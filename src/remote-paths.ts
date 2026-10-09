function normalizePathLikeObsidian(path: string): string {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .join("/");
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
    .filter(Boolean)
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
  const p = normalizePathLikeObsidian(path);

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
