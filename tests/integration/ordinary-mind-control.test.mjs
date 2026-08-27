import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  AccountBootstrapService,
  OrdinaryMindControlFailure,
  OrdinaryMindControlService,
} from "@mind-diary/application-control";
import { CAPABILITIES, verifiedSpaceHost } from "@mind-diary/domain";
import { validateOkfBundle } from "@mind-diary/okf-codec";

const CREATED_AT = "2026-08-07T04:30:00.000Z";
const RENAMED_AT = "2026-08-07T04:31:00.000Z";
const HOST = verifiedSpaceHost("mind-diary.example");

function preRegistrationActor(index, displayName = `Owner ${index}`) {
  return {
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding: `private.owner.${index}@example.com`,
    suggestedDisplayName: displayName,
    deploymentCapabilities: CAPABILITIES,
    requestId: `request_bootstrap_${index}`,
    occurredAtUtc: CREATED_AT,
  };
}

function registeredActor(
  principalId,
  requestId = "request_ordinary_mind",
  occurredAtUtc = RENAMED_AT,
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
    nextPrincipalId: () => `principal_ordinary_${++account}`,
    nextExternalBindingId: () => `binding_ordinary_${account}`,
    nextSpaceId: () => `space_personal_ordinary_${account}`,
    nextMembershipId: () => `membership_personal_ordinary_${account}`,
    nextRevisionId: () => `revision_personal_ordinary_${account}`,
    nextIndexJobId: () => `job_index_personal_ordinary_${account}`,
    nextPersonalSpaceHandle: () => `personal-service-ordinary-${account}`,
  };
}

function ordinaryIds(prefix = "ordinary") {
  let spaces = 0;
  let memberships = 0;
  let revisions = 0;
  let indexJobs = 0;
  return {
    nextSpaceId: () => `space_${prefix}_${++spaces}`,
    nextMembershipId: () => `membership_${prefix}_${++memberships}`,
    nextRevisionId: () => `revision_${prefix}_${++revisions}`,
    nextIndexJobId: () => `job_index_${prefix}_${++indexJobs}`,
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
    logger: { record: (event) => events.push(event) },
  });
  return { metadata, objects, events, bootstrap, ordinary };
}

async function createAccount(env, index, displayName = `Owner ${index}`) {
  return env.bootstrap.bootstrapAccount(
    preRegistrationActor(index, displayName),
    { action: "create_isolated_account" },
  );
}

async function ordinaryState(env, mindId) {
  const state = await env.metadata.inspectOrdinaryMindStateForTest(mindId);
  assert.ok(state);
  return state;
}

async function materializeBundle(env, state) {
  assert.equal(state.revisions.length, 1);
  return Promise.all(
    state.revisions[0].manifest.entries.map(async (entry) => {
      const object = await env.objects.getSpaceCanonicalObject(
        "markdown",
        state.space.spaceId,
        entry.sha256,
      ) ?? await env.objects.getImmutable(entry.sha256);
      assert.ok(object);
      return { path: entry.path, bytes: object.bytes };
    }),
  );
}

function expectFailure(code) {
  return (error) => {
    assert.equal(error instanceof OrdinaryMindControlFailure, true);
    assert.equal(error.code, code);
    return true;
  };
}

test("create atomically publishes one private ordinary Mind, initial HEAD and sole Owner", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Private Owner Profile");
  const actor = registeredActor(
    owner.principalId,
    "request_create_research_notes",
    CREATED_AT,
  );
  const created = await env.ordinary.createSpaceWithOwner(actor, {
    name: "  Research Notes  ",
    handle: "research-notes",
    idempotencyKey: "create-research-notes",
  });

  assert.deepEqual(created, {
    mindId: "space_ordinary_1",
    route: "/research-notes",
    handle: "research-notes",
    name: "Research Notes",
    description: null,
    visibility: "private",
    metadataVersion: 1,
    accessVersion: 1,
    headRevisionId: "revision_ordinary_1",
    replayed: false,
  });
  const state = await ordinaryState(env, created.mindId);
  assert.equal(state.space.spaceHandle, "research-notes");
  assert.equal(state.space.normalizedHandle, "research-notes");
  assert.equal(state.space.visibility, "private");
  assert.equal(state.space.description, null);
  assert.equal(state.space.headRevisionId, state.revisions[0].revision.revisionId);
  assert.equal(state.revisions[0].revision.revisionNumber, 1);
  assert.equal(state.revisions[0].revision.parentRevisionId, null);
  assert.equal(state.memberships.length, 1);
  assert.equal(state.memberships[0].role, "owner");
  assert.equal(state.memberships[0].state, "active");
  assert.equal(state.memberships[0].principalId, owner.principalId);
  assert.equal(state.reservation.spaceId, created.mindId);
  assert.equal(
    (await env.metadata.readRevisionIndexState(
      created.mindId,
      state.space.headRevisionId,
    ))?.status,
    "queued",
  );
  assert.ok(
    (await env.metadata.listBackgroundJobsForTest()).some((job) =>
      job.jobId === "job_index_ordinary_1" &&
      job.target.kind === "revision_index" &&
      job.target.spaceId === created.mindId),
  );
  assert.deepEqual(
    await env.metadata.resolveHandle({ host: HOST, handle: "research-notes" }),
    { kind: "resolved", spaceId: created.mindId },
  );

  const validation = validateOkfBundle(await materializeBundle(env, state));
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
  assert.equal(validation.conforms, true);
  assert.deepEqual(
    validation.files.map((file) => file.path),
    ["index.md", "log.md"],
  );

  const sameDisplayName = await env.ordinary.createSpaceWithOwner(actor, {
    name: "Research Notes",
    handle: "research-library",
    idempotencyKey: "create-research-library",
  });
  assert.equal(sameDisplayName.name, created.name);
  assert.notEqual(sameDisplayName.handle, created.handle);
  assert.notEqual(sameDisplayName.mindId, created.mindId);
  assert.deepEqual(await env.metadata.inspectOrdinaryMindTotalsForTest(), {
    minds: 2,
    reservations: 2,
    memberships: 2,
    revisions: 2,
    idempotencyRecords: 2,
  });
});

