import {
  SYNTHETIC_ASSERTION_IDS,
  assertRedactedDocument,
  canonical,
  digest,
  isRecord,
} from "./multi-principal-probe-core.mjs";
import { EXPECTED_DEFAULT_MCP_TOOL_NAMES } from "./exact-mcp-tool-inventory.mjs";
import { verifyUatTestAccountPoolReadinessReceipt } from "./uat-test-account-pool-contract.mjs";

export const RELEASE_03_ACCESS_ADMIN_RUNNER_ID =
  "ship-work-release/uat-release-0.3-access-admin/v1";
export const RELEASE_03_ACCESS_ADMIN_LOCAL_SCHEMA =
  "mind-diary/release-0.3-access-admin-local-evidence/v1";
export const RELEASE_03_ACCESS_ADMIN_OBSERVATION_SCHEMA =
  "mind-diary/uat-release-0.3-access-admin-observation/v1";
export const RELEASE_03_ACCESS_ADMIN_JOIN_SCHEMA =
  "mind-diary/uat-release-0.3-access-admin-evidence/v1";

export const RELEASE_03_ACCESS_ADMIN_LOCAL_ASSERTION_IDS = Object.freeze([
  "local.three-ephemeral-principals",
  "local.browser-rest-mcp-content-carriers",
  "local.private-non-enumeration",
  "local.public-unlisted-reader-equivalent",
  "local.invitation-pending-cancel-reissue-expiry",
  "local.reader-editor-admin-role-transitions",
  "local.ownership-transfer-sole-owner",
  "local.revoke-and-leave-next-request",
  "local.no-control-plane-mcp-tools",
  "local.restart-and-cleanup",
  "local.exact-source-and-suite-hashes",
  "local.hosted-status-not-run",
]);

// MD-354 consumes the MD-300 carrier as an immutable input rather than
// importing its executable entry point. The carrier source is hash-bound in
// every local receipt, and this closed registry rejects a drifted receipt
// without making the offline join depend on built product packages.
export const RELEASE_03_EXPECTED_SYNTHETIC_BROWSER_ASSERTION_IDS = Object.freeze([
  "activation.server-bound-browser-contexts",
  "bootstrap.distinct-ordinary-principals",
  "bootstrap.distinct-personal-minds",
  "bootstrap.client-identity-selection-denied",
  "personal-isolation.session-ui-and-api",
  "private.route-and-api-non-enumeration",
  "visibility.public-ui-and-catalog",
  "visibility.unlisted-exact-ui",
  "visibility.private-immediate-revoke",
  "invitation.pending-ui-and-api-denied",
  "invitation.accept-reader",
  "role.reader-no-write",
  "role.editor-controlled-write",
  "ownership.transfer-exactly-one-owner",
  "restart.persistence",
  "operator.ui-paginated-directory",
  "operator.api-paginated-directory",
  "operator.search-sort-empty-never-active",
  "operator.ordinary-ui-denied",
  "operator.ordinary-api-denied",
  "operator.mind-role-ui-denied",
  "operator.mind-role-api-denied",
  "operator.denied-request-no-activity",
  "revoke.context-denied-after-restart",
  "cleanup.ordinary-mind-deleted",
  "cleanup.tokens-revoked",
  "cleanup.accounts-deleted",
  "cleanup.background-drained",
  "cleanup.negative-state-scan",
  "production-negative.no-synthetic-authority",
]);

export const RELEASE_03_ACCESS_ADMIN_HOSTED_ASSERTION_IDS = Object.freeze([
  "r03.access.lineage-and-three-actor-pool",
  "r03.access.private-nonmember-no-existence-leak",
  "r03.access.public-unlisted-reader-equivalent-only",
  "r03.access.pending-invitation-no-access",
  "r03.access.invitation-cancel-reissue-expiry-policy",
  "r03.access.invitation-accept-reader",
  "r03.access.reader-read-only",
  "r03.access.editor-content-write",
  "r03.access.admin-basic-membership-management",
  "r03.access.ownership-transfer-exactly-one-owner",
  "r03.access.revoke-next-request-web-rest-mcp-content",
  "r03.access.reaccept-reader-and-leave",
  "r03.access.current-role-read-back-every-state",
  "r03.access.content-mcp-catalog-excludes-control-mutations",
  "r03.access.restart-or-redeploy-current-state",
  "r03.access.run-owned-cleanup-and-pool-baseline",
]);

