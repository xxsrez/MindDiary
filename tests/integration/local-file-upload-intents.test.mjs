import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  FILE_UPLOAD_INTENT_ROUTE_PREFIX,
  HostedFileUploadIntentClientFailure,
  createFileUploadIntentHttpHandler,
  createHostedFileUploadIntentClient,
} from "@mind-diary/adapter-mcp";
import {
  BundleFileStagingService,
  LocalFileUploadIntentService,
  MindBindingContentAuthorizer,
  createLocalFileUploadIntentSecretCodec,
} from "@mind-diary/application-content";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";
import { CAPABILITIES, bindingVersion, version } from "@mind-diary/domain";
import { MINDS, PRINCIPALS } from "@mind-diary/test-fixtures";

const ORIGIN = "https://mind-diary.invalid";
const NOW = "2026-08-24T12:00:00.000Z";
const TOKEN_EXPIRY = "2026-11-24T12:00:00.000Z";
const TOKEN_ID = "token_hosted_upload";
const BINDING_OWNER_ID = "binding_owner_hosted_upload";
const WRITE_BINDING_ID = "write_binding_hosted_upload";
const HASH = `sha256:${"a".repeat(64)}`;
const KEY = Uint8Array.from({ length: 32 }, (_value, index) => 31 - index);
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);

function actor(requestId = "request_hosted_issue") {
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
    requestId,
    occurredAtUtc: NOW,
  };
}

function authorizationState(tokenState = "active") {
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
      state: tokenState,
      scopes: ["content:read", "content:write"],
      version: version(tokenState === "active" ? 1 : 2),
      expiresAt: TOKEN_EXPIRY,
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
      idempotencyKey: "bind-hosted-upload",
      canonicalRequestHash: HASH,
      requestId: "request_bind_hosted_upload",
      auditEventId: "audit_bind_hosted_upload",
      auditOutboxMessageId: "outbox_bind_hosted_upload",
      occurredAt: NOW,
    }),
  );
  assert.equal(result.kind, "applied");
}

async function sha256(objects) {
  return objects.calculateSha256(PNG);
}

async function harness(existing = {}) {
  const metadata = existing.metadata ?? new InMemoryRevisionMetadataStore();
  const objects = existing.objects ?? new InMemoryObjectStore();
  if (!existing.metadata) {
    metadata.setCurrentAuthorizationStateForTest(
      {
        principalId: PRINCIPALS.editor.principalId,
        spaceId: MINDS.ordinary.spaceId,
        tokenId: TOKEN_ID,
      },
      authorizationState(),
    );
    await bindWrite(metadata);
  }
  const authorizer = new MindBindingContentAuthorizer({
    delegate: new CapabilityAuthorizer(metadata),
    bindings: metadata,
  });
  let stagedIds = 0;
  const staging = new BundleFileStagingService({
    authorizer,
    metadata,
    objects,
    clock: { now: () => NOW },
    ids: { nextStagedBundleFileId: () => `staged_hosted_upload_${++stagedIds}` },
  });
  const secrets = await createLocalFileUploadIntentSecretCodec(KEY);
  const uploadIntents = new LocalFileUploadIntentService({
    authorizer,
    bindings: metadata,
    intents: metadata,
    staging: {
      stageStream: (request) => staging.stageStream(request),
      readStagedBundleFile: (id) => metadata.readStagedBundleFile(id),
    },
    digest: objects,
    clock: { now: () => NOW },
    nextIntentId: () => "upload-intent_integration",
    nextClaimId: () => `upload-claim_${crypto.randomUUID()}`,
    secrets,
    deploymentCapabilities: CAPABILITIES,
    issuerActorAllowed: () => true,
  });
  const handler = createFileUploadIntentHttpHandler({
    application: uploadIntents,
    publicOrigin: ORIGIN,
    nextRequestId: () => `request_http_${crypto.randomUUID()}`,
  });
  const client = createHostedFileUploadIntentClient({
    publicOrigin: ORIGIN,
    async fetcher(url, init) {
      const response = await handler(new Request(url, init));
      if (response === null) throw new TypeError("upload route was not handled");
      return response;
    },
  });
  return { metadata, objects, staging, uploadIntents, handler, client };
}

async function issue(env, overrides = {}) {
  return env.uploadIntents.create(actor(), {
    source_kind: "local_path",
    write_binding_id: WRITE_BINDING_ID,
    display_filename: "artifact.png",
    claimed_media_type: "image/png",
    expected_size: PNG.byteLength,
    expected_sha256: await sha256(env.objects),
    idempotency_key: "hosted-upload-exact",
    ...overrides,
  });
}

