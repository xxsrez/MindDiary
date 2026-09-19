import { createHash } from "node:crypto";
import { verifyAcceptanceClockCalibration } from "./acceptance-clock-calibration.mjs";

import {
  PILOT_COHORTS,
  PRIVACY_SAFE_OBSERVABILITY_OPERATIONS,
  PRIVACY_SAFE_OBSERVABILITY_OUTCOMES,
  PRIVACY_SAFE_OBSERVABILITY_SURFACES,
  PRIVACY_SAFE_OBSERVABILITY_UNITS,
  PRIVACY_SAFE_OPERATIONAL_METRICS,
  PRIVACY_SAFE_PILOT_METRICS,
} from "@mind-diary/application-ports";

import {
  createPerformanceCredentialBinding,
  performanceRequestArgumentsDigest,
  REQUIRED_SMALL_HISTORY_REVISION_COUNTS,
  REQUIRED_STARTER_SMALL,
} from "./performance-profile-readback.mjs";
import { verifyPerformanceTelemetryCaptureReceipt } from "./performance-telemetry-capture.mjs";

export const PERFORMANCE_GATE_SCHEMA = "mind-diary/performance-gate/v3";
export const PERFORMANCE_SCENARIO_SCHEMA = "mind-diary/performance-scenario/v3";
export const PERFORMANCE_TELEMETRY_EVENT = "mind-diary.performance-gate-telemetry";
export const PERFORMANCE_TELEMETRY_SCHEMA = "mind-diary/performance-gate-telemetry/v1";

export const PERFORMANCE_BUDGETS_MS = Object.freeze({
  server: Object.freeze({
    list_minds: 2_000,
    browse_entries: 2_000,
    list_files: 2_000,
    grep_files: 2_000,
    read_files: 1_000,
    search: 2_000,
    fetch: 1_000,
  }),
  connector_read: 5_000,
  home: 3_000,
  observed_cold: 5_000,
  history_growth_ratio: 1.2,
});

export const REQUIRED_PROFILE_MATRIX = Object.freeze({
  starter_small: REQUIRED_STARTER_SMALL,
  history_revision_counts: REQUIRED_SMALL_HISTORY_REVISION_COUNTS,
});

export const PERFORMANCE_PROFILES = Object.freeze([
  "web",
  "mcp_modern",
]);

const MCP_PROFILES = Object.freeze(["mcp_modern"]);
const REQUIRED_MCP_OPERATIONS = Object.freeze(Object.keys(PERFORMANCE_BUDGETS_MS.server));
const READ_OPERATIONS = new Set([
  ...REQUIRED_MCP_OPERATIONS,
  "get_mind_info",
  "get_mind_bindings",
  "list_revisions",
  "get_revision",
  "validate_mind",
  "get_export_status",
]);
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z][a-z0-9._:-]{0,119}$/u;
const DEPLOYMENT = /^appgdep_[a-z0-9]+$/u;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,127}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const REQUEST_ID = /^(?:req|request|background-request|download-request)[_-][A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const JOB_ID = /^(?:(?:job(?:-[a-z]+)?)|export|index|audit|invitation|deletion)[_-][A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "oai-sites-authorization",
  "proxy-authorization",
  "x-mind-diary-performance-correlation-id",
  "x-mind-diary-performance-correlation-signature",
]);

const SCENARIO_KEYS = new Set([
  "schema",
  "target_url",
  "environment",
  "candidate_sha",
  "deployment_id",
  "warm_samples",
  "telemetry_wait_seconds",
  "credential_binding_key_env",
  "performance_correlation_key_env",
  "requests",
]);
const REQUEST_KEYS = new Set([
  "id",
  "profile",
  "fixture_profile_id",
  "operation",
  "method",
  "path",
  "expected_status",
  "headers",
  "bearer_token_env",
  "sites_authorization_env",
  "cookie_env",
  "body",
  "history_comparison",
]);
const HISTORY_KEYS = new Set(["group", "scale"]);

