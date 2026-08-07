import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  AccountBootstrapService,
  InvitationControlFailure,
  InvitationControlService,
  OrdinaryMindControlService,
} from "@mind-diary/application-control";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";
import { CAPABILITIES, verifiedSpaceHost, version } from "@mind-diary/domain";

const CREATED_AT = "2026-08-07T05:00:00.000Z";
const INVITED_AT = "2026-08-07T05:15:00.000Z";
const HOST = verifiedSpaceHost("mind-diary.example");

function preRegistrationActor(index, displayName = `Registered ${index}`) {
  return {
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding: `private.target.${index}@example.com`,
    suggestedDisplayName: displayName,
    deploymentCapabilities: CAPABILITIES,
    requestId: `request_bootstrap_invitation_${index}`,
    occurredAtUtc: CREATED_AT,
  };
}

function actor(
  principalId,
  requestId = "request_create_invitation",
  occurredAtUtc = INVITED_AT,
  deploymentCapabilities = CAPABILITIES,
) {
  return {
    kind: "registered_principal",
    principalId,
    authentication: { kind: "sites_identity" },
    deploymentCapabilities,
    requestId,
    occurredAtUtc,
  };
}

function accountIds() {
  let account = 0;
  return {
    nextPrincipalId: () => `principal_invitation_${++account}`,
    nextExternalBindingId: () => `binding_invitation_${account}`,
    nextSpaceId: () => `space_personal_invitation_${account}`,
    nextMembershipId: () => `membership_personal_invitation_${account}`,
    nextRevisionId: () => `revision_personal_invitation_${account}`,
    nextPersonalSpaceHandle: () => `personal-service-invitation-${account}`,
  };
}

function ordinaryIds() {
  let spaces = 0;
  let memberships = 0;
  let revisions = 0;
  return {
    nextSpaceId: () => `space_invitation_${++spaces}`,
    nextMembershipId: () => `membership_invitation_owner_${++memberships}`,
    nextRevisionId: () => `revision_invitation_${++revisions}`,
  };
}

