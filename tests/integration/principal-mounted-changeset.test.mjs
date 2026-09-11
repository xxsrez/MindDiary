import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  AccountBootstrapService,
  OrdinaryMindControlService,
  PrincipalMindUsageApplicationService,
} from "@mind-diary/application-control";
import {
  CanonicalRevisionCoordinator,
  ChangesetCommitService,
} from "@mind-diary/application-content";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";
import { CAPABILITIES, verifiedSpaceHost } from "@mind-diary/domain";

const T0 = "2026-08-30T21:00:00.000Z";
const T1 = "2026-08-30T21:01:00.000Z";
const T2 = "2026-08-30T21:02:00.000Z";
const FUTURE = "2026-11-30T21:00:00.000Z";
const HOST = verifiedSpaceHost("mind-diary.example");

function beforeRegistration() {
  return {
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding: "mounted-writer@example.com",
    suggestedDisplayName: "Mounted Writer",
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_mounted_bootstrap",
    occurredAtUtc: T0,
  };
}

function sitesActor(principalId, requestId, occurredAtUtc = T1) {
  return {
    kind: "registered_principal",
    principalId,
    authentication: { kind: "sites_identity" },
    deploymentCapabilities: CAPABILITIES,
    requestId,
    occurredAtUtc,
  };
}

function tokenActor(principalId, tokenId, requestId, scopes = ["content:read", "content:write"]) {
  return {
    kind: "registered_principal",
    principalId,
    authentication: { kind: "mcp_token", tokenId, effectiveScopes: scopes },
    deploymentCapabilities: CAPABILITIES,
    requestId,
    occurredAtUtc: T1,
  };
}

function accountIds() {
  let sequence = 0;
  return {
    nextPrincipalId: () => `principal_mounted_${++sequence}`,
    nextExternalBindingId: () => `binding_mounted_${sequence}`,
    nextSpaceId: () => `space_mounted_personal_${sequence}`,
    nextMembershipId: () => `membership_mounted_personal_${sequence}`,
    nextRevisionId: () => `revision_mounted_personal_${sequence}`,
    nextIndexJobId: () => `job_mounted_personal_${sequence}`,
    nextPersonalSpaceHandle: () => `personal-mounted-${sequence}`,
  };
}

function ordinaryIds() {
  let sequence = 0;
  return {
    nextSpaceId: () => `space_mounted_ordinary_${++sequence}`,
    nextMembershipId: () => `membership_mounted_ordinary_${sequence}`,
    nextRevisionId: () => `revision_mounted_ordinary_${sequence}`,
    nextIndexJobId: () => `job_mounted_ordinary_${sequence}`,
  };
}

function usageIds() {
  let generation = 0;
  let audit = 0;
  let outbox = 0;
  return {
    nextPrincipalMindUsageGenerationId: () => `usage_generation_${++generation}`,
    nextPrincipalMindUsageAuditEventId: () => `usage_audit_${++audit}`,
    nextPrincipalMindUsageOutboxMessageId: () => `usage_outbox_${++outbox}`,
  };
}

function revisionIds(...values) {
  let cursor = 0;
  return {
    nextRevisionId() {
      const value = values[cursor++];
      if (value === undefined) throw new Error("revision fixture exhausted");
      return value;
    },
  };
}

function sha256(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

async function setup() {
  const metadata = new InMemoryRevisionMetadataStore();
  const objects = new InMemoryObjectStore();
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
  });
  const usage = new PrincipalMindUsageApplicationService({
    usage: metadata,
    digest: objects,
    ids: usageIds(),
  });
  const account = await bootstrap.bootstrapAccount(beforeRegistration(), {
    action: "create_isolated_account",
  });
  const owner = sitesActor(account.principalId, "request_create_minds", T0);
  const writable = await ordinary.createSpaceWithOwner(owner, {
    name: "Engineering decisions",
    handle: "engineering-decisions",
    description: "Durable engineering implementation decisions",
    idempotencyKey: "create-engineering-decisions",
  });
  const readable = await ordinary.createSpaceWithOwner(owner, {
    name: "Product research",
    handle: "product-research-mounted",
    description: "Durable product research",
    idempotencyKey: "create-product-research-mounted",
  });
  assert.equal((await usage.mutate({
    actor: owner,
    spaceId: writable.mindId,
    usageMode: "read_write",
    expectedUsageVersion: 0,
    idempotencyKey: "select-writable",
  })).kind, "applied");
  assert.equal((await usage.mutate({
    actor: owner,
    spaceId: readable.mindId,
    usageMode: "read",
    expectedUsageVersion: 1,
    idempotencyKey: "enable-readable",
  })).kind, "applied");
  const coordinator = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  const authorizer = new CapabilityAuthorizer(metadata);

  const registerToken = async (tokenId, scopes = ["content:read", "content:write"]) => {
    for (const mind of [writable, readable]) {
      const current = await metadata.readCurrentAuthorizationState({
        principalId: account.principalId,
        spaceId: mind.mindId,
        tokenId: null,
      });
      assert.ok(current);
      metadata.setCurrentAuthorizationStateForTest({
        principalId: account.principalId,
        spaceId: mind.mindId,
        tokenId,
      }, {
        ...current,
        token: {
          tokenId,
          principalId: account.principalId,
          state: "active",
          scopes,
          version: 1,
          expiresAt: FUTURE,
        },
      });
    }
  };
  await registerToken("token_mounted_one");
  await registerToken("token_mounted_two");
  await registerToken("token_mounted_read_only", ["content:read"]);

  const service = (nextRevisionId, objectStore = objects) => new ChangesetCommitService({
    authorizer,
    metadata,
    revisions: coordinator,
    objects: objectStore,
    clock: { now: () => T2 },
    revisionIds: revisionIds(nextRevisionId),
  });
  return { metadata, objects, coordinator, usage, account, owner, writable, readable, service };
}

