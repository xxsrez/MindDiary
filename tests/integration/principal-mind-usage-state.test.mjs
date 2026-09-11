import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  AccountBootstrapService,
  OrdinaryMindControlService,
  PersonalMindControlService,
  PrincipalMindUsageApplicationService,
} from "@mind-diary/application-control";
import { CAPABILITIES, verifiedSpaceHost, version } from "@mind-diary/domain";

import { createSitesMetadataStore } from "../../packages/adapter-metadata-sites/dist/index.js";
import { FakeD1Database } from "../../scripts/lib/fake-sites-storage.mjs";

const T0 = "2026-08-30T20:00:00.000Z";
const T1 = "2026-08-30T20:01:00.000Z";
const T2 = "2026-08-30T20:02:00.000Z";
const HOST = verifiedSpaceHost("mind-diary.example");
const HASH = `sha256:${"a".repeat(64)}`;

function beforeRegistration(index = 1) {
  return {
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding: `usage.${index}@example.com`,
    suggestedDisplayName: `Usage Owner ${index}`,
    deploymentCapabilities: CAPABILITIES,
    requestId: `request_usage_bootstrap_${index}`,
    occurredAtUtc: T0,
  };
}

function actor(principalId, requestId, occurredAtUtc = T1) {
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
  let sequence = 0;
  return {
    nextPrincipalId: () => `principal_usage_${++sequence}`,
    nextExternalBindingId: () => `binding_usage_${sequence}`,
    nextSpaceId: () => `space_usage_personal_${sequence}`,
    nextMembershipId: () => `membership_usage_personal_${sequence}`,
    nextRevisionId: () => `revision_usage_personal_${sequence}`,
    nextIndexJobId: () => `job_usage_personal_${sequence}`,
    nextPersonalSpaceHandle: () => `personal-usage-${sequence}`,
  };
}

function ordinaryIds() {
  let spaces = 0;
  return {
    nextSpaceId: () => `space_usage_ordinary_${++spaces}`,
    nextMembershipId: () => `membership_usage_ordinary_${spaces}`,
    nextRevisionId: () => `revision_usage_ordinary_${spaces}`,
    nextIndexJobId: () => `job_usage_ordinary_${spaces}`,
  };
}

function usageIds({ fixedGeneration, prefix = "usage" } = {}) {
  let generation = 0;
  let audit = 0;
  let outbox = 0;
  return {
    nextPrincipalMindUsageGenerationId: () =>
      fixedGeneration ?? `${prefix}_generation_${++generation}`,
    nextPrincipalMindUsageAuditEventId: () => `${prefix}_audit_${++audit}`,
    nextPrincipalMindUsageOutboxMessageId: () => `${prefix}_outbox_${++outbox}`,
  };
}

function services(metadata, ids = usageIds()) {
  const objects = new InMemoryObjectStore();
  return {
    objects,
    bootstrap: new AccountBootstrapService({
      accounts: metadata,
      objects,
      ids: accountIds(),
    }),
    ordinary: new OrdinaryMindControlService({
      ordinaryMinds: metadata,
      objects,
      ids: ordinaryIds(),
      host: HOST,
    }),
    personal: new PersonalMindControlService({ personalMinds: metadata, digest: objects }),
    usage: new PrincipalMindUsageApplicationService({ usage: metadata, digest: objects, ids }),
  };
}

async function setup(metadata = new InMemoryRevisionMetadataStore()) {
  const api = services(metadata);
  const account = await api.bootstrap.bootstrapAccount(beforeRegistration(), {
    action: "create_isolated_account",
  });
  const principalActor = actor(account.principalId, "request_usage_setup", T0);
  const first = await api.ordinary.createSpaceWithOwner(principalActor, {
    name: "Product research",
    handle: "product-research",
    description: "Durable product research decisions",
    idempotencyKey: "create-product-research",
  });
  const second = await api.ordinary.createSpaceWithOwner(principalActor, {
    name: "Engineering notes",
    handle: "engineering-notes",
    description: "Durable engineering implementation decisions",
    idempotencyKey: "create-engineering-notes",
  });
  return { metadata, api, account, first, second };
}

