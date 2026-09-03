import assert from "node:assert/strict";
import test from "node:test";

import { createBackgroundServiceActor } from "@mind-diary/adapter-background";
import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import { InvitationExpiryJobHandler } from "@mind-diary/application-background";
import {
  AccountBootstrapService,
  InvitationControlFailure,
  InvitationControlService,
  OrdinaryMindControlService,
} from "@mind-diary/application-control";
import { CAPABILITIES, verifiedSpaceHost } from "@mind-diary/domain";

const CREATED = "2026-08-07T06:00:00.000Z";
const INVITED = "2026-08-07T06:15:00.000Z";
const EXPIRES = "2026-08-14T06:15:00.000Z";
const HOST = verifiedSpaceHost("mind-diary.example");

function pre(index) {
  return {
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding: `lifecycle.${index}@example.com`,
    suggestedDisplayName: `Lifecycle ${index}`,
    deploymentCapabilities: CAPABILITIES,
    requestId: `bootstrap_${index}`,
    occurredAtUtc: CREATED,
  };
}

function actor(principalId, requestId, occurredAtUtc = INVITED) {
  return {
    kind: "registered_principal",
    principalId,
    authentication: { kind: "sites_identity" },
    deploymentCapabilities: CAPABILITIES,
    requestId,
    occurredAtUtc,
  };
}

function harness() {
  const metadata = new InMemoryRevisionMetadataStore();
  const objects = new InMemoryObjectStore();
  let account = 0;
  let space = 0;
  let ownerMembership = 0;
  let revision = 0;
  let invitation = 0;
  let targetMembership = 0;
  let job = 0;
  const bootstrap = new AccountBootstrapService({
    accounts: metadata,
    objects,
    ids: {
      nextPrincipalId: () => `principal_lifecycle_${++account}`,
      nextExternalBindingId: () => `binding_lifecycle_${account}`,
      nextSpaceId: () => `space_personal_lifecycle_${account}`,
      nextMembershipId: () => `membership_personal_lifecycle_${account}`,
      nextRevisionId: () => `revision_personal_lifecycle_${account}`,
      nextPersonalSpaceHandle: () => `personal-lifecycle-${account}`,
    },
  });
  const ordinary = new OrdinaryMindControlService({
    ordinaryMinds: metadata,
    objects,
    host: HOST,
    ids: {
      nextSpaceId: () => `space_lifecycle_${++space}`,
      nextMembershipId: () => `membership_owner_lifecycle_${++ownerMembership}`,
      nextRevisionId: () => `revision_lifecycle_${++revision}`,
    },
  });
  const invitations = new InvitationControlService({
    invitations: metadata,
    objects,
    ids: {
      nextInvitationId: () => `invitation_lifecycle_${++invitation}`,
      nextMembershipId: () => `membership_target_lifecycle_${++targetMembership}`,
      nextInvitationExpiryJobId: () => `job_expire_invitation_${++job}`,
    },
  });
  return { metadata, bootstrap, ordinary, invitations };
}

async function fixture(role = "editor") {
  const env = harness();
  const owner = await env.bootstrap.bootstrapAccount(pre(1), { action: "create_isolated_account" });
  const target = await env.bootstrap.bootstrapAccount(pre(2), { action: "create_isolated_account" });
  const other = await env.bootstrap.bootstrapAccount(pre(3), { action: "create_isolated_account" });
  const mind = await env.ordinary.createSpaceWithOwner(actor(owner.principalId, "create", CREATED), {
    name: "Lifecycle Mind",
    handle: `lifecycle-${role}`,
    idempotencyKey: `create-${role}`,
  });
  const invite = await env.invitations.createInvitation(actor(owner.principalId, "invite"), {
    mindId: mind.mindId,
    targetVerifiedEmail: "lifecycle.2@example.com",
    role,
    expectedMetadataVersion: 1,
    idempotencyKey: `invite-${role}`,
  });
  return { env, owner, target, other, mind, invite };
}

async function state(env, mindId) {
  const value = await env.metadata.inspectOrdinaryMindStateForTest(mindId);
  assert.ok(value);
  return value;
}

function command(invitationId, version, key) {
  return { invitationId, expectedInvitationVersion: version, idempotencyKey: key };
}

