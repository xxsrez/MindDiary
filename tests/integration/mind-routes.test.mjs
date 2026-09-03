import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  AccountBootstrapService,
  MindRouteFailure,
  MindRouteService,
  OrdinaryMindControlService,
} from "@mind-diary/application-control";
import { CAPABILITIES, verifiedSpaceHost, version } from "@mind-diary/domain";

const CREATED_AT = "2026-08-07T04:30:00.000Z";
const CHANGED_AT = "2026-08-07T04:31:00.000Z";
const RACE_AT = "2026-08-07T04:32:00.000Z";
const HOST = verifiedSpaceHost("mind-diary.example");

function preRegistrationActor(index, displayName = `Owner ${index}`) {
  return {
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding: `private.route.${index}@example.com`,
    suggestedDisplayName: displayName,
    deploymentCapabilities: CAPABILITIES,
    requestId: `request_bootstrap_route_${index}`,
    occurredAtUtc: CREATED_AT,
  };
}

function registeredActor(principalId, requestId = "request_route") {
  return {
    kind: "registered_principal",
    principalId,
    authentication: { kind: "sites_identity" },
    deploymentCapabilities: CAPABILITIES,
    requestId,
    occurredAtUtc: CHANGED_AT,
  };
}

function accountIds() {
  let account = 0;
  return {
    nextPrincipalId: () => `principal_route_${++account}`,
    nextExternalBindingId: () => `binding_route_${account}`,
    nextSpaceId: () => `space_personal_route_${account}`,
    nextMembershipId: () => `membership_personal_route_${account}`,
    nextRevisionId: () => `revision_personal_route_${account}`,
    nextPersonalSpaceHandle: () => `personal-service-route-${account}`,
  };
}

function ordinaryIds() {
  let spaces = 0;
  let memberships = 0;
  let revisions = 0;
  return {
    nextSpaceId: () => `space_route_${++spaces}`,
    nextMembershipId: () => `membership_route_owner_${++memberships}`,
    nextRevisionId: () => `revision_route_${++revisions}`,
  };
}

function harness() {
  const metadata = new InMemoryRevisionMetadataStore();
  const objects = new InMemoryObjectStore();
  const events = [];
  const bootstrap = new AccountBootstrapService({
    accounts: metadata,
    objects,
    ids: accountIds(),
  });
  const ordinary = new OrdinaryMindControlService({
    ordinaryMinds: metadata,
    objects,
    ids: ordinaryIds(),
    host: HOST,
  });
  const routes = new MindRouteService({
    routes: metadata,
    host: HOST,
    logger: { record: (event) => events.push(event) },
  });
  return { metadata, objects, events, bootstrap, ordinary, routes };
}

async function createAccount(env, index, displayName = `Owner ${index}`) {
  return env.bootstrap.bootstrapAccount(
    preRegistrationActor(index, displayName),
    { action: "create_isolated_account" },
  );
}

async function createMind(env, owner, handle, name = handle, description = undefined) {
  return env.ordinary.createSpaceWithOwner(
    registeredActor(owner.principalId, `request_create_${handle}`),
    {
      name,
      handle,
      ...(description === undefined ? {} : { description }),
      idempotencyKey: `create-${handle}`,
    },
  );
}

async function grantMembership(env, mind, principal, role = "editor", suffix = "1") {
  const ownerState = await env.metadata.inspectOrdinaryMindStateForTest(mind.mindId);
  assert.ok(ownerState);
  assert.equal(
    await env.metadata.grantOrdinaryMembershipForTest(
      {
        membershipId: `membership_route_grant_${suffix}`,
        spaceId: mind.mindId,
        principalId: principal.principalId,
        role,
        state: "active",
        version: version(1),
        createdAt: CHANGED_AT,
        createdBy: ownerState.memberships[0].principalId,
        updatedAt: CHANGED_AT,
        updatedBy: ownerState.memberships[0].principalId,
      },
      CHANGED_AT,
    ),
    true,
  );
}

function expectRouteFailure(code) {
  return (error) => {
    assert.equal(error instanceof MindRouteFailure, true);
    assert.equal(error.code, code);
    return true;
  };
}

