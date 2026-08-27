import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  AccountBootstrapService,
  MindRouteFailure,
  MindRouteService,
  OrdinaryMindControlService,
  PublicMindCatalogFailure,
  PublicMindCatalogService,
  VisibilityControlService,
} from "@mind-diary/application-control";
import { CAPABILITIES, verifiedSpaceHost } from "@mind-diary/domain";

const CREATED_AT = "2026-08-07T06:00:00.000Z";
const CHANGED_AT = "2026-08-07T06:01:00.000Z";
const LATER_AT = "2026-08-07T06:02:00.000Z";
const HOST = verifiedSpaceHost("mind-diary.example");

function preRegistrationActor(index, displayName = `Principal ${index}`) {
  return {
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding: `private.catalog.${index}@example.com`,
    suggestedDisplayName: displayName,
    deploymentCapabilities: CAPABILITIES,
    requestId: `request_catalog_bootstrap_${index}`,
    occurredAtUtc: CREATED_AT,
  };
}

function registeredActor(
  principalId,
  requestId = "request_public_catalog",
  occurredAtUtc = CHANGED_AT,
) {
  return {
    kind: "registered_principal",
    principalId,
    authentication: { kind: "sites_identity" },
    deploymentCapabilities: CAPABILITIES,
    requestId,
    occurredAtUtc,
  };
}

function accountIds() {
  let account = 0;
  return {
    nextPrincipalId: () => `principal_catalog_${++account}`,
    nextExternalBindingId: () => `binding_catalog_${account}`,
    nextSpaceId: () => `space_personal_catalog_${account}`,
    nextMembershipId: () => `membership_personal_catalog_${account}`,
    nextRevisionId: () => `revision_personal_catalog_${account}`,
    nextPersonalSpaceHandle: () => `personal-service-catalog-${account}`,
  };
}

function ordinaryIds() {
  let spaces = 0;
  let memberships = 0;
  let revisions = 0;
  return {
    nextSpaceId: () => `space_catalog_${String(++spaces).padStart(3, "0")}`,
    nextMembershipId: () => `membership_catalog_owner_${++memberships}`,
    nextRevisionId: () => `revision_catalog_${++revisions}`,
  };
}

