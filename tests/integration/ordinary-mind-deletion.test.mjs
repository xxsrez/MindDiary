import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryAuditSink } from "@mind-diary/adapter-audit-memory";
import {
  InMemoryMcpTokenStore,
  InMemoryRevisionMetadataStore,
} from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import { InMemoryExactRevisionSearchIndex } from "@mind-diary/adapter-search-memory";
import { DEFAULT_CAPACITY_LIMITS } from "@mind-diary/application-content";
import {
  AccountBootstrapService,
  MIND_DELETION_IMPACT_LIFETIME_MINUTES,
  OrdinaryMindControlFailure,
  OrdinaryMindControlService,
  OrdinaryMindDeletionService,
  MindRouteService,
  PublicMindCatalogService,
} from "@mind-diary/application-control";
import {
  CAPABILITIES,
  bindingVersion,
  idempotencyKey,
  version,
  verifiedSpaceHost,
} from "@mind-diary/domain";

const CREATED_AT = "2026-08-07T06:00:00.000Z";
const DELETE_AT = "2026-08-07T06:10:00.000Z";
const HOST = verifiedSpaceHost("mind-diary.example");

function preRegistrationActor(index) {
  return {
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding: `deletion.owner.${index}@example.com`,
    suggestedDisplayName: `Deletion Owner ${index}`,
    deploymentCapabilities: CAPABILITIES,
    requestId: `request_deletion_bootstrap_${index}`,
    occurredAtUtc: CREATED_AT,
  };
}

function actor(principalId, requestId = "request_delete", occurredAtUtc = DELETE_AT) {
  return {
    kind: "registered_principal",
    principalId,
    authentication: { kind: "sites_identity" },
    deploymentCapabilities: CAPABILITIES,
    requestId,
    occurredAtUtc,
  };
}

function accountIds() {
  let id = 0;
  return {
    nextPrincipalId: () => `principal_delete_${++id}`,
    nextExternalBindingId: () => `binding_delete_${id}`,
    nextSpaceId: () => `space_personal_delete_${id}`,
    nextMembershipId: () => `membership_personal_delete_${id}`,
    nextRevisionId: () => `revision_personal_delete_${id}`,
    nextPersonalSpaceHandle: () => `personal-service-delete-${id}`,
  };
}

function ordinaryIds() {
  let spaces = 0;
  let memberships = 0;
  let revisions = 0;
  return {
    nextSpaceId: () => `space_delete_${++spaces}`,
    nextMembershipId: () => `membership_delete_${++memberships}`,
    nextRevisionId: () => `revision_delete_${++revisions}`,
  };
}

function deletionIds() {
  let impacts = 0;
  return { nextImpactId: () => `impact_delete_${++impacts}` };
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
  const deletionDependencies = {
    ordinaryMinds: metadata,
    objects,
    index,
    audit,
    exportArchives: objects,
    ids: deletionIds(),
    clock: { now: () => now.value },
    host: HOST,
  };
  const deletion = new OrdinaryMindDeletionService(deletionDependencies);
  const routes = new MindRouteService({ routes: metadata, host: HOST });
  const catalog = new PublicMindCatalogService({ catalog: metadata, host: HOST });
  return {
    metadata,
    objects,
    index,
    audit,
    tokens,
    now,
    bootstrap,
    ordinary,
    deletion,
    routes,
    catalog,
    deletionDependencies,
  };
}

async function createAccount(env, index) {
  return env.bootstrap.bootstrapAccount(preRegistrationActor(index), {
    action: "create_isolated_account",
  });
}

async function createMind(env, owner, handle = "delete-target") {
  return env.ordinary.createSpaceWithOwner(
    actor(owner.principalId, `request_create_${handle}`, CREATED_AT),
    { name: "Delete Target", handle, idempotencyKey: `create-${handle}` },
  );
}