function tracedStore(metadata, { beforeFinalAuthorize, candidateIds } = {}) {
  const trace = [];
  return {
    trace,
    store: {
      readPersonalMindProfile: (principalId) =>
        metadata.readPersonalMindProfile(principalId),
      listActiveMembershipMindIds: async (principalId) =>
        candidateIds ?? metadata.listActiveMembershipMindIds(principalId),
      resolveHandle: async (request) => {
        trace.push("resolve");
        return metadata.resolveHandle(request);
      },
      readResolvedSpace: async (spaceId) => {
        trace.push("metadata");
        return metadata.readResolvedSpace(spaceId);
      },
      readCurrentAuthorizationState: async (query) => {
        trace.push("authorize");
        return metadata.readCurrentAuthorizationState(query);
      },
      readCurrentRouteAuthorizationState: async (query) => {
        trace.push("final_authorize");
        if (beforeFinalAuthorize) await beforeFinalAuthorize();
        return metadata.readCurrentRouteAuthorizationState(query);
      },
    },
  };
}

test("/me and list expose only safe Personal plus accepted membership descriptors", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Mind Owner");
  const member = await createAccount(env, 2, "Accepted Member");
  const outsider = await createAccount(env, 3, "Outside Visitor");
  const shared = await createMind(
    env,
    owner,
    "shared-notes",
    "Shared Notes",
    "Only authorized readers receive this metadata.",
  );
  const unlisted = await createMind(env, owner, "quiet-library", "Quiet Library");
  const published = await createMind(env, owner, "public-library", "Public Library");
  const privateMind = await createMind(env, owner, "private-library", "Private Library");
  await grantMembership(env, shared, member, "editor", "shared");
  assert.equal(
    await env.metadata.changeOrdinaryVisibilityForTest(
      unlisted.mindId,
      "unlisted",
      CHANGED_AT,
    ),
    true,
  );
  assert.equal(
    await env.metadata.changeOrdinaryVisibilityForTest(
      published.mindId,
      "public",
      CHANGED_AT,
    ),
    true,
  );

  const actor = registeredActor(member.principalId, "request_safe_list");
  const personal = await env.routes.resolveRoute(actor, "/me");
  assert.equal(personal.route, "/me");
  assert.equal(personal.name, "Accepted Member");
  assert.equal(personal.isPersonal, true);
  assert.equal("handle" in personal, false);
  assert.equal(Object.hasOwn(personal, "description"), false);
  assert.equal(
    personal.access.capabilities.some(
      (capability) => !capability.startsWith("content:"),
    ),
    false,
  );

  const duplicateCandidates = tracedStore(env.metadata, {
    candidateIds: [shared.mindId, shared.mindId],
  });
  const routes = new MindRouteService({ routes: duplicateCandidates.store, host: HOST });
  const listed = await routes.listMinds(actor);
  assert.deepEqual(
    listed.map((mind) => mind.route),
    ["/me", "/shared-notes"],
  );
  assert.equal(listed[1].access.kind, "membership");
  assert.equal(listed[1].access.role, "editor");
  assert.equal(
    listed[1].description,
    "Only authorized readers receive this metadata.",
  );
  assert.equal(
    listed[1].access.capabilities.some(
      (capability) => !capability.startsWith("content:"),
    ),
    false,
  );
  assert.equal(listed.some((mind) => mind.route === "/quiet-library"), false);
  assert.equal(listed.some((mind) => mind.route === "/public-library"), false);
  assert.equal(listed.some((mind) => mind.route === "/private-library"), false);

  const account = await env.metadata.readAccount(member.principalId);
  assert.ok(account);
  const serialized = JSON.stringify({ personal, listed, events: env.events });
  assert.equal(serialized.includes(account.personalMind.space.spaceHandle), false);
  assert.equal(serialized.includes("private.route"), false);
  assert.equal(serialized.includes(outsider.principalId), false);
});

