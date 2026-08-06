import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  CanonicalRevisionCoordinator,
  CanonicalRevisionError,
} from "@mind-diary/application-content";
import { MARKDOWN_MEDIA_TYPE } from "@mind-diary/domain";
import {
  CANONICAL_REVISION_FILES,
  MINDS,
  REVISIONS,
  REVISION_AUTHORS,
} from "@mind-diary/test-fixtures";

const encoder = new TextEncoder();

function harness() {
  const objects = new InMemoryObjectStore();
  const revisions = new InMemoryRevisionMetadataStore();
  return {
    objects,
    revisions,
    coordinator: new CanonicalRevisionCoordinator({ objects, revisions }),
  };
}

function request({
  revisionId = REVISIONS.initial.revisionId,
  expectedRevisionId = null,
  committedAt = REVISIONS.initial.committedAt,
  files = CANONICAL_REVISION_FILES,
  summary = "Fixture revision",
} = {}) {
  return {
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId,
    revisionId,
    committedAt,
    committedBy: REVISION_AUTHORS.active,
    summary,
    files,
  };
}

function oneFile(path, text) {
  return [{ path, mediaType: MARKDOWN_MEDIA_TYPE, bytes: encoder.encode(text) }];
}

test("manifest hash ignores input order and revisions form a positive exact-parent chain", async () => {
  const firstHarness = harness();
  const first = await firstHarness.coordinator.commit(
    request({ files: [...CANONICAL_REVISION_FILES].reverse() }),
  );
  assert.equal(first.kind, "committed");
  assert.equal(first.envelope.revision.revisionNumber, 1);
  assert.equal(first.envelope.revision.parentRevisionId, null);
  assert.deepEqual(
    first.envelope.manifest.entries.map((entry) => entry.path),
    ["concepts/baseline.md", "index.md", "log.md"],
  );

  const secondHarness = harness();
  const equivalent = await secondHarness.coordinator.commit(request());
  assert.equal(equivalent.envelope.revision.manifestHash, first.envelope.revision.manifestHash);

  const next = await firstHarness.coordinator.commit(
    request({
      revisionId: REVISIONS.next.revisionId,
      expectedRevisionId: REVISIONS.initial.revisionId,
      committedAt: REVISIONS.next.committedAt,
      files: oneFile("index.md", "# New HEAD\n"),
      summary: "Move HEAD",
    }),
  );
  assert.equal(next.envelope.revision.revisionNumber, 2);
  assert.equal(next.envelope.revision.parentRevisionId, REVISIONS.initial.revisionId);
  assert.equal(await firstHarness.revisions.readHead(MINDS.ordinary.spaceId), REVISIONS.next.revisionId);

  const historical = await firstHarness.coordinator.materialize(
    MINDS.ordinary.spaceId,
    REVISIONS.initial.revisionId,
  );
  assert.equal(historical.envelope.revision.revisionId, REVISIONS.initial.revisionId);
  assert.match(historical.files.find((file) => file.path === "index.md").text, /Fixture Mind/);
});

test("exact retry does not duplicate revision and a concurrent stale loser is unreachable", async () => {
  const { coordinator, revisions } = harness();
  const initialRequest = request();
  const initial = await coordinator.commit(initialRequest);
  const replay = await coordinator.commit(initialRequest);
  assert.equal(initial.kind, "committed");
  assert.equal(replay.kind, "committed");
  assert.equal(replay.replayed, true);
  assert.equal((await revisions.listRevisions(MINDS.ordinary.spaceId)).length, 1);

  const raceRequests = [
    request({
      revisionId: "revision_race_a",
      expectedRevisionId: REVISIONS.initial.revisionId,
      committedAt: REVISIONS.next.committedAt,
      files: oneFile("a.md", "# A\n"),
    }),
    request({
      revisionId: "revision_race_b",
      expectedRevisionId: REVISIONS.initial.revisionId,
      committedAt: REVISIONS.next.committedAt,
      files: oneFile("b.md", "# B\n"),
    }),
  ];
  const results = await Promise.all(raceRequests.map((candidate) => coordinator.commit(candidate)));
  const winner = results.find((result) => result.kind === "committed");
  const loser = results.find((result) => result.kind === "stale_head");
  assert.ok(winner);
  assert.ok(loser);
  assert.equal(loser.currentHeadRevisionId, winner.envelope.revision.revisionId);
  assert.equal((await revisions.listRevisions(MINDS.ordinary.spaceId)).length, 2);
  const loserId = raceRequests.find(
    (candidate) => candidate.revisionId !== winner.envelope.revision.revisionId,
  ).revisionId;
  await assert.rejects(
    coordinator.materialize(MINDS.ordinary.spaceId, loserId),
    (error) => error instanceof CanonicalRevisionError && error.code === "revision_not_found",
  );
});

