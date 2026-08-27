import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  MembershipControlFailure,
  MembershipControlService,
} from "@mind-diary/application-control";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";
import {
  CAPABILITIES,
  capabilitiesForRole,
} from "@mind-diary/domain";

const NOW = "2026-08-07T10:30:00.000Z";
const SPACE_ID = "space_membership_control";

function actor(principalId, requestId = `request_${principalId}`) {
  return {
    kind: "registered_principal",
    principalId,
    authentication: { kind: "sites_identity" },
    deploymentCapabilities: CAPABILITIES,
    requestId,
    occurredAtUtc: NOW,
  };
}

function expectFailure(code) {
  return (error) => error instanceof MembershipControlFailure && error.code === code;
}

function clone(value) {
  return structuredClone(value);
}

class InMemoryMembershipControlStore {
  constructor({ mindKind = "ordinary", visibility = "private" } = {}) {
    this.state = {
      spaces: new Map([
        [
          SPACE_ID,
          {
            spaceId: SPACE_ID,
            mindKind,
            state: "active",
            visibility,
            accessVersion: 1,
          },
        ],
      ]),
      memberships: new Map(),
      idempotency: new Map(),
      audit: [],
      outbox: [],
    };
    this.tail = Promise.resolve();
    this.beforeTransaction = null;
    this.failAfterState = false;
  }

  addMembership(memberId, principalId, role, version = 1) {
    this.state.memberships.set(memberId, {
      membershipId: memberId,
      spaceId: SPACE_ID,
      principalId,
      role,
      state: "active",
      version,
      createdAt: NOW,
      createdBy: "principal_owner",
      updatedAt: NOW,
      updatedBy: "principal_owner",
    });
  }

  snapshot() {
    return clone(this.state);
  }

  member(memberId) {
    return clone(this.state.memberships.get(memberId));
  }

  failNextAfterState() {
    this.failAfterState = true;
  }

  beforeNextTransaction(callback) {
    this.beforeTransaction = callback;
  }

  forceRevoke(memberId) {
    const membership = this.state.memberships.get(memberId);
    if (!membership) throw new Error("membership fixture missing");
    membership.state = "revoked";
    membership.version += 1;
    this.state.spaces.get(membership.spaceId).accessVersion += 1;
  }

  async readCurrentAuthorizationState(query) {
    return this.#authorizationState(this.state, query);
  }

  async readMembershipMutationReplay(request) {
    return this.#readReplay(this.state, request);
  }

  async runMembershipControlTransaction(operation) {
    const prior = this.tail;
    let release;
    this.tail = new Promise((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      const before = this.beforeTransaction;
      this.beforeTransaction = null;
      if (before) before(this);
      const draft = clone(this.state);
      const transaction = this.#transaction(draft);
      const result = await operation(transaction);
      this.state = draft;
      return result;
    } finally {
      release();
    }
  }

  #authorizationState(state, query) {
    const space = state.spaces.get(query.spaceId);
    if (!space) return null;
    const membership = [...state.memberships.values()].find(
      (candidate) =>
        candidate.spaceId === query.spaceId &&
        candidate.principalId === query.principalId,
    );
    return {
      principal: { principalId: query.principalId, state: "active" },
      space: {
        spaceId: space.spaceId,
        state: space.state,
        visibility: space.visibility,
        accessVersion: space.accessVersion,
      },
      membership: membership
        ? {
            principalId: membership.principalId,
            spaceId: membership.spaceId,
            role: membership.role,
            state: membership.state,
            version: membership.version,
          }
        : null,
      token: null,
    };
  }

