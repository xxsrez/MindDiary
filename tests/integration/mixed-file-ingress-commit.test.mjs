import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryLocalFileUploadIntentStore,
  InMemoryRevisionMetadataStore,
} from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  BundleFileStagingService,
  CanonicalRevisionCoordinator,
  ChangesetCommitFailure,
  ChangesetCommitService,
  DEFAULT_CHANGESET_PREFLIGHT_LIMITS,
  DeterministicOkfExportService,
  FileIngressCoordinator,
  GeneratedArtifactIngressService,
  LocalFileUploadIntentService,
  MindBindingContentAuthorizer,
  createLocalFileUploadIntentSecretCodec,
} from "@mind-diary/application-content";
import { createGoogleDriveConnectorIngress } from "@mind-diary/composition-root";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";
import { CAPABILITIES, bindingVersion, version } from "@mind-diary/domain";
import {
  CANONICAL_REVISION_FILES,
  FIXED_NOW,
  MINDS,
  PRINCIPALS,
  REVISION_AUTHORS,
  REVISIONS,
} from "@mind-diary/test-fixtures";

const START = "2026-08-25T13:00:00.000Z";
const AUTHORIZATION_RECORD_ID = "md_oauth_access_mixed_ingress";
const OWNER = "md_oauth_grant_mixed_ingress";
const WRITE = "write_binding_mixed_ingress";
const FOREIGN_AUTHORIZATION_RECORD_ID = "md_oauth_access_mixed_foreign";
const FOREIGN_OWNER = "md_oauth_grant_mixed_foreign";
const FOREIGN_WRITE = "write_binding_mixed_foreign";
const HASH = `sha256:${"a".repeat(64)}`;

const FIXTURES = Object.freeze({
  sessionDocx: Uint8Array.from([
    0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x73, 0x79, 0x6e, 0x74,
    0x68, 0x65, 0x74, 0x69, 0x63, 0x2d, 0x64, 0x6f, 0x63, 0x78,
  ]),
  localOpus: Uint8Array.from([
    0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x4f, 0x70, 0x75, 0x73, 0x48, 0x65,
    0x61, 0x64, 0x01, 0x02,
  ]),
  localHeic: Uint8Array.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    0x00, 0x00, 0x00, 0x00, 0x68, 0x65, 0x69, 0x63,
  ]),
  workspaceUnknown: Uint8Array.from([
    0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f, 0x80, 0xff, 0x21,
  ]),
  connector: Uint8Array.from([0x43, 0x4f, 0x4e, 0x4e, 0x45, 0x43, 0x54]),
  bounded: Uint8Array.from([0x42, 0x4f, 0x55, 0x4e, 0x44, 0x45, 0x44]),
  generated: Uint8Array.from([0x47, 0x45, 0x4e, 0x45, 0x52, 0x41, 0x54, 0x45, 0x44]),
});

const MIXED_MARKDOWN = `---
type: Engineering Fixture
title: Mixed ingress commit
description: Synthetic file-ingress integration evidence.
status: draft
---

# Mixed ingress commit

This fixture contains no private content.
`;

function actor(env, overrides = {}) {
  const principalId = overrides.principalId ?? PRINCIPALS.editor.principalId;
  return Object.freeze({
    kind: "registered_principal",
    principalId,
    authentication: Object.freeze({
      kind: "mcp_token",
      tokenId: overrides.tokenId ?? AUTHORIZATION_RECORD_ID,
      bindingOwnerId: overrides.bindingOwnerId ?? OWNER,
      effectiveScopes: Object.freeze(["content:read", "content:write"]),
    }),
    deploymentCapabilities: CAPABILITIES,
    requestId: overrides.requestId ?? "request_mixed_ingress",
    occurredAtUtc: env.clock.now(),
  });
}