test("ordinary handle uniqueness is scoped to the trusted verified host", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const actor = registeredActor(owner.principalId, "request_host_a", CREATED_AT);
  const hostA = await env.ordinary.createSpaceWithOwner(actor, {
    name: "Host A Mind",
    handle: "shared-handle",
    idempotencyKey: "host-a-create",
  });
  const hostBValue = verifiedSpaceHost("other-mind-diary.example");
  const hostBService = new OrdinaryMindControlService({
    ordinaryMinds: env.metadata,
    objects: env.objects,
    ids: ordinaryIds("other_host"),
    host: hostBValue,
  });
  const hostB = await hostBService.createSpaceWithOwner(
    registeredActor(owner.principalId, "request_host_b", CREATED_AT),
    {
      name: "Host B Mind",
      handle: "shared-handle",
      idempotencyKey: "host-b-create",
    },
  );

  assert.notEqual(hostB.mindId, hostA.mindId);
  assert.deepEqual(
    await env.metadata.resolveHandle({ host: HOST, handle: "shared-handle" }),
    { kind: "resolved", spaceId: hostA.mindId },
  );
  assert.deepEqual(
    await env.metadata.resolveHandle({ host: hostBValue, handle: "shared-handle" }),
    { kind: "resolved", spaceId: hostB.mindId },
  );
  assert.equal((await ordinaryState(env, hostA.mindId)).reservation.host, HOST);
  assert.equal(
    (await ordinaryState(env, hostB.mindId)).reservation.host,
    hostBValue,
  );
});

test("invalid, denied, reserved and occupied create commands leave no partial reachable aggregate", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const actor = registeredActor(owner.principalId, "request_create_invalid", CREATED_AT);
  const beforeReachable = await env.metadata.listReachableObjectDigests();

  for (const [command, code] of [
    [{ name: "", handle: "valid-handle", idempotencyKey: "invalid-name" }, "invalid_display_name"],
    [{ name: "Mind", handle: "Not-Canonical", idempotencyKey: "invalid-handle" }, "invalid_handle"],
    [{ name: "Mind", handle: "me", idempotencyKey: "reserved-me" }, "handle_unavailable"],
    [{ name: "Mind", handle: "admin", idempotencyKey: "reserved-admin" }, "handle_unavailable"],
    [{ name: "Mind", handle: "%61bc", idempotencyKey: "encoded-alias" }, "invalid_handle"],
  ]) {
    await assert.rejects(
      env.ordinary.createSpaceWithOwner(actor, command),
      expectFailure(code),
    );
  }
  await assert.rejects(
    env.ordinary.createSpaceWithOwner(
      {
        ...actor,
        authentication: {
          kind: "mcp_token",
          tokenId: "token_control_denied",
          effectiveScopes: ["content:read", "content:write"],
        },
      },
      { name: "Denied", handle: "denied-mind", idempotencyKey: "denied" },
    ),
    expectFailure("authentication_required"),
  );
  await assert.rejects(
    env.ordinary.createSpaceWithOwner(
      registeredActor("principal_missing", "request_forged_principal", CREATED_AT),
      { name: "Denied", handle: "missing-owner", idempotencyKey: "missing-owner" },
    ),
    expectFailure("authentication_required"),
  );
  assert.deepEqual(await env.metadata.inspectOrdinaryMindTotalsForTest(), {
    minds: 0,
    reservations: 0,
    memberships: 0,
    revisions: 0,
    idempotencyRecords: 0,
  });
  assert.deepEqual(await env.metadata.listReachableObjectDigests(), beforeReachable);

  const created = await env.ordinary.createSpaceWithOwner(actor, {
    name: "Occupied",
    handle: "occupied-mind",
    idempotencyKey: "occupied-owner",
  });
  const beforeConflict = await ordinaryState(env, created.mindId);
  await assert.rejects(
    env.ordinary.createSpaceWithOwner(actor, {
      name: "Other",
      handle: "occupied-mind",
      idempotencyKey: "occupied-candidate",
    }),
    expectFailure("handle_unavailable"),
  );
  assert.deepEqual(await ordinaryState(env, created.mindId), beforeConflict);
  assert.equal((await env.metadata.inspectOrdinaryMindTotalsForTest()).minds, 1);
});