  #replayKey(request) {
    return [
      request.principalId,
      request.spaceId,
      request.operation,
      request.idempotencyKey,
    ].join("\u0000");
  }

  #readReplay(state, request) {
    const stored = state.idempotency.get(this.#replayKey(request));
    if (!stored) return { kind: "not_found" };
    if (stored.canonicalRequestHash !== request.canonicalRequestHash) {
      return { kind: "idempotency_conflict" };
    }
    return {
      kind: "replayed",
      membership: clone(stored.membership),
      changed: stored.changed,
      requiredCapability: stored.requiredCapability,
    };
  }

  #transaction(draft) {
    return {
      kind: "authorization-transaction",
      readCurrentAuthorizationState: async (query) =>
        this.#authorizationState(draft, query),
      readMembershipControlTarget: async (query) => {
        const space = draft.spaces.get(query.spaceId);
        if (!space) return { kind: "mind_not_found" };
        const membership = [...draft.memberships.values()].find(
          (candidate) =>
            candidate.spaceId === query.spaceId &&
            (query.memberId !== undefined
              ? candidate.membershipId === query.memberId
              : candidate.principalId === query.principalId),
        );
        if (!membership) return { kind: "membership_not_found" };
        return {
          kind: "found",
          mindKind: space.mindKind,
          membership: clone(membership),
        };
      },
      applyMembershipMutation: async (request) =>
        this.#applyMutation(draft, request),
    };
  }

  #applyMutation(draft, request) {
    const replay = this.#readReplay(draft, request);
    if (replay.kind === "replayed") return { ...replay, kind: "applied", replayed: true };
    if (replay.kind === "idempotency_conflict") return replay;

    const space = draft.spaces.get(request.spaceId);
    if (!space) return { kind: "mind_not_found" };
    if (space.mindKind === "personal") return { kind: "personal_mind" };
    const target = draft.memberships.get(request.targetMembershipId);
    if (!target || target.spaceId !== request.spaceId || target.state !== "active") {
      return { kind: "membership_not_found" };
    }
    if (target.role === "owner") return { kind: "owner_membership" };
    if (target.version !== request.expectedMembershipVersion) {
      return { kind: "membership_version_conflict" };
    }
    const source = [...draft.memberships.values()].find(
      (candidate) =>
        candidate.spaceId === request.spaceId &&
        candidate.principalId === request.principalId &&
        candidate.state === "active",
    );
    if (!source) return { kind: "forbidden" };
    if (
      request.authorizationStamp.accessVersion !== space.accessVersion ||
      request.authorizationStamp.membershipVersion !== source.version ||
      request.authorizationStamp.tokenVersion !== null
    ) {
      return { kind: "authorization_state_changed" };
    }
    if (!capabilitiesForRole(source.role).includes(request.requiredCapability)) {
      return { kind: "forbidden" };
    }

    if (request.operation === "leave_space") {
      if (source.membershipId !== target.membershipId) return { kind: "forbidden" };
    } else {
      const required =
        target.role === "admin" || request.role === "admin"
          ? "members:manage-admin"
          : "members:manage-basic";
      if (request.requiredCapability !== required) return { kind: "forbidden" };
    }
    if (
      draft.audit.some((event) => event.auditEventId === request.auditEventId) ||
      draft.outbox.some(
        (message) => message.outboxMessageId === request.auditOutboxMessageId,
      )
    ) {
      return { kind: "effect_conflict" };
    }

    const previousRole = target.role;
    const previousState = target.state;
    const changed =
      request.operation === "change_membership_role"
        ? target.role !== request.role
        : true;
    if (changed) {
      if (request.operation === "change_membership_role") {
        if (!request.role) return { kind: "invalid_record" };
        target.role = request.role;
      } else {
        target.state = "revoked";
      }
      target.version += 1;
      target.updatedAt = request.occurredAt;
      target.updatedBy = request.principalId;
      space.accessVersion += 1;
    }
    if (this.failAfterState) {
      this.failAfterState = false;
      throw new Error("injected membership transaction failure");
    }

    const event = {
      auditEventId: request.auditEventId,
      actor: { kind: "principal", principalId: request.principalId },
      requestId: request.requestId,
      eventType: request.operation,
      outcome: "succeeded",
      spaceId: request.spaceId,
      occurredAt: request.occurredAt,
      safeMetadata: {
        operation: request.operation,
        previous_role: previousRole,
        resulting_role: target.role,
        previous_state: previousState,
        resulting_state: target.state,
        changed,
      },
    };
    draft.audit.push(event);
    draft.outbox.push({
      outboxMessageId: request.auditOutboxMessageId,
      auditEventId: request.auditEventId,
      state: "pending",
    });
    const resultMembership = clone(target);
    draft.idempotency.set(this.#replayKey(request), {
      canonicalRequestHash: request.canonicalRequestHash,
      membership: resultMembership,
      changed,
      requiredCapability: request.requiredCapability,
    });
    return {
      kind: "applied",
      membership: resultMembership,
      changed,
      replayed: false,
    };
  }
}