test("Mind deletion waits for an unclosed canonical writer before retiring the handle", async () => {
  const env = harness();
  const owner = await createAccount(env, "pending-writer");
  const mind = await createMind(env, owner, "pending-writer-delete");
  const reservationId = `capacity:commit:${mind.mindId}:pending-delete`;
  const admitted = await env.metadata.runCapacityTransaction((transaction) =>
    transaction.admitCapacityReservation({
      reservationId,
      attemptId: "pending-delete-attempt",
      requestedByPrincipalId: owner.principalId,
      spaceId: mind.mindId,
      operation: "commit",
      operationRef: "pending-delete",
      baseRevisionId: mind.headRevisionId,
      idempotencyKey: idempotencyKey("pending-delete"),
      requested: { physicalCanonicalBytes: 1024, temporaryBytes: 0, d1MetadataBytes: 512 },
      bulk: false,
      heavy: false,
      createdAt: CREATED_AT,
      expiresAt: "2026-08-07T06:15:00.000Z",
    }, DEFAULT_CAPACITY_LIMITS));
  assert.equal(admitted.kind, "admitted");
  const preview = await env.deletion.getDeletionImpact(actor(owner.principalId), {
    handle: "pending-writer-delete",
  });
  const command = {
    handle: "pending-writer-delete",
    impactId: preview.impactId,
    confirmation: preview.confirmation,
    idempotencyKey: "delete-pending-writer",
  };
  await assert.rejects(env.deletion.deleteSpace(actor(owner.principalId), command),
    (error) => error instanceof OrdinaryMindControlFailure &&
      error.code === "deletion_cleanup_incomplete");
  assert.equal((await env.routes.resolveExactMind(actor(owner.principalId), command.handle)).mindId,
    mind.mindId);
  await env.metadata.runCapacityTransaction((transaction) =>
    transaction.cancelCapacityReservation({ reservationId, canceledAt: DELETE_AT }));
  assert.equal(await env.metadata.closeCapacityReservationWriter({
    reservationId, expectedAttemptId: "pending-delete-attempt", closedAt: DELETE_AT,
  }), true);
  assert.equal((await env.deletion.deleteSpace(actor(owner.principalId), command)).replayed, false);
});

async function seedPrincipalToken(env, principalId) {
  const created = await env.tokens.createMcpToken({
    tokenId: "token_survives_mind_delete",
    principalId,
    name: "Codex survives",
    verifier: `hmac-sha256:v1:${"1".repeat(64)}`,
    displayPrefix: "mdp_v1_ABC123…",
    scopes: ["content:read", "content:write"],
    createdAt: CREATED_AT,
    expiresAt: "2026-11-05T06:00:00.000Z",
  });
  assert.equal(created.kind, "created");
}

async function seedTargetBinding(env, principalId, spaceId) {
  const result = await env.metadata.runMindBindingTransaction((transaction) =>
    transaction.applyWriteMindBinding({
      bindingOwnerId: "binding_owner_mind_delete",
      principalId,
      action: "bind",
      spaceId,
      writeBindingId: "write_binding_mind_delete",
      expectedBindingVersion: bindingVersion(0),
      idempotencyKey: "bind-before-mind-delete",
      canonicalRequestHash: `sha256:${"7".repeat(64)}`,
      requestId: "request_bind_before_mind_delete",
      auditEventId: "audit_bind_before_mind_delete",
      auditOutboxMessageId: "outbox_bind_before_mind_delete",
      occurredAt: CREATED_AT,
    }),
  );
  assert.equal(result.kind, "applied");
  assert.equal(result.bindings.writeBinding.spaceId, spaceId);
}

