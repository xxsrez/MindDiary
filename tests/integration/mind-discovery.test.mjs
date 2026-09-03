import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  CanonicalRevisionCoordinator,
  MindDiscoveryFailure,
  MindDiscoveryService,
} from "@mind-diary/application-content";
import {
  AccountBootstrapService,
  OrdinaryMindControlService,
  PersonalMindControlService,
  PrincipalMindUsageApplicationService,
  VisibilityControlService,
} from "@mind-diary/application-control";
import {
  CAPABILITIES,
  createCanonicalRevisionEnvelope,
  verifiedSpaceHost,
  version,
} from "@mind-diary/domain";

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

function usageIds() {
  let generation = 0;
  let audit = 0;
  let outbox = 0;
  return {
    nextPrincipalMindUsageGenerationId: () => `usage_discovery_generation_${++generation}`,
    nextPrincipalMindUsageAuditEventId: () => `usage_discovery_audit_${++audit}`,
    nextPrincipalMindUsageOutboxMessageId: () => `usage_discovery_outbox_${++outbox}`,
  };
}

const credentialAccess = Object.freeze({
  async authorizeCredentialContentAccess() {
    return Object.freeze({ kind: "allowed" });
  },
});

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
  const personal = new PersonalMindControlService({
    personalMinds: metadata,
    digest: objects,
  });
  const usage = new PrincipalMindUsageApplicationService({
    usage: metadata,
    digest: objects,
    ids: usageIds(),
  });
  const revisions = new CanonicalRevisionCoordinator({
    objects,
    revisions: metadata,
  });
  const discovery = new MindDiscoveryService({ store: metadata, host: HOST });
  return {
    metadata,
    objects,
    bootstrap,
    ordinary,
    visibility,
    personal,
    usage,
    revisions,
    discovery,
  };
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
    {
      name,
      handle,
      description: `Durable knowledge for ${name}`,
      idempotencyKey: `create-${handle}`,
    },
  );
}

function mcpActor(
  principalId,
  tokenId,
  scopes = ["content:read"],
  requestId = `request_${tokenId}`,
) {
  return {
    kind: "registered_principal",
    principalId,
    authentication: {
      kind: "mcp_token",
      tokenId,
      bindingOwnerId: `owner_${tokenId}`,
      effectiveScopes: scopes,
    },
    deploymentCapabilities: CAPABILITIES,
    requestId,
    occurredAtUtc: CHANGED_AT,
  };
}

async function authorizeMcpMind(env, principalId, spaceId, tokenId, scopes, options = {}) {
  const snapshot = await env.metadata.readResolvedSpace(spaceId);
  const profile = await env.metadata.readPersonalMindProfile(principalId);
  const isPersonal = profile?.personalMind.spaceId === spaceId;
  const visibility = options.visibility ?? snapshot?.space.visibility ?? "private";
  env.metadata.setCurrentAuthorizationStateForTest(
    { principalId, spaceId, tokenId },
    {
      principal: { principalId, state: "active" },
      space: {
        spaceId,
        state: "active",
        visibility,
        accessVersion: options.accessVersion === undefined
          ? snapshot?.space.accessVersion ?? version(1)
          : version(options.accessVersion),
      },
      membership: options.baseline === true
        ? null
        : {
            principalId,
            spaceId,
            role: options.role ?? (isPersonal ? "owner" : "editor"),
            state: "active",
            version: version(1),
          },
      token: {
        tokenId,
        principalId,
        state: "active",
        scopes,
        version: version(1),
        expiresAt: "2027-08-07T00:00:00.000Z",
      },
    },
  );
}

async function setUsage(env, principalId, spaceId, usageMode, expectedUsageVersion, key) {
  return env.usage.mutate({
    actor: actor(principalId, `request_usage_${key}`),
    spaceId,
    usageMode,
    expectedUsageVersion,
    idempotencyKey: key,
  });
}

