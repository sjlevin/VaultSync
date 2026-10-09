import { App, Notice, TFile, normalizePath } from "obsidian";
import { Settings } from "../types";
import { Manifest, formatBackupStamp, parseBackupStamp } from "../sync-core";
import {
  vaultRemotePrefix,
  detectRemotePrefix as detectRemotePrefixForVault,
  localPath as localPathForVault,
  stripRemotePrefix,
  remotePath as remotePathForVault,
  isSafePath,
  isHardDeniedPath,
  canonicalPathKey,
  matchesPattern,
  conflictCopyPath,
} from "../remote-paths";
import { gitBlobSha, formatBytes } from "./helpers";
import {
  PLUGIN_ID,
  CONFLICT_STAMP,
  GITHUB_BLOB_LIMIT,
  GITHUB_RECOMMENDED_BLOB_LIMIT,
  BACKUP_RETENTION_DAYS,
} from "../constants";

export class VaultHelper {
  public pluginWrites = new Set<string>();
  private warnedUnsafeLocal = new Set<string>();
  /**
   * Canonical keys of paths this snapshot refuses to touch on either side
   * ("poisoned"): remote entries that collide, are unsafe, oversized or not
   * regular blobs, local files that alias each other, and spellings that
   * collide across the two sides. isIgnored() honours it, so planning sees
   * neither side and emits no change; dropping only one side would read as
   * "deleted over there" and plan a delete here. The manifest keeps the
   * previous entry for these (nextManifest `preserve`) so the baseline
   * survives until the poison clears.
   *
   * Scoped to one local+remote snapshot: cleared by beginSnapshot(), which
   * every snapshot (the retry replan included) goes through.
   */
  public skippedPaths = new Set<string>();

  /** Call at the start of every sync so stale write-guards don't suppress real user edits. */
  clearPluginWrites() {
    this.pluginWrites.clear();
    this.warnedUnsafeLocal.clear();
  }

  /** Forget the previous snapshot's poison before listing both sides again. */
  beginSnapshot() {
    this.skippedPaths.clear();
  }

  /** Poison `path` (by canonical key) for the rest of this snapshot. */
  poison(path: string) {
    this.skippedPaths.add(canonicalPathKey(path));
  }

  isPoisoned(path: string): boolean {
    return this.skippedPaths.has(canonicalPathKey(normalizePath(path)));
  }

  constructor(
    private app: App,
    private getSettings: () => Settings,
    private getSyncManifest: () => Manifest,
  ) {}

  /** Whether planning must see neither side of `path`: user-ignored or poisoned. */
  isIgnored(path: string): boolean {
    return this.isPoisoned(path) || this.isUserIgnored(path);
  }

  /**
   * Whether a vault path is excluded from sync (both directions) by
   * configuration, independent of this snapshot's poison.
   *
   * Hard denies come FIRST and are not user-configurable: trimming the
   * ignore-patterns textarea can never re-enable them.
   */
  isUserIgnored(path: string): boolean {
    path = normalizePath(path).normalize("NFC");
    const configDir = this.app.vault.configDir;
    const settings = this.getSettings();

    if (isHardDeniedPath(path, configDir, PLUGIN_ID)) return true;
    const key = canonicalPathKey(path);

    // Config-dir allowlist (replaces the old "sync the whole .obsidian dir").
    // Compared on canonical keys: `.Obsidian/App.json` is `.obsidian/app.json`
    // on a case-insensitive filesystem.
    const configKey = canonicalPathKey(configDir);
    if (key === configKey || key.startsWith(configKey + "/")) {
      if (
        settings.syncObsidianConfig &&
        [
          `${configKey}/app.json`,
          `${configKey}/appearance.json`,
          `${configKey}/core-plugins.json`,
          `${configKey}/hotkeys.json`,
        ].includes(key)
      )
        return false;
      // The hard deny above has already reduced a plugin folder to its
      // data.json; the folder itself stays visible so the scan can descend.
      const pluginsKey = `${configKey}/plugins`;
      if (
        settings.syncCommunityPlugins &&
        (key === pluginsKey || key.startsWith(`${pluginsKey}/`))
      ) {
        // Plugin data.json files (often hold API keys) are opt-in.
        if (key.endsWith("/data.json"))
          return !settings.syncPluginDataJson;
        return false;
      }
      return true;
    }

    return this.ignoreRules().some((pattern) => matchesPattern(path, pattern));
  }