test("membership list stays inside one adapter-provided consistent read session", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Session Owner");
  await createMind(env, owner, "session-notes", "Session Notes");
  let sessions = 0;
  let escapedReads = 0;
  let authorizationBatches = 0;
  const guarded = new Proxy(env.metadata, {
    get(target, property, receiver) {
      if (property === "withConsistentRead") {
        return async (operation) => {
          sessions += 1;
          return operation(new Proxy(env.metadata, {
            get(readTarget, readProperty, readReceiver) {
              const selected = Reflect.get(readTarget, readProperty, readReceiver);
              if (readProperty !== "readCurrentAuthorizationStates" || typeof selected !== "function") {
                return typeof selected === "function" ? selected.bind(readTarget) : selected;
              }
              return (...args) => {
                authorizationBatches += 1;
                return selected.apply(readTarget, args);
              };
            },
          }));
        };
      }
      const selected = Reflect.get(target, property, receiver);
      if (typeof selected !== "function") return selected;
      return () => {
        escapedReads += 1;
        throw new Error("route list escaped the consistent read session");
      };
    },
  });
  const routes = new MindRouteService({ routes: guarded, host: HOST });

  const listed = await routes.listMinds(
    registeredActor(owner.principalId, "request_consistent_list"),
  );

  assert.equal(sessions, 1);
  assert.equal(escapedReads, 0);
  assert.equal(authorizationBatches, 1);
  assert.deepEqual(listed.map((mind) => mind.route), ["/me", "/session-notes"]);
});

test("exact ordinary resolve uses membership or current public/unlisted Reader baseline", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const member = await createAccount(env, 2);
  const outsider = await createAccount(env, 3);
  const mind = await createMind(
    env,
    owner,
    "research-notes",
    "Research Notes",
    "Authorized route description.",
  );
  await grantMembership(env, mind, member, "reader", "reader");

  const ownerResult = await env.routes.resolveRoute(
    registeredActor(owner.principalId),
    "/research-notes",
  );
  assert.equal(ownerResult.access.kind, "membership");
  assert.equal(ownerResult.access.role, "owner");
  const memberResult = await env.routes.resolveExactMind(
    registeredActor(member.principalId),
    "research-notes",
  );
  assert.equal(memberResult.access.kind, "membership");
  assert.equal(memberResult.access.role, "reader");

  env.metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: outsider.principalId,
      spaceId: mind.mindId,
      tokenId: null,
    },
    {
      principal: { principalId: outsider.principalId, state: "active" },
      space: {
        spaceId: mind.mindId,
        state: "active",
        visibility: "public",
        accessVersion: version(99),
      },
      membership: null,
      token: null,
    },
  );
  const denied = await env.routes
    .resolveExactMind(registeredActor(outsider.principalId), "research-notes")
    .catch((error) => error);
  const missing = await env.routes
    .resolveExactMind(registeredActor(outsider.principalId), "missing-mind")
    .catch((error) => error);
  assert.equal(denied instanceof MindRouteFailure, true);
  assert.deepEqual(
    { code: denied.code, message: denied.message },
    { code: missing.code, message: missing.message },
  );

  for (const visibility of ["unlisted", "public"]) {
    assert.equal(
      await env.metadata.changeOrdinaryVisibilityForTest(
        mind.mindId,
        visibility,
        CHANGED_AT,
      ),
      true,
    );
    const baseline = await env.routes.resolveExactMind(
      registeredActor(outsider.principalId, `request_${visibility}`),
      "research-notes",
    );
    assert.equal(baseline.visibility, visibility);
    assert.equal(baseline.discovery, "exact_handle");
    assert.equal(baseline.description, "Authorized route description.");
    assert.deepEqual(baseline.access, {
      kind: "visibility",
      role: null,
      capabilities: [
        "content:browse",
        "content:search",
        "content:fetch",
        "content:history",
        "content:validate",
        "content:export",
      ],
    });
  }
});

