import { privateAcceptanceDirectory } from "./lib/private-operations.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { AcceptanceClient } from "./lib/acceptance-client.mjs";
import { createCollaborationFixture } from "./lib/acceptance-fixture.mjs";
import { acceptanceDigest, createAcceptanceComponent } from "./lib/acceptance-evidence.mjs";

import { snapshotAcceptanceFixture, verifyAcceptanceSnapshot } from "./lib/acceptance-persistence.mjs";

// prepare leaves a durable checkpoint. The controlling agent redeploys the exact
// saved version through Sites, records the provider read-back, then runs verify.
const [tag, action, identityPath] = process.argv.slice(2);
if (!/^[a-zA-Z0-9_-]{1,80}$/.test(tag ?? "") || !["prepare", "verify", "cleanup"].includes(action)) throw Error("invalid_persistence_command");
const root = privateAcceptanceDirectory();
const config = { directory: join(root, "runs", tag), platformToken: JSON.parse(await readFile(join(root, "platform-token.json"), "utf8")).token,
  controllerKey: await readFile(join(root, "controller-key"), "utf8") };
const client = await new AcceptanceClient(config).open();
let phase = action;
process.once("uncaughtException", () => { console.error(JSON.stringify({ status: "failed", phase })); process.exit(1); });
async function clean() {
  await client.cleanup();
  const final = await client.control("/_acceptance/inventory");
  assert.deepEqual(final, client.state.persistence.baseline);
  return final;
}
if (action === "cleanup") {
  await clean(); console.log(JSON.stringify({ status: "baseline_restored" }));
} else {
  const identity = JSON.parse(await readFile(identityPath, "utf8"));
  assert.equal(identity.project_id, process.env.MIND_DIARY_ACCEPTANCE_PROJECT ?? "appgprj_example8ca2ca9e5243cfd6");
  const build = await (await client.request("/_acceptance/build")).json();
  for (const key of ["candidate_sha", "common_modules_sha256", "test_adapter_sha256"]) assert.equal(identity[key], build[key]);
  const runnerSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), "", "clean_runner_required");
  if (action === "prepare") {
    if (client.state.persistence?.ready) throw Error("persistence_checkpoint_already_prepared");
    client.state.persistence ??= { identity, runner_sha: runnerSha, baseline: await client.control("/_acceptance/inventory") };
    assert.deepEqual(client.state.persistence.identity, identity); await client.save();
    try {
      const fixture = await createCollaborationFixture(client);
      const token = client.state.operations["token:owner"].result.data.secret;
      const snapshots = await snapshotAcceptanceFixture(client, fixture, token);
      Object.assign(client.state.persistence, { ready: true, snapshots }); await client.save();
      console.log(JSON.stringify({ phase: "awaiting_exact_saved_version_redeploy", identity, lanes: snapshots.length }));
    } catch (error) { await clean(); throw error; }
  } else {
    const saved = client.state.persistence; assert.equal(saved?.ready, true);
    assert.equal(saved.runner_sha, runnerSha, "runner_changed_between_deployments");
    assert.notEqual(identity.deployment_id, saved.identity.deployment_id, "redeployment_required");
    for (const key of Object.keys(identity).filter(key => key !== "deployment_id")) assert.equal(identity[key], saved.identity[key], "artifact_changed");
    let receipt, final;
    try {
      const token = client.state.operations["token:owner"].result.data.secret;
      await verifyAcceptanceSnapshot(client, token, saved.snapshots);
      receipt = { schema: "mind-diary/acceptance-persistence/v1", status: "passed", before: saved.identity, after: identity,
        runner_sha: runnerSha, snapshots: saved.snapshots };
    } finally { phase = "cleanup"; final = await clean(); }
    const component = createAcceptanceComponent({ kind: "persistence", status: "passed", identity, runner_sha: runnerSha,
      assertions: { commit_before_redeploy: true, distinct_deployment: true, same_artifact: true, exact_revision_readback: true, exact_content_readback: true },
      details: { previous_deployment_id: saved.identity.deployment_id }, cleanup: { status: "baseline_restored", baseline: saved.baseline, final }, source_receipts: [acceptanceDigest(receipt)] });
    await writeFile(join(client.directory, "persistence-source.json"), JSON.stringify(receipt), { mode: 0o600 });
    await writeFile(join(client.directory, "persistence-component.json"), JSON.stringify(component), { mode: 0o600 });
    console.log(JSON.stringify({ status: "passed", component: component.artifact_sha256, cleanup: "baseline_restored" }));
  }
}
