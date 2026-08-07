import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  AccountBootstrapService,
  MindRouteFailure,
  MindRouteService,
  OrdinaryMindControlFailure,
  OrdinaryMindControlService,
  VisibilityControlService,
} from "@mind-diary/application-control";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";
import { CAPABILITIES, verifiedSpaceHost, version } from "@mind-diary/domain";

const CREATED_AT = "2026-08-07T05:00:00.000Z";
const CHANGED_AT = "2026-08-07T05:01:00.000Z";
const LATER_AT = "2026-08-07T05:02:00.000Z";
const FINAL_AT = "2026-08-07T05:03:00.000Z";
const HOST = verifiedSpaceHost("mind-diary.example");

function preRegistrationActor(index, displayName = `Principal ${index}`) {
  return {
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding: `private.visibility.${index}@example.com`,
    suggestedDisplayName: displayName,
    deploymentCapabilities: CAPABILITIES,
    requestId: `request_visibility_bootstrap_${index}`,
    occurredAtUtc: CREATED_AT,
  };
}

function registeredActor(
  principalId,
  requestId = "request_visibility",
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
    nextPrincipalId: () => `principal_visibility_${++account}`,
    nextExternalBindingId: () => `binding_visibility_${account}`,
    nextSpaceId: () => `space_personal_visibility_${account}`,
    nextMembershipId: () => `membership_personal_visibility_${account}`,
    nextRevisionId: () => `revision_personal_visibility_${account}`,
    nextPersonalSpaceHandle: () => `personal-service-visibility-${account}`,
  };
}

function ordinaryIds() {
  let spaces = 0;
  let memberships = 0;
  let revisions = 0;
  return {
    nextSpaceId: () => `space_visibility_${++spaces}`,
    nextMembershipId: () => `membership_visibility_owner_${++memberships}`,
    nextRevisionId: () => `revision_visibility_${++revisions}`,
  };
}

function uniqueAuditIds() {
  let events = 0;
  let outbox = 0;
  return {
    nextAuditEventId: () => `audit_visibility_${++events}`,
    nextOutboxMessageId: () => `outbox_visibility_${++outbox}`,
  };
}

function harness({ auditIds = uniqueAuditIds() } = {}) {
  const metadata = new InMemoryRevisionMetadataStore();
  const objects = new InMemoryObjectStore();
  const safeEvents = [];
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
    auditIds,
    logger: { record: (event) => safeEvents.push(event) },
  });
  const routes = new MindRouteService({ routes: metadata, host: HOST });
  return { metadata, objects, safeEvents, bootstrap, ordinary, visibility, routes };
}

async function createAccount(env, index, displayName = `Principal ${index}`) {
  return env.bootstrap.bootstrapAccount(
    preRegistrationActor(index, displayName),
    { action: "create_isolated_account" },
  );
}

async function createMind(env, owner, handle = "visibility-mind") {
  return env.ordinary.createSpaceWithOwner(
    registeredActor(owner.principalId, `request_create_${handle}`, CREATED_AT),
    {
      name: "Visibility Mind",
      handle,
      idempotencyKey: `create-${handle}`,
    },
  );
}

async function state(env, mindId) {
  const current = await env.metadata.inspectOrdinaryMindStateForTest(mindId);
  assert.ok(current);
  return current;
}

async function grantMembership(env, mindId, ownerId, principalId, role, suffix) {
  assert.equal(
    await env.metadata.grantOrdinaryMembershipForTest(
      {
        membershipId: `membership_visibility_${suffix}`,
        spaceId: mindId,
        principalId,
        role,
        state: "active",
        version: version(1),
        createdAt: CHANGED_AT,
        createdBy: ownerId,
        updatedAt: CHANGED_AT,
        updatedBy: ownerId,
      },
      CHANGED_AT,
    ),
    true,
  );
}

