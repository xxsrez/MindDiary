import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  AccountBootstrapFailure,
  AccountBootstrapService,
} from "@mind-diary/application-control";
import { CAPABILITIES } from "@mind-diary/domain";
import { validateOkfBundle } from "@mind-diary/okf-codec";

const NOW = "2026-08-07T03:20:00.000Z";
const encoder = new TextEncoder();

function preRegistrationActor({
  normalizedBinding = "private.member@example.com",
  suggestedDisplayName = "Trusted Profile Name",
  requestId = "request_account_bootstrap",
} = {}) {
  return {
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding,
    ...(suggestedDisplayName === undefined ? {} : { suggestedDisplayName }),
    deploymentCapabilities: CAPABILITIES,
    requestId,
    occurredAtUtc: NOW,
  };
}

function registeredActor(principalId) {
  return {
    kind: "registered_principal",
    principalId,
    authentication: { kind: "sites_identity" },
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_resolve_me",
    occurredAtUtc: NOW,
  };
}

function sequentialIds(overrides = {}) {
  let account = 0;
  return {
    nextPrincipalId: () => `principal_bootstrap_${++account}`,
    nextExternalBindingId: () => `binding_bootstrap_${account}`,
    nextSpaceId: () => `space_personal_${account}`,
    nextMembershipId: () => `membership_personal_${account}`,
    nextRevisionId: () => `revision_personal_${account}`,
    nextIndexJobId: () => `job_index_personal_${account}`,
    nextPersonalSpaceHandle: () => `personal-service-${account}`,
    ...overrides,
  };
}

function harness({ ids = sequentialIds(), failureLogger } = {}) {
  const accounts = new InMemoryRevisionMetadataStore();
  const objects = new InMemoryObjectStore();
  const service = new AccountBootstrapService({
    accounts,
    objects,
    ids,
    logger: failureLogger,
  });
  return { accounts, objects, service };
}

async function materializedPersonalBundle(accounts, objects, principalId) {
  const personal = await accounts.resolvePersonalMind(principalId);
  assert.ok(personal);
  const envelope = await accounts.readRevision(
    personal.spaceId,
    personal.headRevisionId,
  );
  assert.ok(envelope);
  const files = await Promise.all(
    envelope.manifest.entries.map(async (entry) => {
      const object = await objects.getImmutable(entry.sha256);
      assert.ok(object);
      return { path: entry.path, bytes: object.bytes };
    }),
  );
  return { personal, envelope, files };
}

test("one transaction creates a complete private Personal Mind and /me resolves immediately", async () => {
  const { accounts, objects, service } = harness();
  const result = await service.bootstrapAccount(preRegistrationActor(), {
    action: "create_isolated_account",
    displayName: "Ignored fallback",
  });

  assert.deepEqual(result, {
    principalId: "principal_bootstrap_1",
    personalMind: {
      mindId: "space_personal_1",
      route: "/me",
      visibility: "private",
      headRevisionId: "revision_personal_1",
    },
    replayed: false,
  });
  assert.equal("handle" in result.personalMind, false);
  assert.equal("displayName" in result, false);
  const initialIndex = await accounts.readRevisionIndexState(
    "space_personal_1",
    "revision_personal_1",
  );
  assert.equal(initialIndex?.status, "queued");
  const initialJobs = await accounts.listBackgroundJobsForTest();
  assert.deepEqual(
    initialJobs.map((job) => ({ id: job.jobId, target: job.target, state: job.state })),
    [{
      id: "job_index_personal_1",
      target: {
        kind: "revision_index",
        spaceId: "space_personal_1",
        revisionId: "revision_personal_1",
      },
      state: "queued",
    }],
  );
  assert.equal("normalizedBinding" in result, false);

  const resolved = await service.resolveMyMind(
    registeredActor(result.principalId),
  );
  assert.deepEqual(resolved, result.personalMind);

  const account = await accounts.readAccount(result.principalId);
  assert.ok(account);
  assert.equal(account.principal.displayName, "Trusted Profile Name");
  assert.equal(account.personalMind.space.visibility, "private");
  assert.equal(account.personalMind.space.name, "Trusted Profile Name");
  assert.equal(account.personalMind.memberships.length, 1);
  assert.equal(account.personalMind.memberships[0].role, "owner");
  assert.equal(
    account.personalMind.memberships[0].principalId,
    result.principalId,
  );
  assert.equal(account.personalMind.personalBinding.principalId, result.principalId);
  assert.match(account.personalMind.space.spaceHandle, /^personal-service-/u);

  const materialized = await materializedPersonalBundle(
    accounts,
    objects,
    result.principalId,
  );
  assert.equal(materialized.envelope.revision.revisionNumber, 1);
  assert.equal(materialized.envelope.revision.parentRevisionId, null);
  assert.equal(
    materialized.envelope.revision.revisionId,
    materialized.personal.headRevisionId,
  );
  const validation = validateOkfBundle(materialized.files);
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
  assert.equal(validation.conforms, true);
  assert.equal(validation.qualityWarnings.length, 0);
  assert.deepEqual(
    validation.files.map((file) => file.path),
    ["index.md", "log.md"],
  );
});

