import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import { BoundedObjectCleanupHandler } from "@mind-diary/application-background";
import {
  CanonicalRevisionCoordinator,
  DEFAULT_CAPACITY_LIMITS,
  MarkdownImportError,
  MarkdownImportService,
} from "@mind-diary/application-content";
import {
  CapabilityAuthorizer,
  REVISION_MANIFEST_MEDIA_TYPE,
} from "@mind-diary/application-ports";
import {
  CAPABILITIES,
  MARKDOWN_MEDIA_TYPE,
  REVISION_MANIFEST_FORMAT_V4,
  REVISION_MANIFEST_FORMAT_V5,
  bundleFileMediaType,
  createCanonicalRevisionEnvelope,
  createRevisionManifest,
  serializeRevisionManifest,
  version,
} from "@mind-diary/domain";
import { validateOkfBundle } from "@mind-diary/okf-codec";
import { MINDS, PRINCIPALS } from "@mind-diary/test-fixtures";

const ENCODER = new TextEncoder();
const T0 = "2026-08-22T18:00:00.000Z";
const T1 = "2026-08-22T18:10:00.000Z";

function actor(requestId = "request_import") {
  return {
    kind: "registered_principal",
    principalId: PRINCIPALS.owner.principalId,
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    deploymentCapabilities: CAPABILITIES,
    requestId,
    occurredAtUtc: T1,
  };
}

function authorize(metadata) {
  metadata.setCurrentAuthorizationStateForTest({
    principalId: PRINCIPALS.owner.principalId,
    spaceId: MINDS.ordinary.spaceId,
    tokenId: null,
  }, {
    principal: { principalId: PRINCIPALS.owner.principalId, state: "active" },
    space: {
      spaceId: MINDS.ordinary.spaceId,
      state: "active",
      visibility: "private",
      accessVersion: version(1),
    },
    membership: {
      principalId: PRINCIPALS.owner.principalId,
      spaceId: MINDS.ordinary.spaceId,
      role: "owner",
      state: "active",
      version: version(1),
    },
    token: null,
  });
}

function revoke(metadata) {
  metadata.setCurrentAuthorizationStateForTest({
    principalId: PRINCIPALS.owner.principalId,
    spaceId: MINDS.ordinary.spaceId,
    tokenId: null,
  }, {
    principal: { principalId: PRINCIPALS.owner.principalId, state: "active" },
    space: {
      spaceId: MINDS.ordinary.spaceId,
      state: "active",
      visibility: "private",
      accessVersion: version(2),
    },
    membership: null,
    token: null,
  });
}

function ids() {
  let plan = 0;
  let session = 0;
  let staged = 0;
  return {
    nextPlanId: () => `import-plan_${++plan}`,
    nextImportId: () => `import_${++session}`,
    nextStagedFileId: () => `import-file_${++staged}`,
  };
}

function effects() {
  let value = 0;
  return {
    nextAuditEventId: () => `audit_import_${++value}`,
    nextOutboxMessageId: () => `outbox_import_${++value}`,
    nextIndexJobId: () => `job_import_${++value}`,
  };
}

async function seed(objects, metadata, files = [{
  path: "index.md",
  mediaType: MARKDOWN_MEDIA_TYPE,
  bytes: ENCODER.encode("---\nokf_version: \"0.2\"\n---\n\n# Before\n"),
}]) {
  const revisions = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  const committed = await revisions.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: null,
    revisionId: "revision_import_initial",
    committedAt: T0,
    committedBy: { kind: "principal", principalId: PRINCIPALS.owner.principalId },
    summary: "Initial import fixture",
    files,
  });
  assert.equal(committed.kind, "committed");
  return revisions;
}

async function seedOpaqueSnapshot(objects, metadata) {
  const revisions = await seed(objects, metadata);
  const markdownBytes = ENCODER.encode(
    "---\nokf_version: \"0.2\"\n---\n\n# Before\n\n![Asset](assets/existing.png)\n",
  );
  const markdownObject = await objects.putSpaceCanonicalObject({
    kind: "markdown",
    spaceId: MINDS.ordinary.spaceId,
    bytes: markdownBytes,
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: T1,
  });
  const opaqueSources = [
    {
      path: "assets/existing.png",
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
      mediaType: bundleFileMediaType("image/png"),
    },
  ];
  const opaqueObjects = await Promise.all(opaqueSources.map((file) =>
    objects.putBundleFile({
      spaceId: MINDS.ordinary.spaceId,
      bytes: file.bytes,
      mediaType: file.mediaType,
      createdAt: T1,
    })));
  const manifest = createRevisionManifest([
    {
      kind: "markdown",
      path: "index.md",
      sha256: markdownObject.object.sha256,
      mediaType: MARKDOWN_MEDIA_TYPE,
      size: markdownObject.object.size,
    },
    ...opaqueSources.map((file, index) => ({
      kind: "opaque",
      path: file.path,
      sha256: opaqueObjects[index].object.sha256,
      mediaType: file.mediaType,
      size: opaqueObjects[index].object.size,
    })),
  ], REVISION_MANIFEST_FORMAT_V4);
  const manifestBytes = ENCODER.encode(serializeRevisionManifest(manifest));
  const manifestObject = await objects.putSpaceCanonicalObject({
    kind: "revision_manifest",
    spaceId: MINDS.ordinary.spaceId,
    bytes: manifestBytes,
    mediaType: REVISION_MANIFEST_MEDIA_TYPE,
    createdAt: T1,
  });
  const envelope = createCanonicalRevisionEnvelope({
    revisionId: "revision_import_opaque",
    spaceId: MINDS.ordinary.spaceId,
    revisionNumber: 2,
    parentRevisionId: "revision_import_initial",
    committedAt: T1,
    committedBy: { kind: "principal", principalId: PRINCIPALS.owner.principalId },
    manifest,
    manifestHash: manifestObject.object.sha256,
    manifestSize: manifestObject.object.size,
    summary: "Opaque import fixture",
  });
  assert.equal((await metadata.commitRevision({
    expectedHeadRevisionId: "revision_import_initial",
    envelope,
  })).kind, "committed");
  return { revisions, opaqueSources };
}

async function plannedFiles(objects) {
  const files = [
    {
      path: "index.md",
      bytes: ENCODER.encode(
        "---\nokf_version: \"0.2\"\n---\n\n# Imported\n\n- [Alpha](concepts/alpha.md)\n",
      ),
    },
    {
      path: "concepts/alpha.md",
      bytes: ENCODER.encode(
        "---\ntype: Reference\ntitle: Alpha\n---\n\n# Alpha\n\nImported exactly.\n",
      ),
    },
  ];
  return Promise.all(files.map(async (file) => ({
    ...file,
    size: file.bytes.byteLength,
    sha256: await objects.calculateSha256(file.bytes),
  })));
}

function service({ metadata, objects, revisions, clock, generatedIds, revisionId = "revision_import_committed", capacityLimits }) {
  return new MarkdownImportService({
    authorizer: new CapabilityAuthorizer(metadata),
    metadata,
    objects,
    revisions,
    clock,
    ids: generatedIds,
    revisionIds: { nextRevisionId: () => revisionId },
    effectIds: effects(),
    ...(capacityLimits === undefined ? {} : { capacityLimits }),
  });
}

test("Markdown import rejects non-canonical, reserved, encoded and overlong paths", async () => {
  const objects = new InMemoryObjectStore();
  const metadata = new InMemoryRevisionMetadataStore();
  const revisions = await seed(objects, metadata);
  authorize(metadata);
  const imports = service({
    metadata,
    objects,
    revisions,
    clock: { now: () => T1 },
    generatedIds: ids(),
  });
  const invalidPaths = [
    "/absolute.md",
    "concepts\\windows.md",
    "https:scheme.md",
    "concepts//empty.md",
    "concepts/../parent.md",
    ".mind-diary/private.md",
    "concepts/cafe\u0301.md",
    "concepts/encoded%2Fslash.md",
    "concepts/encoded%5Cbackslash.md",
    "concepts/encoded%00nul.md",
    `${"é".repeat(128)}.md`,
    `${"a".repeat(250)}/${"b".repeat(250)}/${"c".repeat(250)}/${"d".repeat(250)}/${"e".repeat(20)}.md`,
  ];
  await assert.rejects(
    imports.plan({
      actor: actor("request_import_invalid_paths"),
      spaceId: MINDS.ordinary.spaceId,
      expectedRevisionId: "revision_import_initial",
      idempotencyKey: "plan-invalid-paths",
      files: invalidPaths.map((path) => ({
        path,
        sha256: `sha256:${"a".repeat(64)}`,
        size: 1,
      })),
    }),
    (error) => error instanceof MarkdownImportError &&
      error.code === "invalid_import_request" &&
      error.failures.length === invalidPaths.length &&
      error.failures.every((failure) => failure.code === "invalid_import_path"),
  );
});

