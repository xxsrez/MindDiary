import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryAuditSink } from "@mind-diary/adapter-audit-memory";
import { createBackgroundServiceActor } from "@mind-diary/adapter-background";
import {
  InMemoryRevisionMetadataStore,
} from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  InMemoryExactRevisionSearchIndex,
} from "@mind-diary/adapter-search-memory";
import {
  createWebCryptoExportDownloadSecretCrypto,
} from "@mind-diary/adapter-security-webcrypto";
import {
  AuditOutboxDeliveryHandler,
  ExportJobHandler,
  ReadyExactRevisionIndexService,
  RevisionIndexJobHandler,
} from "@mind-diary/application-background";
import {
  CanonicalRevisionCoordinator,
  ChangesetCommitService,
  DEFAULT_CAPACITY_LIMITS,
  DeterministicOkfExportService,
  ExportJobApplicationService,
} from "@mind-diary/application-content";
import {
  AccountBootstrapService,
  InvitationControlService,
  MindRouteFailure,
  MindRouteService,
  OrdinaryMindControlFailure,
  OrdinaryMindControlService,
  OrdinaryMindDeletionService,
  OwnershipTransferFailure,
  OwnershipTransferService,
  VisibilityControlService,
} from "@mind-diary/application-control";
import {
  CapabilityAuthorizer,
  CurrentAccessBackgroundAuthorizer,
} from "@mind-diary/application-ports";
import { COMPOSITION_SELECTION } from "@mind-diary/composition-root";
import {
  CAPABILITIES,
  verifiedSpaceHost,
  version,
} from "@mind-diary/domain";
import { validateOkfBundle } from "@mind-diary/okf-codec";

import {
  createBarrier,
  createGate,
  createMutableClock,
  interceptPort,
} from "../helpers/failure-injection.mjs";

const T0 = "2026-08-07T11:00:00.000Z";
const T1 = "2026-08-07T11:01:00.000Z";
const T2 = "2026-08-07T11:02:00.000Z";
const T3 = "2026-08-07T11:03:00.000Z";
const T4 = "2026-08-07T11:04:00.000Z";
const T5 = "2026-08-07T11:05:00.000Z";
const T6 = "2026-08-07T11:06:00.000Z";
const T7 = "2026-08-07T11:07:00.000Z";
const T8 = "2026-08-07T11:08:00.000Z";
const TOKEN_EXPIRY = "2026-11-05T11:00:00.000Z";
const FAR_FUTURE = "9999-12-31T23:59:59.999Z";
const HOST = verifiedSpaceHost("mind-diary.example");
const TOKEN_ID = "token_concurrency_suite";
const DOWNLOAD_KEY = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 41,
);

function preRegistrationActor(index, requestId = `bootstrap_${index}`) {
  return {
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding: `fixture.${index}@example.invalid`,
    suggestedDisplayName: `Fixture Principal ${index}`,
    deploymentCapabilities: CAPABILITIES,
    requestId,
    occurredAtUtc: T0,
  };
}

function sitesActor(principalId, requestId, occurredAtUtc = T1) {
  return {
    kind: "registered_principal",
    principalId,
    authentication: { kind: "sites_identity" },
    deploymentCapabilities: CAPABILITIES,
    requestId,
    occurredAtUtc,
  };
}

function mcpActor(principalId, requestId, occurredAtUtc = T3) {
  return {
    kind: "registered_principal",
    principalId,
    authentication: {
      kind: "mcp_token",
      tokenId: TOKEN_ID,
      effectiveScopes: ["content:read", "content:write"],
    },
    deploymentCapabilities: CAPABILITIES,
    requestId,
    occurredAtUtc,
  };
}

function backgroundActor(occurredAtUtc, capabilities = []) {
  return createBackgroundServiceActor({
    serviceId: "mind-diary-concurrency-suite",
    requestId: `background_${occurredAtUtc}`,
    occurredAtUtc,
    deploymentCapabilities: capabilities,
  });
}

