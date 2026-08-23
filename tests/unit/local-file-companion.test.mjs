import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalCompanionTransportFailure,
  LocalFileCompanion,
  LOCAL_COMPANION_LIMITS,
} from "@mind-diary/application-content";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);
const ACTOR = { kind: "service", serviceId: "local-companion-test" };
const TARGET = {
  actor: ACTOR,
  spaceId: "space_local_companion",
  writeBindingId: "binding_local_companion",
};

function inspection(overrides = {}) {
  return {
    canonicalPath: "/workspace/artifact.png",
    displayFilename: "artifact.png",
    kind: "regular",
    snapshotId: "snapshot-1",
    size: PNG.byteLength,
    authority: "local",
    canonical: true,
    ...overrides,
  };
}

function fakeFilesystem({ before = inspection(), after = before, chunks = [PNG] } = {}) {
  let inspectCount = 0;
  return {
    get inspectCount() {
      return inspectCount;
    },
    async inspect() {
      inspectCount += 1;
      return inspectCount === 1 ? before : after;
    },
    async read() {
      return chunks;
    },
  };
}

function stagedResult(sourceKind = "local_path") {
  return {
    kind: "staged",
    replayed: false,
    record: {
      stagedFileId: "staged_local_companion",
      sourceKind,
      sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      size: PNG.byteLength,
    },
  };
}

function harness(options = {}) {
  const calls = [];
  const transport = options.transport ?? {
    async upload(request) {
      calls.push(request);
      return stagedResult(request.input.sourceKind);
    },
  };
  const service = new LocalFileCompanion({
    filesystem: options.filesystem ?? fakeFilesystem(),
    transport,
    authorize: options.authorize ?? (async () => ({ kind: "allowed" })),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.maxConcurrentUploads === undefined ? {} : { maxConcurrentUploads: options.maxConcurrentUploads }),
  });
  return { calls, service };
}

test("local file is verified before only-path-free upload transport", async () => {
  const env = harness();
  const result = await env.service.upload_local_file({
    ...TARGET,
    path: "/workspace/artifact.png",
    idempotencyKey: "local-file-1",
    expectedSize: PNG.byteLength,
    displayFilename: "artifact.png",
    claimedMediaType: "image/png",
  });
  assert.equal(result.kind, "staged");
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].input.sourceKind, "local_path");
  assert.equal(env.calls[0].input.size, PNG.byteLength);
  assert.equal(env.calls[0].input.detectedMediaType, "image/png");
  assert.equal(env.calls[0].input.safeDisplayFilename, "artifact.png");
  assert.equal(Object.hasOwn(env.calls[0], "path"), false);
  assert.equal(Object.hasOwn(env.calls[0].input, "canonicalPath"), false);
});

test("local companion telemetry stays path- and secret-free", async () => {
  const events = [];
  const env = harness({ logger: { record(event) { events.push(event); } } });
  const result = await env.service.uploadLocalFile({
    ...TARGET,
    path: "/private/user/workspace/secret-artifact.png",
    idempotencyKey: "telemetry-secret",
    displayFilename: "secret-artifact.png",
  });
  assert.equal(result.kind, "staged");
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /private|workspace|secret-artifact|telemetry-secret|local-companion-test/u);
  assert.match(serialized, /upload_local_file/u);
});

test("workspace artifacts use explicit workspace authority and the same boundary", async () => {
  const env = harness({
    filesystem: fakeFilesystem({
      before: inspection({ authority: "workspace" }),
      after: inspection({ authority: "workspace" }),
    }),
  });
  const result = await env.service.uploadLocalFile({
    ...TARGET,
    path: "/workspace/generated/artifact.png",
    sourceKind: "workspace/generated_artifact",
    idempotencyKey: "workspace-file-1",
  });
  assert.equal(result.kind, "staged");
  assert.equal(env.calls[0].input.sourceKind, "workspace/generated_artifact");
});

test("missing, traversal, symlink, directory and special files fail closed", async (t) => {
  for (const [name, filesystem, expected] of [
    ["missing", fakeFilesystem({ before: inspection({ kind: "missing" }) }), "file_ingress_source_unavailable"],
    ["symlink", fakeFilesystem({ before: inspection({ kind: "symlink" }) }), "file_ingress_source_unsupported"],
    ["directory", fakeFilesystem({ before: inspection({ kind: "directory" }) }), "file_ingress_source_unsupported"],
    ["special", fakeFilesystem({ before: inspection({ kind: "special" }) }), "file_ingress_source_unsupported"],
    ["outside authority", fakeFilesystem({ before: inspection({ authority: "none" }) }), "file_ingress_source_unsupported"],
  ]) {
    await t.test(name, async () => {
      const env = harness({ filesystem });
      const result = await env.service.uploadLocalFile({
        ...TARGET,
        path: "/workspace/artifact.png",
        idempotencyKey: `local-${name}`,
      });
      assert.deepEqual(result, { kind: "invalid", code: expected });
      assert.equal(env.calls.length, 0);
    });
  }
  const traversal = harness();
  assert.deepEqual(
    await traversal.service.uploadLocalFile({
      ...TARGET,
      path: "/workspace/../outside/artifact.png",
      idempotencyKey: "traversal",
    }),
    { kind: "invalid", code: "invalid_path" },
  );
  assert.equal(traversal.calls.length, 0);
});

