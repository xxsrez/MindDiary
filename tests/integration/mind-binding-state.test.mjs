import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  MindBindingApplicationService,
} from "@mind-diary/application-content";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";
import { CAPABILITIES, bindingVersion, version } from "@mind-diary/domain";

import { createSitesMetadataStore } from "../../packages/adapter-metadata-sites/dist/index.js";
import { FakeD1Database } from "../../scripts/lib/fake-sites-storage.mjs";

const NOW = "2026-08-22T09:00:00.000Z";
const LATER = "2026-08-22T09:01:00.000Z";
const EXPIRY = "2026-11-20T09:00:00.000Z";
const PRINCIPAL_ID = "principal_binding_owner";
const TOKEN_ID = "token_binding_owner";
const BINDING_OWNER_ID = "grant_binding_owner";
const SPACE_A = "space_binding_alpha";
const SPACE_B = "space_binding_beta";
const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;

function actor(overrides = {}) {
  return {
    kind: "registered_principal",
    principalId: PRINCIPAL_ID,
    authentication: {
      kind: "mcp_token",
      tokenId: TOKEN_ID,
      bindingOwnerId: BINDING_OWNER_ID,
      effectiveScopes: ["content:read", "content:write"],
    },
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_binding_state",
    occurredAtUtc: NOW,
    ...overrides,
  };
}

function authorizationState(spaceId, overrides = {}) {
  return {
    principal: { principalId: PRINCIPAL_ID, state: "active" },
    space: {
      spaceId,
      state: "active",
      visibility: "private",
      accessVersion: version(1),
    },
    membership: {
      principalId: PRINCIPAL_ID,
      spaceId,
      role: "editor",
      state: "active",
      version: version(1),
    },
    token: {
      tokenId: TOKEN_ID,
      principalId: PRINCIPAL_ID,
      state: "active",
      scopes: ["content:read", "content:write"],
      version: version(1),
      expiresAt: EXPIRY,
    },
    ...overrides,
  };
}

function bindingIds() {
  let reads = 0;
  let writes = 0;
  let audits = 0;
  let outbox = 0;
  return {
    nextReadMindBindingId: () => `read_binding_${++reads}`,
    nextWriteMindBindingId: () => `write_binding_${++writes}`,
    nextMindBindingAuditEventId: () => `audit_binding_${++audits}`,
    nextMindBindingOutboxMessageId: () => `outbox_binding_${++outbox}`,
  };
}

function applicationHarness() {
  const metadata = new InMemoryRevisionMetadataStore();
  for (const spaceId of [SPACE_A, SPACE_B]) {
    metadata.setCurrentAuthorizationStateForTest(
      { principalId: PRINCIPAL_ID, spaceId, tokenId: TOKEN_ID },
      authorizationState(spaceId),
    );
  }
  const objects = new InMemoryObjectStore();
  const service = new MindBindingApplicationService({
    authorizer: new CapabilityAuthorizer(metadata),
    bindings: metadata,
    ids: bindingIds(),
    digest: objects,
  });
  return { metadata, service };
}

async function applyWrite(store, input) {
  return store.runMindBindingTransaction((transaction) =>
    transaction.applyWriteMindBinding({
      bindingOwnerId: BINDING_OWNER_ID,
      principalId: PRINCIPAL_ID,
      action: "bind",
      spaceId: input.spaceId,
      writeBindingId: input.writeBindingId,
      expectedBindingVersion: bindingVersion(input.expectedBindingVersion),
      idempotencyKey: input.idempotencyKey,
      canonicalRequestHash: input.canonicalRequestHash,
      requestId: `request_${input.idempotencyKey}`,
      auditEventId: `audit_${input.idempotencyKey}`,
      auditOutboxMessageId: `outbox_${input.idempotencyKey}`,
      occurredAt: input.occurredAt ?? NOW,
    }),
  );
}