function failure(code) {
  return (error) => {
    assert.equal(error instanceof InvitationControlFailure, true);
    assert.equal(error.code, code);
    return true;
  };
}

test("accept is target-bound, versioned, atomic and retry-safe under concurrency", async () => {
  const { env, target, other, mind, invite } = await fixture("admin");
  await assert.rejects(
    env.invitations.acceptInvitation(actor(other.principalId, "wrong-target"), command(invite.invitationId, 1, "wrong-target")),
    failure("forbidden"),
  );
  const exact = command(invite.invitationId, 1, "accept-once");
  const outcomes = await Promise.all([
    env.invitations.acceptInvitation(actor(target.principalId, "accept-a"), exact),
    env.invitations.acceptInvitation(actor(target.principalId, "accept-b"), exact),
  ]);
  assert.equal(outcomes.filter((item) => item.replayed).length, 1);
  assert.equal(new Set(outcomes.map((item) => item.membershipId)).size, 1);
  const final = await state(env, mind.mindId);
  assert.equal(final.invitations[0].state, "accepted");
  assert.equal(final.invitations[0].version, 2);
  assert.equal(final.memberships.filter((item) => item.principalId === target.principalId).length, 1);
  assert.equal(final.memberships.find((item) => item.principalId === target.principalId).role, "admin");
  assert.equal(final.space.metadataVersion, 3);
  assert.equal(final.space.accessVersion, 2);
  await assert.rejects(
    env.invitations.acceptInvitation(actor(target.principalId, "second-key"), command(invite.invitationId, 1, "second-key")),
    failure("invitation_conflict"),
  );
  assert.deepEqual(await state(env, mind.mindId), final);
});

test("request-time expiry is strict at the boundary, durable and retry-safe", async () => {
  const beforeBoundary = await fixture("reader");
  const accepted = await beforeBoundary.env.invitations.acceptInvitation(
    actor(
      beforeBoundary.target.principalId,
      "accept-before-boundary",
      "2026-08-14T06:14:59.999Z",
    ),
    command(
      beforeBoundary.invite.invitationId,
      1,
      "accept-before-boundary",
    ),
  );
  assert.equal(accepted.state, "accepted");
  assert.equal(
    (await state(beforeBoundary.env, beforeBoundary.mind.mindId)).memberships
      .filter((item) => item.principalId === beforeBoundary.target.principalId)
      .length,
    1,
  );

  for (const [suffix, occurredAt] of [
    ["at-boundary", EXPIRES],
    ["after-boundary", "2026-08-14T06:15:00.001Z"],
  ]) {
    const current = await fixture("editor");
    const exact = command(
      current.invite.invitationId,
      1,
      `late-accept-${suffix}`,
    );
    await assert.rejects(
      current.env.invitations.acceptInvitation(
        actor(current.target.principalId, `late-${suffix}`, occurredAt),
        exact,
      ),
      failure("invitation_expired"),
    );
    const expired = await state(current.env, current.mind.mindId);
    assert.equal(expired.invitations[0].state, "expired");
    assert.equal(expired.invitations[0].version, 2);
    assert.equal(expired.memberships.length, 1);

    await assert.rejects(
      current.env.invitations.acceptInvitation(
        actor(current.target.principalId, `late-retry-${suffix}`, occurredAt),
        exact,
      ),
      failure("invitation_expired"),
    );
    assert.deepEqual(
      await state(current.env, current.mind.mindId),
      expired,
    );
  }
});