function expectControlFailure(code) {
  return (error) => {
    assert.equal(error instanceof OrdinaryMindControlFailure, true);
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

async function authorize(
  metadata,
  actor,
  spaceId,
  capability,
  revisionMode = "head",
) {
  return new CapabilityAuthorizer(metadata).authorize({
    actor,
    spaceId,
    capability,
    revisionMode,
  });
}

test("visibility transition changes only policy epochs, grants baseline reads, and private revokes immediately", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Owner Profile");
  const outsider = await createAccount(env, 2, "Outside Reader");
  const mind = await createMind(env, owner, "grant-boundary");
  const ownerActor = registeredActor(
    owner.principalId,
    "request_visibility_public",
    CHANGED_AT,
  );
  const outsiderActor = registeredActor(
    outsider.principalId,
    "request_visibility_outsider",
    CHANGED_AT,
  );
  const before = await state(env, mind.mindId);

  await assert.rejects(
    env.visibility.changeVisibility(ownerActor, {
      mindId: mind.mindId,
      visibility: "public",
      expectedMetadataVersion: before.space.metadataVersion,
      idempotencyKey: "public-without-ack",
    }),
    expectControlFailure("exposure_acknowledgement_required"),
  );
  assert.deepEqual(await state(env, mind.mindId), before);
  assert.equal((await env.metadata.listAuditEventsForTest()).length, 0);

  const opened = await env.visibility.changeVisibility(ownerActor, {
    mindId: mind.mindId,
    visibility: "public",
    acknowledgeLiveHeadAndHistoryExposure: true,
    expectedMetadataVersion: before.space.metadataVersion,
    idempotencyKey: "open-public",
  });
  const afterOpen = await state(env, mind.mindId);
  assert.deepEqual(opened, {
    mindId: mind.mindId,
    route: "/grant-boundary",
    handle: "grant-boundary",
    name: before.space.name,
    visibility: "public",
    metadataVersion: before.space.metadataVersion + 1,
    accessVersion: before.space.accessVersion + 1,
    headRevisionId: before.space.headRevisionId,
    changed: true,
    replayed: false,
  });
  assert.equal(afterOpen.space.visibility, "public");
  assert.equal(afterOpen.space.metadataVersion, before.space.metadataVersion + 1);
  assert.equal(afterOpen.space.accessVersion, before.space.accessVersion + 1);
  assert.equal(afterOpen.space.updatedAt, CHANGED_AT);
  assert.equal(afterOpen.space.spaceId, before.space.spaceId);
  assert.equal(afterOpen.space.spaceHandle, before.space.spaceHandle);
  assert.equal(afterOpen.space.normalizedHandle, before.space.normalizedHandle);
  assert.equal(afterOpen.space.name, before.space.name);
  assert.equal(afterOpen.space.headRevisionId, before.space.headRevisionId);
  assert.deepEqual(afterOpen.memberships, before.memberships);
  assert.deepEqual(afterOpen.revisions, before.revisions);
  assert.deepEqual(afterOpen.reservation, before.reservation);

  for (const capability of [
    "content:browse",
    "content:search",
    "content:fetch",
    "content:history",
    "content:validate",
    "content:export",
  ]) {
    const decision = await authorize(
      env.metadata,
      outsiderActor,
      mind.mindId,
      capability,
    );
    assert.equal(decision.kind, "allowed");
    assert.deepEqual(decision.grant, {
      kind: "baseline_visibility",
      visibility: "public",
    });
  }
  for (const capability of [
    "content:write",
    "members:manage-basic",
    "settings:configure",
    "visibility:change",
    "ownership:transfer",
  ]) {
    assert.equal(
      (await authorize(env.metadata, outsiderActor, mind.mindId, capability)).kind,
      "denied",
    );
  }
  const exact = await env.routes.resolveExactMind(outsiderActor, "grant-boundary");
  assert.equal(exact.access.kind, "visibility");
  assert.equal(exact.access.role, null);
  assert.equal(exact.discovery, "exact_handle");
  assert.equal(exact.access.capabilities.includes("content:write"), false);
  assert.deepEqual(
    (await env.routes.listMinds(outsiderActor)).map((descriptor) => descriptor.route),
    ["/me"],
  );
  assert.equal((await state(env, mind.mindId)).memberships.length, 1);

  const closed = await env.visibility.changeVisibility(
    registeredActor(owner.principalId, "request_visibility_private", LATER_AT),
    {
      mindId: mind.mindId,
      visibility: "private",
      expectedMetadataVersion: afterOpen.space.metadataVersion,
      idempotencyKey: "close-private",
    },
  );
  assert.equal(closed.visibility, "private");
  assert.equal(closed.accessVersion, afterOpen.space.accessVersion + 1);
  assert.equal(
    (await authorize(env.metadata, outsiderActor, mind.mindId, "content:fetch"))
      .kind,
    "denied",
  );
  assert.equal(
    (await authorize(env.metadata, outsiderActor, mind.mindId, "content:history"))
      .kind,
    "denied",
  );
  await assert.rejects(
    env.routes.resolveExactMind(outsiderActor, "grant-boundary"),
    expectRouteFailure("mind_not_found"),
  );

  const audits = await env.metadata.listAuditEventsForTest();
  const outbox = await env.metadata.listAuditOutboxForTest();
  assert.equal(audits.length, 2);
  assert.equal(outbox.length, 2);
  assert.deepEqual(audits[0].safeMetadata, {
    access_version: 2,
    from_visibility: "private",
    metadata_version: 2,
    to_visibility: "public",
  });
  assert.deepEqual(audits[1].safeMetadata, {
    access_version: 3,
    from_visibility: "public",
    metadata_version: 3,
    to_visibility: "private",
  });
  for (const audit of audits) {
    assert.equal(audit.eventType, "space.visibility_changed");
    assert.equal(audit.outcome, "succeeded");
    assert.equal(audit.spaceId, mind.mindId);
    assert.deepEqual(Object.keys(audit.safeMetadata).sort(), [
      "access_version",
      "from_visibility",
      "metadata_version",
      "to_visibility",
    ]);
  }
});

test("real unlisted transition grants exact-route historical reads while anonymous stays denied in open modes", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Unlisted Owner");
  const outsider = await createAccount(env, 2, "Exact Route Reader");
  const mind = await createMind(env, owner, "unlisted-history");
  const opened = await env.visibility.changeVisibility(
    registeredActor(owner.principalId, "request_unlisted_history"),
    {
      mindId: mind.mindId,
      visibility: "unlisted",
      acknowledgeLiveHeadAndHistoryExposure: true,
      expectedMetadataVersion: 1,
      idempotencyKey: "open-unlisted-history",
    },
  );
  const outsiderActor = registeredActor(
    outsider.principalId,
    "request_unlisted_history_reader",
  );
  for (const capability of ["content:fetch", "content:history"]) {
    const decision = await authorize(
      env.metadata,
      outsiderActor,
      mind.mindId,
      capability,
      "historical",
    );
    assert.equal(decision.kind, "allowed");
    assert.deepEqual(decision.grant, {
      kind: "baseline_visibility",
      visibility: "unlisted",
    });
  }
  const exact = await env.routes.resolveExactMind(
    outsiderActor,
    "unlisted-history",
  );
  assert.equal(exact.visibility, "unlisted");
  assert.equal(exact.access.kind, "visibility");
  assert.deepEqual(
    (await env.routes.listMinds(outsiderActor)).map((descriptor) => descriptor.route),
    ["/me"],
  );

  const anonymous = {
    kind: "anonymous",
    authentication: { kind: "none" },
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_anonymous_open_mind",
    occurredAtUtc: CHANGED_AT,
  };
  assert.equal(
    (await authorize(env.metadata, anonymous, mind.mindId, "content:fetch"))
      .kind,
    "denied",
  );
  await assert.rejects(
    env.routes.resolveExactMind(anonymous, "unlisted-history"),
    expectRouteFailure("authentication_required"),
  );

  await env.visibility.changeVisibility(
    registeredActor(owner.principalId, "request_unlisted_to_public", LATER_AT),
    {
      mindId: mind.mindId,
      visibility: "public",
      expectedMetadataVersion: opened.metadataVersion,
      idempotencyKey: "unlisted-to-public-anonymous-check",
    },
  );
  assert.equal(
    (await authorize(env.metadata, anonymous, mind.mindId, "content:history", "historical"))
      .kind,
    "denied",
  );
  await assert.rejects(
    env.routes.resolveExactMind(anonymous, "unlisted-history"),
    expectRouteFailure("authentication_required"),
  );
});

