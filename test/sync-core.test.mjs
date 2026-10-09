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
} from "../dist/sync-core.js";
import { isSafePath, isHardDeniedPath } from "../dist/remote-paths.js";

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

// --- Mass-delete guard ---
assert.ok(!exceedsMassDeleteThreshold(0, 100));   // nothing to delete: no
assert.ok(!exceedsMassDeleteThreshold(1, 4));     // single delete: no
assert.ok(!exceedsMassDeleteThreshold(5, 100));   // 5% of vault: no
assert.ok(!exceedsMassDeleteThreshold(25, 100));  // exactly 25%: no
assert.ok(exceedsMassDeleteThreshold(26, 100));   // above 25%: yes
assert.ok(exceedsMassDeleteThreshold(3, 8));      // 37% of vault: yes
assert.ok(exceedsMassDeleteThreshold(3, 4));     // 75% of vault: yes

console.log("adversarial tests passed");
