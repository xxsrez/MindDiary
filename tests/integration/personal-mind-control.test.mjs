import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import { CanonicalRevisionCoordinator } from "@mind-diary/application-content";
import {
  AccountBootstrapService,
  PERSONAL_MIND_FORBIDDEN_LIFECYCLE_OPERATIONS,
  PersonalMindControlFailure,
  PersonalMindControlService,
} from "@mind-diary/application-control";
import { CAPABILITIES, createCanonicalRevisionEnvelope } from "@mind-diary/domain";

const NOW = "2026-08-07T03:55:00.000Z";
const LATER = "2026-08-07T03:56:00.000Z";

function preRegistrationActor(index, displayName = `Owner ${index}`) {
  return {
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding: `private.member.${index}@example.com`,
    suggestedDisplayName: displayName,
    deploymentCapabilities: CAPABILITIES,
    requestId: `request_bootstrap_${index}`,
    occurredAtUtc: NOW,
  };
}

function registeredActor(principalId, requestId = "request_personal_control") {
  return {
    kind: "registered_principal",
    principalId,
    authentication: { kind: "sites_identity" },
    deploymentCapabilities: CAPABILITIES,
    requestId,
    occurredAtUtc: LATER,
  };
}

function sequentialIds() {
  let account = 0;
  return {
    nextPrincipalId: () => `principal_personal_${++account}`,
    nextExternalBindingId: () => `binding_personal_${account}`,
    nextSpaceId: () => `space_personal_${account}`,
    nextMembershipId: () => `membership_personal_${account}`,
    nextRevisionId: () => `revision_personal_${account}`,
    nextPersonalSpaceHandle: () => `personal-service-${account}`,
  };
}

function harness({ digest, logger } = {}) {
  const metadata = new InMemoryRevisionMetadataStore();
  const objects = new InMemoryObjectStore();
  const bootstrap = new AccountBootstrapService({
    accounts: metadata,
    objects,
    ids: sequentialIds(),
  });
  const personal = new PersonalMindControlService({
    personalMinds: metadata,
    digest: digest ?? objects,
    logger,
  });
  const revisions = new CanonicalRevisionCoordinator({
    objects,
    revisions: metadata,
  });
  return { metadata, objects, bootstrap, personal, revisions };
}

async function createAccount(env, index, displayName = `Owner ${index}`) {
  return env.bootstrap.bootstrapAccount(
    preRegistrationActor(index, displayName),
    { action: "create_isolated_account" },
  );
}

async function completeState(metadata, principalId) {
  const account = await metadata.readAccount(principalId);
  assert.ok(account);
  const revisions = await metadata.listRevisions(
    account.personalMind.space.spaceId,
  );
  return { account, revisions };
}

function expectControlFailure(code) {
  return (error) => {
    assert.equal(error instanceof PersonalMindControlFailure, true);
    assert.equal(error.code, code);
    return true;
  };
}

test("/me resolves only from the authenticated principal binding and foreign Personal Mind stays hidden", async () => {
  const env = harness();
  const alpha = await createAccount(env, 1, "Alpha Owner");
  const beta = await createAccount(env, 2, "Beta Owner");

  const alphaView = await env.personal.resolveMyMind(
    registeredActor(alpha.principalId, "request_alpha_me"),
  );
  const betaView = await env.personal.resolveMyMind(
    registeredActor(beta.principalId, "request_beta_me"),
  );
  assert.equal(alphaView.personalMind.mindId, alpha.personalMind.mindId);
  assert.equal(betaView.personalMind.mindId, beta.personalMind.mindId);
  assert.notEqual(alphaView.personalMind.mindId, betaView.personalMind.mindId);
  assert.equal(alphaView.personalMind.route, "/me");
  assert.equal("handle" in alphaView.personalMind, false);

  await assert.rejects(
    env.personal.guardOrdinaryLifecycle(
      registeredActor(beta.principalId, "request_foreign_personal"),
      { mindId: alpha.personalMind.mindId, operation: "delete_space" },
    ),
    expectControlFailure("mind_not_found"),
  );
  await assert.rejects(
    env.personal.resolveMyMind({
      kind: "service",
      authentication: { kind: "internal_service", purpose: "audit" },
      requestId: "request_service_me",
      occurredAtUtc: LATER,
      deploymentCapabilities: CAPABILITIES,
    }),
    expectControlFailure("authentication_required"),
  );
});