function invitationIds() {
  let invitations = 0;
  return {
    nextInvitationId: () => `invitation_${++invitations}`,
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
  const invitations = new InvitationControlService({
    invitations: metadata,
    objects,
    ids: invitationIds(),
    logger: { record: (event) => events.push(event) },
  });
  return { metadata, objects, events, bootstrap, ordinary, invitations };
}

async function createAccount(env, index, displayName) {
  return env.bootstrap.bootstrapAccount(
    preRegistrationActor(index, displayName),
    { action: "create_isolated_account" },
  );
}

async function createMind(env, owner, handle = "shared-research") {
  return env.ordinary.createSpaceWithOwner(
    actor(owner.principalId, `request_create_${handle}`, CREATED_AT),
    {
      name: "Shared Research",
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
  principalId,
  role,
  createdBy,
  suffix,
) {
  const granted = await env.metadata.grantOrdinaryMembershipForTest(
    {
      membershipId: `membership_invitation_${suffix}`,
      spaceId: mindId,
      principalId,
      role,
      state: "active",
      version: version(1),
      createdAt: INVITED_AT,
      createdBy,
      updatedAt: INVITED_AT,
      updatedBy: createdBy,
    },
    INVITED_AT,
  );
  assert.equal(granted, true);
  return state(env, mindId);
}

function command(mindId, targetIndex, overrides = {}) {
  return {
    mindId,
    targetVerifiedEmail: `private.target.${targetIndex}@example.com`,
    role: "reader",
    expectedMetadataVersion: 1,
    idempotencyKey: `invite-target-${targetIndex}`,
    ...overrides,
  };
}

function expectFailure(code) {
  return (error) => {
    assert.equal(error instanceof InvitationControlFailure, true);
    assert.equal(error.code, code);
    return true;
  };
}

test("Owner exact-normalized invite creates one seven-day pending record without membership or access", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Owner Profile");
  const target = await createAccount(env, 2, "Registered Target");
  const mind = await createMind(env, owner);

  const result = await env.invitations.createInvitation(
    actor(owner.principalId),
    command(mind.mindId, 2, {
      targetVerifiedEmail: "  PRIVATE.TARGET.2@EXAMPLE.COM  ",
      role: "admin",
    }),
  );

  assert.deepEqual(result, {
    invitationId: "invitation_1",
    mindId: mind.mindId,
    target: {
      principalId: target.principalId,
      displayName: "Registered Target",
    },
    proposedRole: "admin",
    state: "pending",
    expiresAt: "2026-08-14T05:15:00.000Z",
    invitationVersion: 1,
    replayed: false,
  });
  const after = await state(env, mind.mindId);
  assert.equal(after.memberships.length, 1);
  assert.equal(after.memberships[0].principalId, owner.principalId);
  assert.equal(after.invitations.length, 1);
  assert.equal(after.invitations[0].targetPrincipalId, target.principalId);
  assert.equal(after.invitations[0].state, "pending");
  assert.equal(after.space.metadataVersion, 1);
  assert.equal(
    await env.metadata.transferOrdinaryOwnershipForTest(
      mind.mindId,
      owner.principalId,
      target.principalId,
      INVITED_AT,
    ),
    false,
  );
  const targetAccess = await new CapabilityAuthorizer(env.metadata).authorize({
    actor: actor(target.principalId, "request_pending_access"),
    spaceId: mind.mindId,
    capability: "content:browse",
    revisionMode: "head",
  });
  assert.equal(targetAccess.kind, "denied");
  assert.equal(targetAccess.code, "access_denied");
  assert.deepEqual(env.events, [
    { event: "invitation_created", requestId: "request_create_invitation" },
  ]);
});

test("Admin can invite Reader or Editor, while Admin/Owner grants and non-admin actors fail closed", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const admin = await createAccount(env, 2);
  await createAccount(env, 3);
  await createAccount(env, 4);
  const editor = await createAccount(env, 5);
  const mind = await createMind(env, owner, "role-policy");
  let current = await grantMembership(
    env,
    mind.mindId,
    admin.principalId,
    "admin",
    owner.principalId,
    "admin",
  );
  current = await grantMembership(
    env,
    mind.mindId,
    editor.principalId,
    "editor",
    owner.principalId,
    "editor",
  );

  const reader = await env.invitations.createInvitation(
    actor(admin.principalId, "request_admin_reader"),
    command(mind.mindId, 3, {
      expectedMetadataVersion: current.space.metadataVersion,
      idempotencyKey: "admin-reader",
    }),
  );
  const editorInvite = await env.invitations.createInvitation(
    actor(admin.principalId, "request_admin_editor"),
    command(mind.mindId, 4, {
      role: "editor",
      expectedMetadataVersion: current.space.metadataVersion,
      idempotencyKey: "admin-editor",
    }),
  );
  assert.equal(reader.proposedRole, "reader");
  assert.equal(editorInvite.proposedRole, "editor");
  const beforeDenied = await state(env, mind.mindId);

  await assert.rejects(
    env.invitations.createInvitation(
      actor(admin.principalId, "request_admin_admin"),
      command(mind.mindId, 4, {
        role: "admin",
        expectedMetadataVersion: current.space.metadataVersion,
        idempotencyKey: "admin-admin",
      }),
    ),
    expectFailure("forbidden"),
  );
  await assert.rejects(
    env.invitations.createInvitation(
      actor(editor.principalId, "request_editor_invite"),
      command(mind.mindId, 4, {
        expectedMetadataVersion: current.space.metadataVersion,
        idempotencyKey: "editor-invite",
      }),
    ),
    expectFailure("forbidden"),
  );
  await assert.rejects(
    env.invitations.createInvitation(
      actor(owner.principalId, "request_owner_owner"),
      command(mind.mindId, 4, {
        role: "owner",
        expectedMetadataVersion: current.space.metadataVersion,
        idempotencyKey: "owner-owner",
      }),
    ),
    expectFailure("invalid_role"),
  );
  assert.deepEqual(await state(env, mind.mindId), beforeDenied);
});

test("invalid or unknown exact emails, Personal Mind, active membership and duplicate pending target leave exact state", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const target = await createAccount(env, 2);
  const member = await createAccount(env, 3);
  const mind = await createMind(env, owner, "target-policy");

  for (const targetVerifiedEmail of [
    "",
    "not-an-email",
    "two@@example.com",
    "member@example",
    "ｍｅｍｂｅｒ＠ｅｘａｍｐｌｅ．ｃｏｍ",
  ]) {
    const before = await state(env, mind.mindId);
    await assert.rejects(
      env.invitations.createInvitation(
        actor(owner.principalId, `request_invalid_${targetVerifiedEmail.length}`),
        command(mind.mindId, 2, { targetVerifiedEmail }),
      ),
      expectFailure("invalid_target_verified_email"),
    );
    assert.deepEqual(await state(env, mind.mindId), before);
  }

  const beforeUnknown = await state(env, mind.mindId);
  let unknownFailure;
  try {
    await env.invitations.createInvitation(
      actor(owner.principalId, "request_unknown_email"),
      command(mind.mindId, 2, {
        targetVerifiedEmail: "unknown.registered@example.com",
      }),
    );
  } catch (error) {
    unknownFailure = error;
  }
  assert.equal(unknownFailure.code, "registered_principal_not_found");
  assert.equal(unknownFailure.message.includes("unknown.registered"), false);
  assert.equal(unknownFailure.message.toLowerCase().includes("alternative"), false);
  assert.deepEqual(await state(env, mind.mindId), beforeUnknown);

  const withMember = await grantMembership(
    env,
    mind.mindId,
    member.principalId,
    "reader",
    owner.principalId,
    "existing_reader",
  );
  await assert.rejects(
    env.invitations.createInvitation(
      actor(owner.principalId, "request_existing_member"),
      command(mind.mindId, 3, {
        expectedMetadataVersion: withMember.space.metadataVersion,
      }),
    ),
    expectFailure("active_membership_exists"),
  );
  const invited = await env.invitations.createInvitation(
    actor(owner.principalId, "request_first_pending"),
    command(mind.mindId, 2, {
      expectedMetadataVersion: withMember.space.metadataVersion,
    }),
  );
  await assert.rejects(
    env.invitations.createInvitation(
      actor(owner.principalId, "request_duplicate_pending"),
      command(mind.mindId, 2, {
        role: "editor",
        expectedMetadataVersion: withMember.space.metadataVersion,
        idempotencyKey: "different-pending-key",
      }),
    ),
    expectFailure("pending_invitation_exists"),
  );
  const afterDuplicate = await state(env, mind.mindId);
  assert.equal(afterDuplicate.invitations.length, 1);
  assert.equal(afterDuplicate.invitations[0].invitationId, invited.invitationId);
  assert.equal(afterDuplicate.memberships.length, 2);

  const ownerAccount = await env.metadata.readAccount(owner.principalId);
  assert.ok(ownerAccount);
  await assert.rejects(
    env.invitations.createInvitation(
      actor(owner.principalId, "request_personal_invitation"),
      command(ownerAccount.personalMind.space.spaceId, 2),
    ),
    expectFailure("personal_mind_operation_forbidden"),
  );
});

