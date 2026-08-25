import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryLocalFileUploadIntentStore } from "@mind-diary/adapter-metadata-memory";
import {
  LOCAL_FILE_UPLOAD_INTENT_LIMITS,
  LocalFileUploadIntentCleanupService,
  LocalFileUploadIntentService,
  createLocalFileUploadIntentSecretCodec,
} from "@mind-diary/application-content";

const START = "2026-08-25T12:00:00.000Z";
const SPACE = "space_upload_intent";
const BINDING = "write_binding_upload_intent";
const OWNER = "md_oauth_grant_upload_intent";
const AUTHORIZATION_RECORD_ID = "md_oauth_access_upload_intent";
const SHA_A = `sha256:${"a".repeat(64)}`;

async function digest(bytes) {
  const result = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...result].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function actor(tokenId = AUTHORIZATION_RECORD_ID) {
  return Object.freeze({
    kind: "registered_principal",
    principalId: "principal_upload_intent",
    authentication: Object.freeze({
      kind: "mcp_token",
      tokenId,
      bindingOwnerId: OWNER,
      effectiveScopes: Object.freeze(["content:read", "content:write"]),
    }),
    deploymentCapabilities: Object.freeze(["content:write"]),
    requestId: "request_create_upload_intent",
    occurredAtUtc: START,
  });
}

function bindingSnapshot(spaceId = SPACE, writeBindingId = BINDING) {
  return Object.freeze({
    bindingSet: Object.freeze({ state: "active" }),
    readBindings: Object.freeze([]),
    writeBinding: Object.freeze({
      state: "active",
      spaceId,
      writeBindingId,
      generation: 1,
    }),
  });
}

function stagedRecord(request, suffix, size = request.expectedSize) {
  return Object.freeze({
    stagedFileId: `staged_upload_${suffix}`,
    bindingOwnerId: OWNER,
    sourceKind: request.sourceKind,
    writeBindingId: request.writeBindingId,
    writeBindingGeneration: 1,
    spaceId: request.spaceId,
    displayFilename: request.displayFilename,
    mediaType: request.claimedMediaType,
    sha256: request.expectedSha256,
    size,
    state: "verified",
    createdAt: START,
    expiresAt: "2026-08-25T13:00:00.000Z",
    consumedAt: null,
    rejectionCode: null,
  });
}

