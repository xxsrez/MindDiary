import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  CanonicalRevisionCoordinator,
  DEFAULT_CAPACITY_LIMITS,
  MarkdownImportError,
  MarkdownImportService,
} from "@mind-diary/application-content";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";
import { CAPABILITIES, MARKDOWN_MEDIA_TYPE, version } from "@mind-diary/domain";
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

async function seed(objects, metadata) {
  const revisions = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  const committed = await revisions.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: null,
    revisionId: "revision_import_initial",
    committedAt: T0,
    committedBy: { kind: "principal", principalId: PRINCIPALS.owner.principalId },
    summary: "Initial import fixture",
    files: [{
      path: "index.md",
      mediaType: MARKDOWN_MEDIA_TYPE,
      bytes: ENCODER.encode("---\nokf_version: \"0.2\"\n---\n\n# Before\n"),
    }],
  });
  assert.equal(committed.kind, "committed");
  return revisions;
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
  const materialized = await revisions.materialize(
    MINDS.ordinary.spaceId,
    "revision_import_committed",
  );
  assert.deepEqual(materialized.files.map((file) => file.path), [
    "concepts/alpha.md",
    "index.md",
  ]);
  assert.equal((await imports.status(actor(), started.session.importId)).session.state, "committed");

  const cleaned = await imports.collectExpired();
  assert.equal(cleaned.deleted, 2);
  assert.equal((await metadata.listMarkdownImportStagedFiles(started.session.importId)).length, 0);
  assert.ok((await metadata.readMarkdownImportSession(started.session.importId)).cleanupCompletedAt);
});

test("Brain-scale synthetic Markdown snapshot crosses bounded batches and publishes one revision", async () => {
  const objects = new InMemoryObjectStore();
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
  assert.equal(validation.session.validationCheckpoint, 100);
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
  assert.equal(finalization.session.promotionCheckpoint, 100);
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
    (error) => error instanceof MarkdownImportError && error.code === "capacity_hard_limit",
  );
  assert.equal(await metadata.readMarkdownImportPlan("import-plan_1"), null);

  imports = service({ metadata, objects, revisions, clock, generatedIds });
  const accepted = await imports.plan({
    actor: actor(),
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: "revision_import_initial",
    idempotencyKey: "plan-expiry-cleanup",
    files: files.map(({ path, sha256, size }) => ({ path, sha256, size })),
  });
  assert.equal(await metadata.readMarkdownImportPlan(accepted.plan.planId) !== null, true);
  now = "2026-08-22T20:00:00.000Z";
  const cleaned = await imports.collectExpired({ maxFiles: 10 });
  assert.equal(cleaned.expiredPlans, 1);
  assert.equal(await metadata.readMarkdownImportPlan(accepted.plan.planId), null);
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
    (error) => error instanceof MarkdownImportError && error.code === "capacity_hard_limit",
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
  const canceled = await imports.cancel(actor(), started.session.importId, started.session.version);
  assert.equal(canceled.kind, "canceled");
  assert.equal(await metadata.readHead(MINDS.ordinary.spaceId), "revision_import_initial");

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
  assert.equal(await metadata.readHead(MINDS.ordinary.spaceId), "revision_competing");
  assert.deepEqual(
    (await metadata.listRevisions(MINDS.ordinary.spaceId)).map((revision) => revision.revision.revisionId),
    ["revision_import_initial", "revision_competing"],
  );
});
