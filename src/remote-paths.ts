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

/** Matched per segment so a directory named `main.js/` is denied too. */
const CONFIG_DIR_SCRIPT_SEGMENT = /\.[cm]?jsx?$/i;

/** Local-only roots that must never sync whatever the ignore list says. */
const HARD_DENIED_ROOTS = new Set([".git", ".trash", ".github-sync-backup"]);

/**
 * Non-configurable deny list. A hostile commit must never be able to replace
 * this plugin's own code (RCE on next launch) or exfiltrate its token file,
 * no JavaScript may flow in either direction under the config dir, and
 * another plugin's folder may only contribute its `data.json` (a remote
 * `manifest.json` could repoint that plugin's `main` at an arbitrary file).
 * Kept as a pure function so the rule is unit-tested and cannot be weakened
 * through the ignore-patterns textarea.
 */
export function isHardDeniedPath(
  path: string,
  configDir: string,
  pluginId: string,
): boolean {
  const key = canonicalPathKey(path);
  const segments = key.split("/");
  if (HARD_DENIED_ROOTS.has(segments[0])) return true;
  const configKey = canonicalPathKey(configDir);
  if (!key.startsWith(configKey + "/")) return false;
  const rest = key.slice(configKey.length + 1).split("/");
  if (rest.some((seg) => CONFIG_DIR_SCRIPT_SEGMENT.test(seg))) return true;
  if (rest[0] !== "plugins" || rest.length < 2) return false;
  if (rest[1] === canonicalPathKey(pluginId)) return true;
  return rest.length > 2 && !(rest.length === 3 && rest[2] === "data.json");
}

/** True for a full git object id (SHA-1 or SHA-256) and nothing else. */
export function isGitSha(sha: unknown): sha is string {
  return typeof sha === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha);
}

/**
 * Ignore-pattern match on canonical keys, so a rule written as `Secrets/**`
 * also covers `secrets/x` and its NFD spelling. Patterns are exact paths,
 * `<folder>/**` prefixes, or `*` wildcards.
 */
export function matchesPattern(path: string, pattern: string): boolean {
  const key = canonicalPathKey(normalizePathLikeObsidian(path));
  pattern = canonicalPathKey(normalizePathLikeObsidian(pattern));
  if (pattern.endsWith("/**")) {
    const root = pattern.slice(0, -3);
    return key === root || key.startsWith(root + "/");
  }
  if (!pattern.includes("*")) return key === pattern;
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(key);
}

/** `notes/a.md` -> `notes/a.conflict-<stamp>.md`; only the basename is split. */
export function conflictCopyPath(path: string, stamp: string): string {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? `${dir}${name.slice(0, dot)}.conflict-${stamp}${name.slice(dot)}`
    : `${dir}${name}.conflict-${stamp}`;
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

function splitSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/**
 * Whether `segments` starts with `prefix`, compared per segment on canonical
 * keys. Lengths are measured on the source strings, never on a lowercased
 * copy: `İ` lowercases to two code points.
 */
function hasPrefixSegments(
  segments: string[],
  prefix: string[],
  clean = (seg: string): string => seg,
): boolean {
  if (segments.length < prefix.length) return false;
  return prefix.every(
    (seg, i) => canonicalPathKey(clean(segments[i])) === canonicalPathKey(seg),
  );
}

/**
 * The part of a remote path below this vault's prefix, or null when it lies
 * outside it. No safety check: this is only for naming an entry that
 * localPath() refuses, in the local path space.
 */
export function stripRemotePrefix(prefix: string, path: string): string | null {
  const p = normalizePathLikeObsidian(path);
  // Empty prefix: the whole repository is this vault's scope.
  if (!prefix) return p;
  const segments = splitSegments(p);
  const prefixSegments = splitSegments(prefix);
  if (!hasPrefixSegments(segments, prefixSegments)) return null;
  return segments.slice(prefixSegments.length).join("/");
}

export function localPath(prefix: string, path: string): string | null {
  // Reject absolute/drive paths on the RAW input, before normalization
  // strips the leading slash and hides the evidence.
  if (path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:/.test(path))
    return null;
  if (!isSafePath(normalizePathLikeObsidian(path))) return null;
  return stripRemotePrefix(prefix, path);
}

/**
 * Given the raw list of paths from GitHub's recursive tree API, find the
 * remote folder that belongs to this vault. With an empty expected prefix
 * the repository root itself is the scope. The returned prefix is always a
 * verbatim slice of a remote path so that localPath() can strip it again.
 */
export function detectRemotePrefix(
  expectedPrefix: string,
  remotePaths: string[],
): string {
  if (!expectedPrefix) return "";
  const expected = splitSegments(expectedPrefix);

  if (remotePaths.some((rp) => rp.startsWith(`${expectedPrefix}/`) || rp === expectedPrefix))
    return expectedPrefix;

  for (const clean of [(seg: string) => seg, cleanRemoteRootSegment]) {
    for (const rp of remotePaths) {
      const segments = splitSegments(rp);
      if (hasPrefixSegments(segments, expected, clean))
        return segments.slice(0, expected.length).join("/");
    }
  }

  return expectedPrefix;
}
