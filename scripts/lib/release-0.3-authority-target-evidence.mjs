import { createHash } from "node:crypto";

import {
  OAUTH_DIRECT_PLUGIN_ASSERTION_IDS,
} from "../run-oauth-direct-plugin-probe.mjs";
import {
  SYNTHETIC_ASSERTION_IDS,
  assertRedactedDocument,
  canonical,
  isRecord,
} from "./multi-principal-probe-core.mjs";
import { EXPECTED_MCP_TOOL_NAMES } from "./exact-mcp-tool-inventory.mjs";
import { verifyUatTestAccountPoolReadinessReceipt } from "./uat-test-account-pool-contract.mjs";

export const RELEASE_03_AUTHORITY_TARGET_RUNNER_ID =
  "ship-work-release/uat-release-0.3-authority-target/v1";
export const RELEASE_03_AUTHORITY_TARGET_LOCAL_SCHEMA =
  "mind-diary/release-0.3-authority-target-local-evidence/v1";
export const RELEASE_03_AUTHORITY_TARGET_OBSERVATION_SCHEMA =
  "mind-diary/uat-release-0.3-authority-target-observation/v1";
export const RELEASE_03_AUTHORITY_TARGET_JOIN_SCHEMA =
  "mind-diary/uat-release-0.3-authority-target-evidence/v1";

export const RELEASE_03_LOCAL_ASSERTION_IDS = Object.freeze([
  "local.synthetic-identity-constructor-only",
  "local.personal-membership-public-unlisted-private",
  "local.membership-visibility-revoke-immediate",
  "local.owner-isolation-oauth-and-personal-token",
  "local.modern-compat-catalog-exact-18",
  "local.target-exact-generation-stale-head-wrong-mind",
  "local.fresh-reconnect-reissue-empty-target",
  "local.legacy-and-same-owner-upgrade",
  "local.capture-no-transfer",
  "local.retired-binding-and-export-tools-absent",
  "local.exact-source-and-test-hashes",
]);

export const RELEASE_03_LOCAL_TEST_PATHS = Object.freeze([
  "tests/conformance/credential-write-target-contract.test.mjs",
  "tests/integration/credential-write-target-state.test.mjs",
  "tests/conformance/mcp-binding-tools.test.mjs",
  "tests/conformance/mcp-export-move.test.mjs",
  "tests/conformance/release-0.3-operation-disposition-contract.test.mjs",
  "tests/conformance/release-0.3-authority-target-evidence.test.mjs",
]);

export const RELEASE_03_LOCAL_SOURCE_PATHS = Object.freeze([
  "scripts/lib/exact-mcp-tool-inventory.mjs",
  "scripts/lib/multi-principal-probe-core.mjs",
  "scripts/lib/release-0.3-authority-target-evidence.mjs",
  "scripts/run-synthetic-multi-principal-probe.mjs",
  "scripts/run-oauth-direct-plugin-probe.mjs",
  "scripts/run-release-0.3-authority-target-local-gate.mjs",
  "tests/fixtures/credential-write-target/contract.v1.json",
  "tests/fixtures/release-0.3-operation-disposition/contract.v1.json",
  "tests/fixtures/release-0.3-authority-target/contract.v1.json",
  ...RELEASE_03_LOCAL_TEST_PATHS,
]);

export const RELEASE_03_HOSTED_CREDENTIAL_CASE_IDS = Object.freeze([
  "fresh-oauth-empty-target",
  "legacy-oauth-pending-upgrade",
  "same-owner-oauth-upgrade-preserves-space-new-generation",
  "oauth-reconnect-empty-target",
  "fresh-personal-token-empty-target",
  "legacy-personal-token-pending-upgrade",
  "personal-token-reissue-empty-target",
  "capture-no-transfer",
]);

