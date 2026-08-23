import assert from "node:assert/strict";
import test from "node:test";
import { createBackgroundServiceActor } from "@mind-diary/adapter-background";
import { InMemoryAuditSink } from "@mind-diary/adapter-audit-memory";
import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import { InMemoryExactRevisionSearchIndex } from "@mind-diary/adapter-search-memory";
import { createWebCryptoExportDownloadSecretCrypto } from "@mind-diary/adapter-security-webcrypto";
import {
  ExportJobExpiryHandler,
  ExportJobHandler,
  BoundedObjectCleanupHandler,
  SpaceTargetRecordPurgeService,
} from "@mind-diary/application-background";
import {
  CanonicalRevisionCoordinator,
  DeterministicOkfExportService,
  ExportJobApplicationService,
} from "@mind-diary/application-content";
import {
  CapabilityAuthorizer,
  CurrentAccessBackgroundAuthorizer,
} from "@mind-diary/application-ports";
import { CAPABILITIES, version } from "@mind-diary/domain";
import {
  CANONICAL_REVISION_FILES,
  FIXED_NOW,
  MINDS,
  PRINCIPALS,
  REVISION_AUTHORS,
  REVISIONS,
  createFixtureClock,
} from "@mind-diary/test-fixtures";

const TOKEN_ID = "token_export_jobs";
const TOKEN_EXPIRY = "2026-11-03T12:00:00.000Z";
const EXPORT_DOWNLOAD_TEST_KEY = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 31,
);

function at(offsetMs) {
  return new Date(Date.parse(FIXED_NOW) + offsetMs).toISOString();
}

function principalActor(principalId = PRINCIPALS.editor.principalId) {
  return {
    kind: "registered_principal",
    principalId,
    authentication: {
      kind: "mcp_token",
      tokenId: TOKEN_ID,
      effectiveScopes: ["content:read", "content:write"],
    },
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_start_export",
    occurredAtUtc: FIXED_NOW,
  };
}

function currentState(actor, overrides = {}) {
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
      role: "reader",
      state: "active",
      version: version(1),
    },
    token: {
      tokenId: TOKEN_ID,
      principalId: actor.principalId,
      state: "active",
      scopes: ["content:read", "content:write"],
      version: version(1),
      expiresAt: TOKEN_EXPIRY,
    },
    ...overrides,
  };
}

function workerActor(occurredAtUtc = FIXED_NOW, capabilities = ["content:export"]) {
  return createBackgroundServiceActor({
    serviceId: "mind-diary-export-worker",
    requestId: "request_export_worker",
    occurredAtUtc,
    deploymentCapabilities: capabilities,
  });
}

async function harness(options = {}) {
  const clock = createFixtureClock(FIXED_NOW);
  const objects = new InMemoryObjectStore();
  const metadata = new InMemoryRevisionMetadataStore();
  const revisions = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  await revisions.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: null,
    revisionId: REVISIONS.initial.revisionId,
    committedAt: REVISIONS.initial.committedAt,
    committedBy: REVISION_AUTHORS.active,
    summary: "Seed durable export jobs",
    files: CANONICAL_REVISION_FILES,
  });
  const actor = principalActor();
  const state = currentState(actor);
  metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: actor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      tokenId: TOKEN_ID,
    },
    state,
  );
  metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: actor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      tokenId: null,
    },
    { ...state, token: null },
  );
  const authorizer = new CapabilityAuthorizer(metadata);
  const backgroundAuthorizer = new CurrentAccessBackgroundAuthorizer(metadata);
  const downloadSecretCrypto =
    options.downloadSecretCrypto ??
    await createWebCryptoExportDownloadSecretCrypto({
      verifierKey: EXPORT_DOWNLOAD_TEST_KEY,
    });
  let nextJob = 0;
  const ids = options.jobIds ?? ["export_job_1", "export_job_2", "export_job_3"];
  const application = () => new ExportJobApplicationService({
    authorizer,
    backgroundAuthorizer,
    metadata,
    digest: objects,
    archives: objects,
    clock,
    retentionMs: options.retentionMs ?? 60_000,
    jobIds: { nextExportJobId: () => ids[nextJob++] },
    downloadSecretCrypto,
    downloadUrlBase: "https://downloads.invalid/export-grants",
    ...(options.capacityLimits === undefined
      ? {}
      : { capacityLimits: options.capacityLimits }),
  });
  const builder = new DeterministicOkfExportService({
    materializer: revisions,
    digest: objects,
  });
  const worker = (customBuilder = builder) => new ExportJobHandler({
    jobs: metadata,
    backgroundAuthorizer,
    builder: customBuilder,
    archives: objects,
    clock,
    retryDelayMs: 1_000,
    claimLeaseMs: 10_000,
  });
  return {
    actor,
    clock,
    objects,
    metadata,
    revisions,
    application,
    builder,
    worker,
  };
}

