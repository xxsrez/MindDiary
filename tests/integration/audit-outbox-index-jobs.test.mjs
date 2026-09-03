import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAuditSink } from "@mind-diary/adapter-audit-memory";
import { createBackgroundServiceActor } from "@mind-diary/adapter-background";
import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import { InMemoryExactRevisionSearchIndex } from "@mind-diary/adapter-search-memory";
import {
  AuditOutboxDeliveryHandler,
  ReadyExactRevisionIndexService,
  RevisionIndexJobHandler,
  RevisionIndexStatusService,
  SpaceTargetRecordPurgeService,
  UnreachableObjectGcHandler,
} from "@mind-diary/application-background";
import {
  CanonicalRevisionCoordinator,
  ChangesetCommitService,
} from "@mind-diary/application-content";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";
import { CAPABILITIES, MARKDOWN_MEDIA_TYPE, version } from "@mind-diary/domain";
import {
  CANONICAL_REVISION_FILES,
  FIXED_NOW,
  MINDS,
  PRINCIPALS,
  REVISION_AUTHORS,
  REVISIONS,
} from "@mind-diary/test-fixtures";

const FUTURE = "2026-11-03T12:00:00.000Z";

function principalActor(requestId = "request_audit_index") {
  return {
    kind: "registered_principal",
    principalId: PRINCIPALS.editor.principalId,
    authentication: {
      kind: "mcp_token",
      tokenId: "token_audit_index",
      effectiveScopes: ["content:read", "content:write"],
    },
    deploymentCapabilities: CAPABILITIES,
    requestId,
    occurredAtUtc: FIXED_NOW,
  };
}

function serviceActor(at = REVISIONS.next.committedAt) {
  return createBackgroundServiceActor({
    serviceId: "mind-diary-background",
    requestId: "request_background",
    occurredAtUtc: at,
  });
}

function authorizationState(actor) {
  return {
    principal: { principalId: actor.principalId, state: "active" },
    space: {
      spaceId: MINDS.ordinary.spaceId,
      state: "active",
      visibility: "private",
      accessVersion: version(1),
    },
    membership: {
      principalId: actor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      role: "editor",
      state: "active",
      version: version(1),
    },
    token: {
      tokenId: actor.authentication.tokenId,
      principalId: actor.principalId,
      state: "active",
      scopes: ["content:read", "content:write"],
      version: version(1),
      expiresAt: FUTURE,
    },
  };
}

function operations(path, title, privateBody = "") {
  return [
    {
      type: "create_file",
      path,
      text: `---\ntype: Reference\ntitle: ${title}\n---\n\n# ${title}\n${privateBody}`,
    },
    {
      type: "replace_index",
      path: "index.md",
      text: `---\nokf_version: "0.2"\n---\n\n# Fixture Mind\n\n- [Reproducible baseline](concepts/baseline.md)\n- [${title}](${path})\n`,
    },
  ];
}

