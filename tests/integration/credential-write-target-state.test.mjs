import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import { CredentialWriteTargetApplicationService } from "@mind-diary/application-control";
import { CAPABILITIES, bindingVersion, version } from "@mind-diary/domain";

import { createSitesMetadataStore } from "../../packages/adapter-metadata-sites/dist/index.js";
import { FakeD1Database } from "../../scripts/lib/fake-sites-storage.mjs";

const T0 = "2026-08-27T13:00:00.000Z";
const T1 = "2026-08-27T13:01:00.000Z";
const PRINCIPAL = "principal_target_integration";
const OTHER_PRINCIPAL = "principal_target_other";
const OWNER = "grant_target_integration";
const SPACE = "space_target_integration";
const HASH = `sha256:${"a".repeat(64)}`;

function authorizationState(role = "editor") {
  return {
    principal: { principalId: PRINCIPAL, state: "active" },
    space: {
      spaceId: SPACE,
      state: "active",
      visibility: "private",
      accessVersion: version(1),
    },
    membership: {
      principalId: PRINCIPAL,
      spaceId: SPACE,
      role,
      state: "active",
      version: version(1),
    },
    token: null,
  };
}

function mutationBase(key) {
  return {
    bindingOwnerId: OWNER,
    principalId: PRINCIPAL,
    idempotencyKey: key,
    canonicalRequestHash: HASH,
    requestId: `request_${key}`,
    auditEventId: `audit_${key}`,
    auditOutboxMessageId: `outbox_${key}`,
    occurredAt: T1,
  };
}

async function register(store, owner = OWNER, principal = PRINCIPAL, kind = "oauth_grant") {
  return store.runCredentialWriteTargetTransaction((transaction) =>
    transaction.registerCredentialWriteTargetOwner({
      bindingOwnerId: owner,
      principalId: principal,
      credentialKind: kind,
      occurredAt: T0,
    }));
}

async function select(store, overrides = {}) {
  return store.runCredentialWriteTargetTransaction((transaction) =>
    transaction.applyCredentialWriteTarget({
      ...mutationBase("select"),
      operation: "select",
      spaceId: SPACE,
      expectedTargetVersion: 0,
      generationId: "target_generation_one",
      credentialHasWriteScope: true,
      ...overrides,
    }));
}

test("durable target state preserves retry identity but isolates fresh owners", async () => {
  let store = new InMemoryRevisionMetadataStore();
  store.setCurrentAuthorizationStateForTest(
    { principalId: PRINCIPAL, spaceId: SPACE, tokenId: null },
    authorizationState(),
  );
  assert.equal((await register(store)).kind, "registered");
  const selected = await select(store);
  assert.equal(selected.kind, "applied");
  assert.equal(selected.state.activeGeneration.generationId, "target_generation_one");

  const snapshot = store.exportDurableSnapshot();
  assert.equal(snapshot.v, 3);
  assert.ok(snapshot.principalMindUsageOwners instanceof Map);
  assert.equal("mindBindingOwners" in snapshot, false);
  assert.ok(snapshot.credentialWriteTargetOwners instanceof Map);
  store = InMemoryRevisionMetadataStore.fromDurableSnapshot(snapshot);

  const replay = await select(store);
  assert.equal(replay.kind, "applied");
  assert.equal(replay.replayed, true);
  assert.equal(replay.state.activeGeneration.generationId, "target_generation_one");

  const cleared = await store.runCredentialWriteTargetTransaction((transaction) =>
    transaction.applyCredentialWriteTarget({
      ...mutationBase("clear"),
      operation: "clear",
      expectedTargetVersion: 1,
    }));
  assert.equal(cleared.kind, "applied");
  assert.equal(cleared.state.activeGeneration, null);
  store = InMemoryRevisionMetadataStore.fromDurableSnapshot(
    store.exportDurableSnapshot(),
  );
  const staleReactivation = await select(store, {
    ...mutationBase("stale-reactivation"),
    expectedTargetVersion: 2,
    generationId: "target_generation_one",
  });
  assert.equal(staleReactivation.kind, "invalid_record");

  assert.equal(
    await store.readCredentialWriteTarget(OWNER, OTHER_PRINCIPAL),
    null,
  );
  const newOwner = "grant_target_reconnect";
  const fresh = await register(store, newOwner);
  assert.equal(fresh.kind, "registered");
  assert.equal(fresh.state.activeGeneration, null);
  assert.equal(fresh.state.automaticCaptureMode, "disabled");

  const reuse = await store.runCredentialWriteTargetTransaction((transaction) =>
    transaction.applyCredentialWriteTarget({
      ...mutationBase("owner-isolation"),
      bindingOwnerId: newOwner,
      operation: "select",
      spaceId: SPACE,
      expectedTargetVersion: 0,
      generationId: "target_generation_one",
      credentialHasWriteScope: true,
    }));
  assert.equal(reuse.kind, "invalid_record");
});