const OPERATIONAL_METRICS = new Set(PRIVACY_SAFE_OPERATIONAL_METRICS);
const PILOT_METRICS = new Set(PRIVACY_SAFE_PILOT_METRICS);
const SURFACES = new Set(PRIVACY_SAFE_OBSERVABILITY_SURFACES);
const OPERATIONS = new Set(PRIVACY_SAFE_OBSERVABILITY_OPERATIONS);
const OUTCOMES = new Set(PRIVACY_SAFE_OBSERVABILITY_OUTCOMES);
const UNITS = new Set(PRIVACY_SAFE_OBSERVABILITY_UNITS);
const COHORTS = new Set(PILOT_COHORTS);
const METRIC_UNITS = Object.freeze({
  request_latency_ms: "milliseconds",
  request_error: "count",
  authentication_outcome: "count",
  cas_conflict: "count",
  index_lag_ms: "milliseconds",
  export_lag_ms: "milliseconds",
  invitation_outcome: "count",
  token_outcome: "count",
  deletion_outcome: "count",
  rate_limit: "count",
  storage_cost_bytes: "bytes",
  query_cost_units: "query_units",
  cleanup_queue_age_ms: "milliseconds",
  cleanup_reclaimed_bytes: "bytes",
  cleanup_orphan_count: "count",
  cleanup_retry_count: "count",
  cleanup_failure_count: "count",
  setup_completion: "count",
  time_to_first_useful_search_ms: "milliseconds",
  time_to_first_meaningful_commit_ms: "milliseconds",
  usage: "count",
  retention: "count",
  lexical_search_effectiveness: "ratio",
  citation_success: "ratio",
});
const TELEMETRY_KEYS = new Set([
  "event", "schema", "kind", "metric", "surface", "operation", "outcome",
  "unit", "value", "occurredAtUtc", "requestId", "jobId", "cohort", "lineage",
  "benchmarkCorrelationId",
]);
const TELEMETRY_LINEAGE_KEYS = new Set(["candidateSha", "siteVersionId", "deploymentId"]);
const BENCHMARK_CORRELATION_ID = /^benchmark_[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const REPORT_KEYS = new Set([
  "schema", "status", "candidate_sha", "deployment", "environment", "target_url",
  "started_at", "completed_at", "duration_ms", "warm_samples", "budgets_ms",
  "profile_readback_sha256", "profile_matrix", "connector", "server",
  "history_growth", "telemetry_capture_sha256", "telemetry", "failures", "artifact_sha256",
]);

export class PerformanceGateInputError extends TypeError {
  constructor(code) {
    super(`performance gate input rejected: ${code}`);
    this.name = "PerformanceGateInputError";
    this.code = code;
  }
}

function reject(code) {
  throw new PerformanceGateInputError(code);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value, expected, code) {
  if (!isRecord(value)) reject(code);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    reject(code);
  }
}

function assertAllowedKeys(value, allowed, code) {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.has(key))) reject(code);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function timestamp(value) {
  return typeof value === "string" && UTC.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function normalizedTargetUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    reject("invalid_target_url");
  }
  if (
    parsed.protocol !== "https:" || parsed.username || parsed.password ||
    parsed.search || parsed.hash || parsed.pathname !== "/"
  ) reject("invalid_target_url");
  return parsed.toString().replace(/\/$/u, "");
}

function optionalEnvironmentReference(value) {
  return value === undefined || (typeof value === "string" && ENVIRONMENT_NAME.test(value));
}

function normalizedHeaders(value) {
  const result = new Map();
  for (const [key, header] of Object.entries(value ?? {})) {
    result.set(key.toLowerCase(), header);
  }
  return result;
}

function validModernProtocolMetadata(params) {
  const meta = params?._meta;
  const clientInfo = meta?.["io.modelcontextprotocol/clientInfo"];
  return isRecord(meta) &&
    meta["io.modelcontextprotocol/protocolVersion"] === "2026-07-28" &&
    isRecord(clientInfo) &&
    typeof clientInfo.name === "string" && clientInfo.name.length > 0 &&
    typeof clientInfo.version === "string" && clientInfo.version.length > 0 &&
    isRecord(meta["io.modelcontextprotocol/clientCapabilities"]);
}

