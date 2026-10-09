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
import { gitBlobSha } from "./src/utils/helpers";
import { ConflictModal, UserCancelledError } from "./src/ui/conflict-modal";
import { ConfirmModal } from "./src/ui/confirm-modal";
import { SyncLogModal } from "./src/ui/sync-log-modal";
import { DeviceFlowModal } from "./src/ui/device-flow-modal";
import { VersionRestoreModal } from "./src/ui/version-restore-modal";
import { SyncStatusView } from "./src/ui/sync-status-view";
import { VaultSyncSettingTab } from "./src/ui/settings-tab";

export default class VaultSyncPlugin extends Plugin {
  settings: Settings = DEFAULT_SETTINGS;
  syncManifest: Manifest = {};
  vaultHelper!: VaultHelper;
  githubClient!: GithubClient;
  settingTab?: VaultSyncSettingTab;
  /** Auto-sync stays paused until this timestamp after GitHub throttles us. */
  private throttledUntil = 0;
  
  private syncing = false;
  private queued = false;
  private statusBar?: HTMLElement;
  private syncLog: SyncLogEntry[] = [];
  private lastStatus = "VaultSync: idle";
  private lastSyncAt = "";
  private lastError = "";
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
          // Back off while GitHub is throttling us.
          if (Date.now() < this.throttledUntil) return;
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

