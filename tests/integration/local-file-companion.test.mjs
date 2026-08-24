import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  BundleFileStagingService,
  AuthorizedConnectorIngressService,
  CanonicalRevisionCoordinator,
  ChangesetCommitService,
  FileIngressCoordinator,
  GeneratedArtifactIngressService,
  LocalFileCompanion,
  MindBindingContentAuthorizer,
  createLocalCompanionStagingTransport,
} from "@mind-diary/application-content";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";
import {
  CAPABILITIES,
  REVISION_MANIFEST_FORMAT_V3,
  bindingVersion,
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
import { createNodeLocalCompanionFileSystem } from "../../scripts/local-companion-node-filesystem.mjs";

const LATER = "2026-08-05T13:00:00.000Z";
const EXPIRY = "2026-11-05T12:00:00.000Z";
const TOKEN_ID = "token_local_companion";
const BINDING_OWNER_ID = "binding_owner_local_companion";
const WRITE_BINDING_ID = "write_binding_local_companion";
const HASH = `sha256:${"a".repeat(64)}`;
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);
const GENERATED_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x02,
]);
const PDF = new TextEncoder().encode("%PDF-1.7\n");

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
    requestId: "request_local_companion",
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
      idempotencyKey: "bind-local-companion",
      canonicalRequestHash: HASH,
      requestId: "request_bind_local_companion",
      auditEventId: "audit_bind_local_companion",
      auditOutboxMessageId: "outbox_bind_local_companion",
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
  // Use the real revision coordinator so the initial revision is authoritative.
  const coordinator = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  await coordinator.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: null,
    revisionId: REVISIONS.initial.revisionId,
    committedAt: REVISIONS.initial.committedAt,
    committedBy: REVISION_AUTHORS.active,
    summary: "Local companion fixture",
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
    ids: { nextStagedBundleFileId: () => `staged_local_companion_${++stagedIds}` },
  });
  const commits = new ChangesetCommitService({
    authorizer,
    metadata,
    revisions: coordinator,
    objects,
    clock: { now: () => LATER },
    revisionIds: { nextRevisionId: () => REVISIONS.next.revisionId },
  });
  return { metadata, objects, staging, commits, currentActor };
}

