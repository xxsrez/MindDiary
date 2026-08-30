import assert from "node:assert/strict";
import test from "node:test";

import {
  createBoundedInMemoryIngressAdapter,
} from "@mind-diary/composition-root";

const COMMON = Object.freeze({
  actor: {},
  spaceId: "space_bounded",
  writeBindingId: "target_generation_bounded",
  displayFilename: "generated.png",
  claimedMediaType: "image/png",
  idempotencyKey: "bounded:test",
});

test("trusted bounded adapter fixes provenance and forwards only safe fields", async () => {
  const calls = [];
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
  const adapter = createBoundedInMemoryIngressAdapter({
    application: {
      async stageBoundedInMemory(request) {
        calls.push(request);
        return { kind: "invalid", code: "expected_size_mismatch" };
      },
    },
  });
  const result = await adapter.stage({
    ...COMMON,
    bytes,
    expectedSize: bytes.byteLength,
    expectedSha256:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceKind: "server_generated",
    localPath: "/private/not-an-input",
    providerUrl: "https://provider.invalid/private",
  });
  assert.deepEqual(result, { kind: "invalid", code: "expected_size_mismatch" });
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]).sort(), [
    "actor",
    "bytes",
    "claimedMediaType",
    "displayFilename",
    "expectedSha256",
    "expectedSize",
    "idempotencyKey",
    "spaceId",
  ]);
  assert.equal(calls[0].writeBindingId, undefined);
  assert.equal(calls[0].sourceKind, undefined);
  assert.equal(calls[0].localPath, undefined);
  assert.equal(calls[0].providerUrl, undefined);
  assert.equal(calls[0].bytes, bytes);
});

test("trusted bounded adapter rejects non-bytes and byte 4 MiB + 1 before application", async () => {
  let calls = 0;
  const adapter = createBoundedInMemoryIngressAdapter({
    application: {
      async stageBoundedInMemory() {
        calls += 1;
        return { kind: "invalid", code: "must_not_run" };
      },
    },
  });
  assert.deepEqual(
    await adapter.stage({ ...COMMON, bytes: "base64-is-not-bytes" }),
    { kind: "invalid", code: "generated_artifact_invalid_chunk" },
  );
  assert.deepEqual(
    await adapter.stage({ ...COMMON, bytes: new Uint8Array(4_194_305) }),
    { kind: "invalid", code: "generated_artifact_size_limit_exceeded" },
  );
  assert.equal(calls, 0);
});
