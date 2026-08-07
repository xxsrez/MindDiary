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