function scenarioRequest(value, fixtureProfiles) {
  assertAllowedKeys(value, REQUEST_KEYS, "invalid_scenario_request");
  if (
    typeof value.id !== "string" || !SAFE_ID.test(value.id) ||
    !PERFORMANCE_PROFILES.includes(value.profile) ||
    !(
      value.profile === "web"
        ? value.fixture_profile_id === null
        : typeof value.fixture_profile_id === "string" && fixtureProfiles.has(value.fixture_profile_id)
    ) ||
    typeof value.operation !== "string" ||
    typeof value.method !== "string" || !/^(?:GET|HEAD|POST)$/u.test(value.method) ||
    typeof value.path !== "string" || !value.path.startsWith("/") || value.path.includes("?") ||
    !Number.isInteger(value.expected_status) || value.expected_status < 200 || value.expected_status >= 300 ||
    !optionalEnvironmentReference(value.bearer_token_env) ||
    !optionalEnvironmentReference(value.sites_authorization_env) || !optionalEnvironmentReference(value.cookie_env)
  ) reject("invalid_scenario_request");
  if (value.headers !== undefined) {
    if (!isRecord(value.headers)) reject("invalid_scenario_headers");
    for (const [key, header] of Object.entries(value.headers)) {
      if (
        !/^[a-z0-9-]{1,64}$/u.test(key) || SENSITIVE_HEADERS.has(key.toLowerCase()) ||
        typeof header !== "string" || header.length > 512
      ) reject("invalid_scenario_headers");
    }
  }
  let historyComparison = null;
  if (value.history_comparison !== undefined) {
    assertExactKeys(value.history_comparison, HISTORY_KEYS, "invalid_history_comparison");
    if (
      typeof value.history_comparison.group !== "string" ||
      !SAFE_ID.test(value.history_comparison.group) ||
      ![1, 10].includes(value.history_comparison.scale)
    ) reject("invalid_history_comparison");
    historyComparison = Object.freeze({ ...value.history_comparison });
  }
  if (value.profile === "web") {
    if (
      value.operation !== "home" || value.method !== "GET" || value.path !== "/" ||
      value.body !== undefined || value.bearer_token_env !== undefined ||
      value.sites_authorization_env === undefined || historyComparison !== null
    ) reject("invalid_web_scenario_request");
  } else {
    const expectedPath = "/api/mcp";
    const headers = normalizedHeaders(value.headers);
    const protocolVersion = "2026-07-28";
    if (
      value.cookie_env !== undefined || !READ_OPERATIONS.has(value.operation) || value.method !== "POST" ||
      value.path !== expectedPath || value.expected_status !== 200 ||
      value.bearer_token_env === undefined || value.sites_authorization_env === undefined ||
      headers.get("accept") !== "application/json, text/event-stream" ||
      !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(headers.get("content-type") ?? "") ||
      headers.get("mcp-protocol-version") !== protocolVersion ||
      !isRecord(value.body) || value.body.jsonrpc !== "2.0" ||
      (typeof value.body.id !== "string" && typeof value.body.id !== "number") ||
      value.body.method !== "tools/call" || !isRecord(value.body.params) ||
      value.body.params.name !== value.operation || !isRecord(value.body.params.arguments)
    ) reject("invalid_mcp_scenario_request");
    if (
      value.profile === "mcp_modern" &&
      (
        headers.get("mcp-method") !== "tools/call" ||
        headers.get("mcp-name") !== value.operation ||
        !validModernProtocolMetadata(value.body.params)
      )
    ) reject("invalid_modern_mcp_transport_metadata");
    const fixture = fixtureProfiles.get(value.fixture_profile_id);
    const argumentsSha256 = performanceRequestArgumentsDigest(value.body.params.arguments);
    if (!fixture.request_bindings.some((binding) =>
      binding.operation === value.operation && binding.arguments_sha256 === argumentsSha256)) {
      reject("fixture_request_binding_mismatch");
    }
    if (historyComparison !== null && value.operation !== "get_revision") {
      reject("history_comparison_not_revision_read");
    }
  }
  return Object.freeze({
    ...value,
    ...(historyComparison === null ? {} : { history_comparison: historyComparison }),
  });
}

export function validatePerformanceScenario(value, profileReadback) {
  assertExactKeys(value, SCENARIO_KEYS, "invalid_scenario");
  if (
    value.schema !== PERFORMANCE_SCENARIO_SCHEMA || value.environment !== "uat" ||
    typeof value.candidate_sha !== "string" || !SHA.test(value.candidate_sha) ||
    typeof value.deployment_id !== "string" || !DEPLOYMENT.test(value.deployment_id) ||
    !Number.isSafeInteger(value.warm_samples) || value.warm_samples < 20 ||
    !Number.isSafeInteger(value.telemetry_wait_seconds) ||
    value.telemetry_wait_seconds < 0 || value.telemetry_wait_seconds > 300 ||
    typeof value.credential_binding_key_env !== "string" ||
    !ENVIRONMENT_NAME.test(value.credential_binding_key_env) ||
    typeof value.performance_correlation_key_env !== "string" ||
    !ENVIRONMENT_NAME.test(value.performance_correlation_key_env) ||
    !Array.isArray(value.requests) || value.requests.length === 0
  ) reject("invalid_scenario");
  const fixtureProfiles = new Map(profileReadback.profiles.map((item) => [item.id, item]));
  const requests = Object.freeze(value.requests.map((item) => scenarioRequest(item, fixtureProfiles)));
  if (new Set(requests.map(({ id }) => id)).size !== requests.length) {
    reject("duplicate_scenario_request_id");
  }
  const coverageFailures = profileCoverageFailures(requests, profileReadback.profiles);
  if (coverageFailures.length > 0) {
    reject(`scenario_coverage_incomplete:${coverageFailures[0]}`);
  }
  return Object.freeze({
    schema: PERFORMANCE_SCENARIO_SCHEMA,
    target_url: normalizedTargetUrl(value.target_url),
    environment: "uat",
    candidate_sha: value.candidate_sha,
    deployment_id: value.deployment_id,
    warm_samples: value.warm_samples,
    telemetry_wait_seconds: value.telemetry_wait_seconds,
    credential_binding_key_env: value.credential_binding_key_env,
    performance_correlation_key_env: value.performance_correlation_key_env,
    requests,
  });
}