test("stale metadata, idempotent retry and conflicting retry preserve one exact invitation", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  await createAccount(env, 2);
  await createAccount(env, 3);
  const mind = await createMind(env, owner, "retry-policy");
  assert.equal(
    await env.metadata.bumpOrdinaryMindMetadataVersionForTest(
      mind.mindId,
      "2026-08-07T05:10:00.000Z",
    ),
    true,
  );
  const staleBefore = await state(env, mind.mindId);
  await assert.rejects(
    env.invitations.createInvitation(
      actor(owner.principalId, "request_stale"),
      command(mind.mindId, 2, { expectedMetadataVersion: 1 }),
    ),
    expectFailure("metadata_conflict"),
  );
  assert.deepEqual(await state(env, mind.mindId), staleBefore);

  const exactCommand = command(mind.mindId, 2, {
    expectedMetadataVersion: 2,
    idempotencyKey: "stable-invitation-retry",
  });
  const created = await env.invitations.createInvitation(
    actor(owner.principalId, "request_retry_first"),
    exactCommand,
  );
  const replayed = await env.invitations.createInvitation(
    actor(
      owner.principalId,
      "request_retry_second",
      "2026-08-07T06:15:00.000Z",
    ),
    exactCommand,
  );
  assert.deepEqual(replayed, { ...created, replayed: true });

  await assert.rejects(
    env.invitations.createInvitation(
      actor(owner.principalId, "request_retry_conflict"),
      command(mind.mindId, 3, {
        expectedMetadataVersion: 2,
        idempotencyKey: "stable-invitation-retry",
      }),
    ),
    expectFailure("idempotency_conflict"),
  );
  const final = await state(env, mind.mindId);
  assert.equal(final.invitations.length, 1);
  assert.equal(final.invitations[0].invitationId, created.invitationId);
  assert.equal(final.memberships.length, 1);
});