test("only the current active ordinary Owner may mutate visibility", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Owner");
  const admin = await createAccount(env, 2, "Admin");
  const editor = await createAccount(env, 3, "Editor");
  const reader = await createAccount(env, 4, "Reader");
  const stranger = await createAccount(env, 5, "Stranger");
  const mind = await createMind(env, owner, "owner-only");
  await grantMembership(env, mind.mindId, owner.principalId, admin.principalId, "admin", "admin");
  await grantMembership(env, mind.mindId, owner.principalId, editor.principalId, "editor", "editor");
  await grantMembership(env, mind.mindId, owner.principalId, reader.principalId, "reader", "reader");
  const before = await state(env, mind.mindId);
  const command = {
    mindId: mind.mindId,
    visibility: "public",
    acknowledgeLiveHeadAndHistoryExposure: true,
    expectedMetadataVersion: before.space.metadataVersion,
  };

  for (const [principal, role] of [
    [admin, "admin"],
    [editor, "editor"],
    [reader, "reader"],
  ]) {
    await assert.rejects(
      env.visibility.changeVisibility(
        registeredActor(principal.principalId, `request_denied_${role}`),
        { ...command, idempotencyKey: `denied-${role}` },
      ),
      expectControlFailure("forbidden"),
    );
  }
  await assert.rejects(
    env.visibility.changeVisibility(
      {
        ...registeredActor(stranger.principalId, "request_forged_role"),
        role: "owner",
      },
      { ...command, idempotencyKey: "forged-role" },
    ),
    expectControlFailure("mind_not_found"),
  );
  await assert.rejects(
    env.visibility.changeVisibility(
      {
        ...registeredActor(owner.principalId, "request_mcp_denied"),
        authentication: {
          kind: "mcp_token",
          tokenId: "token_visibility_denied",
          effectiveScopes: ["content:read", "content:write"],
        },
      },
      { ...command, idempotencyKey: "mcp-denied" },
    ),
    expectControlFailure("authentication_required"),
  );
  await assert.rejects(
    env.visibility.changeVisibility(
      {
        kind: "service",
        serviceId: "visibility-service",
        authentication: { kind: "internal_service", purpose: "audit" },
        deploymentCapabilities: CAPABILITIES,
        requestId: "request_service_denied",
        occurredAtUtc: CHANGED_AT,
      },
      { ...command, idempotencyKey: "service-denied" },
    ),
    expectControlFailure("authentication_required"),
  );
  await assert.rejects(
    env.visibility.changeVisibility(
      registeredActor(owner.principalId, "request_personal_denied"),
      {
        mindId: owner.personalMind.mindId,
        visibility: "public",
        acknowledgeLiveHeadAndHistoryExposure: true,
        expectedMetadataVersion: 1,
        idempotencyKey: "personal-denied",
      },
    ),
    expectControlFailure("personal_mind_operation_forbidden"),
  );
  await assert.rejects(
    env.visibility.changeVisibility(
      registeredActor(owner.principalId, "request_invalid_visibility"),
      { ...command, visibility: "secret", idempotencyKey: "invalid-visibility" },
    ),
    expectControlFailure("invalid_visibility"),
  );
  await assert.rejects(
    env.visibility.changeVisibility(
      registeredActor(owner.principalId, "request_invalid_ack"),
      {
        ...command,
        acknowledgeLiveHeadAndHistoryExposure: "yes",
        idempotencyKey: "invalid-ack",
      },
    ),
    expectControlFailure("invalid_exposure_acknowledgement"),
  );
  assert.deepEqual(await state(env, mind.mindId), before);
  assert.equal((await env.metadata.listAuditEventsForTest()).length, 0);
  assert.equal((await env.metadata.listAuditOutboxForTest()).length, 0);
});

