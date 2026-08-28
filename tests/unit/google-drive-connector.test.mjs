import assert from "node:assert/strict";
import test from "node:test";

import {
  GOOGLE_DRIVE_CONNECTOR_LIMITS,
  GoogleDriveConnectorObjectSource,
  createGoogleDriveConnectorIngress,
  createGoogleDriveRunConnectorStageOperation,
} from "@mind-diary/composition-root";
import {
  AuthorizedConnectorIngressService,
} from "@mind-diary/application-content";
import {
  GOOGLE_DRIVE_FIXTURES,
  driveMetadata,
  sha256,
} from "../fixtures/google-drive-connector.mjs";

const OPAQUE_BEARER = "drive_access_token_sensitive";
const GRANT = "drive_grant_fingerprint_sensitive";
const BINDING = "drive_binding_reference_sensitive";
const TARGET_OWNER = "target_owner_google_drive_unit";
const TARGET_GENERATION = "target_generation_google_drive_unit";
const SPACE = "space_google_drive_unit";
const RUN_FINGERPRINT = `sha256:${"b".repeat(64)}`;
const CLEANUP_OWNER = "cleanup_owner_google_drive_unit";
const ACTOR = Object.freeze({
  kind: "registered_principal",
  principalId: "principal_google_drive_unit",
  authentication: Object.freeze({
    kind: "mcp_token",
    bindingOwnerId: TARGET_OWNER,
  }),
});
const LIMITS = Object.freeze({
  maxBytes: 268_435_456,
  fetchTimeoutMilliseconds: 30_000,
  maxRedirects: 4,
});
const ALLOWED = Object.freeze({
  kind: "allowed",
  capability: "content:write",
  grant: Object.freeze({ kind: "membership", role: "editor" }),
  stamp: Object.freeze({ accessVersion: 1, membershipVersion: 1, tokenVersion: 1 }),
});

function targetReader(spaceId = SPACE) {
  return {
    async readCredentialWriteTarget(ownerId, principalId) {
      assert.equal(ownerId, TARGET_OWNER);
      assert.equal(principalId, ACTOR.principalId);
      return {
        kind: "current",
        state: {
          bindingOwnerId: TARGET_OWNER,
          principalId: ACTOR.principalId,
          lifecycleState: "active",
          targetVersion: 1,
          activeGeneration: {
            generationId: TARGET_GENERATION,
            bindingOwnerId: TARGET_OWNER,
            spaceId,
          },
        },
      };
    },
  };
}

function selection(objectId) {
  return { bindingRef: BINDING, objectId };
}

function runProviderBinding(objectId) {
  return Object.freeze({
    bindingRef: BINDING,
    objectId,
    runOwnership: Object.freeze({
      runFingerprint: RUN_FINGERPRINT,
      cleanupOwnerRef: CLEANUP_OWNER,
    }),
  });
}

function authorizedGrants(overrides = {}) {
  let calls = 0;
  return {
    calls: () => calls,
    async resolve(request) {
      calls += 1;
      assert.equal(request.actor, ACTOR);
      assert.equal(request.bindingRef, BINDING);
      return typeof overrides.resolve === "function"
        ? overrides.resolve(calls)
        : {
            kind: "authorized",
            accessToken: OPAQUE_BEARER,
            grantFingerprint: GRANT,
          };
    },
  };
}

