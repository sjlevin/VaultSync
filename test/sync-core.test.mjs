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
// Local edited, remote deleted: surfaced as a conflict so pull cannot
// quietly rebuild the manifest without the base entry.
assert.deepEqual(
  planPullChanges(
    { "a.md": { sha: "L2", remoteSha: "R1" } },
    {},
    { "a.md": { sha: "R1", remoteSha: "R1" } },
  ),
  [{ type: "conflict", path: "a.md", remoteSha: null, kind: "local_modified_remote_deleted" }],
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
// Another plugin's folder contributes only data.json: a remote manifest.json
// could repoint that plugin's `main`, and styles.css is not worth the surface.
assert.ok(isHardDeniedPath(".obsidian/plugins/other/styles.css", cfg, "vaultsync"));
assert.ok(isHardDeniedPath(".obsidian/plugins/other/manifest.json", cfg, "vaultsync"));
assert.ok(isHardDeniedPath(".obsidian/plugins/other/sub/data.json", cfg, "vaultsync"));
assert.ok(!isHardDeniedPath(".obsidian/plugins/other/data.json", cfg, "vaultsync"));
assert.ok(!isHardDeniedPath(".obsidian/plugins/other", cfg, "vaultsync"));
assert.ok(!isHardDeniedPath(".obsidian/plugins", cfg, "vaultsync"));
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
assert.ok(isHardDeniedPath(".obsidian/plugins/other/x.json", cfg, "vaultsync"));
// Any segment, not only the last: a `main.js/` directory, and .jsx.
assert.ok(isHardDeniedPath(".obsidian/snippets/main.js/x.json", cfg, "vaultsync"));
assert.ok(isHardDeniedPath(".obsidian/snippets/x.jsx", cfg, "vaultsync"));
assert.ok(isHardDeniedPath(".obsidian/snippets/x.CJS", cfg, "vaultsync"));
// Local-only roots are denied whatever the ignore list says, any case.
for (const p of [".git/config", ".Git/HEAD", ".trash/x.md", ".TRASH/x.md", ".github-sync-backup/2026/x.md", ".GitHub-Sync-Backup"])
  assert.ok(isHardDeniedPath(p, cfg, "vaultsync"), p);
assert.ok(!isHardDeniedPath(".gitx/x.md", cfg, "vaultsync"));
assert.ok(!isHardDeniedPath("notes/.git/x.md", cfg, "vaultsync"));
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

// ---------------------------------------------------------------------------
// Audit 3
// ---------------------------------------------------------------------------
import { planCommitTree, findCanonicalCollisions } from "../dist/sync-core.js";
import {
  isGitSha,
  matchesPattern,
  conflictCopyPath,
  stripRemotePrefix,
} from "../dist/remote-paths.js";

// Block A (behaviour that must hold before and after).
assert.deepEqual(planChanges({ "a.md": { sha: "Z", remoteSha: "R1" } }, { "a.md": { sha: "Z" } }, base), []);
assert.deepEqual(planChanges({ "n.md": { sha: "S", remoteSha: null } }, { "n.md": { sha: "S" } }, {}), []);
assert.deepEqual(planChanges({}, { "a.md": { sha: "R1" } }, base), [{ type: "deleteRemote", path: "a.md" }]);
assert.deepEqual(planChanges({ "a.md": { sha: "L1", remoteSha: "R1" } }, {}, base), [{ type: "deleteLocal", path: "a.md" }]);
assert.equal(planChanges({}, { X: { sha: "bbb" } }, { X: { sha: "", remoteSha: "aaa" } })[0].kind, "local_deleted_remote_modified");
assert.deepEqual(planChanges({ X: { sha: "aaa", remoteSha: null } }, { X: { sha: "aaa" } }, { X: { sha: "", remoteSha: "aaa" } }), []);
assert.deepEqual(planPullChanges({ "n.md": { sha: "L", remoteSha: null } }, {}, {}), []);
assert.ok(exceedsMassDeleteThreshold(10, 10)); assert.ok(!exceedsMassDeleteThreshold(9, 36)); assert.ok(exceedsMassDeleteThreshold(9, 35));
assert.equal(parseBackupStamp("2024-02-29T00-00-00-000Z"), Date.UTC(2024, 1, 29));
for (const bad of ["2026-02-29T00-00-00-000Z","2026-03-04T24-00-00-000Z","2026-03-04T05-60-00-000Z","2026-03-04T05-06-07-89Z","2026-03-04T05-06-07-089Z/x"]) assert.equal(parseBackupStamp(bad), null, bad);
assert.equal(canonicalPathKey("A\u030a.md"), "\u00e5.md");
for (const p of ["", "a/", "a//b.md", "...", "con.tar.gz", "a\x7f.md", "c:/x", "a:b.md"]) assert.ok(!isSafePath(p), p);
for (const p of [".obsidian/app.json", "..x/y.md", "com0.md", "cafe\u0301.md"]) assert.ok(isSafePath(p), p);
assert.equal(localPath("V", "V//a.md"), "a.md"); assert.equal(localPath("V", "V"), ""); assert.equal(localPath("V", "Vx/a.md"), null); assert.equal(localPath("Vault", "vault/a.md"), "a.md");
assert.equal(detectRemotePrefix("Personal", ["personal/x.md", "Personal/y.md"]), "Personal");
assert.equal(detectRemotePrefix("Personal", ["Personalx/x.md"]), "Personal");
// vaultsync2 is not the vaultsync plugin dir; data.json is the one allowed file there.
assert.ok(!isHardDeniedPath(".obsidian/plugins/vaultsync2/data.json", cfg, "vaultsync"));
assert.ok(!isHardDeniedPath(".obsidianx/plugins/vaultsync/main.js", cfg, "vaultsync"));

// A: a poisoned path (isIgnored covers it) yields no change in either direction.
const poisoned = (p) => canonicalPathKey(p) === "secret.md";
assert.deepEqual(
  planChanges({ "secret.md": { sha: "L1", remoteSha: "R1" } }, {}, { "secret.md": { sha: "L1", remoteSha: "R1" } }, poisoned),
  [],
);
assert.deepEqual(planChanges({}, { "SECRET.md": { sha: "R2" } }, {}, poisoned), []);
// The poisoned path is absent from both listings, but its baseline survives:
// nextManifest copies the base entry for paths `preserve` covers.
const secretBase = { "secret.md": { sha: "L1", remoteSha: "R1" }, "other.md": { sha: "O", remoteSha: "O" } };
const afterPoison = nextManifest({ "other.md": { sha: "O", remoteSha: "O" } }, { "other.md": { sha: "O" } }, () => false, new Set(), secretBase, poisoned);
assert.deepEqual(afterPoison, {
  "secret.md": { sha: "L1", remoteSha: "R1" },
  "other.md": { sha: "O", remoteSha: "O", size: undefined },
});
// A poisoned path with no base entry is simply left out.
assert.deepEqual(nextManifest({}, { "secret.md": { sha: "R1" } }, () => false, new Set(), {}, poisoned), {});
// User-ignored paths are still dropped even when the base has them.
assert.deepEqual(nextManifest({}, {}, poisoned, new Set(), secretBase), {});
// Poison cleared, remote deleted the file: the kept baseline makes it a
// local delete (or a conflict when edited), never a re-upload.
assert.deepEqual(planChanges({ "secret.md": { sha: "L1", remoteSha: "R1" } }, {}, afterPoison), [
  { type: "deleteLocal", path: "secret.md" },
]);
assert.equal(
  planChanges({ "secret.md": { sha: "L2", remoteSha: "R1" } }, {}, afterPoison)[0].kind,
  "local_modified_remote_deleted",
);
// Without the preserved entry the same state reads as a brand-new upload.
assert.deepEqual(planChanges({ "secret.md": { sha: "L1", remoteSha: "R1" } }, {}, { "other.md": afterPoison["other.md"] }), [
  { type: "upload", path: "secret.md" },
]);

// Cross-side collisions: distinct spellings under one canonical key.
assert.deepEqual(findCanonicalCollisions(["A.md", "a.md", "b.md"], canonicalPathKey), [["A.md", "a.md"]]);
assert.deepEqual(findCanonicalCollisions(["a.md", "a.md"], canonicalPathKey), []);
assert.deepEqual(findCanonicalCollisions([], canonicalPathKey), []);
assert.deepEqual(
  findCanonicalCollisions(["x/Caf\u00e9.md", "x/cafe\u0301.md", "Zed.md", "zed.md", "ZED.md", "y.md"], canonicalPathKey),
  [["x/Caf\u00e9.md", "x/cafe\u0301.md"], ["ZED.md", "Zed.md", "zed.md"]],
);

// B: prefix matching on canonical keys, sliced by source length.
assert.equal(localPath("Caf\u00e9", "Cafe\u0301/a.md"), "a.md");
assert.equal(localPath("\u0130st", "i\u0307st/a.md"), "a.md");
assert.equal(localPath("Notes/Mobile", "notes/MOBILE/a.md"), "a.md");
assert.equal(localPath("Notes/Mobile", "notes/a.md"), null);
assert.equal(detectRemotePrefix("Personal", [" Personal/x.md"]), " Personal");
assert.equal(localPath(detectRemotePrefix("Personal", [" Personal/x.md"]), " Personal/x.md"), "x.md");
assert.equal(detectRemotePrefix("Caf\u00e9", ["cafe\u0301/x.md"]), "cafe\u0301");
assert.equal(stripRemotePrefix("V", "V/a<b.md"), "a<b.md");
assert.equal(stripRemotePrefix("V", "W/a.md"), null);
assert.equal(localPath("V", "V/a<b.md"), null);

// E: gone on both sides is a no-op, with or without a tombstone.
assert.deepEqual(planChanges({}, {}, base), []);
assert.deepEqual(planChanges({}, {}, { X: { sha: "", remoteSha: "aaa" } }), []);

// F: keep-both uploads the local file even though the path appears twice.
const keepBoth = [
  { type: "downloadConflictCopy", path: "a.md", remoteSha: "R" },
  { type: "upload", path: "a.md" },
  { type: "upload", path: "a.md" },
  { type: "deleteRemote", path: "b.md" },
  { type: "deleteRemote", path: "a.md" },
  { type: "download", path: "c.md", remoteSha: "R" },
];
assert.deepEqual(planCommitTree(keepBoth, (p) => `V/${p}`), {
  uploads: [{ path: "a.md", remotePath: "V/a.md" }],
  deletes: [{ path: "b.md", remotePath: "V/b.md" }],
});
assert.deepEqual(planCommitTree([], (p) => p), { uploads: [], deletes: [] });

// G: only bare object ids pass.
assert.ok(isGitSha("a".repeat(40)));
assert.ok(isGitSha("0123456789abcdef".repeat(4)));
for (const bad of ["", "A".repeat(40), "a".repeat(39), "a".repeat(41), "a".repeat(63), "../x", "a".repeat(40) + "?x=1", null, 42])
  assert.ok(!isGitSha(bad), String(bad));

// H: ignore patterns match on canonical keys.
assert.ok(matchesPattern("secrets/x.md", "Secrets/**"));
assert.ok(matchesPattern("Secrets", "secrets/**"));
assert.ok(!matchesPattern("secretsx/x.md", "Secrets/**"));
assert.ok(matchesPattern("Cafe\u0301.md", "caf\u00e9.md"));
assert.ok(matchesPattern("notes/Draft-1.MD", "notes/draft-*.md"));
assert.ok(!matchesPattern("notes/a.md", "notes/b.md"));
assert.ok(matchesPattern("a/b.md", "a//b.md"));

// J: the conflict suffix goes on the basename, not the first dotted folder.
assert.equal(conflictCopyPath("assets/2024.01/photo", "S"), "assets/2024.01/photo.conflict-S");
assert.equal(conflictCopyPath("assets/2024.01/photo.png", "S"), "assets/2024.01/photo.conflict-S.png");
assert.equal(conflictCopyPath("a.md", "S"), "a.conflict-S.md");
assert.equal(conflictCopyPath(".hidden", "S"), ".hidden.conflict-S");

console.log("audit 3 tests passed");
