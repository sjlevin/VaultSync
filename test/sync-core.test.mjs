import assert from "node:assert/strict";
import { planChanges, planPullChanges } from "../dist/sync-core.js";
import {
  detectRemotePrefix,
  localPath,
  remotePath,
  vaultRemotePrefix,
} from "../dist/remote-paths.js";

const base = { "a.md": { sha: "L1", remoteSha: "R1" } };
assert.deepEqual(
  planChanges({ "a.md": { sha: "L2", remoteSha: "R1" } }, { "a.md": { sha: "R1" } }, base),
  [{ type: "upload", path: "a.md" }],
);
assert.deepEqual(
  planChanges({ "a.md": { sha: "L1", remoteSha: "R1" } }, { "a.md": { sha: "R2" } }, base),
  [{ type: "download", path: "a.md", remoteSha: "R2" }],
);
assert.equal(
  planChanges({ "a.md": { sha: "L2", remoteSha: "R1" } }, { "a.md": { sha: "R2" } }, base)[0].kind,
  "both_modified",
);
assert.equal(
  planChanges({ "a.md": { sha: "L2", remoteSha: "R1" } }, {}, base)[0].kind,
  "local_modified_remote_deleted",
);
assert.equal(
  planChanges({}, { "a.md": { sha: "R2" } }, base)[0].kind,
  "local_deleted_remote_modified",
);
assert.equal(
  planChanges({ "new.md": { sha: "L", remoteSha: null } }, { "new.md": { sha: "R" } }, {})[0].kind,
  "both_added",
);

assert.deepEqual(
  planPullChanges({}, { "a.md": { sha: "R1" } }, { "a.md": { sha: "R1", remoteSha: "R1" } }),
  [{ type: "download", path: "a.md", remoteSha: "R1" }],
);
assert.deepEqual(
  planPullChanges(
    { "a.md": { sha: "R1", remoteSha: "R1" } },
    {},
    { "a.md": { sha: "R1", remoteSha: "R1" } },
  ),
  [{ type: "deleteLocal", path: "a.md" }],
);
assert.deepEqual(
  planPullChanges(
    { "a.md": { sha: "L2", remoteSha: "R1" } },
    {},
    { "a.md": { sha: "R1", remoteSha: "R1" } },
  ),
  [],
);

assert.equal(vaultRemotePrefix("Personal ", "", true), "Personal");
assert.equal(vaultRemotePrefix(" Personal\u200b ", " Notes / Mobile ", true), "Personal/Notes/Mobile");
assert.equal(vaultRemotePrefix("Personal", "", false), "");
assert.equal(vaultRemotePrefix("Personal", "Notes", false), "Notes");
assert.equal(remotePath(vaultRemotePrefix("Personal ", "", true), "Oi.md"), "Personal/Oi.md");
assert.equal(remotePath(vaultRemotePrefix("Personal", "", false), "Oi.md"), "Oi.md");
assert.equal(
  localPath(vaultRemotePrefix("Personal", "", false), "Notes/Oi.md"),
  "Notes/Oi.md",
);
assert.equal(
  localPath(vaultRemotePrefix("Personal", "", true), "Other/Oi.md"),
  null,
);
assert.equal(
  detectRemotePrefix(vaultRemotePrefix("Personal ", "", true), [
    "Personal /Oi.md",
    "Personal/Procedural Map Generation.md",
  ]),
  "Personal",
);
assert.equal(
  detectRemotePrefix(vaultRemotePrefix("Personal", "", false), [
    "Notes/Oi.md",
    "a.md",
  ]),
  "",
);
console.log("sync-core tests passed");

// ---------------------------------------------------------------------------
// Adversarial cases (security audit remediation)
// ---------------------------------------------------------------------------
import {
  nextManifest,
  exceedsMassDeleteThreshold,
  formatBackupStamp,
  parseBackupStamp,
} from "../dist/sync-core.js";
import { isSafePath, isHardDeniedPath, canonicalPathKey } from "../dist/remote-paths.js";