test("create exact retry is stable before generated-record checks and changed payload conflicts", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const actor = registeredActor(owner.principalId, "request_create_retry", CREATED_AT);
  const command = {
    name: "Retry Mind",
    handle: "retry-mind",
    idempotencyKey: "same-create-key",
  };
  const first = await env.ordinary.createSpaceWithOwner(actor, command);
  const retry = await env.ordinary.createSpaceWithOwner(actor, {
    ...command,
    name: "  Retry Mind  ",
  });
  assert.equal(first.replayed, false);
  assert.equal(retry.replayed, true);
  assert.deepEqual({ ...retry, replayed: false }, first);

  const beforeConflict = await ordinaryState(env, first.mindId);
  await assert.rejects(
    env.ordinary.createSpaceWithOwner(actor, {
      ...command,
      name: "Different Payload",
    }),
    expectFailure("idempotency_conflict"),
  );
  assert.deepEqual(await ordinaryState(env, first.mindId), beforeConflict);
  assert.deepEqual(await env.metadata.inspectOrdinaryMindTotalsForTest(), {
    minds: 1,
    reservations: 1,
    memberships: 1,
    revisions: 1,
    idempotencyRecords: 1,
  });
});

test("concurrent creates have one atomic winner for both exact retry and handle uniqueness", async () => {
  const exact = harness();
  const exactOwner = await createAccount(exact, 1);
  const exactActor = registeredActor(exactOwner.principalId, "request_create_race", CREATED_AT);
  const exactOutcomes = await Promise.all(
    Array.from({ length: 24 }, () =>
      exact.ordinary.createSpaceWithOwner(exactActor, {
        name: "Exact Race",
        handle: "exact-race",
        idempotencyKey: "exact-race-key",
      }),
    ),
  );
  assert.equal(new Set(exactOutcomes.map((result) => result.mindId)).size, 1);
  assert.equal(exactOutcomes.filter((result) => result.replayed === false).length, 1);
  assert.equal(exactOutcomes.filter((result) => result.replayed === true).length, 23);
  assert.deepEqual(await exact.metadata.inspectOrdinaryMindTotalsForTest(), {
    minds: 1,
    reservations: 1,
    memberships: 1,
    revisions: 1,
    idempotencyRecords: 1,
  });

  const unique = harness();
  const uniqueOwner = await createAccount(unique, 1);
  const uniqueActor = registeredActor(uniqueOwner.principalId, "request_handle_race", CREATED_AT);
  const uniquenessOutcomes = await Promise.allSettled(
    Array.from({ length: 24 }, (_, index) =>
      unique.ordinary.createSpaceWithOwner(uniqueActor, {
        name: `Handle Racer ${index}`,
        handle: "unique-winner",
        idempotencyKey: `unique-race-${index}`,
      }),
    ),
  );
  const winners = uniquenessOutcomes.filter((outcome) => outcome.status === "fulfilled");
  const losers = uniquenessOutcomes.filter((outcome) => outcome.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 23);
  for (const loser of losers) {
    assert.equal(loser.reason instanceof OrdinaryMindControlFailure, true);
    assert.equal(loser.reason.code, "handle_unavailable");
  }
  const final = await ordinaryState(unique, winners[0].value.mindId);
  assert.equal(final.space.name, winners[0].value.name);
  assert.equal(final.memberships.length, 1);
  assert.equal(final.memberships[0].role, "owner");
  assert.equal(final.revisions.length, 1);
  assert.deepEqual(await unique.metadata.inspectOrdinaryMindTotalsForTest(), {
    minds: 1,
    reservations: 1,
    memberships: 1,
    revisions: 1,
    idempotencyRecords: 1,
  });
});