export const RELEASE_03_HOSTED_AUTHORITY_CASE_IDS = Object.freeze([
  "personal-discovery",
  "membership-discovery",
  "public-discovery",
  "unlisted-exact-discovery",
  "private-non-enumeration",
  "membership-change-immediate",
  "visibility-change-immediate",
  "credential-revoke-next-request",
  "oauth-owner-isolation",
  "personal-token-owner-isolation",
  "exact-target-generation",
  "stale-head-no-side-effect",
  "wrong-mind-no-side-effect",
  "retired-binding-tools-absent",
  "moved-export-tools-absent",
]);

export const RELEASE_03_FINAL_ASSERTION_IDS = Object.freeze([
  "r03.authority.surface-separation",
  "r03.authority.operation-disposition",
  "r03.traceability.closed-registry",
  "r03.target.accepted-contract",
  "r03.target.storage-migration",
  "r03.reads.current-acl",
  "r03.mcp.catalog-closed",
  "r03.target.lifecycle",
  "r03.target.uat-joined",
]);

const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const DEPLOYMENT = /^appgdep_[a-z0-9]+$/u;
const SITE_PROJECT = /^appgprj_[a-z0-9]+$/u;
const SITE_VERSION = /^(?:appgver_[a-z0-9]+|appgprj_[a-z0-9]+~appgver_[a-z0-9]+)$/u;
const ACTOR_FINGERPRINT = /^actor-[a-z0-9]{16,64}$/u;
const RUN_FINGERPRINT = /^uatauth-run-[0-9a-f]{32}$/u;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

export class Release03AuthorityTargetEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = "Release03AuthorityTargetEvidenceError";
    this.code = code;
  }
}

function fail(code) {
  throw new Release03AuthorityTargetEvidenceError(code);
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function exactKeys(value, expected) {
  return isRecord(value) &&
    Object.keys(value).length === expected.length &&
    Object.keys(value).every((key) => expected.includes(key));
}

function assertionRows(ids) {
  return ids.map((id) => Object.freeze({ id, status: "passed" }));
}

function exactPassedRows(value, ids) {
  return Array.isArray(value) && canonical(value) === canonical(assertionRows(ids));
}

function exactCaseRows(value, ids) {
  return Array.isArray(value) && canonical(value) === canonical(assertionRows(ids));
}

function utcInstant(value) {
  if (
    typeof value !== "string" ||
    !UTC_INSTANT.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) fail("invalid_observed_at_utc");
  return value;
}

function assertArtifact(value, code) {
  if (!SHA256.test(value?.artifact_sha256)) fail(code);
  const { artifact_sha256: artifact, ...unsigned } = value;
  if (artifact !== digest(canonical(unsigned))) fail(code);
}

function assertSourceMap(value, code) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== RELEASE_03_LOCAL_SOURCE_PATHS.length ||
    Object.keys(value).some((path) => !RELEASE_03_LOCAL_SOURCE_PATHS.includes(path))
  ) fail(code);
  for (const [path, hash] of Object.entries(value)) {
    if (
      !/^(?:scripts|tests|docs)\/[a-zA-Z0-9._/-]+$/u.test(path) ||
      path.includes("..") ||
      !SHA256.test(hash)
    ) fail(code);
  }
}

function verifyProbeReceipt(value, { schema, assertions, candidateSha, kind }) {
  if (
    !isRecord(value) ||
    value.schema !== schema ||
    value.status !== "passed" ||
    value.candidate_sha !== candidateSha ||
    !exactPassedRows(value.assertions, assertions)
  ) fail(`invalid_${kind}_receipt`);
  assertArtifact(value, `invalid_${kind}_receipt_hash`);
  assertRedactedDocument(value);
  return value;
}

