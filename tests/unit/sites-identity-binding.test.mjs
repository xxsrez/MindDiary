import assert from "node:assert/strict";
import test from "node:test";

import {
  SITES_IDENTITY_PROVIDER,
  SITES_UNKNOWN_IDENTITY_ACTIONS,
  SitesIdentityResolver,
  isTrustedSitesControlActor,
} from "../../packages/adapter-web/dist/index.js";
import { CAPABILITIES } from "../../packages/domain/dist/index.js";

const NOW = "2026-08-07T03:00:00.000Z";

function requestContext(requestId = "request_sites_identity") {
  return {
    requestId,
    occurredAtUtc: NOW,
    deploymentCapabilities: CAPABILITIES,
  };
}

function fixture({ snapshot, lookup } = {}) {
  let currentSnapshot =
    snapshot ??
    ({
      kind: "authenticated",
      verifiedEmail: "member@example.com",
      verifiedFullName: "Private Profile Name",
    });
  let currentLookup =
    lookup ??
    ((query) => ({
      kind: "bound",
      provider: query.provider,
      normalizedBinding: query.normalizedBinding,
      principalId: "principal_existing",
    }));
  const identityReads = [];
  const bindingReads = [];
  const events = [];
  const resolver = new SitesIdentityResolver({
    identity: {
      readVerifiedIdentity() {
        identityReads.push(true);
        return currentSnapshot;
      },
    },
    bindings: {
      async readActiveBinding(query) {
        bindingReads.push(query);
        return currentLookup(query);
      },
    },
    logger: {
      record(event) {
        events.push(event);
      },
    },
  });

  return {
    resolver,
    identityReads,
    bindingReads,
    events,
    setSnapshot(next) {
      currentSnapshot = next;
    },
    setLookup(next) {
      currentLookup = next;
    },
  };
}

test("normalizes verified email server-side and builds an email-free immutable actor", async () => {
  const variants = [
    "Member@Example.COM",
    "  member@example.com  ",
  ];

  for (const [index, verifiedEmail] of variants.entries()) {
    const probe = fixture({
      snapshot: {
        kind: "authenticated",
        verifiedEmail,
        verifiedFullName: "Private Profile Name",
      },
    });
    const result = await probe.resolver.resolve(
      requestContext(`request_normalized_${index}`),
    );

    assert.equal(result.kind, "authenticated");
    assert.equal(probe.bindingReads.length, 1);
    assert.equal(probe.bindingReads[0].provider, SITES_IDENTITY_PROVIDER);
    assert.equal(
      probe.bindingReads[0].normalizedBinding,
      "member@example.com",
    );
    assert.equal(result.actor.principalId, "principal_existing");
    assert.equal(isTrustedSitesControlActor(result.actor), true);
    assert.equal(Object.isFrozen(result.actor), true);
    assert.equal(Object.isFrozen(result.actor.authentication), true);
    assert.equal(Object.isFrozen(result.actor.deploymentCapabilities), true);
    assert.equal("verifiedEmail" in result.actor, false);
    assert.equal("verifiedFullName" in result.actor, false);
    assert.equal("email" in result.actor, false);
    assert.equal("role" in result.actor, false);
  }
});

test("unknown exact binding offers only isolated creation or manual recovery and never inherits rights", async () => {
  const probe = fixture({ lookup: () => ({ kind: "unbound" }) });

  const first = await probe.resolver.resolve(requestContext("request_unknown_1"));
  const retry = await probe.resolver.resolve(requestContext("request_unknown_2"));

  assert.deepEqual(first, {
    kind: "registration_required",
    actions: SITES_UNKNOWN_IDENTITY_ACTIONS,
  });
  assert.deepEqual(retry, first);
  assert.equal("actor" in first, false);
  assert.equal("principalId" in first, false);
  assert.equal(probe.bindingReads.length, 2);

  probe.setLookup((query) => ({
    kind: "bound",
    provider: query.provider,
    normalizedBinding: query.normalizedBinding,
    principalId: "principal_new_isolated",
  }));
  const afterExplicitBootstrap = await probe.resolver.resolve(
    requestContext("request_unknown_after_bootstrap"),
  );
  assert.equal(afterExplicitBootstrap.kind, "authenticated");
  assert.equal(afterExplicitBootstrap.actor.principalId, "principal_new_isolated");
  assert.notEqual(afterExplicitBootstrap.actor.principalId, "principal_previous");
});

test("browser headers, body, query and role claims cannot substitute for server identity", async () => {
  const probe = fixture({
    snapshot: {
      kind: "unauthenticated",
      verifiedEmail: "spoofed@example.com",
      principalId: "principal_spoofed",
      role: "owner",
    },
  });
  const spoofedContext = {
    ...requestContext("request_spoofed"),
    headers: {
      "oai-authenticated-user-email": "spoofed@example.com",
      "x-principal-id": "principal_spoofed",
      "x-role": "owner",
    },
    body: { email: "spoofed@example.com", principalId: "principal_spoofed" },
    query: { role: "owner" },
  };

  const result = await probe.resolver.resolve(spoofedContext);
  assert.deepEqual(result, {
    kind: "denied",
    code: "authentication_required",
    retryable: false,
  });
  assert.equal(probe.bindingReads.length, 0);
  assert.equal("actor" in result, false);
});