function mcpDiscovery(store = null) {
  return new MindDiscoveryService({
    store: store ?? new InMemoryRevisionMetadataStore(),
    host: HOST,
    credentialAccess,
  });
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

test("content commit keeps ordinary metadata HEAD atomic and immediately discoverable", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Owner");
  const mind = await createMind(env, owner, "committed-notes", "Committed Notes");
  const before = await env.revisions.readHeadRevision(mind.mindId);
  assert.ok(before);

  const rolledBackRevisionId = "revision_discovery_rolled_back";
  const rolledBackEnvelope = createCanonicalRevisionEnvelope({
    revisionId: rolledBackRevisionId,
    spaceId: mind.mindId,
    revisionNumber: before.envelope.revision.revisionNumber + 1,
    parentRevisionId: before.envelope.revision.revisionId,
    committedAt: "2026-08-07T08:01:30.000Z",
    committedBy: before.envelope.revision.committedBy,
    manifest: before.envelope.manifest,
    manifestHash: before.envelope.revision.manifestHash,
    summary: "Roll back projected HEAD",
  });
  await assert.rejects(
    env.metadata.runContentCommitTransaction(async (transaction) => {
      const staged = await transaction.commitRevision({
        expectedHeadRevisionId: before.envelope.revision.revisionId,
        envelope: rolledBackEnvelope,
      });
      assert.equal(staged.kind, "committed");
      assert.equal(await transaction.readHead(mind.mindId), rolledBackRevisionId);
      throw new Error("injected failure after projected HEAD");
    }),
    /injected failure after projected HEAD/u,
  );
  assert.equal(
    await env.metadata.readHead(mind.mindId),
    before.envelope.revision.revisionId,
  );
  assert.equal(
    (await env.metadata.readResolvedSpace(mind.mindId)).space.headRevisionId,
    before.envelope.revision.revisionId,
  );

  const firstRequest = {
    spaceId: mind.mindId,
    expectedRevisionId: before.envelope.revision.revisionId,
    revisionId: "revision_discovery_committed",
    committedAt: "2026-08-07T08:02:00.000Z",
    committedBy: before.envelope.revision.committedBy,
    summary: "Advance ordinary Mind HEAD",
    files: before.files,
  };
  const first = await env.revisions.commit(firstRequest);
  assert.equal(first.kind, "committed");
  assert.equal(first.replayed, false);

  const firstSnapshot = await env.metadata.readResolvedSpace(mind.mindId);
  assert.ok(firstSnapshot);
  assert.equal(firstSnapshot.space.headRevisionId, first.envelope.revision.revisionId);
  assert.equal(await env.metadata.readHead(mind.mindId), firstSnapshot.space.headRevisionId);
  const listed = await env.discovery.listMinds(actor(owner.principalId), { limit: 10 });
  assert.equal(
    listed.minds.find((candidate) => candidate.mindId === mind.mindId).head
      .revisionId,
    first.envelope.revision.revisionId,
  );
  assert.equal(
    (await env.discovery.resolveMind(actor(owner.principalId), "committed-notes"))
      .head.revisionId,
    first.envelope.revision.revisionId,
  );
  assert.equal(
    (
      await env.discovery.getMindInfo(
        actor(owner.principalId),
        "committed-notes",
        { kind: "head" },
      )
    ).resolvedRevision.revisionId,
    first.envelope.revision.revisionId,
  );
  assert.equal(
    (
      await env.discovery.getMindInfo(actor(owner.principalId), mind.mindId, {
        kind: "revision",
        revisionId: first.envelope.revision.revisionId,
      })
    ).resolvedRevision.revisionId,
    first.envelope.revision.revisionId,
  );

  const raceBase = await env.revisions.readHeadRevision(mind.mindId);
  assert.ok(raceBase);
  const raceRequest = (suffix) => ({
    spaceId: mind.mindId,
    expectedRevisionId: raceBase.envelope.revision.revisionId,
    revisionId: `revision_discovery_race_${suffix}`,
    committedAt: "2026-08-07T08:03:00.000Z",
    committedBy: raceBase.envelope.revision.committedBy,
    summary: `Race ${suffix}`,
    files: raceBase.files,
  });
  const raceRequests = [raceRequest("a"), raceRequest("b")];
  const raceResults = await Promise.all(
    raceRequests.map((request) => env.revisions.commit(request)),
  );
  const winner = raceResults.find((result) => result.kind === "committed");
  const loser = raceResults.find((result) => result.kind === "stale_head");
  assert.ok(winner);
  assert.ok(loser);
  assert.equal(loser.currentHeadRevisionId, winner.envelope.revision.revisionId);
  assert.equal(
    (await env.metadata.readResolvedSpace(mind.mindId)).space.headRevisionId,
    winner.envelope.revision.revisionId,
  );
  assert.equal(await env.metadata.readHead(mind.mindId), winner.envelope.revision.revisionId);

  const winnerRequest = raceRequests.find(
    (request) => request.revisionId === winner.envelope.revision.revisionId,
  );
  const replay = await env.revisions.commit(winnerRequest);
  assert.equal(replay.kind, "committed");
  assert.equal(replay.replayed, true);
  assert.equal(
    (await env.metadata.readResolvedSpace(mind.mindId)).space.headRevisionId,
    winner.envelope.revision.revisionId,
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

test("MCP discovery omits legacy Personal description and projects the shared writable mount", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Usage Owner");
  const enabled = await createMind(env, owner, "enabled-notes", "Enabled Notes");
  const disabled = await createMind(env, owner, "disabled-notes", "Disabled Notes");
  const profile = await env.metadata.readPersonalMindProfile(owner.principalId);
  assert.ok(profile);
  await env.personal.updateMyMindDescription(actor(owner.principalId), {
    description: "Private durable working preferences",
    expectedMetadataVersion: profile.personalMind.metadataVersion,
    idempotencyKey: "describe-personal-for-mcp",
  });

  assert.equal(
    (await setUsage(
      env,
      owner.principalId,
      owner.personalMind.mindId,
      "read",
      0,
      "enable-personal-read",
    )).kind,
    "applied",
  );
  const writable = await setUsage(
    env,
    owner.principalId,
    enabled.mindId,
    "read_write",
    1,
    "enable-ordinary-write",
  );
  assert.equal(writable.kind, "applied");

  for (const token of [
    { id: "token_usage_read", scopes: ["content:read"] },
    { id: "token_usage_write", scopes: ["content:read", "content:write"] },
  ]) {
    for (const spaceId of [owner.personalMind.mindId, enabled.mindId, disabled.mindId]) {
      await authorizeMcpMind(env, owner.principalId, spaceId, token.id, token.scopes, {
        role: "owner",
      });
    }
  }

  const discovery = mcpDiscovery(env.metadata);
  const readActor = mcpActor(owner.principalId, "token_usage_read");
  const listed = await discovery.listMinds(readActor, { limit: 10 });
  assert.deepEqual(listed.minds.map(({ route }) => route), ["/me", "/enabled-notes"]);
  assert.equal(Object.hasOwn(listed.minds[0], "description"), false);
  assert.equal(listed.minds[0].routingProfile, "personal_default");
  assert.equal(listed.minds[0].usageMode, "read");
  assert.deepEqual(listed.minds[0].effective, { canRead: true, canWrite: false });
  assert.deepEqual(listed.minds[0].writableMount, { active: false, generation: null });
  assert.equal(listed.minds[0].settingsVersion, 2);

  const enabledDescriptor = listed.minds[1];
  assert.equal(enabledDescriptor.description, "Durable knowledge for Enabled Notes");
  assert.equal(enabledDescriptor.routingProfile, "description_based");
  assert.equal(enabledDescriptor.usageMode, "read_write");
  assert.deepEqual(enabledDescriptor.effective, { canRead: true, canWrite: false });
  assert.equal(enabledDescriptor.settingsVersion, 2);
  assert.deepEqual(enabledDescriptor.writableMount, {
    active: true,
    generation: writable.state.activeWriteGeneration.generationId,
  });
  assert.equal(enabledDescriptor.contentCapabilities, undefined);

  const writeDescriptor = await discovery.resolveMind(
    mcpActor(
      owner.principalId,
      "token_usage_write",
      ["content:read", "content:write"],
    ),
    "enabled-notes",
  );
  assert.deepEqual(writeDescriptor.effective, { canRead: true, canWrite: true });
  assert.equal(
    writeDescriptor.writableMount.generation,
    enabledDescriptor.writableMount.generation,
  );

  for (const selector of ["disabled-notes", "missing-notes"]) {
    await assert.rejects(
      discovery.resolveMind(readActor, selector),
      expectFailure("mind_not_found"),
    );
  }
  await assert.rejects(
    discovery.getMindInfo(readActor, disabled.mindId, { kind: "head" }),
    expectFailure("mind_not_found"),
  );
  await assert.rejects(
    discovery.getMindInfo(readActor, "/disabled-notes", { kind: "head" }),
    expectFailure("mind_not_found"),
  );

  assert.equal(
    (await setUsage(
      env,
      owner.principalId,
      disabled.mindId,
      "read",
      2,
      "enable-disabled-as-read-only",
    )).kind,
    "applied",
  );
  const readOnlyInfo = await discovery.getMindInfo(
    mcpActor(
      owner.principalId,
      "token_usage_write",
      ["content:read", "content:write"],
    ),
    "/disabled-notes",
    { kind: "head" },
  );
  assert.equal(readOnlyInfo.mind.route, "/disabled-notes");
  assert.equal(readOnlyInfo.mind.description, "Durable knowledge for Disabled Notes");
  assert.equal(readOnlyInfo.mind.routingProfile, "description_based");
  assert.equal(readOnlyInfo.mind.usageMode, "read");
  assert.deepEqual(readOnlyInfo.mind.effective, { canRead: true, canWrite: false });
  assert.equal(readOnlyInfo.mind.settingsVersion, 3);
  assert.deepEqual(readOnlyInfo.mind.writableMount, {
    active: false,
    generation: null,
  });
  assert.equal(readOnlyInfo.contentCapabilities.includes("browse"), true);
  assert.equal(readOnlyInfo.contentCapabilities.includes("commit"), false);
});

test("enabled public and unlisted Minds remain readable through current visibility grants", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Public Owner");
  const viewer = await createAccount(env, 2, "Visibility Viewer");
  const published = await createMind(env, owner, "enabled-public", "Enabled Public");
  const unlisted = await createMind(env, owner, "enabled-unlisted", "Enabled Unlisted");
  await makeVisible(env, owner, published, "public", "enabled-public");
  await makeVisible(env, owner, unlisted, "unlisted", "enabled-unlisted");
  assert.equal(
    (await setUsage(env, viewer.principalId, published.mindId, "read", 0, "read-public"))
      .kind,
    "applied",
  );
  assert.equal(
    (await setUsage(env, viewer.principalId, unlisted.mindId, "read", 1, "read-unlisted"))
      .kind,
    "applied",
  );
  for (const [spaceId, visibility] of [
    [published.mindId, "public"],
    [unlisted.mindId, "unlisted"],
  ]) {
    await authorizeMcpMind(
      env,
      viewer.principalId,
      spaceId,
      "token_visibility_read",
      ["content:read"],
      { baseline: true, visibility },
    );
  }

  const listed = await mcpDiscovery(env.metadata).listMinds(
    mcpActor(viewer.principalId, "token_visibility_read"),
    { limit: 10 },
  );
  assert.deepEqual(listed.minds.map(({ route }) => route), [
    "/enabled-public",
    "/enabled-unlisted",
  ]);
  assert.equal(listed.minds.every(({ access }) => access.kind === "visibility"), true);
  assert.equal(listed.minds.every(({ usageMode }) => usageMode === "read"), true);
});

test("MCP list cursor is invalidated when principal settings version or writable mount changes", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Cursor Owner");
  const ordinary = await createMind(env, owner, "cursor-notes", "Cursor Notes");
  await setUsage(env, owner.principalId, owner.personalMind.mindId, "read", 0, "cursor-me");
  await setUsage(env, owner.principalId, ordinary.mindId, "read", 1, "cursor-mind");
  for (const spaceId of [owner.personalMind.mindId, ordinary.mindId]) {
    await authorizeMcpMind(
      env,
      owner.principalId,
      spaceId,
      "token_cursor",
      ["content:read", "content:write"],
      { role: "owner" },
    );
  }
  const discovery = mcpDiscovery(env.metadata);
  const currentActor = mcpActor(
    owner.principalId,
    "token_cursor",
    ["content:read", "content:write"],
  );
  const first = await discovery.listMinds(currentActor, { limit: 1 });
  assert.ok(first.nextCursor);
  await setUsage(env, owner.principalId, ordinary.mindId, "read_write", 2, "cursor-switch");
  await assert.rejects(
    discovery.listMinds(currentActor, { cursor: first.nextCursor, limit: 1 }),
    expectFailure("invalid_cursor"),
  );
});

