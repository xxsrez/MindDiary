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

const CANDIDATE = "a".repeat(40);
const DEPLOYMENT = "appgdep_performancefixture";
const TARGET = "https://mind-diary.example";
const RUN_START = Date.parse("2026-08-24T00:00:00.000Z");
const BINDING_KEY = "performance-binding-key-32-bytes-minimum";
const DEPLOYMENT_RECORD = Object.freeze({
  site_project_id: "appgprj_performancefixture",
  site_version_id: "appgver_performancefixture",
  deployment_id: DEPLOYMENT,
  archive_sha256: `sha256:${"b".repeat(64)}`,
});

function counts({ minds = 1, revisions = 1, files = 2, bytes = 128 } = {}) {
  return { minds, revisions, files, bytes };
}

function fixtureCredential(id) {
  return `mdp_v1_${id}_${"x".repeat(48)}`;
}

function fixtureCredentialEnv(id) {
  return `MIND_DIARY_PERFORMANCE_${id.toUpperCase()}_TOKEN`;
}

function fixtureArguments(id, operation) {
  if (operation === "list_minds") return {};
  if (operation === "get_revision") {
    return { mind: `/performance-${id}`, revision_id: `revision_${id}` };
  }
  if (operation === "browse_entries") {
    return { mind: "/performance-brain", revision_selector: { kind: "head" } };
  }
  if (operation === "fetch") return { id: "entry_performance_brain" };
  if (operation === "search") {
    return { mind: "/performance-mixed", query: "synthetic performance marker" };
  }
  throw new Error(`unexpected fixture operation ${operation}`);
}

function operationsForKind(kind) {
  if (kind === "mind_count") return ["list_minds"];
  if (kind === "revision_count") return ["get_revision"];
  if (kind === "brain_markdown") return ["browse_entries", "fetch"];
  return ["search"];
}

function profile(id, kind, observed) {
  return {
    id,
    kind,
    fixture_fingerprint: `sha256:${id.charCodeAt(0).toString(16).padStart(2, "0").repeat(32)}`,
    credential_binding: {
      scheme: "hmac-sha256-v1",
      digest: createPerformanceCredentialBinding({
        key: BINDING_KEY,
        profileId: id,
        credential: fixtureCredential(id),
      }),
    },
    request_bindings: operationsForKind(kind).map((operation) => ({
      operation,
      arguments_sha256: performanceRequestArgumentsDigest(fixtureArguments(id, operation)),
    })),
    provisioning_request_id: `request_provision_${id}`,
    readback_request_id: `request_readback_${id}`,
    expected: observed,
    observed,
  };
}

function profileReceipt() {
  return createPerformanceProfileReadbackReceipt({
    status: "passed",
    candidate_sha: CANDIDATE,
    environment: "uat",
    target_url: TARGET,
    deployment: DEPLOYMENT_RECORD,
    started_at: "2026-08-23T23:55:00.000Z",
    completed_at: "2026-08-23T23:59:00.000Z",
    generator: "mind-diary/uat-profile-provision-readback/v1",
    profiles: [
      profile("minds1", "mind_count", counts({ minds: 1 })),
      profile("minds10", "mind_count", counts({ minds: 10 })),
      profile("minds100", "mind_count", counts({ minds: 100 })),
      profile("revisions1", "revision_count", counts({ revisions: 1 })),
      profile("revisions20", "revision_count", counts({ revisions: 20 })),
      profile("revisions100", "revision_count", counts({ revisions: 100 })),
      profile("revisions1000", "revision_count", counts({ revisions: 1_000 })),
      profile("brain", "brain_markdown", counts({ files: 1_741, bytes: 5_681_704 })),
      profile("mixed", "mixed_corpus", counts({ files: 80, bytes: 590_000_000 })),
    ],
  });
}