test("invalid verified identity and invalid trusted request context fail closed before lookup", async () => {
  for (const verifiedEmail of [
    "",
    "not-an-email",
    "two@@example.com",
    ".leading@example.com",
    "member@example",
    "member@-example.com",
    "member@example.com\nforged@example.com",
    "ｍｅｍｂｅｒ＠ｅｘａｍｐｌｅ．ｃｏｍ",
  ]) {
    const probe = fixture({
      snapshot: { kind: "authenticated", verifiedEmail },
    });
    const result = await probe.resolver.resolve(requestContext("request_invalid"));
    assert.equal(result.kind, "denied");
    assert.equal(probe.bindingReads.length, 0);
  }

  const invalidContextProbe = fixture();
  for (const context of [
    { ...requestContext(), requestId: "" },
    { ...requestContext(), occurredAtUtc: "not-a-time" },
    { ...requestContext(), occurredAtUtc: "2026-02-30T03:00:00.000Z" },
    { ...requestContext(), deploymentCapabilities: "content:read" },
  ]) {
    const result = await invalidContextProbe.resolver.resolve(context);
    assert.equal(result.kind, "denied");
  }
  assert.equal(invalidContextProbe.identityReads.length, 0);
  assert.equal(invalidContextProbe.bindingReads.length, 0);
  await invalidContextProbe.resolver.resolve({
    ...requestContext(),
    requestId: "private@example.com",
  });
  assert.deepEqual(invalidContextProbe.events.at(-1), {
    event: "sites_identity_denied",
    requestId: "request_invalid",
  });
  assert.equal(
    JSON.stringify(invalidContextProbe.events).includes("private@example.com"),
    false,
  );
});

test("binding mismatch, malformed results and lookup failures fail closed without principal leakage", async () => {
  const results = [
    () => ({
      kind: "bound",
      provider: SITES_IDENTITY_PROVIDER,
      normalizedBinding: "other@example.com",
      principalId: "principal_wrong_binding",
    }),
    (query) => ({
      kind: "bound",
      provider: query.provider,
      normalizedBinding: query.normalizedBinding,
      principalId: "",
    }),
    () => ({ kind: "unavailable" }),
    () => null,
    () => ({ kind: "bound" }),
    () => {
      throw new Error("storage error containing private@example.com");
    },
  ];

  for (const [index, lookup] of results.entries()) {
    const probe = fixture({ lookup });
    const result = await probe.resolver.resolve(
      requestContext(`request_mismatch_${index}`),
    );
    assert.deepEqual(result, {
      kind: "unavailable",
      code: "identity_binding_unavailable",
      retryable: true,
    });
    assert.equal("actor" in result, false);
    assert.equal(JSON.stringify(result).includes("principal_wrong_binding"), false);
  }
});

test("parallel unknown retries are read-only and cannot race into an inherited principal", async () => {
  let reads = 0;
  const probe = fixture({
    lookup: async () => {
      reads += 1;
      await Promise.resolve();
      return { kind: "unbound" };
    },
  });

  const outcomes = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      probe.resolver.resolve(requestContext(`request_race_${index}`)),
    ),
  );
  assert.equal(reads, 12);
  assert.equal(
    outcomes.every(
      (outcome) =>
        outcome.kind === "registration_required" && !("actor" in outcome),
    ),
    true,
  );
});

test("safe logger receives only categorical outcome and request id", async () => {
  const rawEmail = "Private.Member@Example.com";
  const rawProfile = "Private Profile Name";
  const probe = fixture({
    snapshot: {
      kind: "authenticated",
      verifiedEmail: rawEmail,
      verifiedFullName: rawProfile,
    },
  });

  await probe.resolver.resolve(requestContext("request_safe_log"));
  assert.deepEqual(probe.events, [
    {
      event: "sites_identity_authenticated",
      requestId: "request_safe_log",
    },
  ]);
  assert.deepEqual(Object.keys(probe.events[0]).sort(), ["event", "requestId"]);
  const serialized = JSON.stringify(probe.events);
  assert.equal(serialized.includes(rawEmail), false);
  assert.equal(serialized.includes(rawProfile), false);
  assert.equal(serialized.includes("member@example.com"), false);
  assert.equal(serialized.includes("principal_existing"), false);
});

test("async logger rejection cannot change authorization or become unhandled", async () => {
  const resolver = new SitesIdentityResolver({
    identity: {
      readVerifiedIdentity: () => ({
        kind: "authenticated",
        verifiedEmail: "member@example.com",
      }),
    },
    bindings: {
      readActiveBinding: (query) => ({
        kind: "bound",
        provider: query.provider,
        normalizedBinding: query.normalizedBinding,
        principalId: "principal_existing",
      }),
    },
    logger: {
      async record() {
        throw new Error("observability unavailable");
      },
    },
  });

  const result = await resolver.resolve(requestContext("request_async_logger"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.kind, "authenticated");
  assert.equal(result.actor.principalId, "principal_existing");
});
