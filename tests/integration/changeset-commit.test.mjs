import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CanonicalRevisionCoordinator,
  ChangesetCommitService,
  NoteQueueService,
  DeterministicOkfExportService,
} from "@mind-diary/application-content";
import { CapabilityAuthorizer } from "@mind-diary/application-ports";
import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  CAPABILITIES,
  MARKDOWN_MEDIA_TYPE,
  createCanonicalRevisionEnvelope,
  version,
} from "@mind-diary/domain";
import {
  CANONICAL_REVISION_FILES,
  FIXED_NOW,
  MINDS,
  OKF_FILES,
  PRINCIPALS,
  REVISION_AUTHORS,
  REVISIONS,
} from "@mind-diary/test-fixtures";
import {
  validateOkfBundle,
  validateOkfProducerBundle,
} from "@mind-diary/okf-codec";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const FUTURE = "2026-11-03T12:00:00.000Z";
const OBJECT_LIST_CUTOFF = "9999-12-31T23:59:59.999Z";

function digest(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function readZipFiles(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = [];
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    assert.equal(view.getUint16(offset + 8, true), 0);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    files.push({
      path: DECODER.decode(bytes.slice(nameStart, nameStart + nameLength)),
      bytes: bytes.slice(dataStart, dataStart + size),
    });
    offset = dataStart + size;
  }
  return files;
}

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

function authorizationQuery(currentActor) {
  return {
    principalId: currentActor.principalId,
    spaceId: MINDS.ordinary.spaceId,
    tokenId: currentActor.authentication.tokenId,
  };
}