export function verifyPerformanceScenarioCredentialBindings(
  scenario,
  profileReadback,
  environment,
) {
  const key = environment?.[scenario.credential_binding_key_env];
  if (typeof key !== "string" || Buffer.byteLength(key) < 32) {
    reject("credential_binding_key_unavailable");
  }
  const fixtures = new Map(profileReadback.profiles.map((item) => [item.id, item]));
  for (const definition of scenario.requests) {
    if (definition.profile === "web") continue;
    const credential = environment?.[definition.bearer_token_env];
    if (typeof credential !== "string" || credential.length === 0) {
      reject(`fixture_credential_unavailable:${definition.id}`);
    }
    const actual = createPerformanceCredentialBinding({
      key,
      profileId: definition.fixture_profile_id,
      credential,
    });
    if (actual !== fixtures.get(definition.fixture_profile_id)?.credential_binding.digest) {
      reject(`fixture_credential_binding_mismatch:${definition.id}`);
    }
  }
  return true;
}

function isSafeCorrelation(value, pattern) {
  return value === null || (typeof value === "string" && pattern.test(value));
}

function validateTelemetryEvent(value) {
  assertExactKeys(value, TELEMETRY_KEYS, "invalid_telemetry_event");
  assertExactKeys(value.lineage, TELEMETRY_LINEAGE_KEYS, "invalid_telemetry_lineage");
  const operational = typeof value.metric === "string" && OPERATIONAL_METRICS.has(value.metric);
  const pilot = typeof value.metric === "string" && PILOT_METRICS.has(value.metric);
  if (
    value.event !== PERFORMANCE_TELEMETRY_EVENT ||
    value.schema !== PERFORMANCE_TELEMETRY_SCHEMA ||
    (value.kind !== "operational" && value.kind !== "pilot") ||
    (value.kind === "operational" && !operational) ||
    (value.kind === "pilot" && !pilot) ||
    !SURFACES.has(value.surface) || !OPERATIONS.has(value.operation) ||
    !OUTCOMES.has(value.outcome) || !UNITS.has(value.unit) ||
    METRIC_UNITS[value.metric] !== value.unit ||
    typeof value.value !== "number" || !Number.isFinite(value.value) ||
    value.value < 0 || value.value > Number.MAX_SAFE_INTEGER ||
    (value.unit === "ratio" && value.value > 1) || !timestamp(value.occurredAtUtc) ||
    !isSafeCorrelation(value.requestId, REQUEST_ID) || !isSafeCorrelation(value.jobId, JOB_ID) ||
    typeof value.lineage.candidateSha !== "string" || !SHA.test(value.lineage.candidateSha) ||
    typeof value.lineage.siteVersionId !== "string" ||
      !/^(?:appgver_[a-z0-9]+|appgprj_[a-z0-9]+~appgver_[a-z0-9]+)$/u.test(value.lineage.siteVersionId) ||
    typeof value.lineage.deploymentId !== "string" || !DEPLOYMENT.test(value.lineage.deploymentId) ||
    !isSafeCorrelation(value.benchmarkCorrelationId, BENCHMARK_CORRELATION_ID) ||
    (value.kind === "operational" && value.cohort !== null) ||
    (value.kind === "pilot" && !COHORTS.has(value.cohort))
  ) reject("invalid_telemetry_event");
  return Object.freeze({ ...value });
}

export function parsePerformanceTelemetryJsonl(text) {
  if (typeof text !== "string") reject("invalid_telemetry_jsonl");
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) reject("empty_telemetry_jsonl");
  return Object.freeze(lines.map((line) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      reject("invalid_telemetry_jsonl");
    }
    return validateTelemetryEvent(parsed);
  }));
}

export function percentile(samples, fraction) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const sorted = samples.map(Number).sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

export function performanceGateNeedsTelemetryRetry(report) {
  return Array.isArray(report?.failures) && report.failures.some((failure) =>
    failure === "telemetry_capture_window_mismatch" ||
    failure === "telemetry_capture_event_count_mismatch" ||
    failure.startsWith("telemetry_correlation_count_mismatch:") ||
    failure.startsWith("server_samples_below_20:"));
}

function rounded(value) {
  return value === null ? null : Number(value.toFixed(3));
}

function finiteNonnegativeSamples(value) {
  return Array.isArray(value) && value.every((sample) =>
    typeof sample === "number" && Number.isFinite(sample) && sample >= 0);
}

