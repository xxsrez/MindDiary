import assert from "node:assert/strict";
import test from "node:test";

import { createSitesObjectStore } from "@mind-diary/adapter-object-sites";
import {
  OBJECT_INTEGRITY_CHUNK_SIZE,
  objectIntegrityLeafInput,
  objectIntegrityNodeInput,
  serializeObjectIntegrityManifest,
} from "@mind-diary/application-ports";
import { loadTextFileHead } from "@mind-diary/application-content";
import {
  MARKDOWN_MEDIA_TYPE,
  REVISION_MANIFEST_FORMAT_V5,
} from "@mind-diary/domain";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x01, 0x02, 0x03,
]);
const CREATED_AT = "2026-08-23T00:00:00.000Z";

class Body {
  constructor(record) {
    this.key = record.key;
    this.size = record.bytes.byteLength;
    this.etag = record.etag;
    this.customMetadata = { ...record.customMetadata };
    this.range = record.range;
    this.#bytes = new Uint8Array(record.bytes);
    this.#record = record;
    this.body = new ReadableStream({
      start: (controller) => {
        controller.enqueue(new Uint8Array(this.#bytes));
        controller.close();
      },
    });
  }

  #bytes;
  #record;

  async arrayBuffer() {
    this.#record.arrayBufferReads = (this.#record.arrayBufferReads ?? 0) + 1;
    return new Uint8Array(this.#bytes).buffer;
  }
}

class StreamingBucket {
  records = new Map();
  #version = 0;

  async get(key, options = {}) {
    const record = this.records.get(key);
    if (record === undefined) return null;
    if (options.range === undefined) return new Body(record);
    const { offset, length } = options.range;
    return new Body({
      ...record,
      bytes: record.bytes.slice(offset, offset + length),
      range: { offset, length },
    });
  }

  async put(key, value, options = {}) {
    if (options.onlyIf?.etagDoesNotMatch === "*" && this.records.has(key)) return null;
    let bytes;
    if (value instanceof ReadableStream) {
      const reader = value.getReader();
      const chunks = [];
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          chunks.push(new Uint8Array(next.value));
        }
      } finally {
        reader.releaseLock();
      }
      bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } else {
      bytes = value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
    }
    const record = {
      key,
      bytes,
      etag: `etag-${++this.#version}`,
      customMetadata: { ...(options.customMetadata ?? {}) },
      arrayBufferReads: 0,
    };
    this.records.set(key, record);
    return new Body(record);
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.records.delete(key);
  }

  async list() {
    return { objects: [], truncated: false };
  }
}

class PreflightBlindCollisionBucket extends StreamingBucket {
  #hideExistingOnce = true;