export const RELEASE_03_ACCESS_ADMIN_FINAL_ASSERTION_IDS = Object.freeze([
  "r03.access.overview",
  "r03.access.membership-lifecycle",
  "r03.access.ownership-transfer",
  "r03.access.uat-joined",
]);

export const RELEASE_03_ACCESS_ADMIN_LOCAL_TEST_PATHS = Object.freeze([
  "tests/unit/invitations-membership-ui.test.mjs",
  "tests/integration/invitation-control.test.mjs",
  "tests/integration/invitation-lifecycle.test.mjs",
  "tests/integration/membership-control.test.mjs",
  "tests/integration/ownership-transfer.test.mjs",
  "tests/integration/visibility-control.test.mjs",
  "tests/integration/public-minds-catalog.test.mjs",
  "tests/conformance/exposure-contract.test.mjs",
  "tests/conformance/release-0.3-access-admin-evidence.test.mjs",
]);

export const RELEASE_03_ACCESS_ADMIN_LOCAL_SOURCE_PATHS = Object.freeze([
  "docs/operations/release-0.3-access-admin-uat-runbook.md",
  "scripts/lib/exact-mcp-tool-inventory.mjs",
  "scripts/lib/multi-principal-probe-core.mjs",
  "scripts/lib/release-0.3-access-admin-evidence.mjs",
  "scripts/lib/uat-test-account-pool-contract.mjs",
  "scripts/run-synthetic-browser-gate.mjs",
  "scripts/run-synthetic-multi-principal-probe.mjs",
  "scripts/run-release-0.3-access-admin-local-gate.mjs",
  "scripts/join-release-0.3-access-admin-uat.mjs",
  "tests/fixtures/file-ingress-evidence/hosted-tool-inventory.json",
  "tests/fixtures/release-0.3-access-admin/contract.v1.json",
  "tests/fixtures/release-0.3-traceability/contract.v1.json",
  ...RELEASE_03_ACCESS_ADMIN_LOCAL_TEST_PATHS,
]);

export const RELEASE_03_ACCESS_ADMIN_STATE_ROWS = Object.freeze([
  Object.freeze({
    id: "private-nonmember",
    actor: "UAT-ORDINARY",
    role: "none",
    access_kind: "none",
    browser: "non-enumerating-denied",
    rest: "non-enumerating-denied",
    mcp: "non-enumerating-denied",
    content_read: false,
    content_write: false,
    membership_manage: false,
  }),
  Object.freeze({
    id: "accepted-reader",
    actor: "UAT-ORDINARY",
    role: "reader",
    access_kind: "membership",
    browser: "allowed",
    rest: "allowed",
    mcp: "allowed",
    content_read: true,
    content_write: false,
    membership_manage: false,
  }),
  Object.freeze({
    id: "promoted-editor",
    actor: "UAT-ORDINARY",
    role: "editor",
    access_kind: "membership",
    browser: "allowed",
    rest: "allowed",
    mcp: "allowed",
    content_read: true,
    content_write: true,
    membership_manage: false,
  }),
  Object.freeze({
    id: "promoted-admin",
    actor: "UAT-ORDINARY",
    role: "admin",
    access_kind: "membership",
    browser: "allowed",
    rest: "allowed",
    mcp: "allowed",
    content_read: true,
    content_write: true,
    membership_manage: true,
  }),
  Object.freeze({
    id: "transferred-owner",
    actor: "UAT-ORDINARY",
    role: "owner",
    access_kind: "membership",
    browser: "allowed",
    rest: "allowed",
    mcp: "allowed",
    content_read: true,
    content_write: true,
    membership_manage: true,
  }),
  Object.freeze({
    id: "former-owner-admin",
    actor: "UAT-MIND-ROLE",
    role: "admin",
    access_kind: "membership",
    browser: "allowed",
    rest: "allowed",
    mcp: "allowed",
    content_read: true,
    content_write: true,
    membership_manage: true,
  }),
  Object.freeze({
    id: "revoked-private",
    actor: "UAT-MIND-ROLE",
    role: "none",
    access_kind: "none",
    browser: "non-enumerating-denied",
    rest: "non-enumerating-denied",
    mcp: "non-enumerating-denied",
    content_read: false,
    content_write: false,
    membership_manage: false,
  }),
  Object.freeze({
    id: "reaccepted-reader",
    actor: "UAT-MIND-ROLE",
    role: "reader",
    access_kind: "membership",
    browser: "allowed",
    rest: "allowed",
    mcp: "allowed",
    content_read: true,
    content_write: false,
    membership_manage: false,
  }),
  Object.freeze({
    id: "left-private",
    actor: "UAT-MIND-ROLE",
    role: "none",
    access_kind: "none",
    browser: "non-enumerating-denied",
    rest: "non-enumerating-denied",
    mcp: "non-enumerating-denied",
    content_read: false,
    content_write: false,
    membership_manage: false,
  }),
  Object.freeze({
    id: "public-nonmember",
    actor: "UAT-MIND-ROLE",
    role: "none",
    access_kind: "visibility",
    browser: "allowed",
    rest: "allowed",
    mcp: "allowed",
    content_read: true,
    content_write: false,
    membership_manage: false,
  }),
  Object.freeze({
    id: "unlisted-exact-nonmember",
    actor: "UAT-MIND-ROLE",
    role: "none",
    access_kind: "visibility",
    browser: "exact-route-only",
    rest: "exact-route-only",
    mcp: "exact-resolve-only",
    content_read: true,
    content_write: false,
    membership_manage: false,
  }),
  Object.freeze({
    id: "private-restored",
    actor: "UAT-MIND-ROLE",
    role: "none",
    access_kind: "none",
    browser: "non-enumerating-denied",
    rest: "non-enumerating-denied",
    mcp: "non-enumerating-denied",
    content_read: false,
    content_write: false,
    membership_manage: false,
  }),
]);

