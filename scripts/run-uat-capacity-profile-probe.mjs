#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  RESTRICTED_UAT_CAPACITY_PROFILE,
  RESTRICTED_UAT_DEFAULT_CAPACITY_PROFILE,
} from "../packages/composition-root/dist/index.js";
import {
  ProbeFailure,
  assertRedactedDocument,
  canonical,
  candidateSha,
  digest,
  fail,
  isRecord,
  required,
  safeCode,
} from "./lib/multi-principal-probe-core.mjs";

export { ProbeFailure, assertRedactedDocument };

const EVIDENCE_SCHEMA = "mind-diary/uat-capacity-profile-evidence/v1";
const SNAPSHOT_SCHEMA = "mind-diary/operator-capacity-diagnostics";
const DEFAULT_BASE_URL = "https://mind-diary.example.invalid";
const TOKEN_ENV = "MIND_DIARY_UAT_OPERATOR_SITES_TOKEN";
const UTILIZATION = new Set(["normal", "warning", "soft_limit", "hard_limit"]);
const SNAPSHOT_KEYS = Object.freeze([
  "headroom",
  "observed_at",
  "profile",
  "quota_rejects",
  "release_fence",
  "reservations",
  "schema",
  "storage_amplification",
  "usage",
  "utilization",
  "version",
]);
const USAGE_KEYS = Object.freeze([
  "d1_metadata_bytes",
  "logical_head_bytes",
  "logical_retained_bytes",
  "physical_canonical_bytes",
  "reconciled_at",
  "reserved_bytes",
  "temporary_bytes",
  "trustworthy",
]);
const HEADROOM_KEYS = Object.freeze([
  "canonical_bytes",
  "d1_metadata_bytes",
  "temporary_bytes",
]);
const RELEASE_FENCE_KEYS = Object.freeze(["schema", "sha256", "version"]);
const RESERVATION_KEYS = Object.freeze([
  "active_bytes",
  "active_count",
  "cleanup_pending_bytes",
  "cleanup_pending_count",
  "expired_active_bytes",
  "expired_active_count",
  "stale_bytes",
  "stale_count",
]);
const PROFILES = Object.freeze({
  "default-v1": RESTRICTED_UAT_DEFAULT_CAPACITY_PROFILE,
  "restricted-uat-v1": RESTRICTED_UAT_CAPACITY_PROFILE,
});

export const CAPACITY_PROFILE_ASSERTION_IDS = Object.freeze([
  "profile.exact_selected_v1",
  "lineage.runtime_configuration_fence",
  "profile.limit_schema_exact",
  "diagnostics.closed_schema",
  "diagnostics.usage_headroom_amplification",
  "diagnostics.quota_reject_and_stale_reservations",
  "diagnostics.query_override_rejected",
  "evidence.redacted",
]);

function configurationFenceNonce(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{22,64}$/u.test(value)) {
    fail("invalid_configuration_fence_nonce");
  }
  return value;
}

function baseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("invalid_base_url");
  }
  if (
    parsed.protocol !== "https:" || parsed.username || parsed.password ||
    parsed.search || parsed.hash
  ) fail("invalid_base_url");
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  return parsed.toString().replace(/\/$/u, "");
}