test("reject and cancel never grant access; only target rejects and the current authorized sender cancels", async () => {
  const rejected = await fixture("reader");
  await assert.rejects(
    rejected.env.invitations.rejectInvitation(actor(rejected.other.principalId, "wrong-reject"), command(rejected.invite.invitationId, 1, "wrong-reject")),
    failure("forbidden"),
  );
  const result = await rejected.env.invitations.rejectInvitation(
    actor(rejected.target.principalId, "reject"),
    command(rejected.invite.invitationId, 1, "reject"),
  );
  assert.equal(result.state, "rejected");
  assert.equal(result.membershipId, null);
  assert.equal((await state(rejected.env, rejected.mind.mindId)).memberships.length, 1);
  await assert.rejects(
    rejected.env.invitations.acceptInvitation(actor(rejected.target.principalId, "accept-rejected"), command(rejected.invite.invitationId, 2, "accept-rejected")),
    failure("invitation_unavailable"),
  );

  const cancelled = await fixture("editor");
  await assert.rejects(
    cancelled.env.invitations.cancelInvitation(actor(cancelled.target.principalId, "target-cancel"), command(cancelled.invite.invitationId, 1, "target-cancel")),
    failure("forbidden"),
  );
  const cancel = await cancelled.env.invitations.cancelInvitation(
    actor(cancelled.owner.principalId, "sender-cancel"),
    command(cancelled.invite.invitationId, 1, "sender-cancel"),
  );
  assert.equal(cancel.state, "cancelled");
  assert.equal((await state(cancelled.env, cancelled.mind.mindId)).memberships.length, 1);
});

test("reissue replaces terminal or current pending atomically and never leaves two pending", async () => {
  const { env, owner, target, mind, invite } = await fixture("editor");
  const first = await env.invitations.reissueInvitation(
    actor(owner.principalId, "reissue"),
    command(invite.invitationId, 1, "reissue"),
  );
  const replay = await env.invitations.reissueInvitation(
    actor(owner.principalId, "reissue-retry", "2026-08-07T07:00:00.000Z"),
    command(invite.invitationId, 1, "reissue"),
  );
  assert.equal(replay.invitation.replayed, true);
  assert.equal(replay.invitation.invitationId, first.invitation.invitationId);
  const after = await state(env, mind.mindId);
  assert.equal(after.invitations.filter((item) => item.state === "pending").length, 1);
  assert.equal(after.invitations.find((item) => item.invitationId === invite.invitationId).state, "cancelled");
  await assert.rejects(
    env.invitations.acceptInvitation(actor(target.principalId, "old-accept"), command(invite.invitationId, 2, "old-accept")),
    failure("invitation_unavailable"),
  );
  const accepted = await env.invitations.acceptInvitation(
    actor(target.principalId, "replacement-accept"),
    command(first.invitation.invitationId, 1, "replacement-accept"),
  );
  assert.equal(accepted.state, "accepted");
  assert.equal((await state(env, mind.mindId)).memberships.filter((item) => item.principalId === target.principalId).length, 1);

  const terminal = await fixture("reader");
  await terminal.env.invitations.rejectInvitation(
    actor(terminal.target.principalId, "reject-before-reissue"),
    command(terminal.invite.invitationId, 1, "reject-before-reissue"),
  );
  const terminalReplacement = await terminal.env.invitations.reissueInvitation(
    actor(terminal.owner.principalId, "reissue-rejected"),
    command(terminal.invite.invitationId, 2, "reissue-rejected"),
  );
  const terminalState = await state(terminal.env, terminal.mind.mindId);
  assert.equal(terminalState.invitations.find((item) => item.invitationId === terminal.invite.invitationId).state, "rejected");
  assert.equal(terminalState.invitations.find((item) => item.invitationId === terminalReplacement.invitation.invitationId).state, "pending");
  assert.equal(terminalState.invitations.filter((item) => item.state === "pending").length, 1);
});

test("reissue expires an overdue replacement and creates one new pending invitation", async () => {
  const current = await fixture("reader");
  const firstReplacement = await current.env.invitations.reissueInvitation(
    actor(current.owner.principalId, "initial-reissue"),
    command(current.invite.invitationId, 1, "initial-reissue"),
  );

  const secondReplacement = await current.env.invitations.reissueInvitation(
    actor(current.owner.principalId, "reissue-after-expiry", EXPIRES),
    command(current.invite.invitationId, 2, "reissue-after-expiry"),
  );
  const final = await state(current.env, current.mind.mindId);
  assert.equal(
    final.invitations.find(
      (item) =>
        item.invitationId === firstReplacement.invitation.invitationId,
    ).state,
    "expired",
  );
  assert.equal(
    final.invitations.find(
      (item) =>
        item.invitationId === secondReplacement.invitation.invitationId,
    ).state,
    "pending",
  );
  assert.equal(
    final.invitations.filter((item) => item.state === "pending").length,
    1,
  );
  assert.equal(final.memberships.length, 1);
});