async function seedExportLocators(env, target, principalId) {
  const job = {
    jobId: "export_delete_target",
    requestedByPrincipalId: principalId,
    spaceId: target.mindId,
    revisionId: target.headRevisionId,
    idempotencyKey: "export-before-delete",
    state: "queued",
    version: version(1),
    attempts: 0,
    availableAt: CREATED_AT,
    claimExpiresAt: null,
    expiresAt: "2026-08-08T06:00:00.000Z",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    completedAt: null,
    lastFailureCode: null,
    archive: null,
    archiveCleanedAt: null,
  };
  const created = await env.metadata.runExportStartTransaction((transaction) =>
    transaction.createExportJob(job),
  );
  assert.equal(created.kind, "created");
  const claimed = await env.metadata.claimExportJob(
    job.jobId,
    "2026-08-07T06:01:00.000Z",
    "2026-08-07T06:02:00.000Z",
  );
  assert.equal(claimed.kind, "claimed");
  const archiveBytes = new TextEncoder().encode("delete-target-export");
  const digest = await env.objects.calculateSha256(archiveBytes);
  const stored = await env.objects.putExportArchive({
    jobId: job.jobId,
    spaceId: target.mindId,
    claimVersion: claimed.job.version,
    bytes: archiveBytes,
    sha256: digest,
    createdAt: "2026-08-07T06:01:00.000Z",
  });
  assert.equal(stored.kind, "stored");
  assert.equal(
    await env.metadata.completeExportJob(
      job.jobId,
      claimed.job.version,
      stored.archive,
      "2026-08-07T06:01:30.000Z",
    ),
    true,
  );
  const grant = {
    secretVerifier: `hmac-sha256:export-download:v1:${"2".repeat(64)}`,
    jobId: job.jobId,
    requestedByPrincipalId: principalId,
    spaceId: target.mindId,
    revisionId: target.headRevisionId,
    objectKey: stored.archive.objectKey,
    state: "active",
    createdAt: "2026-08-07T06:02:00.000Z",
    expiresAt: "2026-08-07T06:07:00.000Z",
    revokedAt: null,
  };
  const grantResult = await env.metadata.runExportDownloadGrantTransaction(
    (transaction) => transaction.createExportDownloadGrant(grant),
  );
  assert.equal(grantResult.kind, "created");
  return { job, grant };
}

function expectFailure(code) {
  return (error) => {
    assert.equal(error instanceof OrdinaryMindControlFailure, true);
    assert.equal(error.code, code);
    return true;
  };
}