function exactKeys(value, expected, code) {
  if (!isRecord(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) fail(code);
  return value;
}

function safeCount(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function safeRatio(value, code) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(code);
  return value;
}

function snakeKey(key) {
  return key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

function expectedLimits(profileId) {
  const selected = PROFILES[profileId];
  if (selected === undefined) fail("invalid_expected_profile");
  return Object.freeze(Object.fromEntries(
    Object.entries(selected.limits)
      .map(([key, value]) => [snakeKey(key), value]),
  ));
}

function releaseConfigurationFenceSha256(candidate, fenceNonce) {
  return `sha256:${createHash("sha256")
    .update(
      `mind-diary/uat-release-configuration-fence/v1\0${candidate}\0${fenceNonce}`,
      "utf8",
    )
    .digest("hex")}`;
}

function observedAt(value) {
  if (
    typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) fail("invalid_observed_at");
  return value;
}

export function validateCapacitySnapshot(value, expectedProfileId) {
  const snapshot = exactKeys(value, SNAPSHOT_KEYS, "invalid_capacity_snapshot_schema");
  if (snapshot.schema !== SNAPSHOT_SCHEMA || snapshot.version !== 1) {
    fail("invalid_capacity_snapshot_version");
  }
  const profile = exactKeys(snapshot.profile, [
    "deployment_posture",
    "limits",
    "profile_id",
    "schema",
    "version",
  ], "invalid_capacity_profile_schema");
  if (
    profile.schema !== "mind-diary/capacity-profile" ||
    profile.version !== 1 ||
    !Object.hasOwn(PROFILES, profile.profile_id) ||
    profile.deployment_posture !== "restricted-uat"
  ) fail("invalid_capacity_profile");
  if (expectedProfileId !== undefined && profile.profile_id !== expectedProfileId) {
    fail("unexpected_capacity_profile");
  }
  const limits = exactKeys(
    profile.limits,
    Object.keys(expectedLimits(profile.profile_id)),
    "invalid_capacity_limit_schema",
  );
  if (canonical(limits) !== canonical(expectedLimits(profile.profile_id))) {
    fail("capacity_limit_mismatch");
  }
  const releaseFence = exactKeys(
    snapshot.release_fence,
    RELEASE_FENCE_KEYS,
    "invalid_release_fence_schema",
  );
  if (
    releaseFence.schema !== "mind-diary/uat-release-configuration-fence" ||
    releaseFence.version !== 1 ||
    typeof releaseFence.sha256 !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(releaseFence.sha256)
  ) fail("invalid_release_fence");
  const usage = exactKeys(snapshot.usage, USAGE_KEYS, "invalid_capacity_usage_schema");
  for (const key of USAGE_KEYS.filter((key) => !["trustworthy", "reconciled_at"].includes(key))) {
    safeCount(usage[key], "invalid_capacity_usage");
  }
  if (typeof usage.trustworthy !== "boolean") fail("invalid_capacity_usage");
  if (usage.reconciled_at !== null) observedAt(usage.reconciled_at);
  const headroom = exactKeys(
    snapshot.headroom,
    HEADROOM_KEYS,
    "invalid_capacity_headroom_schema",
  );
  for (const key of HEADROOM_KEYS) safeCount(headroom[key], "invalid_capacity_headroom");
  safeRatio(snapshot.storage_amplification, "invalid_storage_amplification");
  safeCount(snapshot.quota_rejects, "invalid_quota_rejects");
  const reservations = exactKeys(
    snapshot.reservations,
    RESERVATION_KEYS,
    "invalid_capacity_reservation_schema",
  );
  for (const key of RESERVATION_KEYS) {
    safeCount(reservations[key], "invalid_capacity_reservations");
  }
  if (
    reservations.stale_count !==
      reservations.expired_active_count + reservations.cleanup_pending_count ||
    reservations.stale_bytes !==
      reservations.expired_active_bytes + reservations.cleanup_pending_bytes
  ) fail("inconsistent_capacity_reservations");
  if (!UTILIZATION.has(snapshot.utilization)) fail("invalid_capacity_utilization");
  observedAt(snapshot.observed_at);
  return Object.freeze({
    ...snapshot,
    profile: Object.freeze({ ...profile, limits: Object.freeze({ ...limits }) }),
    release_fence: Object.freeze({ ...releaseFence }),
    usage: Object.freeze({ ...usage }),
    headroom: Object.freeze({ ...headroom }),
    reservations: Object.freeze({ ...reservations }),
  });
}

export function createEvidence(input) {
  const snapshot = validateCapacitySnapshot(input.snapshot);
  const candidate = candidateSha(input.candidateSha);
  const fenceNonce = configurationFenceNonce(input.configurationFenceNonce);
  if (
    releaseConfigurationFenceSha256(candidate, fenceNonce) !== snapshot.release_fence.sha256
  ) fail("release_configuration_fence_mismatch");
  const unsigned = Object.freeze({
    schema: EVIDENCE_SCHEMA,
    status: "passed",
    candidate_sha: candidate,
    release_configuration_fence_sha256: snapshot.release_fence.sha256,
    lineage_scope: "runtime_configuration_fence_not_attestation",
    profile: Object.freeze({
      schema: snapshot.profile.schema,
      version: snapshot.profile.version,
      profile_id: snapshot.profile.profile_id,
      deployment_posture: snapshot.profile.deployment_posture,
      limits: snapshot.profile.limits,
    }),
    observed_at_utc: snapshot.observed_at,
    utilization: snapshot.utilization,
    usage: snapshot.usage,
    headroom: snapshot.headroom,
    storage_amplification: snapshot.storage_amplification,
    quota_rejects: snapshot.quota_rejects,
    reservations: snapshot.reservations,
    assertions: Object.freeze(CAPACITY_PROFILE_ASSERTION_IDS.map((id) =>
      Object.freeze({ id, status: "passed" }))),
  });
  return assertRedactedDocument(Object.freeze({
    ...unsigned,
    artifact_sha256: digest(canonical(unsigned)),
  }));
}

export function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (!argument.startsWith("--")) fail("invalid_cli_argument");
    const key = argument.slice(2).replaceAll("-", "_");
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) fail("missing_cli_value");
    if (Object.hasOwn(options, key)) fail("duplicate_cli_argument");
    options[key] = value;
    index += 1;
  }
  const allowed = new Set([
    "base_url",
    "candidate_sha",
    "configuration_fence_nonce",
    "evidence_out",
    "expected_profile",
    "expected_utilization",
    "min_quota_rejects",
  ]);
  if (Object.keys(options).some((key) => !allowed.has(key))) {
    fail("unsupported_cli_argument");
  }
  return options;
}

