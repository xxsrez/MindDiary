import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthorizedConnectorIngressService,
  CONNECTOR_OBJECT_LIMITS,
  ConnectorObjectStreamFailure,
} from "@mind-diary/application-content";

const SHA256 = `sha256:${"a".repeat(64)}`;
const COMMON = {
  actor: { kind: "registered_principal" },
  spaceId: "space_connector",
  writeBindingId: "write_connector",
  representation: { kind: "binary" },
  idempotencyKey: "connector-stage",
};

const ALLOWED = Object.freeze({
  kind: "allowed",
  capability: "content:write",
  grant: Object.freeze({ kind: "membership", role: "editor" }),
  stamp: Object.freeze({
    accessVersion: 1,
    membershipVersion: 1,
    tokenVersion: 1,
  }),
});

function verifiedInput(overrides = {}) {
  return {
    sourceKind: "connector_object",
    representation: COMMON.representation,
    stream: (async function* () { yield Uint8Array.of(1); })(),
    displayFilename: "connector.bin",
    advisoryMediaType: "application/octet-stream",
    size: 1,
    sha256: SHA256,
    ...overrides,
  };
}

function fixture(
  sourceResult,
  stageResult = { kind: "invalid", code: "fixture_result" },
  options = {},
) {
  const reads = [];
  const stages = [];
  const service = new AuthorizedConnectorIngressService({
    ...options,
    staging: {
      async authorizeSourceRead() {
        return ALLOWED;
      },
      async stageStream(request) {
        stages.push(request);
        return stageResult;
      },
    },
  });
  const source = {
    async readVerifiedSnapshot(request) {
      reads.push(request);
      return typeof sourceResult === "function" ? sourceResult(request) : sourceResult;
    },
  };
  return { service, source, reads, stages };
}

test("current Mind write authorization is checked before connector metadata", async () => {
  let reads = 0;
  const denied = Object.freeze({
    kind: "denied",
    code: "write_binding_stale",
    retryable: false,
  });
  const service = new AuthorizedConnectorIngressService({
    staging: {
      async authorizeSourceRead(request) {
        assert.equal(request.spaceId, COMMON.spaceId);
        assert.equal(request.writeBindingId, COMMON.writeBindingId);
        return denied;
      },
      async stageStream() {
        throw new Error("must not stage");
      },
    },
  });
  const result = await service.stage({
    ...COMMON,
    source: {
      async readVerifiedSnapshot() {
        reads += 1;
        return { kind: "ready", input: verifiedInput() };
      },
    },
  });
  assert.deepEqual(result, { kind: "denied", decision: denied });
  assert.equal(reads, 0);
});

test("binary connector snapshots expose only verified bytes to shared staging", async () => {
  const env = fixture({ kind: "ready", input: verifiedInput() });

  assert.deepEqual(await env.service.stage({ ...COMMON, source: env.source }), {
    kind: "invalid",
    code: "fixture_result",
  });
  assert.equal(env.reads.length, 1);
  assert.equal(env.reads[0].representation.kind, "binary");
  assert.deepEqual(env.reads[0].limits, CONNECTOR_OBJECT_LIMITS);
  assert.equal(env.stages.length, 1);
  assert.equal(env.stages[0].sourceKind, "connector_object");
  assert.equal(env.stages[0].maxBytes, 268_435_456);
  assert.equal(env.stages[0].displayFilename, "connector.bin");
  assert.equal(env.stages[0].claimedMediaType, "application/octet-stream");
  assert.equal(env.stages[0].expectedSize, 1);
  assert.equal(env.stages[0].expectedSha256, SHA256);
  for (const forbidden of [
    "source", "representation", "providerObjectId", "providerUrl", "providerRevision",
    "account", "grant", "locator", "url",
  ]) {
    assert.equal(forbidden in env.stages[0], false, forbidden);
  }
});

test("connector locator, grant and revision fields cannot cross as verified input", async () => {
  for (const [field, value] of [
    ["providerObjectId", "object"],
    ["providerUrl", "https://provider.invalid/object"],
    ["providerRevision", "revision"],
    ["grant", "grant"],
  ]) {
    const env = fixture({ kind: "ready", input: verifiedInput({ [field]: value }) });
    assert.deepEqual(await env.service.stage({ ...COMMON, source: env.source }), {
      kind: "invalid",
      code: "file_ingress_source_unavailable",
      retryable: false,
    });
    assert.equal(env.stages.length, 0, field);
  }
});