test("changed snapshots and oversize files never reach transport", async (t) => {
  await t.test("changed snapshot", async () => {
    const env = harness({
      filesystem: fakeFilesystem({
        before: inspection({ snapshotId: "before" }),
        after: inspection({ snapshotId: "after" }),
      }),
    });
    const result = await env.service.uploadLocalFile({
      ...TARGET,
      path: "/workspace/artifact.png",
      idempotencyKey: "changed",
    });
    assert.deepEqual(result, { kind: "invalid", code: "local_companion_file_changed" });
    assert.equal(env.calls.length, 0);
  });
  await t.test("oversize", async () => {
    const env = harness({
      filesystem: fakeFilesystem({
        before: inspection({ size: LOCAL_COMPANION_LIMITS.maxFileBytes + 1 }),
      }),
    });
    const result = await env.service.uploadLocalFile({
      ...TARGET,
      path: "/workspace/artifact.png",
      idempotencyKey: "oversize",
    });
    assert.deepEqual(result, { kind: "invalid", code: "bundle_file_size_limit_exceeded" });
    assert.equal(env.calls.length, 0);
  });
});

test("bounded bytes sniff MIME, reject mismatch and enforce its tighter limit", async (t) => {
  await t.test("happy path", async () => {
    const env = harness({ filesystem: fakeFilesystem() });
    const result = await env.service.upload_bytes({
      ...TARGET,
      bytes: PNG,
      displayFilename: "generated.png",
      claimedMediaType: "image/png",
      idempotencyKey: "bytes-1",
    });
    assert.equal(result.kind, "staged");
    assert.equal(env.calls[0].input.sourceKind, "bounded_in_memory");
  });
  await t.test("MIME mismatch", async () => {
    const env = harness();
    const result = await env.service.upload_bytes({
      ...TARGET,
      bytes: PNG,
      displayFilename: "generated.png",
      claimedMediaType: "application/pdf",
      idempotencyKey: "bytes-mismatch",
    });
    assert.deepEqual(result, { kind: "invalid", code: "bundle_file_media_mismatch" });
    assert.equal(env.calls.length, 0);
  });
  await t.test("bounded limit", async () => {
    const env = harness();
    const result = await env.service.upload_bytes({
      ...TARGET,
      bytes: new Uint8Array(LOCAL_COMPANION_LIMITS.maxBoundedBytes + 1),
      displayFilename: "generated.png",
      idempotencyKey: "bytes-oversize",
    });
    assert.deepEqual(result, { kind: "invalid", code: "local_companion_invalid_bytes" });
    assert.equal(env.calls.length, 0);
  });
});

test("transport retries the identical verified payload and idempotency key", async () => {
  const calls = [];
  let attempt = 0;
  const env = harness({
    maxAttempts: 3,
    transport: {
      async upload(request) {
        calls.push(request);
        attempt += 1;
        if (attempt === 1) {
          throw new LocalCompanionTransportFailure(
            "file_ingress_transport_unavailable",
            "unknown outcome",
            true,
            true,
          );
        }
        return stagedResult(request.input.sourceKind);
      },
    },
  });
  const result = await env.service.upload_bytes({
    ...TARGET,
    bytes: PNG,
    displayFilename: "generated.png",
    idempotencyKey: "retry-exact",
  });
  assert.equal(result.kind, "staged");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].idempotencyKey, calls[1].idempotencyKey);
  assert.deepEqual(calls[0].input.bytes, calls[1].input.bytes);
  assert.equal(calls[0].input.sha256, calls[1].input.sha256);
});

test("authorization, cancellation and cleanup boundaries are fail closed", async (t) => {
  await t.test("authorization denial reads nothing", async () => {
    const filesystem = fakeFilesystem();
    const env = harness({
      filesystem,
      authorize: async () => ({ kind: "denied", code: "forbidden" }),
    });
    const result = await env.service.uploadLocalFile({
      ...TARGET,
      path: "/workspace/artifact.png",
      idempotencyKey: "denied",
    });
    assert.deepEqual(result, { kind: "invalid", code: "local_companion_authorization_denied" });
    assert.equal(filesystem.inspectCount, 0);
  });
  await t.test("cancelled upload does not call transport", async () => {
    const controller = new AbortController();
    controller.abort();
    const env = harness();
    const result = await env.service.upload_bytes({
      ...TARGET,
      bytes: PNG,
      displayFilename: "generated.png",
      idempotencyKey: "cancelled",
      signal: controller.signal,
    });
    assert.deepEqual(result, { kind: "invalid", code: "local_companion_cancelled" });
    assert.equal(env.calls.length, 0);
  });
  await t.test("cleanup is explicit and runs after success", async () => {
    let cleanups = 0;
    const env = harness();
    const result = await env.service.upload_bytes({
      ...TARGET,
      bytes: PNG,
      displayFilename: "generated.png",
      idempotencyKey: "cleanup",
      cleanupMode: "success",
      cleanup: () => { cleanups += 1; },
    });
    assert.equal(result.kind, "staged");
    assert.equal(cleanups, 1);
  });
});
