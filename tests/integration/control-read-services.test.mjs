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
  all() { return this.database.all(this.sql, this.values); }
  async first() { return (await this.all()).results?.[0] ?? null; }
}

class EventLogD1 {
  metadataSchemaVersion = 4;
  events = [];
  snapshot = null;
  snapshotHead = null;
  snapshotChunks = new Map();
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
  async run(sql, values) {
    if (/^\s*CREATE TABLE/u.test(sql)) return { meta: { changes: 0 } };
    if (sql.includes("/*md-metadata-migration*/")) {
      this.metadataSchemaVersion = Math.max(this.metadataSchemaVersion, Number(values[0]));
      return { meta: { changes: 1 } };
    }
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
    if (sql.includes("/*md-metadata-snapshot-write*/")) {
      const sequence = Number(values[0]);
      if (this.snapshotHead !== null && this.snapshotHead.sequence >= sequence) {
        return { meta: { changes: 0 } };
      }
      this.snapshotHead = {
        sequence,
        chunk_count: Number(values[1]),
        payload_chars: Number(values[2]),
      };
      return { meta: { changes: 1 } };
    }
    if (sql.includes("/*md-metadata-snapshot-chunk-write*/")) {
      this.snapshotChunks.set(`${values[0]}:${values[1]}`, {
        sequence: Number(values[0]),
        chunk_index: Number(values[1]),
        payload_json: values[2],
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("/*md-metadata-snapshot-cleanup*/")) {
      const headSequence = this.snapshotHead?.sequence ?? 0;
      let changes = 0;
      for (const [key, row] of this.snapshotChunks) {
        if (row.sequence >= headSequence) continue;
        this.snapshotChunks.delete(key);
        changes += 1;
      }
      return { meta: { changes } };
    }
    throw new Error(`unsupported statement: ${sql}`);
  }
  async all(sql, values) {
    if (sql.includes("/*md-metadata-cold-load*/")) {
      const rows = [];
      const baseSequence = this.snapshotHead?.sequence ?? this.snapshot?.sequence ?? 0;
      if (this.snapshotHead !== null) {
        rows.push(...[...this.snapshotChunks.values()]
          .filter((row) => row.sequence === this.snapshotHead.sequence)
          .sort((left, right) => left.chunk_index - right.chunk_index)
          .map((row) => ({
            row_kind: 0,
            sequence: this.snapshotHead.sequence,
            chunk_count: this.snapshotHead.chunk_count,
            payload_chars: this.snapshotHead.payload_chars,
            chunk_index: row.chunk_index,
            target: null,
            operation: null,
            payload_json: row.payload_json,
            schema_version: this.metadataSchemaVersion,
          })));
      } else if (this.snapshot !== null) {
        rows.push({
          row_kind: 1,
          sequence: this.snapshot.sequence,
          chunk_count: 1,
          payload_chars: this.snapshot.payload_json.length,
          chunk_index: 0,
          target: null,
          operation: null,
          payload_json: this.snapshot.payload_json,
          schema_version: this.metadataSchemaVersion,
        });
      }
      rows.push(...this.events
        .filter((row) => row.sequence > baseSequence)
        .map((row) => ({
          row_kind: 2,
          sequence: row.sequence,
          chunk_count: null,
          payload_chars: null,
          chunk_index: null,
          target: row.target,
          operation: row.operation,
          payload_json: row.payload_json,
          schema_version: this.metadataSchemaVersion,
        })));
      if (rows.length === 0) {
        rows.push({
          row_kind: 3,
          sequence: 0,
          chunk_count: null,
          payload_chars: null,
          chunk_index: null,
          target: null,
          operation: null,
          payload_json: "",
          schema_version: this.metadataSchemaVersion,
        });
      }
      return { results: rows };
    }
    if (sql.includes("/*md-metadata-snapshot-head-read*/")) {
      return { results: this.snapshotHead === null ? [] : [{ ...this.snapshotHead }] };
    }
    if (sql.includes("/*md-metadata-snapshot-chunks-read*/")) {
      return {
        results: [...this.snapshotChunks.values()]
          .filter((row) =>
            row.sequence === Number(values[0]) &&
            row.chunk_index >= Number(values[1]))
          .sort((left, right) => left.chunk_index - right.chunk_index)
          .slice(0, Number(values[2]))
          .map((row) => ({
            chunk_index: row.chunk_index,
            payload_json: row.payload_json,
          })),
      };
    }
    if (sql.includes("/*md-metadata-snapshot-read*/")) {
      return { results: this.snapshot === null ? [] : [{ ...this.snapshot }] };
    }
    if (sql.includes("/*md-metadata-events-tail*/")) {
      return {
        results: this.events
          .filter((event) => event.sequence > Number(values[0]))
          .map((event) => ({ ...event })),
      };
    }
    if (sql.includes("/*md-metadata-events-migration*/")) {
      return { results: this.events.map((event) => ({ ...event })) };
    }
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