function principalMountedMetadata(metadata) {
  const generation = Object.freeze({
    principalId: PRINCIPALS.editor.principalId,
    spaceId: MINDS.ordinary.spaceId,
    generationId: "usage_generation_audit_index",
  });
  const readUsage = async (principalId) => principalId === generation.principalId
    ? Object.freeze({
        principalId,
        entries: Object.freeze([Object.freeze({
          principalId,
          spaceId: generation.spaceId,
          usageMode: "read_write",
          writeGeneration: generation,
        })]),
        ordinaryWriteGeneration: generation,
      })
    : null;
  const validatePin = async (pin) =>
    pin.principalId === generation.principalId &&
    pin.spaceId === generation.spaceId &&
    pin.generationId === generation.generationId;
  const wrapTransaction = (transaction) => Object.freeze({
    ...transaction,
    readPrincipalMindUsage: readUsage,
    validatePrincipalMindUsageWritePin: validatePin,
  });
  return new Proxy(metadata, {
    get(target, property) {
      if (property === "readPrincipalMindUsage") return readUsage;
      if (property === "validatePrincipalMindUsageWritePin") return validatePin;
      if (property === "runContentCommitTransaction") {
        return (operation) => target.runContentCommitTransaction((transaction) =>
          operation(wrapTransaction(transaction)));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function fixture() {
  const objects = new InMemoryObjectStore();
  const metadata = principalMountedMetadata(new InMemoryRevisionMetadataStore());
  const revisions = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  const seeded = await revisions.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: null,
    revisionId: REVISIONS.initial.revisionId,
    committedAt: REVISIONS.initial.committedAt,
    committedBy: REVISION_AUTHORS.active,
    summary: "Seed background fixture",
    files: CANONICAL_REVISION_FILES,
  });
  assert.equal(seeded.kind, "committed");
  const actor = principalActor();
  metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: actor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      tokenId: actor.authentication.tokenId,
    },
    authorizationState(actor),
  );
  const authorizer = new CapabilityAuthorizer(metadata);
  const commit = (revisionIds, effectIds) => {
    let nextRevision = 0;
    return new ChangesetCommitService({
      authorizer,
      metadata,
      revisions,
      objects,
      clock: { now: () => REVISIONS.next.committedAt },
      revisionIds: {
        nextRevisionId: () => revisionIds[nextRevision++],
      },
      ...(effectIds ? { effectIds } : {}),
    });
  };
  return { actor, objects, metadata, revisions, commit };
}

test("successful commit atomically stages safe audit, outbox, idempotency and one exact index job", async () => {
  const env = await fixture();
  const service = env.commit(["revision_audit_index_safe"]);
  const result = await service.commit({
    actor: env.actor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "safe_effects",
    summary: "private@example.test bearer-private private query",
    operations: operations(
      "concepts/safe-effects.md",
      "Safe effects",
      "private-body-marker bearer-private",
    ),
  });
  assert.equal(result.kind, "committed");
  const [event] = await env.metadata.listAuditEventsForTest();
  const [outbox] = await env.metadata.listAuditOutboxForTest();
  const [job] = await env.metadata.listBackgroundJobsForTest();
  const [idempotency] = await env.metadata.listIdempotencyRecordsForTest();
  assert.equal(event.spaceId, MINDS.ordinary.spaceId);
  assert.equal(event.safeMetadata.revision_id, "revision_audit_index_safe");
  assert.doesNotMatch(
    JSON.stringify(event.safeMetadata),
    /private-body-marker|private@example|bearer-private|private query/iu,
  );
  assert.equal(outbox.auditEventId, event.auditEventId);
  assert.deepEqual(job.target, {
    kind: "revision_index",
    spaceId: MINDS.ordinary.spaceId,
    revisionId: "revision_audit_index_safe",
  });
  assert.equal(idempotency.result.revisionId, "revision_audit_index_safe");
  assert.equal(
    (await env.metadata.readRevisionIndexState(
      MINDS.ordinary.spaceId,
      "revision_audit_index_safe",
    )).status,
    "queued",
  );

  const replay = await service.commit({
    actor: env.actor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "safe_effects",
    summary: "private@example.test bearer-private private query",
    operations: operations(
      "concepts/safe-effects.md",
      "Safe effects",
      "private-body-marker bearer-private",
    ),
  });
  assert.equal(replay.kind, "committed");
  assert.equal(replay.replayed, true);
  assert.equal((await env.metadata.listAuditEventsForTest()).length, 1);
  assert.equal((await env.metadata.listAuditOutboxForTest()).length, 1);
  assert.equal((await env.metadata.listBackgroundJobsForTest()).length, 1);
});

test("effect collision rolls back revision, HEAD and idempotency in the same transaction", async () => {
  const env = await fixture();
  const fixedEffects = {
    nextAuditEventId: () => "audit_fixed",
    nextOutboxMessageId: () => "outbox_fixed",
    nextIndexJobId: () => "job_fixed",
  };
  const firstService = env.commit(["revision_effect_first"], fixedEffects);
  assert.equal(
    (await firstService.commit({
      actor: env.actor,
      spaceId: MINDS.ordinary.spaceId,
      expectedRevisionId: REVISIONS.initial.revisionId,
      idempotencyKey: "effect_first",
      summary: "First",
      operations: operations("concepts/first.md", "First"),
    })).kind,
    "committed",
  );
  const secondService = env.commit(["revision_effect_second"], fixedEffects);
  await assert.rejects(
    secondService.commit({
      actor: env.actor,
      spaceId: MINDS.ordinary.spaceId,
      expectedRevisionId: "revision_effect_first",
      idempotencyKey: "effect_second",
      summary: "Second",
      operations: operations("concepts/second.md", "Second"),
    }),
    /commit effects were not staged atomically/u,
  );
  assert.equal(await env.metadata.readHead(MINDS.ordinary.spaceId), "revision_effect_first");
  assert.equal(
    await env.metadata.readRevision(MINDS.ordinary.spaceId, "revision_effect_second"),
    null,
  );
  assert.equal((await env.metadata.listIdempotencyRecordsForTest()).length, 1);
});

test("commit audit metadata rejects extra keys and private values atomically", async () => {
  const env = await fixture();
  const occurredAt = REVISIONS.next.committedAt;
  const initial = await env.metadata.readRevision(
    MINDS.ordinary.spaceId,
    REVISIONS.initial.revisionId,
  );
  assert.ok(initial);
  const effects = (safeMetadata, suffix) => ({
    auditEvent: {
      auditEventId: `audit_invalid_${suffix}`,
      actor: { kind: "principal", principalId: env.actor.principalId },
      requestId: `request_invalid_${suffix}`,
      eventType: "content.changeset_committed",
      outcome: "succeeded",
      spaceId: MINDS.ordinary.spaceId,
      occurredAt,
      safeMetadata,
    },
    auditOutbox: {
      outboxMessageId: `outbox_invalid_${suffix}`,
      auditEventId: `audit_invalid_${suffix}`,
      state: "pending",
      version: version(1),
      attempts: 0,
      availableAt: occurredAt,
      claimExpiresAt: null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    },
    indexJob: {
      jobId: `job_invalid_${suffix}`,
      target: {
        kind: "revision_index",
        spaceId: MINDS.ordinary.spaceId,
        revisionId: REVISIONS.initial.revisionId,
      },
      state: "queued",
      version: version(1),
      attempts: 0,
      availableAt: occurredAt,
      claimExpiresAt: null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    },
    indexState: {
      spaceId: MINDS.ordinary.spaceId,
      revisionId: REVISIONS.initial.revisionId,
      status: "queued",
      attempts: 0,
      queuedAt: occurredAt,
      updatedAt: occurredAt,
      readyAt: null,
      lastFailureCode: null,
    },
  });
  const validBase = () => ({
    revision_id: initial.revision.revisionId,
    previous_revision_id: initial.revision.parentRevisionId,
    revision_number: initial.revision.revisionNumber,
    manifest_hash: initial.revision.manifestHash,
  });
  const extra = await env.metadata.runContentCommitTransaction((transaction) =>
    transaction.stageContentCommitEffects(
      effects({ ...validBase(), harmless: "private body" }, "extra"),
    ),
  );
  const privateValue = await env.metadata.runContentCommitTransaction((transaction) =>
    transaction.stageContentCommitEffects(
      effects(
        { ...validBase(), previous_revision_id: "private_query_and_bearer_material" },
        "value",
      ),
    ),
  );
  assert.equal(extra.kind, "invalid_effects");
  assert.equal(privateValue.kind, "invalid_effects");
  assert.equal((await env.metadata.listAuditEventsForTest()).length, 0);
  assert.equal((await env.metadata.listAuditOutboxForTest()).length, 0);
  assert.equal((await env.metadata.listBackgroundJobsForTest()).length, 0);
});

test("index worker uses requested revision, exposes lag/failure and never substitutes HEAD", async () => {
  const env = await fixture();
  const service = env.commit(["revision_index_requested", "revision_index_failed"]);
  assert.equal(
    (await service.commit({
      actor: env.actor,
      spaceId: MINDS.ordinary.spaceId,
      expectedRevisionId: REVISIONS.initial.revisionId,
      idempotencyKey: "index_requested",
      summary: "Requested",
      operations: operations("concepts/requested.md", "Requested"),
    })).kind,
    "committed",
  );
  const advanced = await env.revisions.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_index_requested",
    revisionId: "revision_new_head",
    committedAt: "2026-08-06T13:00:00.000Z",
    committedBy: REVISION_AUTHORS.active,
    summary: "Advance HEAD outside requested job",
    files: [
      ...CANONICAL_REVISION_FILES,
      {
        path: "concepts/new-head.md",
        mediaType: MARKDOWN_MEDIA_TYPE,
        bytes: new TextEncoder().encode(
          "---\ntype: Reference\ntitle: New HEAD\n---\n\n# New HEAD\n",
        ),
      },
    ],
  });
  assert.equal(advanced.kind, "committed");
  const index = new InMemoryExactRevisionSearchIndex();
  const clock = { now: () => "2026-08-06T13:01:00.000Z" };
  const handler = new RevisionIndexJobHandler({
    work: env.metadata,
    revisions: env.revisions,
    index,
    clock,
  });
  assert.deepEqual(await handler.handle({
    actor: serviceActor(clock.now()),
    jobId: "index_job_revision_index_requested",
  }), { kind: "completed" });
  assert.equal(
    (await index.readExactRevision(
      MINDS.ordinary.spaceId,
      "revision_index_requested",
    )).documents.some((document) => document.path === "concepts/requested.md"),
    true,
  );
  assert.deepEqual(
    await index.readExactRevision(MINDS.ordinary.spaceId, "revision_new_head"),
    { kind: "unavailable" },
  );
  const status = await new RevisionIndexStatusService(env.metadata).read({
    spaceId: MINDS.ordinary.spaceId,
    revisionId: "revision_index_requested",
    currentHeadRevisionId: "revision_new_head",
  });
  assert.equal(status.status, "ready");
  assert.equal(status.lagging, false);
  assert.equal(status.isCurrentHead, false);

  const mismatchingMaterializer = {
    materialize: () => env.revisions.materialize(
      MINDS.ordinary.spaceId,
      "revision_new_head",
    ),
  };
  const queued = await service.commit({
    actor: env.actor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_new_head",
    idempotencyKey: "index_mismatch",
    summary: "Queue mismatch check",
    operations: operations("concepts/index-mismatch.md", "Index mismatch"),
  });
  assert.equal(queued.kind, "committed");
  assert.equal(queued.envelope.revision.revisionId, "revision_index_failed");
  const mismatch = new RevisionIndexJobHandler({
    work: env.metadata,
    revisions: mismatchingMaterializer,
    index,
    clock,
  });
  assert.deepEqual(await mismatch.handle({
    actor: serviceActor(clock.now()),
    jobId: "index_job_revision_index_failed",
  }), { kind: "failed", failureCode: "exact_revision_mismatch" });
  assert.equal(
    (await env.metadata.readRevisionIndexState(
      MINDS.ordinary.spaceId,
      "revision_index_failed",
    )).status,
    "failed",
  );
  assert.deepEqual(
    await index.readExactRevision(MINDS.ordinary.spaceId, "revision_index_failed"),
    { kind: "unavailable" },
  );
});