function mcpRequest(profileName, operation, fixtureProfileId, suffix, historyComparison) {
  const id = `${profileName}.${operation}.${suffix}`;
  return {
    id,
    profile: profileName,
    fixture_profile_id: fixtureProfileId,
    operation,
    method: "POST",
    path: profileName === "mcp_modern" ? "/api/mcp" : "/api/mcp/2025-11-25",
    expected_status: 200,
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json; charset=utf-8",
      "mcp-protocol-version": profileName === "mcp_modern" ? "2026-07-28" : "2025-11-25",
      ...(profileName === "mcp_modern"
        ? { "mcp-method": "tools/call", "mcp-name": operation }
        : {}),
    },
    bearer_token_env: fixtureCredentialEnv(fixtureProfileId),
    sites_authorization_env: "MIND_DIARY_PERFORMANCE_SITES_TOKEN",
    body: {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: operation,
        arguments: fixtureArguments(fixtureProfileId, operation),
        ...(profileName === "mcp_modern" ? {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "mind-diary-performance-gate",
              version: "v2",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        } : {}),
      },
    },
    ...(historyComparison === undefined ? {} : { history_comparison: historyComparison }),
  };
}

function rawScenario() {
  const requests = [{
    id: "web.home",
    profile: "web",
    fixture_profile_id: null,
    operation: "home",
    method: "GET",
    path: "/",
    expected_status: 200,
    headers: { accept: "text/html" },
    sites_authorization_env: "MIND_DIARY_PERFORMANCE_SITES_TOKEN",
  }];
  for (const profileName of ["mcp_modern", "mcp_compatibility"]) {
    requests.push(
      mcpRequest(profileName, "list_minds", "minds1", "minds1"),
      mcpRequest(profileName, "list_minds", "minds10", "minds10"),
      mcpRequest(profileName, "list_minds", "minds100", "minds100"),
      mcpRequest(profileName, "get_revision", "revisions1", "revisions1"),
      mcpRequest(profileName, "get_revision", "revisions20", "revisions20"),
      mcpRequest(
        profileName,
        "get_revision",
        "revisions100",
        "revisions100",
        { group: "point_history", scale: 1 },
      ),
      mcpRequest(
        profileName,
        "get_revision",
        "revisions1000",
        "revisions1000",
        { group: "point_history", scale: 10 },
      ),
      mcpRequest(profileName, "browse_entries", "brain", "brain"),
      mcpRequest(profileName, "fetch", "brain", "brain_fetch"),
      mcpRequest(profileName, "search", "mixed", "mixed"),
    );
  }
  return {
    schema: "mind-diary/performance-scenario/v2",
    target_url: TARGET,
    environment: "uat",
    candidate_sha: CANDIDATE,
    deployment_id: DEPLOYMENT,
    warm_samples: 20,
    telemetry_wait_seconds: 0,
    credential_binding_key_env: "MIND_DIARY_PERFORMANCE_BINDING_KEY",
    performance_correlation_key_env: "MIND_DIARY_PERFORMANCE_CORRELATION_KEY",
    requests,
  };
}

function credentialEnvironment() {
  return Object.fromEntries([
    ["MIND_DIARY_PERFORMANCE_BINDING_KEY", BINDING_KEY],
    ...profileReceipt().profiles.map(({ id }) => [fixtureCredentialEnv(id), fixtureCredential(id)]),
  ]);
}

function event({
  requestId,
  benchmarkCorrelationId = "benchmark_fixture",
  occurredAtUtc,
  surface,
  operation,
  value = 100,
  outcome = "success",
  lineage = {
    candidateSha: CANDIDATE,
    siteVersionId: DEPLOYMENT_RECORD.site_version_id,
    deploymentId: DEPLOYMENT,
  },
}) {
  return {
    event: PERFORMANCE_TELEMETRY_EVENT,
    schema: PERFORMANCE_TELEMETRY_SCHEMA,
    kind: "operational",
    metric: "request_latency_ms",
    surface,
    operation,
    outcome,
    unit: "milliseconds",
    value,
    occurredAtUtc,
    requestId,
    jobId: null,
    cohort: null,
    lineage,
    benchmarkCorrelationId,
  };
}

function samples(value) {
  return Array.from({ length: 20 }, () => value);
}