function authorizationState(currentActor, overrides = {}) {
  const role = overrides.role ?? "editor";
  const membershipState = overrides.membershipState ?? "active";
  const accessVersion = overrides.accessVersion ?? version(1);
  const membershipVersion = overrides.membershipVersion ?? version(1);
  return {
    principal: {
      principalId: currentActor.principalId,
      state: "active",
    },
    space: {
      spaceId: MINDS.ordinary.spaceId,
      state: "active",
      visibility: "private",
      accessVersion,
    },
    membership: {
      principalId: currentActor.principalId,
      spaceId: MINDS.ordinary.spaceId,
      role,
      state: membershipState,
      version: membershipVersion,
    },
    token: {
      tokenId: currentActor.authentication.tokenId,
      principalId: currentActor.principalId,
      state: "active",
      scopes: ["content:read", "content:write"],
      version: version(1),
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

function instrumentedCanonicalObjectStore(
  objects,
  { delayMs = 0, failAtPut = null } = {},
) {
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const store = new Proxy(objects, {
    get(target, property) {
      if (property === "putSpaceCanonicalObject") {
        return async (request) => {
          calls += 1;
          active += 1;
          maximum = Math.max(maximum, active);
          try {
            if (failAtPut !== null && calls === failAtPut) {
              throw new Error("injected canonical object failure");
            }
            if (delayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
            return target.putSpaceCanonicalObject(request);
          } finally {
            active -= 1;
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return Object.freeze({
    store,
    calls: () => calls,
    maximum: () => maximum,
  });
}

function twoPartyBarrier() {
  let arrivals = 0;
  let release;
  const opened = new Promise((resolve) => {
    release = resolve;
  });
  return async () => {
    arrivals += 1;
    if (arrivals === 2) release();
    await opened;
  };
}

function newConcept(path, title) {
  return {
    type: "create_file",
    path,
    text: `---\ntype: Reference\ntitle: ${title}\n---\n\n# ${title}\n`,
  };
}

function changes(path, title) {
  return [
    newConcept(path, title),
    {
      type: "replace_index",
      path: "index.md",
      text: `---\nokf_version: "0.2"\n---\n\n# Fixture Mind\n\n- [Reproducible baseline](concepts/baseline.md)\n- [${title}](${path})\n`,
      expected_sha256: digest(
        OKF_FILES.find((file) => file.path === "index.md").text,
      ),
    },
    {
      type: "add_log_entry",
      path: "log.md",
      category: "Update",
      message: `Added [${title}](${path}).`,
    },
  ];
}

function principalMountedMetadata(metadata) {
  const mounted = new Map();
  let generation = 0;
  const key = (principalId, spaceId) => `${principalId}\0${spaceId}`;
  const select = (principalId, spaceId) => {
    const generationId = `usage_generation_commit_${++generation}`;
    mounted.set(key(principalId, spaceId),
      Object.freeze({ principalId, spaceId, generationId }));
    return generationId;
  };
  const ensure = (principalId, spaceId) => {
    const current = mounted.get(key(principalId, spaceId));
    if (current !== undefined) return current;
    select(principalId, spaceId);
    return mounted.get(key(principalId, spaceId));
  };
  const readUsage = async (principalId) => {
    const current = [...mounted.values()].filter((entry) =>
      entry.principalId === principalId);
    if (current.length === 0) return null;
    return Object.freeze({
      principalId,
      entries: Object.freeze(current.map((entry) => Object.freeze({
        principalId,
        spaceId: entry.spaceId,
        routingProfile: "description_based",
        usageMode: "read_write",
        writeGeneration: entry,
      }))),
    });
  };
  const validatePin = async (pin) => {
    const current = mounted.get(key(pin.principalId, pin.spaceId));
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
  return Object.freeze({
    store,
    select,
    ensure,
    disable: (principalId, spaceId) => mounted.delete(key(principalId, spaceId)),
  });
}

async function fixture() {
  const objects = new InMemoryObjectStore();
  const rawMetadata = new InMemoryRevisionMetadataStore();
  const usage = principalMountedMetadata(rawMetadata);
  const metadata = usage.store;
  const coordinator = new CanonicalRevisionCoordinator({
    objects,
    revisions: metadata,
  });
  const seeded = await coordinator.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: null,
    revisionId: REVISIONS.initial.revisionId,
    committedAt: REVISIONS.initial.committedAt,
    committedBy: REVISION_AUTHORS.active,
    summary: "Seed atomic changeset fixture",
    files: CANONICAL_REVISION_FILES,
  });
  assert.equal(seeded.kind, "committed");
  const authorizer = new CapabilityAuthorizer(metadata);

  const grant = (currentActor, overrides) =>
    metadata.setCurrentAuthorizationStateForTest(
      authorizationQuery(currentActor),
      authorizationState(currentActor, overrides),
    );
  const service = ({
    currentActor,
    nextRevisionId,
    objectStore = objects,
    committedAt = REVISIONS.next.committedAt,
    capacityLimits,
  }) => {
    grant(currentActor);
    usage.ensure(currentActor.principalId, MINDS.ordinary.spaceId);
    return new ChangesetCommitService({
      authorizer,
      metadata,
      revisions: coordinator,
      objects: objectStore,
      clock: { now: () => committedAt },
      revisionIds: revisionIds(nextRevisionId),
      ...(capacityLimits === undefined ? {} : { capacityLimits }),
    });
  };
  const snapshot = async () => {
    const head = await coordinator.readHeadRevision(MINDS.ordinary.spaceId);
    const allObjects = await objects.listImmutableObjects({
      createdBefore: OBJECT_LIST_CUTOFF,
      excludedDigests: [],
      limit: 1_000,
    });
    const spaceObjects = await objects.listSpaceCanonicalObjects({
      createdBefore: OBJECT_LIST_CUTOFF,
      excluded: [],
      limit: 1_000,
    });
    const spaceReachable = await metadata.listReachableSpaceCanonicalObjects();
    return {
      head: head?.envelope.revision.revisionId ?? null,
      revisions: (await metadata.listRevisions(MINDS.ordinary.spaceId)).map(
        (revision) => revision.revision.revisionId,
      ),
      reachable: await metadata.listReachableObjectDigests(),
      objects: allObjects.map((object) => object.sha256),
      spaceObjects: spaceObjects.map((object) => [
        object.kind,
        object.spaceId,
        object.sha256,
      ]),
      spaceReachable: spaceReachable.map((object) => [
        object.kind,
        object.spaceId,
        object.sha256,
      ]),
      files:
        head?.files.map((file) => [file.path, file.text]) ?? [],
    };
  };
  return { objects, metadata, coordinator, grant, service, snapshot, usage };
}

test("changeset preflight is deterministic and leaves commit state untouched", async () => {
  const env = await fixture();
  const editor = actor(
    PRINCIPALS.editor.principalId,
    "token_preflight",
    "request_preflight",
  );
  const service = env.service({
    currentActor: editor,
    nextRevisionId: "revision_after_preflight",
  });
  const before = await env.snapshot();
  const request = {
    actor: editor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    producerProfile: true,
    operations: changes("concepts/preflight.md", "Preflight"),
  };
  const first = await service.preflight(request);
  const second = await service.preflight(request);
  assert.equal(first.kind, "ready");
  assert.equal(second.kind, "ready");
  assert.equal(first.baseRevisionId, REVISIONS.initial.revisionId);
  assert.match(first.changesetIdentity, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(second.changesetIdentity, first.changesetIdentity);
  assert.equal(first.validation.valid, true);
  assert.equal(first.validation.qualityWarnings.length, 0);
  assert.deepEqual(await env.snapshot(), before);

  const committed = await service.commit({
    ...request,
    idempotencyKey: "commit-after-preflight",
    summary: "Commit the exact preflighted changeset",
  });
  assert.equal(committed.kind, "committed");
  assert.equal(committed.envelope.revision.revisionId, "revision_after_preflight");
  const afterCommit = await env.snapshot();
  const stale = await service.preflight(request);
  assert.equal(stale.kind, "revision_conflict");
  assert.equal(stale.currentRevisionId, "revision_after_preflight");
  assert.deepEqual(await env.snapshot(), afterCommit);
});

test("queued note is durable before background commit and exact retry is deduplicated", async () => {
  const env = await fixture();
  const editor = actor(PRINCIPALS.editor.principalId, "token_note", "request_note");
  const commits = env.service({ currentActor: editor, nextRevisionId: "revision_note" });
  const scheduled = [];
  const notes = new NoteQueueService({ metadata: env.metadata, objects: env.objects,
    authorizer: new CapabilityAuthorizer(env.metadata), clock: { now: () => FIXED_NOW }, commits,
    schedule: (id) => scheduled.push(id) });
  const input = { idempotencyKey: "synthetic-1", title: "Synthetic note", text: "Paper lighthouse is blue. Fictional test." };
  const accepted = await notes.enqueue(editor, MINDS.ordinary.spaceId, input);
  assert.equal(accepted.state, "queued");
  assert.equal((await env.snapshot()).head, REVISIONS.initial.revisionId);
  const snapshot = env.metadata.exportDurableSnapshot();
  assert.equal(snapshot.queuedNotes.size, 1);
  assert.equal(InMemoryRevisionMetadataStore.fromDurableSnapshot(snapshot).exportDurableSnapshot().queuedNotes.size, 1);
  assert.deepEqual(await notes.enqueue(editor, MINDS.ordinary.spaceId, input), accepted);
  await assert.rejects(notes.enqueue(editor, MINDS.ordinary.spaceId, { ...input, text: "changed" }), /idempotency_conflict/);
  await notes.process(scheduled[0]);
  const receipt = await notes.status(editor, MINDS.ordinary.spaceId, accepted.receiptId);
  assert.equal(receipt.state, "committed", JSON.stringify(receipt));
  assert.equal(receipt.revisionId, "revision_note");
  assert.ok((await env.snapshot()).files.some(([path, text]) => path === receipt.path && text.includes(input.text)));
  await notes.process(scheduled[0]);
  assert.equal((await env.snapshot()).revisions.length, 2);
});

test("queued note does not survive a writable generation change as write authority", async () => {
  const env = await fixture();
  const editor = actor(PRINCIPALS.editor.principalId, "token_note_revoke", "request_note_revoke");
  const commits = env.service({ currentActor: editor, nextRevisionId: "revision_note_revoke" });
  const notes = new NoteQueueService({ metadata: env.metadata, objects: env.objects,
    authorizer: new CapabilityAuthorizer(env.metadata), clock: { now: () => FIXED_NOW }, commits, schedule: () => {} });
  const accepted = await notes.enqueue(editor, MINDS.ordinary.spaceId, { idempotencyKey: "revoke", title: "Synthetic", text: "Fictional." });
  env.usage.select(editor.principalId, MINDS.ordinary.spaceId);
  await notes.process(accepted.receiptId);
  const receipt = await notes.status(editor, MINDS.ordinary.spaceId, accepted.receiptId);
  assert.equal(receipt.state, "failed");
  assert.equal(receipt.failureCode, "writable_mind_stale");
  assert.equal((await env.snapshot()).head, REVISIONS.initial.revisionId);
  const record = env.metadata.exportDurableSnapshot().queuedNotes.get(accepted.receiptId);
  assert.equal(await env.metadata.isSpaceCanonicalObjectReachable("markdown", record.spaceId, record.payloadHash), true);
});

test("queued note reconciles a lost successful response without a second revision", async () => {
  const env = await fixture();
  const editor = actor(PRINCIPALS.editor.principalId, "token_note_unknown", "request_note_unknown");
  const real = env.service({ currentActor: editor, nextRevisionId: "revision_note_unknown" });
  let writes = 0;
  const notes = new NoteQueueService({ metadata: env.metadata, objects: env.objects,
    authorizer: new CapabilityAuthorizer(env.metadata), clock: { now: () => FIXED_NOW }, schedule: () => {},
    commits: { reconcile: (request) => real.reconcile(request), commit: async (request) => {
      const result = await real.commit(request); writes += 1;
      assert.equal(result.kind, "committed");
      throw new Error("simulated lost transport response");
    } } });
  const accepted = await notes.enqueue(editor, MINDS.ordinary.spaceId, { idempotencyKey: "unknown", title: "Synthetic", text: "Fictional." });
  await notes.process(accepted.receiptId);
  assert.equal((await notes.status(editor, MINDS.ordinary.spaceId, accepted.receiptId)).state, "committed");
  assert.equal(writes, 1);
  assert.equal((await env.snapshot()).revisions.length, 2);
});

test("two queued notes accepted at one HEAD both commit additively", async () => {
  const env = await fixture();
  const editor = actor(PRINCIPALS.editor.principalId, "token_note_race", "request_note_race");
  let revision = 0;
  const real = env.service({ currentActor: editor, nextRevisionId: "unused" });
  const commits = { reconcile: (request) => real.reconcile(request), commit: (request) =>
    env.service({ currentActor: editor, nextRevisionId: `revision_note_race_${++revision}` }).commit(request) };
  const notes = new NoteQueueService({ metadata: env.metadata, objects: env.objects,
    authorizer: new CapabilityAuthorizer(env.metadata), clock: { now: () => FIXED_NOW }, schedule: () => {}, commits });
  const first = await notes.enqueue(editor, MINDS.ordinary.spaceId, { idempotencyKey: "one", title: "One", text: "Fictional one." });
  const second = await notes.enqueue(editor, MINDS.ordinary.spaceId, { idempotencyKey: "two", title: "Two", text: "Fictional two." });
  await notes.process(first.receiptId);
  await notes.process(second.receiptId);
  assert.equal((await notes.status(editor, MINDS.ordinary.spaceId, first.receiptId)).state, "committed");
  assert.equal((await notes.status(editor, MINDS.ordinary.spaceId, second.receiptId)).state, "committed");
  assert.equal((await env.snapshot()).revisions.length, 3);
});

test("commit capacity rejection happens before canonical object writes", async () => {
  const env = await fixture();
  const editor = actor(
    PRINCIPALS.editor.principalId,
    "token_capacity_commit",
    "request_capacity_commit",
  );
  const service = env.service({
    currentActor: editor,
    nextRevisionId: "revision_capacity_rejected",
    capacityLimits: {
      mindPhysicalCanonicalBytes: 1,
      principalPhysicalCanonicalBytes: 1,
      sitePhysicalCanonicalBytes: 1,
      siteTemporaryBytes: 8_589_934_592,
      siteD1MetadataBytes: 536_870_912,
      ordinaryCommitSoftGrowthBytes: 4_194_304,
      activeHeavyPerMind: 1,
      activeHeavyPerPrincipal: 2,
      activeHeavyPerSite: 8,
    },
  });
  const before = await env.snapshot();
  const result = await service.commit({
    actor: editor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "capacity-commit-reject",
    summary: "capacity reject",
    operations: changes("concepts/capacity-reject.md", "Capacity reject"),
  });
  assert.equal(result.kind, "invalid");
  assert.equal(result.error.code, "capacity_hard_limit");
  assert.deepEqual(await env.snapshot(), before);
});

test("success writes immutable candidate objects and performs one revision/HEAD transition", async () => {
  const env = await fixture();
  const editor = actor(
    PRINCIPALS.editor.principalId,
    "token_commit_success",
    "request_commit_success",
  );
  const service = env.service({
    currentActor: editor,
    nextRevisionId: REVISIONS.next.revisionId,
  });

  const result = await service.commit({
    actor: editor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "commit_success",
    summary: "Add atomic concept",
    operations: changes("concepts/atomic.md", "Atomic commit"),
  });

  assert.equal(result.kind, "committed");
  assert.equal(result.previousRevisionId, REVISIONS.initial.revisionId);
  assert.equal(result.envelope.revision.revisionNumber, 2);
  const after = await env.snapshot();
  assert.equal(after.head, REVISIONS.next.revisionId);
  assert.deepEqual(after.revisions, [
    REVISIONS.initial.revisionId,
    REVISIONS.next.revisionId,
  ]);
  assert.equal(after.files.some(([path]) => path === "concepts/atomic.md"), true);
  assert.match(after.files.find(([path]) => path === "index.md")[1], /Atomic commit/u);
  assert.match(
    after.files.find(([path]) => path === "log.md")[1],
    /- \*\*Update\*\*: Added \[Atomic commit\]\(concepts\/atomic\.md\)\.\n- \*\*Create\*\*:/u,
  );
  assert.equal(after.objects.every((digest) => after.reachable.includes(digest)), true);
  const historical = await env.coordinator.materialize(
    MINDS.ordinary.spaceId,
    REVISIONS.initial.revisionId,
  );
  assert.equal(
    historical.files.some((file) => file.path === "concepts/atomic.md"),
    false,
  );
});

test("large changesets materialize Markdown objects with bounded deterministic concurrency", async () => {
  const env = await fixture();
  const editor = actor(
    PRINCIPALS.editor.principalId,
    "token_bounded_commit",
    "request_bounded_commit",
  );
  const instrumented = instrumentedCanonicalObjectStore(env.objects, { delayMs: 2 });
  const service = env.service({
    currentActor: editor,
    nextRevisionId: "revision_bounded_commit",
    objectStore: instrumented.store,
  });
  const operations = Array.from({ length: 80 }, (_, index) =>
    newConcept(
      `concepts/bounded-${String(index).padStart(3, "0")}.md`,
      `Bounded ${index}`,
    )
  );

  const result = await service.commit({
    actor: editor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "commit-bounded-large",
    summary: "Bounded large changeset",
    operations,
  });

  assert.equal(result.kind, "committed");
  assert.ok(instrumented.maximum() > 1);
  assert.ok(instrumented.maximum() <= 8);
  assert.ok(instrumented.calls() >= operations.length);
  const paths = result.envelope.manifest.entries.map((entry) => entry.path);
  assert.deepEqual(paths, [...paths].sort());
  const after = await env.snapshot();
  assert.equal(after.head, "revision_bounded_commit");
  assert.equal(after.revisions.length, 2);
});

test("object materialization failure leaves large changesets without revision, HEAD, or idempotency completion", async () => {
  const env = await fixture();
  const editor = actor(
    PRINCIPALS.editor.principalId,
    "token_bounded_commit_failure",
    "request_bounded_commit_failure",
  );
  const instrumented = instrumentedCanonicalObjectStore(env.objects, {
    delayMs: 1,
    failAtPut: 17,
  });
  const service = env.service({
    currentActor: editor,
    nextRevisionId: "revision_bounded_commit_failure",
    objectStore: instrumented.store,
  });
  const operations = Array.from({ length: 80 }, (_, index) =>
    newConcept(
      `concepts/failure-${String(index).padStart(3, "0")}.md`,
      `Failure ${index}`,
    )
  );
  const before = await env.snapshot();

  await assert.rejects(
    service.commit({
      actor: editor,
      spaceId: MINDS.ordinary.spaceId,
      expectedRevisionId: REVISIONS.initial.revisionId,
      idempotencyKey: "commit-bounded-large-failure",
      summary: "Bounded large changeset failure",
      operations,
    }),
    /injected canonical object failure/u,
  );

  const after = await env.snapshot();
  assert.equal(after.head, before.head);
  assert.deepEqual(after.revisions, before.revisions);
  assert.equal(
    (await env.metadata.listIdempotencyRecordsForTest()).length,
    0,
  );
  assert.equal(
    (await env.metadata.listAuditEventsForTest()).some(
      ({ eventType }) => eventType === "content.changeset_committed",
    ),
    false,
  );
});

test("MCP producer proposal fails closed on warnings and round-trips a valid immutable revision through export", async () => {
  const env = await fixture();
  const editor = actor(
    PRINCIPALS.editor.principalId,
    "token_producer_round_trip",
    "request_producer_round_trip",
  );
  const service = env.service({
    currentActor: editor,
    nextRevisionId: "revision_producer_round_trip",
  });
  const before = await env.snapshot();
  const warningOperations = [{
    type: "create_file",
    path: "concepts/generated-warning.md",
    text: "---\ntype: Generated Knowledge\nstatus: reviewed\n---\n\n# Warning\n",
  }];
  const warningPreflight = await service.preflight({
    actor: editor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    producerProfile: true,
    operations: warningOperations,
  });
  const warningBearing = await service.commit({
    actor: editor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "producer-warning-rejected",
    summary: "Reject warning-bearing generated knowledge",
    producerProfile: true,
    operations: warningOperations,
  });
  assert.equal(warningPreflight.kind, "invalid");
  assert.equal(warningBearing.kind, "invalid");
  assert.equal(warningBearing.error.code, "okf_validation_failed");
  assert.equal(warningPreflight.error.code, warningBearing.error.code);
  assert.deepEqual(
    warningBearing.error.diagnostics.map((issue) => issue.code),
    ["invalid_lifecycle_status"],
  );
  assert.deepEqual(
    warningPreflight.error.diagnostics,
    warningBearing.error.diagnostics,
  );
  assert.deepEqual(await env.snapshot(), before);

  const path = "concepts/generated-durable.md";
  const title = "Generated durable knowledge";
  const text = `---
type: Generated Knowledge
title: ${title}
generated: { by: mind-diary/0.3, at: 2026-08-30T21:00:00Z }
---

# ${title}
`;
  assert.equal(
    validateOkfProducerBundle([{ path, text }]).producerValid,
    true,
  );
  const operations = changes(path, title);
  operations[0] = { type: "create_file", path, text };
  const committed = await service.commit({
    actor: editor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "producer-valid-round-trip",
    summary: "Commit validated generated knowledge",
    producerProfile: true,
    operations,
  });
  assert.equal(committed.kind, "committed");
  assert.equal(
    committed.envelope.revision.revisionId,
    "revision_producer_round_trip",
  );

  const exported = await new DeterministicOkfExportService({
    materializer: env.coordinator,
    digest: env.objects,
  }).exportExactRevision({
    spaceId: MINDS.ordinary.spaceId,
    revisionId: committed.envelope.revision.revisionId,
  });
  const archiveFiles = readZipFiles(exported.bytes);
  const exportedValidation = validateOkfProducerBundle(archiveFiles);
  assert.equal(exportedValidation.producerValid, true);
  assert.equal(
    DECODER.decode(archiveFiles.find((file) => file.path === path).bytes),
    text,
  );
  const historical = await env.coordinator.materialize(
    MINDS.ordinary.spaceId,
    REVISIONS.initial.revisionId,
  );
  assert.equal(historical.files.some((file) => file.path === path), false);
});

test("producer policy rollout preserves old idempotent replays without permitting a new warning-bearing commit", async () => {
  const env = await fixture();
  const editor = actor(
    PRINCIPALS.editor.principalId,
    "token_producer_rollout",
    "request_producer_rollout",
  );
  const service = env.service({
    currentActor: editor,
    nextRevisionId: "revision_before_producer_policy",
  });
  const oldPayload = {
    actor: editor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "pre-policy-warning",
    summary: "Historical warning-bearing commit",
    operations: [{
      type: "create_file",
      path: "concepts/pre-policy-warning.md",
      text: "---\ntype: Generated Knowledge\nstatus: reviewed\n---\n\n# Historical warning\n",
    }],
  };
  const historicalCommit = await service.commit(oldPayload);
  assert.equal(historicalCommit.kind, "committed");
  const afterHistorical = await env.snapshot();

  const replay = await service.commit({ ...oldPayload, producerProfile: true });
  assert.equal(replay.kind, "committed");
  assert.equal(replay.replayed, true);
  assert.equal(
    replay.envelope.revision.revisionId,
    historicalCommit.envelope.revision.revisionId,
  );
  assert.deepEqual(await env.snapshot(), afterHistorical);

  const rejected = await service.commit({
    ...oldPayload,
    expectedRevisionId: historicalCommit.envelope.revision.revisionId,
    idempotencyKey: "post-policy-warning",
    producerProfile: true,
    operations: [{
      ...oldPayload.operations[0],
      path: "concepts/post-policy-warning.md",
    }],
  });
  assert.equal(rejected.kind, "invalid");
  assert.equal(rejected.error.code, "okf_validation_failed");
  assert.deepEqual(await env.snapshot(), afterHistorical);
});

test("metadata transaction rolls back a staged revision/HEAD when its callback fails", async () => {
  const env = await fixture();
  const before = await env.snapshot();
  const parent = await env.metadata.readRevision(
    MINDS.ordinary.spaceId,
    REVISIONS.initial.revisionId,
  );
  assert.ok(parent);
  const stagedEnvelope = createCanonicalRevisionEnvelope({
    revisionId: "revision_rolled_back",
    spaceId: MINDS.ordinary.spaceId,
    revisionNumber: 2,
    parentRevisionId: REVISIONS.initial.revisionId,
    committedAt: REVISIONS.next.committedAt,
    committedBy: REVISION_AUTHORS.active,
    manifest: parent.manifest,
    manifestHash: parent.revision.manifestHash,
    summary: "Must roll back",
  });

  await assert.rejects(
    env.metadata.runContentCommitTransaction(async (transaction) => {
      const staged = await transaction.commitRevision({
        expectedHeadRevisionId: REVISIONS.initial.revisionId,
        envelope: stagedEnvelope,
      });
      assert.equal(staged.kind, "committed");
      assert.equal(
        await transaction.readHead(MINDS.ordinary.spaceId),
        "revision_rolled_back",
      );
      throw new Error("injected failure after staged revision");
    }),
    /injected failure after staged revision/u,
  );

  assert.deepEqual(await env.snapshot(), before);
  assert.equal(
    await env.metadata.readRevision(
      MINDS.ordinary.spaceId,
      "revision_rolled_back",
    ),
    null,
  );
});

test("semantic log-only commit materializes one valid server-dated entry", async () => {
  const env = await fixture();
  const editor = actor(
    PRINCIPALS.editor.principalId,
    "token_commit_log_deferred",
    "request_commit_log_deferred",
  );
  const service = env.service({
    currentActor: editor,
    nextRevisionId: "revision_log_materialized",
  });
  const before = await env.snapshot();

  const result = await service.commit({
    actor: editor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "commit_log_materialized",
    summary: "Materialize log operation",
    operations: [
      {
        type: "add_log_entry",
        path: "log.md",
        category: "Update",
        message: "Recorded a semantic update.",
      },
    ],
  });

  assert.equal(result.kind, "committed");
  const after = await env.snapshot();
  assert.equal(after.head, "revision_log_materialized");
  assert.equal(after.revisions.length, before.revisions.length + 1);
  assert.match(
    after.files.find(([path]) => path === "log.md")[1],
    /## 2026-08-06\n\n- \*\*Update\*\*: Recorded a semantic update\.\n- \*\*Create\*\*:/u,
  );
  assert.deepEqual(
    after.files.filter(([path]) => path !== "log.md"),
    before.files.filter(([path]) => path !== "log.md"),
  );
});

test("repeated semantic commits preserve valid newest-first date groups and entry order", async () => {
  const env = await fixture();
  const editor = actor(
    PRINCIPALS.editor.principalId,
    "token_repeated_log",
    "request_repeated_log",
  );
  const commitLog = async ({ expectedRevisionId, revisionId, committedAt, key, message }) =>
    env.service({
      currentActor: editor,
      nextRevisionId: revisionId,
      committedAt,
    }).commit({
      actor: editor,
      spaceId: MINDS.ordinary.spaceId,
      expectedRevisionId,
      idempotencyKey: key,
      summary: message,
      operations: [
        {
          type: "add_log_entry",
          path: "log.md",
          category: "Update",
          message,
        },
      ],
    });

  const first = await commitLog({
    expectedRevisionId: REVISIONS.initial.revisionId,
    revisionId: "revision_log_day_one_first",
    committedAt: "2026-08-07T00:00:00.000Z",
    key: "log_day_one_first",
    message: "First entry on day one.",
  });
  assert.equal(first.kind, "committed");
  const second = await commitLog({
    expectedRevisionId: first.envelope.revision.revisionId,
    revisionId: "revision_log_day_one_second",
    committedAt: "2026-08-07T23:59:59.000Z",
    key: "log_day_one_second",
    message: "Second entry on day one.",
  });
  assert.equal(second.kind, "committed");
  const third = await commitLog({
    expectedRevisionId: second.envelope.revision.revisionId,
    revisionId: "revision_log_day_two",
    committedAt: "2026-08-08T00:00:00.000Z",
    key: "log_day_two",
    message: "Entry on day two.",
  });
  assert.equal(third.kind, "committed");

  const head = await env.coordinator.readHeadRevision(MINDS.ordinary.spaceId);
  const validation = validateOkfBundle(
    head.files.map((file) => ({ path: file.path, text: file.text })),
  );
  assert.equal(validation.valid, true);
  const log = head.files.find((file) => file.path === "log.md").text;
  assert.match(
    log,
    /## 2026-08-08\n\n- \*\*Update\*\*: Entry on day two\.\n\n## 2026-08-07\n\n- \*\*Update\*\*: Second entry on day one\.\n- \*\*Update\*\*: First entry on day one\.\n\n## 2026-08-06/u,
  );
});

test("denied preflight and transaction-time revocation leave HEAD/revisions unchanged", async () => {
  const env = await fixture();
  const deniedActor = actor(
    PRINCIPALS.editor.principalId,
    "token_commit_denied",
    "request_commit_denied",
  );
  const deniedService = env.service({
    currentActor: deniedActor,
    nextRevisionId: "revision_denied",
  });
  env.grant(deniedActor, { role: "reader" });
  const before = await env.snapshot();
  const denied = await deniedService.commit({
    actor: deniedActor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "commit_denied",
    summary: "Must be denied",
    operations: changes("concepts/denied.md", "Denied"),
  });
  assert.equal(denied.kind, "denied");
  assert.equal(denied.decision.code, "capability_denied");
  assert.deepEqual(await env.snapshot(), before);

  const racingActor = actor(
    PRINCIPALS.editor.principalId,
    "token_commit_recheck",
    "request_commit_recheck",
  );
  env.grant(racingActor);
  const objectStore = objectStoreWithFirstPutHook(env.objects, async () => {
    env.grant(racingActor, {
      membershipState: "revoked",
      accessVersion: version(2),
      membershipVersion: version(2),
    });
  });
  const racingService = env.service({
    currentActor: racingActor,
    nextRevisionId: "revision_recheck_denied",
    objectStore,
  });
  const rechecked = await racingService.commit({
    actor: racingActor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "commit_recheck",
    summary: "Lose authorization race",
    operations: changes("concepts/recheck.md", "Recheck"),
  });
  assert.equal(rechecked.kind, "denied");
  assert.equal(rechecked.decision.code, "access_denied");
  const afterRecheck = await env.snapshot();
  assert.equal(afterRecheck.head, before.head);
  assert.deepEqual(afterRecheck.revisions, before.revisions);
  assert.deepEqual(afterRecheck.reachable, before.reachable);
  assert.equal(afterRecheck.files.some(([path]) => path === "concepts/recheck.md"), false);
});

test("stale expected revision reports current HEAD and changes no final state", async () => {
  const env = await fixture();
  const advanced = await env.coordinator.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    revisionId: "revision_advanced",
    committedAt: REVISIONS.next.committedAt,
    committedBy: REVISION_AUTHORS.active,
    summary: "Advance before stale attempt",
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
  const editor = actor(
    PRINCIPALS.editor.principalId,
    "token_commit_stale",
    "request_commit_stale",
  );
  const service = env.service({
    currentActor: editor,
    nextRevisionId: "revision_stale_attempt",
  });
  const before = await env.snapshot();

  const result = await service.commit({
    actor: editor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "commit_stale",
    summary: "Stale attempt",
    operations: changes("concepts/stale.md", "Stale"),
  });

  assert.deepEqual(result, {
    kind: "revision_conflict",
    currentRevisionId: "revision_advanced",
  });
  assert.deepEqual(await env.snapshot(), before);
});

test("metadata transaction failure leaves written objects unreachable and final state intact", async () => {
  const env = await fixture();
  const editor = actor(
    PRINCIPALS.editor.principalId,
    "token_commit_failure",
    "request_commit_failure",
  );
  const service = env.service({
    currentActor: editor,
    nextRevisionId: "revision_transaction_failure",
  });
  const before = await env.snapshot();
  env.metadata.failNextCommitForTest();

  await assert.rejects(
    service.commit({
      actor: editor,
      spaceId: MINDS.ordinary.spaceId,
      expectedRevisionId: REVISIONS.initial.revisionId,
      idempotencyKey: "commit_failure",
      summary: "Injected failure",
      operations: changes("concepts/failure.md", "Failure"),
    }),
    /injected revision metadata transaction failure/u,
  );

  const after = await env.snapshot();
  assert.equal(after.head, before.head);
  assert.deepEqual(after.revisions, before.revisions);
  assert.deepEqual(after.reachable, before.reachable);
  assert.equal(
    (await env.metadata.listIdempotencyRecordsForTest()).length,
    0,
  );
  assert.ok(after.spaceObjects.length > before.spaceObjects.length);
  assert.equal(after.files.some(([path]) => path === "concepts/failure.md"), false);
  const [capacity] = await env.metadata.listCapacityReservationsForTest();
  assert.equal(capacity.state, "cleanup_pending");
});

test("two Editors racing from one HEAD get one winner and one explicit conflict without hidden merge", async () => {
  const env = await fixture();
  const editorA = actor(
    PRINCIPALS.owner.principalId,
    "token_race_a",
    "request_race_a",
  );
  const editorB = actor(
    PRINCIPALS.editor.principalId,
    "token_race_b",
    "request_race_b",
  );
  const barrier = twoPartyBarrier();
  const serviceA = env.service({
    currentActor: editorA,
    nextRevisionId: "revision_race_a",
    objectStore: objectStoreWithFirstPutHook(env.objects, barrier),
  });
  const serviceB = env.service({
    currentActor: editorB,
    nextRevisionId: "revision_race_b",
    objectStore: objectStoreWithFirstPutHook(env.objects, barrier),
  });

  const [resultA, resultB] = await Promise.all([
    serviceA.commit({
      actor: editorA,
      spaceId: MINDS.ordinary.spaceId,
      expectedRevisionId: REVISIONS.initial.revisionId,
      idempotencyKey: "commit_race_a",
      summary: "Race A",
      operations: changes("concepts/race-a.md", "Race A"),
    }),
    serviceB.commit({
      actor: editorB,
      spaceId: MINDS.ordinary.spaceId,
      expectedRevisionId: REVISIONS.initial.revisionId,
      idempotencyKey: "commit_race_b",
      summary: "Race B",
      operations: changes("concepts/race-b.md", "Race B"),
    }),
  ]);
  const winner = [resultA, resultB].find((result) => result.kind === "committed");
  const loser = [resultA, resultB].find(
    (result) => result.kind === "revision_conflict",
  );
  assert.ok(winner);
  assert.ok(loser);
  assert.equal(loser.currentRevisionId, winner.envelope.revision.revisionId);

  const after = await env.snapshot();
  assert.equal(after.head, winner.envelope.revision.revisionId);
  assert.equal(after.revisions.length, 2);
  const hasA = after.files.some(([path]) => path === "concepts/race-a.md");
  const hasB = after.files.some(([path]) => path === "concepts/race-b.md");
  assert.notEqual(hasA, hasB);
  const losingRevisionId =
    winner.envelope.revision.revisionId === "revision_race_a"
      ? "revision_race_b"
      : "revision_race_a";
  assert.equal(
    await env.metadata.readRevision(MINDS.ordinary.spaceId, losingRevisionId),
    null,
  );
  const reachableSpaceKeys = new Set(after.spaceReachable.map((item) => item.join("\0")));
  assert.equal(
    after.spaceObjects.some((item) => !reachableSpaceKeys.has(item.join("\0"))),
    true,
  );
  assert.deepEqual(
    after.spaceReachable,
    [
      ...winner.envelope.manifest.entries
        .filter((entry) => entry.kind === "markdown")
        .map((entry) => ["markdown", MINDS.ordinary.spaceId, entry.sha256]),
      [
        "revision_manifest",
        MINDS.ordinary.spaceId,
        winner.envelope.revision.manifestHash,
      ],
    ].sort((left, right) => left.join("\0").localeCompare(right.join("\0"))),
  );
});

test("only a change to the exact writable Mind fences a prepared commit", async () => {
  const env = await fixture();
  const editor = actor(
    PRINCIPALS.editor.principalId,
    "token_usage_commit_race",
    "request_usage_commit_race",
  );
  env.grant(editor);
  const otherSpaceId = "space_usage_commit_other";
  const baseAuthorizer = new CapabilityAuthorizer(env.metadata);
  const initialGeneration = env.usage.select(
    editor.principalId,
    MINDS.ordinary.spaceId,
  );
  const racedObjects = objectStoreWithFirstPutHook(env.objects, async () => {
    env.usage.select(editor.principalId, otherSpaceId);
    const replacement = env.usage.select(editor.principalId, MINDS.ordinary.spaceId);
    assert.notEqual(replacement, initialGeneration);
  });
  const raced = new ChangesetCommitService({
    authorizer: baseAuthorizer,
    metadata: env.metadata,
    revisions: env.coordinator,
    objects: racedObjects,
    clock: { now: () => REVISIONS.next.committedAt },
    revisionIds: revisionIds("revision_binding_race_must_not_commit"),
  });
  const denied = await raced.commit({
    actor: editor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "commit-with-stale-usage-generation",
    summary: "Must be fenced by concurrent writable Mind switch",
    operations: changes("concepts/usage-race.md", "Usage race"),
  });
  assert.equal(denied.kind, "denied");
  assert.equal(denied.decision.code, "writable_mind_stale");

  const afterDenied = await env.snapshot();
  assert.equal(afterDenied.head, REVISIONS.initial.revisionId);
  assert.equal(
    (await env.metadata.listAuditEventsForTest()).some(
      ({ eventType }) => eventType === "content.changeset_committed",
    ),
    false,
  );
  assert.equal(
    (await env.metadata.listBackgroundJobsForTest()).some(
      ({ target }) => target.kind === "revision_index",
    ),
    false,
  );

  const currentGeneration = env.usage.select(
    editor.principalId,
    MINDS.ordinary.spaceId,
  );
  assert.notEqual(currentGeneration, initialGeneration);
  const current = new ChangesetCommitService({
    authorizer: baseAuthorizer,
    metadata: env.metadata,
    revisions: env.coordinator,
    objects: env.objects,
    clock: { now: () => REVISIONS.next.committedAt },
    revisionIds: revisionIds("revision_binding_race_fresh_commit"),
  });
  const committed = await current.commit({
    actor: editor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "commit-with-current-usage-generation",
    summary: "Commit with current writable Mind",
    operations: changes("concepts/usage-current.md", "Usage current"),
  });
  assert.equal(committed.kind, "committed");
  assert.equal(
    (await env.metadata.listAuditEventsForTest()).filter(
      ({ eventType }) => eventType === "content.changeset_committed",
    ).length,
    1,
  );
  assert.equal(
    (await env.metadata.listBackgroundJobsForTest()).filter(
      ({ target }) => target.kind === "revision_index",
    ).length,
    1,
  );
  env.usage.select(editor.principalId, otherSpaceId);
  const unaffectedReplay = await current.commit({
    actor: editor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "commit-with-current-usage-generation",
    summary: "Commit with current writable Mind",
    operations: changes("concepts/usage-current.md", "Usage current"),
  });
  assert.equal(unaffectedReplay.kind, "committed");
  assert.equal(unaffectedReplay.replayed, true);
  env.usage.disable(editor.principalId, MINDS.ordinary.spaceId);
  const disabledReplay = await current.commit({
    actor: editor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "commit-with-current-usage-generation",
    summary: "Commit with current writable Mind",
    operations: changes("concepts/usage-current.md", "Usage current"),
  });
  assert.equal(disabledReplay.kind, "denied");
  assert.equal(disabledReplay.decision.code, "writable_mind_required");
  assert.equal((await env.snapshot()).revisions.length, 2);
});