test("malformed principal usage state fails closed before descriptor projection", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Corrupt Owner");
  const mind = await createMind(env, owner, "corrupt-usage", "Corrupt Usage");
  const applied = await setUsage(
    env,
    owner.principalId,
    mind.mindId,
    "read_write",
    0,
    "corrupt-source",
  );
  assert.equal(applied.kind, "applied");
  await authorizeMcpMind(
    env,
    owner.principalId,
    mind.mindId,
    "token_corrupt_usage",
    ["content:read", "content:write"],
    { role: "owner" },
  );
  let proxy;
  proxy = new Proxy(env.metadata, {
    get(target, property) {
      if (property === "withConsistentRead") return undefined;
      if (property === "readPrincipalMindUsage") {
        return async () => ({
          ...applied.state,
          activeWriteGeneration: null,
        });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const discovery = mcpDiscovery(proxy);
  const currentActor = mcpActor(
    owner.principalId,
    "token_corrupt_usage",
    ["content:read", "content:write"],
  );
  await assert.rejects(
    discovery.listMinds(currentActor, { limit: 10 }),
    expectFailure("discovery_unavailable"),
  );
  await assert.rejects(
    discovery.resolveMind(currentActor, "corrupt-usage"),
    expectFailure("discovery_unavailable"),
  );
});
