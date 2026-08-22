import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryPrivacySafeObservabilitySink } from "@mind-diary/adapter-audit-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import {
  BackgroundPrivacySafeObservability,
  BoundedObjectCleanupHandler,
} from "@mind-diary/application-background";
import { MARKDOWN_MEDIA_TYPE } from "@mind-diary/domain";

const T0 = "2026-08-20T00:00:00.000Z";
const T3 = "2026-08-21T00:00:00.000Z";
const T4 = "2026-08-22T00:00:00.000Z";
const T5 = "2026-08-23T00:00:00.000Z";
const actor = {
  kind: "service",
  serviceId: "bounded-cleanup-test",
  requestId: "request_cleanup_test",
  occurredAtUtc: T4,
  deploymentCapabilities: [],
};

function metadata(options = {}) {
  return {
    async isImmutableObjectReachable(sha256) {
      return options.immutable?.has(sha256) ?? false;
    },
    async isBundleFileObjectReachable(spaceId, sha256) {
      return options.bundle?.has(`${spaceId}:${sha256}`) ?? false;
    },
    async isSpaceCanonicalObjectReachable(kind, spaceId, sha256) {
      return options.space?.has(`${kind}:${spaceId}:${sha256}`) ?? false;
    },
    async readStagedBundleFile(stagedFileId) {
      return options.staged?.has(stagedFileId) ? { stagedFileId } : null;
    },
    async readExportJob(jobId) {
      return options.exports?.has(jobId)
        ? { jobId, expiresAt: T5, archiveCleanedAt: null }
        : null;
    },
    async completeExpiredExportCleanup() {
      return true;
    },
  };
}

test("bounded cleanup traverses every namespace, keeps active roots, and emits closed metrics", async () => {
  const objects = new InMemoryObjectStore();
  const orphanImmutable = await objects.putImmutable({
    bytes: new TextEncoder().encode("# orphan immutable\n"),
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: T0,
  });
  const rootedImmutable = await objects.putImmutable({
    bytes: new TextEncoder().encode("# rooted immutable\n"),
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: T0,
  });
  const orphanBundle = await objects.putBundleFile({
    spaceId: "space_a",
    bytes: Uint8Array.of(1, 2, 3),
    mediaType: "image/png",
    createdAt: T0,
  });
  const rootedBundle = await objects.putBundleFile({
    spaceId: "space_b",
    bytes: Uint8Array.of(4, 5, 6),
    mediaType: "image/png",
    createdAt: T0,
  });
  const stagedOrphan = await objects.putStagedBundleFile({
    stagedFileId: "staged_orphan",
    bindingOwnerId: "binding_owner_a",
    spaceId: "space_a",
    bytes: Uint8Array.of(7),
    createdAt: T0,
  });
  await objects.putStagedBundleFile({
    stagedFileId: "staged_active",
    bindingOwnerId: "binding_owner_b",
    spaceId: "space_b",
    bytes: Uint8Array.of(8),
    createdAt: T0,
  });
  for (const [jobId, spaceId, value] of [
    ["export_orphan", "space_a", 9],
    ["export_active", "space_b", 10],
  ]) {
    const bytes = Uint8Array.of(value);
    await objects.putExportArchive({
      jobId,
      spaceId,
      claimVersion: 1,
      bytes,
      sha256: await objects.calculateSha256(bytes),
      createdAt: T0,
    });
  }
  const state = metadata({
    immutable: new Set([rootedImmutable.object.sha256]),
    bundle: new Set([`space_b:${rootedBundle.object.sha256}`]),
    staged: new Set(["staged_active"]),
    exports: new Set(["export_active"]),
  });
  const sink = new InMemoryPrivacySafeObservabilitySink();
  const handler = new BoundedObjectCleanupHandler({
    objects,
    checkpoints: new InMemoryRevisionMetadataStore(),
    reachability: state,
    staging: state,
    exports: state,
    clock: { now: () => T4 },
    monotonicNow: () => 0,
    observability: new BackgroundPrivacySafeObservability({ sink, cohort: "close_circle" }),
  });
  const result = await handler.handle({
    actor,
    createdBefore: T3,
    maxObjects: 100,
    maxBytes: 1_000_000,
    maxDurationMs: 1_000,
  });
  assert.equal(result.kind, "completed");
  assert.equal(result.cycleCompleted, true);
  assert.equal(result.deleted, 4);
  assert.equal(result.orphanCount, 4);
  assert.equal(await objects.getImmutable(orphanImmutable.object.sha256), null);
  assert.ok(await objects.getImmutable(rootedImmutable.object.sha256));
  assert.equal(await objects.getBundleFile("space_a", orphanBundle.object.sha256), null);
  assert.ok(await objects.getBundleFile("space_b", rootedBundle.object.sha256));
  assert.equal(await objects.getStagedBundleFile(stagedOrphan.stagedFileId), null);
  assert.ok(await objects.getStagedBundleFile("staged_active"));
  assert.deepEqual(
    (await objects.listExportArchivesForTest()).map((item) => item.jobId),
    ["export_active"],
  );
  assert.deepEqual(
    sink.eventsForTest().map((event) => event.metric).sort(),
    [
      "cleanup_failure_count",
      "cleanup_orphan_count",
      "cleanup_queue_age_ms",
      "cleanup_reclaimed_bytes",
      "cleanup_retry_count",
    ],
  );
});