test("content commit atomically advances the Personal Mind metadata HEAD", async () => {
  const env = harness();
  const created = await createAccount(env, 1, "Personal Owner");
  const personalMindId = created.personalMind.mindId;
  const before = await env.revisions.readHeadRevision(personalMindId);
  assert.ok(before);

  const rolledBackRevisionId = "revision_personal_content_rolled_back";
  const rolledBackEnvelope = createCanonicalRevisionEnvelope({
    revisionId: rolledBackRevisionId,
    spaceId: personalMindId,
    revisionNumber: before.envelope.revision.revisionNumber + 1,
    parentRevisionId: before.envelope.revision.revisionId,
    committedAt: "2026-08-07T03:55:30.000Z",
    committedBy: before.envelope.revision.committedBy,
    manifest: before.envelope.manifest,
    manifestHash: before.envelope.revision.manifestHash,
    summary: "Roll back Personal Mind projected HEAD",
  });
  await assert.rejects(
    env.metadata.runContentCommitTransaction(async (transaction) => {
      const staged = await transaction.commitRevision({
        expectedHeadRevisionId: before.envelope.revision.revisionId,
        envelope: rolledBackEnvelope,
      });
      assert.equal(staged.kind, "committed");
      assert.equal(await transaction.readHead(personalMindId), rolledBackRevisionId);
      throw new Error("injected Personal Mind content transaction failure");
    }),
    /injected Personal Mind content transaction failure/u,
  );
  assert.equal(
    await env.metadata.readHead(personalMindId),
    before.envelope.revision.revisionId,
  );
  assert.equal(
    (await env.metadata.readAccount(created.principalId)).personalMind.space
      .headRevisionId,
    before.envelope.revision.revisionId,
  );

  const committed = await env.revisions.commit({
    spaceId: personalMindId,
    expectedRevisionId: before.envelope.revision.revisionId,
    revisionId: "revision_personal_content_committed",
    committedAt: "2026-08-07T03:56:00.000Z",
    committedBy: before.envelope.revision.committedBy,
    summary: "Advance Personal Mind HEAD",
    files: before.files,
  });
  assert.equal(committed.kind, "committed");
  assert.equal(committed.replayed, false);

  const expectedHead = committed.envelope.revision.revisionId;
  const account = await env.metadata.readAccount(created.principalId);
  assert.ok(account);
  assert.equal(account.personalMind.space.headRevisionId, expectedHead);
  assert.equal(await env.metadata.readHead(personalMindId), expectedHead);
  assert.equal(
    (
      await env.personal.resolveMyMind(
        registeredActor(created.principalId, "request_personal_content_head"),
      )
    ).personalMind.headRevisionId,
    expectedHead,
  );
  assert.equal(
    (await env.revisions.materialize(personalMindId, expectedHead)).envelope.revision
      .revisionId,
    expectedHead,
  );
});

test("every ordinary lifecycle path is denied from server-side Personal binding before state changes", async () => {
  assert.deepEqual(PERSONAL_MIND_FORBIDDEN_LIFECYCLE_OPERATIONS, [
    "rename_space",
    "create_invitation",
    "accept_invitation",
    "reject_invitation",
    "cancel_invitation",
    "reissue_invitation",
    "add_participant",
    "change_membership_role",
    "revoke_membership",
    "leave_space",
    "change_visibility",
    "publish",
    "transfer_ownership",
    "delete_space",
  ]);
  const events = [];
  const env = harness({ logger: { record: (event) => events.push(event) } });
  const created = await createAccount(env, 1);
  const actor = registeredActor(created.principalId, "request_lifecycle_guard");
  const before = await completeState(env.metadata, created.principalId);
  const hiddenHandle = before.account.personalMind.space.spaceHandle;

  for (const operation of PERSONAL_MIND_FORBIDDEN_LIFECYCLE_OPERATIONS) {
    await assert.rejects(
      env.personal.guardOrdinaryLifecycle(actor, {
        mindId: created.personalMind.mindId,
        operation,
      }),
      expectControlFailure("personal_mind_operation_forbidden"),
    );
  }

  const after = await completeState(env.metadata, created.principalId);
  assert.deepEqual(after, before);
  assert.equal(after.account.personalMind.space.visibility, "private");
  assert.equal(after.account.personalMind.memberships.length, 1);
  assert.equal(after.account.personalMind.memberships[0].role, "owner");
  const serializedEvents = JSON.stringify(events);
  assert.equal(serializedEvents.includes(hiddenHandle), false);
  assert.equal(events.length, PERSONAL_MIND_FORBIDDEN_LIFECYCLE_OPERATIONS.length);
});