export function createRelease03AuthorityTargetLocalEvidence(input) {
  if (!SHA.test(input.candidateSha)) fail("invalid_candidate_sha");
  const synthetic = verifyProbeReceipt(input.syntheticEvidence, {
    schema: "mind-diary/synthetic-multi-principal-evidence/v1",
    assertions: SYNTHETIC_ASSERTION_IDS,
    candidateSha: input.candidateSha,
    kind: "synthetic",
  });
  const oauth = verifyProbeReceipt(input.oauthEvidence, {
    schema: "mind-diary/oauth-direct-plugin-evidence/v1",
    assertions: OAUTH_DIRECT_PLUGIN_ASSERTION_IDS,
    candidateSha: input.candidateSha,
    kind: "oauth",
  });
  if (
    !Array.isArray(input.tests) ||
    input.tests.length !== RELEASE_03_LOCAL_TEST_PATHS.length ||
    input.tests.some((row, index) =>
      !exactKeys(row, ["path", "status", "stdout_sha256"]) ||
      row.path !== RELEASE_03_LOCAL_TEST_PATHS[index] ||
      row.status !== "passed" ||
      !SHA256.test(row.stdout_sha256))
  ) fail("invalid_local_test_receipts");
  assertSourceMap(input.sourceHashes, "invalid_local_source_hashes");
  const unsigned = Object.freeze({
    schema: RELEASE_03_AUTHORITY_TARGET_LOCAL_SCHEMA,
    status: "passed",
    release: "0.3",
    candidate_sha: input.candidateSha,
    runner_id: RELEASE_03_AUTHORITY_TARGET_RUNNER_ID,
    hosted_status: "not-run",
    inputs: Object.freeze({
      synthetic_evidence_sha256: synthetic.artifact_sha256,
      oauth_evidence_sha256: oauth.artifact_sha256,
    }),
    assertions: Object.freeze(assertionRows(RELEASE_03_LOCAL_ASSERTION_IDS)),
    tests: Object.freeze(input.tests.map((row) => Object.freeze({ ...row }))),
    source_hashes: Object.freeze({ ...input.sourceHashes }),
    started_at: utcInstant(input.startedAt),
    completed_at: utcInstant(input.completedAt),
  });
  return Object.freeze(assertRedactedDocument({
    ...unsigned,
    artifact_sha256: digest(canonical(unsigned)),
  }));
}

export function verifyRelease03AuthorityTargetLocalEvidence(value) {
  if (
    !exactKeys(value, [
      "schema", "status", "release", "candidate_sha", "runner_id", "hosted_status",
      "inputs", "assertions", "tests", "source_hashes", "started_at", "completed_at",
      "artifact_sha256",
    ]) ||
    value.schema !== RELEASE_03_AUTHORITY_TARGET_LOCAL_SCHEMA ||
    value.status !== "passed" ||
    value.release !== "0.3" ||
    !SHA.test(value.candidate_sha) ||
    value.runner_id !== RELEASE_03_AUTHORITY_TARGET_RUNNER_ID ||
    value.hosted_status !== "not-run" ||
    !exactKeys(value.inputs, ["synthetic_evidence_sha256", "oauth_evidence_sha256"]) ||
    Object.values(value.inputs).some((hash) => !SHA256.test(hash)) ||
    !exactPassedRows(value.assertions, RELEASE_03_LOCAL_ASSERTION_IDS) ||
    !Array.isArray(value.tests) || value.tests.length !== RELEASE_03_LOCAL_TEST_PATHS.length ||
    value.tests.some((row, index) =>
      !exactKeys(row, ["path", "status", "stdout_sha256"]) ||
      row.path !== RELEASE_03_LOCAL_TEST_PATHS[index] ||
      row.status !== "passed" || !SHA256.test(row.stdout_sha256))
  ) fail("invalid_local_evidence");
  assertSourceMap(value.source_hashes, "invalid_local_source_hashes");
  utcInstant(value.started_at);
  utcInstant(value.completed_at);
  assertArtifact(value, "invalid_local_evidence_hash");
  assertRedactedDocument(value);
  return Object.freeze(structuredClone(value));
}

