import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  MCP_ENDPOINT,
  MCP_TARGET_PROTOCOL,
} from "../../packages/adapter-mcp/dist/index.js";
import {
  MCP_CONTENT_DEPLOYMENT_CAPABILITIES,
} from "../../packages/application-content/dist/index.js";
import { createProductSiteRuntime } from "../../packages/composition-root/dist/index.js";
import {
  deterministicKey,
  FakeD1Database,
  FakeR2Bucket,
} from "../../scripts/lib/fake-sites-storage.mjs";

const ORIGIN = "https://mind-diary.example";
const INITIAL_TIME = "2026-08-24T09:00:00.000Z";
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
]);
const PNG_CHANGED = Uint8Array.from([...PNG, 0x01]);
const PDF = new TextEncoder().encode("%PDF-1.7\n% generated fixture\n");

class StreamingFakeR2Bucket extends FakeR2Bucket {
  failNextStagedBytePut = false;
  failNextStreamPut = false;

  async put(key, value, options = {}) {
    if (
      this.failNextStagedBytePut &&
      key.startsWith("staged-bundle-files/") &&
      value instanceof Uint8Array
    ) {
      this.failNextStagedBytePut = false;
      throw new Error("injected staged byte writer failure");
    }
    if (!(value instanceof ReadableStream)) return super.put(key, value, options);
    if (this.failNextStreamPut) {
      this.failNextStreamPut = false;
      await value.cancel(new Error("injected stream writer failure")).catch(() => undefined);
      throw new Error("injected stream writer failure");
    }
    const reader = value.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        assert.ok(next.value instanceof Uint8Array);
        const copy = new Uint8Array(next.value);
        chunks.push(copy);
        size += copy.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return super.put(key, bytes, options);
  }
}

function csrfFromHtml(html) {
  const match = /<meta name="mind-diary-csrf-token" content="([^"]+)">/u.exec(html);
  assert.ok(match, "server-rendered page must include a CSRF token");
  return match[1];
}

async function responseFrom(runtime, request) {
  const response = await runtime.fetch(request);
  assert.ok(response instanceof Response);
  return response;
}

