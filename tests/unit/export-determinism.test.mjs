import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { InMemoryObjectStore } from "@mind-diary/adapter-object-memory";
import {
  DeterministicOkfExportService,
  BUNDLE_EXPORT_CONFIG,
  OKF_EXPORT_CONFIG,
  OkfExportError,
} from "@mind-diary/application-content";
import { MARKDOWN_MEDIA_TYPE } from "@mind-diary/domain";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SPACE_ID = "space_export_unit";
const REVISION_ID = "revision_export_unit";
const PLACEHOLDER_DIGEST = `sha256:${"0".repeat(64)}`;

function file(path, text) {
  const bytes = encoder.encode(text);
  return {
    path,
    mediaType: MARKDOWN_MEDIA_TYPE,
    sha256: PLACEHOLDER_DIGEST,
    size: bytes.byteLength,
    bytes,
  };
}

function materialized(files) {
  return {
    envelope: {
      revision: { spaceId: SPACE_ID, revisionId: REVISION_ID },
      manifest: { entries: [] },
    },
    files,
  };
}

function readLocalEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = [];
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const time = view.getUint16(offset + 10, true);
    const date = view.getUint16(offset + 12, true);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const bodyStart = nameStart + nameLength + extraLength;
    entries.push({
      path: decoder.decode(bytes.slice(nameStart, nameStart + nameLength)),
      body: bytes.slice(bodyStart, bodyStart + size),
      flags,
      method,
      time,
      date,
      extraLength,
    });
    offset = bodyStart + size;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50);
  return entries;
}

test("same exact revision and export config produce identical ZIP bytes and hash", async () => {
  const source = [
    file("zeta.md", "---\ntype: Zeta\n---\n\n# Zeta\n"),
    file(
      "concepts/future.md",
      "---\r\ntype: Future Unknown Type\r\nproducer_extension: { keep: exact }\r\n---\r\n\r\n# Future\r\n",
    ),
    file("alpha.md", "---\ntype: Alpha\n---\n\n# Alpha\n"),
  ];
  let materializeCalls = 0;
  const materializer = {
    async materialize() {
      materializeCalls += 1;
      return materialized(materializeCalls === 1 ? source : [...source].reverse());
    },
  };
  const digest = new InMemoryObjectStore();
  const service = new DeterministicOkfExportService({ materializer, digest });

  const first = await service.exportExactRevision({
    spaceId: SPACE_ID,
    revisionId: REVISION_ID,
  });
  const second = await service.exportExactRevision({
    spaceId: SPACE_ID,
    revisionId: REVISION_ID,
  });

  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.size, first.bytes.byteLength);
  assert.equal(
    first.sha256,
    `sha256:${createHash("sha256").update(first.bytes).digest("hex")}`,
  );
  assert.deepEqual(
    {
      archiveFormat: first.archiveFormat,
      mediaType: first.mediaType,
      filename: first.filename,
      contentDisposition: first.contentDisposition,
    },
    OKF_EXPORT_CONFIG,
  );
  assert.equal(first.validatedOkfVersion, "0.2");

  const entries = readLocalEntries(first.bytes);
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ["alpha.md", "concepts/future.md", "zeta.md"],
  );
  for (const entry of entries) {
    assert.equal(entry.flags, 0x0800);
    assert.equal(entry.method, 0);
    assert.equal(entry.time, 0);
    assert.equal(entry.date, 0x0021);
    assert.equal(entry.extraLength, 0);
  }
  const future = entries.find((entry) => entry.path === "concepts/future.md");
  assert.deepEqual(future.body, source[1].bytes);
  assert.equal(decoder.decode(future.body).includes("Future Unknown Type"), true);
  assert.equal(materializeCalls, 2);
});