async function setMode(env, mindId, usageMode, expectedUsageVersion, key, at = T1) {
  return env.api.usage.mutate({
    actor: actor(env.account.principalId, `request_${key}`, at),
    spaceId: mindId,
    usageMode,
    expectedUsageVersion,
    idempotencyKey: key,
  });
}

function entryFor(state, mindId) {
  const entry = state.entries.find((candidate) => candidate.spaceId === mindId);
  assert.ok(entry, `Expected usage entry for ${mindId}`);
  return entry;
}

function generationFor(state, mindId) {
  const generation = entryFor(state, mindId).writeGeneration;
  assert.ok(generation, `Expected write generation for ${mindId}`);
  return generation;
}

async function selectLegacyCredentialTarget(
  metadata,
  principalId,
  ownerId,
  credentialKind,
  spaceId,
) {
  const registered = await metadata.runCredentialWriteTargetTransaction((transaction) =>
    transaction.registerCredentialWriteTargetOwner({
      bindingOwnerId: ownerId,
      principalId,
      credentialKind,
      occurredAt: T0,
    }));
  assert.equal(registered.kind, "registered");
  const selected = await metadata.runCredentialWriteTargetTransaction((transaction) =>
    transaction.applyCredentialWriteTarget({
      bindingOwnerId: ownerId,
      principalId,
      operation: "select",
      spaceId,
      expectedTargetVersion: 0,
      generationId: `legacy_generation_${ownerId}`,
      credentialHasWriteScope: true,
      idempotencyKey: `legacy-key-${ownerId}`,
      canonicalRequestHash: HASH,
      requestId: `legacy_request_${ownerId}`,
      auditEventId: `legacy_audit_${ownerId}`,
      auditOutboxMessageId: `legacy_outbox_${ownerId}`,
      occurredAt: T1,
    }));
  assert.equal(selected.kind, "applied");
}

test("principal usage starts disabled and preserves independent writable Minds", async () => {
  const env = await setup();
  assert.equal(await env.api.usage.read(actor(env.account.principalId, "read-empty")), null);

  const readable = await setMode(env, env.first.mindId, "read", 0, "first-read");
  assert.equal(readable.kind, "applied");
  assert.equal(readable.state.usageVersion, 1);
  assert.equal(readable.state.entries[0].usageMode, "read");

  const same = await setMode(env, env.first.mindId, "read", 1, "first-read-again");
  assert.equal(same.kind, "applied");
  assert.equal(same.changed, false);
  assert.equal(same.state.usageVersion, 1);

  const firstWritable = await setMode(
    env,
    env.first.mindId,
    "read_write",
    1,
    "first-writable",
  );
  assert.equal(firstWritable.kind, "applied");
  const firstGeneration = generationFor(firstWritable.state, env.first.mindId).generationId;
  assert.equal(await env.metadata.validatePrincipalMindUsageWritePin({
    principalId: env.account.principalId,
    spaceId: env.first.mindId,
    generationId: firstGeneration,
  }), true);

  const bothWritable = await setMode(
    env,
    env.second.mindId,
    "read_write",
    2,
    "second-writable",
    T2,
  );
  assert.equal(bothWritable.kind, "applied");
  assert.equal(bothWritable.state.usageVersion, 3);
  assert.equal(bothWritable.state.entries.length, 2);
  assert.equal(
    entryFor(bothWritable.state, env.first.mindId).usageMode,
    "read_write",
  );
  assert.equal(
    entryFor(bothWritable.state, env.second.mindId).usageMode,
    "read_write",
  );
  assert.notEqual(
    generationFor(bothWritable.state, env.second.mindId).generationId,
    firstGeneration,
  );
  assert.equal(await env.metadata.validatePrincipalMindUsageWritePin({
    principalId: env.account.principalId,
    spaceId: env.first.mindId,
    generationId: firstGeneration,
  }), true);

  const stale = await setMode(env, env.first.mindId, "disabled", 2, "stale-version");
  assert.equal(stale.kind, "usage_version_conflict");
  const replay = await setMode(
    env,
    env.second.mindId,
    "read_write",
    2,
    "second-writable",
    T2,
  );
  assert.equal(replay.kind, "applied");
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.state, bothWritable.state);
});