function authorizationState({
  principalId = PRINCIPALS.editor.principalId,
  tokenId = AUTHORIZATION_RECORD_ID,
  spaceId = MINDS.ordinary.spaceId,
  role = "editor",
  tokenState = "active",
} = {}) {
  return Object.freeze({
    principal: Object.freeze({ principalId, state: "active" }),
    space: Object.freeze({
      spaceId,
      state: "active",
      visibility: "private",
      accessVersion: version(1),
    }),
    membership: Object.freeze({
      principalId,
      spaceId,
      role,
      state: "active",
      version: version(1),
    }),
    token: Object.freeze({
      tokenId,
      principalId,
      state: tokenState,
      scopes: Object.freeze(["content:read", "content:write"]),
      version: version(1),
      expiresAt: "2027-08-25T13:00:00.000Z",
    }),
  });
}

async function bindWrite(metadata, currentActor, spaceId, writeBindingId, suffix) {
  const result = await metadata.runMindBindingTransaction((transaction) =>
    transaction.applyWriteMindBinding({
      bindingOwnerId: currentActor.authentication.bindingOwnerId,
      principalId: currentActor.principalId,
      action: "bind",
      spaceId,
      writeBindingId,
      expectedBindingVersion: bindingVersion(0),
      idempotencyKey: `bind-${suffix}`,
      canonicalRequestHash: HASH,
      requestId: `request_bind_${suffix}`,
      auditEventId: `audit_bind_${suffix}`,
      auditOutboxMessageId: `outbox_bind_${suffix}`,
      occurredAt: currentActor.occurredAtUtc,
    }),
  );
  assert.equal(result.kind, "applied");
}

function chunks(bytes) {
  const split = Math.max(1, Math.floor(bytes.byteLength / 2));
  return (async function* () {
    yield bytes.subarray(0, split);
    if (split < bytes.byteLength) yield bytes.subarray(split);
  })();
}

function storedZipEntry(bytes, expectedPath) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 30 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    assert.equal(view.getUint16(offset + 8, true), 0);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const path = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    if (path === expectedPath) return bytes.slice(dataStart, dataStart + size);
    offset = dataStart + size;
  }
  return null;
}

async function harness() {
  let now = START;
  let stagedId = 0;
  let revisionId = 0;
  let intentId = 0;
  let claimId = 0;
  const clock = Object.freeze({
    now: () => now,
    set: (value) => { now = value; },
  });
  const metadata = new InMemoryRevisionMetadataStore();
  const objects = new InMemoryObjectStore();
  const env = { clock, metadata, objects };
  const currentActor = actor(env);
  metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: currentActor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      tokenId: AUTHORIZATION_RECORD_ID,
    },
    authorizationState(),
  );
  await bindWrite(metadata, currentActor, MINDS.ordinary.spaceId, WRITE, "mixed");

  const revisions = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  await revisions.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: null,
    revisionId: REVISIONS.initial.revisionId,
    committedAt: FIXED_NOW,
    committedBy: REVISION_AUTHORS.active,
    summary: "Mixed ingress fixture",
    files: CANONICAL_REVISION_FILES,
  });
  const authorizer = new MindBindingContentAuthorizer({
    delegate: new CapabilityAuthorizer(metadata),
    bindings: metadata,
    readAuthority: "legacy_mind_binding",
  });
  const staging = new BundleFileStagingService({
    authorizer,
    metadata,
    objects,
    clock,
    ids: { nextStagedBundleFileId: () => `staged_mixed_${++stagedId}` },
  });
  const commits = new ChangesetCommitService({
    authorizer,
    metadata,
    revisions,
    objects,
    clock,
    revisionIds: { nextRevisionId: () => `revision_mixed_${++revisionId}` },
  });
  const ingress = new FileIngressCoordinator({
    staging,
    commits,
    adapters: {
      session_attachment: {
        stage: (payload) => staging.stage({ ...payload, sourceKind: "session_attachment" }),
      },
    },
  });
  const intentStore = new InMemoryLocalFileUploadIntentStore();
  const secrets = await createLocalFileUploadIntentSecretCodec(
    new Uint8Array(32).fill(37),
  );
  const uploadIntents = new LocalFileUploadIntentService({
    authorizer,
    bindings: metadata,
    intents: intentStore,
    staging,
    digest: objects,
    clock,
    nextIntentId: () => `upload_intent_mixed_${++intentId}`,
    nextClaimId: () => `upload_claim_mixed_${++claimId}`,
    secrets,
    deploymentCapabilities: CAPABILITIES,
    issuerActorAllowed: () => true,
    leaseHeartbeatMilliseconds: 5,
  });
  return {
    ...env,
    authorizer,
    revisions,
    staging,
    commits,
    ingress,
    uploadIntents,
    currentActor: () => actor(env),
    nextRevisionId: () => `revision_mixed_${++revisionId}`,
  };
}