export const RELEASE_03_ACCESS_ADMIN_INVITATION_ROWS = Object.freeze([
  Object.freeze({ id: "pending", state: "pending", access_granted: false, expiry_policy: "seven-days" }),
  Object.freeze({ id: "cancelled", state: "cancelled", access_granted: false, expiry_policy: "terminal" }),
  Object.freeze({ id: "reissued", state: "pending", access_granted: false, expiry_policy: "fresh-seven-days" }),
  Object.freeze({ id: "rejected", state: "rejected", access_granted: false, expiry_policy: "terminal" }),
  Object.freeze({ id: "accepted", state: "accepted", access_granted: true, expiry_policy: "terminal" }),
]);

const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const DEPLOYMENT = /^appgdep_[a-z0-9]+$/u;
const PROJECT = /^appgprj_[a-z0-9]+$/u;
const VERSION = /^appgver_[a-z0-9]+$/u;
const FINGERPRINT = /^actor-[a-z0-9]{16,64}$/u;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

export class Release03AccessAdminEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = "Release03AccessAdminEvidenceError";
    this.code = code;
  }
}

function fail(code) {
  throw new Release03AccessAdminEvidenceError(code);
}

function exactKeys(value, keys) {
  return isRecord(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key));
}

function exactArtifact(value, code) {
  if (!isRecord(value) || !SHA256.test(value.artifact_sha256 ?? "")) fail(code);
  const { artifact_sha256: artifact, ...unsigned } = value;
  if (artifact !== digest(canonical(unsigned))) fail(code);
  try {
    assertRedactedDocument(value);
  } catch {
    fail(code);
  }
  return value;
}

function utc(value) {
  if (typeof value !== "string" || !UTC_INSTANT.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail("invalid_utc_instant");
  }
  return value;
}

function passedRows(ids) {
  return ids.map((id) => Object.freeze({ id, status: "passed" }));
}

function exactPassedRows(value, ids) {
  return canonical(value) === canonical(passedRows(ids));
}

function verifyCarrier(value, { schema, assertions, candidate, code }) {
  exactArtifact(value, code);
  if (value.schema !== schema || value.status !== "passed" ||
      value.candidate_sha !== candidate || !exactPassedRows(value.assertions, assertions)) fail(code);
  return value;
}

function exactHashMap(value) {
  if (!isRecord(value) || Object.keys(value).length !== RELEASE_03_ACCESS_ADMIN_LOCAL_SOURCE_PATHS.length ||
      Object.keys(value).some((path) => !RELEASE_03_ACCESS_ADMIN_LOCAL_SOURCE_PATHS.includes(path))) {
    fail("invalid_local_source_hashes");
  }
  for (const [path, hash] of Object.entries(value)) {
    if (!/^(?:docs|scripts|tests)\/[A-Za-z0-9._/-]+$/u.test(path) || path.includes("..") || !SHA256.test(hash)) {
      fail("invalid_local_source_hashes");
    }
  }
}