test("Owner preview is expiring, impact-bound and whole-Mind deletion leaves only a non-linkable retired handle", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const target = await createMind(env, owner);
  await seedPrincipalToken(env, owner.principalId);
  await seedTargetBinding(env, owner.principalId, target.mindId);
  assert.equal(
    await env.metadata.changeOrdinaryVisibilityForTest(
      target.mindId,
      "public",
      "2026-08-07T06:00:30.000Z",
    ),
    true,
  );
  const exportLocators = await seedExportLocators(
    env,
    target,
    owner.principalId,
  );
  const state = await env.metadata.inspectOrdinaryMindStateForTest(target.mindId);
  assert.ok(state);
  const targetDigests = state.revisions.flatMap((revision) =>
    revision.manifest.entries.map((entry) => entry.sha256),
  );
  await env.index.replaceExactRevision({
    spaceId: target.mindId,
    revisionId: target.headRevisionId,
    documents: [{ path: "index.md", text: "private target text" }],
  });
  await env.audit.deliver({
    auditEventId: "audit_delete_target",
    actor: { kind: "principal", principalId: owner.principalId },
    requestId: "request_audit_target",
    eventType: "space.test",
    outcome: "succeeded",
    spaceId: target.mindId,
    occurredAt: CREATED_AT,
    safeMetadata: {},
  });
  assert.equal(
    (await env.catalog.listPublicMinds(actor(owner.principalId))).minds.some(
      (mind) => mind.mindId === target.mindId,
    ),
    true,
  );
  assert.equal(
    (await env.routes.listMinds(actor(owner.principalId))).some(
      (mind) => mind.mindId === target.mindId,
    ),
    true,
  );

  const preview = await env.deletion.getDeletionImpact(
    actor(owner.principalId, "request_delete_preview"),
    { handle: target.handle },
  );
  assert.equal(preview.mind.route, `/${target.handle}`);
  assert.equal(preview.revisionCount, 1);
  assert.equal(preview.membershipCount, 1);
  assert.equal(preview.pendingInvitationCount, 0);
  assert.equal(preview.exportJobCount, 1);
  assert.equal(preview.irreversible, true);
  assert.equal(preview.recoveryAvailable, false);
  assert.equal(preview.forensicReceiptRetained, false);
  assert.equal(preview.confirmation, `delete-mind:${target.handle}`);
  assert.equal(
    Date.parse(preview.expiresAt) - Date.parse(DELETE_AT),
    MIND_DELETION_IMPACT_LIFETIME_MINUTES * 60_000,
  );

  const result = await env.deletion.deleteSpace(
    actor(owner.principalId, "request_delete_commit"),
    {
      handle: target.handle,
      impactId: preview.impactId,
      confirmation: preview.confirmation,
      idempotencyKey: "delete-target-once",
    },
  );
  assert.equal(result.replayed, false);
  assert.equal(await env.metadata.inspectOrdinaryMindStateForTest(target.mindId), null);
  const bindingsAfterDeletion = await env.metadata.readMindBindingSet(
    "binding_owner_mind_delete",
    owner.principalId,
    DELETE_AT,
  );
  assert.equal(bindingsAfterDeletion.writeBinding, null);
  assert.deepEqual(bindingsAfterDeletion.readBindings, []);
  assert.equal(await env.metadata.readHead(target.mindId), null);
  assert.equal(
    await env.metadata.readRevision(target.mindId, target.headRevisionId),
    null,
  );
  assert.deepEqual(
    await env.metadata.resolveHandle({ host: HOST, handle: target.handle }),
    { kind: "not_found" },
  );
  assert.equal(
    (await env.metadata.reserveHandle({
      host: HOST,
      handle: target.handle,
      spaceId: "space_reuse_attempt",
    })).kind,
    "handle_unavailable",
  );
  assert.deepEqual(
    await env.index.readExactRevision(target.mindId, target.headRevisionId),
    { kind: "unavailable" },
  );
  assert.equal(env.audit.deliveredForTest().length, 0);
  assert.equal(
    (await env.catalog.listPublicMinds(actor(owner.principalId))).minds.some(
      (mind) => mind.mindId === target.mindId,
    ),
    false,
  );
  assert.equal(
    (await env.routes.listMinds(actor(owner.principalId))).some(
      (mind) => mind.mindId === target.mindId,
    ),
    false,
  );
  await assert.rejects(
    env.routes.resolveExactMind(actor(owner.principalId), target.handle),
    (error) => error.code === "mind_not_found",
  );
  assert.equal(await env.metadata.readExportJob(exportLocators.job.jobId), null);
  assert.deepEqual(
    await env.metadata.readExportDownloadGrant(
      exportLocators.grant.secretVerifier,
      DELETE_AT,
    ),
    { kind: "not_found" },
  );
  assert.equal(
    await env.objects.readExportArchive(exportLocators.grant.objectKey),
    null,
  );
  assert.equal(
    (await env.tokens.readMcpTokenForAuthorization(
      "token_survives_mind_delete",
    )).state,
    "active",
  );
  assert.deepEqual(await env.metadata.inspectDeletionCleanupForTest(), []);
  const markers = await env.metadata.inspectRetiredHandlesForTest();
  assert.deepEqual(markers, [{ host: HOST, canonicalHandle: target.handle }]);
  assert.equal(JSON.stringify(markers).includes(target.mindId), false);
  assert.equal(JSON.stringify(markers).includes(owner.principalId), false);
  for (const digest of targetDigests) {
    assert.equal(await env.objects.getImmutable(digest), null);
  }

  const retry = await env.deletion.deleteSpace(
    actor(owner.principalId, "request_delete_retry"),
    {
      handle: target.handle,
      impactId: preview.impactId,
      confirmation: preview.confirmation,
      idempotencyKey: "delete-target-once",
    },
  );
  assert.equal(retry.replayed, true);
  assert.deepEqual(await env.metadata.inspectDeletionCleanupForTest(), []);
});

