import { createHash, createHmac } from "node:crypto";

export const PERFORMANCE_PROFILE_READBACK_SCHEMA =
  "mind-diary/performance-profile-readback/v2";
export const PERFORMANCE_PROFILE_READBACK_GENERATOR =
  "mind-diary/uat-profile-provision-readback/v2";

export const REQUIRED_STARTER_SMALL = Object.freeze({
  minds: 2,
  revisions: 1,
  files_min: 1,
  files_max: 16,
  bytes_min: 1,
  bytes_max: 1_048_576,
});
export const REQUIRED_SMALL_HISTORY_REVISION_COUNTS = Object.freeze([1, 10]);

const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const HMAC_SHA256 = /^hmac-sha256:[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z][a-z0-9._:-]{0,119}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
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
  "profiles",
  "artifact_sha256",
]);
const DEPLOYMENT_KEYS = new Set([
  "site_project_id",
  "site_version_id",
  "deployment_id",
  "archive_sha256",
]);
const PROFILE_KEYS = new Set([
  "id",
  "kind",
  "fixture_fingerprint",
  "credential_binding",
  "request_bindings",
  "provisioning_request_id",
  "readback_request_id",
  "expected",
  "observed",
]);
const CREDENTIAL_BINDING_KEYS = new Set(["scheme", "digest"]);
const REQUEST_BINDING_KEYS = new Set(["operation", "arguments_sha256"]);
const COUNT_KEYS = new Set(["minds", "revisions", "files", "bytes"]);
const PROFILE_KINDS = new Set([
  "starter_small",
  "small_history",
]);
const REQUIRED_PROFILE_OPERATIONS = Object.freeze({
  starter_small: Object.freeze([
    "list_minds",
    "browse_entries",
    "search",
    "fetch",
  ]),
  small_history: Object.freeze(["get_revision"]),
});

export class PerformanceProfileReadbackError extends TypeError {
  constructor(code) {
    super(`performance profile readback rejected: ${code}`);
    this.name = "PerformanceProfileReadbackError";
    this.code = code;
  }
}

function fail(code) {
  throw new PerformanceProfileReadbackError(code);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value, keys, code) {
  if (!isRecord(value)) fail(code);
  const actual = Object.keys(value);
  if (actual.length !== keys.size || actual.some((key) => !keys.has(key))) {
    fail(code);
  }
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

export function performanceRequestArgumentsDigest(value) {
  if (!isRecord(value)) fail("invalid_request_arguments");
  return digest(canonical(value));
}

export function createPerformanceCredentialBinding({ key, profileId, credential }) {
  if (
    (typeof key !== "string" && !ArrayBuffer.isView(key)) ||
    Buffer.byteLength(key) < 32 ||
    typeof profileId !== "string" ||
    !SAFE_ID.test(profileId) ||
    typeof credential !== "string" ||
    credential.length === 0
  ) fail("invalid_credential_binding_input");
  const hmac = createHmac("sha256", key);
  hmac.update("mind-diary/performance-profile-credential/v1\0", "utf8");
  hmac.update(profileId, "utf8");
  hmac.update("\0", "utf8");
  hmac.update(credential, "utf8");
  return `hmac-sha256:${hmac.digest("hex")}`;
}

function exactUtc(value, code) {
  if (
    typeof value !== "string" ||
    !UTC.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
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
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) fail("invalid_target_url");
  return parsed.toString().replace(/\/$/u, "");
}

function deployment(value) {
  assertExactKeys(value, DEPLOYMENT_KEYS, "invalid_deployment");
  if (
    typeof value.site_project_id !== "string" ||
    !/^appgprj_[a-z0-9]+$/u.test(value.site_project_id) ||
    typeof value.site_version_id !== "string" ||
    !/^appgver_[a-z0-9]+$/u.test(value.site_version_id) ||
    typeof value.deployment_id !== "string" ||
    !/^appgdep_[a-z0-9]+$/u.test(value.deployment_id) ||
    typeof value.archive_sha256 !== "string" ||
    !SHA256.test(value.archive_sha256)
  ) fail("invalid_deployment");
  return Object.freeze({ ...value });
}

function counts(value, code) {
  assertExactKeys(value, COUNT_KEYS, code);
  const result = {};
  for (const key of COUNT_KEYS) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) fail(code);
    result[key] = value[key];
  }
  return Object.freeze(result);
}

