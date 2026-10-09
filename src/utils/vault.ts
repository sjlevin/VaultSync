import { App, Notice, TFile, normalizePath } from "obsidian";
import { Settings } from "../types";
import { Manifest } from "../sync-core";
import {
  vaultRemotePrefix,
  detectRemotePrefix as detectRemotePrefixForVault,
  localPath as localPathForVault,
  remotePath as remotePathForVault,
} from "../remote-paths";
import { gitBlobSha, matchesPattern, formatBytes } from "./helpers";
import {
  PLUGIN_ID,
  CONFLICT_STAMP,
  GITHUB_BLOB_LIMIT,
  GITHUB_RECOMMENDED_BLOB_LIMIT,
} from "../constants";

export class VaultHelper {
  public pluginWrites = new Set<string>();

  /** Call at the start of every sync so stale write-guards don't suppress real user edits. */
  clearPluginWrites() {
    this.pluginWrites.clear();
  }

  constructor(
    private app: App,
    private getSettings: () => Settings,
    private getSyncManifest: () => Manifest,
  ) {}

  isIgnored(path: string): boolean {
    path = normalizePath(path);
    const settings = this.getSettings();
    const configDir = this.app.vault.configDir;
    if (!settings.syncObsidianConfig && path.startsWith(configDir + "/"))
      return true;
    if (
      !settings.syncCommunityPlugins &&
      path.startsWith(configDir + "/plugins/") &&
      !path.startsWith(`${configDir}/plugins/${PLUGIN_ID}/`)
    )
      return true;
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
    return paths.filter((p) => {
      if (this.isIgnored(p)) return false;
      if (seen.has(p)) return false;
      seen.add(p);
      return true;
    });
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
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const bytes = await this.app.vault.readBinary(file);
    const backupPath = normalizePath(
      `.github-sync-backup/${new Date().toISOString().replace(CONFLICT_STAMP, "-")}/${path}`,
    );
    await this.writeVaultFile(backupPath, bytes);
  }

  async deleteVaultFile(path: string) {
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
