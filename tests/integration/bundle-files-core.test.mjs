import assert from "node:assert/strict";
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
const HASH = `sha256:${"a".repeat(64)}`;
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);
const PNG_REPLACEMENT = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x02,
]);
const PDF = new TextEncoder().encode("%PDF-1.7\n");
const ZIP = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);

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
    ...(capacityLimits === undefined ? {} : { capacityLimits }),
  });
  return { metadata, objects, revisions, authorizer, staging, currentActor };
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
    idempotencyKey: "stage-spoofed-file",
  });
  assert.deepEqual(spoofed, { kind: "invalid", code: "unsupported_bundle_file_type" });

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
  assert.equal(committed.envelope.manifest.format, REVISION_MANIFEST_FORMAT_V3);
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
  const interrupted = await env.metadata.collectStagedBundleFilesForGc({
    createdBefore: "2026-08-07T13:55:00.000Z",
    limit: 1,
  });
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].state, "expired");
  assert.deepEqual(await cleanup.collectExpired(), {
    scanned: 1,
    deleted: 1,
    bytes: PNG.byteLength,
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
  const stagedFiles = [];
  for (const [path, mediaType, bytes] of [
    ["assets/diagram.png", "image/png", PNG],
    ["assets/справка.pdf", "application/pdf", PDF],
    ["assets/archive.zip", "application/zip", ZIP],
  ]) {
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
    stagedFiles.push({ path, staged });
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
  const issueDirectGrant = async (entry) => {
    const issued = await crypto.issueSecret();
    const created = await env.metadata.runBundleFileDownloadGrantTransaction(
      (transaction) => transaction.createBundleFileDownloadGrant({
        secretVerifier: issued.verifier(),
        requestedByPrincipalId: env.currentActor.principalId,
        tokenId: TOKEN_ID,
        bindingOwnerId: BINDING_OWNER_ID,
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
    objects: env.objects,
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
    objects: env.objects,
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
  assert.doesNotMatch(JSON.stringify(issuedByApplication.file), /bytes|url|provider/iu);
  const applicationSecret = new URL(issuedByApplication.downloadUrl).pathname.split("/").at(-1);
  const applicationDownload = await issuingService.download(serviceActor, applicationSecret);
  assert.equal(applicationDownload.kind, "download");
  assert.deepEqual(applicationDownload.bytes, PNG);
  env.metadata.setCurrentAuthorizationStateForTest(authorizationKey, authorizationState());

  const pngEntry = committed.envelope.manifest.entries.find(
    (candidate) => candidate.path === "assets/diagram.png",
  );
  const secret = await issueDirectGrant(pngEntry);
  const results = await Promise.all([
    service.download(serviceActor, secret),
    service.download(serviceActor, secret),
  ]);
  const download = results.find((result) => result.kind === "download");
  assert.equal(results.filter((result) => result.kind === "download").length, 1);
  assert.equal(results.filter((result) => result.kind === "not_found").length, 1);
  assert.deepEqual(download.bytes, PNG);
  assert.equal(download.headers["Content-Type"], "image/png");
  assert.equal(download.headers["Content-Length"], String(PNG.byteLength));
  assert.equal(download.headers["Cache-Control"], "no-store");
  assert.equal(download.headers["Cross-Origin-Resource-Policy"], "same-origin");
  assert.match(download.headers["Content-Disposition"], /^inline;/u);
  assert.equal(download.headers["Content-Security-Policy"], "sandbox");

  for (const [path, expectedBytes] of [
    ["assets/справка.pdf", PDF],
    ["assets/archive.zip", ZIP],
  ]) {
    const entry = committed.envelope.manifest.entries.find(
      (candidate) => candidate.path === path,
    );
    const result = await service.download(serviceActor, await issueDirectGrant(entry));
    assert.equal(result.kind, "download");
    assert.deepEqual(result.bytes, expectedBytes);
    assert.match(result.headers["Content-Disposition"], /^attachment;/u);
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
  assert.deepEqual(
    await service.download(serviceActor, revokedSecret),
    { kind: "not_found" },
  );

  env.metadata.setCurrentAuthorizationStateForTest(authorizationKey, authorizationState());
  const unauthorizedSecret = await issueDirectGrant(pngEntry);
  env.metadata.setCurrentAuthorizationStateForTest(authorizationKey, {
    ...authorizationState(),
    membership: null,
  });
  assert.deepEqual(
    await service.download(serviceActor, unauthorizedSecret),
    { kind: "not_found" },
  );

  env.metadata.setCurrentAuthorizationStateForTest(authorizationKey, authorizationState());
  const expiredSecret = await issueDirectGrant(pngEntry);
  const expiredService = new BundleFileDownloadService({
    store: env.metadata,
    objects: env.objects,
    authorizer: env.authorizer,
    host: verifiedSpaceHost("mind-diary.test"),
    clock: { now: () => "2026-08-05T13:06:00.000Z" },
    secrets: crypto,
    downloadUrlBase: "https://mind-diary.test/api/bundle-download",
  });
  assert.deepEqual(
    await expiredService.download(serviceActor, expiredSecret),
    { kind: "not_found" },
  );

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
    4,
  );
  await env.metadata.purgeSpaceTargetRecords(MINDS.ordinary.spaceId);
  assert.deepEqual(await env.metadata.listBundleFileDownloadGrantsForTest(), []);
  assert.deepEqual(
    await service.download(serviceActor, deletedSecret),
    { kind: "not_found" },
  );
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
  assert.equal(foreign.kind, "denied");

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
