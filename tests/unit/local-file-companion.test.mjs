import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  LocalCompanionHostedFailure,
  LocalFileCompanion,
} from "@mind-diary/application-content";

const BYTES = new TextEncoder().encode("arbitrary epub-ish bytes\0with binary");
const SHA = `sha256:${createHash("sha256").update(BYTES).digest("hex")}`;
const URL = "https://mind-diary.invalid/api/file-ingress/v1/upload-intents/mdupload_v1_test";
const REF = "mdlocal_v1_0123456789abcdef";
const NOW = Date.parse("2026-08-25T12:00:00.000Z");

function snapshot(overrides = {}) {
  return {
    displayFilename: "fixture.epub",
    kind: "regular",
    snapshotId: "dev:ino:size:mtime",
    size: BYTES.byteLength,
    authority: "local",
    canonical: true,
    ...overrides,
  };
}

function fakeFile(options = {}) {
  const inspections = [...(options.inspections ?? [snapshot(), snapshot(), snapshot()])];
  let inspectIndex = 0;
  let closed = 0;
  let streams = 0;
  return {
    get closed() { return closed; },
    get streams() { return streams; },
    inspection: inspections[0],
    async inspect() {
      inspectIndex += 1;
      return inspections[Math.min(inspectIndex, inspections.length - 1)];
    },
    stream() {
      streams += 1;
      const chunks = options.chunks ?? [BYTES.subarray(0, 7), BYTES.subarray(7)];
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
    async close() { closed += 1; },
  };
}

function staged(overrides = {}) {
  return {
    staged_file_ref: "staged_local_fixture",
    state: "verified",
    source_kind: "local_path",
    display_filename: "fixture.epub",
    media_type: "application/epub+zip",
    sha256: SHA,
    size: BYTES.byteLength,
    expires_at: "2026-08-25T13:00:00.000Z",
    replayed: false,
    ...overrides,
  };
}

function harness(options = {}) {
  const file = options.file ?? fakeFile();
  const transportCalls = [];
  const filesystemCalls = [];
  const transport = options.transport ?? {
    async upload(request) {
      const chunks = [];
      for await (const chunk of request.stream) chunks.push(new Uint8Array(chunk));
      transportCalls.push({
        uploadUrl: request.uploadUrl,
        bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
        keys: Object.keys(request).sort(),
      });
      return staged(options.staged);
    },
  };
  const companion = new LocalFileCompanion({
    filesystem: {
      async open(path) {
        filesystemCalls.push(path);
        return { kind: "opened", file };
      },
    },
    transport,
    clock: options.clock ?? { now: () => NOW },
    nextLocalFileRef: options.nextLocalFileRef ?? (() => REF),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.preparedTtlMilliseconds === undefined
      ? {}
      : { preparedTtlMilliseconds: options.preparedTtlMilliseconds }),
  });
  return { companion, file, filesystemCalls, transportCalls };
}

async function prepare(env, overrides = {}) {
  return env.companion.prepare_local_file({
    path: "/private/work/fixture.epub",
    claimed_media_type: "application/epub+zip",
    ...overrides,
  });
}

test("prepare returns only a short-lived pathless receipt for arbitrary bytes", async () => {
  const events = [];
  const env = harness({ logger: { record(event) { events.push(event); } } });
  const result = await prepare(env, {
    expected_size: BYTES.byteLength,
    expected_sha256: SHA,
  });
  assert.equal(result.kind, "prepared");
  assert.deepEqual(result.prepared_file, {
    local_file_ref: REF,
    source_kind: "local_path",
    display_filename: "fixture.epub",
    claimed_media_type: "application/epub+zip",
    expected_size: BYTES.byteLength,
    expected_sha256: SHA,
    expires_at: "2026-08-25T12:10:00.000Z",
  });
  assert.equal(env.file.streams, 1);
  assert.equal(env.file.closed, 0);
  const serialized = JSON.stringify({ output: result, events });
  assert.doesNotMatch(serialized, /\/private|\/work|fixture\.epub.*fixture\.epub/u);
});

test("upload streams the same stable handle, returns the hosted receipt and consumes the ref", async () => {
  const env = harness();
  const prepared = await prepare(env);
  assert.equal(prepared.kind, "prepared");
  const result = await env.companion.upload_prepared_file({
    local_file_ref: REF,
    upload_url: URL,
  });
  assert.deepEqual(result, { kind: "staged", staged_file: staged() });
  assert.equal(env.file.streams, 2);
  assert.equal(env.file.closed, 1);
  assert.equal(env.transportCalls.length, 1);
  assert.equal(env.transportCalls[0].uploadUrl, URL);
  assert.deepEqual(env.transportCalls[0].bytes, Buffer.from(BYTES));
  assert.deepEqual(env.transportCalls[0].keys, ["stream", "uploadUrl"]);
  assert.deepEqual(
    await env.companion.upload_prepared_file({
      local_file_ref: REF,
      upload_url: URL,
    }),
    { kind: "invalid", code: "local_companion_ref_not_found" },
  );
});