function harness(options) {
  const memberships = new InMemoryMembershipControlStore(options);
  memberships.addMembership("member_owner", "principal_owner", "owner");
  memberships.addMembership("member_admin", "principal_admin", "admin");
  memberships.addMembership("member_editor", "principal_editor", "editor");
  memberships.addMembership("member_reader", "principal_reader", "reader");
  const safeEvents = [];
  let audit = 0;
  let outbox = 0;
  const service = new MembershipControlService({
    memberships,
    digest: {
      calculateSha256: async (bytes) =>
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    },
    auditIds: {
      nextAuditEventId: () => `audit_membership_${++audit}`,
      nextOutboxMessageId: () => `outbox_membership_${++outbox}`,
    },
    logger: { record: (event) => safeEvents.push(event) },
  });
  return { memberships, safeEvents, service };
}

async function authorize(store, principalId, capability, revisionMode = "head") {
  return new CapabilityAuthorizer(store).authorize({
    actor: actor(
      principalId,
      `request_authorize_${principalId}_${capability}_${revisionMode}`,
    ),
    spaceId: SPACE_ID,
    capability,
    revisionMode,
  });
}

const READER_EQUIVALENT_CAPABILITIES = Object.freeze([
  "content:browse",
  "content:search",
  "content:fetch",
  "content:history",
  "content:validate",
  "content:export",
]);

const NON_READER_CAPABILITIES = Object.freeze([
  "content:write",
  "members:manage-basic",
  "members:manage-admin",
]);

async function assertFormerParticipantBaseline(store, principalId, visibility) {
  assert.deepEqual(
    capabilitiesForRole("reader"),
    READER_EQUIVALENT_CAPABILITIES,
    "the regression matrix must track the complete accepted Reader capability set",
  );
  for (const revisionMode of ["head", "historical"]) {
    for (const capability of READER_EQUIVALENT_CAPABILITIES) {
      const result = await authorize(store, principalId, capability, revisionMode);
      assert.equal(
        result.kind,
        "allowed",
        `${visibility} ${revisionMode} ${capability} should remain reader-equivalent`,
      );
      assert.equal(result.grant.kind, "baseline_visibility");
      assert.equal(result.grant.visibility, visibility);
    }
  }
  for (const capability of NON_READER_CAPABILITIES) {
    const result = await authorize(store, principalId, capability);
    assert.equal(result.kind, "denied", `${visibility} must deny ${capability}`);
    assert.equal(result.code, "capability_denied");
  }
}

async function assertFormerPrivateParticipantDenied(store, principalId) {
  for (const revisionMode of ["head", "historical"]) {
    for (const capability of [
      ...READER_EQUIVALENT_CAPABILITIES,
      ...NON_READER_CAPABILITIES,
    ]) {
      const result = await authorize(store, principalId, capability, revisionMode);
      assert.equal(result.kind, "denied", `private ${revisionMode} must deny ${capability}`);
      assert.equal(result.code, "access_denied");
    }
  }
}