function createHarness() {
  const metadata = new InMemoryRevisionMetadataStore();
  const objects = new InMemoryObjectStore();
  const index = new InMemoryExactRevisionSearchIndex();
  const audit = new InMemoryAuditSink();
  const clock = createMutableClock(T0);
  const revisions = new CanonicalRevisionCoordinator({
    objects,
    revisions: metadata,
  });
  let account = 0;
  let ordinaryMind = 0;
  let ownerMembership = 0;
  let ordinaryRevision = 0;
  let invitation = 0;
  let invitationMembership = 0;
  let invitationJob = 0;
  let auditEvent = 0;
  let auditOutbox = 0;
  let contentRevision = 0;
  let indexJob = 0;
  let exportJob = 0;
  let deletionImpact = 0;

  const nextAuditEventId = () => `audit_stress_${++auditEvent}`;
  const nextOutboxMessageId = () => `outbox_stress_${++auditOutbox}`;
  const bootstrap = new AccountBootstrapService({
    accounts: metadata,
    objects,
    ids: {
      nextPrincipalId: () => `principal_stress_${++account}`,
      nextExternalBindingId: () => `binding_stress_${account}`,
      nextSpaceId: () => `space_personal_stress_${account}`,
      nextMembershipId: () => `membership_personal_stress_${account}`,
      nextRevisionId: () => `revision_personal_stress_${account}`,
      nextPersonalSpaceHandle: () => `personal-stress-${account}`,
    },
  });
  const ordinary = new OrdinaryMindControlService({
    ordinaryMinds: metadata,
    objects,
    host: HOST,
    ids: {
      nextSpaceId: () => `space_stress_${++ordinaryMind}`,
      nextMembershipId: () =>
        `membership_owner_stress_${++ownerMembership}`,
      nextRevisionId: () => `revision_ordinary_stress_${++ordinaryRevision}`,
    },
  });
  const invitations = new InvitationControlService({
    invitations: metadata,
    objects,
    ids: {
      nextInvitationId: () => `invitation_stress_${++invitation}`,
      nextMembershipId: () =>
        `membership_invited_stress_${++invitationMembership}`,
      nextInvitationExpiryJobId: () =>
        `job_invitation_stress_${++invitationJob}`,
    },
  });
  const visibility = new VisibilityControlService({
    ordinaryMinds: metadata,
    objects,
    auditIds: { nextAuditEventId, nextOutboxMessageId },
  });
  const ownership = new OwnershipTransferService({
    ordinaryMinds: metadata,
    objects,
    auditIds: { nextAuditEventId, nextOutboxMessageId },
  });
  const effectIds = {
    nextAuditEventId,
    nextOutboxMessageId,
    nextIndexJobId: () => `index_job_stress_${++indexJob}`,
  };
  const revisionIds = {
    nextRevisionId: () => `revision_content_stress_${++contentRevision}`,
  };
  const jobIds = {
    nextExportJobId: () => `export_job_stress_${++exportJob}`,
  };
  const deletionIds = {
    nextImpactId: () => `impact_stress_${++deletionImpact}`,
  };
  const deletionDependencies = (selectedIndex = index) => ({
    ordinaryMinds: metadata,
    objects,
    index: selectedIndex,
    audit,
    exportArchives: objects,
    ids: deletionIds,
    clock,
    host: HOST,
  });

  return {
    metadata,
    objects,
    index,
    audit,
    clock,
    revisions,
    bootstrap,
    ordinary,
    invitations,
    visibility,
    ownership,
    effectIds,
    revisionIds,
    jobIds,
    deletionDependencies,
  };
}

async function bootstrap(env, index) {
  return env.bootstrap.bootstrapAccount(preRegistrationActor(index), {
    action: "create_isolated_account",
  });
}

async function createMind(env, owner, handle) {
  return env.ordinary.createSpaceWithOwner(
    sitesActor(owner.principalId, `create_${handle}`, T0),
    {
      name: `Mind ${handle}`,
      handle,
      idempotencyKey: `create-${handle}`,
    },
  );
}

async function inspectMind(env, mindId) {
  const state = await env.metadata.inspectOrdinaryMindStateForTest(mindId);
  assert.ok(state);
  return state;
}

function activeOwners(state) {
  return state.memberships.filter(
    (membership) =>
      membership.state === "active" && membership.role === "owner",
  );
}

async function grantMcpAuthorization(env, principalId, spaceId) {
  const current = await env.metadata.readCurrentAuthorizationState({
    principalId,
    spaceId,
    tokenId: null,
  });
  assert.ok(current);
  env.metadata.setCurrentAuthorizationStateForTest(
    { principalId, spaceId, tokenId: TOKEN_ID },
    {
      ...current,
      token: {
        tokenId: TOKEN_ID,
        principalId,
        state: "active",
        scopes: ["content:read", "content:write"],
        version: version(1),
        expiresAt: TOKEN_EXPIRY,
      },
    },
  );
}

function commitService(env, actor, objects = env.objects) {
  return new ChangesetCommitService({
    authorizer: new CapabilityAuthorizer(env.metadata),
    metadata: env.metadata,
    revisions: env.revisions,
    objects,
    clock: env.clock,
    revisionIds: env.revisionIds,
    effectIds: env.effectIds,
  });
}

function conceptText(title) {
  return `---\ntype: Reference\ntitle: ${title}\n---\n\n# ${title}\n`;
}

function changesFor(head, path, title) {
  const index = head.files.find((file) => file.path === "index.md");
  assert.ok(index);
  return [
    { type: "create_file", path, text: conceptText(title) },
    {
      type: "replace_index",
      path: "index.md",
      text: `${index.text.trimEnd()}\n\n- [${title}](${path})\n`,
    },
    {
      type: "add_log_entry",
      path: "log.md",
      category: "Update",
      message: `Added [${title}](${path}).`,
    },
  ];
}

async function objectSnapshot(env) {
  const objects = await env.objects.listImmutableObjects({
    createdBefore: FAR_FUTURE,
    excludedDigests: [],
    limit: 10_000,
  });
  const spaceObjects = await env.objects.listSpaceCanonicalObjects({
    createdBefore: FAR_FUTURE,
    excluded: [],
    limit: 10_000,
  });
  const reachableSpace = await env.metadata.listReachableSpaceCanonicalObjects();
  return {
    all: [
      ...objects.map((object) => `legacy\0${object.sha256}`),
      ...spaceObjects.map((object) =>
        `${object.kind}\0${object.spaceId}\0${object.sha256}`),
    ].sort(),
    reachable: [
      ...(await env.metadata.listReachableObjectDigests()).map(
        (digest) => `legacy\0${digest}`,
      ),
      ...reachableSpace.map((object) =>
        `${object.kind}\0${object.spaceId}\0${object.sha256}`),
    ].sort(),
  };
}

