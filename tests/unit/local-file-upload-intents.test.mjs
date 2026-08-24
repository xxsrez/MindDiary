import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import {
  LOCAL_FILE_UPLOAD_INTENT_LIMITS,
  LocalFileUploadIntentService,
  createLocalFileUploadIntentSecretCodec,
} from "@mind-diary/application-content";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);
const KEY = Uint8Array.from({ length: 32 }, (_value, index) => index + 1);
const FOREIGN_KEY = Uint8Array.from({ length: 32 }, (_value, index) => 255 - index);

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...digest].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function actor(overrides = {}) {
  return {
    kind: "registered_principal",
    principalId: "principal_upload_owner",
    deploymentCapabilities: Object.freeze(["content:write"]),
    requestId: "request_issue",
    occurredAtUtc: "2026-08-24T12:00:00.000Z",
    authentication: {
      kind: "mcp_token",
      tokenId: "token_upload_owner",
      bindingOwnerId: "binding_owner_upload",
      effectiveScopes: Object.freeze(["content:read", "content:write"]),
    },
    ...overrides,
  };
}

async function createInput(overrides = {}) {
  return {
    source_kind: "local_path",
    write_binding_id: "write_binding_upload",
    display_filename: "artifact.png",
    claimed_media_type: "image/png",
    expected_size: PNG.byteLength,
    expected_sha256: await sha256(PNG),
    idempotency_key: "upload-intent-key-1",
    ...overrides,
  };
}

async function harness(options = {}) {
  const store = options.store ?? new InMemoryRevisionMetadataStore();
  let now = options.now ?? "2026-08-24T12:00:00.000Z";
  let nextIntent = 0;
  let nextClaim = 0;
  let authorization = "allowed";
  let nextStageResult = null;
  const staged = new Map();
  const stageCalls = [];
  const secrets = await createLocalFileUploadIntentSecretCodec(KEY);
  const service = new LocalFileUploadIntentService({
    authorizer: {
      async authorize(request) {
        return authorization === "allowed"
          ? { kind: "allowed", stamp: {}, capability: request.capability, grant: { kind: "membership", role: "owner" } }
          : { kind: "denied", code: "token_inactive", retryable: false };
      },
    },
    bindings: {
      async readMindBindingSet(ownerId, principalId) {
        if (ownerId !== "binding_owner_upload" || principalId !== "principal_upload_owner") return null;
        return {
          writeBinding: {
            state: "active",
            writeBindingId: "write_binding_upload",
            spaceId: "space_upload",
          },
        };
      },
    },
    intents: store,
    staging: {
      async stageStream(request) {
        stageCalls.push(request);
        for await (const _chunk of request.stream) {
          // The fake owns no bytes; iteration proves the application passed a stream.
        }
        if (options.stageDelayMilliseconds !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, options.stageDelayMilliseconds));
        }
        if (nextStageResult !== null) {
          const result = nextStageResult;
          nextStageResult = null;
          return result;
        }
        const record = {
          stagedFileId: `staged_upload_${staged.size + 1}`,
          bindingOwnerId: request.actor.authentication.bindingOwnerId,
          sourceKind: request.sourceKind,
          writeBindingId: request.writeBindingId,
          writeBindingGeneration: 1,
          spaceId: request.spaceId,
          displayFilename: request.displayFilename,
          mediaType: request.claimedMediaType,
          sha256: request.expectedSha256,
          size: request.expectedSize,
          state: "verified",
          createdAt: now,
          expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString(),
          consumedAt: null,
          rejectionCode: null,
        };
        staged.set(record.stagedFileId, record);
        return { kind: "staged", record, replayed: false };
      },
      async readStagedBundleFile(stagedFileId) {
        return staged.get(stagedFileId) ?? null;
      },
    },
    digest: { calculateSha256: sha256 },
    clock: { now: () => now },
    nextIntentId: () => `upload-intent_${++nextIntent}`,
    nextClaimId: () => `upload-claim_${++nextClaim}`,
    secrets,
    deploymentCapabilities: Object.freeze(["content:write"]),
    issuerActorAllowed: options.issuerActorAllowed ?? (() => true),
    ...(options.leaseHeartbeatMilliseconds === undefined
      ? {}
      : { leaseHeartbeatMilliseconds: options.leaseHeartbeatMilliseconds }),
  });
  return {
    service,
    store,
    secrets,
    stageCalls,
    setNow(value) { now = value; },
    denyAuthorization() { authorization = "denied"; },
    stageOnce(result) { nextStageResult = result; },
  };
}

