import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryHandleRegistry } from "@mind-diary/adapter-metadata-memory";
import { AuthorizedHandleReader } from "@mind-diary/application-ports";
import { opaqueId, verifiedSpaceHost } from "@mind-diary/domain";

const HOST = verifiedSpaceHost("mind.example");
const SPACE_ID = opaqueId("space_private");
const ACTOR = Object.freeze({
  kind: "registered_principal",
  principalId: opaqueId("principal_reader"),
  authentication: Object.freeze({ kind: "sites_identity" }),
  deploymentCapabilities: Object.freeze(["content:fetch"]),
  occurredAtUtc: "2026-08-06T12:00:00Z",
  requestId: opaqueId("request_handle_resolution"),
});

const ALLOWED = Object.freeze({
  kind: "allowed",
  capability: "content:fetch",
  grant: Object.freeze({ kind: "membership", role: "reader" }),
  stamp: Object.freeze({
    accessVersion: 1,
    membershipVersion: 1,
    tokenVersion: null,
  }),
});
const DENIED = Object.freeze({ kind: "denied", code: "access_denied", retryable: false });

async function harness(decision) {
  const registry = new InMemoryHandleRegistry();
  await registry.reserveHandle({ host: HOST, handle: "private-mind", spaceId: SPACE_ID });
  const events = [];
  const handles = {
    kind: "metadata-store",
    reserveHandle: (request) => registry.reserveHandle(request),
    retireHandle: (request) => registry.retireHandle(request),
    resolveHandle: (request) => {
      events.push("resolve");
      return registry.resolveHandle(request);
    },
  };
  const authorizer = {
    authorize: async () => {
      events.push("authorize");
      return decision;
    },
    reauthorizeInTransaction: async () => decision,
  };
  const targets = {
    readResolvedSpace: async (spaceId) => {
      events.push("read-target");
      return Object.freeze({ spaceId, name: "Private Mind" });
    },
  };
  return {
    events,
    reader: new AuthorizedHandleReader({ handles, authorizer, targets }),
  };
}

function request(handle) {
  return {
    actor: ACTOR,
    host: HOST,
    handle,
    capability: "content:fetch",
    revisionMode: "head",
  };
}

test("exact canonical handle resolves to space_id before authorization and target read", async () => {
  const { reader, events } = await harness(ALLOWED);
  const result = await reader.read(request("private-mind"));
  assert.equal(result.kind, "found");
  assert.equal(result.spaceId, SPACE_ID);
  assert.equal(result.value.spaceId, SPACE_ID);
  assert.deepEqual(events, ["resolve", "authorize", "read-target"]);
  assert.ok(Object.isFrozen(result));
});

test("missing and access-denied targets are externally indistinguishable and never read objects", async () => {
  const missingHarness = await harness(ALLOWED);
  const missing = await missingHarness.reader.read(request("missing-mind"));
  assert.deepEqual(missingHarness.events, ["resolve"]);

  const deniedHarness = await harness(DENIED);
  const denied = await deniedHarness.reader.read(request("private-mind"));
  assert.deepEqual(deniedHarness.events, ["resolve", "authorize"]);

  assert.deepEqual(missing, { kind: "not_found" });
  assert.deepEqual(denied, missing);
  assert.deepEqual(Object.keys(denied), ["kind"]);
  assert.ok(Object.isFrozen(missing));
  assert.ok(Object.isFrozen(denied));
});

test("resolver rejects normalized aliases without access or target reads", async () => {
  for (const alias of ["ｐｒｉｖａｔｅ－ｍｉｎｄ", "private%2dmind", "private%252dmind"]) {
    const { reader, events } = await harness(ALLOWED);
    assert.deepEqual(await reader.read(request(alias)), { kind: "not_found" });
    assert.deepEqual(events, ["resolve"]);
  }
});
