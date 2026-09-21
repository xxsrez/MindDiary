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
import { ObjectStoreFailure } from "@mind-diary/application-ports";
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
  let active = 0;
  let maximum = 0;
  let delayMs = 0;
  let failAtRead = null;
  let afterNextRead = null;
  return {
    kind: "object-store",
    calculateSha256: (bytes) => delegate.calculateSha256(bytes),
    putImmutable: (request) => delegate.putImmutable(request),
    getImmutable: async (sha256) => {
      reads += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        if (failAtRead !== null && reads === failAtRead) {
          throw new ObjectStoreFailure(
            "object_read_timeout",
            "injected validation object read failure",
          );
        }
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        const value = await delegate.getImmutable(sha256);
        const callback = afterNextRead;
        afterNextRead = null;
        if (callback !== null) await callback();
        return value;
      } finally {
        active -= 1;
      }
    },
    listImmutableObjects: (request) => delegate.listImmutableObjects(request),
    deleteImmutableObject: (request) => delegate.deleteImmutableObject(request),
    reads: () => reads,
    maximum: () => maximum,
    resetReads: () => {
      reads = 0;
      maximum = 0;
    },
    configure: (options = {}) => {
      delayMs = options.delayMs ?? 0;
      failAtRead = options.failAtRead ?? null;
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

function largeValidationFixtureFiles() {
  return [
    { path: "index.md", text: rootIndex() },
    ...Array.from({ length: 163 }, (_, index) => ({
      path: `concepts/bounded-${String(index).padStart(3, "0")}.md`,
      text: `---\ntype: Reference\n---\n\n# Bounded ${index}\n`,
    })),
  ];
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
  const afterHeadChange = await env.validation.validateMind(actor(owner.principalId), {
    mind: mind.handle,
    cursor: result.nextCursor,
  });
  assert.equal(
    afterHeadChange.resolvedRevision.revisionId,
    result.resolvedRevision.revisionId,
  );
  assert.equal(afterHeadChange.consistencyErrors.length, 5);
  assert.equal(afterHeadChange.nextCursor, null);

  await assert.rejects(
    env.validation.validateMind(actor(owner.principalId), {
      mind: mind.handle,
      revisionSelector: { kind: "head" },
      cursor: result.nextCursor,
    }),
    expectValidationFailure("invalid_request"),
  );
  await assert.rejects(
    env.validation.validateMind(actor(owner.principalId), {
      mind: mind.handle,
      cursor: `${result.nextCursor}tampered`,
    }),
    expectValidationFailure("invalid_request"),
  );

  const foreignMind = await createMind(env, owner, "foreign-pagination");
  await assert.rejects(
    env.validation.validateMind(actor(owner.principalId), {
      mind: foreignMind.handle,
      cursor: result.nextCursor,
    }),
    expectValidationFailure("revision_not_found"),
  );
});

test("validation diagnostic pagination preserves 0, 100 and 101 issue boundaries", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Boundary Owner");
  const ownerActor = actor(owner.principalId);

  for (const issueCount of [0, VALIDATION_ISSUE_LIMIT, VALIDATION_ISSUE_LIMIT + 1]) {
    const mind = await createMind(env, owner, `boundary-${issueCount}`);
    const links = Array.from(
      { length: issueCount },
      (_, index) => `- [Missing ${index}](missing-${issueCount}-${index}.md)`,
    ).join("\n");
    await commitFiles(
      env,
      owner,
      mind,
      [{ path: "index.md", text: rootIndex(links.length === 0 ? "" : `${links}\n`) }],
      `Commit ${issueCount} validation issues`,
    );
    const first = await env.validation.validateMind(ownerActor, { mind: mind.handle });
    assert.equal(first.issueCounts.consistencyErrors, issueCount);
    assert.equal(first.consistencyErrors.length, Math.min(issueCount, VALIDATION_ISSUE_LIMIT));
    assert.equal(first.issuesTruncated, issueCount > VALIDATION_ISSUE_LIMIT);
    assert.equal(first.nextCursor === null, issueCount <= VALIDATION_ISSUE_LIMIT);
    if (first.nextCursor !== null) {
      const second = await env.validation.validateMind(ownerActor, {
        mind: mind.handle,
        cursor: first.nextCursor,
      });
      assert.equal(second.consistencyErrors.length, 1);
      assert.equal(second.nextCursor, null);
    }
  }
});

test("mixed validation diagnostics paginate deterministically without gaps or duplicates", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Mixed Diagnostics Owner");
  const mind = await createMind(env, owner, "mixed-diagnostics");
  const missingLinks = Array.from(
    { length: VALIDATION_ISSUE_LIMIT + 5 },
    (_, index) => `- [Missing ${index}](mixed-missing-${index}.md)`,
  ).join("\n");
  await commitFiles(
    env,
    owner,
    mind,
    [{
      path: "index.md",
      text: rootIndex(`- [Warning](concepts/warning.md)\n${missingLinks}\n`),
    }, {
      path: "concepts/warning.md",
      text: "---\ntype: Generated Knowledge\nstatus: reviewed\n---\n\n# Warning\n",
    }, {
      path: "raw/nonconformant.md",
      text: "# Missing frontmatter\n",
    }],
    "Commit mixed paginated diagnostics",
  );

  const request = { mind: mind.handle };
  const first = await env.validation.validateMind(actor(owner.principalId), request);
  const repeated = await env.validation.validateMind(actor(owner.principalId), request);
  assert.deepEqual(repeated, first);
  const expectedTotal = first.issueCounts.conformanceErrors +
    first.issueCounts.consistencyErrors + first.issueCounts.advisories;
  assert.ok(expectedTotal > VALIDATION_ISSUE_LIMIT);

  const seen = new Set();
  const classes = new Set();
  let page = first;
  for (;;) {
    for (const issue of [
      ...page.conformanceErrors,
      ...page.consistencyErrors,
      ...page.advisories,
    ]) {
      const identity = JSON.stringify([
        issue.class,
        issue.code,
        issue.path,
        issue.line ?? null,
        issue.target ?? null,
      ]);
      assert.equal(seen.has(identity), false, identity);
      seen.add(identity);
      classes.add(issue.class);
    }
    if (page.nextCursor === null) break;
    page = await env.validation.validateMind(actor(owner.principalId), {
      mind: mind.handle,
      cursor: page.nextCursor,
    });
  }
  assert.equal(seen.size, expectedTotal);
  assert.deepEqual([...classes].sort(), ["advisory", "conformance", "consistency"]);
});

