import { createHash } from "node:crypto";

import {
  canonical,
  candidateSha,
  digest,
  fail,
  isRecord,
} from "./multi-principal-probe-core.mjs";
import { verifyUatTestAccountPoolReadinessReceipt } from "./uat-test-account-pool-contract.mjs";

export const GOOGLE_DRIVE_UAT_RUNNER_ID =
  "ship-work-release/uat-google-drive-connector-object/v1";
export const GOOGLE_DRIVE_UAT_CONTRACT_SCHEMA =
  "mind-diary/google-drive-connector-uat-contract/v1";
export const GOOGLE_DRIVE_UAT_FIXTURE_SCHEMA =
  "mind-diary/google-drive-connector-uat-synthetic-fixtures/v1";
export const GOOGLE_DRIVE_UAT_PLAN_SCHEMA =
  "mind-diary/google-drive-connector-uat-plan/v1";
export const GOOGLE_DRIVE_UAT_SITES_READBACK_SCHEMA =
  "mind-diary/google-drive-connector-sites-readback/v1";
export const GOOGLE_DRIVE_UAT_PROVIDER_READBACK_SCHEMA =
  "mind-diary/google-drive-connector-provider-readback/v1";
export const GOOGLE_DRIVE_UAT_PRODUCT_READBACK_SCHEMA =
  "mind-diary/google-drive-connector-product-readback/v1";
export const GOOGLE_DRIVE_UAT_JOIN_SCHEMA =
  "mind-diary/google-drive-connector-uat-readback-join/v1";
export const GOOGLE_DRIVE_UAT_TERMINAL_SCHEMA =
  "mind-diary/google-drive-connector-uat-evidence/v1";

export const GOOGLE_DRIVE_UAT_ASSERTION_IDS = Object.freeze([
  "GD-UAT-001-exact-candidate-deployment",
  "GD-UAT-002-one-exact-authorized-object",
  "GD-UAT-003-binary-byte-for-byte",
  "GD-UAT-004-native-explicit-export-snapshot",
  "GD-UAT-005-adapter-secret-and-locator-boundary",
  "GD-UAT-006-revoked-grant-fails-closed",
  "GD-UAT-007-ownership-change-fails-closed",
  "GD-UAT-008-revision-or-export-race-fails-closed",
  "GD-UAT-009-oversize-timeout-unknown-fail-closed",
  "GD-UAT-010-no-existence-leak",
  "GD-UAT-011-current-writable-target-authorization",
  "GD-UAT-012-stage-commit-download-history-web-export",
  "GD-UAT-013-persistence-after-redeploy",
  "GD-UAT-014-content-mcp-has-no-administrative-export",
  "GD-UAT-015-bounded-cleanup-readback",
  "GD-UAT-016-shared-drive-native-export",
]);

export const GOOGLE_DRIVE_UAT_BLOCKER_CATEGORIES = Object.freeze([
  "service_fault",
  "product_defect",
  "missing_external_capability",
  "credential_role_or_approval",
  "unknown_external_outcome",
  "blocked_by_dependency",
]);

export const GOOGLE_DRIVE_UAT_CLEANUP_STEPS = Object.freeze([
  "delete_synthetic_provider_objects",
  "revoke_run_scoped_grant",
  "delete_run_mind",
  "verify_provider_objects_absent",
  "verify_run_mind_absent",
]);

export const GOOGLE_DRIVE_UAT_NEGATIVE_CASES = Object.freeze([
  Object.freeze({
    id: "selector-url-forbidden",
    code: "file_ingress_source_unavailable",
    retryable: false,
    providerFetch: false,
    indistinguishable: true,
  }),
  Object.freeze({
    id: "selector-query-forbidden",
    code: "file_ingress_source_unavailable",
    retryable: false,
    providerFetch: false,
    indistinguishable: true,
  }),
  Object.freeze({
    id: "selector-folder-forbidden",
    code: "file_ingress_source_unavailable",
    retryable: false,
    providerFetch: false,
    indistinguishable: true,
  }),
  Object.freeze({
    id: "grant-revoked",
    code: "file_ingress_source_unavailable",
    retryable: false,
    providerFetch: false,
    indistinguishable: true,
  }),
  Object.freeze({
    id: "ownership-changed",
    code: "file_ingress_source_unavailable",
    retryable: false,
    providerFetch: true,
    indistinguishable: true,
  }),
  Object.freeze({
    id: "version-changed",
    code: "file_ingress_source_unavailable",
    retryable: false,
    providerFetch: true,
    indistinguishable: true,
  }),
  Object.freeze({
    id: "native-export-bytes-changed",
    code: "file_ingress_source_unavailable",
    retryable: false,
    providerFetch: true,
    indistinguishable: true,
  }),
  Object.freeze({
    id: "binary-size-plus-one",
    code: "file_ingress_source_unavailable",
    retryable: false,
    providerFetch: true,
    indistinguishable: true,
  }),
  Object.freeze({
    id: "native-export-size-plus-one",
    code: "file_ingress_source_unavailable",
    retryable: false,
    providerFetch: true,
    indistinguishable: true,
  }),
  Object.freeze({
    id: "provider-timeout",
    code: "file_ingress_transport_unavailable",
    retryable: true,
    providerFetch: true,
    indistinguishable: true,
  }),
  Object.freeze({
    id: "provider-unknown-outcome",
    code: "file_ingress_transport_unavailable",
    retryable: true,
    providerFetch: true,
    indistinguishable: true,
  }),
  Object.freeze({
    id: "provider-not-found",
    code: "file_ingress_source_unavailable",
    retryable: false,
    providerFetch: true,
    indistinguishable: true,
  }),
  Object.freeze({
    id: "provider-forbidden",
    code: "file_ingress_source_unavailable",
    retryable: false,
    providerFetch: true,
    indistinguishable: true,
  }),
  Object.freeze({
    id: "writable-target-missing",
    code: "writable_target_required",
    retryable: false,
    providerFetch: false,
    indistinguishable: true,
  }),
  Object.freeze({
    id: "writable-target-mismatch",
    code: "writable_target_mismatch",
    retryable: false,
    providerFetch: false,
    indistinguishable: true,
  }),
  Object.freeze({
    id: "writable-target-concurrently-changed",
    code: "writable_target_unavailable",
    retryable: false,
    providerFetch: false,
    indistinguishable: true,
  }),
]);