function verifyCatalogReadBack(value) {
  if (!exactKeys(value, ["modern", "compatibility"])) fail("invalid_catalog_read_back");
  for (const profile of ["modern", "compatibility"]) {
    const row = value[profile];
    if (
      !exactKeys(row, ["protocol", "tool_names", "retired_binding_tools_absent", "moved_export_tools_absent"]) ||
      row.protocol !== (profile === "modern" ? "2026-07-28" : "2025-11-25") ||
      canonical(row.tool_names) !== canonical(EXPECTED_MCP_TOOL_NAMES) ||
      row.retired_binding_tools_absent !== true ||
      row.moved_export_tools_absent !== true
    ) fail("invalid_catalog_read_back");
  }
  return value;
}

function verifySurfaceReadBack(value) {
  const expected = [
    { id: "oauth-connection", status: "passed" },
    { id: "personal-token-advanced-mcp", status: "passed" },
  ];
  if (canonical(value) !== canonical(expected)) fail("invalid_web_surface_read_back");
  return value;
}

function verifyImmutableRevisionReadBack(value) {
  if (
    !exactKeys(value, [
      "commit_status", "head_matches_commit", "history_matches_commit",
      "fetch_matches_commit", "content_sha256",
    ]) ||
    value.commit_status !== "committed" ||
    value.head_matches_commit !== true ||
    value.history_matches_commit !== true ||
    value.fetch_matches_commit !== true ||
    !SHA256.test(value.content_sha256)
  ) fail("invalid_immutable_revision_read_back");
  return value;
}

function verifyCleanup(value) {
  if (
    !exactKeys(value, [
      "status", "credentials_revoked_next_request_denied", "run_mind_absent",
      "pool_baseline_unchanged",
    ]) ||
    value.status !== "passed" ||
    value.credentials_revoked_next_request_denied !== true ||
    value.run_mind_absent !== true ||
    value.pool_baseline_unchanged !== true
  ) fail("invalid_cleanup_read_back");
  return value;
}

function verifyDeploymentReadBack(value) {
  if (
    !exactKeys(value, ["site_project_id", "site_version_id", "archive_sha256"]) ||
    !SITE_PROJECT.test(value.site_project_id) ||
    !SITE_VERSION.test(value.site_version_id) ||
    !SHA256.test(value.archive_sha256)
  ) fail("invalid_deployment_read_back");
  return value;
}

export function createRelease03AuthorityTargetHostedObservation(input) {
  if (!SHA.test(input.candidateSha)) fail("invalid_candidate_sha");
  if (!DEPLOYMENT.test(input.deploymentId)) fail("invalid_deployment_id");
  if (!RUN_FINGERPRINT.test(input.runFingerprint)) fail("invalid_run_fingerprint");
  if (
    !Array.isArray(input.actorFingerprints) ||
    input.actorFingerprints.length !== 3 ||
    new Set(input.actorFingerprints).size !== 3 ||
    input.actorFingerprints.some((value) => !ACTOR_FINGERPRINT.test(value))
  ) fail("invalid_actor_fingerprints");
  verifyDeploymentReadBack(input.deploymentReadBack);
  verifyCatalogReadBack(input.catalogs);
  verifySurfaceReadBack(input.webSurfaces);
  verifyImmutableRevisionReadBack(input.immutableRevision);
  verifyCleanup(input.cleanup);
  if (!exactCaseRows(input.credentialCases, RELEASE_03_HOSTED_CREDENTIAL_CASE_IDS)) {
    fail("invalid_credential_cases");
  }
  if (!exactCaseRows(input.authorityCases, RELEASE_03_HOSTED_AUTHORITY_CASE_IDS)) {
    fail("invalid_authority_cases");
  }
  const unsigned = Object.freeze({
    schema: RELEASE_03_AUTHORITY_TARGET_OBSERVATION_SCHEMA,
    status: "passed",
    environment: "uat",
    production_excluded: true,
    candidate_sha: input.candidateSha,
    deployment_id: input.deploymentId,
    runner_id: RELEASE_03_AUTHORITY_TARGET_RUNNER_ID,
    run_fingerprint: input.runFingerprint,
    actor_fingerprints: Object.freeze([...input.actorFingerprints]),
    deployment_read_back: Object.freeze({ ...input.deploymentReadBack }),
    web_surfaces: Object.freeze(input.webSurfaces.map((row) => Object.freeze({ ...row }))),
    catalogs: Object.freeze(structuredClone(input.catalogs)),
    credential_cases: Object.freeze(input.credentialCases.map((row) => Object.freeze({ ...row }))),
    authority_cases: Object.freeze(input.authorityCases.map((row) => Object.freeze({ ...row }))),
    immutable_revision: Object.freeze({ ...input.immutableRevision }),
    cleanup: Object.freeze({ ...input.cleanup }),
    observed_at_utc: utcInstant(input.observedAtUtc),
  });
  return Object.freeze(assertRedactedDocument({
    ...unsigned,
    artifact_sha256: digest(canonical(unsigned)),
  }));
}

