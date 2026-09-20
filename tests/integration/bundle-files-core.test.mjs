import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import { InMemoryExactRevisionSearchIndex } from "@mind-diary/adapter-search-memory";
import { createSitesMetadataStore } from "@mind-diary/adapter-metadata-sites";
import { createSitesObjectStore } from "@mind-diary/adapter-object-sites";
import { createWebCryptoExportDownloadSecretCrypto } from "@mind-diary/adapter-security-webcrypto";
import {
  BundleFileDownloadService,
  BundleFileStagingService,
  CanonicalRevisionCoordinator,
  ChangesetCommitService,
  DeterministicOkfExportService,
  GeneratedArtifactIngressService,
  MindBindingContentAuthorizer,
} from "@mind-diary/application-content";
import { RevisionIndexJobHandler } from "@mind-diary/application-background";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";
import {
  CAPABILITIES,
  REVISION_MANIFEST_FORMAT_V1,
  REVISION_MANIFEST_FORMAT_V2,
  REVISION_MANIFEST_FORMAT_V3,
  REVISION_MANIFEST_FORMAT_V4,
  bindingVersion,
  createCanonicalRevisionEnvelope,
  createRevisionManifest,
  serializeRevisionManifest,
  version,
  verifiedSpaceHost,
} from "@mind-diary/domain";
import {
  CANONICAL_REVISION_FILES,
  FIXED_NOW,
  MINDS,
  PRINCIPALS,
  REVISION_AUTHORS,
  REVISIONS,
} from "@mind-diary/test-fixtures";
import { FakeD1Database, FakeR2Bucket } from "../../scripts/lib/fake-sites-storage.mjs";

const LATER = "2026-08-05T13:00:00.000Z";
const OBJECT_REFRESH = "2026-08-07T13:00:00.000Z";
const EXPIRY = "2026-11-05T12:00:00.000Z";
const TOKEN_ID = "token_bundle_file";
const BINDING_OWNER_ID = "binding_owner_bundle_file";
const WRITE_BINDING_ID = "write_binding_bundle_file";
const MOUNT_GENERATION_ID = "usage_generation_bundle_file";
const HASH = `sha256:${"a".repeat(64)}`;
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);
const PNG_REPLACEMENT = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0xf4, 0x22, 0x7f, 0x8a,
]);
const MALFORMED_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x08, 0x06, 0x00, 0x00, 0x00, 0xf0, 0xd7, 0xaf, 0xb7,
]);
const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01,
  0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
]);
const GIF = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
]);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
  0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x9d,
  0x01, 0x2a, 0x01, 0x00, 0x01, 0x00,
]);
const PDF = new TextEncoder().encode("%PDF-1.7\n");
const ZIP = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);

