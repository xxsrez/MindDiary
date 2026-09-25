import assert from "node:assert/strict";
import test from "node:test";
import {
  CanonicalRevisionCoordinator,
  ChangesetCommitService,
  DEFAULT_IDEMPOTENCY_KEY_MAX_BYTES,
} from "@mind-diary/application-content";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";
import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import { CAPABILITIES, MARKDOWN_MEDIA_TYPE, version } from "@mind-diary/domain";
import {
  CANONICAL_REVISION_FILES,
  FIXED_NOW,
  MINDS,
  PRINCIPALS,
  REVISION_AUTHORS,
  REVISIONS,
} from "@mind-diary/test-fixtures";

const SPACE_A = MINDS.ordinary.spaceId;
const SPACE_B = "space_idempotency_isolated";
const INITIAL_A = REVISIONS.initial.revisionId;
const INITIAL_B = "revision_idempotency_initial_b";
const FUTURE = "2026-11-03T12:00:00.000Z";
const ENCODER = new TextEncoder();

function actor(principalId, tokenId, requestId) {
  return {
    kind: "registered_principal",
    principalId,
    authentication: {
      kind: "mcp_token",
      tokenId,
      effectiveScopes: ["content:read", "content:write"],
    },
    deploymentCapabilities: CAPABILITIES,
    requestId,
    occurredAtUtc: FIXED_NOW,
  };
}

function authorizationQuery(currentActor, spaceId) {
  return {
    principalId: currentActor.principalId,
    spaceId,
    tokenId: currentActor.authentication.tokenId,
  };
}

function authorizationState(currentActor, spaceId, overrides = {}) {
  return {
    principal: {
      principalId: currentActor.principalId,
      state: "active",
    },
    space: {
      spaceId,
      state: "active",
      visibility: "private",
      accessVersion: overrides.accessVersion ?? version(1),
    },
    membership: {
      principalId: currentActor.principalId,
      spaceId,
      role: overrides.role ?? "editor",
      state: overrides.membershipState ?? "active",
      version: overrides.membershipVersion ?? version(1),
    },
    token: {
      tokenId: currentActor.authentication.tokenId,
      principalId: currentActor.principalId,
      state: overrides.tokenState ?? "active",
      scopes: ["content:read", "content:write"],
      version: overrides.tokenVersion ?? version(1),
      expiresAt: FUTURE,
    },
  };
}

function revisionIds(...ids) {
  let cursor = 0;
  return {
    nextRevisionId() {
      const id = ids[cursor];
      if (!id) throw new Error("revision fixture IDs exhausted");
      cursor += 1;
      return id;
    },
  };
}

function objectStoreWithFirstPutHook(objects, hook) {
  let invoked = false;
  const beforeFirstPut = async () => {
    if (invoked) return;
    invoked = true;
    await hook();
  };
  return {
    kind: "object-store",
    calculateSha256: (bytes) => objects.calculateSha256(bytes),
    async putImmutable(request) {
      await beforeFirstPut();
      return objects.putImmutable(request);
    },
    async putSpaceCanonicalObject(request) {
      await beforeFirstPut();
      return objects.putSpaceCanonicalObject(request);
    },
    getSpaceCanonicalObject: (kind, spaceId, digest) =>
      objects.getSpaceCanonicalObject(kind, spaceId, digest),
    listSpaceCanonicalObjects: (request) => objects.listSpaceCanonicalObjects(request),
    deleteSpaceCanonicalObject: (request) => objects.deleteSpaceCanonicalObject(request),
    putBundleFile: (request) => objects.putBundleFile(request),
    getBundleFile: (spaceId, digest) => objects.getBundleFile(spaceId, digest),
    listBundleFileObjects: (request) => objects.listBundleFileObjects(request),
    deleteBundleFileObject: (request) => objects.deleteBundleFileObject(request),
    putStagedBundleFile: (request) => objects.putStagedBundleFile(request),
    getStagedBundleFile: (id) => objects.getStagedBundleFile(id),
    deleteStagedBundleFile: (id) => objects.deleteStagedBundleFile(id),
    getImmutable: (digest) => objects.getImmutable(digest),
    listImmutableObjects: (request) => objects.listImmutableObjects(request),
    deleteImmutableObject: (request) => objects.deleteImmutableObject(request),
  };
}

