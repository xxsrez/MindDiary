import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createSitesMetadataStore } from "@mind-diary/adapter-metadata-sites";
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
const PNG_PREFIX = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PRIVATE_PAYLOAD_SENTINEL = "private generated chart payload must not escape";

class StreamingFakeR2Bucket extends FakeR2Bucket {
  async put(key, value, options = {}) {
    if (!(value instanceof ReadableStream)) return super.put(key, value, options);
    const reader = value.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        assert.ok(next.value instanceof Uint8Array);
        const chunk = new Uint8Array(next.value);
        chunks.push(chunk);
        size += chunk.byteLength;
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

function exactPng() {
  const bytes = new Uint8Array(4_194_304);
  bytes.set(PNG_PREFIX);
  bytes.set(new TextEncoder().encode(PRIVATE_PAYLOAD_SENTINEL), 64);
  return bytes;
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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

async function modernTool(runtime, secret, id, name, args, observedBodies) {
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
          name: "mind-diary-md321-hosted-bounded-test",
          version: "0.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  assert.equal(response.status, 200, `${name}: ${await response.clone().text()}`);
  const body = await response.json();
  observedBodies.push(body);
  assert.equal(body.result?.isError, false, `${name}: ${JSON.stringify(body)}`);
  assert.equal(body.result?.structuredContent?.ok, true, name);
  return body.result.structuredContent.data;
}

function stagedObjectCount(bucket) {
  return [...bucket.records.keys()].filter((key) =>
    key.startsWith("staged-bundle-files/")
  ).length;
}

test("Product Site candidate stages bounded bytes privately and publishes only by explicit commit", async () => {
  const database = new FakeD1Database();
  const bucket = new StreamingFakeR2Bucket();
  const telemetryLines = [];
  const observedBodies = [];
  const now = new Date("2026-08-27T20:00:00.000Z");
  const runtime = await createProductSiteRuntime({
    database,
    bucket,
    publicOrigin: ORIGIN,
    identity: {
      readVerifiedIdentity() {
        return {
          kind: "authenticated",
          verifiedEmail: "md321.bounded@example.com",
          verifiedFullName: "MD321 Bounded Producer",
        };
      },
    },
    tokenVerifierKey: deterministicKey(17),
    locatorKey: deterministicKey(57),
    exportDownloadVerifierKey: deterministicKey(97),
    csrfKey: deterministicKey(137),
    now: () => now,
    observabilityWriter: { write(line) { telemetryLines.push(line); } },
    schedule() {},
  });

  assert.equal(Object.isFrozen(runtime.boundedInMemoryIngress), true);
  assert.deepEqual(Object.keys(runtime.boundedInMemoryIngress), ["stage"]);

  const registration = await responseFrom(runtime, new Request(`${ORIGIN}/`));
  const registrationCsrf = csrfFromHtml(await registration.text());
  const bootstrapped = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/account`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": registrationCsrf,
      "idempotency-key": "bootstrap:md321-bounded",
    },
    body: JSON.stringify({ action: "create_isolated_account" }),
  }));
  assert.equal(bootstrapped.status, 200);
  const bootstrapData = (await bootstrapped.json()).data;
  const principalId = bootstrapData.principal_id;
  const session = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/session`));
  const sessionData = (await session.json()).data;

  const settings = await responseFrom(runtime, new Request(`${ORIGIN}/settings/developer/mcp`));
  const csrf = csrfFromHtml(await settings.text());
  const issued = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/mcp-tokens`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": csrf,
      "idempotency-key": "token:md321-bounded",
    },
    body: JSON.stringify({ name: "MD321 bounded", scopes: ["content:write"] }),
  }));
  assert.equal(issued.status, 200);
  const issuedBody = await issued.json();
  const secret = issuedBody.data.secret;
  const personalTokenRef = issuedBody.data.token.personal_token_ref;

  const described = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/me/description`, {
      method: "PATCH",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": csrf,
        "idempotency-key": "description:md321-bounded",
      },
      body: JSON.stringify({
        description: "Durable generated charts explicitly discussed with the user",
        expected_metadata_version: sessionData.personal_mind.metadata_version,
      }),
    },
  ));
  assert.equal(described.status, 200, await described.clone().text());
  const selected = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/me/usage`, {
      method: "PUT",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": csrf,
        "idempotency-key": "usage:md321-bounded",
      },
      body: JSON.stringify({
        usage_mode: "read_write",
        expected_usage_version: 0,
      }),
    },
  ));
  assert.equal(selected.status, 200, await selected.clone().text());

  const minds = await modernTool(
    runtime,
    secret,
    "md321-list",
    "list_minds",
    {},
    observedBodies,
  );
  const personal = minds.minds.find(({ route }) => route === "/me");
  assert.ok(personal);
  const initialHead = personal.head.revision_id;

  const metadata = await createSitesMetadataStore(database);
  const token = await metadata.readMcpTokenMetadataByPresentationRef(
    principalId,
    personalTokenRef,
  );
  assert.ok(token);
  const actor = Object.freeze({
    kind: "registered_principal",
    principalId,
    authentication: Object.freeze({
      kind: "mcp_token",
      tokenId: token.tokenId,
      bindingOwnerId: token.tokenId,
      effectiveScopes: Object.freeze(["content:read", "content:write"]),
    }),
    deploymentCapabilities: MCP_CONTENT_DEPLOYMENT_CAPABILITIES,
    requestId: "request_md321_bounded",
    occurredAtUtc: now.toISOString(),
  });
  const common = Object.freeze({
    actor,
    spaceId: personal.mind_id,
    displayFilename: "private-chart.png",
    claimedMediaType: "image/png",
  });

  const capabilitiesBefore = await modernTool(
    runtime,
    secret,
    "md321-capability-before",
    "get_file_ingress_capabilities",
    {},
    observedBodies,
  );
  assert.deepEqual(
    capabilitiesBefore.sources
      .filter(({ source_kind }) => source_kind === "bounded_in_memory")
      .map(({ source_kind, server_adapter_status, server_transport, max_bytes }) => [
        source_kind,
        server_adapter_status,
        server_transport,
        max_bytes,
      ]),
    [["bounded_in_memory", "not_available", "none", 0]],
  );

  const beforeRejectedObjects = stagedObjectCount(bucket);
  const objectKeysBeforeOversized = [...bucket.records.keys()].sort();
  const oversized = await runtime.boundedInMemoryIngress.stage({
    ...common,
    idempotencyKey: "stage:md321-oversized",
    bytes: new Uint8Array(4_194_305),
  });
  assert.deepEqual(oversized, {
    kind: "invalid",
    code: "generated_artifact_size_limit_exceeded",
  });
  assert.deepEqual([...bucket.records.keys()].sort(), objectKeysBeforeOversized);
  const invalidFilename = await runtime.boundedInMemoryIngress.stage({
    ...common,
    displayFilename: "../private-chart.png",
    idempotencyKey: "stage:md321-invalid-name",
    bytes: PNG_PREFIX,
  });
  assert.deepEqual(invalidFilename, { kind: "invalid", code: "invalid_filename" });
  const disabled = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/me/usage`, {
      method: "PUT",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": csrf,
        "idempotency-key": "usage:md321-disabled",
      },
      body: JSON.stringify({
        usage_mode: "disabled",
        expected_usage_version: 1,
      }),
    },
  ));
  assert.equal(disabled.status, 200, await disabled.clone().text());
  const unavailable = await runtime.boundedInMemoryIngress.stage({
    ...common,
    idempotencyKey: "stage:md321-disabled",
    bytes: PNG_PREFIX,
  });
  assert.equal(unavailable.kind, "denied");
  assert.equal(stagedObjectCount(bucket), beforeRejectedObjects);
  const reenabled = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/me/usage`, {
      method: "PUT",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": csrf,
        "idempotency-key": "usage:md321-reenabled",
      },
      body: JSON.stringify({
        usage_mode: "read_write",
        expected_usage_version: 2,
      }),
    },
  ));
  assert.equal(reenabled.status, 200, await reenabled.clone().text());
  const headAfterRejected = (await modernTool(
    runtime,
    secret,
    "md321-head-after-rejected",
    "list_minds",
    {},
    observedBodies,
  )).minds.find(({ route }) => route === "/me").head.revision_id;
  assert.equal(headAfterRejected, initialHead);

  const bytes = exactPng();
  const digest = sha256(bytes);
  const staged = await runtime.boundedInMemoryIngress.stage({
    ...common,
    idempotencyKey: "stage:md321-exact",
    expectedSize: bytes.byteLength,
    expectedSha256: digest,
    bytes,
    sourceKind: "server_generated",
    providerObjectId: "must-not-cross-adapter",
  });
  assert.equal(staged.kind, "staged");
  assert.equal(staged.record.sourceKind, "bounded_in_memory");
  assert.equal(staged.record.sha256, digest);
  assert.equal(staged.record.size, 4_194_304);
  assert.equal(staged.record.mediaType, "image/png");
  assert.equal(JSON.stringify(staged).includes(PRIVATE_PAYLOAD_SENTINEL), false);
  assert.equal("structuredContent" in staged, false);

  const replayed = await runtime.boundedInMemoryIngress.stage({
    ...common,
    idempotencyKey: "stage:md321-exact",
    expectedSize: bytes.byteLength,
    expectedSha256: digest,
    bytes,
  });
  assert.equal(replayed.kind, "staged");
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.record.stagedFileId, staged.record.stagedFileId);
  const reconciled = await modernTool(
    runtime,
    secret,
    "md321-reconcile-stage",
    "reconcile_file_stage",
    {
      mind: "/me",
      source_kind: "bounded_in_memory",
      display_filename: "private-chart.png",
      claimed_media_type: "image/png",
      media_type: "image/png",
      sha256: digest,
      size: bytes.byteLength,
      idempotency_key: "stage:md321-exact",
      expected_size: bytes.byteLength,
      expected_sha256: digest,
    },
    observedBodies,
  );
  assert.equal(reconciled.status, "staged");
  assert.equal(
    reconciled.staged_file.staged_file_ref,
    staged.record.stagedFileId,
  );
  assert.equal(reconciled.staged_file.expires_at, staged.record.expiresAt);
  assert.equal(reconciled.staged_file.replayed, true);
  const changed = new Uint8Array(bytes);
  changed[changed.byteLength - 1] = 1;
  assert.deepEqual(
    await runtime.boundedInMemoryIngress.stage({
      ...common,
      idempotencyKey: "stage:md321-exact",
      bytes: changed,
    }),
    { kind: "invalid", code: "idempotency_conflict" },
  );

  const beforeCommitHead = (await modernTool(
    runtime,
    secret,
    "md321-before-commit",
    "list_minds",
    {},
    observedBodies,
  )).minds.find(({ route }) => route === "/me").head.revision_id;
  assert.equal(beforeCommitHead, initialHead);
  const committed = await modernTool(
    runtime,
    secret,
    "md321-commit",
    "commit_changeset",
    {
      mind: "/me",
      expected_revision: initialHead,
      idempotency_key: "commit:md321-bounded",
      summary: "Publish one bounded generated chart",
      operations: [{
        type: "create_bundle_file",
        path: "assets/private-chart.png",
        staged_file_ref: staged.record.stagedFileId,
      }],
    },
    observedBodies,
  );
  assert.notEqual(committed.revision.revision_id, initialHead);
  const listed = await modernTool(
    runtime,
    secret,
    "md321-list-files",
    "list_bundle_files",
    {
      mind: "/me",
      revision_selector: {
        kind: "revision",
        revision_id: committed.revision.revision_id,
      },
      limit: 10,
    },
    observedBodies,
  );
  assert.deepEqual(
    listed.files.map(({ path, sha256: fileDigest, size, media_type }) => [
      path,
      fileDigest,
      size,
      media_type,
    ]),
    [["assets/private-chart.png", digest, 4_194_304, "image/png"]],
  );

  const capabilitiesAfter = await modernTool(
    runtime,
    secret,
    "md321-capability-after",
    "get_file_ingress_capabilities",
    {},
    observedBodies,
  );
  const boundedCapability = capabilitiesAfter.sources.find(
    ({ source_kind }) => source_kind === "bounded_in_memory",
  );
  assert.deepEqual(
    [
      boundedCapability.server_adapter_status,
      boundedCapability.server_transport,
      boundedCapability.max_bytes,
    ],
    ["not_available", "none", 0],
  );
  const privacySurface = JSON.stringify({
    telemetryLines,
    observedBodies,
    metadataEvents: database.metadataEvents,
    metadataSnapshot: database.metadataSnapshot,
    metadataSnapshotChunks: [...database.metadataSnapshotChunks.values()],
  });
  assert.equal(privacySurface.includes(PRIVATE_PAYLOAD_SENTINEL), false);
  assert.equal(privacySurface.includes("must-not-cross-adapter"), false);
});