async function chunks(...values) {
  return (async function* () {
    for (const value of values) yield value;
  })();
}

test("intent creation is exact-idempotent, binding scoped and stores no source locator", async () => {
  const env = await harness();
  const input = await createInput();
  const first = await env.service.create(actor(), input);
  const replay = await env.service.create(actor(), input);
  assert.equal(first.kind, "ready");
  assert.match(first.uploadCapability, /^mdupload_v1_[A-Za-z0-9_-]{16,4096}$/u);
  assert.deepEqual(replay, { ...first, replayed: true });

  const intentId = await env.secrets.verify(first.uploadCapability);
  const record = await env.store.readLocalFileUploadIntent(intentId);
  assert.equal(record.principalId, "principal_upload_owner");
  assert.equal(record.tokenId, "token_upload_owner");
  assert.equal(record.bindingOwnerId, "binding_owner_upload");
  assert.equal(record.spaceId, "space_upload");
  assert.equal(record.sourceKind, "local_path");
  assert.equal(Date.parse(record.expiresAt) - Date.parse(record.createdAt), 600_000);
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /\/workspace|provider|account|https?:|mdo_access/u);

  const changed = await env.service.create(actor(), await createInput({ display_filename: "changed.png" }));
  assert.deepEqual(changed, { kind: "invalid", code: "file_ingress_intent_conflict" });
});

test("OAuth access-token rotation creates a fresh token-pinned intent under the same grant", async () => {
  const env = await harness();
  const input = await createInput({ idempotency_key: "upload-after-token-rotation" });
  const first = await env.service.create(actor(), input);
  const rotated = await env.service.create(actor({
    authentication: {
      ...actor().authentication,
      tokenId: "token_upload_owner_rotated",
    },
  }), input);
  assert.equal(first.kind, "ready");
  assert.equal(rotated.kind, "ready");
  assert.equal(first.replayed, false);
  assert.equal(rotated.replayed, false);
  assert.notEqual(rotated.uploadCapability, first.uploadCapability);
  const rotatedIntentId = await env.secrets.verify(rotated.uploadCapability);
  assert.equal(
    (await env.store.readLocalFileUploadIntent(rotatedIntentId)).tokenId,
    "token_upload_owner_rotated",
  );
});

test("non-OAuth MCP actors cannot issue a hosted companion capability", async () => {
  const env = await harness({ issuerActorAllowed: () => false });
  assert.deepEqual(
    await env.service.create(actor(), await createInput()),
    { kind: "invalid", code: "insufficient_scope" },
  );
  assert.equal(env.stageCalls.length, 0);
});

test("connector_object is generic and rejects every provider/account/URL/path extension", async () => {
  const env = await harness();
  const connector = await env.service.create(actor(), await createInput({
    source_kind: "connector_object",
    idempotency_key: "connector-safe",
  }));
  assert.equal(connector.kind, "ready");
  const uploaded = await env.service.upload({
    capability: connector.uploadCapability,
    requestId: "request_connector_upload",
    stream: await chunks(PNG),
  });
  assert.equal(uploaded.kind, "staged");
  assert.equal(env.stageCalls[0].sourceKind, "connector_object");

  for (const extra of [
    { provider_file_id: "drive-secret" },
    { provider_account_id: "account-secret" },
    { source_url: "https://provider.invalid/object" },
    { local_path: "/workspace/private.png" },
    { bytes_base64: "AAAA" },
  ]) {
    const result = await env.service.create(actor(), {
      ...await createInput({ idempotency_key: `extra-${Object.keys(extra)[0]}` }),
      ...extra,
    });
    assert.deepEqual(result, { kind: "invalid", code: "invalid_request" });
  }
});

