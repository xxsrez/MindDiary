import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  CanonicalRevisionCoordinator,
  DeterministicOkfExportService,
  OkfExportError,
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
  const coordinator = new CanonicalRevisionCoordinator({ objects, revisions });
  const exports = new DeterministicOkfExportService({
    materializer: coordinator,
    digest: objects,
  });
  return { objects, revisions, coordinator, exports };
}

function commitRequest({
  revisionId,
  expectedRevisionId,
  committedAt,
  files,
}) {
  return {
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId,
    revisionId,
    committedAt,
    committedBy: REVISION_AUTHORS.active,
    summary: `Commit ${revisionId}`,
    files,
  };
}

test("selected exact revision stays byte-identical after HEAD movement", async () => {
  const { revisions, coordinator, exports } = harness();
  await coordinator.commit(
    commitRequest({
      revisionId: REVISIONS.initial.revisionId,
      expectedRevisionId: null,
      committedAt: REVISIONS.initial.committedAt,
      files: [...CANONICAL_REVISION_FILES].reverse(),
    }),
  );
  const selected = await exports.exportExactRevision({
    spaceId: MINDS.ordinary.spaceId,
    revisionId: REVISIONS.initial.revisionId,
  });

  await coordinator.commit(
    commitRequest({
      revisionId: REVISIONS.next.revisionId,
      expectedRevisionId: REVISIONS.initial.revisionId,
      committedAt: REVISIONS.next.committedAt,
      files: [
        {
          path: "index.md",
          mediaType: MARKDOWN_MEDIA_TYPE,
          bytes: encoder.encode("# Different current HEAD\n"),
        },
      ],
    }),
  );
  const selectedAfterHeadMove = await exports.exportExactRevision({
    spaceId: MINDS.ordinary.spaceId,
    revisionId: REVISIONS.initial.revisionId,
  });
  const current = await exports.exportExactRevision({
    spaceId: MINDS.ordinary.spaceId,
    revisionId: REVISIONS.next.revisionId,
  });

  assert.deepEqual(selectedAfterHeadMove.bytes, selected.bytes);
  assert.equal(selectedAfterHeadMove.sha256, selected.sha256);
  assert.equal(selectedAfterHeadMove.size, selected.size);
  assert.notEqual(current.sha256, selected.sha256);
  assert.equal(await revisions.readHead(MINDS.ordinary.spaceId), REVISIONS.next.revisionId);
  assert.equal((await revisions.listRevisions(MINDS.ordinary.spaceId)).length, 2);
});

test("missing or corrupt exact revision maps to stable export failures without state mutation", async () => {
  const { objects, revisions, coordinator, exports } = harness();
  const committed = await coordinator.commit(
    commitRequest({
      revisionId: REVISIONS.initial.revisionId,
      expectedRevisionId: null,
      committedAt: REVISIONS.initial.committedAt,
      files: CANONICAL_REVISION_FILES,
    }),
  );

  await assert.rejects(
    exports.exportExactRevision({
      spaceId: MINDS.ordinary.spaceId,
      revisionId: "revision_missing",
    }),
    (error) => error instanceof OkfExportError && error.code === "revision_not_found",
  );

  const firstDigest = committed.envelope.manifest.entries[0].sha256;
  objects.corruptBytesForTest(firstDigest, encoder.encode("# Tampered\n"));
  await assert.rejects(
    exports.exportExactRevision({
      spaceId: MINDS.ordinary.spaceId,
      revisionId: REVISIONS.initial.revisionId,
    }),
    (error) =>
      error instanceof OkfExportError && error.code === "revision_integrity_failure",
  );

  assert.equal(await revisions.readHead(MINDS.ordinary.spaceId), REVISIONS.initial.revisionId);
  assert.equal((await revisions.listRevisions(MINDS.ordinary.spaceId)).length, 1);
});