test("no-op, exact replay, payload conflict and later-state replay preserve command idempotency", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const mind = await createMind(env, owner, "idempotent-visibility");
  const actor = registeredActor(owner.principalId, "request_visibility_idempotency");
  const initial = await state(env, mind.mindId);
  const noopCommand = {
    mindId: mind.mindId,
    visibility: "private",
    expectedMetadataVersion: initial.space.metadataVersion,
    idempotencyKey: "private-noop",
  };
  const noop = await env.visibility.changeVisibility(actor, noopCommand);
  const noopRetry = await env.visibility.changeVisibility(actor, noopCommand);
  assert.equal(noop.changed, false);
  assert.equal(noop.replayed, false);
  assert.equal(noopRetry.changed, false);
  assert.equal(noopRetry.replayed, true);
  assert.deepEqual(await state(env, mind.mindId), initial);
  assert.equal((await env.metadata.listAuditEventsForTest()).length, 0);
  await assert.rejects(
    env.visibility.changeVisibility(actor, {
      ...noopCommand,
      visibility: "public",
      acknowledgeLiveHeadAndHistoryExposure: true,
    }),
    expectControlFailure("idempotency_conflict"),
  );

  const openCommand = {
    mindId: mind.mindId,
    visibility: "unlisted",
    acknowledgeLiveHeadAndHistoryExposure: true,
    expectedMetadataVersion: initial.space.metadataVersion,
    idempotencyKey: "open-unlisted",
  };
  const opened = await env.visibility.changeVisibility(actor, openCommand);
  const openedRetry = await env.visibility.changeVisibility(actor, openCommand);
  assert.equal(opened.changed, true);
  assert.equal(opened.replayed, false);
  assert.equal(openedRetry.replayed, true);
  assert.deepEqual({ ...openedRetry, replayed: false }, opened);
  assert.equal((await env.metadata.listAuditEventsForTest()).length, 1);

  const publicResult = await env.visibility.changeVisibility(
    registeredActor(owner.principalId, "request_visibility_public_later", LATER_AT),
    {
      mindId: mind.mindId,
      visibility: "public",
      expectedMetadataVersion: opened.metadataVersion,
      idempotencyKey: "unlisted-to-public",
    },
  );
  assert.equal(publicResult.visibility, "public");
  assert.equal((await env.metadata.listAuditEventsForTest()).length, 2);

  const priorResultReplay = await env.visibility.changeVisibility(
    registeredActor(owner.principalId, "request_visibility_prior_replay", FINAL_AT),
    openCommand,
  );
  assert.equal(priorResultReplay.replayed, true);
  assert.equal(priorResultReplay.visibility, "unlisted");
  assert.equal((await state(env, mind.mindId)).space.visibility, "public");
  assert.equal((await env.metadata.listAuditEventsForTest()).length, 2);

  const publicNoop = await env.visibility.changeVisibility(
    registeredActor(owner.principalId, "request_visibility_public_noop", FINAL_AT),
    {
      mindId: mind.mindId,
      visibility: "public",
      expectedMetadataVersion: publicResult.metadataVersion,
      idempotencyKey: "public-noop",
    },
  );
  assert.equal(publicNoop.changed, false);
  assert.equal(publicNoop.metadataVersion, publicResult.metadataVersion);
  assert.equal(publicNoop.accessVersion, publicResult.accessVersion);
  assert.equal((await env.metadata.listAuditEventsForTest()).length, 2);

  const beforeStale = await state(env, mind.mindId);
  await assert.rejects(
    env.visibility.changeVisibility(actor, {
      mindId: mind.mindId,
      visibility: "private",
      expectedMetadataVersion: publicResult.metadataVersion - 1,
      idempotencyKey: "stale-visibility",
    }),
    expectControlFailure("metadata_conflict"),
  );
  assert.deepEqual(await state(env, mind.mindId), beforeStale);
});