test("local disk, workspace bytes and native session ref share one atomic commit pipeline", async () => {
  const root = await mkdtemp(join(tmpdir(), "mind-diary-md272-"));
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const localPath = join(root, "local.png");
    const workspacePath = join(workspace, "generated.png");
    await writeFile(localPath, PNG);
    await writeFile(workspacePath, GENERATED_PNG);

    const env = await harness();
    const transport = createLocalCompanionStagingTransport({ staging: env.staging });
    const companion = new LocalFileCompanion({
      filesystem: createNodeLocalCompanionFileSystem({
        localRoots: [root],
        workspaceRoots: [workspace],
      }),
      transport,
      authorize: async () => ({ kind: "allowed" }),
    });
    const generatedIngress = new GeneratedArtifactIngressService({
      staging: env.staging,
    });
    const connectorIngress = new AuthorizedConnectorIngressService({
      staging: env.staging,
      reader: {
        async read({ object }) {
          assert.deepEqual(object, { ref: "connector-object-fixture" });
          return {
            kind: "ready",
            stream: (async function* () {
              yield GENERATED_PNG;
            })(),
            displayFilename: "connector.png",
            claimedMediaType: "image/png",
            expectedSize: GENERATED_PNG.byteLength,
            expectedSha256: await env.objects.calculateSha256(GENERATED_PNG),
          };
        },
      },
    });
    const ingress = new FileIngressCoordinator({
      staging: env.staging,
      commits: env.commits,
      adapters: {
        session_attachment: {
          stage: (payload) => env.staging.stage({
            ...payload,
            sourceKind: "session_attachment",
          }),
        },
        connector_object: {
          stage: (payload) => connectorIngress.stage(payload),
        },
        local_path: {
          stage: (payload) => companion.uploadLocalFile({
            ...payload,
            sourceKind: "local_path",
          }),
        },
        "workspace/generated_artifact": {
          stage: (payload) => companion.uploadLocalFile({
            ...payload,
            sourceKind: "workspace/generated_artifact",
          }),
        },
        bounded_in_memory: {
          stage: (payload) => generatedIngress.stageBoundedInMemory(payload),
        },
        server_generated: {
          stage: (payload) => generatedIngress.stageServerGenerated(payload),
        },
      },
    });
    assert.deepEqual(
      ingress.capabilities().map(({ sourceKind, status }) => [sourceKind, status]),
      [
        ["session_attachment", "available_local"],
        ["local_path", "available_local"],
        ["workspace/generated_artifact", "available_local"],
        ["connector_object", "available_local"],
        ["bounded_in_memory", "available_local"],
        ["server_generated", "available_local"],
      ],
    );

    const local = await ingress.stage({
      sourceKind: "local_path",
      payload: {
        actor: env.currentActor,
        spaceId: MINDS.ordinary.spaceId,
        writeBindingId: WRITE_BINDING_ID,
        path: localPath,
        idempotencyKey: "local-path-stage",
        claimedMediaType: "image/png",
      },
    });
    assert.equal(local.kind, "staged");
    const localReplay = await ingress.stage({
      sourceKind: "local_path",
      payload: {
        actor: env.currentActor,
        spaceId: MINDS.ordinary.spaceId,
        writeBindingId: WRITE_BINDING_ID,
        path: localPath,
        idempotencyKey: "local-path-stage",
        claimedMediaType: "image/png",
      },
    });
    assert.equal(localReplay.kind, "staged");
    assert.equal(localReplay.replayed, true);
    assert.equal(localReplay.record.stagedFileId, local.record.stagedFileId);
    const generated = await ingress.stage({
      sourceKind: "workspace/generated_artifact",
      payload: {
        actor: env.currentActor,
        spaceId: MINDS.ordinary.spaceId,
        writeBindingId: WRITE_BINDING_ID,
        path: workspacePath,
        idempotencyKey: "workspace-stage",
        claimedMediaType: "image/png",
      },
    });
    assert.equal(generated.kind, "staged");
    const bytes = await ingress.stage({
      sourceKind: "bounded_in_memory",
      payload: {
        actor: env.currentActor,
        spaceId: MINDS.ordinary.spaceId,
        writeBindingId: WRITE_BINDING_ID,
        bytes: PDF,
        displayFilename: "bounded.pdf",
        claimedMediaType: "application/pdf",
        idempotencyKey: "generated-bytes-stage",
      },
    });
    assert.equal(bytes.kind, "staged");
    const session = await ingress.stage({
      sourceKind: "session_attachment",
      payload: {
        actor: env.currentActor,
        spaceId: MINDS.ordinary.spaceId,
        writeBindingId: WRITE_BINDING_ID,
        bytes: PNG,
        displayFilename: "session.png",
        claimedMediaType: "image/png",
        idempotencyKey: "native-session-stage",
      },
    });
    assert.equal(session.kind, "staged");
    const connector = await ingress.stage({
      sourceKind: "connector_object",
      payload: {
        actor: env.currentActor,
        spaceId: MINDS.ordinary.spaceId,
        writeBindingId: WRITE_BINDING_ID,
        object: { ref: "connector-object-fixture" },
        displayFilename: "connector.png",
        idempotencyKey: "connector-stage",
      },
    });
    assert.equal(connector.kind, "staged");
    const serverGenerated = await ingress.stage({
      sourceKind: "server_generated",
      payload: {
        actor: env.currentActor,
        spaceId: MINDS.ordinary.spaceId,
        writeBindingId: WRITE_BINDING_ID,
        stream: (async function* () { yield GENERATED_PNG; })(),
        displayFilename: "server-generated.png",
        claimedMediaType: "image/png",
        idempotencyKey: "server-generated-stage",
      },
    });
    assert.equal(serverGenerated.kind, "staged");

    const commitRequest = {
      actor: env.currentActor,
      spaceId: MINDS.ordinary.spaceId,
      writeBindingId: WRITE_BINDING_ID,
      expectedRevisionId: REVISIONS.initial.revisionId,
      idempotencyKey: "local-companion-commit",
      summary: "Local companion atomic fixture",
      operations: [
        { type: "create_file", path: "concepts/local.md", text: "---\ntype: Reference\ntitle: Local\n---\n\n# Local\n" },
        { type: "create_bundle_file", path: "assets/local.png", staged_file_id: local.record.stagedFileId },
        { type: "create_bundle_file", path: "assets/generated.png", staged_file_id: generated.record.stagedFileId },
        { type: "create_bundle_file", path: "assets/generated.pdf", staged_file_id: bytes.record.stagedFileId },
        { type: "create_bundle_file", path: "assets/session.png", staged_file_id: session.record.stagedFileId },
        { type: "create_bundle_file", path: "assets/connector.png", staged_file_id: connector.record.stagedFileId },
        { type: "create_bundle_file", path: "assets/server-generated.png", staged_file_id: serverGenerated.record.stagedFileId },
      ],
    };
    assert.deepEqual(await ingress.reconcileCommit(commitRequest), { kind: "missing" });
    const committed = await ingress.commit(commitRequest);
    assert.equal(committed.kind, "committed");
    const reconciledCommit = await ingress.reconcileCommit(commitRequest);
    assert.equal(reconciledCommit.kind, "committed");
    assert.equal(reconciledCommit.replayed, true);
    assert.equal(
      reconciledCommit.envelope.revision.revisionId,
      committed.envelope.revision.revisionId,
    );
    assert.equal(committed.envelope.manifest.format, REVISION_MANIFEST_FORMAT_V3);
    const opaque = committed.envelope.manifest.entries.filter((entry) => entry.kind === "opaque");
    assert.equal(opaque.length, 6);
    const expected = new Map([
      ["assets/local.png", PNG],
      ["assets/generated.png", GENERATED_PNG],
      ["assets/generated.pdf", PDF],
      ["assets/session.png", PNG],
      ["assets/connector.png", GENERATED_PNG],
      ["assets/server-generated.png", GENERATED_PNG],
    ]);
    for (const entry of opaque) {
      const exact = await env.objects.getBundleFile(MINDS.ordinary.spaceId, entry.sha256);
      assert.ok(exact, `missing canonical object for ${entry.path}`);
      assert.deepEqual(exact.bytes, expected.get(entry.path));
      assert.equal(exact.size, entry.size);
      assert.equal(exact.mediaType, entry.mediaType);
    }
    assert.deepEqual(
      [local, generated, bytes, session, connector, serverGenerated].map(
        (result) => result.record.state,
      ),
      ["verified", "verified", "verified", "verified", "verified", "verified"],
    );
    for (const result of [local, generated, bytes, session, connector, serverGenerated]) {
      assert.equal((await env.metadata.readStagedBundleFile(result.record.stagedFileId)).state, "consumed");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Node companion rejects symlink and directory sources before upload", async () => {
  const root = await mkdtemp(join(tmpdir(), "mind-diary-md272-negative-"));
  try {
    const file = join(root, "file.png");
    const link = join(root, "link.png");
    const directory = join(root, "directory.png");
    await writeFile(file, PNG);
    await mkdir(directory);
    try {
      await (await import("node:fs/promises")).symlink(file, link);
    } catch (error) {
      assert.fail(`symlink fixture unavailable: ${error.message}`);
    }
    const calls = [];
    const companion = new LocalFileCompanion({
      filesystem: createNodeLocalCompanionFileSystem({ localRoots: [root] }),
      transport: { async upload(request) { calls.push(request); return { kind: "invalid", code: "unexpected" }; } },
      authorize: async () => ({ kind: "allowed" }),
    });
    for (const [path, code] of [
      [link, "file_ingress_source_unsupported"],
      [directory, "file_ingress_source_unsupported"],
    ]) {
      const result = await companion.uploadLocalFile({
        ...({ actor: { kind: "service", serviceId: "negative" }, spaceId: "space", writeBindingId: "binding" }),
        path,
        idempotencyKey: path,
      });
      assert.deepEqual(result, { kind: "invalid", code });
    }
    assert.equal(calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
