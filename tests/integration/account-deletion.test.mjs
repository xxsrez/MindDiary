import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryAuditSink } from "@mind-diary/adapter-audit-memory";
import {
  InMemoryMcpTokenStore,
  InMemoryRevisionMetadataStore,
} from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import { InMemoryExactRevisionSearchIndex } from "@mind-diary/adapter-search-memory";
import {
  ACCOUNT_DELETION_CONFIRMATION,
  ACCOUNT_DELETION_IMPACT_LIFETIME_MINUTES,
  AccountBootstrapService,
  AccountDeletionFailure,
  AccountDeletionService,
  InvitationControlService,
  OrdinaryMindControlService,
} from "@mind-diary/application-control";
import { createLocalAccountDeletionBoundary } from "@mind-diary/composition-root";
import {
  CAPABILITIES,
  createCanonicalRevisionEnvelope,
  version,
  verifiedSpaceHost,
} from "@mind-diary/domain";

const CREATED_AT = "2026-08-07T07:00:00.000Z";
const DELETE_AT = "2026-08-07T07:10:00.000Z";
const HOST = verifiedSpaceHost("mind-diary.example");

function preRegistrationActor(index) {
  return {
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding: `account.deletion.${index}@example.com`,
    suggestedDisplayName: `Account ${index}`,
    deploymentCapabilities: CAPABILITIES,
    requestId: `request_account_bootstrap_${index}`,
    occurredAtUtc: CREATED_AT,
  };
}

function actor(principalId, requestId = "request_account_delete") {
  return {
    kind: "registered_principal",
    principalId,
    authentication: { kind: "sites_identity" },
    deploymentCapabilities: CAPABILITIES,
    requestId,
    occurredAtUtc: DELETE_AT,
  };
}

function accountIds() {
  let id = 0;
  return {
    nextPrincipalId: () => `principal_account_delete_${++id}`,
    nextExternalBindingId: () => `binding_account_delete_${id}`,
    nextSpaceId: () => `space_personal_account_delete_${id}`,
    nextMembershipId: () => `membership_personal_account_delete_${id}`,
    nextRevisionId: () => `revision_personal_account_delete_${id}`,
    nextPersonalSpaceHandle: () => `personal-account-delete-${id}`,
  };
}

function ordinaryIds() {
  let spaces = 0;
  let memberships = 0;
  let revisions = 0;
  return {
    nextSpaceId: () => `space_account_delete_${++spaces}`,
    nextMembershipId: () => `membership_account_delete_${++memberships}`,
    nextRevisionId: () => `revision_account_delete_${++revisions}`,
  };
}

function deletionIds() {
  let impacts = 0;
  let tombstones = 0;
  return {
    nextImpactId: () => `impact_account_delete_${++impacts}`,
    nextDeletedPrincipalId: () => `deleted_principal_${++tombstones}`,
  };
}

function invitationIds() {
  let invitations = 0;
  let memberships = 100;
  let jobs = 0;
  return {
    nextInvitationId: () => `invitation_account_delete_${++invitations}`,
    nextMembershipId: () => `membership_invitation_${++memberships}`,
    nextInvitationExpiryJobId: () => `job_invitation_${++jobs}`,
  };
}

function harness(options = {}) {
  const metadata = options.metadata ?? new InMemoryRevisionMetadataStore();
  const objects = options.objects ?? new InMemoryObjectStore();
  const index = options.index ?? new InMemoryExactRevisionSearchIndex();
  const audit = options.audit ?? new InMemoryAuditSink();
  const tokens = options.tokens ?? new InMemoryMcpTokenStore();
  const now = { value: options.now ?? DELETE_AT };
  const bootstrap = new AccountBootstrapService({
    accounts: metadata,
    objects,
    ids: accountIds(),
  });
  const ordinary = new OrdinaryMindControlService({
    ordinaryMinds: metadata,
    objects,
    ids: ordinaryIds(),
    host: HOST,
  });
  const invitations = new InvitationControlService({
    invitations: metadata,
    objects,
    ids: invitationIds(),
  });
  const deletionDependencies = {
    accounts: metadata,
    tokens,
    objects,
    index,
    audit,
    exportArchives: objects,
    ids: deletionIds(),
    clock: { now: () => now.value },
    host: HOST,
  };
  const deletion = new AccountDeletionService(deletionDependencies);
  return {
    metadata,
    objects,
    index,
    audit,
    tokens,
    now,
    bootstrap,
    ordinary,
    invitations,
    deletion,
    deletionDependencies,
  };
}