test("provider-native documents require one explicit export snapshot", async () => {
  const representation = {
    kind: "export_snapshot",
    format: "provider/pdf",
    displayFilename: "document.pdf",
    mediaType: "application/pdf",
  };
  const env = fixture((request) => request.representation.kind === "binary"
    ? { kind: "unavailable", failure: "source_unavailable" }
    : { kind: "ready", input: verifiedInput({
        representation,
        displayFilename: representation.displayFilename,
        advisoryMediaType: representation.mediaType,
      }) });

  assert.deepEqual(await env.service.stage({ ...COMMON, source: env.source }), {
    kind: "invalid",
    code: "file_ingress_source_unavailable",
    retryable: false,
  });
  await env.service.stage({ ...COMMON, source: env.source, representation });
  assert.equal(env.reads[0].representation.kind, "binary");
  assert.deepEqual(env.reads[1].representation, representation);
  assert.equal(env.stages[0].displayFilename, "document.pdf");
  assert.equal(env.stages[0].claimedMediaType, "application/pdf");
  assert.equal("format" in env.stages[0], false);
});

test("implicit or changed export representation fails before staging", async () => {
  const implicit = fixture({ kind: "ready", input: verifiedInput() });
  assert.deepEqual(await implicit.service.stage({
    ...COMMON,
    source: implicit.source,
    representation: { kind: "export_snapshot", format: "", displayFilename: "x", mediaType: "x" },
  }), {
    kind: "invalid",
    code: "file_ingress_source_unavailable",
    retryable: false,
  });
  assert.equal(implicit.reads.length, 0);
  assert.equal(implicit.stages.length, 0);

  const requested = {
    kind: "export_snapshot",
    format: "provider/pdf",
    displayFilename: "document.pdf",
    mediaType: "application/pdf",
  };
  const drifted = fixture({ kind: "ready", input: verifiedInput({
    representation: { ...requested, format: "provider/docx" },
    displayFilename: requested.displayFilename,
    advisoryMediaType: requested.mediaType,
  }) });
  assert.deepEqual(await drifted.service.stage({
    ...COMMON,
    source: drifted.source,
    representation: requested,
  }), {
    kind: "invalid",
    code: "file_ingress_source_unavailable",
    retryable: false,
  });
  assert.equal(drifted.stages.length, 0);

  const changedMetadata = fixture({ kind: "ready", input: verifiedInput({
    representation: requested,
    displayFilename: "implicit-name.pdf",
    advisoryMediaType: requested.mediaType,
  }) });
  assert.deepEqual(await changedMetadata.service.stage({
    ...COMMON,
    source: changedMetadata.source,
    representation: requested,
  }), {
    kind: "invalid",
    code: "file_ingress_source_unavailable",
    retryable: false,
  });
  assert.equal(changedMetadata.stages.length, 0);
});

test("missing, revoked and wrong-owner objects are externally indistinguishable", async (t) => {
  for (const condition of ["missing", "revoked", "wrong-owner"]) {
    await t.test(condition, async () => {
      const env = fixture({
        kind: "unavailable",
        failure: "source_unavailable",
        internalCondition: condition,
      });
      assert.deepEqual(await env.service.stage({ ...COMMON, source: env.source }), {
        kind: "invalid",
        code: "file_ingress_source_unavailable",
        retryable: false,
      });
      assert.equal(env.stages.length, 0);
    });
  }
});

test("redirect, timeout and provider failures have one bounded transport outcome", async (t) => {
  for (const condition of ["redirect-limit", "timeout", "provider-failure"]) {
    await t.test(condition, async () => {
      const env = fixture({
        kind: "unavailable",
        failure: "transport_unavailable",
        retryable: true,
        internalCondition: condition,
      });
      assert.deepEqual(await env.service.stage({ ...COMMON, source: env.source }), {
        kind: "invalid",
        code: "file_ingress_transport_unavailable",
        retryable: true,
      });
      assert.equal(env.reads.length, 1);
      assert.equal(env.reads[0].limits.maxRedirects, 4);
      assert.equal(env.reads[0].limits.fetchTimeoutMilliseconds, 30_000);
      assert.equal(env.stages.length, 0);
    });
  }

  const thrown = fixture(() => { throw new Error("provider details"); });
  assert.deepEqual(await thrown.service.stage({ ...COMMON, source: thrown.source }), {
    kind: "invalid",
    code: "file_ingress_transport_unavailable",
    retryable: true,
  });
  assert.equal(thrown.stages.length, 0);

  const bounded = fixture(
    () => new Promise(() => undefined),
    undefined,
    { fetchTimeoutMilliseconds: 1 },
  );
  assert.deepEqual(await bounded.service.stage({ ...COMMON, source: bounded.source }), {
    kind: "invalid",
    code: "file_ingress_transport_unavailable",
    retryable: true,
  });
  assert.equal(bounded.reads[0].limits.fetchTimeoutMilliseconds, 1);
  assert.equal(bounded.stages.length, 0);
});