test("Personal Mind, non-owner, stale, expired and malformed confirmation paths fail closed", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const stranger = await createAccount(env, 2);
  const target = await createMind(env, owner, "guarded-delete");
  await assert.rejects(
    env.deletion.getDeletionImpact(actor(owner.principalId), {
      handle: "me",
    }),
    expectFailure("personal_mind_operation_forbidden"),
  );
  await assert.rejects(
    env.deletion.getDeletionImpact(actor(stranger.principalId), {
      handle: target.handle,
    }),
    expectFailure("forbidden"),
  );

  const stale = await env.deletion.getDeletionImpact(actor(owner.principalId), {
    handle: target.handle,
  });
  assert.equal(
    await env.metadata.bumpOrdinaryMindMetadataVersionForTest(
      target.mindId,
      "2026-08-07T06:11:00.000Z",
    ),
    true,
  );
  await assert.rejects(
    env.deletion.deleteSpace(actor(owner.principalId), {
      handle: target.handle,
      impactId: stale.impactId,
      confirmation: stale.confirmation,
      idempotencyKey: "stale-delete",
    }),
    expectFailure("deletion_impact_changed"),
  );
  assert.ok(await env.metadata.inspectOrdinaryMindStateForTest(target.mindId));

  const expired = await env.deletion.getDeletionImpact(actor(owner.principalId), {
    handle: target.handle,
  });
  env.now.value = expired.expiresAt;
  await assert.rejects(
    env.deletion.deleteSpace(actor(owner.principalId), {
      handle: target.handle,
      impactId: expired.impactId,
      confirmation: expired.confirmation,
      idempotencyKey: "expired-delete",
    }),
    expectFailure("deletion_impact_expired"),
  );
  await assert.rejects(
    env.deletion.deleteSpace(actor(owner.principalId), {
      handle: target.handle,
      impactId: expired.impactId,
      confirmation: "delete-mind:another-target",
      idempotencyKey: "wrong-confirmation",
    }),
    expectFailure("invalid_confirmation"),
  );
  assert.ok(await env.metadata.inspectOrdinaryMindStateForTest(target.mindId));
});

test("shared content objects survive and durable cleanup work resumes after service reconstruction", async () => {
  let failPurge = true;
  const baseIndex = new InMemoryExactRevisionSearchIndex();
  const failingIndex = {
    kind: "search-index",
    replaceExactRevision: (request) => baseIndex.replaceExactRevision(request),
    readExactRevision: (spaceId, revisionId) =>
      baseIndex.readExactRevision(spaceId, revisionId),
    purgeSpace: async (spaceId) => {
      if (failPurge) {
        failPurge = false;
        throw new Error("injected deletion cleanup failure");
      }
      return baseIndex.purgeSpace(spaceId);
    },
  };
  const env = harness({ index: failingIndex });
  const owner = await createAccount(env, 1);
  const stranger = await createAccount(env, 2);
  const first = await createMind(env, owner, "shared-delete-a");
  const second = await createMind(env, owner, "shared-delete-b");
  const firstState = await env.metadata.inspectOrdinaryMindStateForTest(first.mindId);
  const secondState = await env.metadata.inspectOrdinaryMindStateForTest(second.mindId);
  assert.ok(firstState);
  assert.ok(secondState);
  assert.deepEqual(
    firstState.revisions[0].manifest.entries.map((entry) => entry.sha256),
    secondState.revisions[0].manifest.entries.map((entry) => entry.sha256),
  );
  const preview = await env.deletion.getDeletionImpact(actor(owner.principalId), {
    handle: first.handle,
  });
  const command = {
    handle: first.handle,
    impactId: preview.impactId,
    confirmation: preview.confirmation,
    idempotencyKey: "resume-delete",
  };
  await assert.rejects(
    env.deletion.deleteSpace(actor(owner.principalId), command),
    /deletion cleanup is incomplete/u,
  );
  assert.equal(await env.metadata.inspectOrdinaryMindStateForTest(first.mindId), null);
  assert.equal((await env.metadata.inspectDeletionCleanupForTest()).length, 1);

  const reconstructed = new OrdinaryMindDeletionService({
    ...env.deletionDependencies,
    ids: deletionIds(),
  });
  await assert.rejects(
    reconstructed.deleteSpace(
      actor(stranger.principalId, "request_foreign_resume_delete"),
      command,
    ),
    expectFailure("mind_not_found"),
  );
  assert.equal((await env.metadata.inspectDeletionCleanupForTest()).length, 1);
  const resumed = await reconstructed.deleteSpace(
    actor(owner.principalId, "request_resume_delete"),
    command,
  );
  assert.equal(resumed.replayed, true);
  assert.deepEqual(await env.metadata.inspectDeletionCleanupForTest(), []);
  assert.ok(await env.metadata.inspectOrdinaryMindStateForTest(second.mindId));
  for (const entry of secondState.revisions[0].manifest.entries) {
    assert.equal(await env.objects.getSpaceCanonicalObject("markdown", first.mindId, entry.sha256), null);
    assert.ok(await env.objects.getSpaceCanonicalObject("markdown", second.mindId, entry.sha256));
  }
});

