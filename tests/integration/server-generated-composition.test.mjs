import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  MCP_ENDPOINT,
  MCP_TARGET_PROTOCOL,
} from "@mind-diary/adapter-mcp";
import { createSitesMetadataStore } from "@mind-diary/adapter-metadata-sites";
import {
  MCP_CONTENT_DEPLOYMENT_CAPABILITIES,
} from "@mind-diary/application-content";
import { createProductSiteRuntime } from "@mind-diary/composition-root";
import {
  deterministicKey,
  FakeD1Database,
  FakeR2Bucket,
} from "../../scripts/lib/fake-sites-storage.mjs";

const ORIGIN = "https://mind-diary.example";
const NOW = "2026-08-27T20:00:00.000Z";
const PDF = new TextEncoder().encode("%PDF-1.7\n% privacy-safe generated fixture\n");

class StreamingFakeR2Bucket extends FakeR2Bucket {
  reads = 0;
  writes = 0;
  deletes = 0;

  async get(key) {
    this.reads += 1;
    return super.get(key);
  }

  async put(key, value, options = {}) {
    this.writes += 1;
    if (!(value instanceof ReadableStream)) return super.put(key, value, options);
    const reader = value.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        assert.ok(next.value instanceof Uint8Array);
        chunks.push(new Uint8Array(next.value));
        size += next.value.byteLength;
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

  async delete(keyOrKeys) {
    this.deletes += 1;
    return super.delete(keyOrKeys);
  }
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function csrfFromHtml(html) {
  const match = /<meta name="mind-diary-csrf-token" content="([^"]+)">/u.exec(html);
  assert.ok(match);
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
          name: "mind-diary-server-generated-composition-test",
          version: "0.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  assert.equal(response.status, 200, name);
  const body = await response.json();
  assert.equal(body.result?.isError, false, `${name}: ${JSON.stringify(body)}`);
  return body.result.structuredContent.data;
}

function stagedObjectCount(bucket) {
  return [...bucket.records.keys()].filter((key) =>
    key.startsWith("staged-bundle-files/")
  ).length;
}