test("rename changes only non-unique display name under metadata CAS", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const actor = registeredActor(owner.principalId, "request_rename_success");
  const created = await env.ordinary.createSpaceWithOwner(
    registeredActor(owner.principalId, "request_create_for_rename", CREATED_AT),
    { name: "Original Name", handle: "stable-handle", idempotencyKey: "create-stable" },
  );
  const before = await ordinaryState(env, created.mindId);
  const renamed = await env.ordinary.renameSpace(actor, {
    mindId: created.mindId,
    name: "  Renamed Library  ",
    expectedMetadataVersion: 1,
    idempotencyKey: "rename-stable",
  });
  const after = await ordinaryState(env, created.mindId);

  assert.equal(renamed.name, "Renamed Library");
  assert.equal(renamed.metadataVersion, 2);
  assert.equal(renamed.replayed, false);
  assert.equal(after.space.name, "Renamed Library");
  assert.equal(after.space.spaceId, before.space.spaceId);
  assert.equal(after.space.spaceHandle, before.space.spaceHandle);
  assert.equal(after.space.normalizedHandle, before.space.normalizedHandle);
  assert.equal(after.space.visibility, before.space.visibility);
  assert.equal(after.space.accessVersion, before.space.accessVersion);
  assert.equal(after.space.headRevisionId, before.space.headRevisionId);
  assert.equal(after.reservation.canonicalHandle, before.reservation.canonicalHandle);
  assert.deepEqual(after.memberships, before.memberships);
  assert.deepEqual(after.revisions, before.revisions);
  assert.equal("newHandle" in renamed, false);

  const duplicate = await env.ordinary.createSpaceWithOwner(
    registeredActor(owner.principalId, "request_duplicate_name", CREATED_AT),
    { name: "Renamed Library", handle: "different-handle", idempotencyKey: "duplicate-name" },
  );
  assert.equal(duplicate.name, renamed.name);
  assert.notEqual(duplicate.handle, renamed.handle);
});

test("ordinary description create and partial metadata update normalize atomically without content effects", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const actor = registeredActor(owner.principalId, "request_description_owner", CREATED_AT);

  const omitted = await env.ordinary.createSpaceWithOwner(actor, {
    name: "Omitted",
    handle: "description-omitted",
    idempotencyKey: "description-omitted",
  });
  assert.equal(omitted.description, null);
  const explicitNull = await env.ordinary.createSpaceWithOwner(actor, {
    name: "Null",
    handle: "description-null",
    description: null,
    idempotencyKey: "description-null",
  });
  assert.equal(explicitNull.description, null);
  const empty = await env.ordinary.createSpaceWithOwner(actor, {
    name: "Empty",
    handle: "description-empty",
    description: " \r\n\t ",
    idempotencyKey: "description-empty",
  });
  assert.equal(empty.description, null);
  const created = await env.ordinary.createSpaceWithOwner(actor, {
    name: "Described",
    handle: "description-valid",
    description: "  Ａ first line\r\nsecond line  ",
    idempotencyKey: "description-valid",
  });
  assert.equal(created.description, "A first line\nsecond line");
  const createReplay = await env.ordinary.createSpaceWithOwner(actor, {
    name: "Described",
    handle: "description-valid",
    description: "A first line\nsecond line",
    idempotencyKey: "description-valid",
  });
  assert.equal(createReplay.replayed, true);
  assert.deepEqual({ ...createReplay, replayed: false }, created);
  await assert.rejects(env.ordinary.createSpaceWithOwner(actor, {
    name: "Described",
    handle: "description-valid",
    description: "Changed create payload",
    idempotencyKey: "description-valid",
  }), expectFailure("idempotency_conflict"));

  const before = await ordinaryState(env, created.mindId);
  const updated = await env.ordinary.renameSpace(
    registeredActor(owner.principalId, "request_description_combined"),
    {
      mindId: created.mindId,
      name: "  Updated Mind  ",
      description: "  Updated\rdescription  ",
      expectedMetadataVersion: before.space.metadataVersion,
      idempotencyKey: "description-combined",
    },
  );
  const after = await ordinaryState(env, created.mindId);
  assert.equal(updated.name, "Updated Mind");
  assert.equal(updated.description, "Updated\ndescription");
  assert.equal(updated.metadataVersion, before.space.metadataVersion + 1);
  assert.equal(after.space.description, "Updated\ndescription");
  assert.equal(after.space.accessVersion, before.space.accessVersion);
  assert.equal(after.space.headRevisionId, before.space.headRevisionId);
  assert.deepEqual(after.revisions, before.revisions);
  assert.deepEqual(after.memberships, before.memberships);

  const replay = await env.ordinary.renameSpace(actor, {
    mindId: created.mindId,
    name: "Updated Mind",
    description: "Updated\ndescription",
    expectedMetadataVersion: before.space.metadataVersion,
    idempotencyKey: "description-combined",
  });
  assert.equal(replay.replayed, true);
  assert.deepEqual({ ...replay, replayed: false }, updated);
  await assert.rejects(
    env.ordinary.renameSpace(actor, {
      mindId: created.mindId,
      description: "Different",
      expectedMetadataVersion: updated.metadataVersion,
      idempotencyKey: "description-combined",
    }),
    expectFailure("idempotency_conflict"),
  );

  const noOpBefore = await ordinaryState(env, created.mindId);
  const noOp = await env.ordinary.renameSpace(actor, {
    mindId: created.mindId,
    description: " Updated\r\ndescription ",
    expectedMetadataVersion: updated.metadataVersion,
    idempotencyKey: "description-no-op",
  });
  assert.equal(noOp.metadataVersion, updated.metadataVersion);
  assert.equal(noOp.replayed, false);
  assert.deepEqual(await ordinaryState(env, created.mindId), noOpBefore);
  const noOpReplay = await env.ordinary.renameSpace(actor, {
    mindId: created.mindId,
    description: "Updated\ndescription",
    expectedMetadataVersion: updated.metadataVersion,
    idempotencyKey: "description-no-op",
  });
  assert.equal(noOpReplay.replayed, true);

  const cleared = await env.ordinary.renameSpace(actor, {
    mindId: created.mindId,
    description: " \n ",
    expectedMetadataVersion: updated.metadataVersion,
    idempotencyKey: "description-clear",
  });
  assert.equal(cleared.description, null);
  assert.equal(cleared.metadataVersion, updated.metadataVersion + 1);
  const explicitNullNoOp = await env.ordinary.renameSpace(actor, {
    mindId: created.mindId,
    description: null,
    expectedMetadataVersion: cleared.metadataVersion,
    idempotencyKey: "description-null-no-op",
  });
  assert.equal(explicitNullNoOp.metadataVersion, cleared.metadataVersion);
});

