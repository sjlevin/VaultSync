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
