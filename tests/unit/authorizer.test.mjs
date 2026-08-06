import assert from "node:assert/strict";
import test from "node:test";
import {
  CapabilityAuthorizer,
} from "@mind-diary/application-ports";
import {
  CAPABILITIES,
  capabilitiesForRole,
  capabilitiesForVisibilityGrant,
  version,
} from "@mind-diary/domain";

const now = "2026-08-06T12:00:00.000Z";
const future = "2026-11-03T12:00:00.000Z";
const principalId = "principal_actor";
const spaceId = "space_target";
const tokenId = "token_actor";

function actor(overrides = {}) {
  return {
    kind: "registered_principal",
    principalId,
    authentication: { kind: "mcp_token", tokenId },
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_authorizer",
    occurredAtUtc: now,
    ...overrides,
  };
}

function sitesActor(overrides = {}) {
  return actor({ authentication: { kind: "sites_identity" }, ...overrides });
}

function currentState(overrides = {}) {
  return {
    principal: { principalId, state: "active" },
    space: {
      spaceId,
      state: "active",
      visibility: "private",
      accessVersion: version(1),
    },
    membership: {
      principalId,
      spaceId,
      role: "owner",
      state: "active",
      version: version(1),
    },
    token: {
      tokenId,
      principalId,
      state: "active",
      scopes: ["content:read", "content:write"],
      version: version(1),
      expiresAt: future,
    },
    ...overrides,
  };
}

function mutableReader(initial = currentState()) {
  let state = initial;
  let reads = 0;
  return {
    readCurrentAuthorizationState: async () => {
      reads += 1;
      return structuredClone(state);
    },
    set: (next) => {
      state = next;
    },
    reads: () => reads,
  };
}

function transaction(state) {
  return {
    kind: "authorization-transaction",
    readCurrentAuthorizationState: async () => structuredClone(state),
  };
}

function request(capability, overrides = {}) {
  return {
    actor: actor(),
    spaceId,
    capability,
    revisionMode: "head",
    ...overrides,
  };
}

async function decide(state, authorizationRequest) {
  return new CapabilityAuthorizer(mutableReader(state)).authorize(
    authorizationRequest,
  );
}

test("role capability matrix uses current active membership", async () => {
  const cases = [
    ["reader", "content:browse", "allowed"],
    ["reader", "content:write", "denied"],
    ["editor", "content:write", "allowed"],
    ["admin", "members:manage-basic", "allowed"],
    ["admin", "members:manage-admin", "denied"],
    ["owner", "members:manage-admin", "allowed"],
    ["owner", "space:delete", "allowed"],
  ];

  for (const [role, capability, expected] of cases) {
    const state = currentState({
      membership: { ...currentState().membership, role },
    });
    const authorizationRequest = request(capability, {
      actor: capability.startsWith("content:") ? actor() : sitesActor(),
    });
    assert.equal((await decide(state, authorizationRequest)).kind, expected);
  }
});

test("public and unlisted grants are read-only baseline access, never membership", async () => {
  for (const visibility of ["public", "unlisted"]) {
    const state = currentState({
      space: { ...currentState().space, visibility },
      membership: null,
    });
    const read = await decide(state, request("content:fetch"));
    assert.deepEqual(read.grant, {
      kind: "baseline_visibility",
      visibility,
    });
    const write = await decide(state, request("content:write"));
    assert.equal(write.kind, "denied");
    assert.equal(write.code, "capability_denied");
  }

  const privateDecision = await decide(
    currentState({ membership: null }),
    request("content:browse"),
  );
  assert.equal(privateDecision.code, "access_denied");
});

test("MCP current token scopes narrow role while Sites identity needs no token scope", async () => {
  const readOnly = currentState({
    token: { ...currentState().token, scopes: ["content:read"] },
  });
  assert.equal(
    (await decide(readOnly, request("content:search"))).kind,
    "allowed",
  );
  const deniedWrite = await decide(readOnly, request("content:write"));
  assert.equal(deniedWrite.code, "insufficient_scope");

  const sitesState = currentState({ token: null });
  const sitesDecision = await decide(
    sitesState,
    request("visibility:change", { actor: sitesActor() }),
  );
  assert.equal(sitesDecision.kind, "allowed");
});

test("deployment capabilities can only narrow an otherwise allowed decision", async () => {
  const decision = await decide(
    currentState(),
    request("content:write", {
      actor: actor({ deploymentCapabilities: ["content:browse"] }),
    }),
  );
  assert.equal(decision.code, "deployment_capability_disabled");
});