function exactTestRows(value) {
  if (!Array.isArray(value) || value.length !== RELEASE_03_ACCESS_ADMIN_LOCAL_TEST_PATHS.length) {
    fail("invalid_local_test_rows");
  }
  value.forEach((row, index) => {
    if (!exactKeys(row, ["path", "status", "stdout_sha256"]) ||
        row.path !== RELEASE_03_ACCESS_ADMIN_LOCAL_TEST_PATHS[index] ||
        row.status !== "passed" || !SHA256.test(row.stdout_sha256)) fail("invalid_local_test_rows");
  });
}

export function createRelease03AccessAdminLocalEvidence(input) {
  if (!SHA.test(input.candidateSha ?? "")) fail("invalid_candidate_sha");
  const synthetic = verifyCarrier(input.syntheticEvidence, {
    schema: "mind-diary/synthetic-multi-principal-evidence/v1",
    assertions: SYNTHETIC_ASSERTION_IDS,
    candidate: input.candidateSha,
    code: "invalid_synthetic_carrier",
  });
  const browser = verifyCarrier(input.browserEvidence, {
    schema: "mind-diary/synthetic-browser-evidence/v1",
    assertions: RELEASE_03_EXPECTED_SYNTHETIC_BROWSER_ASSERTION_IDS,
    candidate: input.candidateSha,
    code: "invalid_browser_carrier",
  });
  exactTestRows(input.tests);
  exactHashMap(input.sourceHashes);
  const unsigned = Object.freeze({
    schema: RELEASE_03_ACCESS_ADMIN_LOCAL_SCHEMA,
    status: "passed",
    release: "0.3",
    candidate_sha: input.candidateSha,
    runner_id: RELEASE_03_ACCESS_ADMIN_RUNNER_ID,
    hosted_status: "not-run",
    carrier: Object.freeze({
      ephemeral_principal_count: 3,
      synthetic_multi_principal_sha256: synthetic.artifact_sha256,
      synthetic_browser_sha256: browser.artifact_sha256,
    }),
    assertions: Object.freeze(passedRows(RELEASE_03_ACCESS_ADMIN_LOCAL_ASSERTION_IDS)),
    tests: Object.freeze(input.tests.map((row) => Object.freeze({ ...row }))),
    source_hashes: Object.freeze({ ...input.sourceHashes }),
    hosted_rows_remaining: Object.freeze([
      "exact candidate and Sites deployment lineage",
      "fresh three-account restricted-UAT pool read-back",
      "same-run sequential role visibility invitation and surface observations",
      "run-owned credential Mind and pool-baseline cleanup read-back",
    ]),
    started_at: utc(input.startedAt),
    completed_at: utc(input.completedAt),
  });
  return Object.freeze(assertRedactedDocument({
    ...unsigned,
    artifact_sha256: digest(canonical(unsigned)),
  }));
}

export function verifyRelease03AccessAdminLocalEvidence(value) {
  exactArtifact(value, "invalid_local_evidence");
  if (!exactKeys(value, [
    "schema", "status", "release", "candidate_sha", "runner_id", "hosted_status",
    "carrier", "assertions", "tests", "source_hashes", "hosted_rows_remaining",
    "started_at", "completed_at", "artifact_sha256",
  ]) || value.schema !== RELEASE_03_ACCESS_ADMIN_LOCAL_SCHEMA || value.status !== "passed" ||
      value.release !== "0.3" || !SHA.test(value.candidate_sha ?? "") ||
      value.runner_id !== RELEASE_03_ACCESS_ADMIN_RUNNER_ID || value.hosted_status !== "not-run" ||
      !exactKeys(value.carrier, [
        "ephemeral_principal_count", "synthetic_multi_principal_sha256", "synthetic_browser_sha256",
      ]) || value.carrier.ephemeral_principal_count !== 3 ||
      !SHA256.test(value.carrier.synthetic_multi_principal_sha256 ?? "") ||
      !SHA256.test(value.carrier.synthetic_browser_sha256 ?? "") ||
      !exactPassedRows(value.assertions, RELEASE_03_ACCESS_ADMIN_LOCAL_ASSERTION_IDS)) {
    fail("invalid_local_evidence");
  }
  exactTestRows(value.tests);
  exactHashMap(value.source_hashes);
  const expectedRemaining = [
    "exact candidate and Sites deployment lineage",
    "fresh three-account restricted-UAT pool read-back",
    "same-run sequential role visibility invitation and surface observations",
    "run-owned credential Mind and pool-baseline cleanup read-back",
  ];
  if (canonical(value.hosted_rows_remaining) !== canonical(expectedRemaining)) fail("invalid_local_evidence");
  utc(value.started_at);
  utc(value.completed_at);
  return value;
}