async function generatedOperations(env, path, title) {
  const head = await env.coordinator.readHeadRevision(env.writable.mindId);
  assert.ok(head);
  const index = head.files.find((file) => file.path === "index.md");
  assert.ok(index);
  const text = `---\ntype: Generated Knowledge\ntitle: ${title}\ngenerated: { by: mind-diary/0.3, at: 2026-08-30T21:00:00Z }\n---\n\n# ${title}\n`;
  return {
    expectedRevisionId: head.envelope.revision.revisionId,
    operations: [
      { type: "create_file", path, text },
      {
        type: "replace_index",
        path: "index.md",
        text: `${index.text.replace("\nAdd the first Memory.\n", "\n")}\n- [${title}](${path})\n`,
        expected_sha256: sha256(index.text),
      },
      {
        type: "add_log_entry",
        path: "log.md",
        category: "Update",
        message: `Added [${title}](${path}).`,
      },
    ],
  };
}

test("principal-owned writable Mind is shared by credentials and client binding fields are irrelevant", async () => {
  const env = await setup();
  const readableHead = await env.coordinator.readHeadRevision(env.readable.mindId);
  assert.ok(readableHead);
  const sourceReferences = [{
    spaceId: env.readable.mindId,
    revisionId: readableHead.envelope.revision.revisionId,
    path: "index.md",
  }];
  const payload = await generatedOperations(
    env,
    "concepts/shared-destination.md",
    "Shared destination",
  );
  const first = await env.service("revision_mounted_commit_one").commit({
    actor: tokenActor(env.account.principalId, "token_mounted_one", "commit_one"),
    spaceId: env.writable.mindId,
    ...payload,
    idempotencyKey: "shared-principal-commit",
    summary: "Store one durable engineering decision",
    sourceReferences,
    producerProfile: true,
    writeBindingId: "caller_value_must_be_ignored",
    automaticCapture: { malicious: true },
  });
  assert.equal(first.kind, "committed");
  const replay = await env.service("revision_must_not_be_used").commit({
    actor: tokenActor(env.account.principalId, "token_mounted_two", "commit_two"),
    spaceId: env.writable.mindId,
    ...payload,
    idempotencyKey: "shared-principal-commit",
    summary: "Store one durable engineering decision",
    sourceReferences,
    producerProfile: true,
    writeBindingId: "different_caller_value",
  });
  assert.equal(replay.kind, "committed");
  assert.equal(replay.replayed, true);
  assert.equal(replay.envelope.revision.revisionId, first.envelope.revision.revisionId);
  const audit = (await env.metadata.listAuditEventsForTest()).find(
    (event) => event.eventType === "content.changeset_committed",
  );
  assert.equal(audit.safeMetadata.source_reference_count, 1);
  assert.match(audit.safeMetadata.source_reference_digest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(audit).includes(env.readable.mindId), false);
});