test("worker failure preserves canonical commit; audit retries dedupe delivery", async () => {
  const env = await fixture();
  const service = env.commit(["revision_worker_failure"]);
  assert.equal(
    (await service.commit({
      actor: env.actor,
      spaceId: MINDS.ordinary.spaceId,
      expectedRevisionId: REVISIONS.initial.revisionId,
      idempotencyKey: "worker_failure",
      summary: "Worker failure",
      operations: operations("concepts/worker-failure.md", "Worker failure"),
    })).kind,
    "committed",
  );
  let now = "2026-08-06T13:10:00.000Z";
  const clock = { now: () => now };
  const index = new InMemoryExactRevisionSearchIndex();
  index.failNextReplaceForTest();
  const indexHandler = new RevisionIndexJobHandler({
    work: env.metadata,
    revisions: env.revisions,
    index,
    clock,
    retryDelayMs: 1_000,
  });
  assert.equal((await indexHandler.handle({
    actor: serviceActor(now),
    jobId: "index_job_revision_worker_failure",
  })).kind, "failed");
  assert.equal(await env.metadata.readHead(MINDS.ordinary.spaceId), "revision_worker_failure");
  assert.ok(await env.metadata.readRevision(
    MINDS.ordinary.spaceId,
    "revision_worker_failure",
  ));
  assert.deepEqual(
    await index.readExactRevision(MINDS.ordinary.spaceId, "revision_worker_failure"),
    { kind: "unavailable" },
  );
  assert.deepEqual(
    await new ReadyExactRevisionIndexService({
      work: env.metadata,
      index,
    }).read(MINDS.ordinary.spaceId, "revision_worker_failure"),
    { kind: "unavailable" },
  );
  now = "2026-08-06T13:10:02.000Z";
  assert.deepEqual(await indexHandler.handle({
    actor: serviceActor(now),
    jobId: "index_job_revision_worker_failure",
  }), { kind: "completed" });

  const audit = new InMemoryAuditSink();
  audit.failNextDeliveryForTest();
  const [outbox] = await env.metadata.listAuditOutboxForTest();
  const auditHandler = new AuditOutboxDeliveryHandler({
    work: env.metadata,
    audit,
    clock,
    retryDelayMs: 1_000,
  });
  assert.equal((await auditHandler.handle({
    actor: serviceActor(now),
    outboxMessageId: outbox.outboxMessageId,
  })).kind, "failed");
  now = "2026-08-06T13:10:04.000Z";
  assert.deepEqual(await auditHandler.handle({
    actor: serviceActor(now),
    outboxMessageId: outbox.outboxMessageId,
  }), { kind: "completed" });
  assert.deepEqual(await auditHandler.handle({
    actor: serviceActor(now),
    outboxMessageId: outbox.outboxMessageId,
  }), { kind: "already_completed" });
  assert.equal(audit.deliveredForTest().length, 1);
});

