import assert from "node:assert/strict";
import test from "node:test";

import {
  SERVER_GENERATED_INGRESS_LIMITS,
  TrustedServerGeneratedIngressService,
} from "@mind-diary/application-content";

const BYTES = new TextEncoder().encode("server-generated fixture");
const TARGET_OWNER = "target_owner_generated";
const TARGET_GENERATION = "target_generation_generated";
const COMMON = {
  actor: {
    kind: "registered_principal",
    principalId: "principal_generated",
    authentication: {
      kind: "mcp_token",
      bindingOwnerId: TARGET_OWNER,
    },
  },
  spaceId: "space_generated",
  displayFilename: "generated.bin",
  expectedMediaType: "application/octet-stream",
  expectedSize: BYTES.byteLength,
  expectedSha256: `sha256:${"a".repeat(64)}`,
  idempotencyKey: "server-generated:stage",
};

function currentUsage(overrides = {}) {
  return {
    principalId: COMMON.actor.principalId,
    ordinaryWriteGeneration: {
      generationId: TARGET_GENERATION,
      principalId: COMMON.actor.principalId,
      spaceId: COMMON.spaceId,
    },
    ...overrides,
  };
}

function usageReader(result = currentUsage(), reads = []) {
  return {
    async readPrincipalMindUsage(principalId) {
      reads.push(principalId);
      return result;
    },
    async validatePrincipalMindUsageWritePin(pin) {
      const generation = result?.ordinaryWriteGeneration;
      return generation?.generationId === pin.generationId &&
        generation?.principalId === pin.principalId &&
        generation?.spaceId === pin.spaceId;
    },
  };
}

function fixture(options = {}) {
  const stages = [];
  const reconciles = [];
  const targetReads = [];
  const service = new TrustedServerGeneratedIngressService({
    producerLeaseMilliseconds: options.producerLeaseMilliseconds ?? 50,
    ingress: {
      async stageServerGenerated(request) {
        const chunks = [];
        stages.push({ ...request, chunks });
        try {
          for await (const chunk of request.stream) chunks.push(chunk);
        } catch {
          return { kind: "invalid", code: "generated_artifact_streaming_unavailable" };
        }
        if (request.signal?.aborted) {
          return { kind: "invalid", code: "generated_artifact_cancelled" };
        }
        return options.result ?? {
          kind: "staged",
          replayed: false,
          record: {
            stagedFileId: "staged_generated",
            sourceKind: "server_generated",
            mediaType: request.claimedMediaType,
            size: chunks.reduce((size, chunk) => size + chunk.byteLength, 0),
          },
        };
      },
    },
    reconciliation: {
      async reconcile(request) {
        reconciles.push(request);
        return options.reconcileResult ?? { kind: "missing" };
      },
    },
    usage: usageReader(
      Object.hasOwn(options, "targetResult") ? options.targetResult : currentUsage(),
      targetReads,
    ),
  });
  return { service, stages, reconciles, targetReads };
}

test("trusted producer forwards only a bounded stream to the shared ingress", async () => {
  const env = fixture();
  let producerContext;
  const result = await env.service.stage({
    ...COMMON,
    producer(context) {
      producerContext = context;
      return new ReadableStream({
        start(controller) {
          controller.enqueue(BYTES.subarray(0, 7));
          controller.enqueue(BYTES.subarray(7));
          controller.close();
        },
      });
    },
    localPath: "/private/generated.bin",
    providerUrl: "https://provider.invalid/generated.bin",
    providerLocator: "private-provider-object",
    prompt: "private prompt",
    jobId: "private-job",
  });

  assert.equal(result.kind, "staged");
  assert.equal(producerContext.maxBytes, 268_435_456);
  assert.equal(producerContext.signal instanceof AbortSignal, true);
  assert.equal(env.reconciles.length, 1);
  assert.deepEqual(env.targetReads, [COMMON.actor.principalId]);
  assert.equal(env.reconciles[0].sourceKind, "server_generated");
  assert.equal(env.reconciles[0].mediaType, "application/octet-stream");
  assert.equal(env.reconciles[0].sha256, COMMON.expectedSha256);
  assert.equal(env.reconciles[0].size, BYTES.byteLength);
  assert.deepEqual(env.stages[0].chunks, [BYTES.subarray(0, 7), BYTES.subarray(7)]);
  assert.equal(env.stages[0].sourceKind, undefined);
  for (const forbidden of [
    "bytes", "localPath", "providerUrl", "providerLocator", "prompt", "jobId",
  ]) assert.equal(forbidden in env.stages[0], false, forbidden);
});

