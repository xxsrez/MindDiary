import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  CanonicalRevisionCoordinator,
  MindValidationFailure,
  MindValidationService,
  VALIDATION_ISSUE_LIMIT,
  VALIDATION_MESSAGE_CHARACTER_LIMIT,
} from "@mind-diary/application-content";
import {
  AccountBootstrapService,
  OrdinaryMindControlService,
  VisibilityControlService,
} from "@mind-diary/application-control";
import {
  CAPABILITIES,
  MARKDOWN_MEDIA_TYPE,
  verifiedSpaceHost,
} from "@mind-diary/domain";

const BOOTSTRAP_AT = "2026-08-07T20:20:00.000Z";
const CREATED_AT = "2026-08-07T20:21:00.000Z";
const VALIDATED_AT = "2026-08-07T20:22:00.000Z";
const HOST = verifiedSpaceHost("mind-diary.example");
const encoder = new TextEncoder();

function preRegistrationActor(index, displayName = `Validation Principal ${index}`) {
  return {
    kind: "sites_identity_before_registration",
    authentication: { kind: "sites_identity", verifiedByPlatform: true },
    provider: "openai-sites",
    normalizedBinding: `private.validation.${index}@example.com`,
    suggestedDisplayName: displayName,
    deploymentCapabilities: CAPABILITIES,
    requestId: `request_validation_bootstrap_${index}`,
    occurredAtUtc: BOOTSTRAP_AT,
  };
}

function actor(
  principalId,
  requestId = "request_validation",
  occurredAtUtc = VALIDATED_AT,
) {
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
  let account = 0;
  return {
    nextPrincipalId: () => `principal_validation_${++account}`,
    nextExternalBindingId: () => `binding_validation_${account}`,
    nextSpaceId: () => `space_personal_validation_${account}`,
    nextMembershipId: () => `membership_personal_validation_${account}`,
    nextRevisionId: () => `revision_personal_validation_${account}`,
    nextPersonalSpaceHandle: () => `personal-service-validation-${account}`,
  };
}

function ordinaryIds() {
  let space = 0;
  let membership = 0;
  let revision = 0;
  return {
    nextSpaceId: () => `space_validation_${++space}`,
    nextMembershipId: () => `membership_validation_owner_${++membership}`,
    nextRevisionId: () => `revision_validation_initial_${++revision}`,
  };
}

function auditIds() {
  let event = 0;
  let outbox = 0;
  return {
    nextAuditEventId: () => `audit_validation_${++event}`,
    nextOutboxMessageId: () => `outbox_validation_${++outbox}`,
  };
}