function auditIds() {
  let events = 0;
  let outbox = 0;
  return {
    nextAuditEventId: () => `audit_catalog_${++events}`,
    nextOutboxMessageId: () => `outbox_catalog_${++outbox}`,
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
  const visibility = new VisibilityControlService({
    ordinaryMinds: metadata,
    objects,
    auditIds: auditIds(),
  });
  const routes = new MindRouteService({ routes: metadata, host: HOST });
  const catalog = new PublicMindCatalogService({
    catalog: metadata,
    host: HOST,
    logger: { record: (event) => events.push(event) },
  });
  return { metadata, objects, events, bootstrap, ordinary, visibility, routes, catalog };
}

async function createAccount(env, index, name = `Principal ${index}`) {
  return env.bootstrap.bootstrapAccount(preRegistrationActor(index, name), {
    action: "create_isolated_account",
  });
}

async function createMind(env, owner, handle, name = handle, description = undefined) {
  return env.ordinary.createSpaceWithOwner(
    registeredActor(owner.principalId, `request_create_${handle}`, CREATED_AT),
    {
      name,
      handle,
      ...(description === undefined ? {} : { description }),
      idempotencyKey: `create-${handle}`,
    },
  );
}

async function currentMind(env, mindId) {
  const current = await env.metadata.inspectOrdinaryMindStateForTest(mindId);
  assert.ok(current);
  return current;
}

async function changeVisibility(env, owner, mind, visibility, suffix) {
  const current = await currentMind(env, mind.mindId);
  return env.visibility.changeVisibility(
    registeredActor(owner.principalId, `request_visibility_${suffix}`, LATER_AT),
    {
      mindId: mind.mindId,
      visibility,
      acknowledgeLiveHeadAndHistoryExposure:
        current.space.visibility === "private" && visibility !== "private",
      expectedMetadataVersion: current.space.metadataVersion,
      idempotencyKey: `visibility-${suffix}`,
    },
  );
}

function expectCatalogFailure(code) {
  return (error) => {
    assert.equal(error instanceof PublicMindCatalogFailure, true);
    assert.equal(error.code, code);
    return true;
  };
}

function expectRouteFailure(code) {
  return (error) => {
    assert.equal(error instanceof MindRouteFailure, true);
    assert.equal(error.code, code);
    return true;
  };
}

function encodeCursor(payload) {
  return `mdc1_${btoa(JSON.stringify(payload))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")}`;
}

function countedCatalogStore(metadata) {
  const reads = { profile: 0, catalog: 0 };
  const store = new Proxy(metadata, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "readPersonalMindProfile") {
        return (...args) => {
          reads.profile += 1;
          return value.apply(target, args);
        };
      }
      if (property === "listPublicMindCatalogPage") {
        return (...args) => {
          reads.catalog += 1;
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
  return { store, reads };
}

test("authenticated catalog returns only current public ordinary Minds without fake memberships", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Catalog Owner");
  const visitor = await createAccount(env, 2, "Catalog Visitor");
  const publicMind = await createMind(
    env,
    owner,
    "public-library",
    "Public Library",
    "A public catalog description.",
  );
  const unlistedMind = await createMind(env, owner, "exact-only", "Exact Only");
  const privateMind = await createMind(env, owner, "private-notes", "Private Notes");
  await changeVisibility(env, owner, publicMind, "public", "public-library");
  await changeVisibility(env, owner, unlistedMind, "unlisted", "exact-only");

  const result = await env.catalog.listPublicMinds(
    registeredActor(visitor.principalId),
    {},
  );
  assert.equal(result.nextCursor, null);
  assert.deepEqual(result.minds.map((mind) => mind.route), ["/public-library"]);
  assert.deepEqual(result.minds[0], {
    mindId: publicMind.mindId,
    route: "/public-library",
    handle: "public-library",
    name: "Public Library",
    description: "A public catalog description.",
    isPersonal: false,
    visibility: "public",
    discovery: "public_catalog",
    access: {
      kind: "visibility",
      role: null,
      capabilities: result.minds[0].access.capabilities,
    },
    metadataVersion: 2,
    headRevisionId: publicMind.headRevisionId,
  });
  assert.equal(result.minds[0].access.capabilities.includes("content:fetch"), true);
  assert.equal(result.minds[0].access.capabilities.includes("content:write"), false);
  assert.equal((await currentMind(env, publicMind.mindId)).memberships.length, 1);
  assert.equal((await currentMind(env, unlistedMind.mindId)).memberships.length, 1);
  assert.equal((await currentMind(env, privateMind.mindId)).memberships.length, 1);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("Exact Only"), false);
  assert.equal(serialized.includes("Private Notes"), false);
  assert.equal(serialized.includes("personal-service-catalog"), false);

  const ownerResult = await env.catalog.listPublicMinds(
    registeredActor(owner.principalId, "request_owner_catalog"),
  );
  assert.equal(ownerResult.minds[0].access.kind, "membership");
  assert.equal(ownerResult.minds[0].access.role, "owner");
  assert.equal(env.events.length, 2);
  for (const event of env.events) {
    assert.deepEqual(Object.keys(event).sort(), ["event", "requestId"]);
  }
});

test("anonymous, MCP, service and inactive actors are denied before catalog reads, including empty pages", async () => {
  const env = harness();
  const account = await createAccount(env, 1);
  const counted = countedCatalogStore(env.metadata);
  const catalog = new PublicMindCatalogService({ catalog: counted.store, host: HOST });
  const deniedActors = [
    {
      kind: "anonymous",
      requestId: "request_anonymous_catalog",
      occurredAtUtc: CHANGED_AT,
      deploymentCapabilities: CAPABILITIES,
    },
    {
      ...registeredActor(account.principalId, "request_mcp_catalog"),
      authentication: {
        kind: "mcp_token",
        tokenId: "token_catalog",
        effectiveScopes: ["content:read"],
      },
    },
    {
      kind: "service",
      serviceId: "catalog-service",
      requestId: "request_service_catalog",
      occurredAtUtc: CHANGED_AT,
      deploymentCapabilities: CAPABILITIES,
    },
  ];
  for (const actor of deniedActors) {
    await assert.rejects(
      catalog.listPublicMinds(actor, {}),
      expectCatalogFailure("authentication_required"),
    );
  }
  assert.deepEqual(counted.reads, { profile: 0, catalog: 0 });

  assert.equal(
    await env.metadata.disablePrincipalForTest(account.principalId, LATER_AT),
    true,
  );
  await assert.rejects(
    catalog.listPublicMinds(
      registeredActor(account.principalId, "request_inactive_catalog"),
      {},
    ),
    expectCatalogFailure("authentication_required"),
  );
  assert.deepEqual(counted.reads, { profile: 1, catalog: 0 });

  const raced = harness();
  const racedAccount = await createAccount(raced, 1);
  const raceStore = new Proxy(raced.metadata, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "listPublicMindCatalogPage") {
        return async (...args) => {
          const page = await value.apply(target, args);
          assert.equal(
            await target.disablePrincipalForTest(racedAccount.principalId, LATER_AT),
            true,
          );
          return page;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const racedCatalog = new PublicMindCatalogService({
    catalog: raceStore,
    host: HOST,
  });
  await assert.rejects(
    racedCatalog.listPublicMinds(
      registeredActor(racedAccount.principalId, "request_empty_page_disable_race"),
    ),
    expectCatalogFailure("authentication_required"),
  );
});

test("initial active-account read failures are normalized without leaking store context", async () => {
  const env = harness();
  const account = await createAccount(env, 1);
  const sensitiveSentinel = "private-profile-row:catalog-owner-secret";
  const events = [];
  const store = new Proxy(env.metadata, {
    get(target, property) {
      if (property === "readPersonalMindProfile") {
        return async () => {
          throw new Error(sensitiveSentinel);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const catalog = new PublicMindCatalogService({
    catalog: store,
    host: HOST,
    logger: { record: (event) => events.push(event) },
  });

  await assert.rejects(
    catalog.listPublicMinds(
      {
        kind: "anonymous",
        requestId: "request_initial_profile_anonymous",
        occurredAtUtc: CHANGED_AT,
        deploymentCapabilities: CAPABILITIES,
      },
      {},
    ),
    expectCatalogFailure("authentication_required"),
  );

  let failure;
  try {
    await catalog.listPublicMinds(
      registeredActor(
        account.principalId,
        "request_initial_profile_store_failure",
      ),
      {},
    );
    assert.fail("catalog call should fail");
  } catch (error) {
    failure = error;
  }
  assert.equal(failure instanceof PublicMindCatalogFailure, true);
  assert.equal(failure.code, "catalog_unavailable");
  assert.equal(failure.message, "Public catalog is unavailable.");
  assert.deepEqual(events, [
    {
      event: "public_minds_denied",
      requestId: "request_initial_profile_anonymous",
    },
    {
      event: "public_minds_failed",
      requestId: "request_initial_profile_store_failure",
    },
  ]);
  assert.equal(
    JSON.stringify({
      error: {
        name: failure.name,
        code: failure.code,
        message: failure.message,
        stack: failure.stack,
      },
      events,
    }).includes(sensitiveSentinel),
    false,
  );
});

test("query validation is stable and cursors are bounded, canonical, versioned and query-bound", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const first = await createMind(env, owner, "cursor-first");
  const second = await createMind(env, owner, "cursor-second");
  await changeVisibility(env, owner, first, "public", "cursor-first");
  await changeVisibility(env, owner, second, "public", "cursor-second");
  const actor = registeredActor(owner.principalId, "request_cursor_validation");
  const valid = await env.catalog.listPublicMinds(actor, { limit: 1 });
  assert.equal(typeof valid.nextCursor, "string");

  const getterQuery = Object.defineProperty({}, "cursor", {
    enumerable: true,
    get: () => {
      throw new Error("must not execute catalog query getters");
    },
  });
  const symbolQuery = { [Symbol("hidden")]: true };
  for (const query of [
    null,
    [],
    "cursor",
    1,
    () => undefined,
    getterQuery,
    symbolQuery,
  ]) {
    await assert.rejects(
      env.catalog.listPublicMinds(actor, query),
      expectCatalogFailure("invalid_query"),
    );
  }
  await assert.rejects(
    env.catalog.listPublicMinds(actor, { limit: 1, extra: true }),
    expectCatalogFailure("invalid_query"),
  );
  for (const limit of [0, -1, 1.5, 101, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    await assert.rejects(
      env.catalog.listPublicMinds(actor, { limit }),
      expectCatalogFailure("invalid_limit"),
    );
  }

  const invalidCursors = [
    "x".repeat(257),
    "mdc1_=",
    "mdc1_A",
    `${valid.nextCursor}=`,
    encodeCursor({ q: "public_minds", v: 1, g: 2, o: 1 }),
    encodeCursor({ v: 2, q: "public_minds", g: 2, o: 1 }),
    encodeCursor({ v: 1, q: "other_query", g: 2, o: 1 }),
    encodeCursor({ v: 1, q: "public_minds", g: -1, o: 1 }),
    encodeCursor({ v: 1, q: "public_minds", g: 2.5, o: 1 }),
    encodeCursor({ v: 1, q: "public_minds", g: 2, o: -1 }),
    encodeCursor({ v: 1, q: "public_minds", g: 2, o: 1.5 }),
    encodeCursor({ v: 1, q: "public_minds", g: 2, o: 99 }),
    encodeCursor({ v: 1, q: "public_minds", g: 2, o: 1, extra: true }),
  ];
  for (const cursor of invalidCursors) {
    await assert.rejects(
      env.catalog.listPublicMinds(actor, { cursor, limit: 1 }),
      expectCatalogFailure("invalid_cursor"),
    );
  }
  assert.equal(
    (await env.catalog.listPublicMinds(actor, { cursor: valid.nextCursor, limit: 1 }))
      .minds.length,
    1,
  );
});

test("pagination uses deterministic immutable ID snapshots and expired generations fail explicitly", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const visitor = await createAccount(env, 2);
  const minds = [];
  for (const handle of ["page-d", "page-a", "page-c", "page-b"]) {
    const mind = await createMind(env, owner, handle, handle.toUpperCase());
    minds.push(mind);
    await changeVisibility(env, owner, mind, "public", handle);
  }
  const actor = registeredActor(visitor.principalId, "request_pagination");
  const firstPage = await env.catalog.listPublicMinds(actor, { limit: 2 });
  assert.deepEqual(firstPage.minds.map((mind) => mind.mindId), [
    minds[0].mindId,
    minds[1].mindId,
  ]);
  assert.equal(typeof firstPage.nextCursor, "string");

  await changeVisibility(env, owner, minds[2], "private", "page-c-private");
  const added = await createMind(env, owner, "page-added");
  await changeVisibility(env, owner, added, "public", "page-added");
  const oldSecondPage = await env.catalog.listPublicMinds(actor, {
    cursor: firstPage.nextCursor,
    limit: 2,
  });
  assert.deepEqual(oldSecondPage.minds.map((mind) => mind.mindId), [
    minds[3].mindId,
  ]);
  assert.equal(oldSecondPage.minds.some((mind) => mind.mindId === added.mindId), false);
  const fresh = await env.catalog.listPublicMinds(actor, { limit: 100 });
  assert.deepEqual(fresh.minds.map((mind) => mind.mindId), [
    minds[0].mindId,
    minds[1].mindId,
    minds[3].mindId,
    added.mindId,
  ]);

  const expiring = firstPage.nextCursor;
  for (let index = 0; index < 33; index += 1) {
    assert.equal(
      await env.metadata.changeOrdinaryVisibilityForTest(
        minds[0].mindId,
        index % 2 === 0 ? "unlisted" : "public",
        LATER_AT,
      ),
      true,
    );
  }
  await assert.rejects(
    env.catalog.listPublicMinds(actor, { cursor: expiring, limit: 2 }),
    expectCatalogFailure("invalid_cursor"),
  );
  const projection = await env.metadata.inspectPublicMindCatalogForTest();
  assert.equal(projection.retainedSnapshots, 32);
});

test("old snapshots fail closed after public-to-private, deleting or route corruption", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Hidden Owner");
  const visitor = await createAccount(env, 2);
  const minds = [];
  for (const [handle, name] of [
    ["safe-anchor", "Safe Anchor"],
    ["hidden-private", "Private Secret Name"],
    ["hidden-deleting", "Deleting Secret Name"],
    ["hidden-corrupt", "Corrupt Secret Name"],
  ]) {
    const mind = await createMind(env, owner, handle, name);
    minds.push(mind);
    await changeVisibility(env, owner, mind, "public", handle);
  }
  const actor = registeredActor(visitor.principalId, "request_old_snapshot");
  const first = await env.catalog.listPublicMinds(actor, { limit: 1 });
  assert.equal(first.minds[0].mindId, minds[0].mindId);

  await changeVisibility(env, owner, minds[1], "private", "old-private");
  assert.equal(
    await env.metadata.markOrdinaryMindDeletingForTest(minds[2].mindId, LATER_AT),
    true,
  );
  assert.equal(
    await env.metadata.corruptOrdinaryHandleForTest(minds[3].mindId),
    true,
  );
  const remainder = await env.catalog.listPublicMinds(actor, {
    cursor: first.nextCursor,
    limit: 100,
  });
  assert.deepEqual(remainder.minds, []);
  const serialized = JSON.stringify(remainder);
  for (const secret of [
    "Private Secret Name",
    "Deleting Secret Name",
    "Corrupt Secret Name",
    "hidden-private",
    "hidden-deleting",
    "hidden-corrupt",
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
  await assert.rejects(
    env.routes.resolveExactMind(actor, "hidden-private"),
    expectRouteFailure("mind_not_found"),
  );
});

test("projection corruption and malformed candidates never become descriptors or raw failures", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Projection Owner");
  const visitor = await createAccount(env, 2);
  const privateMind = await createMind(
    env,
    owner,
    "projection-private",
    "Projection Private Name",
  );
  const publicMind = await createMind(
    env,
    owner,
    "projection-public",
    "Projection Public Name",
  );
  await changeVisibility(env, owner, publicMind, "public", "projection-public");
  await env.metadata.corruptPublicMindCatalogForTest([
    null,
    7,
    "",
    "space_missing_catalog",
    privateMind.mindId,
    publicMind.mindId,
    publicMind.mindId,
  ]);
  const result = await env.catalog.listPublicMinds(
    registeredActor(visitor.principalId, "request_projection_corrupt"),
    { limit: 100 },
  );
  assert.deepEqual(result.minds.map((mind) => mind.mindId), [publicMind.mindId]);
  assert.equal(JSON.stringify(result).includes("Projection Private Name"), false);
  await changeVisibility(
    env,
    owner,
    publicMind,
    "unlisted",
    "projection-corruption-repair",
  );
  assert.deepEqual(
    (await env.metadata.inspectPublicMindCatalogForTest()).spaceIds,
    [],
  );
});

test("malformed adapter pages fail with a stable safe catalog error", async () => {
  const env = harness();
  const account = await createAccount(env, 1);
  const actor = registeredActor(account.principalId, "request_malformed_page");
  const malformedPages = [
    null,
    { kind: "other" },
    { kind: "page", spaceIds: null, nextCursor: null },
    { kind: "page", spaceIds: ["one", "two"], nextCursor: null },
    { kind: "page", spaceIds: [], nextCursor: 7 },
  ];
  for (const malformed of malformedPages) {
    const events = [];
    const store = new Proxy(env.metadata, {
      get(target, property) {
        if (property === "listPublicMindCatalogPage") {
          return async () => malformed;
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const catalog = new PublicMindCatalogService({
      catalog: store,
      host: HOST,
      logger: { record: (event) => events.push(event) },
    });
    await assert.rejects(
      catalog.listPublicMinds(actor, { limit: 1 }),
      expectCatalogFailure("catalog_unavailable"),
    );
    assert.deepEqual(events, [
      {
        event: "public_minds_failed",
        requestId: "request_malformed_page",
      },
    ]);
  }
});

test("visibility projection changes are atomic and exact retries do not duplicate generations", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const mind = await createMind(env, owner, "atomic-projection");
  const actor = registeredActor(owner.principalId, "request_atomic_projection");
  const beforeProjection = await env.metadata.inspectPublicMindCatalogForTest();
  const command = {
    mindId: mind.mindId,
    visibility: "public",
    acknowledgeLiveHeadAndHistoryExposure: true,
    expectedMetadataVersion: 1,
    idempotencyKey: "atomic-projection",
  };
  env.metadata.failNextOrdinaryMindAtForTest("visibility_after_catalog");
  await assert.rejects(
    env.visibility.changeVisibility(actor, command),
    /injected ordinary Mind transaction failure/u,
  );
  assert.deepEqual(
    await env.metadata.inspectPublicMindCatalogForTest(),
    beforeProjection,
  );
  assert.equal((await currentMind(env, mind.mindId)).space.visibility, "private");
  assert.equal((await env.metadata.listAuditEventsForTest()).length, 0);

  const changed = await env.visibility.changeVisibility(actor, command);
  const afterChanged = await env.metadata.inspectPublicMindCatalogForTest();
  assert.deepEqual(afterChanged.spaceIds, [mind.mindId]);
  assert.equal(afterChanged.generation, beforeProjection.generation + 1);
  const replay = await env.visibility.changeVisibility(actor, command);
  assert.equal(replay.replayed, true);
  assert.deepEqual(
    await env.metadata.inspectPublicMindCatalogForTest(),
    afterChanged,
  );

  const noop = await env.visibility.changeVisibility(
    registeredActor(owner.principalId, "request_public_noop"),
    {
      mindId: mind.mindId,
      visibility: "public",
      expectedMetadataVersion: changed.metadataVersion,
      idempotencyKey: "public-noop-projection",
    },
  );
  assert.equal(noop.changed, false);
  assert.deepEqual(
    await env.metadata.inspectPublicMindCatalogForTest(),
    afterChanged,
  );
});

test("concurrent visibility writers leave catalog projection equal to canonical final state", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const visitor = await createAccount(env, 2);
  const mind = await createMind(env, owner, "catalog-race");
  const results = await Promise.allSettled([
    env.visibility.changeVisibility(
      registeredActor(owner.principalId, "request_race_public"),
      {
        mindId: mind.mindId,
        visibility: "public",
        acknowledgeLiveHeadAndHistoryExposure: true,
        expectedMetadataVersion: 1,
        idempotencyKey: "race-public",
      },
    ),
    env.visibility.changeVisibility(
      registeredActor(owner.principalId, "request_race_unlisted"),
      {
        mindId: mind.mindId,
        visibility: "unlisted",
        acknowledgeLiveHeadAndHistoryExposure: true,
        expectedMetadataVersion: 1,
        idempotencyKey: "race-unlisted",
      },
    ),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const canonical = await currentMind(env, mind.mindId);
  const projection = await env.metadata.inspectPublicMindCatalogForTest();
  assert.equal(
    projection.spaceIds.includes(mind.mindId),
    canonical.space.visibility === "public",
  );
  const listed = await env.catalog.listPublicMinds(
    registeredActor(visitor.principalId, "request_race_list"),
  );
  assert.equal(
    listed.minds.some((descriptor) => descriptor.mindId === mind.mindId),
    canonical.space.visibility === "public",
  );
  assert.equal((await currentMind(env, mind.mindId)).memberships.length, 1);
});