test("Sites application command selects through the atomic ACL-backed store path", async () => {
  const store = new InMemoryRevisionMetadataStore();
  store.setCurrentAuthorizationStateForTest(
    { principalId: PRINCIPAL, spaceId: SPACE, tokenId: null },
    authorizationState(),
  );
  await register(store);
  let generation = 0;
  let audit = 0;
  let outbox = 0;
  const service = new CredentialWriteTargetApplicationService({
    targets: store,
    digest: new InMemoryObjectStore(),
    ids: {
      nextCredentialWriteTargetGenerationId: () => `application_generation_${++generation}`,
      nextCredentialWriteTargetAuditEventId: () => `application_audit_${++audit}`,
      nextCredentialWriteTargetOutboxMessageId: () => `application_outbox_${++outbox}`,
    },
  });
  const actor = {
    kind: "registered_principal",
    principalId: PRINCIPAL,
    authentication: { kind: "sites_identity" },
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_application_select",
    occurredAtUtc: T1,
  };
  const command = {
    actor,
    bindingOwnerId: OWNER,
    credentialScopes: ["content:read", "content:write"],
    operation: "select",
    spaceId: SPACE,
    expectedTargetVersion: 0,
    idempotencyKey: "application-select",
  };
  const selected = await service.mutate(command);
  assert.equal(selected.kind, "applied");
  assert.equal(selected.state.activeGeneration.generationId, "application_generation_1");
  const replay = await service.mutate(command);
  assert.equal(replay.kind, "applied");
  assert.equal(replay.replayed, true);
  assert.equal(replay.state.activeGeneration.generationId, "application_generation_1");
});

test("revocation is idempotent and cannot transfer target or capture to a replacement owner", async () => {
  const store = new InMemoryRevisionMetadataStore();
  store.setCurrentAuthorizationStateForTest(
    { principalId: PRINCIPAL, spaceId: SPACE, tokenId: null },
    authorizationState("owner"),
  );
  await register(store);
  const selected = await select(store);
  assert.equal(selected.kind, "applied");
  const captured = await store.runCredentialWriteTargetTransaction((transaction) =>
    transaction.applyCredentialWriteTarget({
      ...mutationBase("capture"),
      operation: "configure_capture",
      mode: "routine_non_sensitive",
      expectedTargetVersion: 1,
      expectedGenerationId: "target_generation_one",
      credentialHasWriteScope: true,
    }));
  assert.equal(captured.kind, "applied");
  assert.equal(captured.state.captureGenerationId, "target_generation_one");

  const revokeRequest = {
    bindingOwnerId: OWNER,
    principalId: PRINCIPAL,
    requestId: "request_revoke_target_owner",
    auditEventId: "audit_revoke_target_owner",
    auditOutboxMessageId: "outbox_revoke_target_owner",
    occurredAt: T1,
  };
  const revoked = await store.revokeCredentialWriteTargetOwner(revokeRequest);
  const retry = await store.revokeCredentialWriteTargetOwner({
    ...revokeRequest,
    auditEventId: "audit_revoke_target_owner_retry",
    auditOutboxMessageId: "outbox_revoke_target_owner_retry",
  });
  assert.deepEqual(revoked, { kind: "revoked", changed: true, replayed: false });
  assert.deepEqual(retry, { kind: "revoked", changed: false, replayed: true });
  const terminal = await store.readCredentialWriteTarget(OWNER, PRINCIPAL);
  assert.equal(terminal.state.lifecycleState, "revoked");
  assert.equal(terminal.state.activeGeneration, null);
  assert.equal(terminal.state.captureGenerationId, null);
  assert.equal((await select(store, {
    ...mutationBase("after-revoke"),
    expectedTargetVersion: terminal.state.targetVersion,
    generationId: "generation_after_revoke",
  })).kind, "credential_inactive");

  const replacement = await register(
    store,
    "grant_replacement_owner",
    PRINCIPAL,
    "oauth_grant",
  );
  assert.equal(replacement.state.activeGeneration, null);
  assert.equal(replacement.state.captureGenerationId, null);
});