test("invalid request and full-bundle validation failures are stable and produce no digest", async () => {
  let digestCalls = 0;
  const digest = {
    async calculateSha256() {
      digestCalls += 1;
      return PLACEHOLDER_DIGEST;
    },
  };
  const materializer = {
    async materialize() {
      return materialized([
        file(
          "concepts/invalid.md",
          "---\ntype: Reference\nacl: [reader]\n---\n\n# Invalid\n",
        ),
      ]);
    },
  };
  const service = new DeterministicOkfExportService({ materializer, digest });

  await assert.rejects(
    service.exportExactRevision({ spaceId: SPACE_ID, revisionId: "" }),
    (error) => error instanceof OkfExportError && error.code === "invalid_request",
  );
  await assert.rejects(
    service.exportExactRevision({ spaceId: SPACE_ID, revisionId: REVISION_ID }),
    (error) =>
      error instanceof OkfExportError &&
      error.code === "okf_validation_failed" &&
      error.diagnostics.some((issue) => issue.code === "forbidden_service_metadata"),
  );
  assert.equal(digestCalls, 0);
});

test("producer-defined non-Markdown objects are never added to the export", async () => {
  const markdownBytes = encoder.encode("---\ntype: Reference\n---\n\n# File\n");
  const service = new DeterministicOkfExportService({
    materializer: {
      async materialize() {
        return materialized([
          {
            path: "concepts/file.md",
            mediaType: "application/octet-stream",
            sha256: PLACEHOLDER_DIGEST,
            size: markdownBytes.byteLength,
            bytes: markdownBytes,
          },
        ]);
      },
    },
    digest: new InMemoryObjectStore(),
  });

  await assert.rejects(
    service.exportExactRevision({ spaceId: SPACE_ID, revisionId: REVISION_ID }),
    (error) =>
      error instanceof OkfExportError && error.code === "revision_integrity_failure",
  );
});

test("MD-BUNDLE-ZIP-1 is byte-deterministic and carries exact opaque bytes plus canonical manifest", async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const markdown = file("concepts/file.md", "---\ntype: Reference\n---\n\n# File\n");
  const opaque = {
    kind: "opaque",
    path: "assets/map.png",
    mediaType: "image/png",
    sha256: `sha256:${"a".repeat(64)}`,
    size: png.byteLength,
    bytes: png,
  };
  let calls = 0;
  const service = new DeterministicOkfExportService({
    materializer: {
      async materialize() {
        calls += 1;
        return materialized(calls === 1 ? [opaque, markdown] : [markdown, opaque]);
      },
    },
    digest: new InMemoryObjectStore(),
  });

  await assert.rejects(
    service.exportExactRevision({ spaceId: SPACE_ID, revisionId: REVISION_ID }),
    (error) => error instanceof OkfExportError && error.code === "export_profile_required",
  );
  const first = await service.exportExactRevision({
    spaceId: SPACE_ID,
    revisionId: REVISION_ID,
    profile: "MD-BUNDLE-ZIP-1",
  });
  const second = await service.exportExactRevision({
    spaceId: SPACE_ID,
    revisionId: REVISION_ID,
    profile: "MD-BUNDLE-ZIP-1",
  });
  assert.deepEqual(first.bytes, second.bytes);
  assert.deepEqual(
    {
      archiveFormat: first.archiveFormat,
      mediaType: first.mediaType,
      filename: first.filename,
      contentDisposition: first.contentDisposition,
    },
    BUNDLE_EXPORT_CONFIG,
  );
  const entries = readLocalEntries(first.bytes);
  assert.deepEqual(entries.map(({ path }) => path), [
    ".mind-diary/manifest.json",
    "assets/map.png",
    "concepts/file.md",
  ]);
  assert.deepEqual(entries.find(({ path }) => path === "assets/map.png").body, png);
  const manifestText = decoder.decode(
    entries.find(({ path }) => path === ".mind-diary/manifest.json").body,
  );
  assert.equal(manifestText.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(manifestText), {
    format: "mind-diary-bundle-export-manifest-v1",
    okf_version: "0.2",
    files: [
      {
        path: "assets/map.png",
        kind: "opaque",
        media_type: "image/png",
        sha256: opaque.sha256,
        size: png.byteLength,
      },
      {
        path: "concepts/file.md",
        kind: "markdown",
        media_type: MARKDOWN_MEDIA_TYPE,
        sha256: PLACEHOLDER_DIGEST,
        size: markdown.size,
      },
    ],
  });
});
