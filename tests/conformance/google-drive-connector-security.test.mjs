import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { GoogleDriveConnectorObjectSource } from "@mind-diary/composition-root";
import { ConnectorObjectStreamFailure } from "@mind-diary/application-content";

const OPAQUE_BEARER = "drive_token_must_never_escape";
const GRANT = "drive_grant_must_never_escape";
const BINDING = "drive_binding_must_never_escape";
const OBJECT = "drive_object_must_never_escape";
const ACTOR = Object.freeze({ kind: "registered_principal" });
const LIMITS = Object.freeze({
  maxBytes: 268_435_456,
  fetchTimeoutMilliseconds: 30_000,
  maxRedirects: 4,
});
const BYTES = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
const DIGEST = createHash("sha256").update(BYTES).digest("hex");

function metadata() {
  return {
    id: OBJECT,
    name: "private.bin",
    mimeType: "application/octet-stream",
    size: String(BYTES.byteLength),
    sha256Checksum: DIGEST,
    trashed: false,
    capabilities: { canDownload: true },
    version: "1",
    headRevisionId: "revision_private",
    ownedByMe: true,
    owners: [{ permissionId: "owner_private" }],
  };
}

function source(grants, fetcher) {
  return new GoogleDriveConnectorObjectSource({
    bindingRef: BINDING,
    objectId: OBJECT,
  }, { grants, fetcher });
}

test("missing, revoked and foreign grants are externally indistinguishable", async (t) => {
  for (const kind of ["missing", "revoked", "foreign"]) {
    await t.test(kind, async () => {
      let fetched = false;
      const result = await source({
        async resolve() { return { kind }; },
      }, async () => {
        fetched = true;
        throw new Error("must not fetch");
      }).readVerifiedSnapshot({
        actor: ACTOR,
        representation: { kind: "binary" },
        limits: LIMITS,
      });
      assert.deepEqual(result, {
        kind: "unavailable",
        failure: "source_unavailable",
      });
      assert.equal(fetched, false);
    });
  }
});

test("provider errors and stream failures expose no token, locator, grant or URL", async () => {
  const grants = {
    async resolve() {
      return {
        kind: "authorized",
        accessToken: OPAQUE_BEARER,
        grantFingerprint: GRANT,
      };
    },
  };
  let metadataCalls = 0;
  const adapter = source(grants, async (input) => {
    const url = new URL(String(input));
    if (url.searchParams.get("alt") !== "media") {
      metadataCalls += 1;
      return new Response(JSON.stringify(metadata()), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(BYTES.subarray(0, 1));
        controller.error(new Error(`${OPAQUE_BEARER}:${GRANT}:${BINDING}:${OBJECT}:${url.href}`));
      },
    }), {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(BYTES.byteLength),
      },
    });
  });
  const result = await adapter.readVerifiedSnapshot({
    actor: ACTOR,
    representation: { kind: "binary" },
    limits: LIMITS,
  });
  assert.equal(result.kind, "ready");
  const serialized = JSON.stringify(result);
  for (const forbidden of [OPAQUE_BEARER, GRANT, BINDING, OBJECT, "googleapis.com"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  await assert.rejects(
    async () => {
      for await (const _chunk of result.input.stream) {
        // Consume the exact provider stream to surface the injected failure.
      }
    },
    (error) => {
      assert.equal(error instanceof ConnectorObjectStreamFailure, true);
      assert.equal(error.failure, "transport_unavailable");
      assert.equal(error.retryable, true);
      assert.equal(error.message, "Connector object snapshot is unavailable");
      for (const forbidden of [OPAQUE_BEARER, GRANT, BINDING, OBJECT, "googleapis.com"]) {
        assert.equal(error.message.includes(forbidden), false, forbidden);
      }
      return true;
    },
  );
  assert.equal(metadataCalls, 2);
});