test("profile rename CAS-syncs both names without changing Personal identity, route, HEAD, or history", async () => {
  const events = [];
  const env = harness({ logger: { record: (event) => events.push(event) } });
  const created = await createAccount(env, 1, "Original Owner");
  const before = await completeState(env.metadata, created.principalId);
  const result = await env.personal.renameAccount(
    registeredActor(created.principalId, "request_profile_rename"),
    {
      displayName: "  Updated Owner  ",
      expectedProfileVersion: 1,
      idempotencyKey: "profile-rename-1",
    },
  );
  const after = await completeState(env.metadata, created.principalId);

  assert.equal(result.replayed, false);
  assert.equal(result.principal.displayName, "Updated Owner");
  assert.equal(result.personalMind.name, "Updated Owner");
  assert.equal(result.principal.profileVersion, 2);
  assert.equal(result.personalMind.metadataVersion, 2);
  assert.equal(result.personalMind.route, "/me");
  assert.equal("handle" in result.personalMind, false);
  assert.equal(after.account.principal.displayName, "Updated Owner");
  assert.equal(after.account.personalMind.space.name, "Updated Owner");
  assert.equal(
    after.account.personalMind.space.spaceId,
    before.account.personalMind.space.spaceId,
  );
  assert.equal(
    after.account.personalMind.space.spaceHandle,
    before.account.personalMind.space.spaceHandle,
  );
  assert.equal(
    after.account.personalMind.space.headRevisionId,
    before.account.personalMind.space.headRevisionId,
  );
  assert.deepEqual(after.revisions, before.revisions);
  assert.equal(after.account.personalMind.space.visibility, "private");
  assert.deepEqual(
    after.account.personalMind.memberships,
    before.account.personalMind.memberships,
  );

  const userFacing = JSON.stringify({ result, events });
  assert.equal(userFacing.includes(before.account.personalMind.space.spaceHandle), false);
  assert.equal(userFacing.includes("private.member"), false);
});

test("invalid and denied profile commands leave both metadata records and revision state unchanged", async () => {
  const env = harness();
  const created = await createAccount(env, 1, "Original Owner");
  const actor = registeredActor(created.principalId);
  const before = await completeState(env.metadata, created.principalId);
  const cases = [
    [{ displayName: "", expectedProfileVersion: 1, idempotencyKey: "valid-key" }, "invalid_display_name"],
    [{ displayName: "Name\u0000Forged", expectedProfileVersion: 1, idempotencyKey: "valid-key" }, "invalid_display_name"],
    [{ displayName: "Name", expectedProfileVersion: 0, idempotencyKey: "valid-key" }, "invalid_profile_version"],
    [{ displayName: "Name", expectedProfileVersion: 1, idempotencyKey: "" }, "invalid_idempotency_key"],
    [{ displayName: "Name", expectedProfileVersion: 1, idempotencyKey: "line\nbreak" }, "invalid_idempotency_key"],
  ];
  for (const [command, code] of cases) {
    await assert.rejects(
      env.personal.renameAccount(actor, command),
      expectControlFailure(code),
    );
  }
  await assert.rejects(
    env.personal.renameAccount(
      {
        ...actor,
        authentication: {
          kind: "mcp_token",
          tokenId: "token_read",
          effectiveScopes: ["content:read"],
        },
      },
      { displayName: "Denied", expectedProfileVersion: 1, idempotencyKey: "denied" },
    ),
    expectControlFailure("authentication_required"),
  );
  assert.deepEqual(await completeState(env.metadata, created.principalId), before);
});

test("exact canonical retry replays, while reused keys and stale versions conflict without mutation", async () => {
  const env = harness();
  const created = await createAccount(env, 1, "Original Owner");
  const actor = registeredActor(created.principalId);
  const command = {
    displayName: "Updated Owner",
    expectedProfileVersion: 1,
    idempotencyKey: "profile-retry",
  };
  const first = await env.personal.renameAccount(actor, command);
  const retry = await env.personal.renameAccount(actor, {
    ...command,
    displayName: "  Updated Owner  ",
  });
  assert.equal(first.replayed, false);
  assert.equal(retry.replayed, true);
  assert.deepEqual({ ...retry, replayed: false }, first);

  const beforeConflicts = await completeState(env.metadata, created.principalId);
  await assert.rejects(
    env.personal.renameAccount(actor, { ...command, displayName: "Different" }),
    expectControlFailure("idempotency_conflict"),
  );
  await assert.rejects(
    env.personal.renameAccount(actor, {
      displayName: "Stale Writer",
      expectedProfileVersion: 1,
      idempotencyKey: "stale-writer",
    }),
    expectControlFailure("profile_conflict"),
  );
  assert.deepEqual(
    await completeState(env.metadata, created.principalId),
    beforeConflicts,
  );
});