async function createAccount(env, index) {
  return env.bootstrap.bootstrapAccount(preRegistrationActor(index), {
    action: "create_isolated_account",
  });
}

async function createMind(env, owner, handle) {
  return env.ordinary.createSpaceWithOwner(
    actor(owner.principalId, `request_create_${handle}`),
    {
      name: handle.replaceAll("-", " "),
      handle,
      idempotencyKey: `create-${handle}`,
    },
  );
}

async function seedToken(env, principalId, suffix = "a") {
  const tokenId = `token_account_delete_${suffix}`;
  const created = await env.tokens.createMcpToken({
    tokenId,
    principalId,
    name: `Codex ${suffix}`,
    verifier: `hmac-sha256:v1:${suffix.repeat(64)}`,
    displayPrefix: `mdp_v1_${suffix.repeat(6)}…`,
    scopes: ["content:read", "content:write"],
    createdAt: CREATED_AT,
    expiresAt: "2026-11-05T07:00:00.000Z",
  });
  assert.equal(created.kind, "created");
  return tokenId;
}

function deleteCommand(preview, key = "delete-account-once") {
  return {
    impactId: preview.impactId,
    confirmation: ACCOUNT_DELETION_CONFIRMATION,
    idempotencyKey: key,
  };
}

function expectFailure(code) {
  return (error) => {
    assert.equal(error instanceof AccountDeletionFailure, true);
    assert.equal(error.code, code);
    return true;
  };
}

async function seedForeignRevision(env, mind, deletedPrincipalId) {
  const initial = await env.metadata.readRevision(mind.mindId, mind.headRevisionId);
  assert.ok(initial);
  const next = createCanonicalRevisionEnvelope({
    revisionId: `revision_foreign_by_${deletedPrincipalId}`,
    spaceId: mind.mindId,
    revisionNumber: 2,
    parentRevisionId: initial.revision.revisionId,
    committedAt: "2026-08-07T07:05:00.000Z",
    committedBy: { kind: "principal", principalId: deletedPrincipalId },
    summary: "Retained foreign commit",
    manifest: initial.manifest,
    manifestHash: initial.revision.manifestHash,
  });
  const committed = await env.metadata.commitRevision({
    expectedHeadRevisionId: initial.revision.revisionId,
    envelope: next,
  });
  assert.equal(committed.kind, "committed");
  return next.revision.revisionId;
}