  private ignoreRules(): string[] {
    return (this.getSettings().ignorePatterns || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /** Repository prefix this vault syncs under ("" = repository root). */
  prefix(): string {
    const settings = this.getSettings();
    return vaultRemotePrefix(
      this.app.vault.getName(),
      settings.rootPath,
      settings.nestUnderVaultName,
    );
  }

  remotePath(path: string): string {
    return remotePathForVault(this.prefix(), path);
  }

  localPath(remotePath: string, prefixOverride?: string): string | null {
    return localPathForVault(prefixOverride ?? this.prefix(), remotePath);
  }

  /** Where a remote entry would land locally, whether or not we would write it. */
  localPathUnchecked(remotePath: string, prefixOverride?: string): string | null {
    return stripRemotePrefix(prefixOverride ?? this.prefix(), remotePath);
  }

  /**
   * Given the raw list of paths from GitHub's recursive tree API, find the
   * remote folder that belongs to this vault.
   */
  detectRemotePrefix(remotePaths: string[]): string {
    return detectRemotePrefixForVault(this.prefix(), remotePaths);
  }

  conflictPath(path: string): string {
    return conflictCopyPath(path, new Date().toISOString().replace(CONFLICT_STAMP, "-"));
  }

  async listAllSyncablePaths(): Promise<string[]> {
    const paths = this.app.vault.getFiles().map((f) => f.path);
    const settings = this.getSettings();
    // getFiles() does not index the config dir; isIgnored() narrows the scan
    // to the settings allowlist and/or plugin data.json files.
    if (settings.syncObsidianConfig || settings.syncCommunityPlugins) {
      await this.scanFolderRecursive(this.app.vault.configDir, paths);
    }
    // Deduplicate: getFiles() already includes configDir TFiles on some platforms,
    // so scanFolderRecursive can produce duplicates that cause spurious upload loops.
    const seen = new Set<string>();
    const unsafe: string[] = [];
    const syncable = paths.filter((p) => {
      if (this.isIgnored(p)) return false;
      if (seen.has(p)) return false;
      seen.add(p);
      // Same rule as for remote entries: a local name we would refuse to
      // write back must not be uploaded, or every later sync trips on it.
      if (!isSafePath(p)) {
        if (!this.warnedUnsafeLocal.has(p)) {
          this.warnedUnsafeLocal.add(p);
          unsafe.push(p);
        }
        return false;
      }
      return true;
    });
    if (unsafe.length)
      console.warn(`VaultSync skipped local files with unsafe names:\n${unsafe.join("\n")}`);
    return this.withoutLocalCollisions(syncable);
  }

  /**
   * Two local files that alias each other (case or NFC/NFD, possible on a
   * case-sensitive filesystem) cannot both map to one remote entry; neither
   * is synced and both are poisoned so the remote copy is left alone too.
   */
  private withoutLocalCollisions(paths: string[]): string[] {
    const byKey = new Map<string, string[]>();
    for (const p of paths) {
      const key = canonicalPathKey(p);
      byKey.set(key, [...(byKey.get(key) ?? []), p]);
    }
    const colliding = [...byKey.entries()].filter(([, group]) => group.length > 1);
    if (colliding.length === 0) return paths;
    for (const [key] of colliding) this.skippedPaths.add(key);
    const dropped = colliding.flatMap(([, group]) => group);
    console.warn(`VaultSync skipped local files whose names collide:\n${dropped.join("\n")}`);
    new Notice(
      `VaultSync skipped ${dropped.length} local file(s) whose names differ only by case or Unicode form. See the console.`,
      10000,
    );
    return paths.filter((p) => !this.skippedPaths.has(canonicalPathKey(p)));
  }

  /**
   * A listing failure must abort the sync: a partial listing looks like a
   * mass local delete and would be pushed as deleteRemote.
   */
  private async scanFolderRecursive(folderPath: string, paths: string[]): Promise<void> {
    if (!(await this.app.vault.adapter.exists(folderPath))) return;
    const list = await this.app.vault.adapter.list(folderPath);
    paths.push(...list.files);
    for (const folder of list.folders) {
      if (!this.isIgnored(folder)) await this.scanFolderRecursive(folder, paths);
    }
  }

  /**
   * Throw unless `path` is a safe vault-relative path that cannot escape the
   * vault root. Called before every local write/delete.
   */
  private assertContained(path: string): void {
    const p = normalizePath(path);
    if (
      !p ||
      p === ".." ||
      p.startsWith("../") ||
      p.startsWith("/") ||
      /^[a-zA-Z]:/.test(p) ||
      !isSafePath(p)
    ) {
      throw new Error(`Refusing to touch unsafe path: ${path}`);
    }
  }

  /**
   * Build the local manifest: every syncable file hashed as raw bytes.
   *
   * VaultSync never modifies note contents — files are synced byte-for-byte.
   * A rename therefore looks like a delete plus an add; the 3-way merge in
   * sync-core only flags it as a conflict if the other side also touched the
   * file, which is the correct conservative behavior.
   */
  async localManifest(): Promise<Manifest> {
    const result: Manifest = {};
    const syncablePaths = await this.listAllSyncablePaths();

    for (const path of syncablePaths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      const bytes =
        file instanceof TFile
          ? await this.app.vault.readBinary(file)
          : await this.app.vault.adapter.readBinary(path);
      const sha = await gitBlobSha(bytes);
      this.assertSyncableSize(path, bytes.byteLength);
      result[path] = {
        sha,
        remoteSha: this.getSyncManifest()[path]?.remoteSha ?? null,
        size: bytes.byteLength,
      };
    }

    return result;
  }

  /** Blob SHA of the file as it is on disk right now; null when it is absent. */
  async currentSha(path: string): Promise<string | null> {
    path = normalizePath(path);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) return gitBlobSha(await this.app.vault.readBinary(file));
    if (file || !(await this.app.vault.adapter.exists(path))) return null;
    return gitBlobSha(await this.app.vault.adapter.readBinary(path));
  }

  async ensureDirectoryExists(path: string) {
    const parts = path.split("/");
    parts.pop();
    
    let currentPath = "";
    for (const part of parts) {
      if (!part) continue;
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const normalized = normalizePath(currentPath);
      const isHidden = normalized.startsWith(".");
      
      if (isHidden) {
        const exists = await this.app.vault.adapter.exists(normalized);
        if (!exists) {
          await this.app.vault.adapter.mkdir(normalized);
        }
      } else {
        // Check the in-memory index first (fast path), then fall back to the
        // adapter (filesystem) because on mobile the index can lag after a
        // rapid sequence of downloads.
        const inIndex = this.app.vault.getAbstractFileByPath(normalized);
        const onDisk = inIndex ? true : await this.app.vault.adapter.exists(normalized);
        if (!onDisk) {
          try {
            await this.app.vault.createFolder(normalized);
          } catch {
            // Folder may have been created concurrently (e.g. by another change
            // in the same sync batch). Verify it actually exists now rather than
            // relying on an error-message string that varies by platform/locale.
            const nowExists = await this.app.vault.adapter.exists(normalized);
            if (!nowExists) throw new Error(`Failed to create folder: ${normalized}`);
          }
        }
      }
    }
  }

  async writeVaultFile(path: string, bytes: ArrayBuffer) {
    path = normalizePath(path);
    this.assertContained(path);
    this.pluginWrites.add(path);
    await this.ensureDirectoryExists(path);
    const existing = this.app.vault.getAbstractFileByPath(path);
    const configKey = canonicalPathKey(this.app.vault.configDir);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, bytes);
    } else if (canonicalPathKey(path).startsWith(configKey + "/")) {
      await this.app.vault.adapter.writeBinary(path, bytes);
    } else {
      await this.app.vault.createBinary(path, bytes);
    }
  }

  async backupLocalFile(path: string) {
    path = normalizePath(path);
    this.assertContained(path);
    const file = this.app.vault.getAbstractFileByPath(path);
    let bytes: ArrayBuffer | null = null;
    if (file instanceof TFile) {
      bytes = await this.app.vault.readBinary(file);
    } else {
      // Adapter-only files (config dir, hidden files) get backups too.
      try {
        bytes = await this.app.vault.adapter.readBinary(path);
      } catch {
        return;
      }
    }
    if (!bytes) return;
    const backupPath = normalizePath(
      `.github-sync-backup/${formatBackupStamp(new Date())}/${path}`,
    );
    await this.writeVaultFile(backupPath, bytes);
  }

  async deleteVaultFile(path: string) {
    path = normalizePath(path);
    this.assertContained(path);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file) {
      this.pluginWrites.add(path);
      await this.app.vault.delete(file, true);
    } else {
      const exists = await this.app.vault.adapter.exists(path);
      if (exists) {
        this.pluginWrites.add(path);
        await this.app.vault.adapter.remove(path);
      }
    }
  }

  /**
   * Delete `.github-sync-backup/` snapshots older than BACKUP_RETENTION_DAYS.
   * Folders that aren't one of our stamps are left alone.
   * Best-effort: failures are logged, never thrown.
   */
  async pruneBackups(): Promise<void> {
    const root = ".github-sync-backup";
    try {
      if (!(await this.app.vault.adapter.exists(root))) return;
      const list = await this.app.vault.adapter.list(root);
      const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 24 * 3600 * 1000;
      for (const folder of list.folders) {
        const time = parseBackupStamp(folder.slice(root.length + 1));
        if (time === null || time >= cutoff) continue;
        try {
          await this.app.vault.adapter.rmdir(folder, true);
        } catch (e) {
          console.warn(`VaultSync: failed to prune backup ${folder}:`, e);
        }
      }
    } catch (e) {
      console.warn("VaultSync: backup pruning failed:", e);
    }
  }

  async assertRemoteDownloadable(path: string) {
    const size = this.getSyncManifest()[path]?.size;
    if (size) this.assertSyncableSize(path, size);
  }

  assertSyncableSize(path: string, size: number) {
    if (size > GITHUB_BLOB_LIMIT)
      throw new Error(
        `${path} is ${formatBytes(size)}, above GitHub's 100 MB file limit. Move it to Git LFS/external storage or ignore it.`,
      );
    if (size > GITHUB_RECOMMENDED_BLOB_LIMIT)
      new Notice(
        `${path} is ${formatBytes(size)}. GitHub allows it, but large files make mobile sync slow.`,
        8000,
      );
  }
}