function revisionHeadStore(metadata) {
  return new Proxy(metadata, {
    get(target, property) {
      if (property === "readResolvedSpace") {
        return async (spaceId) => {
          const state = await target.inspectOrdinaryMindStateForTest(spaceId);
          const headRevisionId = await target.readHead(spaceId);
          if (state === null || headRevisionId === null) return null;
          return {
            host: state.reservation.host,
            canonicalHandle: state.reservation.canonicalHandle,
            space: { ...state.space, headRevisionId },
          };
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function observedObjects(delegate) {
  let reads = 0;
  let afterNextRead = null;
  return {
    kind: "object-store",
    calculateSha256: (bytes) => delegate.calculateSha256(bytes),
    putImmutable: (request) => delegate.putImmutable(request),
    getImmutable: async (sha256) => {
      reads += 1;
      const value = await delegate.getImmutable(sha256);
      const callback = afterNextRead;
      afterNextRead = null;
      if (callback !== null) await callback();
      return value;
    },
    listImmutableObjects: (request) => delegate.listImmutableObjects(request),
    deleteImmutableObject: (request) => delegate.deleteImmutableObject(request),
    reads: () => reads,
    resetReads: () => {
      reads = 0;
    },
    afterNextRead: (callback) => {
      afterNextRead = callback;
    },
  };
}

function harness() {
  const metadata = new InMemoryRevisionMetadataStore();
  const store = revisionHeadStore(metadata);
  const objects = new InMemoryObjectStore();
  const observed = observedObjects(objects);
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
  const visibility = new VisibilityControlService({
    ordinaryMinds: metadata,
    objects,
    auditIds: auditIds(),
  });
  const revisions = new CanonicalRevisionCoordinator({
    objects,
    revisions: metadata,
  });
  const validation = new MindValidationService({
    store,
    objects: observed,
    host: HOST,
  });
  let revision = 0;
  return {
    metadata,
    objects,
    observed,
    bootstrap,
    ordinary,
    visibility,
    revisions,
    validation,
    nextRevisionId: () => `revision_validation_content_${++revision}`,
  };
}

async function createAccount(env, index, displayName) {
  return env.bootstrap.bootstrapAccount(
    preRegistrationActor(index, displayName),
    { action: "create_isolated_account" },
  );
}

async function createMind(env, owner, handle) {
  return env.ordinary.createSpaceWithOwner(
    actor(owner.principalId, `request_create_${handle}`, CREATED_AT),
    { name: handle, handle, idempotencyKey: `create-${handle}` },
  );
}

async function commitFiles(env, owner, mind, files, summary) {
  const expectedRevisionId = await env.metadata.readHead(mind.mindId);
  assert.ok(expectedRevisionId);
  const result = await env.revisions.commit({
    spaceId: mind.mindId,
    expectedRevisionId,
    revisionId: env.nextRevisionId(),
    committedAt: VALIDATED_AT,
    committedBy: { kind: "principal", principalId: owner.principalId },
    summary,
    files: files.map((file) => ({
      path: file.path,
      mediaType: MARKDOWN_MEDIA_TYPE,
      bytes: encoder.encode(file.text),
    })),
  });
  assert.equal(result.kind, "committed");
  return result.envelope.revision.revisionId;
}

function rootIndex(body = "") {
  return `---\nokf_version: "0.2"\n---\n\n# Validation fixture\n\n${body}`;
}

function expectValidationFailure(code) {
  return (error) => {
    assert.ok(error instanceof MindValidationFailure);
    assert.equal(error.code, code);
    return true;
  };
}

test("validation is exact-revision-bound, strict across the whole bundle, and separates quality warnings", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Validation Owner");
  const mind = await createMind(env, owner, "strict-validation");
  const ownerActor = actor(owner.principalId);

  const invalidRevision = await commitFiles(
    env,
    owner,
    mind,
    [
      {
        path: "index.md",
        text: rootIndex("- [Outside wiki](raw/outside-wiki.md)\n"),
      },
      { path: "wiki/good.md", text: "---\ntype: Reference\n---\n\n# Good\n" },
      { path: "raw/outside-wiki.md", text: "# Missing frontmatter\n" },
    ],
    "Commit invalid full-bundle fixture",
  );
  const validHead = await commitFiles(
    env,
    owner,
    mind,
    [
      { path: "index.md", text: rootIndex("- [Future](future.md)\n") },
      {
        path: "future.md",
        text: "---\ntype: Future Producer Type\nproducer_extension: retained\nstatus: experimental\n---\n\n# Future\n",
      },
    ],
    "Commit valid future-compatible fixture",
  );

  const exact = await env.validation.validateMind(ownerActor, {
    mind: mind.handle,
    revisionSelector: { kind: "revision", revisionId: invalidRevision },
  });
  assert.equal(exact.resolvedRevision.revisionId, invalidRevision);
  assert.equal(exact.revisionMode, "historical");
  assert.equal(exact.readOnly, true);
  assert.equal(exact.valid, false);
  assert.equal(exact.validatedOkfVersion, "0.2");
  assert.deepEqual(
    exact.conformanceErrors.map((issue) => [issue.path, issue.code, issue.class]),
    [["raw/outside-wiki.md", "missing_frontmatter", "conformance"]],
  );

  const head = await env.validation.validateMind(ownerActor, { mind: mind.mindId });
  assert.equal(head.resolvedRevision.revisionId, validHead);
  assert.equal(head.revisionMode, "head");
  assert.equal(head.readOnly, true);
  assert.equal(head.valid, true);
  assert.equal(head.conformanceErrors.length, 0);
  assert.deepEqual(
    head.qualityWarnings.map((issue) => [issue.code, issue.severity, issue.class]),
    [["invalid_lifecycle_status", "warning", "advisory"]],
  );
  assert.equal(head.qualityWarnings[0].blocksCommit, true);
  assert.equal(head.commitReady, false);
  assert.equal(head.validationComplete, true);
  assert.equal(head.validationRulesVersion, "2026-09-18");
  assert.equal(head.nextCursor, null);
  assert.equal(head.issuesTruncated, false);
});

test("private denial performs no canonical object read and returns no diagnostics", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Private Owner");
  const outsider = await createAccount(env, 2, "Private Outsider");
  const mind = await createMind(env, owner, "private-validation");
  await commitFiles(
    env,
    owner,
    mind,
    [{ path: "private.md", text: "PRIVATE_VALIDATION_BODY_WITHOUT_FRONTMATTER" }],
    "Commit private invalid content",
  );
  env.observed.resetReads();

  await assert.rejects(
    env.validation.validateMind(actor(outsider.principalId), { mind: mind.handle }),
    expectValidationFailure("mind_not_found"),
  );
  assert.equal(env.observed.reads(), 0);
});

test("validation response is bounded and issue messages do not echo untrusted link targets", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Budget Owner");
  const mind = await createMind(env, owner, "bounded-validation");
  const privateTarget = "PRIVATE_TARGET_SHOULD_NOT_BE_ECHOED";
  const links = Array.from(
    { length: VALIDATION_ISSUE_LIMIT + 5 },
    (_, index) => `- [Missing ${index}](${privateTarget}-${index}.md)`,
  ).join("\n");
  await commitFiles(
    env,
    owner,
    mind,
    [{ path: "index.md", text: rootIndex(`${links}\n`) }],
    "Commit many quality warnings",
  );

  const result = await env.validation.validateMind(actor(owner.principalId), {
    mind: mind.handle,
  });
  assert.equal(result.valid, false);
  assert.equal(result.commitReady, false);
  assert.equal(result.validationComplete, true);
  assert.equal(result.issueCounts.consistencyErrors, VALIDATION_ISSUE_LIMIT + 5);
  assert.equal(result.consistencyErrors.length, VALIDATION_ISSUE_LIMIT);
  assert.equal(result.issuesTruncated, true);
  assert.equal(typeof result.nextCursor, "string");
  assert.ok(
    result.consistencyErrors.every(
      (issue) =>
        issue.message.length <= VALIDATION_MESSAGE_CHARACTER_LIMIT &&
        !issue.message.includes(privateTarget),
    ),
  );
  const continuation = await env.validation.validateMind(actor(owner.principalId), {
    mind: mind.handle,
    cursor: result.nextCursor,
  });
  assert.equal(continuation.consistencyErrors.length, 5);
  assert.equal(continuation.issuesTruncated, false);
  assert.equal(continuation.nextCursor, null);
  assert.deepEqual(
    new Set([
      ...result.consistencyErrors,
      ...continuation.consistencyErrors,
    ].map((issue) => issue.target)),
    new Set(Array.from(
      { length: VALIDATION_ISSUE_LIMIT + 5 },
      (_, index) => `${privateTarget}-${index}.md`,
    )),
  );
  await commitFiles(
    env,
    owner,
    mind,
    [{ path: "index.md", text: rootIndex("# Fresh HEAD\n") }],
    "Move HEAD after validation pagination",
  );
  await assert.rejects(
    env.validation.validateMind(actor(owner.principalId), {
      mind: mind.handle,
      cursor: result.nextCursor,
    }),
    expectValidationFailure("invalid_request"),
  );
});

test("access revoked during materialization fails closed without returning a partial result", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Race Owner");
  const outsider = await createAccount(env, 2, "Race Reader");
  const mind = await createMind(env, owner, "validation-race");
  await commitFiles(
    env,
    owner,
    mind,
    [
      { path: "index.md", text: rootIndex("- [Entry](entry.md)\n") },
      { path: "entry.md", text: "---\ntype: Reference\n---\n\n# Entry\n" },
    ],
    "Commit race fixture",
  );
  const before = await env.metadata.inspectOrdinaryMindStateForTest(mind.mindId);
  assert.ok(before);
  await env.visibility.changeVisibility(actor(owner.principalId), {
    mindId: mind.mindId,
    visibility: "public",
    acknowledgeLiveHeadAndHistoryExposure: true,
    expectedMetadataVersion: before.space.metadataVersion,
    idempotencyKey: "open-validation-race",
  });
  env.observed.afterNextRead(async () => {
    const opened = await env.metadata.inspectOrdinaryMindStateForTest(mind.mindId);
    assert.ok(opened);
    await env.visibility.changeVisibility(actor(owner.principalId), {
      mindId: mind.mindId,
      visibility: "private",
      expectedMetadataVersion: opened.space.metadataVersion,
      idempotencyKey: "close-validation-race",
    });
  });

  await assert.rejects(
    env.validation.validateMind(actor(outsider.principalId), { mind: mind.handle }),
    expectValidationFailure("mind_not_found"),
  );
});