  async sync(reason: string) {
    if (this.syncing) {
      this.queued = true;
      return;
    }
    this.syncing = true;
    this.queued = false;
    this.lastSyncTime = Date.now();
    // Clear stale write-guards so real user edits made after the previous sync
    // are not silently swallowed by the pluginWrites guard, especially on mobile
    // where syncs fire very frequently (startup + interval + file-change).
    this.vaultHelper.clearPluginWrites();
    await this.ensureFreshToken();

    // Interactive reasons get confirmation modals; background reasons abort
    // instead of popping UI.
    const interactive = reason === "manual" || reason === "force";

    if (reason === "force") {
      this.syncManifest = {};
      new Notice("Force sync: clearing cache and fetching all updates...");
    }

    const startedAt = new Date().toISOString();
    let changesForLog: Change[] = [];
    let commitSha: string | undefined;
    this.setStatus(`VaultSync: syncing (${reason})`);

    try {
      this.validateSettings();
      await this.resetManifestOnScopeChange();

      await this.githubClient.ensureRepositoryReady();
      const [local, remoteInfo] = await Promise.all([
        this.vaultHelper.localManifest(),
        this.githubClient.remoteTree(),
      ]);
      const changes = this.planChanges(local, remoteInfo.tree);
      
      changesForLog = changes;
      if (changes.length === 0) {
        this.setStatus("VaultSync: synced");
        this.lastSyncAt = new Date().toLocaleString();
        this.lastChangeCount = 0;
        this.lastError = "";
        this.refreshStatusViews();
        await this.saveSettings();
        this.recordSyncLog(startedAt, reason, "success", changesForLog);
        return;
      }

      const resolvedChanges = await this.resolveConflicts(changes, local, interactive);
      changesForLog = resolvedChanges;
      const remoteUpdates = await this.applyLocalChanges(
        resolvedChanges,
        local,
      );
      const commitNeeded = resolvedChanges.some(
        (c) => c.type === "upload" || c.type === "deleteRemote",
      );
      let nextRemote = { ...remoteInfo.tree, ...remoteUpdates };
      if (commitNeeded) {
        const commitResult = await this.githubClient.commitRemoteChangesWithRetry(
          resolvedChanges,
          remoteInfo,
          nextRemote,
          () => this.vaultHelper.localManifest(),
          (l, r) => this.planChanges(l, r),
          (c, l) => this.resolveConflicts(c, l, interactive),
          (c, l) => this.applyLocalChanges(c, l),
        );
        nextRemote = commitResult.remote;
        commitSha = commitResult.commitSha;
      }

      const finalLocal = await this.vaultHelper.localManifest();
      // Paths we planned to download but that aren't in the local manifest
      // (download not yet applied, or the mobile file index lagging) must
      // NOT be tombstoned: the next sync will simply download them again.
      const pendingDownloads = new Set(
        resolvedChanges
          .filter((c) => c.type === "download")
          .map((c) => c.path),
      );
      this.syncManifest = this.nextManifest(finalLocal, nextRemote, pendingDownloads);
      await this.saveSettings();
      // Prune old local backups (best-effort, never fails the sync).
      await this.vaultHelper.pruneBackups();
      this.lastSyncAt = new Date().toLocaleString();
      this.lastChangeCount = changes.length;
      this.lastError = "";
      this.setStatus(
        `VaultSync: synced ${resolvedChanges.length} change${resolvedChanges.length === 1 ? "" : "s"}`,
      );
      this.recordSyncLog(
        startedAt,
        reason,
        "success",
        changesForLog,
        commitSha,
      );
    } catch (error) {
      const cancelled = error instanceof UserCancelledError;
      const throttled =
        error instanceof GithubApiError &&
        (error.status === 429 || error.status === 403);
      if (throttled) {
        // Pause auto-sync (honoring Retry-After when GitHub sends one)
        // instead of hammering a throttled endpoint.
        const pauseMs = error.retryAfterMs ?? 60_000;
        this.throttledUntil = Date.now() + pauseMs;
        new Notice(
          `GitHub rate limit hit — auto-sync paused for ~${Math.max(1, Math.round(pauseMs / 1000))}s.`,
          8000,
        );
      }
      this.recordSyncLog(
        startedAt,
        reason,
        "error",
        changesForLog,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
      if (cancelled) {
        this.setStatus("VaultSync: sync cancelled");
        new Notice("Sync cancelled.", 4000);
      } else {
        this.fail("Sync failed", error);
      }
    } finally {
      this.syncing = false;
      if (this.queued) void this.sync("queued");
    }
  }

  async pull() {
    if (this.syncing) {
      new Notice("Sync already in progress. Please wait.");
      return;
    }
    this.syncing = true;
    this.queued = false;
    this.lastSyncTime = Date.now();
    this.vaultHelper.clearPluginWrites();
    await this.ensureFreshToken();

    const startedAt = new Date().toISOString();
    let changesForLog: Change[] = [];
    this.setStatus("VaultSync: pulling changes...");

    try {
      this.validateSettings();
      await this.resetManifestOnScopeChange();
      await this.githubClient.ensureRepositoryReady();
      // Clear manifest so we compare against the true remote state without
      // any stale local baseline that might suppress downloads.
      const savedManifest = this.syncManifest;
      this.syncManifest = {};
      const [local, remoteInfo] = await Promise.all([
        this.vaultHelper.localManifest(),
        this.githubClient.remoteTree(),
      ]);
      this.syncManifest = savedManifest;

      const rawPull = planPullChanges(
        local,
        remoteInfo.tree,
        savedManifest,
        (path) => this.vaultHelper.isIgnored(path),
      );
      // A pull must never silently overwrite a locally modified file: any
      // download where the local file also diverged from the manifest
      // becomes a real conflict and goes through the conflict modal.
      const pullChanges: Change[] = rawPull.map((c) => {
        if (c.type !== "download") return c;
        const base = savedManifest[c.path];
        const localEntry = local[c.path];
        const locallyModified =
          !!localEntry && localEntry.sha !== (base?.sha ?? null);
        if (!locallyModified) return c;
        const kind: ConflictKind = !base ? "both_added" : "both_modified";
        return { type: "conflict", path: c.path, remoteSha: c.remoteSha, kind };
      });

      changesForLog = pullChanges;
      if (pullChanges.length === 0) {
        new Notice("Already up to date — nothing to pull.");
        this.setStatus("VaultSync: synced");
        this.recordSyncLog(startedAt, "pull", "success", pullChanges);
        return;
      }

      const resolvedPull = await this.resolveConflicts(pullChanges, local, true);
      // A pull never pushes: drop any upload/deleteRemote resolutions.
      const pullOnly = resolvedPull.filter(
        (c) =>
          c.type === "download" ||
          c.type === "deleteLocal" ||
          c.type === "downloadConflictCopy",
      );
      changesForLog = pullOnly;
      await this.applyLocalChanges(pullOnly, local);

      const finalLocal = await this.vaultHelper.localManifest();
      const pendingDownloads = new Set(
        pullOnly.filter((c) => c.type === "download").map((c) => c.path),
      );
      this.syncManifest = this.nextManifest(finalLocal, remoteInfo.tree, pendingDownloads);
      await this.saveSettings();
      this.lastSyncAt = new Date().toLocaleString();
      this.lastChangeCount = pullChanges.length;
      this.lastError = "";
      this.setStatus(
        `VaultSync: pulled ${pullChanges.length} change${pullChanges.length === 1 ? "" : "s"}`,
      );
      new Notice(`Pulled ${pullChanges.length} change${pullChanges.length === 1 ? "" : "s"} from GitHub.`);
      this.recordSyncLog(startedAt, "pull", "success", pullChanges);
    } catch (error) {
      this.recordSyncLog(
        startedAt,
        "pull",
        "error",
        changesForLog,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
      this.fail("Pull failed", error);
    } finally {
      this.syncing = false;
      if (this.queued) void this.sync("queued");
    }
  }


  /**
   * If the repo/branch/path scope changed since the last sync, the stored
   * manifest describes a different remote. Reset it and re-baseline instead
   * of planning against stale state (which can look like a mass delete).
   */
  private async resetManifestOnScopeChange(): Promise<void> {
    const scope = JSON.stringify({
      owner: this.settings.owner.trim().toLowerCase(),
      repo: this.settings.repo.trim().toLowerCase(),
      branch: this.settings.branch.trim(),
      rootPath: this.settings.rootPath.trim(),
      nestUnderVaultName: this.settings.nestUnderVaultName,
    });
    if (this.settings.syncScope !== scope) {
      this.syncManifest = {};
      this.settings.syncScope = scope;
      await this.saveSettings();
    }
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

  private planChanges(local: Manifest, remote: RemoteTree): Change[] {
    return classifyChanges(local, remote, this.syncManifest, (path) =>
      this.vaultHelper.isIgnored(path),
    );
  }

  private async resolveConflicts(
    changes: Change[],
    local: Manifest,
    interactive: boolean,
  ): Promise<Change[]> {
    const conflicts = changes.filter((change) => change.type === "conflict") as Array<Extract<Change, { type: "conflict" }>>;
    let resolved: Change[];
    if (conflicts.length === 0) {
      resolved = changes;
    } else {
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

    // Mass local-delete guard: a plan that deletes a large share of local
    // files usually means the remote is unexpectedly empty (wrong repo,
    // wrong branch, emptied repo) — never do it silently.
    const deleteLocals = resolved.filter((c) => c.type === "deleteLocal");
    if (exceedsMassDeleteThreshold(deleteLocals.length, Object.keys(local).length)) {
      const message =
        `This sync would delete ${deleteLocals.length} of ${Object.keys(local).length} local files. ` +
        `This usually means the remote repository is empty or the repository settings changed. ` +
        `Backups are kept under .github-sync-backup/, but review before continuing.`;
      if (!interactive) {
        throw new Error(
          `Refusing to delete ${deleteLocals.length} local files in a background sync. Run "Sync now" to review and confirm.`,
        );
      }
      const confirmed = await new ConfirmModal(
        this.app,
        "Delete many local files?",
        message,
        "Delete them",
      ).confirm();
      if (!confirmed)
        throw new UserCancelledError("Mass local delete declined.");
    }
    return resolved;
  }

  private async applyLocalChanges(
    changes: Change[],
    local: Manifest,
  ): Promise<RemoteTree> {
    const updates: RemoteTree = {};
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
        const conflictPath = this.vaultHelper.conflictPath(change.path);
        const bytes = await this.githubClient.downloadBytes(change.path, change.remoteSha);
        await this.vaultHelper.writeVaultFile(conflictPath, bytes);
        const sha = await gitBlobSha(bytes);
        updates[conflictPath] = { sha, size: bytes.byteLength };
        new Notice(`Conflict kept: ${conflictPath}`, 10000);
      }
    }
    return updates;
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
    status: "success" | "error",
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