async function modernMcp(runtime, secret, body) {
  return responseFrom(runtime, new Request(`${ORIGIN}${MCP_ENDPOINT}`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${secret}`,
      "content-type": "application/json; charset=utf-8",
      "mcp-method": body.method,
      "mcp-protocol-version": MCP_TARGET_PROTOCOL,
      ...(body.method === "tools/call" && typeof body.params?.name === "string"
        ? { "mcp-name": body.params.name }
        : {}),
    },
    body: JSON.stringify(body),
  }));
}

async function modernTool(runtime, secret, id, name, args) {
  const response = await modernMcp(runtime, secret, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": {
          name: "mind-diary-hosted-generated-ingress-test",
          version: "0.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  assert.equal(response.status, 200, name);
  const body = await response.json();
  assert.equal(body.result?.isError, false, `${name}: ${JSON.stringify(body)}`);
  assert.equal(body.result?.structuredContent?.ok, true, name);
  return body.result.structuredContent.data;
}

async function rejectedTool(runtime, secret, id, name, args) {
  const response = await modernMcp(runtime, secret, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": {
          name: "mind-diary-hosted-generated-ingress-test",
          version: "0.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  assert.equal(response.status, 200, name);
  const body = await response.json();
  assert.equal(body.result?.isError, true, JSON.stringify(body));
  assert.equal(body.result?.structuredContent?.ok, false, name);
  return body.result.structuredContent.error;
}

function stagedObjectCount(bucket) {
  return [...bucket.records.keys()].filter((key) =>
    key.startsWith("staged-bundle-files/")
  ).length;
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

test("hosted generated ingress is authorized, durable, privacy-bounded and exact across restart", async () => {
  const database = new FakeD1Database();
  const bucket = new StreamingFakeR2Bucket();
  let currentTime = new Date(INITIAL_TIME);
  const scheduled = [];
  const telemetryLines = [];
  const runtimeOptions = {
    database,
    bucket,
    publicOrigin: ORIGIN,
    identity: {
      readVerifiedIdentity() {
        return {
          kind: "authenticated",
          verifiedEmail: "generated.ingress@example.com",
          verifiedFullName: "Generated Ingress",
        };
      },
    },
    tokenVerifierKey: deterministicKey(17),
    locatorKey: deterministicKey(57),
    exportDownloadVerifierKey: deterministicKey(97),
    csrfKey: deterministicKey(137),
    now: () => currentTime,
    observabilityWriter: { write(line) { telemetryLines.push(line); } },
    schedule(work) { scheduled.push(work); },
  };
  let runtime = await createProductSiteRuntime(runtimeOptions);
  assert.equal(Object.isFrozen(runtime.generatedFileIngress), true);
  assert.deepEqual(Object.keys(runtime.generatedFileIngress).sort(), [
    "stageBoundedInMemory",
    "stageServerGenerated",
  ]);

  const registration = await responseFrom(runtime, new Request(`${ORIGIN}/`));
  const registrationCsrf = csrfFromHtml(await registration.text());
  const bootstrapped = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/account`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": registrationCsrf,
      "idempotency-key": "bootstrap:hosted-generated-ingress",
    },
    body: JSON.stringify({ action: "create_isolated_account" }),
  }));
  assert.equal(bootstrapped.status, 200);
  const principalId = (await bootstrapped.json()).data.principal_id;

  const settings = await responseFrom(runtime, new Request(`${ORIGIN}/settings/mcp`));
  const csrf = csrfFromHtml(await settings.text());
  const issued = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/mcp-tokens`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": csrf,
      "idempotency-key": "token:hosted-generated-ingress",
    },
    body: JSON.stringify({
      name: "Hosted generated ingress",
      scopes: ["content:write"],
    }),
  }));
  assert.equal(issued.status, 200);
  const issuedBody = await issued.json();
  const secret = issuedBody.data.secret;
  const tokenId = issuedBody.data.token.token_id;

  const minds = await modernTool(runtime, secret, "generated-list", "list_minds", {});
  const personal = minds.minds.find(({ route }) => route === "/me");
  assert.ok(personal);
  const binding = await modernTool(
    runtime,
    secret,
    "generated-write-binding",
    "set_write_mind_binding",
    {
      action: "bind",
      mind: "/me",
      expected_binding_version: 0,
      idempotency_key: "binding:hosted-generated-ingress",
    },
  );
  const writeBindingId = binding.current.write_binding_id;

  const actor = () => Object.freeze({
    kind: "registered_principal",
    principalId,
    authentication: Object.freeze({
      kind: "mcp_token",
      tokenId,
      bindingOwnerId: tokenId,
      effectiveScopes: Object.freeze(["content:read", "content:write"]),
    }),
    deploymentCapabilities: MCP_CONTENT_DEPLOYMENT_CAPABILITIES,
    requestId: `request_generated_${currentTime.getTime()}`,
    occurredAtUtc: currentTime.toISOString(),
  });
  const common = () => ({
    actor: actor(),
    spaceId: personal.mind_id,
    writeBindingId,
  });

  const capabilities = await modernTool(
    runtime,
    secret,
    "generated-capabilities",
    "get_file_ingress_capabilities",
    {},
  );
  assert.deepEqual(
    capabilities.sources
      .filter(({ source_kind }) =>
        source_kind === "connector_object" ||
        source_kind === "bounded_in_memory" || source_kind === "server_generated"
      )
      .map(({ source_kind, status, max_bytes }) => [source_kind, status, max_bytes]),
    [
      ["connector_object", "available_hosted", 67_108_864],
      ["bounded_in_memory", "available_hosted", 4_194_304],
      ["server_generated", "available_hosted", 67_108_864],
    ],
  );

  const beforeFailures = stagedObjectCount(bucket);
  const wrongAuthentication = await runtime.generatedFileIngress.stageBoundedInMemory({
    ...common(),
    actor: {
      ...actor(),
      authentication: { kind: "sites_identity" },
    },
    displayFilename: "wrong-auth.png",
    claimedMediaType: "image/png",
    idempotencyKey: "generated:wrong-auth",
    bytes: PNG,
  });
  assert.deepEqual(wrongAuthentication, { kind: "invalid", code: "mcp_token_required" });
  const wrongBinding = await runtime.generatedFileIngress.stageBoundedInMemory({
    ...common(),
    writeBindingId: "write-binding-wrong",
    displayFilename: "wrong-binding.png",
    claimedMediaType: "image/png",
    idempotencyKey: "generated:wrong-binding",
    bytes: PNG,
  });
  assert.equal(wrongBinding.kind, "denied");
  const oversized = await runtime.generatedFileIngress.stageBoundedInMemory({
    ...common(),
    displayFilename: "oversized.png",
    claimedMediaType: "image/png",
    idempotencyKey: "generated:oversized",
    bytes: new Uint8Array(4_194_305),
  });
  assert.deepEqual(oversized, {
    kind: "invalid",
    code: "generated_artifact_size_limit_exceeded",
  });
  const cancelledController = new AbortController();
  const cancelled = await runtime.generatedFileIngress.stageServerGenerated({
    ...common(),
    displayFilename: "cancelled.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "generated:cancelled",
    signal: cancelledController.signal,
    stream: (async function* () {
      yield PDF.subarray(0, 5);
      cancelledController.abort();
      yield PDF.subarray(5);
    })(),
  });
  assert.deepEqual(cancelled, { kind: "invalid", code: "generated_artifact_cancelled" });
  const mismatch = await runtime.generatedFileIngress.stageServerGenerated({
    ...common(),
    displayFilename: "mismatch.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "generated:mismatch",
    stream: (async function* () { yield PNG; })(),
  });
  assert.deepEqual(mismatch, { kind: "invalid", code: "bundle_file_media_mismatch" });
  bucket.failNextStagedBytePut = true;
  const boundedWriterFailure = await runtime.generatedFileIngress.stageBoundedInMemory({
    ...common(),
    displayFilename: "bounded-writer-failure.png",
    claimedMediaType: "image/png",
    idempotencyKey: "generated:bounded-writer-failure",
    bytes: PNG,
  });
  assert.deepEqual(boundedWriterFailure, {
    kind: "invalid",
    code: "generated_artifact_storage_unavailable",
  });
  bucket.failNextStreamPut = true;
  const writerFailure = await runtime.generatedFileIngress.stageServerGenerated({
    ...common(),
    displayFilename: "writer-failure.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "generated:writer-failure",
    stream: (async function* () { yield PDF; })(),
  });
  assert.deepEqual(writerFailure, {
    kind: "invalid",
    code: "generated_artifact_streaming_unavailable",
  });
  assert.equal(stagedObjectCount(bucket), beforeFailures);

  const privacySentinels = {
    localPath: "/private/secret/generated.png",
    providerObjectId: "provider-secret-object",
    sourceUrl: "https://provider.invalid/private-object",
    prompt: "private generation prompt",
  };
  const bounded = await runtime.generatedFileIngress.stageBoundedInMemory({
    ...common(),
    displayFilename: "bounded.png",
    claimedMediaType: "image/png",
    idempotencyKey: "generated:bounded",
    expectedSize: PNG.byteLength,
    expectedSha256: sha256(PNG),
    bytes: PNG,
    sourceKind: "connector_object",
    ...privacySentinels,
  });
  assert.equal(bounded.kind, "staged");
  assert.equal(bounded.record.sourceKind, "bounded_in_memory");
  assert.equal(bounded.record.sha256, sha256(PNG));
  assert.equal(bounded.record.size, PNG.byteLength);
  assert.equal(
    Date.parse(bounded.record.expiresAt) - Date.parse(bounded.record.createdAt),
    60 * 60 * 1_000,
  );

  const stagedBeforeRestart = stagedObjectCount(bucket);
  runtime = await createProductSiteRuntime(runtimeOptions);
  const replayed = await runtime.generatedFileIngress.stageBoundedInMemory({
    ...common(),
    displayFilename: "bounded.png",
    claimedMediaType: "image/png",
    idempotencyKey: "generated:bounded",
    expectedSize: PNG.byteLength,
    expectedSha256: sha256(PNG),
    bytes: PNG,
  });
  assert.equal(replayed.kind, "staged");
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.record.stagedFileId, bounded.record.stagedFileId);
  assert.equal(stagedObjectCount(bucket), stagedBeforeRestart);

  const changedRetry = await runtime.generatedFileIngress.stageBoundedInMemory({
    ...common(),
    displayFilename: "bounded.png",
    claimedMediaType: "image/png",
    idempotencyKey: "generated:bounded",
    bytes: PNG_CHANGED,
  });
  assert.deepEqual(changedRetry, { kind: "invalid", code: "idempotency_conflict" });
  assert.equal(stagedObjectCount(bucket), stagedBeforeRestart);

  const serverGenerated = await runtime.generatedFileIngress.stageServerGenerated({
    ...common(),
    displayFilename: "server-generated.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "generated:server-stream",
    expectedSize: PDF.byteLength,
    expectedSha256: sha256(PDF),
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(PDF.subarray(0, 7));
        controller.enqueue(PDF.subarray(7));
        controller.close();
      },
    }),
    ...privacySentinels,
  });
  assert.equal(serverGenerated.kind, "staged");
  assert.equal(serverGenerated.record.sourceKind, "server_generated");
  assert.equal(serverGenerated.record.sha256, sha256(PDF));
  assert.equal(serverGenerated.record.size, PDF.byteLength);

  const serializedStaging = JSON.stringify({
    bounded: bounded.record,
    serverGenerated: serverGenerated.record,
    r2: [...bucket.records.values()].map(({ key, customMetadata }) => ({
      key,
      customMetadata,
    })),
  });
  for (const forbidden of Object.values(privacySentinels)) {
    assert.equal(serializedStaging.includes(forbidden), false, forbidden);
  }
  assert.equal(serializedStaging.includes(secret), false);

  const committed = await modernTool(
    runtime,
    secret,
    "generated-commit",
    "commit_changeset",
    {
      mind: "/me",
      write_binding_id: writeBindingId,
      expected_revision: personal.head.revision_id,
      idempotency_key: "commit:hosted-generated-ingress",
      summary: "Publish generated files atomically",
      operations: [
        {
          type: "create_bundle_file",
          path: "assets/bounded.png",
          staged_file_ref: bounded.record.stagedFileId,
        },
        {
          type: "create_bundle_file",
          path: "assets/server-generated.pdf",
          staged_file_ref: serverGenerated.record.stagedFileId,
        },
        {
          type: "create_file",
          path: "concepts/generated-ingress.md",
          text: [
            "---",
            "type: Reference",
            "title: Generated ingress",
            "---",
            "",
            "# Generated ingress",
            "",
            "![Bounded asset](../assets/bounded.png)",
            "",
          ].join("\n"),
        },
      ],
    },
  );
  const generatedRevisionId = committed.revision.revision_id;
  assert.notEqual(generatedRevisionId, personal.head.revision_id);

  runtime = await createProductSiteRuntime(runtimeOptions);
  const advanced = await modernTool(
    runtime,
    secret,
    "generated-advance-head",
    "commit_changeset",
    {
      mind: "/me",
      write_binding_id: writeBindingId,
      expected_revision: generatedRevisionId,
      idempotency_key: "commit:advance-generated-history",
      summary: "Advance HEAD after generated file publication",
      operations: [{
        type: "replace_file",
        path: "concepts/generated-ingress.md",
        text: [
          "---",
          "type: Reference",
          "title: Generated ingress",
          "---",
          "",
          "# Generated ingress",
          "",
          "Historical generated assets remain exact.",
          "",
        ].join("\n"),
      }],
    },
  );
  assert.notEqual(advanced.revision.revision_id, generatedRevisionId);
  runtime = await createProductSiteRuntime(runtimeOptions);
  const listed = await modernTool(
    runtime,
    secret,
    "generated-list-after-restart",
    "list_bundle_files",
    {
      mind: "/me",
      revision_selector: { kind: "revision", revision_id: generatedRevisionId },
      limit: 10,
    },
  );
  assert.deepEqual(
    listed.files.map(({ path, sha256: digest, size }) => [path, digest, size]),
    [
      ["assets/bounded.png", sha256(PNG), PNG.byteLength],
      ["assets/server-generated.pdf", sha256(PDF), PDF.byteLength],
    ],
  );
  for (const [path, expected] of [
    ["assets/bounded.png", PNG],
    ["assets/server-generated.pdf", PDF],
  ]) {
    const grant = await modernTool(
      runtime,
      secret,
      `generated-download-${path}`,
      "get_bundle_file_download",
      {
        mind: "/me",
        revision_selector: { kind: "revision", revision_id: generatedRevisionId },
        path,
      },
    );
    const downloaded = await responseFrom(runtime, new Request(grant.download_url));
    assert.equal(downloaded.status, 200);
    assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), expected);
  }

  const beforeExpiryHead = (await modernTool(
    runtime,
    secret,
    "generated-head-before-expiry",
    "list_minds",
    {},
  )).minds.find(({ route }) => route === "/me").head.revision_id;
  const expiring = await runtime.generatedFileIngress.stageBoundedInMemory({
    ...common(),
    displayFilename: "expiring.png",
    claimedMediaType: "image/png",
    idempotencyKey: "generated:expiring",
    bytes: PNG_CHANGED,
  });
  assert.equal(expiring.kind, "staged");
  currentTime = new Date(Date.parse(expiring.record.expiresAt) + 1);
  const expiredCommit = await rejectedTool(
    runtime,
    secret,
    "generated-expired-commit",
    "commit_changeset",
    {
      mind: "/me",
      write_binding_id: writeBindingId,
      expected_revision: beforeExpiryHead,
      idempotency_key: "commit:expired-generated-ingress",
      summary: "Must not publish an expired generated ref",
      operations: [{
        type: "create_bundle_file",
        path: "assets/expired.png",
        staged_file_ref: expiring.record.stagedFileId,
      }],
    },
  );
  assert.equal(expiredCommit.code, "staged_bundle_file_expired");
  const afterExpiryHead = (await modernTool(
    runtime,
    secret,
    "generated-head-after-expiry",
    "list_minds",
    {},
  )).minds.find(({ route }) => route === "/me").head.revision_id;
  assert.equal(afterExpiryHead, beforeExpiryHead);

  assert.ok(scheduled.some(({ kind }) => kind === "revision_index"));
  const durablePrivacySurface = JSON.stringify({
    metadataSnapshot: database.metadataSnapshot,
    metadataSnapshotChunks: [...database.metadataSnapshotChunks.values()],
    telemetry: telemetryLines,
  });
  for (const forbidden of [...Object.values(privacySentinels), secret]) {
    assert.equal(durablePrivacySurface.includes(forbidden), false, forbidden);
  }
});
