import assert from "node:assert/strict";
import test from "node:test";

import { AuthorizedConnectorIngressService } from "@mind-diary/application-content";

const COMMON = {
  actor: { kind: "registered_principal" },
  spaceId: "space_connector",
  writeBindingId: "write_connector",
  object: { providerObjectId: "opaque-to-application" },
  idempotencyKey: "connector-stage",
};

test("authorized connector reader keeps provider identity outside shared staging", async () => {
  const calls = [];
  const service = new AuthorizedConnectorIngressService({
    reader: {
      async read(request) {
        assert.equal(request.object, COMMON.object);
        return {
          kind: "ready",
          stream: (async function* () { yield Uint8Array.of(1); })(),
          displayFilename: "connector.png",
          claimedMediaType: "image/png",
          expectedSize: 1,
          expectedSha256: `sha256:${"a".repeat(64)}`,
        };
      },
    },
    staging: {
      async stageStream(request) {
        calls.push(request);
        return { kind: "invalid", code: "fixture_result" };
      },
    },
  });
  assert.deepEqual(await service.stage(COMMON), {
    kind: "invalid",
    code: "fixture_result",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceKind, "connector_object");
  assert.equal(calls[0].maxBytes, 67_108_864);
  assert.equal("object" in calls[0], false);
  assert.equal("providerObjectId" in calls[0], false);
});

test("connector denial and unavailable outcomes fail closed before staging", async () => {
  let staged = false;
  const staging = {
    async stageStream() {
      staged = true;
      throw new Error("must not stage");
    },
  };
  const denied = new AuthorizedConnectorIngressService({
    staging,
    reader: {
      async read() {
        return { kind: "denied", decision: { code: "forbidden" } };
      },
    },
  });
  assert.deepEqual(await denied.stage(COMMON), {
    kind: "denied",
    decision: { code: "forbidden" },
  });
  const unavailable = new AuthorizedConnectorIngressService({
    staging,
    reader: {
      async read() {
        return { kind: "unavailable", retryable: false };
      },
    },
  });
  assert.deepEqual(await unavailable.stage(COMMON), {
    kind: "invalid",
    code: "file_ingress_source_unavailable",
    retryable: false,
  });
  const failed = new AuthorizedConnectorIngressService({
    staging,
    reader: {
      async read() {
        throw new Error("provider timeout");
      },
    },
  });
  assert.deepEqual(await failed.stage(COMMON), {
    kind: "invalid",
    code: "file_ingress_source_unavailable",
    retryable: true,
  });
  assert.equal(staged, false);
});