test("every resolved historical revision is read-only even for Owner", async () => {
  const write = await decide(
    currentState(),
    request("content:write", { revisionMode: "historical" }),
  );
  assert.equal(write.code, "historical_read_only");
  assert.equal(
    (
      await decide(
        currentState(),
        request("content:history", { revisionMode: "historical" }),
      )
    ).kind,
    "allowed",
  );
});

test("anonymous and service actors are denied without reading target state", async () => {
  const reader = mutableReader();
  const authorizer = new CapabilityAuthorizer(reader);
  for (const unauthenticated of [
    { kind: "anonymous" },
    {
      kind: "service",
      serviceId: "indexer",
      deploymentCapabilities: CAPABILITIES,
      requestId: "request_service",
      occurredAtUtc: now,
    },
  ]) {
    const decision = await authorizer.authorize(
      request("content:browse", { actor: unauthenticated }),
    );
    assert.equal(decision.code, "authentication_required");
  }
  assert.equal(reader.reads(), 0);
});

test("client role claims are ignored and current state is queried by trusted identities", async () => {
  let query;
  const authorizer = new CapabilityAuthorizer({
    readCurrentAuthorizationState: async (currentQuery) => {
      query = currentQuery;
      return currentState({ membership: null });
    },
  });
  const decision = await authorizer.authorize(
    request("content:write", { actor: actor({ role: "owner" }) }),
  );
  assert.equal(decision.code, "access_denied");
  assert.deepEqual(query, { principalId, spaceId, tokenId });
});

test("invalid capability, revision mode, state identity and timestamp fail closed", async () => {
  const reader = mutableReader();
  const authorizer = new CapabilityAuthorizer(reader);
  assert.equal(
    (
      await authorizer.authorize(
        request("content:execute", { revisionMode: "head" }),
      )
    ).code,
    "invalid_authorization_request",
  );
  assert.equal(
    (
      await authorizer.authorize(
        request("content:browse", { revisionMode: "moving-tag" }),
      )
    ).code,
    "invalid_authorization_request",
  );
  assert.equal(reader.reads(), 0);

  assert.equal(
    (
      await decide(
        currentState({
          principal: { principalId: "principal_other", state: "active" },
        }),
        request("content:browse"),
      )
    ).code,
    "authorization_state_unavailable",
  );
  assert.equal(
    (
      await decide(
        currentState(),
        request("content:browse", {
          actor: actor({ occurredAtUtc: "not-a-time" }),
        }),
      )
    ).code,
    "invalid_authorization_request",
  );
});

test("malformed persisted authorization enums and shapes fail closed without mutation", async () => {
  assert.deepEqual(capabilitiesForVisibilityGrant("secret"), []);
  assert.deepEqual(capabilitiesForRole("root"), []);

  const corruptions = [
    [
      "visibility",
      currentState({
        space: { ...currentState().space, visibility: "secret" },
      }),
    ],
    [
      "membership state",
      currentState({
        membership: { ...currentState().membership, state: "pending" },
      }),
    ],
    [
      "membership role",
      currentState({
        membership: { ...currentState().membership, role: "root" },
      }),
    ],
    [
      "token scope string",
      currentState({
        token: { ...currentState().token, scopes: "content:write" },
      }),
    ],
    [
      "write-only token scopes",
      currentState({
        token: { ...currentState().token, scopes: ["content:write"] },
      }),
    ],
    [
      "unknown token scope",
      currentState({
        token: {
          ...currentState().token,
          scopes: ["content:read", "control:write"],
        },
      }),
    ],
    ["missing principal shape", currentState({ principal: null })],
    ["missing membership shape", currentState({ membership: {} })],
    ["missing token shape", currentState({ token: {} })],
    [
      "invalid access version",
      currentState({
        space: { ...currentState().space, accessVersion: 0 },
      }),
    ],
  ];

  for (const [name, state] of corruptions) {
    const before = structuredClone(state);
    const decision = await decide(state, request("content:browse"));
    assert.equal(decision.code, "authorization_state_unavailable", name);
    assert.deepEqual(state, before, name);
  }
});

test("revoked, expired, missing and wrong-principal tokens stop future access", async () => {
  const variants = [
    currentState({ token: { ...currentState().token, state: "revoked" } }),
    currentState({ token: { ...currentState().token, expiresAt: now } }),
    currentState({ token: null }),
    currentState({
      token: { ...currentState().token, principalId: "principal_other" },
    }),
  ];
  for (const state of variants) {
    const decision = await decide(state, request("content:browse"));
    assert.equal(decision.code, "token_inactive");
  }
});

