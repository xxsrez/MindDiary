import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryAuditSink } from "@mind-diary/adapter-audit-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import { InMemoryExactRevisionSearchIndex } from "@mind-diary/adapter-search-memory";
import {
  AccountDeletionService,
  AccountBootstrapService,
  InvitationControlService,
  OrdinaryMindDeletionService,
  OrdinaryMindControlService,
  OwnershipTransferService,
} from "@mind-diary/application-control";
import { CAPABILITIES, MARKDOWN_MEDIA_TYPE, verifiedSpaceHost } from "@mind-diary/domain";
import {
  COMPOSITION_SELECTION,
  createSitesPersistenceBoundary,
} from "@mind-diary/composition-root";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";

import {
  createSitesMetadataStore,
} from "../../packages/adapter-metadata-sites/dist/index.js";

const T0 = "2026-08-08T08:00:00.000Z";
const T1 = "2026-08-08T08:05:00.000Z";
const T2 = "2026-08-08T08:10:00.000Z";
const T3 = "2026-08-08T08:15:00.000Z";
const T4 = "2026-08-08T08:20:00.000Z";
const T5 = "2026-08-08T08:25:00.000Z";
const HOST = verifiedSpaceHost("mind-diary.example");
const SHA_A = `sha256:${"a".repeat(64)}`;

class FakeD1Statement {
  #database;
  #sql;
  #values = [];

  constructor(database, sql) {
    this.#database = database;
    this.#sql = sql;
  }

  bind(...values) {
    this.#values = values;
    return this;
  }

  async run() {
    return this.#database.run(this.#sql, this.#values);
  }

  async all() {
    return this.#database.all(this.#sql, this.#values);
  }

  async first() {
    return (await this.all()).results?.[0] ?? null;
  }
}

class FakeD1Database {
  metadataEvents = [];
  search = new Map();
  audit = new Map();
  locatorHandles = new Map();
  #failTag = null;

  prepare(sql) {
    return new FakeD1Statement(this, sql);
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  failNext(tag) {
    this.#failTag = tag;
  }

  #maybeFail(sql) {
    if (this.#failTag && sql.includes(this.#failTag)) {
      const tag = this.#failTag;
      this.#failTag = null;
      throw new Error(`synthetic D1 failure at ${tag}`);
    }
  }