test("expected media is reduced to one canonical MIME essence before reconcile and staging", async () => {
  const env = fixture();
  const result = await env.service.stage({
    ...COMMON,
    displayFilename: "generated.pdf",
    expectedMediaType: "Application/PDF; charset=binary",
    producer: () => (async function* () { yield BYTES; })(),
  });

  assert.equal(result.kind, "staged");
  assert.equal(env.reconciles[0].claimedMediaType, "application/pdf");
  assert.equal(env.reconciles[0].expectedMediaType, "application/pdf");
  assert.equal(env.reconciles[0].mediaType, "application/pdf");
  assert.equal(env.stages[0].claimedMediaType, "application/pdf");
  assert.equal(env.stages[0].expectedMediaType, "application/pdf");
});

test("the accepted producer lease and size ceiling are exact and cannot widen", () => {
  assert.deepEqual(SERVER_GENERATED_INGRESS_LIMITS, {
    maxBytes: 268_435_456,
    producerLeaseMilliseconds: 600_000,
  });
  assert.throws(() => new TrustedServerGeneratedIngressService({
    ingress: { stageServerGenerated() { throw new Error("unreachable"); } },
    reconciliation: { reconcile() { throw new Error("unreachable"); } },
    usage: usageReader(),
    producerLeaseMilliseconds: 600_001,
  }), /outside the accepted bound/u);
});

test("principal Mind mount is required and exact before producer acquisition", async () => {
  for (const [targetResult, code] of [
    [currentUsage({ ordinaryWriteGeneration: null }), "writable_target_required"],
    [currentUsage({
      ordinaryWriteGeneration: {
        generationId: "target_generation_other",
        principalId: COMMON.actor.principalId,
        spaceId: "space_other",
      },
    }), "writable_target_mismatch"],
    [null, "writable_target_required"],
  ]) {
    const env = fixture({ targetResult });
    let producerInvocations = 0;
    assert.deepEqual(await env.service.stage({
      ...COMMON,
      producer() {
        producerInvocations += 1;
        return (async function* () { yield BYTES; })();
      },
    }), { kind: "invalid", code });
    assert.equal(producerInvocations, 0);
    assert.equal(env.reconciles.length, 0);
    assert.equal(env.stages.length, 0);
  }
});

test("timeout while opening a producer fails closed and signals the producer", async () => {
  const env = fixture({ producerLeaseMilliseconds: 5 });
  let observedSignal;
  const result = await env.service.stage({
    ...COMMON,
    producer({ signal }) {
      observedSignal = signal;
      return new Promise(() => undefined);
    },
  });

  assert.deepEqual(result, {
    kind: "invalid",
    code: "generated_artifact_streaming_unavailable",
  });
  assert.equal(observedSignal.aborted, true);
  assert.equal(env.stages.length, 0);
});

test("timeout of a pending chunk returns the producer and leaves no staged result", async () => {
  const env = fixture({ producerLeaseMilliseconds: 5 });
  let returned = false;
  const source = {
    [Symbol.asyncIterator]() {
      return {
        next() { return new Promise(() => undefined); },
        return() {
          returned = true;
          return { done: true, value: undefined };
        },
      };
    },
  };

  assert.deepEqual(await env.service.stage({
    ...COMMON,
    producer: () => source,
  }), {
    kind: "invalid",
    code: "generated_artifact_streaming_unavailable",
  });
  assert.equal(returned, true);
  assert.equal(env.stages[0].chunks.length, 0);
});