test("legacy event state becomes pending, requires explicit same-owner upgrade and drops capture", async () => {
  const store = new InMemoryRevisionMetadataStore();
  store.setCurrentAuthorizationStateForTest(
    { principalId: PRINCIPAL, spaceId: SPACE, tokenId: null },
    authorizationState(),
  );
  await store.runMindBindingTransaction((transaction) =>
    transaction.applyWriteMindBinding({
      bindingOwnerId: OWNER,
      principalId: PRINCIPAL,
      action: "bind",
      spaceId: SPACE,
      writeBindingId: "legacy_write_binding_id",
      expectedBindingVersion: bindingVersion(0),
      idempotencyKey: "legacy-bind",
      canonicalRequestHash: HASH,
      requestId: "request_legacy_bind",
      auditEventId: "audit_legacy_bind",
      auditOutboxMessageId: "outbox_legacy_bind",
      occurredAt: T0,
    }));
  await store.runMindBindingTransaction((transaction) =>
    transaction.applyAutomaticCapturePolicy({
      bindingOwnerId: OWNER,
      principalId: PRINCIPAL,
      action: "enable",
      spaceId: SPACE,
      writeBindingId: "legacy_write_binding_id",
      mode: "routine_non_sensitive",
      expectedBindingVersion: bindingVersion(1),
      idempotencyKey: "legacy-capture",
      canonicalRequestHash: HASH,
      requestId: "request_legacy_capture",
      auditEventId: "audit_legacy_capture",
      auditOutboxMessageId: "outbox_legacy_capture",
      occurredAt: T0,
    }));

  await store.decommissionLegacyMindBindingsForMigration();
  const pending = await store.readCredentialWriteTarget(OWNER, PRINCIPAL);
  assert.equal(pending.kind, "pending_upgrade");
  assert.equal(pending.legacy.candidateSpaceId, SPACE);
  assert.equal(pending.legacy.automaticCaptureWasEnabled, true);
  assert.equal((await select(store)).kind, "pending_upgrade");

  const personalAttempt = await store.runCredentialWriteTargetTransaction((transaction) =>
    transaction.applyCredentialWriteTarget({
      ...mutationBase("personal-upgrade"),
      operation: "upgrade_legacy",
      credentialKind: "personal_token",
      generationId: "replacement_personal_generation",
      credentialHasWriteScope: true,
    }));
  assert.equal(personalAttempt.kind, "upgrade_not_supported");

  const upgraded = await store.runCredentialWriteTargetTransaction((transaction) =>
    transaction.applyCredentialWriteTarget({
      ...mutationBase("oauth-upgrade"),
      operation: "upgrade_legacy",
      credentialKind: "oauth_grant",
      generationId: "replacement_oauth_generation",
      credentialHasWriteScope: true,
    }));
  assert.equal(upgraded.kind, "applied");
  assert.equal(upgraded.state.activeGeneration.spaceId, SPACE);
  assert.equal(upgraded.state.activeGeneration.generationId, "replacement_oauth_generation");
  assert.notEqual(upgraded.state.activeGeneration.generationId, "legacy_write_binding_id");
  assert.equal(upgraded.state.automaticCaptureMode, "disabled");
  assert.equal(upgraded.state.captureGenerationId, null);
});

