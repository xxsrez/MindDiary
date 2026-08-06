import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  MARKDOWN_MEDIA_TYPE,
  RevisionEnvelopeError,
  canonicalMarkdownPath,
  createCanonicalRevisionEnvelope,
  createRevisionManifest,
  revisionNumber,
  serializeRevisionManifest,
  sha256Digest,
  utcInstant,
} from "@mind-diary/domain";
import { MINDS, REVISIONS, REVISION_AUTHORS } from "@mind-diary/test-fixtures";

const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;

function hash(source) {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

test("revision manifest ordering and serialization are deterministic", () => {
  const forward = createRevisionManifest([
    { path: "z.md", sha256: B, mediaType: MARKDOWN_MEDIA_TYPE, size: 2 },
    { path: "a.md", sha256: A, mediaType: MARKDOWN_MEDIA_TYPE, size: 1 },
  ]);
  const reverse = createRevisionManifest([...forward.entries].reverse());

  assert.deepEqual(forward.entries.map((entry) => entry.path), ["a.md", "z.md"]);
  assert.equal(serializeRevisionManifest(forward), serializeRevisionManifest(reverse));
  assert.equal(hash(serializeRevisionManifest(forward)).length, 71);
  assert.ok(Object.isFrozen(forward));
  assert.ok(Object.isFrozen(forward.entries));
});

test("revision values reject invalid digest, path, media, size, number and UTC metadata", () => {
  for (const digest of ["", "a".repeat(64), `sha256:${"A".repeat(64)}`]) {
    assert.throws(() => sha256Digest(digest), RevisionEnvelopeError);
  }
  for (const path of ["", "/index.md", "../index.md", "a\\b.md", "a.zip", "a%2fb.md"]) {
    assert.throws(() => canonicalMarkdownPath(path), RevisionEnvelopeError);
  }
  assert.throws(
    () =>
      createRevisionManifest([
        { path: "index.md", sha256: A, mediaType: "text/plain", size: 1 },
      ]),
    (error) => error instanceof RevisionEnvelopeError && error.code === "invalid_media_type",
  );
  assert.throws(
    () =>
      createRevisionManifest([
        { path: "index.md", sha256: A, mediaType: MARKDOWN_MEDIA_TYPE, size: -1 },
      ]),
    RevisionEnvelopeError,
  );
  assert.throws(() => revisionNumber(0), TypeError);
  assert.throws(() => revisionNumber(1.5), TypeError);
  assert.throws(() => utcInstant("2026-08-06T12:00:00+01:00"), RevisionEnvelopeError);
});

test("SpaceRevision envelope carries positive number, exact parent and server UTC metadata", () => {
  const manifest = createRevisionManifest([
    { path: "index.md", sha256: A, mediaType: MARKDOWN_MEDIA_TYPE, size: 1 },
  ]);
  const envelope = createCanonicalRevisionEnvelope({
    revisionId: REVISIONS.next.revisionId,
    spaceId: MINDS.ordinary.spaceId,
    revisionNumber: 2,
    parentRevisionId: REVISIONS.initial.revisionId,
    committedAt: REVISIONS.next.committedAt,
    committedBy: REVISION_AUTHORS.active,
    manifest,
    manifestHash: hash(serializeRevisionManifest(manifest)),
    summary: "Fixture next revision",
  });

  assert.equal(envelope.revision.revisionNumber, 2);
  assert.equal(envelope.revision.parentRevisionId, REVISIONS.initial.revisionId);
  assert.equal(envelope.revision.committedAt, REVISIONS.next.committedAt);
  assert.ok(Object.isFrozen(envelope.revision));
});
