import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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

test("streamed exact export is byte-identical while reading only one immutable file at a time", async () => {
  const digest = new InMemoryObjectStore();
  const source = [
    file("zeta.md", "---\ntype: Zeta\n---\n\n# Zeta\n"),
    file("alpha.md", "---\ntype: Alpha\n---\n\n# Alpha\n"),
  ];
  const files = await Promise.all(source.map(async (entry) => ({
    ...entry,
    kind: "markdown",
    sha256: await digest.calculateSha256(entry.bytes),
  })));
  const envelope = {
    revision: { spaceId: SPACE_ID, revisionId: REVISION_ID },
    manifest: { entries: files.map(({ bytes: _bytes, ...entry }) => entry) },
  };
  let activeReads = 0;
  let peakReads = 0;
  const materializer = {
    async materialize() {
      return { envelope, files };
    },
    async readRevisionEnvelope() {
      return envelope;
    },
    async readRevisionFile(_spaceId, _revisionId, path) {
      activeReads += 1;
      peakReads = Math.max(peakReads, activeReads);
      try {
        const selected = files.find((entry) => entry.path === path);
        return selected === undefined ? null : { ...selected, bytes: new Uint8Array(selected.bytes) };
      } finally {
        activeReads -= 1;
      }
    },
    async openRevisionFile(_spaceId, _revisionId, path) {
      activeReads += 1;
      peakReads = Math.max(peakReads, activeReads);
      const selected = files.find((entry) => entry.path === path);
      if (selected === undefined) {
        activeReads -= 1;
        return null;
      }
      const bytes = new Uint8Array(selected.bytes);
      const { bytes: _bytes, ...metadata } = selected;
      return {
        ...metadata,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
            activeReads -= 1;
          },
        }),
      };
    },
  };
  const service = new DeterministicOkfExportService({ materializer, digest });
  const bounded = await service.exportExactRevision({
    spaceId: SPACE_ID,
    revisionId: REVISION_ID,
  });
  const chunks = [];
  let maxChunk = 0;
  const streamed = await service.writeExactRevision({
    spaceId: SPACE_ID,
    revisionId: REVISION_ID,
  }, {
    async write(chunk) {
      maxChunk = Math.max(maxChunk, chunk.byteLength);
      chunks.push(new Uint8Array(chunk));
    },
  });
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  assert.deepEqual(bytes, bounded.bytes);
  assert.equal(streamed.sha256, bounded.sha256);
  assert.equal(streamed.size, bounded.size);
  assert.equal(peakReads, 1);
  assert.ok(maxChunk <= 1_048_576);
});

test("streamed export reuses one verified revision session for every file pass", async () => {
  const digest = new InMemoryObjectStore();
  const markdown = file("concepts/source.md", "---\ntype: Reference\n---\n\n# Source\n");
  const opaqueBytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
  const files = [
    {
      ...markdown,
      kind: "markdown",
      sha256: await digest.calculateSha256(markdown.bytes),
    },
    {
      kind: "opaque",
      path: "assets/source.pdf",
      mediaType: "application/pdf",
      sha256: await digest.calculateSha256(opaqueBytes),
      size: opaqueBytes.byteLength,
      bytes: opaqueBytes,
    },
  ];
  const envelope = {
    revision: { spaceId: SPACE_ID, revisionId: REVISION_ID },
    manifest: { entries: files.map(({ bytes: _bytes, ...entry }) => entry) },
  };
  let sessionCalls = 0;
  let legacyEnvelopeCalls = 0;
  let legacyFileCalls = 0;
  const sessionReads = [];
  const sessionOpens = [];
  const selectedFile = (path) => files.find((entry) => entry.path === path);
  const openFile = async (path) => {
    const selected = selectedFile(path);
    if (selected === undefined) return null;
    const { bytes, ...metadata } = selected;
    return {
      ...metadata,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      }),
    };
  };
  const materializer = {
    async materialize() {
      return { envelope, files };
    },
    async openRevisionSession() {
      sessionCalls += 1;
      return {
        envelope,
        async readRevisionFile(path) {
          sessionReads.push(path);
          const selected = selectedFile(path);
          return selected === undefined
            ? null
            : { ...selected, bytes: new Uint8Array(selected.bytes) };
        },
        async openRevisionFile(path) {
          sessionOpens.push(path);
          return openFile(path);
        },
      };
    },
    async readRevisionEnvelope() {
      legacyEnvelopeCalls += 1;
      return envelope;
    },
    async readRevisionFile() {
      legacyFileCalls += 1;
      return null;
    },
    async openRevisionFile() {
      legacyFileCalls += 1;
      return null;
    },
  };
  const service = new DeterministicOkfExportService({ materializer, digest });
  const bounded = await service.exportExactRevision({
    spaceId: SPACE_ID,
    revisionId: REVISION_ID,
    profile: "MD-BUNDLE-ZIP-1",
  });
  const chunks = [];
  const streamed = await service.writeExactRevision({
    spaceId: SPACE_ID,
    revisionId: REVISION_ID,
    profile: "MD-BUNDLE-ZIP-1",
  }, {
    async write(chunk) {
      chunks.push(new Uint8Array(chunk));
    },
  });
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  assert.deepEqual(bytes, bounded.bytes);
  assert.equal(streamed.sha256, bounded.sha256);
  assert.equal(sessionCalls, 1);
  assert.equal(legacyEnvelopeCalls, 0);
  assert.equal(legacyFileCalls, 0);
  assert.deepEqual(sessionReads, ["concepts/source.md"]);
  assert.deepEqual(sessionOpens, [
    "assets/source.pdf",
    "assets/source.pdf",
    "concepts/source.md",
  ]);
});

test("streamed export keeps one contract-bounded Markdown file and never concatenates stream chunks", async () => {
  const source = await readFile(
    new URL("../../packages/application-content/src/deterministic-export.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /MAX_EXPORT_MARKDOWN_FILE_BYTES = 1_048_576/u);
  assert.match(source, /entry\.kind === "markdown"[\s\S]{0,160}#inspectBoundedMarkdownFile/u);
  assert.doesNotMatch(source, /markdownChunks|markdownBytes\.set\(/u);
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
