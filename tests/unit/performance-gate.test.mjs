import assert from "node:assert/strict";
import test from "node:test";

import { waitForTelemetry } from "../../scripts/benchmark-runtime-performance.mjs";

import {
  PERFORMANCE_BUDGETS_MS,
  PERFORMANCE_TELEMETRY_EVENT,
  PERFORMANCE_TELEMETRY_SCHEMA,
  evaluatePerformanceGate,
  parsePerformanceTelemetryJsonl,
  performanceGateNeedsTelemetryRetry,
  percentile,
  validatePerformanceScenario,
  verifyPerformanceScenarioCredentialBindings,
  verifyPerformanceGateArtifact,
} from "../../scripts/lib/performance-gate.mjs";
import {
  createPerformanceCredentialBinding,
  createPerformanceProfileReadbackReceipt,
  performanceRequestArgumentsDigest,
  verifyPerformanceProfileReadbackReceipt,
} from "../../scripts/lib/performance-profile-readback.mjs";
import {
  createPerformanceTelemetryCaptureReceipt,
  PERFORMANCE_TELEMETRY_CAPTURE_GENERATOR,
  verifyPerformanceTelemetryCaptureReceipt,
} from "../../scripts/lib/performance-telemetry-capture.mjs";

import { CANDIDATE, DEPLOYMENT, TARGET, RUN_START, BINDING_KEY, DEPLOYMENT_RECORD, counts, fixtureCredential, fixtureCredentialEnv, fixtureArguments, operationsForKind, profile, profileReceipt, mcpRequest, rawScenario, credentialEnvironment, event, samples, fixture } from "../helpers/performance-fixture.mjs";

test("nearest-rank percentile is deterministic", () => {
  assert.equal(percentile([4, 1, 3, 2, 5], 0.95), 5);
  assert.equal(percentile(samples(7), 0.95), 7);
  assert.equal(percentile([], 0.95), null);
});

test("runner keeps polling while a valid telemetry capture is still finalizing", () => {
  assert.equal(performanceGateNeedsTelemetryRetry({
    failures: ["telemetry_capture_window_mismatch"],
  }), true);
  assert.equal(performanceGateNeedsTelemetryRetry({
    failures: ["telemetry_capture_event_count_mismatch"],
  }), true);
  assert.equal(performanceGateNeedsTelemetryRetry({
    failures: ["telemetry_capture_lineage_mismatch"],
  }), false);
});

test("runner fails immediately on a semantically invalid control-plane capture", async () => {
  const input = fixture();
  const telemetryJsonl = `${input.server_telemetry.map((item) => JSON.stringify(item)).join("\n")}\n`;
  const invalidCapture = JSON.stringify({
    ...input.telemetry_capture,
    generator: "mind-diary/untrusted-runtime-self-attestation/v1",
  });
  let reads = 0;
  let sleeps = 0;
  await assert.rejects(
    waitForTelemetry({
      telemetryPath: "telemetry.jsonl",
      telemetryCapturePath: "capture.json",
      timeoutSeconds: 300,
      evaluation: {},
    }, {
      readText: async (path) => {
        reads += 1;
        return path === "telemetry.jsonl" ? telemetryJsonl : invalidCapture;
      },
      sleep: async () => { sleeps += 1; },
    }),
    (error) => error?.code === "invalid_control_plane_capture",
  );
  assert.equal(reads, 2);
  assert.equal(sleeps, 0);
});

test("profile receipt verifies observed Minds, revisions, files and bytes and rejects tampering", () => {
  const receipt = profileReceipt();
  assert.deepEqual(verifyPerformanceProfileReadbackReceipt(receipt), receipt);
  const oversized = structuredClone(receipt);
  oversized.profiles[0].observed.files = 17;
  oversized.profiles[0].expected.files = 17;
  assert.throws(
    () => createPerformanceProfileReadbackReceipt(oversized),
    /starter_small_profile_incomplete/u,
  );
  const declaredOnly = structuredClone(receipt);
  declaredOnly.profiles[2].observed.bytes = 512;
  declaredOnly.profiles[2].expected.bytes = 513;
  assert.throws(
    () => createPerformanceProfileReadbackReceipt(declaredOnly),
    /profile_readback_mismatch/u,
  );
  const wrongTopology = structuredClone(receipt);
  wrongTopology.profiles[1].fixture_fingerprint = wrongTopology.profiles[2].fixture_fingerprint;
  assert.throws(
    () => createPerformanceProfileReadbackReceipt(wrongTopology),
    /small_history_fixture_topology_invalid/u,
  );
});