test("delete racing metadata writers has exactly one valid terminal state", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const target = await createMind(env, owner, "delete-race");
  const preview = await env.deletion.getDeletionImpact(actor(owner.principalId), {
    handle: target.handle,
  });
  const deletePromise = env.deletion.deleteSpace(
    actor(owner.principalId, "request_delete_race"),
    {
      handle: target.handle,
      impactId: preview.impactId,
      confirmation: preview.confirmation,
      idempotencyKey: "delete-race",
    },
  );
  const renamePromises = Array.from({ length: 12 }, (_, index) =>
    env.ordinary.renameSpace(
      actor(owner.principalId, `request_rename_delete_race_${index}`),
      {
        mindId: target.mindId,
        name: `Race Winner ${index}`,
        expectedMetadataVersion: target.metadataVersion,
        idempotencyKey: `rename-delete-race-${index}`,
      },
    ),
  );
  const [deleteOutcome, ...renameOutcomes] = await Promise.allSettled([
    deletePromise,
    ...renamePromises,
  ]);
  const renameWinners = renameOutcomes.filter(
    (outcome) => outcome.status === "fulfilled",
  );
  if (deleteOutcome.status === "fulfilled") {
    assert.equal(renameWinners.length, 0);
    assert.equal(
      await env.metadata.inspectOrdinaryMindStateForTest(target.mindId),
      null,
    );
    assert.equal((await env.metadata.inspectRetiredHandlesForTest()).length, 1);
  } else {
    assert.equal(deleteOutcome.reason.code, "deletion_impact_changed");
    assert.equal(renameWinners.length, 1);
    const final = await env.metadata.inspectOrdinaryMindStateForTest(target.mindId);
    assert.ok(final);
    assert.equal(final.space.name, renameWinners[0].value.name);
    assert.deepEqual(await env.metadata.inspectRetiredHandlesForTest(), []);
    assert.deepEqual(await env.metadata.inspectDeletionCleanupForTest(), []);
  }
});

test("every injected pre-commit deletion stage rolls back aggregate, retirement and cleanup", async () => {
  for (const stage of [
    "delete_after_handle_retirement",
    "delete_after_target_records",
    "delete_after_catalog",
    "delete_after_cleanup_work",
    "delete_before_commit",
  ]) {
    const env = harness();
    const owner = await createAccount(env, 1);
    const target = await createMind(
      env,
      owner,
      `rollback-${stage.slice(7, 18).replaceAll("_", "-")}`,
    );
    const before = await env.metadata.inspectOrdinaryMindStateForTest(target.mindId);
    const preview = await env.deletion.getDeletionImpact(actor(owner.principalId), {
      handle: target.handle,
    });
    const command = {
      handle: target.handle,
      impactId: preview.impactId,
      confirmation: preview.confirmation,
      idempotencyKey: `delete-${stage}`,
    };
    env.metadata.failNextOrdinaryMindAtForTest(stage);
    await assert.rejects(
      env.deletion.deleteSpace(actor(owner.principalId), command),
      /injected ordinary Mind transaction failure/u,
    );
    assert.deepEqual(
      await env.metadata.inspectOrdinaryMindStateForTest(target.mindId),
      before,
    );
    assert.deepEqual(await env.metadata.inspectRetiredHandlesForTest(), []);
    assert.deepEqual(await env.metadata.inspectDeletionCleanupForTest(), []);
    assert.deepEqual(
      await env.metadata.resolveHandle({ host: HOST, handle: target.handle }),
      { kind: "resolved", spaceId: target.mindId },
    );

    const recovered = await env.deletion.deleteSpace(
      actor(owner.principalId, `request_recover_${stage}`),
      command,
    );
    assert.equal(recovered.replayed, false);
    assert.equal(
      await env.metadata.inspectOrdinaryMindStateForTest(target.mindId),
      null,
    );
  }
});