function exactActorFingerprints(value) {
  if (!Array.isArray(value) || value.length !== 3 || new Set(value).size !== 3 ||
      value.some((fingerprint) => !FINGERPRINT.test(fingerprint))) fail("invalid_actor_fingerprints");
  return value;
}

function exactBooleanRecord(value, keys, code) {
  if (!exactKeys(value, keys) || Object.values(value).some((item) => item !== true)) fail(code);
}

export function createRelease03AccessAdminHostedObservation(input) {
  if (!SHA.test(input.candidateSha ?? "") || !DEPLOYMENT.test(input.deploymentId ?? "") ||
      !PROJECT.test(input.projectId ?? "") || !VERSION.test(input.versionId ?? "") ||
      !SHA256.test(input.poolReceiptSha256 ?? "")) fail("invalid_hosted_lineage");
  exactActorFingerprints(input.actorFingerprints);
  if (canonical(input.stateRows) !== canonical(RELEASE_03_ACCESS_ADMIN_STATE_ROWS) ||
      canonical(input.invitationRows) !== canonical(RELEASE_03_ACCESS_ADMIN_INVITATION_ROWS) ||
      canonical(input.mcpToolNames) !== canonical(EXPECTED_DEFAULT_MCP_TOOL_NAMES)) fail("invalid_hosted_observation_rows");
  exactBooleanRecord(input.readBack, [
    "browser_rest_mcp_content_each_state",
    "current_role_on_every_request",
    "public_unlisted_reader_equivalent_only",
    "revoked_private_non_enumerating",
    "sole_owner_after_transfer",
    "no_control_mcp_tools",
    "restart_or_redeploy_current_state",
  ], "hosted_readback_incomplete");
  exactBooleanRecord(input.cleanup, [
    "per_run_tokens_revoked",
    "next_mcp_request_denied",
    "run_mind_deleted",
    "exact_mind_absent",
    "temporary_roles_absent",
    "audience_unchanged",
    "operator_allowlist_unchanged",
    "pool_baseline_read_back",
    "unknown_outcomes_none",
  ], "hosted_cleanup_incomplete");
  const unsigned = Object.freeze({
    schema: RELEASE_03_ACCESS_ADMIN_OBSERVATION_SCHEMA,
    status: "passed",
    release: "0.3",
    runner_id: RELEASE_03_ACCESS_ADMIN_RUNNER_ID,
    candidate_sha: input.candidateSha,
    deployment_id: input.deploymentId,
    project_id: input.projectId,
    version_id: input.versionId,
    deployment_status: "succeeded",
    pool_receipt_sha256: input.poolReceiptSha256,
    actor_fingerprints: Object.freeze([...input.actorFingerprints]),
    mcp_tool_names: Object.freeze([...input.mcpToolNames]),
    state_rows: Object.freeze(input.stateRows.map((row) => Object.freeze({ ...row }))),
    invitation_rows: Object.freeze(input.invitationRows.map((row) => Object.freeze({ ...row }))),
    assertions: Object.freeze(passedRows(RELEASE_03_ACCESS_ADMIN_HOSTED_ASSERTION_IDS)),
    read_back: Object.freeze({ ...input.readBack }),
    cleanup: Object.freeze({ ...input.cleanup }),
    observed_at: utc(input.observedAt),
  });
  return Object.freeze(assertRedactedDocument({
    ...unsigned,
    artifact_sha256: digest(canonical(unsigned)),
  }));
}