test("concurrent duplicate-target invitations have one winner and no partial membership", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  await createAccount(env, 2);
  const mind = await createMind(env, owner, "invitation-race");

  const outcomes = await Promise.allSettled(
    Array.from({ length: 24 }, (_, index) =>
      env.invitations.createInvitation(
        actor(owner.principalId, `request_invitation_race_${index}`),
        command(mind.mindId, 2, {
          idempotencyKey: `invitation-race-${index}`,
        }),
      ),
    ),
  );
  const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
  const losers = outcomes.filter((outcome) => outcome.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 23);
  for (const loser of losers) {
    assert.equal(loser.reason instanceof InvitationControlFailure, true);
    assert.equal(loser.reason.code, "pending_invitation_exists");
  }
  const final = await state(env, mind.mindId);
  assert.equal(final.invitations.length, 1);
  assert.equal(final.invitations[0].invitationId, winners[0].value.invitationId);
  assert.equal(final.memberships.length, 1);
});

test("injected transaction failures roll back invitation and idempotency, then exact retry succeeds", async () => {
  for (const stage of [
    "invitation_after_record",
    "invitation_after_idempotency",
    "invitation_before_commit",
  ]) {
    const env = harness();
    const owner = await createAccount(env, 1);
    await createAccount(env, 2);
    const mind = await createMind(env, owner, `rollback-${stage.replaceAll("_", "-")}`);
    const exactCommand = command(mind.mindId, 2, {
      idempotencyKey: `rollback-${stage}`,
    });
    const before = await state(env, mind.mindId);
    env.metadata.failNextOrdinaryMindAtForTest(stage);
    await assert.rejects(
      env.invitations.createInvitation(
        actor(owner.principalId, `request_${stage}`),
        exactCommand,
      ),
      /injected ordinary Mind transaction failure/u,
    );
    assert.deepEqual(await state(env, mind.mindId), before);

    const recovered = await env.invitations.createInvitation(
      actor(owner.principalId, `request_recover_${stage}`),
      exactCommand,
    );
    assert.equal(recovered.replayed, false);
    const final = await state(env, mind.mindId);
    assert.equal(final.invitations.length, 1);
    assert.equal(final.memberships.length, 1);
  }
});

test("deleted target and deployment capability denial are generic and safe logs contain no email", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const target = await createAccount(env, 2, "Private Target Name");
  const mind = await createMind(env, owner, "safe-invitation");
  assert.equal(
    await env.metadata.disablePrincipalForTest(
      target.principalId,
      "2026-08-07T05:12:00.000Z",
    ),
    true,
  );
  await assert.rejects(
    env.invitations.createInvitation(
      actor(owner.principalId, "request_deleted_target"),
      command(mind.mindId, 2),
    ),
    expectFailure("registered_principal_not_found"),
  );
  await assert.rejects(
    env.invitations.createInvitation(
      actor(
        owner.principalId,
        "request_deployment_denied",
        INVITED_AT,
        ["content:browse"],
      ),
      command(mind.mindId, 2),
    ),
    expectFailure("forbidden"),
  );
  const serialized = JSON.stringify(env.events);
  assert.equal(serialized.includes("private.target.2@example.com"), false);
  assert.equal(serialized.includes("Private Target Name"), false);
  assert.equal(serialized.includes(target.principalId), false);
  assert.equal((await state(env, mind.mindId)).invitations.length, 0);
});