test("GET status is non-consuming; PUT is one-use and preserves current actor authority", async () => {
  const env = await harness();
  const created = await env.service.create(actor(), await createInput());
  assert.equal(created.kind, "ready");
  assert.deepEqual(
    await env.service.status({ capability: created.uploadCapability, requestId: "request_status_1" }),
    { kind: "pending", expiresAt: created.expiresAt },
  );
  assert.deepEqual(
    await env.service.status({ capability: created.uploadCapability, requestId: "request_status_2" }),
    { kind: "pending", expiresAt: created.expiresAt },
  );
  const uploaded = await env.service.upload({
    capability: created.uploadCapability,
    requestId: "request_upload",
    stream: await chunks(PNG),
  });
  assert.equal(uploaded.kind, "staged");
  assert.equal(env.stageCalls[0].actor.authentication.tokenId, "token_upload_owner");
  assert.equal(env.stageCalls[0].actor.authentication.bindingOwnerId, "binding_owner_upload");
  assert.deepEqual(env.stageCalls[0].actor.deploymentCapabilities, ["content:write"]);

  const status = await env.service.status({
    capability: created.uploadCapability,
    requestId: "request_status_staged",
  });
  assert.equal(status.kind, "staged");
  assert.equal(status.record.stagedFileId, uploaded.record.stagedFileId);
  assert.equal(status.replayed, false);
  assert.deepEqual(
    await env.service.upload({
      capability: created.uploadCapability,
      requestId: "request_replay",
      stream: await chunks(PNG),
    }),
    { kind: "intent_invalid", code: "file_ingress_intent_conflict" },
  );
});

test("expired, changed and foreign capabilities fail without revealing intent ownership", async () => {
  const env = await harness();
  const created = await env.service.create(actor(), await createInput());
  assert.equal(created.kind, "ready");
  const foreignCodec = await createLocalFileUploadIntentSecretCodec(FOREIGN_KEY);
  const intentId = await env.secrets.verify(created.uploadCapability);
  const foreign = await foreignCodec.issue(intentId);
  const changed = `${created.uploadCapability.slice(0, -1)}${created.uploadCapability.endsWith("A") ? "B" : "A"}`;
  for (const capability of [foreign, changed, "mdupload_v1_invalid.invalid"]) {
    assert.deepEqual(
      await env.service.status({ capability, requestId: "request_foreign" }),
      { kind: "intent_invalid", code: "file_ingress_source_unavailable" },
    );
  }

  env.setNow(new Date(Date.parse(created.expiresAt) + 1).toISOString());
  assert.deepEqual(
    await env.service.status({ capability: created.uploadCapability, requestId: "request_expired" }),
    { kind: "intent_invalid", code: "file_ingress_intent_expired" },
  );
  assert.deepEqual(
    await env.service.upload({
      capability: created.uploadCapability,
      requestId: "request_expired_upload",
      stream: await chunks(PNG),
    }),
    { kind: "intent_invalid", code: "file_ingress_intent_expired" },
  );
});