const PROVIDER_ASSERTION_IDS = Object.freeze(GOOGLE_DRIVE_UAT_ASSERTION_IDS.filter((id) =>
  [2, 3, 4, 5, 6, 7, 8, 9, 10, 16].some((number) => id.includes(`-${String(number).padStart(3, "0")}-`))
));
const PRODUCT_ASSERTION_IDS = Object.freeze(GOOGLE_DRIVE_UAT_ASSERTION_IDS.filter((id) =>
  [1, 11, 12, 13, 14, 15].some((number) => id.includes(`-${String(number).padStart(3, "0")}-`))
));

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PROJECT_ID = /^appgprj_[a-z0-9]+$/u;
const VERSION_ID = /^(?:appgver_[a-z0-9]+|appgprj_[a-z0-9]+~appgver_[a-z0-9]+)$/u;
const DEPLOYMENT_ID = /^appgdep_[a-z0-9]+$/u;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const FORBIDDEN_FIELD = /^(?:access_token|refresh_token|authorization_header|provider_grant_(?:id|ref)|provider_object_id|provider_revision_id|provider_export_url|download_url|binding_ref|principal_email|local_path|file_content|raw_(?:request|response|body)|cookie|credential|secret|token)$/iu;
const FORBIDDEN_VALUE = /(?:mdp_v1_|mdg_v1_|mdo_(?:code|access|refresh)_|oai-sites-authorization|authorization\s*:|cookie\s*:|https?:\/\/|@[a-z0-9.-]+\.[a-z]{2,}|(?:principal|space|revision|grant|binding|token)_[a-z0-9])/iu;

function exactKeys(value, keys, code) {
  if (!isRecord(value)) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code);
  }
}

