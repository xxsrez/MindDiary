import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const fixture = JSON.parse(await readFile(
  new URL("tests/fixtures/credential-write-target/contract.v1.json", root),
  "utf8",
));
const specification = await readFile(
  new URL("docs/specs/credential-write-target.md", root),
  "utf8",
);
const decision = await readFile(
  new URL("docs/decisions/0022-site-controlled-credential-write-target.md", root),
  "utf8",
);
const historicalDecision = await readFile(
  new URL("docs/decisions/0013-multiple-read-single-write-mind-bindings.md", root),
  "utf8",
);

function exactKeys(value, keys, label) {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), label);
}

function unique(values, label) {
  assert.equal(new Set(values).size, values.length, label);
}

test("credential write target fixture is a closed Release 0.3 contract", () => {
  assert.equal(fixture.$schema, "mind-diary/credential-write-target/v1");
  assert.equal(fixture.version, 1);
  assert.equal(fixture.release, "0.3");
  assert.equal(fixture.status, "accepted_contract_not_implemented");
  assert.equal(fixture.source, "docs/specs/credential-write-target.md");
  assert.equal(fixture.decision, "docs/decisions/0022-site-controlled-credential-write-target.md");
  exactKeys(fixture, [
    "$schema",
    "version",
    "source",
    "decision",
    "release",
    "status",
    "readAuthorization",
    "ownership",
    "targetState",
    "siteControl",
    "mcp",
    "commit",
    "failureMatrix",
    "migration",
    "captureAndStaging",
    "legacyCompatibility",
    "acceptanceIds",
  ], "top-level contract drifted");
  unique(fixture.acceptanceIds, "acceptance IDs must be unique");
  assert.equal(fixture.acceptanceIds.length, 10);
});

test("reads use explicit selectors and current ACL or visibility without read binding", () => {
  const read = fixture.readAuthorization;
  assert.equal(read.explicitMindRequired, true);
  assert.equal(read.revisionResolutionRequired, true);
  assert.equal(read.clientRevisionSelectorRequired, false);
  assert.equal(read.omittedRevision, "resolve_current_head_to_exact_revision");
  assert.equal(read.contentReadScopeRequired, true);
  assert.equal(read.readBindingRequired, false);
  assert.equal(read.crossMindQueryAllowed, false);
  assert.equal(read.currentAccessRechecked, true);
  exactKeys(read.cases, [
    "personal",
    "private",
    "unlisted_exact_handle",
    "public_catalog",
    "historical",
  ], "read case matrix must be closed");
  assert.equal(read.cases.private.discovery, "membership_only");
  assert.equal(read.cases.unlisted_exact_handle.discovery, "exact_handle_only");
  assert.equal(read.cases.public_catalog.discovery, "authenticated_catalog_or_exact_handle");
  assert.equal(read.cases.historical.requiredAccess, "current_access_not_historical_acl");
});

test("each credential has one immutable independent owner and at most one target", () => {
  assert.deepEqual(fixture.ownership.ownerKinds, ["oauth_grant", "personal_token"]);
  assert.equal(fixture.ownership.serverDerivedOwnerField, "binding_owner_id");
  assert.equal(fixture.ownership.ownerImmutable, true);
  assert.equal(fixture.ownership.ownerIndependentPerCredential, true);
  assert.equal(fixture.ownership.accessRefreshPreservesOwner, true);
  assert.equal(fixture.ownership.oauthReconnectCreatesNewOwner, true);
  assert.equal(fixture.ownership.personalTokenReissueCreatesNewOwner, true);
  assert.equal(fixture.ownership.clientOwnerFieldsAccepted, false);
  assert.equal(fixture.targetState.maximumActiveTargets, 1);
  assert.equal(fixture.targetState.generationOpaque, true);
  assert.equal(fixture.targetState.generationNeverReused, true);
  assert.deepEqual(fixture.targetState.authorityCachedInTarget, []);
});

test("target transitions are versioned, idempotent, and never fall back", () => {
  const transitions = fixture.targetState.transitions;
  exactKeys(transitions, [
    "select_empty",
    "switch_other",
    "select_same",
    "clear",
    "revoke_or_expire",
  ], "target transition matrix drifted");
  assert.deepEqual(transitions.select_empty, {
    versionDelta: 1,
    generation: "new",
    previous: "none",
  });
  assert.deepEqual(transitions.switch_other, {
    versionDelta: 1,
    generation: "new",
    previous: "invalidated",
  });
  assert.deepEqual(transitions.select_same, {
    versionDelta: 0,
    generation: "preserved",
    result: "idempotent_no_op",
  });
  assert.deepEqual(transitions.clear, {
    versionDelta: 1,
    generation: "none",
    previous: "invalidated",
  });
  assert.equal(transitions.revoke_or_expire.fallback, "none");
});

test("only trusted Site mutates target while MCP is inspect-only", () => {
  assert.equal(fixture.siteControl.mutationSurface, "trusted_sites_web_only");
  assert.equal(fixture.siteControl.oauthLocation, "connection_detail");
  assert.equal(fixture.siteControl.personalTokenLocation, "advanced_mcp");
  assert.deepEqual(fixture.siteControl.actions, ["select", "switch", "clear"]);
  for (const required of [
    "actor_owned_presentation_ref",
    "expected_target_version",
    "idempotency_key",
    "current_write_scope",
    "current_writer_role",
    "server_read_back",
  ]) assert.ok(fixture.siteControl.requires.includes(required), required);
  assert.equal(fixture.siteControl.readableProjectionPersistedAsBinding, false);
  assert.equal(fixture.mcp.inspection, "privacy_safe_current_credential_only");
  assert.equal(fixture.mcp.targetMutation, false);
  assert.equal(fixture.mcp.protocolProfilesShareSemantics, true);
  assert.equal(fixture.mcp.operationNamesOwnedBy, "MD-337");
});