test("verified full name wins, while missing or invalid profile requires explicit valid first-login input", async () => {
  const trusted = harness();
  const trustedResult = await trusted.service.bootstrapAccount(
    preRegistrationActor({ suggestedDisplayName: "  Verified Name  " }),
    { action: "create_isolated_account", displayName: "Fallback Name" },
  );
  assert.equal(
    (await trusted.accounts.readAccount(trustedResult.principalId)).principal
      .displayName,
    "Verified Name",
  );

  const fallback = harness();
  const fallbackResult = await fallback.service.bootstrapAccount(
    preRegistrationActor({ suggestedDisplayName: null }),
    { action: "create_isolated_account", displayName: "  First Login Name  " },
  );
  assert.equal(
    (await fallback.accounts.readAccount(fallbackResult.principalId)).principal
      .displayName,
    "First Login Name",
  );

  for (const displayName of [undefined, "", "   ", "name\u0000forged", "x".repeat(129)]) {
    const invalid = harness();
    await assert.rejects(
      invalid.service.bootstrapAccount(
        preRegistrationActor({ suggestedDisplayName: null }),
        { action: "create_isolated_account", ...(displayName === undefined ? {} : { displayName }) },
      ),
      (error) =>
        error instanceof AccountBootstrapFailure &&
        error.code === "display_name_required",
    );
    assert.deepEqual(await invalid.accounts.inspectAccountBootstrapStateForTest(), {
      principals: 0,
      bindings: 0,
      personalMinds: 0,
      memberships: 0,
      revisions: 0,
    });
  }
});

test("exact binding replay does not require or revalidate first-login display name", async () => {
  const { accounts, service } = harness();
  const actor = preRegistrationActor({ suggestedDisplayName: "Original Verified Name" });
  const created = await service.bootstrapAccount(actor, {
    action: "create_isolated_account",
  });

  const replays = await Promise.all([
    service.bootstrapAccount(
      { ...actor, suggestedDisplayName: null, requestId: "request_replay_without_profile" },
      { action: "create_isolated_account" },
    ),
    service.bootstrapAccount(
      { ...actor, suggestedDisplayName: "Changed Profile Name", requestId: "request_replay_changed_profile" },
      { action: "create_isolated_account" },
    ),
    service.bootstrapAccount(
      { ...actor, suggestedDisplayName: "invalid\u0000profile", requestId: "request_replay_invalid_profile" },
      { action: "create_isolated_account" },
    ),
  ]);

  for (const replay of replays) {
    assert.equal(replay.replayed, true);
    assert.equal(replay.principalId, created.principalId);
    assert.equal(replay.personalMind.mindId, created.personalMind.mindId);
  }
  assert.equal(
    (await accounts.readAccount(created.principalId)).principal.displayName,
    "Original Verified Name",
  );
  assert.deepEqual(await accounts.inspectAccountBootstrapStateForTest(), {
    principals: 1,
    bindings: 1,
    personalMinds: 1,
    memberships: 1,
    revisions: 1,
  });
});

test("exact external binding retry and concurrency expose one account and one Personal Mind", async () => {
  const { accounts, service } = harness();
  const actor = preRegistrationActor();
  const outcomes = await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      service.bootstrapAccount(
        { ...actor, requestId: `request_account_race_${index}` },
        { action: "create_isolated_account" },
      ),
    ),
  );
  assert.equal(new Set(outcomes.map((item) => item.principalId)).size, 1);
  assert.equal(new Set(outcomes.map((item) => item.personalMind.mindId)).size, 1);
  assert.equal(outcomes.filter((item) => item.replayed === false).length, 1);
  assert.equal(outcomes.filter((item) => item.replayed === true).length, 23);
  assert.deepEqual(await accounts.inspectAccountBootstrapStateForTest(), {
    principals: 1,
    bindings: 1,
    personalMinds: 1,
    memberships: 1,
    revisions: 1,
  });
});