function summarizeSamples(samples) {
  if (samples.length === 0) {
    return Object.freeze({ samples: 0, min_ms: null, p50_ms: null, p95_ms: null, max_ms: null });
  }
  return Object.freeze({
    samples: samples.length,
    min_ms: rounded(Math.min(...samples)),
    p50_ms: rounded(percentile(samples, 0.5)),
    p95_ms: rounded(percentile(samples, 0.95)),
    max_ms: rounded(Math.max(...samples)),
  });
}

export function requiredPerformanceGroupOperations(profile, operation) {
  return profile === "web"
    ? Object.freeze(["stage_authentication", "stage_application", "stage_total", "home"])
    : Object.freeze([profile, "stage_authentication", "stage_application", "stage_total", operation]);
}

function groupTelemetry(events) {
  const groups = new Map();
  for (const event of events) {
    if (event.metric !== "request_latency_ms" || event.requestId === null) continue;
    const list = groups.get(event.requestId) ?? [];
    list.push(event);
    groups.set(event.requestId, list);
  }
  return groups;
}

function matchingGroup(group, profile, operation) {
  const surface = profile === "web" ? "control" : "mcp";
  if (group.some((event) => event.surface !== surface)) return false;
  const operations = new Set(group.map((event) => event.operation));
  return requiredPerformanceGroupOperations(profile, operation).every((item) => operations.has(item));
}

function groupWindow(group) {
  const observed = group.map(({ occurredAtUtc }) => Date.parse(occurredAtUtc));
  return Object.freeze({ started: Math.min(...observed), completed: Math.max(...observed) });
}

function groupTime(group) {
  return groupWindow(group).completed;
}

function profileCoverageFailures(definitions, receiptProfiles) {
  const failures = [];
  for (const profile of PERFORMANCE_PROFILES) {
    if (!definitions.some((item) => item.profile === profile)) failures.push(`profile_coverage_missing:${profile}`);
  }
  for (const profile of MCP_PROFILES) {
    for (const operation of REQUIRED_MCP_OPERATIONS) {
      if (!definitions.some((item) => item.profile === profile && item.operation === operation)) {
        failures.push(`operation_coverage_missing:${profile}:${operation}`);
      }
    }
  }
  for (const fixture of receiptProfiles) {
    for (const profile of MCP_PROFILES) {
      if (!definitions.some((item) =>
        item.profile === profile && item.fixture_profile_id === fixture.id)) {
        failures.push(`fixture_profile_unexercised:${profile}:${fixture.id}`);
      }
    }
  }
  return failures;
}

function durationWindow(startedAt, completedAt) {
  if (!timestamp(startedAt) || !timestamp(completedAt)) return null;
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  return completed < started ? null : Object.freeze({ started, completed });
}

function createReport(unsigned) {
  return Object.freeze({ ...unsigned, artifact_sha256: digest(canonical(unsigned)) });
}