test("usage survives restart, is shared independently of credentials, and retired generations never reactivate", async () => {
  const env = await setup();
  const writable = await setMode(env, env.first.mindId, "read_write", 0, "select");
  assert.equal(writable.kind, "applied");
  const retiredGeneration = generationFor(writable.state, env.first.mindId).generationId;
  let metadata = InMemoryRevisionMetadataStore.fromDurableSnapshot(
    env.metadata.exportDurableSnapshot(),
  );
  assert.deepEqual(
    await metadata.readPrincipalMindUsage(env.account.principalId),
    writable.state,
  );

  const afterRestart = {
    ...env,
    metadata,
    api: services(metadata, usageIds({ prefix: "after_restart" })),
  };
  const disabled = await afterRestart.api.usage.mutate({
    actor: actor(env.account.principalId, "request_disable", T2),
    spaceId: env.first.mindId,
    usageMode: "disabled",
    expectedUsageVersion: 1,
    idempotencyKey: "disable",
  });
  assert.equal(disabled.kind, "applied");
  const reuseApi = services(metadata, usageIds({
    fixedGeneration: retiredGeneration,
    prefix: "reuse",
  }));
  const reuse = await reuseApi.usage.mutate({
    actor: actor(env.account.principalId, "request_reuse", T2),
    spaceId: env.first.mindId,
    usageMode: "read_write",
    expectedUsageVersion: 2,
    idempotencyKey: "reuse-retired-generation",
  });
  assert.equal(reuse.kind, "generation_conflict");

  await metadata.disablePrincipalForTest(env.account.principalId, T2);
  assert.equal(await metadata.validatePrincipalMindUsageWritePin({
    principalId: env.account.principalId,
    spaceId: env.first.mindId,
    generationId: retiredGeneration,
  }), false);
  assert.equal(await metadata.readPrincipalMindUsage(env.account.principalId), null);
});

test("credential creation, replacement and revocation never fork or clear principal usage", async () => {
  const env = await setup();
  const configured = await setMode(env, env.first.mindId, "read_write", 0, "principal-config");
  assert.equal(configured.kind, "applied");
  for (const [index, credentialKind] of [
    "oauth_grant",
    "oauth_grant",
    "personal_token",
    "personal_token",
  ].entries()) {
    const ownerId = `credential_owner_${index + 1}`;
    const registered = await env.metadata.runCredentialWriteTargetTransaction((transaction) =>
      transaction.registerCredentialWriteTargetOwner({
        bindingOwnerId: ownerId,
        principalId: env.account.principalId,
        credentialKind,
        occurredAt: T1,
      }));
    assert.equal(registered.kind, "registered");
    assert.deepEqual(
      await env.metadata.readPrincipalMindUsage(env.account.principalId),
      configured.state,
    );
    const revoked = await env.metadata.revokeCredentialWriteTargetOwner({
      bindingOwnerId: ownerId,
      principalId: env.account.principalId,
      requestId: `revoke_request_${index}`,
      auditEventId: `revoke_audit_${index}`,
      auditOutboxMessageId: `revoke_outbox_${index}`,
      occurredAt: T2,
    });
    assert.equal(revoked.kind, "revoked");
    assert.deepEqual(
      await env.metadata.readPrincipalMindUsage(env.account.principalId),
      configured.state,
    );
  }
});

test("principal isolation denies another account and leaves both snapshots independent", async () => {
  const env = await setup();
  const second = await env.api.bootstrap.bootstrapAccount(beforeRegistration(2), {
    action: "create_isolated_account",
  });
  const denied = await env.api.usage.mutate({
    actor: actor(second.principalId, "request_foreign_usage", T1),
    spaceId: env.first.mindId,
    usageMode: "read",
    expectedUsageVersion: 0,
    idempotencyKey: "foreign-private-mind",
  });
  assert.equal(denied.kind, "read_access_required");
  assert.equal(await env.metadata.readPrincipalMindUsage(env.account.principalId), null);
  assert.equal(await env.metadata.readPrincipalMindUsage(second.principalId), null);
});

