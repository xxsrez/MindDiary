import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  MARKDOWN_MEDIA_TYPE,
  createCanonicalRevisionEnvelope,
  createRevisionManifest,
  serializeRevisionManifest,
} from "@mind-diary/domain";
import { MINDS, REVISIONS, REVISION_AUTHORS } from "@mind-diary/test-fixtures";

async function envelope({
  objects,
  revisionId,
  revisionNumber,
  parentRevisionId,
  manifestHashOverride,
}) {
  const bytes = new TextEncoder().encode(`# ${revisionId}\n`);
  const digest = await objects.calculateSha256(bytes);
  const manifest = createRevisionManifest([
    { path: "index.md", sha256: digest, mediaType: MARKDOWN_MEDIA_TYPE, size: bytes.byteLength },
  ]);
  const manifestHash = manifestHashOverride ?? await objects.calculateSha256(
    new TextEncoder().encode(serializeRevisionManifest(manifest)),
  );
  return createCanonicalRevisionEnvelope({
    revisionId,
    spaceId: MINDS.ordinary.spaceId,
    revisionNumber,
    parentRevisionId,
    committedAt: REVISIONS.initial.committedAt,
    committedBy: REVISION_AUTHORS.active,
    manifest,
    manifestHash,
    summary: "Storage contract fixture",
  });
}

test("revision store rejects wrong parent, wrong number, bad manifest hash and stale CAS", async () => {
  const objects = new InMemoryObjectStore();
  const metadata = new InMemoryRevisionMetadataStore();
  const initial = await envelope({
    objects,
    revisionId: REVISIONS.initial.revisionId,
    revisionNumber: 1,
    parentRevisionId: null,
  });
  assert.equal(
    (await metadata.commitRevision({ expectedHeadRevisionId: null, envelope: initial })).kind,
    "committed",
  );

  const wrongParent = await envelope({
    objects,
    revisionId: "revision_wrong_parent",
    revisionNumber: 2,
    parentRevisionId: null,
  });
  assert.deepEqual(
    await metadata.commitRevision({
      expectedHeadRevisionId: REVISIONS.initial.revisionId,
      envelope: wrongParent,
    }),
    { kind: "invalid_revision_chain", reason: "parent_mismatch" },
  );

  const wrongNumber = await envelope({
    objects,
    revisionId: "revision_wrong_number",
    revisionNumber: 3,
    parentRevisionId: REVISIONS.initial.revisionId,
  });
  assert.equal(
    (await metadata.commitRevision({
      expectedHeadRevisionId: REVISIONS.initial.revisionId,
      envelope: wrongNumber,
    })).reason,
    "revision_number_mismatch",
  );

  const badHash = await envelope({
    objects,
    revisionId: "revision_bad_hash",
    revisionNumber: 2,
    parentRevisionId: REVISIONS.initial.revisionId,
    manifestHashOverride: `sha256:${"f".repeat(64)}`,
  });
  assert.equal(
    (await metadata.commitRevision({
      expectedHeadRevisionId: REVISIONS.initial.revisionId,
      envelope: badHash,
    })).reason,
    "manifest_hash_mismatch",
  );

  const stale = await envelope({
    objects,
    revisionId: "revision_stale_initial",
    revisionNumber: 1,
    parentRevisionId: null,
  });
  assert.deepEqual(
    await metadata.commitRevision({ expectedHeadRevisionId: null, envelope: stale }),
    { kind: "stale_head", currentHeadRevisionId: REVISIONS.initial.revisionId },
  );
  assert.equal(await metadata.readHead(MINDS.ordinary.spaceId), REVISIONS.initial.revisionId);
  assert.equal((await metadata.listRevisions(MINDS.ordinary.spaceId)).length, 1);
});

test("object-store locator and revision metadata expose no object-store version identity", async () => {
  const objects = new InMemoryObjectStore();
  const put = await objects.putImmutable({
    bytes: new TextEncoder().encode("# Content\n"),
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt: REVISIONS.initial.committedAt,
  });
  assert.deepEqual(Object.keys(put.object).sort(), [
    "createdAt",
    "mediaType",
    "protectedAt",
    "sha256",
    "size",
  ]);
  assert.equal(Object.keys(put.object).some((key) => /version/i.test(key)), false);
  assert.match(put.object.sha256, /^sha256:[0-9a-f]{64}$/);
});