test("revision index recovery uses bounded exponential backoff and terminal attempt and age limits", async () => {
  const env = await fixture();
  const service = env.commit(["revision_index_bounded_retry"]);
  assert.equal((await service.commit({
    actor: env.actor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "bounded_index_retry",
    summary: "Bounded index retry",
    operations: operations("concepts/bounded-index-retry.md", "Bounded index retry"),
  })).kind, "committed");
  const jobId = "index_job_revision_index_bounded_retry";
  let now = "2026-08-06T12:01:01.000Z";
  const clock = { now: () => now };
  const index = new InMemoryExactRevisionSearchIndex();
  const handler = new RevisionIndexJobHandler({
    work: env.metadata,
    revisions: env.revisions,
    index,
    clock,
    retryDelayMs: 1_000,
    maxRetryDelayMs: 4_000,
    maxAttempts: 3,
    maxAgeMs: 60_000,
  });

  index.failNextReplaceForTest();
  assert.deepEqual(await handler.handle({ actor: serviceActor(now), jobId }), {
    kind: "failed",
    failureCode: "index_rebuild_failed",
  });
  let job = (await env.metadata.listBackgroundJobsForTest())
    .find((candidate) => candidate.jobId === jobId);
  assert.equal(job.availableAt, "2026-08-06T12:01:02.000Z");

  now = "2026-08-06T12:01:01.999Z";
  assert.deepEqual(await handler.handle({ actor: serviceActor(now), jobId }), {
    kind: "not_available",
  });
  now = "2026-08-06T12:01:02.000Z";
  index.failNextReplaceForTest();
  assert.equal((await handler.handle({ actor: serviceActor(now), jobId })).failureCode,
    "index_rebuild_failed");
  job = (await env.metadata.listBackgroundJobsForTest())
    .find((candidate) => candidate.jobId === jobId);
  assert.equal(job.availableAt, "2026-08-06T12:01:04.000Z");

  now = "2026-08-06T12:01:04.000Z";
  index.failNextReplaceForTest();
  assert.deepEqual(await handler.handle({ actor: serviceActor(now), jobId }), {
    kind: "failed",
    failureCode: "index_retry_attempt_limit",
  });
  const terminal = await env.metadata.readRevisionIndexState(
    MINDS.ordinary.spaceId,
    "revision_index_bounded_retry",
  );
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.attempts, 3);
  assert.equal(terminal.lastFailureCode, "index_retry_attempt_limit");
  assert.deepEqual(await env.metadata.listRecoverableIndexJobs(now, 10), []);

  const agedEnv = await fixture();
  const agedService = agedEnv.commit(["revision_index_age_limit"]);
  assert.equal((await agedService.commit({
    actor: agedEnv.actor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "aged_index_retry",
    summary: "Aged index retry",
    operations: operations("concepts/aged-index-retry.md", "Aged index retry"),
  })).kind, "committed");
  let materializations = 0;
  const agedNow = "2026-08-06T12:01:02.000Z";
  const agedHandler = new RevisionIndexJobHandler({
    work: agedEnv.metadata,
    revisions: {
      async materialize(...args) {
        materializations += 1;
        return agedEnv.revisions.materialize(...args);
      },
    },
    index: new InMemoryExactRevisionSearchIndex(),
    clock: { now: () => agedNow },
    maxAgeMs: 1_000,
  });
  assert.deepEqual(await agedHandler.handle({
    actor: serviceActor(agedNow),
    jobId: "index_job_revision_index_age_limit",
  }), { kind: "failed", failureCode: "index_retry_age_limit" });
  assert.equal(materializations, 0);
  assert.equal((await agedEnv.metadata.readRevisionIndexState(
    MINDS.ordinary.spaceId,
    "revision_index_age_limit",
  )).lastFailureCode, "index_retry_age_limit");
});