test("preview binds the exact cascade and deletion preserves foreign revisions with a non-PII tombstone", async () => {
  const env = harness();
  const deleted = await createAccount(env, 1);
  const survivor = await createAccount(env, 2);
  const owned = await createMind(env, deleted, "owned-delete-target");
  const foreignMembershipMind = await createMind(
    env,
    survivor,
    "foreign-membership",
  );
  const foreignInvitationMind = await createMind(
    env,
    survivor,
    "foreign-invitation",
  );
  assert.equal(
    await env.metadata.grantOrdinaryMembershipForTest(
      {
        membershipId: "membership_foreign_deleted_principal",
        spaceId: foreignMembershipMind.mindId,
        principalId: deleted.principalId,
        role: "editor",
        state: "active",
        version: version(1),
        createdAt: CREATED_AT,
        createdBy: survivor.principalId,
        updatedAt: CREATED_AT,
        updatedBy: survivor.principalId,
      },
      "2026-08-07T07:01:00.000Z",
    ),
    true,
  );
  const invitation = await env.invitations.createInvitation(
    actor(survivor.principalId, "request_foreign_invitation"),
    {
      mindId: foreignInvitationMind.mindId,
      targetVerifiedEmail: preRegistrationActor(1).normalizedBinding,
      role: "reader",
      expectedMetadataVersion: foreignInvitationMind.metadataVersion,
      idempotencyKey: "invite-before-account-delete",
    },
  );
  const tokenId = await seedToken(env, deleted.principalId);
  const foreignRevisionId = await seedForeignRevision(
    env,
    foreignMembershipMind,
    deleted.principalId,
  );
  await env.audit.deliver({
    auditEventId: "audit_foreign_deleted_principal",
    actor: { kind: "principal", principalId: deleted.principalId },
    requestId: "request_foreign_audit",
    eventType: "space.test",
    outcome: "succeeded",
    spaceId: foreignMembershipMind.mindId,
    occurredAt: CREATED_AT,
    safeMetadata: {},
  });

  const preview = await env.deletion.getAccountDeletionImpact(
    actor(deleted.principalId, "request_account_preview"),
  );
  assert.deepEqual(preview.personalMind, { route: "/me", name: "Account 1" });
  assert.deepEqual(preview.ownedMinds, [
    { route: "/owned-delete-target", name: "owned delete target" },
  ]);
  assert.equal(preview.foreignMembershipCount, 1);
  assert.equal(preview.pendingInvitationCount, 1);
  assert.equal(preview.activeMcpTokenCount, 1);
  assert.equal(preview.forensicReceiptRetained, false);
  assert.equal(
    Date.parse(preview.expiresAt) - Date.parse(DELETE_AT),
    ACCOUNT_DELETION_IMPACT_LIFETIME_MINUTES * 60_000,
  );

  const result = await env.deletion.deleteAccount(
    actor(deleted.principalId, "request_account_commit"),
    deleteCommand(preview),
  );
  assert.equal(result.replayed, false);
  assert.equal(result.spacesDeleted, 2);
  assert.equal(result.tokensRevoked, 1);
  assert.equal(await env.metadata.readAccount(deleted.principalId), null);
  assert.equal(await env.metadata.resolvePersonalMind(deleted.principalId), null);
  assert.equal(
    await env.metadata.readAccountByExternalBinding({
      provider: "openai-sites",
      normalizedBinding: preRegistrationActor(1).normalizedBinding,
    }),
    null,
  );
  assert.equal(await env.metadata.inspectOrdinaryMindStateForTest(owned.mindId), null);
  assert.equal(
    (await env.tokens.readMcpTokenForAuthorization(tokenId)).state,
    "revoked",
  );
  const retainedMembershipMind =
    await env.metadata.inspectOrdinaryMindStateForTest(foreignMembershipMind.mindId);
  assert.ok(retainedMembershipMind);
  assert.equal(
    retainedMembershipMind.memberships.some(
      (membership) => membership.principalId === deleted.principalId,
    ),
    false,
  );
  const retainedInvitationMind =
    await env.metadata.inspectOrdinaryMindStateForTest(foreignInvitationMind.mindId);
  assert.ok(retainedInvitationMind);
  assert.equal(
    retainedInvitationMind.invitations.some(
      (candidate) => candidate.invitationId === invitation.invitationId,
    ),
    false,
  );
  const retainedRevision = await env.metadata.readRevision(
    foreignMembershipMind.mindId,
    foreignRevisionId,
  );
  assert.ok(retainedRevision);
  assert.equal(retainedRevision.revision.committedBy.kind, "deleted-principal");
  assert.equal(
    JSON.stringify(retainedRevision.revision.committedBy).includes(
      deleted.principalId,
    ),
    false,
  );
  const delivered = env.audit.deliveredForTest();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].actor.kind, "deleted-principal");
  assert.equal(JSON.stringify(delivered[0].actor).includes(deleted.principalId), false);
  assert.deepEqual(await env.metadata.inspectAccountDeletionImpactsForTest(), []);
  assert.deepEqual(await env.metadata.inspectAccountDeletionCleanupForTest(), []);
  const retired = await env.metadata.inspectRetiredHandlesForTest();
  assert.deepEqual(retired, [
    { host: HOST, canonicalHandle: "owned-delete-target" },
  ]);
  assert.equal(JSON.stringify(retired).includes(deleted.principalId), false);
});

test("token or metadata changes after preview fail closed and release the token reservation", async () => {
  const env = harness();
  const deleted = await createAccount(env, 1);
  await seedToken(env, deleted.principalId, "a");
  const tokenStale = await env.deletion.getAccountDeletionImpact(
    actor(deleted.principalId),
  );
  await seedToken(env, deleted.principalId, "b");
  await assert.rejects(
    env.deletion.deleteAccount(
      actor(deleted.principalId),
      deleteCommand(tokenStale, "delete-token-stale"),
    ),
    expectFailure("deletion_impact_changed"),
  );
  assert.ok(await env.metadata.readAccount(deleted.principalId));

  const metadataStale = await env.deletion.getAccountDeletionImpact(
    actor(deleted.principalId),
  );
  assert.equal(
    await env.metadata.bumpPersonalMindMetadataVersionForTest(
      deleted.principalId,
      "2026-08-07T07:11:00.000Z",
    ),
    true,
  );
  await assert.rejects(
    env.deletion.deleteAccount(
      actor(deleted.principalId),
      deleteCommand(metadataStale, "delete-metadata-stale"),
    ),
    expectFailure("deletion_impact_changed"),
  );
  const postConflictToken = await env.tokens.createMcpToken({
    tokenId: "token_after_metadata_conflict",
    principalId: deleted.principalId,
    name: "Allowed after rollback",
    verifier: `hmac-sha256:v1:${"c".repeat(64)}`,
    displayPrefix: "mdp_v1_cccccc…",
    scopes: ["content:read"],
    createdAt: CREATED_AT,
    expiresAt: "2026-11-05T07:00:00.000Z",
  });
  assert.equal(postConflictToken.kind, "created");
});