test("ACL loss disables the write pin without rewriting principal intent", async () => {
  const env = await setup();
  const editor = await env.api.bootstrap.bootstrapAccount(beforeRegistration(2), {
    action: "create_isolated_account",
  });
  assert.equal(await env.metadata.grantOrdinaryMembershipForTest({
    membershipId: "membership_usage_editor",
    spaceId: env.first.mindId,
    principalId: editor.principalId,
    role: "editor",
    state: "active",
    version: version(1),
    createdAt: T1,
    createdBy: env.account.principalId,
    updatedAt: T1,
    updatedBy: env.account.principalId,
  }, T1), true);
  const configured = await env.api.usage.mutate({
    actor: actor(editor.principalId, "request_editor_writable", T1),
    spaceId: env.first.mindId,
    usageMode: "read_write",
    expectedUsageVersion: 0,
    idempotencyKey: "editor-writable",
  });
  assert.equal(configured.kind, "applied");
  const pin = {
    principalId: editor.principalId,
    spaceId: env.first.mindId,
    generationId: generationFor(configured.state, env.first.mindId).generationId,
  };
  assert.equal(await env.metadata.validatePrincipalMindUsageWritePin(pin), true);
  assert.equal(await env.metadata.revokeOrdinaryMembershipForTest(
    env.first.mindId,
    editor.principalId,
    T2,
  ), true);
  assert.equal(await env.metadata.validatePrincipalMindUsageWritePin(pin), false);
  assert.deepEqual(
    await env.metadata.readPrincipalMindUsage(editor.principalId),
    configured.state,
  );
  const retry = await env.api.usage.mutate({
    actor: actor(editor.principalId, "request_editor_writable_retry", T2),
    spaceId: env.first.mindId,
    usageMode: "read_write",
    expectedUsageVersion: 0,
    idempotencyKey: "editor-writable",
  });
  assert.equal(retry.kind, "read_access_required");
});

test("v2 migration transfers only one unambiguous described legacy target with a fresh generation", async () => {
  const unambiguous = await setup();
  await selectLegacyCredentialTarget(
    unambiguous.metadata,
    unambiguous.account.principalId,
    "legacy_oauth_one",
    "oauth_grant",
    unambiguous.first.mindId,
  );
  const v2 = unambiguous.metadata.exportDurableSnapshot();
  v2.v = 2;
  delete v2.principalMindUsageOwners;
  const migrated = InMemoryRevisionMetadataStore.fromDurableSnapshot(v2);
  const state = await migrated.readPrincipalMindUsage(unambiguous.account.principalId);
  assert.ok(state);
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].spaceId, unambiguous.first.mindId);
  assert.equal(state.entries[0].usageMode, "read_write");
  assert.notEqual(
    generationFor(state, unambiguous.first.mindId).generationId,
    "legacy_generation_legacy_oauth_one",
  );

  const ambiguous = await setup();
  await selectLegacyCredentialTarget(
    ambiguous.metadata,
    ambiguous.account.principalId,
    "legacy_oauth_conflict",
    "oauth_grant",
    ambiguous.first.mindId,
  );
  await selectLegacyCredentialTarget(
    ambiguous.metadata,
    ambiguous.account.principalId,
    "legacy_token_conflict",
    "personal_token",
    ambiguous.second.mindId,
  );
  const ambiguousV2 = ambiguous.metadata.exportDurableSnapshot();
  ambiguousV2.v = 2;
  delete ambiguousV2.principalMindUsageOwners;
  const failedClosed = InMemoryRevisionMetadataStore.fromDurableSnapshot(ambiguousV2);
  assert.equal(
    await failedClosed.readPrincipalMindUsage(ambiguous.account.principalId),
    null,
  );

  const partialEvidence = await setup();
  await selectLegacyCredentialTarget(
    partialEvidence.metadata,
    partialEvidence.account.principalId,
    "legacy_oauth_partial",
    "oauth_grant",
    partialEvidence.first.mindId,
  );
  const partialV2 = partialEvidence.metadata.exportDurableSnapshot();
  partialV2.v = 2;
  delete partialV2.principalMindUsageOwners;
  partialV2.legacyCredentialWriteTargetUpgrades.set("legacy_ambiguous_owner", {
    bindingOwnerId: "legacy_ambiguous_owner",
    principalId: partialEvidence.account.principalId,
    candidateSpaceId: null,
    candidateGeneration: null,
    unambiguous: false,
    automaticCaptureWasEnabled: false,
    observedAt: T1,
  });
  const partialFailedClosed = InMemoryRevisionMetadataStore.fromDurableSnapshot(partialV2);
  assert.equal(
    await partialFailedClosed.readPrincipalMindUsage(partialEvidence.account.principalId),
    null,
  );
});

