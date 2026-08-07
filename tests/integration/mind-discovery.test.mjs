import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  MindDiscoveryFailure,
  MindDiscoveryService,
} from "@mind-diary/application-content";
import {
  AccountBootstrapService,
  OrdinaryMindControlService,
  VisibilityControlService,
} from "@mind-diary/application-control";
import { CAPABILITIES, verifiedSpaceHost, version } from "@mind-diary/domain";

const CREATED_AT = "2026-08-07T08:00:00.000Z";
const CHANGED_AT = "2026-08-07T08:01:00.000Z";
const HOST = verifiedSpaceHost("mind-diary.example");

function preRegistrationActor(index, displayName = `Principal ${index}`) {
  return {
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding: `private.discovery.${index}@example.com`,
    suggestedDisplayName: displayName,
    deploymentCapabilities: CAPABILITIES,
    requestId: `request_discovery_bootstrap_${index}`,
    occurredAtUtc: CREATED_AT,
  };
}

function actor(principalId, requestId = "request_discovery") {
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
    nextPrincipalId: () => `principal_discovery_${++account}`,
    nextExternalBindingId: () => `binding_discovery_${account}`,
    nextSpaceId: () => `space_personal_discovery_${account}`,
    nextMembershipId: () => `membership_personal_discovery_${account}`,
    nextRevisionId: () => `revision_personal_discovery_${account}`,
    nextPersonalSpaceHandle: () => `personal-service-discovery-${account}`,
  };
}

function ordinaryIds() {
  let space = 0;
  let membership = 0;
  let revision = 0;
  return {
    nextSpaceId: () => `space_discovery_${String(++space).padStart(3, "0")}`,
    nextMembershipId: () => `membership_discovery_owner_${++membership}`,
    nextRevisionId: () => `revision_discovery_${++revision}`,
  };
}

function auditIds() {
  let event = 0;
  let outbox = 0;
  return {
    nextAuditEventId: () => `audit_discovery_${++event}`,
    nextOutboxMessageId: () => `outbox_discovery_${++outbox}`,
  };
}

function harness() {
  const metadata = new InMemoryRevisionMetadataStore();
  const objects = new InMemoryObjectStore();
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
  const discovery = new MindDiscoveryService({ store: metadata, host: HOST });
  return { metadata, objects, bootstrap, ordinary, visibility, discovery };
}

async function createAccount(env, index, displayName) {
  return env.bootstrap.bootstrapAccount(
    preRegistrationActor(index, displayName),
    { action: "create_isolated_account" },
  );
}

async function createMind(env, owner, handle, name = handle) {
  return env.ordinary.createSpaceWithOwner(
    actor(owner.principalId, `request_create_${handle}`),
    { name, handle, idempotencyKey: `create-${handle}` },
  );
}

async function currentMind(env, mindId) {
  const current = await env.metadata.inspectOrdinaryMindStateForTest(mindId);
  assert.ok(current);
  return current;
}

async function makeVisible(env, owner, mind, visibility, suffix) {
  const current = await currentMind(env, mind.mindId);
  return env.visibility.changeVisibility(
    actor(owner.principalId, `request_visibility_${suffix}`),
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

async function grantMembership(env, mind, owner, member, role = "editor") {
  assert.equal(
    await env.metadata.grantOrdinaryMembershipForTest(
      {
        membershipId: `membership_discovery_${mind.mindId}_${member.principalId}`,
        spaceId: mind.mindId,
        principalId: member.principalId,
        role,
        state: "active",
        version: version(1),
        createdAt: CHANGED_AT,
        createdBy: owner.principalId,
        updatedAt: CHANGED_AT,
        updatedBy: owner.principalId,
      },
      CHANGED_AT,
    ),
    true,
  );
}

function expectFailure(code) {
  return (error) => {
    assert.equal(error instanceof MindDiscoveryFailure, true);
    assert.equal(error.code, code);
    return true;
  };
}

test("list_minds combines Personal, accepted memberships and public catalog with stable pagination", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Owner");
  const member = await createAccount(env, 2, "Member");
  const shared = await createMind(env, owner, "shared-notes", "Shared Notes");
  const published = await createMind(env, owner, "public-notes", "Public Notes");
  const unlisted = await createMind(env, owner, "quiet-notes", "Quiet Notes");
  const privateMind = await createMind(env, owner, "private-notes", "Private Notes");
  await grantMembership(env, shared, owner, member);
  await makeVisible(env, owner, published, "public", "public");
  await makeVisible(env, owner, unlisted, "unlisted", "unlisted");

  const first = await env.discovery.listMinds(actor(member.principalId), { limit: 2 });
  assert.deepEqual(first.minds.map((mind) => mind.route), ["/me", "/public-notes"]);
  assert.match(first.nextCursor, /^mdm1_[0-9a-z]+_[0-9a-f]{8}$/);
  assert.equal(first.minds[0].handle, null);
  assert.equal(first.minds[0].head.revisionNumber, 1);
  assert.equal(first.minds[1].access.kind, "visibility");
  assert.equal(first.minds[1].access.capabilities.includes("content:write"), false);

  const second = await env.discovery.listMinds(actor(member.principalId), {
    cursor: first.nextCursor,
    limit: 2,
  });
  assert.deepEqual(second.minds.map((mind) => mind.route), ["/shared-notes"]);
  assert.equal(second.nextCursor, null);
  assert.equal(second.minds[0].access.kind, "membership");
  assert.equal(second.minds[0].access.role, "editor");

  const allRoutes = [...first.minds, ...second.minds].map((mind) => mind.route);
  assert.equal(new Set(allRoutes).size, allRoutes.length);
  assert.equal(allRoutes.includes("/quiet-notes"), false);
  assert.equal(allRoutes.includes("/private-notes"), false);
  assert.equal(privateMind.visibility, "private");
});

test("a list cursor fails closed when the authorized universe changes", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Owner");
  const viewer = await createAccount(env, 2, "Viewer");
  const firstPublic = await createMind(env, owner, "alpha-public");
  const secondPublic = await createMind(env, owner, "beta-public");
  await makeVisible(env, owner, firstPublic, "public", "alpha");
  await makeVisible(env, owner, secondPublic, "public", "beta");

  const first = await env.discovery.listMinds(actor(viewer.principalId), { limit: 1 });
  assert.ok(first.nextCursor);
  const thirdPublic = await createMind(env, owner, "aardvark-public");
  await makeVisible(env, owner, thirdPublic, "public", "aardvark");

  await assert.rejects(
    env.discovery.listMinds(actor(viewer.principalId), {
      cursor: first.nextCursor,
      limit: 1,
    }),
    expectFailure("invalid_cursor"),
  );
  for (const invalid of [0, -1, 101, 1.5]) {
    await assert.rejects(
      env.discovery.listMinds(actor(viewer.principalId), { limit: invalid }),
      expectFailure("invalid_limit"),
    );
  }
});

