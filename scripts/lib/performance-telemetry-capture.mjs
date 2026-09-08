import { createHash } from "node:crypto";

export const PERFORMANCE_TELEMETRY_CAPTURE_SCHEMA =
  "mind-diary/performance-telemetry-capture/v1";
export const PERFORMANCE_TELEMETRY_CAPTURE_GENERATOR =
  "mind-diary/sites-control-plane-telemetry-join/v1";

const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const TOP_LEVEL_KEYS = new Set([
  "schema",
  "status",
  "candidate_sha",
  "environment",
  "target_url",
  "deployment",
  "started_at",
  "completed_at",
  "generator",
  "control_plane_query_id",
  "telemetry_jsonl_sha256",
  "event_count",
  "artifact_sha256",
]);
const DEPLOYMENT_KEYS = new Set([
  "site_project_id",
  "site_version_id",
  "deployment_id",
  "archive_sha256",
]);

export class PerformanceTelemetryCaptureError extends TypeError {
  constructor(code) {
    super(`performance telemetry capture rejected: ${code}`);
    this.name = "PerformanceTelemetryCaptureError";
    this.code = code;
  }
}

function fail(code) {
  throw new PerformanceTelemetryCaptureError(code);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value, keys, code) {
  if (!isRecord(value)) fail(code);
  const actual = Object.keys(value);
  if (actual.length !== keys.size || actual.some((key) => !keys.has(key))) fail(code);
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

function exactUtc(value, code) {
  if (
    typeof value !== "string" || !UTC.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value
  ) fail(code);
  return value;
}

function exactTargetUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("invalid_target_url");
  }
  if (
    parsed.protocol !== "https:" || parsed.username || parsed.password ||
    parsed.search || parsed.hash || parsed.pathname !== "/"
  ) fail("invalid_target_url");
  return parsed.toString().replace(/\/$/u, "");
}

function exactDeployment(value) {
  assertExactKeys(value, DEPLOYMENT_KEYS, "invalid_deployment");
  if (
    typeof value.site_project_id !== "string" || !/^appgprj_[a-z0-9]+$/u.test(value.site_project_id) ||
    typeof value.site_version_id !== "string" || !/^(?:appgver_[a-z0-9]+|appgprj_[a-z0-9]+~appgver_[a-z0-9]+)$/u.test(value.site_version_id) ||
    typeof value.deployment_id !== "string" || !/^appgdep_[a-z0-9]+$/u.test(value.deployment_id) ||
    typeof value.archive_sha256 !== "string" || !SHA256.test(value.archive_sha256)
  ) fail("invalid_deployment");
  return Object.freeze({ ...value });
}

function telemetryProjection(text) {
  if (typeof text !== "string") fail("invalid_telemetry_jsonl");
  const eventCount = text.split(/\r?\n/u).filter((line) => line.trim().length > 0).length;
  if (eventCount === 0) fail("empty_telemetry_jsonl");
  return Object.freeze({
    telemetry_jsonl_sha256: digest(text),
    event_count: eventCount,
  });
}