test("exact-HEAD plan reports add, replace, delete, unchanged and seals idempotent descriptors", async () => {
  const objects = new InMemoryObjectStore();
  const metadata = new InMemoryRevisionMetadataStore();
  const initialSources = [
    { path: "index.md", bytes: ENCODER.encode("# Unchanged\n") },
    { path: "concepts/replaced.md", bytes: ENCODER.encode("# Before\n") },
    { path: "concepts/deleted.md", bytes: ENCODER.encode("# Delete me\n") },
  ];
  const revisions = await seed(objects, metadata, initialSources.map((file) => ({
    ...file,
    mediaType: MARKDOWN_MEDIA_TYPE,
  })));
  authorize(metadata);
  const imports = service({
    metadata,
    objects,
    revisions,
    clock: { now: () => T1 },
    generatedIds: ids(),
  });
  const desiredSources = [
    initialSources[0],
    { path: "concepts/replaced.md", bytes: ENCODER.encode("# After\n") },
    { path: "concepts/added.md", bytes: ENCODER.encode("# Added\n") },
  ];
  const desired = await Promise.all(desiredSources.map(async (file) => ({
    path: file.path,
    size: file.bytes.byteLength,
    sha256: await objects.calculateSha256(file.bytes),
  })));
  const request = {
    actor: actor("request_exact_plan"),
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_import_initial",
    idempotencyKey: "plan-exact-diff",
    files: desired,
  };
  const planned = await imports.plan(request);
  assert.deepEqual({
    additions: planned.plan.additions,
    replacements: planned.plan.replacements,
    deletions: planned.plan.deletions,
    unchanged: planned.plan.unchanged,
  }, { additions: 1, replacements: 1, deletions: 1, unchanged: 1 });
  assert.equal(planned.plan.expectedRevisionId, "revision_import_initial");
  assert.equal(planned.plan.projectedUtilization, "normal");
  const replay = await imports.plan({ ...request, actor: actor("request_exact_plan_replay") });
  assert.equal(replay.replayed, true);
  assert.equal(replay.plan.planId, planned.plan.planId);
  assert.equal(replay.plan.descriptorHash, planned.plan.descriptorHash);
  await assert.rejects(
    imports.plan({
      ...request,
      actor: actor("request_exact_plan_changed_replay"),
      files: desired.slice(0, 2),
    }),
    (error) => error instanceof MarkdownImportError && error.code === "import_idempotency_conflict",
  );
  await assert.rejects(
    imports.plan({
      ...request,
      actor: actor("request_exact_plan_stale_head"),
      expectedRevisionId: "revision_unknown",
      idempotencyKey: "plan-stale-exact-head",
    }),
    (error) => error instanceof MarkdownImportError && error.code === "import_head_conflict",
  );
});

test("Markdown import survives restart, replays a batch, commits one HEAD and cleans staging", async () => {
  const objects = new InMemoryObjectStore();
  let metadata = new InMemoryRevisionMetadataStore();
  let revisions = await seed(objects, metadata);
  authorize(metadata);
  const generatedIds = ids();
  const clock = { now: () => T1 };
  let imports = service({ metadata, objects, revisions, clock, generatedIds });
  const files = await plannedFiles(objects);

  const planned = await imports.plan({
    actor: actor(),
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_import_initial",
    idempotencyKey: "plan-import-1",
    files: files.map(({ path, sha256, size }) => ({ path, sha256, size })),
  });
  assert.equal(planned.kind, "planned");
  assert.deepEqual(
    [planned.plan.additions, planned.plan.replacements, planned.plan.deletions],
    [1, 1, 0],
  );
  assert.equal(
    planned.plan.descriptorHash,
    await objects.calculateSha256(ENCODER.encode(JSON.stringify(
      planned.plan.files.map(({ path, sha256, size }) => ({ path, sha256, size })),
    ))),
  );
  const started = await imports.start({
    actor: actor(),
    spaceId: MINDS.ordinary.spaceId,
    planId: planned.plan.planId,
    idempotencyKey: "session-import-1",
  });
  assert.equal(started.kind, "started");
  assert.equal(started.session.checkpoint, 0);
  const startReplay = await imports.start({
    actor: actor("request_import_start_replay"),
    spaceId: MINDS.ordinary.spaceId,
    planId: planned.plan.planId,
    idempotencyKey: "session-import-1",
  });
  assert.equal(startReplay.replayed, true);
  assert.equal(startReplay.session.importId, started.session.importId);
  await assert.rejects(
    imports.start({
      actor: actor("request_import_second_claim"),
      spaceId: MINDS.ordinary.spaceId,
      planId: planned.plan.planId,
      idempotencyKey: "session-import-different-key",
    }),
    (error) => error instanceof MarkdownImportError &&
      error.code === "import_idempotency_conflict",
  );
  revoke(metadata);
  await assert.rejects(
    imports.status(actor("request_import_revoked_status"), started.session.importId),
    (error) => error instanceof MarkdownImportError &&
      error.code === "import_session_not_found",
  );
  authorize(metadata);

  const staged = await imports.stageBatch({
    actor: actor(),
    importId: started.session.importId,
    checkpoint: 1,
    expectedVersion: started.session.version,
    files,
  });
  assert.equal(staged.kind, "staged");
  assert.equal(staged.session.stagedFileCount, 2);

  metadata = InMemoryRevisionMetadataStore.fromDurableSnapshot(metadata.exportDurableSnapshot());
  revisions = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  imports = service({ metadata, objects, revisions, clock, generatedIds });
  const replay = await imports.stageBatch({
    actor: actor("request_import_replay"),
    importId: started.session.importId,
    checkpoint: 1,
    expectedVersion: started.session.version,
    files,
  });
  assert.equal(replay.kind, "staged");
  assert.equal(replay.replayed, true);
  assert.equal((await metadata.listMarkdownImportStagedFiles(started.session.importId)).length, 2);

  const validated = await imports.validate({
    actor: actor(),
    importId: started.session.importId,
    expectedVersion: staged.session.version,
  });
  assert.equal(validated.kind, "validated");
  const committed = await imports.commit({
    actor: actor(),
    importId: started.session.importId,
    expectedVersion: validated.session.version,
  });
  assert.deepEqual(committed, {
    kind: "committed",
    revisionId: "revision_import_committed",
    replayed: false,
  });
  metadata = InMemoryRevisionMetadataStore.fromDurableSnapshot(metadata.exportDurableSnapshot());
  revisions = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  imports = service({ metadata, objects, revisions, clock, generatedIds });
  const unknownOutcomeReplay = await imports.commit({
    actor: actor("request_import_unknown_outcome_replay"),
    importId: started.session.importId,
    expectedVersion: validated.session.version,
  });
  assert.deepEqual(unknownOutcomeReplay, {
    kind: "committed",
    revisionId: "revision_import_committed",
    replayed: true,
  });
  const materialized = await revisions.materialize(
    MINDS.ordinary.spaceId,
    "revision_import_committed",
  );
  assert.deepEqual(materialized.files.map((file) => file.path), [
    "concepts/alpha.md",
    "index.md",
  ]);
  assert.equal(validateOkfBundle(materialized.files
    .filter((file) => file.kind === "markdown")
    .map((file) => ({ path: file.path, text: file.text }))).valid, true);
  assert.equal((await metadata.listRevisions(MINDS.ordinary.spaceId)).length, 2);
  assert.equal((await imports.status(actor(), started.session.importId)).session.state, "committed");

  const cleaned = await imports.collectExpired();
  assert.equal(cleaned.deleted, 2);
  assert.equal((await metadata.listMarkdownImportStagedFiles(started.session.importId)).length, 0);
  assert.ok((await metadata.readMarkdownImportSession(started.session.importId)).cleanupCompletedAt);
  assert.equal((await metadata.listCapacityReservationsForTest()).find((item) =>
    item.reservationId === started.session.reservationId)?.state, "released");
});