test("exact lifecycle replays recheck current principal and sender authorization", async () => {
  const accepted = await fixture("reader");
  const acceptCommand = command(accepted.invite.invitationId, 1, "accept-before-disable");
  await accepted.env.invitations.acceptInvitation(
    actor(accepted.target.principalId, "accept-before-disable"),
    acceptCommand,
  );
  assert.equal(
    await accepted.env.metadata.disablePrincipalForTest(
      accepted.target.principalId,
      "2026-08-07T06:16:00.000Z",
    ),
    true,
  );
  await assert.rejects(
    accepted.env.invitations.acceptInvitation(
      actor(accepted.target.principalId, "accept-replay-disabled", "2026-08-07T06:17:00.000Z"),
      acceptCommand,
    ),
    failure("forbidden"),
  );

  const cancelled = await fixture("editor");
  const cancelCommand = command(cancelled.invite.invitationId, 1, "cancel-before-disable");
  await cancelled.env.invitations.cancelInvitation(
    actor(cancelled.owner.principalId, "cancel-before-disable"),
    cancelCommand,
  );
  assert.equal(
    await cancelled.env.metadata.disablePrincipalForTest(
      cancelled.owner.principalId,
      "2026-08-07T06:16:00.000Z",
    ),
    true,
  );
  await assert.rejects(
    cancelled.env.invitations.cancelInvitation(
      actor(cancelled.owner.principalId, "cancel-replay-disabled", "2026-08-07T06:17:00.000Z"),
      cancelCommand,
    ),
    failure("forbidden"),
  );

  const reissued = await fixture("admin");
  const reissueCommand = command(reissued.invite.invitationId, 1, "reissue-before-disable");
  await reissued.env.invitations.reissueInvitation(
    actor(reissued.owner.principalId, "reissue-before-disable"),
    reissueCommand,
  );
  assert.equal(
    await reissued.env.metadata.disablePrincipalForTest(
      reissued.owner.principalId,
      "2026-08-07T06:16:00.000Z",
    ),
    true,
  );
  await assert.rejects(
    reissued.env.invitations.reissueInvitation(
      actor(reissued.owner.principalId, "reissue-replay-disabled", "2026-08-07T06:17:00.000Z"),
      reissueCommand,
    ),
    failure("forbidden"),
  );
});

test("metadata lifecycle boundary rejects malformed server-owned IDs and expiry", async () => {
  const { env, owner, target, mind, invite } = await fixture("editor");
  const before = await state(env, mind.mindId);
  const jobsBefore = await env.metadata.listBackgroundJobsForTest();
  const invalidMembership = await env.metadata.runOrdinaryMindTransaction(
    (transaction) => transaction.transitionInvitation({
      operation: "accept_invitation",
      principalId: target.principalId,
      invitationId: invite.invitationId,
      expectedInvitationVersion: 1,
      membershipId: "invalid membership id",
      idempotencyKey: "invalid-membership-id",
      canonicalRequestHash: "a".repeat(64),
      occurredAt: INVITED,
    }),
  );
  assert.equal(invalidMembership.kind, "invalid_record");

  for (const malformed of [
    {
      replacementInvitationId: "invalid invitation id",
      expiryJobId: "job_valid_reissue_id",
      expiresAt: EXPIRES,
      idempotencyKey: "invalid-reissue-id",
    },
    {
      replacementInvitationId: "invitation_valid_reissue_id",
      expiryJobId: "job_valid_reissue_expiry",
      expiresAt: "2026-08-08T06:15:00.000Z",
      idempotencyKey: "invalid-reissue-expiry",
    },
  ]) {
    const result = await env.metadata.runOrdinaryMindTransaction(
      (transaction) => transaction.reissueInvitation({
        principalId: owner.principalId,
        invitationId: invite.invitationId,
        expectedInvitationVersion: 1,
        replacementInvitationId: malformed.replacementInvitationId,
        expiryJobId: malformed.expiryJobId,
        expiresAt: malformed.expiresAt,
        idempotencyKey: malformed.idempotencyKey,
        canonicalRequestHash: "b".repeat(64),
        occurredAt: INVITED,
      }),
    );
    assert.equal(result.kind, "invalid_record");
  }
  assert.deepEqual(await state(env, mind.mindId), before);
  assert.deepEqual(await env.metadata.listBackgroundJobsForTest(), jobsBefore);
});