test("description validation, CAS and ordinary-only authorization fail closed without partial update", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const editor = await createAccount(env, 2);
  const reader = await createAccount(env, 3);
  const visitor = await createAccount(env, 4);
  const ownerActor = registeredActor(owner.principalId, "request_description_boundaries");
  const created = await env.ordinary.createSpaceWithOwner(
    registeredActor(owner.principalId, "request_description_target", CREATED_AT),
    {
      name: "Boundary Target",
      handle: "description-boundaries",
      description: "Initial",
      idempotencyKey: "description-boundaries",
    },
  );
  for (const [principal, role] of [[editor, "editor"], [reader, "reader"]]) {
    assert.equal(await env.metadata.grantOrdinaryMembershipForTest({
      membershipId: `membership_description_${role}`,
      spaceId: created.mindId,
      principalId: principal.principalId,
      role,
      state: "active",
      version: 1,
      createdAt: RENAMED_AT,
      createdBy: owner.principalId,
      updatedAt: RENAMED_AT,
      updatedBy: owner.principalId,
    }, RENAMED_AT), true);
  }
  assert.equal(
    await env.metadata.changeOrdinaryVisibilityForTest(
      created.mindId,
      "public",
      "2026-08-07T04:32:00.000Z",
    ),
    true,
  );
  const current = await ordinaryState(env, created.mindId);
  for (const principal of [editor, reader, visitor]) {
    await assert.rejects(env.ordinary.renameSpace(
      registeredActor(principal.principalId, `request_denied_${principal.principalId}`),
      {
        mindId: created.mindId,
        description: "Denied",
        expectedMetadataVersion: current.space.metadataVersion,
        idempotencyKey: `description-denied-${principal.principalId}`,
      },
    ), expectFailure("forbidden"));
  }

  const stable = await ordinaryState(env, created.mindId);
  for (const invalid of [
    "x".repeat(501),
    "bad\0value",
    "bad\u000bvalue",
    "bad\u0085value",
    "\ud800",
  ]) {
    await assert.rejects(env.ordinary.renameSpace(ownerActor, {
      mindId: created.mindId,
      name: "Must Not Apply",
      description: invalid,
      expectedMetadataVersion: stable.space.metadataVersion,
      idempotencyKey: `invalid-description-${invalid.length}-${invalid.charCodeAt(0)}`,
    }), expectFailure("invalid_description"));
  }
  const personalBefore = await env.metadata.readPersonalMindProfile(owner.principalId);
  assert.ok(personalBefore);
  await assert.rejects(env.ordinary.renameSpace(ownerActor, {
    mindId: created.mindId,
    description: "Valid",
    expectedMetadataVersion: stable.space.metadataVersion - 1,
    idempotencyKey: "description-stale",
  }), expectFailure("metadata_conflict"));
  await assert.rejects(env.ordinary.renameSpace(ownerActor, {
    mindId: created.mindId,
    expectedMetadataVersion: stable.space.metadataVersion,
    idempotencyKey: "description-empty-update",
  }), expectFailure("invalid_request"));
  await assert.rejects(env.ordinary.renameSpace(ownerActor, {
    mindId: created.mindId,
    description: "Valid",
    expectedMetadataVersion: stable.space.metadataVersion,
    idempotencyKey: "description-unknown-field",
    isPersonal: false,
  }), expectFailure("invalid_request"));
  await assert.rejects(env.ordinary.renameSpace(ownerActor, {
    mindId: owner.personalMind.mindId,
    description: "Forbidden Personal metadata",
    expectedMetadataVersion: 1,
    idempotencyKey: "description-personal",
  }), expectFailure("personal_mind_operation_forbidden"));
  assert.deepEqual(
    await env.metadata.readPersonalMindProfile(owner.principalId),
    personalBefore,
  );
  assert.deepEqual(await ordinaryState(env, created.mindId), stable);
});