test("new previews prune expired impact state while pending cleanup IDs remain reserved", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const first = await createMind(env, owner, "preview-expiry-a");
  const second = await createMind(env, owner, "preview-expiry-b");
  const expired = await env.deletion.getDeletionImpact(
    actor(owner.principalId, "request_expiring_preview"),
    { handle: first.handle },
  );
  assert.deepEqual(
    (await env.metadata.inspectDeletionImpactsForTest()).map(
      (impact) => impact.impactId,
    ),
    [expired.impactId],
  );

  env.now.value = expired.expiresAt;
  const current = await env.deletion.getDeletionImpact(
    actor(owner.principalId, "request_preview_prunes_expired"),
    { handle: second.handle },
  );
  assert.notEqual(current.impactId, expired.impactId);
  assert.deepEqual(
    (await env.metadata.inspectDeletionImpactsForTest()).map(
      (impact) => impact.impactId,
    ),
    [current.impactId],
  );

  let failPurge = true;
  const baseIndex = new InMemoryExactRevisionSearchIndex();
  const failingIndex = {
    kind: "search-index",
    replaceExactRevision: (request) => baseIndex.replaceExactRevision(request),
    readExactRevision: (spaceId, revisionId) =>
      baseIndex.readExactRevision(spaceId, revisionId),
    purgeSpace: async (spaceId) => {
      if (failPurge) {
        failPurge = false;
        throw new Error("injected pending cleanup");
      }
      return baseIndex.purgeSpace(spaceId);
    },
  };
  const pendingEnv = harness({ index: failingIndex });
  const pendingOwner = await createAccount(pendingEnv, 1);
  const deletedMind = await createMind(
    pendingEnv,
    pendingOwner,
    "preview-cleanup-a",
  );
  const otherMind = await createMind(
    pendingEnv,
    pendingOwner,
    "preview-cleanup-b",
  );
  const pendingPreview = await pendingEnv.deletion.getDeletionImpact(
    actor(pendingOwner.principalId, "request_pending_cleanup_preview"),
    { handle: deletedMind.handle },
  );
  const pendingCommand = {
    handle: deletedMind.handle,
    impactId: pendingPreview.impactId,
    confirmation: pendingPreview.confirmation,
    idempotencyKey: "pending-preview-delete",
  };
  await assert.rejects(
    pendingEnv.deletion.deleteSpace(
      actor(pendingOwner.principalId, "request_pending_cleanup_delete"),
      pendingCommand,
    ),
    expectFailure("deletion_cleanup_incomplete"),
  );
  assert.equal((await pendingEnv.metadata.inspectDeletionCleanupForTest()).length, 1);

  const reconstructed = new OrdinaryMindDeletionService({
    ...pendingEnv.deletionDependencies,
    ids: { nextImpactId: () => pendingPreview.impactId },
  });
  await assert.rejects(
    reconstructed.getDeletionImpact(
      actor(pendingOwner.principalId, "request_colliding_cleanup_impact"),
      { handle: otherMind.handle },
    ),
    expectFailure("ordinary_mind_unavailable"),
  );
  assert.equal((await pendingEnv.metadata.inspectDeletionCleanupForTest()).length, 1);
  const resumed = await reconstructed.deleteSpace(
    actor(pendingOwner.principalId, "request_resume_colliding_cleanup"),
    pendingCommand,
  );
  assert.equal(resumed.replayed, true);
  assert.deepEqual(await pendingEnv.metadata.inspectDeletionCleanupForTest(), []);
});