test("validation cursor continuation rechecks current access after visibility revoke", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Cursor Revoke Owner");
  const outsider = await createAccount(env, 2, "Cursor Revoke Reader");
  const mind = await createMind(env, owner, "cursor-revoke");
  const links = Array.from(
    { length: VALIDATION_ISSUE_LIMIT + 1 },
    (_, index) => `- [Missing ${index}](revoke-missing-${index}.md)`,
  ).join("\n");
  await commitFiles(
    env,
    owner,
    mind,
    [{ path: "index.md", text: rootIndex(`${links}\n`) }],
    "Commit cursor revoke fixture",
  );
  const privateState = await env.metadata.inspectOrdinaryMindStateForTest(mind.mindId);
  assert.ok(privateState);
  await env.visibility.changeVisibility(actor(owner.principalId), {
    mindId: mind.mindId,
    visibility: "public",
    acknowledgeLiveHeadAndHistoryExposure: true,
    expectedMetadataVersion: privateState.space.metadataVersion,
    idempotencyKey: "open-cursor-revoke",
  });
  const first = await env.validation.validateMind(actor(outsider.principalId), {
    mind: mind.handle,
  });
  assert.equal(typeof first.nextCursor, "string");
  const publicState = await env.metadata.inspectOrdinaryMindStateForTest(mind.mindId);
  assert.ok(publicState);
  await env.visibility.changeVisibility(actor(owner.principalId), {
    mindId: mind.mindId,
    visibility: "private",
    expectedMetadataVersion: publicState.space.metadataVersion,
    idempotencyKey: "close-cursor-revoke",
  });
  await assert.rejects(
    env.validation.validateMind(actor(outsider.principalId), {
      mind: mind.handle,
      cursor: first.nextCursor,
    }),
    expectValidationFailure("mind_not_found"),
  );
});

test("large exact revisions materialize Markdown objects with bounded concurrency and stable validation", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Large Validation Owner");
  const mind = await createMind(env, owner, "large-bounded-validation");
  await commitFiles(
    env,
    owner,
    mind,
    largeValidationFixtureFiles(),
    "Commit large bounded validation fixture",
  );
  env.observed.configure({ delayMs: 2 });

  const result = await env.validation.validateMind(actor(owner.principalId), {
    mind: mind.handle,
  });

  assert.equal(result.valid, true);
  assert.equal(result.validationComplete, true);
  assert.equal(result.conformanceErrors.length, 0);
  assert.equal(result.consistencyErrors.length, 0);
  assert.ok(env.observed.maximum() > 1);
  assert.ok(env.observed.maximum() <= 8);
  assert.equal(env.observed.reads(), largeValidationFixtureFiles().length);
});

test("large exact revision object failure is reported as integrity failure without a partial validation result", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Failure Validation Owner");
  const mind = await createMind(env, owner, "large-failure-validation");
  await commitFiles(
    env,
    owner,
    mind,
    largeValidationFixtureFiles(),
    "Commit large validation failure fixture",
  );
  env.observed.configure({ delayMs: 1, failAtRead: 37 });

  await assert.rejects(
    env.validation.validateMind(actor(owner.principalId), { mind: mind.handle }),
    expectValidationFailure("revision_integrity_failure"),
  );
  assert.ok(env.observed.maximum() > 1);
  assert.ok(env.observed.maximum() <= 8);
});

test("validation rechecks current access between bounded materialization batches", async () => {
  const env = harness();
  const owner = await createAccount(env, 1, "Batch Revoke Owner");
  const outsider = await createAccount(env, 2, "Batch Revoke Reader");
  const mind = await createMind(env, owner, "batch-revoke-validation");
  await commitFiles(
    env,
    owner,
    mind,
    largeValidationFixtureFiles(),
    "Commit batch revoke fixture",
  );
  const before = await env.metadata.inspectOrdinaryMindStateForTest(mind.mindId);
  assert.ok(before);
  await env.visibility.changeVisibility(actor(owner.principalId), {
    mindId: mind.mindId,
    visibility: "public",
    acknowledgeLiveHeadAndHistoryExposure: true,
    expectedMetadataVersion: before.space.metadataVersion,
    idempotencyKey: "open-batch-revoke-validation",
  });
  env.observed.configure({ delayMs: 2 });
  env.observed.afterNextRead(async () => {
    const opened = await env.metadata.inspectOrdinaryMindStateForTest(mind.mindId);
    assert.ok(opened);
    await env.visibility.changeVisibility(actor(owner.principalId), {
      mindId: mind.mindId,
      visibility: "private",
      expectedMetadataVersion: opened.space.metadataVersion,
      idempotencyKey: "close-batch-revoke-validation",
    });
  });

  await assert.rejects(
    env.validation.validateMind(actor(outsider.principalId), { mind: mind.handle }),
    expectValidationFailure("mind_not_found"),
  );
  assert.ok(env.observed.reads() >= 8);
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