async function streamBytes(body) {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function readStoredZipEntries(bytes) {
  const entries = new Map();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 30 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    assert.equal(view.getUint16(offset + 8, true), 0, "fixture expects stored ZIP entries");
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const path = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    entries.set(path, bytes.slice(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return entries;
}

function streamingProbeObjectStore() {
  const evidence = { writes: 0, maxChunkBytes: 0, completedBytes: 0, aborted: false };
  return {
    evidence,
    calculateSha256: async (bytes) =>
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    beginStagedBundleFileUpload: async (request) => {
      let size = 0;
      let closed = false;
      return {
        write: async (chunk) => {
          assert.equal(closed, false);
          assert.ok(size + chunk.byteLength <= request.maxBytes);
          size += chunk.byteLength;
          evidence.writes += 1;
          evidence.maxChunkBytes = Math.max(evidence.maxChunkBytes, chunk.byteLength);
        },
        complete: async ({ size: expectedSize }) => {
          assert.equal(expectedSize, size);
          closed = true;
          evidence.completedBytes = size;
          return {
            stagedFileId: request.stagedFileId,
            bindingOwnerId: request.bindingOwnerId,
            spaceId: request.spaceId,
            size,
            createdAt: request.createdAt,
          };
        },
        abort: async () => {
          closed = true;
          evidence.aborted = true;
        },
      };
    },
    deleteStagedBundleFile: async () => true,
  };
}

async function* repeatedChunks(count, chunkBytes, extra = 0) {
  const chunk = new Uint8Array(chunkBytes);
  for (let index = 0; index < count; index += 1) yield chunk;
  if (extra > 0) yield new Uint8Array(extra);
}

function actor() {
  return {
    kind: "registered_principal",
    principalId: PRINCIPALS.editor.principalId,
    authentication: {
      kind: "mcp_token",
      tokenId: TOKEN_ID,
      bindingOwnerId: BINDING_OWNER_ID,
      effectiveScopes: ["content:read", "content:write"],
    },
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_bundle_file",
    occurredAtUtc: FIXED_NOW,
  };
}

function authorizationState() {
  return {
    principal: { principalId: PRINCIPALS.editor.principalId, state: "active" },
    space: {
      spaceId: MINDS.ordinary.spaceId,
      state: "active",
      visibility: "private",
      accessVersion: version(1),
    },
    membership: {
      principalId: PRINCIPALS.editor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      role: "editor",
      state: "active",
      version: version(1),
    },
    token: {
      tokenId: TOKEN_ID,
      principalId: PRINCIPALS.editor.principalId,
      state: "active",
      scopes: ["content:read", "content:write"],
      version: version(1),
      expiresAt: EXPIRY,
    },
  };
}

async function bindWrite(metadata) {
  const result = await metadata.runMindBindingTransaction((transaction) =>
    transaction.applyWriteMindBinding({
      bindingOwnerId: BINDING_OWNER_ID,
      principalId: PRINCIPALS.editor.principalId,
      action: "bind",
      spaceId: MINDS.ordinary.spaceId,
      writeBindingId: WRITE_BINDING_ID,
      expectedBindingVersion: bindingVersion(0),
      idempotencyKey: "bind-bundle-file",
      canonicalRequestHash: HASH,
      requestId: "request_bind_bundle_file",
      auditEventId: "audit_bind_bundle_file",
      auditOutboxMessageId: "outbox_bind_bundle_file",
      occurredAt: FIXED_NOW,
    }),
  );
  assert.equal(result.kind, "applied");
}

function principalMountedMetadata(metadata) {
  const mountedState = Object.freeze({
    principalId: PRINCIPALS.editor.principalId,
    entries: Object.freeze([Object.freeze({
      principalId: PRINCIPALS.editor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      routingProfile: "description_based",
      usageMode: "read_write",
      writeGeneration: Object.freeze({
        principalId: PRINCIPALS.editor.principalId,
        spaceId: MINDS.ordinary.spaceId,
        generationId: MOUNT_GENERATION_ID,
      }),
    })]),
  });
  const readUsage = async (principalId) =>
    principalId === PRINCIPALS.editor.principalId ? mountedState : null;
  const validatePin = async (pin) =>
    pin.principalId === PRINCIPALS.editor.principalId &&
    pin.spaceId === MINDS.ordinary.spaceId &&
    pin.generationId === MOUNT_GENERATION_ID;
  const wrapTransaction = (transaction) => Object.freeze({
    ...transaction,
    readPrincipalMindUsage: readUsage,
    validatePrincipalMindUsageWritePin: validatePin,
  });
  return new Proxy(metadata, {
    get(target, property) {
      if (property === "readPrincipalMindUsage") return readUsage;
      if (property === "validatePrincipalMindUsageWritePin") return validatePin;
      if (
        property === "runBundleFileStagingTransaction" ||
        property === "runContentCommitTransaction"
      ) {
        return (operation) => target[property]((transaction) =>
          operation(wrapTransaction(transaction)));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function harness({ capacityLimits } = {}) {
  const metadata = new InMemoryRevisionMetadataStore();
  const objects = new InMemoryObjectStore();
  const currentActor = actor();
  metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: currentActor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      tokenId: TOKEN_ID,
    },
    authorizationState(),
  );
  await bindWrite(metadata);
  const mountedMetadata = principalMountedMetadata(metadata);
  const revisions = new CanonicalRevisionCoordinator({ objects, revisions: mountedMetadata });
  await revisions.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: null,
    revisionId: REVISIONS.initial.revisionId,
    committedAt: REVISIONS.initial.committedAt,
    committedBy: REVISION_AUTHORS.active,
    summary: "BundleFile fixture",
    files: CANONICAL_REVISION_FILES,
  });
  const authorizer = new CapabilityAuthorizer(metadata);
  let stagedIds = 0;
  const staging = new BundleFileStagingService({
    authorizer,
    metadata: mountedMetadata,
    objects,
    clock: { now: () => LATER },
    ids: { nextStagedBundleFileId: () => `staged_bundle_${++stagedIds}` },
    ...(capacityLimits === undefined ? {} : { capacityLimits }),
  });
  return {
    metadata: mountedMetadata,
    rawMetadata: metadata,
    objects,
    revisions,
    authorizer,
    staging,
    currentActor,
  };
}

test("staging capacity admission rejects before any temporary object write", async () => {
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
  const result = await env.staging.stage({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "capacity.png",
    claimedMediaType: "image/png",
    bytes: PNG,
    idempotencyKey: "capacity-stage",
  });
  assert.deepEqual(result, { kind: "invalid", code: "capacity_hard_limit" });
  assert.equal(await env.objects.getStagedBundleFile("staged_bundle_1"), null);
});

test("a staged file for Mind A cannot be consumed by Mind B", async () => {
  const env = await harness();
  const staged = await env.staging.stage({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    displayFilename: "mind-a.bin",
    claimedMediaType: "application/octet-stream",
    bytes: Uint8Array.of(1, 2, 3),
    idempotencyKey: "stage-for-mind-a",
  });
  assert.equal(staged.kind, "staged");
  const crossMind = await env.metadata.runContentCommitTransaction((transaction) =>
    transaction.consumeStagedBundleFiles({
      stagedFileIds: [staged.record.stagedFileId],
      principalId: env.currentActor.principalId,
      principalMindUsageGenerationId: MOUNT_GENERATION_ID,
      spaceId: "space_other_writable_mind",
      consumedAt: LATER,
    }));
  assert.deepEqual(crossMind, {
    kind: "binding_mismatch",
    stagedFileId: staged.record.stagedFileId,
  });
  assert.equal(
    (await env.metadata.readStagedBundleFile(staged.record.stagedFileId))?.state,
    "verified",
  );
});

test("manifest v1 stays byte-stable while new mixed manifests use discriminated v2", () => {
  const markdown = {
    path: "index.md",
    sha256: HASH,
    mediaType: "text/markdown; charset=utf-8",
    size: 1,
  };
  const v1 = createRevisionManifest([markdown], REVISION_MANIFEST_FORMAT_V1);
  assert.equal(v1.format, REVISION_MANIFEST_FORMAT_V1);
  assert.doesNotMatch(serializeRevisionManifest(v1), /"kind"/u);
  const v2 = createRevisionManifest([
    markdown,
    {
      kind: "opaque",
      path: "assets/diagram.png",
      sha256: HASH,
      mediaType: "image/png",
      size: 10,
    },
  ]);
  assert.equal(v2.format, REVISION_MANIFEST_FORMAT_V2);
  assert.match(serializeRevisionManifest(v2), /"kind":"opaque"/u);
});

test("staging contains spoofed types and atomically consumes a binding-pinned ref", async () => {
  const env = await harness();
  const spoofed = await env.staging.stage({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "spoofed.png",
    claimedMediaType: "image/png",
    bytes: new TextEncoder().encode("<svg><script/></svg>"),
    idempotencyKey: "stage-spoofed-file",
  });
  assert.equal(spoofed.kind, "staged");
  assert.equal(spoofed.record.mediaType, "application/octet-stream");

  const stageReceipt = {
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "diagram.png",
    claimedMediaType: "image/png",
    idempotencyKey: "stage-diagram-file",
    mediaType: "image/png",
    sha256: await env.objects.calculateSha256(PNG),
    size: PNG.byteLength,
  };
  assert.deepEqual(await env.staging.reconcile(stageReceipt), { kind: "missing" });

  const staged = await env.staging.stage({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "diagram.png",
    claimedMediaType: "image/png",
    bytes: PNG,
    idempotencyKey: "stage-diagram-file",
  });
  assert.equal(staged.kind, "staged");
  assert.equal(staged.record.state, "verified");
  assert.equal(staged.replayed, false);
  const reconciledStage = await env.staging.reconcile(stageReceipt);
  assert.equal(reconciledStage.kind, "staged");
  assert.equal(reconciledStage.replayed, true);
  assert.equal(reconciledStage.record.stagedFileId, staged.record.stagedFileId);
  assert.deepEqual(
    await env.staging.reconcile({
      ...stageReceipt,
      sha256: `sha256:${"0".repeat(64)}`,
    }),
    { kind: "invalid", code: "idempotency_conflict" },
  );

  const replayedStage = await env.staging.stage({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "diagram.png",
    claimedMediaType: "image/png",
    bytes: PNG,
    idempotencyKey: "stage-diagram-file",
  });
  assert.equal(replayedStage.kind, "staged");
  assert.equal(replayedStage.replayed, true);
  assert.equal(replayedStage.record.stagedFileId, staged.record.stagedFileId);

  const changedStage = await env.staging.stage({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "diagram.png",
    claimedMediaType: "image/png",
    bytes: Uint8Array.from([...PNG, 0]),
    idempotencyKey: "stage-diagram-file",
  });
  assert.deepEqual(changedStage, { kind: "invalid", code: "idempotency_conflict" });

  const duplicateRefCommit = new ChangesetCommitService({
    authorizer: env.authorizer,
    metadata: env.metadata,
    revisions: env.revisions,
    objects: env.objects,
    clock: { now: () => LATER },
    revisionIds: { nextRevisionId: () => "revision_duplicate_staged_ref" },
  });
  const duplicateRef = await duplicateRefCommit.commit({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "commit-duplicate-staged-ref",
    summary: "Must reject one staged ref under two paths",
    operations: [
      {
        type: "create_bundle_file",
        path: "assets/diagram-a.png",
        staged_file_id: staged.record.stagedFileId,
      },
      {
        type: "create_bundle_file",
        path: "assets/diagram-b.png",
        staged_file_id: staged.record.stagedFileId,
      },
    ],
  });
  assert.equal(duplicateRef.kind, "invalid");
  assert.equal(
    duplicateRef.error.code,
    "duplicate_staged_bundle_file_reference",
  );
  assert.equal(await env.metadata.readHead(MINDS.ordinary.spaceId), REVISIONS.initial.revisionId);
  assert.equal(
    (await env.metadata.readStagedBundleFile(staged.record.stagedFileId)).state,
    "verified",
  );

  const quotaLimited = new ChangesetCommitService({
    authorizer: env.authorizer,
    metadata: env.metadata,
    revisions: env.revisions,
    objects: env.objects,
    clock: { now: () => LATER },
    revisionIds: { nextRevisionId: () => "revision_bundle_quota_denied" },
    maxRetainedBundleFileBytes: PNG.byteLength - 1,
  });
  const overQuota = await quotaLimited.commit({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "commit-bundle-file-over-quota",
    summary: "Must not commit diagram",
    operations: [{
      type: "create_bundle_file",
      path: "assets/diagram.png",
      staged_file_id: staged.record.stagedFileId,
    }],
  });
  assert.equal(overQuota.kind, "invalid");
  assert.equal(overQuota.error.code, "retained_bundle_file_quota_exceeded");
  assert.equal(await env.metadata.readHead(MINDS.ordinary.spaceId), REVISIONS.initial.revisionId);
  assert.equal(
    (await env.metadata.readStagedBundleFile(staged.record.stagedFileId)).state,
    "verified",
  );

  const commits = new ChangesetCommitService({
    authorizer: env.authorizer,
    metadata: env.metadata,
    revisions: env.revisions,
    objects: env.objects,
    clock: { now: () => LATER },
    revisionIds: { nextRevisionId: () => REVISIONS.next.revisionId },
  });
  const committed = await commits.commit({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "commit-bundle-file",
    summary: "Add diagram",
    operations: [{
      type: "create_bundle_file",
      path: "assets/diagram.png",
      staged_file_id: staged.record.stagedFileId,
    }],
  });
  assert.equal(committed.kind, "committed");
  assert.equal(committed.envelope.manifest.format, REVISION_MANIFEST_FORMAT_V4);
  assert.deepEqual(
    committed.envelope.manifest.entries.find((entry) => entry.kind === "opaque"),
    {
      kind: "opaque",
      path: "assets/diagram.png",
      sha256: staged.record.sha256,
      mediaType: "image/png",
      size: PNG.byteLength,
    },
  );
  assert.equal(
    (await env.metadata.readStagedBundleFile(staged.record.stagedFileId)).state,
    "consumed",
  );
  const restoredMetadata = InMemoryRevisionMetadataStore.fromDurableSnapshot(
    env.metadata.exportDurableSnapshot(),
  );
  const retainedQuota = (candidateEntries, maxRetainedBytes) =>
    restoredMetadata.runContentCommitTransaction((transaction) =>
      transaction.checkBundleFileRetainedQuota({
        spaceId: MINDS.ordinary.spaceId,
        candidateEntries,
        maxRetainedBytes,
      }));
  assert.equal(await retainedQuota(
    [{ sha256: staged.record.sha256, size: staged.record.size }],
    staged.record.size,
  ), true);
  assert.equal(await retainedQuota(
    [
      { sha256: staged.record.sha256, size: staged.record.size },
      { sha256: `sha256:${"f".repeat(64)}`, size: 1 },
    ],
    staged.record.size,
  ), false);
  const exact = await env.revisions.materialize(
    MINDS.ordinary.spaceId,
    REVISIONS.next.revisionId,
  );
  const opaque = exact.files.find((file) => file.kind === "opaque");
  assert.deepEqual(opaque.bytes, PNG);

  const index = new InMemoryExactRevisionSearchIndex();
  const indexing = new RevisionIndexJobHandler({
    work: env.metadata,
    revisions: env.revisions,
    index,
    clock: { now: () => LATER },
  });
  assert.deepEqual(
    await indexing.handle({
      actor: {
        kind: "service",
        serviceId: "bundle-file-index-test",
        deploymentCapabilities: CAPABILITIES,
        requestId: "request_bundle_file_index",
        occurredAtUtc: LATER,
      },
      jobId: `index_job_${REVISIONS.next.revisionId}`,
    }),
    { kind: "completed" },
  );
  const indexed = await index.readExactRevision(
    MINDS.ordinary.spaceId,
    REVISIONS.next.revisionId,
  );
  assert.equal(indexed.kind, "ready");
  assert.equal(indexed.documents.some((document) => document.path.endsWith(".png")), false);

  const cleanup = new BundleFileStagingService({
    authorizer: env.authorizer,
    metadata: env.metadata,
    objects: env.objects,
    clock: { now: () => "2026-08-07T14:00:00.000Z" },
  });
  const interrupted = await env.metadata.collectStagedBundleFilesForGc({
    createdBefore: "2026-08-07T13:55:00.000Z",
    limit: 1,
  });
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].state, "expired");
  assert.deepEqual(await cleanup.collectExpired(), {
    scanned: 2,
    deleted: 2,
    bytes: PNG.byteLength + new TextEncoder().encode("<svg><script/></svg>").byteLength,
  });
  assert.equal(await env.metadata.readStagedBundleFile(staged.record.stagedFileId), null);
  const reservation = (await env.metadata.listCapacityReservationsForTest())
    .find((item) => item.reservationId === staged.record.capacityReservationId);
  assert.equal(reservation.state, "released");
  assert.deepEqual(
    (await env.objects.getBundleFile(MINDS.ordinary.spaceId, staged.record.sha256)).bytes,
    PNG,
  );
});

test("indexing selects exact Markdown entries before reading large mixed-bundle objects", async () => {
  const env = await harness();
  const largeOpaqueBytes = new Uint8Array(8 * 1024 * 1024);
  largeOpaqueBytes.set(PNG.subarray(0, 8));
  const staged = await env.staging.stage({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "large-archive.bin",
    claimedMediaType: "application/octet-stream",
    bytes: largeOpaqueBytes,
    idempotencyKey: "stage-large-index-exclusion",
  });
  assert.equal(staged.kind, "staged");

  const revisionIds = ["revision_large_mixed", "revision_large_mixed_deleted"];
  const commits = new ChangesetCommitService({
    authorizer: env.authorizer,
    metadata: env.metadata,
    revisions: env.revisions,
    objects: env.objects,
    clock: { now: () => LATER },
    revisionIds: { nextRevisionId: () => revisionIds.shift() },
  });
  const mixed = await commits.commit({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "commit-large-index-exclusion",
    summary: "Add indexable note and large opaque archive",
    operations: [
      {
        type: "create_file",
        path: "concepts/temporary-index-note.md",
        text: "---\ntype: Reference\ntitle: Temporary index note\n---\n\n# Temporary index note\n",
      },
      {
        type: "create_bundle_file",
        path: "assets/large-archive.bin",
        staged_file_id: staged.record.stagedFileId,
      },
    ],
  });
  assert.equal(mixed.kind, "committed");
  assert.equal(
    mixed.envelope.manifest.entries
      .filter((entry) => entry.kind === "opaque")
      .reduce((bytes, entry) => bytes + entry.size, 0),
    largeOpaqueBytes.byteLength,
  );
  const deleted = await commits.commit({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    expectedRevisionId: "revision_large_mixed",
    idempotencyKey: "commit-large-index-deletion",
    summary: "Remove indexable note and large opaque archive",
    operations: [
      { type: "delete_file", path: "concepts/temporary-index-note.md" },
      { type: "delete_bundle_file", path: "assets/large-archive.bin" },
    ],
  });
  assert.equal(deleted.kind, "committed");

  let materializeCalls = 0;
  const readCalls = [];
  const selectiveRevisions = {
    async materialize(...args) {
      materializeCalls += 1;
      return env.revisions.materialize(...args);
    },
    readRevisionEnvelope: (...args) => env.revisions.readRevisionEnvelope(...args),
    async readRevisionFile(spaceId, revisionId, path) {
      readCalls.push({ revisionId, path });
      assert.notEqual(path, "assets/large-archive.bin");
      return env.revisions.readRevisionFile(spaceId, revisionId, path);
    },
  };
  const index = new InMemoryExactRevisionSearchIndex();
  const indexing = new RevisionIndexJobHandler({
    work: env.metadata,
    revisions: selectiveRevisions,
    index,
    clock: { now: () => LATER },
  });
  for (const revisionId of ["revision_large_mixed", "revision_large_mixed_deleted"]) {
    assert.deepEqual(await indexing.handle({
      actor: {
        kind: "service",
        serviceId: "large-bundle-index-test",
        deploymentCapabilities: CAPABILITIES,
        requestId: `request_${revisionId}`,
        occurredAtUtc: LATER,
      },
      jobId: `index_job_${revisionId}`,
    }), { kind: "completed" });
  }
  assert.equal(materializeCalls, 0);
  assert.equal(
    readCalls.some((call) => call.path === "assets/large-archive.bin"),
    false,
  );
  const indexedMixed = await index.readExactRevision(
    MINDS.ordinary.spaceId,
    "revision_large_mixed",
  );
  assert.equal(indexedMixed.kind, "ready");
  assert.equal(
    indexedMixed.documents.some((document) =>
      document.path === "concepts/temporary-index-note.md"),
    true,
  );
  const indexedDeleted = await index.readExactRevision(
    MINDS.ordinary.spaceId,
    "revision_large_mixed_deleted",
  );
  assert.equal(indexedDeleted.kind, "ready");
  assert.equal(
    indexedDeleted.documents.some((document) =>
      document.path === "concepts/temporary-index-note.md"),
    false,
  );
});

test("server-generated stream uses shared quarantine and records safe provenance", async () => {
  const env = await harness();
  const ingress = new GeneratedArtifactIngressService({ staging: env.staging });
  const result = await ingress.stageServerGenerated({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "generated.png",
    claimedMediaType: "image/png",
    idempotencyKey: "generated-stream-stage",
    stream: (async function* () {
      yield PNG.subarray(0, 4);
      yield PNG.subarray(4);
    })(),
  });
  assert.equal(result.kind, "staged");
  assert.equal(result.record.sourceKind, "server_generated");
  assert.deepEqual(
    (await env.objects.getStagedBundleFile(result.record.stagedFileId))?.bytes,
    PNG,
  );
});

test("text ingress validates complete UTF-8 across stream chunks before assigning text media", async () => {
  const env = await harness();
  const csv = new TextEncoder().encode("stop_id,stop_name\n1,Funchal\n2,Câmara de Lobos\n");
  const split = csv.indexOf(0xc3) + 1;
  const staged = await env.staging.stageStream({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "stops.csv",
    claimedMediaType: "application/octet-stream",
    idempotencyKey: "stage-streaming-utf8-csv",
    sourceKind: "local_path",
    maxBytes: csv.byteLength,
    stream: (async function* () {
      yield csv.subarray(0, split);
      yield csv.subarray(split);
    })(),
  });
  assert.equal(staged.kind, "staged");
  assert.equal(staged.record.mediaType, "text/csv");
  assert.deepEqual(
    (await env.objects.getStagedBundleFile(staged.record.stagedFileId))?.bytes,
    csv,
  );

  const invalidUtf8 = Uint8Array.from([0x72, 0x6f, 0x77, 0x0a, 0xc3, 0x28]);
  const binary = await env.staging.stageStream({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "invalid.csv",
    claimedMediaType: "text/csv",
    idempotencyKey: "stage-streaming-invalid-utf8-csv",
    sourceKind: "local_path",
    maxBytes: invalidUtf8.byteLength,
    stream: (async function* () {
      yield invalidUtf8.subarray(0, 5);
      yield invalidUtf8.subarray(5);
    })(),
  });
  assert.equal(binary.kind, "staged");
  assert.equal(binary.record.mediaType, "application/octet-stream");
  assert.deepEqual(
    (await env.objects.getStagedBundleFile(binary.record.stagedFileId))?.bytes,
    invalidUtf8,
  );
});

test("streaming stage forwards an exact authorized source size to object storage", async () => {
  const env = await harness();
  const objects = streamingProbeObjectStore();
  const begin = objects.beginStagedBundleFileUpload;
  let requestedExpectedSize;
  objects.beginStagedBundleFileUpload = async (request) => {
    requestedExpectedSize = request.expectedSize;
    return begin(request);
  };
  const staging = new BundleFileStagingService({
    authorizer: env.authorizer,
    metadata: env.metadata,
    objects,
    clock: { now: () => LATER },
    ids: { nextStagedBundleFileId: () => "staged_stream_exact_source_size" },
  });
  const result = await staging.stageStream({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "exact-source.bin",
    idempotencyKey: "stage-exact-source-size",
    sourceKind: "local_path",
    expectedSize: PNG.byteLength,
    maxBytes: 268_435_456,
    stream: (async function* () {
      yield PNG;
    })(),
  });
  assert.equal(result.kind, "staged");
  assert.equal(requestedExpectedSize, PNG.byteLength);
  const reservation = (await env.metadata.listCapacityReservationsForTest())
    .find((item) => item.reservationId === result.record.capacityReservationId);
  assert.equal(reservation.requested.temporaryBytes, PNG.byteLength);
  assert.equal(reservation.heavy, false);
});

test("streaming stage accepts exact 256 MiB and rejects byte 268435457 without buffering", async () => {
  const acceptedEnv = await harness();
  const acceptedObjects = streamingProbeObjectStore();
  const accepted = new BundleFileStagingService({
    authorizer: acceptedEnv.authorizer,
    metadata: acceptedEnv.metadata,
    objects: acceptedObjects,
    clock: { now: () => LATER },
    ids: { nextStagedBundleFileId: () => "staged_stream_exact_256m" },
  });
  const exact = await accepted.stageStream({
    actor: acceptedEnv.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "large.bin",
    idempotencyKey: "stage-large-exact-256m",
    sourceKind: "server_generated",
    maxBytes: 268_435_456,
    stream: repeatedChunks(256, 1_048_576),
  });
  assert.equal(exact.kind, "staged");
  assert.equal(exact.record.size, 268_435_456);
  assert.equal(exact.record.mediaType, "application/octet-stream");
  assert.deepEqual(acceptedObjects.evidence, {
    writes: 256,
    maxChunkBytes: 1_048_576,
    completedBytes: 268_435_456,
    aborted: false,
  });

  const overflowEnv = await harness();
  const overflowObjects = streamingProbeObjectStore();
  const overflow = new BundleFileStagingService({
    authorizer: overflowEnv.authorizer,
    metadata: overflowEnv.metadata,
    objects: overflowObjects,
    clock: { now: () => LATER },
    ids: { nextStagedBundleFileId: () => "staged_stream_overflow_256m" },
  });
  const plusOne = await overflow.stageStream({
    actor: overflowEnv.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "large-plus-one.bin",
    idempotencyKey: "stage-large-plus-one",
    sourceKind: "server_generated",
    maxBytes: 268_435_456,
    stream: repeatedChunks(256, 1_048_576, 1),
  });
  assert.deepEqual(plusOne, { kind: "stream_invalid", code: "stream_size_limit_exceeded" });
  assert.equal(overflowObjects.evidence.completedBytes, 0);
  assert.equal(overflowObjects.evidence.aborted, true);
});

test("server-generated cancellation cleans up and MIME conflict degrades to opaque", async () => {
  const env = await harness();
  const ingress = new GeneratedArtifactIngressService({ staging: env.staging });
  const controller = new AbortController();
  const canceled = await ingress.stageServerGenerated({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "canceled.png",
    claimedMediaType: "image/png",
    idempotencyKey: "generated-stream-canceled",
    signal: controller.signal,
    stream: (async function* () {
      yield PNG;
      controller.abort();
      yield PNG;
    })(),
  });
  assert.deepEqual(canceled, {
    kind: "invalid",
    code: "generated_artifact_cancelled",
  });
  assert.equal(await env.objects.getStagedBundleFile("staged_bundle_1"), null);

  const rejected = await ingress.stageServerGenerated({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "wrong.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "generated-stream-mime-rejected",
    stream: (async function* () {
      yield PNG;
    })(),
  });
  assert.equal(rejected.kind, "staged");
  assert.equal(rejected.record.mediaType, "application/octet-stream");
  assert.notEqual(await env.objects.getStagedBundleFile("staged_bundle_2"), null);
});

test("server-generated staged ID collision preserves the foreign object", async () => {
  const env = await harness();
  const foreign = Uint8Array.from([0x01, 0x02, 0x03]);
  await env.objects.putStagedBundleFile({
    stagedFileId: "staged_bundle_1",
    bindingOwnerId: "binding_owner_foreign",
    spaceId: MINDS.personal.spaceId,
    bytes: foreign,
    createdAt: LATER,
  });
  const ingress = new GeneratedArtifactIngressService({ staging: env.staging });

  const result = await ingress.stageServerGenerated({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "collision.png",
    claimedMediaType: "image/png",
    idempotencyKey: "generated-stream-collision",
    stream: (async function* () {
      yield PNG;
    })(),
  });

  assert.deepEqual(result, {
    kind: "invalid",
    code: "generated_artifact_streaming_unavailable",
  });
  const preserved = await env.objects.getStagedBundleFile("staged_bundle_1");
  assert.equal(preserved.bindingOwnerId, "binding_owner_foreign");
  assert.equal(preserved.spaceId, MINDS.personal.spaceId);
  assert.deepEqual(preserved.bytes, foreign);
});

test("arbitrary opaque formats stage and commit atomically with bounded safe media fallback", async () => {
  const env = await harness();
  const fixtures = [
    ["assets/document.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Uint8Array.from([...ZIP, 1]), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["assets/photo.heic", "image/heic", Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]), "image/heic"],
    ["assets/book.epub", "application/epub+zip", Uint8Array.from([...ZIP, 2]), "application/epub+zip"],
    ["assets/audio.opus", "audio/ogg", new TextEncoder().encode("OggS\0OpusHead"), "audio/ogg"],
    ["assets/page.html", "text/html; charset=UTF-8", new TextEncoder().encode("<!doctype html><p>opaque</p>"), "text/html"],
    ["assets/table.csv", "application/octet-stream", new TextEncoder().encode("name,value\nalpha,1\n"), "text/csv"],
    ["assets/routes.txt", "application/octet-stream", new TextEncoder().encode("route_id,route_short_name\n1,Airport\n"), "text/plain"],
    ["assets/data.json", "application/octet-stream", new TextEncoder().encode("{\"value\":1}"), "application/json"],
    ["assets/notebook.ipynb", "application/x-ipynb+json", new TextEncoder().encode("{\"cells\":[]}"), "application/x-ipynb+json"],
    ["assets/archive.zip", "application/zip", ZIP, "application/zip"],
    ["assets/unknown.custom", "application/x-mind-diary-test", Uint8Array.of(0, 1, 2, 3), "application/octet-stream"],
  ];
  const staged = [];
  for (const [path, claimedMediaType, bytes, expectedMediaType] of fixtures) {
    const result = await env.staging.stage({
      actor: env.currentActor,
      spaceId: MINDS.ordinary.spaceId,
      writeBindingId: WRITE_BINDING_ID,
      displayFilename: path.split("/").at(-1),
      claimedMediaType,
      bytes,
      idempotencyKey: `stage-arbitrary-${path}`,
    });
    assert.equal(result.kind, "staged", path);
    assert.equal(result.record.mediaType, expectedMediaType, path);
    staged.push({ path, bytes, result });
  }
  for (const [displayFilename, claimedMediaType, bytes, expectedMediaType] of [
    ["missing.html", undefined, new TextEncoder().encode("<!doctype html>"), "text/html"],
    ["invalid.html", "text/html\r\nx-injected: yes", new TextEncoder().encode("<!doctype html>"), "text/html"],
    ["conflict.html", "text/html", PNG, "application/octet-stream"],
    ["control.csv", "text/csv", Uint8Array.of(0x61, 0x2c, 0x62, 0x0a, 0x00), "application/octet-stream"],
  ]) {
    const fallback = await env.staging.stage({
      actor: env.currentActor,
      spaceId: MINDS.ordinary.spaceId,
      writeBindingId: WRITE_BINDING_ID,
      displayFilename,
      claimedMediaType,
      bytes,
      idempotencyKey: `stage-advisory-fallback-${displayFilename}`,
    });
    assert.equal(fallback.kind, "staged", displayFilename);
    assert.equal(fallback.record.mediaType, expectedMediaType, displayFilename);
  }

  const commits = new ChangesetCommitService({
    authorizer: env.authorizer,
    metadata: env.metadata,
    revisions: env.revisions,
    objects: env.objects,
    clock: { now: () => LATER },
    revisionIds: { nextRevisionId: () => "revision_arbitrary_opaque_formats" },
  });
  const committed = await commits.commit({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "commit-arbitrary-opaque-formats",
    summary: "Commit arbitrary opaque formats",
    operations: staged.map(({ path, result }) => ({
      type: "create_bundle_file",
      path,
      staged_file_id: result.record.stagedFileId,
    })),
  });
  assert.equal(committed.kind, "committed");
  assert.equal(committed.envelope.manifest.format, REVISION_MANIFEST_FORMAT_V4);
  const exact = await env.revisions.materialize(
    MINDS.ordinary.spaceId,
    committed.envelope.revision.revisionId,
  );
  for (const fixture of staged) {
    assert.deepEqual(
      exact.files.find(({ path }) => path === fixture.path)?.bytes,
      fixture.bytes,
      fixture.path,
    );
  }
});

test("a new revision can refine media type while reusing the same canonical bytes", async () => {
  const env = await harness();
  const bytes = new TextEncoder().encode("route_id,route_short_name\n1,Airport\n");
  const invalidTextBytes = Uint8Array.of(0xff, 0xfe, 0x00, 0x41);
  const stagedOpaque = await env.staging.stage({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "routes.bin",
    claimedMediaType: "application/octet-stream",
    bytes,
    idempotencyKey: "stage-routes-as-opaque",
  });
  assert.equal(stagedOpaque.kind, "staged");
  assert.equal(stagedOpaque.record.mediaType, "application/octet-stream");
  const stagedInvalidText = await env.staging.stage({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "raw.bin",
    claimedMediaType: "application/octet-stream",
    bytes: invalidTextBytes,
    idempotencyKey: "stage-invalid-text-as-opaque",
  });
  assert.equal(stagedInvalidText.kind, "staged");

  const revisionIds = ["revision_routes_opaque", "revision_routes_text"];
  const commits = new ChangesetCommitService({
    authorizer: env.authorizer,
    metadata: env.metadata,
    revisions: env.revisions,
    objects: env.objects,
    clock: { now: () => LATER },
    revisionIds: { nextRevisionId: () => revisionIds.shift() },
  });
  const initial = await commits.commit({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "commit-routes-as-opaque",
    summary: "Store routes with the original opaque classification",
    operations: [
      {
        type: "create_bundle_file",
        path: "data/routes.csv",
        staged_file_id: stagedOpaque.record.stagedFileId,
      },
      {
        type: "create_bundle_file",
        path: "data/raw.txt",
        staged_file_id: stagedInvalidText.record.stagedFileId,
      },
    ],
  });
  assert.equal(initial.kind, "committed");

  const invalidUtf8 = await commits.commit({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    expectedRevisionId: initial.envelope.revision.revisionId,
    idempotencyKey: "reject-invalid-text-reclassification",
    summary: "Must not reclassify invalid UTF-8 bytes as text",
    operations: [{
      type: "reclassify_bundle_file",
      path: "data/raw.txt",
      media_type: "text/plain",
      expected_sha256: stagedInvalidText.record.sha256,
    }],
  });
  assert.equal(invalidUtf8.kind, "invalid");
  assert.equal(invalidUtf8.error.code, "bundle_file_media_mismatch");
  assert.equal(await env.metadata.readHead(MINDS.ordinary.spaceId), initial.envelope.revision.revisionId);

  const wrongMedia = await commits.commit({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    expectedRevisionId: initial.envelope.revision.revisionId,
    idempotencyKey: "reject-route-json-reclassification",
    summary: "Must not reclassify CSV bytes as JSON",
    operations: [{
      type: "reclassify_bundle_file",
      path: "data/routes.csv",
      media_type: "application/json",
      expected_sha256: stagedOpaque.record.sha256,
    }],
  });
  assert.equal(wrongMedia.kind, "invalid");
  assert.equal(wrongMedia.error.code, "bundle_file_media_mismatch");
  assert.equal(await env.metadata.readHead(MINDS.ordinary.spaceId), initial.envelope.revision.revisionId);

  const refined = await commits.commit({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    expectedRevisionId: initial.envelope.revision.revisionId,
    idempotencyKey: "commit-routes-as-text",
    summary: "Refine routes media classification",
    operations: [{
      type: "reclassify_bundle_file",
      path: "data/routes.csv",
      media_type: "text/csv",
      expected_sha256: stagedOpaque.record.sha256,
    }],
  });
  assert.equal(refined.kind, "committed");

  const historical = await env.revisions.materialize(
    MINDS.ordinary.spaceId,
    initial.envelope.revision.revisionId,
  );
  const current = await env.revisions.materialize(
    MINDS.ordinary.spaceId,
    refined.envelope.revision.revisionId,
  );
  const historicalEntry = historical.files.find(({ path }) => path === "data/routes.csv");
  const currentEntry = current.files.find(({ path }) => path === "data/routes.csv");
  assert.equal(historicalEntry.mediaType, "application/octet-stream");
  assert.equal(currentEntry.mediaType, "text/csv");
  assert.equal(historicalEntry.sha256, currentEntry.sha256);
  assert.deepEqual(historicalEntry.bytes, bytes);
  assert.deepEqual(currentEntry.bytes, bytes);
  assert.equal(
    (await env.objects.getBundleFile(MINDS.ordinary.spaceId, currentEntry.sha256)).mediaType,
    "application/octet-stream",
  );
});

test("Markdown BundleFile references validate the atomic resulting revision", async () => {
  const env = await harness();
  const staged = await env.staging.stage({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "diagram.png",
    claimedMediaType: "image/png",
    bytes: PNG,
    idempotencyKey: "stage-reference-diagram",
  });
  assert.equal(staged.kind, "staged");
  const revisionIds = [
    "revision_bundle_reference",
    "revision_bundle_reference_invalid",
    "revision_bundle_reference_removed",
  ];
  const commits = new ChangesetCommitService({
    authorizer: env.authorizer,
    metadata: env.metadata,
    revisions: env.revisions,
    objects: env.objects,
    clock: { now: () => LATER },
    revisionIds: { nextRevisionId: () => revisionIds.shift() },
  });
  const linkedText = [
    "---",
    "type: Reference",
    "title: Diagram reference",
    "---",
    "",
    "# Diagram reference",
    "",
    "![Diagram](../assets/diagram.png)",
    "",
  ].join("\n");
  const created = await commits.commit({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "commit-bundle-reference",
    summary: "Add linked diagram atomically",
    operations: [
      {
        type: "create_bundle_file",
        path: "assets/diagram.png",
        staged_file_id: staged.record.stagedFileId,
      },
      {
        type: "create_file",
        path: "concepts/diagram-reference.md",
        text: linkedText,
      },
    ],
  });
  assert.equal(created.kind, "committed");

  const invalidDelete = await commits.commit({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    expectedRevisionId: created.envelope.revision.revisionId,
    idempotencyKey: "delete-still-referenced-bundle-file",
    summary: "Must not leave a dangling reference",
    operations: [{ type: "delete_bundle_file", path: "assets/diagram.png" }],
  });
  assert.equal(invalidDelete.kind, "invalid");
  assert.equal(invalidDelete.error.code, "okf_validation_failed");
  assert.ok(invalidDelete.error.diagnostics.some(
    (issue) => issue.code === "bundle_file_reference_missing",
  ));
  assert.equal(
    await env.metadata.readHead(MINDS.ordinary.spaceId),
    created.envelope.revision.revisionId,
  );

  const removed = await commits.commit({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    expectedRevisionId: created.envelope.revision.revisionId,
    idempotencyKey: "remove-bundle-reference-and-file",
    summary: "Remove diagram and its reference atomically",
    operations: [
      { type: "delete_bundle_file", path: "assets/diagram.png" },
      {
        type: "replace_file",
        path: "concepts/diagram-reference.md",
        text: linkedText.replace("![Diagram](../assets/diagram.png)", "Diagram removed."),
      },
    ],
  });
  assert.equal(removed.kind, "committed");
  assert.equal(
    removed.envelope.manifest.entries.some((entry) => entry.kind === "opaque"),
    false,
  );
});

test("BundleFile dev smoke preserves exact bytes, history, exports, and reconstructed state", async () => {
  const env = await harness();
  const opaqueFixtures = [
    ["assets/diagram.png", "image/png", PNG],
    ["assets/photo.jpg", "image/jpeg", JPEG],
    ["assets/animation.gif", "image/gif", GIF],
    ["assets/preview.webp", "image/webp", WEBP],
    ["assets/spoofed.png", "image/png", MALFORMED_PNG],
    ["assets/справка.pdf", "application/pdf", PDF],
    ["assets/document.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Uint8Array.from([...ZIP, 1])],
    ["assets/photo.heic", "image/heic", Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])],
    ["assets/book.epub", "application/epub+zip", Uint8Array.from([...ZIP, 2])],
    ["assets/audio.opus", "audio/ogg", new TextEncoder().encode("OggS\0OpusHead")],
    ["assets/page.html", "text/html", new TextEncoder().encode("<!doctype html><p>opaque</p>")],
    ["assets/table.csv", "text/csv", new TextEncoder().encode("name,value\nalpha,1\n")],
    ["assets/data.json", "application/json", new TextEncoder().encode("{\"value\":1}")],
    ["assets/notebook.ipynb", "application/x-ipynb+json", new TextEncoder().encode("{\"cells\":[]}")],
    ["assets/archive.zip", "application/zip", ZIP],
    ["assets/unknown.bin", "application/x-mind-diary-test", Uint8Array.of(0, 1, 2, 3)],
  ];
  const stagedFiles = [];
  for (const [path, mediaType, bytes] of opaqueFixtures) {
    const staged = await env.staging.stage({
      actor: env.currentActor,
      spaceId: MINDS.ordinary.spaceId,
      writeBindingId: WRITE_BINDING_ID,
      displayFilename: path.split("/").at(-1),
      claimedMediaType: mediaType,
      bytes,
      idempotencyKey: `stage-download-${path}`,
    });
    assert.equal(staged.kind, "staged");
    stagedFiles.push({ path, bytes, staged });
  }
  const commits = new ChangesetCommitService({
    authorizer: env.authorizer,
    metadata: env.metadata,
    revisions: env.revisions,
    objects: env.objects,
    clock: { now: () => LATER },
    revisionIds: { nextRevisionId: () => REVISIONS.next.revisionId },
  });
  const committed = await commits.commit({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "commit-download-diagram",
    summary: "Add exact download diagram",
    operations: [
      ...stagedFiles.map(({ path, staged }) => ({
        type: "create_bundle_file",
        path,
        staged_file_id: staged.record.stagedFileId,
      })),
      {
        type: "create_file",
        path: "concepts/bundle-files.md",
        text: [
          "---",
          "type: Reference",
          "title: Bundle files",
          "---",
          "",
          "# Bundle files",
          "",
          "![Diagram](../assets/diagram.png)",
          "",
        ].join("\n"),
      },
    ],
  });
  assert.equal(committed.kind, "committed");

  const crypto = await createWebCryptoExportDownloadSecretCrypto({
    verifierKey: new Uint8Array(32).fill(23),
  });
  let bundleFileOpens = 0;
  const observedDownloadObjects = new Proxy(env.objects, {
    get(target, property) {
      if (property === "openBundleFile") {
        return async (...args) => {
          bundleFileOpens += 1;
          return target.openBundleFile(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const resetBundleFileOpens = () => {
    bundleFileOpens = 0;
  };
  const discoveryStore = new Proxy(env.metadata, {
    get(target, property) {
      if (property === "readResolvedSpace") {
        return async (spaceId) => spaceId === MINDS.ordinary.spaceId
          ? {
              host: verifiedSpaceHost("mind-diary.test"),
              canonicalHandle: "bundle-downloads",
              space: {
                spaceId,
                spaceHandle: "bundle-downloads",
                normalizedHandle: "bundle-downloads",
                name: "Bundle downloads",
                visibility: "private",
                state: "active",
                metadataVersion: version(1),
                accessVersion: version(1),
                headRevisionId: REVISIONS.next.revisionId,
                createdAt: FIXED_NOW,
                updatedAt: LATER,
              },
            }
          : null;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const issueDirectGrant = async (entry, bindingOwnerId = BINDING_OWNER_ID) => {
    const issued = await crypto.issueSecret();
    const created = await env.metadata.runBundleFileDownloadGrantTransaction(
      (transaction) => transaction.createBundleFileDownloadGrant({
        secretVerifier: issued.verifier(),
        requestedByPrincipalId: env.currentActor.principalId,
        tokenId: TOKEN_ID,
        bindingOwnerId,
        spaceId: MINDS.ordinary.spaceId,
        revisionId: REVISIONS.next.revisionId,
        path: entry.path,
        mediaType: entry.mediaType,
        sha256: entry.sha256,
        size: entry.size,
        state: "active",
        createdAt: LATER,
        expiresAt: "2026-08-05T13:05:00.000Z",
        consumedAt: null,
      }),
    );
    assert.equal(created.kind, "created");
    return issued.consumeSecret();
  };
  const service = new BundleFileDownloadService({
    store: discoveryStore,
    objects: observedDownloadObjects,
    authorizer: env.authorizer,
    host: verifiedSpaceHost("mind-diary.test"),
    clock: { now: () => LATER },
    secrets: crypto,
    downloadUrlBase: "https://mind-diary.test/api/bundle-download",
  });
  const serviceActor = {
    kind: "service",
    serviceId: "bundle-download-test",
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_bundle_download",
    occurredAtUtc: LATER,
  };
  const authorizationKey = {
    principalId: env.currentActor.principalId,
    spaceId: MINDS.ordinary.spaceId,
    tokenId: TOKEN_ID,
  };
  env.metadata.setCurrentAuthorizationStateForTest(authorizationKey, {
    ...authorizationState(),
    token: {
      ...authorizationState().token,
      expiresAt: "2026-08-06T12:01:00.000Z",
    },
  });
  const issuingService = new BundleFileDownloadService({
    store: discoveryStore,
    objects: observedDownloadObjects,
    authorizer: env.authorizer,
    host: verifiedSpaceHost("mind-diary.test"),
    clock: { now: () => FIXED_NOW },
    secrets: crypto,
    downloadUrlBase: "https://mind-diary.test/api/bundle-download",
  });
  const issuedByApplication = await issuingService.issue(env.currentActor, {
    mind: MINDS.ordinary.spaceId,
    revisionSelector: { kind: "revision", revisionId: REVISIONS.next.revisionId },
    path: "assets/diagram.png",
  });
  assert.equal(issuedByApplication.downloadExpiresAt, "2026-08-06T12:01:00.000Z");
  assert.equal(issuedByApplication.file.inlineEligible, true);
  assert.equal(issuedByApplication.disposition, "inline");
  assert.doesNotMatch(JSON.stringify(issuedByApplication.file), /bytes|url|provider/iu);
  const applicationSecret = new URL(issuedByApplication.downloadUrl).pathname.split("/").at(-1);
  const applicationDownload = await issuingService.download(serviceActor, applicationSecret);
  assert.equal(applicationDownload.kind, "download");
  assert.deepEqual(await streamBytes(applicationDownload.body), PNG);
  const spoofedIssue = await issuingService.issue(env.currentActor, {
    mind: MINDS.ordinary.spaceId,
    revisionSelector: { kind: "revision", revisionId: REVISIONS.next.revisionId },
    path: "assets/spoofed.png",
  });
  assert.equal(spoofedIssue.file.inlineEligible, false);
  assert.equal(spoofedIssue.disposition, "attachment");
  env.metadata.setCurrentAuthorizationStateForTest(authorizationKey, authorizationState());

  resetBundleFileOpens();
  await assert.rejects(
    issuingService.issue(env.currentActor, {
      mind: MINDS.ordinary.spaceId,
      path: "../assets/diagram.png",
    }),
    (error) => error?.code === "invalid_request",
  );
  await assert.rejects(
    issuingService.issue(env.currentActor, {
      mind: MINDS.personal.spaceId,
      path: "assets/diagram.png",
    }),
    (error) => error?.code === "mind_not_found",
  );
  assert.deepEqual(await service.download(serviceActor, "foreign-download-secret"), {
    kind: "not_found",
  });
  assert.equal(bundleFileOpens, 0);

  const pngEntry = committed.envelope.manifest.entries.find(
    (candidate) => candidate.path === "assets/diagram.png",
  );
  const raceBindingOwnerId = "binding_owner_bundle_file_race";
  const raceActor = {
    ...env.currentActor,
    authentication: {
      ...env.currentActor.authentication,
      bindingOwnerId: raceBindingOwnerId,
    },
  };
  const raceProfile = await env.metadata.runCredentialWriteTargetTransaction(
    (transaction) => transaction.registerCredentialWriteTargetOwner({
      bindingOwnerId: raceBindingOwnerId,
      principalId: raceActor.principalId,
      credentialKind: "oauth_grant",
      occurredAt: FIXED_NOW,
    }),
  );
  assert.equal(raceProfile.kind, "registered");
  const raceAuthorizer = new MindBindingContentAuthorizer({
    delegate: new CapabilityAuthorizer(env.metadata),
    bindings: env.metadata,
    readAuthority: "current_acl",
  });
  let revokeBeforeGrantTransaction = true;
  const raceStore = new Proxy(discoveryStore, {
    get(target, property) {
      if (property === "runBundleFileDownloadGrantTransaction") {
        return async (operation) => {
          if (revokeBeforeGrantTransaction) {
            revokeBeforeGrantTransaction = false;
            const revoked = await env.metadata.revokeCredentialWriteTargetOwner({
              bindingOwnerId: raceBindingOwnerId,
              principalId: raceActor.principalId,
              requestId: "request_bundle_grant_race_revoke",
              auditEventId: "audit_bundle_grant_race_revoke",
              auditOutboxMessageId: "outbox_bundle_grant_race_revoke",
              occurredAt: LATER,
            });
            assert.equal(revoked.kind, "revoked");
          }
          return target.runBundleFileDownloadGrantTransaction(operation);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const raceService = new BundleFileDownloadService({
    store: raceStore,
    objects: observedDownloadObjects,
    authorizer: raceAuthorizer,
    credentialAccess: raceAuthorizer,
    host: verifiedSpaceHost("mind-diary.test"),
    clock: { now: () => LATER },
    secrets: crypto,
    downloadUrlBase: "https://mind-diary.test/api/bundle-download",
  });
  const grantsBeforeRace = env.metadata.exportDurableSnapshot()
    .bundleFileDownloadGrants.size;
  await assert.rejects(
    raceService.issue(raceActor, {
      mind: MINDS.ordinary.spaceId,
      revisionSelector: { kind: "revision", revisionId: REVISIONS.next.revisionId },
      path: "assets/diagram.png",
    }),
    (error) => error?.code === "mind_not_found",
  );
  assert.equal(
    env.metadata.exportDurableSnapshot().bundleFileDownloadGrants.size,
    grantsBeforeRace,
  );
  const consumeRaceOwnerId = "binding_owner_bundle_file_consume_race";
  assert.equal(
    (await env.metadata.runCredentialWriteTargetTransaction((transaction) =>
      transaction.registerCredentialWriteTargetOwner({
        bindingOwnerId: consumeRaceOwnerId,
        principalId: env.currentActor.principalId,
        credentialKind: "oauth_grant",
        occurredAt: FIXED_NOW,
      }))).kind,
    "registered",
  );
  const consumeRaceSecret = await issueDirectGrant(pngEntry, consumeRaceOwnerId);
  let revokeBeforeConsumeTransaction = true;
  const consumeRaceStore = new Proxy(discoveryStore, {
    get(target, property) {
      if (property === "runBundleFileDownloadGrantTransaction") {
        return async (operation) => {
          if (revokeBeforeConsumeTransaction) {
            revokeBeforeConsumeTransaction = false;
            const revoked = await env.metadata.revokeCredentialWriteTargetOwner({
              bindingOwnerId: consumeRaceOwnerId,
              principalId: env.currentActor.principalId,
              requestId: "request_bundle_consume_race_revoke",
              auditEventId: "audit_bundle_consume_race_revoke",
              auditOutboxMessageId: "outbox_bundle_consume_race_revoke",
              occurredAt: LATER,
            });
            assert.equal(revoked.kind, "revoked");
          }
          return target.runBundleFileDownloadGrantTransaction(operation);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const consumeRaceService = new BundleFileDownloadService({
    store: consumeRaceStore,
    objects: observedDownloadObjects,
    authorizer: raceAuthorizer,
    credentialAccess: raceAuthorizer,
    host: verifiedSpaceHost("mind-diary.test"),
    clock: { now: () => LATER },
    secrets: crypto,
    downloadUrlBase: "https://mind-diary.test/api/bundle-download",
  });
  assert.deepEqual(
    await consumeRaceService.download(serviceActor, consumeRaceSecret),
    { kind: "not_found" },
  );
  const consumeRaceGrant = [...env.metadata.exportDurableSnapshot()
    .bundleFileDownloadGrants.values()].find(
      ({ bindingOwnerId }) => bindingOwnerId === consumeRaceOwnerId,
    );
  assert.equal(consumeRaceGrant.state, "active");
  assert.equal(consumeRaceGrant.consumedAt, null);
  const secret = await issueDirectGrant(pngEntry);
  const results = await Promise.all([
    service.download(serviceActor, secret),
    service.download(serviceActor, secret),
  ]);
  const download = results.find((result) => result.kind === "download");
  assert.equal(results.filter((result) => result.kind === "download").length, 1);
  assert.equal(results.filter((result) => result.kind === "not_found").length, 1);
  assert.deepEqual(await streamBytes(download.body), PNG);
  assert.equal(download.headers["Content-Type"], "image/png");
  assert.equal(download.headers["Content-Length"], String(PNG.byteLength));
  assert.equal(download.headers["Cache-Control"], "no-store");
  assert.equal(download.headers["Cross-Origin-Resource-Policy"], "same-origin");
  assert.match(download.headers["Content-Disposition"], /^inline;/u);
  assert.equal(download.headers["Content-Security-Policy"], "sandbox");

  const inlinePaths = new Set([
    "assets/diagram.png",
    "assets/photo.jpg",
    "assets/animation.gif",
    "assets/preview.webp",
  ]);
  const additionalDownloadFixtures = stagedFiles.filter(({ path }) => path !== "assets/diagram.png");
  for (const { path, bytes: expectedBytes } of additionalDownloadFixtures) {
    const entry = committed.envelope.manifest.entries.find(
      (candidate) => candidate.path === path,
    );
    const result = await service.download(serviceActor, await issueDirectGrant(entry));
    assert.equal(result.kind, "download");
    assert.deepEqual(await streamBytes(result.body), expectedBytes);
    assert.match(
      result.headers["Content-Disposition"],
      inlinePaths.has(path) ? /^inline;/u : /^attachment;/u,
    );
    assert.equal(result.headers["X-Content-Type-Options"], "nosniff");
    assert.equal(result.headers["Cache-Control"], "no-store");
    assert.equal(
      result.headers["Content-Security-Policy"],
      inlinePaths.has(path) ? "sandbox" : undefined,
    );
    assert.doesNotMatch(result.headers["Content-Disposition"], /\r|\n/u);
    if (path.includes("справка")) {
      assert.match(result.headers["Content-Disposition"], /filename\*=UTF-8''/u);
      assert.doesNotMatch(result.headers["Content-Disposition"], /справка/u);
    }
  }

  const revokedSecret = await issueDirectGrant(pngEntry);
  env.metadata.setCurrentAuthorizationStateForTest(authorizationKey, {
    ...authorizationState(),
    token: { ...authorizationState().token, state: "revoked" },
  });
  resetBundleFileOpens();
  assert.deepEqual(
    await service.download(serviceActor, revokedSecret),
    { kind: "not_found" },
  );
  assert.equal(bundleFileOpens, 0);

  env.metadata.setCurrentAuthorizationStateForTest(authorizationKey, authorizationState());
  const unauthorizedSecret = await issueDirectGrant(pngEntry);
  env.metadata.setCurrentAuthorizationStateForTest(authorizationKey, {
    ...authorizationState(),
    membership: null,
  });
  resetBundleFileOpens();
  assert.deepEqual(
    await service.download(serviceActor, unauthorizedSecret),
    { kind: "not_found" },
  );
  assert.equal(bundleFileOpens, 0);

  env.metadata.setCurrentAuthorizationStateForTest(authorizationKey, authorizationState());
  const expiredSecret = await issueDirectGrant(pngEntry);
  const expiredService = new BundleFileDownloadService({
    store: env.metadata,
    objects: observedDownloadObjects,
    authorizer: env.authorizer,
    host: verifiedSpaceHost("mind-diary.test"),
    clock: { now: () => "2026-08-05T13:06:00.000Z" },
    secrets: crypto,
    downloadUrlBase: "https://mind-diary.test/api/bundle-download",
  });
  resetBundleFileOpens();
  assert.deepEqual(
    await expiredService.download(serviceActor, expiredSecret),
    { kind: "not_found" },
  );
  assert.equal(bundleFileOpens, 0);

  const replacement = await env.staging.stage({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "diagram-v2.png",
    claimedMediaType: "image/png",
    bytes: PNG_REPLACEMENT,
    idempotencyKey: "stage-download-diagram-v2",
  });
  assert.equal(replacement.kind, "staged");
  const replacementRevisionId = "revision_bundle_file_replacement";
  const replacementCommits = new ChangesetCommitService({
    authorizer: env.authorizer,
    metadata: env.metadata,
    revisions: env.revisions,
    objects: env.objects,
    clock: { now: () => "2026-08-05T13:07:00.000Z" },
    revisionIds: { nextRevisionId: () => replacementRevisionId },
  });
  const replaced = await replacementCommits.commit({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    expectedRevisionId: REVISIONS.next.revisionId,
    idempotencyKey: "replace-download-diagram-delete-archive",
    summary: "Replace diagram and remove archive",
    operations: [
      {
        type: "replace_bundle_file",
        path: "assets/diagram.png",
        staged_file_id: replacement.record.stagedFileId,
      },
      { type: "delete_bundle_file", path: "assets/archive.zip" },
      {
        type: "replace_file",
        path: "concepts/bundle-files.md",
        text: [
          "---",
          "type: Reference",
          "title: Bundle files",
          "---",
          "",
          "# Bundle files",
          "",
          "![Updated diagram](../assets/diagram.png)",
          "",
        ].join("\n"),
      },
    ],
  });
  assert.equal(replaced.kind, "committed");

  const historical = await env.revisions.materialize(
    MINDS.ordinary.spaceId,
    REVISIONS.next.revisionId,
  );
  assert.deepEqual(
    historical.files.find((file) => file.path === "assets/diagram.png").bytes,
    PNG,
  );
  assert.deepEqual(
    historical.files.find((file) => file.path === "assets/archive.zip").bytes,
    ZIP,
  );
  const current = await env.revisions.materialize(
    MINDS.ordinary.spaceId,
    replacementRevisionId,
  );
  assert.deepEqual(
    current.files.find((file) => file.path === "assets/diagram.png").bytes,
    PNG_REPLACEMENT,
  );
  assert.equal(
    current.files.some((file) => file.path === "assets/archive.zip"),
    false,
  );

  const exporter = new DeterministicOkfExportService({
    materializer: env.revisions,
    digest: env.objects,
  });
  const firstBundleExport = await exporter.exportExactRevision({
    spaceId: MINDS.ordinary.spaceId,
    revisionId: replacementRevisionId,
    profile: "MD-BUNDLE-ZIP-1",
  });
  const secondBundleExport = await exporter.exportExactRevision({
    spaceId: MINDS.ordinary.spaceId,
    revisionId: replacementRevisionId,
    profile: "MD-BUNDLE-ZIP-1",
  });
  assert.deepEqual(secondBundleExport.bytes, firstBundleExport.bytes);
  assert.equal(secondBundleExport.sha256, firstBundleExport.sha256);
  const currentExportEntries = readStoredZipEntries(firstBundleExport.bytes);
  for (const { path, bytes } of stagedFiles) {
    if (path === "assets/archive.zip") {
      assert.equal(currentExportEntries.has(path), false);
    } else {
      assert.deepEqual(
        currentExportEntries.get(path),
        path === "assets/diagram.png" ? PNG_REPLACEMENT : bytes,
        path,
      );
    }
  }
  const historicalBundleExport = await exporter.exportExactRevision({
    spaceId: MINDS.ordinary.spaceId,
    revisionId: REVISIONS.next.revisionId,
    profile: "MD-BUNDLE-ZIP-1",
  });
  const historicalExportEntries = readStoredZipEntries(historicalBundleExport.bytes);
  for (const { path, bytes } of stagedFiles) {
    assert.deepEqual(historicalExportEntries.get(path), bytes, path);
  }
  const legacyExport = await exporter.exportExactRevision({
    spaceId: MINDS.ordinary.spaceId,
    revisionId: REVISIONS.initial.revisionId,
    profile: "MD-OKF-ZIP-1",
  });
  assert.equal(legacyExport.archiveFormat, "MD-OKF-ZIP-1");

  const reconstructedMetadata = InMemoryRevisionMetadataStore.fromDurableSnapshot(
    env.metadata.exportDurableSnapshot(),
  );
  const reconstructedRevisions = new CanonicalRevisionCoordinator({
    objects: env.objects,
    revisions: reconstructedMetadata,
  });
  const reconstructed = await reconstructedRevisions.materialize(
    MINDS.ordinary.spaceId,
    replacementRevisionId,
  );
  assert.deepEqual(
    reconstructed.files.find((file) => file.path === "assets/diagram.png").bytes,
    PNG_REPLACEMENT,
  );
  assert.equal(
    reconstructed.files.some((file) => file.path === "assets/archive.zip"),
    false,
  );

  const deletedSecret = await issueDirectGrant(pngEntry);
  assert.equal(
    (await env.metadata.listBundleFileDownloadGrantsForTest()).filter(
      (grant) => grant.state === "consumed",
    ).length,
    2 + additionalDownloadFixtures.length,
  );
  await env.metadata.purgeSpaceTargetRecords(MINDS.ordinary.spaceId);
  assert.deepEqual(await env.metadata.listBundleFileDownloadGrantsForTest(), []);
  resetBundleFileOpens();
  assert.deepEqual(
    await service.download(serviceActor, deletedSecret),
    { kind: "not_found" },
  );
  assert.equal(bundleFileOpens, 0);
});

test("staging verifies image, PDF and ZIP metadata and fails closed on foreign or expired reuse", async () => {
  const env = await harness();
  for (const [name, mediaType, bytes] of [
    ["diagram.png", "image/png", PNG],
    ["paper.pdf", "application/pdf", PDF],
    ["archive.zip", "application/zip", ZIP],
  ]) {
    const expectedSha256 = await env.objects.calculateSha256(bytes);
    const staged = await env.staging.stage({
      actor: env.currentActor,
      spaceId: MINDS.ordinary.spaceId,
      writeBindingId: WRITE_BINDING_ID,
      displayFilename: name,
      claimedMediaType: mediaType,
      bytes,
      idempotencyKey: `stage-${name}`,
      expectedSize: bytes.byteLength,
      expectedSha256,
    });
    assert.equal(staged.kind, "staged");
    assert.equal(staged.record.displayFilename, name);
    assert.equal(staged.record.mediaType, mediaType);
    assert.equal(staged.record.size, bytes.byteLength);
    assert.equal(staged.record.sha256, expectedSha256);
  }

  const mismatched = await env.staging.stage({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "wrong-size.png",
    claimedMediaType: "image/png",
    bytes: PNG,
    idempotencyKey: "stage-wrong-size",
    expectedSize: PNG.byteLength + 1,
  });
  assert.deepEqual(mismatched, { kind: "invalid", code: "expected_size_mismatch" });

  const foreign = await env.staging.stage({
    actor: {
      ...env.currentActor,
      authentication: {
        ...env.currentActor.authentication,
        bindingOwnerId: "binding_owner_foreign",
      },
    },
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "foreign.png",
    claimedMediaType: "image/png",
    bytes: PNG,
    idempotencyKey: "stage-foreign",
  });
  assert.equal(foreign.kind, "staged");
  assert.equal(foreign.record.principalId, env.currentActor.principalId);
  assert.equal(
    foreign.record.principalMindUsageGenerationId,
    MOUNT_GENERATION_ID,
  );

  const expired = new BundleFileStagingService({
    authorizer: env.authorizer,
    metadata: env.metadata,
    objects: env.objects,
    clock: { now: () => "2026-08-05T14:00:00.000Z" },
  });
  assert.deepEqual(await expired.stage({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "diagram.png",
    claimedMediaType: "image/png",
    bytes: PNG,
    idempotencyKey: "stage-diagram.png",
    expectedSize: PNG.byteLength,
    expectedSha256: await env.objects.calculateSha256(PNG),
  }), { kind: "invalid", code: "staged_file_expired" });
  assert.equal(await env.metadata.readHead(MINDS.ordinary.spaceId), REVISIONS.initial.revisionId);
});

test("staging metadata failure removes the uncommitted provider object", async () => {
  const env = await harness();
  const staging = new BundleFileStagingService({
    authorizer: env.authorizer,
    metadata: {
      readPrincipalMindUsage: (principalId) =>
        env.metadata.readPrincipalMindUsage(principalId),
      validatePrincipalMindUsageWritePin: (pin) =>
        env.metadata.validatePrincipalMindUsageWritePin(pin),
      runCapacityTransaction: (operation) =>
        env.metadata.runCapacityTransaction(operation),
      releaseCapacityReservation: (request) =>
        env.metadata.releaseCapacityReservation(request),
      async runBundleFileStagingTransaction() {
        throw new Error("injected staging metadata failure");
      },
    },
    objects: env.objects,
    clock: { now: () => LATER },
    ids: { nextStagedBundleFileId: () => "staged_metadata_failure" },
  });
  await assert.rejects(staging.stage({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "failure.png",
    claimedMediaType: "image/png",
    bytes: PNG,
    idempotencyKey: "stage-metadata-failure",
  }), /injected staging metadata failure/u);
  assert.equal(await env.objects.getStagedBundleFile("staged_metadata_failure"), null);
  const [reservation] = await env.metadata.listCapacityReservationsForTest();
  assert.equal(reservation.state, "released");
});

test("opaque canonical dedupe is isolated by Space and Sites reconstructs staged metadata", async () => {
  const memory = new InMemoryObjectStore();
  const one = await memory.putBundleFile({
    spaceId: "space_one",
    bytes: PNG,
    mediaType: "image/png",
    createdAt: FIXED_NOW,
  });
  const memoryReclassified = await memory.putBundleFile({
    spaceId: "space_one",
    bytes: PNG,
    mediaType: "application/octet-stream",
    createdAt: OBJECT_REFRESH,
  });
  assert.equal(memoryReclassified.status, "already_exists");
  assert.equal(memoryReclassified.object.mediaType, "image/png");
  await memory.putBundleFile({
    spaceId: "space_two",
    bytes: PNG,
    mediaType: "image/png",
    createdAt: FIXED_NOW,
  });
  assert.equal(await memory.getBundleFile("space_missing", one.object.sha256), null);
  assert.deepEqual((await memory.getBundleFile("space_two", one.object.sha256)).bytes, PNG);
  const unreachable = await memory.putBundleFile({
    spaceId: "space_garbage",
    bytes: Uint8Array.from([...PNG, 0x02]),
    mediaType: "image/png",
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  const emptyMetadata = new InMemoryRevisionMetadataStore();
  const collector = new CanonicalRevisionCoordinator({
    objects: memory,
    revisions: emptyMetadata,
  });
  const collected = await collector.collectUnreachableObjects({
    createdBefore: "2026-08-02T00:00:00.000Z",
    limit: 10,
  });
  assert.equal(collected.deleted, 1);
  assert.equal(
    await memory.getBundleFile("space_garbage", unreachable.object.sha256),
    null,
  );

  const bucket = new FakeR2Bucket();
  const sitesObjects = await createSitesObjectStore(bucket);
  const sitesPut = await sitesObjects.putBundleFile({
    spaceId: "space_sites",
    bytes: PNG,
    mediaType: "image/png",
    createdAt: FIXED_NOW,
  });
  assert.deepEqual(
    (await sitesObjects.getBundleFile("space_sites", sitesPut.object.sha256)).bytes,
    PNG,
  );
  await sitesObjects.putStagedBundleFile({
    stagedFileId: "staged_sites_reclassification",
    bindingOwnerId: BINDING_OWNER_ID,
    spaceId: "space_sites",
    bytes: PNG,
    createdAt: FIXED_NOW,
  });
  const promotedReclassification = await sitesObjects.promoteStagedBundleFile({
    stagedFileId: "staged_sites_reclassification",
    bindingOwnerId: BINDING_OWNER_ID,
    spaceId: "space_sites",
    sha256: sitesPut.object.sha256,
    size: PNG.byteLength,
    mediaType: "application/octet-stream",
    createdAt: FIXED_NOW,
  });
  assert.equal(promotedReclassification.status, "already_exists");
  assert.equal(promotedReclassification.object.mediaType, "image/png");
  const refreshed = await sitesObjects.putBundleFile({
    spaceId: "space_sites",
    bytes: PNG,
    mediaType: "application/octet-stream",
    createdAt: OBJECT_REFRESH,
  });
  assert.equal(refreshed.status, "already_exists");
  assert.equal(refreshed.object.mediaType, "image/png");
  assert.equal(refreshed.object.protectedAt, OBJECT_REFRESH);
  assert.equal((await sitesObjects.listBundleFileObjects({
    createdBefore: "2026-08-07T12:30:00.000Z",
    excluded: [],
    limit: 10,
  })).length, 0);
  assert.equal(await sitesObjects.deleteBundleFileObject({
    spaceId: "space_sites",
    sha256: sitesPut.object.sha256,
    expectedProtectedAt: FIXED_NOW,
    createdBefore: "2026-08-08T00:00:00.000Z",
  }), false);

  const database = new FakeD1Database();
  const first = await createSitesMetadataStore(database);
  const record = {
    stagedFileId: "staged_sites_restart",
    bindingOwnerId: BINDING_OWNER_ID,
    sourceKind: "session_attachment",
    writeBindingId: WRITE_BINDING_ID,
    writeBindingGeneration: bindingVersion(1),
    spaceId: "space_sites",
    displayFilename: "diagram.png",
    mediaType: "image/png",
    sha256: sitesPut.object.sha256,
    size: PNG.byteLength,
    state: "verified",
    createdAt: FIXED_NOW,
    expiresAt: EXPIRY,
    consumedAt: null,
    rejectionCode: null,
  };
  const namespace = {
    principalId: PRINCIPALS.editor.principalId,
    bindingOwnerId: BINDING_OWNER_ID,
    spaceId: "space_sites",
    operation: "stage_bundle_file",
    key: "stage-sites-restart",
  };
  const created = await first.runBundleFileStagingTransaction(async (transaction) => {
    const staged = await transaction.createStagedBundleFile(
      record,
      268_435_456,
      FIXED_NOW,
    );
    const completed = await transaction.completeIdempotency({
      namespace,
      canonicalRequestHash: sitesPut.object.sha256,
      result: { kind: "stage_bundle_file", stagedFileId: record.stagedFileId },
      completedAt: FIXED_NOW,
    });
    return { staged, completed };
  });
  assert.equal(created.staged.kind, "created");
  assert.equal(created.completed.kind, "completed");
  const restarted = await createSitesMetadataStore(database);
  assert.deepEqual(await restarted.readStagedBundleFile(record.stagedFileId), record);
  const replay = await restarted.runBundleFileStagingTransaction((transaction) =>
    transaction.checkIdempotency({
      namespace,
      canonicalRequestHash: sitesPut.object.sha256,
    }),
  );
  assert.equal(replay.kind, "replay");
  assert.equal(replay.record.result.stagedFileId, record.stagedFileId);

  const bundleManifest = createRevisionManifest([{
    kind: "opaque",
    path: "assets/diagram.png",
    sha256: sitesPut.object.sha256,
    mediaType: "image/png",
    size: PNG.byteLength,
  }]);
  const bundleManifestHash = await sitesObjects.calculateSha256(
    new TextEncoder().encode(serializeRevisionManifest(bundleManifest)),
  );
  const bundleEnvelope = createCanonicalRevisionEnvelope({
    revisionId: "revision_sites_bundle_download",
    spaceId: "space_sites",
    revisionNumber: 1,
    parentRevisionId: null,
    committedAt: FIXED_NOW,
    committedBy: REVISION_AUTHORS.active,
    manifest: bundleManifest,
    manifestHash: bundleManifestHash,
    summary: "Sites durable BundleFile download",
  });
  assert.equal((await restarted.commitRevision({
    expectedHeadRevisionId: null,
    envelope: bundleEnvelope,
  })).kind, "committed");
  const secretVerifier = `hmac-sha256:export-download:v1:${"7".repeat(64)}`;
  const grant = {
    secretVerifier,
    requestedByPrincipalId: PRINCIPALS.editor.principalId,
    tokenId: TOKEN_ID,
    bindingOwnerId: BINDING_OWNER_ID,
    spaceId: "space_sites",
    revisionId: bundleEnvelope.revision.revisionId,
    path: "assets/diagram.png",
    mediaType: "image/png",
    sha256: sitesPut.object.sha256,
    size: PNG.byteLength,
    state: "active",
    createdAt: FIXED_NOW,
    expiresAt: EXPIRY,
    consumedAt: null,
  };
  assert.equal((await restarted.runBundleFileDownloadGrantTransaction(
    (transaction) => transaction.createBundleFileDownloadGrant(grant),
  )).kind, "created");
  const afterGrantRestart = await createSitesMetadataStore(database);
  const activeGrant = await afterGrantRestart.readBundleFileDownloadGrant(
    secretVerifier,
    FIXED_NOW,
  );
  assert.equal(activeGrant.kind, "active");
  assert.deepEqual(activeGrant.grant, grant);

  const competingRestart = await createSitesMetadataStore(database);
  const consumed = await Promise.all([
    afterGrantRestart.runBundleFileDownloadGrantTransaction((transaction) =>
      transaction.consumeBundleFileDownloadGrant(secretVerifier, LATER)),
    competingRestart.runBundleFileDownloadGrantTransaction((transaction) =>
      transaction.consumeBundleFileDownloadGrant(secretVerifier, LATER)),
  ]);
  assert.equal(consumed.every((result) => result.kind === "consumed"), true);
  assert.equal(consumed.filter((result) => "grant" in result).length, 1);
  const finalRestart = await createSitesMetadataStore(database);
  assert.deepEqual(
    await finalRestart.readBundleFileDownloadGrant(secretVerifier, LATER),
    { kind: "consumed" },
  );
});