test("Admin manages only Reader/Editor, Owner additionally manages Admin, and Owner assignment is transfer-only", async () => {
  const env = harness();

  assert.equal((await authorize(env.memberships, "principal_reader", "content:write")).kind, "denied");
  assert.equal((await authorize(env.memberships, "principal_editor", "content:write")).kind, "allowed");

  const promoted = await env.service.changeMembershipRole(
    actor("principal_admin", "request_promote_reader"),
    {
      mindId: SPACE_ID,
      memberId: "member_reader",
      role: "editor",
      expectedMembershipVersion: 1,
      idempotencyKey: "membership-promote-reader-0001",
    },
  );
  assert.deepEqual(
    { role: promoted.role, version: promoted.membershipVersion, changed: promoted.changed },
    { role: "editor", version: 2, changed: true },
  );
  assert.equal((await authorize(env.memberships, "principal_reader", "content:write")).kind, "allowed");

  const beforeDenied = env.memberships.snapshot();
  await assert.rejects(
    env.service.changeMembershipRole(actor("principal_admin"), {
      mindId: SPACE_ID,
      memberId: "member_admin",
      role: "reader",
      expectedMembershipVersion: 1,
      idempotencyKey: "membership-admin-self-0001",
    }),
    expectFailure("forbidden"),
  );
  assert.deepEqual(env.memberships.snapshot(), beforeDenied);

  const downgraded = await env.service.changeMembershipRole(actor("principal_owner"), {
    mindId: SPACE_ID,
    memberId: "member_admin",
    role: "reader",
    expectedMembershipVersion: 1,
    idempotencyKey: "membership-owner-downgrade-admin-0001",
  });
  assert.equal(downgraded.role, "reader");
  assert.equal((await authorize(env.memberships, "principal_admin", "content:write")).kind, "denied");

  const beforeOwnerRole = env.memberships.snapshot();
  await assert.rejects(
    env.service.changeMembershipRole(actor("principal_owner"), {
      mindId: SPACE_ID,
      memberId: "member_editor",
      role: "owner",
      expectedMembershipVersion: 1,
      idempotencyKey: "membership-invalid-owner-role-0001",
    }),
    expectFailure("owner_role_requires_transfer"),
  );
  assert.deepEqual(env.memberships.snapshot(), beforeOwnerRole);
});

test("authorized revoke and non-owner leave invalidate current access immediately while Owner remains protected", async () => {
  const env = harness();

  await env.service.revokeMembership(actor("principal_admin"), {
    mindId: SPACE_ID,
    memberId: "member_reader",
    expectedMembershipVersion: 1,
    idempotencyKey: "membership-revoke-reader-0001",
  });
  assert.equal((await authorize(env.memberships, "principal_reader", "content:browse")).kind, "denied");

  const leaveCommand = {
    mindId: SPACE_ID,
    expectedMembershipVersion: 1,
    idempotencyKey: "membership-editor-leave-0001",
  };
  const left = await env.service.leaveSpace(
    actor("principal_editor", "request_editor_leave"),
    leaveCommand,
  );
  assert.equal(left.state, "revoked");
  assert.equal((await authorize(env.memberships, "principal_editor", "content:browse")).kind, "denied");

  await env.service.revokeMembership(actor("principal_owner"), {
    mindId: SPACE_ID,
    memberId: "member_admin",
    expectedMembershipVersion: 1,
    idempotencyKey: "membership-owner-revoke-admin-0001",
  });
  assert.equal((await authorize(env.memberships, "principal_admin", "content:browse")).kind, "denied");

  const beforeOwnerAttempts = env.memberships.snapshot();
  await assert.rejects(
    env.service.leaveSpace(actor("principal_owner"), {
      mindId: SPACE_ID,
      expectedMembershipVersion: 1,
      idempotencyKey: "membership-owner-leave-0001",
    }),
    expectFailure("owner_membership_protected"),
  );
  await assert.rejects(
    env.service.revokeMembership(actor("principal_owner"), {
      mindId: SPACE_ID,
      memberId: "member_owner",
      expectedMembershipVersion: 1,
      idempotencyKey: "membership-owner-self-revoke-0001",
    }),
    expectFailure("owner_membership_protected"),
  );
  assert.deepEqual(env.memberships.snapshot(), beforeOwnerAttempts);

  const replayed = await env.service.leaveSpace(
    actor("principal_editor", "request_editor_leave_retry"),
    leaveCommand,
  );
  assert.equal(replayed.replayed, true);
  assert.equal(env.memberships.state.audit.length, 3);
  assert.equal(env.memberships.state.outbox.length, 3);

  await assert.rejects(
    env.service.leaveSpace(actor("principal_editor"), {
      ...leaveCommand,
      expectedMembershipVersion: 2,
    }),
    expectFailure("idempotency_conflict"),
  );
  assert.equal(env.memberships.state.audit.length, 3);
});