function changes(path, title) {
  return [
    {
      type: "create_file",
      path,
      text: `---\ntype: Reference\ntitle: ${title}\n---\n\n# ${title}\n`,
    },
    {
      type: "replace_index",
      path: "index.md",
      text: `---\nokf_version: "0.2"\n---\n\n# Fixture Mind\n\n- [Reproducible baseline](concepts/baseline.md)\n- [${title}](${path})\n`,
    },
  ];
}

function principalMountedMetadata(metadata) {
  const mounted = new Map();
  let generation = 0;
  const select = (principalId, spaceId) => {
    const current = Object.freeze({
      principalId,
      spaceId,
      generationId: `usage_generation_idempotency_${++generation}`,
    });
    mounted.set(principalId, current);
    return current;
  };
  const ensure = (principalId, spaceId) => {
    const current = mounted.get(principalId);
    return current?.spaceId === spaceId ? current : select(principalId, spaceId);
  };
  const readUsage = async (principalId) => {
    const current = mounted.get(principalId);
    if (current === undefined) return null;
    return Object.freeze({
      principalId,
      entries: Object.freeze([Object.freeze({
        principalId,
        spaceId: current.spaceId,
        usageMode: "read_write",
        writeGeneration: current,
      })]),
    });
  };
  const validatePin = async (pin) => {
    const current = mounted.get(pin.principalId);
    return current !== undefined &&
      current.spaceId === pin.spaceId &&
      current.generationId === pin.generationId;
  };
  const wrapTransaction = (transaction) => Object.freeze({
    ...transaction,
    readPrincipalMindUsage: readUsage,
    validatePrincipalMindUsageWritePin: validatePin,
  });
  const store = new Proxy(metadata, {
    get(target, property) {
      if (property === "readPrincipalMindUsage") return readUsage;
      if (property === "validatePrincipalMindUsageWritePin") return validatePin;
      if (property === "runContentCommitTransaction") {
        return (operation) => target.runContentCommitTransaction((transaction) =>
          operation(wrapTransaction(transaction)));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return Object.freeze({ store, select, ensure });
}

async function fixture() {
  const objects = new InMemoryObjectStore();
  const rawMetadata = new InMemoryRevisionMetadataStore();
  const usage = principalMountedMetadata(rawMetadata);
  const metadata = usage.store;
  const coordinator = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  const authorizer = new CapabilityAuthorizer(metadata);
  const seed = async (spaceId, revisionId) => {
    const seeded = await coordinator.commit({
      spaceId,
      expectedRevisionId: null,
      revisionId,
      committedAt: REVISIONS.initial.committedAt,
      committedBy: REVISION_AUTHORS.active,
      summary: "Seed idempotency fixture",
      files: CANONICAL_REVISION_FILES,
    });
    assert.equal(seeded.kind, "committed");
  };
  const grant = (currentActor, spaceId, overrides) => {
    usage.ensure(currentActor.principalId, spaceId);
    metadata.setCurrentAuthorizationStateForTest(
      authorizationQuery(currentActor, spaceId),
      authorizationState(currentActor, spaceId, overrides),
    );
  };
  const service = (ids, objectStore = objects) =>
    new ChangesetCommitService({
      authorizer,
      metadata,
      revisions: coordinator,
      objects: objectStore,
      clock: { now: () => REVISIONS.next.committedAt },
      revisionIds: revisionIds(...ids),
    });
  const snapshot = async (spaceId) => ({
    head: await metadata.readHead(spaceId),
    revisions: (await metadata.listRevisions(spaceId)).map(
      (revision) => revision.revision.revisionId,
    ),
    idempotency: await metadata.listIdempotencyRecordsForTest(),
  });
  return { objects, metadata, coordinator, seed, grant, service, snapshot, usage };
}

function request({ currentActor, spaceId, expectedRevisionId, key, path, title }) {
  return {
    actor: currentActor,
    spaceId,
    expectedRevisionId,
    idempotencyKey: key,
    summary: `Add ${title}`,
    operations: changes(path, title),
  };
}

test("success stores a typed result and exact replay survives a later HEAD move", async () => {
  const env = await fixture();
  await env.seed(SPACE_A, INITIAL_A);
  const editor = actor(
    PRINCIPALS.editor.principalId,
    "token_idempotency_replay",
    "request_idempotency_replay",
  );
  env.grant(editor, SPACE_A);
  const service = env.service(["revision_idempotency_original"]);
  const originalRequest = request({
    currentActor: editor,
    spaceId: SPACE_A,
    expectedRevisionId: INITIAL_A,
    key: "same_payload_after_head_move",
    path: "concepts/idempotent.md",
    title: "Idempotent",
  });

  assert.deepEqual(await service.reconcile(originalRequest), { kind: "missing" });

  const original = await service.commit(originalRequest);
  assert.equal(original.kind, "committed");
  assert.equal(original.replayed, false);
  assert.equal(original.envelope.revision.revisionId, "revision_idempotency_original");
  const reconciled = await service.reconcile(structuredClone(originalRequest));
  assert.equal(reconciled.kind, "committed");
  assert.equal(reconciled.replayed, true);
  assert.equal(
    reconciled.envelope.revision.revisionId,
    "revision_idempotency_original",
  );

  const advanced = await env.coordinator.commit({
    spaceId: SPACE_A,
    expectedRevisionId: "revision_idempotency_original",
    revisionId: "revision_after_idempotent_effect",
    committedAt: "2026-08-06T12:01:00.000Z",
    committedBy: REVISION_AUTHORS.active,
    summary: "Advance HEAD independently",
    files: [
      ...CANONICAL_REVISION_FILES,
      {
        path: "concepts/advanced.md",
        mediaType: MARKDOWN_MEDIA_TYPE,
        bytes: ENCODER.encode(
          "---\ntype: Reference\ntitle: Advanced\n---\n\n# Advanced\n",
        ),
      },
    ],
  });
  assert.equal(advanced.kind, "committed");

  const replay = await service.commit({
    ...originalRequest,
    operations: originalRequest.operations.map((operation) =>
      operation.type === "create_file"
        ? { text: operation.text, path: operation.path, type: operation.type }
        : { text: operation.text, type: operation.type, path: operation.path },
    ),
  });
  assert.equal(replay.kind, "committed");
  assert.equal(replay.replayed, true);
  assert.equal(replay.envelope.revision.revisionId, "revision_idempotency_original");
  assert.equal(replay.previousRevisionId, INITIAL_A);

  const final = await env.snapshot(SPACE_A);
  assert.equal(final.head, "revision_after_idempotent_effect");
  assert.deepEqual(final.revisions, [
    INITIAL_A,
    "revision_idempotency_original",
    "revision_after_idempotent_effect",
  ]);
  assert.equal(final.idempotency.length, 1);
  assert.deepEqual(final.idempotency[0].result, {
    kind: "commit_changeset",
    previousRevisionId: INITIAL_A,
    revisionId: "revision_idempotency_original",
  });
  assert.match(final.idempotency[0].canonicalRequestHash, /^sha256:[0-9a-f]{64}$/u);
});

test("idempotent replay never duplicates a semantic log entry", async () => {
  const env = await fixture();
  await env.seed(SPACE_A, INITIAL_A);
  const editor = actor(
    PRINCIPALS.editor.principalId,
    "token_log_idempotent_replay",
    "request_log_idempotent_replay",
  );
  env.grant(editor, SPACE_A);
  const service = env.service(["revision_log_idempotent"]);
  const logRequest = {
    actor: editor,
    spaceId: SPACE_A,
    expectedRevisionId: INITIAL_A,
    idempotencyKey: "semantic_log_exact_replay",
    summary: "Record semantic log entry",
    operations: [
      {
        type: "add_log_entry",
        path: "log.md",
        category: "Update",
        message: "Recorded exactly once.",
      },
    ],
  };

  const original = await service.commit(logRequest);
  const replay = await service.commit(structuredClone(logRequest));
  assert.equal(original.kind, "committed");
  assert.equal(original.replayed, false);
  assert.equal(replay.kind, "committed");
  assert.equal(replay.replayed, true);
  assert.equal(replay.envelope.revision.revisionId, original.envelope.revision.revisionId);

  const materialized = await env.coordinator.materialize(
    SPACE_A,
    original.envelope.revision.revisionId,
  );
  const log = materialized.files.find((file) => file.path === "log.md").text;
  assert.equal(log.match(/Recorded exactly once\./gu)?.length, 1);
  assert.equal((await env.metadata.listRevisions(SPACE_A)).length, 2);
});

test("same namespace with a different canonical payload conflicts without effects", async () => {
  const env = await fixture();
  await env.seed(SPACE_A, INITIAL_A);
  const editor = actor(
    PRINCIPALS.editor.principalId,
    "token_idempotency_conflict",
    "request_idempotency_conflict",
  );
  env.grant(editor, SPACE_A);
  const service = env.service(["revision_idempotency_conflict_original"]);
  const original = request({
    currentActor: editor,
    spaceId: SPACE_A,
    expectedRevisionId: INITIAL_A,
    key: "payload_conflict",
    path: "concepts/original.md",
    title: "Original",
  });
  assert.equal((await service.commit(original)).kind, "committed");
  const before = await env.snapshot(SPACE_A);

  const conflict = await service.commit({
    ...original,
    summary: "Different payload",
    operations: changes("concepts/different.md", "Different"),
  });
  assert.deepEqual(conflict, { kind: "idempotency_conflict" });
  assert.deepEqual(await env.snapshot(SPACE_A), before);
});

test("the same key is isolated by principal and Space while operation stays explicit", async () => {
  const env = await fixture();
  await env.seed(SPACE_A, INITIAL_A);
  await env.seed(SPACE_B, INITIAL_B);
  const editorA = actor(
    PRINCIPALS.owner.principalId,
    "token_namespace_a",
    "request_namespace_a",
  );
  const editorB = actor(
    PRINCIPALS.editor.principalId,
    "token_namespace_b",
    "request_namespace_b",
  );
  env.grant(editorA, SPACE_A);
  env.grant(editorB, SPACE_A);
  env.grant(editorA, SPACE_B);
  const sharedKey = "shared_namespace_key";

  env.usage.select(editorA.principalId, SPACE_A);
  const first = await env.service(["revision_namespace_principal_a"]).commit(
    request({
      currentActor: editorA,
      spaceId: SPACE_A,
      expectedRevisionId: INITIAL_A,
      key: sharedKey,
      path: "concepts/principal-a.md",
      title: "Principal A",
    }),
  );
  assert.equal(first.kind, "committed");
  env.usage.select(editorB.principalId, SPACE_A);
  const second = await env.service(["revision_namespace_principal_b"]).commit(
    request({
      currentActor: editorB,
      spaceId: SPACE_A,
      expectedRevisionId: "revision_namespace_principal_a",
      key: sharedKey,
      path: "concepts/principal-b.md",
      title: "Principal B",
    }),
  );
  assert.equal(second.kind, "committed");
  env.usage.select(editorA.principalId, SPACE_B);
  const third = await env.service(["revision_namespace_space_b"]).commit(
    request({
      currentActor: editorA,
      spaceId: SPACE_B,
      expectedRevisionId: INITIAL_B,
      key: sharedKey,
      path: "concepts/space-b.md",
      title: "Space B",
    }),
  );
  assert.equal(third.kind, "committed");

  const records = await env.metadata.listIdempotencyRecordsForTest();
  assert.equal(records.length, 3);
  assert.deepEqual(
    records.map((record) => [
      record.principalId,
      record.spaceId,
      record.operation,
      record.key,
    ]),
    [
      [editorA.principalId, SPACE_A, "commit_changeset", sharedKey],
      [editorB.principalId, SPACE_A, "commit_changeset", sharedKey],
      [editorA.principalId, SPACE_B, "commit_changeset", sharedKey],
    ],
  );
});

test("the generic contract isolates operation namespaces and replays a typed export result", async () => {
  const env = await fixture();
  await env.seed(SPACE_A, INITIAL_A);
  const editor = actor(
    PRINCIPALS.editor.principalId,
    "token_operation_namespace",
    "request_operation_namespace",
  );
  env.grant(editor, SPACE_A);
  const shared = {
    principalId: editor.principalId,
    spaceId: SPACE_A,
    key: "shared_operation_key",
  };
  const exportHash = `sha256:${"a".repeat(64)}`;

  await env.metadata.runContentCommitTransaction(async (transaction) => {
    const exportNamespace = { ...shared, operation: "start_export" };
    const checked = await transaction.checkIdempotency({
      namespace: exportNamespace,
      canonicalRequestHash: exportHash,
    });
    assert.deepEqual(checked, { kind: "missing" });
    const completed = await transaction.completeIdempotency({
      namespace: exportNamespace,
      canonicalRequestHash: exportHash,
      result: {
        kind: "start_export",
        jobId: "job_contract_only",
        revisionId: INITIAL_A,
      },
      completedAt: REVISIONS.next.committedAt,
    });
    assert.equal(completed.kind, "completed");
  });

  await env.metadata.runContentCommitTransaction(async (transaction) => {
    const replay = await transaction.checkIdempotency({
      namespace: { ...shared, operation: "start_export" },
      canonicalRequestHash: exportHash,
    });
    assert.equal(replay.kind, "replay");
    assert.deepEqual(replay.record.result, {
      kind: "start_export",
      jobId: "job_contract_only",
      revisionId: INITIAL_A,
    });
    const commitNamespace = await transaction.checkIdempotency({
      namespace: { ...shared, operation: "commit_changeset" },
      canonicalRequestHash: exportHash,
    });
    assert.deepEqual(commitNamespace, { kind: "missing" });
  });

  const records = await env.metadata.listIdempotencyRecordsForTest();
  assert.equal(records.length, 1);
  assert.equal(records[0].operation, "start_export");
});

test("invalid idempotency keys are bounded by UTF-8 bytes and one-line policy", async () => {
  const env = await fixture();
  await env.seed(SPACE_A, INITIAL_A);
  const editor = actor(
    PRINCIPALS.editor.principalId,
    "token_invalid_idempotency_key",
    "request_invalid_idempotency_key",
  );
  env.grant(editor, SPACE_A);
  const service = env.service([]);
  const before = await env.snapshot(SPACE_A);
  const invalidKeys = [
    "x".repeat(DEFAULT_IDEMPOTENCY_KEY_MAX_BYTES + 1),
    `bad${String.fromCharCode(0)}key`,
    "bad\nkey",
    "bad\u2028key",
    "bad\u2029key",
  ];

  for (const [index, key] of invalidKeys.entries()) {
    const result = await service.commit(
      request({
        currentActor: editor,
        spaceId: SPACE_A,
        expectedRevisionId: INITIAL_A,
        key,
        path: `concepts/invalid-key-${index}.md`,
        title: `Invalid key ${index}`,
      }),
    );
    assert.equal(result.kind, "invalid");
    assert.equal(result.error.code, "invalid_idempotency_key");
  }

  assert.deepEqual(await env.snapshot(SPACE_A), before);
});

test("replay fails closed after current write authorization is revoked", async () => {
  const env = await fixture();
  await env.seed(SPACE_A, INITIAL_A);
  const editor = actor(
    PRINCIPALS.editor.principalId,
    "token_idempotency_revoked",
    "request_idempotency_revoked",
  );
  env.grant(editor, SPACE_A);
  const service = env.service(["revision_before_revoke"]);
  const original = request({
    currentActor: editor,
    spaceId: SPACE_A,
    expectedRevisionId: INITIAL_A,
    key: "replay_after_revoke",
    path: "concepts/private-result.md",
    title: "Private result",
  });
  assert.equal((await service.commit(original)).kind, "committed");
  const before = await env.snapshot(SPACE_A);

  env.grant(editor, SPACE_A, {
    membershipState: "revoked",
    accessVersion: version(2),
    membershipVersion: version(2),
  });
  const denied = await service.commit(original);
  assert.equal(denied.kind, "denied");
  assert.equal(denied.decision.code, "access_denied");
  assert.deepEqual(await env.snapshot(SPACE_A), before);
});

test("concurrent exact retry waits for one writer, then replays its result", async () => {
  const env = await fixture();
  await env.seed(SPACE_A, INITIAL_A);
  const editor = actor(
    PRINCIPALS.editor.principalId,
    "token_idempotency_concurrent",
    "request_idempotency_concurrent",
  );
  env.grant(editor, SPACE_A);
  let signalFirstPut;
  let releaseFirstPut;
  const firstPutStarted = new Promise((resolve) => { signalFirstPut = resolve; });
  const firstPutReleased = new Promise((resolve) => { releaseFirstPut = resolve; });
  let secondWriterPuts = 0;
  const serviceA = env.service(
    ["revision_concurrent_retry_a"],
    objectStoreWithFirstPutHook(env.objects, async () => {
      signalFirstPut();
      await firstPutReleased;
    }),
  );
  const serviceB = env.service(
    ["revision_concurrent_retry_b"],
    objectStoreWithFirstPutHook(env.objects, () => { secondWriterPuts += 1; }),
  );
  const retry = request({
    currentActor: editor,
    spaceId: SPACE_A,
    expectedRevisionId: INITIAL_A,
    key: "concurrent_exact_retry",
    path: "concepts/concurrent-idempotent.md",
    title: "Concurrent idempotent",
  });

  const firstCommit = serviceA.commit(retry);
  await firstPutStarted;
  try {
    const concurrent = await serviceB.commit(retry);
    assert.equal(concurrent.kind, "invalid");
    assert.equal(concurrent.error.code, "commit_in_progress");
    assert.equal(secondWriterPuts, 0);
  } finally {
    releaseFirstPut();
  }
  const first = await firstCommit;
  const replay = await serviceB.commit(retry);
  assert.equal(first.kind, "committed");
  assert.equal(first.replayed, false);
  assert.equal(replay.kind, "committed");
  assert.equal(replay.replayed, true);
  assert.equal(secondWriterPuts, 0);
  assert.equal(
    first.envelope.revision.revisionId,
    replay.envelope.revision.revisionId,
  );

  const final = await env.snapshot(SPACE_A);
  assert.equal(final.head, first.envelope.revision.revisionId);
  assert.equal(final.revisions.length, 2);
  assert.equal(final.idempotency.length, 1);
  assert.equal((await env.metadata.listAuditEventsForTest()).length, 1);
  assert.equal((await env.metadata.listAuditOutboxForTest()).length, 1);
  assert.equal((await env.metadata.listBackgroundJobsForTest()).length, 1);
  const unusedRevisionId =
    final.head === "revision_concurrent_retry_a"
      ? "revision_concurrent_retry_b"
      : "revision_concurrent_retry_a";
  assert.equal(await env.metadata.readRevision(SPACE_A, unusedRevisionId), null);
});