test("descriptionless ordinary Minds remain writable and client hints cannot spoof routing identity", async () => {
  const env = await setup();
  const noDescription = await env.api.ordinary.createSpaceWithOwner(
    actor(env.account.principalId, "request_create_empty", T0),
    {
      name: "Unclassified",
      handle: "unclassified",
      idempotencyKey: "create-unclassified",
    },
  );
  const descriptionless = await setMode(
    env,
    noDescription.mindId,
    "read_write",
    0,
    "empty-write",
  );
  assert.equal(descriptionless.kind, "applied");
  assert.equal(entryFor(descriptionless.state, noDescription.mindId).routingProfile,
    "description_based");
  const spoofedPersonal = await env.api.usage.mutate({
    actor: actor(env.account.principalId, "request_spoofed_personal", T1),
    spaceId: noDescription.mindId,
    usageMode: "read_write",
    expectedUsageVersion: 1,
    idempotencyKey: "spoofed-personal",
    isPersonal: true,
    route: "/me",
  });
  assert.equal(spoofedPersonal.kind, "applied");
  assert.equal(spoofedPersonal.changed, false);
  assert.equal(entryFor(spoofedPersonal.state, noDescription.mindId).routingProfile,
    "description_based");

  const writable = await setMode(env, env.first.mindId, "read_write", 1, "write-described");
  assert.equal(writable.kind, "applied");
  const previousGeneration = generationFor(writable.state, env.first.mindId).generationId;
  const cleared = await env.api.ordinary.renameSpace(
    actor(env.account.principalId, "clear-description", T2),
    {
      mindId: env.first.mindId,
      description: null,
      expectedMetadataVersion: env.first.metadataVersion,
      idempotencyKey: "clear-writable-description",
    },
  );
  assert.equal(cleared.description, null);
  const afterClear = await env.metadata.readPrincipalMindUsage(env.account.principalId);
  assert.equal(entryFor(afterClear, env.first.mindId).usageMode, "read_write");
  assert.notEqual(generationFor(afterClear, env.first.mindId).generationId,
    previousGeneration);
});

test("descriptionless Personal Mind is writable, idempotent, and survives restart", async () => {
  const env = await setup();
  const initial = await env.api.personal.resolveMyMind(
    actor(env.account.principalId, "personal-descriptionless", T1),
  );
  assert.equal(initial.personalMind.description, null);
  const writable = await setMode(
    env,
    initial.personalMind.mindId,
    "read_write",
    0,
    "personal-writable",
  );
  assert.equal(writable.kind, "applied");
  const generationId = generationFor(
    writable.state,
    initial.personalMind.mindId,
  ).generationId;
  assert.equal(await env.metadata.validatePrincipalMindUsageWritePin({
    principalId: env.account.principalId,
    spaceId: initial.personalMind.mindId,
    generationId,
  }), true);
  const replayed = await setMode(
    env,
    initial.personalMind.mindId,
    "read_write",
    0,
    "personal-writable",
  );
  assert.equal(replayed.kind, "applied");
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.state, writable.state);
  const restarted = InMemoryRevisionMetadataStore.fromDurableSnapshot(
    env.metadata.exportDurableSnapshot(),
  );
  assert.equal(await restarted.validatePrincipalMindUsageWritePin({
    principalId: env.account.principalId,
    spaceId: initial.personalMind.mindId,
    generationId,
  }), true);
});