function fakeProvider(fixture, options = {}) {
  const calls = [];
  let metadataReads = 0;
  let contentReads = 0;
  return {
    calls,
    metadataReads: () => metadataReads,
    contentReads: () => contentReads,
    async fetcher(input, init) {
      const url = new URL(String(input));
      calls.push({ url, init });
      assert.equal(url.origin, "https://www.googleapis.com");
      assert.equal(init.redirect, "manual");
      assert.equal(init.credentials, "omit");
      assert.equal(init.referrerPolicy, "no-referrer");
      assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${OPAQUE_BEARER}`);
      if (typeof options.response === "function") {
        const replaced = options.response({ url, init, calls });
        if (replaced !== undefined) return replaced;
      }
      const isExport = url.pathname.endsWith("/export");
      const isBinary = url.searchParams.get("alt") === "media";
      if (!isExport && !isBinary) {
        metadataReads += 1;
        const override = typeof options.metadata === "function"
          ? options.metadata(metadataReads)
          : {};
        const body = JSON.stringify(driveMetadata(fixture, override));
        return new Response(body, {
          headers: {
            "content-type": "application/json",
            "content-length": String(new TextEncoder().encode(body).byteLength),
            etag: `"${fixture.version}"`,
          },
        });
      }
      contentReads += 1;
      const bytes = typeof options.bytes === "function"
        ? options.bytes(contentReads)
        : fixture.bytes;
      const mediaType = isExport ? fixture.exportMediaType : fixture.mediaType;
      return new Response(bytes, {
        headers: {
          "content-type": mediaType,
          "content-length": String(bytes.byteLength),
        },
      });
    },
  };
}

async function collect(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function consumingIngress() {
  return new AuthorizedConnectorIngressService({
    targets: targetReader(),
    staging: {
      async authorizeSourceRead() { return ALLOWED; },
      async stageStream(request) {
        try {
          await collect(request.stream);
          return { kind: "staged", record: {}, replayed: false };
        } catch {
          return { kind: "stream_invalid", code: "stream_transport_unavailable" };
        }
      },
    },
  });
}

function stageSource(source, requestedRepresentation) {
  return consumingIngress().stage({
    actor: ACTOR,
    spaceId: SPACE,
    source,
    representation: requestedRepresentation,
    idempotencyKey: "stage-google-drive-unit",
  });
}

function representation(fixture) {
  return fixture.format === undefined
    ? { kind: "binary" }
    : {
        kind: "export_snapshot",
        format: fixture.format,
        displayFilename: fixture.displayFilename,
        mediaType: fixture.exportMediaType,
      };
}

test("binary Drive object is streamed byte-for-byte through a fixed provider origin", async () => {
  const fixture = GOOGLE_DRIVE_FIXTURES.binary;
  const grants = authorizedGrants();
  const provider = fakeProvider(fixture);
  const source = new GoogleDriveConnectorObjectSource(selection(fixture.objectId), {
    grants,
    fetcher: provider.fetcher,
  });
  const result = await source.readVerifiedSnapshot({
    actor: ACTOR,
    representation: { kind: "binary" },
    limits: LIMITS,
  });
  assert.equal(result.kind, "ready");
  assert.deepEqual(Object.keys(result.input).sort(), [
    "advisoryMediaType",
    "displayFilename",
    "representation",
    "sha256",
    "size",
    "sourceKind",
    "stream",
  ]);
  assert.equal(result.input.displayFilename, fixture.name);
  assert.equal(result.input.advisoryMediaType, fixture.mediaType);
  assert.equal(result.input.sha256, sha256(fixture.bytes));
  assert.deepEqual(await collect(result.input.stream), fixture.bytes);
  assert.equal(provider.metadataReads(), 3);
  assert.equal(provider.contentReads(), 1);
  assert.equal(grants.calls(), 4);
  assert.equal(
    provider.calls.some(({ url }) => url.searchParams.get("alt") === "media"),
    true,
  );
});

test("Docs, Sheets and Slides require an explicit supported export snapshot", async (t) => {
  for (const fixture of [
    GOOGLE_DRIVE_FIXTURES.document,
    GOOGLE_DRIVE_FIXTURES.spreadsheet,
    GOOGLE_DRIVE_FIXTURES.presentation,
  ]) {
    await t.test(fixture.format, async () => {
      const grants = authorizedGrants();
      const sharedDriveId = `shared_${fixture.objectId}`;
      const provider = fakeProvider(fixture, {
        metadata() {
          return {
            driveId: sharedDriveId,
            ownedByMe: undefined,
            owners: undefined,
          };
        },
      });
      const source = new GoogleDriveConnectorObjectSource(selection(fixture.objectId), {
        grants,
        fetcher: provider.fetcher,
      });
      const binary = await source.readVerifiedSnapshot({
        actor: ACTOR,
        representation: { kind: "binary" },
        limits: LIMITS,
      });
      assert.deepEqual(binary, {
        kind: "unavailable",
        failure: "source_unavailable",
      });
      const exported = await source.readVerifiedSnapshot({
        actor: ACTOR,
        representation: representation(fixture),
        limits: LIMITS,
      });
      assert.equal(exported.kind, "ready");
      assert.equal(exported.input.representation.kind, "export_snapshot");
      assert.equal(exported.input.displayFilename, fixture.displayFilename);
      assert.equal(exported.input.advisoryMediaType, fixture.exportMediaType);
      assert.equal(exported.input.sha256, sha256(fixture.bytes));
      assert.deepEqual(await collect(exported.input.stream), fixture.bytes);
      assert.equal(provider.contentReads(), 2);
      const exportCalls = provider.calls.filter(({ url }) =>
        url.pathname.endsWith("/export")
      );
      assert.equal(exportCalls.length, 2);
      assert.equal(
        exportCalls.every(({ url }) =>
          url.searchParams.get("mimeType") === fixture.exportMediaType &&
          url.searchParams.has("supportsAllDrives") === false
        ),
        true,
      );
      assert.equal(
        provider.calls.filter(({ url }) => !url.pathname.endsWith("/export"))
          .every(({ url }) =>
            url.searchParams.get("supportsAllDrives") === "true"
          ),
        true,
      );
    });
  }
});

test("unsupported or implicit native export formats never fetch export bytes", async () => {
  const fixture = GOOGLE_DRIVE_FIXTURES.document;
  const provider = fakeProvider(fixture);
  const source = new GoogleDriveConnectorObjectSource(selection(fixture.objectId), {
    grants: authorizedGrants(),
    fetcher: provider.fetcher,
  });
  for (const requested of [
    {
      kind: "export_snapshot",
      format: "google-drive/xlsx",
      displayFilename: "document.xlsx",
      mediaType: GOOGLE_DRIVE_FIXTURES.spreadsheet.exportMediaType,
    },
    {
      kind: "export_snapshot",
      format: "google-drive/docx",
      displayFilename: "document.pdf",
      mediaType: GOOGLE_DRIVE_FIXTURES.document.exportMediaType,
    },
  ]) {
    assert.deepEqual(await source.readVerifiedSnapshot({
      actor: ACTOR,
      representation: requested,
      limits: LIMITS,
    }), {
      kind: "unavailable",
      failure: "source_unavailable",
    });
  }
  assert.equal(provider.contentReads(), 0);
});

test("native export race fails when the explicit snapshot bytes change", async () => {
  const fixture = GOOGLE_DRIVE_FIXTURES.document;
  const changed = new Uint8Array(fixture.bytes);
  changed[changed.byteLength - 1] ^= 0xff;
  const provider = fakeProvider(fixture, {
    bytes(read) { return read === 1 ? fixture.bytes : changed; },
  });
  const { ingress, source } = createGoogleDriveConnectorIngress({
    selection: selection(fixture.objectId),
    grants: authorizedGrants(),
    fetcher: provider.fetcher,
    targets: targetReader("space_native_export_race"),
    staging: {
      async authorizeSourceRead() { return ALLOWED; },
      async stageStream(request) {
        try {
          await collect(request.stream);
          return { kind: "staged", record: {}, replayed: false };
        } catch {
          return { kind: "stream_invalid", code: "stream_transport_unavailable" };
        }
      },
    },
  });
  const result = await ingress.stage({
    actor: ACTOR,
    spaceId: "space_native_export_race",
    source,
    representation: representation(fixture),
    idempotencyKey: "stage-native-export-race",
  });
  assert.deepEqual(result, {
    kind: "invalid",
    code: "file_ingress_source_unavailable",
    retryable: false,
  });
  assert.equal(provider.contentReads(), 2);
});

test("grant revocation and object mutation after selection abort the lazy stream", async (t) => {
  await t.test("grant revoked", async () => {
    const fixture = GOOGLE_DRIVE_FIXTURES.binary;
    const grants = authorizedGrants({
      resolve(call) {
        return call === 1
          ? {
              kind: "authorized",
              accessToken: OPAQUE_BEARER,
              grantFingerprint: GRANT,
            }
          : { kind: "revoked" };
      },
    });
    const source = new GoogleDriveConnectorObjectSource(selection(fixture.objectId), {
      grants,
      fetcher: fakeProvider(fixture).fetcher,
    });
    assert.deepEqual(await stageSource(source, { kind: "binary" }), {
      kind: "invalid",
      code: "file_ingress_source_unavailable",
      retryable: false,
    });
  });

  await t.test("object ownership/version changed", async () => {
    const fixture = GOOGLE_DRIVE_FIXTURES.binary;
    const provider = fakeProvider(fixture, {
      metadata(read) {
        return read < 2 ? {} : {
          version: "18",
          ownedByMe: false,
          owners: [{ permissionId: "different_owner" }],
        };
      },
    });
    const source = new GoogleDriveConnectorObjectSource(selection(fixture.objectId), {
      grants: authorizedGrants(),
      fetcher: provider.fetcher,
    });
    assert.deepEqual(await stageSource(source, { kind: "binary" }), {
      kind: "invalid",
      code: "file_ingress_source_unavailable",
      retryable: false,
    });
    assert.equal(provider.contentReads(), 0);
  });
});

test("redirects, oversize and arbitrary URL-shaped selection fail closed", async () => {
  const fixture = GOOGLE_DRIVE_FIXTURES.binary;
  let fetched = 0;
  const redirected = new GoogleDriveConnectorObjectSource(selection(fixture.objectId), {
    grants: authorizedGrants(),
    fetcher: async () => {
      fetched += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "https://attacker.invalid/object" },
      });
    },
  });
  assert.deepEqual(await redirected.readVerifiedSnapshot({
    actor: ACTOR,
    representation: { kind: "binary" },
    limits: LIMITS,
  }), {
    kind: "unavailable",
    failure: "transport_unavailable",
    retryable: false,
  });
  assert.equal(fetched, 1);

  const oversizeProvider = fakeProvider(fixture, {
    metadata() { return { size: String(268_435_457) }; },
  });
  const oversize = new GoogleDriveConnectorObjectSource(selection(fixture.objectId), {
    grants: authorizedGrants(),
    fetcher: oversizeProvider.fetcher,
  });
  assert.deepEqual(await oversize.readVerifiedSnapshot({
    actor: ACTOR,
    representation: { kind: "binary" },
    limits: LIMITS,
  }), {
    kind: "unavailable",
    failure: "source_unavailable",
  });
  assert.equal(oversizeProvider.contentReads(), 0);

  let resolverCalled = false;
  const urlSelection = new GoogleDriveConnectorObjectSource({
    bindingRef: BINDING,
    objectId: fixture.objectId,
    url: "https://www.googleapis.com/drive/v3/files/anything",
  }, {
    grants: {
      async resolve() {
        resolverCalled = true;
        return { kind: "revoked" };
      },
    },
    fetcher: async () => { throw new Error("must not fetch"); },
  });
  assert.deepEqual(await urlSelection.readVerifiedSnapshot({
    actor: ACTOR,
    representation: { kind: "binary" },
    limits: LIMITS,
  }), {
    kind: "unavailable",
    failure: "source_unavailable",
  });
  assert.equal(resolverCalled, false);
});

test("native export provider limit is enforced before staging", async () => {
  const fixture = GOOGLE_DRIVE_FIXTURES.document;
  const provider = fakeProvider(fixture, {
    response({ url }) {
      if (url.pathname.endsWith("/export")) {
        return new Response(Uint8Array.of(1), {
          headers: {
            "content-type": fixture.exportMediaType,
            "content-length": String(
              GOOGLE_DRIVE_CONNECTOR_LIMITS.maxNativeExportBytes + 1,
            ),
          },
        });
      }
    },
  });
  const source = new GoogleDriveConnectorObjectSource(selection(fixture.objectId), {
    grants: authorizedGrants(),
    fetcher: provider.fetcher,
  });
  assert.deepEqual(await source.readVerifiedSnapshot({
    actor: ACTOR,
    representation: representation(fixture),
    limits: LIMITS,
  }), {
    kind: "unavailable",
    failure: "source_unavailable",
  });
});

test("run-scoped stage resolves target before exact provider binding and preserves cleanup ownership", async () => {
  const fixture = GOOGLE_DRIVE_FIXTURES.binary;
  const providerBinding = runProviderBinding(fixture.objectId);
  const provider = fakeProvider(fixture);
  const events = [];
  const storeBindings = [];
  const staged = [];
  const operation = createGoogleDriveRunConnectorStageOperation({
    grantStore: {
      async resolveRunObjectGrant(request) {
        events.push("grant-store");
        assert.equal(request.actor, ACTOR);
        storeBindings.push(request.providerBinding);
        return {
          kind: "authorized",
          providerBinding,
          accessToken: OPAQUE_BEARER,
          grantFingerprint: GRANT,
        };
      },
    },
    async fetcher(input, init) {
      events.push("provider-read");
      return provider.fetcher(input, init);
    },
    targets: {
      async readCredentialWriteTarget(ownerId, principalId) {
        events.push("target-read");
        return targetReader().readCredentialWriteTarget(ownerId, principalId);
      },
    },
    staging: {
      async authorizeSourceRead() {
        events.push("mind-authorization");
        return ALLOWED;
      },
      async stageStream(request) {
        events.push("stage-stream");
        await collect(request.stream);
        staged.push(request);
        return { kind: "staged", record: {}, replayed: false };
      },
    },
  });

  assert.deepEqual(await operation.stage({
    actor: ACTOR,
    spaceId: SPACE,
    providerBinding,
    representation: { kind: "binary" },
    idempotencyKey: "run-stage-google-drive-unit",
  }), {
    kind: "staged",
    record: {},
    replayed: false,
  });
  assert.deepEqual(events.slice(0, 4), [
    "target-read",
    "mind-authorization",
    "grant-store",
    "provider-read",
  ]);
  assert.equal(storeBindings.length, 4);
  for (const value of storeBindings) assert.deepEqual(value, providerBinding);
  assert.equal(staged.length, 1);
  assert.equal(staged[0].sourceKind, "connector_object");
  for (const forbidden of [
    "providerBinding", "bindingRef", "objectId", "runOwnership", "accessToken",
  ]) assert.equal(forbidden in staged[0], false, forbidden);
});

test("run-scoped stage never resolves a grant or provider before writable target authorization", async () => {
  const fixture = GOOGLE_DRIVE_FIXTURES.binary;
  let storeReads = 0;
  let providerReads = 0;
  let authorizationReads = 0;
  const operation = createGoogleDriveRunConnectorStageOperation({
    grantStore: {
      async resolveRunObjectGrant() {
        storeReads += 1;
        throw new Error("must not resolve");
      },
    },
    async fetcher() {
      providerReads += 1;
      throw new Error("must not fetch");
    },
    targets: {
      async readCredentialWriteTarget() { return null; },
    },
    staging: {
      async authorizeSourceRead() {
        authorizationReads += 1;
        return ALLOWED;
      },
      async stageStream() { throw new Error("must not stage"); },
    },
  });

  assert.deepEqual(await operation.stage({
    actor: ACTOR,
    spaceId: SPACE,
    providerBinding: runProviderBinding(fixture.objectId),
    representation: { kind: "binary" },
    idempotencyKey: "run-stage-no-target",
  }), {
    kind: "invalid",
    code: "writable_target_unavailable",
  });
  assert.equal(authorizationReads, 0);
  assert.equal(storeReads, 0);
  assert.equal(providerReads, 0);
});

test("run-scoped grant revoke during stream verification fails closed", async () => {
  const fixture = GOOGLE_DRIVE_FIXTURES.binary;
  const providerBinding = runProviderBinding(fixture.objectId);
  const provider = fakeProvider(fixture);
  let storeReads = 0;
  let durableStages = 0;
  const operation = createGoogleDriveRunConnectorStageOperation({
    grantStore: {
      async resolveRunObjectGrant() {
        storeReads += 1;
        return storeReads === 1
          ? {
              kind: "authorized",
              providerBinding,
              accessToken: OPAQUE_BEARER,
              grantFingerprint: GRANT,
            }
          : { kind: "revoked" };
      },
    },
    fetcher: provider.fetcher,
    targets: targetReader(),
    staging: {
      async authorizeSourceRead() { return ALLOWED; },
      async stageStream(request) {
        try {
          await collect(request.stream);
          durableStages += 1;
          return { kind: "staged", record: {}, replayed: false };
        } catch {
          return { kind: "stream_invalid", code: "stream_transport_unavailable" };
        }
      },
    },
  });

  assert.deepEqual(await operation.stage({
    actor: ACTOR,
    spaceId: SPACE,
    providerBinding,
    representation: { kind: "binary" },
    idempotencyKey: "run-stage-revoked",
  }), {
    kind: "invalid",
    code: "file_ingress_source_unavailable",
    retryable: false,
  });
  assert.equal(storeReads, 2);
  assert.equal(provider.metadataReads(), 1);
  assert.equal(provider.contentReads(), 0);
  assert.equal(durableStages, 0);
});

test("run-scoped stage rejects mismatched or expanded provider bindings", async (t) => {
  const fixture = GOOGLE_DRIVE_FIXTURES.binary;
  const providerBinding = runProviderBinding(fixture.objectId);
  await t.test("store echoes different cleanup owner", async () => {
    let providerReads = 0;
    const operation = createGoogleDriveRunConnectorStageOperation({
      grantStore: {
        async resolveRunObjectGrant() {
          return {
            kind: "authorized",
            providerBinding: {
              ...providerBinding,
              runOwnership: {
                ...providerBinding.runOwnership,
                cleanupOwnerRef: "cleanup_owner_other",
              },
            },
            accessToken: OPAQUE_BEARER,
            grantFingerprint: GRANT,
          };
        },
      },
      async fetcher() {
        providerReads += 1;
        throw new Error("must not fetch");
      },
      targets: targetReader(),
      staging: {
        async authorizeSourceRead() { return ALLOWED; },
        async stageStream() { throw new Error("must not stage"); },
      },
    });
    assert.deepEqual(await operation.stage({
      actor: ACTOR,
      spaceId: SPACE,
      providerBinding,
      representation: { kind: "binary" },
      idempotencyKey: "run-stage-owner-mismatch",
    }), {
      kind: "invalid",
      code: "file_ingress_source_unavailable",
      retryable: false,
    });
    assert.equal(providerReads, 0);
  });

  await t.test("URL-shaped expansion is not a provider binding", async () => {
    let storeReads = 0;
    let providerReads = 0;
    const operation = createGoogleDriveRunConnectorStageOperation({
      grantStore: {
        async resolveRunObjectGrant() {
          storeReads += 1;
          return { kind: "revoked" };
        },
      },
      async fetcher() {
        providerReads += 1;
        throw new Error("must not fetch");
      },
      targets: targetReader(),
      staging: {
        async authorizeSourceRead() { return ALLOWED; },
        async stageStream() { throw new Error("must not stage"); },
      },
    });
    assert.deepEqual(await operation.stage({
      actor: ACTOR,
      spaceId: SPACE,
      providerBinding: {
        ...providerBinding,
        url: "https://www.googleapis.com/drive/v3/files/anything",
      },
      representation: { kind: "binary" },
      idempotencyKey: "run-stage-url-expanded",
    }), {
      kind: "invalid",
      code: "file_ingress_source_unavailable",
      retryable: false,
    });
    assert.equal(storeReads, 0);
    assert.equal(providerReads, 0);
  });
});