test("unregistered identity and malformed destructive input are denied without mutation", async () => {
  const env = harness();
  const deleted = await createAccount(env, 1);
  await assert.rejects(
    env.deletion.getAccountDeletionImpact(preRegistrationActor(1)),
    expectFailure("authentication_required"),
  );
  const preview = await env.deletion.getAccountDeletionImpact(
    actor(deleted.principalId),
  );
  await assert.rejects(
    env.deletion.deleteAccount(actor(deleted.principalId), {
      ...deleteCommand(preview),
      impactId: "bad impact id",
    }),
    expectFailure("invalid_deletion_impact_id"),
  );
  assert.ok(await env.metadata.readAccount(deleted.principalId));
  assert.equal(
    (await env.metadata.inspectAccountDeletionCleanupForTest()).length,
    0,
  );
});

test("external cleanup failure never reports success and exact retry resumes without a deletion receipt", async () => {
  const baseIndex = new InMemoryExactRevisionSearchIndex();
  let failPurge = true;
  const index = {
    kind: "search-index",
    replaceExactRevision: (request) => baseIndex.replaceExactRevision(request),
    readExactRevision: (spaceId, revisionId) =>
      baseIndex.readExactRevision(spaceId, revisionId),
    purgeSpace: async (spaceId) => {
      if (failPurge) {
        failPurge = false;
        throw new Error("injected account cleanup failure");
      }
      return baseIndex.purgeSpace(spaceId);
    },
  };
  const env = harness({ index });
  const deleted = await createAccount(env, 1);
  await createMind(env, deleted, "cleanup-resume-owned");
  const tokenId = await seedToken(env, deleted.principalId);
  const preview = await env.deletion.getAccountDeletionImpact(
    actor(deleted.principalId),
  );
  const command = deleteCommand(preview, "cleanup-resume-account");
  await assert.rejects(
    env.deletion.deleteAccount(actor(deleted.principalId), command),
    expectFailure("deletion_cleanup_incomplete"),
  );
  assert.equal(await env.metadata.readAccount(deleted.principalId), null);
  assert.equal(
    (await env.tokens.readMcpTokenForAuthorization(tokenId)).state,
    "revoked",
  );
  assert.equal(
    (await env.metadata.inspectAccountDeletionCleanupForTest()).length,
    1,
  );

  const reconstructed = new AccountDeletionService({
    ...env.deletionDependencies,
    ids: deletionIds(),
  });
  const resumed = await reconstructed.deleteAccount(
    actor(deleted.principalId, "request_account_cleanup_resume"),
    command,
  );
  assert.equal(resumed.replayed, true);
  assert.deepEqual(await env.metadata.inspectAccountDeletionCleanupForTest(), []);
  await assert.rejects(
    reconstructed.deleteAccount(actor(deleted.principalId), command),
    expectFailure("deletion_impact_changed"),
  );
});

test("expiry, exact confirmation and every injected pre-commit stage leave the account intact", async () => {
  const expiryEnv = harness();
  const expiryAccount = await createAccount(expiryEnv, 1);
  const expired = await expiryEnv.deletion.getAccountDeletionImpact(
    actor(expiryAccount.principalId),
  );
  expiryEnv.now.value = expired.expiresAt;
  await assert.rejects(
    expiryEnv.deletion.deleteAccount(
      actor(expiryAccount.principalId),
      deleteCommand(expired, "expired-account-delete"),
    ),
    expectFailure("deletion_impact_expired"),
  );
  await assert.rejects(
    expiryEnv.deletion.deleteAccount(actor(expiryAccount.principalId), {
      ...deleteCommand(expired, "wrong-confirmation"),
      confirmation: "DELETE MY ACCOUNT",
    }),
    expectFailure("invalid_confirmation"),
  );
  assert.ok(await expiryEnv.metadata.readAccount(expiryAccount.principalId));

  for (const stage of [
    "delete_after_handle_retirement",
    "delete_after_target_records",
    "delete_after_foreign_tombstones",
    "delete_after_identity",
    "delete_after_cleanup_work",
    "delete_before_commit",
  ]) {
    const env = harness();
    const deleted = await createAccount(env, 1);
    const owned = await createMind(
      env,
      deleted,
      `rollback-${stage.slice(7, 22).replaceAll("_", "-")}`,
    );
    const tokenId = await seedToken(env, deleted.principalId);
    const preview = await env.deletion.getAccountDeletionImpact(
      actor(deleted.principalId),
    );
    env.metadata.failNextAccountDeletionAtForTest(stage);
    await assert.rejects(
      env.deletion.deleteAccount(
        actor(deleted.principalId),
        deleteCommand(preview, `rollback-${stage}`),
      ),
      /injected account deletion transaction failure/u,
    );
    assert.ok(await env.metadata.readAccount(deleted.principalId));
    assert.ok(await env.metadata.inspectOrdinaryMindStateForTest(owned.mindId));
    assert.equal(
      (await env.tokens.readMcpTokenForAuthorization(tokenId)).state,
      "active",
    );
    assert.deepEqual(await env.metadata.inspectRetiredHandlesForTest(), []);
    assert.deepEqual(await env.metadata.inspectAccountDeletionCleanupForTest(), []);
  }
});