test("hosted composition stages one trusted stream and reuses commit/history/download/Web export", async () => {
  const database = new FakeD1Database();
  const bucket = new StreamingFakeR2Bucket();
  const scheduled = [];
  const telemetry = [];
  const runtimeOptions = {
    database,
    bucket,
    publicOrigin: ORIGIN,
    identity: {
      readVerifiedIdentity() {
        return {
          kind: "authenticated",
          verifiedEmail: "generated.composition@example.com",
          verifiedFullName: "Generated Composition",
        };
      },
    },
    tokenVerifierKey: deterministicKey(11),
    locatorKey: deterministicKey(51),
    exportDownloadVerifierKey: deterministicKey(91),
    csrfKey: deterministicKey(131),
    now: () => new Date(NOW),
    observabilityWriter: { write(line) { telemetry.push(line); } },
    schedule(work) { scheduled.push(work); },
  };
  let runtime = await createProductSiteRuntime(runtimeOptions);
  assert.equal(Object.isFrozen(runtime.serverGeneratedIngress), true);
  assert.deepEqual(Object.keys(runtime.serverGeneratedIngress), ["stage"]);

  const registration = await responseFrom(runtime, new Request(`${ORIGIN}/`));
  const bootstrapCsrf = csrfFromHtml(await registration.text());
  const bootstrap = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/account`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": bootstrapCsrf,
      "idempotency-key": "bootstrap:server-generated-composition",
    },
    body: JSON.stringify({ action: "create_isolated_account" }),
  }));
  assert.equal(bootstrap.status, 200);
  const principalId = (await bootstrap.json()).data.principal_id;
  const session = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/session`));
  const sessionData = (await session.json()).data;
  const initialRevisionId = sessionData.personal_mind.head_revision_id;
  const spaceId = sessionData.personal_mind.mind_id;

  const settings = await responseFrom(runtime, new Request(`${ORIGIN}/settings/developer/mcp`));
  const csrf = csrfFromHtml(await settings.text());
  const issued = await responseFrom(runtime, new Request(`${ORIGIN}/api/v1/mcp-tokens`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": csrf,
      "idempotency-key": "token:server-generated-composition",
    },
    body: JSON.stringify({ name: "Generated composition", scopes: ["content:write"] }),
  }));
  assert.equal(issued.status, 200);
  const issuedData = (await issued.json()).data;
  const secret = issuedData.secret;
  const personalTokenRef = issuedData.token.personal_token_ref;

  const selected = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/mcp-tokens/${encodeURIComponent(personalTokenRef)}/mind-access`,
    {
      method: "PATCH",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": csrf,
        "idempotency-key": "target:server-generated-composition",
      },
      body: JSON.stringify({
        action: "select_write",
        mind_ref: "/me",
        expected_target_version: 0,
      }),
    },
  ));
  assert.equal(selected.status, 200, await selected.clone().text());

  const capabilities = await modernTool(
    runtime,
    secret,
    "generated-capabilities",
    "get_file_ingress_capabilities",
    {},
  );
  assert.deepEqual(
    capabilities.sources.find(({ source_kind }) => source_kind === "server_generated"),
    {
      source_kind: "server_generated",
      server_adapter_status: "not_available",
      server_transport: "none",
      requires_writable_target: false,
      max_bytes: 0,
      fallback: "none",
    },
  );
  const listedTools = await modernMcp(runtime, secret, {
    jsonrpc: "2.0",
    id: "generated-tool-list",
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": {
          name: "mind-diary-server-generated-composition-test",
          version: "0.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  const toolNames = (await listedTools.json()).result.tools.map(({ name }) => name);
  assert.equal(toolNames.some((name) => /server_generated|generated.*stage/iu.test(name)), false);
  assert.equal(toolNames.some((name) => /export/iu.test(name)), false);

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
      effectiveScopes: token.scopes,
    }),
    deploymentCapabilities: MCP_CONTENT_DEPLOYMENT_CAPABILITIES,
    requestId: "request_server_generated_composition",
    occurredAtUtc: NOW,
  });
  const common = {
    actor,
    spaceId,
    displayFilename: "safe-generated.pdf",
    expectedMediaType: "application/pdf; charset=binary",
    expectedSize: PDF.byteLength,
    expectedSha256: sha256(PDF),
  };

  const beforeFailedStage = stagedObjectCount(bucket);
  const failed = await runtime.serverGeneratedIngress.stage({
    ...common,
    idempotencyKey: "stage:server-generated-failure",
    producer: () => (async function* () {
      yield PDF.subarray(0, 8);
      throw new Error("private producer failure");
    })(),
  });
  assert.deepEqual(failed, {
    kind: "invalid",
    code: "generated_artifact_streaming_unavailable",
  });
  assert.equal(stagedObjectCount(bucket), beforeFailedStage);

  const objectsBeforeTargetRace = stagedObjectCount(bucket);
  const objectCallsBeforeTargetRace = {
    reads: bucket.reads,
    writes: bucket.writes,
    deletes: bucket.deletes,
  };
  const allocatedReservationsBeforeTargetRace = (
    await (await createSitesMetadataStore(database)).listCapacityReservationsForTest()
  ).filter(({ state }) => state !== "released");
  let targetRaceProducerInvocations = 0;
  const targetRace = await runtime.serverGeneratedIngress.stage({
    ...common,
    idempotencyKey: "stage:server-generated-target-race",
    producer: async () => {
      targetRaceProducerInvocations += 1;
      const cleared = await responseFrom(runtime, new Request(
        `${ORIGIN}/api/v1/mcp-tokens/${encodeURIComponent(personalTokenRef)}/mind-access`,
        {
          method: "PATCH",
          headers: {
            origin: ORIGIN,
            "content-type": "application/json",
            "x-csrf-token": csrf,
            "idempotency-key": "target:server-generated-race-clear",
          },
          body: JSON.stringify({
            action: "clear_write",
            expected_target_version: 1,
          }),
        },
      ));
      assert.equal(cleared.status, 200, await cleared.clone().text());
      const reselected = await responseFrom(runtime, new Request(
        `${ORIGIN}/api/v1/mcp-tokens/${encodeURIComponent(personalTokenRef)}/mind-access`,
        {
          method: "PATCH",
          headers: {
            origin: ORIGIN,
            "content-type": "application/json",
            "x-csrf-token": csrf,
            "idempotency-key": "target:server-generated-race-reselect",
          },
          body: JSON.stringify({
            action: "select_write",
            mind_ref: "/me",
            expected_target_version: 2,
          }),
        },
      ));
      assert.equal(reselected.status, 200, await reselected.clone().text());
      return (async function* () { yield PDF; })();
    },
  });
  assert.deepEqual(targetRace, {
    kind: "invalid",
    code: "writable_target_unavailable",
  });
  assert.equal(targetRaceProducerInvocations, 1);
  assert.equal(stagedObjectCount(bucket), objectsBeforeTargetRace);
  assert.deepEqual({
    reads: bucket.reads,
    writes: bucket.writes,
    deletes: bucket.deletes,
  }, objectCallsBeforeTargetRace);
  assert.deepEqual(
    (await (await createSitesMetadataStore(database)).listCapacityReservationsForTest())
      .filter(({ state }) => state !== "released"),
    allocatedReservationsBeforeTargetRace,
  );

  const wrongMediaKey = "stage:server-generated-media-correction";
  const metadataBeforeWrongMedia = await createSitesMetadataStore(database);
  const idempotencyBeforeWrongMedia = await metadataBeforeWrongMedia
    .listIdempotencyRecordsForTest();
  const allocatedReservationsBeforeWrongMedia = (
    await metadataBeforeWrongMedia.listCapacityReservationsForTest()
  ).filter(({ state }) => state !== "released");
  const objectsBeforeWrongMedia = stagedObjectCount(bucket);
  let wrongMediaProducerInvocations = 0;
  const wrongMedia = await runtime.serverGeneratedIngress.stage({
    ...common,
    expectedMediaType: "image/png",
    idempotencyKey: wrongMediaKey,
    producer: () => {
      wrongMediaProducerInvocations += 1;
      return (async function* () { yield PDF; })();
    },
  });
  assert.deepEqual(wrongMedia, {
    kind: "invalid",
    code: "bundle_file_media_mismatch",
  });
  assert.equal(wrongMediaProducerInvocations, 1);
  assert.equal(stagedObjectCount(bucket), objectsBeforeWrongMedia);

  const metadataAfterWrongMedia = await createSitesMetadataStore(database);
  assert.deepEqual(
    (await metadataAfterWrongMedia.listCapacityReservationsForTest())
      .filter(({ state }) => state !== "released"),
    allocatedReservationsBeforeWrongMedia,
  );
  assert.deepEqual(
    await metadataAfterWrongMedia.listIdempotencyRecordsForTest(),
    idempotencyBeforeWrongMedia,
  );
  assert.equal(
    (await metadataAfterWrongMedia.collectStagedBundleFilesForGc({
      createdBefore: "2099-01-01T00:00:00.000Z",
      limit: 100,
    })).length,
    0,
  );

  const privacySentinels = {
    localPath: "/private/prompt/output.pdf",
    url: "https://provider.invalid/private-output",
    providerLocator: "provider-secret-object",
    prompt: "private generation prompt",
    jobId: "private-generation-job",
  };
  let producerInvocations = 0;
  const staged = await runtime.serverGeneratedIngress.stage({
    ...common,
    idempotencyKey: wrongMediaKey,
    producer: () => {
      producerInvocations += 1;
      return new ReadableStream({
        start(controller) {
          controller.enqueue(PDF.subarray(0, 11));
          controller.enqueue(PDF.subarray(11));
          controller.close();
        },
      });
    },
    ...privacySentinels,
  });
  assert.equal(staged.kind, "staged");
  assert.equal(staged.record.sourceKind, "server_generated");
  assert.equal(staged.record.mediaType, "application/pdf");
  assert.equal(staged.record.size, PDF.byteLength);
  assert.equal(staged.record.sha256, sha256(PDF));
  const objectCallsAfterSuccess = {
    reads: bucket.reads,
    writes: bucket.writes,
    deletes: bucket.deletes,
  };

  runtime = await createProductSiteRuntime(runtimeOptions);
  const replayed = await runtime.serverGeneratedIngress.stage({
    ...common,
    expectedMediaType: "application/pdf",
    idempotencyKey: wrongMediaKey,
    producer: () => {
      producerInvocations += 1;
      return (async function* () { yield PDF; })();
    },
  });
  assert.equal(replayed.kind, "staged");
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.record.stagedFileId, staged.record.stagedFileId);
  assert.equal(producerInvocations, 1);
  assert.deepEqual({
    reads: bucket.reads,
    writes: bucket.writes,
    deletes: bucket.deletes,
  }, objectCallsAfterSuccess);

  const objectsBeforeConflict = bucket.records.size;
  const conflict = await runtime.serverGeneratedIngress.stage({
    ...common,
    expectedSha256: `sha256:${"f".repeat(64)}`,
    idempotencyKey: wrongMediaKey,
    producer: () => {
      producerInvocations += 1;
      return (async function* () { yield PDF; })();
    },
  });
  assert.deepEqual(conflict, { kind: "invalid", code: "idempotency_conflict" });
  assert.equal(producerInvocations, 1);
  assert.equal(bucket.records.size, objectsBeforeConflict);
  assert.deepEqual({
    reads: bucket.reads,
    writes: bucket.writes,
    deletes: bucket.deletes,
  }, objectCallsAfterSuccess);

  const beforeCommit = await modernTool(runtime, secret, "generated-before", "list_minds", {});
  assert.equal(
    beforeCommit.minds.find(({ route }) => route === "/me").head.revision_id,
    initialRevisionId,
  );
  const committed = await modernTool(
    runtime,
    secret,
    "generated-commit",
    "commit_changeset",
    {
      mind: "/me",
      expected_revision: initialRevisionId,
      idempotency_key: "commit:server-generated-composition",
      summary: "Commit a privacy-safe generated fixture",
      operations: [{
        type: "create_bundle_file",
        path: "assets/safe-generated.pdf",
        staged_file_ref: staged.record.stagedFileId,
      }],
    },
  );
  const revisionId = committed.revision.revision_id;
  assert.notEqual(revisionId, initialRevisionId);

  const history = await modernTool(runtime, secret, "generated-history", "list_revisions", {
    mind: "/me",
    limit: 10,
  });
  assert.equal(
    history.revisions.some(({ revision }) => revision.revision_id === revisionId),
    true,
  );
  const files = await modernTool(runtime, secret, "generated-files", "list_bundle_files", {
    mind: "/me",
    revision_selector: { kind: "revision", revision_id: revisionId },
    limit: 10,
  });
  assert.deepEqual(files.files.map(({ path, size, sha256: digest }) => [path, size, digest]), [
    ["assets/safe-generated.pdf", PDF.byteLength, sha256(PDF)],
  ]);
  const download = await modernTool(runtime, secret, "generated-download", "get_bundle_file_download", {
    mind: "/me",
    revision_selector: { kind: "revision", revision_id: revisionId },
    path: "assets/safe-generated.pdf",
  });
  const downloaded = await responseFrom(runtime, new Request(download.download_url));
  assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), PDF);

  const exportStarted = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/minds/me/exports`,
    {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": csrf,
        "idempotency-key": "export:server-generated-composition",
      },
      body: JSON.stringify({
        revision_selector: { kind: "revision", revision_id: revisionId },
        profile: "MD-BUNDLE-ZIP-1",
      }),
    },
  ));
  assert.equal(exportStarted.status, 202, await exportStarted.clone().text());
  const exportJob = (await exportStarted.json()).data.job;
  assert.equal(scheduled.some((work) => work.kind === "export" && work.id === exportJob.job_id), true);
  const recovery = await runtime.recoverBackground();
  assert.ok(recovery.dispatched >= 1);
  const exportStatus = await responseFrom(runtime, new Request(
    `${ORIGIN}/api/v1/export-jobs/${encodeURIComponent(exportJob.job_id)}`,
  ));
  const completedExport = (await exportStatus.json()).data.job;
  assert.equal(completedExport.status, "succeeded");
  assert.equal(completedExport.archive_format, "MD-BUNDLE-ZIP-1");
  const exported = await responseFrom(runtime, new Request(completedExport.download_url));
  const archive = new Uint8Array(await exported.arrayBuffer());
  assert.equal(archive.byteLength, completedExport.size);
  assert.equal(sha256(archive), completedExport.sha256);
  assert.equal(new TextDecoder().decode(archive).includes("% privacy-safe generated fixture"), true);

  const durableSurface = JSON.stringify({
    metadataSnapshot: database.metadataSnapshot,
    metadataSnapshotChunks: [...database.metadataSnapshotChunks.values()],
    records: [...bucket.records.values()].map(({ key, customMetadata }) => ({ key, customMetadata })),
    telemetry,
  });
  for (const forbidden of [...Object.values(privacySentinels), secret]) {
    assert.equal(durableSurface.includes(forbidden), false, forbidden);
  }
});
