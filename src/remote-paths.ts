function normalizePathLikeObsidian(path: string): string {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .join("/");
}

/**
 * Key under which two paths alias the same file on a case-insensitive,
 * Unicode-normalizing filesystem (macOS, Windows). Every deny/allow/collision
 * comparison goes through this so `.Obsidian/…` cannot slip past a rule
 * written for `.obsidian/…`.
 */
export function canonicalPathKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

const CONFIG_DIR_SCRIPT = /\.(js|mjs|cjs)$/;

/**
 * Non-configurable deny list for config-dir paths. A hostile commit must
 * never be able to replace this plugin's own code (RCE on next launch) or
 * exfiltrate its token file, and no JavaScript may flow in either direction
 * under the config dir. Kept as a pure function so the rule is unit-tested
 * and cannot be weakened through the ignore-patterns textarea.
 */
export function isHardDeniedPath(
  path: string,
  configDir: string,
  pluginId: string,
): boolean {
  const key = canonicalPathKey(path);
  const configKey = canonicalPathKey(configDir);
  const pluginDir = `${configKey}/plugins/${canonicalPathKey(pluginId)}`;
  if (key === pluginDir || key.startsWith(pluginDir + "/")) return true;
  if (key.startsWith(configKey + "/") && CONFIG_DIR_SCRIPT.test(key))
    return true;
  return false;
}

/** Windows reserved device names (also rejected by GitHub on push). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Defense in depth for remote-controlled paths. GitHub's tree API and git
 * fsck normally reject entries like `..`, but a hostile or buggy remote must
 * never be able to make us write outside the vault. Returns false for any
 * segment that is empty/dot-dot, contains control chars (incl. NUL) or
 * Windows-invalid characters, ends in dot/space, or is a reserved device
 * name. Also rejects absolute paths and drive-letter prefixes outright.
 */
export function isSafePath(path: string): boolean {
  if (!path || path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return false;
  const segments = path.normalize("NFC").split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") return false;
    // eslint-disable-next-line no-control-regex
    if (/[\0-\x1f\x7f]/.test(seg)) return false;
    if (/[<>:"|?*]/.test(seg)) return false;
    if (/[. ]$/.test(seg)) return false;
    if (WINDOWS_RESERVED.test(seg)) return false;
  }
  return true;
}

function cleanRemoteRootSegment(segment: string): string {
  return segment
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function cleanRemoteRootPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .map(cleanRemoteRootSegment)
    // Dot segments are meaningless in a repo prefix and `..` could escape it.
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .join("/");
}

/**
 * The repository prefix this vault syncs under.
 *
 * When nestUnderVaultName is false (the default), the vault syncs to the
 * repository root (plus an optional rootPath subfolder) — i.e. repo paths
 * mirror vault paths 1:1. When true, files live under <vault-name>/[rootPath]/,
 * matching the original SuperSync layout.
 */
export function vaultRemotePrefix(
  vaultName: string,
  rootPath: string,
  nestUnderVaultName: boolean,
): string {
  const parts: string[] = [];
  if (nestUnderVaultName) parts.push(cleanRemoteRootSegment(vaultName));
  const root = cleanRemoteRootPath(rootPath);
  if (root) parts.push(root);
  return parts.filter(Boolean).join("/");
}

export function remotePath(prefix: string, path: string): string {
  const p = normalizePathLikeObsidian(path);
  return normalizePathLikeObsidian([prefix, p].filter(Boolean).join("/"));
}

export function localPath(prefix: string, path: string): string | null {
  // Reject absolute/drive paths on the RAW input, before normalization
  // strips the leading slash and hides the evidence.
  if (path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:/.test(path))
    return null;
  const p = normalizePathLikeObsidian(path);
  if (!isSafePath(p)) return null;

  // Empty prefix: the whole repository is this vault's scope.
  if (!prefix) return p;

  const pLower = p.toLowerCase();
  const prefixLower = prefix.toLowerCase();

  if (pLower === prefixLower) return "";
  return pLower.startsWith(`${prefixLower}/`) ? p.slice(prefix.length + 1) : null;
}

/**
 * Given the raw list of paths from GitHub's recursive tree API, find the
 * remote folder that belongs to this vault. With an empty expected prefix
 * the repository root itself is the scope.
 */
export function detectRemotePrefix(
  expectedPrefix: string,
  remotePaths: string[],
): string {
  if (!expectedPrefix) return "";

  const expectedLower = expectedPrefix.toLowerCase();
  const candidates = new Set<string>();

  for (const rp of remotePaths) {
    const firstSlash = rp.indexOf("/");
    if (firstSlash === -1) continue;
    candidates.add(rp.slice(0, firstSlash));
  }

  if (remotePaths.some((rp) => rp.startsWith(`${expectedPrefix}/`) || rp === expectedPrefix))
    return expectedPrefix;

  for (const rp of remotePaths) {
    const rpLower = rp.toLowerCase();
    if (rpLower.startsWith(`${expectedLower}/`) || rpLower === expectedLower)
      return rp.slice(0, expectedPrefix.length);
  }

  for (const candidate of candidates) {
    if (candidate.trim().toLowerCase() === expectedLower) {
      return candidate.trim();
    }
  }

  return expectedPrefix;
}
