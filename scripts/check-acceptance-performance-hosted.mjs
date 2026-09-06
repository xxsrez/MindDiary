import assert from "node:assert/strict";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { AcceptanceClient } from "./lib/acceptance-client.mjs";
import { createAcceptancePerformanceFixture } from "./lib/acceptance-performance-fixture.mjs";
import { collectPerformanceSamples } from "./benchmark-runtime-performance.mjs";
import { createSitesLogPerformanceCapture } from "./lib/performance-telemetry-capture.mjs";
import { evaluatePerformanceGate, verifyPerformanceScenarioCredentialBindings } from "./lib/performance-gate.mjs";
import { ACCEPTANCE_ASSERTIONS, acceptanceDigest, createAcceptanceComponent } from "./lib/acceptance-evidence.mjs";

import { observeAcceptanceClock, createAcceptanceClockCalibration } from "./lib/acceptance-clock-calibration.mjs";
import { waitForAcceptanceTelemetry } from "./lib/acceptance-telemetry-barrier.mjs";

let phase = "configuration";
process.once("uncaughtException", () => { console.error(JSON.stringify({ status: "failed", phase })); process.exit(1); });
const [tag, action, inputPath] = process.argv.slice(2);
assert.match(tag ?? "", /^[a-zA-Z0-9_-]{1,80}$/);
assert.ok(["sample", "finalize", "cleanup"].includes(action));
const root = join(homedir(), ".codex/private/mind-diary-acceptance");
const platformToken = JSON.parse(await readFile(join(root, "platform-token.json"), "utf8")).token;
const controllerKey = await readFile(join(root, "controller-key"), "utf8");
const client = await new AcceptanceClient({ directory: join(root, "runs", tag), platformToken, controllerKey }).open();
const write = (name, value) => writeFile(join(client.directory, name), JSON.stringify(value), { mode: 0o600 });
if (action === "cleanup") {
  phase = "cleanup";
  await client.cleanup();
  const final = await client.control("/_acceptance/inventory");
  assert.deepEqual(final, client.state.performance.baseline);
  console.log(JSON.stringify({ phase, status: "baseline_restored" }));
} else if (action === "sample") {
  const identity = JSON.parse(await readFile(inputPath, "utf8"));
  const build = await (await client.request("/_acceptance/build")).json();
  assert.equal(identity.project_id, "appgprj_example8ca2ca9e5243cfd6");
  for (const key of ["candidate_sha", "common_modules_sha256", "test_adapter_sha256"]) assert.equal(identity[key], build[key]);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), "", "clean_runner_required");
  assert.ok(!client.state.performance?.samples, "samples_already_recorded");
  client.state.performance ??= { identity, runner_sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), baseline: await client.control("/_acceptance/inventory"), bindingKey: randomBytes(32).toString("base64url") };
  assert.deepEqual(client.state.performance.identity, identity);
  await client.save();
  try {
    phase = "performance_fixture";
    const f = await createAcceptancePerformanceFixture(client, identity, client.state.performance.bindingKey);
    const keys = JSON.parse(await readFile(join(root, "runtime-secrets.json"), "utf8"));
    process.env.MD_PERF_PLATFORM = `Bearer ${platformToken}`;
    process.env.MD_PERF_BINDING_KEY = client.state.performance.bindingKey;
    process.env.MD_PERF_CORRELATION_KEY = keys.MIND_DIARY_PERFORMANCE_CORRELATION_KEY;
    process.env.MD_PERF_COOKIE = f.credentials.starter.cookie;
    for (const [id, credential] of Object.entries(f.credentials)) process.env[`MD_PERF_${id.toUpperCase()}`] = credential.token;
    verifyPerformanceScenarioCredentialBindings(f.scenario, f.profileReadback, process.env);
    client.state.performance.scenario = f.scenario; client.state.performance.profile_readback = f.profileReadback; await client.save();
    client.state.performance.clock_before = await observeAcceptanceClock(client, identity.candidate_sha); await client.save();
    phase = "performance_samples";
    let sampleCount = 0, batch = [];
    const collectionDeadline = Date.now() + 1800000;
    const collection = { schema: "mind-diary/performance-collection/v1", policy: "provider-telemetry-batches", max_samples_per_batch: 5,
      max_barrier_wait_ms: 60000, max_collection_ms: 1800000, batches: [] };
    client.state.performance.collection = collection;
    const journalPath = process.env.MD_ACCEPTANCE_LOG_JOURNAL ?? join(client.directory, "sites-log-captures.jsonl");
    const samples = await collectPerformanceSamples(f.scenario, Buffer.from(process.env.MD_PERF_CORRELATION_KEY, "base64url"), async sample => {
      await appendFile(join(client.directory, "performance-samples.jsonl"), JSON.stringify(sample) + "\n", { mode: 0o600 });
      const definition = f.scenario.requests.find(value => value.id === sample.definition_id);
      assert.ok(definition, "sample_definition_missing");
      batch.push({ ...sample, profile: definition.profile, operation: definition.operation });
      sampleCount++;
      if (Date.now() >= collectionDeadline) throw Error("performance_collection_deadline_exceeded");
      if (batch.length === 5 || sampleCount % 21 === 0) {
        phase = "provider_telemetry_barrier";
        collection.batches.push(await waitForAcceptanceTelemetry({ journalPath, projectId: identity.project_id, samples: batch,
          timeoutMs: Math.min(60000, collectionDeadline - Date.now()) }));
        await write("performance-collection.json", collection); batch = []; phase = "performance_samples";
      }
      if (sampleCount % 21 === 0) console.log(JSON.stringify({ phase, requests_completed: sampleCount / 21, requests_total: f.scenario.requests.length }));
    });
    client.state.performance.samples = samples; await client.save();
    const after = await observeAcceptanceClock(client, identity.candidate_sha);
    client.state.performance.clock_calibration = createAcceptanceClockCalibration({ candidate_sha: identity.candidate_sha, target_url: f.scenario.target_url,
      before: client.state.performance.clock_before, after }); await client.save();
    console.log(JSON.stringify({ phase: "provider_capture_required", status: "samples_recorded", run_id: client.state.run.run_id,
      candidate: identity.candidate_sha, started_at: samples.startedAt, completed_at: samples.completedAt, sample_count: sampleCount }));
  } catch (error) { await client.cleanup(); throw error; }
} else {
  const p = client.state.performance;
  assert.ok(p?.samples && client.state.phase !== "cleaned");
  try {
    phase = "provider_telemetry_join";
    const source = JSON.parse(await readFile(inputPath, "utf8"));
    const correlations = p.samples.connectorResults.flatMap(r => r.sample_windows.map(w => w.benchmark_correlation_id));
    const captured = createSitesLogPerformanceCapture({ candidate_sha: p.identity.candidate_sha, environment: "uat", target_url: p.scenario.target_url,
      deployment: p.profile_readback.deployment, started_at: p.samples.startedAt, completed_at: new Date().toISOString(), provider_script: "site---6a9c795089608191bc1b52e06234fc4a" }, source, correlations);
    const evaluation = { candidate_sha: p.identity.candidate_sha, deployment_id: p.identity.deployment_id, environment: "uat", target_url: p.scenario.target_url,
      started_at: p.samples.startedAt, completed_at: p.samples.completedAt, warm_samples: 20, scenario: p.scenario, profile_readback: p.profile_readback,
      ...(p.clock_calibration ? { clock_calibration: p.clock_calibration } : {}),
      connector_results: p.samples.connectorResults, server_telemetry: captured.telemetry, telemetry_capture: captured.receipt };
    const report = evaluatePerformanceGate(evaluation);
    await write("performance-evaluation.json", evaluation); await write("performance-report.json", report);
    console.log(JSON.stringify({ phase, status: report.status, failures: report.failures, artifact_sha256: report.artifact_sha256 }));
    assert.equal(report.status, "passed", "performance_gate_failed");
    p.passed = true; p.evaluation = evaluation; p.report = report; await client.save();
  } finally {
    phase = "performance_cleanup";
    await client.cleanup();
    const final = await client.control("/_acceptance/inventory");
    assert.deepEqual(final, p.baseline);
    const evaluatorSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const evaluatorClean = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() === "";
    if (p.passed && evaluatorSha === p.runner_sha && evaluatorClean) {
      const component = createAcceptanceComponent({ kind: "performance", status: "passed", identity: p.identity, runner_sha: p.runner_sha,
        assertions: Object.fromEntries(ACCEPTANCE_ASSERTIONS.performance.map(name => [name, true])), details: { report: p.report, evaluation: p.evaluation, ...(p.collection ? { collection: p.collection } : {}) },
        cleanup: { status: "baseline_restored", baseline: p.baseline, final }, source_receipts: [acceptanceDigest(p.samples), p.evaluation.telemetry_capture.control_plane_source.result_sha256.slice(7), ...(p.collection ? [acceptanceDigest(p.collection)] : [])] });
      await write("performance-component.json", component);
    }
    if (p.passed && (evaluatorSha !== p.runner_sha || !evaluatorClean)) console.log(JSON.stringify({ phase: "component_not_emitted", reason: "collector_and_evaluator_runner_differ", collector_sha: p.runner_sha, evaluator_sha: evaluatorSha }));
    delete p.bindingKey; await client.save();
    console.log(JSON.stringify({ phase, status: p.passed ? "passed" : "failed", cleanup: "baseline_restored" }));
  }
}