async function responseJson(response, code) {
  const text = await response.text();
  try {
    return text.length === 0 ? null : JSON.parse(text);
  } catch {
    fail(code, { status: response.status });
  }
}

export async function run(options, dependencies = {}) {
  const token = required(
    (dependencies.environment ?? process.env)[TOKEN_ENV],
    `missing_${TOKEN_ENV.toLowerCase()}`,
  );
  const origin = baseUrl(options.base_url ?? DEFAULT_BASE_URL);
  const headers = Object.freeze({
    accept: "application/json",
    "OAI-Sites-Authorization": `Bearer ${token}`,
  });
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const readback = await fetchImpl(
    new URL("/api/v1/internal/operators/capacity", origin),
    { headers, redirect: "error" },
  );
  const body = await responseJson(readback, "invalid_capacity_response");
  if (readback.status !== 200 || body?.ok !== true || !isRecord(body.data)) {
    fail("capacity_readback_failed", {
      status: readback.status,
      code: safeCode(body?.error?.code),
    });
  }
  const expectedProfile = options.expected_profile ?? "restricted-uat-v1";
  if (!Object.hasOwn(PROFILES, expectedProfile)) fail("invalid_expected_profile");
  const snapshot = validateCapacitySnapshot(body.data, expectedProfile);

  const override = await fetchImpl(
    new URL("/api/v1/internal/operators/capacity?profile=default", origin),
    { headers, redirect: "error" },
  );
  const overrideBody = await responseJson(override, "invalid_override_response");
  if (override.status !== 400 || overrideBody?.error?.code !== "invalid_request") {
    fail("capacity_query_override_not_rejected", {
      status: override.status,
      code: safeCode(overrideBody?.error?.code),
    });
  }

  if (
    options.expected_utilization !== undefined &&
    (!UTILIZATION.has(options.expected_utilization) ||
      snapshot.utilization !== options.expected_utilization)
  ) fail("unexpected_capacity_utilization");
  if (options.min_quota_rejects !== undefined) {
    const minimum = Number(options.min_quota_rejects);
    if (!Number.isSafeInteger(minimum) || minimum < 0) fail("invalid_min_quota_rejects");
    if (snapshot.quota_rejects < minimum) fail("quota_reject_count_too_low");
  }

  const evidence = createEvidence({
    candidateSha: options.candidate_sha,
    configurationFenceNonce: options.configuration_fence_nonce,
    snapshot,
  });
  if (options.evidence_out !== undefined) {
    await writeFile(options.evidence_out, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(options.evidence_out, 0o600);
  }
  return evidence;
}

function usage() {
  return `Usage: node scripts/run-uat-capacity-profile-probe.mjs \\
  --candidate-sha <40-lowercase-hex> --configuration-fence-nonce <22-64-chars> \\
  [--expected-profile restricted-uat-v1|default-v1] \\
  [--base-url https://...] [--expected-utilization normal|warning|soft_limit|hard_limit] \\
  [--min-quota-rejects <count>] [--evidence-out <0600-json-path>]\n\n${TOKEN_ENV} is required and is never accepted on the command line.\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
    } else {
      const evidence = await run(options);
      process.stdout.write(`${JSON.stringify(evidence)}\n`);
    }
  } catch (error) {
    const failure = error instanceof ProbeFailure
      ? { code: error.code, ...error.details }
      : { code: "capacity_probe_failed" };
    process.stderr.write(`${JSON.stringify({ ok: false, error: failure })}\n`);
    process.exitCode = 1;
  }
}
