import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  CanonicalRevisionCoordinator,
  CanonicalRevisionError,
  ChangesetCommitService,
  ChangesetPreflightService,
} from "@mind-diary/application-content";
import {
  CapabilityAuthorizer,
  REVISION_MANIFEST_MEDIA_TYPE,
} from "@mind-diary/application-ports";
import {
  CAPABILITIES,
  MARKDOWN_MEDIA_TYPE,
  REVISION_MANIFEST_FORMAT_V3,
  REVISION_MANIFEST_FORMAT_V4,
  REVISION_MANIFEST_FORMAT_V5,
  createCanonicalRevisionEnvelope,
  createRevisionManifest,
  serializeRevisionManifest,
  version,
} from "@mind-diary/domain";
import { FIXED_NOW, MINDS, PRINCIPALS } from "@mind-diary/test-fixtures";

const ENCODER = new TextEncoder();
const INITIAL_REVISION = "revision_delta_large_initial";
const OBJECT_CUTOFF = "2026-08-23T00:00:00.000Z";

function concept(index, suffix = "baseline") {
  return `---\ntype: Reference\ntitle: Concept ${index}\n---\n\n# Concept ${index}\n\n${suffix}\n`;
}

function actor() {
  return {
    kind: "registered_principal",
    principalId: PRINCIPALS.editor.principalId,
    authentication: {
      kind: "mcp_token",
      tokenId: "token_delta_large",
      bindingOwnerId: "token_delta_large",
      effectiveScopes: ["content:read", "content:write"],
    },
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_delta_large",
    occurredAtUtc: FIXED_NOW,
  };
}

function authorizationState(currentActor) {
  return {
    principal: { principalId: currentActor.principalId, state: "active" },
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
      expiresAt: "2026-11-03T12:00:00.000Z",
    },
  };
}