test("revoke preserves full public and unlisted live/history Reader capability only", async () => {
  for (const visibility of ["public", "unlisted"]) {
    const env = harness({ visibility });
    await env.service.revokeMembership(actor("principal_owner", `request_${visibility}_revoke`), {
      mindId: SPACE_ID,
      memberId: "member_editor",
      expectedMembershipVersion: 1,
      idempotencyKey: `membership-${visibility}-revoke-editor-0001`,
    });

    assert.equal(env.memberships.member("member_editor").state, "revoked");
    await assertFormerParticipantBaseline(env.memberships, "principal_editor", visibility);
  }
});

test("leave preserves full public and unlisted live/history Reader capability only", async () => {
  for (const visibility of ["public", "unlisted"]) {
    const env = harness({ visibility });
    await env.service.leaveSpace(actor("principal_editor", `request_${visibility}_leave`), {
      mindId: SPACE_ID,
      expectedMembershipVersion: 1,
      idempotencyKey: `membership-${visibility}-leave-editor-0001`,
    });

    assert.equal(env.memberships.member("member_editor").state, "revoked");
    await assertFormerParticipantBaseline(env.memberships, "principal_editor", visibility);
  }
});

test("revoke and leave keep former private participants non-disclosing and fully denied", async () => {
  for (const lifecycle of ["revoke", "leave"]) {
    const env = harness({ visibility: "private" });
    if (lifecycle === "revoke") {
      await env.service.revokeMembership(actor("principal_owner", "request_private_revoke"), {
        mindId: SPACE_ID,
        memberId: "member_editor",
        expectedMembershipVersion: 1,
        idempotencyKey: "membership-private-revoke-editor-0001",
      });
    } else {
      await env.service.leaveSpace(actor("principal_editor", "request_private_leave"), {
        mindId: SPACE_ID,
        expectedMembershipVersion: 1,
        idempotencyKey: "membership-private-leave-editor-0001",
      });
    }

    assert.equal(env.memberships.member("member_editor").state, "revoked");
    await assertFormerPrivateParticipantDenied(env.memberships, "principal_editor");
  }
});

test("membership version CAS, concurrent writers, no-op and exact retry are deterministic", async () => {
  const env = harness();
  const first = env.service.changeMembershipRole(actor("principal_owner", "request_race_a"), {
    mindId: SPACE_ID,
    memberId: "member_reader",
    role: "editor",
    expectedMembershipVersion: 1,
    idempotencyKey: "membership-race-a-0001",
  });
  const second = env.service.changeMembershipRole(actor("principal_owner", "request_race_b"), {
    mindId: SPACE_ID,
    memberId: "member_reader",
    role: "admin",
    expectedMembershipVersion: 1,
    idempotencyKey: "membership-race-b-0001",
  });
  const settled = await Promise.allSettled([first, second]);
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = settled.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "membership_version_conflict");
  assert.equal(env.memberships.member("member_reader").version, 2);
  assert.equal(env.memberships.state.audit.length, 1);

  const current = env.memberships.member("member_reader");
  const beforeStale = env.memberships.snapshot();
  await assert.rejects(
    env.service.changeMembershipRole(actor("principal_owner"), {
      mindId: SPACE_ID,
      memberId: "member_reader",
      role: current.role === "editor" ? "reader" : "editor",
      expectedMembershipVersion: 1,
      idempotencyKey: "membership-stale-0001",
    }),
    expectFailure("membership_version_conflict"),
  );
  assert.deepEqual(env.memberships.snapshot(), beforeStale);

  const noopCommand = {
    mindId: SPACE_ID,
    memberId: "member_reader",
    role: current.role,
    expectedMembershipVersion: 2,
    idempotencyKey: "membership-noop-0001",
  };
  const noop = await env.service.changeMembershipRole(actor("principal_owner"), noopCommand);
  assert.deepEqual(
    { changed: noop.changed, version: noop.membershipVersion },
    { changed: false, version: 2 },
  );
  const replay = await env.service.changeMembershipRole(actor("principal_owner"), noopCommand);
  assert.equal(replay.replayed, true);
  assert.equal(env.memberships.state.audit.length, 2);
});