test("MCP-issued capability streams into the real staging gate and reconcile_file_stage remains authoritative", async () => {
  const env = await harness();
  const created = await issue(env);
  assert.equal(created.kind, "ready");
  const uploadUrl = `${ORIGIN}${FILE_UPLOAD_INTENT_ROUTE_PREFIX}${encodeURIComponent(created.uploadCapability)}`;

  const pending = await env.client.status(uploadUrl);
  assert.equal(pending.status, "pending");
  const uploaded = await env.client.upload({ uploadUrl, bytes: PNG });
  assert.equal(uploaded.status, "staged");
  assert.equal(uploaded.staged_file.state, "verified");
  assert.equal(uploaded.staged_file.source_kind, "local_path");
  assert.equal(uploaded.staged_file.sha256, await sha256(env.objects));
  assert.equal(uploaded.staged_file.size, PNG.byteLength);
  assert.equal(await env.objects.getBundleFile(MINDS.ordinary.spaceId, uploaded.staged_file.sha256), null);

  const reconciled = await env.staging.reconcile({
    actor: actor("request_reconcile_stage"),
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: WRITE_BINDING_ID,
    sourceKind: "local_path",
    displayFilename: "artifact.png",
    claimedMediaType: "image/png",
    mediaType: "image/png",
    sha256: uploaded.staged_file.sha256,
    size: PNG.byteLength,
    idempotencyKey: "hosted-upload-exact",
    expectedSize: PNG.byteLength,
    expectedSha256: await sha256(env.objects),
  });
  assert.equal(reconciled.kind, "staged");
  assert.equal(reconciled.record.stagedFileId, uploaded.staged_file.staged_file_ref);
  assert.equal(reconciled.replayed, true);

  await assert.rejects(
    env.client.upload({ uploadUrl, bytes: PNG }),
    (error) => error instanceof HostedFileUploadIntentClientFailure &&
      error.code === "file_ingress_intent_conflict",
  );
});

test("durable intent/status survive metadata reconstruction with the same deployment key", async () => {
  const env = await harness();
  const created = await issue(env);
  const uploadUrl = `${ORIGIN}${FILE_UPLOAD_INTENT_ROUTE_PREFIX}${created.uploadCapability}`;
  await env.client.upload({ uploadUrl, bytes: PNG });
  const restoredMetadata = InMemoryRevisionMetadataStore.fromDurableSnapshot(
    env.metadata.exportDurableSnapshot(),
  );
  const restored = await harness({ metadata: restoredMetadata, objects: env.objects });
  const status = await restored.client.status(uploadUrl);
  assert.equal(status.status, "staged");
  assert.equal(status.staged_file.staged_file_ref, "staged_hosted_upload_1");
});

test("a lost successful PUT response is recovered by GET without replaying bytes", async () => {
  const env = await harness();
  const created = await issue(env, { idempotency_key: "hosted-upload-unknown-outcome" });
  const uploadUrl = `${ORIGIN}${FILE_UPLOAD_INTENT_ROUTE_PREFIX}${created.uploadCapability}`;
  const methods = [];
  const recoveringClient = createHostedFileUploadIntentClient({
    publicOrigin: ORIGIN,
    async fetcher(url, init) {
      methods.push(init.method);
      const response = await env.handler(new Request(url, init));
      assert.ok(response);
      if (init.method === "PUT") {
        assert.equal(response.status, 201);
        throw new TypeError("response lost after server commit");
      }
      return response;
    },
  });
  const recovered = await recoveringClient.upload({ uploadUrl, bytes: PNG });
  assert.equal(recovered.status, "staged");
  assert.deepEqual(methods, ["PUT", "GET"]);
  assert.equal(recovered.staged_file.replayed, false);
  const intentId = await (await createLocalFileUploadIntentSecretCodec(KEY)).verify(created.uploadCapability);
  assert.equal((await env.metadata.readLocalFileUploadIntent(intentId)).state, "consumed");
});

test("token revocation after issuance blocks capability upload without target disclosure", async () => {
  const env = await harness();
  const created = await issue(env);
  const uploadUrl = `${ORIGIN}${FILE_UPLOAD_INTENT_ROUTE_PREFIX}${created.uploadCapability}`;
  env.metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: PRINCIPALS.editor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      tokenId: TOKEN_ID,
    },
    authorizationState("revoked"),
  );
  await assert.rejects(
    env.client.upload({ uploadUrl, bytes: PNG }),
    (error) => error instanceof HostedFileUploadIntentClientFailure &&
      error.code === "file_ingress_source_unavailable" &&
      !error.message.includes(created.uploadCapability),
  );
  const intentId = await (await createLocalFileUploadIntentSecretCodec(KEY)).verify(created.uploadCapability);
  assert.equal((await env.metadata.readLocalFileUploadIntent(intentId)).state, "rejected");
});

test("changed bytes fail the shared digest gate and retire the one-use intent", async () => {
  const env = await harness();
  const created = await issue(env, { idempotency_key: "hosted-upload-changed-bytes" });
  const uploadUrl = `${ORIGIN}${FILE_UPLOAD_INTENT_ROUTE_PREFIX}${created.uploadCapability}`;
  await assert.rejects(
    env.client.upload({
      uploadUrl,
      bytes: Uint8Array.from([...PNG.slice(0, -1), 0xff]),
    }),
    (error) => error instanceof HostedFileUploadIntentClientFailure &&
      error.code === "bundle_file_digest_mismatch" && error.retryable === false,
  );
  const intentId = await (await createLocalFileUploadIntentSecretCodec(KEY)).verify(created.uploadCapability);
  assert.equal((await env.metadata.readLocalFileUploadIntent(intentId)).state, "rejected");
  await assert.rejects(
    env.client.upload({ uploadUrl, bytes: PNG }),
    (error) => error instanceof HostedFileUploadIntentClientFailure &&
      error.code === "file_ingress_intent_conflict",
  );
});
