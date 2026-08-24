import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CONNECTOR_OBJECT_BRIDGE_FORMAT,
  ConnectorObjectCompanionUploader,
  MD272_UPLOAD_INTENT_WIRE,
  UploadIntentHttpTransport,
  isValidUploadCapabilityUrl,
  parseConnectorObjectPrivateState,
} from "../../scripts/lib/connector-object-upload-bridge.mjs";
import { createPrivacySafeObserver } from "../helpers/privacy-safe-observer.mjs";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x01, 0x02, 0x03,
]);
const PDF = new TextEncoder().encode("%PDF-1.7\nbridge fixture\n");
const PRIVATE_PATH = "/private/tmp/md284/drive-object.bin";
const CAPABILITY_URL =
  "https://mind-diary.example/api/file-ingress/upload-intents/mdupload_v1_privateSignedCapability123456";
const EXPECTED_ORIGIN = "https://mind-diary.example";
const MATERIALIZATION_ROOT = "/private/tmp";
const DRIVE_ID = "private_drive_object_id";
const DRIVE_ACCOUNT = "private_drive_account";
const SENSITIVE_GRANT_VALUE = "private_drive_token";

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function state(overrides = {}) {
  return {
    format: CONNECTOR_OBJECT_BRIDGE_FORMAT,
    provider_profile: "google_drive",
    source_kind: "connector_object",
    materialized_file_path: PRIVATE_PATH,
    upload_url: CAPABILITY_URL,
    display_filename: "drive-object.png",
    claimed_media_type: "image/png",
    expected_size: PNG.byteLength,
    expected_sha256: sha256(PNG),
    ...overrides,
  };
}

function uploader({ sourceResult = { kind: "ready", bytes: PNG }, transport, maxFileBytes } = {}) {
  const calls = [];
  const service = new ConnectorObjectCompanionUploader({
    expectedOrigin: EXPECTED_ORIGIN,
    materializationRoot: MATERIALIZATION_ROOT,
    source: {
      async read(path, options) {
        calls.push({ kind: "source", path, options });
        return sourceResult;
      },
    },
    transport: transport ?? {
      async consume(request) {
        calls.push({ kind: "transport", request });
        return { status: "staged" };
      },
    },
    ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
  });
  return { calls, service };
}

test("MD-272 integration seam pins the exact MCP input and private HTTP lifecycle", () => {
  assert.deepEqual(MD272_UPLOAD_INTENT_WIRE.issueInputFields, [
    "write_binding_id",
    "source_kind",
    "display_filename",
    "claimed_media_type",
    "expected_size",
    "expected_sha256",
    "idempotency_key",
  ]);
  assert.deepEqual(MD272_UPLOAD_INTENT_WIRE.issueOutputFields, [
    "upload_url",
    "expires_at",
    "replayed",
  ]);
  assert.equal(MD272_UPLOAD_INTENT_WIRE.sourceKind, "connector_object");
  assert.equal(MD272_UPLOAD_INTENT_WIRE.method, "PUT");
  assert.equal(MD272_UPLOAD_INTENT_WIRE.statusMethod, "GET");
  assert.equal(MD272_UPLOAD_INTENT_WIRE.authorization, "none");
  assert.equal(MD272_UPLOAD_INTENT_WIRE.intentTtlSeconds, 600);
  assert.deepEqual(MD272_UPLOAD_INTENT_WIRE.errorStatuses, {
    file_ingress_intent_conflict: 409,
    file_ingress_intent_expired: 410,
    file_ingress_source_unavailable: 404,
    transient_unavailable: 503,
  });
});