test("authorization reloads membership, visibility and token state on every call", async () => {
  const reader = mutableReader();
  const authorizer = new CapabilityAuthorizer(reader);
  assert.equal(
    (await authorizer.authorize(request("content:write"))).kind,
    "allowed",
  );

  reader.set(
    currentState({
      membership: { ...currentState().membership, state: "revoked" },
    }),
  );
  assert.equal(
    (await authorizer.authorize(request("content:write"))).code,
    "access_denied",
  );

  reader.set(
    currentState({
      space: { ...currentState().space, visibility: "public" },
      membership: null,
    }),
  );
  assert.equal(
    (await authorizer.authorize(request("content:browse"))).kind,
    "allowed",
  );
  reader.set(currentState({ membership: null }));
  assert.equal(
    (await authorizer.authorize(request("content:browse"))).code,
    "access_denied",
  );

  reader.set(
    currentState({
      token: { ...currentState().token, state: "revoked" },
    }),
  );
  assert.equal(
    (await authorizer.authorize(request("content:browse"))).code,
    "token_inactive",
  );
  assert.equal(reader.reads(), 5);
});

test("transaction recheck denies a membership revocation race and leaves final state unchanged", async () => {
  const authorizer = new CapabilityAuthorizer(mutableReader());
  const preflight = await authorizer.authorize(request("content:write"));
  assert.equal(preflight.kind, "allowed");

  const revoked = currentState({
    space: { ...currentState().space, accessVersion: version(2) },
    membership: {
      ...currentState().membership,
      state: "revoked",
      version: version(2),
    },
  });
  const recheck = await authorizer.reauthorizeInTransaction(
    request("content:write"),
    transaction(revoked),
    preflight.stamp,
  );
  let committedRevisions = 0;
  if (recheck.kind === "allowed") committedRevisions += 1;
  assert.equal(recheck.code, "access_denied");
  assert.equal(committedRevisions, 0);
  assert.equal(revoked.membership.state, "revoked");
});

test("transaction recheck detects stale authorization and a fresh retry succeeds", async () => {
  const changed = currentState({
    space: { ...currentState().space, accessVersion: version(2) },
    membership: {
      ...currentState().membership,
      version: version(2),
    },
    token: { ...currentState().token, version: version(2) },
  });
  const reader = mutableReader();
  const authorizer = new CapabilityAuthorizer(reader);
  const initial = await authorizer.authorize(request("content:write"));
  assert.equal(initial.kind, "allowed");

  const stale = await authorizer.reauthorizeInTransaction(
    request("content:write"),
    transaction(changed),
    initial.stamp,
  );
  assert.deepEqual(stale, {
    kind: "denied",
    code: "authorization_state_changed",
    retryable: true,
  });

  reader.set(changed);
  const retried = await authorizer.authorize(request("content:write"));
  assert.equal(retried.kind, "allowed");
  assert.equal(
    (
      await authorizer.reauthorizeInTransaction(
        request("content:write"),
        transaction(changed),
        retried.stamp,
      )
    ).kind,
    "allowed",
  );
});

test("transaction recheck observes visibility-to-private and token-revocation races", async () => {
  const publicState = currentState({
    space: { ...currentState().space, visibility: "public" },
    membership: null,
  });
  const publicAuthorizer = new CapabilityAuthorizer(mutableReader(publicState));
  const baseline = await publicAuthorizer.authorize(request("content:fetch"));
  assert.equal(baseline.kind, "allowed");
  const privateState = currentState({
    space: { ...currentState().space, accessVersion: version(2) },
    membership: null,
  });
  assert.equal(
    (
      await publicAuthorizer.reauthorizeInTransaction(
        request("content:fetch"),
        transaction(privateState),
        baseline.stamp,
      )
    ).code,
    "access_denied",
  );

  const tokenAuthorizer = new CapabilityAuthorizer(mutableReader());
  const tokenAllowed = await tokenAuthorizer.authorize(request("content:fetch"));
  const revokedToken = currentState({
    token: {
      ...currentState().token,
      state: "revoked",
      version: version(2),
    },
  });
  assert.equal(
    (
      await tokenAuthorizer.reauthorizeInTransaction(
        request("content:fetch"),
        transaction(revokedToken),
        tokenAllowed.stamp,
      )
    ).code,
    "token_inactive",
  );
});