test("export capacity admission is atomic with job creation", async () => {
  const env = await harness({
    capacityLimits: {
      mindPhysicalCanonicalBytes: 2_147_483_648,
      principalPhysicalCanonicalBytes: 8_589_934_592,
      sitePhysicalCanonicalBytes: 34_359_738_368,
      siteTemporaryBytes: 1,
      siteD1MetadataBytes: 536_870_912,
      ordinaryCommitSoftGrowthBytes: 4_194_304,
      activeHeavyPerMind: 1,
      activeHeavyPerPrincipal: 2,
      activeHeavyPerSite: 8,
    },
  });
  const result = await env.application().start(startRequest(
    env.actor,
    "export-capacity-hard-limit",
  ));
  assert.equal(result.kind, "invalid");
  assert.equal(result.code, "capacity_hard_limit");
  assert.equal((await env.metadata.listExportJobsForTest()).length, 0);
  assert.equal((await env.metadata.listCapacityReservationsForTest()).length, 0);
});

function startRequest(actor, key = "export-idempotency-1", selector = { kind: "head" }) {
  return {
    actor,
    spaceId: MINDS.ordinary.spaceId,
    revisionSelector: selector,
    idempotencyKey: key,
  };
}

test("start_export atomically fixes principal, Space, exact revision and one durable idempotent job", async () => {
  const env = await harness({ jobIds: ["export_job_a", "export_job_b"] });
  const firstService = env.application();
  const first = await firstService.start(startRequest(env.actor));
  assert.equal(first.kind, "started");
  assert.equal(first.replayed, false);
  assert.equal(first.job.status, "queued");
  assert.equal(first.job.revisionId, REVISIONS.initial.revisionId);

  const [stored] = await env.metadata.listExportJobsForTest();
  assert.equal(stored.requestedByPrincipalId, env.actor.principalId);
  assert.equal(stored.spaceId, MINDS.ordinary.spaceId);
  assert.equal(stored.revisionId, REVISIONS.initial.revisionId);
  assert.equal(stored.idempotencyKey, "export-idempotency-1");
  assert.equal(stored.state, "queued");

  await env.revisions.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    revisionId: REVISIONS.next.revisionId,
    committedAt: REVISIONS.next.committedAt,
    committedBy: REVISION_AUTHORS.active,
    summary: "Move HEAD after export selection",
    files: CANONICAL_REVISION_FILES,
  });

  // A reconstructed application instance replays from the shared store.
  const replay = await env.application().start(startRequest(env.actor));
  assert.equal(replay.kind, "started");
  assert.equal(replay.replayed, true);
  assert.equal(replay.job.jobId, first.job.jobId);
  assert.equal(replay.job.revisionId, REVISIONS.initial.revisionId);
  assert.equal((await env.metadata.listExportJobsForTest()).length, 1);

  const conflict = await env.application().start(
    startRequest(env.actor, "export-idempotency-1", {
      kind: "revision",
      revisionId: REVISIONS.initial.revisionId,
    }),
  );
  assert.deepEqual(conflict, { kind: "idempotency_conflict" });
  assert.equal((await env.metadata.listExportJobsForTest()).length, 1);
});