test("retryable transport releases the lease, active leases fence, and definitive failures retire", async () => {
  const env = await harness();
  const created = await env.service.create(actor(), await createInput());
  const intentId = await env.secrets.verify(created.uploadCapability);
  await env.store.claimLocalFileUploadIntent({
    intentId,
    principalId: "principal_upload_owner",
    bindingOwnerId: "binding_owner_upload",
    claimId: "foreign-active-claim",
    occurredAt: "2026-08-24T12:00:01.000Z",
    leaseExpiresAt: "2026-08-24T12:00:31.000Z",
  });
  assert.deepEqual(
    await env.service.upload({
      capability: created.uploadCapability,
      requestId: "request_busy",
      stream: await chunks(PNG),
    }),
    { kind: "intent_invalid", code: "file_ingress_transport_unavailable" },
  );

  env.setNow("2026-08-24T12:00:32.000Z");
  env.stageOnce({ kind: "stream_invalid", code: "stream_transport_unavailable" });
  assert.deepEqual(
    await env.service.upload({
      capability: created.uploadCapability,
      requestId: "request_transport",
      stream: await chunks(PNG),
    }),
    { kind: "stream_invalid", code: "stream_transport_unavailable" },
  );
  assert.equal((await env.store.readLocalFileUploadIntent(intentId)).state, "active");

  env.stageOnce({ kind: "invalid", code: "expected_sha256_mismatch" });
  assert.deepEqual(
    await env.service.upload({
      capability: created.uploadCapability,
      requestId: "request_mismatch",
      stream: await chunks(PNG),
    }),
    { kind: "invalid", code: "expected_sha256_mismatch" },
  );
  assert.equal((await env.store.readLocalFileUploadIntent(intentId)).state, "rejected");
  assert.deepEqual(
    await env.service.upload({
      capability: created.uploadCapability,
      requestId: "request_after_reject",
      stream: await chunks(PNG),
    }),
    { kind: "intent_invalid", code: "file_ingress_intent_conflict" },
  );
});

test("slow uploads renew the 30-second claim lease and fence a concurrent retry", async () => {
  const env = await harness({
    leaseHeartbeatMilliseconds: 5,
    stageDelayMilliseconds: 40,
  });
  const created = await env.service.create(
    actor(),
    await createInput({ idempotency_key: "slow-upload-heartbeat" }),
  );
  assert.equal(created.kind, "ready");
  const intentId = await env.secrets.verify(created.uploadCapability);
  const upload = env.service.upload({
    capability: created.uploadCapability,
    requestId: "request_slow_upload",
    stream: await chunks(PNG),
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await env.store.readLocalFileUploadIntent(intentId))?.state === "consuming") break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal((await env.store.readLocalFileUploadIntent(intentId))?.state, "consuming");

  env.setNow("2026-08-24T12:00:20.000Z");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await env.store.readLocalFileUploadIntent(intentId);
    if (Date.parse(current?.leaseExpiresAt ?? "") > Date.parse("2026-08-24T12:00:30.000Z")) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const renewed = await env.store.readLocalFileUploadIntent(intentId);
  assert.equal(renewed?.leaseExpiresAt, "2026-08-24T12:00:50.000Z");
  assert.deepEqual(await env.store.claimLocalFileUploadIntent({
    intentId,
    principalId: "principal_upload_owner",
    bindingOwnerId: "binding_owner_upload",
    claimId: "concurrent-retry",
    occurredAt: "2026-08-24T12:00:31.000Z",
    leaseExpiresAt: "2026-08-24T12:01:01.000Z",
  }), { kind: "busy" });
  assert.equal((await upload).kind, "staged");
});

test("status rechecks current token/ACL and consumed receipts expire after ten minutes", async () => {
  const env = await harness();
  const created = await env.service.create(actor(), await createInput());
  await env.service.upload({
    capability: created.uploadCapability,
    requestId: "request_upload",
    stream: await chunks(PNG),
  });
  env.denyAuthorization();
  assert.deepEqual(
    await env.service.status({ capability: created.uploadCapability, requestId: "request_revoked" }),
    { kind: "intent_invalid", code: "file_ingress_source_unavailable" },
  );
  env.setNow(new Date(Date.parse(created.expiresAt) + 1).toISOString());
  assert.deepEqual(
    await env.service.status({ capability: created.uploadCapability, requestId: "request_expired" }),
    { kind: "intent_invalid", code: "file_ingress_intent_expired" },
  );
  assert.equal(LOCAL_FILE_UPLOAD_INTENT_LIMITS.ttlMilliseconds, 600_000);
});