test("three ordinary Minds and Personal remain independently writable across restart and disable", async () => {
  const env = await setup();
  const personal = await env.api.personal.resolveMyMind(
    actor(env.account.principalId, "independent-personal", T1),
  );
  const third = await env.api.ordinary.createSpaceWithOwner(
    actor(env.account.principalId, "request-third-ordinary", T1),
    {
      name: "Architecture notes",
      handle: "architecture-notes",
      description: null,
      idempotencyKey: "create-architecture-notes",
    },
  );
  const first = await setMode(
    env,
    env.first.mindId,
    "read_write",
    0,
    "independent-first",
  );
  assert.equal(first.kind, "applied");
  const firstGeneration = generationFor(first.state, env.first.mindId).generationId;
  const withPersonal = await setMode(
    env,
    personal.personalMind.mindId,
    "read_write",
    1,
    "independent-personal-write",
    T2,
  );
  assert.equal(withPersonal.kind, "applied");
  const personalGeneration = generationFor(
    withPersonal.state,
    personal.personalMind.mindId,
  ).generationId;
  const withSecond = await setMode(
    env,
    env.second.mindId,
    "read_write",
    2,
    "independent-second",
    T2,
  );
  assert.equal(withSecond.kind, "applied");
  const secondGeneration = generationFor(withSecond.state, env.second.mindId).generationId;
  const all = await setMode(
    env,
    third.mindId,
    "read_write",
    3,
    "independent-third",
    T2,
  );
  assert.equal(all.kind, "applied");
  const thirdGeneration = generationFor(all.state, third.mindId).generationId;
  assert.equal(all.state.entries.filter((entry) =>
    entry.usageMode === "read_write").length, 4);
  assert.equal(generationFor(all.state, env.first.mindId).generationId, firstGeneration);
  assert.equal(generationFor(all.state, env.second.mindId).generationId, secondGeneration);
  assert.equal(generationFor(all.state, personal.personalMind.mindId).generationId,
    personalGeneration);

  const restarted = InMemoryRevisionMetadataStore.fromDurableSnapshot(
    env.metadata.exportDurableSnapshot(),
  );
  const restartedState = await restarted.readPrincipalMindUsage(env.account.principalId);
  assert.equal(restartedState.contractVersion, "principal-mind-usage/v3");
  assert.equal(restartedState.entries.filter((entry) =>
    entry.usageMode === "read_write").length, 4);

  const restartedEnv = {
    ...env,
    metadata: restarted,
    api: services(restarted, usageIds({ prefix: "multi_restart" })),
  };
  const firstDisabled = await setMode(
    restartedEnv,
    env.first.mindId,
    "disabled",
    4,
    "disable-first-only",
    T2,
  );
  assert.equal(firstDisabled.kind, "applied");
  assert.equal(firstDisabled.state.entries.some((entry) =>
    entry.spaceId === env.first.mindId), false);
  for (const [spaceId, generationId] of [
    [env.second.mindId, secondGeneration],
    [third.mindId, thirdGeneration],
    [personal.personalMind.mindId, personalGeneration],
  ]) {
    assert.equal(entryFor(firstDisabled.state, spaceId).usageMode, "read_write");
    assert.equal(await restarted.validatePrincipalMindUsageWritePin({
      principalId: env.account.principalId,
      spaceId,
      generationId,
    }), true);
  }
  assert.equal(await restarted.validatePrincipalMindUsageWritePin({
    principalId: env.account.principalId,
    spaceId: env.first.mindId,
    generationId: firstGeneration,
  }), false);

  const personalRead = await setMode(
    restartedEnv,
    personal.personalMind.mindId,
    "read",
    5,
    "independent-personal-read",
    T2,
  );
  assert.equal(personalRead.kind, "applied");
  assert.equal(entryFor(personalRead.state, personal.personalMind.mindId).writeGeneration,
    null);
  assert.equal(entryFor(personalRead.state, env.second.mindId).usageMode, "read_write");
  assert.equal(entryFor(personalRead.state, third.mindId).usageMode, "read_write");
  assert.equal(await restarted.validatePrincipalMindUsageWritePin({
    principalId: env.account.principalId,
    spaceId: personal.personalMind.mindId,
    generationId: personalGeneration,
  }), false);
});