// --- Path traversal / unsafe names: localPath must refuse them ---
const unsafePaths = [
  "../evil.md",
  "a/../../evil.md",
  "notes/../..",
  "..",
  ".",
  "a/./b.md",
  "/absolute/path.md",
  "C:/evil.md",
  "notes/\0null.md",
  "notes/a\rb.md",
  "notes/a<b.md",
  "notes/a>b.md",
  'notes/a"b.md',
  "notes/a|b.md",
  "notes/a?b.md",
  "notes/a*b.md",
  "notes/trailingdot./x.md",
  "notes/trailingspace /x.md",
  "nul.md",
  "notes/CON.txt",
  "notes/com1.md",
  "notes/lpt9.md",
  "notes/aux",
];
for (const p of unsafePaths) {
  assert.equal(localPath("", p), null, `unsafe path must be rejected: ${JSON.stringify(p)}`);
}
const safePaths = [
  "notes/a.md",
  "notes/café.md",
  "notes/with space.md",
  "notes/under_score-name.123.md",
  ".obsidian/hotkeys.json",
  "a/b/c/d.md",
];
for (const p of safePaths) {
  assert.equal(localPath("", p), p, `safe path must pass: ${p}`);
  assert.ok(isSafePath(p), `isSafePath: ${p}`);
}
for (const p of unsafePaths) assert.ok(!isSafePath(p), `isSafePath rejects: ${JSON.stringify(p)}`);
// localPath still maps prefixes for safe paths
assert.equal(localPath("Vault", "Vault/notes/a.md"), "notes/a.md");
assert.equal(localPath("Vault", "Other/notes/a.md"), null);
// .. under a prefix must not escape it
assert.equal(localPath("Vault", "Vault/../evil.md"), null);

// --- .obsidian hard deny: never syncable, not configurable ---
const cfg = ".obsidian";
assert.ok(isHardDeniedPath(".obsidian/plugins/vaultsync/main.js", cfg, "vaultsync"));
assert.ok(isHardDeniedPath(".obsidian/plugins/vaultsync/data.json", cfg, "vaultsync"));
assert.ok(isHardDeniedPath(".obsidian/plugins/vaultsync", cfg, "vaultsync"));
assert.ok(isHardDeniedPath(".obsidian/plugins/other/main.js", cfg, "vaultsync"));
assert.ok(isHardDeniedPath(".obsidian/snippets/x.js", cfg, "vaultsync"));
assert.ok(!isHardDeniedPath(".obsidian/hotkeys.json", cfg, "vaultsync"));
assert.ok(!isHardDeniedPath(".obsidian/plugins/other/styles.css", cfg, "vaultsync"));
assert.ok(!isHardDeniedPath("notes/a.md", cfg, "vaultsync"));
// Case/Unicode aliases of the plugin dir on a case-insensitive filesystem.
assert.ok(isHardDeniedPath(".Obsidian/plugins/vaultsync/main.js", cfg, "vaultsync"));
assert.ok(isHardDeniedPath(".obsidian/PLUGINS/VAULTSYNC/data.json", cfg, "vaultsync"));
assert.ok(isHardDeniedPath(".obsidian/plugins/VaultSync", cfg, "vaultsync"));
// NFD-encoded config dir (e + combining acute) aliases the NFC one.
assert.ok(isHardDeniedPath("cafe\u0301-cfg/plugins/vaultsync/main.js", "caf\u00e9-cfg", "vaultsync"));
assert.ok(isHardDeniedPath("caf\u00e9-cfg/plugins/vaultsync/main.js", "cafe\u0301-cfg", "vaultsync"));
// Every JavaScript module extension, any case.
for (const ext of ["js", "mjs", "cjs", "JS", "Mjs", "CJS"])
  assert.ok(isHardDeniedPath(`.obsidian/snippets/x.${ext}`, cfg, "vaultsync"), ext);
assert.ok(isHardDeniedPath(".OBSIDIAN/plugins/other/main.mjs", cfg, "vaultsync"));
assert.ok(!isHardDeniedPath(".obsidian/plugins/other/x.json", cfg, "vaultsync"));
assert.ok(!isHardDeniedPath("notes/script.js", cfg, "vaultsync"));

// --- Collision key: case and NFC/NFD aliases map to one key ---
assert.equal(canonicalPathKey("Notes/Caf\u00e9.md"), canonicalPathKey("notes/cafe\u0301.md"));
assert.notEqual(canonicalPathKey("notes/cafe.md"), canonicalPathKey("notes/caf\u00e9.md"));

