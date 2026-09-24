import assert from "node:assert/strict";
import test from "node:test";
import {
  CanonicalRevisionCoordinator,
  DEFAULT_CAPACITY_LIMITS,
} from "@mind-diary/application-content";
import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  idempotencyKey,
  opaqueId,
} from "@mind-diary/domain";
import {
  CANONICAL_REVISION_FILES,
  MINDS,
  PRINCIPALS,
  REVISION_AUTHORS,
  REVISIONS,
} from "@mind-diary/test-fixtures";

const CREATED = "2026-08-22T12:00:00.000Z";
const EXPIRES = "2026-08-22T13:00:00.000Z";

function limits(overrides = {}) {
  return Object.freeze({ ...DEFAULT_CAPACITY_LIMITS, ...overrides });
}

function request(overrides = {}) {
  const suffix = overrides.suffix ?? "one";
  return Object.freeze({
    reservationId: `capacity:test:${suffix}`,
    requestedByPrincipalId: PRINCIPALS.owner.principalId,
    spaceId: MINDS.ordinary.spaceId,
    operation: overrides.operation ?? "import",
    operationRef: `operation-${suffix}`,
    baseRevisionId: null,
    idempotencyKey: idempotencyKey(`capacity-${suffix}`),
    requested: Object.freeze({
      physicalCanonicalBytes: 1,
      temporaryBytes: 0,
      d1MetadataBytes: 0,
      ...(overrides.requested ?? {}),
    }),
    bulk: overrides.bulk ?? false,
    heavy: overrides.heavy ?? false,
    createdAt: overrides.createdAt ?? CREATED,
    expiresAt: overrides.expiresAt ?? EXPIRES,
  });
}

test("usage is recomputed from immutable manifests and same-Space shared digests count once", async () => {
  const metadata = new InMemoryRevisionMetadataStore();
  const objects = new InMemoryObjectStore();
  const revisions = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  await revisions.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: null,
    revisionId: REVISIONS.initial.revisionId,
    committedAt: REVISIONS.initial.committedAt,
    committedBy: REVISION_AUTHORS.active,
    summary: "capacity seed",
    files: CANONICAL_REVISION_FILES,
  });
  await revisions.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    revisionId: opaqueId("revision_capacity_reuse"),
    committedAt: REVISIONS.next.committedAt,
    committedBy: REVISION_AUTHORS.active,
    summary: "reuse exact files",
    files: CANONICAL_REVISION_FILES,
  });

  const usage = await metadata.readMindCapacityUsage(MINDS.ordinary.spaceId);
  assert.ok(usage);
  assert.equal(usage.logicalRetainedBytes, usage.logicalHeadBytes * 2);
  assert.ok(usage.physicalCanonicalBytes < usage.logicalRetainedBytes);
  assert.equal(usage.trustworthy, true);

  const first = await metadata.reconcileCapacityUsage({
    spaceId: MINDS.ordinary.spaceId,
    reconciledAt: "2026-08-22T12:10:00.000Z",
  });
  assert.equal(first.driftDetected, false);

  const changed = CANONICAL_REVISION_FILES.map((file, index) =>
    index === 0
      ? Object.freeze({ ...file, bytes: new TextEncoder().encode("# changed\n") })
      : file,
  );
  await revisions.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: opaqueId("revision_capacity_reuse"),
    revisionId: opaqueId("revision_capacity_changed"),
    committedAt: "2026-08-22T12:15:00.000Z",
    committedBy: REVISION_AUTHORS.active,
    summary: "change one object",
    files: changed,
  });
  const second = await metadata.reconcileCapacityUsage({
    spaceId: MINDS.ordinary.spaceId,
    reconciledAt: "2026-08-22T12:20:00.000Z",
  });
  assert.equal(second.driftDetected, false);
  assert.equal(second.scannedSpaces, 1);
});

