import { requestUrl, App, Notice, TFile } from "obsidian";
import { Settings, DeviceTokenResponse, VersionEntry } from "../types";
import { RemoteTree, Change, Manifest } from "../sync-core";
import { VaultHelper } from "./vault";
import { isSafePath, canonicalPathKey } from "../remote-paths";
import {
  sleep,
  encodePath,
  base64FromBytes,
  bytesFromBase64,
  gitBlobSha,
  formatBytes,
} from "./helpers";
import { GITHUB_BLOB_LIMIT } from "../constants";

export class RemoteAdvancedError extends Error {}

/** GitHub API failure with the HTTP status attached for retry decisions. */
export class GithubApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfterMs?: number,
    /** True only when GitHub is rate limiting us; a plain 403 is a permission error. */
    public rateLimited = false,
  ) {
    super(message);
  }
}

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

/**
 * How long GitHub wants us to wait: Retry-After when present, else the
 * X-RateLimit-Reset epoch. Undefined when neither header is usable.
 */
function retryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  const retryAfter = parseInt(header(headers, "retry-after") ?? "", 10);
  if (Number.isFinite(retryAfter)) return retryAfter * 1000;
  const reset = parseInt(header(headers, "x-ratelimit-reset") ?? "", 10);
  if (Number.isFinite(reset)) return Math.max(0, reset * 1000 - Date.now());
  return undefined;
}

export class GithubClient {
  public onStatusUpdate?: (status: string) => void;

  constructor(
    private app: App,
    private getSettings: () => Settings,
    private saveSettings: () => Promise<void>,
    private vaultHelper: VaultHelper,
  ) {}

  async github<T = unknown>(
    method: string,
    endpoint: string,
    body?: unknown,
  ): Promise<T> {
    const settings = this.getSettings();
    return this.githubRaw<T>(
      method,
      `repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}${endpoint}`,
      body,
      false,
    );
  }

