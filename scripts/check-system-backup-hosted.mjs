import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AcceptanceClient } from "./lib/acceptance-client.mjs";
import { createCollaborationFixture } from "./lib/acceptance-fixture.mjs";
import { checkBackupIntegrity, runBackup } from "./lib/system-backup-client.mjs";
import { ACCEPTANCE_ORIGIN } from "../apps/mind-diary-acceptance/runtime-target.mjs";

const expected = process.env.MD_ACCEPTANCE_EXPECTED_SHA;
assert.match(expected ?? "", /^[0-9a-f]{40}$/u);
const tag = process.argv[2] ?? crypto.randomUUID();
assert.match(tag, /^[A-Za-z0-9_-]{1,80}$/u);
const privateRoot = join(homedir(), ".codex/private/mind-diary-acceptance");
const [platform, controllerKey] = await Promise.all([
  readFile(join(privateRoot, "platform-token.json"), "utf8").then((value) => JSON.parse(value).token),
  readFile(join(privateRoot, "controller-key"), "utf8").then((value) => value.trim()),
]);
assert.match(controllerKey, /^[A-Za-z0-9_-]{43}$/u);
const client = await new AcceptanceClient({
  directory: join(privateRoot, "runs", tag),
  platformToken: platform,
  controllerKey,
}).open();
assert.equal(client.state.phase, "prepared", "fresh_synthetic_run_required");
const buildResponse = await client.request("/_acceptance/build");
assert.equal(buildResponse.status, 200);
const build = await buildResponse.json();
assert.equal(build.candidate_sha, expected);
assert.equal(build.dirty, false);
const baseline = await client.control("/_acceptance/inventory");
assert.equal(baseline.complete, true);
assert.equal(baseline.principals, 0);
assert.equal(baseline.owned_minds, 0);
assert.equal(baseline.object_count, 0);
assert.ok(Object.values(baseline.rows).every((count) => count === 0));

const fetchImpl = (url, options) => {
  if (new URL(url).origin !== ACCEPTANCE_ORIGIN) throw new Error("foreign_backup_target");
  return fetch(url, {
    ...options,
    headers: { ...options.headers, "OAI-Sites-Authorization": `Bearer ${platform}`,
      "x-md-acceptance-run": client.state.run.run_id },
  });
};
const directory = join(client.directory, "backup");
const run = () => runBackup({
  directory, origin: ACCEPTANCE_ORIGIN, key: `mdb_v1_${controllerKey}`, fetchImpl,
});
let fixture;
let baselineBackup;
let deltaBackup;
let noChangeBackup;
let populated;
let cleanup;
try {
  await client.setup({ profile: "operator" });
  fixture = await createCollaborationFixture(client);
  populated = await client.control("/_acceptance/inventory");
  assert.equal(populated.complete, true);
  assert.equal(populated.principals, 4);
  assert.equal(populated.owned_minds, 5);
  baselineBackup = await run();
  assert.equal(baselineBackup.mode, "baseline");
  assert.equal(baselineBackup.pending, null);
  assert.equal((await checkBackupIntegrity({ directory })).ok, true);

  const token = client.state.operations["token:owner"].result.data.secret;
  await client.commit("backup:delta", token, {
    mind: "/me", expected_revision: fixture.revisions["/me"][1],
    summary: "Synthetic hosted backup delta",
    operations: [{ type: "replace_file", path: "concepts/acceptance.md",
      text: "---\ntype: Reference\n---\n\nSynthetic acceptance decision version three.\n" }],
  });
  deltaBackup = await run();
  assert.equal(deltaBackup.mode, "incremental");
  assert.ok(deltaBackup.last_success.sequence > baselineBackup.last_success.sequence);
  assert.equal(deltaBackup.pending, null);
  const integrity = await checkBackupIntegrity({ directory });
  assert.equal(integrity.ok, true);
  assert.equal(integrity.sequence, deltaBackup.last_success.sequence);

  noChangeBackup = await run();
  assert.equal(noChangeBackup.downloaded_objects, 0);
  assert.equal(noChangeBackup.pending, null);
} finally {
  if (client.state.run) cleanup = await client.cleanup();
}
assert.equal(cleanup?.state, "cleaned");
const final = await client.control("/_acceptance/inventory");
assert.equal(final.complete, true);
assert.equal(final.principals, baseline.principals);
assert.equal(final.owned_minds, baseline.owned_minds);
assert.equal(final.object_count, baseline.object_count);
assert.deepEqual(final.rows, baseline.rows);
console.log(JSON.stringify({
  status: "passed", candidate_sha: expected, hosted: true,
  fixture_minds: populated.owned_minds, baseline: {
    sequence: baselineBackup.last_success.sequence,
    records: baselineBackup.last_success.record_count,
    objects: baselineBackup.last_success.object_count,
    downloaded_objects: baselineBackup.downloaded_objects,
    largest_response_bytes: baselineBackup.largest_response_bytes,
  },
  delta: {
    sequence: deltaBackup.last_success.sequence,
    records: deltaBackup.last_success.record_count,
    objects: deltaBackup.last_success.object_count,
    downloaded_objects: deltaBackup.downloaded_objects,
    largest_response_bytes: deltaBackup.largest_response_bytes,
  },
  no_change_downloaded_objects: noChangeBackup.downloaded_objects,
  cleanup: cleanup.state,
}));
