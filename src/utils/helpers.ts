import { ConflictKind } from "../sync-core";

export async function gitBlobSha(bytes: ArrayBuffer): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const joined = new Uint8Array(header.byteLength + bytes.byteLength);
  joined.set(header, 0);
  joined.set(new Uint8Array(bytes), header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", joined);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function base64FromBytes(bytes: ArrayBuffer): string {
  let binary = "";
  const array = new Uint8Array(bytes);
  for (let i = 0; i < array.length; i += 0x8000)
    binary += String.fromCharCode(...array.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function conflictDescription(kind: ConflictKind): string {
  if (kind === "both_added")
    return "Local and remote both created this path differently.";
  if (kind === "both_modified")
    return "Local and remote both changed since the last successful sync.";
  if (kind === "local_modified_remote_deleted")
    return "Local changed but remote deleted this file.";
  return "Local deleted but remote changed this file.";
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export interface DiffLine {
  type: "added" | "removed" | "unchanged";
  text: string;
}

export function generateDiff(oldStr: string, newStr: string): DiffLine[] {
  if (!oldStr) {
    return newStr.split(/\r?\n/).map((line) => ({ type: "added", text: line }));
  }
  if (!newStr) {
    return oldStr.split(/\r?\n/).map((line) => ({ type: "removed", text: line }));
  }

  const oldLines = oldStr.split(/\r?\n/);
  const newLines = newStr.split(/\r?\n/);
  const m = oldLines.length;
  const n = newLines.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const result: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ type: "unchanged", text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: "added", text: newLines[j - 1] });
      j--;
    } else {
      result.unshift({ type: "removed", text: oldLines[i - 1] });
      i--;
    }
  }
  return result;
}

/** Max characters fed into a preview diff. */
export const PREVIEW_CHAR_LIMIT = 50_000;
/** Max lines per side: the LCS diff allocates (m+1)*(n+1) cells. */
export const PREVIEW_LINE_LIMIT = 2_000;

/**
 * Truncate text for preview rendering. The full file is still synced;
 * only the on-screen diff is capped.
 */
export function truncateForPreview(text: string): string {
  const shown = text.slice(0, PREVIEW_CHAR_LIMIT);
  const lines = shown.split(/\r?\n/);
  if (shown.length === text.length && lines.length <= PREVIEW_LINE_LIMIT) return text;
  // One line is reserved for the marker, so the diff sees at most
  // PREVIEW_LINE_LIMIT lines.
  const kept = lines.slice(0, PREVIEW_LINE_LIMIT - 1).join("\n");
  return (
    kept +
    `\n… [preview truncated: showing first ${kept.length} of ${text.length} characters]`
  );
}

export function isBinaryFile(path: string): boolean {
  const BINARY_EXTENSIONS = new Set([
    "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "tiff",
    "pdf",
    "zip", "tar", "gz", "rar", "7z",
    "mp3", "wav", "m4a", "ogg", "flac",
    "mp4", "mov", "avi", "mkv", "webm",
    "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "woff", "woff2", "eot", "ttf", "otf",
    "exe", "dll", "so", "dylib", "bin"
  ]);
  const parts = path.split("/");
  const filename = parts[parts.length - 1];
  if (!filename.includes(".")) return false;
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext ? BINARY_EXTENSIONS.has(ext) : false;
}
