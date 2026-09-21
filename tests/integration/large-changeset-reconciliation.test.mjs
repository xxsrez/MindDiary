import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CanonicalRevisionCoordinator,
  ChangesetCommitService,
} from "@mind-diary/application-content";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";
import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  CAPABILITIES,
  version,
} from "@mind-diary/domain";
import {
  CANONICAL_REVISION_FILES,
  FIXED_NOW,
  MINDS,
  PRINCIPALS,
  REVISION_AUTHORS,
  REVISIONS,
} from "@mind-diary/test-fixtures";

const FUTURE = "2026-11-03T12:00:00.000Z";
const OBJECT_LIST_CUTOFF = "9999-12-31T23:59:59.999Z";
const LARGE_OPERATION_COUNT = 72;

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function actor(tokenId, requestId) {
  return {
    kind: "registered_principal",
    principalId: PRINCIPALS.editor.principalId,
    authentication: {
      kind: "mcp_token",
      tokenId,
      effectiveScopes: ["content:read", "content:write"],
    },
    deploymentCapabilities: CAPABILITIES,
    requestId,
    occurredAtUtc: FIXED_NOW,
  };
}

function authorizationQuery(currentActor) {
  return {
    principalId: currentActor.principalId,
    spaceId: MINDS.ordinary.spaceId,
    tokenId: currentActor.authentication.tokenId,
  };
}

function authorizationState(currentActor) {
  return {
    principal: {
      principalId: currentActor.principalId,
      state: "active",
    },
    space: {
      spaceId: MINDS.ordinary.spaceId,
      state: "active",
      visibility: "private",
      accessVersion: version(1),
    },
    membership: {
      principalId: currentActor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      role: "editor",
      state: "active",
      version: version(1),
    },
    token: {
      tokenId: currentActor.authentication.tokenId,
      principalId: currentActor.principalId,
      state: "active",
      scopes: ["content:read", "content:write"],
      version: version(1),
      expiresAt: FUTURE,
    },
  };
}