test("v1 and v2 singleton states migrate to v3 without changing the selected generation", async () => {
  for (const [legacyVersion, target] of [
    [1, "ordinary"],
    [1, "personal"],
    [2, "ordinary"],
    [2, "personal"],
  ]) {
    const env = await setup();
    const personal = await env.api.personal.resolveMyMind(
      actor(env.account.principalId, `legacy-${target}`, T1),
    );
    const spaceId = target === "personal"
      ? personal.personalMind.mindId
      : env.first.mindId;
    const writable = await setMode(
      env,
      spaceId,
      "read_write",
      0,
      `legacy-${target}-write`,
    );
    assert.equal(writable.kind, "applied");
    const selectedGeneration = generationFor(writable.state, spaceId);
    const snapshot = env.metadata.exportDurableSnapshot();
    snapshot.v = legacyVersion === 1 ? 3 : 4;
    const owner = snapshot.principalMindUsageOwners.get(env.account.principalId);
    const downgradeState = (state) => {
      const entry = entryFor(state, spaceId);
      if (legacyVersion === 1) {
        return {
          principalId: state.principalId,
          contractVersion: "principal-mind-usage/v1",
          usageVersion: state.usageVersion,
          entries: state.entries.map(({ routingProfile: _routingProfile, ...item }) => item),
          activeWriteGeneration: entry.writeGeneration,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
        };
      }
      return {
        ...state,
        contractVersion: "principal-mind-usage/v2",
        ordinaryWriteGeneration: target === "ordinary" ? entry.writeGeneration : null,
        personalWriteGeneration: target === "personal" ? entry.writeGeneration : null,
      };
    };
    owner.state = downgradeState(owner.state);
    owner.idempotency = new Map([...owner.idempotency].map(([key, record]) => [
      key,
      {
        ...record,
        result: { ...record.result, state: downgradeState(record.result.state) },
      },
    ]));

    const restored = InMemoryRevisionMetadataStore.fromDurableSnapshot(snapshot);
    const migrated = await restored.readPrincipalMindUsage(env.account.principalId);
    assert.equal(migrated.contractVersion, "principal-mind-usage/v3");
    assert.equal(migrated.entries[0].routingProfile,
      target === "personal" ? "personal_default" : "description_based");
    assert.deepEqual(generationFor(migrated, spaceId), selectedGeneration);
    const replay = await setMode(
      { ...env, metadata: restored, api: services(restored) },
      spaceId,
      "read_write",
      0,
      `legacy-${target}-write`,
    );
    assert.equal(replay.kind, "applied");
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.state, migrated);
  }
});

test("corrupt generations and incompatible downgrade snapshots fail closed", async () => {
  const env = await setup();
  const writable = await setMode(env, env.first.mindId, "read_write", 0, "corrupt-base");
  assert.equal(writable.kind, "applied");
  const snapshot = env.metadata.exportDurableSnapshot();
  const owner = snapshot.principalMindUsageOwners.get(env.account.principalId);
  owner.state = {
    ...owner.state,
    entries: [
      ...owner.state.entries,
      {
        ...owner.state.entries[0],
        spaceId: env.second.mindId,
        writeGeneration: {
          ...owner.state.entries[0].writeGeneration,
          spaceId: env.second.mindId,
        },
      },
    ],
  };
  assert.throws(
    () => InMemoryRevisionMetadataStore.fromDurableSnapshot(snapshot),
    /durable snapshot is invalid/u,
  );

  const mismatchedPinSnapshot = env.metadata.exportDurableSnapshot();
  mismatchedPinSnapshot.v = 4;
  assert.throws(
    () => InMemoryRevisionMetadataStore.fromDurableSnapshot(mismatchedPinSnapshot),
    /durable snapshot is invalid/u,
  );
});