test("scenario is exact-SHA/deployment scoped and forbids inline credentials and declared matrix", () => {
  const receipt = profileReceipt();
  const scenario = validatePerformanceScenario(rawScenario(), receipt);
  assert.equal(scenario.requests.length, 13);
  assert.equal(
    verifyPerformanceScenarioCredentialBindings(scenario, receipt, credentialEnvironment()),
    true,
  );
  const inlineCredential = rawScenario();
  inlineCredential.requests[1].headers.authorization = "Bearer private";
  assert.throws(
    () => validatePerformanceScenario(inlineCredential, receipt),
    /invalid_scenario_headers/u,
  );
  const staleShape = { ...rawScenario(), profile_matrix: { mind_counts: [1, 10, 100] } };
  assert.throws(() => validatePerformanceScenario(staleShape, receipt), /invalid_scenario/u);
  const missingCompatibility = rawScenario();
  missingCompatibility.requests = missingCompatibility.requests.filter(
    ({ profile: profileName }) => profileName !== "mcp_compatibility",
  );
  assert.throws(
    () => validatePerformanceScenario(missingCompatibility, receipt),
    /scenario_coverage_incomplete:profile_coverage_missing:mcp_compatibility/u,
  );
  const missingTransport = rawScenario();
  delete missingTransport.requests[1].headers["mcp-protocol-version"];
  assert.throws(
    () => validatePerformanceScenario(missingTransport, receipt),
    /invalid_mcp_scenario_request/u,
  );
  const wrongFixtureSelection = rawScenario();
  const historyRequest = wrongFixtureSelection.requests.find(({ fixture_profile_id }) =>
    fixture_profile_id === "history1");
  historyRequest.body.params.arguments.revision_id = "revision_wrong";
  assert.throws(
    () => validatePerformanceScenario(wrongFixtureSelection, receipt),
    /fixture_request_binding_mismatch/u,
  );
  const wrongCredential = credentialEnvironment();
  wrongCredential[fixtureCredentialEnv("starter")] = fixtureCredential("history1");
  assert.throws(
    () => verifyPerformanceScenarioCredentialBindings(scenario, receipt, wrongCredential),
    /fixture_credential_binding_mismatch/u,
  );
});

test("performance gate passes only correlated web, modern and compatibility cold plus warm evidence", () => {
  assert.ok(PERFORMANCE_BUDGETS_MS.server.list_minds > 0);
  const report = evaluatePerformanceGate(fixture());
  assert.equal(report.status, "passed", JSON.stringify(report.failures));
  assert.deepEqual(report.failures, []);
  assert.equal(report.connector.length, 13);
  assert.ok(report.connector.every(({ telemetry_correlated_requests }) =>
    telemetry_correlated_requests === 21));
  assert.equal(report.server.length, 8);
  assert.ok(report.server.every(({ warm }) => warm.samples >= 20));
  assert.deepEqual(report.history_growth.map(({ ratio }) => ratio), [1.1, 1.1]);
  assert.deepEqual(verifyPerformanceGateArtifact(report), report);
});

test("gate fails closed on missing profile, stale telemetry, negative values and regression", () => {
  const input = fixture();
  input.scenario = {
    ...input.scenario,
    requests: input.scenario.requests.filter(({ profile }) => profile !== "mcp_compatibility"),
  };
  input.connector_results = input.connector_results.filter(({ profile }) => profile !== "mcp_compatibility");
  input.server_telemetry = input.server_telemetry.filter(({ operation }) => operation !== "mcp_compatibility");
  input.connector_results[0] = {
    ...input.connector_results[0],
    observed_cold_ms: 6_000,
    warm_ms: samples(4_000).slice(0, 19),
  };
  input.server_telemetry[0] = {
    ...input.server_telemetry[0],
    value: -1,
    occurredAtUtc: "2026-08-23T23:00:00.000Z",
  };
  const report = evaluatePerformanceGate(input);
  assert.equal(report.status, "failed");
  for (const failure of [
    "profile_coverage_missing:mcp_compatibility",
    "operation_coverage_missing:mcp_compatibility:list_minds",
    "fixture_profile_unexercised:mcp_compatibility:starter",
    "observed_cold_budget_exceeded:web.home",
    "connector_samples_incomplete:web.home",
    "connector_p95_budget_exceeded:web.home",
    "telemetry_schema_invalid:0",
    "history_comparison_missing:mcp_compatibility",
    "server_samples_below_20:mcp_compatibility:list_minds",
  ]) assert.ok(report.failures.includes(failure), failure);
});

