import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import test from "node:test";

import {
  CONNECTOR_OBJECT_BRIDGE_FORMAT,
  ConnectorObjectCompanionUploader,
  NodeMaterializedConnectorFileSource,
  UploadIntentHttpTransport,
} from "../../scripts/lib/connector-object-upload-bridge.mjs";
import {
  CONNECTOR_OBJECT_BRIDGE_FIXTURES,
} from "../fixtures/connector-object-bridge.mjs";
import { createPrivacySafeObserver } from "../helpers/privacy-safe-observer.mjs";

const SIGNED_HANDLE = "mdupload_v1_privateCapabilityValue1234567890";
const CAPABILITY_URL =
  `https://mind-diary.example/api/file-ingress/upload-intents/${SIGNED_HANDLE}`;
const EXPECTED_ORIGIN = "https://mind-diary.example";
const MATERIALIZATION_ROOT = "/private/tmp";
const PRIVATE_DRIVE_ID = "private_drive_object_id";
const PRIVATE_DRIVE_ACCOUNT = "private_drive_account";
const SENSITIVE_GRANT_VALUE = "private_drive_token";

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function privateState(path, fixture, overrides = {}) {
  return {
    format: CONNECTOR_OBJECT_BRIDGE_FORMAT,
    provider_profile: "google_drive",
    source_kind: "connector_object",
    materialized_file_path: path,
    upload_url: CAPABILITY_URL,
    display_filename: fixture.filename,
    claimed_media_type: fixture.mediaType,
    expected_size: fixture.bytes.byteLength,
    expected_sha256: sha256(fixture.bytes),
    ...overrides,
  };
}

function stagedBody(metadata, replayed = false) {
  return {
    ok: true,
    data: {
      status: "staged",
      staged_file: {
        staged_file_ref: "staged_server_private_ref",
        state: "verified",
        source_kind: "connector_object",
        display_filename: metadata.displayFilename,
        media_type: metadata.mediaType,
        sha256: metadata.sha256,
        size: metadata.size,
        expires_at: "2026-08-24T13:00:00.000Z",
        replayed,
      },
    },
  };
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class FakeUploadIntentServer {
  constructor(expectedBytes, metadata) {
    this.expectedBytes = new Uint8Array(expectedBytes);
    this.metadata = { ...metadata };
  }

  expectedBytes;
  metadata;
  state = "pending";
  mode = "normal";
  putCount = 0;
  getCount = 0;
  lastPut = null;

  fetch = async (url, init = {}) => {
    assert.equal(url, CAPABILITY_URL);
    if (init.method === "GET") {
      this.getCount += 1;
      if (this.state === "expired") {
        return json(410, { ok: false, error: { code: "file_ingress_intent_expired" } });
      }
      if (this.state === "missing") {
        return json(404, { ok: false, error: { code: "file_ingress_source_unavailable" } });
      }
      if (this.state === "rejected") {
        return json(200, {
          ok: true,
          data: { status: "rejected", code: "file_ingress_intent_conflict" },
        });
      }
      return this.state === "staged"
        ? json(200, stagedBody(this.metadata, true))
        : json(200, {
            ok: true,
            data: { status: "pending", expires_at: "2026-08-24T12:10:00.000Z" },
          });
    }

    assert.equal(init.method, "PUT");
    this.putCount += 1;
    const headers = new Headers(init.headers);
    assert.equal(headers.get("content-type"), "application/octet-stream");
    assert.equal(headers.has("authorization"), false);
    assert.equal(headers.has("cookie"), false);
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "manual");
    this.lastPut = new Uint8Array(init.body);

    if (this.state === "expired") {
      return json(410, { ok: false, error: { code: "file_ingress_intent_expired" } });
    }
    if (this.state === "staged") {
      return json(409, { ok: false, error: { code: "file_ingress_intent_conflict" } });
    }
    if (this.mode === "timeout_before_consume") {
      return await new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(
          new Error(`${SENSITIVE_GRANT_VALUE}:${PRIVATE_DRIVE_ID}`),
        ), { once: true });
      });
    }
    if (this.mode === "interrupt_before_consume") {
      throw new Error(`${SENSITIVE_GRANT_VALUE}:${PRIVATE_DRIVE_ACCOUNT}`);
    }
    const bytesMatch = this.lastPut.byteLength === this.expectedBytes.byteLength &&
      this.lastPut.every((value, index) => value === this.expectedBytes[index]);
    if (!bytesMatch) {
      return json(409, { ok: false, error: { code: "file_ingress_intent_conflict" } });
    }
    this.state = "staged";
    if (this.mode === "interrupt_after_consume") {
      throw new Error(`${SENSITIVE_GRANT_VALUE}:${CAPABILITY_URL}`);
    }
    return json(201, stagedBody(this.metadata));
  };
}