function principalMountedMetadata(metadata) {
  const generation = Object.freeze({
    principalId: PRINCIPALS.editor.principalId,
    spaceId: MINDS.ordinary.spaceId,
    generationId: "usage_generation_delta_storage",
  });
  const readUsage = async (principalId) => principalId === generation.principalId
    ? Object.freeze({
        principalId,
        entries: Object.freeze([Object.freeze({
          principalId,
          spaceId: generation.spaceId,
          usageMode: "read_write",
          writeGeneration: generation,
        })]),
      })
    : null;
  const validatePin = async (pin) =>
    pin.principalId === generation.principalId &&
    pin.spaceId === generation.spaceId &&
    pin.generationId === generation.generationId;
  const wrapTransaction = (transaction) => Object.freeze({
    ...transaction,
    readPrincipalMindUsage: readUsage,
    validatePrincipalMindUsageWritePin: validatePin,
  });
  return new Proxy(metadata, {
    get(target, property) {
      if (property === "readPrincipalMindUsage") return readUsage;
      if (property === "validatePrincipalMindUsageWritePin") return validatePin;
      if (property === "runContentCommitTransaction") {
        return (operation) => target.runContentCommitTransaction((transaction) =>
          operation(wrapTransaction(transaction)));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function countedStore(objects, { markdownReadDelayMs = 0 } = {}) {
  const metrics = {
    markdownReadBytes: 0,
    markdownReadCount: 0,
    markdownReadActive: 0,
    markdownReadMaximum: 0,
    markdownPutBytes: 0,
    markdownPutCount: 0,
    manifestReadBytes: 0,
    manifestPutBytes: 0,
    manifestPutCount: 0,
  };
  const reset = () => Object.keys(metrics).forEach((key) => { metrics[key] = 0; });
  const store = new Proxy(objects, {
    get(target, property) {
      if (property === "getSpaceCanonicalObject") {
        return async (kind, spaceId, digest) => {
          if (kind === "markdown") {
            metrics.markdownReadCount += 1;
            metrics.markdownReadActive += 1;
            metrics.markdownReadMaximum = Math.max(
              metrics.markdownReadMaximum,
              metrics.markdownReadActive,
            );
          }
          try {
            if (kind === "markdown" && markdownReadDelayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, markdownReadDelayMs));
            }
            const result = await target.getSpaceCanonicalObject(kind, spaceId, digest);
            if (result) {
              if (kind === "markdown") metrics.markdownReadBytes += result.size;
              else metrics.manifestReadBytes += result.size;
            }
            return result;
          } finally {
            if (kind === "markdown") metrics.markdownReadActive -= 1;
          }
        };
      }
      if (property === "putSpaceCanonicalObject") {
        return async (request) => {
          const result = await target.putSpaceCanonicalObject(request);
          if (request.kind === "markdown") {
            metrics.markdownPutBytes += request.bytes.byteLength;
            metrics.markdownPutCount += 1;
          } else {
            metrics.manifestPutBytes += request.bytes.byteLength;
            metrics.manifestPutCount += 1;
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { store, metrics, reset };
}

async function seedLargeV3(objects, metadata, fileCount = 2_000, withIndex = false) {
  const entries = [];
  for (let index = 0; index < fileCount; index += 1) {
    const path = `concepts/concept-${String(index).padStart(4, "0")}.md`;
    const bytes = ENCODER.encode(concept(index));
    const put = await objects.putSpaceCanonicalObject({
      kind: "markdown",
      spaceId: MINDS.ordinary.spaceId,
      bytes,
      mediaType: MARKDOWN_MEDIA_TYPE,
      createdAt: "2026-08-22T17:00:00.000Z",
    });
    entries.push({
      kind: "markdown",
      path,
      sha256: put.object.sha256,
      mediaType: MARKDOWN_MEDIA_TYPE,
      size: put.object.size,
    });
  }
  if (withIndex) {
    const text = `---\nokf_version: "0.2"\n---\n\n# Large Mind\n\n${
      Array.from({ length: fileCount }, (_, index) => {
        const suffix = String(index).padStart(4, "0");
        return `- [Concept ${index}](concepts/concept-${suffix}.md)`;
      }).join("\n")
    }\n`;
    const put = await objects.putSpaceCanonicalObject({
      kind: "markdown",
      spaceId: MINDS.ordinary.spaceId,
      bytes: ENCODER.encode(text),
      mediaType: MARKDOWN_MEDIA_TYPE,
      createdAt: "2026-08-22T17:00:00.000Z",
    });
    entries.push({
      kind: "markdown",
      path: "index.md",
      sha256: put.object.sha256,
      mediaType: MARKDOWN_MEDIA_TYPE,
      size: put.object.size,
    });
  }
  const manifest = createRevisionManifest(entries, REVISION_MANIFEST_FORMAT_V3);
  const manifestObject = await objects.putSpaceCanonicalObject({
    kind: "revision_manifest",
    spaceId: MINDS.ordinary.spaceId,
    bytes: ENCODER.encode(serializeRevisionManifest(manifest)),
    mediaType: REVISION_MANIFEST_MEDIA_TYPE,
    createdAt: "2026-08-22T17:00:00.000Z",
  });
  const envelope = createCanonicalRevisionEnvelope({
    revisionId: INITIAL_REVISION,
    spaceId: MINDS.ordinary.spaceId,
    revisionNumber: 1,
    parentRevisionId: null,
    committedAt: "2026-08-22T17:00:00.000Z",
    committedBy: { kind: "principal", principalId: PRINCIPALS.editor.principalId },
    manifest,
    manifestHash: manifestObject.object.sha256,
    manifestSize: manifestObject.object.size,
    summary: "Large v3 fixture",
  });
  assert.equal(
    (await metadata.commitRevision({ expectedHeadRevisionId: null, envelope })).kind,
    "committed",
  );
  return envelope;
}

test("producer additive validation reads only changed files and the retained root projection", async () => {
  const objects = new InMemoryObjectStore();
  const metadata = principalMountedMetadata(new InMemoryRevisionMetadataStore());
  const fileCount = 500;
  const initial = await seedLargeV3(objects, metadata, fileCount, true);
  const counted = countedStore(objects, { markdownReadDelayMs: 2 });
  const revisions = new CanonicalRevisionCoordinator({
    objects: counted.store,
    revisions: metadata,
  });
  const currentActor = actor();
  metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: currentActor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      tokenId: currentActor.authentication.tokenId,
    },
    authorizationState(currentActor),
  );
  const service = new ChangesetCommitService({
    authorizer: new CapabilityAuthorizer(metadata),
    metadata,
    revisions,
    objects: counted.store,
    clock: { now: () => "2026-08-22T18:14:00.000Z" },
    revisionIds: { nextRevisionId: () => "revision_delta_producer_proof" },
  });
  const indexEntry = initial.manifest.entries.find((entry) => entry.path === "index.md");
  const indexObject = await objects.getSpaceCanonicalObject(
    "markdown",
    MINDS.ordinary.spaceId,
    indexEntry.sha256,
  );
  const currentIndex = new TextDecoder().decode(indexObject.bytes);
  const newPath = `concepts/concept-${fileCount}.md`;
  const newIndex = `${currentIndex.trimEnd()}\n- [Concept ${fileCount}](${newPath})\n`;

  counted.reset();
  const proof = await service.commit({
    actor: currentActor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: INITIAL_REVISION,
    idempotencyKey: "producer-proof-chain",
    summary: "Establish exact producer-valid parent proof",
    producerProfile: true,
    operations: [{
      type: "replace_file",
      path: "concepts/concept-0000.md",
      text: concept(0, "producer proof candidate"),
    }],
  });
  assert.equal(proof.kind, "committed");
  assert.equal(
    proof.envelope.revision.producerCertificate.spaceId,
    MINDS.ordinary.spaceId,
  );
  assert.equal(
    proof.envelope.revision.producerCertificate.revisionId,
    proof.envelope.revision.revisionId,
  );
  assert.equal(
    proof.envelope.revision.producerCertificate.manifestFingerprint,
    proof.envelope.revision.manifestHash,
  );
  assert.ok(proof.envelope.revision.producerCertificate.files.length > fileCount);
  assert.ok(counted.metrics.markdownReadBytes > indexObject.size);
  assert.ok(counted.metrics.markdownReadMaximum > 1);
  assert.ok(counted.metrics.markdownReadMaximum <= 8);
  assert.ok(counted.metrics.markdownReadCount >= fileCount);

  counted.reset();
  const additive = await service.preflight({
    actor: currentActor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: proof.envelope.revision.revisionId,
    producerProfile: true,
    operations: [{
      type: "create_file",
      path: newPath,
      text: concept(fileCount, "incremental producer"),
    }, {
      type: "replace_index",
      path: "index.md",
      text: newIndex,
      expected_sha256: indexEntry.sha256,
    }],
  });
  assert.equal(additive.kind, "ready");
  assert.equal(counted.metrics.markdownReadBytes, indexObject.size);

  counted.reset();
  const invalidating = await service.preflight({
    actor: currentActor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: proof.envelope.revision.revisionId,
    producerProfile: true,
    operations: [{
      type: "replace_index",
      path: "index.md",
      text: currentIndex.replace(/^.*concept-0000\.md.*\n/mu, ""),
      expected_sha256: indexEntry.sha256,
    }],
  });
  assert.equal(invalidating.kind, "ready");
  assert.ok(counted.metrics.markdownReadBytes > indexObject.size);

  const restartedMetadata = principalMountedMetadata(
    InMemoryRevisionMetadataStore.fromDurableSnapshot(metadata.exportDurableSnapshot()),
  );
  const restartedCoordinator = new CanonicalRevisionCoordinator({
    objects: counted.store,
    revisions: restartedMetadata,
  });
  const restartedPreflight = new ChangesetPreflightService({
    authorizer: new CapabilityAuthorizer(restartedMetadata),
    revisions: restartedCoordinator,
    clock: { now: () => "2026-08-22T18:14:00.000Z" },
  });
  counted.reset();
  const afterRestart = await restartedPreflight.preflight({
    actor: currentActor,
    spaceId: MINDS.ordinary.spaceId,
    revisionMode: "head",
    expectedRevisionId: proof.envelope.revision.revisionId,
    producerProfile: true,
    operations: [{
      type: "create_file",
      path: "concepts/after-restart.md",
      text: concept(fileCount + 1, "incremental after restart"),
    }, {
      type: "replace_index",
      path: "index.md",
      text: `${currentIndex.trimEnd()}\n- [After restart](concepts/after-restart.md)\n`,
      expected_sha256: proof.envelope.manifest.entries.find((entry) => entry.path === "index.md").sha256,
    }],
  });
  assert.equal(afterRestart.kind, "ready");
  assert.equal(counted.metrics.markdownReadBytes, indexObject.size);

  counted.reset();
  const inboundDelete = await restartedPreflight.preflight({
    actor: currentActor,
    spaceId: MINDS.ordinary.spaceId,
    revisionMode: "head",
    expectedRevisionId: proof.envelope.revision.revisionId,
    producerProfile: true,
    operations: [{
      type: "delete_file",
      path: "concepts/concept-0001.md",
    }],
  });
  assert.equal(inboundDelete.kind, "invalid");
  assert.ok(inboundDelete.error.diagnostics.some(
    (diagnostic) => diagnostic.code === "markdown_file_missing",
  ));
  assert.equal(counted.metrics.markdownReadBytes, 0);

  counted.reset();
  const missingAnchor = await restartedPreflight.preflight({
    actor: currentActor,
    spaceId: MINDS.ordinary.spaceId,
    revisionMode: "head",
    expectedRevisionId: proof.envelope.revision.revisionId,
    producerProfile: true,
    operations: [{
      type: "replace_file",
      path: "concepts/concept-0003.md",
      text: `${concept(3, "anchor check")}\n[Missing section](concept-0004.md#absent)\n`,
    }],
  });
  assert.equal(missingAnchor.kind, "invalid");
  assert.ok(missingAnchor.error.diagnostics.some(
    (diagnostic) => diagnostic.code === "markdown_section_missing",
  ));
  assert.equal(counted.metrics.markdownReadBytes, 0);

  counted.reset();
  const mixedCycle = await restartedPreflight.preflight({
    actor: currentActor,
    spaceId: MINDS.ordinary.spaceId,
    revisionMode: "head",
    expectedRevisionId: proof.envelope.revision.revisionId,
    producerProfile: true,
    operations: [{
      type: "create_file",
      path: "concepts/mixed-a.md",
      text: `${concept("mixed-a", "cycle A")}\n[Cycle B](mixed-b.md)\n`,
    }, {
      type: "create_file",
      path: "concepts/mixed-b.md",
      text: `${concept("mixed-b", "cycle B")}\n[Cycle A](mixed-a.md)\n`,
    }, {
      type: "replace_file",
      path: "concepts/concept-0003.md",
      text: `${concept(3, "bridge to cycle")}\n[Cycle A](mixed-a.md)\n`,
    }],
  });
  assert.equal(mixedCycle.kind, "ready");
  assert.equal(mixedCycle.validation.valid, true);
  assert.equal(counted.metrics.markdownReadBytes, 0);

  const parentEnvelope = await restartedCoordinator.readHeadRevisionEnvelope(
    MINDS.ordinary.spaceId,
  );
  assert.ok(parentEnvelope?.revision.producerCertificate);
  const corruptCertificate = Object.freeze({
    ...parentEnvelope.revision.producerCertificate,
    dependencyFingerprint: `sha256:${"0".repeat(64)}`,
  });
  const corruptEnvelope = Object.freeze({
    ...parentEnvelope,
    revision: Object.freeze({
      ...parentEnvelope.revision,
      producerCertificate: corruptCertificate,
    }),
  });
  const corruptReader = {
    readHeadRevisionEnvelope: async () => corruptEnvelope,
    readRevisionFile: restartedCoordinator.readRevisionFile.bind(restartedCoordinator),
  };
  const corruptPreflight = new ChangesetPreflightService({
    authorizer: new CapabilityAuthorizer(restartedMetadata),
    revisions: corruptReader,
    clock: { now: () => "2026-08-22T18:14:00.000Z" },
  });
  counted.reset();
  const staleCertificate = await corruptPreflight.preflight({
    actor: currentActor,
    spaceId: MINDS.ordinary.spaceId,
    revisionMode: "head",
    expectedRevisionId: proof.envelope.revision.revisionId,
    producerProfile: true,
    operations: [{
      type: "create_file",
      path: "concepts/after-corruption.md",
      text: concept(fileCount + 2, "full fallback after certificate mismatch"),
    }],
  });
  assert.equal(staleCertificate.kind, "ready");
  assert.ok(counted.metrics.markdownReadBytes > indexObject.size);
  assert.ok(counted.metrics.markdownReadMaximum > 1);
  assert.ok(counted.metrics.markdownReadMaximum <= 8);
});

test("producer additive validation cannot trust an unproved consumer-warning parent", async () => {
  const objects = new InMemoryObjectStore();
  const metadata = principalMountedMetadata(new InMemoryRevisionMetadataStore());
  const warningRevisionId = "revision_delta_warning_initial";
  const files = [{
    path: "index.md",
    text: "---\nokf_version: \"0.2\"\n---\n\n# Warning parent\n\n- [Warning](concepts/warning.md)\n",
  }, {
    path: "concepts/warning.md",
    text: "---\ntype: Generated Knowledge\nstatus: reviewed\n---\n\n# Warning\n",
  }];
  const entries = [];
  for (const file of files) {
    const put = await objects.putSpaceCanonicalObject({
      kind: "markdown",
      spaceId: MINDS.ordinary.spaceId,
      bytes: ENCODER.encode(file.text),
      mediaType: MARKDOWN_MEDIA_TYPE,
      createdAt: "2026-08-22T17:00:00.000Z",
    });
    entries.push({
      kind: "markdown",
      path: file.path,
      sha256: put.object.sha256,
      mediaType: MARKDOWN_MEDIA_TYPE,
      size: put.object.size,
    });
  }
  const manifest = createRevisionManifest(entries, REVISION_MANIFEST_FORMAT_V4);
  const manifestObject = await objects.putSpaceCanonicalObject({
    kind: "revision_manifest",
    spaceId: MINDS.ordinary.spaceId,
    bytes: ENCODER.encode(serializeRevisionManifest(manifest)),
    mediaType: REVISION_MANIFEST_MEDIA_TYPE,
    createdAt: "2026-08-22T17:00:00.000Z",
  });
  const envelope = createCanonicalRevisionEnvelope({
    revisionId: warningRevisionId,
    spaceId: MINDS.ordinary.spaceId,
    revisionNumber: 1,
    parentRevisionId: null,
    committedAt: "2026-08-22T17:00:00.000Z",
    committedBy: { kind: "principal", principalId: PRINCIPALS.editor.principalId },
    manifest,
    manifestHash: manifestObject.object.sha256,
    manifestSize: manifestObject.object.size,
    summary: "Consumer-valid warning fixture",
  });
  assert.equal(
    (await metadata.commitRevision({ expectedHeadRevisionId: null, envelope })).kind,
    "committed",
  );
  const currentActor = actor();
  metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: currentActor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      tokenId: currentActor.authentication.tokenId,
    },
    authorizationState(currentActor),
  );
  const preflight = new ChangesetPreflightService({
    authorizer: new CapabilityAuthorizer(metadata),
    revisions: new CanonicalRevisionCoordinator({ objects, revisions: metadata }),
    clock: { now: () => "2026-08-22T18:14:00.000Z" },
  });
  const indexEntry = entries.find((entry) => entry.path === "index.md");
  const nextPath = "concepts/new.md";
  const result = await preflight.preflight({
    actor: currentActor,
    spaceId: MINDS.ordinary.spaceId,
    revisionMode: "head",
    expectedRevisionId: warningRevisionId,
    producerProfile: true,
    operations: [{
      type: "create_file",
      path: nextPath,
      text: concept(2, "new producer file"),
    }, {
      type: "replace_index",
      path: "index.md",
      text: `${files[0].text.trimEnd()}\n- [New](${nextPath})\n`,
      expected_sha256: indexEntry.sha256,
    }],
  });

  assert.equal(result.kind, "invalid");
  assert.equal(result.error.code, "okf_validation_failed");
  assert.ok(result.error.diagnostics.some(
    (diagnostic) => diagnostic.code === "invalid_lifecycle_status",
  ));
});

test("small add/update/delete over a large v3 Mind read no unchanged content and write only delta plus manifest", async () => {
  const objects = new InMemoryObjectStore();
  const metadata = principalMountedMetadata(new InMemoryRevisionMetadataStore());
  const initial = await seedLargeV3(objects, metadata);
  const counted = countedStore(objects);
  const revisions = new CanonicalRevisionCoordinator({
    objects: counted.store,
    revisions: metadata,
  });
  const currentActor = actor();
  metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: currentActor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      tokenId: currentActor.authentication.tokenId,
    },
    authorizationState(currentActor),
  );
  const ids = ["revision_delta_update", "revision_delta_add", "revision_delta_delete"];
  const service = new ChangesetCommitService({
    authorizer: new CapabilityAuthorizer(metadata),
    metadata,
    revisions,
    objects: counted.store,
    clock: { now: () => "2026-08-22T18:15:00.000Z" },
    revisionIds: { nextRevisionId: () => ids.shift() },
  });
  const sentinel = initial.manifest.entries.find(
    (entry) => entry.path === "concepts/concept-1999.md",
  );

  const preflight = new ChangesetPreflightService({
    authorizer: new CapabilityAuthorizer(metadata),
    revisions,
    clock: { now: () => "2026-08-22T18:14:00.000Z" },
  });
  counted.reset();
  const brokenLink = await preflight.preflight({
    actor: currentActor,
    spaceId: MINDS.ordinary.spaceId,
    revisionMode: "head",
    expectedRevisionId: INITIAL_REVISION,
    operations: [{
      type: "replace_file",
      path: "concepts/concept-0000.md",
      text: `${concept(0, "link diagnostic")}\n[Missing](missing.md)\n`,
    }],
  });
  assert.equal(brokenLink.kind, "ready");
  assert.equal(counted.metrics.markdownReadBytes, 0);
  assert.ok(brokenLink.validation.qualityWarnings.some(
    (warning) => warning.code === "broken_cross_link",
  ));

  const replacement = concept(0, "one-line update");
  counted.reset();
  const updated = await service.commit({
    actor: currentActor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: INITIAL_REVISION,
    idempotencyKey: "delta-update",
    summary: "Update one file",
    operations: [{
      type: "replace_file",
      path: "concepts/concept-0000.md",
      text: replacement,
    }],
  });
  assert.equal(updated.kind, "committed");
  assert.equal(counted.metrics.markdownReadBytes, 0);
  assert.equal(counted.metrics.markdownPutBytes, ENCODER.encode(replacement).byteLength);
  assert.equal(counted.metrics.markdownPutCount, 1);
  assert.equal(counted.metrics.manifestPutCount, 1);
  assert.ok(counted.metrics.manifestReadBytes > 0);
  assert.equal(
    updated.envelope.manifest.entries.find((entry) => entry.path === sentinel.path).sha256,
    sentinel.sha256,
  );

  const addedText = concept(2000, "new delta file");
  counted.reset();
  const added = await service.commit({
    actor: currentActor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: updated.envelope.revision.revisionId,
    idempotencyKey: "delta-add",
    summary: "Add one file",
    operations: [{
      type: "create_file",
      path: "concepts/concept-2000.md",
      text: addedText,
    }],
  });
  assert.equal(added.kind, "committed");
  assert.equal(counted.metrics.markdownReadBytes, 0);
  assert.equal(counted.metrics.markdownPutBytes, ENCODER.encode(addedText).byteLength);
  assert.equal(counted.metrics.markdownPutCount, 1);
  assert.equal(counted.metrics.manifestPutCount, 1);

  counted.reset();
  const deleted = await service.commit({
    actor: currentActor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: added.envelope.revision.revisionId,
    idempotencyKey: "delta-delete",
    summary: "Delete one file",
    operations: [{
      type: "delete_file",
      path: "concepts/concept-2000.md",
    }],
  });
  assert.equal(deleted.kind, "committed");
  assert.equal(counted.metrics.markdownReadBytes, 0);
  assert.equal(counted.metrics.markdownPutBytes, 0);
  assert.equal(counted.metrics.markdownPutCount, 0);
  assert.equal(counted.metrics.manifestPutCount, 1);

  const historical = await revisions.materialize(
    MINDS.ordinary.spaceId,
    updated.envelope.revision.revisionId,
  );
  assert.equal(historical.files.length, 2_000);
  assert.equal(
    historical.files.find((file) => file.path === "concepts/concept-0000.md").text,
    replacement,
  );
  assert.equal(
    (await metadata.listReachableSpaceCanonicalObjects()).length,
    2_006,
  );
});

test("failed v3 HEAD transition leaves only collectable orphans and manifest tamper fails closed", async () => {
  const objects = new InMemoryObjectStore();
  const metadata = principalMountedMetadata(new InMemoryRevisionMetadataStore());
  await seedLargeV3(objects, metadata, 8);
  const revisions = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  const currentActor = actor();
  metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: currentActor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      tokenId: currentActor.authentication.tokenId,
    },
    authorizationState(currentActor),
  );
  const service = new ChangesetCommitService({
    authorizer: new CapabilityAuthorizer(metadata),
    metadata,
    revisions,
    objects,
    clock: { now: () => "2026-08-22T18:20:00.000Z" },
    revisionIds: { nextRevisionId: () => "revision_delta_failed" },
  });
  metadata.failNextCommitForTest();
  await assert.rejects(service.commit({
    actor: currentActor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: INITIAL_REVISION,
    idempotencyKey: "delta-failed",
    summary: "Must not publish",
    producerProfile: true,
    operations: [{
      type: "replace_file",
      path: "concepts/concept-0000.md",
      text: concept(0, "failed delta"),
    }],
  }), /injected revision metadata transaction failure/u);
  assert.equal(await metadata.readHead(MINDS.ordinary.spaceId), INITIAL_REVISION);
  assert.equal(await metadata.readRevision(MINDS.ordinary.spaceId, "revision_delta_failed"), null);

  const collected = await revisions.collectUnreachableObjects({
    createdBefore: OBJECT_CUTOFF,
    limit: 10,
  });
  assert.equal(collected.deleted, 2);
  assert.equal(
    (await revisions.materialize(MINDS.ordinary.spaceId, INITIAL_REVISION)).files.length,
    8,
  );

  const initial = await metadata.readRevision(MINDS.ordinary.spaceId, INITIAL_REVISION);
  objects.corruptSpaceCanonicalBytesForTest(
    "revision_manifest",
    MINDS.ordinary.spaceId,
    initial.revision.manifestHash,
    ENCODER.encode("{}\n"),
  );
  await assert.rejects(
    revisions.readHeadRevisionEnvelope(MINDS.ordinary.spaceId),
    (error) =>
      error instanceof CanonicalRevisionError &&
      error.code === "manifest_integrity_failure",
  );
});

test("legacy v2 corpus stays exact-readable while its first v3 change remains a small delta", async () => {
  const objects = new InMemoryObjectStore();
  const metadata = principalMountedMetadata(new InMemoryRevisionMetadataStore());
  const legacyCoordinator = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  const files = Array.from({ length: 500 }, (_, index) => ({
    path: `concepts/legacy-${String(index).padStart(4, "0")}.md`,
    mediaType: MARKDOWN_MEDIA_TYPE,
    bytes: ENCODER.encode(concept(index, "legacy")),
  }));
  const seeded = await legacyCoordinator.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: null,
    revisionId: "revision_delta_legacy_initial",
    committedAt: "2026-08-22T16:00:00.000Z",
    committedBy: { kind: "principal", principalId: PRINCIPALS.editor.principalId },
    summary: "Legacy v2 large fixture",
    files,
  });
  assert.equal(seeded.envelope.manifest.format, "mind-diary-revision-manifest-v2");

  const counted = countedStore(objects);
  const revisions = new CanonicalRevisionCoordinator({
    objects: counted.store,
    revisions: metadata,
  });
  const currentActor = actor();
  metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: currentActor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      tokenId: currentActor.authentication.tokenId,
    },
    authorizationState(currentActor),
  );
  const service = new ChangesetCommitService({
    authorizer: new CapabilityAuthorizer(metadata),
    metadata,
    revisions,
    objects: counted.store,
    clock: { now: () => "2026-08-22T18:25:00.000Z" },
    revisionIds: { nextRevisionId: () => "revision_delta_legacy_first_v3" },
  });
  const replacement = concept(0, "first v3 delta");
  counted.reset();
  const result = await service.commit({
    actor: currentActor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: seeded.envelope.revision.revisionId,
    idempotencyKey: "legacy-first-v3",
    summary: "Change one legacy file",
    operations: [{
      type: "replace_file",
      path: "concepts/legacy-0000.md",
      text: replacement,
    }],
  });
  assert.equal(result.kind, "committed");
  assert.equal(result.envelope.manifest.format, REVISION_MANIFEST_FORMAT_V5);
  assert.equal(counted.metrics.markdownReadBytes, 0);
  assert.equal(counted.metrics.markdownPutCount, 1);
  assert.equal(counted.metrics.markdownPutBytes, ENCODER.encode(replacement).byteLength);
  assert.equal(counted.metrics.manifestPutCount, 1);

  const materialized = await revisions.materialize(
    MINDS.ordinary.spaceId,
    result.envelope.revision.revisionId,
  );
  assert.equal(materialized.files.length, 500);
  assert.equal(
    materialized.files.find((file) => file.path === "concepts/legacy-0000.md").text,
    replacement,
  );
  assert.match(
    materialized.files.find((file) => file.path === "concepts/legacy-0499.md").text,
    /legacy/u,
  );
});