function unsignedReceipt(input, projection) {
  if (input.status !== "passed") fail("capture_not_passed");
  if (typeof input.candidate_sha !== "string" || !SHA.test(input.candidate_sha)) {
    fail("invalid_candidate_sha");
  }
  if (input.environment !== "uat") fail("environment_not_uat");
  if (
    input.generator !== PERFORMANCE_TELEMETRY_CAPTURE_GENERATOR ||
    typeof input.control_plane_query_id !== "string" ||
    !/^request_[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(input.control_plane_query_id)
  ) fail("invalid_control_plane_capture");
  const startedAt = exactUtc(input.started_at, "invalid_started_at");
  const completedAt = exactUtc(input.completed_at, "invalid_completed_at");
  if (Date.parse(completedAt) < Date.parse(startedAt)) fail("invalid_capture_window");
  if (
    typeof projection.telemetry_jsonl_sha256 !== "string" ||
    !SHA256.test(projection.telemetry_jsonl_sha256) ||
    !Number.isSafeInteger(projection.event_count) || projection.event_count <= 0
  ) fail("invalid_telemetry_projection");
  return Object.freeze({
    schema: PERFORMANCE_TELEMETRY_CAPTURE_SCHEMA,
    status: "passed",
    candidate_sha: input.candidate_sha,
    environment: "uat",
    target_url: exactTargetUrl(input.target_url),
    deployment: exactDeployment(input.deployment),
    started_at: startedAt,
    completed_at: completedAt,
    generator: PERFORMANCE_TELEMETRY_CAPTURE_GENERATOR,
    control_plane_query_id: input.control_plane_query_id,
    telemetry_jsonl_sha256: projection.telemetry_jsonl_sha256,
    event_count: projection.event_count,
  });
}

export function createPerformanceTelemetryCaptureReceipt(input, telemetryJsonl) {
  const unsigned = unsignedReceipt(input, telemetryProjection(telemetryJsonl));
  return Object.freeze({
    ...unsigned,
    artifact_sha256: digest(canonical(unsigned)),
  });
}

export function verifyPerformanceTelemetryCaptureReceipt(value, telemetryJsonl) {
  if (value?.schema === "mind-diary/performance-telemetry-capture/v3") return verifySitesD1PerformanceCapture(value, telemetryJsonl);
  if (value?.schema === "mind-diary/performance-telemetry-capture/v2") return verifySitesLogPerformanceCapture(value, telemetryJsonl);
  assertExactKeys(value, TOP_LEVEL_KEYS, "invalid_capture_receipt");
  if (typeof value.artifact_sha256 !== "string" || !SHA256.test(value.artifact_sha256)) {
    fail("invalid_capture_hash");
  }
  const projection = telemetryJsonl === undefined
    ? Object.freeze({
        telemetry_jsonl_sha256: value.telemetry_jsonl_sha256,
        event_count: value.event_count,
      })
    : telemetryProjection(telemetryJsonl);
  const unsigned = unsignedReceipt(value, projection);
  const recreated = Object.freeze({
    ...unsigned,
    artifact_sha256: digest(canonical(unsigned)),
  });
  if (
    value.schema !== PERFORMANCE_TELEMETRY_CAPTURE_SCHEMA ||
    canonical(value) !== canonical(recreated)
  ) fail("invalid_capture_receipt");
  return recreated;
}

// Sites exposes a log-result envelope, not a control-plane request id. V2
// records the actual envelope digest and provider event/version identifiers;
// it never invents a request_* id. Expected source digests are anchored by the
// caller's private control-plane journal, independently of this receipt.
const SITES_LOG_CAPTURE_SCHEMA = "mind-diary/performance-telemetry-capture/v2";
const SITES_LOG_CAPTURE_GENERATOR = "mind-diary/sites-log-envelope-capture/v2";
function sitesCaptureUnsigned(value, projection) {
  const source = value.control_plane_source;
  const batched = source.result_kind === "sites-log-envelope-batch";
  assertExactKeys(source, new Set(["tool", "project_id", "result_sha256", "provider_script", "provider_version_ids", "event_ids", ...(batched ? ["result_kind", "envelope_sha256s"] : [])]), "invalid_sites_log_source");
  if (batched && (!Array.isArray(source.envelope_sha256s) || source.envelope_sha256s.length < 1 || source.envelope_sha256s.some(hash => !SHA256.test(hash)))) fail("invalid_sites_log_batch");
  if (source.tool !== "sites_get_site_worker_logs" || source.project_id !== value.deployment?.site_project_id ||
    typeof source.result_sha256 !== "string" || !SHA256.test(source.result_sha256) || typeof source.provider_script !== "string" || !source.provider_script ||
    !Array.isArray(source.event_ids) || source.event_ids.length < 1 || new Set(source.event_ids).size !== source.event_ids.length ||
    source.event_ids.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) ||
    !Array.isArray(source.provider_version_ids) || source.provider_version_ids.length !== 1 || typeof source.provider_version_ids[0] !== "string") fail("invalid_sites_log_source");
  if (value.status !== "passed" || !SHA.test(value.candidate_sha ?? "") || value.environment !== "uat" || value.generator !== SITES_LOG_CAPTURE_GENERATOR) fail("invalid_sites_log_capture");
  const startedAt = exactUtc(value.started_at, "invalid_started_at"), completedAt = exactUtc(value.completed_at, "invalid_completed_at");
  if (Date.parse(completedAt) < Date.parse(startedAt)) fail("invalid_capture_window");
  return { schema: SITES_LOG_CAPTURE_SCHEMA, status: "passed", candidate_sha: value.candidate_sha, environment: "uat", target_url: exactTargetUrl(value.target_url),
    deployment: exactDeployment(value.deployment), started_at: startedAt, completed_at: completedAt, generator: SITES_LOG_CAPTURE_GENERATOR,
    control_plane_source: source, ...projection };
}
export function createSitesLogPerformanceCapture(input, result, correlationIds) {
  const envelopes = Array.isArray(result) ? result : [result];
  if (!envelopes.length || envelopes.some(value => value?.project_id !== input.deployment?.site_project_id || !Array.isArray(value.events))) fail("wrong_sites_log_project");
  const selected = envelopes.flatMap(value => value.events).filter(event => correlationIds.includes(event.source?.benchmarkCorrelationId));
  if (!selected.length) fail("signed_provider_telemetry_missing");
  const ids = new Set(), versions = new Set(), telemetry = [], eventDigests = new Map();
  for (const event of selected) {
    const source = event.source, workers = event.$workers;
    if (source.event !== "mind-diary.privacy-safe-observability" || source.schema !== "mind-diary/privacy-safe-observability/v2" ||
      workers?.scriptName !== input.provider_script || workers.truncated === true || !event.$metadata?.id || !workers.scriptVersion?.id) fail("invalid_provider_event");
    const eventDigest = digest(canonical({ source, workers }));
    if (ids.has(event.$metadata.id)) {
      if (eventDigests.get(event.$metadata.id) !== eventDigest) fail("conflicting_provider_event");
      continue;
    }
    eventDigests.set(event.$metadata.id, eventDigest);
    ids.add(event.$metadata.id); versions.add(workers.scriptVersion.id);
    telemetry.push({ event: "mind-diary.performance-gate-telemetry", schema: "mind-diary/performance-gate-telemetry/v1",
      kind: source.kind, metric: source.metric, surface: source.surface, operation: source.operation, outcome: source.outcome, unit: source.unit,
      value: source.value, occurredAtUtc: source.occurredAtUtc, requestId: source.requestId ?? null, jobId: source.jobId ?? null, cohort: source.cohort ?? null,
      lineage: { candidateSha: input.candidate_sha, siteVersionId: input.deployment.site_version_id, deploymentId: input.deployment.deployment_id },
      benchmarkCorrelationId: source.benchmarkCorrelationId });
  }
  const text = telemetry.map(event => JSON.stringify(event)).join("\n") + "\n";
  const unsigned = sitesCaptureUnsigned({ ...input, status: "passed", generator: SITES_LOG_CAPTURE_GENERATOR, control_plane_source: {
    tool: "sites_get_site_worker_logs", project_id: envelopes[0].project_id, result_sha256: digest(canonical(result)), provider_script: input.provider_script,
    ...(Array.isArray(result) ? { result_kind: "sites-log-envelope-batch", envelope_sha256s: envelopes.map(value => digest(canonical(value))) } : {}),
    provider_version_ids: [...versions].sort(), event_ids: [...ids].sort(),
  } }, telemetryProjection(text));
  return { telemetry, telemetryJsonl: text, receipt: { ...unsigned, artifact_sha256: digest(canonical(unsigned)) } };
}
function verifySitesLogPerformanceCapture(value, text) {
  const projection = text === undefined ? { telemetry_jsonl_sha256: value.telemetry_jsonl_sha256, event_count: value.event_count } : telemetryProjection(text);
  if (!SHA256.test(projection.telemetry_jsonl_sha256 ?? "") || !Number.isSafeInteger(projection.event_count) || projection.event_count < 1) fail("invalid_telemetry_projection");
  const unsigned = sitesCaptureUnsigned(value, projection), recreated = { ...unsigned, artifact_sha256: digest(canonical(unsigned)) };
  if (canonical(value) !== canonical(recreated)) fail("invalid_capture_receipt");
  return recreated;
}

