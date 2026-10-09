import {
  Notice,
  Plugin,
  TFile,
  debounce,
  TAbstractFile,
} from "obsidian";
import {
  Change,
  Manifest,
  RemoteTree,
  ConflictKind,
  exceedsMassDeleteThreshold,
  nextManifest as buildNextManifest,
  planChanges as classifyChanges,
  planPullChanges,
} from "./src/sync-core";
import {
  Settings,
  SyncLogEntry,
  DeviceCodeResponse,
  DeviceTokenResponse,
  DEFAULT_SETTINGS,
} from "./src/types";
import {
  VIEW_TYPE_SYNC_STATUS,
} from "./src/constants";
import { VaultHelper } from "./src/utils/vault";
import { GithubClient, GithubApiError } from "./src/utils/github";
import { ConflictModal, SyncNeedsUserError, UserCancelledError } from "./src/ui/conflict-modal";
import { ConfirmModal } from "./src/ui/confirm-modal";
import { SyncLogModal } from "./src/ui/sync-log-modal";
import { DeviceFlowModal } from "./src/ui/device-flow-modal";
import { VersionRestoreModal } from "./src/ui/version-restore-modal";
import { SyncStatusView } from "./src/ui/sync-status-view";
import { VaultSyncSettingTab } from "./src/ui/settings-tab";

export type SyncReason =
  | "manual"
  | "force"
  | "settings"
  | "panel"
  | "startup"
  | "interval"
  | "file change";

/** Sync triggers that may open modals; everything else is background. */
const INTERACTIVE_REASONS = new Set<SyncReason>(["manual", "force", "settings", "panel"]);

/** Union of two plans keyed by path; an entry in `later` replaces `first`. */
function mergeChangesByPath(first: Change[], later: Change[]): Change[] {
  const byPath = new Map<string, Change>();
  for (const c of [...first, ...later]) byPath.set(c.path, c);
  return [...byPath.values()];
}

export default class VaultSyncPlugin extends Plugin {
  settings: Settings = DEFAULT_SETTINGS;
  syncManifest: Manifest = {};
  vaultHelper!: VaultHelper;
  githubClient!: GithubClient;
  settingTab?: VaultSyncSettingTab;
  /** Auto-sync stays paused until this timestamp after GitHub throttles us. */
  private throttledUntil = 0;
  
  private syncing = false;
  /** Sync requested while one was running; re-run with this reason after. */
  private queuedReason: SyncReason | null = null;
  private statusBar?: HTMLElement;
  private syncLog: SyncLogEntry[] = [];
  private lastStatus = "VaultSync: idle";
  private lastSyncAt = "";
  private lastError = "";
  /** Why the last background sync stepped aside for the user; "" when none. */
  private lastNeedsUser = "";
  private needsUserNotified = false;
  private lastChangeCount = 0;
  private lastSyncTime = Date.now();
  private syncAfterChange = debounce(
    () => void this.sync("file change"),
    3000,
    true,
  );

  async onload() {
    // Initialize helpers synchronously first so they are immediately available
    this.vaultHelper = new VaultHelper(
      this.app,
      () => this.settings,
      () => this.syncManifest,
    );
    this.githubClient = new GithubClient(
      this.app,
      () => this.settings,
      async () => await this.saveSettings(),
      this.vaultHelper,
    );
    this.githubClient.onStatusUpdate = (status) => {
      this.setStatus(`VaultSync: ${status}`);
    };

    const data = await this.loadData();
    const loadedSettings = data?.settings ?? data ?? {};
    if (loadedSettings.ignorePatterns === undefined || loadedSettings.ignorePatterns === "") {
      loadedSettings.ignorePatterns = [
        ".git/**",
        ".trash/**",
        // Local-only: conflict/delete backups are never uploaded.
        ".github-sync-backup/**",
        // The repository's own README is the user's, not the vault's.
        "README.md",
        `${this.app.vault.configDir}/workspace*.json`,
        ".DS_Store",
      ].join("\n");
    }

    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      loadedSettings,
    );
    this.syncManifest = data?.manifest ?? {};
    this.syncLog = data?.syncLog ?? [];