async function harness(options = {}) {
  let now = START;
  let intentId = 0;
  let claimId = 0;
  let binding = bindingSnapshot();
  let authorization = "allowed";
  const intents = options.intents ?? new InMemoryLocalFileUploadIntentStore();
  const staged = new Map();
  const stageCalls = [];
  const secrets = await createLocalFileUploadIntentSecretCodec(
    new Uint8Array(32).fill(17),
  );
  const staging = {
    async stageStream(request) {
      stageCalls.push(request);
      if (options.stageStream) return options.stageStream(request, staged);
      let size = 0;
      const chunks = [];
      for await (const chunk of request.stream) {
        assert.ok(chunk instanceof Uint8Array);
        size += chunk.byteLength;
        chunks.push(chunk);
      }
      if (size !== request.expectedSize) {
        return { kind: "invalid", code: "expected_size_mismatch" };
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (await digest(bytes) !== request.expectedSha256) {
        return { kind: "invalid", code: "expected_sha256_mismatch" };
      }
      const record = stagedRecord(request, stageCalls.length);
      staged.set(record.stagedFileId, record);
      return { kind: "staged", record, replayed: false };
    },
    async readStagedBundleFile(stagedFileId) {
      return staged.get(stagedFileId) ?? null;
    },
  };
  const service = new LocalFileUploadIntentService({
    authorizer: {
      async authorize() {
        return authorization === "allowed"
          ? { kind: "allowed" }
          : { kind: "denied", code: "forbidden", retryable: false };
      },
    },
    bindings: {
      async readMindBindingSet() {
        return binding;
      },
    },
    intents,
    staging,
    digest: { calculateSha256: digest },
    clock: { now: () => now },
    nextIntentId: () => `upload_intent_${++intentId}`,
    nextClaimId: () => `upload_claim_${++claimId}`,
    secrets,
    deploymentCapabilities: Object.freeze(["content:write"]),
    issuerActorAllowed: (candidate) =>
      String(candidate.authentication.tokenId).startsWith("md_oauth_access_") &&
      String(candidate.authentication.bindingOwnerId).startsWith("md_oauth_grant_"),
    leaseHeartbeatMilliseconds: 5,
  });
  return {
    intents,
    service,
    stageCalls,
    staged,
    setNow(value) { now = value; },
    setBinding(value) { binding = value; },
    setAuthorization(value) { authorization = value; },
  };
}

async function createIntent(env, input) {
  return env.service.create(actor(), SPACE, {
    source_kind: "local_path",
    write_binding_id: BINDING,
    display_filename: "artifact.bin",
    expected_size: 0,
    expected_sha256: SHA_A,
    idempotency_key: "upload-intent-default",
    ...input,
  });
}

test("format-neutral intents stage synthetic DOCX, HEIC, EPUB, OPUS, HTML, notebook, ZIP and unknown bytes", async () => {
  const env = await harness();
  const fixtures = [
    ["fixture.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["fixture.heic", "image/heic"],
    ["fixture.epub", "application/epub+zip"],
    ["fixture.opus", "audio/ogg"],
    ["fixture.html", "text/html"],
    ["fixture.ipynb", "application/x-ipynb+json"],
    ["fixture.zip", "application/zip"],
    ["fixture.unknown", "unsafe media\r\nheader"],
  ];
  for (const [filename, mediaType] of fixtures) {
    const bytes = new TextEncoder().encode(`synthetic:${filename}`);
    const created = await createIntent(env, {
      display_filename: filename,
      claimed_media_type: mediaType,
      expected_size: bytes.byteLength,
      expected_sha256: await digest(bytes),
      idempotency_key: `format-${filename}`,
    });
    assert.equal(created.kind, "ready");
    const result = await env.service.upload({
      capability: created.uploadCapability,
      requestId: `request_${filename}`,
      stream: (async function* () { yield bytes; })(),
    });
    assert.equal(result.kind, "staged", filename);
  }
  assert.equal(env.stageCalls.at(-1).claimedMediaType, "application/octet-stream");
  const snapshot = env.intents.exportDurableSnapshot();
  const records = [...snapshot.records.values()];
  const serialized = JSON.stringify(records);
  assert.doesNotMatch(serialized, /mdupload_v1_|\/Users\/|private\/tmp|bearer|bytes/iu);
  assert.equal(records.every((record) => record.formatVersion === 1), true);
});

test("intent transport stays structurally streaming beyond 146215108 bytes and rejects oversize before staging", async () => {
  const largeSize = 146_215_109;
  let observed = 0;
  let maxChunk = 0;
  const env = await harness({
    async stageStream(request, staged) {
      assert.equal(request.maxBytes, 268_435_456);
      for await (const chunk of request.stream) {
        observed += chunk.byteLength;
        maxChunk = Math.max(maxChunk, chunk.byteLength);
      }
      const record = stagedRecord(request, "large", observed);
      staged.set(record.stagedFileId, record);
      return { kind: "staged", record, replayed: false };
    },
  });
  const created = await createIntent(env, {
    display_filename: "large.synthetic",
    claimed_media_type: "application/octet-stream",
    expected_size: largeSize,
    expected_sha256: SHA_A,
    idempotency_key: "large-structural-stream",
  });
  assert.equal(created.kind, "ready");
  const chunk = new Uint8Array(1_048_576);
  const uploaded = await env.service.upload({
    capability: created.uploadCapability,
    requestId: "request_large_stream",
    stream: (async function* () {
      let remaining = largeSize;
      while (remaining > 0) {
        const take = Math.min(remaining, chunk.byteLength);
        yield take === chunk.byteLength ? chunk : chunk.subarray(0, take);
        remaining -= take;
      }
    })(),
  });
  assert.equal(uploaded.kind, "staged");
  assert.equal(observed, largeSize);
  assert.equal(maxChunk, chunk.byteLength);
  assert.equal((await createIntent(env, {
    expected_size: LOCAL_FILE_UPLOAD_INTENT_LIMITS.maxBytes + 1,
    idempotency_key: "oversize-create",
  })).kind, "invalid");
  assert.equal(env.stageCalls.length, 1);
});

test("size/digest failures, interruption, replay, wrong binding/Mind, revoke and expiry fail closed", async () => {
  let mode = "cancel";
  const env = await harness({
    async stageStream(request, staged) {
      for await (const _chunk of request.stream) { /* drain */ }
      if (mode === "cancel") {
        mode = "success";
        return { kind: "stream_invalid", code: "stream_cancelled" };
      }
      if (mode === "size") return { kind: "invalid", code: "expected_size_mismatch" };
      if (mode === "digest") return { kind: "invalid", code: "expected_sha256_mismatch" };
      if (mode === "oversize") return { kind: "stream_invalid", code: "stream_size_limit_exceeded" };
      const record = stagedRecord(request, mode);
      staged.set(record.stagedFileId, record);
      return { kind: "staged", record, replayed: false };
    },
  });
  const bytes = Uint8Array.of(1, 2, 3);
  const base = {
    expected_size: bytes.byteLength,
    expected_sha256: await digest(bytes),
    idempotency_key: "retry-after-interruption",
  };
  const created = await createIntent(env, base);
  const replay = await createIntent(env, base);
  assert.equal(created.kind, "ready");
  assert.deepEqual(replay, { ...created, replayed: true });
  const rotatedAccessReplay = await env.service.create(
    actor("md_oauth_access_upload_intent_rotated"),
    SPACE,
    {
      source_kind: "local_path",
      write_binding_id: BINDING,
      display_filename: "artifact.bin",
      expected_size: bytes.byteLength,
      expected_sha256: await digest(bytes),
      idempotency_key: "retry-after-interruption",
    },
  );
  assert.deepEqual(rotatedAccessReplay, { ...created, replayed: true });
  const upload = () => env.service.upload({
    capability: created.uploadCapability,
    requestId: "request_retry",
    stream: (async function* () { yield bytes; })(),
  });
  assert.deepEqual(await upload(), { kind: "stream_invalid", code: "stream_cancelled" });
  assert.equal((await upload()).kind, "staged");
  assert.deepEqual(await upload(), {
    kind: "intent_invalid",
    code: "file_ingress_intent_conflict",
  });
  assert.equal((await env.service.status({
    capability: created.uploadCapability,
    requestId: "request_status",
  })).kind, "staged");
  const reconciledCreate = await createIntent(env, base);
  assert.deepEqual(reconciledCreate, { ...created, replayed: true });
  assert.equal((await env.service.status({
    capability: reconciledCreate.uploadCapability,
    requestId: "request_status_after_create_retry",
  })).kind, "staged");

  assert.equal((await env.service.create(actor(), "space_wrong", {
    source_kind: "local_path",
    write_binding_id: BINDING,
    display_filename: "wrong.bin",
    expected_size: 0,
    expected_sha256: SHA_A,
    idempotency_key: "wrong-mind",
  })).code, "write_binding_stale");
  const guarded = await createIntent(env, { idempotency_key: "guarded" });
  env.setBinding(bindingSnapshot(SPACE, "other_binding"));
  assert.equal((await env.service.status({
    capability: guarded.uploadCapability,
    requestId: "wrong_binding",
  })).code, "file_ingress_source_unavailable");
  env.setBinding(bindingSnapshot());
  env.setAuthorization("denied");
  assert.equal((await env.service.status({
    capability: guarded.uploadCapability,
    requestId: "revoked",
  })).code, "file_ingress_source_unavailable");
  env.setAuthorization("allowed");

  for (const failureMode of ["size", "digest", "oversize"]) {
    mode = failureMode;
    const failed = await createIntent(env, { idempotency_key: `failure-${failureMode}` });
    const result = await env.service.upload({
      capability: failed.uploadCapability,
      requestId: `request_${failureMode}`,
      stream: (async function* () {})(),
    });
    assert.notEqual(result.kind, "staged");
    assert.equal((await env.service.status({
      capability: failed.uploadCapability,
      requestId: `status_${failureMode}`,
    })).kind, "rejected");
  }

  env.setNow("2026-08-25T12:11:00.000Z");
  assert.equal((await env.service.status({
    capability: guarded.uploadCapability,
    requestId: "expired",
  })).code, "file_ingress_intent_expired");
});

test("cleanup deletes at most the bounded expired/orphan batch after the safety window", async () => {
  const env = await harness();
  for (let index = 0; index < 105; index += 1) {
    assert.equal((await createIntent(env, {
      idempotency_key: `cleanup-${index}`,
    })).kind, "ready");
  }
  env.setNow("2026-08-26T13:00:01.000Z");
  const cleanup = new LocalFileUploadIntentCleanupService({
    intents: env.intents,
    clock: { now: () => "2026-08-26T13:00:01.000Z" },
  });
  assert.deepEqual(await cleanup.run(), { scanned: 100, deleted: 100 });
  assert.equal((await env.intents.collectExpiredLocalFileUploadIntents({
    expiredBefore: "2026-08-25T13:00:01.000Z",
    limit: 100,
  })).length, 5);
});