test("application binding commands enforce fresh target authority, CAS and immutable generations", async () => {
  const { metadata, service } = applicationHarness();
  const currentActor = actor();

  const empty = await service.read({ actor: currentActor });
  assert.equal(empty.kind, "ready");
  assert.equal(empty.bindings.bindingSet.bindingVersion, 0);
  assert.deepEqual(empty.bindings.readBindings, []);
  assert.equal(empty.bindings.writeBinding, null);

  const attachedA = await service.mutateRead({
    actor: currentActor,
    action: "attach",
    spaceId: SPACE_A,
    expectedBindingVersion: 0,
    idempotencyKey: "attach-alpha",
  });
  assert.equal(attachedA.kind, "applied");
  assert.equal(attachedA.bindings.bindingSet.bindingVersion, 1);
  assert.deepEqual(attachedA.bindings.readBindings.map((item) => item.spaceId), [SPACE_A]);

  const replay = await service.mutateRead({
    actor: currentActor,
    action: "attach",
    spaceId: SPACE_A,
    expectedBindingVersion: 0,
    idempotencyKey: "attach-alpha",
  });
  assert.equal(replay.kind, "applied");
  assert.equal(replay.replayed, true);
  assert.equal(
    replay.bindings.readBindings[0].readBindingId,
    attachedA.bindings.readBindings[0].readBindingId,
  );

  const stale = await service.mutateRead({
    actor: currentActor,
    action: "attach",
    spaceId: SPACE_B,
    expectedBindingVersion: 0,
    idempotencyKey: "attach-beta-stale",
  });
  assert.deepEqual(stale, {
    kind: "binding_version_conflict",
    currentBindingVersion: 1,
  });

  const attachedB = await service.mutateRead({
    actor: currentActor,
    action: "attach",
    spaceId: SPACE_B,
    expectedBindingVersion: 1,
    idempotencyKey: "attach-beta",
  });
  assert.equal(attachedB.kind, "applied");
  assert.equal(attachedB.bindings.bindingSet.bindingVersion, 2);
  assert.deepEqual(
    attachedB.bindings.readBindings.map((item) => item.spaceId),
    [SPACE_A, SPACE_B],
  );

  const boundA = await service.mutateWrite({
    actor: currentActor,
    action: "bind",
    spaceId: SPACE_A,
    expectedBindingVersion: 2,
    idempotencyKey: "bind-alpha",
  });
  assert.equal(boundA.kind, "applied");
  assert.equal(boundA.bindings.bindingSet.bindingVersion, 3);
  assert.equal(boundA.bindings.writeBinding.spaceId, SPACE_A);
  assert.equal(boundA.bindings.writeBinding.generation, 3);
  const firstWriteId = boundA.bindings.writeBinding.writeBindingId;

  const reboundB = await service.mutateWrite({
    actor: currentActor,
    action: "bind",
    spaceId: SPACE_B,
    expectedBindingVersion: 3,
    idempotencyKey: "bind-beta",
  });
  assert.equal(reboundB.kind, "applied");
  assert.equal(reboundB.bindings.bindingSet.bindingVersion, 4);
  assert.equal(reboundB.bindings.writeBinding.spaceId, SPACE_B);
  assert.notEqual(reboundB.bindings.writeBinding.writeBindingId, firstWriteId);
  assert.equal(reboundB.previousWriteBinding.writeBindingId, firstWriteId);
  assert.equal(reboundB.previousWriteBinding.state, "invalidated");

  const reboundA = await service.mutateWrite({
    actor: currentActor,
    action: "bind",
    spaceId: SPACE_A,
    expectedBindingVersion: 4,
    idempotencyKey: "rebind-alpha",
  });
  assert.equal(reboundA.kind, "applied");
  assert.equal(reboundA.bindings.writeBinding.spaceId, SPACE_A);
  assert.notEqual(reboundA.bindings.writeBinding.writeBindingId, firstWriteId);

  const unbound = await service.mutateWrite({
    actor: currentActor,
    action: "unbind",
    expectedBindingVersion: 5,
    idempotencyKey: "unbind",
  });
  assert.equal(unbound.kind, "applied");
  assert.equal(unbound.bindings.bindingSet.bindingVersion, 6);
  assert.equal(unbound.bindings.writeBinding, null);

  metadata.setCurrentAuthorizationStateForTest(
    { principalId: PRINCIPAL_ID, spaceId: SPACE_A, tokenId: TOKEN_ID },
    authorizationState(SPACE_A, {
      membership: {
        ...authorizationState(SPACE_A).membership,
        role: "reader",
      },
    }),
  );
  const denied = await service.mutateWrite({
    actor: currentActor,
    action: "bind",
    spaceId: SPACE_A,
    expectedBindingVersion: 6,
    idempotencyKey: "bind-without-write",
  });
  assert.equal(denied.kind, "denied");
  assert.equal(denied.decision.code, "capability_denied");
  assert.equal((await service.read({ actor: currentActor })).bindings.writeBinding, null);
  const auditEvents = await metadata.listAuditEventsForTest();
  const auditOutbox = await metadata.listAuditOutboxForTest();
  assert.equal(auditEvents.length, 6);
  assert.equal(auditOutbox.length, 6);
  assert.equal(
    auditEvents.every((event) => event.eventType.startsWith("mind_binding.")),
    true,
  );
  assert.equal(JSON.stringify(auditEvents).includes(BINDING_OWNER_ID), false);
  assert.equal(JSON.stringify(auditEvents).includes(TOKEN_ID), false);
});