test("ambiguous v1 snapshot migrates fail-closed and never persists read records", async () => {
  const baseline = new InMemoryRevisionMetadataStore().exportDurableSnapshot();
  const legacyOwner = {
    bindingSet: {
      bindingOwnerId: OWNER,
      principalId: PRINCIPAL,
      state: "active",
      bindingVersion: bindingVersion(3),
      automaticCaptureMode: "routine_non_sensitive",
      captureWriteBindingId: "legacy_write_a",
      captureUpdatedAt: T0,
      createdAt: T0,
      updatedAt: T0,
    },
    readBindingsById: new Map([
      ["legacy_read", {
        readBindingId: "legacy_read",
        bindingOwnerId: OWNER,
        spaceId: SPACE,
        state: "active",
        createdAt: T0,
        invalidatedAt: null,
      }],
    ]),
    activeReadBindingBySpace: new Map([[SPACE, "legacy_read"]]),
    writeBindingsById: new Map([
      ["legacy_write_a", {
        writeBindingId: "legacy_write_a",
        bindingOwnerId: OWNER,
        spaceId: SPACE,
        generation: bindingVersion(1),
        state: "active",
        createdAt: T0,
        invalidatedAt: null,
      }],
      ["legacy_write_b", {
        writeBindingId: "legacy_write_b",
        bindingOwnerId: OWNER,
        spaceId: "space_conflicting",
        generation: bindingVersion(2),
        state: "active",
        createdAt: T0,
        invalidatedAt: null,
      }],
    ]),
    activeWriteBindingId: "legacy_write_a",
    idempotency: new Map(),
  };
  const v1 = {
    ...baseline,
    v: 1,
    mindBindingOwners: new Map([[OWNER, legacyOwner]]),
  };
  delete v1.credentialWriteTargetOwners;
  delete v1.legacyCredentialWriteTargetUpgrades;
  let restored = InMemoryRevisionMetadataStore.fromDurableSnapshot(v1);
  const pending = await restored.readCredentialWriteTarget(OWNER, PRINCIPAL);
  assert.equal(pending.kind, "pending_upgrade");
  assert.equal(pending.legacy.unambiguous, false);
  assert.equal(pending.legacy.candidateSpaceId, null);

  const forward = restored.exportDurableSnapshot();
  assert.equal(forward.v, 3);
  assert.equal("mindBindingOwners" in forward, false);
  restored = InMemoryRevisionMetadataStore.fromDurableSnapshot(forward);
  assert.equal(
    (await restored.readCredentialWriteTarget(OWNER, PRINCIPAL)).kind,
    "pending_upgrade",
  );
});

test("corrupt forward snapshots fail closed instead of reviving another owner generation", async () => {
  const store = new InMemoryRevisionMetadataStore();
  store.setCurrentAuthorizationStateForTest(
    { principalId: PRINCIPAL, spaceId: SPACE, tokenId: null },
    authorizationState(),
  );
  await register(store);
  await select(store);
  const snapshot = store.exportDurableSnapshot();
  const owner = snapshot.credentialWriteTargetOwners.get(OWNER);
  owner.state = {
    ...owner.state,
    activeGeneration: {
      ...owner.state.activeGeneration,
      bindingOwnerId: "grant_different_owner",
    },
  };
  assert.throws(
    () => InMemoryRevisionMetadataStore.fromDurableSnapshot(snapshot),
    /durable snapshot is invalid/u,
  );
});

test("Sites event persistence restores the exact owner generation without read state", async () => {
  const database = new FakeD1Database();
  let store = await createSitesMetadataStore(database);
  store.setCurrentAuthorizationStateForTest(
    { principalId: PRINCIPAL, spaceId: SPACE, tokenId: null },
    authorizationState(),
  );
  assert.equal((await register(store)).kind, "registered");
  assert.equal((await select(store)).kind, "applied");

  store = await createSitesMetadataStore(database);
  const restored = await store.readCredentialWriteTarget(OWNER, PRINCIPAL);
  assert.equal(restored.kind, "current");
  assert.equal(restored.state.activeGeneration.generationId, "target_generation_one");
  assert.equal(restored.state.captureGenerationId, null);
});