test("caller cancellation of a pending chunk is distinct and closes the producer", async () => {
  const env = fixture();
  const controller = new AbortController();
  let returned = false;
  const source = {
    [Symbol.asyncIterator]() {
      return {
        next() { return new Promise(() => undefined); },
        return() {
          returned = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  setTimeout(() => controller.abort(), 5);

  assert.deepEqual(await env.service.stage({
    ...COMMON,
    signal: controller.signal,
    producer: () => source,
  }), {
    kind: "invalid",
    code: "generated_artifact_cancelled",
  });
  assert.equal(returned, true);
});

test("shared preflight rejection closes an unopened producer iterator", async () => {
  let returned = false;
  const expected = { kind: "invalid", code: "invalid_display_filename" };
  const service = new TrustedServerGeneratedIngressService({
    producerLeaseMilliseconds: 50,
    ingress: {
      async stageServerGenerated() { return expected; },
    },
    reconciliation: {
      async reconcile() { return { kind: "missing" }; },
    },
    usage: usageReader(),
  });
  const result = await service.stage({
    ...COMMON,
    producer: () => ({
      [Symbol.asyncIterator]() {
        return {
          next() { return new Promise(() => undefined); },
          return() {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    }),
  });
  assert.equal(result, expected);
  assert.equal(returned, true);
});

test("successful uncertain retry and changed receipt resolve before producer or objects", async () => {
  let producerInvocations = 0;
  let objectWrites = 0;
  let staged = null;
  const service = new TrustedServerGeneratedIngressService({
    producerLeaseMilliseconds: 50,
    reconciliation: {
      async reconcile(request) {
        if (staged === null) return { kind: "missing" };
        const matches = request.displayFilename === COMMON.displayFilename &&
          request.mediaType === COMMON.expectedMediaType &&
          request.size === COMMON.expectedSize &&
          request.sha256 === COMMON.expectedSha256;
        return matches
          ? { kind: "staged", record: staged, replayed: true }
          : { kind: "invalid", code: "idempotency_conflict" };
      },
    },
    usage: usageReader(),
    ingress: {
      async stageServerGenerated(request) {
        for await (const chunk of request.stream) objectWrites += chunk.byteLength;
        staged = {
          stagedFileId: "staged_uncertain_retry",
          sourceKind: "server_generated",
          mediaType: COMMON.expectedMediaType,
          size: COMMON.expectedSize,
          sha256: COMMON.expectedSha256,
        };
        return { kind: "staged", record: staged, replayed: false };
      },
    },
  });
  const request = {
    ...COMMON,
    producer: () => {
      producerInvocations += 1;
      return (async function* () { yield BYTES; })();
    },
  };

  const first = await service.stage(request);
  const retry = await service.stage(request);
  assert.equal(first.kind, "staged");
  assert.equal(retry.kind, "staged");
  assert.equal(retry.replayed, true);
  assert.equal(retry.record.stagedFileId, first.record.stagedFileId);
  assert.equal(producerInvocations, 1);
  assert.equal(objectWrites, BYTES.byteLength);

  assert.deepEqual(await service.stage({
    ...request,
    expectedSha256: `sha256:${"b".repeat(64)}`,
  }), { kind: "invalid", code: "idempotency_conflict" });
  assert.equal(producerInvocations, 1);
  assert.equal(objectWrites, BYTES.byteLength);
});

test("producer acquisition, iteration and shape failures collapse without fallback", async (t) => {
  for (const [name, producer] of [
    ["acquisition throw", () => { throw new Error("private producer error"); }],
    ["acquisition reject", async () => { throw new Error("private producer rejection"); }],
    ["invalid shape", () => ({ bytes: BYTES })],
    ["iteration throw", () => (async function* () {
      yield BYTES.subarray(0, 4);
      throw new Error("private iteration failure");
    })()],
  ]) {
    await t.test(name, async () => {
      const env = fixture();
      assert.deepEqual(await env.service.stage({ ...COMMON, producer }), {
        kind: "invalid",
        code: "generated_artifact_streaming_unavailable",
      });
    });
  }
});

test("shared filename, media, quota and idempotency outcomes pass through unchanged", async () => {
  const expected = { kind: "invalid", code: "bundle_file_media_mismatch" };
  const env = fixture({ result: expected });
  assert.equal(await env.service.stage({
    ...COMMON,
    producer: () => (async function* () { yield BYTES; })(),
  }), expected);
});