test("a reclaimed revision index claim fences the stale handler completion", async () => {
  const env = await fixture();
  const service = env.commit(["revision_index_handler_fence"]);
  assert.equal((await service.commit({
    actor: env.actor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "index_handler_fence",
    summary: "Index handler fence",
    operations: operations("concepts/index-handler-fence.md", "Index handler fence"),
  })).kind, "committed");
  let now = "2026-08-06T12:01:01.000Z";
  let replaceCalls = 0;
  let releaseFirst;
  let firstStarted;
  const firstStartedGate = new Promise((resolve) => { firstStarted = resolve; });
  const firstReplaceGate = new Promise((resolve) => { releaseFirst = resolve; });
  const stored = new InMemoryExactRevisionSearchIndex();
  const index = {
    kind: "search-index",
    async replaceExactRevision(request) {
      replaceCalls += 1;
      if (replaceCalls === 1) {
        firstStarted();
        await firstReplaceGate;
      }
      await stored.replaceExactRevision(request);
    },
    readExactRevision: (...args) => stored.readExactRevision(...args),
    purgeSpace: (...args) => stored.purgeSpace(...args),
  };
  const handler = new RevisionIndexJobHandler({
    work: env.metadata,
    revisions: env.revisions,
    index,
    clock: { now: () => now },
    claimLeaseMs: 1_000,
  });
  const request = {
    actor: serviceActor(now),
    jobId: "index_job_revision_index_handler_fence",
  };
  const stale = handler.handle(request);
  await firstStartedGate;
  now = "2026-08-06T12:01:02.001Z";
  assert.deepEqual(await handler.handle({ ...request, actor: serviceActor(now) }), {
    kind: "completed",
  });
  releaseFirst();
  assert.deepEqual(await stale, { kind: "not_available" });
  const state = await env.metadata.readRevisionIndexState(
    MINDS.ordinary.spaceId,
    "revision_index_handler_fence",
  );
  assert.equal(state.status, "ready");
  assert.equal(state.attempts, 2);
});