async function stageLocalIntent(env, sourceKind, filename, mediaType, bytes, key) {
  const sha256 = await env.objects.calculateSha256(bytes);
  const created = await env.uploadIntents.create(
    env.currentActor(),
    MINDS.ordinary.spaceId,
    {
      source_kind: sourceKind,
      write_binding_id: WRITE,
      display_filename: filename,
      claimed_media_type: mediaType,
      expected_size: bytes.byteLength,
      expected_sha256: sha256,
      idempotency_key: key,
    },
  );
  assert.equal(created.kind, "ready");
  const uploaded = await env.uploadIntents.upload({
    capability: created.uploadCapability,
    requestId: `request_upload_${key}`,
    stream: chunks(bytes),
  });
  assert.equal(uploaded.kind, "staged");
  return Object.freeze({
    record: uploaded.record,
    capability: created.uploadCapability,
  });
}

async function stageSmall(env, sourceKind, key) {
  const bytes = Uint8Array.from([key.length & 0xff, sourceKind.length & 0xff, 0x5a]);
  const result = await env.staging.stage({
    actor: env.currentActor(),
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE,
    displayFilename: `${key}.bin`,
    claimedMediaType: "application/octet-stream",
    bytes,
    sourceKind,
    idempotencyKey: `stage-${key}`,
  });
  assert.equal(result.kind, "staged");
  return result.record;
}

function commitRequest(env, key, operations, overrides = {}) {
  return Object.freeze({
    actor: env.currentActor(),
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE,
    expectedRevisionId: overrides.expectedRevisionId ?? REVISIONS.initial.revisionId,
    idempotencyKey: key,
    summary: overrides.summary ?? `Synthetic ${key}`,
    operations,
  });
}