test("concurrent start retries produce one job and selector failures leave no partial state", async () => {
  const env = await harness({ jobIds: ["export_race_a", "export_race_b"] });
  const service = env.application();
  const [left, right] = await Promise.all([
    service.start(startRequest(env.actor, "same-concurrent-key")),
    service.start(startRequest(env.actor, "same-concurrent-key")),
  ]);
  assert.equal(left.kind, "started");
  assert.equal(right.kind, "started");
  assert.equal(left.job.jobId, right.job.jobId);
  assert.equal([left.replayed, right.replayed].filter(Boolean).length, 1);
  assert.equal((await env.metadata.listExportJobsForTest()).length, 1);

  const missing = await service.start(
    startRequest(env.actor, "missing-revision-key", {
      kind: "revision",
      revisionId: "revision_missing",
    }),
  );
  assert.deepEqual(missing, { kind: "revision_not_found" });
  assert.equal((await env.metadata.listExportJobsForTest()).length, 1);
  assert.equal((await env.metadata.listIdempotencyRecordsForTest()).length, 1);

  const invalid = await service.start({
    ...startRequest(env.actor, "invalid-selector-key"),
    revisionSelector: { kind: "revision", revisionId: "" },
  });
  assert.equal(invalid.kind, "invalid");
  const outsider = principalActor(PRINCIPALS.outsider.principalId);
  env.metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: outsider.principalId,
      spaceId: MINDS.ordinary.spaceId,
      tokenId: TOKEN_ID,
    },
    currentState(outsider, { membership: null }),
  );
  const denied = await service.start(startRequest(outsider, "denied-start-key"));
  assert.equal(denied.kind, "denied");
  assert.equal((await env.metadata.listExportJobsForTest()).length, 1);
  assert.equal((await env.metadata.listIdempotencyRecordsForTest()).length, 1);
});

test("reconstructed worker builds the exact archive into object storage and status stays safe", async () => {
  const env = await harness();
  const started = await env.application().start(startRequest(env.actor));
  assert.equal(started.kind, "started");

  const handled = await env.worker().handle({
    actor: workerActor(),
    jobId: started.job.jobId,
  });
  assert.deepEqual(handled, { kind: "completed" });

  const status = await env.application().getStatus({
    actor: env.actor,
    jobId: started.job.jobId,
  });
  assert.equal(status.kind, "found");
  assert.equal(status.job.status, "succeeded");
  assert.equal(status.job.revisionId, REVISIONS.initial.revisionId);
  assert.equal(status.job.archive.archiveFormat, "MD-OKF-ZIP-1");
  assert.equal(status.job.archive.mediaType, "application/zip");
  assert.equal(status.job.archive.size > 0, true);
  assert.match(status.download.url, /^https:\/\/downloads\.invalid\/export-grants\/mdg_v1_/u);
  assert.equal(status.download.expiresAt, at(60_000));
  assert.doesNotMatch(
    JSON.stringify(status.job),
    /requestedByPrincipalId|idempotencyKey|objectKey|download_url|downloadUrl|bytes/iu,
  );

  const durable = await env.metadata.readExportJob(started.job.jobId);
  assert.ok(durable.archive.objectKey);
  const archiveBytes = await env.objects.readExportArchive(durable.archive.objectKey);
  assert.equal(archiveBytes.byteLength, status.job.archive.size);
  assert.equal((await env.objects.listExportArchivesForTest()).length, 1);
});

test("explicit bundle export profile is durable and reaches the reconstructed worker", async () => {
  const env = await harness();
  const started = await env.application().start({
    ...startRequest(env.actor, "bundle-export-profile"),
    profile: "MD-BUNDLE-ZIP-1",
  });
  assert.equal(started.kind, "started");
  assert.equal(
    (await env.metadata.readExportJob(started.job.jobId)).profile,
    "MD-BUNDLE-ZIP-1",
  );
  let observedRequest = null;
  const observingBuilder = {
    exportExactRevision: async (request) => {
      observedRequest = request;
      return env.builder.exportExactRevision(request);
    },
  };
  assert.deepEqual(
    await env.worker(observingBuilder).handle({
      actor: workerActor(),
      jobId: started.job.jobId,
    }),
    { kind: "completed" },
  );
  assert.equal(observedRequest.profile, "MD-BUNDLE-ZIP-1");
  const status = await env.application().getStatus({
    actor: env.actor,
    jobId: started.job.jobId,
  });
  assert.equal(status.kind, "found");
  assert.equal(status.job.archive.archiveFormat, "MD-BUNDLE-ZIP-1");
  assert.equal(status.job.archive.filename, "mind-diary-bundle.zip");
});