export function evaluatePerformanceGate(input) {
  const failures = [];
  const addFailure = (code) => { if (!failures.includes(code)) failures.push(code); };
  const scenario = input.scenario ?? {};
  const profileReadback = input.profile_readback ?? {};
  let telemetryCapture = null;
  try {
    telemetryCapture = verifyPerformanceTelemetryCaptureReceipt(input.telemetry_capture);
  } catch {
    addFailure("telemetry_capture_invalid");
  }
  let clock = { lower_ms: 0, upper_ms: 0 };
  if (input.clock_calibration) {
    try { clock = verifyAcceptanceClockCalibration(input.clock_calibration, input); }
    catch { addFailure("clock_calibration_invalid"); }
  }
  const runWindow = durationWindow(input.started_at, input.completed_at);
  if (typeof input.candidate_sha !== "string" || !SHA.test(input.candidate_sha)) addFailure("invalid_candidate_sha");
  if (typeof input.deployment_id !== "string" || !DEPLOYMENT.test(input.deployment_id)) addFailure("invalid_deployment_id");
  if (input.environment !== "uat") addFailure("environment_not_uat");
  if (runWindow === null) addFailure("invalid_run_window");
  if (scenario.candidate_sha !== input.candidate_sha || profileReadback.candidate_sha !== input.candidate_sha) {
    addFailure("candidate_sha_mismatch");
  }
  if (scenario.deployment_id !== input.deployment_id || profileReadback.deployment?.deployment_id !== input.deployment_id) {
    addFailure("deployment_id_mismatch");
  }
  if (scenario.target_url !== input.target_url || profileReadback.target_url !== input.target_url) {
    addFailure("target_url_mismatch");
  }
  if (
    runWindow !== null &&
    (!timestamp(profileReadback.completed_at) || Date.parse(profileReadback.completed_at) > runWindow.started)
  ) addFailure("profile_readback_not_before_run");
  if (telemetryCapture !== null) {
    if (
      telemetryCapture.candidate_sha !== input.candidate_sha ||
      telemetryCapture.environment !== input.environment ||
      telemetryCapture.target_url !== input.target_url ||
      canonical(telemetryCapture.deployment) !== canonical(profileReadback.deployment)
    ) addFailure("telemetry_capture_lineage_mismatch");
    if (
      runWindow === null ||
      Date.parse(telemetryCapture.started_at) > runWindow.started ||
      Date.parse(telemetryCapture.completed_at) < runWindow.completed
    ) addFailure("telemetry_capture_window_mismatch");
  }
  const warmMinimum = Number(input.warm_samples);
  if (!Number.isSafeInteger(warmMinimum) || warmMinimum < 20) addFailure("warm_samples_below_20");

  const definitions = Array.isArray(scenario.requests) ? scenario.requests : [];
  const receiptProfiles = Array.isArray(profileReadback.profiles) ? profileReadback.profiles : [];
  for (const failure of profileCoverageFailures(definitions, receiptProfiles)) addFailure(failure);

  const telemetry = Array.isArray(input.server_telemetry) ? input.server_telemetry : [];
  const safeTelemetry = [];
  for (const [index, event] of telemetry.entries()) {
    try {
      const verified = validateTelemetryEvent(event);
      if (
        verified.lineage.candidateSha !== input.candidate_sha ||
        verified.lineage.siteVersionId !== profileReadback.deployment?.site_version_id ||
        verified.lineage.deploymentId !== input.deployment_id
      ) {
        addFailure(`telemetry_lineage_mismatch:${index}`);
        continue;
      }
      safeTelemetry.push(verified);
    } catch {
      addFailure(`telemetry_schema_invalid:${index}`);
    }
  }
  if (telemetryCapture !== null && telemetryCapture.event_count !== safeTelemetry.length) {
    addFailure("telemetry_capture_event_count_mismatch");
  }
  if (runWindow !== null && safeTelemetry.some((event) => {
    const observed = Date.parse(event.occurredAtUtc);
    return observed < runWindow.started + clock.lower_ms || observed > runWindow.completed + clock.upper_ms;
  })) addFailure("telemetry_outside_run_window");

  const groups = groupTelemetry(safeTelemetry);
  const assignedGroups = new Set();
  const connector = [];
  const serverWarm = new Map();
  const results = Array.isArray(input.connector_results) ? input.connector_results : [];
  const resultById = new Map(results.map((result) => [result.id, result]));
  if (resultById.size !== results.length) addFailure("duplicate_connector_result_id");

  for (const definition of definitions) {
    const result = resultById.get(definition.id);
    if (!result) {
      addFailure(`connector_result_missing:${definition.id}`);
      continue;
    }
    const block = durationWindow(result.started_at, result.completed_at);
    const coldCompleted = timestamp(result.cold_completed_at) ? Date.parse(result.cold_completed_at) : Number.NaN;
    const warm = result.warm_ms ?? [];
    const sampleWindows = Array.isArray(result.sample_windows) ? result.sample_windows : [];
    const identityMatches = result.profile === definition.profile &&
      result.operation === definition.operation &&
      result.fixture_profile_id === definition.fixture_profile_id &&
      result.response_verified === true &&
      result.fixture_binding_verified === true;
    if (!identityMatches) addFailure(`connector_result_mismatch:${definition.id}`);
    if (
      block === null || runWindow === null || block.started < runWindow.started ||
      block.completed > runWindow.completed || !Number.isFinite(coldCompleted) ||
      coldCompleted < block.started || coldCompleted > block.completed
    ) addFailure(`connector_window_invalid:${definition.id}`);
    if (
      typeof result.observed_cold_ms !== "number" || !Number.isFinite(result.observed_cold_ms) ||
      result.observed_cold_ms < 0 || !finiteNonnegativeSamples(warm)
    ) addFailure(`connector_samples_invalid:${definition.id}`);
    if (warm.length < 20 || warm.length !== warmMinimum) addFailure(`connector_samples_incomplete:${definition.id}`);
    if (sampleWindows.length !== warmMinimum + 1) {
      addFailure(`connector_sample_windows_incomplete:${definition.id}`);
    }
    for (const [sampleIndex, sampleWindow] of sampleWindows.entries()) {
      const window = durationWindow(sampleWindow?.started_at, sampleWindow?.completed_at);
      const expectedKind = sampleIndex === 0 ? "cold" : "warm";
      const expectedIndex = sampleIndex === 0 ? 0 : sampleIndex - 1;
      if (
        window === null || block === null ||
        sampleWindow?.kind !== expectedKind || sampleWindow?.index !== expectedIndex ||
        typeof sampleWindow?.request_id !== "string" || !REQUEST_ID.test(sampleWindow.request_id) ||
        typeof sampleWindow?.benchmark_correlation_id !== "string" ||
          !BENCHMARK_CORRELATION_ID.test(sampleWindow.benchmark_correlation_id) ||
        window.started < block.started || window.completed > block.completed ||
        (sampleIndex > 0 && durationWindow(
          sampleWindows[sampleIndex - 1]?.started_at,
          sampleWindows[sampleIndex - 1]?.completed_at,
        )?.completed > window.started)
      ) addFailure(`connector_sample_window_invalid:${definition.id}:${sampleIndex}`);
    }
    const summary = finiteNonnegativeSamples(warm) ? summarizeSamples(warm) : summarizeSamples([]);
    if (
      typeof result.observed_cold_ms === "number" && Number.isFinite(result.observed_cold_ms) &&
      result.observed_cold_ms > PERFORMANCE_BUDGETS_MS.observed_cold
    ) addFailure(`observed_cold_budget_exceeded:${definition.id}`);
    const connectorBudget = definition.profile === "web" ? PERFORMANCE_BUDGETS_MS.home : PERFORMANCE_BUDGETS_MS.connector_read;
    if (summary.p95_ms !== null && summary.p95_ms > connectorBudget) addFailure(`connector_p95_budget_exceeded:${definition.id}`);

    let correlated = [];
    if (block !== null && sampleWindows.length === warmMinimum + 1) {
      for (const [sampleIndex, sampleWindow] of sampleWindows.entries()) {
        const window = durationWindow(sampleWindow.started_at, sampleWindow.completed_at);
        if (window === null) continue;
        const matches = [...groups.entries()].filter(([requestId, group]) => {
          const observed = groupWindow(group);
          return requestId === sampleWindow.request_id &&
            group.every((event) =>
              event.benchmarkCorrelationId === sampleWindow.benchmark_correlation_id) &&
            observed.started >= window.started + clock.lower_ms && observed.completed <= window.completed + clock.upper_ms &&
            matchingGroup(group, definition.profile, definition.operation);
        });
        if (matches.length !== 1) {
          addFailure(`telemetry_sample_correlation_mismatch:${definition.id}:${sampleIndex}`);
        }
        if (matches.length === 1) correlated.push(matches[0]);
      }
    }
    const expectedCorrelations = Number.isSafeInteger(warmMinimum) ? warmMinimum + 1 : 21;
    if (correlated.length !== expectedCorrelations) addFailure(`telemetry_correlation_count_mismatch:${definition.id}`);
    for (const [requestId, group] of correlated) {
      if (assignedGroups.has(requestId)) addFailure(`telemetry_request_reused:${definition.id}`);
      assignedGroups.add(requestId);
      if (group.some(({ outcome }) => outcome !== "success")) addFailure(`telemetry_request_failed:${definition.id}`);
    }
    if (correlated.length > 0 && groupTime(correlated[0][1]) > coldCompleted + clock.upper_ms) {
      addFailure(`telemetry_cold_request_mismatch:${definition.id}`);
    }
    if (definition.profile !== "web") {
      const samples = [];
      for (const [, group] of correlated.slice(1)) {
        const operationEvents = group.filter((event) =>
          event.surface === "mcp" && event.operation === definition.operation && event.metric === "request_latency_ms");
        if (operationEvents.length !== 1) {
          addFailure(`server_operation_telemetry_ambiguous:${definition.id}`);
          continue;
        }
        samples.push(operationEvents[0].value);
      }
      const key = `${definition.profile}:${definition.operation}`;
      serverWarm.set(key, [...(serverWarm.get(key) ?? []), ...samples]);
    }
    connector.push(Object.freeze({
      id: definition.id,
      profile: definition.profile,
      fixture_profile_id: definition.fixture_profile_id,
      operation: definition.operation,
      observed_cold_ms: typeof result.observed_cold_ms === "number" ? rounded(result.observed_cold_ms) : null,
      warm: summary,
      telemetry_correlated_requests: correlated.length,
      history_comparison: definition.history_comparison ?? null,
    }));
  }
  if (results.length !== definitions.length) addFailure("unexpected_connector_results");

  const candidatePerformanceGroups = [...groups.entries()].filter(([, group]) => {
    const operations = new Set(group.map(({ operation }) => operation));
    return operations.has("home") || MCP_PROFILES.some((profile) => operations.has(profile));
  });
  for (const [requestId] of candidatePerformanceGroups) {
    if (!assignedGroups.has(requestId)) addFailure("telemetry_unbound_request");
  }

  const server = [];
  for (const profile of MCP_PROFILES) {
    for (const [operation, budget] of Object.entries(PERFORMANCE_BUDGETS_MS.server)) {
      const samples = serverWarm.get(`${profile}:${operation}`) ?? [];
      const summary = summarizeSamples(samples);
      server.push(Object.freeze({ profile, operation, warm: summary }));
      if (samples.length < 20) addFailure(`server_samples_below_20:${profile}:${operation}`);
      if (summary.p95_ms !== null && summary.p95_ms > budget) addFailure(`server_p95_budget_exceeded:${profile}:${operation}`);
    }
  }

  const historyGrowth = [];
  for (const profile of MCP_PROFILES) {
    const profileRows = connector.filter((row) => row.profile === profile && row.history_comparison !== null);
    const groupsForProfile = new Map();
    for (const row of profileRows) {
      const group = row.history_comparison.group;
      groupsForProfile.set(group, [...(groupsForProfile.get(group) ?? []), row]);
    }
    if (groupsForProfile.size === 0) addFailure(`history_comparison_missing:${profile}`);
    for (const [group, rows] of groupsForProfile) {
      const baselineRows = rows.filter(({ history_comparison }) => history_comparison.scale === 1);
      const scaledRows = rows.filter(({ history_comparison }) => history_comparison.scale === 10);
      if (baselineRows.length !== 1 || scaledRows.length !== 1) {
        addFailure(`history_1x_10x_comparison_invalid:${profile}:${group}`);
        continue;
      }
      const baseline = baselineRows[0].warm.p95_ms;
      const scaled = scaledRows[0].warm.p95_ms;
      const ratio = baseline === 0 ? (scaled === 0 ? 1 : Number.POSITIVE_INFINITY) : scaled / baseline;
      historyGrowth.push(Object.freeze({
        profile,
        group,
        baseline_id: baselineRows[0].id,
        scaled_id: scaledRows[0].id,
        baseline_p95_ms: baseline,
        scaled_p95_ms: scaled,
        ratio: Number.isFinite(ratio) ? rounded(ratio) : null,
        budget_ratio: PERFORMANCE_BUDGETS_MS.history_growth_ratio,
      }));
      if (!Number.isFinite(ratio) || ratio > PERFORMANCE_BUDGETS_MS.history_growth_ratio) {
        addFailure(`history_point_read_growth_exceeded:${profile}:${group}`);
      }
    }
  }

  const startedAt = input.started_at ?? null;
  const completedAt = input.completed_at ?? null;
  const durationMs = runWindow === null ? null : runWindow.completed - runWindow.started;
  const unsigned = Object.freeze({
    schema: input.clock_calibration ? "mind-diary/performance-gate/v4" : PERFORMANCE_GATE_SCHEMA,
    ...(input.clock_calibration ? { clock_calibration_sha256: clock.artifact_sha256 ?? null } : {}),
    status: failures.length === 0 ? "passed" : "failed",
    candidate_sha: input.candidate_sha ?? null,
    deployment: profileReadback.deployment ?? null,
    environment: input.environment ?? null,
    target_url: input.target_url ?? null,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs,
    warm_samples: warmMinimum,
    budgets_ms: PERFORMANCE_BUDGETS_MS,
    profile_readback_sha256: profileReadback.artifact_sha256 ?? null,
    profile_matrix: Object.freeze(receiptProfiles.map((item) => Object.freeze({
      id: item.id,
      kind: item.kind,
      fixture_fingerprint: item.fixture_fingerprint,
      observed: Object.freeze({ ...item.observed }),
    }))),
    connector: Object.freeze(connector),
    server: Object.freeze(server),
    history_growth: Object.freeze(historyGrowth),
    telemetry_capture_sha256: telemetryCapture?.artifact_sha256 ?? null,
    telemetry: Object.freeze({
      events: safeTelemetry.length,
      correlated_requests: assignedGroups.size,
      started_at: startedAt,
      completed_at: completedAt,
    }),
    failures: Object.freeze(failures),
  });
  return createReport(unsigned);
}

export function verifyPerformanceGateArtifact(value) {
  const calibrated = value.schema === "mind-diary/performance-gate/v4";
  assertExactKeys(value, new Set([...REPORT_KEYS, ...(calibrated ? ["clock_calibration_sha256"] : [])]), "invalid_performance_report");
  if (calibrated && !SHA256.test(value.clock_calibration_sha256 ?? "")) reject("invalid_clock_calibration_hash");
  if (
    (!calibrated && value.schema !== PERFORMANCE_GATE_SCHEMA) || typeof value.artifact_sha256 !== "string" ||
    !SHA256.test(value.artifact_sha256)
  ) reject("invalid_performance_report");
  const { artifact_sha256: artifact, ...unsigned } = value;
  if (artifact !== digest(canonical(unsigned))) reject("invalid_performance_report_hash");
  return Object.freeze(value);
}
