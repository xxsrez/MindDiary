import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  CanonicalRevisionCoordinator,
  DeterministicOkfExportService,
} from "@mind-diary/application-content";
import { validateOkfBundle } from "@mind-diary/okf-codec";
import {
  CANONICAL_REVISION_FILES,
  MINDS,
  REVISIONS,
  REVISION_AUTHORS,
} from "@mind-diary/test-fixtures";

const decoder = new TextDecoder();

function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = [];
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const time = view.getUint16(offset + 10, true);
    const date = view.getUint16(offset + 12, true);
    const crc32 = view.getUint32(offset + 14, true);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    files.push({
      path: decoder.decode(bytes.slice(nameStart, nameStart + nameLength)),
      bytes: bytes.slice(dataStart, dataStart + size),
      flags,
      method,
      time,
      date,
      crc32,
      size,
      extraLength,
      localOffset: offset,
    });
    offset = dataStart + size;
  }
  const centralOffset = offset;
  const central = [];
  while (view.getUint32(offset, true) === 0x02014b50) {
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    central.push({
      madeBy: view.getUint16(offset + 4, true),
      needed: view.getUint16(offset + 6, true),
      flags: view.getUint16(offset + 8, true),
      method: view.getUint16(offset + 10, true),
      time: view.getUint16(offset + 12, true),
      date: view.getUint16(offset + 14, true),
      path: decoder.decode(bytes.slice(nameStart, nameStart + nameLength)),
      extraLength,
      commentLength,
      externalAttributes: view.getUint32(offset + 38, true),
      localOffset: view.getUint32(offset + 42, true),
    });
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  assert.equal(view.getUint32(offset, true), 0x06054b50);
  return {
    files,
    central,
    centralOffset,
    end: {
      disk: view.getUint16(offset + 4, true),
      centralDisk: view.getUint16(offset + 6, true),
      entriesOnDisk: view.getUint16(offset + 8, true),
      entries: view.getUint16(offset + 10, true),
      centralSize: view.getUint32(offset + 12, true),
      centralOffset: view.getUint32(offset + 16, true),
      commentLength: view.getUint16(offset + 20, true),
    },
  };
}

test("MD-OKF-ZIP-1 fixture pins classic ZIP metadata and validates the extracted full bundle", async () => {
  const objects = new InMemoryObjectStore();
  const revisions = new InMemoryRevisionMetadataStore();
  const coordinator = new CanonicalRevisionCoordinator({ objects, revisions });
  await coordinator.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: null,
    revisionId: REVISIONS.initial.revisionId,
    committedAt: REVISIONS.initial.committedAt,
    committedBy: REVISION_AUTHORS.active,
    summary: "Deterministic export fixture",
    files: [...CANONICAL_REVISION_FILES].reverse(),
  });
  const service = new DeterministicOkfExportService({
    materializer: coordinator,
    digest: objects,
  });
  const exported = await service.exportExactRevision({
    spaceId: MINDS.ordinary.spaceId,
    revisionId: REVISIONS.initial.revisionId,
  });
  const archive = readZip(exported.bytes);

  assert.deepEqual(
    archive.files.map((file) => file.path),
    ["concepts/baseline.md", "index.md", "log.md"],
  );
  assert.deepEqual(
    archive.files.map((file) => file.path),
    archive.central.map((entry) => entry.path),
  );
  assert.equal(exported.mediaType, "application/zip");
  assert.equal(exported.filename, "mind-diary-okf-bundle.zip");
  assert.equal(
    exported.contentDisposition,
    'attachment; filename="mind-diary-okf-bundle.zip"',
  );
  assert.equal(exported.archiveFormat, "MD-OKF-ZIP-1");
  assert.equal(
    exported.sha256,
    "sha256:2a11b6f9ad57e061abe6b06db8df00f0bff04c266d456d931657dbe086e385d7",
  );
  assert.equal(exported.size, 866);
  assert.equal(exported.size, exported.bytes.byteLength);

  for (const [index, local] of archive.files.entries()) {
    const central = archive.central[index];
    assert.equal(local.flags, 0x0800);
    assert.equal(local.method, 0);
    assert.equal(local.time, 0);
    assert.equal(local.date, 0x0021);
    assert.equal(local.extraLength, 0);
    assert.equal(local.path.endsWith(".md"), true);
    assert.equal(local.path.endsWith("/"), false);
    assert.equal(central.madeBy, 0x0314);
    assert.equal(central.needed, 20);
    assert.equal(central.flags, local.flags);
    assert.equal(central.method, local.method);
    assert.equal(central.time, local.time);
    assert.equal(central.date, local.date);
    assert.equal(central.extraLength, 0);
    assert.equal(central.commentLength, 0);
    assert.equal(central.externalAttributes, 0x81a40000);
    assert.equal(central.localOffset, local.localOffset);
  }
  assert.deepEqual(archive.end, {
    disk: 0,
    centralDisk: 0,
    entriesOnDisk: 3,
    entries: 3,
    centralSize: exported.bytes.byteLength - archive.centralOffset - 22,
    centralOffset: archive.centralOffset,
    commentLength: 0,
  });

  const validation = validateOkfBundle(
    archive.files.map((entry) => ({ path: entry.path, bytes: entry.bytes })),
  );
  assert.equal(validation.valid, true);
  assert.equal(validation.files.length, CANONICAL_REVISION_FILES.length);
  assert.equal(
    archive.files.find((entry) => entry.path === "concepts/baseline.md").bytes
      .includes(0),
    false,
  );
});
