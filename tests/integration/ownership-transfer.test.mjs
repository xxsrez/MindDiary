import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import { DEFAULT_CAPACITY_LIMITS } from "@mind-diary/application-content";
import {
  AccountBootstrapService,
  InvitationControlService,
  MembershipControlService,
  OrdinaryMindControlService,
  OwnershipTransferFailure,
  OwnershipTransferService,
} from "@mind-diary/application-control";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";
import { CAPABILITIES, verifiedSpaceHost, version } from "@mind-diary/domain";

const CREATED_AT = "2026-08-07T08:00:00.000Z";
const INVITED_AT = "2026-08-07T08:05:00.000Z";
const ACCEPTED_AT = "2026-08-07T08:10:00.000Z";
const TRANSFERRED_AT = "2026-08-07T08:15:00.000Z";
const LATER_AT = "2026-08-07T08:20:00.000Z";
const HOST = verifiedSpaceHost("mind-diary.example");

function preRegistrationActor(index, displayName = `Principal ${index}`) {
  return {
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding: `private.ownership.${index}@example.com`,
    suggestedDisplayName: displayName,
    deploymentCapabilities: CAPABILITIES,
    requestId: `request_ownership_bootstrap_${index}`,
    occurredAtUtc: CREATED_AT,
  };
}