// --- Backup folder stamps round-trip; anything else is left alone ---
const stampDate = new Date("2026-03-04T05:06:07.089Z");
const stamp = formatBackupStamp(stampDate);
assert.equal(stamp, "2026-03-04T05-06-07-089Z");
assert.ok(!Number.isFinite(Date.parse(stamp)), "Date.parse cannot read our stamps");
assert.equal(parseBackupStamp(stamp), stampDate.getTime());
assert.equal(parseBackupStamp(formatBackupStamp(new Date(0))), 0);
for (const bad of ["", "notes", "2026-03-04", "2026-03-04T05:06:07.089Z", "2026-13-99T05-06-07-089Z", "2026-02-31T05-06-07-089Z"])
  assert.equal(parseBackupStamp(bad), null, `unparseable: ${bad}`);

// --- Tombstone / retry case (audit #3) ---
// The dangerous plan: remote has X, local lacks it, manifest tombstones it
// -> planChanges emits deleteRemote for a file the other side just added.
assert.deepEqual(
  planChanges({}, { X: { sha: "aaa" } }, { X: { sha: "", remoteSha: "aaa" } }),
  [{ type: "deleteRemote", path: "X" }],
);
// Genuine local delete still tombstones (needed so it isn't re-downloaded).
assert.deepEqual(nextManifest({}, { X: { sha: "aaa" } }), {
  X: { sha: "", remoteSha: "aaa", size: undefined },
});
// But a path with a pending download is NEVER tombstoned.
assert.deepEqual(
  nextManifest({}, { X: { sha: "aaa" } }, () => false, new Set(["X"])),
  {},
);
// Applied downloads merge normally.
assert.deepEqual(
  nextManifest({ X: { sha: "aaa", remoteSha: null } }, { X: { sha: "aaa" } }),
  { X: { sha: "aaa", remoteSha: "aaa", size: undefined } },
);

// --- Conflict copies: local-only until uploaded, never recorded as remote ---
// The copy is written locally but not committed in the same sync. If it were
// recorded in the manifest as present on both sides, the next plan would see
// "remote deleted" and emit deleteLocal for it.
const copyLocal = {
  "a.md": { sha: "L", remoteSha: null },
  "a.conflict-2026.md": { sha: "C", remoteSha: null },
};
const copyRemote = { "a.md": { sha: "L" } };
const afterCopy = nextManifest(copyLocal, copyRemote);
assert.equal(afterCopy["a.conflict-2026.md"], undefined);
assert.deepEqual(planChanges(copyLocal, copyRemote, afterCopy), [
  { type: "upload", path: "a.conflict-2026.md" },
]);
// The pre-fix manifest shape (copy recorded on both sides) is the bug.
assert.deepEqual(
  planChanges(copyLocal, copyRemote, {
    ...afterCopy,
    "a.conflict-2026.md": { sha: "C", remoteSha: "C" },
  }),
  [{ type: "deleteLocal", path: "a.conflict-2026.md" }],
);

// --- Mass-delete guard: >25% of the side, or 10+ files, with at least one ---
assert.ok(!exceedsMassDeleteThreshold(0, 100));   // nothing to delete: no
assert.ok(!exceedsMassDeleteThreshold(0, 0));
assert.ok(!exceedsMassDeleteThreshold(1, 4));     // exactly 25%: no
assert.ok(exceedsMassDeleteThreshold(1, 3));      // 1 of 3: yes
assert.ok(exceedsMassDeleteThreshold(1, 1));      // the whole vault: yes
assert.ok(!exceedsMassDeleteThreshold(5, 100));   // 5% of vault: no
assert.ok(!exceedsMassDeleteThreshold(9, 1000));  // below both bounds: no
assert.ok(exceedsMassDeleteThreshold(10, 1000));  // absolute bound: yes
assert.ok(exceedsMassDeleteThreshold(25, 100));   // 25%, but 10+ files: yes
assert.ok(!exceedsMassDeleteThreshold(2, 8));     // exactly 25%, under 10: no
assert.ok(exceedsMassDeleteThreshold(3, 8));      // 37% of vault: yes
assert.ok(exceedsMassDeleteThreshold(3, 4));      // 75% of vault: yes

console.log("adversarial tests passed");