test("legacy durable ordinary metadata reconstructs missing description as null without touching Personal Mind", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Legacy Owner");
  const created = await env.ordinary.createSpaceWithOwner(
    registeredActor(owner.principalId, "request_legacy_description", CREATED_AT),
    {
      name: "Legacy Ordinary",
      handle: "legacy-description",
      idempotencyKey: "legacy-description",
    },
  );
  const snapshot = env.metadata.exportDurableSnapshot();
  const stored = snapshot.knowledgeSpaces.get(created.mindId);
  assert.ok(stored);
  const { description: _description, ...legacyRecord } = stored;
  snapshot.knowledgeSpaces.set(created.mindId, Object.freeze(legacyRecord));

  const restored = InMemoryRevisionMetadataStore.fromDurableSnapshot(snapshot);
  const ordinary = await restored.inspectOrdinaryMindStateForTest(created.mindId);
  assert.ok(ordinary);
  assert.equal(ordinary.space.description, null);
  assert.equal(ordinary.space.metadataVersion, stored.metadataVersion);
  assert.equal(ordinary.space.updatedAt, stored.updatedAt);

  const personal = await restored.readPersonalMindProfile(owner.principalId);
  assert.ok(personal);
  assert.equal("description" in personal.personalMind, false);
  const reconstructed = restored.exportDurableSnapshot();
  const personalSpace = reconstructed.knowledgeSpaces.get(owner.personalMind.mindId);
  assert.ok(personalSpace);
  assert.equal("description" in personalSpace, false);
});

test("rename replay, payload conflict, stale CAS, Personal target and unauthorized actor fail closed", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Owner Profile");
  const stranger = await createAccount(env, 2, "Stranger Profile");
  const ownerActor = registeredActor(owner.principalId, "request_rename_retry");
  const created = await env.ordinary.createSpaceWithOwner(
    registeredActor(owner.principalId, "request_create_retry_target", CREATED_AT),
    { name: "Original", handle: "rename-retry", idempotencyKey: "create-retry-target" },
  );
  const command = {
    mindId: created.mindId,
    name: "Updated",
    expectedMetadataVersion: 1,
    idempotencyKey: "rename-retry-key",
  };
  const first = await env.ordinary.renameSpace(ownerActor, command);
  const retry = await env.ordinary.renameSpace(ownerActor, {
    ...command,
    name: "  Updated  ",
  });
  assert.equal(retry.replayed, true);
  assert.deepEqual({ ...retry, replayed: false }, first);

  const beforeDenied = await ordinaryState(env, created.mindId);
  await assert.rejects(
    env.ordinary.renameSpace(ownerActor, { ...command, name: "Different" }),
    expectFailure("idempotency_conflict"),
  );
  await assert.rejects(
    env.ordinary.renameSpace(ownerActor, {
      ...command,
      name: "Stale",
      idempotencyKey: "rename-stale",
    }),
    expectFailure("metadata_conflict"),
  );
  await assert.rejects(
    env.ordinary.renameSpace(
      registeredActor(stranger.principalId, "request_unauthorized_rename"),
      {
        mindId: created.mindId,
        name: "Unauthorized",
        expectedMetadataVersion: 2,
        idempotencyKey: "unauthorized-rename",
      },
    ),
    expectFailure("forbidden"),
  );
  await assert.rejects(
    env.ordinary.renameSpace(ownerActor, {
      mindId: owner.personalMind.mindId,
      name: "Personal Rename",
      expectedMetadataVersion: 1,
      idempotencyKey: "personal-rename",
    }),
    expectFailure("personal_mind_operation_forbidden"),
  );
  await assert.rejects(
    env.ordinary.renameSpace(
      registeredActor(stranger.principalId, "request_foreign_personal"),
      {
        mindId: owner.personalMind.mindId,
        name: "Foreign Personal",
        expectedMetadataVersion: 1,
        idempotencyKey: "foreign-personal",
      },
    ),
    expectFailure("mind_not_found"),
  );
  assert.deepEqual(await ordinaryState(env, created.mindId), beforeDenied);
});

