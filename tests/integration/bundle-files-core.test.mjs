import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import { InMemoryExactRevisionSearchIndex } from "@mind-diary/adapter-search-memory";
import { createSitesMetadataStore } from "@mind-diary/adapter-metadata-sites";
import { createSitesObjectStore } from "@mind-diary/adapter-object-sites";
import {
  BundleFileStagingService,
  CanonicalRevisionCoordinator,
  ChangesetCommitService,
  MindBindingContentAuthorizer,
} from "@mind-diary/application-content";
import { RevisionIndexJobHandler } from "@mind-diary/application-background";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";
import {
  CAPABILITIES,
  REVISION_MANIFEST_FORMAT_V1,
  REVISION_MANIFEST_FORMAT_V2,
  bindingVersion,
  createRevisionManifest,
  serializeRevisionManifest,
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
import { FakeD1Database, FakeR2Bucket } from "../../scripts/lib/fake-sites-storage.mjs";

const LATER = "2026-08-05T13:00:00.000Z";
const OBJECT_REFRESH = "2026-08-07T13:00:00.000Z";
const EXPIRY = "2026-11-05T12:00:00.000Z";
const TOKEN_ID = "token_bundle_file";
const BINDING_OWNER_ID = "binding_owner_bundle_file";
const WRITE_BINDING_ID = "write_binding_bundle_file";
const HASH = `sha256:${"a".repeat(64)}`;
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);

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

async function harness() {
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
  const revisions = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  await revisions.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: null,
    revisionId: REVISIONS.initial.revisionId,
    committedAt: REVISIONS.initial.committedAt,
    committedBy: REVISION_AUTHORS.active,
    summary: "BundleFile fixture",
    files: CANONICAL_REVISION_FILES,
  });
  const authorizer = new MindBindingContentAuthorizer({
    delegate: new CapabilityAuthorizer(metadata),
    bindings: metadata,
  });
  let stagedIds = 0;
  const staging = new BundleFileStagingService({
    authorizer,
    metadata,
    objects,
    clock: { now: () => LATER },
    ids: { nextStagedBundleFileId: () => `staged_bundle_${++stagedIds}` },
  });
  return { metadata, objects, revisions, authorizer, staging, currentActor };
}

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

test("staging rejects spoofed types and atomically consumes a binding-pinned ref", async () => {
  const env = await harness();
  const spoofed = await env.staging.stage({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "spoofed.png",
    claimedMediaType: "image/png",
    bytes: new TextEncoder().encode("<svg><script/></svg>"),
  });
  assert.deepEqual(spoofed, { kind: "invalid", code: "file_signature_mismatch" });

  const staged = await env.staging.stage({
    actor: env.currentActor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    displayFilename: "diagram.png",
    claimedMediaType: "image/png",
    bytes: PNG,
  });
  assert.equal(staged.kind, "staged");
  assert.equal(staged.record.state, "verified");

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
  assert.equal(committed.envelope.manifest.format, REVISION_MANIFEST_FORMAT_V2);
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
  assert.deepEqual(await cleanup.collectExpired(), {
    scanned: 1,
    deleted: 1,
    bytes: PNG.byteLength,
  });
  assert.equal(await env.metadata.readStagedBundleFile(staged.record.stagedFileId), null);
  assert.deepEqual(
    (await env.objects.getBundleFile(MINDS.ordinary.spaceId, staged.record.sha256)).bytes,
    PNG,
  );
});

test("opaque canonical dedupe is isolated by Space and Sites reconstructs staged metadata", async () => {
  const memory = new InMemoryObjectStore();
  const one = await memory.putBundleFile({
    spaceId: "space_one",
    bytes: PNG,
    mediaType: "image/png",
    createdAt: FIXED_NOW,
  });
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
  const refreshed = await sitesObjects.putBundleFile({
    spaceId: "space_sites",
    bytes: PNG,
    mediaType: "image/png",
    createdAt: OBJECT_REFRESH,
  });
  assert.equal(refreshed.status, "already_exists");
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
  const created = await first.runBundleFileStagingTransaction((transaction) =>
    transaction.createStagedBundleFile(record, 268_435_456, FIXED_NOW),
  );
  assert.equal(created.kind, "created");
  const restarted = await createSitesMetadataStore(database);
  assert.deepEqual(await restarted.readStagedBundleFile(record.stagedFileId), record);
});