test("late source drift remains terminal after quarantine cleanup", async () => {
  let quarantinedBytes = 0;
  let durableStages = 0;
  let sourceCalls = 0;
  const service = new AuthorizedConnectorIngressService({
    staging: {
      async authorizeSourceRead() { return ALLOWED; },
      async stageStream(request) {
        try {
          for await (const chunk of request.stream) quarantinedBytes += chunk.byteLength;
          durableStages += 1;
          return { kind: "staged", record: {}, replayed: false };
        } catch {
          quarantinedBytes = 0;
          return { kind: "stream_invalid", code: "stream_transport_unavailable" };
        }
      },
    },
  });
  const source = {
    async readVerifiedSnapshot() {
      sourceCalls += 1;
      return {
        kind: "ready",
        input: verifiedInput({
          stream: (async function* () {
            yield Uint8Array.of(1);
            throw ConnectorObjectStreamFailure.sourceUnavailable();
          })(),
        }),
      };
    },
  };

  assert.deepEqual(await service.stage({ ...COMMON, source }), {
    kind: "invalid",
    code: "file_ingress_source_unavailable",
    retryable: false,
  });
  assert.equal(sourceCalls, 1);
  assert.equal(quarantinedBytes, 0);
  assert.equal(durableStages, 0);
});

test("late transient transport failure remains retryable after cleanup", async () => {
  const service = new AuthorizedConnectorIngressService({
    staging: {
      async authorizeSourceRead() { return ALLOWED; },
      async stageStream(request) {
        try {
          for await (const _chunk of request.stream) {
            // Consume until the adapter reports its final transport check.
          }
          return { kind: "staged", record: {}, replayed: false };
        } catch {
          return { kind: "stream_invalid", code: "stream_transport_unavailable" };
        }
      },
    },
  });
  const source = {
    async readVerifiedSnapshot() {
      return {
        kind: "ready",
        input: verifiedInput({
          stream: (async function* () {
            yield Uint8Array.of(1);
            throw ConnectorObjectStreamFailure.transportUnavailable(true);
          })(),
        }),
      };
    },
  };
  assert.deepEqual(await service.stage({ ...COMMON, source }), {
    kind: "invalid",
    code: "file_ingress_transport_unavailable",
    retryable: true,
  });
});

test("the connector deadline remains active until the verified stream finishes", async () => {
  let durableStages = 0;
  let observedSignal;
  const service = new AuthorizedConnectorIngressService({
    fetchTimeoutMilliseconds: 1,
    staging: {
      async authorizeSourceRead() { return ALLOWED; },
      async stageStream(request) {
        try {
          for await (const _chunk of request.stream) {
            // The fixture intentionally produces no complete chunk.
          }
          durableStages += 1;
          return { kind: "staged", record: {}, replayed: false };
        } catch {
          return { kind: "stream_invalid", code: "stream_transport_unavailable" };
        }
      },
    },
  });
  const source = {
    async readVerifiedSnapshot(request) {
      observedSignal = request.signal;
      return {
        kind: "ready",
        input: verifiedInput({
          stream: (async function* () {
            await new Promise((resolve) => {
              request.signal.addEventListener("abort", resolve, { once: true });
            });
            throw new Error("connector deadline reached before final snapshot check");
          })(),
        }),
      };
    },
  };

  assert.deepEqual(await service.stage({ ...COMMON, source }), {
    kind: "invalid",
    code: "file_ingress_transport_unavailable",
    retryable: true,
  });
  assert.equal(observedSignal.aborted, true);
  assert.equal(durableStages, 0);
});

test("shared exact-byte mismatch is collapsed before any connector fallback", async () => {
  const env = fixture(
    { kind: "ready", input: verifiedInput() },
    { kind: "invalid", code: "expected_sha256_mismatch" },
  );
  assert.deepEqual(await env.service.stage({ ...COMMON, source: env.source }), {
    kind: "invalid",
    code: "file_ingress_source_unavailable",
    retryable: false,
  });
  assert.equal(env.reads.length, 1);
  assert.equal(env.stages.length, 1);
});

test("malformed adapter outcomes fail closed", async () => {
  for (const outcome of [null, { kind: "mystery" }, {
    kind: "unavailable",
    failure: "provider-secret-reason",
    retryable: "sometimes",
  }]) {
    const env = fixture(outcome);
    assert.deepEqual(await env.service.stage({ ...COMMON, source: env.source }), {
      kind: "invalid",
      code: "file_ingress_transport_unavailable",
      retryable: true,
    });
    assert.equal(env.stages.length, 0);
  }
});
