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
  assert.equal(second.driftDetected, true);
  assert.equal(second.scannedSpaces, 1);
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
  assert.equal(
    [left, right].find((result) => result.kind === "rejected").reason,
    "fairness_limit",
  );
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

  const hard = await softStore.runCapacityTransaction((transaction) =>
    transaction.admitCapacityReservation(
      request({ suffix: "hard", requested: { physicalCanonicalBytes: 101 } }),
      constrained,
    ));
  assert.equal(hard.kind, "rejected");
  assert.equal(hard.reason, "hard_limit");
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