test("absolute one-file grammar, explicit authority and special kinds fail closed", async (t) => {
  for (const [name, request] of [
    ["relative", { path: "fixture.epub" }],
    ["glob", { path: "/private/work/*.epub" }],
    ["traversal", { path: "/private/work/../fixture.epub" }],
    ["source", { path: "/private/work/fixture.epub", source_kind: "session_attachment" }],
  ]) {
    await t.test(name, async () => {
      const env = harness();
      const result = await env.companion.prepare_local_file(request);
      assert.equal(result.kind, "invalid");
      assert.equal(env.filesystemCalls.length, 0);
    });
  }
  for (const [name, inspection] of [
    ["directory", snapshot({ kind: "directory" })],
    ["symlink", snapshot({ kind: "symlink" })],
    ["special", snapshot({ kind: "special" })],
    ["outside authority", snapshot({ authority: "none" })],
  ]) {
    await t.test(name, async () => {
      const env = harness({ file: fakeFile({ inspections: [inspection] }) });
      assert.deepEqual(await prepare(env), {
        kind: "invalid",
        code: "file_ingress_source_unsupported",
      });
      assert.equal(env.file.streams, 0);
      assert.equal(env.file.closed, 1);
    });
  }
});

test("expected size/digest and stable snapshot changes are deterministic", async (t) => {
  await t.test("size", async () => {
    const env = harness();
    assert.deepEqual(await prepare(env, { expected_size: BYTES.byteLength + 1 }), {
      kind: "invalid",
      code: "bundle_file_size_mismatch",
    });
  });
  await t.test("digest", async () => {
    const env = harness();
    assert.deepEqual(await prepare(env, {
      expected_sha256: `sha256:${"0".repeat(64)}`,
    }), {
      kind: "invalid",
      code: "bundle_file_digest_mismatch",
    });
  });
  await t.test("prepare mutation", async () => {
    const env = harness({
      file: fakeFile({ inspections: [snapshot(), snapshot({ snapshotId: "changed" })] }),
    });
    assert.deepEqual(await prepare(env), {
      kind: "invalid",
      code: "local_companion_file_changed",
    });
  });
  await t.test("pre-upload mutation", async () => {
    const env = harness({
      file: fakeFile({
        inspections: [snapshot(), snapshot(), snapshot({ snapshotId: "changed" })],
      }),
    });
    assert.equal((await prepare(env)).kind, "prepared");
    assert.deepEqual(await env.companion.upload_prepared_file({
      local_file_ref: REF,
      upload_url: URL,
    }), {
      kind: "invalid",
      code: "local_companion_file_changed",
    });
    assert.equal(env.transportCalls.length, 0);
  });
});

test("unknown transport outcome retains the same ref for exact reconcile/retry", async () => {
  let attempt = 0;
  const seen = [];
  const env = harness({
    transport: {
      async upload(request) {
        attempt += 1;
        if (attempt === 1) {
          throw new LocalCompanionHostedFailure(
            "file_ingress_transport_unavailable",
            true,
            true,
          );
        }
        const chunks = [];
        for await (const chunk of request.stream) chunks.push(chunk);
        seen.push(Buffer.concat(chunks.map(Buffer.from)));
        return staged({ replayed: true });
      },
    },
  });
  assert.equal((await prepare(env)).kind, "prepared");
  assert.deepEqual(await env.companion.upload_prepared_file({
    local_file_ref: REF,
    upload_url: URL,
  }), {
    kind: "invalid",
    code: "file_ingress_transport_unavailable",
    retryable: true,
  });
  const retried = await env.companion.upload_prepared_file({
    local_file_ref: REF,
    upload_url: URL,
  });
  assert.equal(retried.kind, "staged");
  assert.equal(retried.staged_file.replayed, true);
  assert.deepEqual(seen, [Buffer.from(BYTES)]);
  assert.equal(env.file.closed, 1);
});

test("retryable staging admission retains the exact prepared ref", async () => {
  for (const code of [
    "staging_quota_exceeded",
    "capacity_soft_limit",
    "capacity_fairness_limit",
    "capacity_accounting_untrusted",
  ]) {
    let attempt = 0;
    const env = harness({
      transport: {
        async upload(request) {
          attempt += 1;
          if (attempt === 1) throw new LocalCompanionHostedFailure(code);
          for await (const _chunk of request.stream) { /* drain */ }
          return staged({ replayed: true });
        },
      },
    });
    assert.equal((await prepare(env)).kind, "prepared");
    assert.deepEqual(await env.companion.upload_prepared_file({
      local_file_ref: REF,
      upload_url: URL,
    }), { kind: "invalid", code, retryable: true });
    assert.equal((await env.companion.upload_prepared_file({
      local_file_ref: REF,
      upload_url: URL,
    })).kind, "staged");
    assert.equal(env.file.closed, 1);
  }
});

test("definitive rejection and expiry invalidate the process-local ref", async (t) => {
  await t.test("definitive", async () => {
    const env = harness({
      transport: {
        async upload() {
          throw new LocalCompanionHostedFailure("file_ingress_intent_expired");
        },
      },
    });
    assert.equal((await prepare(env)).kind, "prepared");
    assert.deepEqual(await env.companion.upload_prepared_file({
      local_file_ref: REF,
      upload_url: URL,
    }), {
      kind: "invalid",
      code: "file_ingress_intent_expired",
      retryable: false,
    });
    assert.equal(env.file.closed, 1);
  });
  await t.test("local TTL", async () => {
    let now = NOW;
    const env = harness({ clock: { now: () => now } });
    assert.equal((await prepare(env)).kind, "prepared");
    now += 600_001;
    assert.deepEqual(await env.companion.upload_prepared_file({
      local_file_ref: REF,
      upload_url: URL,
    }), {
      kind: "invalid",
      code: "local_companion_ref_not_found",
    });
    assert.equal(env.file.closed, 1);
  });
});