test("token issuance racing deletion has one coherent terminal state", async () => {
  const env = harness();
  const deleted = await createAccount(env, 1);
  const preview = await env.deletion.getAccountDeletionImpact(
    actor(deleted.principalId),
  );
  const deletePromise = env.deletion.deleteAccount(
    actor(deleted.principalId, "request_account_delete_race"),
    deleteCommand(preview, "account-delete-race"),
  );
  const tokenPromise = env.tokens.createMcpToken({
    tokenId: "token_account_delete_race",
    principalId: deleted.principalId,
    name: "Racing token",
    verifier: `hmac-sha256:v1:${"d".repeat(64)}`,
    displayPrefix: "mdp_v1_dddddd…",
    scopes: ["content:read"],
    createdAt: CREATED_AT,
    expiresAt: "2026-11-05T07:00:00.000Z",
  });
  const [deleteOutcome, tokenOutcome] = await Promise.allSettled([
    deletePromise,
    tokenPromise,
  ]);
  if (deleteOutcome.status === "fulfilled") {
    assert.equal(tokenOutcome.status, "fulfilled");
    assert.equal(tokenOutcome.value.kind, "principal_deleted");
    assert.equal(await env.metadata.readAccount(deleted.principalId), null);
  } else {
    assert.equal(deleteOutcome.reason.code, "deletion_impact_changed");
    assert.equal(tokenOutcome.status, "fulfilled");
    assert.equal(tokenOutcome.value.kind, "created");
    assert.ok(await env.metadata.readAccount(deleted.principalId));
  }
});

test("concurrent exact deletion retries converge on one completed cascade", async () => {
  const env = harness();
  const deleted = await createAccount(env, 1);
  await createMind(env, deleted, "concurrent-account-delete");
  await seedToken(env, deleted.principalId);
  const preview = await env.deletion.getAccountDeletionImpact(
    actor(deleted.principalId),
  );
  const command = deleteCommand(preview, "concurrent-account-delete");
  const outcomes = await Promise.allSettled([
    env.deletion.deleteAccount(
      actor(deleted.principalId, "request_account_delete_concurrent_a"),
      command,
    ),
    env.deletion.deleteAccount(
      actor(deleted.principalId, "request_account_delete_concurrent_b"),
      command,
    ),
  ]);
  assert.equal(
    outcomes.every((outcome) => outcome.status === "fulfilled"),
    true,
    JSON.stringify(
      outcomes.map((outcome) =>
        outcome.status === "fulfilled"
          ? { status: outcome.status, replayed: outcome.value.replayed }
          : { status: outcome.status, code: outcome.reason?.code },
      ),
    ),
  );
  assert.equal(outcomes.some((outcome) => outcome.value.replayed), true);
  assert.equal(await env.metadata.readAccount(deleted.principalId), null);
  assert.deepEqual(await env.metadata.inspectAccountDeletionCleanupForTest(), []);
});

test("composition root wires one shared local account-cascade boundary", () => {
  const boundary = createLocalAccountDeletionBoundary({
    ids: deletionIds(),
    clock: { now: () => DELETE_AT },
    host: HOST,
  });
  assert.equal(boundary.metadata.kind, "metadata-store");
  assert.equal(boundary.tokens.kind, "metadata-store");
  assert.equal(boundary.objects.kind, "object-store");
  assert.equal(boundary.index.kind, "search-index");
  assert.equal(boundary.audit.kind, "audit-sink");
  assert.equal(boundary.deletion instanceof AccountDeletionService, true);
});
