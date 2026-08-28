import { createHash } from "node:crypto";

import { isProviderVersionId } from "./sites-provider-readback.mjs";

export const PROVIDER_REQUEST_LOG_BOUNDARY_SCHEMA =
  "mind-diary/provider-request-log-boundary-receipt/v1";

export const APPLICATION_BOUNDARY_CLASSIFICATIONS = Object.freeze([
  "application_telemetry",
  "application_service_audit",
  "release_receipt",
]);

export const PROVIDER_BOUNDARY_CLASSIFICATIONS = Object.freeze([
  "source_network_metadata",
  "client_software_metadata",
  "request_target_metadata",
  "request_header_metadata",
  "payload_metadata",
  "credential_metadata",
  "signed_resource_metadata",
  "retention_control",
  "reduction_control",
  "access_control",
  "deletion_control",
]);

export const PROVIDER_BOUNDARY_STATUSES = Object.freeze([
  "unknown",
  "not_available",
  "accepted_boundary",
  "failed",
]);

const APPLICATION_STATUSES = new Set(["passed", "failed"]);
const PROVIDER_STATUSES = new Set(PROVIDER_BOUNDARY_STATUSES);
const AUTHORITY_STATUSES = new Set(["required", "recorded"]);
const TOP_LEVEL_KEYS = new Set([
  "candidate_sha",
  "deployment",
  "observed_at_utc",
  "application_evidence",
  "provider_evidence",
  "authority",
]);
const DEPLOYMENT_KEYS = new Set([
  "site_project_id",
  "site_version_id",
  "deployment_id",
  "archive_sha256",
]);
const EVIDENCE_KEYS = new Set(["locator", "sha256"]);
const CLASSIFICATION_KEYS = new Set(["classification", "status", "evidence"]);
const AUTHORITY_KEYS = new Set(["status", "evidence"]);
const SAFE_LOCATOR = /^(?:repo|release-evidence|sites-metadata|provider-control|task-manager):[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

export class ProviderRequestLogBoundaryError extends TypeError {
  constructor(code) {
    super(`provider request-log boundary receipt rejected: ${code}`);
    this.name = "ProviderRequestLogBoundaryError";
    this.code = code;
  }
}

function fail(code) {
  throw new ProviderRequestLogBoundaryError(code);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value, expected, code) {
  if (!isRecord(value)) fail(code);
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
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

function evidenceReference(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  assertExactKeys(value, EVIDENCE_KEYS, "invalid_evidence_reference");
  if (!SAFE_LOCATOR.test(value.locator) || !SHA256.test(value.sha256)) {
    fail("invalid_evidence_reference");
  }
  return Object.freeze({ locator: value.locator, sha256: value.sha256 });
}

function orderedClassifications(value, expectedIds, statuses, code) {
  if (!Array.isArray(value) || value.length !== expectedIds.length) fail(code);
  return Object.freeze(value.map((entry, index) => {
    assertExactKeys(entry, CLASSIFICATION_KEYS, code);
    const expected = expectedIds[index];
    if (entry.classification !== expected || !statuses.has(entry.status)) fail(code);
    const evidence = evidenceReference(entry.evidence, { nullable: true });
    if (
      (entry.status === "unknown" && evidence !== null) ||
      (entry.status !== "unknown" && evidence === null)
    ) fail(code);
    return Object.freeze({
      classification: expected,
      status: entry.status,
      evidence,
    });
  }));
}

function deployment(value) {
  assertExactKeys(value, DEPLOYMENT_KEYS, "invalid_deployment_identity");
  if (
    typeof value.site_project_id !== "string" ||
    !/^appgprj_[a-z0-9]+$/u.test(value.site_project_id) ||
    !isProviderVersionId(value.site_version_id) ||
    typeof value.deployment_id !== "string" ||
    !/^appgdep_[a-z0-9]+$/u.test(value.deployment_id) ||
    !SHA256.test(value.archive_sha256)
  ) fail("invalid_deployment_identity");
  return Object.freeze({ ...value });
}

function boundaryStatus(providerEvidence, authority) {
  if (providerEvidence.some(({ status }) => status === "failed")) return "failed";
  if (providerEvidence.every(({ status }) => status === "not_available")) {
    return authority.status === "recorded" ? "accepted_boundary" : "not_available";
  }
  if (providerEvidence.some(({ status }) => status === "unknown")) return "unknown";
  return authority.status === "recorded" ? "accepted_boundary" : "unknown";
}

function assertReceiptTextIsSafe(value) {
  const text = JSON.stringify(value);
  for (const pattern of [
    /https?:\/\//iu,
    /@[a-z0-9.-]+\.[a-z]{2,}/iu,
    /mdp_v1_/iu,
    /mdg_v1_/iu,
    /mdo_(?:code|access|refresh)_/iu,
    /hmac-sha256:/iu,
    /(?:authorization|cookie|csrf|secret|verifier|signed_?url|download_?url)["']?\s*:/iu,
  ]) {
    if (pattern.test(text)) fail("unsafe_receipt_content");
  }
}

export function createProviderRequestLogBoundaryReceipt(input) {
  assertExactKeys(input, TOP_LEVEL_KEYS, "invalid_receipt_input");
  if (typeof input.candidate_sha !== "string" || !/^[0-9a-f]{40}$/u.test(input.candidate_sha)) {
    fail("invalid_candidate_sha");
  }
  if (
    typeof input.observed_at_utc !== "string" ||
    !UTC_INSTANT.test(input.observed_at_utc) ||
    !Number.isFinite(Date.parse(input.observed_at_utc))
  ) fail("invalid_observation_time");

  const applicationEvidence = orderedClassifications(
    input.application_evidence,
    APPLICATION_BOUNDARY_CLASSIFICATIONS,
    APPLICATION_STATUSES,
    "invalid_application_evidence",
  );
  if (applicationEvidence.some(({ evidence }) => evidence === null)) {
    fail("missing_application_evidence");
  }
  const providerEvidence = orderedClassifications(
    input.provider_evidence,
    PROVIDER_BOUNDARY_CLASSIFICATIONS,
    PROVIDER_STATUSES,
    "invalid_provider_evidence",
  );
  assertExactKeys(input.authority, AUTHORITY_KEYS, "invalid_authority_evidence");
  if (!AUTHORITY_STATUSES.has(input.authority.status)) fail("invalid_authority_evidence");
  const authorityEvidence = evidenceReference(input.authority.evidence, { nullable: true });
  if (
    (input.authority.status === "required" && authorityEvidence !== null) ||
    (input.authority.status === "recorded" && authorityEvidence === null)
  ) fail("invalid_authority_evidence");
  const authority = Object.freeze({
    status: input.authority.status,
    evidence: authorityEvidence,
  });

  const unsigned = Object.freeze({
    schema: PROVIDER_REQUEST_LOG_BOUNDARY_SCHEMA,
    status: applicationEvidence.some(({ status }) => status === "failed")
      ? "failed"
      : boundaryStatus(providerEvidence, authority),
    candidate_sha: input.candidate_sha,
    deployment: deployment(input.deployment),
    observed_at_utc: input.observed_at_utc,
    application_evidence: applicationEvidence,
    provider_evidence: providerEvidence,
    authority,
  });
  assertReceiptTextIsSafe(unsigned);
  return Object.freeze({
    ...unsigned,
    artifact_sha256: digest(canonical(unsigned)),
  });
}

export function verifyProviderRequestLogBoundaryReceipt(value) {
  if (!isRecord(value)) fail("invalid_receipt");
  const { artifact_sha256: artifact, ...input } = value;
  if (!SHA256.test(artifact)) fail("invalid_receipt_hash");
  const recreated = createProviderRequestLogBoundaryReceipt({
    candidate_sha: input.candidate_sha,
    deployment: input.deployment,
    observed_at_utc: input.observed_at_utc,
    application_evidence: input.application_evidence,
    provider_evidence: input.provider_evidence,
    authority: input.authority,
  });
  if (
    input.schema !== recreated.schema ||
    input.status !== recreated.status ||
    artifact !== recreated.artifact_sha256 ||
    canonical(value) !== canonical(recreated)
  ) fail("invalid_receipt");
  return recreated;
}
