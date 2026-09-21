import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryObjectStore,
  ObjectStoreIntegrityError,
} from "@mind-diary/adapter-object-memory";
import { OBJECT_INTEGRITY_CHUNK_SIZE } from "@mind-diary/application-ports";
import { MARKDOWN_MEDIA_TYPE } from "@mind-diary/domain";
import { loadTextFileRange, loadTextFileTail } from "@mind-diary/application-content";
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

test("canonical range proofs authenticate crossed chunks and bounded UTF-8 tail reads", async () => {
  const store = new InMemoryObjectStore();
  const bytes = encoder.encode(`${"line\r\n".repeat(40_000)}last🙂\rfinal`);
  const put = await store.putSpaceCanonicalObject({
    kind: "markdown",
    spaceId: "space_range_proof",
    bytes,
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: FIXED_NOW,
  });
  const entry = {
    path: "large.md",
    kind: "markdown",
    mediaType: MARKDOWN_MEDIA_TYPE,
    sha256: put.object.sha256,
    size: bytes.byteLength,
  };
  const ranged = await loadTextFileRange(
    store,
    "space_range_proof",
    "mind-diary-revision-manifest-v4",
    entry,
    70_000,
    170_000,
    undefined,
    Date.now() + 15_000,
    async () => { throw new Error("unexpected full fallback"); },
  );
  assert.equal(ranged.kind, "file");
  assert.deepEqual(ranged.file.bytes, bytes.slice(70_000, 170_000));

  let tailRangeReads = 0;
  const boundedStore = {
    calculateSha256: (candidate) => store.calculateSha256(candidate),
    openSpaceCanonicalObjectRange: async (...args) => {
      tailRangeReads += 1;
      return store.openSpaceCanonicalObjectRange(...args);
    },
  };
  const tail = await loadTextFileTail(
    boundedStore,
    "space_range_proof",
    "mind-diary-revision-manifest-v4",
    entry,
    2,
    undefined,
    Date.now() + 15_000,
    async () => { throw new Error("unexpected full fallback"); },
  );
  assert.equal(tail.kind, "file");
  assert.equal(tail.file.text, "last🙂\rfinal");
  assert.equal(tail.complete, false);
  assert.ok(tailRangeReads <= 4, `tail read ${tailRangeReads} fixed-size chunks`);

  const boundaryBytes = encoder.encode(`${"a".repeat(OBJECT_INTEGRITY_CHUNK_SIZE - 2)}🙂\r\nkeep\rfinal`);
  const boundaryPut = await store.putSpaceCanonicalObject({
    kind: "markdown",
    spaceId: "space_range_utf8_boundary",
    bytes: boundaryBytes,
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: FIXED_NOW,
  });
  const boundaryEntry = {
    path: "boundary.md",
    kind: "markdown",
    mediaType: MARKDOWN_MEDIA_TYPE,
    sha256: boundaryPut.object.sha256,
    size: boundaryBytes.byteLength,
  };
  let boundaryRangeReads = 0;
  const boundaryStore = {
    calculateSha256: (candidate) => store.calculateSha256(candidate),
    openSpaceCanonicalObjectRange: async (...args) => {
      boundaryRangeReads += 1;
      return store.openSpaceCanonicalObjectRange(...args);
    },
  };
  const boundaryTail = await loadTextFileTail(
    boundaryStore,
    "space_range_utf8_boundary",
    "mind-diary-revision-manifest-v4",
    boundaryEntry,
    2,
    undefined,
    Date.now() + 15_000,
    async () => { throw new Error("unexpected UTF-8 boundary fallback"); },
  );
  assert.equal(boundaryTail.kind, "file");
  assert.equal(boundaryTail.file.text, "keep\rfinal");
  assert.ok(boundaryRangeReads <= 3, `boundary tail read ${boundaryRangeReads} fixed-size chunks`);
});

test("range proof corruption fails and legacy ranges use one verified full-read fallback", async () => {
  const store = new InMemoryObjectStore();
  const bytes = encoder.encode("prefix🙂\n".repeat(20_000));
  const put = await store.putSpaceCanonicalObject({
    kind: "markdown",
    spaceId: "space_range_corruption",
    bytes,
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: FIXED_NOW,
  });
  const entry = {
    path: "corrupt.md",
    kind: "markdown",
    mediaType: MARKDOWN_MEDIA_TYPE,
    sha256: put.object.sha256,
    size: bytes.byteLength,
  };
  const corruptProofStore = {
    calculateSha256: (candidate) => store.calculateSha256(candidate),
    openSpaceCanonicalObjectRange: async (kind, spaceId, sha256, range) => {
      const opened = await store.openSpaceCanonicalObjectRange(kind, spaceId, sha256, range);
      return {
        ...opened,
        integrityProof: { ...opened.integrityProof, root: `sha256:${"0".repeat(64)}` },
      };
    },
  };
  await assert.rejects(
    loadTextFileRange(
      corruptProofStore,
      "space_range_corruption",
      "mind-diary-revision-manifest-v4",
      entry,
      1,
      100,
      undefined,
      Date.now() + 15_000,
      async () => { throw new Error("corrupt proof must not fall back"); },
    ),
    (error) => error?.code === "revision_integrity_failure",
  );

  let fullReads = 0;
  const legacyStore = {
    calculateSha256: (candidate) => store.calculateSha256(candidate),
    openSpaceCanonicalObjectRange: async (kind, spaceId, sha256, range) => {
      const opened = await store.openSpaceCanonicalObjectRange(kind, spaceId, sha256, range);
      return { ...opened, integrityProof: undefined, range: undefined };
    },
  };
  const legacy = await loadTextFileRange(
    legacyStore,
    "space_range_corruption",
    "mind-diary-revision-manifest-v4",
    entry,
    1,
    100,
    undefined,
    Date.now() + 15_000,
    async () => {
      fullReads += 1;
      return {
        kind: "file",
        file: { entry, bytes, text: new TextDecoder().decode(bytes) },
      };
    },
  );
  assert.equal(legacy.kind, "file");
  assert.deepEqual(legacy.file.bytes, bytes.slice(1, 100));
  assert.equal(fullReads, 1);
});