function fixture() {
  const receipt = profileReceipt();
  const scenario = validatePerformanceScenario(rawScenario(), receipt);
  const connectorResults = [];
  const telemetry = [];
  for (const [index, definition] of scenario.requests.entries()) {
    const started = RUN_START + (index + 1) * 1_000;
    const sampleWindows = Array.from({ length: 21 }, (_, sample) => {
      const observed = started + 10 + sample * 20;
      return {
        kind: sample === 0 ? "cold" : "warm",
        index: sample === 0 ? 0 : sample - 1,
        started_at: new Date(observed - 5).toISOString(),
        completed_at: new Date(observed + 5).toISOString(),
        request_id: `request_perf_${index}_${sample}`,
        benchmark_correlation_id: `benchmark_perf_${index}_${sample}`,
      };
    });
    const coldCompleted = Date.parse(sampleWindows[0].completed_at);
    const completed = Date.parse(sampleWindows.at(-1).completed_at);
    const historyValue = definition.history_comparison?.scale === 10 ? 110 : 100;
    connectorResults.push({
      id: definition.id,
      profile: definition.profile,
      fixture_profile_id: definition.fixture_profile_id,
      operation: definition.operation,
      response_verified: true,
      fixture_binding_verified: true,
      observed_cold_ms: 100,
      warm_ms: samples(historyValue),
      sample_windows: sampleWindows,
      started_at: sampleWindows[0].started_at,
      cold_completed_at: new Date(coldCompleted).toISOString(),
      completed_at: new Date(completed).toISOString(),
    });
    for (let sample = 0; sample <= 20; sample += 1) {
      const occurredAtUtc = new Date(started + 10 + sample * 20).toISOString();
      const requestId = `request_perf_${index}_${sample}`;
      const surface = definition.profile === "web" ? "control" : "mcp";
      const operations = definition.profile === "web"
        ? ["stage_authentication", "stage_application", "stage_total", "home"]
        : [definition.profile, "stage_authentication", "stage_application", "stage_total", definition.operation];
      for (const operation of operations) {
        telemetry.push(event({
          requestId,
          benchmarkCorrelationId: `benchmark_perf_${index}_${sample}`,
          occurredAtUtc,
          surface,
          operation,
          value: operation === definition.operation ? historyValue : 100,
        }));
      }
    }
  }
  const startedAt = new Date(RUN_START).toISOString();
  const completedAt = new Date(RUN_START + (scenario.requests.length + 2) * 1_000).toISOString();
  const telemetryJsonl = `${telemetry.map((item) => JSON.stringify(item)).join("\n")}\n`;
  const telemetryCapture = createPerformanceTelemetryCaptureReceipt({
    status: "passed",
    candidate_sha: CANDIDATE,
    environment: "uat",
    target_url: TARGET,
    deployment: DEPLOYMENT_RECORD,
    started_at: new Date(RUN_START - 1_000).toISOString(),
    completed_at: new Date(Date.parse(completedAt) + 1_000).toISOString(),
    generator: PERFORMANCE_TELEMETRY_CAPTURE_GENERATOR,
    control_plane_query_id: "request_control_plane_fixture",
  }, telemetryJsonl);
  return {
    candidate_sha: CANDIDATE,
    deployment_id: DEPLOYMENT,
    environment: "uat",
    target_url: TARGET,
    started_at: startedAt,
    completed_at: completedAt,
    warm_samples: 20,
    scenario,
    profile_readback: receipt,
    connector_results: connectorResults,
    server_telemetry: telemetry,
    telemetry_capture: telemetryCapture,
  };
}

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
  const tampered = structuredClone(receipt);
  tampered.profiles[7].observed.files = 1_740;
  assert.throws(
    () => verifyPerformanceProfileReadbackReceipt(tampered),
    /profile readback rejected/u,
  );
  const declaredOnly = structuredClone(receipt);
  declaredOnly.profiles[8].observed.bytes = 590_000_000;
  declaredOnly.profiles[8].expected.bytes = 590_000_001;
  assert.throws(
    () => createPerformanceProfileReadbackReceipt(declaredOnly),
    /profile_readback_mismatch/u,
  );
});

test("scenario is exact-SHA/deployment scoped and forbids inline credentials and declared matrix", () => {
  const receipt = profileReceipt();
  const scenario = validatePerformanceScenario(rawScenario(), receipt);
  assert.equal(scenario.requests.length, 21);
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
  wrongFixtureSelection.requests[4].body.params.arguments.revision_id = "revision_wrong";
  assert.throws(
    () => validatePerformanceScenario(wrongFixtureSelection, receipt),
    /fixture_request_binding_mismatch/u,
  );
  const wrongCredential = credentialEnvironment();
  wrongCredential[fixtureCredentialEnv("minds10")] = fixtureCredential("minds1");
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
  assert.equal(report.connector.length, 21);
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
    "fixture_profile_unexercised:mcp_compatibility:minds1",
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