test("telemetry is bound to exact lineage and runner-owned per-sample correlation", () => {
  const wrongLineage = fixture();
  wrongLineage.server_telemetry[0] = {
    ...wrongLineage.server_telemetry[0],
    lineage: {
      ...wrongLineage.server_telemetry[0].lineage,
      deploymentId: "appgdep_foreign",
    },
  };
  const wrongLineageReport = evaluatePerformanceGate(wrongLineage);
  assert.equal(wrongLineageReport.status, "failed");
  assert.ok(wrongLineageReport.failures.includes("telemetry_lineage_mismatch:0"));

  const foreignRequest = fixture();
  for (let index = 0; index < foreignRequest.server_telemetry.length; index += 1) {
    if (foreignRequest.server_telemetry[index].requestId !== "request_perf_0_0") continue;
    foreignRequest.server_telemetry[index] = {
      ...foreignRequest.server_telemetry[index],
      benchmarkCorrelationId: "benchmark_foreign_same_window",
    };
  }
  const foreignReport = evaluatePerformanceGate(foreignRequest);
  assert.equal(foreignReport.status, "failed");
  assert.ok(foreignReport.failures.includes("telemetry_sample_correlation_mismatch:web.home:0"));
});

test("telemetry capture receipt binds the finalized JSONL and exact deployment window", () => {
  const input = fixture();
  const telemetryJsonl = `${input.server_telemetry.map((item) => JSON.stringify(item)).join("\n")}\n`;
  assert.deepEqual(
    verifyPerformanceTelemetryCaptureReceipt(input.telemetry_capture, telemetryJsonl),
    input.telemetry_capture,
  );
  assert.throws(
    () => verifyPerformanceTelemetryCaptureReceipt(input.telemetry_capture, `${telemetryJsonl} `),
    /invalid_capture_receipt/u,
  );
  input.telemetry_capture = createPerformanceTelemetryCaptureReceipt({
    status: "passed",
    candidate_sha: CANDIDATE,
    environment: "uat",
    target_url: TARGET,
    deployment: { ...DEPLOYMENT_RECORD, deployment_id: "appgdep_foreign" },
    started_at: new Date(RUN_START - 1_000).toISOString(),
    completed_at: new Date(Date.parse(input.completed_at) + 1_000).toISOString(),
    generator: PERFORMANCE_TELEMETRY_CAPTURE_GENERATOR,
    control_plane_query_id: "request_control_plane_foreign",
  }, telemetryJsonl);
  const report = evaluatePerformanceGate(input);
  assert.equal(report.status, "failed");
  assert.ok(report.failures.includes("telemetry_capture_lineage_mismatch"));
});

test("closed telemetry parser rejects extra or private dimensions", () => {
  const valid = event({
    requestId: "request_closed_1",
    occurredAtUtc: "2026-08-24T00:00:00.000Z",
    surface: "mcp",
    operation: "search",
  });
  assert.equal(parsePerformanceTelemetryJsonl(`${JSON.stringify(valid)}\n`).length, 1);
  assert.throws(
    () => parsePerformanceTelemetryJsonl(JSON.stringify({ ...valid, query: "private" })),
    /invalid_telemetry_event/u,
  );
});

test("performance report hash detects post-gate mutation", () => {
  const report = structuredClone(evaluatePerformanceGate(fixture()));
  report.connector[0].warm.p95_ms = 0;
  assert.throws(() => verifyPerformanceGateArtifact(report), /invalid_performance_report_hash/u);
});