export function verifyRelease03AccessAdminHostedObservation(value) {
  exactArtifact(value, "invalid_hosted_observation");
  if (!exactKeys(value, [
    "schema", "status", "release", "runner_id", "candidate_sha", "deployment_id",
    "project_id", "version_id", "deployment_status", "pool_receipt_sha256",
    "actor_fingerprints", "mcp_tool_names", "state_rows", "invitation_rows",
    "assertions", "read_back", "cleanup", "observed_at", "artifact_sha256",
  ]) || value.schema !== RELEASE_03_ACCESS_ADMIN_OBSERVATION_SCHEMA || value.status !== "passed" ||
      value.release !== "0.3" || value.runner_id !== RELEASE_03_ACCESS_ADMIN_RUNNER_ID ||
      !SHA.test(value.candidate_sha ?? "") || !DEPLOYMENT.test(value.deployment_id ?? "") ||
      !PROJECT.test(value.project_id ?? "") || !VERSION.test(value.version_id ?? "") ||
      value.deployment_status !== "succeeded" || !SHA256.test(value.pool_receipt_sha256 ?? "") ||
      !exactPassedRows(value.assertions, RELEASE_03_ACCESS_ADMIN_HOSTED_ASSERTION_IDS) ||
      canonical(value.state_rows) !== canonical(RELEASE_03_ACCESS_ADMIN_STATE_ROWS) ||
      canonical(value.invitation_rows) !== canonical(RELEASE_03_ACCESS_ADMIN_INVITATION_ROWS) ||
      canonical(value.mcp_tool_names) !== canonical(EXPECTED_DEFAULT_MCP_TOOL_NAMES)) {
    fail("invalid_hosted_observation");
  }
  exactActorFingerprints(value.actor_fingerprints);
  exactBooleanRecord(value.read_back, [
    "browser_rest_mcp_content_each_state", "current_role_on_every_request",
    "public_unlisted_reader_equivalent_only", "revoked_private_non_enumerating",
    "sole_owner_after_transfer", "no_control_mcp_tools", "restart_or_redeploy_current_state",
  ], "hosted_readback_incomplete");
  exactBooleanRecord(value.cleanup, [
    "per_run_tokens_revoked", "next_mcp_request_denied", "run_mind_deleted",
    "exact_mind_absent", "temporary_roles_absent", "audience_unchanged",
    "operator_allowlist_unchanged", "pool_baseline_read_back", "unknown_outcomes_none",
  ], "hosted_cleanup_incomplete");
  utc(value.observed_at);
  return value;
}

export function createRelease03AccessAdminUatJoin({ localEvidence, poolEvidence, hostedObservation }) {
  const local = verifyRelease03AccessAdminLocalEvidence(localEvidence);
  let pool;
  try {
    pool = verifyUatTestAccountPoolReadinessReceipt(poolEvidence);
  } catch {
    fail("invalid_pool_evidence");
  }
  const hosted = verifyRelease03AccessAdminHostedObservation(hostedObservation);
  if (pool.actors.length !== 3 || local.candidate_sha !== pool.candidate_sha ||
      local.candidate_sha !== hosted.candidate_sha || pool.deployment_id !== hosted.deployment_id ||
      pool.artifact_sha256 !== hosted.pool_receipt_sha256 ||
      canonical(pool.actors.map((actor) => actor.actor_fingerprint)) !== canonical(hosted.actor_fingerprints)) {
    fail("access_admin_lineage_mismatch");
  }
  const unsigned = Object.freeze({
    schema: RELEASE_03_ACCESS_ADMIN_JOIN_SCHEMA,
    status: "structurally_verified_readback",
    acceptance: "nonterminal",
    hosted_evidence: false,
    live_tool_provenance_required: true,
    release: "0.3",
    runner_id: RELEASE_03_ACCESS_ADMIN_RUNNER_ID,
    candidate_sha: local.candidate_sha,
    deployment_id: hosted.deployment_id,
    project_fingerprint: digest(hosted.project_id),
    version_fingerprint: digest(hosted.version_id),
    actor_fingerprints: Object.freeze([...hosted.actor_fingerprints]),
    inputs: Object.freeze({
      local_evidence_sha256: local.artifact_sha256,
      pool_evidence_sha256: pool.artifact_sha256,
      hosted_observation_sha256: hosted.artifact_sha256,
    }),
    assertions: Object.freeze(RELEASE_03_ACCESS_ADMIN_FINAL_ASSERTION_IDS.map((id) =>
      Object.freeze({ id, status: "structurally-observed" }))),
    read_back: Object.freeze({ ...hosted.read_back }),
    cleanup: Object.freeze({ ...hosted.cleanup }),
  });
  return Object.freeze(assertRedactedDocument({
    ...unsigned,
    artifact_sha256: digest(canonical(unsigned)),
  }));
}