test("resolve_mind exposes exact unlisted access while private denial matches missing", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Owner");
  const viewer = await createAccount(env, 2, "Viewer");
  const unlisted = await createMind(env, owner, "exact-library", "Exact Library");
  const privateMind = await createMind(env, owner, "hidden-library", "Hidden Library");
  await makeVisible(env, owner, unlisted, "unlisted", "exact");

  const exact = await env.discovery.resolveMind(
    actor(viewer.principalId),
    "exact-library",
  );
  assert.equal(exact.mindId, unlisted.mindId);
  assert.equal(exact.discovery, "exact_handle");
  assert.equal(exact.access.kind, "visibility");
  assert.equal(exact.access.capabilities.includes("content:write"), false);

  for (const handle of ["hidden-library", "missing-library"]) {
    await assert.rejects(
      env.discovery.resolveMind(actor(viewer.principalId), handle),
      expectFailure("mind_not_found"),
    );
  }
  await assert.rejects(
    env.discovery.resolveMind(actor(viewer.principalId), "Not Canonical"),
    expectFailure("invalid_mind_selector"),
  );
  assert.equal(privateMind.visibility, "private");
});

test("get_mind_info pins one revision and removes commit from historical mode", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Owner");
  const mind = await createMind(env, owner, "history-notes", "History Notes");
  const current = await currentMind(env, mind.mindId);
  const revisionId = current.space.headRevisionId;

  const head = await env.discovery.getMindInfo(
    actor(owner.principalId),
    "history-notes",
    { kind: "head" },
  );
  assert.equal(head.mind.mindId, mind.mindId);
  assert.equal(head.resolvedRevision.revisionId, revisionId);
  assert.equal(head.revisionMode, "head");
  assert.equal(head.contentCapabilities.includes("commit"), true);

  const historical = await env.discovery.getMindInfo(
    actor(owner.principalId),
    mind.mindId,
    { kind: "revision", revisionId },
  );
  assert.equal(historical.resolvedRevision.revisionId, revisionId);
  assert.equal(historical.revisionMode, "historical");
  assert.equal(historical.contentCapabilities.includes("commit"), false);
  assert.equal(historical.contentCapabilities.includes("browse"), true);

  await assert.rejects(
    env.discovery.getMindInfo(actor(owner.principalId), mind.mindId, {
      kind: "as_of",
      asOf: "2026-08-07T07:59:59.000Z",
    }),
    expectFailure("revision_not_found"),
  );
});

test("mismatched resolved metadata cannot redirect a descriptor to another space", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Owner");
  const mind = await createMind(env, owner, "source-space");
  const original = env.metadata.readResolvedSpace.bind(env.metadata);
  const store = new Proxy(env.metadata, {
    get(target, property) {
      if (property === "readResolvedSpace") {
        return async (spaceId) => {
          const snapshot = await original(spaceId);
          if (snapshot === null) return null;
          return {
            ...snapshot,
            space: { ...snapshot.space, spaceId: "space_redirected" },
          };
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const discovery = new MindDiscoveryService({ store, host: HOST });

  await assert.rejects(
    discovery.resolveMind(actor(owner.principalId), "source-space"),
    expectFailure("mind_not_found"),
  );
  assert.equal(mind.handle, "source-space");
});