test("authentication precedes parsing and noncanonical, reserved, multi-segment, or hidden routes fail closed", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const account = await env.metadata.readAccount(owner.principalId);
  assert.ok(account);
  const actor = registeredActor(owner.principalId);
  const invalidRoutes = [
    "research-notes",
    "/Research-notes",
    "/research%2Dnotes",
    "/research/notes",
    "/research-notes/",
    "/research-notes?mode=edit",
    "/api",
    "/public",
    "/me/",
  ];
  for (const route of invalidRoutes) {
    await assert.rejects(
      env.routes.resolveRoute(actor, route),
      expectRouteFailure("invalid_route"),
    );
  }

  await assert.rejects(
    env.routes.resolveRoute(
      {
        kind: "service",
        authentication: { kind: "internal_service", purpose: "test" },
        deploymentCapabilities: CAPABILITIES,
        requestId: "request_unauthenticated_invalid",
        occurredAtUtc: CHANGED_AT,
      },
      "/not/canonical",
    ),
    expectRouteFailure("authentication_required"),
  );
  await assert.rejects(
    env.routes.resolveRoute(
      actor,
      `/${account.personalMind.space.spaceHandle}`,
    ),
    expectRouteFailure("mind_not_found"),
  );
  await assert.rejects(
    env.routes.resolveExactMind(
      {
        ...actor,
        authentication: {
          kind: "mcp_token",
          tokenId: "token_forged",
          effectiveScopes: ["content:read"],
        },
      },
      "research-notes",
    ),
    expectRouteFailure("authentication_required"),
  );
});

test("every call observes revocation, visibility, deleting, and corrupted handle state", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const member = await createAccount(env, 2);
  const outsider = await createAccount(env, 3);
  const shared = await createMind(env, owner, "shared-current", "Shared Current");
  const corrupt = await createMind(env, owner, "corrupt-current", "Corrupt Current");
  await grantMembership(env, shared, member, "editor", "current");

  const memberActor = registeredActor(member.principalId);
  assert.deepEqual(
    (await env.routes.listMinds(memberActor)).map((mind) => mind.route),
    ["/me", "/shared-current"],
  );
  assert.equal(
    await env.metadata.revokeOrdinaryMembershipForTest(
      shared.mindId,
      member.principalId,
      CHANGED_AT,
    ),
    true,
  );
  assert.deepEqual(
    (await env.routes.listMinds(memberActor)).map((mind) => mind.route),
    ["/me"],
  );
  await assert.rejects(
    env.routes.resolveExactMind(memberActor, "shared-current"),
    expectRouteFailure("mind_not_found"),
  );

  assert.equal(
    await env.metadata.changeOrdinaryVisibilityForTest(
      shared.mindId,
      "public",
      CHANGED_AT,
    ),
    true,
  );
  assert.equal(
    (await env.routes.resolveExactMind(
      registeredActor(outsider.principalId),
      "shared-current",
    )).visibility,
    "public",
  );
  const formerMemberRead = await env.routes.resolveExactMind(
    memberActor,
    "shared-current",
  );
  assert.equal(formerMemberRead.visibility, "public");
  assert.equal(formerMemberRead.access.kind, "visibility");
  assert.equal(formerMemberRead.access.role, null);
  assert.equal(
    await env.metadata.changeOrdinaryVisibilityForTest(
      shared.mindId,
      "private",
      CHANGED_AT,
    ),
    true,
  );
  await assert.rejects(
    env.routes.resolveExactMind(
      registeredActor(outsider.principalId),
      "shared-current",
    ),
    expectRouteFailure("mind_not_found"),
  );
  await assert.rejects(
    env.routes.resolveExactMind(memberActor, "shared-current"),
    expectRouteFailure("mind_not_found"),
  );

  assert.equal(await env.metadata.corruptOrdinaryHandleForTest(corrupt.mindId), true);
  await assert.rejects(
    env.routes.resolveExactMind(
      registeredActor(owner.principalId),
      "corrupt-current",
    ),
    expectRouteFailure("mind_not_found"),
  );
  assert.equal(
    await env.metadata.markOrdinaryMindDeletingForTest(shared.mindId, CHANGED_AT),
    true,
  );
  await assert.rejects(
    env.routes.resolveExactMind(
      registeredActor(owner.principalId),
      "shared-current",
    ),
    expectRouteFailure("mind_not_found"),
  );
});

test("private exact opening denies before route metadata is read", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const visitor = await createAccount(env, 2);
  await createMind(
    env,
    owner,
    "private-before-metadata",
    "Private name must not escape",
    "Private description must not escape",
  );
  const traced = tracedStore(env.metadata);
  const routes = new MindRouteService({ routes: traced.store, host: HOST });

  await assert.rejects(
    routes.resolveExactMind(
      registeredActor(visitor.principalId, "request_private_before_metadata"),
      "private-before-metadata",
    ),
    expectRouteFailure("mind_not_found"),
  );
  assert.deepEqual(traced.trace, ["resolve", "authorize"]);
});