test("commit is fenced by exact generation, Mind, scope, role, HEAD, and idempotency", () => {
  assert.deepEqual(fixture.commit.requiredInputFields, [
    "mind",
    "write_target_generation",
    "expected_revision",
    "idempotency_key",
    "operations",
  ]);
  for (const check of [
    "active_credential",
    "exact_immutable_owner",
    "content_write_scope",
    "active_target_generation",
    "explicit_mind_matches_generation",
    "current_writer_role",
    "staged_refs_same_owner_generation",
    "expected_head",
    "idempotency",
  ]) assert.ok(fixture.commit.transactionChecks.includes(check), check);
  assert.deepEqual(fixture.commit.idempotencyNamespace, [
    "binding_owner_id",
    "target_generation",
    "space_id",
    "operation",
    "key",
  ]);
  assert.equal(fixture.commit.fallback, "none");
});

test("every denied operation case has zero observable mutation side effects", () => {
  unique(fixture.failureMatrix.map(({ case: caseName }) => caseName), "failure cases must be unique");
  const requiredCases = new Set([
    "missing_target",
    "legacy_owner_pending_upgrade",
    "stale_generation",
    "wrong_mind",
    "revoked_or_expired_owner",
    "scope_or_role_loss",
    "visibility_removes_read_grant",
    "corrupt_or_partial_state",
    "stale_head",
  ]);
  assert.deepEqual(new Set(fixture.failureMatrix.map(({ case: caseName }) => caseName)), requiredCases);
  for (const failure of fixture.failureMatrix) {
    exactKeys(failure, [
      "case",
      "code",
      "reachableObject",
      "revision",
      "headMove",
      "auditOrOutbox",
      "indexEffect",
      "stagedConsumption",
      "fallback",
    ], `${failure.case}: failure shape drifted`);
    for (const field of [
      "reachableObject",
      "revision",
      "headMove",
      "auditOrOutbox",
      "indexEffect",
      "stagedConsumption",
    ]) assert.equal(failure[field], false, `${failure.case}:${field}`);
    assert.equal(failure.fallback, "none", failure.case);
  }
});

test("migration is explicit, same-owner only, and fail closed", () => {
  const migration = fixture.migration;
  assert.equal(migration.capability, "credential-write-target/v1");
  assert.equal(migration.legacyInitialLifecycle, "pending_upgrade");
  assert.equal(migration.legacyReadBindings, "not_authority_and_not_migrated");
  assert.equal(migration.legacyWriteIdsAcceptedByV1, false);
  assert.equal(migration.legacyStagedRefsAcceptedByV1, false);
  assert.equal(migration.unknownAttemptResumed, false);
  assert.equal(migration.completedImmutableResultPreserved, true);
  assert.equal(migration.oauth.explicitAction, "same_grant_reconsent");
  assert.equal(migration.oauth.sameOwnerRequired, true);
  assert.equal(migration.oauth.preserveOnly, "exactly_one_unambiguous_active_target");
  assert.equal(migration.oauth.oldGenerationReused, false);
  assert.equal(migration.oauth.failedCheckOutcome, "active_v1_owner_empty_target");
  assert.equal(migration.personalToken.explicitAction, "reissue_required");
  assert.equal(migration.personalToken.inPlaceWriteUpgrade, false);
  assert.equal(migration.personalToken.newOwner, true);
  assert.equal(migration.personalToken.newTarget, "empty");
  assert.equal(migration.reconnect.newOwner, true);
  assert.equal(migration.reconnect.newTarget, "empty");
  assert.equal(migration.reconnect.targetCopyAllowed, false);
  assert.equal(migration.ambiguousCorruptOrPartialOutcome, "empty_or_unavailable_never_guessed");
});

test("capture and staging remain pinned to the same owner and generation", () => {
  const contract = fixture.captureAndStaging;
  assert.equal(contract.captureDefault, "disabled");
  assert.deepEqual(contract.capturePin, ["binding_owner_id", "target_generation"]);
  assert.equal(contract.captureEnableSurface, "trusted_sites_web_only");
  assert.equal(contract.captureTransferAcrossGeneration, false);
  assert.equal(contract.captureTransferAcrossOwner, false);
  assert.equal(contract.captureMigrationPreserveRequiresSeparateConfirmation, true);
  assert.deepEqual(contract.newStagedRefPin, ["binding_owner_id", "target_generation"]);
  assert.equal(contract.legacyStagedRefRemap, false);
});

test("ADR preserves historical evidence while superseding only Release 0.3 access clauses", () => {
  assert.match(decision, /частично заменяет/u);
  assert.match(decision, /обязательные `read_bindings`/u);
  assert.match(decision, /credential-scoped owner/u);
  assert.match(decision, /единственный writable destination/u);
  assert.match(decision, /Historical Release 0\.1\/0\.2 records и\s+evidence не переписываются/u);
  assert.match(historicalDecision, /частично superseded для Release 0\.3/u);
  assert.match(historicalDecision, /Сохраняются historical implementation и\s+evidence/u);
  assert.match(specification, /Runtime, persistence, wire schemas,[\s\S]*ещё не реализованы/u);
  assert.match(specification, /MCP inspection не принимает action/u);
  assert.match(specification, /Same-owner OAuth preservation/u);
  assert.equal(fixture.legacyCompatibility.historicalContractRetained, true);
  assert.equal(fixture.legacyCompatibility.historicalEvidenceReclassifiedAsTarget, false);
  assert.equal(fixture.legacyCompatibility.silentOldIdTranslation, false);
  assert.equal(fixture.legacyCompatibility.silentPersonalFallback, false);
});