test("Sites persistence restores a descriptionless Personal writable pin and exact replay", async () => {
  const database = new FakeD1Database();
  let metadata = await createSitesMetadataStore(database);
  const env = await setup(metadata);
  const personal = await env.api.personal.resolveMyMind(
    actor(env.account.principalId, "sites-personal", T1),
  );
  assert.equal(personal.personalMind.description, null);
  const writable = await setMode(
    env,
    personal.personalMind.mindId,
    "read_write",
    0,
    "sites-personal-write",
  );
  assert.equal(writable.kind, "applied");
  const replayed = await setMode(
    env,
    personal.personalMind.mindId,
    "read_write",
    0,
    "sites-personal-write",
  );
  assert.equal(replayed.kind, "applied");
  assert.equal(replayed.replayed, true);

  metadata = await createSitesMetadataStore(database);
  assert.deepEqual(
    await metadata.readPrincipalMindUsage(env.account.principalId),
    writable.state,
  );
  assert.equal(await metadata.validatePrincipalMindUsageWritePin({
    principalId: env.account.principalId,
    spaceId: personal.personalMind.mindId,
    generationId: generationFor(
      writable.state,
      personal.personalMind.mindId,
    ).generationId,
  }), true);
});

for (const storage of ["memory", "sites"]) test(`${storage}: description changes fence only the affected write lane; no-op and replay preserve pins`, async () => {
  const database = new FakeD1Database();
  const env = await setup(storage === "sites" ? await createSitesMetadataStore(database) : undefined);
  const principalId = env.account.principalId;
  const personalId = env.account.personalMind.mindId;
  await setMode(env, env.first.mindId, "read_write", 0, "description-ordinary");
  const both = await setMode(env, personalId, "read_write", 1, "description-personal");
  const oldPin = { principalId, spaceId: personalId,
    generationId: generationFor(both.state, personalId).generationId };
  const ordinaryPin = { principalId, spaceId: env.first.mindId,
    generationId: generationFor(both.state, env.first.mindId).generationId };
  const before = await env.metadata.readAccount(principalId);
  const command = { description: "Engineering decisions; exclude daily logs",
    expectedMetadataVersion: before.personalMind.space.metadataVersion,
    idempotencyKey: "configure-personal-topics" };
  await env.api.personal.updateMyMindDescription(actor(principalId, "description-update"), command);
  assert.equal(await env.metadata.validatePrincipalMindUsageWritePin(oldPin), false);
  assert.equal(await env.metadata.validatePrincipalMindUsageWritePin(ordinaryPin), true);
  const configured = await env.metadata.readPrincipalMindUsage(principalId);
  const after = await env.metadata.readAccount(principalId);
  assert.equal(after.personalMind.space.description, command.description);
  assert.equal(after.personalMind.space.headRevisionId, before.personalMind.space.headRevisionId);
  assert.equal(generationFor(configured, personalId).spaceId, personalId);
  const replay = await env.api.personal.updateMyMindDescription(actor(principalId, "description-replay"), command);
  assert.equal(replay.replayed, true);
  await env.api.personal.updateMyMindDescription(actor(principalId, "description-noop"), {
    ...command, expectedMetadataVersion: after.personalMind.space.metadataVersion,
    idempotencyKey: "configure-personal-noop" });
  assert.deepEqual(await env.metadata.readPrincipalMindUsage(principalId), configured);
  await assert.rejects(env.api.personal.updateMyMindDescription(actor(principalId, "description-stale"), {
    ...command, description: "Other topics", idempotencyKey: "stale-description" }),
  (error) => error.code === "metadata_conflict");
  await env.api.personal.updateMyMindDescription(actor(principalId, "description-clear"), {
    description: null, expectedMetadataVersion: after.personalMind.space.metadataVersion,
    idempotencyKey: "clear-personal-topics" });
  const restored = storage === "sites" ? await createSitesMetadataStore(database) :
    InMemoryRevisionMetadataStore.fromDurableSnapshot(env.metadata.exportDurableSnapshot());
  assert.equal((await restored.readAccount(principalId)).personalMind.space.description, null);
  assert.equal(await restored.validatePrincipalMindUsageWritePin(oldPin), false);
  assert.equal(await restored.validatePrincipalMindUsageWritePin(ordinaryPin), true);
  const current = await restored.readPrincipalMindUsage(principalId);
  assert.equal(await restored.validatePrincipalMindUsageWritePin({ ...oldPin,
    generationId: generationFor(current, personalId).generationId }), true);
});
