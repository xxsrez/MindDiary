import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryMcpTokenStore,
  InMemoryRevisionMetadataStore,
} from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  AccountBootstrapService,
  OrdinaryMindControlService,
  PrincipalActivityService,
  ServiceOperatorDirectoryFailure,
  ServiceOperatorDirectoryService,
} from "@mind-diary/application-control";
import { CAPABILITIES, version, verifiedSpaceHost } from "@mind-diary/domain";

const T0 = "2026-08-22T09:00:00.000Z";
const T1 = "2026-08-22T10:00:00.000Z";
const T2 = "2026-08-22T11:00:00.000Z";

function actor(principalId, occurredAtUtc = T2, requestId = "request_operator") {
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
  let next = 0;
  return {
    nextPrincipalId: () => `principal_operator_${++next}`,
    nextExternalBindingId: () => `binding_operator_${next}`,
    nextSpaceId: () => `space_personal_operator_${next}`,
    nextMembershipId: () => `membership_personal_operator_${next}`,
    nextRevisionId: () => `revision_personal_operator_${next}`,
    nextIndexJobId: () => `job_personal_operator_${next}`,
    nextPersonalSpaceHandle: () => `personal-operator-${next}`,
  };
}

function preRegistration(index) {
  return {
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding: `operator.user.${index}@example.com`,
    suggestedDisplayName: index === 1 ? "Pilot Operator" : `Pilot User ${index}`,
    deploymentCapabilities: CAPABILITIES,
    requestId: `request_bootstrap_operator_${index}`,
    occurredAtUtc: T0,
  };
}

test("service operator directory is separately authorized, monotonic, paginated, audited and privacy-minimized", async () => {
  const metadata = new InMemoryRevisionMetadataStore();
  const tokens = new InMemoryMcpTokenStore();
  const objects = new InMemoryObjectStore();
  const bootstrap = new AccountBootstrapService({ accounts: metadata, objects, ids: accountIds() });
  const accounts = [];
  for (const index of [1, 2, 3]) {
    accounts.push(await bootstrap.bootstrapAccount(preRegistration(index), {
      action: "create_isolated_account",
    }));
  }
  const [operator, participant, neverActive] = accounts;

  let ordinary = 0;
  const minds = new OrdinaryMindControlService({
    ordinaryMinds: metadata,
    objects,
    host: verifiedSpaceHost("mind-diary.example"),
    ids: {
      nextSpaceId: () => `space_operator_owned_${++ordinary}`,
      nextMembershipId: () => `membership_operator_owned_${ordinary}`,
      nextRevisionId: () => `revision_operator_owned_${ordinary}`,
      nextIndexJobId: () => `job_operator_owned_${ordinary}`,
    },
  });
  const owned = await minds.createSpaceWithOwner(actor(operator.principalId, T0), {
    name: "Support Fixture",
    handle: "support-fixture",
    idempotencyKey: "create-support-fixture",
  });
  assert.equal(await metadata.grantOrdinaryMembershipForTest({
    membershipId: "membership_operator_participant",
    spaceId: owned.mindId,
    principalId: participant.principalId,
    role: "editor",
    state: "active",
    version: version(1),
    createdAt: T0,
    createdBy: operator.principalId,
    updatedAt: T0,
    updatedBy: operator.principalId,
  }, T0), true);

  assert.equal((await tokens.createMcpToken({
    tokenId: "token_operator_participant",
    principalId: participant.principalId,
    name: "Participant Codex",
    verifier: `hmac-sha256:v1:${"a".repeat(64)}`,
    displayPrefix: "mdp_v1_Aaaaaa…",
    scopes: ["content:read"],
    createdAt: T0,
    expiresAt: "2026-11-20T00:00:00.000Z",
  })).kind, "created");

  const activity = new PrincipalActivityService(metadata);
  await activity.recordSuccessful(actor(operator.principalId, T1), "web", "page");
  await activity.recordSuccessful(actor(participant.principalId, T2), "mcp", "content_read");
  await activity.recordSuccessful(actor(participant.principalId, T0), "mcp", "content_write");
  assert.equal((await metadata.readPrincipalActivity(participant.principalId)).lastMcpSeenAt, T2);
  assert.equal(await metadata.readPrincipalActivity(neverActive.principalId), null);

  let ids = 0;
  const directory = new ServiceOperatorDirectoryService({
    store: metadata,
    tokens,
    operatorPrincipalIds: new Set([operator.principalId]),
    ids: {
      nextAuditEventId: () => `audit_operator_directory_${++ids}`,
      nextOutboxMessageId: () => `outbox_operator_directory_${ids}`,
    },
  });

  await assert.rejects(
    directory.list(actor(participant.principalId), {}),
    (error) => error instanceof ServiceOperatorDirectoryFailure && error.code === "not_found",
  );

  const first = await directory.list(actor(operator.principalId), {
    sort: "last_activity_at",
    direction: "desc",
    limit: 1,
  });
  assert.equal(first.principals.length, 1);
  assert.equal(first.principals[0].principalId, participant.principalId);
  assert.equal(first.principals[0].participatingMindCount, 1);
  assert.equal(first.principals[0].activeMcpCredentialCount, 1);
  assert.equal(typeof first.nextCursor, "string");

  const second = await directory.list(actor(operator.principalId), {
    sort: "last_activity_at",
    direction: "desc",
    limit: 1,
    cursor: first.nextCursor,
  });
  assert.equal(second.principals[0].principalId, operator.principalId);
  assert.equal(second.principals[0].ownedMindCount, 1);

  const searched = await directory.list(actor(operator.principalId), {
    query: "OPERATOR.USER.2@EXAMPLE.COM",
  });
  assert.deepEqual(searched.principals.map(({ principalId }) => principalId), [participant.principalId]);
  const inactive = await directory.list(actor(operator.principalId), {
    neverActive: true,
  });
  assert.deepEqual(inactive.principals.map(({ principalId }) => principalId), [neverActive.principalId]);

  const restored = InMemoryRevisionMetadataStore.fromDurableSnapshot(
    metadata.exportDurableSnapshot(),
  );
  assert.equal((await restored.readPrincipalActivity(participant.principalId)).lastMcpSeenAt, T2);
  const { principalActivities: _legacyMissingField, ...legacySnapshot } =
    metadata.exportDurableSnapshot();
  const legacyRestored = InMemoryRevisionMetadataStore.fromDurableSnapshot(legacySnapshot);
  assert.equal(await legacyRestored.readPrincipalActivity(participant.principalId), null);
  await assert.rejects(metadata.recordPrincipalActivity({
    principalId: participant.principalId,
    surface: "web",
    kind: "content_read",
    observedAt: T2,
  }), /activity observation is invalid/u);

  const audit = await metadata.listAuditEventsForTest();
  assert.equal(audit.length, 4);
  assert.equal(audit.at(-1).eventType, "service_operator.principal_directory_read");
  const serializedAudit = JSON.stringify(audit);
  for (const forbidden of [
    "operator.user.1@example.com",
    "operator.user.2@example.com",
    "OPERATOR.USER.2@EXAMPLE.COM",
    "Pilot User 2",
  ]) assert.equal(serializedAudit.includes(forbidden), false, forbidden);
});