test("queued note reusing a committed markdown digest does not double-count physical storage", async () => {
  const metadata = new InMemoryRevisionMetadataStore();
  const objects = new InMemoryObjectStore();
  const revisions = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  const committed = await revisions.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: null,
    revisionId: REVISIONS.initial.revisionId,
    committedAt: REVISIONS.initial.committedAt,
    committedBy: REVISION_AUTHORS.active,
    summary: "capacity queued-note seed",
    files: CANONICAL_REVISION_FILES,
  });
  assert.equal(committed.kind, "committed");
  const markdown = committed.envelope.manifest.entries.find((entry) => entry.kind === "markdown");
  assert.ok(markdown);
  const before = await metadata.readMindCapacityUsage(MINDS.ordinary.spaceId);
  const snapshot = metadata.exportDurableSnapshot();
  const receiptId = `note_${"0".repeat(64)}`;
  snapshot.queuedNotes.set(receiptId, Object.freeze({
    receiptId,
    spaceId: MINDS.ordinary.spaceId,
    actor: Object.freeze({
      kind: "registered_principal",
      principalId: PRINCIPALS.owner.principalId,
      authentication: Object.freeze({
        kind: "mcp_token",
        tokenId: "token_capacity_reused_note",
        effectiveScopes: Object.freeze(["content:read", "content:write"]),
      }),
      deploymentCapabilities: Object.freeze([]),
      requestId: "request_capacity_reused_note",
      occurredAtUtc: CREATED,
    }),
    writePin: Object.freeze({
      principalId: PRINCIPALS.owner.principalId,
      spaceId: MINDS.ordinary.spaceId,
      generationId: "generation_capacity_reused_note",
    }),
    payloadHash: markdown.sha256,
    size: markdown.size,
    path: `raw/inbox/${receiptId}.md`,
    state: "queued",
    attempts: 0,
    leaseUntil: 0,
    revisionId: null,
    expectedRevisionId: REVISIONS.initial.revisionId,
    failureCode: null,
  }));
  const restored = InMemoryRevisionMetadataStore.fromDurableSnapshot(snapshot);
  const after = await restored.readMindCapacityUsage(MINDS.ordinary.spaceId);

  assert.equal(after.physicalCanonicalBytes, before.physicalCanonicalBytes);
  assert.equal(after.d1MetadataBytes, before.d1MetadataBytes + 2_048);
});

test("reservation admission is serialized, retry-safe and enforces fairness plus soft/hard limits", async () => {
  const metadata = new InMemoryRevisionMetadataStore();
  const constrained = limits({
    mindPhysicalCanonicalBytes: 100,
    principalPhysicalCanonicalBytes: 100,
    sitePhysicalCanonicalBytes: 100,
    siteTemporaryBytes: 100,
    siteD1MetadataBytes: 100,
    activeHeavyPerMind: 1,
    activeHeavyPerPrincipal: 1,
    activeHeavyPerSite: 1,
  });

  const [left, right] = await Promise.all([
    metadata.runCapacityTransaction((transaction) =>
      transaction.admitCapacityReservation(
        request({ suffix: "race-a", heavy: true }),
        constrained,
      )),
    metadata.runCapacityTransaction((transaction) =>
      transaction.admitCapacityReservation(
        request({ suffix: "race-b", heavy: true }),
        constrained,
      )),
  ]);
  assert.deepEqual(
    [left.kind, right.kind].sort(),
    ["admitted", "rejected"],
  );
  const fairness = [left, right].find((result) => result.kind === "rejected");
  assert.equal(fairness.reason, "fairness_limit");
  assert.deepEqual(fairness.diagnostic, {
    operation: "import",
    spaceScope: "mind",
    metric: "active_heavy_operations",
    requested: 1,
    committed: 0,
    reserved: 1,
    state: "normal",
    heavy: true,
    recovery: { action: "retry_after_previous_operation" },
  });
  const winner = [left, right].find((result) => result.kind === "admitted");
  const replay = await metadata.runCapacityTransaction((transaction) =>
    transaction.admitCapacityReservation(
      request({ suffix: winner.reservation.operationRef.endsWith("race-a") ? "race-a" : "race-b", heavy: true }),
      constrained,
    ));
  assert.equal(replay.kind, "admitted");
  assert.equal(replay.replayed, true);

  const softStore = new InMemoryRevisionMetadataStore();
  const soft = await softStore.runCapacityTransaction((transaction) =>
    transaction.admitCapacityReservation(
      request({
        suffix: "soft",
        bulk: true,
        requested: { physicalCanonicalBytes: 85 },
      }),
      constrained,
    ));
  assert.equal(soft.kind, "rejected");
  assert.equal(soft.reason, "soft_limit");
  assert.equal(soft.diagnostic.spaceScope, "mind");
  assert.equal(soft.diagnostic.metric, "physical_canonical_bytes");
  assert.equal(soft.diagnostic.requested, 85);

  const hard = await softStore.runCapacityTransaction((transaction) =>
    transaction.admitCapacityReservation(
      request({ suffix: "hard", requested: { physicalCanonicalBytes: 101 } }),
      constrained,
    ));
  assert.equal(hard.kind, "rejected");
  assert.equal(hard.reason, "hard_limit");
  assert.equal(hard.diagnostic.state, "hard_limit");
  assert.equal(hard.diagnostic.requested, 101);
});