test("a concurrent commit re-protecting an orphan wins the cleanup fence", async () => {
  const objects = new InMemoryObjectStore();
  const bytes = new TextEncoder().encode("# raced object\n");
  const stored = await objects.putImmutable({
    bytes,
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: T0,
  });
  const racedObjects = {
    listObjectCleanupPage: (request) => objects.listObjectCleanupPage(request),
    hasExportArchivesForJob: (jobId, spaceId) =>
      objects.hasExportArchivesForJob(jobId, spaceId),
    async deleteObjectCleanupCandidate(request) {
      if (request.candidate.namespace === "immutable") {
        await objects.putImmutable({ bytes, mediaType: MARKDOWN_MEDIA_TYPE, createdAt: T4 });
      }
      return objects.deleteObjectCleanupCandidate(request);
    },
  };
  const state = metadata();
  const result = await new BoundedObjectCleanupHandler({
    objects: racedObjects,
    checkpoints: new InMemoryRevisionMetadataStore(),
    reachability: state,
    staging: state,
    exports: state,
    clock: { now: () => T4 },
    monotonicNow: () => 0,
  }).handle({ actor, createdBefore: T3, maxObjects: 1, maxDurationMs: 1_000 });
  assert.equal(result.orphanCount, 1);
  assert.equal(result.deleted, 0);
  assert.ok(await objects.getImmutable(stored.object.sha256));
});

test("cleanup persists progress at strict object, byte and time budgets", async () => {
  const objects = new InMemoryObjectStore();
  for (let index = 0; index < 4; index += 1) {
    await objects.putImmutable({
      bytes: new TextEncoder().encode(`# orphan ${index}\n`),
      mediaType: MARKDOWN_MEDIA_TYPE,
      createdAt: T0,
    });
  }
  const state = metadata();
  const handler = new BoundedObjectCleanupHandler({
    objects,
    checkpoints: new InMemoryRevisionMetadataStore(),
    reachability: state,
    staging: state,
    exports: state,
    clock: { now: () => T4 },
    monotonicNow: () => 0,
  });
  const first = await handler.handle({
    actor,
    createdBefore: T3,
    maxObjects: 1,
    maxBytes: 1,
    maxDurationMs: 1_000,
  });
  assert.equal(first.deleted, 0);
  assert.equal(first.reclaimedBytes, 0);
  assert.equal(first.budgetExhausted, true);
  const second = await handler.handle({
    actor,
    createdBefore: T3,
    maxObjects: 1,
    maxBytes: 1_000,
    maxDurationMs: 1_000,
  });
  assert.equal(second.deleted, 1);

  const monotonic = [0, 10, 10];
  const timed = new BoundedObjectCleanupHandler({
    objects,
    checkpoints: new InMemoryRevisionMetadataStore(),
    reachability: state,
    staging: state,
    exports: state,
    clock: { now: () => T4 },
    monotonicNow: () => monotonic.shift() ?? 10,
  });
  const stopped = await timed.handle({
    actor,
    createdBefore: T3,
    maxObjects: 10,
    maxDurationMs: 5,
  });
  assert.equal(stopped.deleted, 0);
  assert.equal(stopped.budgetExhausted, true);
});