test("unknown exact identity creates an isolated account and never merges, relinks or transfers access", async () => {
  const { accounts, service } = harness();
  const first = await service.bootstrapAccount(
    preRegistrationActor({ normalizedBinding: "first.member@example.com" }),
    { action: "create_isolated_account" },
  );
  const second = await service.bootstrapAccount(
    preRegistrationActor({
      normalizedBinding: "second.member@example.com",
      requestId: "request_second_account",
    }),
    { action: "create_isolated_account" },
  );
  assert.notEqual(second.principalId, first.principalId);
  assert.notEqual(second.personalMind.mindId, first.personalMind.mindId);
  assert.deepEqual(await accounts.inspectAccountBootstrapStateForTest(), {
    principals: 2,
    bindings: 2,
    personalMinds: 2,
    memberships: 2,
    revisions: 2,
  });
});

test("denied, invalid action and stale identifier conflicts leave no partial state", async () => {
  const denied = harness();
  await assert.rejects(
    denied.service.bootstrapAccount(
      { kind: "service", requestId: "request_service", occurredAtUtc: NOW },
      { action: "create_isolated_account" },
    ),
    (error) =>
      error instanceof AccountBootstrapFailure &&
      error.code === "authentication_required",
  );
  await assert.rejects(
    denied.service.bootstrapAccount(preRegistrationActor(), { action: "merge_account" }),
    (error) =>
      error instanceof AccountBootstrapFailure &&
      error.code === "invalid_action",
  );
  assert.equal((await denied.accounts.inspectAccountBootstrapStateForTest()).principals, 0);

  const conflict = harness({
    ids: sequentialIds({ nextPrincipalId: () => "principal_collision" }),
  });
  await conflict.service.bootstrapAccount(
    preRegistrationActor({ normalizedBinding: "first.member@example.com" }),
    { action: "create_isolated_account" },
  );
  await assert.rejects(
    conflict.service.bootstrapAccount(
      preRegistrationActor({
        normalizedBinding: "unrelated.member@example.com",
        requestId: "request_collision",
      }),
      { action: "create_isolated_account" },
    ),
    (error) =>
      error instanceof AccountBootstrapFailure &&
      error.code === "account_bootstrap_conflict",
  );
  assert.deepEqual(await conflict.accounts.inspectAccountBootstrapStateForTest(), {
    principals: 1,
    bindings: 1,
    personalMinds: 1,
    memberships: 1,
    revisions: 1,
  });
});

test("injected failure at every transaction stage rolls back metadata and leaves only unreachable immutable objects", async () => {
  const stages = [
    "after_principal",
    "after_binding",
    "after_space",
    "after_membership",
    "after_revision",
    "before_commit",
  ];
  for (const stage of stages) {
    const { accounts, objects, service } = harness();
    accounts.failNextAccountBootstrapAtForTest(stage);
    await assert.rejects(
      service.bootstrapAccount(preRegistrationActor(), {
        action: "create_isolated_account",
      }),
      /injected account bootstrap transaction failure/u,
    );
    assert.deepEqual(await accounts.inspectAccountBootstrapStateForTest(), {
      principals: 0,
      bindings: 0,
      personalMinds: 0,
      memberships: 0,
      revisions: 0,
    });
    const unreachable = await objects.listImmutableObjects({
      createdBefore: "2026-08-07T03:21:00.000Z",
      excludedDigests: [],
      limit: 10,
    });
    assert.equal(unreachable.length, 2);
  }
});

test("normal logs and public results contain neither sensitive external binding nor raw trusted profile", async () => {
  const events = [];
  const { service } = harness({
    failureLogger: { record: (event) => events.push(event) },
  });
  const binding = "private.member@example.com";
  const profile = "Private Trusted Profile";
  const result = await service.bootstrapAccount(
    preRegistrationActor({
      normalizedBinding: binding,
      suggestedDisplayName: profile,
      requestId: "request_safe_bootstrap_log",
    }),
    { action: "create_isolated_account" },
  );
  assert.deepEqual(events, [
    { event: "account_bootstrap_succeeded", requestId: "request_safe_bootstrap_log" },
  ]);
  const serialized = JSON.stringify({ events, result });
  assert.equal(serialized.includes(binding), false);
  assert.equal(serialized.includes(profile), false);
  assert.equal(serialized.includes("personal-service"), false);
});