test("verified connector bytes cross only the private capability transport and emit a classification receipt", async () => {
  const env = uploader();
  const receipt = await env.service.upload(state());
  assert.deepEqual(receipt, {
    format: "mind-diary-connector-object-upload-receipt-v1",
    provider_profile: "google_drive",
    source_kind: "connector_object",
    status: "staged",
    safe_filename: "drive-object.png",
    media_type: "image/png",
    size: PNG.byteLength,
    sha256: sha256(PNG),
  });
  assert.equal(env.calls.length, 2);
  assert.equal(env.calls[0].path, PRIVATE_PATH);
  assert.equal(env.calls[1].request.uploadUrl, CAPABILITY_URL);
  assert.deepEqual(env.calls[1].request.bytes, PNG);
  assert.deepEqual(env.calls[1].request.metadata, {
    displayFilename: "drive-object.png",
    mediaType: "image/png",
    size: PNG.byteLength,
    sha256: sha256(PNG),
  });
  assert.equal("path" in env.calls[1].request, false);
  assert.equal("providerProfile" in env.calls[1].request, false);

  const observer = createPrivacySafeObserver({
    sensitiveValues: [
      PRIVATE_PATH,
      CAPABILITY_URL,
      DRIVE_ID,
      DRIVE_ACCOUNT,
      SENSITIVE_GRANT_VALUE,
    ],
  });
  observer.observe("evidence", receipt);
  assert.deepEqual(observer.summary(), { evidence: 1 });
});

test("changed, symlink, directory, special, missing and oversize sources stop before capability consumption", async (t) => {
  for (const [kind, expectedStatus] of [
    ["changed", "changed"],
    ["symlink", "source_unsupported"],
    ["directory", "source_unsupported"],
    ["special", "source_unsupported"],
    ["missing", "source_unavailable"],
    ["oversize", "oversize"],
  ]) {
    await t.test(kind, async () => {
      const env = uploader({ sourceResult: { kind } });
      const receipt = await env.service.upload(state());
      assert.equal(receipt.status, expectedStatus);
      assert.equal(env.calls.some((call) => call.kind === "transport"), false);
    });
  }
  const limited = uploader({ maxFileBytes: PNG.byteLength - 1 });
  const oversizeIntent = await limited.service.upload(state());
  assert.equal(oversizeIntent.status, "oversize");
  assert.equal(limited.calls.length, 0);
});

test("MIME, extension, size and SHA are revalidated against exact materialized bytes", async (t) => {
  await t.test("MIME mismatch", async () => {
    const env = uploader({ sourceResult: { kind: "ready", bytes: PDF } });
    const receipt = await env.service.upload(state({
      display_filename: "drive-object.pdf",
      claimed_media_type: "image/png",
      expected_size: PDF.byteLength,
      expected_sha256: sha256(PDF),
    }));
    assert.equal(receipt.status, "mime_mismatch");
    assert.equal(env.calls.some((call) => call.kind === "transport"), false);
  });
  await t.test("extension mismatch", async () => {
    const env = uploader();
    const receipt = await env.service.upload(state({ display_filename: "drive-object.pdf" }));
    assert.equal(receipt.status, "mime_mismatch");
    assert.equal(env.calls.some((call) => call.kind === "transport"), false);
  });
  for (const overrides of [
    { expected_size: PNG.byteLength + 1 },
    { expected_sha256: `sha256:${"0".repeat(64)}` },
  ]) {
    await t.test(Object.keys(overrides)[0], async () => {
      const env = uploader();
      const receipt = await env.service.upload(state(overrides));
      assert.equal(receipt.status, "changed");
      assert.equal(env.calls.some((call) => call.kind === "transport"), false);
    });
  }
});

test("private state is exact and rejects provider identity, arbitrary URL and CLI-shaped extras", () => {
  assert.ok(parseConnectorObjectPrivateState(
    state(),
    EXPECTED_ORIGIN,
    MATERIALIZATION_ROOT,
  ));
  assert.equal(isValidUploadCapabilityUrl(CAPABILITY_URL, EXPECTED_ORIGIN), true);
  assert.equal(isValidUploadCapabilityUrl(
    "https://evil.example/api/file-ingress/upload-intents/mdupload_v1_attackCapability123456",
    EXPECTED_ORIGIN,
  ), false);
  for (const candidate of [
    { ...state(), drive_file_id: DRIVE_ID },
    { ...state(), drive_account: DRIVE_ACCOUNT },
    { ...state(), access_token: SENSITIVE_GRANT_VALUE },
    { ...state(), file_uri: { id: DRIVE_ID } },
    { ...state(), workspace_path: PRIVATE_PATH },
    { ...state(), base64: "iVBORw0KGgo=" },
    { ...state(), upload_url: "https://drive.google.com/file/d/private" },
    { ...state(), upload_url: `${CAPABILITY_URL}?redirect=https://example.com` },
    { ...state(), source_kind: "local_path" },
  ]) {
    assert.equal(parseConnectorObjectPrivateState(
      candidate,
      EXPECTED_ORIGIN,
      MATERIALIZATION_ROOT,
    ), null);
  }
});

