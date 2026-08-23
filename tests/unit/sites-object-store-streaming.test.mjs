import assert from "node:assert/strict";
import test from "node:test";

import { createSitesObjectStore } from "@mind-diary/adapter-object-sites";

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
    this.#bytes = new Uint8Array(record.bytes);
  }

  #bytes;

  async arrayBuffer() {
    return new Uint8Array(this.#bytes).buffer;
  }
}

class StreamingBucket {
  records = new Map();
  #version = 0;

  async get(key) {
    const record = this.records.get(key);
    return record === undefined ? null : new Body(record);
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