test("heavy-operation denial identifies the first occupied principal or Site lane", async () => {
  for (const [scope, perPrincipal, perSite] of [
    ["principal", 1, 2],
    ["site", 2, 1],
  ]) {
    const metadata = new InMemoryRevisionMetadataStore();
    const constrained = limits({
      activeHeavyPerMind: 2,
      activeHeavyPerPrincipal: perPrincipal,
      activeHeavyPerSite: perSite,
    });
    const first = await metadata.runCapacityTransaction((transaction) =>
      transaction.admitCapacityReservation(request({ suffix: `${scope}-first`, heavy: true }), constrained));
    assert.equal(first.kind, "admitted");
    const second = await metadata.runCapacityTransaction((transaction) =>
      transaction.admitCapacityReservation(request({ suffix: `${scope}-second`, heavy: true }), constrained));
    assert.equal(second.kind, "rejected");
    assert.equal(second.reason, "fairness_limit");
    assert.equal(second.diagnostic.spaceScope, scope);
    assert.equal(second.diagnostic.reserved, 1);
  }
});

test("expired reservations become bounded cleanup work and telemetry stays content-free", async () => {
  const metadata = new InMemoryRevisionMetadataStore();
  const admitted = await metadata.runCapacityTransaction((transaction) =>
    transaction.admitCapacityReservation(
      request({
        suffix: "expired",
        requested: { physicalCanonicalBytes: 0, temporaryBytes: 16 },
      }),
      DEFAULT_CAPACITY_LIMITS,
    ));
  assert.equal(admitted.kind, "admitted");

  const expired = await metadata.collectExpiredCapacityReservations({
    now: "2026-08-22T14:00:00.000Z",
    limit: 1,
  });
  assert.equal(expired.length, 1);
  assert.equal(expired[0].state, "cleanup_pending");
  const resumed = await metadata.collectExpiredCapacityReservations({
    now: "2026-08-22T14:00:30.000Z",
    limit: 1,
  });
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].state, "cleanup_pending");
  const retryBeforeCleanup = await metadata.runCapacityTransaction((transaction) =>
    transaction.admitCapacityReservation(
      request({
        suffix: "expired",
        createdAt: "2026-08-22T14:00:30.000Z",
        expiresAt: "2026-08-22T15:00:30.000Z",
        requested: { physicalCanonicalBytes: 0, temporaryBytes: 16 },
      }),
      DEFAULT_CAPACITY_LIMITS,
    ));
  assert.equal(retryBeforeCleanup.kind, "rejected");
  assert.equal(retryBeforeCleanup.reason, "accounting_untrusted");

  const commitStore = new InMemoryRevisionMetadataStore();
  const commitRequest = request({ suffix: "resumable-commit", operation: "commit" });
  const commitAdmission = await commitStore.runCapacityTransaction((transaction) =>
    transaction.admitCapacityReservation(commitRequest, DEFAULT_CAPACITY_LIMITS));
  assert.equal(commitAdmission.kind, "admitted");
  await commitStore.runCapacityTransaction((transaction) =>
    transaction.cancelCapacityReservation({
      reservationId: commitRequest.reservationId,
      canceledAt: "2026-08-22T12:01:00.000Z",
    }));
  const resumedCommit = await commitStore.runCapacityTransaction((transaction) =>
    transaction.admitCapacityReservation({
      ...commitRequest,
      createdAt: "2026-08-22T12:02:00.000Z",
      expiresAt: "2026-08-22T13:02:00.000Z",
    }, DEFAULT_CAPACITY_LIMITS));
  assert.equal(resumedCommit.kind, "admitted");
  assert.equal(resumedCommit.replayed, false);
  const telemetry = await metadata.readCapacityTelemetry(
    DEFAULT_CAPACITY_LIMITS,
    "2026-08-22T14:00:00.000Z",
  );
  assert.equal(telemetry.staleReservations, 1);
  assert.ok(telemetry.temporaryHeadroomBytes >= 0);
  assert.equal("path" in telemetry, false);
  assert.equal("email" in telemetry, false);

  assert.equal(await metadata.releaseCapacityReservation({
    reservationId: expired[0].reservationId,
    releasedAt: "2026-08-22T14:01:00.000Z",
  }), true);
  const restored = InMemoryRevisionMetadataStore.fromDurableSnapshot(
    metadata.exportDurableSnapshot(),
  );
  const [persistedReservation] = await restored.listCapacityReservationsForTest();
  assert.equal(persistedReservation.state, "released");
  const retryAfterCleanup = await metadata.runCapacityTransaction((transaction) =>
    transaction.admitCapacityReservation(
      request({
        suffix: "expired",
        createdAt: "2026-08-22T14:02:00.000Z",
        expiresAt: "2026-08-22T15:02:00.000Z",
        requested: { physicalCanonicalBytes: 0, temporaryBytes: 16 },
      }),
      DEFAULT_CAPACITY_LIMITS,
    ));
  assert.equal(retryAfterCleanup.kind, "admitted");
  assert.equal(retryAfterCleanup.replayed, false);
});