test("concurrent Space object re-put advances protectedAt and leaves deletion cleanup pending", async () => {
  const base = new InMemoryObjectStore();
  let protectOnNextDelete = false;
  const objects = {
    kind: "object-store",
    calculateSha256: (bytes) => base.calculateSha256(bytes),
    putImmutable: (request) => base.putImmutable(request),
    getImmutable: (digest) => base.getImmutable(digest),
    listImmutableObjects: (request) => base.listImmutableObjects(request),
    deleteImmutableObject: async (request) => {
      if (protectOnNextDelete) {
        protectOnNextDelete = false;
        const current = await base.getImmutable(request.sha256);
        assert.ok(current);
        await base.putImmutable({
          bytes: current.bytes,
          mediaType: current.mediaType,
          createdAt: "2026-08-07T06:10:01.000Z",
        });
      }
      return base.deleteImmutableObject(request);
    },
    putSpaceCanonicalObject: (request) => base.putSpaceCanonicalObject(request),
    getSpaceCanonicalObject: (kind, spaceId, digest) =>
      base.getSpaceCanonicalObject(kind, spaceId, digest),
    listSpaceCanonicalObjects: (request) => base.listSpaceCanonicalObjects(request),
    deleteSpaceCanonicalObject: async (request) => {
      if (protectOnNextDelete) {
        protectOnNextDelete = false;
        const current = await base.getSpaceCanonicalObject(
          request.kind, request.spaceId, request.sha256,
        );
        assert.ok(current);
        await base.putSpaceCanonicalObject({
          kind: request.kind,
          spaceId: request.spaceId,
          bytes: current.bytes,
          mediaType: current.mediaType,
          createdAt: "2026-08-07T06:10:01.000Z",
        });
      }
      return base.deleteSpaceCanonicalObject(request);
    },
    putBundleFile: (request) => base.putBundleFile(request),
    getBundleFile: (spaceId, digest) => base.getBundleFile(spaceId, digest),
    listBundleFileObjects: (request) => base.listBundleFileObjects(request),
    deleteBundleFileObject: (request) => base.deleteBundleFileObject(request),
    putStagedBundleFile: (request) => base.putStagedBundleFile(request),
    getStagedBundleFile: (id) => base.getStagedBundleFile(id),
    deleteStagedBundleFile: (id) => base.deleteStagedBundleFile(id),
    putExportArchive: (request) => base.putExportArchive(request),
    readExportArchive: (key) => base.readExportArchive(key),
    deleteExportArchive: (key) => base.deleteExportArchive(key),
    deleteExportArchivesForJob: (jobId) =>
      base.deleteExportArchivesForJob(jobId),
    deleteExportArchivesForSpace: (spaceId) =>
      base.deleteExportArchivesForSpace(spaceId),
  };
  const env = harness({ objects });
  const owner = await createAccount(env, 1);
  const target = await createMind(env, owner, "protected-reput");
  const state = await env.metadata.inspectOrdinaryMindStateForTest(target.mindId);
  assert.ok(state);
  const digests = state.revisions[0].manifest.entries.map((entry) => entry.sha256);
  const preview = await env.deletion.getDeletionImpact(actor(owner.principalId), {
    handle: target.handle,
  });
  protectOnNextDelete = true;
  await assert.rejects(env.deletion.deleteSpace(actor(owner.principalId), {
    handle: target.handle,
    impactId: preview.impactId,
    confirmation: preview.confirmation,
    idempotencyKey: "protected-reput-delete",
  }), /deletion cleanup is incomplete/u);
  const retained = await base.listSpaceCanonicalObjects({
    spaceId: target.mindId,
    createdBefore: "2026-08-07T06:11:00.000Z",
    excluded: [],
    limit: 10,
  });
  assert.equal(retained.length, 1);
  assert.equal(retained[0].protectedAt, "2026-08-07T06:10:01.000Z");
  assert.ok(digests.includes(retained[0].sha256));
  assert.equal((await env.metadata.inspectDeletionCleanupForTest()).length, 1);
});