test("concurrent same-key retry has one effect and concurrent writers have one CAS winner", async () => {
  const exact = harness();
  const exactOwner = await createAccount(exact, 1);
  const exactMind = await createMind(exact, exactOwner, "same-key-race");
  const exactActor = registeredActor(
    exactOwner.principalId,
    "request_visibility_same_key_race",
  );
  const exactCommand = {
    mindId: exactMind.mindId,
    visibility: "public",
    acknowledgeLiveHeadAndHistoryExposure: true,
    expectedMetadataVersion: 1,
    idempotencyKey: "same-key-race",
  };
  const exactResults = await Promise.all(
    Array.from({ length: 24 }, () =>
      exact.visibility.changeVisibility(exactActor, exactCommand),
    ),
  );
  assert.equal(exactResults.filter((result) => !result.replayed).length, 1);
  assert.equal(exactResults.filter((result) => result.replayed).length, 23);
  assert.equal(new Set(exactResults.map((result) => result.metadataVersion)).size, 1);
  assert.equal((await state(exact, exactMind.mindId)).space.metadataVersion, 2);
  assert.equal((await exact.metadata.listAuditEventsForTest()).length, 1);
  assert.equal((await exact.metadata.listAuditOutboxForTest()).length, 1);

  const writers = harness();
  const writersOwner = await createAccount(writers, 1);
  const writersMind = await createMind(writers, writersOwner, "different-key-race");
  const outcomes = await Promise.allSettled(
    Array.from({ length: 24 }, (_, index) =>
      writers.visibility.changeVisibility(
        registeredActor(
          writersOwner.principalId,
          `request_visibility_writer_${index}`,
        ),
        {
          mindId: writersMind.mindId,
          visibility: index % 2 === 0 ? "public" : "unlisted",
          acknowledgeLiveHeadAndHistoryExposure: true,
          expectedMetadataVersion: 1,
          idempotencyKey: `writer-${index}`,
        },
      ),
    ),
  );
  const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
  const losers = outcomes.filter((outcome) => outcome.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 23);
  for (const loser of losers) {
    assert.equal(loser.reason instanceof OrdinaryMindControlFailure, true);
    assert.equal(loser.reason.code, "metadata_conflict");
  }
  const final = await state(writers, writersMind.mindId);
  assert.equal(final.space.visibility, winners[0].value.visibility);
  assert.equal(final.space.metadataVersion, 2);
  assert.equal(final.space.accessVersion, 2);
  assert.equal((await writers.metadata.listAuditEventsForTest()).length, 1);
});