test("job ID is only a locator: missing current access hides status and blocks the worker", async () => {
  const env = await harness();
  const started = await env.application().start(startRequest(env.actor));
  assert.equal(started.kind, "started");

  const outsider = principalActor(PRINCIPALS.outsider.principalId);
  env.metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: outsider.principalId,
      spaceId: MINDS.ordinary.spaceId,
      tokenId: TOKEN_ID,
    },
    currentState(outsider, { membership: null }),
  );
  assert.deepEqual(
    await env.application().getStatus({ actor: outsider, jobId: started.job.jobId }),
    { kind: "not_found" },
  );

  env.metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: env.actor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      tokenId: null,
    },
    currentState(env.actor, { membership: null, token: null }),
  );
  const denied = await env.worker().handle({
    actor: workerActor(),
    jobId: started.job.jobId,
  });
  assert.deepEqual(denied, {
    kind: "failed",
    failureCode: "export_access_denied",
  });
  const durable = await env.metadata.readExportJob(started.job.jobId);
  assert.equal(durable.state, "failed");
  assert.equal(durable.lastFailureCode, "export_access_denied");
  assert.equal((await env.objects.listExportArchivesForTest()).length, 0);
});

test("worker reauthorizes after build, then a reconstructed retry succeeds without duplicate archives", async () => {
  const env = await harness();
  const started = await env.application().start(startRequest(env.actor));
  assert.equal(started.kind, "started");
  let builds = 0;
  const revokeDuringBuild = {
    exportExactRevision: async (request) => {
      builds += 1;
      const built = await env.builder.exportExactRevision(request);
      env.metadata.setCurrentAuthorizationStateForTest(
        {
          principalId: env.actor.principalId,
          spaceId: MINDS.ordinary.spaceId,
          tokenId: null,
        },
        currentState(env.actor, { membership: null, token: null }),
      );
      return built;
    },
  };
  const first = await env.worker(revokeDuringBuild).handle({
    actor: workerActor(),
    jobId: started.job.jobId,
  });
  assert.deepEqual(first, {
    kind: "failed",
    failureCode: "export_access_denied",
  });
  assert.equal((await env.objects.listExportArchivesForTest()).length, 0);

  env.metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: env.actor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      tokenId: null,
    },
    currentState(env.actor, { token: null }),
  );
  env.clock.set(at(1_000));
  const retry = await env.worker().handle({
    actor: workerActor(at(1_000)),
    jobId: started.job.jobId,
  });
  assert.deepEqual(retry, { kind: "completed" });
  const durable = await env.metadata.readExportJob(started.job.jobId);
  assert.equal(durable.attempts, 2);
  assert.equal(durable.state, "succeeded");
  assert.equal((await env.objects.listExportArchivesForTest()).length, 1);
  assert.equal(builds, 1);
});

test("claim fencing rejects stale completion and a transient failure is durably retryable", async () => {
  const env = await harness();
  const started = await env.application().start(startRequest(env.actor));
  assert.equal(started.kind, "started");
  const firstClaim = await env.metadata.claimExportJob(
    started.job.jobId,
    FIXED_NOW,
    at(2_000),
  );
  assert.equal(firstClaim.kind, "claimed");
  assert.deepEqual(await env.metadata.listRecoverableExportJobs(at(1_000), 10), []);
  assert.deepEqual(
    (await env.metadata.listRecoverableExportJobs(at(2_000), 10)).map((job) => job.jobId),
    [started.job.jobId],
  );
  assert.deepEqual(
    await env.metadata.claimExportJob(started.job.jobId, at(1_000), at(3_000)),
    { kind: "not_available" },
  );
  const secondClaim = await env.metadata.claimExportJob(
    started.job.jobId,
    at(2_000),
    at(4_000),
  );
  assert.equal(secondClaim.kind, "claimed");
  assert.equal(secondClaim.job.version > firstClaim.job.version, true);
  const fakeArchive = {
    objectKey: "exports/stale",
    archiveFormat: "MD-OKF-ZIP-1",
    mediaType: "application/zip",
    filename: "mind-diary-okf-bundle.zip",
    contentDisposition: 'attachment; filename="mind-diary-okf-bundle.zip"',
    sha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    size: 1,
  };
  assert.equal(
    await env.metadata.completeExportJob(
      started.job.jobId,
      firstClaim.job.version,
      fakeArchive,
      at(2_500),
    ),
    false,
  );
  assert.equal(
    await env.metadata.failExportJob(
      started.job.jobId,
      secondClaim.job.version,
      "transient_storage_failure",
      at(2_500),
      at(3_000),
    ),
    true,
  );
  assert.equal((await env.metadata.readExportJob(started.job.jobId)).state, "failed");
  assert.deepEqual(await env.metadata.listRecoverableExportJobs(at(2_999), 10), []);
  assert.deepEqual(
    (await env.metadata.listRecoverableExportJobs(at(3_000), 10)).map((job) => job.jobId),
    [started.job.jobId],
  );

  env.clock.set(at(3_000));
  const retried = await env.worker().handle({
    actor: workerActor(at(3_000)),
    jobId: started.job.jobId,
  });
  assert.deepEqual(retried, { kind: "completed" });
  assert.equal((await env.metadata.readExportJob(started.job.jobId)).attempts, 3);
});

