import assert from "node:assert/strict";


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
    return { mind: "/performance-starter", revision_selector: { kind: "head" } };
  }
  if (operation === "fetch") return { id: "entry_performance_starter" };
  if (operation === "search") {
    return { mind: "/performance-starter", query: "synthetic performance marker" };
  }
  throw new Error(`unexpected fixture operation ${operation}`);
}

function operationsForKind(kind) {
  if (kind === "small_history") return ["get_revision"];
  return ["list_minds", "browse_entries", "search", "fetch"];
}

function profile(id, kind, observed, fingerprintId = id) {
  return {
    id,
    kind,
    fixture_fingerprint: `sha256:${fingerprintId.charCodeAt(0).toString(16).padStart(2, "0").repeat(32)}`,
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
    generator: "mind-diary/uat-profile-provision-readback/v2",
    profiles: [
      profile("starter", "starter_small", counts({ minds: 2, revisions: 1, files: 2, bytes: 1_024 })),
      profile("history1", "small_history", counts({ minds: 2, revisions: 1, files: 2, bytes: 1_024 }), "starter"),
      profile("history10", "small_history", counts({ minds: 2, revisions: 10, files: 1, bytes: 512 })),
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
      mcpRequest(profileName, "list_minds", "starter", "starter"),
      mcpRequest(profileName, "browse_entries", "starter", "starter_browse"),
      mcpRequest(profileName, "search", "starter", "starter_search"),
      mcpRequest(profileName, "fetch", "starter", "starter_fetch"),
      mcpRequest(
        profileName,
        "get_revision",
        "history1",
        "history1",
        { group: "point_history", scale: 1 },
      ),
      mcpRequest(
        profileName,
        "get_revision",
        "history10",
        "history10",
        { group: "point_history", scale: 10 },
      ),
    );
  }
  return {
    schema: "mind-diary/performance-scenario/v3",
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


export { CANDIDATE, DEPLOYMENT, TARGET, RUN_START, BINDING_KEY, DEPLOYMENT_RECORD, counts, fixtureCredential, fixtureCredentialEnv, fixtureArguments, operationsForKind, profile, profileReceipt, mcpRequest, rawScenario, credentialEnvironment, event, samples, fixture };