test("an abandoned import promotion page resumes after restart without releasing unknown writes", async () => {
  const objects = new InMemoryObjectStore();
  let metadata = new InMemoryRevisionMetadataStore();
  let revisions = await seed(objects, metadata);
  authorize(metadata);
  const generatedIds = ids();
  const clock = { now: () => T1 };
  let imports = service({ metadata, objects, revisions, clock, generatedIds });
  const bytes = ENCODER.encode("---\nokf_version: \"0.2\"\n---\n\n# Imported\n");
  const files = [{
    path: "index.md",
    bytes,
    size: bytes.byteLength,
    sha256: await objects.calculateSha256(bytes),
  }];
  const planned = await imports.plan({
    actor: actor("request_promotion_fence_plan"),
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_import_initial",
    idempotencyKey: "promotion-fence-plan",
    files: files.map(({ path, sha256, size }) => ({ path, sha256, size })),
  });
  const started = await imports.start({
    actor: actor("request_promotion_fence_start"),
    spaceId: MINDS.ordinary.spaceId,
    planId: planned.plan.planId,
    idempotencyKey: "promotion-fence-session",
  });
  const staged = await imports.stageBatch({
    actor: actor("request_promotion_fence_stage"),
    importId: started.session.importId,
    checkpoint: 1,
    expectedVersion: started.session.version,
    files,
  });
  const validated = await imports.validate({
    actor: actor("request_promotion_fence_validate"),
    importId: started.session.importId,
    expectedVersion: staged.session.version,
  });
  let signalPut;
  let releasePut;
  const putStarted = new Promise((resolve) => { signalPut = resolve; });
  const putGate = new Promise((resolve) => { releasePut = resolve; });
  let putCalls = 0;
  const delayedObjects = new Proxy(objects, {
    get(target, property) {
      if (property === "putSpaceCanonicalObject") return async (request) => {
        putCalls += 1;
        if (putCalls === 1) {
          signalPut();
          await putGate;
          throw new Error("synthetic abandoned import worker");
        }
        return target.putSpaceCanonicalObject(request);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  imports = service({ metadata, objects: delayedObjects, revisions, clock, generatedIds });
  const first = imports.commit({
    actor: actor("request_promotion_fence_first"),
    importId: started.session.importId,
    expectedVersion: validated.session.version,
  });
  await putStarted;
  const running = await metadata.readMarkdownImportSession(started.session.importId);
  assert.ok(running.activeStepId);
  metadata = InMemoryRevisionMetadataStore.fromDurableSnapshot(metadata.exportDurableSnapshot());
  revisions = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  const cancelMetadata = InMemoryRevisionMetadataStore.fromDurableSnapshot(metadata.exportDurableSnapshot());
  const cancelImports = service({ metadata: cancelMetadata, objects,
    revisions: new CanonicalRevisionCoordinator({ objects, revisions: cancelMetadata }),
    clock, generatedIds });
  const canceled = await cancelImports.cancel(actor("request_promotion_fence_cancel"),
    started.session.importId, running.version);
  assert.equal(canceled.session.state, "canceled");
  assert.equal(canceled.session.activeStepId, null);
  assert.equal(canceled.session.unsettledWriterPossible, true);
  assert.equal((await cancelMetadata.listCapacityReservationsForTest()).find((item) =>
    item.reservationId === started.session.reservationId)?.state, "cleanup_pending");
  const conflictMetadata = InMemoryRevisionMetadataStore.fromDurableSnapshot(metadata.exportDurableSnapshot());
  const conflictRevisions = new CanonicalRevisionCoordinator({ objects, revisions: conflictMetadata });
  let injectHeadChange = true;
  const conflictRaceMetadata = new Proxy(conflictMetadata, {
    get(target, property) {
      if (property === "runMarkdownImportTransaction") return async (operation) => {
        if (injectHeadChange) {
          injectHeadChange = false;
          assert.equal((await conflictRevisions.commit({
            spaceId: MINDS.ordinary.spaceId,
            expectedRevisionId: "revision_import_initial",
            revisionId: "revision_import_conflict_after_lost_step",
            committedAt: T1,
            committedBy: { kind: "principal", principalId: PRINCIPALS.owner.principalId },
            summary: "Concurrent HEAD",
            files: [{ path: "index.md", bytes: ENCODER.encode("# Concurrent HEAD\n"),
              mediaType: MARKDOWN_MEDIA_TYPE }],
          })).kind, "committed");
        }
        return target.runMarkdownImportTransaction(operation);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const conflictImports = service({ metadata: conflictRaceMetadata, objects,
    revisions: conflictRevisions, clock, generatedIds });
  await assert.rejects(conflictImports.commit({
    actor: actor("request_promotion_fence_head_conflict"),
    importId: started.session.importId,
    expectedVersion: running.version,
  }), (error) => error instanceof MarkdownImportError && error.code === "import_head_conflict");
  const conflicted = await conflictMetadata.readMarkdownImportSession(started.session.importId);
  assert.equal(conflicted.state, "validation_failed");
  assert.equal(conflicted.activeStepId, null);
  assert.equal(conflicted.unsettledWriterPossible, true);
  assert.equal((await conflictMetadata.listCapacityReservationsForTest()).find((item) =>
    item.reservationId === started.session.reservationId)?.state, "cleanup_pending");
  const afterExpiry = new Date(Date.parse(running.expiresAt) + 1_000).toISOString();
  await metadata.collectExpiredCapacityReservations({ now: afterExpiry, limit: 10 });
  const restarted = service({ metadata, objects: delayedObjects, revisions,
    clock: { now: () => afterExpiry }, generatedIds });
  const callsBeforeSecond = putCalls;
  const recovered = await restarted.commit({
    actor: actor("request_promotion_fence_second"),
    importId: started.session.importId,
    expectedVersion: running.version,
  });
  assert.equal(recovered.kind, "committed");
  assert.equal(putCalls, callsBeforeSecond + 2);
  assert.equal((await metadata.readMarkdownImportSession(started.session.importId))
    .unsettledWriterPossible, true);
  releasePut();
  await assert.rejects(first, /synthetic abandoned import worker/u);
  await restarted.collectExpired();
  assert.equal((await metadata.listCapacityReservationsForTest()).find((item) =>
    item.reservationId === started.session.reservationId)?.state, "cleanup_pending");
});

test("a superseded import page releases capacity after its old writer settles", async () => {
  const objects = new InMemoryObjectStore();
  const metadata = new InMemoryRevisionMetadataStore();
  const revisions = await seed(objects, metadata);
  authorize(metadata);
  const generatedIds = ids();
  const clock = { now: () => T1 };
  const bytes = ENCODER.encode("---\nokf_version: \"0.2\"\n---\n\n# Settled import\n");
  const files = [{ path: "index.md", bytes, size: bytes.byteLength,
    sha256: await objects.calculateSha256(bytes) }];
  const normal = service({ metadata, objects, revisions, clock, generatedIds });
  const plan = await normal.plan({ actor: actor(), spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_import_initial", idempotencyKey: "settled-plan",
    files: files.map(({ path, sha256, size }) => ({ path, sha256, size })) });
  const started = await normal.start({ actor: actor(), spaceId: MINDS.ordinary.spaceId,
    planId: plan.plan.planId, idempotencyKey: "settled-session" });
  const staged = await normal.stageBatch({ actor: actor(), importId: started.session.importId,
    checkpoint: 1, expectedVersion: started.session.version, files });
  const validated = await normal.validate({ actor: actor(), importId: started.session.importId,
    expectedVersion: staged.session.version });
  let signalFirstPut;
  const firstPutStarted = new Promise((resolve) => { signalFirstPut = resolve; });
  let resumeFirstPut;
  const firstPutHold = new Promise((resolve) => { resumeFirstPut = resolve; });
  let putCalls = 0;
  const delayedObjects = new Proxy(objects, {
    get(target, property) {
      if (property === "putSpaceCanonicalObject") return async (request) => {
        putCalls += 1;
        if (putCalls === 1) {
          signalFirstPut();
          await firstPutHold;
        }
        return target.putSpaceCanonicalObject(request);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const imports = service({ metadata, objects: delayedObjects, revisions, clock, generatedIds });
  const first = imports.commit({ actor: actor("settled-first"),
    importId: started.session.importId, expectedVersion: validated.session.version });
  await firstPutStarted;
  const running = await metadata.readMarkdownImportSession(started.session.importId);
  assert.ok(running.activeStepId);
  const recovered = await imports.commit({ actor: actor("settled-second"),
    importId: started.session.importId, expectedVersion: running.version });
  assert.equal(recovered.kind, "committed");
  assert.equal((await metadata.readMarkdownImportSession(started.session.importId))
    .unsettledStepIds?.length, 1);
  await imports.collectExpired();
  assert.equal((await metadata.readMarkdownImportSession(started.session.importId))
    .cleanupCompletedAt, null);
  resumeFirstPut();
  await assert.rejects(first, (error) => error instanceof MarkdownImportError &&
    error.code === "import_state_conflict");
  const settled = await metadata.readMarkdownImportSession(started.session.importId);
  assert.deepEqual(settled.unsettledStepIds, []);
  assert.equal(settled.unsettledWriterPossible, false);
  await imports.collectExpired();
  assert.equal((await metadata.listCapacityReservationsForTest()).find((item) =>
    item.reservationId === started.session.reservationId)?.state, "released");
  assert.ok((await metadata.readMarkdownImportSession(started.session.importId)).cleanupCompletedAt);
});

test("revocation after promotion writes closes the import without releasing possible orphans", async () => {
  const objects = new InMemoryObjectStore();
  const metadata = new InMemoryRevisionMetadataStore();
  const revisions = await seed(objects, metadata);
  authorize(metadata);
  const generatedIds = ids();
  const clock = { now: () => T1 };
  const normal = service({ metadata, objects, revisions, clock, generatedIds });
  const bytes = ENCODER.encode("---\nokf_version: \"0.2\"\n---\n\n# Revoked import\n");
  const files = [{ path: "index.md", bytes, size: bytes.byteLength,
    sha256: await objects.calculateSha256(bytes) }];
  const plan = await normal.plan({ actor: actor(), spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_import_initial", idempotencyKey: "revoked-plan",
    files: files.map(({ path, sha256, size }) => ({ path, sha256, size })) });
  const started = await normal.start({ actor: actor(), spaceId: MINDS.ordinary.spaceId,
    planId: plan.plan.planId, idempotencyKey: "revoked-session" });
  const staged = await normal.stageBatch({ actor: actor(), importId: started.session.importId,
    checkpoint: 1, expectedVersion: started.session.version, files });
  const validated = await normal.validate({ actor: actor(), importId: started.session.importId,
    expectedVersion: staged.session.version });
  let revoked = false;
  const revokingObjects = new Proxy(objects, {
    get(target, property) {
      if (property === "putSpaceCanonicalObject") return async (request) => {
        const result = await target.putSpaceCanonicalObject(request);
        if (!revoked) { revoked = true; revoke(metadata); }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const imports = service({ metadata, objects: revokingObjects, revisions, clock, generatedIds });
  const result = await imports.commit({ actor: actor("revoked-writer"),
    importId: started.session.importId, expectedVersion: validated.session.version });
  assert.equal(result.kind, "denied");
  const closed = await metadata.readMarkdownImportSession(started.session.importId);
  assert.equal(closed.state, "canceled");
  assert.equal(closed.activeStepId, null);
  assert.equal(closed.canonicalWriteExposure, true);
  assert.equal(await metadata.readHead(MINDS.ordinary.spaceId), "revision_import_initial");
  await imports.collectExpired();
  assert.equal((await metadata.listCapacityReservationsForTest()).find((item) =>
    item.reservationId === started.session.reservationId)?.state, "cleanup_pending");
  const cleanup = new BoundedObjectCleanupHandler({
    objects,
    checkpoints: metadata,
    reachability: metadata,
    staging: metadata,
    exports: metadata,
    clock: { now: () => "2027-01-02T00:00:00.000Z" },
    monotonicNow: () => 0,
  });
  const serviceActor = { kind: "service", serviceId: "failed-import-recovery",
    requestId: "failed-import-recovery", occurredAtUtc: "2027-01-02T00:00:00.000Z",
    deploymentCapabilities: [] };
  const tooYoung = await cleanup.handle({ actor: serviceActor,
    createdBefore: "2026-08-22T18:05:00.000Z", maxObjects: 1_000,
    maxBytes: 268_435_456, maxDurationMs: 1_000 });
  assert.equal(tooYoung.cycleCompleted, true);
  assert.equal((await metadata.listCapacityReservationsForTest()).find((item) =>
    item.reservationId === started.session.reservationId)?.state, "cleanup_pending");
  const blockedObjects = new Proxy(objects, {
    get(target, property) {
      if (property === "deleteObjectCleanupCandidate") return async (request) =>
        request.candidate.namespace === "space_canonical"
          ? false
          : target.deleteObjectCleanupCandidate(request);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const failedDelete = await new BoundedObjectCleanupHandler({
    objects: blockedObjects, checkpoints: metadata, reachability: metadata,
    staging: metadata, exports: metadata,
    clock: { now: () => "2027-01-02T00:00:00.000Z" }, monotonicNow: () => 0,
  }).handle({ actor: serviceActor, createdBefore: "2027-01-01T00:00:00.000Z",
    maxObjects: 1_000, maxBytes: 268_435_456, maxDurationMs: 1_000 });
  assert.equal(failedDelete.cycleCompleted, true);
  assert.equal((await metadata.listCapacityReservationsForTest()).find((item) =>
    item.reservationId === started.session.reservationId)?.state, "cleanup_pending");
  const reclaimed = await cleanup.handle({ actor: serviceActor,
    createdBefore: "2027-01-01T00:00:00.000Z", maxObjects: 1_000,
    maxBytes: 268_435_456, maxDurationMs: 1_000 });
  assert.equal(reclaimed.cycleCompleted, true);
  assert.ok(reclaimed.deleted > 0);
  assert.equal((await metadata.listCapacityReservationsForTest()).find((item) =>
    item.reservationId === started.session.reservationId)?.state, "released");
  assert.equal(await metadata.readHead(MINDS.ordinary.spaceId), "revision_import_initial");
});

test("a settled import writer closes its step when final metadata commit fails", async () => {
  const objects = new InMemoryObjectStore();
  const metadata = new InMemoryRevisionMetadataStore();
  const revisions = await seed(objects, metadata);
  authorize(metadata);
  const generatedIds = ids();
  const clock = { now: () => T1 };
  const normal = service({ metadata, objects, revisions, clock, generatedIds });
  const bytes = ENCODER.encode("---\nokf_version: \"0.2\"\n---\n\n# Metadata failure\n");
  const files = [{ path: "index.md", bytes, size: bytes.byteLength,
    sha256: await objects.calculateSha256(bytes) }];
  const plan = await normal.plan({ actor: actor(), spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_import_initial", idempotencyKey: "failed-final-plan",
    files: files.map(({ path, sha256, size }) => ({ path, sha256, size })) });
  const started = await normal.start({ actor: actor(), spaceId: MINDS.ordinary.spaceId,
    planId: plan.plan.planId, idempotencyKey: "failed-final-session" });
  const staged = await normal.stageBatch({ actor: actor(), importId: started.session.importId,
    checkpoint: 1, expectedVersion: started.session.version, files });
  const validated = await normal.validate({ actor: actor(), importId: started.session.importId,
    expectedVersion: staged.session.version });
  let transactions = 0;
  const failingMetadata = new Proxy(metadata, {
    get(target, property) {
      if (property === "runMarkdownImportTransaction") return async (operation) => {
        transactions += 1;
        if (transactions === 2) throw new Error("synthetic final metadata failure");
        return target.runMarkdownImportTransaction(operation);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const imports = service({ metadata: failingMetadata, objects, revisions, clock, generatedIds });
  await assert.rejects(imports.commit({ actor: actor("failed-final-commit"),
    importId: started.session.importId, expectedVersion: validated.session.version }),
  /synthetic final metadata failure/u);
  assert.equal(transactions, 4);
  const closed = await metadata.readMarkdownImportSession(started.session.importId);
  assert.equal(closed.state, "validation_failed");
  assert.equal(closed.activeStepId, null);
  assert.equal(closed.unsettledWriterPossible, false);
  assert.equal(await metadata.readHead(MINDS.ordinary.spaceId), "revision_import_initial");
  await imports.collectExpired();
  assert.ok((await metadata.readMarkdownImportSession(started.session.importId)).cleanupCompletedAt);
  assert.equal((await metadata.listCapacityReservationsForTest()).find((item) =>
    item.reservationId === started.session.reservationId)?.state, "cleanup_pending");
});

test("a staged batch with a lost D1 response has no stranded staging writer", async () => {
  const objects = new InMemoryObjectStore();
  const metadata = new InMemoryRevisionMetadataStore();
  const revisions = await seed(objects, metadata);
  authorize(metadata);
  const generatedIds = ids();
  const clock = { now: () => T1 };
  const normal = service({ metadata, objects, revisions, clock, generatedIds });
  const bytes = ENCODER.encode("---\nokf_version: \"0.2\"\n---\n\n# Staging response\n");
  const files = [{ path: "index.md", bytes, size: bytes.byteLength,
    sha256: await objects.calculateSha256(bytes) }];
  const plan = await normal.plan({ actor: actor(), spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_import_initial", idempotencyKey: "staging-response-plan",
    files: files.map(({ path, sha256, size }) => ({ path, sha256, size })) });
  const started = await normal.start({ actor: actor(), spaceId: MINDS.ordinary.spaceId,
    planId: plan.plan.planId, idempotencyKey: "staging-response-session" });
  let transactions = 0;
  const lostResponseMetadata = new Proxy(metadata, {
    get(target, property) {
      if (property === "runMarkdownImportTransaction") return async (operation) => {
        transactions += 1;
        const result = await target.runMarkdownImportTransaction(operation);
        if (transactions === 3) throw new Error("synthetic lost staging response");
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const importing = service({ metadata: lostResponseMetadata, objects, revisions,
    clock, generatedIds });
  await assert.rejects(importing.stageBatch({ actor: actor(),
    importId: started.session.importId, checkpoint: 1,
    expectedVersion: started.session.version, files }), /synthetic lost staging response/u);
  const durable = await metadata.readMarkdownImportSession(started.session.importId);
  assert.equal(durable.checkpoint, 1);
  assert.deepEqual(durable.activeStagingStepIds, []);
  assert.equal((await metadata.listMarkdownImportStagedFiles(started.session.importId)).length, 1);
  const replay = await normal.stageBatch({ actor: actor(), importId: started.session.importId,
    checkpoint: 1, expectedVersion: started.session.version, files });
  assert.equal(replay.kind, "staged");
  assert.equal(replay.replayed, true);
});

test("uncertain staged object write keeps import capacity and cleanup fenced", async () => {
  const objects = new InMemoryObjectStore();
  const metadata = new InMemoryRevisionMetadataStore();
  const revisions = await seed(objects, metadata);
  authorize(metadata);
  const generatedIds = ids();
  const clock = { now: () => T1 };
  const normal = service({ metadata, objects, revisions, clock, generatedIds });
  const bytes = ENCODER.encode("---\nokf_version: \"0.2\"\n---\n\n# Uncertain staging\n");
  const files = [{ path: "index.md", bytes, size: bytes.byteLength,
    sha256: await objects.calculateSha256(bytes) }];
  const plan = await normal.plan({ actor: actor(), spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_import_initial", idempotencyKey: "uncertain-stage-plan",
    files: files.map(({ path, sha256, size }) => ({ path, sha256, size })) });
  const started = await normal.start({ actor: actor(), spaceId: MINDS.ordinary.spaceId,
    planId: plan.plan.planId, idempotencyKey: "uncertain-stage-session" });
  const uncertainObjects = new Proxy(objects, {
    get(target, property) {
      if (property === "putStagedBundleFile") return async (request) => {
        await target.putStagedBundleFile(request);
        throw new Error("synthetic uncertain staged PUT");
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const importing = service({ metadata, objects: uncertainObjects, revisions,
    clock, generatedIds });
  await assert.rejects(importing.stageBatch({ actor: actor(),
    importId: started.session.importId, checkpoint: 1,
    expectedVersion: started.session.version, files }), /synthetic uncertain staged PUT/u);
  const uncertain = await metadata.readMarkdownImportSession(started.session.importId);
  assert.equal(uncertain.activeStagingStepIds.length, 1);
  const canceled = await normal.cancel(actor(), started.session.importId, uncertain.version);
  assert.equal(canceled.session.state, "canceled");
  const cleaned = await normal.collectExpired();
  assert.equal(cleaned.sessions, 0);
  const gc = await new BoundedObjectCleanupHandler({
    objects, checkpoints: metadata, reachability: metadata, staging: metadata,
    exports: metadata, clock: { now: () => "2027-01-02T00:00:00.000Z" },
    monotonicNow: () => 0,
  }).handle({ actor: { kind: "service", serviceId: "uncertain-stage-gc",
    requestId: "uncertain-stage-gc", occurredAtUtc: "2027-01-02T00:00:00.000Z",
    deploymentCapabilities: [] }, createdBefore: "2027-01-01T00:00:00.000Z",
    maxObjects: 1_000, maxBytes: 268_435_456, maxDurationMs: 1_000 });
  assert.equal(gc.cycleCompleted, true);
  assert.equal((await metadata.listCapacityReservationsForTest()).find((item) =>
    item.reservationId === started.session.reservationId)?.state, "cleanup_pending");
});

test("an unarmed staging step is retired on expiry before it can write", async () => {
  const objects = new InMemoryObjectStore();
  const metadata = new InMemoryRevisionMetadataStore();
  const revisions = await seed(objects, metadata);
  authorize(metadata);
  const generatedIds = ids();
  const normal = service({ metadata, objects, revisions, clock: { now: () => T1 }, generatedIds });
  const bytes = ENCODER.encode("---\nokf_version: \"0.2\"\n---\n\n# Prepared only\n");
  const file = { path: "index.md", bytes, size: bytes.byteLength,
    sha256: await objects.calculateSha256(bytes) };
  const plan = await normal.plan({ actor: actor(), spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_import_initial", idempotencyKey: "prepared-stage-plan",
    files: [{ path: file.path, size: file.size, sha256: file.sha256 }] });
  const started = await normal.start({ actor: actor(), spaceId: MINDS.ordinary.spaceId,
    planId: plan.plan.planId, idempotencyKey: "prepared-stage-session" });
  const stepId = "prepared-stage-only";
  const canonicalRequestHash = await objects.calculateSha256(ENCODER.encode("prepared step"));
  const prepared = await metadata.runMarkdownImportTransaction((transaction) =>
    transaction.beginMarkdownImportStagingStep({
      importId: started.session.importId,
      expectedVersion: started.session.version,
      checkpoint: 1,
      canonicalRequestHash,
      stepId,
      startedAt: T1,
    }));
  assert.equal(prepared.kind, "claimed");
  const afterExpiry = new Date(Date.parse(started.session.expiresAt) + 1_000).toISOString();
  const expired = service({ metadata, objects, revisions,
    clock: { now: () => afterExpiry }, generatedIds });
  const cleaned = await expired.collectExpired();
  assert.equal(cleaned.sessions, 1);
  const retired = await metadata.readMarkdownImportSession(started.session.importId);
  assert.equal(retired.state, "expired");
  assert.deepEqual(retired.activeStagingStepIds, []);
  assert.equal(await metadata.runMarkdownImportTransaction((transaction) =>
    transaction.armMarkdownImportStagingStep({ importId: started.session.importId,
      expectedVersion: started.session.version, stepId, armedAt: afterExpiry })), false);
  assert.equal((await metadata.listCapacityReservationsForTest()).find((item) =>
    item.reservationId === started.session.reservationId)?.state, "released");
});

test("batch checkpoints reject gaps and changed replay while exact replay stays idempotent", async () => {
  const objects = new InMemoryObjectStore();
  const metadata = new InMemoryRevisionMetadataStore();
  const revisions = await seed(objects, metadata);
  authorize(metadata);
  const imports = service({
    metadata,
    objects,
    revisions,
    clock: { now: () => T1 },
    generatedIds: ids(),
  });
  const files = await plannedFiles(objects);
  const planned = await imports.plan({
    actor: actor("request_checkpoint_plan"),
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_import_initial",
    idempotencyKey: "plan-checkpoints",
    files: files.map(({ path, sha256, size }) => ({ path, sha256, size })),
  });
  const started = await imports.start({
    actor: actor("request_checkpoint_start"),
    spaceId: MINDS.ordinary.spaceId,
    planId: planned.plan.planId,
    idempotencyKey: "session-checkpoints",
  });
  await assert.rejects(
    imports.stageBatch({
      actor: actor("request_checkpoint_gap"),
      importId: started.session.importId,
      checkpoint: 2,
      expectedVersion: started.session.version,
      files: [files[0]],
    }),
    (error) => error instanceof MarkdownImportError && error.code === "import_checkpoint_conflict",
  );
  const first = await imports.stageBatch({
    actor: actor("request_checkpoint_first"),
    importId: started.session.importId,
    checkpoint: 1,
    expectedVersion: started.session.version,
    files: [files[0]],
  });
  const replay = await imports.stageBatch({
    actor: actor("request_checkpoint_exact_replay"),
    importId: started.session.importId,
    checkpoint: 1,
    expectedVersion: started.session.version,
    files: [files[0]],
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.session.version, first.session.version);
  await assert.rejects(
    imports.stageBatch({
      actor: actor("request_checkpoint_changed_replay"),
      importId: started.session.importId,
      checkpoint: 1,
      expectedVersion: started.session.version,
      files: [files[1]],
    }),
    (error) => error instanceof MarkdownImportError && error.code === "import_idempotency_conflict",
  );
  const second = await imports.stageBatch({
    actor: actor("request_checkpoint_second"),
    importId: started.session.importId,
    checkpoint: 2,
    expectedVersion: first.session.version,
    files: [files[1]],
  });
  assert.equal(second.session.checkpoint, 2);
  assert.equal(second.session.stagedFileCount, 2);
});

test("invalid UTF-8 is rejected before checkpoint publication and leaves HEAD unchanged", async () => {
  const objects = new InMemoryObjectStore();
  const metadata = new InMemoryRevisionMetadataStore();
  const revisions = await seed(objects, metadata);
  authorize(metadata);
  const imports = service({
    metadata,
    objects,
    revisions,
    clock: { now: () => T1 },
    generatedIds: ids(),
  });
  const bytes = Uint8Array.from([0x23, 0x20, 0xc3, 0x28]);
  const file = {
    path: "invalid-utf8.md",
    bytes,
    size: bytes.byteLength,
    sha256: await objects.calculateSha256(bytes),
  };
  const planned = await imports.plan({
    actor: actor("request_invalid_utf8_plan"),
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_import_initial",
    idempotencyKey: "plan-invalid-utf8",
    files: [{ path: file.path, sha256: file.sha256, size: file.size }],
  });
  const started = await imports.start({
    actor: actor("request_invalid_utf8_start"),
    spaceId: MINDS.ordinary.spaceId,
    planId: planned.plan.planId,
    idempotencyKey: "session-invalid-utf8",
  });
  await assert.rejects(
    imports.stageBatch({
      actor: actor("request_invalid_utf8_stage"),
      importId: started.session.importId,
      checkpoint: 1,
      expectedVersion: started.session.version,
      files: [file],
    }),
    (error) => error instanceof MarkdownImportError &&
      error.code === "import_validation_failed" &&
      error.failures.some((failure) => failure.code === "invalid_utf8"),
  );
  assert.equal((await metadata.listMarkdownImportStagedFiles(started.session.importId)).length, 0);
  const failed = await metadata.readMarkdownImportSession(started.session.importId);
  assert.equal(failed.state, "validation_failed");
  assert.equal(failed.checkpoint, 0);
  assert.deepEqual(failed.failures, [{ path: "invalid-utf8.md", code: "invalid_utf8" }]);
  assert.equal((await imports.collectExpired()).deleted, 0);
  assert.ok((await metadata.readMarkdownImportSession(started.session.importId)).cleanupCompletedAt);
  assert.equal(await metadata.readHead(MINDS.ordinary.spaceId), "revision_import_initial");
});

test("Brain-scale synthetic Markdown snapshot crosses bounded batches and publishes one revision", async () => {
  const objects = new InMemoryObjectStore();
  const objectConcurrency = {
    getStagedBundleFile: { active: 0, peak: 0 },
    putSpaceCanonicalObject: { active: 0, peak: 0 },
    putStagedBundleFile: { active: 0, peak: 0 },
  };
  for (const method of Object.keys(objectConcurrency)) {
    const original = objects[method].bind(objects);
    objects[method] = async (...args) => {
      const state = objectConcurrency[method];
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await original(...args);
      } finally {
        state.active -= 1;
      }
    };
  }
  let metadata = new InMemoryRevisionMetadataStore();
  let revisions = await seed(objects, metadata);
  authorize(metadata);
  let imports = service({
    metadata,
    objects,
    revisions,
    clock: { now: () => T1 },
    generatedIds: ids(),
    revisionId: "revision_import_synthetic",
  });
  const sources = [
    { path: "index.md", bytes: ENCODER.encode("# Synthetic Brain\n") },
    ...Array.from({ length: 1_024 }, (_unused, index) => ({
      path: `concepts/note-${String(index + 1).padStart(4, "0")}.md`,
      bytes: ENCODER.encode(
        `---\ntype: Reference\ntitle: Note ${index + 1}\n---\n\n# Note ${index + 1}\n\nSynthetic import evidence.\n`,
      ),
    })),
  ];
  const files = await Promise.all(sources.map(async (file) => ({
    ...file,
    size: file.bytes.byteLength,
    sha256: await objects.calculateSha256(file.bytes),
  })));
  const planned = await imports.plan({
    actor: actor("request_synthetic_plan"),
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_import_initial",
    idempotencyKey: "plan-synthetic-brain",
    files: files.map(({ path, sha256, size }) => ({ path, sha256, size })),
  });
  assert.equal(planned.plan.files.length, 1_025);
  const started = await imports.start({
    actor: actor("request_synthetic_start"),
    spaceId: MINDS.ordinary.spaceId,
    planId: planned.plan.planId,
    idempotencyKey: "session-synthetic-brain",
  });
  let session = started.session;
  let checkpoint = 0;
  for (let offset = 0; offset < files.length; offset += 256) {
    checkpoint += 1;
    const staged = await imports.stageBatch({
      actor: actor(`request_synthetic_batch_${checkpoint}`),
      importId: session.importId,
      checkpoint,
      expectedVersion: session.version,
      files: files.slice(offset, offset + 256),
    });
    session = staged.session;
  }
  assert.equal(session.checkpoint, 5);
  assert.equal(session.stagedFileCount, 1_025);
  let validation = await imports.validate({
    actor: actor("request_synthetic_validate"),
    importId: session.importId,
    expectedVersion: session.version,
  });
  assert.equal(validation.kind, "validation_progress");
  assert.equal(validation.session.validationCheckpoint, 20);
  metadata = InMemoryRevisionMetadataStore.fromDurableSnapshot(metadata.exportDurableSnapshot());
  revisions = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  imports = service({
    metadata,
    objects,
    revisions,
    clock: { now: () => T1 },
    generatedIds: ids(),
    revisionId: "revision_import_synthetic",
  });
  while (validation.kind === "validation_progress") {
    validation = await imports.validate({
      actor: actor(`request_synthetic_validate_${validation.session.validationCheckpoint}`),
      importId: session.importId,
      expectedVersion: validation.session.version,
    });
  }
  assert.equal(validation.kind, "validated");
  assert.equal(validation.session.validationCheckpoint, 1_025);
  let finalization = await imports.commit({
    actor: actor("request_synthetic_commit"),
    importId: session.importId,
    expectedVersion: validation.session.version,
  });
  assert.equal(finalization.kind, "commit_progress");
  assert.equal(finalization.session.promotionCheckpoint, 8);
  metadata = InMemoryRevisionMetadataStore.fromDurableSnapshot(metadata.exportDurableSnapshot());
  revisions = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  imports = service({
    metadata,
    objects,
    revisions,
    clock: { now: () => T1 },
    generatedIds: ids(),
    revisionId: "revision_import_synthetic",
  });
  while (finalization.kind === "commit_progress") {
    finalization = await imports.commit({
      actor: actor(`request_synthetic_commit_${finalization.session.promotionCheckpoint}`),
      importId: session.importId,
      expectedVersion: finalization.session.version,
    });
  }
  assert.equal(finalization.revisionId, "revision_import_synthetic");
  const materialized = await revisions.materialize(
    MINDS.ordinary.spaceId,
    "revision_import_synthetic",
  );
  assert.equal(materialized.files.length, 1_025);
  assert.equal((await metadata.listRevisions(MINDS.ordinary.spaceId)).length, 2);
  for (const state of Object.values(objectConcurrency)) {
    assert.ok(state.peak > 1, "import object I/O should overlap");
    assert.ok(state.peak <= 8, "import object I/O must remain bounded");
  }
});

test("bounded validation persists sanitized failures and schedules cleanup without changing HEAD", async () => {
  const objects = new InMemoryObjectStore();
  const metadata = new InMemoryRevisionMetadataStore();
  const revisions = await seed(objects, metadata);
  authorize(metadata);
  const imports = service({ metadata, objects, revisions, clock: { now: () => T1 }, generatedIds: ids() });
  const bytes = ENCODER.encode("---\ntype: [invalid\n---\n\n# Invalid\n");
  const file = {
    path: "concepts/invalid.md",
    bytes,
    size: bytes.byteLength,
    sha256: await objects.calculateSha256(bytes),
  };
  const plan = await imports.plan({
    actor: actor(),
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_import_initial",
    idempotencyKey: "plan-validation-failure",
    files: [{ path: file.path, sha256: file.sha256, size: file.size }],
  });
  const started = await imports.start({
    actor: actor(),
    spaceId: MINDS.ordinary.spaceId,
    planId: plan.plan.planId,
    idempotencyKey: "session-validation-failure",
  });
  const staged = await imports.stageBatch({
    actor: actor(),
    importId: started.session.importId,
    checkpoint: 1,
    expectedVersion: started.session.version,
    files: [file],
  });
  await assert.rejects(
    imports.validate({
      actor: actor(),
      importId: started.session.importId,
      expectedVersion: staged.session.version,
    }),
    (error) => error instanceof MarkdownImportError &&
      error.code === "import_validation_failed" && error.failures.length > 0,
  );
  const failed = await imports.status(actor(), started.session.importId);
  assert.equal(failed.session.state, "validation_failed");
  assert.equal(failed.session.failures.length > 0, true);
  assert.equal(await metadata.readHead(MINDS.ordinary.spaceId), "revision_import_initial");
  const cleanup = await imports.collectExpired();
  assert.equal(cleanup.deleted, 1);
  assert.ok((await metadata.readMarkdownImportSession(started.session.importId)).cleanupCompletedAt);
});

test("bounded validation rejects a Markdown BundleFile reference missing from the exact revision", async () => {
  const objects = new InMemoryObjectStore();
  const metadata = new InMemoryRevisionMetadataStore();
  const revisions = await seed(objects, metadata);
  authorize(metadata);
  const imports = service({ metadata, objects, revisions, clock: { now: () => T1 }, generatedIds: ids() });
  const bytes = ENCODER.encode(
    "---\ntype: Reference\ntitle: Missing asset\n---\n\n![Missing](../assets/missing.png)\n",
  );
  const file = {
    path: "concepts/missing-asset.md",
    bytes,
    size: bytes.byteLength,
    sha256: await objects.calculateSha256(bytes),
  };
  const plan = await imports.plan({
    actor: actor("request_missing_asset_plan"),
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_import_initial",
    idempotencyKey: "plan-missing-bundle-file",
    files: [{ path: file.path, sha256: file.sha256, size: file.size }],
  });
  const started = await imports.start({
    actor: actor("request_missing_asset_start"),
    spaceId: MINDS.ordinary.spaceId,
    planId: plan.plan.planId,
    idempotencyKey: "session-missing-bundle-file",
  });
  const staged = await imports.stageBatch({
    actor: actor("request_missing_asset_stage"),
    importId: started.session.importId,
    checkpoint: 1,
    expectedVersion: started.session.version,
    files: [file],
  });
  await assert.rejects(
    imports.validate({
      actor: actor("request_missing_asset_validate"),
      importId: started.session.importId,
      expectedVersion: staged.session.version,
    }),
    (error) => error instanceof MarkdownImportError &&
      error.code === "import_validation_failed" &&
      error.failures.some((failure) => failure.code === "bundle_file_reference_missing"),
  );
  assert.equal(await metadata.readHead(MINDS.ordinary.spaceId), "revision_import_initial");
});

test("snapshot replacement preserves disjoint opaque paths and validates the full Markdown bundle", async () => {
  const objects = new InMemoryObjectStore();
  const metadata = new InMemoryRevisionMetadataStore();
  const { revisions, opaqueSources } = await seedOpaqueSnapshot(objects, metadata);
  authorize(metadata);
  const imports = service({
    metadata,
    objects,
    revisions,
    clock: { now: () => T1 },
    generatedIds: ids(),
    revisionId: "revision_import_preserves_opaque",
  });
  const sources = [
    {
      path: "index.md",
      bytes: ENCODER.encode(
        "---\nokf_version: \"0.2\"\n---\n\n# Imported\n\n![Asset](assets/existing.png)\n",
      ),
    },
    {
      path: "concepts/new.md",
      bytes: ENCODER.encode("---\ntype: Reference\ntitle: New\n---\n\n# New\n"),
    },
  ];
  const files = await Promise.all(sources.map(async (file) => ({
    ...file,
    size: file.bytes.byteLength,
    sha256: await objects.calculateSha256(file.bytes),
  })));
  const planned = await imports.plan({
    actor: actor("request_opaque_preservation_plan"),
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_import_opaque",
    idempotencyKey: "plan-opaque-preservation",
    files: files.map(({ path, sha256, size }) => ({ path, sha256, size })),
  });
  assert.deepEqual([
    planned.plan.additions,
    planned.plan.replacements,
    planned.plan.deletions,
    planned.plan.unchanged,
  ], [1, 1, 0, 0]);
  const started = await imports.start({
    actor: actor("request_opaque_preservation_start"),
    spaceId: MINDS.ordinary.spaceId,
    planId: planned.plan.planId,
    idempotencyKey: "session-opaque-preservation",
  });
  const staged = await imports.stageBatch({
    actor: actor("request_opaque_preservation_stage"),
    importId: started.session.importId,
    checkpoint: 1,
    expectedVersion: started.session.version,
    files,
  });
  const validated = await imports.validate({
    actor: actor("request_opaque_preservation_validate"),
    importId: started.session.importId,
    expectedVersion: staged.session.version,
  });
  const committed = await imports.commit({
    actor: actor("request_opaque_preservation_commit"),
    importId: started.session.importId,
    expectedVersion: validated.session.version,
  });
  assert.equal(committed.revisionId, "revision_import_preserves_opaque");
  const materialized = await revisions.materialize(
    MINDS.ordinary.spaceId,
    "revision_import_preserves_opaque",
  );
  assert.equal(materialized.envelope.manifest.format, REVISION_MANIFEST_FORMAT_V5);
  assert.deepEqual(materialized.files.map((file) => file.path), [
    "assets/existing.png",
    "concepts/new.md",
    "index.md",
  ]);
  const opaque = materialized.files.filter((file) => file.kind === "opaque");
  assert.deepEqual(opaque.map((file) => ({
    path: file.path,
    mediaType: file.mediaType,
    bytes: [...file.bytes],
  })), opaqueSources.map((file) => ({
    path: file.path,
    mediaType: file.mediaType,
    bytes: [...file.bytes],
  })));
  const fullValidation = validateOkfBundle(materialized.files
    .filter((file) => file.kind === "markdown")
    .map((file) => ({ path: file.path, text: file.text })));
  assert.equal(fullValidation.valid, true);
  assert.equal((await metadata.listRevisions(MINDS.ordinary.spaceId)).length, 3);
});

test("plan metadata is admitted against D1 hard capacity and unreferenced expiry is bounded", async () => {
  const objects = new InMemoryObjectStore();
  const metadata = new InMemoryRevisionMetadataStore();
  const revisions = await seed(objects, metadata);
  authorize(metadata);
  const files = await plannedFiles(objects);
  const generatedIds = ids();
  let now = T1;
  const clock = { now: () => now };
  const currentUsage = await metadata.readSiteCapacityUsage();
  let imports = service({
    metadata,
    objects,
    revisions,
    clock,
    generatedIds,
    capacityLimits: {
      ...DEFAULT_CAPACITY_LIMITS,
      siteD1MetadataBytes: currentUsage.d1MetadataBytes + 700,
    },
  });
  await assert.rejects(
    imports.plan({
      actor: actor(),
      spaceId: MINDS.ordinary.spaceId,
      expectedRevisionId: "revision_import_initial",
      idempotencyKey: "plan-d1-rejected",
      files: files.map(({ path, sha256, size }) => ({ path, sha256, size })),
    }),
    (error) => error instanceof MarkdownImportError &&
      error.code === "capacity_hard_limit" &&
      error.details?.spaceScope === "site" &&
      error.details?.metric === "d1_metadata_bytes",
  );
  assert.equal(await metadata.readMarkdownImportPlan("import-plan_1"), null);

  const held = await metadata.runCapacityTransaction((transaction) =>
    transaction.admitCapacityReservation({
      reservationId: "capacity:held-plan",
      requestedByPrincipalId: PRINCIPALS.owner.principalId,
      spaceId: MINDS.ordinary.spaceId,
      operation: "export",
      operationRef: "held-plan",
      baseRevisionId: null,
      idempotencyKey: "capacity-held-plan",
      requested: { physicalCanonicalBytes: 0, temporaryBytes: 0, d1MetadataBytes: 200 },
      bulk: true,
      heavy: true,
      createdAt: T1,
      expiresAt: "2026-08-22T19:10:00.000Z",
    }, DEFAULT_CAPACITY_LIMITS));
  assert.equal(held.kind, "admitted");
  const usageWithHold = await metadata.readSiteCapacityUsage();
  imports = service({
    metadata,
    objects,
    revisions,
    clock,
    generatedIds,
    capacityLimits: {
      ...DEFAULT_CAPACITY_LIMITS,
      siteD1MetadataBytes: usageWithHold.d1MetadataBytes + 512 + files.length * 160 + 100,
    },
  });
  await assert.rejects(
    imports.plan({
      actor: actor(),
      spaceId: MINDS.ordinary.spaceId,
      expectedRevisionId: "revision_import_initial",
      idempotencyKey: "plan-d1-reserved",
      files: files.map(({ path, sha256, size }) => ({ path, sha256, size })),
    }),
    (error) => error instanceof MarkdownImportError &&
      error.code === "capacity_hard_limit" &&
      error.details?.committed === usageWithHold.d1MetadataBytes &&
      error.details?.reserved === 200,
  );

  now = "2026-08-22T20:00:00.000Z";
  const accepted = await imports.plan({
    actor: actor(),
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_import_initial",
    idempotencyKey: "plan-after-reservation-expiry",
    files: files.map(({ path, sha256, size }) => ({ path, sha256, size })),
  });
  assert.equal(await metadata.readMarkdownImportPlan(accepted.plan.planId) !== null, true);
  assert.equal((await metadata.listCapacityReservationsForTest())[0].state, "cleanup_pending");
  now = "2026-08-22T22:00:00.000Z";
  const cleaned = await imports.collectExpired({ maxFiles: 10 });
  assert.equal(cleaned.expiredPlans, 1);
  assert.equal(await metadata.readMarkdownImportPlan(accepted.plan.planId), null);
});

test("expired session cleanup respects the 20-second deadline and resumes from durable file records", async () => {
  const objects = new InMemoryObjectStore();
  const metadata = new InMemoryRevisionMetadataStore();
  const revisions = await seed(objects, metadata);
  authorize(metadata);
  let cleanupMode = false;
  let cleanupClockReads = 0;
  const expiredAt = "2026-08-24T18:10:00.000Z";
  const clock = {
    now: () => {
      if (!cleanupMode) return T1;
      const value = new Date(Date.parse(expiredAt) + cleanupClockReads * 11_000).toISOString();
      cleanupClockReads += 1;
      return value;
    },
  };
  const imports = service({ metadata, objects, revisions, clock, generatedIds: ids() });
  const files = await plannedFiles(objects);
  const planned = await imports.plan({
    actor: actor("request_expiry_plan"),
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_import_initial",
    idempotencyKey: "plan-expiry-session",
    files: files.map(({ path, sha256, size }) => ({ path, sha256, size })),
  });
  const started = await imports.start({
    actor: actor("request_expiry_start"),
    spaceId: MINDS.ordinary.spaceId,
    planId: planned.plan.planId,
    idempotencyKey: "session-expiry-cleanup",
  });
  await imports.stageBatch({
    actor: actor("request_expiry_stage"),
    importId: started.session.importId,
    checkpoint: 1,
    expectedVersion: started.session.version,
    files,
  });
  cleanupMode = true;
  const first = await imports.collectExpired({ maxFiles: 10, maxDurationMs: 20_000 });
  assert.deepEqual({
    examined: first.examined,
    deleted: first.deleted,
    timedOut: first.timedOut,
  }, { examined: 1, deleted: 1, timedOut: true });
  const expired = await metadata.readMarkdownImportSession(started.session.importId);
  assert.equal(expired.state, "expired");
  assert.equal(expired.cleanupCompletedAt, null);
  assert.equal((await metadata.listMarkdownImportStagedFiles(started.session.importId)).length, 1);

  cleanupClockReads = 0;
  const resumed = await imports.collectExpired({ maxFiles: 10, maxDurationMs: 20_000 });
  assert.equal(resumed.deleted, 1);
  assert.equal(resumed.timedOut, true);
  assert.equal((await metadata.listMarkdownImportStagedFiles(started.session.importId)).length, 0);
  assert.equal((await metadata.readMarkdownImportSession(started.session.importId)).cleanupCompletedAt, null);

  cleanupClockReads = 0;
  const completed = await imports.collectExpired({ maxFiles: 10, maxDurationMs: 20_000 });
  assert.equal(completed.deleted, 0);
  assert.equal(completed.timedOut, false);
  assert.ok((await metadata.readMarkdownImportSession(started.session.importId)).cleanupCompletedAt);
  assert.equal(await metadata.readHead(MINDS.ordinary.spaceId), "revision_import_initial");
});

test("quota rejection, cancel and stale HEAD publish no partial imported revision", async () => {
  const objects = new InMemoryObjectStore();
  const metadata = new InMemoryRevisionMetadataStore();
  const revisions = await seed(objects, metadata);
  authorize(metadata);
  const generatedIds = ids();
  const files = await plannedFiles(objects);
  const clock = { now: () => T1 };
  const tinyLimits = {
    mindPhysicalCanonicalBytes: 64,
    principalPhysicalCanonicalBytes: 64,
    sitePhysicalCanonicalBytes: 64,
    siteTemporaryBytes: 64,
    siteD1MetadataBytes: 1_024,
    ordinaryCommitSoftGrowthBytes: 1,
    activeHeavyPerMind: 1,
    activeHeavyPerPrincipal: 2,
    activeHeavyPerSite: 8,
  };
  let imports = service({ metadata, objects, revisions, clock, generatedIds });
  const plan = await imports.plan({
    actor: actor(),
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_import_initial",
    idempotencyKey: "plan-quota",
    files: files.map(({ path, sha256, size }) => ({ path, sha256, size })),
  });
  imports = service({ metadata, objects, revisions, clock, generatedIds, capacityLimits: tinyLimits });
  await assert.rejects(
    imports.start({
      actor: actor(),
      spaceId: MINDS.ordinary.spaceId,
      planId: plan.plan.planId,
      idempotencyKey: "session-quota",
    }),
    (error) => error instanceof MarkdownImportError &&
      error.code === "capacity_hard_limit" &&
      error.details?.operation === "import" &&
      error.details?.state === "hard_limit",
  );
  assert.equal(await metadata.readHead(MINDS.ordinary.spaceId), "revision_import_initial");

  imports = service({ metadata, objects, revisions, clock, generatedIds });
  const acceptedPlan = await imports.plan({
    actor: actor(),
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_import_initial",
    idempotencyKey: "plan-cancel",
    files: files.map(({ path, sha256, size }) => ({ path, sha256, size })),
  });
  const started = await imports.start({
    actor: actor(),
    spaceId: MINDS.ordinary.spaceId,
    planId: acceptedPlan.plan.planId,
    idempotencyKey: "session-cancel",
  });
  const cancelStaged = await imports.stageBatch({
    actor: actor("request_cancel_stage"),
    importId: started.session.importId,
    checkpoint: 1,
    expectedVersion: started.session.version,
    files,
  });
  revoke(metadata);
  const canceled = await imports.cancel(
    actor("request_cancel_after_role_loss"),
    started.session.importId,
    cancelStaged.session.version,
  );
  assert.equal(canceled.kind, "canceled");
  assert.equal(await metadata.readHead(MINDS.ordinary.spaceId), "revision_import_initial");
  assert.equal((await imports.collectExpired()).deleted, 2);
  authorize(metadata);

  const conflictPlan = await imports.plan({
    actor: actor(),
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_import_initial",
    idempotencyKey: "plan-stale-head",
    files: files.map(({ path, sha256, size }) => ({ path, sha256, size })),
  });
  const conflictSession = await imports.start({
    actor: actor(),
    spaceId: MINDS.ordinary.spaceId,
    planId: conflictPlan.plan.planId,
    idempotencyKey: "session-stale-head",
  });
  const staged = await imports.stageBatch({
    actor: actor(),
    importId: conflictSession.session.importId,
    checkpoint: 1,
    expectedVersion: conflictSession.session.version,
    files,
  });
  const validated = await imports.validate({
    actor: actor(),
    importId: conflictSession.session.importId,
    expectedVersion: staged.session.version,
  });
  const competing = await revisions.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_import_initial",
    revisionId: "revision_competing",
    committedAt: T1,
    committedBy: { kind: "principal", principalId: PRINCIPALS.owner.principalId },
    summary: "Competing HEAD",
    files: [{
      path: "index.md",
      mediaType: MARKDOWN_MEDIA_TYPE,
      bytes: ENCODER.encode("---\nokf_version: \"0.2\"\n---\n\n# Competing\n"),
    }],
  });
  assert.equal(competing.kind, "committed");
  await assert.rejects(
    imports.commit({
      actor: actor(),
      importId: conflictSession.session.importId,
      expectedVersion: validated.session.version,
    }),
    (error) => error instanceof MarkdownImportError && error.code === "import_head_conflict",
  );
  const closed = await metadata.readMarkdownImportSession(conflictSession.session.importId);
  assert.equal(closed.state, "validation_failed");
  assert.deepEqual(closed.failures, [{ path: "(snapshot)", code: "import_head_conflict" }]);
  const conflictCleanup = await imports.collectExpired();
  assert.equal(conflictCleanup.deleted, 2);
  assert.ok((await metadata.readMarkdownImportSession(conflictSession.session.importId)).cleanupCompletedAt);
  assert.equal(await metadata.readHead(MINDS.ordinary.spaceId), "revision_competing");
  assert.deepEqual(
    (await metadata.listRevisions(MINDS.ordinary.spaceId)).map((revision) => revision.revision.revisionId),
    ["revision_import_initial", "revision_competing"],
  );
});