test("invalid UTF-8 and metadata failure publish neither revision nor HEAD", async () => {
  const { objects, revisions, coordinator } = harness();
  await assert.rejects(
    coordinator.commit(
      request({
        files: [{
          path: "index.md",
          mediaType: MARKDOWN_MEDIA_TYPE,
          bytes: Uint8Array.of(0xc3, 0x28),
        }],
      }),
    ),
    (error) => error instanceof CanonicalRevisionError && error.code === "invalid_utf8",
  );
  assert.equal((await objects.listImmutableObjects({
    createdBefore: "2026-08-07T00:00:00Z",
    excludedDigests: [],
    limit: 10,
  })).length, 0);

  revisions.failNextCommitForTest();
  await assert.rejects(coordinator.commit(request()), /injected revision metadata/);
  assert.equal(await revisions.readHead(MINDS.ordinary.spaceId), null);
  assert.equal((await revisions.listRevisions(MINDS.ordinary.spaceId)).length, 0);
  await assert.rejects(
    coordinator.materialize(MINDS.ordinary.spaceId, REVISIONS.initial.revisionId),
    (error) => error instanceof CanonicalRevisionError && error.code === "revision_not_found",
  );
  assert.equal((await objects.listImmutableObjects({
    createdBefore: "2026-08-07T00:00:00Z",
    excludedDigests: [],
    limit: 10,
  })).length, 3);
});

test("bounded GC deletes only unreachable objects strictly older than cutoff", async () => {
  const { objects, revisions, coordinator } = harness();
  await coordinator.commit(
    request({ files: oneFile("reachable.md", "# Reachable\n") }),
  );
  revisions.failNextCommitForTest();
  await assert.rejects(
    coordinator.commit(
      request({
        revisionId: REVISIONS.next.revisionId,
        expectedRevisionId: REVISIONS.initial.revisionId,
        committedAt: "2026-08-06T12:01:00Z",
        files: oneFile("failed.md", "# Failed\n"),
      }),
    ),
  );
  const failedDigest = (
    await objects.listImmutableObjects({
      createdBefore: "2026-08-06T12:02:00Z",
      excludedDigests: [],
      limit: 10,
    })
  ).find((object) => object.createdAt === "2026-08-06T12:01:00Z").sha256;
  const boundary = await objects.putImmutable({
    bytes: encoder.encode("# Boundary\n"),
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: "2026-08-06T12:02:00Z",
  });
  const newer = await objects.putImmutable({
    bytes: encoder.encode("# Newer\n"),
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: "2026-08-06T12:03:00Z",
  });

  const collected = await coordinator.collectUnreachableObjects({
    createdBefore: "2026-08-06T12:02:00Z",
    limit: 10,
  });
  assert.equal(collected.deleted, 1);
  assert.deepEqual(collected.deletedDigests, [failedDigest]);
  assert.equal(await objects.getImmutable(failedDigest), null);
  assert.ok(await objects.getImmutable(boundary.object.sha256));
  assert.ok(await objects.getImmutable(newer.object.sha256));
  assert.equal(
    (await coordinator.materialize(MINDS.ordinary.spaceId, REVISIONS.initial.revisionId)).files[0].path,
    "reachable.md",
  );
  assert.ok(collected.scanned <= 10);

  await objects.putImmutable({
    bytes: encoder.encode("# Old one\n"),
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: "2026-08-06T11:00:00Z",
  });
  await objects.putImmutable({
    bytes: encoder.encode("# Old two\n"),
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: "2026-08-06T11:01:00Z",
  });
  const bounded = await coordinator.collectUnreachableObjects({
    createdBefore: "2026-08-06T12:02:00Z",
    limit: 1,
  });
  assert.equal(bounded.scanned, 1);
  assert.equal(bounded.deleted, 1);
});

