import { App, Notice, TFile, normalizePath } from "obsidian";
import { Settings } from "../types";
import { Manifest, formatBackupStamp, parseBackupStamp } from "../sync-core";
import {
  vaultRemotePrefix,
  detectRemotePrefix as detectRemotePrefixForVault,
  localPath as localPathForVault,
  remotePath as remotePathForVault,
  isSafePath,
  isHardDeniedPath,
  canonicalPathKey,
} from "../remote-paths";
import { gitBlobSha, matchesPattern, formatBytes } from "./helpers";
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

  /** Call at the start of every sync so stale write-guards don't suppress real user edits. */
  clearPluginWrites() {
    this.pluginWrites.clear();
    this.warnedUnsafeLocal.clear();
  }

  constructor(
    private app: App,
    private getSettings: () => Settings,
    private getSyncManifest: () => Manifest,
  ) {}

  /**
   * Whether a vault path is excluded from sync (both directions).
   *
   * Hard denies come FIRST and are not user-configurable: trimming the
   * ignore-patterns textarea can never re-enable them.
   */
  isIgnored(path: string): boolean {
    path = normalizePath(path).normalize("NFC");
    const configDir = this.app.vault.configDir;
    const settings = this.getSettings();

    // Hard deny 1: our own plugin directory. A hostile commit must never be
    // able to replace this plugin's code (RCE on next Obsidian launch) or
    // exfiltrate its token file. Plugin updates come from BRAT/releases.
    // Hard deny 2: no JavaScript under the config dir, either direction.
    // (Pure-function rule in remote-paths.ts; unit-tested, not configurable.)
    if (isHardDeniedPath(path, configDir, PLUGIN_ID)) return true;

    // Config-dir allowlist (replaces the old "sync the whole .obsidian dir").
    // Compared on canonical keys: `.Obsidian/App.json` is `.obsidian/app.json`
    // on a case-insensitive filesystem.
    const key = canonicalPathKey(path);
    const configKey = canonicalPathKey(configDir);
    if (key === configKey || key.startsWith(configKey + "/")) {
      // Exact-file allowlist for Obsidian settings sync.
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
      // Community plugin folders (code excluded by hard deny 2 above).
      if (
        settings.syncCommunityPlugins &&
        key.startsWith(`${configKey}/plugins/`)
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

  /**
   * Given the raw list of paths from GitHub's recursive tree API, find the
   * remote folder that belongs to this vault.
   */
  detectRemotePrefix(remotePaths: string[]): string {
    return detectRemotePrefixForVault(this.prefix(), remotePaths);
  }

  conflictPath(path: string): string {
    const stamp = new Date().toISOString().replace(CONFLICT_STAMP, "-");
    const dot = path.lastIndexOf(".");
    return dot > -1
      ? `${path.slice(0, dot)}.conflict-${stamp}${path.slice(dot)}`
      : `${path}.conflict-${stamp}`;
  }

  restoredPath(path: string, commitSha: string): string {
    const dot = path.lastIndexOf(".");
    const suffix = `.restored-${commitSha.slice(0, 8)}`;
    return dot > -1
      ? `${path.slice(0, dot)}${suffix}${path.slice(dot)}`
      : `${path}${suffix}`;
  }

  async listAllSyncablePaths(): Promise<string[]> {
    const paths = this.app.vault.getFiles().map((f) => f.path);
    const settings = this.getSettings();
    if (settings.syncObsidianConfig) {
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
    return syncable;
  }

  private async scanFolderRecursive(folderPath: string, paths: string[]): Promise<void> {
    try {
      const exists = await this.app.vault.adapter.exists(folderPath);
      if (!exists) return;
      
      const list = await this.app.vault.adapter.list(folderPath);
      for (const file of list.files) {
        paths.push(file);
      }
      for (const folder of list.folders) {
        if (!this.isIgnored(folder)) {
          await this.scanFolderRecursive(folder, paths);
        }
      }
    } catch (e) {
      console.error(`Failed to scan folder ${folderPath}:`, e);
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
      let bytes: ArrayBuffer;
      if (file instanceof TFile) {
        bytes = await this.app.vault.readBinary(file);
      } else {
        // Hidden file or config file (read directly from adapter)
        bytes = await this.app.vault.adapter.readBinary(path);
      }
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

  async ensureDirectoryExists(path: string) {
    const parts = path.split("/");
    parts.pop(); // Remove file name
    
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
    const configDir = this.app.vault.configDir;
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, bytes);
    } else if (path.startsWith(configDir + "/")) {
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