test("revoking a binding owner invalidates all active records and is terminal", async () => {
  const { metadata, service } = applicationHarness();
  const currentActor = actor();
  const read = await service.mutateRead({
    actor: currentActor,
    action: "attach",
    spaceId: SPACE_A,
    expectedBindingVersion: 0,
    idempotencyKey: "attach-before-revoke",
  });
  assert.equal(read.kind, "applied");
  const write = await service.mutateWrite({
    actor: currentActor,
    action: "bind",
    spaceId: SPACE_B,
    expectedBindingVersion: 1,
    idempotencyKey: "bind-before-revoke",
  });
  assert.equal(write.kind, "applied");

  const revoked = await metadata.revokeMindBindingOwner({
    bindingOwnerId: BINDING_OWNER_ID,
    principalId: PRINCIPAL_ID,
    requestId: "request_revoke_binding_owner",
    auditEventId: "audit_revoke_binding_owner",
    auditOutboxMessageId: "outbox_revoke_binding_owner",
    occurredAt: LATER,
  });
  assert.deepEqual(revoked, {
    kind: "revoked",
    invalidatedReadBindings: 1,
    invalidatedWriteBindings: 1,
    replayed: false,
  });
  const after = await service.read({ actor: actor({ occurredAtUtc: LATER }) });
  assert.equal(after.kind, "ready");
  assert.equal(after.bindings.bindingSet.state, "revoked");
  assert.deepEqual(after.bindings.readBindings, []);
  assert.equal(after.bindings.writeBinding, null);
  const terminal = await service.mutateWrite({
    actor: actor({ occurredAtUtc: LATER }),
    action: "unbind",
    expectedBindingVersion: after.bindings.bindingSet.bindingVersion,
    idempotencyKey: "unbind-after-revoke",
  });
  assert.deepEqual(terminal, { kind: "binding_owner_revoked" });
  assert.equal((await metadata.listAuditEventsForTest()).length, 3);
});

test("Sites event-log persistence reconciles unknown outcomes and serializes concurrent CAS", async () => {
  const database = new FakeD1Database();
  const first = await createSitesMetadataStore(database);
  const initial = await applyWrite(first, {
    spaceId: SPACE_A,
    writeBindingId: "write_sites_alpha",
    expectedBindingVersion: 0,
    idempotencyKey: "sites-bind-alpha",
    canonicalRequestHash: SHA_A,
  });
  assert.equal(initial.kind, "applied");
  assert.equal(initial.bindings.writeBinding.spaceId, SPACE_A);

  const restarted = await createSitesMetadataStore(database);
  const durable = await restarted.readMindBindingSet(
    BINDING_OWNER_ID,
    PRINCIPAL_ID,
    LATER,
  );
  assert.equal(durable.bindingSet.bindingVersion, 1);
  assert.equal(durable.writeBinding.writeBindingId, "write_sites_alpha");

  const reconciled = await applyWrite(restarted, {
    spaceId: SPACE_A,
    writeBindingId: "write_sites_unknown_retry",
    expectedBindingVersion: 0,
    idempotencyKey: "sites-bind-alpha",
    canonicalRequestHash: SHA_A,
  });
  assert.equal(reconciled.kind, "applied");
  assert.equal(reconciled.replayed, true);
  assert.equal(reconciled.bindings.writeBinding.writeBindingId, "write_sites_alpha");

  const left = await createSitesMetadataStore(database);
  const right = await createSitesMetadataStore(database);
  const race = await Promise.all([
    applyWrite(left, {
      spaceId: SPACE_B,
      writeBindingId: "write_sites_race_beta",
      expectedBindingVersion: 1,
      idempotencyKey: "sites-race-beta",
      canonicalRequestHash: SHA_B,
    }),
    applyWrite(right, {
      spaceId: SPACE_A,
      writeBindingId: "write_sites_race_alpha",
      expectedBindingVersion: 1,
      idempotencyKey: "sites-race-alpha",
      canonicalRequestHash: `sha256:${"c".repeat(64)}`,
    }),
  ]);
  assert.deepEqual(
    race.map((result) => result.kind).sort(),
    ["applied", "binding_version_conflict"],
  );
  const final = await (await createSitesMetadataStore(database)).readMindBindingSet(
    BINDING_OWNER_ID,
    PRINCIPAL_ID,
    LATER,
  );
  assert.equal(final.bindingSet.bindingVersion, 2);
  assert.ok([SPACE_A, SPACE_B].includes(final.writeBinding.spaceId));
  assert.equal(
    final.readBindings.length,
    0,
    "binding state remains service metadata and never changes content/read records",
  );
  assert.equal(
    (await (await createSitesMetadataStore(database)).listAuditEventsForTest()).length,
    2,
  );
});