test("exact replay rechecks current Owner, principal and target lifecycle before prior-result lookup", async () => {
  const transferred = harness();
  const oldOwner = await createAccount(transferred, 1, "Old Owner");
  const newOwner = await createAccount(transferred, 2, "New Owner");
  const transferredMind = await createMind(transferred, oldOwner, "transferred-mind");
  await grantMembership(
    transferred,
    transferredMind.mindId,
    oldOwner.principalId,
    newOwner.principalId,
    "admin",
    "new-owner",
  );
  const beforeOpen = await state(transferred, transferredMind.mindId);
  const transferReplayCommand = {
    mindId: transferredMind.mindId,
    visibility: "public",
    acknowledgeLiveHeadAndHistoryExposure: true,
    expectedMetadataVersion: beforeOpen.space.metadataVersion,
    idempotencyKey: "before-transfer-replay",
  };
  await transferred.visibility.changeVisibility(
    registeredActor(oldOwner.principalId, "request_before_transfer"),
    transferReplayCommand,
  );
  assert.equal(
    await transferred.metadata.transferOrdinaryOwnershipForTest(
      transferredMind.mindId,
      oldOwner.principalId,
      newOwner.principalId,
      LATER_AT,
    ),
    true,
  );
  const afterTransfer = await state(transferred, transferredMind.mindId);
  await assert.rejects(
    transferred.visibility.changeVisibility(
      registeredActor(oldOwner.principalId, "request_replay_after_transfer", FINAL_AT),
      transferReplayCommand,
    ),
    expectControlFailure("forbidden"),
  );
  assert.deepEqual(await state(transferred, transferredMind.mindId), afterTransfer);
  assert.equal((await transferred.metadata.listAuditEventsForTest()).length, 1);

  const deleting = harness();
  const deletingOwner = await createAccount(deleting, 1);
  const deletingMind = await createMind(deleting, deletingOwner, "deleting-visibility");
  const deletingCommand = {
    mindId: deletingMind.mindId,
    visibility: "public",
    acknowledgeLiveHeadAndHistoryExposure: true,
    expectedMetadataVersion: 1,
    idempotencyKey: "before-delete-replay",
  };
  await deleting.visibility.changeVisibility(
    registeredActor(deletingOwner.principalId, "request_before_delete"),
    deletingCommand,
  );
  assert.equal(
    await deleting.metadata.markOrdinaryMindDeletingForTest(
      deletingMind.mindId,
      LATER_AT,
    ),
    true,
  );
  const afterDeleting = await state(deleting, deletingMind.mindId);
  await assert.rejects(
    deleting.visibility.changeVisibility(
      registeredActor(deletingOwner.principalId, "request_replay_after_delete", FINAL_AT),
      deletingCommand,
    ),
    expectControlFailure("mind_not_found"),
  );
  assert.deepEqual(await state(deleting, deletingMind.mindId), afterDeleting);
  assert.equal((await deleting.metadata.listAuditEventsForTest()).length, 1);

  const disabled = harness();
  const disabledOwner = await createAccount(disabled, 1);
  const disabledMind = await createMind(disabled, disabledOwner, "disabled-owner");
  const disabledCommand = {
    mindId: disabledMind.mindId,
    visibility: "public",
    acknowledgeLiveHeadAndHistoryExposure: true,
    expectedMetadataVersion: 1,
    idempotencyKey: "before-disable-replay",
  };
  await disabled.visibility.changeVisibility(
    registeredActor(disabledOwner.principalId, "request_before_disable"),
    disabledCommand,
  );
  assert.equal(
    await disabled.metadata.disablePrincipalForTest(
      disabledOwner.principalId,
      LATER_AT,
    ),
    true,
  );
  const afterDisable = await state(disabled, disabledMind.mindId);
  await assert.rejects(
    disabled.visibility.changeVisibility(
      registeredActor(disabledOwner.principalId, "request_replay_after_disable", FINAL_AT),
      disabledCommand,
    ),
    expectControlFailure("mind_not_found"),
  );
  assert.deepEqual(await state(disabled, disabledMind.mindId), afterDisable);
  assert.equal((await disabled.metadata.listAuditEventsForTest()).length, 1);
});