test("admission atomically retires an expired heavy reservation after restart", async () => {
  const metadata = new InMemoryRevisionMetadataStore();
  const constrained = limits({
    activeHeavyPerMind: 1,
    activeHeavyPerPrincipal: 1,
    activeHeavyPerSite: 1,
  });
  const staleRequest = request({
    suffix: "stale-heavy",
    heavy: true,
    requested: { physicalCanonicalBytes: 0, temporaryBytes: 16 },
  });
  const admitted = await metadata.runCapacityTransaction((transaction) =>
    transaction.admitCapacityReservation(staleRequest, constrained));
  assert.equal(admitted.kind, "admitted");

  const restarted = InMemoryRevisionMetadataStore.fromDurableSnapshot(
    metadata.exportDurableSnapshot(),
  );
  const successorRequest = request({
    suffix: "successor-heavy",
    operation: "export",
    heavy: true,
    createdAt: "2026-08-22T14:00:00.000Z",
    expiresAt: "2026-08-23T14:00:00.000Z",
    requested: { physicalCanonicalBytes: 0, temporaryBytes: 1 },
  });
  const successor = await restarted.runCapacityTransaction((transaction) =>
    transaction.admitCapacityReservation(successorRequest, constrained));
  assert.equal(successor.kind, "admitted");
  assert.equal(successor.replayed, false);

  const reservations = await restarted.listCapacityReservationsForTest();
  assert.equal(
    reservations.find(({ reservationId }) =>
      reservationId === staleRequest.reservationId).state,
    "cleanup_pending",
  );
  assert.equal(
    reservations.find(({ reservationId }) =>
      reservationId === successorRequest.reservationId).state,
    "active",
  );

  const replay = await restarted.runCapacityTransaction((transaction) =>
    transaction.admitCapacityReservation(successorRequest, constrained));
  assert.equal(replay.kind, "admitted");
  assert.equal(replay.replayed, true);
  assert.equal((await restarted.listCapacityReservationsForTest()).length, 2);

  const staleRetry = await restarted.runCapacityTransaction((transaction) =>
    transaction.admitCapacityReservation({
      ...staleRequest,
      createdAt: "2026-08-22T14:00:01.000Z",
      expiresAt: "2026-08-23T14:00:01.000Z",
    }, constrained));
  assert.equal(staleRetry.kind, "rejected");
  assert.equal(staleRetry.reason, "accounting_untrusted");
});