test("concurrent profile writers have one winner and never split principal and Personal Mind names", async () => {
  const env = harness();
  const created = await createAccount(env, 1, "Original Owner");
  const actor = registeredActor(created.principalId);
  const before = await completeState(env.metadata, created.principalId);
  const outcomes = await Promise.allSettled(
    Array.from({ length: 24 }, (_, index) =>
      env.personal.renameAccount(actor, {
        displayName: `Race Winner ${index}`,
        expectedProfileVersion: 1,
        idempotencyKey: `race-${index}`,
      }),
    ),
  );
  const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
  const losers = outcomes.filter((outcome) => outcome.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 23);
  for (const loser of losers) {
    assert.equal(loser.reason instanceof PersonalMindControlFailure, true);
    assert.equal(loser.reason.code, "profile_conflict");
  }
  const after = await completeState(env.metadata, created.principalId);
  assert.equal(after.account.principal.displayName, winners[0].value.principal.displayName);
  assert.equal(
    after.account.personalMind.space.name,
    after.account.principal.displayName,
  );
  assert.equal(after.account.principal.profileVersion, 2);
  assert.equal(after.account.personalMind.space.metadataVersion, 2);
  assert.equal(after.account.personalMind.space.headRevisionId, before.account.personalMind.space.headRevisionId);
  assert.deepEqual(after.revisions, before.revisions);
});

test("metadata-version race is detected even when principal profile version is still current", async () => {
  let releaseDigest;
  let enteredDigest;
  const digestEntered = new Promise((resolve) => {
    enteredDigest = resolve;
  });
  const digestRelease = new Promise((resolve) => {
    releaseDigest = resolve;
  });
  const env = harness({
    digest: {
      calculateSha256: async (bytes) => {
        enteredDigest();
        await digestRelease;
        return env.objects.calculateSha256(bytes);
      },
    },
  });
  const created = await createAccount(env, 1, "Original Owner");
  const before = await completeState(env.metadata, created.principalId);
  const pending = env.personal.renameAccount(registeredActor(created.principalId), {
    displayName: "Racing Rename",
    expectedProfileVersion: 1,
    idempotencyKey: "metadata-race",
  });
  await digestEntered;
  assert.equal(
    await env.metadata.bumpPersonalMindMetadataVersionForTest(
      created.principalId,
      "2026-08-07T03:55:30.000Z",
    ),
    true,
  );
  releaseDigest();
  await assert.rejects(pending, expectControlFailure("profile_conflict"));

  const after = await completeState(env.metadata, created.principalId);
  assert.equal(after.account.principal.displayName, "Original Owner");
  assert.equal(after.account.personalMind.space.name, "Original Owner");
  assert.equal(after.account.principal.profileVersion, 1);
  assert.equal(after.account.personalMind.space.metadataVersion, 2);
  assert.equal(after.account.personalMind.space.headRevisionId, before.account.personalMind.space.headRevisionId);
  assert.deepEqual(after.revisions, before.revisions);
});

test("transaction failures roll back both metadata writes and leave retry available", async () => {
  for (const stage of ["after_principal", "after_space", "before_commit"]) {
    const env = harness();
    const created = await createAccount(env, 1, "Original Owner");
    const actor = registeredActor(created.principalId, `request_failure_${stage}`);
    const before = await completeState(env.metadata, created.principalId);
    const command = {
      displayName: "Recovered Owner",
      expectedProfileVersion: 1,
      idempotencyKey: `failure-${stage}`,
    };
    env.metadata.failNextPersonalProfileAtForTest(stage);
    await assert.rejects(
      env.personal.renameAccount(actor, command),
      /injected Personal Mind profile transaction failure/u,
    );
    assert.deepEqual(await completeState(env.metadata, created.principalId), before);

    const retry = await env.personal.renameAccount(actor, command);
    assert.equal(retry.replayed, false);
    assert.equal(retry.principal.displayName, "Recovered Owner");
    const after = await completeState(env.metadata, created.principalId);
    assert.equal(after.account.personalMind.space.headRevisionId, before.account.personalMind.space.headRevisionId);
    assert.deepEqual(after.revisions, before.revisions);
  }
});
