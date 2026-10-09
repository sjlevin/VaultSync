export interface ManifestEntry {
  sha: string;
  remoteSha: string | null;
  size?: number;
  id?: string;
}

export type Manifest = Record<string, ManifestEntry>;
export type RemoteTree = Record<string, { sha: string; size?: number }>;

export type ConflictKind =
  | "both_modified"
  | "both_added"
  | "local_modified_remote_deleted"
  | "local_deleted_remote_modified";

export type Change =
  | { type: "upload"; path: string }
  | { type: "download"; path: string; remoteSha: string }
  | { type: "downloadConflictCopy"; path: string; remoteSha: string }
  | { type: "deleteLocal"; path: string }
  | { type: "deleteRemote"; path: string }
  | { type: "conflict"; path: string; remoteSha: string | null; kind: ConflictKind };

export function planChanges(
  local: Manifest,
  remote: RemoteTree,
  baseManifest: Manifest,
  isIgnored: (path: string) => boolean = () => false,
): Change[] {
  const changes: Change[] = [];
  const paths = new Set([
    ...Object.keys(local),
    ...Object.keys(remote),
    ...Object.keys(baseManifest),
  ]);
  for (const path of [...paths].sort()) {
    if (isIgnored(path)) continue;
    const base = baseManifest[path];
    const localEntry = local[path];
    const remoteEntry = remote[path];
    const baseLocal = base?.sha ?? null;
    const baseRemote = base?.remoteSha ?? null;
    const localSha = localEntry?.sha ?? null;
    const remoteSha = remoteEntry?.sha ?? null;
    const localChanged = localSha !== baseLocal;
    const remoteChanged = remoteSha !== baseRemote;

    if (localSha && remoteSha && localSha === remoteSha) continue;

    if (localSha && remoteSha && !base && localSha !== remoteSha)
      changes.push({ type: "conflict", path, remoteSha, kind: "both_added" });
    else if (localSha && !remoteSha && !base) changes.push({ type: "upload", path });
    else if (!localSha && remoteSha && !base) changes.push({ type: "download", path, remoteSha });
    else if (localChanged && remoteChanged && localSha && remoteSha)
      changes.push({ type: "conflict", path, remoteSha, kind: "both_modified" });
    else if (localChanged && remoteChanged && localSha && !remoteSha)
      changes.push({
        type: "conflict",
        path,
        remoteSha: null,
        kind: "local_modified_remote_deleted",
      });
    else if (localChanged && remoteChanged && !localSha && remoteSha)
      changes.push({ type: "conflict", path, remoteSha, kind: "local_deleted_remote_modified" });
    else if (localChanged && localSha) changes.push({ type: "upload", path });
    else if (localChanged && !localSha) changes.push({ type: "deleteRemote", path });
    else if (remoteChanged && remoteSha) changes.push({ type: "download", path, remoteSha });
    else if (remoteChanged && !remoteSha) changes.push({ type: "deleteLocal", path });
  }
  return changes;
}

export function planPullChanges(
  local: Manifest,
  remote: RemoteTree,
  baseManifest: Manifest,
  isIgnored: (path: string) => boolean = () => false,
): Change[] {
  const changes: Change[] = [];
  const paths = new Set([
    ...Object.keys(remote),
    ...Object.keys(baseManifest),
  ]);
  for (const path of [...paths].sort()) {
    if (isIgnored(path)) continue;
    const localSha = local[path]?.sha ?? null;
    const remoteSha = remote[path]?.sha ?? null;
    const baseSha = baseManifest[path]?.sha ?? null;

    if (remoteSha) {
      if (localSha !== remoteSha)
        changes.push({ type: "download", path, remoteSha });
      continue;
    }

    if (localSha && baseSha && localSha === baseSha)
      changes.push({ type: "deleteLocal", path });
  }
  return changes;
}

/** Share of files above which a mass-delete plan needs confirmation. */
export const MASS_DELETE_FRACTION = 0.25;
/** Absolute delete count that always needs confirmation, however big the vault. */
export const MASS_DELETE_ABSOLUTE = 10;

export function exceedsMassDeleteThreshold(
  deleteCount: number,
  totalFileCount: number,
): boolean {
  return (
    deleteCount >= 1 &&
    (deleteCount > totalFileCount * MASS_DELETE_FRACTION ||
      deleteCount >= MASS_DELETE_ABSOLUTE)
  );
}

/** Folder name for a backup snapshot: ISO-8601 with `:` and `.` replaced by `-`. */
export function formatBackupStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

const BACKUP_STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

/** Inverse of formatBackupStamp; null for anything that isn't one of our stamps. */
export function parseBackupStamp(folderName: string): number | null {
  const m = BACKUP_STAMP.exec(folderName);
  if (!m) return null;
  const time = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  if (!Number.isFinite(time)) return null;
  // Date.parse rolls impossible dates forward (Feb 31 -> Mar 3); only a stamp
  // that round-trips exactly is one we wrote.
  return formatBackupStamp(new Date(time)) === folderName ? time : null;
}

/**
 * Merge the post-sync local and remote states into the next manifest.
 *
 * `pendingDownloads` holds paths this sync planned to download but that are
 * absent from `local` (download not yet applied, or the mobile file index
 * lagging). Those must NOT be tombstoned: a tombstone
 * ({sha:"", remoteSha}) makes the next planChanges emit `deleteRemote` for
 * them — deleting from GitHub what the other side just added.
 */
export function nextManifest(
  local: Manifest,
  remote: RemoteTree,
  isIgnored: (path: string) => boolean = () => false,
  pendingDownloads: Set<string> = new Set(),
): Manifest {
  const next: Manifest = {};
  for (const path of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    if (isIgnored(path)) continue;
    if (local[path] && remote[path]) {
      // Use the remote SHA (the version actually synced) as the base for both
      // local and remote in the manifest. If the local file was modified
      // concurrently during sync, its current localSha will differ from the
      // remoteSha, correctly prompting an upload in the next sync.
      const remoteSha = remote[path].sha;
      next[path] = {
        sha: remoteSha,
        remoteSha: remoteSha,
        size: remote[path].size ?? local[path].size,
      };
    } else if (!local[path] && remote[path]) {
      if (pendingDownloads.has(path)) continue;
      // File exists on remote but was deleted locally. Record a tombstone so
      // the next sync knows the deletion was intentional and plans
      // deleteRemote instead of re-downloading the file.
      next[path] = {
        sha: "",
        remoteSha: remote[path].sha,
        size: remote[path].size,
      };
    }
    // If local[path] exists but remote[path] doesn't, the file is
    // local-only (upload pending) — don't add to the manifest yet.
  }
  return next;
}