test("trusted materialization root rejects traversal and sibling paths before source access", async () => {
  const env = uploader();
  for (const materialized_file_path of [
    `${MATERIALIZATION_ROOT}/../sibling/drive-object.png`,
    `${MATERIALIZATION_ROOT}-sibling/drive-object.png`,
    MATERIALIZATION_ROOT,
  ]) {
    const receipt = await env.service.upload(state({ materialized_file_path }));
    assert.equal(receipt.status, "invalid_private_state");
  }
  assert.equal(env.calls.length, 0);
  for (const materializationRoot of [
    "/",
    `${MATERIALIZATION_ROOT}/`,
    `${MATERIALIZATION_ROOT}/../md284`,
  ]) {
    assert.equal(parseConnectorObjectPrivateState(
      state(),
      EXPECTED_ORIGIN,
      materializationRoot,
    ), null);
    assert.throws(
      () => new ConnectorObjectCompanionUploader({
        expectedOrigin: EXPECTED_ORIGIN,
        materializationRoot,
      }),
      /options are invalid/u,
    );
  }
});

test("trusted origin pin rejects a path-shaped capability before reading private bytes", async () => {
  const env = uploader();
  const receipt = await env.service.upload(state({
    upload_url:
      "https://evil.example/api/file-ingress/upload-intents/mdupload_v1_attackCapability123456",
  }));
  assert.equal(receipt.status, "invalid_private_state");
  assert.equal(env.calls.length, 0);
});

test("HTTP transport performs one raw unauthenticated no-redirect PUT and discards staged refs", async () => {
  const calls = [];
  const metadata = {
    displayFilename: "drive-object.png",
    mediaType: "image/png",
    size: PNG.byteLength,
    sha256: sha256(PNG),
  };
  const transport = new UploadIntentHttpTransport({
    expectedOrigin: EXPECTED_ORIGIN,
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        ok: true,
        data: {
          status: "staged",
          staged_file: {
            staged_file_ref: "staged_private_ref",
            state: "verified",
            source_kind: "connector_object",
            display_filename: metadata.displayFilename,
            media_type: metadata.mediaType,
            sha256: metadata.sha256,
            size: metadata.size,
            expires_at: "2026-08-24T12:00:00.000Z",
            replayed: false,
          },
        },
      }), { status: 201, headers: { "content-type": "application/json" } });
    },
  });
  const result = await transport.consume({
    uploadUrl: CAPABILITY_URL,
    bytes: PNG,
    metadata,
  });
  assert.deepEqual(result, { status: "staged" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CAPABILITY_URL);
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.credentials, "omit");
  assert.deepEqual(calls[0].init.body, PNG);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("content-type"), "application/octet-stream");
  assert.equal(headers.has("authorization"), false);
  assert.equal(headers.has("cookie"), false);
  assert.doesNotMatch(JSON.stringify(result), /staged_private_ref/u);
});

test("HTTP transport rejects a staged response missing required receipt fields", async () => {
  const calls = [];
  const malformed = {
    ok: true,
    data: {
      status: "staged",
      staged_file: {
        state: "verified",
        source_kind: "connector_object",
        display_filename: "drive-object.png",
        media_type: "image/png",
        sha256: sha256(PNG),
        size: PNG.byteLength,
      },
    },
  };
  const transport = new UploadIntentHttpTransport({
    expectedOrigin: EXPECTED_ORIGIN,
    fetcher: async (_url, init) => {
      calls.push(init.method);
      return new Response(JSON.stringify(malformed), {
        status: init.method === "PUT" ? 201 : 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const result = await transport.consume({
    uploadUrl: CAPABILITY_URL,
    bytes: PNG,
    metadata: {
      displayFilename: "drive-object.png",
      mediaType: "image/png",
      size: PNG.byteLength,
      sha256: sha256(PNG),
    },
  });
  assert.deepEqual(result, { status: "unavailable" });
  assert.deepEqual(calls, ["PUT", "GET"]);
});