test("idempotency replay rechecks current active target and settings authorization", async () => {
  const deleting = harness();
  const deletingOwner = await createAccount(deleting, 1);
  const deletingActor = registeredActor(
    deletingOwner.principalId,
    "request_create_before_delete",
    CREATED_AT,
  );
  const createCommand = {
    name: "Deleting Mind",
    handle: "deleting-mind",
    idempotencyKey: "create-before-delete",
  };
  const created = await deleting.ordinary.createSpaceWithOwner(
    deletingActor,
    createCommand,
  );
  assert.equal(
    await deleting.metadata.markOrdinaryMindDeletingForTest(
      created.mindId,
      RENAMED_AT,
    ),
    true,
  );
  await assert.rejects(
    deleting.ordinary.createSpaceWithOwner(deletingActor, createCommand),
    expectFailure("mind_not_found"),
  );

  const revoked = harness();
  const owner = await createAccount(revoked, 1);
  const admin = await createAccount(revoked, 2);
  const target = await revoked.ordinary.createSpaceWithOwner(
    registeredActor(owner.principalId, "request_create_admin_target", CREATED_AT),
    { name: "Admin Target", handle: "admin-target", idempotencyKey: "admin-target" },
  );
  assert.equal(
    await revoked.metadata.grantOrdinaryMembershipForTest(
      {
        membershipId: "membership_test_admin",
        spaceId: target.mindId,
        principalId: admin.principalId,
        role: "admin",
        state: "active",
        version: 1,
        createdAt: RENAMED_AT,
        createdBy: owner.principalId,
        updatedAt: RENAMED_AT,
        updatedBy: owner.principalId,
      },
      RENAMED_AT,
    ),
    true,
  );
  const beforeRename = await ordinaryState(revoked, target.mindId);
  const adminActor = registeredActor(
    admin.principalId,
    "request_admin_rename",
    "2026-08-07T04:32:00.000Z",
  );
  const renameCommand = {
    mindId: target.mindId,
    name: "Admin Renamed",
    description: "Updated by current Admin",
    expectedMetadataVersion: beforeRename.space.metadataVersion,
    idempotencyKey: "admin-rename-replay",
  };
  const renamed = await revoked.ordinary.renameSpace(adminActor, renameCommand);
  assert.equal(renamed.name, "Admin Renamed");
  assert.equal(renamed.description, "Updated by current Admin");
  assert.equal(
    await revoked.metadata.revokeOrdinaryMembershipForTest(
      target.mindId,
      admin.principalId,
      "2026-08-07T04:33:00.000Z",
    ),
    true,
  );
  const afterRevoke = await ordinaryState(revoked, target.mindId);
  await assert.rejects(
    revoked.ordinary.renameSpace(adminActor, renameCommand),
    expectFailure("forbidden"),
  );
  assert.deepEqual(await ordinaryState(revoked, target.mindId), afterRevoke);
});