async function createExportApplication(env) {
  const downloadSecretCrypto = await createWebCryptoExportDownloadSecretCrypto({
    verifierKey: DOWNLOAD_KEY,
  });
  const backgroundAuthorizer = new CurrentAccessBackgroundAuthorizer(
    env.metadata,
  );
  return {
    backgroundAuthorizer,
    application: new ExportJobApplicationService({
      authorizer: new CapabilityAuthorizer(env.metadata),
      backgroundAuthorizer,
      metadata: env.metadata,
      digest: env.objects,
      archives: env.objects,
      clock: env.clock,
      jobIds: env.jobIds,
      downloadSecretCrypto,
      downloadUrlBase: "https://downloads.invalid/export-grants",
      capacityLimits: {
        ...DEFAULT_CAPACITY_LIMITS,
        activeHeavyPerMind: 8,
        activeHeavyPerPrincipal: 8,
      },
    }),
  };
}

function startExportRequest(actor, spaceId, key, revisionSelector) {
  return {
    actor,
    spaceId,
    idempotencyKey: key,
    revisionSelector,
  };
}

test(
  "control-plane races and injected rollbacks preserve one Personal Mind, handle, membership and Owner",
  { timeout: 15_000 },
  async () => {
    const env = createHarness();
    const ownerOutcomes = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        env.bootstrap.bootstrapAccount(
          preRegistrationActor(1, `bootstrap_owner_race_${index}`),
          { action: "create_isolated_account" },
        ),
      ),
    );
    assert.equal(new Set(ownerOutcomes.map((item) => item.principalId)).size, 1);
    assert.equal(
      ownerOutcomes.filter((item) => item.replayed === false).length,
      1,
    );
    assert.deepEqual(await env.metadata.inspectAccountBootstrapStateForTest(), {
      principals: 1,
      bindings: 1,
      personalMinds: 1,
      memberships: 1,
      revisions: 1,
    });
    const owner = ownerOutcomes[0];
    const targetA = await bootstrap(env, 2);
    const targetB = await bootstrap(env, 3);

    const totalsBeforeInjectedCreate =
      await env.metadata.inspectOrdinaryMindTotalsForTest();
    env.metadata.failNextOrdinaryMindAtForTest("create_after_handle");
    await assert.rejects(
      env.ordinary.createSpaceWithOwner(
        sitesActor(owner.principalId, "injected_create", T0),
        {
          name: "Injected create",
          handle: "injected-create",
          idempotencyKey: "injected-create",
        },
      ),
      /injected ordinary Mind transaction failure/u,
    );
    assert.deepEqual(
      await env.metadata.inspectOrdinaryMindTotalsForTest(),
      totalsBeforeInjectedCreate,
    );
    assert.deepEqual(
      await env.metadata.resolveHandle({ host: HOST, handle: "injected-create" }),
      { kind: "not_found" },
    );

    const handleOutcomes = await Promise.allSettled(
      Array.from({ length: 16 }, (_, index) =>
        env.ordinary.createSpaceWithOwner(
          sitesActor(owner.principalId, `handle_race_${index}`, T0),
          {
            name: `Handle racer ${index}`,
            handle: "single-handle-winner",
            idempotencyKey: `handle-race-${index}`,
          },
        ),
      ),
    );
    const handleWinners = handleOutcomes.filter(
      (outcome) => outcome.status === "fulfilled",
    );
    const handleLosers = handleOutcomes.filter(
      (outcome) => outcome.status === "rejected",
    );
    assert.equal(handleWinners.length, 1);
    assert.equal(handleLosers.length, 15);
    for (const loser of handleLosers) {
      assert.equal(loser.reason instanceof OrdinaryMindControlFailure, true);
      assert.equal(loser.reason.code, "handle_unavailable");
    }
    const mind = handleWinners[0].value;
    let state = await inspectMind(env, mind.mindId);
    assert.equal(state.memberships.length, 1);
    assert.equal(activeOwners(state).length, 1);

    const invitation = await env.invitations.createInvitation(
      sitesActor(owner.principalId, "invite_target_a", T1),
      {
        mindId: mind.mindId,
        targetVerifiedEmail: "fixture.2@example.invalid",
        role: "editor",
        expectedMetadataVersion: state.space.metadataVersion,
        idempotencyKey: "invite-target-a",
      },
    );
    const beforeInjectedAccept = await inspectMind(env, mind.mindId);
    const acceptCommand = {
      invitationId: invitation.invitationId,
      expectedInvitationVersion: 1,
      idempotencyKey: "accept-target-a",
    };
    env.metadata.failNextOrdinaryMindAtForTest(
      "invitation_lifecycle_after_membership",
    );
    await assert.rejects(
      env.invitations.acceptInvitation(
        sitesActor(targetA.principalId, "injected_accept", T2),
        acceptCommand,
      ),
      /injected ordinary Mind transaction failure/u,
    );
    assert.deepEqual(
      await inspectMind(env, mind.mindId),
      beforeInjectedAccept,
    );
    const accepted = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        env.invitations.acceptInvitation(
          sitesActor(targetA.principalId, `accept_race_${index}`, T2),
          acceptCommand,
        ),
      ),
    );
    assert.equal(accepted.filter((item) => item.replayed === false).length, 1);
    assert.equal(new Set(accepted.map((item) => item.membershipId)).size, 1);
    state = await inspectMind(env, mind.mindId);
    const targetAMembership = state.memberships.find(
      (membership) => membership.principalId === targetA.principalId,
    );
    assert.ok(targetAMembership);
    assert.equal(targetAMembership.role, "editor");

    const targetBMembershipId = "membership_stress_target_b";
    assert.equal(
      await env.metadata.grantOrdinaryMembershipForTest(
        {
          membershipId: targetBMembershipId,
          spaceId: mind.mindId,
          principalId: targetB.principalId,
          role: "admin",
          state: "active",
          version: version(1),
          createdAt: T2,
          createdBy: owner.principalId,
          updatedAt: T2,
          updatedBy: owner.principalId,
        },
        T2,
      ),
      true,
    );

    state = await inspectMind(env, mind.mindId);
    const beforeInjectedVisibility = state;
    const visibilityCommand = {
      mindId: mind.mindId,
      visibility: "public",
      acknowledgeLiveHeadAndHistoryExposure: true,
      expectedMetadataVersion: state.space.metadataVersion,
      idempotencyKey: "injected-visibility",
    };
    env.metadata.failNextOrdinaryMindAtForTest("visibility_after_audit");
    await assert.rejects(
      env.visibility.changeVisibility(
        sitesActor(owner.principalId, "injected_visibility", T2),
        visibilityCommand,
      ),
      /injected ordinary Mind transaction failure/u,
    );
    assert.deepEqual(
      await inspectMind(env, mind.mindId),
      beforeInjectedVisibility,
    );
    const visibilityOutcomes = await Promise.allSettled([
      env.visibility.changeVisibility(
        sitesActor(owner.principalId, "visibility_public", T2),
        { ...visibilityCommand, idempotencyKey: "visibility-public" },
      ),
      env.visibility.changeVisibility(
        sitesActor(owner.principalId, "visibility_unlisted", T2),
        {
          ...visibilityCommand,
          visibility: "unlisted",
          idempotencyKey: "visibility-unlisted",
        },
      ),
    ]);
    const visibilityWinners = visibilityOutcomes.filter(
      (outcome) => outcome.status === "fulfilled",
    );
    const visibilityLosers = visibilityOutcomes.filter(
      (outcome) => outcome.status === "rejected",
    );
    assert.equal(visibilityWinners.length, 1);
    assert.equal(visibilityLosers.length, 1);
    assert.equal(
      visibilityLosers[0].reason instanceof OrdinaryMindControlFailure,
      true,
    );
    assert.equal(visibilityLosers[0].reason.code, "metadata_conflict");
    state = await inspectMind(env, mind.mindId);
    assert.ok(["public", "unlisted"].includes(state.space.visibility));

    const beforeInjectedTransfer = state;
    const transferCommand = {
      mindId: mind.mindId,
      targetMemberId: targetAMembership.membershipId,
      expectedMetadataVersion: state.space.metadataVersion,
      confirmation: "transfer-ownership",
      idempotencyKey: "injected-transfer",
    };
    env.metadata.failNextOrdinaryMindAtForTest("ownership_after_memberships");
    await assert.rejects(
      env.ownership.transferOwnership(
        sitesActor(owner.principalId, "injected_transfer", T2),
        transferCommand,
      ),
      /injected ordinary Mind transaction failure/u,
    );
    assert.deepEqual(
      await inspectMind(env, mind.mindId),
      beforeInjectedTransfer,
    );
    const transferOutcomes = await Promise.allSettled([
      env.ownership.transferOwnership(
        sitesActor(owner.principalId, "transfer_target_a", T2),
        { ...transferCommand, idempotencyKey: "transfer-target-a" },
      ),
      env.ownership.transferOwnership(
        sitesActor(owner.principalId, "transfer_target_b", T2),
        {
          ...transferCommand,
          targetMemberId: targetBMembershipId,
          idempotencyKey: "transfer-target-b",
        },
      ),
    ]);
    const transferWinners = transferOutcomes.filter(
      (outcome) => outcome.status === "fulfilled",
    );
    const transferLosers = transferOutcomes.filter(
      (outcome) => outcome.status === "rejected",
    );
    assert.equal(transferWinners.length, 1);
    assert.equal(transferLosers.length, 1);
    assert.equal(
      transferLosers[0].reason instanceof OwnershipTransferFailure,
      true,
    );
    assert.equal(transferLosers[0].reason.code, "metadata_conflict");
    state = await inspectMind(env, mind.mindId);
    assert.equal(activeOwners(state).length, 1);
    assert.equal(
      state.memberships.find(
        (membership) => membership.principalId === owner.principalId,
      ).role,
      "admin",
    );
    assert.equal((await env.metadata.listAuditEventsForTest()).length, 2);
    assert.equal((await env.metadata.listAuditOutboxForTest()).length, 2);
  },
);