export function verifyRelease03AuthorityTargetHostedObservation(value) {
  if (
    !exactKeys(value, [
      "schema", "status", "environment", "production_excluded", "candidate_sha",
      "deployment_id", "runner_id", "run_fingerprint", "actor_fingerprints",
      "deployment_read_back", "web_surfaces", "catalogs", "credential_cases",
      "authority_cases", "immutable_revision", "cleanup", "observed_at_utc",
      "artifact_sha256",
    ]) ||
    value.schema !== RELEASE_03_AUTHORITY_TARGET_OBSERVATION_SCHEMA ||
    value.status !== "passed" || value.environment !== "uat" ||
    value.production_excluded !== true || !SHA.test(value.candidate_sha) ||
    !DEPLOYMENT.test(value.deployment_id) ||
    value.runner_id !== RELEASE_03_AUTHORITY_TARGET_RUNNER_ID ||
    !RUN_FINGERPRINT.test(value.run_fingerprint) ||
    !Array.isArray(value.actor_fingerprints) || value.actor_fingerprints.length !== 3 ||
    new Set(value.actor_fingerprints).size !== 3 ||
    value.actor_fingerprints.some((fingerprint) => !ACTOR_FINGERPRINT.test(fingerprint)) ||
    !exactCaseRows(value.credential_cases, RELEASE_03_HOSTED_CREDENTIAL_CASE_IDS) ||
    !exactCaseRows(value.authority_cases, RELEASE_03_HOSTED_AUTHORITY_CASE_IDS)
  ) fail("invalid_hosted_observation");
  verifySurfaceReadBack(value.web_surfaces);
  verifyCatalogReadBack(value.catalogs);
  verifyDeploymentReadBack(value.deployment_read_back);
  verifyImmutableRevisionReadBack(value.immutable_revision);
  verifyCleanup(value.cleanup);
  utcInstant(value.observed_at_utc);
  assertArtifact(value, "invalid_hosted_observation_hash");
  assertRedactedDocument(value);
  return Object.freeze(structuredClone(value));
}

