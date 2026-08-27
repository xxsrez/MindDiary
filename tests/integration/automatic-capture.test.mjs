import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  AutomaticCaptureService,
  CanonicalRevisionCoordinator,
  ChangesetCommitService,
  MindBindingApplicationService,
  MindBindingContentAuthorizer,
} from "@mind-diary/application-content";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";
import { CAPABILITIES, version } from "@mind-diary/domain";
import { validateOkfBundle } from "@mind-diary/okf-codec";
import {
  CANONICAL_REVISION_FILES,
  MINDS,
  PRINCIPALS,
  REVISION_AUTHORS,
  REVISIONS,
} from "@mind-diary/test-fixtures";

const NOW = "2026-08-22T10:00:00.000Z";
const EXPIRY = "2026-11-20T10:00:00.000Z";
const TOKEN_ID = "token_automatic_capture";
const BINDING_OWNER_ID = "grant_automatic_capture";
const OTHER_SPACE_ID = "space_capture_other";

function actor() {
  return {
    kind: "registered_principal",
    principalId: PRINCIPALS.editor.principalId,
    authentication: {
      kind: "mcp_token",
      tokenId: TOKEN_ID,
      bindingOwnerId: BINDING_OWNER_ID,
      effectiveScopes: ["content:read", "content:write"],
    },
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_automatic_capture",
    occurredAtUtc: NOW,
  };
}

function authorizationState(visibility = "private") {
  return {
    principal: {
      principalId: PRINCIPALS.editor.principalId,
      state: "active",
    },
    space: {
      spaceId: MINDS.ordinary.spaceId,
      state: "active",
      visibility,
      accessVersion: version(1),
    },
    membership: {
      principalId: PRINCIPALS.editor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      role: "editor",
      state: "active",
      version: version(1),
    },
    token: {
      tokenId: TOKEN_ID,
      principalId: PRINCIPALS.editor.principalId,
      state: "active",
      scopes: ["content:read", "content:write"],
      version: version(1),
      expiresAt: EXPIRY,
    },
  };
}

function bindingIds() {
  let writes = 0;
  let audits = 0;
  let outbox = 0;
  return {
    nextReadMindBindingId: () => "unused_read_binding",
    nextWriteMindBindingId: () => `write_capture_${++writes}`,
    nextMindBindingAuditEventId: () => `audit_capture_binding_${++audits}`,
    nextMindBindingOutboxMessageId: () => `outbox_capture_binding_${++outbox}`,
  };
}

function revisionIds(...ids) {
  let cursor = 0;
  return {
    nextRevisionId() {
      const id = ids[cursor];
      if (id === undefined) throw new Error("capture revision IDs exhausted");
      cursor += 1;
      return id;
    },
  };
}

async function fixture() {
  const metadata = new InMemoryRevisionMetadataStore();
  const objects = new InMemoryObjectStore();
  const revisions = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  const seeded = await revisions.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: null,
    revisionId: REVISIONS.initial.revisionId,
    committedAt: REVISIONS.initial.committedAt,
    committedBy: REVISION_AUTHORS.active,
    summary: "Seed automatic capture fixture",
    files: CANONICAL_REVISION_FILES,
  });
  assert.equal(seeded.kind, "committed");
  const currentActor = actor();
  metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: currentActor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      tokenId: TOKEN_ID,
    },
    authorizationState(),
  );
  const delegate = new CapabilityAuthorizer(metadata);
  const bindings = new MindBindingApplicationService({
    authorizer: delegate,
    bindings: metadata,
    writeAuthority: "legacy_mind_binding",
    ids: bindingIds(),
    digest: objects,
  });
  const bound = await bindings.mutateWrite({
    actor: currentActor,
    action: "bind",
    spaceId: MINDS.ordinary.spaceId,
    expectedBindingVersion: 0,
    idempotencyKey: "automatic-capture-bind",
  });
  assert.equal(bound.kind, "applied");
  const enabled = await bindings.mutateAutomaticCapture({
    actor: currentActor,
    action: "enable",
    expectedBindingVersion: 1,
    idempotencyKey: "automatic-capture-enable",
  });
  assert.equal(enabled.kind, "applied");
  const authorizer = new MindBindingContentAuthorizer({
    delegate,
    bindings: metadata,
    readAuthority: "legacy_mind_binding",
  });
  const commits = new ChangesetCommitService({
    authorizer,
    metadata,
    revisions,
    objects,
    clock: { now: () => NOW },
    revisionIds: revisionIds("revision_capture_one", "revision_capture_two"),
  });
  const capture = new AutomaticCaptureService({
    authorizer,
    bindings: metadata,
    revisions,
    commits,
  });
  return {
    actor: currentActor,
    bindings,
    capture,
    metadata,
    revisions,
    writeBindingId: bound.bindings.writeBinding.writeBindingId,
    bindingVersion: enabled.bindings.bindingSet.bindingVersion,
  };
}