test(
  "content crash, idempotency and HEAD races publish one complete monotonic revision and exact as_of",
  { timeout: 15_000 },
  async () => {
    const env = createHarness();
    const owner = await bootstrap(env, 1);
    const mind = await createMind(env, owner, "content-races");
    await grantMcpAuthorization(env, owner.principalId, mind.mindId);
    const actor = mcpActor(owner.principalId, "commit_crash", T3);
    const initial = await env.revisions.readHeadRevision(mind.mindId);
    assert.ok(initial);
    const crashRequest = {
      actor,
      spaceId: mind.mindId,
      expectedRevisionId: initial.envelope.revision.revisionId,
      idempotencyKey: "object-put-before-head-cas",
      summary: "Crash-safe commit",
      operations: changesFor(
        initial,
        "concepts/crash-safe.md",
        "Crash safe",
      ),
    };
    const beforeCrash = await objectSnapshot(env);
    const revisionsBeforeCrash = await env.metadata.listRevisions(mind.mindId);
    env.clock.set(T3);
    env.metadata.failNextCommitForTest(
      new Error("injected crash between object put and HEAD CAS"),
    );
    await assert.rejects(
      commitService(env, actor).commit(crashRequest),
      /injected crash between object put and HEAD CAS/u,
    );
    const afterCrash = await objectSnapshot(env);
    assert.deepEqual(afterCrash.reachable, beforeCrash.reachable);
    assert.equal(afterCrash.all.length > beforeCrash.all.length, true);
    assert.equal(
      (await env.metadata.listRevisions(mind.mindId)).length,
      revisionsBeforeCrash.length,
    );
    assert.equal(await env.metadata.readHead(mind.mindId), mind.headRevisionId);
    assert.equal((await env.metadata.listIdempotencyRecordsForTest()).length, 0);
    assert.equal((await env.metadata.listAuditEventsForTest()).length, 0);

    const exactResults = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        commitService(
          env,
          mcpActor(owner.principalId, `commit_retry_${index}`, T3),
        ).commit({
          ...crashRequest,
          actor: mcpActor(owner.principalId, `commit_retry_${index}`, T3),
        }),
      ),
    );
    assert.equal(exactResults.every((result) => result.kind === "committed"), true);
    assert.equal(exactResults.filter((result) => result.replayed === false).length, 1);
    assert.equal(
      new Set(
        exactResults.map((result) => result.envelope.revision.revisionId),
      ).size,
      1,
    );
    const committed = exactResults[0];
    assert.equal(committed.envelope.revision.revisionNumber, 2);
    const afterCommitted = await env.revisions.readHeadRevision(mind.mindId);
    assert.ok(afterCommitted);
    assert.equal(
      afterCommitted.files.filter(
        (file) => file.path === "concepts/crash-safe.md",
      ).length,
      1,
    );
    const log = afterCommitted.files.find((file) => file.path === "log.md");
    assert.ok(log);
    assert.equal((log.text.match(/Crash safe/gu) ?? []).length, 1);

    const stateBeforePayloadConflict = await objectSnapshot(env);
    const payloadConflict = await commitService(env, actor).commit({
      ...crashRequest,
      operations: changesFor(
        initial,
        "concepts/different-payload.md",
        "Different payload",
      ),
    });
    assert.deepEqual(payloadConflict, { kind: "idempotency_conflict" });
    assert.deepEqual(await objectSnapshot(env), stateBeforePayloadConflict);

    const raceBase = await env.revisions.readHeadRevision(mind.mindId);
    assert.ok(raceBase);
    const barrier = createBarrier(2);
    const gatedObjects = () => {
      let firstPut = true;
      return interceptPort(env.objects, {
        putSpaceCanonicalObject: async (putSpaceCanonicalObject, request) => {
          if (firstPut) {
            firstPut = false;
            await barrier.arriveAndWait();
          }
          return putSpaceCanonicalObject(request);
        },
      });
    };
    env.clock.set(T4);
    const raceRequests = [
      {
        actor: mcpActor(owner.principalId, "head_race_a", T4),
        spaceId: mind.mindId,
        expectedRevisionId: raceBase.envelope.revision.revisionId,
        idempotencyKey: "head-race-a",
        summary: "HEAD race A",
        operations: changesFor(raceBase, "concepts/race-a.md", "Race A"),
      },
      {
        actor: mcpActor(owner.principalId, "head_race_b", T4),
        spaceId: mind.mindId,
        expectedRevisionId: raceBase.envelope.revision.revisionId,
        idempotencyKey: "head-race-b",
        summary: "HEAD race B",
        operations: changesFor(raceBase, "concepts/race-b.md", "Race B"),
      },
    ];
    const raceResults = await Promise.all(
      raceRequests.map((request) =>
        commitService(env, request.actor, gatedObjects()).commit(request),
      ),
    );
    const raceWinners = raceResults.filter(
      (result) => result.kind === "committed",
    );
    const raceLosers = raceResults.filter(
      (result) => result.kind === "revision_conflict",
    );
    assert.equal(raceWinners.length, 1);
    assert.equal(raceLosers.length, 1);
    assert.equal(
      raceLosers[0].currentRevisionId,
      raceWinners[0].envelope.revision.revisionId,
    );
    const finalHead = await env.revisions.readHeadRevision(mind.mindId);
    assert.ok(finalHead);
    const winnerPath = raceWinners[0].envelope.revision.summary.endsWith("A")
      ? "concepts/race-a.md"
      : "concepts/race-b.md";
    const loserPath =
      winnerPath === "concepts/race-a.md"
        ? "concepts/race-b.md"
        : "concepts/race-a.md";
    assert.equal(finalHead.files.some((file) => file.path === winnerPath), true);
    assert.equal(finalHead.files.some((file) => file.path === loserPath), false);
    const finalIndex = finalHead.files.find((file) => file.path === "index.md");
    assert.ok(finalIndex);
    assert.equal(finalIndex.text.includes(winnerPath), true);
    assert.equal(finalIndex.text.includes(loserPath), false);
    const validation = validateOkfBundle(
      finalHead.files.map((file) => ({ path: file.path, bytes: file.bytes })),
    );
    assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));

    const allRevisions = await env.metadata.listRevisions(mind.mindId);
    assert.deepEqual(
      allRevisions.map((envelope) => envelope.revision.revisionNumber),
      [1, 2, 3],
    );
    assert.deepEqual(
      allRevisions.map((envelope) => envelope.revision.committedAt),
      [T0, T3, T4],
    );
    assert.equal(
      allRevisions.every((envelope) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(
          envelope.revision.committedAt,
        ),
      ),
      true,
    );
    assert.equal(
      allRevisions.every(
        (envelope, index) =>
          index === 0 ||
          Date.parse(envelope.revision.committedAt) >
            Date.parse(allRevisions[index - 1].revision.committedAt),
      ),
      true,
    );

    env.clock.set(T5);
    const exports = await createExportApplication(env);
    const beforeFirst = await exports.application.start(
      startExportRequest(actor, mind.mindId, "as-of-before-first", {
        kind: "as_of",
        asOf: "2026-08-07T10:59:59.999Z",
      }),
    );
    assert.deepEqual(beforeFirst, { kind: "revision_not_found" });
    const atSecond = await exports.application.start(
      startExportRequest(actor, mind.mindId, "as-of-second", {
        kind: "as_of",
        asOf: T3,
      }),
    );
    assert.equal(atSecond.kind, "started");
    assert.equal(
      atSecond.job.revisionId,
      committed.envelope.revision.revisionId,
    );
    const atThird = await exports.application.start(
      startExportRequest(actor, mind.mindId, "as-of-third", {
        kind: "as_of",
        asOf: T4,
      }),
    );
    assert.equal(atThird.kind, "started");
    assert.equal(
      atThird.job.revisionId,
      raceWinners[0].envelope.revision.revisionId,
    );
    assert.deepEqual(
      await exports.application.start(
        startExportRequest(actor, mind.mindId, "as-of-second", {
          kind: "as_of",
          asOf: T4,
        }),
      ),
      { kind: "idempotency_conflict" },
    );
    const objects = await objectSnapshot(env);
    assert.equal(
      objects.all.filter((digest) => !objects.reachable.includes(digest)).length >
        0,
      true,
    );
  },
);

