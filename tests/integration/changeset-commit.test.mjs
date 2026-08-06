import assert from "node:assert/strict";
import test from "node:test";
import {
  CanonicalRevisionCoordinator,
  ChangesetCommitService,
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

const ENCODER = new TextEncoder();
const FUTURE = "2026-11-03T12:00:00.000Z";
const OBJECT_LIST_CUTOFF = "9999-12-31T23:59:59.999Z";

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
  return {
    kind: "object-store",
    calculateSha256: (bytes) => objects.calculateSha256(bytes),
    async putImmutable(request) {
      if (!invoked) {
        invoked = true;
        await hook();
      }
      return objects.putImmutable(request);
    },
    getImmutable: (digest) => objects.getImmutable(digest),
    listImmutableObjects: (request) => objects.listImmutableObjects(request),
    deleteImmutableObject: (request) => objects.deleteImmutableObject(request),
  };
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
    },
  ];
}

async function fixture() {
  const objects = new InMemoryObjectStore();
  const metadata = new InMemoryRevisionMetadataStore();
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
  }) => {
    grant(currentActor);
    return new ChangesetCommitService({
      authorizer,
      metadata,
      revisions: coordinator,
      objects: objectStore,
      clock: { now: () => REVISIONS.next.committedAt },
      revisionIds: revisionIds(nextRevisionId),
    });
  };
  const snapshot = async () => {
    const head = await coordinator.readHeadRevision(MINDS.ordinary.spaceId);
    const allObjects = await objects.listImmutableObjects({
      createdBefore: OBJECT_LIST_CUTOFF,
      excludedDigests: [],
      limit: 1_000,
    });
    return {
      head: head?.envelope.revision.revisionId ?? null,
      revisions: (await metadata.listRevisions(MINDS.ordinary.spaceId)).map(
        (revision) => revision.revision.revisionId,
      ),
      reachable: await metadata.listReachableObjectDigests(),
      objects: allObjects.map((object) => object.sha256),
      files:
        head?.files.map((file) => [file.path, file.text]) ?? [],
    };
  };
  return { objects, metadata, coordinator, grant, service, snapshot };
}

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
  assert.equal(
    after.files.find(([path]) => path === "log.md")[1],
    OKF_FILES.find((file) => file.path === "log.md").text,
  );
  assert.deepEqual(after.reachable, [...after.objects].sort());
  const historical = await env.coordinator.materialize(
    MINDS.ordinary.spaceId,
    REVISIONS.initial.revisionId,
  );
  assert.equal(
    historical.files.some((file) => file.path === "concepts/atomic.md"),
    false,
  );
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

test("add_log_entry stays deferred to AND-71 and materializes no partial commit", async () => {
  const env = await fixture();
  const editor = actor(
    PRINCIPALS.editor.principalId,
    "token_commit_log_deferred",
    "request_commit_log_deferred",
  );
  const service = env.service({
    currentActor: editor,
    nextRevisionId: "revision_log_deferred",
  });
  const before = await env.snapshot();

  const result = await service.commit({
    actor: editor,
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: REVISIONS.initial.revisionId,
    idempotencyKey: "commit_log_deferred",
    summary: "Deferred log operation",
    operations: [
      newConcept("concepts/deferred.md", "Deferred"),
      {
        type: "add_log_entry",
        path: "log.md",
        category: "Update",
        message: "Add deferred concept.",
      },
    ],
  });

  assert.equal(result.kind, "requires_log_materialization");
  assert.deepEqual(await env.snapshot(), before);
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
  assert.ok(after.objects.length > before.objects.length);
  assert.equal(after.files.some(([path]) => path === "concepts/failure.md"), false);
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
  assert.ok(after.objects.length > after.reachable.length);
  assert.deepEqual(after.reachable, winner.envelope.manifest.entries.map(
    (entry) => entry.sha256,
  ).concat(
    (await env.metadata.readRevision(
      MINDS.ordinary.spaceId,
      REVISIONS.initial.revisionId,
    )).manifest.entries.map((entry) => entry.sha256),
  ).filter((digest, index, all) => all.indexOf(digest) === index).sort());
});