function request(env, overrides = {}) {
  return {
    actor: env.actor,
    spaceId: MINDS.ordinary.spaceId,
    writeBindingId: env.writeBindingId,
    expectedBindingVersion: env.bindingVersion,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "capture-routine-fact",
    classification: "routine_non_sensitive",
    captureKind: "fact",
    captureKey: "preferred-review-style",
    title: "Preferred review style",
    description: "A routine working preference stated by the user.",
    body: "The user prefers evidence-led code review summaries.",
    sources: [{ kind: "user_statement" }],
    ...overrides,
  };
}

test("automatic capture commits bounded additive Memories and deduplicates exact content", async () => {
  const env = await fixture();
  const first = await env.capture.capture(request(env));
  assert.equal(first.kind, "captured");
  assert.equal(first.path, "concepts/captured/preferred-review-style.md");
  assert.equal(first.revisionId, "revision_capture_one");

  const targetSource = await env.capture.capture(request(env, {
    expectedRevisionId: first.revisionId,
    idempotencyKey: "capture-target-source",
    captureKey: "baseline-source-note",
    captureKind: "source_note",
    title: "Baseline source note",
    description: "A bounded note derived from the active target Mind.",
    body: "The baseline entry documents the reproducible fixture.",
    sources: [{
      kind: "target_entry",
      revisionId: first.revisionId,
      path: "concepts/baseline.md",
    }],
  }));
  assert.equal(targetSource.kind, "captured");
  assert.equal(targetSource.revisionId, "revision_capture_two");

  const noOp = await env.capture.capture(request(env));
  assert.deepEqual(noOp, {
    kind: "no_op",
    path: "concepts/captured/preferred-review-style.md",
    revisionId: "revision_capture_two",
  });
  const collision = await env.capture.capture(request(env, {
    expectedRevisionId: "revision_capture_two",
    idempotencyKey: "capture-routine-fact-collision",
    body: "Different content may not overwrite the stable capture key.",
  }));
  assert.deepEqual(collision, { kind: "capture_conflict" });

  const head = await env.revisions.readHeadRevision(MINDS.ordinary.spaceId);
  const validation = validateOkfBundle(
    head.files.map((file) => ({ path: file.path, text: file.text })),
  );
  assert.equal(validation.valid, true);
  assert.match(
    head.files.find((file) => file.path === "log.md").text,
    /Captured routine Memory at concepts\/captured\/baseline-source-note\.md/u,
  );
  const audit = (await env.metadata.listAuditEventsForTest()).filter(
    (event) => event.eventType === "content.changeset_committed",
  );
  assert.equal(audit.length, 2);
  assert.equal(audit[0].safeMetadata.capture_mode, "routine_non_sensitive");
  assert.equal(typeof audit[0].safeMetadata.capture_source_refs, "string");
  assert.equal(JSON.stringify(audit).includes("evidence-led code review"), false);
});

test("automatic capture fails closed for cross-Mind sources, visibility drift and rebind", async () => {
  const env = await fixture();
  const crossMind = await env.capture.capture(request(env, {
    captureKey: "cross-mind-source",
    idempotencyKey: "capture-cross-mind-source",
    sources: [{
      kind: "target_entry",
      revisionId: "revision_other_mind",
      path: "concepts/private.md",
    }],
  }));
  assert.deepEqual(crossMind, { kind: "capture_confirmation_required" });

  env.metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: env.actor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      tokenId: TOKEN_ID,
    },
    authorizationState("public"),
  );
  assert.deepEqual(
    await env.capture.capture(request(env, {
      captureKey: "visibility-drift",
      idempotencyKey: "capture-visibility-drift",
    })),
    { kind: "capture_target_visibility_blocked" },
  );

  env.metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: env.actor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      tokenId: TOKEN_ID,
    },
    authorizationState(),
  );
  env.metadata.setCurrentAuthorizationStateForTest(
    {
      principalId: env.actor.principalId,
      spaceId: OTHER_SPACE_ID,
      tokenId: TOKEN_ID,
    },
    {
      ...authorizationState(),
      space: {
        ...authorizationState().space,
        spaceId: OTHER_SPACE_ID,
      },
      membership: {
        ...authorizationState().membership,
        spaceId: OTHER_SPACE_ID,
      },
    },
  );
  const rebound = await env.bindings.mutateWrite({
    actor: env.actor,
    action: "bind",
    spaceId: OTHER_SPACE_ID,
    expectedBindingVersion: env.bindingVersion,
    idempotencyKey: "capture-new-write-generation",
  });
  assert.equal(rebound.kind, "applied");
  assert.equal(rebound.bindings.bindingSet.automaticCaptureMode, "disabled");
  assert.deepEqual(
    await env.capture.capture(request(env, {
      captureKey: "stale-generation",
      idempotencyKey: "capture-stale-generation",
    })),
    { kind: "capture_disabled" },
  );
  assert.deepEqual(
    await env.capture.capture(request(env, {
      classification: "sensitive",
      captureKey: "sensitive-input",
      idempotencyKey: "capture-sensitive-input",
    })),
    { kind: "invalid_capture_request" },
  );
});