export function createRelease03AuthorityTargetUatJoin(input) {
  let local;
  let pool;
  let hosted;
  try {
    local = verifyRelease03AuthorityTargetLocalEvidence(input.localEvidence);
    pool = verifyUatTestAccountPoolReadinessReceipt(input.poolEvidence);
    hosted = verifyRelease03AuthorityTargetHostedObservation(input.hostedObservation);
  } catch {
    fail("invalid_join_input_receipt");
  }
  if (new Set([local.candidate_sha, pool.candidate_sha, hosted.candidate_sha]).size !== 1) {
    fail("candidate_lineage_mismatch");
  }
  if (pool.deployment_id !== hosted.deployment_id) fail("deployment_lineage_mismatch");
  const poolFingerprints = pool.actors.map((actor) => actor.actor_fingerprint);
  if (canonical(poolFingerprints) !== canonical(hosted.actor_fingerprints)) {
    fail("actor_pool_lineage_mismatch");
  }
  const unsigned = Object.freeze({
    schema: RELEASE_03_AUTHORITY_TARGET_JOIN_SCHEMA,
    status: "passed",
    candidate_sha: hosted.candidate_sha,
    deployment_id: hosted.deployment_id,
    runner_id: RELEASE_03_AUTHORITY_TARGET_RUNNER_ID,
    actor_fingerprints: Object.freeze([...hosted.actor_fingerprints]),
    assertions: Object.freeze(assertionRows(RELEASE_03_FINAL_ASSERTION_IDS)),
    read_back: Object.freeze({
      local_evidence_sha256: local.artifact_sha256,
      pool_readiness_sha256: pool.artifact_sha256,
      hosted_observation_sha256: hosted.artifact_sha256,
      deployment: Object.freeze({ ...hosted.deployment_read_back }),
      web_surfaces: Object.freeze(structuredClone(hosted.web_surfaces)),
      modern_tool_count: hosted.catalogs.modern.tool_names.length,
      compatibility_tool_count: hosted.catalogs.compatibility.tool_names.length,
      immutable_revision: Object.freeze({ ...hosted.immutable_revision }),
      run_fingerprint: hosted.run_fingerprint,
      observed_at_utc: hosted.observed_at_utc,
    }),
    cleanup: Object.freeze({ ...hosted.cleanup }),
  });
  return Object.freeze(assertRedactedDocument({
    ...unsigned,
    artifact_sha256: digest(canonical(unsigned)),
  }));
}

export function verifyRelease03AuthorityTargetUatJoin(value) {
  if (
    !exactKeys(value, [
      "schema", "status", "candidate_sha", "deployment_id", "runner_id",
      "actor_fingerprints", "assertions", "read_back", "cleanup", "artifact_sha256",
    ]) ||
    value.schema !== RELEASE_03_AUTHORITY_TARGET_JOIN_SCHEMA ||
    value.status !== "passed" || !SHA.test(value.candidate_sha) ||
    !DEPLOYMENT.test(value.deployment_id) ||
    value.runner_id !== RELEASE_03_AUTHORITY_TARGET_RUNNER_ID ||
    !Array.isArray(value.actor_fingerprints) || value.actor_fingerprints.length !== 3 ||
    new Set(value.actor_fingerprints).size !== 3 ||
    value.actor_fingerprints.some((fingerprint) => !ACTOR_FINGERPRINT.test(fingerprint)) ||
    !exactPassedRows(value.assertions, RELEASE_03_FINAL_ASSERTION_IDS) ||
    !exactKeys(value.read_back, [
      "local_evidence_sha256", "pool_readiness_sha256", "hosted_observation_sha256",
      "deployment", "web_surfaces", "modern_tool_count",
      "compatibility_tool_count", "immutable_revision", "run_fingerprint", "observed_at_utc",
    ]) ||
    !SHA256.test(value.read_back.local_evidence_sha256) ||
    !SHA256.test(value.read_back.pool_readiness_sha256) ||
    !SHA256.test(value.read_back.hosted_observation_sha256) ||
    value.read_back.modern_tool_count !== 18 ||
    value.read_back.compatibility_tool_count !== 18 ||
    !RUN_FINGERPRINT.test(value.read_back.run_fingerprint)
  ) fail("invalid_uat_join_evidence");
  verifySurfaceReadBack(value.read_back.web_surfaces);
  verifyDeploymentReadBack(value.read_back.deployment);
  verifyImmutableRevisionReadBack(value.read_back.immutable_revision);
  verifyCleanup(value.cleanup);
  utcInstant(value.read_back.observed_at_utc);
  assertArtifact(value, "invalid_uat_join_evidence_hash");
  assertRedactedDocument(value);
  return Object.freeze(structuredClone(value));
}