test("whole-Mind deletion removes invitation history, lifecycle idempotency and expiry jobs", async () => {
  const { env, owner, mind, invite } = await fixture("editor");
  await env.invitations.reissueInvitation(
    actor(owner.principalId, "reissue-before-delete"),
    command(invite.invitationId, 1, "reissue-before-delete"),
  );
  assert.equal((await state(env, mind.mindId)).invitations.length, 2);
  assert.equal(
    (await env.metadata.listBackgroundJobsForTest()).filter((job) =>
      job.target.kind === "expire_invitation").length,
    2,
  );

  const impact = await env.metadata.runOrdinaryMindTransaction(
    (transaction) => transaction.createOrdinaryMindDeletionImpact({
      principalId: owner.principalId,
      host: HOST,
      handle: mind.handle,
      impactId: "impact_invitation_lifecycle_delete",
      occurredAt: "2026-08-07T06:16:00.000Z",
      expiresAt: "2026-08-07T06:21:00.000Z",
    }),
  );
  assert.equal(impact.kind, "created");
  assert.equal(impact.impact.invitationCount, 2);
  assert.equal(impact.impact.backgroundJobCount, 3);
  const deleted = await env.metadata.runOrdinaryMindTransaction(
    (transaction) => transaction.deleteOrdinaryMind({
      principalId: owner.principalId,
      host: HOST,
      handle: mind.handle,
      impactId: impact.impact.impactId,
      idempotencyKey: "delete-invitation-lifecycle",
      occurredAt: "2026-08-07T06:17:00.000Z",
    }),
  );
  assert.equal(deleted.kind, "deleted");
  assert.equal(deleted.counts.invitations, 2);
  assert.equal(deleted.counts.backgroundJobs, 3);
  assert.equal(deleted.counts.idempotencyRecords, 3);
  assert.equal(await env.metadata.inspectOrdinaryMindStateForTest(mind.mindId), null);
  assert.equal(
    (await env.metadata.listBackgroundJobsForTest()).filter((job) =>
      (job.target.kind === "revision_index" && job.target.spaceId === mind.mindId) ||
      job.target.kind === "expire_invitation").length,
    0,
  );
});

test("durable expiry re-reads invitation state, survives reconstruction and loses races safely", async () => {
  const { env, target, mind, invite } = await fixture("editor");
  const job = (await env.metadata.listBackgroundJobsForTest()).find(
    (candidate) => candidate.target.kind === "expire_invitation",
  );
  assert.ok(job);
  assert.equal(job.target.kind, "expire_invitation");
  assert.deepEqual(Object.keys(job.target), ["kind", "invitationId"]);
  const now = { value: "2026-08-14T06:14:59.999Z" };
  const clock = { now: () => now.value };
  let handler = new InvitationExpiryJobHandler({ jobs: env.metadata, clock });
  const serviceActor = () => createBackgroundServiceActor({
    serviceId: "expiry-worker",
    requestId: "expiry-request",
    occurredAtUtc: now.value,
  });
  assert.equal((await handler.handle({ actor: serviceActor(), jobId: job.jobId })).kind, "not_available");
  now.value = EXPIRES;
  const [accept, expire] = await Promise.allSettled([
    env.invitations.acceptInvitation(actor(target.principalId, "accept-at-expiry", EXPIRES), command(invite.invitationId, 1, "accept-at-expiry")),
    handler.handle({ actor: serviceActor(), jobId: job.jobId }),
  ]);
  assert.equal(accept.status, "rejected");
  assert.equal(["invitation_expired", "invitation_conflict"].includes(accept.reason.code), true);
  assert.equal(expire.status, "fulfilled");
  assert.equal(expire.value.kind, "completed");
  const final = await state(env, mind.mindId);
  assert.equal(final.invitations[0].state, "expired");
  assert.equal(final.memberships.length, 1);
  handler = new InvitationExpiryJobHandler({ jobs: env.metadata, clock });
  assert.equal((await handler.handle({ actor: serviceActor(), jobId: job.jobId })).kind, "already_completed");
});