test("concurrent rename writers have one winner and an exact final state", async () => {
  const env = harness();
  const owner = await createAccount(env, 1);
  const created = await env.ordinary.createSpaceWithOwner(
    registeredActor(owner.principalId, "request_create_rename_race", CREATED_AT),
    { name: "Original", handle: "rename-race", idempotencyKey: "create-rename-race" },
  );
  const before = await ordinaryState(env, created.mindId);
  const outcomes = await Promise.allSettled(
    Array.from({ length: 24 }, (_, index) =>
      env.ordinary.renameSpace(
        registeredActor(owner.principalId, `request_rename_race_${index}`),
        {
          mindId: created.mindId,
          name: `Winner ${index}`,
          expectedMetadataVersion: 1,
          idempotencyKey: `rename-race-${index}`,
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
  const after = await ordinaryState(env, created.mindId);
  assert.equal(after.space.name, winners[0].value.name);
  assert.equal(after.space.metadataVersion, 2);
  assert.equal(after.space.spaceHandle, before.space.spaceHandle);
  assert.equal(after.space.accessVersion, before.space.accessVersion);
  assert.equal(after.space.headRevisionId, before.space.headRevisionId);
  assert.deepEqual(after.memberships, before.memberships);
  assert.deepEqual(after.revisions, before.revisions);
});

test("every injected create failure rolls back handle, Space, Owner, revision and idempotency", async () => {
  for (const stage of [
    "create_after_handle",
    "create_after_revision",
    "create_after_space",
    "create_after_membership",
    "create_after_idempotency",
    "create_before_commit",
  ]) {
    const env = harness();
    const owner = await createAccount(env, 1);
    const actor = registeredActor(owner.principalId, `request_create_failure_${stage}`, CREATED_AT);
    const command = {
      name: "Rollback Mind",
      handle: "rollback-mind",
      idempotencyKey: `rollback-${stage}`,
    };
    const reachableBefore = await env.metadata.listReachableObjectDigests();
    env.metadata.failNextOrdinaryMindAtForTest(stage);
    await assert.rejects(
      env.ordinary.createSpaceWithOwner(actor, command),
      /injected ordinary Mind transaction failure/u,
    );
    assert.deepEqual(await env.metadata.inspectOrdinaryMindTotalsForTest(), {
      minds: 0,
      reservations: 0,
      memberships: 0,
      revisions: 0,
      idempotencyRecords: 0,
    });
    assert.deepEqual(
      await env.metadata.resolveHandle({ host: HOST, handle: command.handle }),
      { kind: "not_found" },
    );
    assert.deepEqual(await env.metadata.listReachableObjectDigests(), reachableBefore);

    const recovered = await env.ordinary.createSpaceWithOwner(actor, command);
    assert.equal(recovered.replayed, false);
    const final = await ordinaryState(env, recovered.mindId);
    assert.equal(final.memberships.length, 1);
    assert.equal(final.memberships[0].role, "owner");
    assert.equal(final.revisions.length, 1);
  }

  const commitFailure = harness();
  const owner = await createAccount(commitFailure, 1);
  const actor = registeredActor(owner.principalId, "request_revision_failure", CREATED_AT);
  const reachableBefore = await commitFailure.metadata.listReachableObjectDigests();
  commitFailure.metadata.failNextCommitForTest();
  await assert.rejects(
    commitFailure.ordinary.createSpaceWithOwner(actor, {
      name: "Revision Failure",
      handle: "revision-failure",
      idempotencyKey: "revision-failure",
    }),
    /injected revision metadata transaction failure/u,
  );
  assert.equal((await commitFailure.metadata.inspectOrdinaryMindTotalsForTest()).minds, 0);
  assert.deepEqual(await commitFailure.metadata.listReachableObjectDigests(), reachableBefore);
});

test("injected rename failures roll back metadata and leave exact retry available", async () => {
  for (const stage of [
    "rename_after_space",
    "rename_after_idempotency",
    "rename_before_commit",
  ]) {
    const env = harness();
    const owner = await createAccount(env, 1);
    const created = await env.ordinary.createSpaceWithOwner(
      registeredActor(owner.principalId, `request_create_${stage}`, CREATED_AT),
      { name: "Original", handle: "rename-rollback", idempotencyKey: `create-${stage}` },
    );
    const actor = registeredActor(owner.principalId, `request_${stage}`);
    const before = await ordinaryState(env, created.mindId);
    const command = {
      mindId: created.mindId,
      name: "Recovered",
      expectedMetadataVersion: 1,
      idempotencyKey: `rename-${stage}`,
    };
    env.metadata.failNextOrdinaryMindAtForTest(stage);
    await assert.rejects(
      env.ordinary.renameSpace(actor, command),
      /injected ordinary Mind transaction failure/u,
    );
    assert.deepEqual(await ordinaryState(env, created.mindId), before);

    const recovered = await env.ordinary.renameSpace(actor, command);
    assert.equal(recovered.replayed, false);
    assert.equal(recovered.name, "Recovered");
    const after = await ordinaryState(env, created.mindId);
    assert.equal(after.space.headRevisionId, before.space.headRevisionId);
    assert.equal(after.space.accessVersion, before.space.accessVersion);
    assert.deepEqual(after.memberships, before.memberships);
    assert.deepEqual(after.revisions, before.revisions);
  }
});

test("safe results, failures and logs never expose hidden handle, verified email or content", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Private Owner Profile");
  const account = await env.metadata.readAccount(owner.principalId);
  assert.ok(account);
  const hiddenHandle = account.personalMind.space.spaceHandle;
  const created = await env.ordinary.createSpaceWithOwner(
    registeredActor(owner.principalId, "request_safe_create", CREATED_AT),
    { name: "Safe Mind", handle: "safe-mind", idempotencyKey: "safe-create" },
  );
  const failures = [];
  try {
    await env.ordinary.createSpaceWithOwner(
      registeredActor(owner.principalId, "request_safe_conflict", CREATED_AT),
      { name: "Other", handle: "safe-mind", idempotencyKey: "safe-conflict" },
    );
  } catch (error) {
    failures.push({ code: error.code, message: error.message });
  }
  const serialized = JSON.stringify({ created, failures, events: env.events });
  assert.equal(serialized.includes(hiddenHandle), false);
  assert.equal(serialized.includes("private.owner.1@example.com"), false);
  assert.equal(serialized.includes("# Mind"), false);
  assert.deepEqual(
    Object.keys(env.events[0]).sort(),
    ["event", "requestId"],
  );
});