test("exact mutation replay refuses a stale target membership descriptor", async () => {
  const env = harness();
  const command = {
    mindId: SPACE_ID,
    memberId: "member_reader",
    role: "editor",
    expectedMembershipVersion: 1,
    idempotencyKey: "membership-stale-replay-0001",
  };

  const changed = await env.service.changeMembershipRole(
    actor("principal_owner", "request_stale_replay_initial"),
    command,
  );
  assert.equal(changed.role, "editor");
  env.memberships.forceRevoke("member_reader");

  await assert.rejects(
    env.service.changeMembershipRole(
      actor("principal_owner", "request_stale_replay_retry"),
      command,
    ),
    expectFailure("membership_state_changed"),
  );
  assert.equal(env.memberships.member("member_reader").state, "revoked");
  assert.equal(env.memberships.state.audit.length, 1);
});

test("transaction failure and late authority loss fail closed; Personal Mind and audit data stay safe", async () => {
  const env = harness();
  const beforeFailure = env.memberships.snapshot();
  env.memberships.failNextAfterState();
  await assert.rejects(
    env.service.changeMembershipRole(actor("principal_owner", "request_injected_failure"), {
      mindId: SPACE_ID,
      memberId: "member_reader",
      role: "editor",
      expectedMembershipVersion: 1,
      idempotencyKey: "membership-rollback-0001",
    }),
    /injected membership transaction failure/,
  );
  assert.deepEqual(env.memberships.snapshot(), beforeFailure);

  env.memberships.beforeNextTransaction((store) => store.forceRevoke("member_admin"));
  await assert.rejects(
    env.service.changeMembershipRole(actor("principal_admin", "request_late_revoke"), {
      mindId: SPACE_ID,
      memberId: "member_reader",
      role: "editor",
      expectedMembershipVersion: 1,
      idempotencyKey: "membership-late-authority-loss-0001",
    }),
    expectFailure("mind_not_found"),
  );
  assert.equal(env.memberships.member("member_admin").state, "revoked");
  assert.equal(env.memberships.member("member_reader").role, "reader");
  assert.equal(env.memberships.state.audit.length, 0);

  const personal = harness({ mindKind: "personal" });
  await assert.rejects(
    personal.service.leaveSpace(actor("principal_owner", "request_personal_leave"), {
      mindId: SPACE_ID,
      expectedMembershipVersion: 1,
      idempotencyKey: "membership-personal-leave-0001",
    }),
    expectFailure("personal_mind_operation_forbidden"),
  );
  assert.equal(personal.memberships.member("member_owner").state, "active");

  const auditEnv = harness();
  await auditEnv.service.changeMembershipRole(actor("principal_owner", "request_safe_audit"), {
    mindId: SPACE_ID,
    memberId: "member_reader",
    role: "editor",
    expectedMembershipVersion: 1,
    idempotencyKey: "membership-safe-audit-0001",
  });
  const serialized = JSON.stringify({
    audit: auditEnv.memberships.state.audit,
    outbox: auditEnv.memberships.state.outbox,
    safeEvents: auditEnv.safeEvents,
  });
  assert.doesNotMatch(serialized, /@|token|content|csrf|download_url/i);
  assert.equal(auditEnv.memberships.state.audit[0].safeMetadata.operation, "change_membership_role");
  assert.equal(auditEnv.memberships.state.outbox.length, 1);

  auditEnv.memberships.forceRevoke("member_owner");
  await assert.rejects(
    auditEnv.service.changeMembershipRole(actor("principal_owner", "request_replay_after_revoke"), {
      mindId: SPACE_ID,
      memberId: "member_reader",
      role: "editor",
      expectedMembershipVersion: 1,
      idempotencyKey: "membership-safe-audit-0001",
    }),
    expectFailure("mind_not_found"),
  );
  assert.equal(auditEnv.memberships.state.audit.length, 1);
});
