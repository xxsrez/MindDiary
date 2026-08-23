import assert from "node:assert/strict";
import test from "node:test";

import { createSitesObjectStore } from "@mind-diary/adapter-object-sites";
import { ObjectStoreFailure } from "@mind-diary/application-ports";

const DIGEST = `sha256:${"a".repeat(64)}`;
const CREATED_AT = "2026-08-23T00:00:00.000Z";

function emptyBucket(overrides = {}) {
  return {
    get: async () => null,
    put: async () => null,
    delete: async () => undefined,
    list: async () => ({ objects: [], truncated: false }),
    ...overrides,
  };
}

test("Sites object reads fail closed when R2 lookup never settles", async () => {
  const bucket = emptyBucket({
    get: () => new Promise(() => {}),
  });
  const objects = await createSitesObjectStore(bucket);

  await assert.rejects(
    objects.getSpaceCanonicalObject("markdown", "space_timeout", DIGEST),
    (error) =>
      error instanceof ObjectStoreFailure &&
      error.code === "object_read_timeout" &&
      error.message === "R2 object lookup timed out",
  );
});

test("Sites object reads fail closed when the R2 body never settles", async () => {
  const bucket = emptyBucket({
    get: async () => ({
      key: "spaces/space_timeout/objects/sha256/a",
      size: 1,
      etag: "etag",
      customMetadata: {
        schema: "md-r2-space-canonical-v1",
        kind: "markdown",
        spaceId: "space_timeout",
        sha256: DIGEST,
        mediaType: "text/markdown; charset=utf-8",
        size: "1",
        createdAt: CREATED_AT,
        protectedAt: CREATED_AT,
      },
      arrayBuffer: () => new Promise(() => {}),
    }),
  });
  const objects = await createSitesObjectStore(bucket);

  await assert.rejects(
    objects.getSpaceCanonicalObject("markdown", "space_timeout", DIGEST),
    (error) =>
      error instanceof ObjectStoreFailure &&
      error.code === "object_read_timeout" &&
      error.message === "R2 object body read timed out",
  );
});