function corruptingMetadata(metadata, mutate) {
  return new Proxy(metadata, {
    get(target, property) {
      if (property === "runContentCommitTransaction") {
        return (callback) => target.runContentCommitTransaction((transaction) =>
          callback(Object.freeze({
            ...transaction,
            stageContentCommitEffects: (request) =>
              transaction.stageContentCommitEffects(mutate(request)),
          })),
        );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("mixed ingress commits real source services atomically and reconciles every failure without privacy leakage", async () => {
  const env = await harness();
  const session = await env.ingress.stage({
    sourceKind: "session_attachment",
    payload: {
      actor: env.currentActor(),
      spaceId: MINDS.ordinary.spaceId,
      writeBindingId: WRITE,
      displayFilename: "synthetic-session.docx",
      claimedMediaType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: FIXTURES.sessionDocx,
      idempotencyKey: "stage-session-docx",
    },
  });
  assert.equal(session.kind, "staged");

  const localOpus = await stageLocalIntent(
    env,
    "local_path",
    "synthetic-local.opus",
    "audio/ogg",
    FIXTURES.localOpus,
    "intent-local-opus",
  );
  const localHeic = await stageLocalIntent(
    env,
    "local_path",
    "synthetic-local.heic",
    "image/heic",
    FIXTURES.localHeic,
    "intent-local-heic",
  );
  const workspace = await stageLocalIntent(
    env,
    "workspace/generated_artifact",
    "synthetic-workspace.bin",
    "application/x-private-test",
    FIXTURES.workspaceUnknown,
    "intent-workspace-unknown",
  );

  const connectorRepresentation = Object.freeze({ kind: "binary" });
  const connectorSha256 = await env.objects.calculateSha256(FIXTURES.connector);
  const connectorObjectId = "drive_mixed_connector_object";
  const connectorBindingRef = "drive_mixed_connector_binding";
  const connectorBearer = "drive_mixed_access_token_sensitive";
  const { ingress: connectorService, source: connectorSource } =
    createGoogleDriveConnectorIngress({
      selection: {
        bindingRef: connectorBindingRef,
        objectId: connectorObjectId,
      },
      grants: {
        async resolve() {
          return {
            kind: "authorized",
            accessToken: connectorBearer,
            grantFingerprint: "drive_mixed_grant_generation",
          };
        },
      },
      async fetcher(input, init) {
        const url = new URL(String(input));
        assert.equal(url.origin, "https://www.googleapis.com");
        assert.equal(
          new Headers(init.headers).get("authorization"),
          `Bearer ${connectorBearer}`,
        );
        if (url.searchParams.get("alt") === "media") {
          return new Response(FIXTURES.connector, {
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(FIXTURES.connector.byteLength),
            },
          });
        }
        return new Response(JSON.stringify({
          id: connectorObjectId,
          name: "synthetic-connector.bin",
          mimeType: "application/octet-stream",
          size: String(FIXTURES.connector.byteLength),
          sha256Checksum: connectorSha256.slice("sha256:".length),
          trashed: false,
          capabilities: { canDownload: true },
          version: "1",
          headRevisionId: "drive_mixed_revision_1",
          ownedByMe: true,
          owners: [{ permissionId: "drive_mixed_owner" }],
        }), {
          headers: { "content-type": "application/json" },
        });
      },
      staging: env.staging,
    });
  const connector = await connectorService.stage({
    actor: env.currentActor(),
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE,
    representation: connectorRepresentation,
    source: connectorSource,
    idempotencyKey: "stage-connector",
  });
  assert.equal(connector.kind, "staged");

  const generatedService = new GeneratedArtifactIngressService({ staging: env.staging });
  const bounded = await generatedService.stageBoundedInMemory({
    actor: env.currentActor(),
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE,
    displayFilename: "synthetic-bounded.bin",
    claimedMediaType: "application/octet-stream",
    idempotencyKey: "stage-bounded",
    bytes: FIXTURES.bounded,
  });
  assert.equal(bounded.kind, "staged");
  const boundedCopy = await generatedService.stageBoundedInMemory({
    actor: env.currentActor(),
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE,
    displayFilename: "synthetic-bounded-copy.bin",
    claimedMediaType: "application/octet-stream",
    idempotencyKey: "stage-bounded-copy",
    bytes: FIXTURES.bounded,
  });
  assert.equal(boundedCopy.kind, "staged");
  const generated = await generatedService.stageServerGenerated({
    actor: env.currentActor(),
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE,
    displayFilename: "synthetic-generated.bin",
    claimedMediaType: "application/octet-stream",
    idempotencyKey: "stage-generated",
    stream: chunks(FIXTURES.generated),
  });
  assert.equal(generated.kind, "staged");

  const staged = [
    ["assets/session.docx", FIXTURES.sessionDocx, session.record],
    ["assets/local.opus", FIXTURES.localOpus, localOpus.record],
    ["assets/local.heic", FIXTURES.localHeic, localHeic.record],
    ["assets/workspace.bin", FIXTURES.workspaceUnknown, workspace.record],
    ["assets/connector.bin", FIXTURES.connector, connector.record],
    ["assets/bounded.bin", FIXTURES.bounded, bounded.record],
    ["assets/bounded-copy.bin", FIXTURES.bounded, boundedCopy.record],
    ["assets/generated.bin", FIXTURES.generated, generated.record],
  ];
  const operations = [
    {
      type: "create_file",
      path: "concepts/mixed-ingress.md",
      text: MIXED_MARKDOWN,
    },
    ...staged.map(([path, _bytes, record]) => ({
      type: "create_bundle_file",
      path,
      staged_file_id: record.stagedFileId,
    })),
  ];
  const request = commitRequest(env, "commit-mixed-ingress", operations);
  const beforeAudits = await env.metadata.listAuditEventsForTest();
  const committed = await env.ingress.commit(request);
  assert.equal(committed.kind, "committed");
  assert.equal(committed.replayed, false);
  assert.equal(committed.envelope.revision.parentRevisionId, REVISIONS.initial.revisionId);
  assert.equal(committed.envelope.revision.revisionNumber, 2);
  assert.equal(await env.metadata.readHead(MINDS.ordinary.spaceId), "revision_mixed_1");
  assert.equal((await env.metadata.listRevisions(MINDS.ordinary.spaceId)).length, 2);

  for (const [path, bytes, record] of staged) {
    const entry = committed.envelope.manifest.entries.find(
      (candidate) => candidate.path === path,
    );
    assert.equal(entry?.kind, "opaque");
    assert.equal(entry?.size, bytes.byteLength);
    assert.equal(entry?.sha256, await env.objects.calculateSha256(bytes));
    assert.equal(
      (await env.metadata.readStagedBundleFile(record.stagedFileId))?.state,
      "consumed",
    );
  }
  const exact = await env.revisions.materialize(
    MINDS.ordinary.spaceId,
    committed.envelope.revision.revisionId,
  );
  for (const [path, bytes] of staged) {
    const file = exact.files.find((candidate) => candidate.path === path);
    assert.equal(file?.kind, "opaque");
    assert.equal(file?.bytes.byteLength, bytes.byteLength);
    assert.equal(
      await env.objects.calculateSha256(file.bytes),
      await env.objects.calculateSha256(bytes),
    );
  }
  const webExporter = new DeterministicOkfExportService({
    materializer: env.revisions,
    digest: env.objects,
  });
  const webExport = await webExporter.exportExactRevision({
    spaceId: MINDS.ordinary.spaceId,
    revisionId: committed.envelope.revision.revisionId,
    profile: "MD-BUNDLE-ZIP-1",
  });
  assert.deepEqual(
    storedZipEntry(webExport.bytes, "assets/connector.bin"),
    FIXTURES.connector,
  );

  const contentAudits = (await env.metadata.listAuditEventsForTest()).filter(
    (event) => event.eventType === "content.changeset_committed",
  );
  assert.equal(contentAudits.length, 1);
  assert.equal(
    (await env.metadata.listAuditEventsForTest()).length,
    beforeAudits.length + 1,
  );
  const receipt = JSON.parse(contentAudits[0].safeMetadata.staged_source_receipts);
  assert.deepEqual(
    receipt.map((item) => item.source_kind),
    [
      "bounded_in_memory",
      "bounded_in_memory",
      "connector_object",
      "local_path",
      "local_path",
      "server_generated",
      "session_attachment",
      "workspace/generated_artifact",
    ],
  );
  assert.equal(receipt[0].sha256, receipt[1].sha256);
  assert.equal(receipt.every((item) => /^sha256:[0-9a-f]{64}$/u.test(item.sha256)), true);
  const auditSource = JSON.stringify(contentAudits[0]);
  for (const forbidden of [
    "assets/",
    "synthetic-session.docx",
    "synthetic-local.opus",
    "synthetic-local.heic",
    "synthetic-workspace.bin",
    "staged_mixed_",
    "mdupload_v1_",
    localOpus.capability,
    localHeic.capability,
    workspace.capability,
  ]) assert.equal(auditSource.includes(forbidden), false);

  const reconciled = await env.ingress.reconcileCommit(request);
  assert.equal(reconciled.kind, "committed");
  assert.equal(reconciled.replayed, true);
  assert.equal(reconciled.envelope.revision.revisionId, committed.envelope.revision.revisionId);
  assert.equal((await env.metadata.listRevisions(MINDS.ordinary.spaceId)).length, 2);
  assert.equal(
    (await env.metadata.listAuditEventsForTest()).filter(
      (event) => event.eventType === "content.changeset_committed",
    ).length,
    1,
  );
  assert.deepEqual(
    await env.ingress.reconcileCommit({ ...request, summary: "Changed retry payload" }),
    { kind: "idempotency_conflict" },
  );

  const consumedRetry = await env.ingress.commit(commitRequest(
    env,
    "commit-consumed-ref",
    [{
      type: "create_bundle_file",
      path: "assets/consumed-again.bin",
      staged_file_id: session.record.stagedFileId,
    }],
    { expectedRevisionId: committed.envelope.revision.revisionId },
  ));
  assert.equal(consumedRetry.kind, "invalid");
  assert.equal(consumedRetry.error.code, "staged_bundle_file_not_verified");

  const staleRecord = await stageSmall(env, "bounded_in_memory", "stale-head");
  const stale = await env.ingress.commit(commitRequest(
    env,
    "commit-stale-head",
    [{
      type: "create_bundle_file",
      path: "assets/stale.bin",
      staged_file_id: staleRecord.stagedFileId,
    }],
  ));
  assert.equal(stale.kind, "revision_conflict");
  assert.equal(
    (await env.metadata.readStagedBundleFile(staleRecord.stagedFileId))?.state,
    "verified",
  );

  const duplicateA = await stageSmall(env, "bounded_in_memory", "duplicate-a");
  const duplicateB = await stageSmall(env, "server_generated", "duplicate-b");
  const duplicate = await env.ingress.commit(commitRequest(
    env,
    "commit-duplicate-path",
    [
      {
        type: "create_bundle_file",
        path: "assets/duplicate.bin",
        staged_file_id: duplicateA.stagedFileId,
      },
      {
        type: "create_bundle_file",
        path: "assets/duplicate.bin",
        staged_file_id: duplicateB.stagedFileId,
      },
    ],
    { expectedRevisionId: committed.envelope.revision.revisionId },
  ));
  assert.equal(duplicate.kind, "invalid");
  assert.equal(duplicate.error.code, "duplicate_operation_path");

  const aggregateA = await stageSmall(env, "bounded_in_memory", "aggregate-a");
  const aggregateB = await stageSmall(env, "server_generated", "aggregate-b");
  const aggregateCommits = new ChangesetCommitService({
    authorizer: env.authorizer,
    metadata: env.metadata,
    revisions: env.revisions,
    objects: env.objects,
    clock: env.clock,
    revisionIds: { nextRevisionId: env.nextRevisionId },
    preflightLimits: {
      ...DEFAULT_CHANGESET_PREFLIGHT_LIMITS,
      maxStagedBundleFileBytes: aggregateA.size + aggregateB.size - 1,
    },
  });
  const aggregate = await aggregateCommits.commit(commitRequest(
    env,
    "commit-aggregate-quota",
    [
      {
        type: "create_bundle_file",
        path: "assets/aggregate-a.bin",
        staged_file_id: aggregateA.stagedFileId,
      },
      {
        type: "create_bundle_file",
        path: "assets/aggregate-b.bin",
        staged_file_id: aggregateB.stagedFileId,
      },
    ],
    { expectedRevisionId: committed.envelope.revision.revisionId },
  ));
  assert.equal(aggregate.kind, "invalid");
  assert.equal(aggregate.error.code, "staged_bundle_file_byte_limit_exceeded");

  const revokedRecord = await stageSmall(env, "bounded_in_memory", "revoked");
  env.metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: PRINCIPALS.editor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      tokenId: AUTHORIZATION_RECORD_ID,
    },
    authorizationState({ tokenState: "revoked" }),
  );
  const revoked = await env.ingress.commit(commitRequest(
    env,
    "commit-revoked",
    [{
      type: "create_bundle_file",
      path: "assets/revoked.bin",
      staged_file_id: revokedRecord.stagedFileId,
    }],
    { expectedRevisionId: committed.envelope.revision.revisionId },
  ));
  assert.equal(revoked.kind, "denied");
  assert.equal(
    (await env.metadata.readStagedBundleFile(revokedRecord.stagedFileId))?.state,
    "verified",
  );
  env.metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: PRINCIPALS.editor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      tokenId: AUTHORIZATION_RECORD_ID,
    },
    authorizationState(),
  );

  const foreignActor = actor(env, {
    principalId: PRINCIPALS.outsider.principalId,
    tokenId: FOREIGN_AUTHORIZATION_RECORD_ID,
    bindingOwnerId: FOREIGN_OWNER,
    requestId: "request_mixed_foreign",
  });
  env.metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: foreignActor.principalId,
      spaceId: MINDS.personal.spaceId,
      tokenId: FOREIGN_AUTHORIZATION_RECORD_ID,
    },
    authorizationState({
      principalId: foreignActor.principalId,
      tokenId: FOREIGN_AUTHORIZATION_RECORD_ID,
      spaceId: MINDS.personal.spaceId,
      role: "owner",
    }),
  );
  await bindWrite(
    env.metadata,
    foreignActor,
    MINDS.personal.spaceId,
    FOREIGN_WRITE,
    "foreign",
  );
  const foreignStage = await env.staging.stage({
    actor: foreignActor,
    spaceId: MINDS.personal.spaceId,
    writeBindingId: FOREIGN_WRITE,
    displayFilename: "synthetic-foreign.bin",
    claimedMediaType: "application/octet-stream",
    bytes: Uint8Array.from([0xf0, 0x12, 0x34]),
    sourceKind: "bounded_in_memory",
    idempotencyKey: "stage-foreign",
  });
  assert.equal(foreignStage.kind, "staged");
  const foreign = await env.ingress.commit(commitRequest(
    env,
    "commit-foreign-ref",
    [{
      type: "create_bundle_file",
      path: "assets/foreign.bin",
      staged_file_id: foreignStage.record.stagedFileId,
    }],
    { expectedRevisionId: committed.envelope.revision.revisionId },
  ));
  assert.equal(foreign.kind, "invalid");
  assert.equal(foreign.error.code, "staged_bundle_file_binding_mismatch");

  assert.equal(await env.metadata.readHead(MINDS.ordinary.spaceId), "revision_mixed_1");
  assert.equal((await env.metadata.listRevisions(MINDS.ordinary.spaceId)).length, 2);
  assert.equal(
    (await env.metadata.listAuditEventsForTest()).filter(
      (event) => event.eventType === "content.changeset_committed",
    ).length,
    1,
  );

  const expiredEnv = await harness();
  const expiring = await stageSmall(expiredEnv, "bounded_in_memory", "expired");
  expiredEnv.clock.set("2026-08-25T14:00:00.001Z");
  const expired = await expiredEnv.ingress.commit(commitRequest(
    expiredEnv,
    "commit-expired",
    [{
      type: "create_bundle_file",
      path: "assets/expired.bin",
      staged_file_id: expiring.stagedFileId,
    }],
  ));
  assert.equal(expired.kind, "invalid");
  assert.equal(expired.error.code, "staged_bundle_file_expired");
  assert.equal(await expiredEnv.metadata.readHead(MINDS.ordinary.spaceId), REVISIONS.initial.revisionId);
  assert.equal((await expiredEnv.metadata.listRevisions(MINDS.ordinary.spaceId)).length, 1);

  const maximumEnv = await harness();
  const maximumRecords = [];
  for (let index = 0; index < 20; index += 1) {
    maximumRecords.push(await stageSmall(
      maximumEnv,
      index % 2 === 0 ? "bounded_in_memory" : "server_generated",
      `maximum-${index}`,
    ));
  }
  const maximum = await maximumEnv.ingress.commit(commitRequest(
    maximumEnv,
    "commit-maximum-receipts",
    maximumRecords.map((record, index) => ({
      type: "create_bundle_file",
      path: `assets/maximum-${index}.bin`,
      staged_file_id: record.stagedFileId,
    })),
  ));
  assert.equal(maximum.kind, "committed");
  const maximumAudit = (await maximumEnv.metadata.listAuditEventsForTest()).find(
    (event) => event.eventType === "content.changeset_committed",
  );
  assert.equal(
    JSON.parse(maximumAudit.safeMetadata.staged_source_receipts).length,
    20,
  );

  const overflowEnv = await harness();
  const overflowRecords = [];
  for (let index = 0; index < 21; index += 1) {
    overflowRecords.push(await stageSmall(
      overflowEnv,
      "bounded_in_memory",
      `overflow-${index}`,
    ));
  }
  const overflow = await overflowEnv.ingress.commit(commitRequest(
    overflowEnv,
    "commit-overflow-receipts",
    overflowRecords.map((record, index) => ({
      type: "create_bundle_file",
      path: `assets/overflow-${index}.bin`,
      staged_file_id: record.stagedFileId,
    })),
  ));
  assert.equal(overflow.kind, "invalid");
  assert.equal(overflow.error.code, "bundle_file_operation_limit_exceeded");
  assert.equal(await overflowEnv.metadata.readHead(MINDS.ordinary.spaceId), REVISIONS.initial.revisionId);
  assert.equal(
    (await overflowEnv.metadata.listAuditEventsForTest()).filter(
      (event) => event.eventType === "content.changeset_committed",
    ).length,
    0,
  );

  for (const mode of ["extra", "malformed"]) {
    const invalidEnv = await harness();
    const record = await stageSmall(invalidEnv, "bounded_in_memory", `audit-${mode}`);
    const metadata = corruptingMetadata(invalidEnv.metadata, (effects) => ({
      ...effects,
      auditEvent: {
        ...effects.auditEvent,
        safeMetadata: mode === "extra"
          ? { ...effects.auditEvent.safeMetadata, forbidden_extra: "x" }
          : {
              ...effects.auditEvent.safeMetadata,
              staged_source_receipts: "not-canonical-json",
            },
      },
    }));
    const service = new ChangesetCommitService({
      authorizer: invalidEnv.authorizer,
      metadata,
      revisions: invalidEnv.revisions,
      objects: invalidEnv.objects,
      clock: invalidEnv.clock,
      revisionIds: { nextRevisionId: invalidEnv.nextRevisionId },
    });
    await assert.rejects(
      service.commit(commitRequest(
        invalidEnv,
        `commit-audit-${mode}`,
        [{
          type: "create_bundle_file",
          path: `assets/audit-${mode}.bin`,
          staged_file_id: record.stagedFileId,
        }],
      )),
      (error) => error instanceof ChangesetCommitFailure &&
        error.code === "invalid_commit_effects",
    );
    assert.equal(
      await invalidEnv.metadata.readHead(MINDS.ordinary.spaceId),
      REVISIONS.initial.revisionId,
    );
    assert.equal((await invalidEnv.metadata.listRevisions(MINDS.ordinary.spaceId)).length, 1);
    assert.equal(
      (await invalidEnv.metadata.readStagedBundleFile(record.stagedFileId))?.state,
      "verified",
    );
    assert.equal(
      (await invalidEnv.metadata.listAuditEventsForTest()).filter(
        (event) => event.eventType === "content.changeset_committed",
      ).length,
      0,
    );
  }
});
