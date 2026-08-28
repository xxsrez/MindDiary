import { createHash } from "node:crypto";

import {
  assertRedactedDocument,
  canonical,
  isRecord,
} from "./multi-principal-probe-core.mjs";
import {
  verifyCleanupEvidence,
  verifyEvidence,
} from "../run-uat-operator-directory-canary.mjs";
import {
  verifyProviderRequestLogBoundaryReceipt,
} from "./provider-request-log-boundary.mjs";
import {
  verifyUatTestAccountPoolReadinessReceipt,
} from "./uat-test-account-pool-contract.mjs";

export const UAT_OPERATOR_DIRECTORY_JOIN_SCHEMA =
  "mind-diary/uat-operator-directory-join-evidence/v1";

export const UAT_OPERATOR_DIRECTORY_JOIN_ASSERTION_IDS = Object.freeze([
  "lineage.exact_candidate",
  "lineage.exact_deployment",
  "actors.pool_ready_exact_audience_and_allowlist",
  "canary.operator_directory_passed",
  "privacy.provider_boundary_accepted",
  "cleanup.same_run_resources_absent",
  "scope.uat_only_production_excluded",
]);

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

export class UatOperatorDirectoryJoinError extends Error {
  constructor(code) {
    super(code);
    this.name = "UatOperatorDirectoryJoinError";
    this.code = code;
  }
}

function fail(code) {
  throw new UatOperatorDirectoryJoinError(code);
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function observedAtUtc(value) {
  if (
    typeof value !== "string" ||
    !UTC_INSTANT.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) fail("invalid_observed_at_utc");
  return value;
}

function same(values, code) {
  if (new Set(values).size !== 1) fail(code);
  return values[0];
}

function exactKeys(value, expected) {
  return isRecord(value) &&
    Object.keys(value).length === expected.length &&
    Object.keys(value).every((key) => expected.includes(key));
}

export function createUatOperatorDirectoryJoinEvidence(input) {
  let canary;
  let pool;
  let provider;
  let cleanup;
  try {
    canary = verifyEvidence(input.canaryEvidence);
    pool = verifyUatTestAccountPoolReadinessReceipt(input.poolEvidence);
    provider = verifyProviderRequestLogBoundaryReceipt(input.providerEvidence);
    cleanup = verifyCleanupEvidence(input.cleanupEvidence);
  } catch {
    fail("invalid_input_receipt");
  }
  const candidateSha = same([
    canary.candidate_sha,
    pool.candidate_sha,
    provider.candidate_sha,
    cleanup.candidate_sha,
  ], "candidate_lineage_mismatch");
  const deploymentId = same([
    canary.deployment_id,
    pool.deployment_id,
    provider.deployment.deployment_id,
    cleanup.deployment_id,
  ], "deployment_lineage_mismatch");
  if (canary.run_fingerprint !== cleanup.run_fingerprint) {
    fail("cleanup_run_mismatch");
  }
  if (cleanup.phase !== "cleanup") {
    fail("normal_cleanup_receipt_required");
  }
  if (provider.status !== "accepted_boundary") {
    fail("provider_boundary_not_accepted");
  }
  const unsigned = Object.freeze({
    schema: UAT_OPERATOR_DIRECTORY_JOIN_SCHEMA,
    status: "passed",
    environment: "uat",
    production_excluded: true,
    candidate_sha: candidateSha,
    deployment: Object.freeze({
      site_project_id: provider.deployment.site_project_id,
      site_version_id: provider.deployment.site_version_id,
      deployment_id: deploymentId,
      archive_sha256: provider.deployment.archive_sha256,
    }),
    run_fingerprint: canary.run_fingerprint,
    inputs: Object.freeze({
      operator_canary_sha256: canary.artifact_sha256,
      actor_pool_sha256: pool.artifact_sha256,
      provider_privacy_sha256: provider.artifact_sha256,
      cleanup_sha256: cleanup.artifact_sha256,
    }),
    assertions: Object.freeze(UAT_OPERATOR_DIRECTORY_JOIN_ASSERTION_IDS.map((id) =>
      Object.freeze({ id, status: "passed" }))),
    observed_at_utc: observedAtUtc(input.observedAtUtc),
  });
  return Object.freeze(assertRedactedDocument({
    ...unsigned,
    artifact_sha256: digest(canonical(unsigned)),
  }));
}

export function verifyUatOperatorDirectoryJoinEvidence(value) {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schema",
      "status",
      "environment",
      "production_excluded",
      "candidate_sha",
      "deployment",
      "run_fingerprint",
      "inputs",
      "assertions",
      "observed_at_utc",
      "artifact_sha256",
    ]) ||
    value.schema !== UAT_OPERATOR_DIRECTORY_JOIN_SCHEMA ||
    value.status !== "passed" ||
    value.environment !== "uat" ||
    value.production_excluded !== true ||
    typeof value.candidate_sha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value.candidate_sha) ||
    typeof value.deployment?.deployment_id !== "string" ||
    !/^appgdep_[a-z0-9]+$/u.test(value.deployment.deployment_id) ||
    !exactKeys(value.deployment, [
      "site_project_id",
      "site_version_id",
      "deployment_id",
      "archive_sha256",
    ]) ||
    !/^appgprj_[a-z0-9]+$/u.test(value.deployment.site_project_id) ||
    !/^(?:appgver_[a-z0-9]+|appgprj_[a-z0-9]+~appgver_[a-z0-9]+)$/u.test(value.deployment.site_version_id) ||
    !SHA256.test(value.deployment?.archive_sha256) ||
    typeof value.run_fingerprint !== "string" ||
    !/^uatop-run-[0-9a-f]{32}$/u.test(value.run_fingerprint) ||
    !Array.isArray(value.assertions) ||
    canonical(value.assertions) !== canonical(
      UAT_OPERATOR_DIRECTORY_JOIN_ASSERTION_IDS.map((id) => ({
        id,
        status: "passed",
      })),
    ) ||
    !exactKeys(value.inputs, [
      "operator_canary_sha256",
      "actor_pool_sha256",
      "provider_privacy_sha256",
      "cleanup_sha256",
    ]) ||
    Object.values(value.inputs).some((artifact) => !SHA256.test(artifact)) ||
    !SHA256.test(value.artifact_sha256)
  ) fail("invalid_join_evidence");
  observedAtUtc(value.observed_at_utc);
  const { artifact_sha256: artifact, ...unsigned } = value;
  if (artifact !== digest(canonical(unsigned))) fail("invalid_join_evidence_hash");
  assertRedactedDocument(value);
  return Object.freeze(structuredClone(value));
}
