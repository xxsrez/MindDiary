import assert from "node:assert/strict";
import test from "node:test";

import {
  GENERATED_ARTIFACT_LIMITS,
  GeneratedArtifactIngressService,
} from "@mind-diary/application-content";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);

function fakeStaging(results = []) {
  const requests = [];
  const streamRequests = [];
  return {
    requests,
    streamRequests,
    service: new GeneratedArtifactIngressService({
      staging: {
        async stage(request) {
          requests.push(request);
          const next = results.shift();
          return next ?? {
            kind: "staged",
            replayed: false,
            record: {
              stagedFileId: `staged_${requests.length}`,
              sourceKind: request.sourceKind,
              sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              size: request.bytes.byteLength,
            },
          };
        },
        async stageStream(request) {
          const receivedChunks = [];
          streamRequests.push({ ...request, receivedChunks });
          for await (const chunk of request.stream) {
            if (!(chunk instanceof Uint8Array)) {
              return { kind: "stream_invalid", code: "stream_invalid_chunk" };
            }
            receivedChunks.push(chunk);
          }
          const next = results.shift();
          return next ?? {
            kind: "staged",
            replayed: false,
            record: {
              stagedFileId: `staged_stream_${streamRequests.length}`,
              sourceKind: request.sourceKind,
              sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              size: 9,
            },
          };
        },
      },
    }),
  };
}

const COMMON = {
  actor: {},
  spaceId: "space_test",
  displayFilename: "generated.png",
  claimedMediaType: "image/png",
  expectedMediaType: "image/png; charset=binary",
  idempotencyKey: "generated-test-1",
};

test("bounded in-memory artifacts use the shared stage pipeline", async () => {
  const env = fakeStaging();
  const result = await env.service.stageBoundedInMemory({ ...COMMON, bytes: PNG });
  assert.equal(result.kind, "staged");
  assert.equal(env.streamRequests[0].sourceKind, "bounded_in_memory");
  assert.deepEqual(env.streamRequests[0].receivedChunks, [PNG]);
});

test("server-generated ReadableStream is assembled with chunk validation", async () => {
  const env = fakeStaging();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(PNG.subarray(0, 4));
      controller.enqueue(PNG.subarray(4));
      controller.close();
    },
  });
  const result = await env.service.stageServerGenerated({ ...COMMON, stream });
  assert.equal(result.kind, "staged");
  assert.equal(env.streamRequests[0].sourceKind, "server_generated");
  assert.equal(env.streamRequests[0].expectedMediaType, COMMON.expectedMediaType);
  assert.equal(env.streamRequests[0].bytes, undefined);
  assert.deepEqual(env.streamRequests[0].receivedChunks, [PNG.subarray(0, 4), PNG.subarray(4)]);
});

test("bounded in-memory limit fails before staging", async () => {
  const env = fakeStaging();
  const result = await env.service.stageBoundedInMemory({
    ...COMMON,
    bytes: new Uint8Array(GENERATED_ARTIFACT_LIMITS.maxBoundedInMemoryBytes + 1),
  });
  assert.deepEqual(result, {
    kind: "invalid",
    code: "generated_artifact_size_limit_exceeded",
  });
  assert.equal(env.requests.length, 0);
});

test("invalid stream chunk is cancelled and never staged", async () => {
  const env = fakeStaging();
  let cancelled = false;
  const stream = {
    [Symbol.asyncIterator]() {
      let step = 0;
      return {
        async next() {
          step += 1;
          return step === 1
            ? { done: false, value: PNG }
            : { done: false, value: "not-bytes" };
        },
        async return() {
          cancelled = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const result = await env.service.stageServerGenerated({ ...COMMON, stream });
  assert.deepEqual(result, { kind: "invalid", code: "generated_artifact_invalid_chunk" });
  assert.equal(cancelled, true);
  assert.equal(env.requests.length, 0);
});

test("stageMany stops before a changeset can publish partial refs", async () => {
  const env = fakeStaging([
    {
      kind: "staged",
      replayed: false,
      record: {
        stagedFileId: "staged_one",
        sourceKind: "server_generated",
        sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        size: PNG.byteLength,
      },
    },
    { kind: "invalid", code: "idempotency_conflict" },
  ]);
  const result = await env.service.stageMany([
    { ...COMMON, sourceKind: "server_generated", stream: (async function* () { yield PNG; })() },
    { ...COMMON, sourceKind: "bounded_in_memory", idempotencyKey: "generated-test-2", bytes: PNG },
  ]);
  assert.equal(result.kind, "invalid");
  assert.equal(result.index, 1);
  assert.equal(env.streamRequests.length, 2);
  assert.equal(env.requests.length, 0);
});