test("exact resolve ordering is resolve then authorize then metadata then final authorize", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const visitor = await createAccount(env, 2);
  const mind = await createMind(env, owner, "trace-order", "Trace Order");
  assert.equal(
    await env.metadata.changeOrdinaryVisibilityForTest(
      mind.mindId,
      "public",
      CHANGED_AT,
    ),
    true,
  );
  const traced = tracedStore(env.metadata);
  const routes = new MindRouteService({ routes: traced.store, host: HOST });
  const result = await routes.resolveExactMind(
    registeredActor(visitor.principalId),
    "trace-order",
  );
  assert.equal(result.route, "/trace-order");
  assert.deepEqual(traced.trace, [
    "resolve",
    "authorize",
    "metadata",
    "final_authorize",
  ]);
});

test("final authorization closes revoke, private, deleting, and principal-disable races", async () => {
  const scenarios = [
    {
      name: "revoke",
      prepare: async (env, mind, owner, actorAccount) => {
        await grantMembership(env, mind, actorAccount, "reader", "race_revoke");
      },
      mutate: (env, mind, actorAccount) =>
        env.metadata.revokeOrdinaryMembershipForTest(
          mind.mindId,
          actorAccount.principalId,
          RACE_AT,
        ),
    },
    {
      name: "private",
      prepare: (env, mind) =>
        env.metadata.changeOrdinaryVisibilityForTest(mind.mindId, "public", CHANGED_AT),
      mutate: (env, mind) =>
        env.metadata.changeOrdinaryVisibilityForTest(mind.mindId, "private", RACE_AT),
    },
    {
      name: "deleting",
      prepare: (env, mind) =>
        env.metadata.changeOrdinaryVisibilityForTest(mind.mindId, "public", CHANGED_AT),
      mutate: (env, mind) =>
        env.metadata.markOrdinaryMindDeletingForTest(mind.mindId, RACE_AT),
    },
    {
      name: "principal-disable",
      prepare: (env, mind) =>
        env.metadata.changeOrdinaryVisibilityForTest(mind.mindId, "public", CHANGED_AT),
      mutate: (env, _mind, actorAccount) =>
        env.metadata.disablePrincipalForTest(actorAccount.principalId, RACE_AT),
    },
  ];

  for (const scenario of scenarios) {
    const env = harness();
    const owner = await createAccount(env, 1);
    const actorAccount = await createAccount(env, 2);
    const mind = await createMind(env, owner, `race-${scenario.name}`, `Race ${scenario.name}`);
    assert.notEqual(await scenario.prepare(env, mind, owner, actorAccount), false);
    const traced = tracedStore(env.metadata, {
      beforeFinalAuthorize: async () => {
        assert.equal(await scenario.mutate(env, mind, actorAccount), true);
      },
    });
    const routes = new MindRouteService({ routes: traced.store, host: HOST });
    await assert.rejects(
      routes.resolveExactMind(
        registeredActor(actorAccount.principalId, `request_race_${scenario.name}`),
        `race-${scenario.name}`,
      ),
      expectRouteFailure("mind_not_found"),
    );
    assert.deepEqual(traced.trace, [
      "resolve",
      "authorize",
      "metadata",
      "final_authorize",
    ]);
  }
});

test("list omits a membership revoked between metadata projection and final authorization", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const member = await createAccount(env, 2);
  const mind = await createMind(env, owner, "list-race", "List Race");
  await grantMembership(env, mind, member, "reader", "list_race");
  const traced = tracedStore(env.metadata, {
    beforeFinalAuthorize: async () => {
      assert.equal(
        await env.metadata.revokeOrdinaryMembershipForTest(
          mind.mindId,
          member.principalId,
          RACE_AT,
        ),
        true,
      );
    },
  });
  const routes = new MindRouteService({ routes: traced.store, host: HOST });
  assert.deepEqual(
    (await routes.listMinds(registeredActor(member.principalId))).map(
      (descriptor) => descriptor.route,
    ),
    ["/me"],
  );
  assert.deepEqual(traced.trace, ["authorize", "metadata", "final_authorize"]);
});
