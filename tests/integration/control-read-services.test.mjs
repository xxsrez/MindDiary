import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  AccountBootstrapService,
  ControlReadService,
  InvitationControlService,
  MembershipControlService,
  OrdinaryMindControlService,
} from "@mind-diary/application-control";
import { CAPABILITIES, verifiedSpaceHost } from "@mind-diary/domain";
import { createSitesMetadataStore } from "../../packages/adapter-metadata-sites/dist/index.js";

const T0 = "2026-08-08T09:00:00.000Z";
const T1 = "2026-08-08T09:05:00.000Z";
const HOST = verifiedSpaceHost("mind-diary.example");

class Statement {
  values = [];
  constructor(database, sql) { this.database = database; this.sql = sql; }
  bind(...values) { this.values = values; return this; }
  run() { return this.database.run(this.sql, this.values); }
  all() { return this.database.all(this.sql); }
  async first() { return (await this.all()).results?.[0] ?? null; }
}

class EventLogD1 {
  events = [];
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
  async run(sql, values) {
    if (/^\s*CREATE TABLE/u.test(sql)) return { meta: { changes: 0 } };
    if (sql.includes("migration*/")) return { meta: { changes: 1 } };
    if (sql.includes("/*md-metadata-append*/")) {
      const current = this.events.at(-1)?.sequence ?? 0;
      if (current !== Number(values[5])) return { meta: { changes: 0 } };
      this.events.push({
        sequence: Number(values[0]),
        target: values[1],
        operation: values[2],
        payload_json: values[3],
      });
      return { meta: { changes: 1 } };
    }
    throw new Error(`unsupported statement: ${sql}`);
  }
  async all(sql) {
    if (sql.includes("/*md-metadata-events*/")) {
      return { results: this.events.map((event) => ({ ...event })) };
    }
    throw new Error(`unsupported query: ${sql}`);
  }
}

function preRegistration(index) {
  return {
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding: `member.${index}@example.com`,
    suggestedDisplayName: `Member ${index}`,
    deploymentCapabilities: CAPABILITIES,
    requestId: `request_bootstrap_${index}`,
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

function ids() {
  let value = 0;
  const next = (prefix) => `${prefix}_${++value}`;
  return {
    nextPrincipalId: () => next("principal"),
    nextExternalBindingId: () => next("binding"),
    nextSpaceId: () => next("space"),
    nextMembershipId: () => next("membership"),
    nextRevisionId: () => next("revision"),
    nextPersonalSpaceHandle: () => `personal-service-${++value}`,
    nextInvitationId: () => next("invitation"),
    nextInvitationExpiryJobId: () => next("invitation-job"),
    nextAuditEventId: () => next("audit"),
    nextOutboxMessageId: () => next("outbox"),
  };
}

test("durable Sites membership CAS and safe read projections survive reconstruction", async () => {
  const database = new EventLogD1();
  const objects = new InMemoryObjectStore();
  const generated = ids();
  let metadata = await createSitesMetadataStore(database);
  const bootstrap = new AccountBootstrapService({ accounts: metadata, objects, ids: generated });
  const owner = await bootstrap.bootstrapAccount(preRegistration(1), { action: "create_isolated_account" });
  const target = await bootstrap.bootstrapAccount(preRegistration(2), { action: "create_isolated_account" });
  const ordinary = new OrdinaryMindControlService({ ordinaryMinds: metadata, objects, ids: generated, host: HOST });
  const mind = await ordinary.createSpaceWithOwner(
    actor(owner.principalId, "request_create_mind", T0),
    { name: "Shared", handle: "shared", idempotencyKey: "create-shared" },
  );
  const invitations = new InvitationControlService({ invitations: metadata, objects, ids: generated });
  const invitation = await invitations.createInvitation(
    actor(owner.principalId, "request_invite"),
    {
      mindId: mind.mindId,
      targetVerifiedEmail: "member.2@example.com",
      role: "reader",
      expectedMetadataVersion: mind.metadataVersion,
      idempotencyKey: "invite-member-two",
    },
  );
  const accepted = await invitations.acceptInvitation(
    actor(target.principalId, "request_accept"),
    {
      invitationId: invitation.invitationId,
      expectedInvitationVersion: invitation.invitationVersion,
      idempotencyKey: "accept-member-two",
    },
  );
  assert.ok(accepted.membershipId);

  metadata = await createSitesMetadataStore(database);
  const reads = new ControlReadService(metadata);
  const before = await reads.listMembers(
    actor(owner.principalId, "request_members_before"),
    mind.mindId,
  );
  assert.deepEqual(
    before.members.map(({ displayName, role, isSelf }) => [displayName, role, isSelf]),
    [["Member 1", "owner", true], ["Member 2", "reader", false]],
  );
  assert.equal("principalId" in before.members[0], false);
  const incoming = await reads.listInvitations(
    actor(target.principalId, "request_invitations"),
  );
  assert.deepEqual(
    incoming.invitations.map(({ direction, counterpartyDisplayName, state }) => [direction, counterpartyDisplayName, state]),
    [["incoming", "Member 1", "accepted"]],
  );

  const memberships = new MembershipControlService({
    memberships: metadata,
    digest: objects,
    auditIds: generated,
  });
  const changed = await memberships.changeMembershipRole(
    actor(owner.principalId, "request_promote"),
    {
      mindId: mind.mindId,
      memberId: accepted.membershipId,
      role: "editor",
      expectedMembershipVersion: 1,
      idempotencyKey: "promote-member-two",
    },
  );
  assert.equal(changed.role, "editor");
  assert.equal(changed.membershipVersion, 2);

  const reconstructed = await createSitesMetadataStore(database);
  const after = await new ControlReadService(reconstructed).listMembers(
    actor(owner.principalId, "request_members_after"),
    mind.mindId,
  );
  assert.equal(after.members.find(({ memberId }) => memberId === accepted.membershipId).role, "editor");
});