test("selected capacity usage is independent of foreign history and jobs", async () => {
  const metadata = new InMemoryRevisionMetadataStore();
  const objects = new InMemoryObjectStore();
  const revisions = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  const selectedSeed = await revisions.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: null,
    revisionId: REVISIONS.initial.revisionId,
    committedAt: REVISIONS.initial.committedAt,
    committedBy: REVISION_AUTHORS.active,
    summary: "selected capacity seed",
    files: CANONICAL_REVISION_FILES,
  });
  assert.equal(selectedSeed.kind, "committed");
  const foreignSpaceId = "space_foreign_capacity_growth";
  const foreignRevisionPrefix = "revision_foreign_capacity_growth";
  let foreignHead = null;
  for (let index = 0; index < 96; index += 1) {
    const revisionId = opaqueId(`${foreignRevisionPrefix}_${index}`);
    const result = await revisions.commit({
      spaceId: foreignSpaceId,
      expectedRevisionId: foreignHead,
      revisionId,
      committedAt: `2026-08-22T12:${String(index % 60).padStart(2, "0")}:00.000Z`,
      committedBy: REVISION_AUTHORS.active,
      summary: `foreign capacity ${index}`,
      files: CANONICAL_REVISION_FILES,
    });
    assert.equal(result.kind, "committed");
    foreignHead = revisionId;
  }
  const before = await metadata.readMindCapacityUsage(MINDS.ordinary.spaceId);
  assert.ok(before);
  metadata.resetProjectionVisitsForTest();
  await metadata.readMindCapacityUsage(MINDS.ordinary.spaceId);
  const baselineVisits = metadata.inspectProjectionVisitsForTest().capacityCanonicalKeys;
  assert.ok(baselineVisits > 0);

  const snapshot = metadata.exportDurableSnapshot();
  for (let index = 0; index < 96; index += 1) {
    snapshot.exportJobs.set(`foreign_export_job_${index}`, {
      jobId: `foreign_export_job_${index}`,
      requestedByPrincipalId: PRINCIPALS.owner.principalId,
      spaceId: foreignSpaceId,
      revisionId: foreignHead,
      idempotencyKey: `foreign_export_key_${index}`,
      profile: "MD-OKF-ZIP-1",
      state: "queued",
      version: 1,
      attempts: 0,
      availableAt: CREATED,
      createdAt: CREATED,
      updatedAt: CREATED,
      claimExpiresAt: null,
      completedAt: null,
      expiresAt: EXPIRES,
      lastFailureCode: null,
      archive: null,
      archiveCleanedAt: null,
    });
  }
  const restored = InMemoryRevisionMetadataStore.fromDurableSnapshot(snapshot);
  restored.resetProjectionVisitsForTest();
  const after = await restored.readMindCapacityUsage(MINDS.ordinary.spaceId);
  assert.ok(after);
  assert.deepEqual(after, before);
  assert.equal(
    restored.inspectProjectionVisitsForTest().capacityCanonicalKeys,
    baselineVisits,
  );
});