test("expiry claims are lease/version fenced and stale workers cannot settle a reclaimed job", async () => {
  const { env, mind } = await fixture("reader");
  const job = (await env.metadata.listBackgroundJobsForTest()).find(
    (candidate) => candidate.target.kind === "expire_invitation",
  );
  assert.ok(job);
  const leaseOne = "2026-08-14T06:15:01.000Z";
  const first = await env.metadata.claimInvitationExpiryJob(job.jobId, EXPIRES, leaseOne);
  assert.equal(first.kind, "claimed");
  assert.equal(
    (await env.metadata.claimInvitationExpiryJob(job.jobId, "2026-08-14T06:15:00.500Z", "2026-08-14T06:15:02.000Z")).kind,
    "not_available",
  );
  const reclaimedAt = "2026-08-14T06:15:01.000Z";
  const second = await env.metadata.claimInvitationExpiryJob(job.jobId, reclaimedAt, "2026-08-14T06:15:03.000Z");
  assert.equal(second.kind, "claimed");
  assert.notEqual(second.job.version, first.job.version);
  assert.equal(
    (await env.metadata.completeInvitationExpiryJob(job.jobId, first.job.version, "2026-08-14T06:15:01.500Z")).kind,
    "not_available",
  );
  assert.equal(
    await env.metadata.failInvitationExpiryJob(job.jobId, first.job.version, "2026-08-14T06:15:01.500Z", "2026-08-14T06:15:02.500Z"),
    false,
  );
  assert.equal(
    (await env.metadata.completeInvitationExpiryJob(job.jobId, second.job.version, "2026-08-14T06:15:02.000Z")).kind,
    "expired",
  );
  assert.equal((await state(env, mind.mindId)).invitations[0].state, "expired");
});

test("injected lifecycle and expiry failures roll back exact state and remain retryable", async () => {
  const accepted = await fixture("reader");
  const before = await state(accepted.env, accepted.mind.mindId);
  accepted.env.metadata.failNextOrdinaryMindAtForTest("invitation_lifecycle_after_membership");
  await assert.rejects(
    accepted.env.invitations.acceptInvitation(actor(accepted.target.principalId, "rollback-accept"), command(accepted.invite.invitationId, 1, "rollback-accept")),
    /injected ordinary Mind transaction failure/u,
  );
  assert.deepEqual(await state(accepted.env, accepted.mind.mindId), before);
  const recovered = await accepted.env.invitations.acceptInvitation(actor(accepted.target.principalId, "recover-accept"), command(accepted.invite.invitationId, 1, "rollback-accept"));
  assert.equal(recovered.replayed, false);

  const expiring = await fixture("reader");
  const job = (await expiring.env.metadata.listBackgroundJobsForTest()).find(
    (candidate) => candidate.target.kind === "expire_invitation",
  );
  assert.ok(job);
  const clock = { now: () => EXPIRES };
  const handler = new InvitationExpiryJobHandler({ jobs: expiring.env.metadata, clock });
  expiring.env.metadata.failNextOrdinaryMindAtForTest("invitation_expiry_before_commit");
  const failed = await handler.handle({
    actor: createBackgroundServiceActor({ serviceId: "expiry-worker", requestId: "rollback-expiry", occurredAtUtc: EXPIRES }),
    jobId: job.jobId,
  });
  assert.equal(failed.kind, "failed");
  assert.equal((await state(expiring.env, expiring.mind.mindId)).invitations[0].state, "pending");
  const retryAt = "2026-08-14T06:15:01.000Z";
  const retried = await new InvitationExpiryJobHandler({ jobs: expiring.env.metadata, clock: { now: () => retryAt } }).handle({
    actor: createBackgroundServiceActor({ serviceId: "expiry-worker", requestId: "recover-expiry", occurredAtUtc: retryAt }),
    jobId: job.jobId,
  });
  assert.equal(retried.kind, "completed");
  assert.equal((await state(expiring.env, expiring.mind.mindId)).invitations[0].state, "expired");
});