  async get(key) {
    if (this.#hideExistingOnce) {
      this.#hideExistingOnce = false;
      return null;
    }
    return super.get(key);
  }
}

class CorruptingPersistedBucket extends StreamingBucket {
  async put(key, value, options = {}) {
    const stored = await super.put(key, value, options);
    const record = this.records.get(key);
    if (stored !== null && key.startsWith("staged-bundle-files/") && record?.bytes.length > 0) {
      record.bytes[0] ^= 0xff;
    }
    return stored;
  }
}

async function settlesWithin(operation, milliseconds = 250) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`operation did not settle within ${milliseconds} ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function foreignStagedRecord(stagedFileId) {
  return {
    key: `staged-bundle-files/${stagedFileId}`,
    bytes: Uint8Array.from([0x01, 0x02, 0x03]),
    etag: "foreign-etag",
    customMetadata: {},
  };
}

async function forgeIntegrityManifest(objects, source, bytes) {
  const chunkDigests = [];
  for (let offset = 0; offset < bytes.byteLength; offset += source.chunkSize) {
    chunkDigests.push(await objects.calculateSha256(
      bytes.slice(offset, Math.min(bytes.byteLength, offset + source.chunkSize)),
    ));
  }
  const encoder = new TextEncoder();
  let level = await Promise.all(chunkDigests.map((digest, index) =>
    objects.calculateSha256(encoder.encode(objectIntegrityLeafInput(
      source,
      index,
      index * source.chunkSize,
      Math.min(source.chunkSize, source.size - index * source.chunkSize),
      digest,
    )))));
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(await objects.calculateSha256(encoder.encode(objectIntegrityNodeInput(
        level[index],
        level[index + 1] ?? level[index],
      ))));
    }
    level = next;
  }
  return {
    ...source,
    root: level[0],
    chunkDigests,
  };
}

test("Sites staged generated writer sends a ReadableStream and publishes only on complete", async () => {
  const bucket = new StreamingBucket();
  const objects = await createSitesObjectStore(bucket);
  const upload = await objects.beginStagedBundleFileUpload({
    stagedFileId: "staged_stream_test",
    bindingOwnerId: "binding_owner_test",
    spaceId: "space_stream_test",
    createdAt: CREATED_AT,
    maxBytes: 64,
  });

  await upload.write(PNG.subarray(0, 5));
  await upload.write(PNG.subarray(5));
  assert.equal(bucket.records.size, 0);
  const sha256 = await objects.calculateSha256(PNG);
  const completed = await upload.complete({ sha256, size: PNG.byteLength });
  assert.deepEqual(completed, {
    stagedFileId: "staged_stream_test",
    bindingOwnerId: "binding_owner_test",
    spaceId: "space_stream_test",
    size: PNG.byteLength,
    createdAt: CREATED_AT,
  });
  assert.equal(bucket.records.size, 1);
  assert.deepEqual(
    (await objects.getStagedBundleFile("staged_stream_test")).bytes,
    PNG,
  );
});

test("Sites canonical ranges use compact metadata plus a bound sidecar and reject tampering", async () => {
  const bucket = new StreamingBucket();
  const objects = await createSitesObjectStore(bucket);
  const spaceId = "space_sites_integrity";
  const bytes = new TextEncoder().encode(
    `${"a".repeat(OBJECT_INTEGRITY_CHUNK_SIZE - 7)}\r\n${"b".repeat(OBJECT_INTEGRITY_CHUNK_SIZE + 23)}\nend🙂\rfinal`,
  );
  const stored = await objects.putSpaceCanonicalObject({
    kind: "markdown",
    spaceId,
    bytes,
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: CREATED_AT,
  });
  const canonicalKey = [...bucket.records.keys()].find((key) =>
    key.endsWith(`/objects/sha256/${stored.object.sha256.slice(7)}`));
  assert.ok(canonicalKey);
  const canonical = bucket.records.get(canonicalKey);
  assert.ok(canonical);
  assert.equal(canonical.customMetadata.chunkDigests, undefined);
  assert.match(canonical.customMetadata.integrityProofDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(canonical.customMetadata.integrityProofRoot, /^sha256:[0-9a-f]{64}$/u);
  const sidecars = [...bucket.records.keys()].filter((key) => key.includes("/integrity/"));
  assert.equal(sidecars.length, 1);
  assert.ok(sidecars[0].startsWith(`spaces/${encodeURIComponent(spaceId)}/integrity/`));

  const opened = await objects.openSpaceCanonicalObjectRange(
    "markdown",
    spaceId,
    stored.object.sha256,
    { offset: OBJECT_INTEGRITY_CHUNK_SIZE - 3, length: 11 },
  );
  assert.ok(opened);
  assert.deepEqual(
    new Uint8Array(await new Response(opened.body).arrayBuffer()),
    bytes.slice(0, OBJECT_INTEGRITY_CHUNK_SIZE * 2),
  );
  assert.deepEqual(opened.range, {
    offset: 0,
    length: OBJECT_INTEGRITY_CHUNK_SIZE * 2,
  });
  assert.ok(opened.integrityProof);

  const trustedRoot = canonical.customMetadata.integrityProofRoot;
  canonical.customMetadata.integrityProofRoot = `sha256:${"0".repeat(64)}`;
  await assert.rejects(
    objects.openSpaceCanonicalObjectRange(
      "markdown",
      spaceId,
      stored.object.sha256,
      { offset: 0, length: 5 },
    ),
    (error) => error?.code === "object_tampered",
  );
  canonical.customMetadata.integrityProofRoot = trustedRoot;
  canonical.bytes[OBJECT_INTEGRITY_CHUNK_SIZE + 1] ^= 0xff;
  await assert.rejects(
    objects.openSpaceCanonicalObjectRange(
      "markdown",
      spaceId,
      stored.object.sha256,
      { offset: OBJECT_INTEGRITY_CHUNK_SIZE, length: 5 },
    ),
    (error) => error?.code === "object_tampered",
  );
});

test("Sites exact re-put repairs a missing integrity sidecar before publishing proof metadata", async () => {
  const bucket = new StreamingBucket();
  const objects = await createSitesObjectStore(bucket);
  const spaceId = "space_sites_integrity_repair";
  const bytes = new TextEncoder().encode(`legacy fallback\n${"body".repeat(20_000)}\n`);
  const stored = await objects.putSpaceCanonicalObject({
    kind: "markdown",
    spaceId,
    bytes,
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: CREATED_AT,
  });
  const canonicalKey = [...bucket.records.keys()].find((key) =>
    key.endsWith(`/objects/sha256/${stored.object.sha256.slice(7)}`));
  assert.ok(canonicalKey);
  const sidecarKey = [...bucket.records.entries()].find(([, record]) =>
    record.customMetadata.objectKey === canonicalKey)?.[0];
  assert.ok(sidecarKey);
  bucket.records.delete(sidecarKey);

  const verifiedFull = await objects.getSpaceCanonicalObject(
    "markdown",
    spaceId,
    stored.object.sha256,
  );
  assert.ok(verifiedFull);
  assert.deepEqual(verifiedFull.bytes, bytes);
  await assert.rejects(
    objects.openSpaceCanonicalObjectRange(
      "markdown",
      spaceId,
      stored.object.sha256,
      { offset: 0, length: 7 },
    ),
    (error) => error?.code === "range_unavailable",
  );

  const repaired = await objects.putSpaceCanonicalObject({
    kind: "markdown",
    spaceId,
    bytes,
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: "2026-08-24T00:00:00.000Z",
  });
  assert.equal(repaired.status, "already_exists");
  assert.equal(bucket.records.has(sidecarKey), true);
  const ranged = await objects.openSpaceCanonicalObjectRange(
    "markdown",
    spaceId,
    stored.object.sha256,
    { offset: 0, length: 7 },
  );
  assert.ok(ranged?.integrityProof);
});

test("Sites BundleFile re-put repairs a missing integrity sidecar", async () => {
  const bucket = new StreamingBucket();
  const objects = await createSitesObjectStore(bucket);
  const spaceId = "space_sites_bundle_integrity_repair";
  const stored = await objects.putBundleFile({
    spaceId,
    bytes: PNG,
    mediaType: "image/png",
    createdAt: CREATED_AT,
  });
  const bundleKey = [...bucket.records.keys()].find((key) =>
    key.endsWith(`/sha256/${stored.object.sha256.slice(7)}`) &&
    key.includes("bundle-files/"));
  assert.ok(bundleKey);
  const sidecarKey = [...bucket.records.entries()].find(([, record]) =>
    record.customMetadata.objectKey === bundleKey)?.[0];
  assert.ok(sidecarKey);
  bucket.records.delete(sidecarKey);

  const verifiedFull = await objects.getBundleFile(spaceId, stored.object.sha256);
  assert.ok(verifiedFull);
  assert.deepEqual(verifiedFull.bytes, PNG);
  const repaired = await objects.putBundleFile({
    spaceId,
    bytes: PNG,
    mediaType: "image/png",
    createdAt: "2026-08-24T00:00:00.000Z",
  });
  assert.equal(repaired.status, "already_exists");
  assert.equal(bucket.records.has(sidecarKey), true);
  const ranged = await objects.openBundleFileRange(
    spaceId,
    stored.object.sha256,
    { offset: 0, length: 4 },
  );
  assert.ok(ranged?.integrityProof);
});

test("bounded head reads authenticate returned Sites bytes before stopping at a newline", async () => {
  const bucket = new StreamingBucket();
  const objects = await createSitesObjectStore(bucket);
  const spaceId = "space_sites_head_integrity";
  const bytes = new TextEncoder().encode(`trusted\n${"body".repeat(20_000)}\n`);
  const stored = await objects.putSpaceCanonicalObject({
    kind: "markdown",
    spaceId,
    bytes,
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: CREATED_AT,
  });
  const entry = Object.freeze({
    path: "index.md",
    kind: "markdown",
    mediaType: MARKDOWN_MEDIA_TYPE,
    sha256: stored.object.sha256,
    size: bytes.byteLength,
    integrityRoot: stored.integrityRoot,
  });
  const loadFull = async () => {
    throw new Error("authenticated range support must not fall back to a full object read");
  };

  const clean = await loadTextFileHead(
    objects,
    spaceId,
    REVISION_MANIFEST_FORMAT_V5,
    entry,
    1,
    undefined,
    Date.now() + 1_000,
    loadFull,
  );
  assert.equal(clean.kind, "file");
  assert.equal(clean.file.text, "trusted\n");
  assert.equal(clean.complete, false);

  const canonicalKey = [...bucket.records.keys()].find((key) =>
    key.endsWith(`/objects/sha256/${stored.object.sha256.slice(7)}`));
  assert.ok(canonicalKey);
  bucket.records.get(canonicalKey).bytes[0] ^= 0xff;
  await assert.rejects(
    loadTextFileHead(
      objects,
      spaceId,
      REVISION_MANIFEST_FORMAT_V5,
      entry,
      1,
      undefined,
      Date.now() + 1_000,
      loadFull,
    ),
    (error) => error?.code === "revision_integrity_failure",
  );
});

test("revision-anchored root rejects coordinated object, sidecar and R2 metadata forgery", async () => {
  const bucket = new StreamingBucket();
  const objects = await createSitesObjectStore(bucket);
  const spaceId = "space_sites_coordinated_forgery";
  const bytes = new TextEncoder().encode(`trusted\n${"body".repeat(20_000)}\n`);
  const stored = await objects.putSpaceCanonicalObject({
    kind: "markdown",
    spaceId,
    bytes,
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: CREATED_AT,
  });
  const canonicalKey = [...bucket.records.keys()].find((key) =>
    key.endsWith(`/objects/sha256/${stored.object.sha256.slice(7)}`));
  assert.ok(canonicalKey);
  const canonical = bucket.records.get(canonicalKey);
  const sidecarEntry = [...bucket.records.entries()].find(([, record]) =>
    record.customMetadata.objectKey === canonicalKey);
  assert.ok(sidecarEntry);
  const [sidecarKey, sidecar] = sidecarEntry;
  const originalManifest = JSON.parse(new TextDecoder().decode(sidecar.bytes));

  canonical.bytes[0] = "f".charCodeAt(0);
  const forgedManifest = await forgeIntegrityManifest(objects, originalManifest, canonical.bytes);
  assert.notEqual(forgedManifest.root, stored.integrityRoot);
  const forgedBytes = new TextEncoder().encode(serializeObjectIntegrityManifest(forgedManifest));
  const forgedDigest = await objects.calculateSha256(forgedBytes);
  sidecar.bytes = forgedBytes;
  sidecar.customMetadata.root = forgedManifest.root;
  sidecar.customMetadata.manifestDigest = forgedDigest;
  canonical.customMetadata.integrityProofRoot = forgedManifest.root;
  canonical.customMetadata.integrityProofDigest = forgedDigest;
  bucket.records.set(sidecarKey, sidecar);

  const opened = await objects.openSpaceCanonicalObjectRange(
    "markdown",
    spaceId,
    stored.object.sha256,
    { offset: 0, length: 7 },
  );
  assert.equal(opened.integrityProof.root, forgedManifest.root);
  const entry = Object.freeze({
    path: "index.md",
    kind: "markdown",
    mediaType: MARKDOWN_MEDIA_TYPE,
    sha256: stored.object.sha256,
    size: bytes.byteLength,
    integrityRoot: stored.integrityRoot,
  });
  await assert.rejects(
    loadTextFileHead(
      objects,
      spaceId,
      REVISION_MANIFEST_FORMAT_V5,
      entry,
      1,
      undefined,
      Date.now() + 1_000,
      async () => { throw new Error("range proof must fail before full fallback"); },
    ),
    (error) => error?.code === "revision_integrity_failure",
  );
});

test("Sites staged writer uses the Cloudflare fixed-length stream for an exact source", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "FixedLengthStream");
  const requestedLengths = [];
  class ProbeFixedLengthStream {
    constructor(expectedLength) {
      requestedLengths.push(expectedLength);
      const transform = new TransformStream();
      this.readable = transform.readable;
      this.writable = transform.writable;
    }
  }
  Object.defineProperty(globalThis, "FixedLengthStream", {
    configurable: true,
    writable: true,
    value: ProbeFixedLengthStream,
  });
  try {
    const bucket = new StreamingBucket();
    const objects = await createSitesObjectStore(bucket);
    const upload = await objects.beginStagedBundleFileUpload({
      stagedFileId: "staged_stream_fixed_length",
      bindingOwnerId: "binding_owner_test",
      spaceId: "space_stream_test",
      createdAt: CREATED_AT,
      maxBytes: 64,
      expectedSize: PNG.byteLength,
    });
    await upload.write(PNG);
    const sha256 = await objects.calculateSha256(PNG);
    await upload.complete({ sha256, size: PNG.byteLength });
    assert.deepEqual(requestedLengths, [PNG.byteLength]);
    assert.deepEqual(
      (await objects.getStagedBundleFile("staged_stream_fixed_length")).bytes,
      PNG,
    );
  } finally {
    if (original === undefined) delete globalThis.FixedLengthStream;
    else Object.defineProperty(globalThis, "FixedLengthStream", original);
  }
});

test("Sites streamed export download preserves its exact HTTP length boundary", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "FixedLengthStream");
  const requestedLengths = [];
  class ProbeFixedLengthStream {
    constructor(expectedLength) {
      requestedLengths.push(expectedLength);
      const transform = new TransformStream();
      this.readable = transform.readable;
      this.writable = transform.writable;
    }
  }
  Object.defineProperty(globalThis, "FixedLengthStream", {
    configurable: true,
    writable: true,
    value: ProbeFixedLengthStream,
  });
  try {
    const bucket = new StreamingBucket();
    const objects = await createSitesObjectStore(bucket);
    const sha256 = await objects.calculateSha256(PNG);
    const upload = await objects.beginExportArchiveUpload({
      jobId: "export_sites_fixed_length",
      spaceId: "space_sites_fixed_length",
      claimVersion: 1,
      archiveFormat: "MD-BUNDLE-ZIP-1",
      filename: "mind-diary-bundle.zip",
      contentDisposition: 'attachment; filename="mind-diary-bundle.zip"',
      createdAt: CREATED_AT,
    });
    await upload.write(PNG);
    const completed = await upload.complete({ sha256, size: PNG.byteLength });
    assert.equal(completed.kind, "stored");

    const opened = await objects.openExportArchive(completed.archive.objectKey);
    assert.ok(opened);
    assert.equal(opened.body instanceof Uint8Array, false);
    assert.deepEqual(requestedLengths, [PNG.byteLength]);
    assert.deepEqual(
      new Uint8Array(await new Response(opened.body).arrayBuffer()),
      PNG,
    );

    const partRecord = [...bucket.records.entries()].find(([key]) =>
      key.includes("/stream/parts/"));
    assert.ok(partRecord);
    partRecord[1].bytes[0] ^= 0xff;
    const corrupted = await objects.openExportArchive(completed.archive.objectKey);
    await assert.rejects(
      corrupted.body.getReader().read(),
      /R2 export part is invalid/u,
    );
    assert.deepEqual(requestedLengths, [PNG.byteLength, PNG.byteLength]);
  } finally {
    if (original === undefined) delete globalThis.FixedLengthStream;
    else Object.defineProperty(globalThis, "FixedLengthStream", original);
  }
});

test("Sites export retry verifies a persisted part across conditional R2 races", async () => {
  class ThrowingConditionalBucket extends StreamingBucket {
    rejectedExistingPuts = 0;
    missExistingPartOnce = false;

    async get(key, options = {}) {
      if (this.missExistingPartOnce && key.includes("/stream/parts/") && this.records.has(key)) {
        this.missExistingPartOnce = false;
        return null;
      }
      return super.get(key, options);
    }

    async put(key, value, options = {}) {
      if (key.includes("/stream/parts/") && options.onlyIf?.etagDoesNotMatch === "*" && this.records.has(key)) {
        this.rejectedExistingPuts += 1;
        throw new Error("conditional put rejected an existing part");
      }
      return super.put(key, value, options);
    }
  }

  const bucket = new ThrowingConditionalBucket();
  const objects = await createSitesObjectStore(bucket);
  const bytes = Uint8Array.from({ length: 4_194_304 + 17 }, (_value, index) => index % 251);
  const sha256 = await objects.calculateSha256(bytes);
  const request = {
    jobId: "export_sites_existing_part",
    spaceId: "space_sites_existing_part",
    claimVersion: 2,
    archiveFormat: "MD-BUNDLE-ZIP-1",
    filename: "mind-diary-bundle.zip",
    contentDisposition: 'attachment; filename="mind-diary-bundle.zip"',
    createdAt: CREATED_AT,
  };

  const interrupted = await objects.beginExportArchiveUpload(request);
  await interrupted.write(bytes.subarray(0, 4_194_304));
  await interrupted.abort();
  bucket.missExistingPartOnce = true;
  const resumed = await objects.beginExportArchiveUpload(request);
  await resumed.write(bytes);
  const completed = await resumed.complete({ sha256, size: bytes.byteLength });
  assert.equal(completed.kind, "stored");
  assert.equal(bucket.rejectedExistingPuts, 1);
  const nextClaim = await objects.beginExportArchiveUpload({ ...request, claimVersion: 3 });
  await nextClaim.write(bytes);
  const replayed = await nextClaim.complete({ sha256, size: bytes.byteLength });
  assert.equal(replayed.kind, "stored");
  assert.equal(bucket.rejectedExistingPuts, 1);
  assert.equal([...bucket.records.keys()].filter((key) => key.includes("/stream/parts/")).length, 2);
  const opened = await objects.openExportArchive(completed.archive.objectKey);
  assert.ok(opened);
  assert.deepEqual(new Uint8Array(await new Response(opened.body).arrayBuffer()), bytes);
});

test("Sites export retry verifies the winner when a conditional R2 put returns null", async () => {
  class NullConditionalBucket extends StreamingBucket {
    hideExistingPartOnce = false;
    rejectedExistingPuts = 0;

    async get(key, options = {}) {
      if (this.hideExistingPartOnce && key.includes("/stream/parts/") && this.records.has(key)) {
        this.hideExistingPartOnce = false;
        return null;
      }
      return super.get(key, options);
    }

    async put(key, value, options = {}) {
      if (key.includes("/stream/parts/") && options.onlyIf?.etagDoesNotMatch === "*" && this.records.has(key)) {
        this.rejectedExistingPuts += 1;
      }
      return super.put(key, value, options);
    }
  }

  const bucket = new NullConditionalBucket();
  const objects = await createSitesObjectStore(bucket);
  const bytes = Uint8Array.from({ length: 4_194_304 }, (_value, index) => index % 251);
  const sha256 = await objects.calculateSha256(bytes);
  const request = {
    jobId: "export_sites_null_conditional_part",
    spaceId: "space_sites_null_conditional_part",
    claimVersion: 1,
    archiveFormat: "MD-BUNDLE-ZIP-1",
    filename: "mind-diary-bundle.zip",
    contentDisposition: 'attachment; filename="mind-diary-bundle.zip"',
    createdAt: CREATED_AT,
  };

  const interrupted = await objects.beginExportArchiveUpload(request);
  await interrupted.write(bytes);
  await interrupted.abort();
  bucket.hideExistingPartOnce = true;
  const resumed = await objects.beginExportArchiveUpload(request);
  await resumed.write(bytes);
  const completed = await resumed.complete({ sha256, size: bytes.byteLength });
  assert.equal(completed.kind, "stored");
  assert.equal(bucket.rejectedExistingPuts, 1);
  const opened = await objects.openExportArchive(completed.archive.objectKey);
  assert.ok(opened);
  assert.deepEqual(new Uint8Array(await new Response(opened.body).arrayBuffer()), bytes);
});

test("Sites export retry does not publish a manifest when a rejected part has no winner", async () => {
  class NullWithoutWinnerBucket extends StreamingBucket {
    async put(key, value, options = {}) {
      if (key.includes("/stream/parts/") && options.onlyIf?.etagDoesNotMatch === "*") return null;
      return super.put(key, value, options);
    }
  }

  const bucket = new NullWithoutWinnerBucket();
  const objects = await createSitesObjectStore(bucket);
  const upload = await objects.beginExportArchiveUpload({
    jobId: "export_sites_null_without_winner",
    spaceId: "space_sites_null_without_winner",
    claimVersion: 1,
    archiveFormat: "MD-BUNDLE-ZIP-1",
    filename: "mind-diary-bundle.zip",
    contentDisposition: 'attachment; filename="mind-diary-bundle.zip"',
    createdAt: CREATED_AT,
  });
  await assert.rejects(
    upload.write(new Uint8Array(4_194_304)),
    (error) => error?.code === "digest_collision",
  );
  assert.equal([...bucket.records.keys()].some((key) => key.endsWith("-manifest")), false);
});

test("Sites staged generated writer aborts partial streams without publication", async () => {
  const bucket = new StreamingBucket();
  const objects = await createSitesObjectStore(bucket);
  const upload = await objects.beginStagedBundleFileUpload({
    stagedFileId: "staged_stream_abort",
    bindingOwnerId: "binding_owner_test",
    spaceId: "space_stream_test",
    createdAt: CREATED_AT,
    maxBytes: 64,
  });
  await upload.write(PNG);
  await upload.abort();
  await upload.abort();
  assert.equal(bucket.records.size, 0);
  assert.equal(await objects.getStagedBundleFile("staged_stream_abort"), null);
});

test("Sites staged completion rejects and removes persisted digest corruption", async () => {
  const bucket = new CorruptingPersistedBucket();
  const objects = await createSitesObjectStore(bucket);
  const upload = await objects.beginStagedBundleFileUpload({
    stagedFileId: "staged_stream_corrupt",
    bindingOwnerId: "binding_owner_test",
    spaceId: "space_stream_test",
    createdAt: CREATED_AT,
    maxBytes: 64,
  });
  await upload.write(PNG);
  const sha256 = await objects.calculateSha256(PNG);
  await assert.rejects(
    upload.complete({ sha256, size: PNG.byteLength }),
    (error) => error?.code === "object_tampered",
  );
  assert.equal(bucket.records.has("staged-bundle-files/staged_stream_corrupt"), false);
});

test("Sites promotion and canonical open use R2 body streams without arrayBuffer", async () => {
  const bucket = new StreamingBucket();
  const objects = await createSitesObjectStore(bucket);
  const upload = await objects.beginStagedBundleFileUpload({
    stagedFileId: "staged_stream_promote",
    bindingOwnerId: "binding_owner_test",
    spaceId: "space_stream_test",
    createdAt: CREATED_AT,
    maxBytes: 64,
  });
  await upload.write(PNG.subarray(0, 4));
  await upload.write(PNG.subarray(4));
  const sha256 = await objects.calculateSha256(PNG);
  await upload.complete({ sha256, size: PNG.byteLength });

  const promoted = await objects.promoteStagedBundleFile({
    stagedFileId: "staged_stream_promote",
    bindingOwnerId: "binding_owner_test",
    spaceId: "space_stream_test",
    sha256,
    mediaType: "image/png",
    size: PNG.byteLength,
    createdAt: CREATED_AT,
  });
  assert.equal(promoted.status, "stored");
  assert.equal(
    [...bucket.records.values()].reduce(
      (total, record) => total + (record.arrayBufferReads ?? 0),
      0,
    ),
    0,
  );

  const opened = await objects.openBundleFile("space_stream_test", sha256);
  assert.ok(opened);
  assert.deepEqual(
    new Uint8Array(await new Response(opened.body).arrayBuffer()),
    PNG,
  );
  assert.equal(
    [...bucket.records.values()].reduce(
      (total, record) => total + (record.arrayBufferReads ?? 0),
      0,
    ),
    0,
  );
});

test("Sites staged generated writer rejects an existing staged ID before opening a stream", async () => {
  const bucket = new StreamingBucket();
  const existing = foreignStagedRecord("staged_stream_existing");
  bucket.records.set(existing.key, existing);
  const objects = await createSitesObjectStore(bucket);

  await assert.rejects(
    objects.beginStagedBundleFileUpload({
      stagedFileId: "staged_stream_existing",
      bindingOwnerId: "binding_owner_test",
      spaceId: "space_stream_test",
      createdAt: CREATED_AT,
      maxBytes: 64,
    }),
    (error) => error?.code === "digest_collision",
  );
  assert.deepEqual(bucket.records.get(existing.key)?.bytes, existing.bytes);
  assert.equal(bucket.records.get(existing.key)?.etag, "foreign-etag");
});

test("Sites staged generated writer settles a conditional-put race without deleting the winner", async () => {
  const bucket = new PreflightBlindCollisionBucket();
  const existing = foreignStagedRecord("staged_stream_race");
  bucket.records.set(existing.key, existing);
  const objects = await createSitesObjectStore(bucket);
  const upload = await objects.beginStagedBundleFileUpload({
    stagedFileId: "staged_stream_race",
    bindingOwnerId: "binding_owner_test",
    spaceId: "space_stream_test",
    createdAt: CREATED_AT,
    maxBytes: 64,
  });

  await assert.rejects(
    settlesWithin(upload.write(PNG)),
    (error) => error?.code === "digest_collision",
  );
  await settlesWithin(upload.abort());
  assert.deepEqual(bucket.records.get(existing.key)?.bytes, existing.bytes);
  assert.equal(bucket.records.get(existing.key)?.etag, "foreign-etag");
});