  async githubRaw<T = unknown>(
    method: string,
    endpoint: string,
    body?: unknown,
    allowFailure = false,
    baseUrl = "https://api.github.com/",
    retried = false,
  ): Promise<T & { ok?: boolean; status?: number; message?: string }> {
    const settings = this.getSettings();
    const url = endpoint.startsWith("http")
      ? endpoint
      : `${baseUrl.replace(/\/$/, "")}/${endpoint.replace(/^\//, "")}`;
    // Never attach the token to an unrecognized host (e.g. a redirect
    // target or a caller-supplied absolute URL). Callers are all hardcoded
    // today; this is defense in depth for future ones.
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
    };
    try {
      const origin = new URL(url).origin;
      if (origin === "https://api.github.com" || origin === "https://github.com")
        headers.Authorization = `Bearer ${settings.token}`;
    } catch {
      throw new Error(`Refusing to call malformed URL: ${url}`);
    }
    const response = await requestUrl({
      url,
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      throw: false,
    });
    // GitHub App user tokens expire after 8 hours. On a 401, try one token
    // refresh (if we have a refresh token) and retry the request once.
    if (response.status === 401 && !retried && settings.refreshToken) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed)
        return this.githubRaw<T>(method, endpoint, body, allowFailure, baseUrl, true);
    }
    if (response.status < 200 || response.status >= 300) {
      const message =
        typeof response.json === "object" && response.json?.message
          ? response.json.message
          : response.text;
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 &&
          (header(response.headers, "x-ratelimit-remaining") === "0" ||
            /rate limit|abuse/i.test(String(message))));
      // Throttling is never an "allowed" failure: callers must see it as a
      // rate limit so auto-sync pauses instead of treating it as a lookup miss.
      if (allowFailure && !rateLimited)
        return { ok: false, status: response.status, message } as T & {
          ok: boolean;
          status: number;
          message: string;
        };
      throw new GithubApiError(
        `GitHub ${method} ${endpoint} failed (${response.status}): ${message}`,
        response.status,
        retryAfterMs(response.headers),
        rateLimited,
      );
    }
    if (allowFailure && typeof response.json === "object")
      return Object.assign(response.json ?? {}, {
        ok: true,
        status: response.status,
      }) as T & {
        ok: boolean;
        status: number;
      };
    return response.json as T & {
      ok?: boolean;
      status?: number;
      message?: string;
    };
  }

  async githubOauth<T>(
    method: string,
    endpoint: string,
    body: unknown,
  ): Promise<T> {
    const response = await requestUrl({
      url: `https://github.com${endpoint}`,
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      throw: false,
    });
    if (response.status < 200 || response.status >= 300)
      throw new Error(
        `GitHub OAuth failed (${response.status}): ${response.text}`,
      );
    return response.json as T;
  }

  async githubUser(): Promise<{ login: string }> {
    return this.githubRaw<{ login: string }>(
      "GET",
      "/user",
      undefined,
      false,
      "https://api.github.com",
    );
  }

  /**
   * Rotate the GitHub App user token using the stored refresh token.
   * User tokens expire after 8 hours; refresh tokens after 6 months.
   * Returns true if a fresh token was stored. No-op for PAT-based setups.
   *
   * Single-flight: concurrent callers (sync + version history) share one
   * in-flight refresh so an out-of-order response can't persist an
   * already-rotated refresh token.
   */
  private refreshPromise: Promise<boolean> | null = null;

  async refreshAccessToken(): Promise<boolean> {
    if (!this.refreshPromise)
      this.refreshPromise = this.doRefreshAccessToken().finally(() => {
        this.refreshPromise = null;
      });
    return this.refreshPromise;
  }

  private async doRefreshAccessToken(): Promise<boolean> {
    const settings = this.getSettings();
    if (!settings.refreshToken || !settings.deviceFlowClientId.trim())
      return false;
    try {
      const result = await this.githubOauth<DeviceTokenResponse>(
        "POST",
        "/login/oauth/access_token",
        {
          client_id: settings.deviceFlowClientId.trim(),
          grant_type: "refresh_token",
          refresh_token: settings.refreshToken,
        },
      );
      if (!result.access_token || !result.refresh_token) return false;
      settings.token = result.access_token;
      settings.refreshToken = result.refresh_token;
      settings.tokenExpiresAt =
        Date.now() + (result.expires_in ?? 8 * 3600) * 1000;
      await this.saveSettings();
      return true;
    } catch {
      return false;
    }
  }

  async ensureRepositoryReady() {
    this.onStatusUpdate?.("checking credentials...");
    const settings = this.getSettings();
    if (!settings.owner.trim()) {
      const user = await this.githubUser();
      settings.owner = user.login;
      await this.saveSettings();
    }

    this.onStatusUpdate?.("verifying repository exists...");
    const repo = await this.githubRaw<{ default_branch?: string }>(
      "GET",
      `/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}`,
      undefined,
      true,
    );
    if (!repo.ok) {
      if (repo.status !== 404)
        throw new Error(
          `GitHub repo lookup failed (${repo.status}): ${repo.message}`,
        );
      // Never auto-create here: a repo-name typo must not silently resolve
      // to an empty repo (which would plan a mass local delete). Creation is
      // an explicit button in settings.
      throw new Error(
        `Repository ${settings.owner}/${settings.repo} was not found (or the GitHub App cannot access it). Check the name, install the app on the repo, or create it with the "Create repository" button in settings.`,
      );
    }

    this.onStatusUpdate?.("checking branch reference...");
    const branch = await this.githubRaw(
      "GET",
      `/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}/git/ref/heads/${encodeURIComponent(settings.branch)}`,
      undefined,
      true,
    );
    if (!branch.ok) {
      if (settings.branch !== "main")
        throw new Error(
          `Branch ${settings.branch} does not exist. Create it on GitHub or use main.`,
        );
      throw new Error(
        "New repository is still initializing on GitHub. Wait a few seconds and sync again.",
      );
    }
  }

  /**
   * Explicit repository creation (settings button). Kept separate from
   * ensureRepositoryReady so a typo'd repo name can never silently become an
   * empty repo during a sync.
   */
  async createRepository(): Promise<void> {
    const settings = this.getSettings();
    const name = settings.repo.trim();
    if (!name) throw new Error("Set a repository name first.");
    this.onStatusUpdate?.("creating remote repository...");
    await this.githubRaw(
      "POST",
      "/user/repos",
      {
        name,
        private: true,
        auto_init: true,
        description:
          "VaultSync private Obsidian vault synchronization repository.",
      },
      false,
    );
  }

  async remoteTree(): Promise<{
    headSha: string;
    treeSha: string;
    tree: RemoteTree;
  }> {
    this.onStatusUpdate?.("fetching remote tree...");
    const settings = this.getSettings();
    const ref = await this.github<{ object: { sha: string } }>(
      "GET",
      `/git/ref/heads/${encodeURIComponent(settings.branch)}?t=${Date.now()}`,
    );
    const commit = await this.github<{ tree: { sha: string } }>(
      "GET",
      `/git/commits/${ref.object.sha}`,
    );
    const treeResponse = await this.github<{
      tree: Array<{ path: string; type: string; sha: string; size?: number }>;
      truncated?: boolean;
    }>("GET", `/git/trees/${commit.tree.sha}?recursive=1`);
    if (treeResponse.truncated)
      throw new Error(
        "GitHub truncated the repository tree. Split the vault with Root path or reduce repository size before syncing.",
      );
    const tree: RemoteTree = {};
    const rawPaths = treeResponse.tree.filter(i => i.type === "blob").map(i => i.path);
    const remotePrefix = this.vaultHelper.detectRemotePrefix(rawPaths);
    // Collision map: two remote entries must never silently resolve to the
    // same local file (case-only or NFC/NFD-only duplicates).
    const seenLocal = new Map<string, string>();
    const skipped: string[] = [];
    for (const item of treeResponse.tree) {
      if (item.type !== "blob") continue;
      if (!isSafePath(item.path)) {
        skipped.push(`unsafe path: ${item.path}`);
        continue;
      }
      const path = this.vaultHelper.localPath(item.path, remotePrefix);
      if (!path || this.vaultHelper.isIgnored(path)) continue;
      const collisionKey = canonicalPathKey(path);
      const firstSeen = seenLocal.get(collisionKey);
      if (firstSeen !== undefined && firstSeen !== item.path) {
        skipped.push(`path collision: ${item.path} collides with ${firstSeen}`);
        continue;
      }
      seenLocal.set(collisionKey, item.path);
      if (item.size && item.size > GITHUB_BLOB_LIMIT)
        throw new Error(
          `${path} is ${formatBytes(item.size)}, above GitHub's 100 MB file limit. Move it to Git LFS/external storage or ignore it.`,
        );
      tree[path] = { sha: item.sha, size: item.size };
    }
    if (skipped.length) {
      console.warn(`VaultSync skipped remote entries:\n${skipped.join("\n")}`);
      new Notice(
        `VaultSync skipped ${skipped.length} remote file(s) (unsafe or colliding paths); they were left untouched. See the console for details.`,
        10000,
      );
    }
    return { headSha: ref.object.sha, treeSha: commit.tree.sha, tree };
  }

  /**
   * Download a file's bytes. When `expectedSha` (the blob SHA from the tree)
   * is given, fetch the immutable blob directly and verify the SHA before
   * returning — the branch can advance between planning and download, but a
   * blob SHA cannot change under us.
   */
  async downloadBytes(path: string, expectedSha?: string): Promise<ArrayBuffer> {
    await this.vaultHelper.assertRemoteDownloadable(path);
    if (expectedSha) {
      const data = await this.github<{ content: string; encoding: string }>(
        "GET",
        `/git/blobs/${expectedSha}`,
      );
      if (data.encoding !== "base64")
        throw new Error(`Unsupported GitHub blob encoding for ${path}`);
      const bytes = bytesFromBase64(data.content.replace(/\s/g, ""));
      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const actualSha = await gitBlobSha(buffer);
      if (actualSha !== expectedSha)
        throw new Error(
          `SHA mismatch downloading ${path}: expected ${expectedSha}, got ${actualSha}`,
        );
      return buffer;
    }
    const settings = this.getSettings();
    const data = await this.github<{ content: string; encoding: string; download_url?: string }>(
      "GET",
      `/contents/${encodePath(this.vaultHelper.remotePath(path))}?ref=${encodeURIComponent(settings.branch)}`,
    );
    // GitHub returns encoding="none" with a download_url for files >1 MB.
    if (data.encoding === "none" && data.download_url) {
      const response = await requestUrl({ url: data.download_url, method: "GET", throw: false });
      if (response.status < 200 || response.status >= 300)
        throw new Error(`Failed to download ${path} (${response.status})`);
      return response.arrayBuffer;
    }
    if (data.encoding !== "base64")
      throw new Error(`Unsupported GitHub content encoding for ${path}`);
    const bytes = bytesFromBase64(data.content.replace(/\s/g, ""));
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
  }

  /**
   * Download a file as of `commitSha` (version restore). The contents API
   * returns the blob SHA alongside the content, so the bytes are verified
   * against it before they are handed back, like a sync download.
   */
  async downloadBytesAtCommit(
    path: string,
    commitSha: string,
  ): Promise<ArrayBuffer> {
    const data = await this.github<{
      sha: string;
      content: string;
      encoding: string;
      size?: number;
      download_url?: string;
    }>(
      "GET",
      `/contents/${encodePath(this.vaultHelper.remotePath(path))}?ref=${encodeURIComponent(commitSha)}`,
    );
    if (data.size) this.vaultHelper.assertSyncableSize(path, data.size);
    let buffer: ArrayBuffer;
    // GitHub returns encoding="none" with a download_url for files >1 MB.
    if (data.encoding === "none" && data.download_url) {
      const response = await requestUrl({ url: data.download_url, method: "GET", throw: false });
      if (response.status < 200 || response.status >= 300)
        throw new Error(`Failed to download ${path} (${response.status})`);
      buffer = response.arrayBuffer;
    } else {
      if (data.encoding !== "base64")
        throw new Error(`Unsupported GitHub content encoding for ${path}`);
      const bytes = bytesFromBase64(data.content.replace(/\s/g, ""));
      buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
    }
    const actualSha = await gitBlobSha(buffer);
    if (actualSha !== data.sha)
      throw new Error(
        `SHA mismatch downloading ${path}: expected ${data.sha}, got ${actualSha}`,
      );
    return buffer;
  }

  async fileVersions(path: string): Promise<VersionEntry[]> {
    const settings = this.getSettings();
    const commits = await this.github<
      Array<{
        sha: string;
        commit: { message: string; author?: { date?: string } };
      }>
    >(
      "GET",
      `/commits?sha=${encodeURIComponent(settings.branch)}&path=${encodePath(this.vaultHelper.remotePath(path))}&per_page=50`,
    );
    return commits.map((commit) => ({
      sha: commit.sha,
      message: commit.commit.message.split("\n")[0],
      date: commit.commit.author?.date ?? "",
    }));
  }

  /**
   * Commit, and on a concurrent-push race replan against the fresh tree and
   * commit once more. `retryChanges` is the replanned set actually applied
   * (empty when the first commit went through) so the caller can treat its
   * downloads as pending in the manifest exactly like first-plan ones.
   */
  async commitRemoteChangesWithRetry(
    changes: Change[],
    remoteInfo: { headSha: string; treeSha: string; tree: RemoteTree },
    remote: RemoteTree,
    localManifestCallback: () => Promise<Manifest>,
    planChangesCallback: (local: Manifest, tree: RemoteTree) => Change[],
    resolveConflictsCallback: (changes: Change[], local: Manifest) => Promise<Change[]>,
    applyLocalChangesCallback: (changes: Change[], local: Manifest) => Promise<unknown>,
  ): Promise<{ remote: RemoteTree; commitSha?: string; retryChanges: Change[] }> {
    try {
      return { ...(await this.commitRemoteChanges(changes, remoteInfo, remote)), retryChanges: [] };
    } catch (error) {
      if (!(error instanceof RemoteAdvancedError)) throw error;
      const fresh = await this.remoteTree();
      const local = await localManifestCallback();
      const retryChanges = await resolveConflictsCallback(
        planChangesCallback(local, fresh.tree),
        local,
      );
      // Apply the download side BEFORE committing. The replan can contain
      // downloads the first plan didn't have; without this they land in
      // nextRemote but not in the local manifest, and the manifest would
      // tombstone them — the next sync would then deleteRemote what the
      // other device just pushed.
      await applyLocalChangesCallback(retryChanges, local);
      const retryRemote = { ...fresh.tree };
      return { ...(await this.commitRemoteChanges(retryChanges, fresh, retryRemote)), retryChanges };
    }
  }

  async commitRemoteChanges(
    changes: Change[],
    remoteInfo: { headSha: string; treeSha: string; tree: RemoteTree },
    remote: RemoteTree,
  ): Promise<{ remote: RemoteTree; commitSha?: string }> {
    const settings = this.getSettings();
    const tree: Array<{
      path: string;
      mode: string;
      type: string;
      sha: string | null;
    }> = [];
    const touched = new Set<string>();
    
    const totalUploads = changes.filter(c => c.type === "upload").length;
    let currentUpload = 0;

    for (const change of changes) {
      if (touched.has(change.path)) continue;
      touched.add(change.path);
      if (change.type === "upload") {
        currentUpload++;
        this.onStatusUpdate?.(`uploading files (${currentUpload}/${totalUploads})...`);
        let bytes: ArrayBuffer;
        const file = this.app.vault.getAbstractFileByPath(change.path);
        if (file instanceof TFile) {
          bytes = await this.app.vault.readBinary(file);
        } else {
          // Config-dir / hidden files aren't TFiles; read via the adapter.
          try {
            bytes = await this.app.vault.adapter.readBinary(change.path);
          } catch {
            console.warn(`VaultSync: skipping upload, file vanished: ${change.path}`);
            continue;
          }
        }
        this.vaultHelper.assertSyncableSize(change.path, bytes.byteLength);
        const blob = await this.github<{ sha: string }>("POST", "/git/blobs", {
          content: base64FromBytes(bytes),
          encoding: "base64",
        });
        tree.push({
          path: this.vaultHelper.remotePath(change.path),
          mode: "100644",
          type: "blob",
          sha: blob.sha,
        });
        remote[change.path] = {
          sha: await gitBlobSha(bytes),
          size: bytes.byteLength,
        };
      }
      if (change.type === "deleteRemote") {
        tree.push({
          path: this.vaultHelper.remotePath(change.path),
          mode: "100644",
          type: "blob",
          sha: null,
        });
        delete remote[change.path];
      }
    }
    if (tree.length === 0) return { remote };
    this.onStatusUpdate?.("creating remote tree...");
    const newTree = await this.github<{ sha: string }>("POST", "/git/trees", {
      base_tree: remoteInfo.treeSha,
      tree,
    });
    
    this.onStatusUpdate?.("creating git commit...");
    const commit = await this.github<{ sha: string }>("POST", "/git/commits", {
      message: `Obsidian sync ${new Date().toISOString()}`,
      tree: newTree.sha,
      parents: [remoteInfo.headSha],
      // Manual/Obsidian-side commits stay visibly Shaun's (author = committer).
      // (Commits this plugin makes on its own behalf are not a thing; the
      // only automated path is the sync itself.)
      author: {
        name: settings.authorName,
        email: settings.authorEmail,
      },
      committer: {
        name: settings.authorName,
        email: settings.authorEmail,
      },
    });
    
    this.onStatusUpdate?.("pushing reference patch...");
    try {
      await this.github(
        "PATCH",
        `/git/refs/heads/${encodeURIComponent(settings.branch)}`,
        {
          sha: commit.sha,
          force: false,
        },
      );
    } catch (error) {
      const status = error instanceof GithubApiError ? error.status : 0;
      // Only genuine concurrent-write races (someone else pushed first) are
      // retried. Throttling (403/429), auth failures, and everything else
      // must NOT be replayed immediately.
      if (status === 409 || status === 422) {
        throw new RemoteAdvancedError(
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
    return { remote, commitSha: commit.sha };
  }

  async checkDeviceToken(
    clientId: string,
    deviceCode: string,
  ): Promise<DeviceTokenResponse> {
    return this.githubOauth<DeviceTokenResponse>("POST", "/login/oauth/access_token", {
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
  }
}
