import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  MARKDOWN_MEDIA_TYPE,
  REVISION_MANIFEST_FORMAT_V3,
  REVISION_MANIFEST_FORMAT_V4,
  REVISION_MANIFEST_FORMAT_V5,
  RevisionEnvelopeError,
  canonicalMarkdownPath,
  createCanonicalRevisionEnvelope,
  createRevisionManifest,
  parseRevisionManifest,
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

test("manifest v4 accepts open safe media while v3 keeps its historical allowlist", () => {
  const v4 = createRevisionManifest([{
    kind: "opaque",
    path: "sources/page.html",
    sha256: A,
    mediaType: "Text/HTML; charset=utf-8",
    size: 17,
  }], REVISION_MANIFEST_FORMAT_V4);
  assert.equal(v4.entries[0].mediaType, "text/html");
  assert.equal(parseRevisionManifest(serializeRevisionManifest(v4)).format, REVISION_MANIFEST_FORMAT_V4);

  const fallback = createRevisionManifest([{
    kind: "opaque",
    path: "sources/unknown.bin",
    sha256: B,
    mediaType: "text/plain\r\nX-Evil: yes",
    size: 3,
  }], REVISION_MANIFEST_FORMAT_V4);
  assert.equal(fallback.entries[0].mediaType, "application/octet-stream");
  assert.throws(() => createRevisionManifest([{
    kind: "opaque",
    path: "sources/page.html",
    sha256: A,
    mediaType: "text/html",
    size: 17,
  }], REVISION_MANIFEST_FORMAT_V3), RevisionEnvelopeError);
});

test("manifest v5 canonically anchors optional object integrity roots", () => {
  const v5 = createRevisionManifest([{
    path: "index.md",
    sha256: A,
    mediaType: MARKDOWN_MEDIA_TYPE,
    size: 1,
    integrityRoot: B,
  }], REVISION_MANIFEST_FORMAT_V5);
  const serialized = serializeRevisionManifest(v5);
  assert.match(serialized, /"integrity_root":"sha256:b{64}"/u);
  assert.deepEqual(parseRevisionManifest(serialized), v5);
  assert.throws(() => createRevisionManifest([{
    path: "index.md",
    sha256: A,
    mediaType: MARKDOWN_MEDIA_TYPE,
    size: 1,
    integrityRoot: B,
  }], REVISION_MANIFEST_FORMAT_V4), RevisionEnvelopeError);
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
  for (const instant of [
    "2026-08-06T12:00:00+01:00",
    "2026-02-29T12:00:00Z",
    "2026-02-31T12:00:00Z",
    "2026-04-31T12:00:00Z",
    "2026-01-01T24:00:00Z",
  ]) {
    assert.throws(() => utcInstant(instant), RevisionEnvelopeError);
  }
  assert.equal(utcInstant("2024-02-29T23:59:59.123456789Z"), "2024-02-29T23:59:59.123456789Z");
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