  async run(sql, values) {
    this.#maybeFail(sql);
    if (/^\s*(?:CREATE TABLE|CREATE INDEX)/u.test(sql)) {
      return { success: true, meta: { changes: 0 } };
    }
    if (sql.includes("migration*/")) {
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-metadata-append*/")) {
      const expected = Number(values[5]);
      const current = this.metadataEvents.at(-1)?.sequence ?? 0;
      if (current !== expected) return { success: true, meta: { changes: 0 } };
      this.metadataEvents.push({
        sequence: Number(values[0]),
        target: values[1],
        operation: values[2],
        payload_json: values[3],
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-locator-create*/")) {
      this.locatorHandles.set(values[0], {
        encrypted_payload: values[1],
        expires_at: values[2],
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-locator-cleanup*/")) {
      const expired = [...this.locatorHandles.entries()]
        .filter(([, row]) => row.expires_at <= values[0])
        .slice(0, 64);
      for (const [key] of expired) this.locatorHandles.delete(key);
      return { success: true, meta: { changes: expired.length } };
    }
    if (sql.includes("/*md-locator-delete*/")) {
      return { success: true, meta: { changes: this.locatorHandles.delete(values[0]) ? 1 : 0 } };
    }
    if (sql.includes("/*md-search-replace*/")) {
      this.search.set(`${values[0]}\u0000${values[1]}`, values[2]);
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-search-purge*/")) {
      let changed = 0;
      for (const key of [...this.search.keys()]) {
        if (key.startsWith(`${values[0]}\u0000`)) {
          this.search.delete(key);
          changed += 1;
        }
      }
      return { success: true, meta: { changes: changed } };
    }
    if (sql.includes("/*md-audit-deliver*/")) {
      const id = values[0];
      if (this.audit.has(id)) return { success: true, meta: { changes: 0 } };
      this.audit.set(id, {
        audit_event_id: id,
        space_id: values[1],
        actor_kind: values[2],
        principal_id: values[3],
        event_json: values[4],
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("/*md-audit-purge*/")) {
      let changed = 0;
      for (const [id, row] of [...this.audit]) {
        if (row.space_id === values[0]) {
          this.audit.delete(id);
          changed += 1;
        }
      }
      return { success: true, meta: { changes: changed } };
    }
    if (sql.includes("/*md-audit-tombstone*/")) {
      const row = this.audit.get(values[1]);
      if (!row || row.principal_id !== values[2]) {
        return { success: true, meta: { changes: 0 } };
      }
      this.audit.set(values[1], {
        ...row,
        actor_kind: "deleted-principal",
        principal_id: null,
        event_json: values[0],
      });
      return { success: true, meta: { changes: 1 } };
    }
    throw new Error(`unsupported FakeD1 run statement: ${sql}`);
  }

  async all(sql, values) {
    this.#maybeFail(sql);
    if (sql.includes("/*md-metadata-events*/")) {
      return { success: true, results: this.metadataEvents.map((row) => ({ ...row })) };
    }
    if (sql.includes("/*md-locator-read*/")) {
      const row = this.locatorHandles.get(values[0]);
      return { success: true, results: row ? [{ ...row }] : [] };
    }
    if (sql.includes("/*md-search-read*/")) {
      const documents_json = this.search.get(`${values[0]}\u0000${values[1]}`);
      return {
        success: true,
        results: documents_json === undefined ? [] : [{ documents_json }],
      };
    }
    if (sql.includes("/*md-audit-by-principal*/")) {
      return {
        success: true,
        results: [...this.audit.values()]
          .filter((row) => row.principal_id === values[0])
          .sort((left, right) => left.audit_event_id.localeCompare(right.audit_event_id))
          .map((row) => ({
            audit_event_id: row.audit_event_id,
            event_json: row.event_json,
          })),
      };
    }
    throw new Error(`unsupported FakeD1 all statement: ${sql}`);
  }
}

class FakeR2Body {
  constructor(record) {
    this.key = record.key;
    this.size = record.bytes.byteLength;
    this.etag = record.etag;
    this.customMetadata = { ...record.customMetadata };
    this.#bytes = new Uint8Array(record.bytes);
  }

  #bytes;

  async arrayBuffer() {
    return new Uint8Array(this.#bytes).buffer;
  }
}

class FakeR2Bucket {
  records = new Map();
  #version = 0;
  #failDelete = false;

  async get(key) {
    const record = this.records.get(key);
    return record ? new FakeR2Body(record) : null;
  }

  async put(key, value, options = {}) {
    const current = this.records.get(key);
    if (options.onlyIf?.etagDoesNotMatch === "*" && current) return null;
    if (options.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) {
      return null;
    }
    const bytes = value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
    const record = {
      key,
      bytes,
      etag: `etag-${++this.#version}`,
      customMetadata: { ...(options.customMetadata ?? {}) },
    };
    this.records.set(key, record);
    return new FakeR2Body(record);
  }

  async delete(keyOrKeys) {
    if (this.#failDelete) {
      this.#failDelete = false;
      throw new Error("synthetic R2 delete failure");
    }
    for (const key of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) {
      this.records.delete(key);
    }
  }

  async list(options = {}) {
    const all = [...this.records.values()]
      .filter((record) => record.key.startsWith(options.prefix ?? ""))
      .sort((left, right) => left.key.localeCompare(right.key));
    const offset = Number(options.cursor ?? 0);
    const limit = options.limit ?? 1000;
    const page = all.slice(offset, offset + limit).map((record) => new FakeR2Body(record));
    const next = offset + page.length;
    return {
      objects: page,
      truncated: next < all.length,
      ...(next < all.length ? { cursor: String(next) } : {}),
    };
  }

  failNextDelete() {
    this.#failDelete = true;
  }
}

function preRegistrationActor(index, occurredAtUtc = T0) {
  return {
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding: `sites.persistence.${index}@example.invalid`,
    suggestedDisplayName: `Sites Principal ${index}`,
    deploymentCapabilities: CAPABILITIES,
    requestId: `request_sites_bootstrap_${index}`,
    occurredAtUtc,
  };
}

function actor(principalId, requestId, occurredAtUtc) {
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
  let account = 0;
  let ordinary = 0;
  let ownerMembership = 0;
  let revision = 0;
  let invitation = 0;
  let invitationMembership = 0;
  let invitationJob = 0;
  let audit = 0;
  let outbox = 0;
  return {
    account: {
      nextPrincipalId: () => `principal_sites_${++account}`,
      nextExternalBindingId: () => `binding_sites_${account}`,
      nextSpaceId: () => `space_personal_sites_${account}`,
      nextMembershipId: () => `membership_personal_sites_${account}`,
      nextRevisionId: () => `revision_personal_sites_${account}`,
      nextPersonalSpaceHandle: () => `personal-sites-${account}`,
    },
    ordinary: {
      nextSpaceId: () => `space_sites_${++ordinary}`,
      nextMembershipId: () => `membership_owner_sites_${++ownerMembership}`,
      nextRevisionId: () => `revision_ordinary_sites_${++revision}`,
    },
    invitation: {
      nextInvitationId: () => `invitation_sites_${++invitation}`,
      nextMembershipId: () => `membership_invited_sites_${++invitationMembership}`,
      nextInvitationExpiryJobId: () => `job_invitation_sites_${++invitationJob}`,
    },
    audit: {
      nextAuditEventId: () => `audit_sites_${++audit}`,
      nextOutboxMessageId: () => `outbox_sites_${++outbox}`,
    },
  };
}

function services(boundary, generators) {
  return {
    bootstrap: new AccountBootstrapService({
      accounts: boundary.metadata,
      objects: boundary.objects,
      ids: generators.account,
    }),
    ordinary: new OrdinaryMindControlService({
      ordinaryMinds: boundary.metadata,
      objects: boundary.objects,
      host: HOST,
      ids: generators.ordinary,
    }),
    invitations: new InvitationControlService({
      invitations: boundary.metadata,
      objects: boundary.objects,
      ids: generators.invitation,
    }),
    ownership: new OwnershipTransferService({
      ordinaryMinds: boundary.metadata,
      objects: boundary.objects,
      auditIds: generators.audit,
    }),
  };
}

function nextEnvelope(base, revisionId, committedAt) {
  return Object.freeze({
    manifest: base.manifest,
    revision: Object.freeze({
      ...base.revision,
      revisionId,
      revisionNumber: base.revision.revisionNumber + 1,
      parentRevisionId: base.revision.revisionId,
      committedAt,
      summary: `Sites CAS ${revisionId}`,
    }),
  });
}

function deletionIds() {
  let impacts = 0;
  let deletedPrincipals = 0;
  return {
    nextImpactId: () => `impact_sites_${++impacts}`,
    nextDeletedPrincipalId: () => `deleted_principal_sites_${++deletedPrincipals}`,
  };
}

async function idempotentCommitRecord(store, namespace, revisionId) {
  return store.runContentCommitTransaction(async (transaction) => {
    const check = await transaction.checkIdempotency({
      namespace,
      canonicalRequestHash: SHA_A,
    });
    if (check.kind !== "missing") return check;
    return transaction.completeIdempotency({
      namespace,
      canonicalRequestHash: SHA_A,
      result: {
        kind: "commit_changeset",
        previousRevisionId: null,
        revisionId,
      },
      completedAt: T5,
    });
  });
}

test("legacy active HEAD without index effects replays and is backfilled exactly once", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  const generators = ids();
  let boundary = await createSitesPersistenceBoundary({ database, bucket });
  const app = services(boundary, generators);
  const created = await app.bootstrap.bootstrapAccount(preRegistrationActor(1), {
    action: "create_isolated_account",
  });
  const bootstrapEvent = database.metadataEvents.find(
    (event) => event.operation === "runAccountBootstrapTransaction",
  );
  assert.ok(bootstrapEvent);
  const payload = JSON.parse(bootstrapEvent.payload_json);
  const createCall = payload.calls.find((call) => call.method === "createAccountBootstrap");
  assert.ok(createCall);
  delete createCall.args[0].initialIndexJob;
  delete createCall.args[0].initialIndexState;
  bootstrapEvent.payload_json = JSON.stringify(payload);

  boundary = await createSitesPersistenceBoundary({ database, bucket });
  const personal = await boundary.metadata.resolvePersonalMind(created.principalId);
  assert.ok(personal);
  assert.equal(
    await boundary.metadata.readRevisionIndexState(
      personal.spaceId,
      personal.headRevisionId,
    ),
    null,
  );
  assert.deepEqual(
    await boundary.metadata.listActiveRevisionIndexGaps(10),
    [{ spaceId: personal.spaceId, revisionId: personal.headRevisionId }],
  );

  const recoveryState = {
    spaceId: personal.spaceId,
    revisionId: personal.headRevisionId,
    status: "queued",
    attempts: 0,
    queuedAt: T1,
    updatedAt: T1,
    readyAt: null,
    lastFailureCode: null,
  };
  const makeJob = (jobId) => ({
    jobId,
    target: {
      kind: "revision_index",
      spaceId: personal.spaceId,
      revisionId: personal.headRevisionId,
    },
    state: "queued",
    version: 1,
    attempts: 0,
    availableAt: T1,
    claimExpiresAt: null,
    createdAt: T1,
    updatedAt: T1,
  });
  const [first, second] = await Promise.all([
    boundary.metadata.ensureRevisionIndexQueued(makeJob("job_recovery_a"), recoveryState),
    boundary.metadata.ensureRevisionIndexQueued(makeJob("job_recovery_b"), recoveryState),
  ]);
  assert.deepEqual(
    [first.kind, second.kind].sort(),
    ["already_present", "queued"],
  );
  const due = await boundary.metadata.listRecoverableIndexJobs(T1, 10);
  assert.equal(due.length, 1);
  assert.equal(due[0].target.revisionId, personal.headRevisionId);
});

test("Sites composition persists account, invitation, ownership, HEAD CAS, idempotency and token state across isolates", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  const generators = ids();
  let boundary = await createSitesPersistenceBoundary({ database, bucket });
  let app = services(boundary, generators);

  const owner = await app.bootstrap.bootstrapAccount(preRegistrationActor(1), {
    action: "create_isolated_account",
  });
  const target = await app.bootstrap.bootstrapAccount(preRegistrationActor(2), {
    action: "create_isolated_account",
  });
  const mind = await app.ordinary.createSpaceWithOwner(
    actor(owner.principalId, "request_sites_create", T1),
    { name: "Durable Mind", handle: "durable-mind", idempotencyKey: "create-durable" },
  );
  const invitation = await app.invitations.createInvitation(
    actor(owner.principalId, "request_sites_invite", T2),
    {
      mindId: mind.mindId,
      targetVerifiedEmail: "sites.persistence.2@example.invalid",
      role: "editor",
      expectedMetadataVersion: 1,
      idempotencyKey: "invite-durable",
    },
  );

  boundary = await createSitesPersistenceBoundary({ database, bucket });
  app = services(boundary, generators);
  const accepted = await app.invitations.acceptInvitation(
    actor(target.principalId, "request_sites_accept", T3),
    {
      invitationId: invitation.invitationId,
      expectedInvitationVersion: 1,
      idempotencyKey: "accept-durable",
    },
  );
  const beforeTransfer = await boundary.metadata.inspectOrdinaryMindStateForTest(mind.mindId);
  assert.ok(beforeTransfer);
  const transferred = await app.ownership.transferOwnership(
    actor(owner.principalId, "request_sites_transfer", T4),
    {
      mindId: mind.mindId,
      targetMemberId: accepted.membershipId,
      expectedMetadataVersion: beforeTransfer.space.metadataVersion,
      confirmation: "transfer-ownership",
      idempotencyKey: "transfer-durable",
    },
  );
  assert.equal(transferred.targetRole, "owner");

  const restarted = await createSitesPersistenceBoundary({ database, bucket });
  const finalMind = await restarted.metadata.inspectOrdinaryMindStateForTest(mind.mindId);
  assert.ok(finalMind);
  assert.deepEqual(
    finalMind.memberships
      .filter((membership) => membership.state === "active" && membership.role === "owner")
      .map((membership) => membership.principalId),
    [target.principalId],
  );
  assert.ok(await restarted.metadata.readAccount(owner.principalId));
  assert.ok(await restarted.metadata.readAccount(target.principalId));

  const base = await restarted.metadata.readRevision(mind.mindId, mind.headRevisionId);
  assert.ok(base);
  const first = await createSitesMetadataStore(database);
  const second = await createSitesMetadataStore(database);
  const race = await Promise.all([
    first.commitRevision({
      expectedHeadRevisionId: mind.headRevisionId,
      envelope: nextEnvelope(base, "revision_sites_race_a", T5),
    }),
    second.commitRevision({
      expectedHeadRevisionId: mind.headRevisionId,
      envelope: nextEnvelope(base, "revision_sites_race_b", T5),
    }),
  ]);
  assert.deepEqual(race.map((result) => result.kind).sort(), ["committed", "stale_head"]);
  const winningRevision = race.find((result) => result.kind === "committed").envelope.revision.revisionId;
  assert.equal((await createSitesMetadataStore(database)).readHead instanceof Function, true);
  assert.equal(await (await createSitesMetadataStore(database)).readHead(mind.mindId), winningRevision);

  const namespace = {
    principalId: owner.principalId,
    spaceId: mind.mindId,
    operation: "commit_changeset",
    key: "sites-idempotency-race",
  };
  const idempotencyRace = await Promise.all([
    idempotentCommitRecord(await createSitesMetadataStore(database), namespace, winningRevision),
    idempotentCommitRecord(await createSitesMetadataStore(database), namespace, winningRevision),
  ]);
  assert.deepEqual(
    idempotencyRace.map((result) => result.kind).sort(),
    ["completed", "replay"],
  );
  assert.equal((await (await createSitesMetadataStore(database)).listIdempotencyRecordsForTest()).length, 1);

  const tokenStore = await createSitesMetadataStore(database);
  const createdToken = await tokenStore.createMcpToken({
    tokenId: "token_sites_durable",
    principalId: owner.principalId,
    name: "Codex durable fixture",
    verifier: `hmac-sha256:v1:${"b".repeat(64)}`,
    displayPrefix: "mdp_v1_abcdef…",
    scopes: ["content:read", "content:write"],
    createdAt: T0,
    expiresAt: "2026-11-06T08:00:00.000Z",
  });
  assert.equal(createdToken.kind, "created");
  assert.equal(
    (await (await createSitesMetadataStore(database)).listMcpTokenMetadata(owner.principalId)).length,
    1,
  );

  const currentAuthorization = await tokenStore.readCurrentAuthorizationState({
    principalId: owner.principalId,
    spaceId: mind.mindId,
    tokenId: "token_sites_durable",
  });
  assert.equal(currentAuthorization?.token?.tokenId, "token_sites_durable");
  assert.equal(currentAuthorization?.membership?.principalId, owner.principalId);
  const routeAuthorization = await tokenStore.readCurrentRouteAuthorizationState({
    principalId: owner.principalId,
    spaceId: mind.mindId,
    tokenId: "token_sites_durable",
    host: HOST,
    handle: mind.handle,
  });
  assert.equal(routeAuthorization?.token?.tokenId, "token_sites_durable");

  const mcpActor = {
    kind: "registered_principal",
    principalId: owner.principalId,
    authentication: {
      kind: "mcp_token",
      tokenId: "token_sites_durable",
      effectiveScopes: ["content:read", "content:write"],
    },
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_sites_mcp_authorization",
    occurredAtUtc: T5,
  };
  const authorizationRequest = {
    actor: mcpActor,
    spaceId: mind.mindId,
    capability: "content:browse",
    revisionMode: "head",
  };
  const authorizer = new CapabilityAuthorizer(tokenStore);
  const authorized = await authorizer.authorize(authorizationRequest);
  assert.equal(authorized.kind, "allowed");
  const transactionAuthorization = await tokenStore.runContentCommitTransaction(
    (transaction) =>
      authorizer.reauthorizeInTransaction(
        authorizationRequest,
        transaction,
        authorized.stamp,
      ),
  );
  assert.equal(transactionAuthorization.kind, "allowed");

  const concurrentRevoker = await createSitesMetadataStore(database);
  let authorizationAttempts = 0;
  const revokedDuringTransaction = await tokenStore.runContentCommitTransaction(
    async (transaction) => {
      authorizationAttempts += 1;
      const decision = await authorizer.reauthorizeInTransaction(
        authorizationRequest,
        transaction,
        authorized.stamp,
      );
      if (authorizationAttempts === 1) {
        assert.equal(decision.kind, "allowed");
        const revocation = await concurrentRevoker.revokeMcpToken({
          principalId: owner.principalId,
          tokenId: "token_sites_durable",
          revokedAt: "2026-08-08T08:26:00.000Z",
        });
        assert.equal(revocation.kind, "revoked");
      }
      return decision;
    },
  );
  assert.equal(authorizationAttempts, 2);
  assert.deepEqual(revokedDuringTransaction, {
    kind: "denied",
    code: "token_inactive",
    retryable: false,
  });

  const winning = await tokenStore.readRevision(mind.mindId, winningRevision);
  assert.ok(winning);
  const effects = {
    auditEvent: {
      auditEventId: "audit_sites_retry",
      actor: { kind: "principal", principalId: owner.principalId },
      requestId: "request_sites_retry",
      eventType: "content.changeset_committed",
      outcome: "succeeded",
      spaceId: mind.mindId,
      occurredAt: T5,
      safeMetadata: {
        revision_id: winning.revision.revisionId,
        previous_revision_id: winning.revision.parentRevisionId,
        revision_number: winning.revision.revisionNumber,
        manifest_hash: winning.revision.manifestHash,
      },
    },
    auditOutbox: {
      outboxMessageId: "outbox_sites_retry",
      auditEventId: "audit_sites_retry",
      state: "pending",
      version: 1,
      attempts: 0,
      availableAt: T5,
      claimExpiresAt: null,
      createdAt: T5,
      updatedAt: T5,
    },
    indexJob: {
      jobId: "index_job_sites_retry",
      target: {
        kind: "revision_index",
        spaceId: mind.mindId,
        revisionId: winning.revision.revisionId,
      },
      state: "queued",
      version: 1,
      attempts: 0,
      availableAt: T5,
      claimExpiresAt: null,
      createdAt: T5,
      updatedAt: T5,
    },
    indexState: {
      spaceId: mind.mindId,
      revisionId: winning.revision.revisionId,
      status: "queued",
      attempts: 0,
      queuedAt: T5,
      updatedAt: T5,
      readyAt: null,
      lastFailureCode: null,
    },
  };
  assert.deepEqual(
    await tokenStore.runContentCommitTransaction((transaction) =>
      transaction.stageContentCommitEffects(effects),
    ),
    { kind: "staged" },
  );

  const indexClaim = await tokenStore.claimIndexJob(
    "index_job_sites_retry",
    T5,
    "2026-08-08T08:29:00.000Z",
  );
  const auditClaim = await tokenStore.claimAuditOutbox(
    "outbox_sites_retry",
    T5,
    "2026-08-08T08:29:00.000Z",
  );
  assert.equal(indexClaim.kind, "claimed");
  assert.equal(auditClaim.kind, "claimed");
  assert.equal(
    await tokenStore.failIndexJob(
      "index_job_sites_retry",
      indexClaim.job.version,
      "synthetic_retry",
      "2026-08-08T08:26:00.000Z",
      "2026-08-08T08:27:00.000Z",
    ),
    true,
  );
  assert.equal(
    await tokenStore.failAuditOutbox(
      "outbox_sites_retry",
      auditClaim.message.version,
      "2026-08-08T08:26:00.000Z",
      "2026-08-08T08:27:00.000Z",
    ),
    true,
  );

  const retryStore = await createSitesMetadataStore(database);
  const retryIndexClaim = await retryStore.claimIndexJob(
    "index_job_sites_retry",
    "2026-08-08T08:27:00.000Z",
    "2026-08-08T08:31:00.000Z",
  );
  const retryAuditClaim = await retryStore.claimAuditOutbox(
    "outbox_sites_retry",
    "2026-08-08T08:27:00.000Z",
    "2026-08-08T08:31:00.000Z",
  );
  assert.equal(retryIndexClaim.kind, "claimed");
  assert.equal(retryAuditClaim.kind, "claimed");
  assert.equal(retryIndexClaim.job.attempts, 2);
  assert.equal(retryAuditClaim.message.attempts, 2);
  assert.equal(
    await retryStore.completeIndexJob(
      "index_job_sites_retry",
      retryIndexClaim.job.version,
      "2026-08-08T08:28:00.000Z",
    ),
    true,
  );
  assert.equal(
    await retryStore.completeAuditOutbox(
      "outbox_sites_retry",
      retryAuditClaim.message.version,
      "2026-08-08T08:28:00.000Z",
    ),
    true,
  );
  const completedStore = await createSitesMetadataStore(database);
  assert.equal(
    (await completedStore.readRevisionIndexState(mind.mindId, winningRevision)).status,
    "ready",
  );
  assert.deepEqual(
    await completedStore.claimAuditOutbox(
      "outbox_sites_retry",
      "2026-08-08T08:29:00.000Z",
      "2026-08-08T08:30:00.000Z",
    ),
    { kind: "completed" },
  );
});

test("D1 mutation failure exposes no process-memory success and retry survives restart", async () => {
  const database = new FakeD1Database();
  const store = await createSitesMetadataStore(database);
  database.failNext("/*md-metadata-append*/");
  await assert.rejects(
    store.reserveHandle({ host: HOST, handle: "retry-handle", spaceId: "space_retry" }),
    /synthetic D1 failure/u,
  );
  assert.deepEqual(
    await (await createSitesMetadataStore(database)).resolveHandle({
      host: HOST,
      handle: "retry-handle",
    }),
    { kind: "not_found" },
  );
  assert.equal(
    (await store.reserveHandle({
      host: HOST,
      handle: "retry-handle",
      spaceId: "space_retry",
    })).kind,
    "reserved",
  );
  assert.deepEqual(
    await (await createSitesMetadataStore(database)).resolveHandle({
      host: HOST,
      handle: "retry-handle",
    }),
    { kind: "resolved", spaceId: "space_retry" },
  );
});

test("whole-Mind and account cleanup resume from durable deletion state after restart", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  const generators = ids();
  let boundary = await createSitesPersistenceBoundary({ database, bucket });
  const app = services(boundary, generators);
  const owner = await app.bootstrap.bootstrapAccount(preRegistrationActor(10), {
    action: "create_isolated_account",
  });
  const mind = await app.ordinary.createSpaceWithOwner(
    actor(owner.principalId, "request_sites_delete_create", T1),
    {
      name: "Restartable deletion",
      handle: "restartable-deletion",
      idempotencyKey: "create-restartable-deletion",
    },
  );

  let failMindIndexPurge = true;
  const failingMindIndex = {
    kind: "search-index",
    replaceExactRevision: (request) => boundary.index.replaceExactRevision(request),
    readExactRevision: (spaceId, revisionId) =>
      boundary.index.readExactRevision(spaceId, revisionId),
    purgeSpace: async (spaceId) => {
      if (failMindIndexPurge) {
        failMindIndexPurge = false;
        throw new Error("synthetic Mind index cleanup failure");
      }
      return boundary.index.purgeSpace(spaceId);
    },
  };
  const mindDeletionIds = deletionIds();
  const mindDeletionOptions = {
    ordinaryMinds: boundary.metadata,
    objects: boundary.objects,
    index: failingMindIndex,
    audit: boundary.audit,
    exportArchives: boundary.exportArchives,
    ids: mindDeletionIds,
    clock: { now: () => T5 },
    host: HOST,
  };
  const mindDeletion = new OrdinaryMindDeletionService(mindDeletionOptions);
  const mindImpact = await mindDeletion.getDeletionImpact(
    actor(owner.principalId, "request_sites_delete_preview", T5),
    { handle: mind.handle },
  );
  const mindCommand = {
    handle: mind.handle,
    impactId: mindImpact.impactId,
    confirmation: mindImpact.confirmation,
    idempotencyKey: "delete-sites-mind-restart",
  };
  await assert.rejects(
    mindDeletion.deleteSpace(
      actor(owner.principalId, "request_sites_delete_fail", T5),
      mindCommand,
    ),
    /deletion cleanup is incomplete/iu,
  );
  assert.equal(await boundary.metadata.inspectOrdinaryMindStateForTest(mind.mindId), null);
  assert.equal((await boundary.metadata.inspectDeletionCleanupForTest()).length, 1);

  boundary = await createSitesPersistenceBoundary({ database, bucket });
  const resumedMindDeletion = new OrdinaryMindDeletionService({
    ...mindDeletionOptions,
    ordinaryMinds: boundary.metadata,
    objects: boundary.objects,
    index: boundary.index,
    audit: boundary.audit,
    exportArchives: boundary.exportArchives,
  });
  const mindResult = await resumedMindDeletion.deleteSpace(
    actor(owner.principalId, "request_sites_delete_resume", T5),
    mindCommand,
  );
  assert.equal(mindResult.replayed, true);
  assert.deepEqual(await boundary.metadata.inspectDeletionCleanupForTest(), []);

  let failAccountIndexPurge = true;
  const failingAccountIndex = {
    kind: "search-index",
    replaceExactRevision: (request) => boundary.index.replaceExactRevision(request),
    readExactRevision: (spaceId, revisionId) =>
      boundary.index.readExactRevision(spaceId, revisionId),
    purgeSpace: async (spaceId) => {
      if (failAccountIndexPurge) {
        failAccountIndexPurge = false;
        throw new Error("synthetic account index cleanup failure");
      }
      return boundary.index.purgeSpace(spaceId);
    },
  };
  const accountDeletionIds = deletionIds();
  const accountDeletionOptions = {
    accounts: boundary.metadata,
    tokens: boundary.tokens,
    objects: boundary.objects,
    index: failingAccountIndex,
    audit: boundary.audit,
    exportArchives: boundary.exportArchives,
    ids: accountDeletionIds,
    clock: { now: () => T5 },
    host: HOST,
  };
  const accountDeletion = new AccountDeletionService(accountDeletionOptions);
  const accountImpact = await accountDeletion.getAccountDeletionImpact(
    actor(owner.principalId, "request_sites_account_preview", T5),
  );
  const accountCommand = {
    impactId: accountImpact.impactId,
    confirmation: accountImpact.confirmation,
    idempotencyKey: "delete-sites-account-restart",
  };
  await assert.rejects(
    accountDeletion.deleteAccount(
      actor(owner.principalId, "request_sites_account_fail", T5),
      accountCommand,
    ),
    /deletion cleanup is incomplete/iu,
  );
  assert.equal(await boundary.metadata.readAccount(owner.principalId), null);
  assert.equal((await boundary.metadata.inspectAccountDeletionCleanupForTest()).length, 1);

  boundary = await createSitesPersistenceBoundary({ database, bucket });
  const resumedAccountDeletion = new AccountDeletionService({
    ...accountDeletionOptions,
    accounts: boundary.metadata,
    tokens: boundary.tokens,
    objects: boundary.objects,
    index: boundary.index,
    audit: boundary.audit,
    exportArchives: boundary.exportArchives,
  });
  const accountResult = await resumedAccountDeletion.deleteAccount(
    actor(owner.principalId, "request_sites_account_resume", T5),
    accountCommand,
  );
  assert.equal(accountResult.replayed, true);
  assert.equal(await boundary.metadata.readAccount(owner.principalId), null);
  assert.deepEqual(await boundary.metadata.inspectAccountDeletionCleanupForTest(), []);
});

async function runObjectContract(name, factory) {
  await test(name, async () => {
    const store = await factory();
    const bytes = new TextEncoder().encode("# Durable canonical bytes\n");
    const put = await store.putImmutable({ bytes, mediaType: MARKDOWN_MEDIA_TYPE, createdAt: T0 });
    assert.equal(put.status, "stored");
    assert.deepEqual((await store.getImmutable(put.object.sha256)).bytes, bytes);
    const listed = await store.listImmutableObjects({
      createdBefore: T2,
      excludedDigests: [],
      limit: 10,
    });
    assert.equal(listed.length, 1);
    assert.equal(
      await store.deleteImmutableObject({
        sha256: put.object.sha256,
        expectedProtectedAt: put.object.protectedAt,
        createdBefore: T2,
      }),
      true,
    );
    assert.equal(await store.getImmutable(put.object.sha256), null);
  });
}

await runObjectContract("memory object contract baseline", async () => new InMemoryObjectStore());
await runObjectContract("Sites R2 object contract", async () => {
  const boundary = await createSitesPersistenceBoundary({
    database: new FakeD1Database(),
    bucket: new FakeR2Bucket(),
  });
  return boundary.objects;
});

test("R2 cleanup is lease-safe, restartable after failure, and export cleanup is durable", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  let store = (await createSitesPersistenceBoundary({ database, bucket })).objects;
  const bytes = new TextEncoder().encode("# Restartable cleanup\n");
  const initial = await store.putImmutable({ bytes, mediaType: MARKDOWN_MEDIA_TYPE, createdAt: T0 });
  const protectedWrite = await store.putImmutable({ bytes, mediaType: MARKDOWN_MEDIA_TYPE, createdAt: T2 });
  assert.equal(
    await store.deleteImmutableObject({
      sha256: initial.object.sha256,
      expectedProtectedAt: initial.object.protectedAt,
      createdBefore: T3,
    }),
    false,
  );
  bucket.failNextDelete();
  await assert.rejects(
    store.deleteImmutableObject({
      sha256: initial.object.sha256,
      expectedProtectedAt: protectedWrite.object.protectedAt,
      createdBefore: T3,
    }),
    /synthetic R2 delete failure/u,
  );
  store = (await createSitesPersistenceBoundary({ database, bucket })).objects;
  const resumed = await store.listImmutableObjects({
    createdBefore: T3,
    excludedDigests: [],
    limit: 10,
  });
  assert.equal(resumed.length, 1);
  assert.equal(
    await store.deleteImmutableObject({
      sha256: resumed[0].sha256,
      expectedProtectedAt: resumed[0].protectedAt,
      createdBefore: T3,
    }),
    true,
  );

  const archiveBytes = Uint8Array.from([80, 75, 5, 6]);
  const archiveSha = await store.calculateSha256(archiveBytes);
  const archive = await store.putExportArchive({
    jobId: "export_sites_restart",
    spaceId: "space_sites_export",
    claimVersion: 1,
    bytes: archiveBytes,
    sha256: archiveSha,
    createdAt: T4,
  });
  assert.equal(archive.kind, "stored");
  const restarted = (await createSitesPersistenceBoundary({ database, bucket })).objects;
  assert.deepEqual(await restarted.readExportArchive(archive.archive.objectKey), archiveBytes);
  assert.equal(await restarted.deleteExportArchivesForJob("export_sites_restart"), 1);
});

async function runSearchContract(name, factory) {
  await test(name, async () => {
    const index = await factory();
    await index.replaceExactRevision({
      spaceId: "space_search_contract",
      revisionId: "revision_search_contract",
      documents: [{ path: "concepts/private.md", text: "private fixture body" }],
    });
    const result = await index.readExactRevision(
      "space_search_contract",
      "revision_search_contract",
    );
    assert.equal(result.kind, "ready");
    assert.deepEqual(result.documents, [
      { path: "concepts/private.md", text: "private fixture body" },
    ]);
    assert.equal(await index.purgeSpace("space_search_contract"), 1);
    assert.deepEqual(
      await index.readExactRevision("space_search_contract", "revision_search_contract"),
      { kind: "unavailable" },
    );
  });
}

await runSearchContract(
  "memory exact-revision search contract baseline",
  async () => new InMemoryExactRevisionSearchIndex(),
);
await runSearchContract("Sites D1 exact-revision search contract", async () => {
  const boundary = await createSitesPersistenceBoundary({
    database: new FakeD1Database(),
    bucket: new FakeR2Bucket(),
  });
  return boundary.index;
});

test("D1 search and privacy-safe audit survive instances without becoming sources of truth", async () => {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  let boundary = await createSitesPersistenceBoundary({ database, bucket });
  await boundary.index.replaceExactRevision({
    spaceId: "space_sites_projection",
    revisionId: "revision_sites_projection",
    documents: [{ path: "index.md", text: "derived private query text" }],
  });
  const event = {
    auditEventId: "audit_sites_delivery",
    actor: { kind: "principal", principalId: "principal_sites_audit" },
    requestId: "request_sites_audit",
    eventType: "content_commit",
    outcome: "succeeded",
    spaceId: "space_sites_projection",
    occurredAt: T4,
    safeMetadata: { revision_number: 2 },
  };
  assert.equal(await boundary.audit.deliver(event), "delivered");
  assert.equal(await boundary.audit.deliver(event), "duplicate");

  boundary = await createSitesPersistenceBoundary({ database, bucket });
  assert.equal(
    (await boundary.index.readExactRevision(
      "space_sites_projection",
      "revision_sites_projection",
    )).kind,
    "ready",
  );
  assert.equal(
    await boundary.audit.tombstonePrincipal(
      "principal_sites_audit",
      "deleted_principal_sites_audit",
    ),
    1,
  );
  assert.deepEqual(JSON.parse(database.audit.get("audit_sites_delivery").event_json).actor, {
    kind: "deleted-principal",
    opaqueId: "deleted_principal_sites_audit",
  });
  assert.equal(await boundary.audit.purgeSpace("space_sites_projection"), 1);
  assert.equal(await boundary.index.purgeSpace("space_sites_projection"), 1);
});

test("production outbound selection contains no process-memory adapter", () => {
  assert.deepEqual(COMPOSITION_SELECTION.productionOutbound, {
    metadata: "sites-d1-fenced-event-log",
    objects: "sites-r2-immutable-envelope",
    search: "sites-d1-exact-revision",
    audit: "sites-d1-privacy-safe-audit",
  });
  assert.equal(
    Object.values(COMPOSITION_SELECTION.productionOutbound).some((value) => value.includes("memory")),
    false,
  );
  assert.equal(COMPOSITION_SELECTION.deployableServiceImplemented, true);
});

test("memory audit contract baseline remains idempotent", async () => {
  const audit = new InMemoryAuditSink();
  const event = {
    auditEventId: "audit_memory_baseline",
    actor: { kind: "service", serviceId: "test" },
    requestId: "request_memory_baseline",
    eventType: "baseline",
    outcome: "succeeded",
    spaceId: null,
    occurredAt: T0,
    safeMetadata: {},
  };
  assert.equal(await audit.deliver(event), "delivered");
  assert.equal(await audit.deliver(event), "duplicate");
});
