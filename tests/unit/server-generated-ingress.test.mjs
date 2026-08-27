import assert from "node:assert/strict";
import test from "node:test";

import {
  SERVER_GENERATED_INGRESS_LIMITS,
  TrustedServerGeneratedIngressService,
} from "@mind-diary/application-content";

const BYTES = new TextEncoder().encode("server-generated fixture");
const COMMON = {
  actor: { kind: "registered_principal" },
  spaceId: "space_generated",
  writeBindingId: "write_generated",
  displayFilename: "generated.bin",
  claimedMediaType: "application/octet-stream",
  idempotencyKey: "server-generated:stage",
};

function fixture(options = {}) {
  const stages = [];
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
            size: chunks.reduce((size, chunk) => size + chunk.byteLength, 0),
          },
        };
      },
    },
  });
  return { service, stages };
}

test("trusted producer forwards only a bounded stream to the shared ingress", async () => {
  const env = fixture();
  let producerContext;
  const result = await env.service.stage({
    ...COMMON,
    expectedSize: BYTES.byteLength,
    expectedSha256: `sha256:${"a".repeat(64)}`,
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
  assert.deepEqual(env.stages[0].chunks, [BYTES.subarray(0, 7), BYTES.subarray(7)]);
  assert.equal(env.stages[0].sourceKind, undefined);
  for (const forbidden of [
    "bytes", "localPath", "providerUrl", "providerLocator", "prompt", "jobId",
  ]) assert.equal(forbidden in env.stages[0], false, forbidden);
});

test("the accepted producer lease and size ceiling are exact and cannot widen", () => {
  assert.deepEqual(SERVER_GENERATED_INGRESS_LIMITS, {
    maxBytes: 268_435_456,
    producerLeaseMilliseconds: 600_000,
  });
  assert.throws(() => new TrustedServerGeneratedIngressService({
    ingress: { stageServerGenerated() { throw new Error("unreachable"); } },
    producerLeaseMilliseconds: 600_001,
  }), /outside the accepted bound/u);
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