function credentialBinding(value) {
  assertExactKeys(value, CREDENTIAL_BINDING_KEYS, "invalid_credential_binding");
  if (
    value.scheme !== "hmac-sha256-v1" ||
    typeof value.digest !== "string" ||
    !HMAC_SHA256.test(value.digest)
  ) fail("invalid_credential_binding");
  return Object.freeze({ scheme: "hmac-sha256-v1", digest: value.digest });
}

function requestBindings(value, kind) {
  if (!Array.isArray(value) || value.length === 0) fail("invalid_request_bindings");
  const bindings = Object.freeze(value.map((item) => {
    assertExactKeys(item, REQUEST_BINDING_KEYS, "invalid_request_binding");
    if (
      typeof item.operation !== "string" ||
      !REQUIRED_PROFILE_OPERATIONS[kind]?.includes(item.operation) ||
      typeof item.arguments_sha256 !== "string" ||
      !SHA256.test(item.arguments_sha256)
    ) fail("invalid_request_binding");
    return Object.freeze({ ...item });
  }));
  const operations = bindings.map(({ operation }) => operation).sort();
  const expected = [...REQUIRED_PROFILE_OPERATIONS[kind]].sort();
  if (
    canonical(operations) !== canonical(expected) ||
    new Set(bindings.map(({ arguments_sha256 }) => arguments_sha256)).size !== bindings.length
  ) fail("profile_request_bindings_incomplete");
  return bindings;
}

function profile(value) {
  assertExactKeys(value, PROFILE_KEYS, "invalid_profile");
  if (
    typeof value.id !== "string" ||
    !SAFE_ID.test(value.id) ||
    !PROFILE_KINDS.has(value.kind) ||
    typeof value.fixture_fingerprint !== "string" ||
    !SHA256.test(value.fixture_fingerprint) ||
    typeof value.provisioning_request_id !== "string" ||
    !SAFE_ID.test(value.provisioning_request_id) ||
    typeof value.readback_request_id !== "string" ||
    !SAFE_ID.test(value.readback_request_id) ||
    value.provisioning_request_id === value.readback_request_id
  ) fail("invalid_profile");
  const verifiedCredentialBinding = credentialBinding(value.credential_binding);
  const verifiedRequestBindings = requestBindings(value.request_bindings, value.kind);
  const expected = counts(value.expected, "invalid_expected_counts");
  const observed = counts(value.observed, "invalid_observed_counts");
  if (canonical(expected) !== canonical(observed)) fail("profile_readback_mismatch");
  return Object.freeze({
    id: value.id,
    kind: value.kind,
    fixture_fingerprint: value.fixture_fingerprint,
    credential_binding: verifiedCredentialBinding,
    request_bindings: verifiedRequestBindings,
    provisioning_request_id: value.provisioning_request_id,
    readback_request_id: value.readback_request_id,
    expected,
    observed,
  });
}