function mountedMetadata(metadata) {
  const mounts = new Map();
  let generation = 0;
  const key = (principalId, spaceId) => `${principalId}\0${spaceId}`;
  const select = (principalId, spaceId) => {
    const generationId = `large_changeset_generation_${++generation}`;
    mounts.set(key(principalId, spaceId), Object.freeze({
      principalId,
      spaceId,
      generationId,
    }));
    return generationId;
  };
  const ensure = (principalId, spaceId) => {
    const current = mounts.get(key(principalId, spaceId));
    if (current !== undefined) return current;
    select(principalId, spaceId);
    return mounts.get(key(principalId, spaceId));
  };
  const readUsage = async (principalId) => {
    const entries = [...mounts.values()]
      .filter((entry) => entry.principalId === principalId)
      .map((entry) => Object.freeze({
        principalId,
        spaceId: entry.spaceId,
        routingProfile: "description_based",
        usageMode: "read_write",
        writeGeneration: entry,
      }));
    return entries.length === 0
      ? null
      : Object.freeze({ principalId, entries: Object.freeze(entries) });
  };
  const validatePin = async (pin) => {
    const current = mounts.get(key(pin.principalId, pin.spaceId));
    return current?.generationId === pin.generationId;
  };
  const wrapTransaction = (transaction) => Object.freeze({
    ...transaction,
    readPrincipalMindUsage: readUsage,
    validatePrincipalMindUsageWritePin: validatePin,
  });
  const store = new Proxy(metadata, {
    get(target, property) {
      if (property === "readPrincipalMindUsage") return readUsage;
      if (property === "validatePrincipalMindUsageWritePin") return validatePin;
      if (property === "runContentCommitTransaction") {
        return (operation) => target.runContentCommitTransaction(
          (transaction) => operation(wrapTransaction(transaction)),
        );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return Object.freeze({ store, ensure });
}

function revisionIds(revisionId) {
  return { nextRevisionId: () => revisionId };
}

function createFile(index, prefix = "large") {
  const title = `${prefix} ${index}`;
  return {
    type: "create_file",
    path: `concepts/${prefix}-${String(index).padStart(3, "0")}.md`,
    text: `---\ntype: Reference\ntitle: ${title}\n---\n\n# ${title}\n`,
  };
}

function largeOperations(prefix = "large") {
  return Array.from({ length: LARGE_OPERATION_COUNT }, (_, index) =>
    createFile(index, prefix));
}

function instrumentedStore(objects, { failAtPut = null } = {}) {
  let putAttempts = 0;
  const writes = [];
  const store = new Proxy(objects, {
    get(target, property) {
      if (property === "putSpaceCanonicalObject") {
        return async (request) => {
          putAttempts += 1;
          writes.push(Object.freeze({
            kind: request.kind,
            spaceId: request.spaceId,
            sha256: digest(request.bytes),
            size: request.bytes.byteLength,
          }));
          if (failAtPut !== null && putAttempts === failAtPut) {
            throw new Error("injected large changeset object failure");
          }
          return target.putSpaceCanonicalObject(request);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return Object.freeze({ store, writes, putAttempts: () => putAttempts });
}

async function fixture() {
  const objects = new InMemoryObjectStore();
  const rawMetadata = new InMemoryRevisionMetadataStore();
  const usage = mountedMetadata(rawMetadata);
  const metadata = usage.store;
  const coordinator = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  const seeded = await coordinator.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: null,
    revisionId: REVISIONS.initial.revisionId,
    committedAt: REVISIONS.initial.committedAt,
    committedBy: REVISION_AUTHORS.active,
    summary: "Seed large changeset fixture",
    files: CANONICAL_REVISION_FILES,
  });
  assert.equal(seeded.kind, "committed");
  const authorizer = new CapabilityAuthorizer(metadata);
  const configureActor = (currentActor) => {
    metadata.setCurrentAuthorizationStateForTest(
      authorizationQuery(currentActor),
      authorizationState(currentActor),
    );
    usage.ensure(currentActor.principalId, MINDS.ordinary.spaceId);
  };
  const service = ({ currentActor, nextRevisionId, objectStore = objects, capacityLimits } = {}) => {
    configureActor(currentActor);
    return new ChangesetCommitService({
      authorizer,
      metadata,
      revisions: coordinator,
      objects: objectStore,
      clock: { now: () => REVISIONS.next.committedAt },
      revisionIds: revisionIds(nextRevisionId),
      ...(capacityLimits === undefined ? {} : { capacityLimits }),
    });
  };
  const state = async () => {
    const head = await coordinator.readHeadRevision(MINDS.ordinary.spaceId);
    const canonical = await objects.listSpaceCanonicalObjects({
      createdBefore: OBJECT_LIST_CUTOFF,
      excluded: [],
      limit: 1_000,
    });
    return {
      head: head?.envelope.revision.revisionId ?? null,
      revisions: (await metadata.listRevisions(MINDS.ordinary.spaceId))
        .map((revision) => revision.revision.revisionId),
      files: head?.files.map((file) => [file.path, file.text]) ?? [],
      reachable: await metadata.listReachableSpaceCanonicalObjects(),
      canonical: canonical.map((object) => ({
        kind: object.kind,
        spaceId: object.spaceId,
        sha256: object.sha256,
      })),
      idempotency: await metadata.listIdempotencyRecordsForTest(),
      audit: await metadata.listAuditEventsForTest(),
      outbox: await metadata.listAuditOutboxForTest(),
      jobs: await metadata.listBackgroundJobsForTest(),
    };
  };
  return Object.freeze({ objects, metadata, service, state });
}

function requestFor(currentActor, operations, idempotencyKey, summary = "Large changeset") {
  return {
    actor: currentActor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey,
    summary,
    operations,
  };
}

function canonicalKey(object) {
  return `${object.kind}\0${object.spaceId}\0${object.sha256}`;
}

test("72-operation changeset commits one revision and does not rewrite unchanged bodies", async () => {
  const env = await fixture();
  const currentActor = actor("large-success-token", "large-success-request");
  const instrumented = instrumentedStore(env.objects);
  const service = env.service({
    currentActor,
    nextRevisionId: "revision_large_success",
    objectStore: instrumented.store,
  });
  const before = await env.state();
  const result = await service.commit(
    requestFor(currentActor, largeOperations(), "large-success-key"),
  );

  assert.equal(result.kind, "committed");
  assert.equal(result.replayed, false);
  const after = await env.state();
  assert.equal(after.head, "revision_large_success");
  assert.deepEqual(after.revisions, [
    REVISIONS.initial.revisionId,
    "revision_large_success",
  ]);
  assert.equal(after.revisions.length - before.revisions.length, 1);
  assert.equal(after.canonical.filter(({ kind }) => kind === "revision_manifest").length, 1);
  assert.equal(instrumented.writes.filter(({ kind }) => kind === "revision_manifest").length, 1);

  const baseDigests = new Set(
    CANONICAL_REVISION_FILES.map(({ bytes }) => digest(bytes)),
  );
  const markdownWrites = instrumented.writes.filter(({ kind }) => kind === "markdown");
  assert.equal(markdownWrites.length, LARGE_OPERATION_COUNT);
  assert.equal(markdownWrites.some(({ sha256 }) => baseDigests.has(sha256)), false);
  assert.equal(after.idempotency.length, 1);
  assert.equal(after.audit.filter(({ eventType }) => eventType === "content.changeset_committed").length, 1);
  assert.equal(after.outbox.length, 1);
  assert.equal(after.jobs.length, 1);
});

test("large changeset capacity rejection happens before any canonical put", async () => {
  const env = await fixture();
  const currentActor = actor("large-capacity-token", "large-capacity-request");
  const instrumented = instrumentedStore(env.objects);
  const service = env.service({
    currentActor,
    nextRevisionId: "revision_large_capacity_rejected",
    objectStore: instrumented.store,
    capacityLimits: {
      mindPhysicalCanonicalBytes: 1,
      principalPhysicalCanonicalBytes: 1,
      sitePhysicalCanonicalBytes: 1,
      siteTemporaryBytes: 8_589_934_592,
      siteD1MetadataBytes: 536_870_912,
      ordinaryCommitSoftGrowthBytes: 4_194_304,
      activeHeavyPerMind: 1,
      activeHeavyPerPrincipal: 2,
      activeHeavyPerSite: 8,
    },
  });
  const before = await env.state();
  const result = await service.commit(
    requestFor(currentActor, largeOperations("capacity"), "large-capacity-key"),
  );

  assert.equal(result.kind, "invalid");
  assert.equal(result.error.code, "capacity_hard_limit");
  assert.equal(instrumented.putAttempts(), 0);
  const after = await env.state();
  assert.equal(after.head, before.head);
  assert.deepEqual(after.revisions, before.revisions);
  assert.deepEqual(after.canonical, before.canonical);
  assert.equal(after.idempotency.length, 0);
  assert.equal(after.audit.length, 0);
  assert.equal(after.outbox.length, 0);
  assert.equal(after.jobs.length, 0);
});

test("object-write failure leaves metadata effects unchanged and only unreachable cleanup candidates", async () => {
  const env = await fixture();
  const currentActor = actor("large-object-failure-token", "large-object-failure-request");
  const instrumented = instrumentedStore(env.objects, { failAtPut: 10 });
  const service = env.service({
    currentActor,
    nextRevisionId: "revision_large_object_failure",
    objectStore: instrumented.store,
  });
  const before = await env.state();
  await assert.rejects(
    service.commit(
      requestFor(currentActor, largeOperations("object-failure"), "large-object-failure-key"),
    ),
    /injected large changeset object failure/u,
  );

  const after = await env.state();
  assert.equal(after.head, before.head);
  assert.deepEqual(after.revisions, before.revisions);
  assert.deepEqual(after.reachable, before.reachable);
  assert.equal(after.idempotency.length, 0);
  assert.equal(after.audit.length, 0);
  assert.equal(after.outbox.length, 0);
  assert.equal(after.jobs.length, 0);
  assert.ok(instrumented.putAttempts() >= 10);
  const beforeCanonical = new Set(before.canonical.map(canonicalKey));
  const reachable = new Set(after.reachable.map(canonicalKey));
  const newUnreachable = after.canonical.filter((object) =>
    !beforeCanonical.has(canonicalKey(object)) && !reachable.has(canonicalKey(object)));
  assert.ok(newUnreachable.length > 0);
});

test("lost successful response reconciles the exact payload to one committed result", async () => {
  const env = await fixture();
  const currentActor = actor("large-unknown-token", "large-unknown-request");
  const real = env.service({
    currentActor,
    nextRevisionId: "revision_large_unknown",
  });
  const request = requestFor(currentActor, largeOperations("unknown"), "large-unknown-key");
  let commitCalls = 0;
  await assert.rejects(
    (async () => {
      const result = await real.commit(request);
      commitCalls += 1;
      assert.equal(result.kind, "committed");
      throw new Error("simulated lost large changeset response");
    })(),
    /simulated lost large changeset response/u,
  );

  const reconciled = await real.reconcile(request);
  assert.equal(reconciled.kind, "committed");
  assert.equal(reconciled.replayed, true);
  assert.equal(commitCalls, 1);
  const after = await env.state();
  assert.equal(after.revisions.length, 2);
  assert.equal(after.head, "revision_large_unknown");
  assert.equal(after.idempotency.length, 1);
  assert.equal(after.audit.filter(({ eventType }) => eventType === "content.changeset_committed").length, 1);
});

test("metadata failure reconciles missing, then exact retry commits once", async () => {
  const env = await fixture();
  const currentActor = actor("large-metadata-failure-token", "large-metadata-failure-request");
  const request = requestFor(
    currentActor,
    largeOperations("metadata-failure"),
    "large-metadata-failure-key",
  );
  const firstService = env.service({
    currentActor,
    nextRevisionId: "revision_large_metadata_failure",
  });
  env.metadata.failNextCommitForTest(
    new Error("injected large metadata append failure"),
  );
  await assert.rejects(firstService.commit(request), /injected large metadata append failure/u);

  assert.deepEqual(await firstService.reconcile(request), { kind: "missing" });
  const retryService = env.service({
    currentActor,
    nextRevisionId: "revision_large_metadata_failure",
  });
  const committed = await retryService.commit(request);
  assert.equal(committed.kind, "committed");
  assert.equal(committed.replayed, false);
  const replayed = await retryService.commit(request);
  assert.equal(replayed.kind, "committed");
  assert.equal(replayed.replayed, true);
  const after = await env.state();
  assert.deepEqual(after.revisions, [
    REVISIONS.initial.revisionId,
    "revision_large_metadata_failure",
  ]);
  assert.equal(after.head, "revision_large_metadata_failure");
  assert.equal(after.idempotency.length, 1);
  assert.equal(after.audit.filter(({ eventType }) => eventType === "content.changeset_committed").length, 1);
});

test("changed payload with the same idempotency key conflicts without new effects", async () => {
  const env = await fixture();
  const currentActor = actor("large-conflict-token", "large-conflict-request");
  const service = env.service({
    currentActor,
    nextRevisionId: "revision_large_conflict",
  });
  const original = requestFor(currentActor, largeOperations("conflict"), "large-conflict-key");
  const committed = await service.commit(original);
  assert.equal(committed.kind, "committed");
  const beforeConflict = await env.state();
  const conflict = await service.commit({
    ...original,
    operations: largeOperations("conflict-changed"),
  });
  assert.deepEqual(conflict, { kind: "idempotency_conflict" });
  const reconcileConflict = await service.reconcile({
    ...original,
    operations: largeOperations("conflict-reconciled"),
  });
  assert.deepEqual(reconcileConflict, { kind: "idempotency_conflict" });
  assert.deepEqual(await env.state(), beforeConflict);
});