function actor(
  principalId,
  requestId = `request_ownership_${principalId}`,
  occurredAtUtc = TRANSFERRED_AT,
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

function harness({ auditIds, capacityLimits } = {}) {
  const metadata = new InMemoryRevisionMetadataStore();
  const objects = new InMemoryObjectStore();
  const safeEvents = [];
  let account = 0;
  let ordinaryMind = 0;
  let ownerMembership = 0;
  let revision = 0;
  let invitation = 0;
  let targetMembership = 0;
  let expiryJob = 0;
  let auditEvent = 0;
  let auditOutbox = 0;
  const bootstrap = new AccountBootstrapService({
    accounts: metadata,
    objects,
    ids: {
      nextPrincipalId: () => `principal_ownership_${++account}`,
      nextExternalBindingId: () => `binding_ownership_${account}`,
      nextSpaceId: () => `space_personal_ownership_${account}`,
      nextMembershipId: () => `membership_personal_ownership_${account}`,
      nextRevisionId: () => `revision_personal_ownership_${account}`,
      nextPersonalSpaceHandle: () => `personal-service-ownership-${account}`,
    },
  });
  const ordinary = new OrdinaryMindControlService({
    ordinaryMinds: metadata,
    objects,
    host: HOST,
    ids: {
      nextSpaceId: () => `space_ownership_${++ordinaryMind}`,
      nextMembershipId: () =>
        `membership_ownership_owner_${++ownerMembership}`,
      nextRevisionId: () => `revision_ownership_${++revision}`,
    },
  });
  const invitations = new InvitationControlService({
    invitations: metadata,
    objects,
    ids: {
      nextInvitationId: () => `invitation_ownership_${++invitation}`,
      nextMembershipId: () =>
        `membership_ownership_target_${++targetMembership}`,
      nextInvitationExpiryJobId: () =>
        `job_ownership_invitation_${++expiryJob}`,
    },
  });
  const ownership = new OwnershipTransferService({
    ordinaryMinds: metadata,
    objects,
    auditIds: auditIds ?? {
      nextAuditEventId: () => `audit_ownership_${++auditEvent}`,
      nextOutboxMessageId: () => `outbox_ownership_${++auditOutbox}`,
    },
    logger: { record: (event) => safeEvents.push(event) },
    capacityLimits: capacityLimits ?? DEFAULT_CAPACITY_LIMITS,
  });
  const memberships = new MembershipControlService({
    memberships: metadata,
    digest: objects,
    auditIds: {
      nextAuditEventId: () => `audit_membership_ownership_${++auditEvent}`,
      nextOutboxMessageId: () => `outbox_membership_ownership_${++auditOutbox}`,
    },
  });
  return {
    metadata,
    objects,
    safeEvents,
    bootstrap,
    ordinary,
    invitations,
    memberships,
    ownership,
  };
}

test("ownership transfer fails atomically when the target aggregate exceeds capacity", async () => {
  const env = harness({
    capacityLimits: {
      mindPhysicalCanonicalBytes: 2_147_483_648,
      principalPhysicalCanonicalBytes: 1,
      sitePhysicalCanonicalBytes: 34_359_738_368,
      siteTemporaryBytes: 8_589_934_592,
      siteD1MetadataBytes: 536_870_912,
      ordinaryCommitSoftGrowthBytes: 4_194_304,
      activeHeavyPerMind: 1,
      activeHeavyPerPrincipal: 2,
      activeHeavyPerSite: 8,
    },
  });
  const owner = await createAccount(env, 40, "Capacity Owner");
  const target = await createAccount(env, 41, "Capacity Target");
  const mind = await createMind(env, owner, "capacity-transfer");
  const targetMemberId = await grantMembership(
    env,
    mind.mindId,
    owner.principalId,
    target.principalId,
    "editor",
    "capacity_target",
  );
  const before = await state(env, mind.mindId);

  await assert.rejects(
    env.ownership.transferOwnership(
      actor(owner.principalId, "request_capacity_transfer"),
      transferCommand(
        mind.mindId,
        targetMemberId,
        before.space.metadataVersion,
        "capacity-transfer",
      ),
    ),
    failure("ownership_target_capacity_exceeded"),
  );
  const after = await state(env, mind.mindId);
  assert.deepEqual(after, before);
});

test("active reservations on the transferred Mind are admitted against the target aggregate with no partial mutation", async () => {
  const env = harness();
  const owner = await createAccount(env, 42, "Reservation Owner");
  const target = await createAccount(env, 43, "Reservation Target");
  const mind = await createMind(env, owner, "reserved-capacity-transfer");
  const targetMemberId = await grantMembership(
    env,
    mind.mindId,
    owner.principalId,
    target.principalId,
    "editor",
    "reserved_capacity_target",
  );
  const targetUsage = await env.metadata.readPrincipalCapacityUsage(target.principalId);
  const mindUsage = await env.metadata.readMindCapacityUsage(mind.mindId);
  const reservationBytes = 1_024;
  const baseProjected = targetUsage.physicalCanonicalBytes + mindUsage.physicalCanonicalBytes;
  const admitted = await env.metadata.runCapacityTransaction((transaction) =>
    transaction.admitCapacityReservation({
      reservationId: "capacity:ownership-transfer:active",
      requestedByPrincipalId: owner.principalId,
      spaceId: mind.mindId,
      operation: "commit",
      operationRef: "ownership-transfer-active-reservation",
      baseRevisionId: mind.headRevisionId,
      idempotencyKey: "capacity-ownership-transfer-active",
      requested: {
        physicalCanonicalBytes: reservationBytes,
        temporaryBytes: 0,
        d1MetadataBytes: 0,
      },
      bulk: false,
      heavy: false,
      createdAt: ACCEPTED_AT,
      expiresAt: "2026-08-07T09:00:00.000Z",
    }, DEFAULT_CAPACITY_LIMITS));
  assert.equal(admitted.kind, "admitted");
  const constrainedCapacityLimits = {
    ...DEFAULT_CAPACITY_LIMITS,
    principalPhysicalCanonicalBytes: Math.ceil(
      (baseProjected + Math.floor(reservationBytes / 2)) / 0.85,
    ),
  };
  assert.equal(baseProjected / constrainedCapacityLimits.principalPhysicalCanonicalBytes < 0.85, true);
  assert.equal(
    (baseProjected + reservationBytes) / constrainedCapacityLimits.principalPhysicalCanonicalBytes >= 0.85,
    true,
  );
  const constrainedOwnership = new OwnershipTransferService({
    ordinaryMinds: env.metadata,
    objects: env.objects,
    auditIds: {
      nextAuditEventId: () => "audit_ownership_reserved_capacity",
      nextOutboxMessageId: () => "outbox_ownership_reserved_capacity",
    },
    capacityLimits: constrainedCapacityLimits,
  });
  const before = await state(env, mind.mindId);
  const reservationsBefore = await env.metadata.listCapacityReservationsForTest();

  await assert.rejects(
    constrainedOwnership.transferOwnership(
      actor(owner.principalId, "request_reserved_capacity_transfer"),
      transferCommand(
        mind.mindId,
        targetMemberId,
        before.space.metadataVersion,
        "reserved-capacity-transfer",
      ),
    ),
    failure("ownership_target_capacity_exceeded"),
  );
  assert.deepEqual(await state(env, mind.mindId), before);
  assert.deepEqual(await env.metadata.listCapacityReservationsForTest(), reservationsBefore);
  assert.equal((await env.metadata.listAuditEventsForTest()).length, 0);
  assert.equal((await env.metadata.listAuditOutboxForTest()).length, 0);
});

async function createAccount(env, index, displayName = `Principal ${index}`) {
  return env.bootstrap.bootstrapAccount(
    preRegistrationActor(index, displayName),
    { action: "create_isolated_account" },
  );
}

async function createMind(env, owner, handle = "ownership-mind") {
  return env.ordinary.createSpaceWithOwner(
    actor(owner.principalId, `request_create_${handle}`, CREATED_AT),
    {
      name: "Ownership Mind",
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

async function grantMembership(
  env,
  mindId,
  ownerId,
  principalId,
  role,
  suffix,
) {
  const membershipId = `membership_ownership_${suffix}`;
  assert.equal(
    await env.metadata.grantOrdinaryMembershipForTest(
      {
        membershipId,
        spaceId: mindId,
        principalId,
        role,
        state: "active",
        version: version(1),
        createdAt: ACCEPTED_AT,
        createdBy: ownerId,
        updatedAt: ACCEPTED_AT,
        updatedBy: ownerId,
      },
      ACCEPTED_AT,
    ),
    true,
  );
  return membershipId;
}

function transferCommand(
  mindId,
  targetMemberId,
  expectedMetadataVersion,
  idempotencyKey = "transfer-once",
  overrides = {},
) {
  return {
    mindId,
    targetMemberId,
    expectedMetadataVersion,
    expectedSourceMembershipVersion: 1,
    expectedTargetMembershipVersion: 1,
    confirmation: "transfer-ownership",
    idempotencyKey,
    ...overrides,
  };
}

function failure(code) {
  return (error) => {
    assert.equal(error instanceof OwnershipTransferFailure, true);
    assert.equal(error.code, code);
    return true;
  };
}

function activeOwners(current) {
  return current.memberships.filter(
    (membership) =>
      membership.state === "active" && membership.role === "owner",
  );
}

async function authorize(env, principalId, spaceId, capability) {
  return new CapabilityAuthorizer(env.metadata).authorize({
    actor: actor(principalId, `request_authorize_${capability}`),
    spaceId,
    capability,
    revisionMode: "head",
  });
}

test("pending target is rejected; accepted participant transfer is atomic, audited once and exactly replayable", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Current Owner");
  const target = await createAccount(env, 2, "Accepted Target");
  const mind = await createMind(env, owner, "accepted-target");
  const invitation = await env.invitations.createInvitation(
    actor(owner.principalId, "request_invite_target", INVITED_AT),
    {
      mindId: mind.mindId,
      targetVerifiedEmail: "private.ownership.2@example.com",
      role: "editor",
      expectedMetadataVersion: 1,
      idempotencyKey: "invite-transfer-target",
    },
  );
  const pending = await state(env, mind.mindId);
  await assert.rejects(
    env.ownership.transferOwnership(
      actor(owner.principalId, "request_transfer_pending", INVITED_AT),
      transferCommand(
        mind.mindId,
        "membership_ownership_target_1",
        pending.space.metadataVersion,
        "pending-transfer",
      ),
    ),
    failure("ownership_target_invalid"),
  );
  assert.deepEqual(await state(env, mind.mindId), pending);
  assert.equal((await env.metadata.listAuditEventsForTest()).length, 0);

  const accepted = await env.invitations.acceptInvitation(
    actor(target.principalId, "request_accept_target", ACCEPTED_AT),
    {
      invitationId: invitation.invitationId,
      expectedInvitationVersion: 1,
      idempotencyKey: "accept-transfer-target",
    },
  );
  assert.equal(accepted.membershipId, "membership_ownership_target_1");
  const before = await state(env, mind.mindId);
  const command = transferCommand(
    mind.mindId,
    accepted.membershipId,
    before.space.metadataVersion,
  );
  const transferred = await env.ownership.transferOwnership(
    actor(owner.principalId, "request_transfer_success"),
    command,
  );

  assert.equal(transferred.replayed, false);
  assert.equal(transferred.sourceRole, "admin");
  assert.equal(transferred.targetRole, "owner");
  assert.equal(transferred.targetMemberId, accepted.membershipId);
  assert.equal(transferred.metadataVersion, before.space.metadataVersion + 1);
  assert.equal(transferred.accessVersion, before.space.accessVersion + 1);
  const after = await state(env, mind.mindId);
  assert.equal(activeOwners(after).length, 1);
  assert.equal(activeOwners(after)[0].principalId, target.principalId);
  assert.equal(
    after.memberships.find(
      (membership) => membership.principalId === owner.principalId,
    ).role,
    "admin",
  );
  assert.equal(
    after.memberships.find(
      (membership) => membership.principalId === target.principalId,
    ).role,
    "owner",
  );
  assert.equal(after.space.spaceHandle, before.space.spaceHandle);
  assert.equal(after.space.normalizedHandle, before.space.normalizedHandle);
  assert.equal(after.space.headRevisionId, before.space.headRevisionId);
  assert.deepEqual(after.revisions, before.revisions);
  assert.deepEqual(after.invitations, before.invitations);
  assert.equal((await authorize(env, owner.principalId, mind.mindId, "ownership:transfer")).kind, "denied");
  assert.equal((await authorize(env, target.principalId, mind.mindId, "ownership:transfer")).kind, "allowed");
  assert.equal((await authorize(env, owner.principalId, mind.mindId, "content:write")).kind, "allowed");
  assert.equal((await authorize(env, target.principalId, mind.mindId, "content:write")).kind, "allowed");

  const events = await env.metadata.listAuditEventsForTest();
  const outbox = await env.metadata.listAuditOutboxForTest();
  assert.equal(events.length, 1);
  assert.equal(outbox.length, 1);
  assert.equal(events[0].eventType, "space.ownership_transferred");
  assert.deepEqual(events[0].safeMetadata, {
    access_version: after.space.accessVersion,
    metadata_version: after.space.metadataVersion,
    source_member_id: transferred.sourceMemberId,
    source_membership_version: transferred.sourceMembershipVersion,
    target_member_id: transferred.targetMemberId,
    target_membership_version: transferred.targetMembershipVersion,
  });
  assert.equal(outbox[0].auditEventId, events[0].auditEventId);

  const replayed = await env.ownership.transferOwnership(
    actor(owner.principalId, "request_transfer_retry", LATER_AT),
    command,
  );
  assert.deepEqual(replayed, { ...transferred, replayed: true });
  assert.deepEqual(await state(env, mind.mindId), after);
  assert.equal((await env.metadata.listAuditEventsForTest()).length, 1);
  assert.equal((await env.metadata.listAuditOutboxForTest()).length, 1);

  await assert.rejects(
    env.ownership.transferOwnership(
      actor(owner.principalId, "request_transfer_key_conflict", LATER_AT),
      { ...command, expectedMetadataVersion: after.space.metadataVersion },
    ),
    failure("idempotency_conflict"),
  );
  assert.deepEqual(await state(env, mind.mindId), after);
});

test("source authority, target activity, Personal Mind and metadata CAS fail without partial transfer", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Owner");
  const target = await createAccount(env, 2, "Target");
  const outsider = await createAccount(env, 3, "Outsider");
  const mind = await createMind(env, owner, "transfer-guards");
  const targetMemberId = await grantMembership(
    env,
    mind.mindId,
    owner.principalId,
    target.principalId,
    "editor",
    "guard_target",
  );
  const before = await state(env, mind.mindId);

  await assert.rejects(
    env.ownership.transferOwnership(
      actor(owner.principalId, "request_transfer_stale"),
      transferCommand(
        mind.mindId,
        targetMemberId,
        before.space.metadataVersion - 1,
        "stale-transfer",
      ),
    ),
    failure("metadata_conflict"),
  );
  await assert.rejects(
    env.ownership.transferOwnership(
      actor(target.principalId, "request_transfer_non_owner"),
      transferCommand(
        mind.mindId,
        before.memberships.find(
          (membership) => membership.principalId === owner.principalId,
        ).membershipId,
        before.space.metadataVersion,
        "non-owner-transfer",
      ),
    ),
    failure("forbidden"),
  );
  await assert.rejects(
    env.ownership.transferOwnership(
      actor(owner.principalId, "request_transfer_owner_target"),
      transferCommand(
        mind.mindId,
        before.memberships.find(
          (membership) => membership.principalId === owner.principalId,
        ).membershipId,
        before.space.metadataVersion,
        "owner-target-transfer",
      ),
    ),
    failure("ownership_target_invalid"),
  );
  const ownerAccount = await env.metadata.readAccount(owner.principalId);
  assert.ok(ownerAccount);
  await assert.rejects(
    env.ownership.transferOwnership(
      actor(owner.principalId, "request_transfer_personal"),
      transferCommand(
        ownerAccount.personalMind.space.spaceId,
        targetMemberId,
        ownerAccount.personalMind.space.metadataVersion,
        "personal-transfer",
      ),
    ),
    failure("personal_mind_operation_forbidden"),
  );
  await assert.rejects(
    env.ownership.transferOwnership(
      actor(outsider.principalId, "request_transfer_outsider"),
      transferCommand(
        mind.mindId,
        targetMemberId,
        before.space.metadataVersion,
        "outsider-transfer",
      ),
    ),
    failure("forbidden"),
  );
  await assert.rejects(
    env.ownership.transferOwnership(
      {
        ...actor(owner.principalId, "request_transfer_disabled"),
        deploymentCapabilities: CAPABILITIES.filter(
          (capability) => capability !== "ownership:transfer",
        ),
      },
      transferCommand(
        mind.mindId,
        targetMemberId,
        before.space.metadataVersion,
        "disabled-transfer",
      ),
    ),
    failure("forbidden"),
  );
  assert.deepEqual(await state(env, mind.mindId), before);
  assert.equal(activeOwners(before).length, 1);
  assert.equal((await env.metadata.listAuditEventsForTest()).length, 0);
  assert.equal((await env.metadata.listAuditOutboxForTest()).length, 0);

  assert.equal(
    await env.metadata.revokeOrdinaryMembershipForTest(
      mind.mindId,
      target.principalId,
      LATER_AT,
    ),
    true,
  );
  const revoked = await state(env, mind.mindId);
  await assert.rejects(
    env.ownership.transferOwnership(
      actor(owner.principalId, "request_transfer_revoked", LATER_AT),
      transferCommand(
        mind.mindId,
        targetMemberId,
        revoked.space.metadataVersion,
        "revoked-transfer",
      ),
    ),
    failure("ownership_target_invalid"),
  );
  assert.deepEqual(await state(env, mind.mindId), revoked);
  assert.equal(activeOwners(revoked).length, 1);
});

test("a target role change after the Owner read fails the transfer closed on membership CAS", async () => {
  const env = harness();
  const owner = await createAccount(env, 20, "Concurrent Owner");
  const target = await createAccount(env, 21, "Concurrent Target");
  const mind = await createMind(env, owner, "concurrent-role-transfer");
  const targetMemberId = await grantMembership(
    env,
    mind.mindId,
    owner.principalId,
    target.principalId,
    "editor",
    "concurrent_role_target",
  );
  const beforeRead = await state(env, mind.mindId);
  const staleCommand = transferCommand(
    mind.mindId,
    targetMemberId,
    beforeRead.space.metadataVersion,
    "concurrent-role-transfer",
  );
  const roleChanged = await env.memberships.changeMembershipRole(
    actor(owner.principalId, "request_concurrent_role_change", LATER_AT),
    {
      mindId: mind.mindId,
      memberId: targetMemberId,
      role: "admin",
      expectedMembershipVersion: 1,
      idempotencyKey: "concurrent-role-change-before-transfer",
    },
  );
  assert.equal(roleChanged.membershipVersion, 2);
  const beforeTransfer = await state(env, mind.mindId);

  await assert.rejects(
    env.ownership.transferOwnership(
      actor(owner.principalId, "request_stale_membership_transfer", LATER_AT),
      staleCommand,
    ),
    failure("ownership_state_changed"),
  );
  assert.deepEqual(await state(env, mind.mindId), beforeTransfer);
  assert.equal(activeOwners(beforeTransfer).length, 1);
  assert.equal(activeOwners(beforeTransfer)[0].principalId, owner.principalId);
});

test("concurrent retries coalesce and competing transfers have one CAS winner and one Owner", async () => {
  const exact = harness();
  const exactOwner = await createAccount(exact, 1);
  const exactTarget = await createAccount(exact, 2);
  const exactMind = await createMind(exact, exactOwner, "exact-transfer-race");
  const exactMemberId = await grantMembership(
    exact,
    exactMind.mindId,
    exactOwner.principalId,
    exactTarget.principalId,
    "admin",
    "exact_target",
  );
  const exactBefore = await state(exact, exactMind.mindId);
  const exactCommand = transferCommand(
    exactMind.mindId,
    exactMemberId,
    exactBefore.space.metadataVersion,
    "exact-transfer-race",
  );
  const exactResults = await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      exact.ownership.transferOwnership(
        actor(exactOwner.principalId, `request_exact_transfer_${index}`),
        exactCommand,
      ),
    ),
  );
  assert.equal(exactResults.filter((result) => !result.replayed).length, 1);
  assert.equal(exactResults.filter((result) => result.replayed).length, 23);
  assert.equal(
    new Set(exactResults.map((result) => result.targetMemberId)).size,
    1,
  );
  const exactAfter = await state(exact, exactMind.mindId);
  assert.equal(activeOwners(exactAfter).length, 1);
  assert.equal(activeOwners(exactAfter)[0].principalId, exactTarget.principalId);
  assert.equal((await exact.metadata.listAuditEventsForTest()).length, 1);

  const competing = harness();
  const owner = await createAccount(competing, 1);
  const targetA = await createAccount(competing, 2);
  const targetB = await createAccount(competing, 3);
  const mind = await createMind(competing, owner, "competing-transfer-race");
  const targetAId = await grantMembership(
    competing,
    mind.mindId,
    owner.principalId,
    targetA.principalId,
    "editor",
    "competing_a",
  );
  const targetBId = await grantMembership(
    competing,
    mind.mindId,
    owner.principalId,
    targetB.principalId,
    "admin",
    "competing_b",
  );
  const before = await state(competing, mind.mindId);
  const outcomes = await Promise.allSettled([
    competing.ownership.transferOwnership(
      actor(owner.principalId, "request_competing_a"),
      transferCommand(
        mind.mindId,
        targetAId,
        before.space.metadataVersion,
        "competing-a",
      ),
    ),
    competing.ownership.transferOwnership(
      actor(owner.principalId, "request_competing_b"),
      transferCommand(
        mind.mindId,
        targetBId,
        before.space.metadataVersion,
        "competing-b",
      ),
    ),
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
  );
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(rejected);
  assert.equal(rejected.reason instanceof OwnershipTransferFailure, true);
  assert.equal(rejected.reason.code, "metadata_conflict");
  const after = await state(competing, mind.mindId);
  assert.equal(activeOwners(after).length, 1);
  assert.equal(after.space.metadataVersion, before.space.metadataVersion + 1);
  assert.equal(after.space.accessVersion, before.space.accessVersion + 1);
  assert.equal((await competing.metadata.listAuditEventsForTest()).length, 1);
  assert.equal((await competing.metadata.listAuditOutboxForTest()).length, 1);
});

test("every injected transfer failure rolls back both roles, versions, audit and idempotency", async () => {
  const stages = [
    "ownership_after_space",
    "ownership_after_memberships",
    "ownership_after_audit",
    "ownership_after_idempotency",
    "ownership_before_commit",
  ];
  for (const [index, stage] of stages.entries()) {
    const env = harness();
    const owner = await createAccount(env, 1);
    const target = await createAccount(env, 2);
    const mind = await createMind(env, owner, `rollback-transfer-${index}`);
    const targetMemberId = await grantMembership(
      env,
      mind.mindId,
      owner.principalId,
      target.principalId,
      "editor",
      `rollback_${index}`,
    );
    const before = await state(env, mind.mindId);
    const command = transferCommand(
      mind.mindId,
      targetMemberId,
      before.space.metadataVersion,
      `rollback-transfer-${index}`,
    );
    env.metadata.failNextOrdinaryMindAtForTest(stage);
    await assert.rejects(
      env.ownership.transferOwnership(
        actor(owner.principalId, `request_rollback_${index}`),
        command,
      ),
      /injected ordinary Mind transaction failure/u,
    );
    assert.deepEqual(await state(env, mind.mindId), before);
    assert.equal(activeOwners(before).length, 1);
    assert.equal((await env.metadata.listAuditEventsForTest()).length, 0);
    assert.equal((await env.metadata.listAuditOutboxForTest()).length, 0);

    const recovered = await env.ownership.transferOwnership(
      actor(owner.principalId, `request_recover_${index}`, LATER_AT),
      command,
    );
    assert.equal(recovered.replayed, false);
    const after = await state(env, mind.mindId);
    assert.equal(activeOwners(after).length, 1);
    assert.equal(activeOwners(after)[0].principalId, target.principalId);
    assert.equal((await env.metadata.listAuditEventsForTest()).length, 1);
    assert.equal((await env.metadata.listAuditOutboxForTest()).length, 1);
  }
});