test("source provenance requires an enabled exact source revision and path", async () => {
  const env = await setup();
  const readableHead = await env.coordinator.readHeadRevision(env.readable.mindId);
  assert.ok(readableHead);
  assert.equal((await env.usage.mutate({
    actor: env.owner,
    spaceId: env.readable.mindId,
    usageMode: "disabled",
    expectedUsageVersion: 2,
    idempotencyKey: "disable-source-mind",
  })).kind, "applied");
  const payload = await generatedOperations(
    env,
    "concepts/disabled-source.md",
    "Disabled source",
  );
  const result = await env.service("revision_disabled_source").commit({
    actor: tokenActor(env.account.principalId, "token_mounted_one", "disabled_source"),
    spaceId: env.writable.mindId,
    ...payload,
    idempotencyKey: "disabled-source",
    summary: "Must not use a disabled source Mind",
    sourceReferences: [{
      spaceId: env.readable.mindId,
      revisionId: readableHead.envelope.revision.revisionId,
      path: "index.md",
    }],
    producerProfile: true,
  });
  assert.equal(result.kind, "denied");
  assert.equal(result.decision.code, "access_denied");
  assert.equal(await env.metadata.readHead(env.writable.mindId), payload.expectedRevisionId);
});

test("wrong/read-only destination, missing writable mode, and read-only scope fail without a revision", async () => {
  const env = await setup();
  const beforeWritable = await env.metadata.listRevisions(env.writable.mindId);
  const beforeReadable = await env.metadata.listRevisions(env.readable.mindId);
  const wrong = await env.service("revision_wrong_target").commit({
    actor: tokenActor(env.account.principalId, "token_mounted_one", "wrong_target"),
    spaceId: env.readable.mindId,
    expectedRevisionId: env.readable.headRevisionId,
    idempotencyKey: "wrong-target",
    summary: "Must not redirect",
    operations: [],
    producerProfile: true,
  });
  assert.equal(wrong.kind, "denied");
  assert.equal(wrong.decision.code, "writable_mind_required");

  const readOnlyScope = await env.service("revision_read_only_scope").commit({
    actor: tokenActor(
      env.account.principalId,
      "token_mounted_read_only",
      "read_only_scope",
      ["content:read"],
    ),
    spaceId: env.writable.mindId,
    expectedRevisionId: env.writable.headRevisionId,
    idempotencyKey: "read-only-scope",
    summary: "Must be denied by scope",
    operations: [],
    producerProfile: true,
  });
  assert.equal(readOnlyScope.kind, "denied");
  assert.equal(readOnlyScope.decision.code, "insufficient_scope");

  assert.equal((await env.usage.mutate({
    actor: env.owner,
    spaceId: env.writable.mindId,
    usageMode: "read",
    expectedUsageVersion: 2,
    idempotencyKey: "disable-writes",
  })).kind, "applied");
  const disabled = await env.service("revision_disabled_target").commit({
    actor: tokenActor(env.account.principalId, "token_mounted_one", "disabled_target"),
    spaceId: env.writable.mindId,
    expectedRevisionId: env.writable.headRevisionId,
    idempotencyKey: "disabled-target",
    summary: "Must not fall back",
    operations: [],
    producerProfile: true,
  });
  assert.equal(disabled.kind, "denied");
  assert.equal(disabled.decision.code, "writable_mind_required");
  assert.equal((await env.metadata.listRevisions(env.writable.mindId)).length, beforeWritable.length);
  assert.equal((await env.metadata.listRevisions(env.readable.mindId)).length, beforeReadable.length);
});

test("enabling another writable Mind preserves the exact pinned generation", async () => {
  const env = await setup();
  const payload = await generatedOperations(env, "concepts/stale-pin.md", "Stale pin");
  let switched = false;
  const hookedObjects = new Proxy(env.objects, {
    get(target, property) {
      if (property === "putSpaceCanonicalObject") {
        return async (request) => {
          if (!switched) {
            switched = true;
            const result = await env.usage.mutate({
              actor: sitesActor(env.account.principalId, "switch_during_commit", T2),
              spaceId: env.readable.mindId,
              usageMode: "read_write",
              expectedUsageVersion: 2,
              idempotencyKey: "switch-during-commit",
            });
            assert.equal(result.kind, "applied");
          }
          return target.putSpaceCanonicalObject(request);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const result = await env.service("revision_stale_usage_pin", hookedObjects).commit({
    actor: tokenActor(env.account.principalId, "token_mounted_one", "stale_pin"),
    spaceId: env.writable.mindId,
    ...payload,
    idempotencyKey: "stale-usage-pin",
    summary: "Must be fenced by principal generation",
    producerProfile: true,
  });
  assert.equal(result.kind, "committed");
  assert.notEqual(result.envelope.revision.revisionId, payload.expectedRevisionId);
  assert.equal(
    await env.metadata.readHead(env.writable.mindId),
    result.envelope.revision.revisionId,
  );
  assert.equal((await env.metadata.listRevisions(env.writable.mindId)).length, 2);
});