function fakeSource(bytes) {
  let current = bytes;
  return {
    set(next) { current = next; },
    async read() { return { kind: "ready", bytes: new Uint8Array(current) }; },
  };
}

function metadata(fixture) {
  return {
    displayFilename: fixture.filename,
    mediaType: fixture.mediaType,
    size: fixture.bytes.byteLength,
    sha256: sha256(fixture.bytes),
  };
}

test("materialized PNG, PDF and opaque ZIP use the exact MD-272 raw intent seam", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mind-diary-md284-bridge-")));
  try {
    for (const fixture of Object.values(CONNECTOR_OBJECT_BRIDGE_FIXTURES)) {
      const path = join(root, `materialized-${fixture.filename}`);
      await writeFile(path, fixture.bytes);
      const server = new FakeUploadIntentServer(fixture.bytes, metadata(fixture));
      const uploader = new ConnectorObjectCompanionUploader({
        expectedOrigin: EXPECTED_ORIGIN,
        materializationRoot: root,
        transport: new UploadIntentHttpTransport({
          expectedOrigin: EXPECTED_ORIGIN,
          fetcher: server.fetch,
        }),
      });
      const receipt = await uploader.upload(privateState(path, fixture));
      assert.equal(receipt.status, "staged");
      assert.equal(receipt.provider_profile, "google_drive");
      assert.equal(receipt.source_kind, "connector_object");
      assert.deepEqual(server.lastPut, fixture.bytes);
      assert.equal(server.putCount, 1);
      assert.equal(server.getCount, 0);
      const observer = createPrivacySafeObserver({
        sensitiveValues: [
          path,
          CAPABILITY_URL,
          SIGNED_HANDLE,
          PRIVATE_DRIVE_ID,
          PRIVATE_DRIVE_ACCOUNT,
          SENSITIVE_GRANT_VALUE,
        ],
      });
      observer.observe("evidence", receipt);
      assert.deepEqual(observer.summary(), { evidence: 1 });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Node materialized-file adapter rejects symlink, directory, special and oversize inputs", async () => {
  const root = await realpath(await mkdtemp("/private/tmp/md284-source-"));
  let socketServer;
  try {
    const file = join(root, "object.png");
    const link = join(root, "object-link.png");
    const directory = join(root, "object-directory.png");
    const socket = join(root, "object-special.png");
    await writeFile(file, CONNECTOR_OBJECT_BRIDGE_FIXTURES.png.bytes);
    await symlink(file, link);
    await mkdir(directory);
    socketServer = createServer();
    await new Promise((resolveListen, rejectListen) => {
      socketServer.once("error", rejectListen);
      socketServer.listen(socket, resolveListen);
    });
    const source = new NodeMaterializedConnectorFileSource({
      materializationRoot: root,
    });
    assert.deepEqual(await source.read(link, { maxBytes: 64 }), { kind: "symlink" });
    assert.deepEqual(await source.read(directory, { maxBytes: 64 }), { kind: "directory" });
    assert.deepEqual(await source.read(socket, { maxBytes: 64 }), { kind: "special" });
    assert.deepEqual(await source.read(file, { maxBytes: 4 }), { kind: "oversize" });
  } finally {
    if (socketServer !== undefined) {
      await new Promise((resolveClose) => socketServer.close(resolveClose));
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted materialization root rejects symlink escapes and invalid roots without consuming capability", async () => {
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), "mind-diary-md284-root-")));
  try {
    const trustedRoot = join(sandbox, "connector-results");
    const outsideRoot = join(sandbox, "outside");
    const linkedDirectory = join(trustedRoot, "linked-result");
    const fixture = CONNECTOR_OBJECT_BRIDGE_FIXTURES.png;
    await mkdir(trustedRoot);
    await mkdir(outsideRoot);
    await writeFile(join(outsideRoot, fixture.filename), fixture.bytes);
    await symlink(outsideRoot, linkedDirectory);

    let consumes = 0;
    const escapedUploader = new ConnectorObjectCompanionUploader({
      expectedOrigin: EXPECTED_ORIGIN,
      materializationRoot: trustedRoot,
      transport: {
        async consume() {
          consumes += 1;
          return { status: "staged" };
        },
      },
    });
    const escapedPath = join(linkedDirectory, fixture.filename);
    const escapedReceipt = await escapedUploader.upload(
      privateState(escapedPath, fixture),
    );
    assert.equal(escapedReceipt.status, "source_unsupported");
    assert.equal(consumes, 0);

    const rootFile = join(sandbox, "not-a-directory");
    const missingRoot = join(sandbox, "missing-root");
    const linkedRoot = join(sandbox, "linked-root");
    await writeFile(rootFile, fixture.bytes);
    await symlink(trustedRoot, linkedRoot);
    for (const materializationRoot of [rootFile, missingRoot, linkedRoot]) {
      let message = null;
      try {
        new ConnectorObjectCompanionUploader({
          expectedOrigin: EXPECTED_ORIGIN,
          materializationRoot,
        });
      } catch (error) {
        message = String(error?.message);
      }
      assert.match(message, /options are invalid/u);
      assert.equal(message.includes(materializationRoot), false);
    }
    assert.equal(consumes, 0);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("GET status is non-consuming; replay, changed, expiry, timeout and interrupted outcomes stay classified", async (t) => {
  const fixture = CONNECTOR_OBJECT_BRIDGE_FIXTURES.png;
  const privatePath = "/private/tmp/md284/materialized.png";
  await t.test("GET is non-consuming", async () => {
    const server = new FakeUploadIntentServer(fixture.bytes, metadata(fixture));
    const transport = new UploadIntentHttpTransport({
      expectedOrigin: EXPECTED_ORIGIN,
      fetcher: server.fetch,
    });
    assert.deepEqual(await transport.inspectStatus({
      uploadUrl: CAPABILITY_URL,
      metadata: metadata(fixture),
    }), { status: "pending" });
    assert.equal(server.getCount, 1);
    assert.equal(server.putCount, 0);
    assert.equal(server.state, "pending");
    server.state = "rejected";
    assert.deepEqual(await transport.inspectStatus({
      uploadUrl: CAPABILITY_URL,
      metadata: metadata(fixture),
    }), { status: "replay_conflict" });
    assert.equal(server.getCount, 2);
    assert.equal(server.putCount, 0);
  });

  await t.test("same retry versus changed payload", async () => {
    const source = fakeSource(fixture.bytes);
    const server = new FakeUploadIntentServer(fixture.bytes, metadata(fixture));
    const uploader = new ConnectorObjectCompanionUploader({
      expectedOrigin: EXPECTED_ORIGIN,
      materializationRoot: MATERIALIZATION_ROOT,
      source,
      transport: new UploadIntentHttpTransport({
        expectedOrigin: EXPECTED_ORIGIN,
        fetcher: server.fetch,
      }),
    });
    assert.equal((await uploader.upload(privateState(privatePath, fixture))).status, "staged");
    assert.equal(
      (await uploader.upload(privateState(privatePath, fixture))).status,
      "already_staged",
    );
    const changedBytes = new Uint8Array(fixture.bytes);
    changedBytes[changedBytes.byteLength - 1] ^= 0xff;
    const changedFixture = { ...fixture, bytes: changedBytes };
    source.set(changedBytes);
    assert.equal(
      (await uploader.upload(privateState(privatePath, changedFixture))).status,
      "changed",
    );
    assert.equal(server.putCount, 3);
    assert.equal(server.getCount, 2);
  });

  await t.test("expired", async () => {
    const server = new FakeUploadIntentServer(fixture.bytes, metadata(fixture));
    server.state = "expired";
    const uploader = new ConnectorObjectCompanionUploader({
      expectedOrigin: EXPECTED_ORIGIN,
      materializationRoot: MATERIALIZATION_ROOT,
      source: fakeSource(fixture.bytes),
      transport: new UploadIntentHttpTransport({
        expectedOrigin: EXPECTED_ORIGIN,
        fetcher: server.fetch,
      }),
    });
    assert.equal(
      (await uploader.upload(privateState(privatePath, fixture))).status,
      "expired",
    );
  });

  await t.test("timeout before consume", async () => {
    const server = new FakeUploadIntentServer(fixture.bytes, metadata(fixture));
    server.mode = "timeout_before_consume";
    const uploader = new ConnectorObjectCompanionUploader({
      expectedOrigin: EXPECTED_ORIGIN,
      materializationRoot: MATERIALIZATION_ROOT,
      source: fakeSource(fixture.bytes),
      transport: new UploadIntentHttpTransport({
        expectedOrigin: EXPECTED_ORIGIN,
        fetcher: server.fetch,
        requestTimeoutMilliseconds: 5,
        statusTimeoutMilliseconds: 20,
      }),
    });
    assert.equal(
      (await uploader.upload(privateState(privatePath, fixture))).status,
      "timeout",
    );
    assert.equal(server.getCount, 1);
    assert.equal(server.state, "pending");
  });

  await t.test("timeout while reading PUT response reconciles pending status", async () => {
    let calls = 0;
    const transport = new UploadIntentHttpTransport({
      expectedOrigin: EXPECTED_ORIGIN,
      requestTimeoutMilliseconds: 5,
      statusTimeoutMilliseconds: 20,
      fetcher: async (_url, init) => {
        calls += 1;
        if (init.method === "GET") {
          return json(200, {
            ok: true,
            data: {
              status: "pending",
              expires_at: "2026-08-24T12:10:00.000Z",
            },
          });
        }
        return new Response(new ReadableStream({ start() {} }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.deepEqual(await transport.consume({
      uploadUrl: CAPABILITY_URL,
      bytes: fixture.bytes,
      metadata: metadata(fixture),
    }), { status: "timeout" });
    assert.equal(calls, 2);
  });

  await t.test("ambiguous PUT and hanging GET use separate finite deadlines", async () => {
    let calls = 0;
    const transport = new UploadIntentHttpTransport({
      expectedOrigin: EXPECTED_ORIGIN,
      requestTimeoutMilliseconds: 5,
      statusTimeoutMilliseconds: 5,
      fetcher: async (_url, init) => {
        calls += 1;
        return await new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(
            new Error(`${SENSITIVE_GRANT_VALUE}:${PRIVATE_DRIVE_ID}`),
          ), { once: true });
        });
      },
    });
    assert.deepEqual(await transport.consume({
      uploadUrl: CAPABILITY_URL,
      bytes: fixture.bytes,
      metadata: metadata(fixture),
    }), { status: "timeout" });
    assert.equal(calls, 2);
    assert.deepEqual(await transport.inspectStatus({
      uploadUrl: CAPABILITY_URL,
      metadata: metadata(fixture),
    }), { status: "status_timeout" });
    assert.equal(calls, 3);
  });

  await t.test("interrupted before consume", async () => {
    const server = new FakeUploadIntentServer(fixture.bytes, metadata(fixture));
    server.mode = "interrupt_before_consume";
    const uploader = new ConnectorObjectCompanionUploader({
      expectedOrigin: EXPECTED_ORIGIN,
      materializationRoot: MATERIALIZATION_ROOT,
      source: fakeSource(fixture.bytes),
      transport: new UploadIntentHttpTransport({
        expectedOrigin: EXPECTED_ORIGIN,
        fetcher: server.fetch,
      }),
    });
    assert.equal(
      (await uploader.upload(privateState(privatePath, fixture))).status,
      "interrupted",
    );
    assert.equal(server.getCount, 1);
  });

  await t.test("interrupted after consume reconciles to staged", async () => {
    const server = new FakeUploadIntentServer(fixture.bytes, metadata(fixture));
    server.mode = "interrupt_after_consume";
    const uploader = new ConnectorObjectCompanionUploader({
      expectedOrigin: EXPECTED_ORIGIN,
      materializationRoot: MATERIALIZATION_ROOT,
      source: fakeSource(fixture.bytes),
      transport: new UploadIntentHttpTransport({
        expectedOrigin: EXPECTED_ORIGIN,
        fetcher: server.fetch,
      }),
    });
    assert.equal(
      (await uploader.upload(privateState(privatePath, fixture))).status,
      "staged_reconciled",
    );
    assert.equal(server.getCount, 1);
    assert.equal(server.state, "staged");
  });
});

test("stdin-only CLI never emits private path, capability or Drive identity", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mind-diary-md284-cli-")));
  try {
    const file = join(root, "private.png");
    const link = join(root, "private-link.png");
    const fixture = CONNECTOR_OBJECT_BRIDGE_FIXTURES.png;
    await writeFile(file, fixture.bytes);
    await symlink(file, link);
    const script = resolve("scripts/run-connector-object-upload-bridge.mjs");
    const input = JSON.stringify(privateState(link, fixture));
    const child = spawn(process.execPath, [script], {
      cwd: resolve("."),
      env: {
        ...process.env,
        MIND_DIARY_CONNECTOR_UPLOAD_ORIGIN: EXPECTED_ORIGIN,
        MIND_DIARY_CONNECTOR_MATERIALIZATION_ROOT: root,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(input);
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });
    const output = Buffer.concat(stdout).toString("utf8");
    const errorOutput = Buffer.concat(stderr).toString("utf8");
    assert.equal(exitCode, 2);
    assert.equal(errorOutput, "");
    assert.equal(JSON.parse(output).status, "source_unsupported");
    for (const sensitive of [
      file,
      link,
      root,
      CAPABILITY_URL,
      SIGNED_HANDLE,
      PRIVATE_DRIVE_ID,
      PRIVATE_DRIVE_ACCOUNT,
      SENSITIVE_GRANT_VALUE,
    ]) {
      assert.equal(output.includes(sensitive), false);
      assert.equal(errorOutput.includes(sensitive), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