function deepFreeze(value) {
  if (!isRecord(value) && !Array.isArray(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function utc(value, code) {
  if (typeof value !== "string" || !UTC_INSTANT.test(value) ||
      Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) fail(code);
  return value;
}

function sha256(value, code) {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
  return value;
}

function deploymentId(value, code = "invalid_deployment_id") {
  if (typeof value !== "string" || !DEPLOYMENT_ID.test(value)) fail(code);
  return value;
}

function assertPrivacySafe(value) {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (FORBIDDEN_VALUE.test(current)) fail("unsafe_google_drive_uat_evidence");
      continue;
    }
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (!isRecord(current)) continue;
    for (const [key, fieldValue] of Object.entries(current)) {
      if (FORBIDDEN_FIELD.test(key)) fail("unsafe_google_drive_uat_evidence");
      pending.push(fieldValue);
    }
  }
  return value;
}

function signed(value, code) {
  if (!isRecord(value) || !SHA256.test(value.artifact_sha256 ?? "")) fail(code);
  const { artifact_sha256: supplied, ...unsigned } = value;
  if (supplied !== digest(canonical(unsigned))) fail(code);
  assertPrivacySafe(value);
  return value;
}

function sign(unsigned) {
  const value = { ...unsigned, artifact_sha256: digest(canonical(unsigned)) };
  assertPrivacySafe(value);
  return deepFreeze(value);
}

function validateAssertionRegistry(value, expectedIds, expectedStatus, code) {
  if (!Array.isArray(value) || value.length !== expectedIds.length) fail(code);
  value.forEach((entry, index) => {
    exactKeys(entry, ["id", "status"], code);
    if (entry.id !== expectedIds[index] || entry.status !== expectedStatus) fail(code);
  });
  return value;
}

function validateRawObservationRefs(value, code) {
  if (!Array.isArray(value) || value.length < 1) fail(code);
  const kinds = new Set();
  for (const entry of value) {
    exactKeys(entry, ["kind", "sha256"], code);
    if (typeof entry.kind !== "string" || !SAFE_CODE.test(entry.kind) || kinds.has(entry.kind)) fail(code);
    kinds.add(entry.kind);
    sha256(entry.sha256, code);
  }
  return value;
}

function validateArtifactSource(value, code) {
  if (!isRecord(value)) fail(code);
  const copy = structuredClone(value);
  const supplied = copy.artifact_sha256;
  delete copy.artifact_sha256;
  if (!SHA256.test(supplied ?? "") || supplied !== digest(canonical(copy))) fail(code);
  return value;
}

export function validateGoogleDriveUatContract(contract) {
  if (!isRecord(contract) || contract.schema !== GOOGLE_DRIVE_UAT_CONTRACT_SCHEMA ||
      contract.contract_status !== "defined_not_executed" ||
      contract.runner_id !== GOOGLE_DRIVE_UAT_RUNNER_ID ||
      contract.verification_task !== "MD-319") fail("invalid_google_drive_uat_contract");
  if (!Array.isArray(contract.assertions) ||
      contract.assertions.length !== GOOGLE_DRIVE_UAT_ASSERTION_IDS.length ||
      contract.assertions.some((id, index) => id !== GOOGLE_DRIVE_UAT_ASSERTION_IDS[index])) {
    fail("invalid_google_drive_uat_contract");
  }
  exactKeys(contract.evidence_schemas, [
    "local_plan",
    "sites_readback",
    "provider_readback",
    "product_readback",
    "structural_join",
    "terminal_hosted",
  ], "invalid_google_drive_uat_contract");
  if (contract.evidence_schemas.local_plan !== GOOGLE_DRIVE_UAT_PLAN_SCHEMA ||
      contract.evidence_schemas.sites_readback !== GOOGLE_DRIVE_UAT_SITES_READBACK_SCHEMA ||
      contract.evidence_schemas.provider_readback !== GOOGLE_DRIVE_UAT_PROVIDER_READBACK_SCHEMA ||
      contract.evidence_schemas.product_readback !== GOOGLE_DRIVE_UAT_PRODUCT_READBACK_SCHEMA ||
      contract.evidence_schemas.structural_join !== GOOGLE_DRIVE_UAT_JOIN_SCHEMA ||
      contract.evidence_schemas.terminal_hosted !== GOOGLE_DRIVE_UAT_TERMINAL_SCHEMA ||
      !Array.isArray(contract.blocker_taxonomy) ||
      contract.blocker_taxonomy.some((value, index) =>
        value !== GOOGLE_DRIVE_UAT_BLOCKER_CATEGORIES[index])) {
    fail("invalid_google_drive_uat_contract");
  }
  return deepFreeze(structuredClone(contract));
}

export function validateGoogleDriveUatFixturePlan(value) {
  validateArtifactSource(value, "invalid_google_drive_uat_fixture_plan");
  if (value.schema !== GOOGLE_DRIVE_UAT_FIXTURE_SCHEMA ||
      value.generator !== "mind-diary-md319-synthetic-google-drive-v1" ||
      value.corpus_class !== "synthetic-no-user-data" ||
      value.provider_scope !== "private-run-owned-google-drive" ||
      !Array.isArray(value.fixtures) || value.fixtures.length !== 4 ||
      !isRecord(value.cleanup) || value.cleanup.delete_all_run_owned_objects !== true ||
      value.cleanup.verify_exact_absence !== true ||
      value.cleanup.retain_source_or_export_bytes !== false) {
    fail("invalid_google_drive_uat_fixture_plan");
  }
  const ids = value.fixtures.map((fixture) => fixture?.id);
  if (ids.some((id, index) => id !== [
    "drive-binary",
    "drive-document-docx",
    "drive-spreadsheet-xlsx",
    "drive-presentation-pptx",
  ][index])) fail("invalid_google_drive_uat_fixture_plan");
  const binary = value.fixtures[0];
  if (binary.kind !== "binary" || binary.expected_source_size !== 4096 ||
      binary.expected_source_sha256 !==
        "sha256:12f51875c1545afac5b3bd4b3fd5131a9ed9f50ff248b84b01986d0934716f68" ||
      binary.representation?.provider_method !== "files.get" ||
      binary.representation?.supports_all_drives !== true) {
    fail("invalid_google_drive_uat_fixture_plan");
  }
  const expectedFormats = ["google-drive/docx", "google-drive/xlsx", "google-drive/pptx"];
  for (const [index, fixture] of value.fixtures.slice(1).entries()) {
    if (fixture.kind !== "google_native_export" || fixture.shared_drive_required !== true ||
        fixture.representation?.kind !== "export_snapshot" ||
        fixture.representation?.format !== expectedFormats[index] ||
        fixture.representation?.provider_method !== "files.export" ||
        JSON.stringify(fixture.representation?.query_keys) !== JSON.stringify(["mimeType"])) {
      fail("invalid_google_drive_uat_fixture_plan");
    }
  }
  return deepFreeze(structuredClone(value));
}

export function createGoogleDriveUatPlanReceipt({
  contract,
  fixturePlan,
  poolReadinessReceipt,
  candidate,
  projectId,
  deployment,
  observedAtUtc,
}) {
  const checkedContract = validateGoogleDriveUatContract(contract);
  const checkedFixture = validateGoogleDriveUatFixturePlan(fixturePlan);
  const checkedPool = verifyUatTestAccountPoolReadinessReceipt(poolReadinessReceipt);
  const checkedCandidate = candidateSha(candidate);
  if (!PROJECT_ID.test(projectId ?? "")) fail("invalid_project_id");
  const checkedDeployment = deploymentId(deployment);
  utc(observedAtUtc, "invalid_observed_at");
  if (checkedPool.candidate_sha !== checkedCandidate ||
      checkedPool.deployment_id !== checkedDeployment) fail("pool_lineage_mismatch");
  if (!Array.isArray(checkedContract.fixtures) ||
      checkedContract.fixtures.length !== checkedFixture.fixtures.length ||
      checkedContract.fixtures.some((fixture, index) =>
        fixture.id !== checkedFixture.fixtures[index].id) ||
      JSON.stringify(checkedContract.cleanup) !== JSON.stringify(GOOGLE_DRIVE_UAT_CLEANUP_STEPS)) {
    fail("fixture_or_cleanup_contract_mismatch");
  }
  const contractSha256 = digest(canonical(checkedContract));
  const runFingerprint = digest(canonical({
    candidate_sha: checkedCandidate,
    deployment_id: checkedDeployment,
    contract_sha256: contractSha256,
    fixture_plan_sha256: checkedFixture.artifact_sha256,
    pool_readiness_sha256: checkedPool.artifact_sha256,
    runner_id: GOOGLE_DRIVE_UAT_RUNNER_ID,
  }));
  return sign({
    schema: GOOGLE_DRIVE_UAT_PLAN_SCHEMA,
    status: "ready_for_hosted_execution",
    hosted_evidence: false,
    acceptance: "nonterminal",
    provenance: "exact-candidate-local-preflight",
    candidate_sha: checkedCandidate,
    project_id: projectId,
    deployment_id: checkedDeployment,
    runner_id: GOOGLE_DRIVE_UAT_RUNNER_ID,
    observed_at_utc: observedAtUtc,
    run_fingerprint: runFingerprint,
    contract_sha256: contractSha256,
    fixture_plan_sha256: checkedFixture.artifact_sha256,
    pool_readiness_sha256: checkedPool.artifact_sha256,
    fixture_ids: checkedFixture.fixtures.map(({ id }) => id),
    assertion_results: GOOGLE_DRIVE_UAT_ASSERTION_IDS.map((id) => ({ id, status: "not_run" })),
    cleanup: {
      status: "not_run",
      steps: checkedContract.cleanup,
    },
    hosted_execution: {
      status: "not_run",
      resume_signal: "direct_same_run_sites_drive_and_product_observations_are_available",
    },
  });
}

export function validateGoogleDriveUatPlanReceipt(value, expected = {}) {
  exactKeys(value, [
    "schema",
    "status",
    "hosted_evidence",
    "acceptance",
    "provenance",
    "candidate_sha",
    "project_id",
    "deployment_id",
    "runner_id",
    "observed_at_utc",
    "run_fingerprint",
    "contract_sha256",
    "fixture_plan_sha256",
    "pool_readiness_sha256",
    "fixture_ids",
    "assertion_results",
    "cleanup",
    "hosted_execution",
    "artifact_sha256",
  ], "invalid_google_drive_uat_plan_receipt");
  signed(value, "invalid_google_drive_uat_plan_receipt");
  if (value.schema !== GOOGLE_DRIVE_UAT_PLAN_SCHEMA ||
      value.status !== "ready_for_hosted_execution" || value.hosted_evidence !== false ||
      value.acceptance !== "nonterminal" ||
      value.provenance !== "exact-candidate-local-preflight" ||
      value.runner_id !== GOOGLE_DRIVE_UAT_RUNNER_ID ||
      !PROJECT_ID.test(value.project_id ?? "") || !DEPLOYMENT_ID.test(value.deployment_id ?? "") ||
      !SHA256.test(value.run_fingerprint ?? "") || !SHA256.test(value.contract_sha256 ?? "") ||
      !SHA256.test(value.fixture_plan_sha256 ?? "") ||
      !SHA256.test(value.pool_readiness_sha256 ?? "") ||
      value.cleanup?.status !== "not_run" || value.hosted_execution?.status !== "not_run") {
    fail("invalid_google_drive_uat_plan_receipt");
  }
  candidateSha(value.candidate_sha);
  utc(value.observed_at_utc, "invalid_google_drive_uat_plan_receipt");
  validateAssertionRegistry(
    value.assertion_results,
    GOOGLE_DRIVE_UAT_ASSERTION_IDS,
    "not_run",
    "invalid_google_drive_uat_plan_receipt",
  );
  if (JSON.stringify(value.fixture_ids) !== JSON.stringify([
    "drive-binary",
    "drive-document-docx",
    "drive-spreadsheet-xlsx",
    "drive-presentation-pptx",
  ]) ||
      JSON.stringify(value.cleanup.steps) !== JSON.stringify(GOOGLE_DRIVE_UAT_CLEANUP_STEPS) ||
      value.hosted_execution.resume_signal !==
        "direct_same_run_sites_drive_and_product_observations_are_available" ||
      value.run_fingerprint !== digest(canonical({
        candidate_sha: value.candidate_sha,
        deployment_id: value.deployment_id,
        contract_sha256: value.contract_sha256,
        fixture_plan_sha256: value.fixture_plan_sha256,
        pool_readiness_sha256: value.pool_readiness_sha256,
        runner_id: GOOGLE_DRIVE_UAT_RUNNER_ID,
      }))) {
    fail("invalid_google_drive_uat_plan_receipt");
  }
  if (expected.candidate !== undefined && value.candidate_sha !== expected.candidate) {
    fail("google_drive_uat_plan_lineage_mismatch");
  }
  if (expected.projectId !== undefined && value.project_id !== expected.projectId) {
    fail("google_drive_uat_plan_lineage_mismatch");
  }
  if (expected.deployment !== undefined && value.deployment_id !== expected.deployment) {
    fail("google_drive_uat_plan_lineage_mismatch");
  }
  return deepFreeze(structuredClone(value));
}

export function validateGoogleDriveUatSitesReadback(value, expected, archiveBytes) {
  exactKeys(value, [
    "schema",
    "generator",
    "status",
    "candidate_sha",
    "project_id",
    "version_id",
    "project_status",
    "version_source_candidate_sha",
    "deployment_before",
    "redeploy_start",
    "deployment_after",
    "archive_size",
    "archive_sha256",
    "observed_at_utc",
    "raw_observation_refs",
    "artifact_sha256",
  ], "invalid_google_drive_uat_sites_readback");
  signed(value, "invalid_google_drive_uat_sites_readback");
  for (const deployment of [value.deployment_before, value.redeploy_start, value.deployment_after]) {
    exactKeys(deployment, ["id", "status", "updated_at_utc"],
      "invalid_google_drive_uat_sites_readback");
    deploymentId(deployment.id, "invalid_google_drive_uat_sites_readback");
    utc(deployment.updated_at_utc, "invalid_google_drive_uat_sites_readback");
  }
  if (value.schema !== GOOGLE_DRIVE_UAT_SITES_READBACK_SCHEMA ||
      value.generator !== "codex-sites-connector-same-run-readback/v1" ||
      value.status !== "observed" || value.candidate_sha !== expected.candidate ||
      value.project_id !== expected.projectId || value.project_status !== "active" ||
      value.version_source_candidate_sha !== expected.candidate ||
      value.deployment_before.id !== expected.deployment ||
      !VERSION_ID.test(value.version_id ?? "") ||
      value.deployment_before.status !== "succeeded" ||
      !["pending", "building", "publishing", "succeeded"].includes(value.redeploy_start.status) ||
      value.deployment_after.status !== "succeeded" ||
      value.deployment_after.id === value.deployment_before.id ||
      value.redeploy_start.id !== value.deployment_after.id ||
      Date.parse(value.redeploy_start.updated_at_utc) < Date.parse(value.deployment_before.updated_at_utc) ||
      Date.parse(value.deployment_after.updated_at_utc) < Date.parse(value.redeploy_start.updated_at_utc) ||
      !Number.isSafeInteger(value.archive_size) || value.archive_size !== archiveBytes.byteLength ||
      value.archive_sha256 !== `sha256:${createHash("sha256").update(archiveBytes).digest("hex")}`) {
    fail("invalid_google_drive_uat_sites_readback");
  }
  utc(value.observed_at_utc, "invalid_google_drive_uat_sites_readback");
  if (Date.parse(value.observed_at_utc) < Date.parse(value.deployment_after.updated_at_utc)) {
    fail("invalid_google_drive_uat_sites_readback");
  }
  validateRawObservationRefs(value.raw_observation_refs, "invalid_google_drive_uat_sites_readback");
  return deepFreeze(structuredClone(value));
}

function validateSnapshot(snapshot, code) {
  exactKeys(snapshot, ["sha256", "size"], code);
  sha256(snapshot.sha256, code);
  if (!Number.isSafeInteger(snapshot.size) || snapshot.size < 1 || snapshot.size > 268_435_456) fail(code);
  return snapshot;
}

function validateProviderFixture(value, expectedFixture, code) {
  exactKeys(value, [
    "fixture_id",
    "selector_kind",
    "object_count",
    "url_query_or_folder_selector_used",
    "actor_owned_run_scoped_grant",
    "source_media_type",
    "representation_kind",
    "provider_method",
    "metadata_supports_all_drives",
    "content_supports_all_drives",
    "shared_drive",
    "export_format",
    "export_media_type",
    "provider_query_keys",
    "snapshot_stable_before_and_after",
    "metadata_observation_sha256",
    "source_snapshot",
    "staged_snapshot",
  ], code);
  if (value.fixture_id !== expectedFixture.id ||
      value.selector_kind !== "exact_object_id" || value.object_count !== 1 ||
      value.url_query_or_folder_selector_used !== false ||
      value.actor_owned_run_scoped_grant !== true ||
      value.source_media_type !== expectedFixture.source_media_type ||
      value.representation_kind !== expectedFixture.representation.kind ||
      value.provider_method !== expectedFixture.representation.provider_method ||
      value.metadata_supports_all_drives !== true ||
      value.snapshot_stable_before_and_after !== true ||
      !SHA256.test(value.metadata_observation_sha256 ?? "")) fail(code);
  validateSnapshot(value.source_snapshot, code);
  validateSnapshot(value.staged_snapshot, code);
  if (value.source_snapshot.sha256 !== value.staged_snapshot.sha256 ||
      value.source_snapshot.size !== value.staged_snapshot.size) fail(code);
  if (expectedFixture.kind === "binary") {
    if (value.shared_drive !== false || value.content_supports_all_drives !== true ||
        value.export_format !== null || value.export_media_type !== null ||
        value.source_snapshot.sha256 !== expectedFixture.expected_source_sha256 ||
        value.source_snapshot.size !== expectedFixture.expected_source_size ||
        JSON.stringify(value.provider_query_keys) !==
          JSON.stringify(["alt", "supportsAllDrives"])) fail(code);
  } else if (value.shared_drive !== true || value.content_supports_all_drives !== false ||
      value.export_format !== expectedFixture.representation.format ||
      value.export_media_type !== expectedFixture.representation.export_media_type ||
      JSON.stringify(value.provider_query_keys) !== JSON.stringify(["mimeType"])) fail(code);
  return value;
}

function validateNegativeMatrix(value, code) {
  if (!Array.isArray(value) || value.length !== GOOGLE_DRIVE_UAT_NEGATIVE_CASES.length) fail(code);
  value.forEach((entry, index) => {
    const expected = GOOGLE_DRIVE_UAT_NEGATIVE_CASES[index];
    exactKeys(entry, [
      "id",
      "status",
      "product_code",
      "retryable",
      "provider_fetch_started",
      "indistinguishable",
      "no_staged_state",
      "no_head_change",
      "raw_observation_sha256",
    ], code);
    if (entry.id !== expected.id || entry.status !== "passed" ||
        entry.product_code !== expected.code || entry.retryable !== expected.retryable ||
        entry.provider_fetch_started !== expected.providerFetch ||
        entry.indistinguishable !== expected.indistinguishable ||
        entry.no_staged_state !== true || entry.no_head_change !== true) fail(code);
    sha256(entry.raw_observation_sha256, code);
  });
  return value;
}

export function validateGoogleDriveUatProviderReadback(value, expected, fixturePlan) {
  exactKeys(value, [
    "schema",
    "generator",
    "status",
    "candidate_sha",
    "deployment_before_id",
    "deployment_after_id",
    "runner_id",
    "run_fingerprint",
    "provider",
    "persistent_scope_changed",
    "observed_at_utc",
    "fixtures",
    "negative_matrix",
    "assertions",
    "raw_observation_refs",
    "artifact_sha256",
  ], "invalid_google_drive_uat_provider_readback");
  signed(value, "invalid_google_drive_uat_provider_readback");
  if (value.schema !== GOOGLE_DRIVE_UAT_PROVIDER_READBACK_SCHEMA ||
      value.generator !== "direct-same-run-google-drive-observation/v1" ||
      value.status !== "observed" || value.candidate_sha !== expected.candidate ||
      value.deployment_before_id !== expected.deploymentBefore ||
      value.deployment_after_id !== expected.deploymentAfter ||
      value.runner_id !== GOOGLE_DRIVE_UAT_RUNNER_ID ||
      value.run_fingerprint !== expected.runFingerprint ||
      value.provider !== "google_drive" || value.persistent_scope_changed !== false ||
      !Array.isArray(value.fixtures) || value.fixtures.length !== fixturePlan.fixtures.length) {
    fail("invalid_google_drive_uat_provider_readback");
  }
  utc(value.observed_at_utc, "invalid_google_drive_uat_provider_readback");
  if (Date.parse(value.observed_at_utc) < Date.parse(expected.sitesObservedAt)) {
    fail("invalid_google_drive_uat_provider_readback");
  }
  value.fixtures.forEach((fixture, index) => validateProviderFixture(
    fixture,
    fixturePlan.fixtures[index],
    "invalid_google_drive_uat_provider_readback",
  ));
  validateNegativeMatrix(value.negative_matrix, "invalid_google_drive_uat_provider_readback");
  validateAssertionRegistry(
    value.assertions,
    PROVIDER_ASSERTION_IDS,
    "passed",
    "invalid_google_drive_uat_provider_readback",
  );
  validateRawObservationRefs(value.raw_observation_refs, "invalid_google_drive_uat_provider_readback");
  return deepFreeze(structuredClone(value));
}

function validateLifecycleFixture(value, expectedProviderFixture, code) {
  exactKeys(value, [
    "fixture_id",
    "source_kind",
    "staged_snapshot",
    "one_head_transition",
    "revision_fingerprint",
    "history_revision_visible",
    "history_observation_sha256",
    "download_snapshot",
    "web_export_entry_snapshot",
    "web_export_archive_sha256",
    "web_export_actor_owned",
    "redeploy_readback_visible",
  ], code);
  if (value.fixture_id !== expectedProviderFixture.fixture_id ||
      value.source_kind !== "connector_object" || value.one_head_transition !== true ||
      value.history_revision_visible !== true || value.redeploy_readback_visible !== true ||
      !SHA256.test(value.revision_fingerprint ?? "") ||
      !SHA256.test(value.history_observation_sha256 ?? "")) fail(code);
  for (const snapshotName of ["staged_snapshot", "download_snapshot", "web_export_entry_snapshot"]) {
    validateSnapshot(value[snapshotName], code);
    if (value[snapshotName].sha256 !== expectedProviderFixture.staged_snapshot.sha256 ||
        value[snapshotName].size !== expectedProviderFixture.staged_snapshot.size) fail(code);
  }
  if (value.web_export_actor_owned !== true || !SHA256.test(value.web_export_archive_sha256 ?? "")) fail(code);
  return value;
}

export function validateGoogleDriveUatProductReadback(value, expected, provider) {
  exactKeys(value, [
    "schema",
    "generator",
    "status",
    "candidate_sha",
    "deployment_before_id",
    "deployment_after_id",
    "runner_id",
    "run_fingerprint",
    "observed_at_utc",
    "target_preflight",
    "lifecycle",
    "content_mcp",
    "cleanup",
    "assertions",
    "raw_observation_refs",
    "artifact_sha256",
  ], "invalid_google_drive_uat_product_readback");
  signed(value, "invalid_google_drive_uat_product_readback");
  exactKeys(value.target_preflight, [
    "server_derived_current_target",
    "caller_owner_generation_or_version_absent",
    "authorization_before_provider_read",
    "concurrent_target_change_fail_closed",
  ], "invalid_google_drive_uat_product_readback");
  exactKeys(value.content_mcp, [
    "administrative_export_absent",
    "connector_locator_absent",
  ], "invalid_google_drive_uat_product_readback");
  exactKeys(value.cleanup, [
    "provider_objects_absent",
    "run_grant_revoked",
    "next_request_denied",
    "run_mind_absent",
    "staged_state_absent",
    "jobs_and_download_grants_absent",
  ], "invalid_google_drive_uat_product_readback");
  if (value.schema !== GOOGLE_DRIVE_UAT_PRODUCT_READBACK_SCHEMA ||
      value.generator !== "direct-same-run-mind-diary-observation/v1" ||
      value.status !== "observed" || value.candidate_sha !== expected.candidate ||
      value.deployment_before_id !== expected.deploymentBefore ||
      value.deployment_after_id !== expected.deploymentAfter ||
      value.runner_id !== GOOGLE_DRIVE_UAT_RUNNER_ID ||
      value.run_fingerprint !== expected.runFingerprint ||
      value.target_preflight?.server_derived_current_target !== true ||
      value.target_preflight?.caller_owner_generation_or_version_absent !== true ||
      value.target_preflight?.authorization_before_provider_read !== true ||
      value.target_preflight?.concurrent_target_change_fail_closed !== true ||
      !Array.isArray(value.lifecycle) || value.lifecycle.length !== provider.fixtures.length ||
      value.content_mcp?.administrative_export_absent !== true ||
      value.content_mcp?.connector_locator_absent !== true ||
      value.cleanup?.provider_objects_absent !== true ||
      value.cleanup?.run_grant_revoked !== true ||
      value.cleanup?.next_request_denied !== true ||
      value.cleanup?.run_mind_absent !== true ||
      value.cleanup?.staged_state_absent !== true ||
      value.cleanup?.jobs_and_download_grants_absent !== true) {
    fail("invalid_google_drive_uat_product_readback");
  }
  utc(value.observed_at_utc, "invalid_google_drive_uat_product_readback");
  if (Date.parse(value.observed_at_utc) < Date.parse(expected.providerObservedAt)) {
    fail("invalid_google_drive_uat_product_readback");
  }
  value.lifecycle.forEach((fixture, index) => validateLifecycleFixture(
    fixture,
    provider.fixtures[index],
    "invalid_google_drive_uat_product_readback",
  ));
  validateAssertionRegistry(
    value.assertions,
    PRODUCT_ASSERTION_IDS,
    "passed",
    "invalid_google_drive_uat_product_readback",
  );
  validateRawObservationRefs(value.raw_observation_refs, "invalid_google_drive_uat_product_readback");
  return deepFreeze(structuredClone(value));
}

export function validateGoogleDriveUatBlocker(value, assertionIds = GOOGLE_DRIVE_UAT_ASSERTION_IDS) {
  exactKeys(value, ["category", "code", "affected_assertion_ids", "resume_signal"],
    "invalid_google_drive_uat_blocker");
  if (!GOOGLE_DRIVE_UAT_BLOCKER_CATEGORIES.includes(value.category) ||
      !SAFE_CODE.test(value.code ?? "") || !SAFE_CODE.test(value.resume_signal ?? "") ||
      !Array.isArray(value.affected_assertion_ids) || value.affected_assertion_ids.length < 1 ||
      value.affected_assertion_ids.some((id) => !assertionIds.includes(id)) ||
      new Set(value.affected_assertion_ids).size !== value.affected_assertion_ids.length) {
    fail("invalid_google_drive_uat_blocker");
  }
  assertPrivacySafe(value);
  return deepFreeze(structuredClone(value));
}

export function createGoogleDriveUatStructuralJoin({
  planReceipt,
  sitesReadback,
  providerReadback,
  productReadback,
  archiveBytes,
  fixturePlan,
}, expected) {
  const plan = validateGoogleDriveUatPlanReceipt(planReceipt, expected);
  const sites = validateGoogleDriveUatSitesReadback(sitesReadback, {
    candidate: plan.candidate_sha,
    projectId: plan.project_id,
    deployment: plan.deployment_id,
  }, archiveBytes);
  const fixtures = validateGoogleDriveUatFixturePlan(fixturePlan);
  if (plan.fixture_plan_sha256 !== fixtures.artifact_sha256) fail("fixture_plan_lineage_mismatch");
  const provider = validateGoogleDriveUatProviderReadback(providerReadback, {
    candidate: plan.candidate_sha,
    deploymentBefore: sites.deployment_before.id,
    deploymentAfter: sites.deployment_after.id,
    runFingerprint: plan.run_fingerprint,
    sitesObservedAt: sites.observed_at_utc,
  }, fixtures);
  const product = validateGoogleDriveUatProductReadback(productReadback, {
    candidate: plan.candidate_sha,
    deploymentBefore: sites.deployment_before.id,
    deploymentAfter: sites.deployment_after.id,
    runFingerprint: plan.run_fingerprint,
    providerObservedAt: provider.observed_at_utc,
  }, provider);
  return sign({
    schema: GOOGLE_DRIVE_UAT_JOIN_SCHEMA,
    status: "structurally_verified_readback",
    hosted_evidence: false,
    acceptance: "nonterminal",
    provenance: "unverified-local-files",
    candidate_sha: plan.candidate_sha,
    project_id: plan.project_id,
    deployment_before_id: sites.deployment_before.id,
    deployment_after_id: sites.deployment_after.id,
    version_id: sites.version_id,
    runner_id: GOOGLE_DRIVE_UAT_RUNNER_ID,
    run_fingerprint: plan.run_fingerprint,
    byte_bindings: {
      site_archive_sha256: sites.archive_sha256,
      plan_receipt_sha256: plan.artifact_sha256,
      fixture_plan_sha256: fixtures.artifact_sha256,
      sites_readback_sha256: sites.artifact_sha256,
      provider_readback_sha256: provider.artifact_sha256,
      product_readback_sha256: product.artifact_sha256,
    },
    fixture_snapshots: provider.fixtures.map((fixture) => ({
      fixture_id: fixture.fixture_id,
      sha256: fixture.staged_snapshot.sha256,
      size: fixture.staged_snapshot.size,
    })),
    assertions: GOOGLE_DRIVE_UAT_ASSERTION_IDS.map((id) => ({ id, status: "passed" })),
    cleanup: structuredClone(product.cleanup),
    terminal_evidence_rule:
      "direct_same_run_orchestrator_observation_required_local_join_cannot_pass_hosted_acceptance",
  });
}

export function validateGoogleDriveUatStructuralJoin(value, inputs, expected) {
  const recreated = createGoogleDriveUatStructuralJoin(inputs, expected);
  if (canonical(recreated) !== canonical(value)) fail("invalid_google_drive_uat_structural_join");
  return recreated;
}

export function signGoogleDriveUatTestArtifact(unsigned) {
  return sign(unsigned);
}