function assertRequiredMatrix(profiles) {
  if (profiles.length !== 3) fail("unexpected_profile_matrix");
  const starter = profiles.filter(({ kind }) => kind === "starter_small");
  if (starter.length !== 1) fail("starter_small_profile_incomplete");
  const starterObserved = starter[0].observed;
  if (
    starterObserved.minds !== REQUIRED_STARTER_SMALL.minds ||
    starterObserved.revisions !== REQUIRED_STARTER_SMALL.revisions ||
    starterObserved.files < REQUIRED_STARTER_SMALL.files_min ||
    starterObserved.files > REQUIRED_STARTER_SMALL.files_max ||
    starterObserved.bytes < REQUIRED_STARTER_SMALL.bytes_min ||
    starterObserved.bytes > REQUIRED_STARTER_SMALL.bytes_max
  ) fail("starter_small_profile_incomplete");

  const history = profiles.filter(({ kind }) => kind === "small_history");
  const revisionCounts = history
    .map(({ observed }) => observed.revisions)
    .sort((left, right) => left - right);
  const historyOne = history.find(({ observed }) => observed.revisions === 1);
  const historyTen = history.find(({ observed }) => observed.revisions === 10);
  if (
    history.length !== REQUIRED_SMALL_HISTORY_REVISION_COUNTS.length ||
    canonical(revisionCounts) !== canonical(REQUIRED_SMALL_HISTORY_REVISION_COUNTS) ||
    history.some(({ observed }) =>
      observed.minds !== REQUIRED_STARTER_SMALL.minds ||
      observed.files < REQUIRED_STARTER_SMALL.files_min ||
      observed.files > REQUIRED_STARTER_SMALL.files_max ||
      observed.bytes < REQUIRED_STARTER_SMALL.bytes_min ||
      observed.bytes > REQUIRED_STARTER_SMALL.bytes_max)
  ) fail("small_history_profile_incomplete");
  if (
    historyOne?.fixture_fingerprint !== starter[0].fixture_fingerprint ||
    canonical(historyOne?.observed) !== canonical(starterObserved) ||
    historyTen?.fixture_fingerprint === starter[0].fixture_fingerprint
  ) fail("small_history_fixture_topology_invalid");
}

function unsignedReceipt(input) {
  if (input.status !== "passed") fail("profile_readback_not_passed");
  if (typeof input.candidate_sha !== "string" || !SHA.test(input.candidate_sha)) {
    fail("invalid_candidate_sha");
  }
  if (input.environment !== "uat") fail("environment_not_uat");
  if (input.generator !== PERFORMANCE_PROFILE_READBACK_GENERATOR) {
    fail("invalid_generator");
  }
  const startedAt = exactUtc(input.started_at, "invalid_started_at");
  const completedAt = exactUtc(input.completed_at, "invalid_completed_at");
  if (Date.parse(completedAt) < Date.parse(startedAt)) fail("invalid_readback_window");
  if (!Array.isArray(input.profiles)) fail("invalid_profiles");
  const profiles = Object.freeze(input.profiles.map(profile));
  if (new Set(profiles.map(({ id }) => id)).size !== profiles.length) {
    fail("duplicate_profile_id");
  }
  const correlationIds = profiles.flatMap((item) => [
    item.provisioning_request_id,
    item.readback_request_id,
  ]);
  if (new Set(correlationIds).size !== correlationIds.length) {
    fail("duplicate_profile_correlation");
  }
  assertRequiredMatrix(profiles);
  return Object.freeze({
    schema: PERFORMANCE_PROFILE_READBACK_SCHEMA,
    status: "passed",
    candidate_sha: input.candidate_sha,
    environment: "uat",
    target_url: exactTargetUrl(input.target_url),
    deployment: deployment(input.deployment),
    started_at: startedAt,
    completed_at: completedAt,
    generator: PERFORMANCE_PROFILE_READBACK_GENERATOR,
    profiles,
  });
}

export function createPerformanceProfileReadbackReceipt(input) {
  const unsigned = unsignedReceipt(input);
  return Object.freeze({
    ...unsigned,
    artifact_sha256: digest(canonical(unsigned)),
  });
}

export function verifyPerformanceProfileReadbackReceipt(value) {
  assertExactKeys(value, TOP_LEVEL_KEYS, "invalid_receipt");
  if (typeof value.artifact_sha256 !== "string" || !SHA256.test(value.artifact_sha256)) {
    fail("invalid_receipt_hash");
  }
  const recreated = createPerformanceProfileReadbackReceipt(value);
  if (
    value.schema !== PERFORMANCE_PROFILE_READBACK_SCHEMA ||
    value.artifact_sha256 !== recreated.artifact_sha256 ||
    canonical(value) !== canonical(recreated)
  ) fail("invalid_receipt");
  return recreated;
}
