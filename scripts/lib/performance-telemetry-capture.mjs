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