test("expiry and cleanup are durable, observable and idempotent", async () => {
  const env = await harness({ retentionMs: 5_000 });
  const started = await env.application().start(startRequest(env.actor));
  assert.equal(started.kind, "started");
  assert.deepEqual(
    await env.worker().handle({ actor: workerActor(), jobId: started.job.jobId }),
    { kind: "completed" },
  );
  assert.equal((await env.objects.listExportArchivesForTest()).length, 1);

  env.clock.set(at(5_000));
  const expiry = new ExportJobExpiryHandler({
    jobs: env.metadata,
    archives: env.objects,
    clock: env.clock,
  });
  assert.deepEqual(
    await expiry.handle({ actor: workerActor(at(5_000)), jobId: started.job.jobId }),
    { kind: "not_available" },
  );
  const cleanup = await new BoundedObjectCleanupHandler({
    objects: env.objects,
    checkpoints: env.metadata,
    reachability: env.metadata,
    staging: env.metadata,
    exports: env.metadata,
    clock: env.clock,
    monotonicNow: () => 0,
  }).handle({
    actor: workerActor(at(5_000)),
    createdBefore: FIXED_NOW,
    maxObjects: 100,
    maxDurationMs: 1_000,
  });
  assert.equal(cleanup.deleted, 1);
  const status = await env.application().getStatus({
    actor: env.actor,
    jobId: started.job.jobId,
  });
  assert.equal(status.kind, "found");
  assert.equal(status.job.status, "expired");
  assert.equal(status.job.archive, null);
  assert.equal(status.download, null);
  assert.equal(status.job.archiveCleanedAt, at(5_000));
  assert.equal((await env.objects.listExportArchivesForTest()).length, 0);

  const reconstructedExpiry = new ExportJobExpiryHandler({
    jobs: env.metadata,
    archives: env.objects,
    clock: env.clock,
  });
  assert.deepEqual(
    await reconstructedExpiry.handle({
      actor: workerActor(at(5_000)),
      jobId: started.job.jobId,
    }),
    { kind: "already_completed" },
  );
  assert.equal((await env.objects.listExportArchivesForTest()).length, 0);
});

test("whole-Mind target purge removes durable export records and stored archives", async () => {
  const env = await harness();
  const started = await env.application().start(startRequest(env.actor));
  assert.equal(started.kind, "started");
  assert.deepEqual(
    await env.worker().handle({ actor: workerActor(), jobId: started.job.jobId }),
    { kind: "completed" },
  );
  const purged = await new SpaceTargetRecordPurgeService({
    metadata: env.metadata,
    index: new InMemoryExactRevisionSearchIndex(),
    audit: new InMemoryAuditSink(),
    exportArchives: env.objects,
  }).purge({ actor: workerActor(), spaceId: MINDS.ordinary.spaceId });
  assert.equal(purged.backgroundJobs, 1);
  assert.equal(purged.idempotencyRecords, 1);
  assert.equal(purged.exportArchives, 1);
  assert.equal(await env.metadata.readExportJob(started.job.jobId), null);
  assert.equal((await env.objects.listExportArchivesForTest()).length, 0);
});