test("expired claims are reclaimable and old claim versions cannot complete or fail", async () => {
  const env = await fixture();
  const service = env.commit(["revision_claim_fencing"]);
  assert.equal(
    (await service.commit({
      actor: env.actor,
      spaceId: MINDS.ordinary.spaceId,
      expectedRevisionId: REVISIONS.initial.revisionId,
      idempotencyKey: "claim_fencing",
      summary: "Claim fencing",
      operations: operations("concepts/claim-fencing.md", "Claim fencing"),
    })).kind,
    "committed",
  );
  const jobId = "index_job_revision_claim_fencing";
  const [outbox] = await env.metadata.listAuditOutboxForTest();
  const t0 = "2026-08-06T14:00:00.000Z";
  const lease1 = "2026-08-06T14:00:10.000Z";
  const beforeExpiry = "2026-08-06T14:00:05.000Z";
  const afterExpiry = "2026-08-06T14:00:11.000Z";
  const lease2 = "2026-08-06T14:00:21.000Z";
  const settle = "2026-08-06T14:00:12.000Z";

  const firstIndexClaim = await env.metadata.claimIndexJob(jobId, t0, lease1);
  assert.equal(firstIndexClaim.kind, "claimed");
  assert.equal(firstIndexClaim.job.claimExpiresAt, lease1);
  assert.deepEqual(
    await env.metadata.claimIndexJob(jobId, beforeExpiry, lease2),
    { kind: "not_available" },
  );
  const secondIndexClaim = await env.metadata.claimIndexJob(
    jobId,
    afterExpiry,
    lease2,
  );
  assert.equal(secondIndexClaim.kind, "claimed");
  assert.ok(secondIndexClaim.job.version > firstIndexClaim.job.version);
  assert.equal(
    await env.metadata.completeIndexJob(jobId, firstIndexClaim.job.version, settle),
    false,
  );
  assert.equal(
    await env.metadata.failIndexJob(
      jobId,
      firstIndexClaim.job.version,
      "old_worker_failure",
      settle,
      "2026-08-06T14:00:30.000Z",
    ),
    false,
  );
  assert.equal(
    await env.metadata.completeIndexJob(jobId, secondIndexClaim.job.version, settle),
    true,
  );

  assert.deepEqual(
    await env.metadata.claimAuditOutbox(
      outbox.outboxMessageId,
      t0,
      "2026-08-06T14:10:00.001Z",
    ),
    { kind: "not_available" },
  );
  const firstAuditClaim = await env.metadata.claimAuditOutbox(
    outbox.outboxMessageId,
    t0,
    lease1,
  );
  assert.equal(firstAuditClaim.kind, "claimed");
  assert.equal(firstAuditClaim.message.claimExpiresAt, lease1);
  assert.deepEqual(
    await env.metadata.claimAuditOutbox(
      outbox.outboxMessageId,
      beforeExpiry,
      lease2,
    ),
    { kind: "not_available" },
  );
  const secondAuditClaim = await env.metadata.claimAuditOutbox(
    outbox.outboxMessageId,
    afterExpiry,
    lease2,
  );
  assert.equal(secondAuditClaim.kind, "claimed");
  assert.ok(secondAuditClaim.message.version > firstAuditClaim.message.version);
  assert.equal(
    await env.metadata.completeAuditOutbox(
      outbox.outboxMessageId,
      firstAuditClaim.message.version,
      settle,
    ),
    false,
  );
  assert.equal(
    await env.metadata.failAuditOutbox(
      outbox.outboxMessageId,
      firstAuditClaim.message.version,
      settle,
      "2026-08-06T14:00:30.000Z",
    ),
    false,
  );
  assert.equal(
    await env.metadata.completeAuditOutbox(
      outbox.outboxMessageId,
      secondAuditClaim.message.version,
      settle,
    ),
    true,
  );
});