test("bounded GC excludes reachable prefix before limit and cannot starve later garbage", async () => {
  const { objects, coordinator } = harness();
  await coordinator.commit(
    request({
      committedAt: "2026-08-06T10:00:00Z",
      files: oneFile("reachable.md", "# Reachable oldest\n"),
    }),
  );
  const garbage = await objects.putImmutable({
    bytes: encoder.encode("# Unreachable later\n"),
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: "2026-08-06T11:00:00Z",
  });

  const collected = await coordinator.collectUnreachableObjects({
    createdBefore: "2026-08-06T12:00:00Z",
    limit: 1,
  });
  assert.deepEqual(collected.deletedDigests, [garbage.object.sha256]);
  assert.equal(await objects.getImmutable(garbage.object.sha256), null);
  assert.equal(
    (await coordinator.materialize(MINDS.ordinary.spaceId, REVISIONS.initial.revisionId)).files[0].text,
    "# Reachable oldest\n",
  );
});

test("reusing an old digest refreshes GC protection and conditional delete cannot break HEAD", async () => {
  const { objects, revisions, coordinator } = harness();
  const files = oneFile("index.md", "# Reused bytes\n");
  const old = await objects.putImmutable({
    bytes: files[0].bytes,
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: "2026-08-06T10:00:00Z",
  });
  const [selected] = await objects.listImmutableObjects({
    createdBefore: "2026-08-06T12:00:00Z",
    excludedDigests: [],
    limit: 1,
  });
  assert.equal(selected.sha256, old.object.sha256);

  await coordinator.commit(
    request({ committedAt: "2026-08-06T13:00:00Z", files }),
  );
  assert.equal(
    await objects.deleteImmutableObject({
      sha256: selected.sha256,
      expectedProtectedAt: selected.protectedAt,
      createdBefore: "2026-08-06T12:00:00Z",
    }),
    false,
  );
  assert.equal(await revisions.readHead(MINDS.ordinary.spaceId), REVISIONS.initial.revisionId);
  assert.equal(
    (await coordinator.materialize(MINDS.ordinary.spaceId, REVISIONS.initial.revisionId)).files[0].text,
    "# Reused bytes\n",
  );
  const protectedObject = await objects.getImmutable(old.object.sha256);
  assert.equal(protectedObject.createdAt, "2026-08-06T10:00:00Z");
  assert.equal(protectedObject.protectedAt, "2026-08-06T13:00:00Z");
});

test("materialize maps stored-object tamper to stable error without changing HEAD", async () => {
  const { objects, revisions, coordinator } = harness();
  const committed = await coordinator.commit(
    request({ files: oneFile("index.md", "# Integrity\n") }),
  );
  const digest = committed.envelope.manifest.entries[0].sha256;
  objects.corruptBytesForTest(digest, encoder.encode("# Tampered!\n"));

  await assert.rejects(
    coordinator.materialize(MINDS.ordinary.spaceId, REVISIONS.initial.revisionId),
    (error) =>
      error instanceof CanonicalRevisionError &&
      error.code === "object_integrity_failure",
  );
  assert.equal(await revisions.readHead(MINDS.ordinary.spaceId), REVISIONS.initial.revisionId);
  assert.equal((await revisions.listRevisions(MINDS.ordinary.spaceId)).length, 1);
});
