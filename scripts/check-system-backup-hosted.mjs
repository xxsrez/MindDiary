import { privateAcceptanceDirectory } from "./lib/private-operations.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AcceptanceClient } from "./lib/acceptance-client.mjs";
import { createCollaborationFixture } from "./lib/acceptance-fixture.mjs";
import { checkBackupIntegrity, runBackup } from "./lib/system-backup-client.mjs";
import { ACCEPTANCE_ORIGIN } from "../apps/mind-diary-acceptance/runtime-target.mjs";

const expected = process.env.MD_ACCEPTANCE_EXPECTED_SHA;
assert.match(expected ?? "", /^[0-9a-f]{40}$/u);
const runnerSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), "",
  "clean_runner_required");
const tag = process.argv[2] ?? crypto.randomUUID();
assert.match(tag, /^[A-Za-z0-9_-]{1,80}$/u);
const privateRoot = privateAcceptanceDirectory();
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

const fetchImpl = async (url, options) => {
  if (new URL(url).origin !== ACCEPTANCE_ORIGIN) throw new Error("foreign_backup_target");
  const response = await fetch(url, {
    ...options,
    headers: { ...options.headers, "OAI-Sites-Authorization": `Bearer ${platform}`,
      "x-md-acceptance-run": client.state.run.run_id },
  });
  if (!response.ok) {
    let code = "untyped";
    try {
      const body = await response.clone().json();
      const candidate = typeof body.code === "string" ? body.code : body.error;
      if (typeof candidate === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(candidate)) {
        code = candidate;
      }
    } catch { /* Keep only the status when the gateway has no JSON error. */ }
    console.error(JSON.stringify({ event: "hosted_backup_http_error",
      status: response.status, code }));
  }
  return response;
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
let primaryFailure;
try {
  await client.setup({ profile: "operator" });
  fixture = await createCollaborationFixture(client, {
    revisionsPerMind: 1, writeSharedContent: false,
  });
  populated = await client.control("/_acceptance/inventory");
  assert.equal(populated.complete, true);
  assert.equal(populated.principals, 4);
  assert.ok(populated.owned_minds >= 1);
  baselineBackup = await run();
  assert.equal(baselineBackup.mode, "baseline");
  assert.equal(baselineBackup.pending, null);
  assert.equal((await checkBackupIntegrity({ directory })).ok, true);

  const token = client.state.operations["token:owner"].result.data.secret;
  await client.commit("backup:delta", token, {
    mind: "/me", expected_revision: fixture.revisions["/me"].at(-1),
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
} catch (error) {
  primaryFailure = error;
  console.error(JSON.stringify({ event: "hosted_backup_failed",
    code: error?.code ?? error?.productError?.code ?? "unknown" }));
  if (process.env.MD_ACCEPTANCE_DIAGNOSTIC_PAUSE === "1") {
    console.error("hosted_backup_failed_diagnostic_pause");
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
} finally {
  if (client.state.run) {
    try { cleanup = await client.cleanup(); }
    catch (error) {
      if (primaryFailure) throw new AggregateError([primaryFailure, error],
        "hosted_backup_and_cleanup_failed");
      throw error;
    }
  }
}
if (primaryFailure) throw primaryFailure;
assert.equal(cleanup?.state, "cleaned");
const final = await client.control("/_acceptance/inventory");
assert.equal(final.complete, true);
assert.equal(final.principals, baseline.principals);
assert.equal(final.owned_minds, baseline.owned_minds);
assert.equal(final.object_count, baseline.object_count);
assert.deepEqual(final.rows, baseline.rows);
console.log(JSON.stringify({
  status: "passed", candidate_sha: expected, runner_sha: runnerSha, hosted: true,
  fixture_principals: populated.principals,
  owned_ordinary_minds: populated.owned_minds, baseline: {
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