    this.statusBar = this.addStatusBarItem();
    this.setStatus("VaultSync: idle");
    this.settingTab = new VaultSyncSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.registerView(
      VIEW_TYPE_SYNC_STATUS,
      (leaf) => new SyncStatusView(leaf, this),
    );
    this.addRibbonIcon(
      "refresh-cw",
      "VaultSync",
      () => void this.activateStatusView(),
    );

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.sync("manual"),
      // No default hotkey: stealing Mod+S from the editor is hostile, and an
      // accidental force-sync (which wipes the manifest) floods both sides
      // with conflict copies.
    });
    this.addCommand({
      id: "force-sync",
      name: "Force sync / fetch updates",
      callback: () => void this.sync("force"),
      // No default hotkey (see above).
    });
    this.addCommand({
      id: "pull-changes",
      name: "Pull changes from GitHub (download only)",
      callback: () => void this.pull(),
    });
    this.addCommand({
      id: "open-sync-status",
      name: "Open sync status panel",
      callback: () => void this.activateStatusView(),
    });
    this.addCommand({
      id: "show-sync-log",
      name: "Show sync log",
      callback: () => new SyncLogModal(this.app, this.syncLog).open(),
    });
    this.addCommand({
      id: "github-device-login",
      name: "Sign in to GitHub with device code",
      callback: () => void this.startDeviceFlowLogin(),
    });
    this.addCommand({
      id: "restore-current-file-version",
      name: "Restore current file from version history",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || this.vaultHelper.isIgnored(file.path)) return false;
        if (!checking) void this.openVersionRestore(file);
        return true;
      },
    });

    this.registerEvent(
      this.app.vault.on("modify", (file) => this.onVaultChange(file)),
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => this.onVaultChange(file)),
    );
    this.registerEvent(this.app.vault.on("delete", () => this.onVaultChange()));
    this.registerEvent(
      this.app.vault.on("rename", (file) => this.onVaultChange(file)),
    );
    this.lastSyncTime = Date.now();
    this.registerInterval(
      window.setInterval(
        () => {
          if (this.isThrottled()) return;
          if (this.settings.autoSync && this.settings.intervalMinutes > 0) {
            const now = Date.now();
            const elapsed = now - this.lastSyncTime;
            const threshold = Math.max(1, this.settings.intervalMinutes) * 60_000;
            if (elapsed >= threshold) {
              void this.sync("interval");
            }
          }
        },
        10_000, // Check every 10 seconds
      ),
    );

    if (this.settings.syncOnStartup)
      this.app.workspace.onLayoutReady(() => void this.sync("startup"));
  }

  async saveSettings() {
    await this.saveData({
      settings: this.settings,
      manifest: this.syncManifest,
      syncLog: this.syncLog,
    });
  }

  async openVersionRestore(file: TFile) {
    try {
      this.validateSettings();
      await this.githubClient.ensureRepositoryReady();
      const versions = await this.githubClient.fileVersions(file.path);
      if (versions.length === 0) {
        new Notice(`No GitHub history found for ${file.path}.`);
        return;
      }
      new VersionRestoreModal(this.app, this, file, versions, async (version) => {
        const bytes = await this.githubClient.downloadBytesAtCommit(file.path, version.sha);
        // Back up the live file first: a restore is destructive.
        await this.vaultHelper.backupLocalFile(file.path);
        await this.vaultHelper.writeVaultFile(file.path, bytes);
        await this.vaultHelper.pruneBackups();
        new Notice(`Restored ${file.name} to the version from commit ${version.sha.slice(0, 8)}.`);
      }).open();
    } catch (error) {
      this.fail("Version restore failed", error);
    }
  }

  async startDeviceFlowLogin() {
    try {
      const clientId = this.settings.deviceFlowClientId.trim();
      if (!clientId)
        throw new Error(
          "Set your GitHub App client ID in settings first, or paste a fine-grained token into the token field instead.",
        );
      const device = await this.githubClient.githubOauth<DeviceCodeResponse>(
        "POST",
        "/login/device/code",
        {
          client_id: clientId,
          // No `scope`: a GitHub App's permissions come from the app's own
          // configuration, and `repo` would be a broad OAuth scope.
        },
      );
      new DeviceFlowModal(
        this.app,
        device,
        clientId,
        this.githubClient,
        async (bundle: DeviceTokenResponse) => {
          if (!bundle.access_token)
            throw new Error("GitHub sign-in did not return a token.");
          this.settings.token = bundle.access_token;
          this.settings.refreshToken = bundle.refresh_token ?? "";
          this.settings.tokenExpiresAt =
            Date.now() + (bundle.expires_in ?? 8 * 3600) * 1000;
          this.settings.owner = "";
          await this.githubClient.ensureRepositoryReady();
          await this.saveSettings();
          new Notice("GitHub sign-in complete.");
          this.refreshStatusViews();
          this.settingTab?.display();
        },
      ).open();
    } catch (error) {
      this.fail("GitHub sign-in failed", error);
    }
  }

  private onVaultChange(file?: TAbstractFile) {
    if (!this.settings.autoSync || !this.settings.syncOnFileChange) return;
    if (file?.path && this.vaultHelper.isIgnored(file.path)) return;
    if (file?.path && this.vaultHelper.pluginWrites.has(file.path)) {
      this.vaultHelper.pluginWrites.delete(file.path);
      return;
    }
    this.syncAfterChange();
  }

  /**
   * Proactively rotate the GitHub App user token when it is expired or
   * expiring within 5 minutes. No-op for PAT-based setups (no refresh token).
   */
  async ensureFreshToken() {
    const { token, refreshToken, tokenExpiresAt } = this.settings;
    if (!token || !refreshToken) return;
    if (tokenExpiresAt && Date.now() < tokenExpiresAt - 5 * 60_000) return;
    await this.githubClient.refreshAccessToken();
  }

  private isThrottled(): boolean {
    return Date.now() < this.throttledUntil;
  }

  async sync(reason: SyncReason) {
    // Interactive reasons get confirmation modals; background reasons abort
    // instead of popping UI.
    const interactive = INTERACTIVE_REASONS.has(reason);

    if (this.isThrottled()) {
      const secs = Math.max(1, Math.round((this.throttledUntil - Date.now()) / 1000));
      if (!interactive) {
        this.setStatus(`VaultSync: paused by GitHub rate limit (~${secs}s)`);
        return;
      }
      new Notice(`GitHub is rate limiting this plugin (~${secs}s left); syncing anyway.`, 6000);
    }
    if (this.syncing) {
      this.queueSync(reason);
      return;
    }
    this.syncing = true;
    this.queuedReason = null;
    // The user is here to resolve whatever we flagged; re-notify if it recurs.
    if (interactive) this.needsUserNotified = false;
    this.lastSyncTime = Date.now();
    // Clear stale write-guards so real user edits made after the previous sync
    // are not silently swallowed by the pluginWrites guard, especially on mobile
    // where syncs fire very frequently (startup + interval + file-change).
    this.vaultHelper.clearPluginWrites();
    await this.ensureFreshToken();

    const startedAt = new Date().toISOString();
    let changesForLog: Change[] = [];
    let commitSha: string | undefined;
    this.setStatus(`VaultSync: syncing (${reason})`);

    try {
      this.validateSettings();
      await this.githubClient.ensureRepositoryReady();
      // Only after the repo/branch is known to exist: a typo'd repository
      // name must fail loudly, not wipe the baseline on the way. The stored
      // manifest and scope are untouched until the run succeeds, so a failure
      // after this point can never persist an empty baseline.
      const pendingScope = this.changedScope();
      const base: Manifest = reason === "force" || pendingScope ? {} : this.syncManifest;
      if (reason === "force") new Notice("Force sync: clearing cache and fetching all updates...");
      const [local, remoteInfo] = await Promise.all([
        this.vaultHelper.localManifest(),
        this.githubClient.remoteTree(),
      ]);
      const changes = this.planChanges(local, remoteInfo.tree, base);

      changesForLog = changes;
      if (changes.length === 0) {
        // Still re-baseline: after a scope reset the base is empty and
        // nothing else would rebuild it.
        await this.finishSuccess(
          startedAt,
          reason,
          changes,
          "VaultSync: synced",
          this.nextManifest(local, remoteInfo.tree),
          pendingScope,
        );
        return;
      }

      const resolvedChanges = await this.resolveConflicts(changes, local, interactive, base);
      changesForLog = resolvedChanges;
      await this.applyLocalChanges(resolvedChanges);
      const commitNeeded = resolvedChanges.some(
        (c) => c.type === "upload" || c.type === "deleteRemote",
      );
      let nextRemote = { ...remoteInfo.tree };
      let retryChanges: Change[] = [];
      if (commitNeeded) {
        const commitResult = await this.githubClient.commitRemoteChangesWithRetry(
          resolvedChanges,
          remoteInfo,
          nextRemote,
          () => this.vaultHelper.localManifest(),
          (l, r) => this.planChanges(l, r, base),
          (c, l) => this.resolveConflicts(c, l, interactive, base),
          (c) => this.applyLocalChanges(c),
        );
        nextRemote = commitResult.remote;
        commitSha = commitResult.commitSha;
        retryChanges = commitResult.retryChanges;
      }
      // What actually happened this run: the first plan, overridden per path
      // by the retry replan where there was one.
      const appliedChanges = mergeChangesByPath(resolvedChanges, retryChanges);
      changesForLog = appliedChanges;

      const finalLocal = await this.vaultHelper.localManifest();
      // Paths we planned to download but that aren't in the local manifest
      // (download not yet applied, or the mobile file index lagging) must
      // NOT be tombstoned: the next sync will simply download them again.
      const pendingDownloads = new Set(
        appliedChanges.filter((c) => c.type === "download").map((c) => c.path),
      );
      await this.finishSuccess(
        startedAt,
        reason,
        appliedChanges,
        `VaultSync: synced ${appliedChanges.length} change${appliedChanges.length === 1 ? "" : "s"}`,
        this.nextManifest(finalLocal, nextRemote, pendingDownloads),
        pendingScope,
        commitSha,
      );
    } catch (error) {
      const cancelled = error instanceof UserCancelledError;
      const needsUser = error instanceof SyncNeedsUserError;
      const rateLimited = error instanceof GithubApiError && error.rateLimited;
      const message = error instanceof Error ? error.message : String(error);
      this.recordSyncLog(
        startedAt,
        reason,
        cancelled ? "cancelled" : needsUser ? "needs-user" : "error",
        changesForLog,
        undefined,
        message,
      );
      // A queued background re-run would just re-raise the same modal or
      // notice; a queued interactive one is the user asking to resolve it.
      if (cancelled || needsUser) this.dropQueuedBackgroundSync();
      if (cancelled) {
        this.setStatus("VaultSync: cancelled");
        new Notice("Sync cancelled.", 4000);
      } else if (needsUser) {
        // Not a failure: the background sync stepped aside for a decision.
        // Background triggers fire constantly, so notify once until the user
        // acts or the condition clears.
        this.lastNeedsUser = message;
        this.setStatus("VaultSync: needs attention (run Sync now)");
        if (!this.needsUserNotified) {
          this.needsUserNotified = true;
          new Notice(`VaultSync paused: ${message}`, 10000);
        }
      } else if (rateLimited) {
        // Pause auto-sync (honoring Retry-After / X-RateLimit-Reset when
        // GitHub sends them) instead of hammering a throttled endpoint.
        const pauseMs = error.retryAfterMs ?? 60_000;
        this.throttledUntil = Date.now() + pauseMs;
        const until = new Date(this.throttledUntil).toLocaleTimeString();
        this.lastError = message;
        this.setStatus(`VaultSync: paused (rate limited until ${until})`);
        new Notice(`GitHub rate limit hit — auto-sync paused until ${until}.`, 8000);
        console.error("Sync failed", error);
      } else {
        this.fail("Sync failed", error);
      }
    } finally {
      this.syncing = false;
      this.runQueuedSync();
    }
  }

  /** Remember a sync requested mid-run; an interactive request wins. */
  private queueSync(reason: SyncReason): void {
    if (this.queuedReason && INTERACTIVE_REASONS.has(this.queuedReason)) return;
    this.queuedReason = reason;
  }

  private dropQueuedBackgroundSync(): void {
    if (this.queuedReason && !INTERACTIVE_REASONS.has(this.queuedReason))
      this.queuedReason = null;
  }

  private runQueuedSync(): void {
    const reason = this.queuedReason;
    this.queuedReason = null;
    if (reason) void this.sync(reason);
  }

  async pull() {
    if (this.syncing) {
      new Notice("Sync already in progress. Please wait.");
      return;
    }
    this.syncing = true;
    this.queuedReason = null;
    this.needsUserNotified = false;
    this.lastSyncTime = Date.now();
    this.vaultHelper.clearPluginWrites();
    await this.ensureFreshToken();

    const startedAt = new Date().toISOString();
    let changesForLog: Change[] = [];
    this.setStatus("VaultSync: pulling changes...");

    try {
      this.validateSettings();
      await this.githubClient.ensureRepositoryReady();
      // Plan against the stored baseline (empty if the scope changed); the
      // manifest and scope are only replaced once the plan has been applied,
      // so a failed fetch can't persist a wiped or half-updated manifest.
      const pendingScope = this.changedScope();
      const base: Manifest = pendingScope ? {} : this.syncManifest;
      const [local, remoteInfo] = await Promise.all([
        this.vaultHelper.localManifest(),
        this.githubClient.remoteTree(),
      ]);

      const rawPull = planPullChanges(
        local,
        remoteInfo.tree,
        base,
        (path) => this.vaultHelper.isIgnored(path),
      );
      // A pull must never silently overwrite a locally modified file: any
      // download where the local file also diverged from the manifest
      // becomes a real conflict and goes through the conflict modal.
      const pullChanges: Change[] = rawPull.map((c) => {
        if (c.type !== "download") return c;
        const baseEntry = base[c.path];
        const localEntry = local[c.path];
        const locallyModified =
          !!localEntry && localEntry.sha !== (baseEntry?.sha ?? null);
        if (!locallyModified) return c;
        const kind: ConflictKind = !baseEntry ? "both_added" : "both_modified";
        return { type: "conflict", path: c.path, remoteSha: c.remoteSha, kind };
      });

      changesForLog = pullChanges;
      if (pullChanges.length === 0) {
        await this.finishSuccess(
          startedAt,
          "pull",
          pullChanges,
          "VaultSync: synced",
          this.nextManifest(local, remoteInfo.tree),
          pendingScope,
        );
        new Notice("Already up to date — nothing to pull.");
        return;
      }

      const resolvedPull = await this.resolveConflicts(pullChanges, local, true, base);
      // A pull never pushes: drop any upload/deleteRemote resolutions.
      const pullOnly = resolvedPull.filter(
        (c) =>
          c.type === "download" ||
          c.type === "deleteLocal" ||
          c.type === "downloadConflictCopy",
      );
      changesForLog = pullOnly;
      await this.applyLocalChanges(pullOnly);

      const finalLocal = await this.vaultHelper.localManifest();
      const pendingDownloads = new Set(
        pullOnly.filter((c) => c.type === "download").map((c) => c.path),
      );
      const plural = pullOnly.length === 1 ? "" : "s";
      await this.finishSuccess(
        startedAt,
        "pull",
        pullOnly,
        `VaultSync: pulled ${pullOnly.length} change${plural}`,
        this.nextManifest(finalLocal, remoteInfo.tree, pendingDownloads),
        pendingScope,
      );
      new Notice(`Pulled ${pullOnly.length} change${plural} from GitHub.`);
    } catch (error) {
      const cancelled = error instanceof UserCancelledError;
      this.recordSyncLog(
        startedAt,
        "pull",
        cancelled ? "cancelled" : "error",
        changesForLog,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
      if (cancelled) {
        this.dropQueuedBackgroundSync();
        this.setStatus("VaultSync: cancelled");
        new Notice("Pull cancelled.", 4000);
      } else {
        this.fail("Pull failed", error);
      }
    } finally {
      this.syncing = false;
      this.runQueuedSync();
    }
  }

  /**
   * Common tail of every successful sync or pull, zero-change runs included.
   * This is the only place the manifest and scope are published: they are
   * assigned together and persisted in one save, so a failure anywhere
   * earlier leaves the previous baseline on disk. Then prune backups, clear
   * the failure and needs-attention state, and log the run.
   */
  private async finishSuccess(
    startedAt: string,
    reason: string,
    changes: Change[],
    statusText: string,
    nextManifest: Manifest,
    pendingScope: string | null,
    commitSha?: string,
  ): Promise<void> {
    this.syncManifest = nextManifest;
    if (pendingScope) this.settings.syncScope = pendingScope;
    await this.saveSettings();
    await this.vaultHelper.pruneBackups();
    this.lastSyncAt = new Date().toLocaleString();
    this.lastChangeCount = changes.length;
    this.lastError = "";
    this.lastNeedsUser = "";
    this.needsUserNotified = false;
    this.setStatus(statusText);
    this.recordSyncLog(startedAt, reason, "success", changes, commitSha);
  }

  /**
   * If the repo/branch/path scope changed since the last sync, the stored
   * manifest describes a different remote and planning must start from an
   * empty baseline (stale state can look like a mass delete). Returns the new
   * scope string to publish on success, or null when it is unchanged. Pure:
   * nothing is mutated here.
   */
  private changedScope(): string | null {
    const scope = JSON.stringify({
      owner: this.settings.owner.trim().toLowerCase(),
      repo: this.settings.repo.trim().toLowerCase(),
      branch: this.settings.branch.trim(),
      rootPath: this.settings.rootPath.trim(),
      nestUnderVaultName: this.settings.nestUnderVaultName,
    });
    return this.settings.syncScope === scope ? null : scope;
  }

  private async validateSettings() {
    if (!this.settings.token.trim())
      throw new Error("GitHub token is required.");
    if (!this.settings.repo.trim())
      throw new Error(
        "Repository is required. Set it in VaultSync settings (e.g. your vault repo name).",
      );
    if (!this.settings.branch.trim())
      this.settings.branch = DEFAULT_SETTINGS.branch;
  }

  /** `base` is the baseline this run plans against (see sync()). */
  private planChanges(local: Manifest, remote: RemoteTree, base: Manifest): Change[] {
    return classifyChanges(local, remote, base, (path) =>
      this.vaultHelper.isIgnored(path),
    );
  }

  private async resolveConflicts(
    changes: Change[],
    local: Manifest,
    interactive: boolean,
    base: Manifest,
  ): Promise<Change[]> {
    const conflicts = changes.filter((change) => change.type === "conflict") as Array<Extract<Change, { type: "conflict" }>>;
    let resolved: Change[];
    if (conflicts.length === 0) {
      resolved = changes;
    } else {
      if (!interactive)
        throw new SyncNeedsUserError(
          `${conflicts.length} file${conflicts.length === 1 ? "" : "s"} changed on both sides. Run "Sync now" to resolve.`,
        );
      const resolutions = await new ConflictModal(this.app, this, conflicts).resolve();
      resolved = changes.filter((change) => change.type !== "conflict");
      for (const conflict of conflicts) {
        const choice = resolutions.get(conflict.path) ?? "both";
        if (choice === "local") {
          if (local[conflict.path])
            resolved.push({ type: "upload", path: conflict.path });
          else resolved.push({ type: "deleteRemote", path: conflict.path });
        } else if (choice === "remote") {
          if (conflict.remoteSha)
            resolved.push({
              type: "download",
              path: conflict.path,
              remoteSha: conflict.remoteSha,
            });
          else resolved.push({ type: "deleteLocal", path: conflict.path });
        } else {
          if (conflict.remoteSha)
            resolved.push({
              type: "downloadConflictCopy",
              path: conflict.path,
              remoteSha: conflict.remoteSha,
            });
          if (local[conflict.path])
            resolved.push({ type: "upload", path: conflict.path });
          else resolved.push({ type: "deleteRemote", path: conflict.path });
        }
      }
    }

    // Mass-delete guards: a plan that deletes a large share of one side
    // usually means the other side is unexpectedly empty (wrong repo or
    // branch, emptied repo, moved or wiped vault) — never do it silently.
    const localCount = Object.keys(local).length;
    const deleteLocals = resolved.filter((c) => c.type === "deleteLocal").length;
    await this.confirmMassDelete(deleteLocals, localCount, interactive, {
      title: "Delete many local files?",
      message:
        `This sync would delete ${deleteLocals} of ${localCount} local files. ` +
        `This usually means the remote repository is empty or the repository settings changed. ` +
        `Backups are kept under .github-sync-backup/, but review before continuing.`,
      button: "Delete them",
      background: `Refusing to delete ${deleteLocals} local files in a background sync.`,
    });
    // deleteRemote is only planned for paths in the baseline, so the
    // baseline size is the right denominator.
    const trackedCount = Object.keys(base).length;
    const deleteRemotes = resolved.filter((c) => c.type === "deleteRemote").length;
    await this.confirmMassDelete(deleteRemotes, trackedCount, interactive, {
      title: "Delete many files from GitHub?",
      message:
        `This sync would delete ${deleteRemotes} of ${trackedCount} synced files from the repository. ` +
        `This usually means the local vault was moved or wiped, or Obsidian's file index is incomplete. ` +
        `Nothing is removed from GitHub until you confirm.`,
      button: "Delete them from GitHub",
      background: `Refusing to delete ${deleteRemotes} files from GitHub in a background sync.`,
    });
    return resolved;
  }

  private async confirmMassDelete(
    count: number,
    total: number,
    interactive: boolean,
    text: { title: string; message: string; button: string; background: string },
  ): Promise<void> {
    if (!exceedsMassDeleteThreshold(count, total)) return;
    if (!interactive)
      throw new SyncNeedsUserError(`${text.background} Run "Sync now" to review and confirm.`);
    const confirmed = await new ConfirmModal(
      this.app,
      text.title,
      text.message,
      text.button,
    ).confirm();
    if (!confirmed) throw new UserCancelledError("Mass delete declined.");
  }

  private async applyLocalChanges(changes: Change[]): Promise<void> {
    for (const change of changes) {
      if (change.type === "download") {
        await this.vaultHelper.backupLocalFile(change.path);
        await this.vaultHelper.writeVaultFile(
          change.path,
          await this.githubClient.downloadBytes(change.path, change.remoteSha),
        );
      }
      if (change.type === "deleteLocal") {
        await this.vaultHelper.backupLocalFile(change.path);
        await this.vaultHelper.deleteVaultFile(change.path);
      }
      if (change.type === "downloadConflictCopy") {
        // Written locally only. It is deliberately NOT added to the remote
        // tree: nothing uploads it in this commit, so recording it would make
        // the next sync plan deleteLocal for it. As a local-only file it is
        // picked up as an upload next sync instead.
        const conflictPath = this.vaultHelper.conflictPath(change.path);
        await this.vaultHelper.writeVaultFile(
          conflictPath,
          await this.githubClient.downloadBytes(change.path, change.remoteSha),
        );
        new Notice(`Conflict kept: ${conflictPath}`, 10000);
      }
    }
  }

  private nextManifest(
    local: Manifest,
    remote: RemoteTree,
    pendingDownloads: Set<string> = new Set(),
  ): Manifest {
    return buildNextManifest(
      local,
      remote,
      (path) => this.vaultHelper.isIgnored(path),
      pendingDownloads,
    );
  }

  private setStatus(text: string) {
    this.lastStatus = text;
    this.statusBar?.setText(text);
    this.refreshStatusViews();
  }

  private fail(prefix: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.lastError = message;
    this.setStatus(`${prefix}: ${message}`);
    new Notice(`${prefix}: ${message}`, 10000);
    console.error(prefix, error);
  }

  getStatusSnapshot() {
    return {
      status: this.lastStatus,
      lastSyncAt: this.lastSyncAt || "Never",
      lastError: this.lastError || "None",
      needsAttention: this.lastNeedsUser,
      lastChangeCount: this.lastChangeCount,
      trackedFiles: Object.keys(this.syncManifest).length,
      logEntries: this.syncLog.length,
      configured: Boolean(
        this.settings.token &&
        this.settings.owner &&
        this.settings.repo &&
        this.settings.branch,
      ),
      repo:
        this.settings.owner && this.settings.repo
          ? `${this.settings.owner}/${this.settings.repo}`
          : "Not configured",
      branch: this.settings.branch || "Not configured",
    };
  }

  async activateStatusView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SYNC_STATUS);
    const leaf = leaves[0] ?? this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE_SYNC_STATUS, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  refreshStatusViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(
      VIEW_TYPE_SYNC_STATUS,
    )) {
      const view = leaf.view;
      if (view instanceof SyncStatusView) view.render();
    }
  }

  showSyncLog() {
    new SyncLogModal(this.app, this.syncLog).open();
  }

  private recordSyncLog(
    startedAt: string,
    reason: string,
    status: SyncLogEntry["status"],
    changes: Change[],
    commitSha?: string,
    error?: string,
  ) {
    this.syncLog.unshift({
      startedAt,
      endedAt: new Date().toISOString(),
      reason,
      status,
      changes: changes.length,
      uploads: changes.filter((c) => c.type === "upload").length,
      downloads: changes.filter((c) => c.type === "download").length,
      deletes: changes.filter(
        (c) => c.type === "deleteLocal" || c.type === "deleteRemote",
      ).length,
      conflicts: changes.filter((c) => c.type === "conflict").length,
      commitSha,
      error,
    });
    this.syncLog = this.syncLog.slice(0, 100);
    void this.saveSettings();
    this.refreshStatusViews();
  }
}