test(
  "local background retries stay exact while deletion races with route and export then resumes idempotently",
  { timeout: 20_000 },
  async () => {
    assert.deepEqual(COMPOSITION_SELECTION.outbound, {
      metadata: "memory-revision-envelope",
      objects: "memory-revision-envelope",
      search: "memory-exact-revision",
      security: "webcrypto-contract-only",
      audit: "memory-idempotent-delivery",
    });
    assert.equal(COMPOSITION_SELECTION.deployableServiceImplemented, true);

    const env = createHarness();
    const owner = await bootstrap(env, 1);
    const mind = await createMind(env, owner, "background-delete-races");
    await grantMcpAuthorization(env, owner.principalId, mind.mindId);
    const actor = mcpActor(owner.principalId, "background_commit", T3);
    const initial = await env.revisions.readHeadRevision(mind.mindId);
    assert.ok(initial);
    env.clock.set(T3);
    const second = await commitService(env, actor).commit({
      actor,
      spaceId: mind.mindId,
      expectedRevisionId: initial.envelope.revision.revisionId,
      idempotencyKey: "background-second",
      summary: "Background second",
      operations: changesFor(
        initial,
        "concepts/background-second.md",
        "Background second",
      ),
    });
    assert.equal(second.kind, "committed");
    const secondHead = await env.revisions.readHeadRevision(mind.mindId);
    assert.ok(secondHead);
    env.clock.set(T4);
    const third = await commitService(env, actor).commit({
      actor: { ...actor, requestId: "background_third", occurredAtUtc: T4 },
      spaceId: mind.mindId,
      expectedRevisionId: secondHead.envelope.revision.revisionId,
      idempotencyKey: "background-third",
      summary: "Background third",
      operations: changesFor(
        secondHead,
        "concepts/background-third.md",
        "Background third",
      ),
    });
    assert.equal(third.kind, "committed");

    const secondIndexJob = (await env.metadata.listBackgroundJobsForTest()).find(
      (job) =>
        job.target.kind === "revision_index" &&
        job.target.revisionId === second.envelope.revision.revisionId,
    );
    assert.ok(secondIndexJob);
    const secondAuditEvent = (await env.metadata.listAuditEventsForTest()).find(
      (event) =>
        event.safeMetadata.revision_id === second.envelope.revision.revisionId,
    );
    assert.ok(secondAuditEvent);
    const secondOutbox = (await env.metadata.listAuditOutboxForTest()).find(
      (message) => message.auditEventId === secondAuditEvent.auditEventId,
    );
    assert.ok(secondOutbox);

    env.clock.set(T5);
    const indexHandler = new RevisionIndexJobHandler({
      work: env.metadata,
      revisions: env.revisions,
      index: env.index,
      clock: env.clock,
      retryDelayMs: 1_000,
    });
    env.index.failNextReplaceForTest(
      new Error("injected exact revision index failure"),
    );
    assert.deepEqual(
      await indexHandler.handle({
        actor: backgroundActor(T5),
        jobId: secondIndexJob.jobId,
      }),
      { kind: "failed", failureCode: "index_rebuild_failed" },
    );
    assert.deepEqual(
      await new ReadyExactRevisionIndexService({
        work: env.metadata,
        index: env.index,
      }).read(mind.mindId, second.envelope.revision.revisionId),
      { kind: "unavailable" },
    );
    env.clock.set("2026-08-07T11:05:02.000Z");
    assert.deepEqual(
      await indexHandler.handle({
        actor: backgroundActor("2026-08-07T11:05:02.000Z"),
        jobId: secondIndexJob.jobId,
      }),
      { kind: "completed" },
    );
    const readySecond = await new ReadyExactRevisionIndexService({
      work: env.metadata,
      index: env.index,
    }).read(mind.mindId, second.envelope.revision.revisionId);
    assert.equal(readySecond.kind, "ready");
    assert.equal(
      readySecond.documents.some(
        (document) => document.path === "concepts/background-second.md",
      ),
      true,
    );
    assert.equal(
      readySecond.documents.some(
        (document) => document.path === "concepts/background-third.md",
      ),
      false,
    );
    assert.deepEqual(
      await env.index.readExactRevision(
        mind.mindId,
        third.envelope.revision.revisionId,
      ),
      { kind: "unavailable" },
    );

    const auditHandler = new AuditOutboxDeliveryHandler({
      work: env.metadata,
      audit: env.audit,
      clock: env.clock,
      retryDelayMs: 1_000,
    });
    env.audit.failNextDeliveryForTest(
      new Error("injected audit delivery failure"),
    );
    assert.deepEqual(
      await auditHandler.handle({
        actor: backgroundActor(env.clock.now()),
        outboxMessageId: secondOutbox.outboxMessageId,
      }),
      { kind: "failed", failureCode: "audit_delivery_failed" },
    );
    env.clock.set("2026-08-07T11:05:04.000Z");
    assert.deepEqual(
      await auditHandler.handle({
        actor: backgroundActor(env.clock.now()),
        outboxMessageId: secondOutbox.outboxMessageId,
      }),
      { kind: "completed" },
    );
    assert.deepEqual(
      await auditHandler.handle({
        actor: backgroundActor(env.clock.now()),
        outboxMessageId: secondOutbox.outboxMessageId,
      }),
      { kind: "already_completed" },
    );
    assert.equal(env.audit.deliveredForTest().length, 1);
    assert.doesNotMatch(
      JSON.stringify(env.audit.deliveredForTest()),
      /example\.invalid|token_concurrency_suite|downloads\.invalid|mdp_v1_/u,
    );

    const exports = await createExportApplication(env);
    const retryJob = await exports.application.start(
      startExportRequest(actor, mind.mindId, "export-retry", {
        kind: "revision",
        revisionId: third.envelope.revision.revisionId,
      }),
    );
    assert.equal(retryJob.kind, "started");
    const builder = new DeterministicOkfExportService({
      materializer: env.revisions,
      digest: env.objects,
    });
    let failBuild = true;
    const transientBuilder = {
      async exportExactRevision(request) {
        if (failBuild) {
          failBuild = false;
          throw new Error("injected export builder failure");
        }
        return builder.exportExactRevision(request);
      },
    };
    const exportWorker = (selectedBuilder = builder) =>
      new ExportJobHandler({
        jobs: env.metadata,
        backgroundAuthorizer: exports.backgroundAuthorizer,
        builder: selectedBuilder,
        archives: env.objects,
        clock: env.clock,
        retryDelayMs: 1_000,
        claimLeaseMs: 10_000,
      });
    assert.deepEqual(
      await exportWorker(transientBuilder).handle({
        actor: backgroundActor(env.clock.now(), ["content:export"]),
        jobId: retryJob.job.jobId,
      }),
      { kind: "failed", failureCode: "export_build_failed" },
    );
    assert.equal((await env.objects.listExportArchivesForTest()).length, 0);

    const thirdHead = await env.revisions.readHeadRevision(mind.mindId);
    assert.ok(thirdHead);
    env.clock.set(T6);
    const fourth = await commitService(env, actor).commit({
      actor: { ...actor, requestId: "background_fourth", occurredAtUtc: T6 },
      spaceId: mind.mindId,
      expectedRevisionId: thirdHead.envelope.revision.revisionId,
      idempotencyKey: "background-fourth",
      summary: "Background fourth",
      operations: changesFor(
        thirdHead,
        "concepts/background-fourth.md",
        "Background fourth",
      ),
    });
    assert.equal(fourth.kind, "committed");
    env.clock.set("2026-08-07T11:06:02.000Z");
    assert.deepEqual(
      await exportWorker().handle({
        actor: backgroundActor(env.clock.now(), ["content:export"]),
        jobId: retryJob.job.jobId,
      }),
      { kind: "completed" },
    );
    const durableRetryJob = await env.metadata.readExportJob(
      retryJob.job.jobId,
    );
    assert.equal(durableRetryJob.revisionId, third.envelope.revision.revisionId);
    assert.equal(durableRetryJob.attempts, 2);
    assert.equal((await env.objects.listExportArchivesForTest()).length, 1);

    const raceJob = await exports.application.start(
      startExportRequest(actor, mind.mindId, "export-delete-race", {
        kind: "head",
      }),
    );
    assert.equal(raceJob.kind, "started");
    assert.equal(raceJob.job.revisionId, fourth.envelope.revision.revisionId);
    const routeGate = createGate();
    const exportGate = createGate();
    const gatedRoutes = interceptPort(env.metadata, {
      readResolvedSpace: async (readResolvedSpace, spaceId) => {
        const snapshot = await readResolvedSpace(spaceId);
        await routeGate.wait();
        return snapshot;
      },
    });
    const routes = new MindRouteService({ routes: gatedRoutes, host: HOST });
    const routeOutcome = routes
      .resolveExactMind(
        sitesActor(owner.principalId, "route_delete_race", T7),
        mind.handle,
      )
      .then(
        (value) => ({ status: "fulfilled", value }),
        (reason) => ({ status: "rejected", reason }),
      );
    const gatedBuilder = {
      async exportExactRevision(request) {
        const built = await builder.exportExactRevision(request);
        await exportGate.wait();
        return built;
      },
    };
    const exportOutcome = exportWorker(gatedBuilder).handle({
      actor: backgroundActor(T7, ["content:export"]),
      jobId: raceJob.job.jobId,
    });
    await Promise.all([routeGate.reached, exportGate.reached]);

    let failIndexPurge = true;
    const failingDeletionIndex = interceptPort(env.index, {
      purgeSpace: async (purgeSpace, spaceId) => {
        if (failIndexPurge) {
          failIndexPurge = false;
          throw new Error("injected deletion index purge failure");
        }
        return purgeSpace(spaceId);
      },
    });
    env.clock.set(T7);
    const deletion = new OrdinaryMindDeletionService(
      env.deletionDependencies(failingDeletionIndex),
    );
    const impact = await deletion.getDeletionImpact(
      sitesActor(owner.principalId, "delete_impact", T7),
      { handle: mind.handle },
    );
    const deleteCommand = {
      handle: mind.handle,
      impactId: impact.impactId,
      confirmation: impact.confirmation,
      idempotencyKey: "delete-race-resumable",
    };
    await assert.rejects(
      deletion.deleteSpace(
        sitesActor(owner.principalId, "delete_first_attempt", T7),
        deleteCommand,
      ),
      (error) =>
        error instanceof OrdinaryMindControlFailure &&
        error.code === "deletion_cleanup_incomplete",
    );
    assert.equal(
      await env.metadata.inspectOrdinaryMindStateForTest(mind.mindId),
      null,
    );
    assert.equal((await env.metadata.inspectDeletionCleanupForTest()).length, 1);
    env.clock.set(T8);
    const reconstructedDeletion = new OrdinaryMindDeletionService(
      env.deletionDependencies(env.index),
    );
    const deleted = await reconstructedDeletion.deleteSpace(
      sitesActor(owner.principalId, "delete_resume", T8),
      deleteCommand,
    );
    assert.equal(deleted.replayed, true);
    assert.deepEqual(await env.metadata.inspectDeletionCleanupForTest(), []);
    assert.equal((await env.metadata.inspectRetiredHandlesForTest()).length, 1);

    routeGate.release();
    exportGate.release();
    const finalRoute = await routeOutcome;
    assert.equal(finalRoute.status, "rejected");
    assert.equal(finalRoute.reason instanceof MindRouteFailure, true);
    assert.equal(finalRoute.reason.code, "mind_not_found");
    assert.deepEqual(await exportOutcome, { kind: "not_available" });
    assert.equal(await env.metadata.readExportJob(raceJob.job.jobId), null);
    assert.equal((await env.objects.listExportArchivesForTest()).length, 0);
    assert.deepEqual(
      await env.index.readExactRevision(
        mind.mindId,
        second.envelope.revision.revisionId,
      ),
      { kind: "unavailable" },
    );
    assert.equal(env.audit.deliveredForTest().length, 0);
    assert.equal(
      (await env.metadata.listBackgroundJobsForTest()).filter((job) =>
        job.target.kind === "revision_index" && job.target.spaceId === mind.mindId).length,
      0,
    );
    assert.equal((await env.metadata.listAuditEventsForTest()).length, 0);
    assert.equal((await env.metadata.listAuditOutboxForTest()).length, 0);
  },
);