test("visibility failures and audit collisions roll back state, idempotency and outbox", async () => {
  for (const stage of [
    "visibility_after_space",
    "visibility_after_audit",
    "visibility_after_idempotency",
    "visibility_before_commit",
  ]) {
    const env = harness();
    const owner = await createAccount(env, 1);
    const mind = await createMind(env, owner, `rollback-${stage.replaceAll("_", "-")}`);
    const before = await state(env, mind.mindId);
    const totalsBefore = await env.metadata.inspectOrdinaryMindTotalsForTest();
    const command = {
      mindId: mind.mindId,
      visibility: "public",
      acknowledgeLiveHeadAndHistoryExposure: true,
      expectedMetadataVersion: before.space.metadataVersion,
      idempotencyKey: `rollback-${stage}`,
    };
    env.metadata.failNextOrdinaryMindAtForTest(stage);
    await assert.rejects(
      env.visibility.changeVisibility(
        registeredActor(owner.principalId, `request_${stage}`),
        command,
      ),
      /injected ordinary Mind transaction failure/u,
    );
    assert.deepEqual(await state(env, mind.mindId), before);
    assert.deepEqual(
      await env.metadata.inspectOrdinaryMindTotalsForTest(),
      totalsBefore,
    );
    assert.equal((await env.metadata.listAuditEventsForTest()).length, 0);
    assert.equal((await env.metadata.listAuditOutboxForTest()).length, 0);

    const recovered = await env.visibility.changeVisibility(
      registeredActor(owner.principalId, `request_recovered_${stage}`, LATER_AT),
      command,
    );
    assert.equal(recovered.changed, true);
    assert.equal(recovered.replayed, false);
    assert.equal((await env.metadata.listAuditEventsForTest()).length, 1);
    assert.equal((await env.metadata.listAuditOutboxForTest()).length, 1);
  }

  const fixedIds = {
    nextAuditEventId: () => "audit_visibility_fixed",
    nextOutboxMessageId: () => "outbox_visibility_fixed",
  };
  const collision = harness({ auditIds: fixedIds });
  const owner = await createAccount(collision, 1, "Private Audit Owner");
  const mind = await createMind(collision, owner, "audit-collision");
  const first = await collision.visibility.changeVisibility(
    registeredActor(owner.principalId, "request_audit_first"),
    {
      mindId: mind.mindId,
      visibility: "public",
      acknowledgeLiveHeadAndHistoryExposure: true,
      expectedMetadataVersion: 1,
      idempotencyKey: "audit-first",
    },
  );
  const beforeCollision = await state(collision, mind.mindId);
  await assert.rejects(
    collision.visibility.changeVisibility(
      registeredActor(owner.principalId, "request_audit_collision", LATER_AT),
      {
        mindId: mind.mindId,
        visibility: "private",
        expectedMetadataVersion: first.metadataVersion,
        idempotencyKey: "audit-second",
      },
    ),
    expectControlFailure("visibility_effect_conflict"),
  );
  assert.deepEqual(await state(collision, mind.mindId), beforeCollision);
  assert.equal((await collision.metadata.listAuditEventsForTest()).length, 1);
  assert.equal((await collision.metadata.listAuditOutboxForTest()).length, 1);

  const account = await collision.metadata.readAccount(owner.principalId);
  assert.ok(account);
  const serialized = JSON.stringify({
    result: first,
    audit: await collision.metadata.listAuditEventsForTest(),
    outbox: await collision.metadata.listAuditOutboxForTest(),
    logs: collision.safeEvents,
  });
  assert.equal(serialized.includes(account.personalMind.space.spaceHandle), false);
  assert.equal(serialized.includes("private.visibility.1@example.com"), false);
  assert.equal(serialized.includes("# Mind"), false);
  assert.equal(serialized.includes("token_visibility_denied"), false);
  assert.equal(serialized.includes("https://"), false);
});