const D1_SCHEMA = "mind-diary/performance-telemetry-capture/v3";
const D1_GENERATOR = "mind-diary/sites-d1-telemetry-capture/v1";
function d1CaptureUnsigned(value, projection) {
  const source = value.control_plane_source;
  assertExactKeys(source, new Set(["tool", "project_id", "binding_name", "table_name", "run_id", "test_adapter_sha256", "result_sha256", "page_sha256s", "row_ids"]), "invalid_sites_d1_source");
  if (source.tool !== "sites_read_database_table_rows" || source.project_id !== value.deployment?.site_project_id || source.binding_name !== "DB"
    || source.table_name !== "md_acceptance_telemetry" || !/^[a-f0-9-]{36}$/.test(source.run_id ?? "") || !/^[a-f0-9]{64}$/.test(source.test_adapter_sha256 ?? "")
    || !SHA256.test(source.result_sha256 ?? "") || !Array.isArray(source.page_sha256s) || !source.page_sha256s.length || source.page_sha256s.length > 256
    || source.page_sha256s.some(hash => !SHA256.test(hash)) || !Array.isArray(source.row_ids) || !source.row_ids.length || source.row_ids.length > 4096
    || new Set(source.row_ids).size !== source.row_ids.length || source.row_ids.length !== projection.event_count
    || source.row_ids.some(id => !/^[a-z0-9_:-]{1,128}$/.test(id))) fail("invalid_sites_d1_source");
  if (value.status !== "passed" || !SHA.test(value.candidate_sha ?? "") || value.environment !== "uat" || value.generator !== D1_GENERATOR) fail("invalid_sites_d1_capture");
  const startedAt = exactUtc(value.started_at, "invalid_started_at"), completedAt = exactUtc(value.completed_at, "invalid_completed_at");
  if (Date.parse(completedAt) < Date.parse(startedAt)) fail("invalid_capture_window");
  return { schema: D1_SCHEMA, status: "passed", candidate_sha: value.candidate_sha, environment: "uat", target_url: exactTargetUrl(value.target_url),
    deployment: exactDeployment(value.deployment), started_at: startedAt, completed_at: completedAt, generator: D1_GENERATOR,
    control_plane_source: source, ...projection };
}
export function createSitesD1PerformanceCapture(input, pages, correlationIds) {
  if (!Array.isArray(pages) || !pages.length || pages.length > 256) fail("invalid_sites_d1_pages");
  const rowIds = new Set(), telemetry = [], selected = new Set(correlationIds); let offset = 0;
  for (const [pageIndex, page] of pages.entries()) {
    const projection = page.model_projection;
    if (page.project_id !== input.deployment?.site_project_id || page.binding_name !== "DB" || page.table_name !== "md_acceptance_telemetry"
      || page.offset !== offset || !Array.isArray(page.rows) || page.rows.length < 1 || page.rows.length > 25 || !projection
      || projection.truncated !== false || projection.truncated_values !== 0 || projection.omitted_columns !== 0 || projection.omitted_rows !== 0) fail("invalid_sites_d1_page");
    offset += page.rows.length;
    const more = pageIndex < pages.length - 1;
    if (page.has_more !== more || projection.next_offset !== (more ? offset : null)) fail("incomplete_sites_d1_pages");
    for (const row of page.rows) {
      if (row.run_id !== input.run_id || row.candidate_sha !== input.candidate_sha || row.adapter_sha256 !== input.test_adapter_sha256
        || !selected.has(row.correlation_id) || !Number.isSafeInteger(row.event_index) || row.event_index < 0 || row.event_index >= 16) fail("foreign_sites_d1_row");
      const parts = [0, 1, 2, 3].map(index => row[`event_json_${index}`]);
      if (parts.some(part => typeof part !== "string" || part.length > 240)) fail("invalid_sites_d1_event");
      const source = JSON.parse(parts.join("")), rowId = `${row.run_id}:${row.correlation_id}:${row.event_index}`;
      if (rowIds.has(rowId)) fail("duplicate_sites_d1_row");
      rowIds.add(rowId);
      if (source.event !== "mind-diary.privacy-safe-observability" || source.schema !== "mind-diary/privacy-safe-observability/v2"
        || source.benchmarkCorrelationId !== row.correlation_id || source.metric !== "request_latency_ms") fail("invalid_sites_d1_event");
      telemetry.push({ event: "mind-diary.performance-gate-telemetry", schema: "mind-diary/performance-gate-telemetry/v1",
        kind: source.kind, metric: source.metric, surface: source.surface, operation: source.operation, outcome: source.outcome, unit: source.unit,
        value: source.value, occurredAtUtc: source.occurredAtUtc, requestId: source.requestId ?? null, jobId: source.jobId ?? null, cohort: source.cohort ?? null,
        lineage: { candidateSha: input.candidate_sha, siteVersionId: input.deployment.site_version_id, deploymentId: input.deployment.deployment_id },
        benchmarkCorrelationId: source.benchmarkCorrelationId });
    }
  }
  const text = telemetry.map(event => JSON.stringify(event)).join("\n") + "\n";
  const unsigned = d1CaptureUnsigned({ ...input, status: "passed", generator: D1_GENERATOR, control_plane_source: {
    tool: "sites_read_database_table_rows", project_id: input.deployment.site_project_id, binding_name: "DB", table_name: "md_acceptance_telemetry",
    run_id: input.run_id, test_adapter_sha256: input.test_adapter_sha256, result_sha256: digest(canonical(pages)),
    page_sha256s: pages.map(page => digest(canonical(page))), row_ids: [...rowIds].sort(),
  } }, telemetryProjection(text));
  return { telemetry, telemetryJsonl: text, receipt: { ...unsigned, artifact_sha256: digest(canonical(unsigned)) } };
}
function verifySitesD1PerformanceCapture(value, text) {
  const projection = text === undefined ? { telemetry_jsonl_sha256: value.telemetry_jsonl_sha256, event_count: value.event_count } : telemetryProjection(text);
  if (!SHA256.test(projection.telemetry_jsonl_sha256 ?? "") || !Number.isSafeInteger(projection.event_count) || projection.event_count < 1) fail("invalid_telemetry_projection");
  const unsigned = d1CaptureUnsigned(value, projection), recreated = { ...unsigned, artifact_sha256: digest(canonical(unsigned)) };
  if (canonical(value) !== canonical(recreated)) fail("invalid_capture_receipt");
  return recreated;
}