test("service-only GC is bounded and delete-all purge removes target jobs/index/audit-outbox", async () => {
  const env = await fixture();
  const service = env.commit(["revision_gc_purge", "revision_orphan"]);
  assert.equal(
    (await service.commit({
      actor: env.actor,
      spaceId: MINDS.ordinary.spaceId,
      expectedRevisionId: REVISIONS.initial.revisionId,
      idempotencyKey: "gc_purge",
      summary: "GC purge",
      operations: operations("concepts/gc-purge.md", "GC purge"),
    })).kind,
    "committed",
  );
  env.metadata.failNextCommitForTest();
  await assert.rejects(service.commit({
    actor: env.actor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_gc_purge",
    idempotencyKey: "orphan",
    summary: "Orphan",
    operations: operations("concepts/orphan.md", "Orphan"),
  }));
  const gc = new UnreachableObjectGcHandler(env.revisions);
  await assert.rejects(
    gc.handle({
      actor: env.actor,
      createdBefore: "9999-01-01T00:00:00.000Z",
      limit: 1,
    }),
    /service ActorContext/u,
  );
  const collected = await gc.handle({
    actor: serviceActor(),
    createdBefore: "9999-01-01T00:00:00.000Z",
    limit: 1,
  });
  assert.equal(collected.scanned, 1);
  assert.equal(collected.deleted, 1);
  assert.ok(await env.revisions.materialize(
    MINDS.ordinary.spaceId,
    "revision_gc_purge",
  ));

  const index = new InMemoryExactRevisionSearchIndex();
  await index.replaceExactRevision({
    spaceId: MINDS.ordinary.spaceId,
    revisionId: "revision_gc_purge",
    documents: [{ path: "index.md", text: "private derived text" }],
  });
  const audit = new InMemoryAuditSink();
  const [outbox] = await env.metadata.listAuditOutboxForTest();
  const delivered = await new AuditOutboxDeliveryHandler({
    work: env.metadata,
    audit,
    clock: { now: () => "2026-08-06T15:00:00.000Z" },
  }).handle({
    actor: serviceActor("2026-08-06T15:00:00.000Z"),
    outboxMessageId: outbox.outboxMessageId,
  });
  assert.deepEqual(delivered, { kind: "completed" });
  assert.equal(audit.deliveredForTest().length, 1);
  const purged = await new SpaceTargetRecordPurgeService({
    metadata: env.metadata,
    index,
    audit,
  }).purge({ actor: serviceActor(), spaceId: MINDS.ordinary.spaceId });
  assert.equal(purged.backgroundJobs, 1);
  assert.equal(purged.indexStates, 1);
  assert.equal(purged.auditEvents, 1);
  assert.equal(purged.auditOutboxMessages, 1);
  assert.equal(purged.idempotencyRecords, 1);
  assert.equal(purged.indexedRevisions, 1);
  assert.equal(purged.deliveredAuditEvents, 1);
  assert.equal((await env.metadata.listAuditEventsForTest()).length, 0);
  assert.equal((await env.metadata.listAuditOutboxForTest()).length, 0);
  assert.equal((await env.metadata.listBackgroundJobsForTest()).length, 0);
  assert.equal(audit.deliveredForTest().length, 0);
  assert.deepEqual(
    await index.readExactRevision(MINDS.ordinary.spaceId, "revision_gc_purge"),
    { kind: "unavailable" },
  );
});
