import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryObjectStore,
  ObjectStoreIntegrityError,
} from "@mind-diary/adapter-object-memory";
import { MARKDOWN_MEDIA_TYPE } from "@mind-diary/domain";
import { FIXED_NOW } from "@mind-diary/test-fixtures";

const encoder = new TextEncoder();
const COLLISION_DIGEST = `sha256:${"0".repeat(64)}`;

test("immutable object put is content-addressed, idempotent and returns defensive bytes", async () => {
  const store = new InMemoryObjectStore();
  const request = {
    bytes: encoder.encode("# Exact bytes\n"),
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: FIXED_NOW,
  };
  const first = await store.putImmutable(request);
  const second = await store.putImmutable(request);

  assert.equal(first.status, "stored");
  assert.equal(second.status, "already_exists");
  assert.equal(first.object.sha256, second.object.sha256);
  assert.equal(first.object.size, request.bytes.byteLength);
  const read = await store.getImmutable(first.object.sha256);
  read.bytes[0] = 0;
  assert.equal(new TextDecoder().decode((await store.getImmutable(first.object.sha256)).bytes), "# Exact bytes\n");
});

test("object adapter rejects invalid digest, media type, UTF-8 and simulated collisions", async () => {
  const store = new InMemoryObjectStore();
  await assert.rejects(
    store.getImmutable("not-a-digest"),
    (error) => error instanceof ObjectStoreIntegrityError && error.code === "invalid_digest",
  );
  await assert.rejects(
    store.putImmutable({
      bytes: encoder.encode("valid"),
      mediaType: "text/plain",
      createdAt: FIXED_NOW,
    }),
    (error) => error instanceof ObjectStoreIntegrityError && error.code === "invalid_media_type",
  );
  await assert.rejects(
    store.putImmutable({
      bytes: Uint8Array.of(0xc3, 0x28),
      mediaType: MARKDOWN_MEDIA_TYPE,
      createdAt: FIXED_NOW,
    }),
    (error) => error instanceof ObjectStoreIntegrityError && error.code === "invalid_utf8",
  );

  const colliding = new InMemoryObjectStore({
    digestComputer: () => COLLISION_DIGEST,
  });
  await colliding.putImmutable({
    bytes: encoder.encode("first"),
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: FIXED_NOW,
  });
  await assert.rejects(
    colliding.putImmutable({
      bytes: encoder.encode("second"),
      mediaType: MARKDOWN_MEDIA_TYPE,
      createdAt: FIXED_NOW,
    }),
    (error) => error instanceof ObjectStoreIntegrityError && error.code === "digest_collision",
  );
});

test("object adapter detects tampering before returning immutable bytes", async () => {
  const store = new InMemoryObjectStore();
  const put = await store.putImmutable({
    bytes: encoder.encode("first"),
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: FIXED_NOW,
  });
  store.corruptBytesForTest(put.object.sha256, encoder.encode("other"));
  await assert.rejects(
    store.getImmutable(put.object.sha256),
    (error) => error instanceof ObjectStoreIntegrityError && error.code === "object_tampered",
  );
});

test("object adapter rejects impossible UTC calendar dates", async () => {
  const store = new InMemoryObjectStore();
  await assert.rejects(
    store.putImmutable({
      bytes: encoder.encode("valid"),
      mediaType: MARKDOWN_MEDIA_TYPE,
      createdAt: "2026-02-31T12:00:00Z",
    }),
    (error) => error instanceof ObjectStoreIntegrityError && error.code === "invalid_timestamp",
  );
});

test("object candidate ordering preserves nanoseconds within one millisecond", async () => {
  const store = new InMemoryObjectStore();
  await store.putImmutable({
    bytes: encoder.encode("later"),
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: "2026-08-06T13:00:00.000000003Z",
  });
  await store.putImmutable({
    bytes: encoder.encode("earlier"),
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: "2026-08-06T13:00:00.000000001Z",
  });

  const candidates = await store.listImmutableObjects({
    createdBefore: "2026-08-06T13:00:00.000000004Z",
    excludedDigests: [],
    limit: 2,
  });
  assert.deepEqual(
    candidates.map((candidate) => candidate.protectedAt),
    [
      "2026-08-06T13:00:00.000000001Z",
      "2026-08-06T13:00:00.000000003Z",
    ],
  );
});
