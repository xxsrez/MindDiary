import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_BUNDLE_FILE_TOOL_DEFINITIONS,
  MCP_TOOL_DEFINITIONS,
  NativeFileInputFailure,
  OpenAiNativeFileTransport,
  ProductMcpContentApplication,
  createMcpHttpHandler,
} from "../../packages/adapter-mcp/dist/index.js";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
]);
const ACTOR = Object.freeze({
  kind: "registered_principal",
  principalId: "principal_bundle_stage",
  authentication: Object.freeze({
    kind: "mcp_token",
    tokenId: "token_bundle_stage",
    bindingOwnerId: "binding_owner_bundle_stage",
    effectiveScopes: Object.freeze(["content:read", "content:write"]),
  }),
  deploymentCapabilities: Object.freeze(["content:read", "content:write"]),
  requestId: "request_bundle_stage",
  occurredAtUtc: "2026-08-22T12:00:00.000Z",
});

function modernMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "bundle-file-test", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

test("publishes strict native-file staging metadata and mixed commit operations", () => {
  assert.deepEqual(
    MCP_BUNDLE_FILE_TOOL_DEFINITIONS.map(({ name }) => name),
    [
      "get_file_ingress_capabilities",
      "create_file_upload_intent",
      "stage_bundle_file",
      "reconcile_file_stage",
      "get_bundle_file_download",
    ],
  );
  const intent = MCP_BUNDLE_FILE_TOOL_DEFINITIONS.find(
    ({ name }) => name === "create_file_upload_intent",
  );
  assert.deepEqual(intent.inputSchema.required, [
    "mind",
    "write_binding_id",
    "source_kind",
    "display_filename",
    "expected_size",
    "expected_sha256",
    "idempotency_key",
  ]);
  assert.equal(intent.inputSchema.properties.expected_size.maximum, 268_435_456);
  assert.equal("_meta" in intent, false);
  assert.doesNotMatch(
    JSON.stringify({ inputSchema: intent.inputSchema, outputSchema: intent.outputSchema }),
    /file_id|download_url|bytes|absolute_path|bearer|connector_object/iu,
  );
  const capabilities = MCP_BUNDLE_FILE_TOOL_DEFINITIONS.find(
    ({ name }) => name === "get_file_ingress_capabilities",
  );
  assert.equal("required" in capabilities.inputSchema, false);
  assert.equal(capabilities.inputSchema.additionalProperties, false);
  assert.deepEqual(capabilities.securitySchemes, [
    { type: "oauth2", scopes: ["content:read"] },
  ]);
  assert.deepEqual(capabilities.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  });
  assert.deepEqual(capabilities.outputSchema.required, ["ok"]);
  const capabilityData = capabilities.outputSchema.properties.data;
  assert.deepEqual(capabilityData.required, [
    "report_scope",
    "client_companion_status",
    "path_admission_status",
    "sources",
  ]);
  assert.deepEqual(
    capabilityData.properties.sources.items.properties.server_adapter_status.enum,
    ["available", "not_available"],
  );
  assert.deepEqual(
    capabilityData.properties.sources.items.properties.server_transport.enum,
    ["companion_upload_intent", "none"],
  );
  assert.doesNotMatch(
    JSON.stringify(capabilities.outputSchema),
    /filename|absolute_path|provider_locator|account|token|url|private_content/iu,
  );
  const stage = MCP_BUNDLE_FILE_TOOL_DEFINITIONS.find(
    ({ name }) => name === "stage_bundle_file",
  );
  assert.equal(stage.name, "stage_bundle_file");
  assert.deepEqual(stage.inputSchema.required, [
    "mind",
    "write_binding_id",
    "file",
    "idempotency_key",
  ]);
  assert.equal(stage.inputSchema.additionalProperties, false);
  assert.deepEqual(stage.inputSchema.properties.file.required, ["file_id", "download_url"]);
  assert.equal(stage.inputSchema.properties.file.additionalProperties, false);
  assert.deepEqual(stage._meta, { "openai/fileParams": ["file"] });
  assert.deepEqual(stage.securitySchemes, [{ type: "oauth2", scopes: ["content:write"] }]);
  assert.deepEqual(stage.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  });
  const serialized = JSON.stringify(stage.outputSchema);
  assert.doesNotMatch(serialized, /file_id|download_url|bytes|local_path|base64/iu);

  const reconcile = MCP_BUNDLE_FILE_TOOL_DEFINITIONS.find(
    ({ name }) => name === "reconcile_file_stage",
  );
  assert.deepEqual(reconcile.inputSchema.required, [
    "mind",
    "write_binding_id",
    "source_kind",
    "display_filename",
    "media_type",
    "sha256",
    "size",
    "idempotency_key",
  ]);
  assert.equal(reconcile.inputSchema.additionalProperties, false);
  assert.deepEqual(reconcile.securitySchemes, [
    { type: "oauth2", scopes: ["content:write"] },
  ]);
  assert.deepEqual(reconcile.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  });
  assert.equal("_meta" in reconcile, false);
  assert.doesNotMatch(
    JSON.stringify(reconcile.outputSchema),
    /file_id|download_url|bytes|local_path|base64/iu,
  );

  const download = MCP_BUNDLE_FILE_TOOL_DEFINITIONS.find(
    ({ name }) => name === "get_bundle_file_download",
  );
  assert.deepEqual(download.inputSchema.required, ["mind", "path"]);
  assert.equal(download.inputSchema.additionalProperties, false);
  assert.deepEqual(download.securitySchemes, [{ type: "oauth2", scopes: ["content:read"] }]);
  assert.deepEqual(download.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  });
  assert.doesNotMatch(
    JSON.stringify(download.outputSchema.properties.data.properties.file),
    /bytes|provider|object_key/iu,
  );

  const commit = MCP_TOOL_DEFINITIONS.find(({ name }) => name === "commit_changeset");
  assert.deepEqual(
    commit.inputSchema.properties.operations.items.oneOf
      .slice(-3)
      .map((variant) => variant.properties.type.const),
    ["create_bundle_file", "replace_bundle_file", "delete_bundle_file"],
  );
  assert.equal(
    commit.inputSchema.properties.operations.items.oneOf.at(-3)
      .properties.staged_file_ref.type,
    "string",
  );
});

test("bounded native transport validates every redirect host and never exposes provider locators", async () => {
  const requested = [];
  const transport = new OpenAiNativeFileTransport({
    maxBytes: 64,
    fetcher: async (input, init) => {
      requested.push({ url: String(input), credentials: init.credentials, redirect: init.redirect });
      if (requested.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://sdmntprwestus2.oaiusercontent.com/file/native" },
        });
      }
      return new Response(PNG, {
        status: 200,
        headers: { "content-length": String(PNG.byteLength) },
      });
    },
  });
  const downloaded = await transport.download({
    fileId: "provider-secret-id",
    downloadUrl: "https://files.oaiusercontent.com/file/temporary-secret",
    fileName: "diagram.png",
    mimeType: "image/png",
  });
  const chunks = [];
  for await (const chunk of downloaded.stream) {
    chunks.push(chunk);
  }
  assert.deepEqual(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), Buffer.from(PNG));
  assert.equal(downloaded.fileName, "diagram.png");
  assert.equal(downloaded.mimeType, "image/png");
  assert.deepEqual(requested.map(({ credentials, redirect }) => ({ credentials, redirect })), [
    { credentials: "omit", redirect: "manual" },
    { credentials: "omit", redirect: "manual" },
  ]);

  await assert.rejects(
    transport.download({
      fileId: "provider-secret-id",
      downloadUrl: "https://attacker.invalid/private",
    }),
    (error) => {
      assert.ok(error instanceof NativeFileInputFailure);
      assert.equal(error.code, "native_file_input_unsupported");
      assert.doesNotMatch(error.message, /attacker|private|provider-secret/iu);
      return true;
    },
  );
  const tooSmall = new OpenAiNativeFileTransport({
    maxBytes: PNG.byteLength - 1,
    fetcher: async () => new Response(PNG, { status: 200 }),
  });
  await assert.rejects(
    (async () => {
      const pending = await tooSmall.download({
        fileId: "provider-secret-id",
        downloadUrl: "https://files.oaiusercontent.com/file/temporary-secret",
      });
      for await (const _chunk of pending.stream) {
        // Consume the stream when the provider omits Content-Length.
      }
    })(),
    (error) => error instanceof NativeFileInputFailure &&
      error.code === "bundle_file_size_limit_exceeded",
  );

  const stalled = new OpenAiNativeFileTransport({
    maxBytes: 64,
    timeoutMs: 10,
    fetcher: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(PNG.slice(0, 1));
      },
    }), { status: 200 }),
  });
  await assert.rejects(
    (async () => {
      const pending = await stalled.download({
        fileId: "provider-secret-id",
        downloadUrl: "https://files.oaiusercontent.com/file/stalled-secret",
      });
      for await (const _chunk of pending.stream) {
        // Consume the bounded stream so its timeout and size checks execute.
      }
    })(),
    (error) => error instanceof NativeFileInputFailure &&
      error.code === "native_file_input_unsupported" &&
      error.retryable === true,
  );
});

test("product adapter terminates provider metadata and returns only verified staged metadata", async () => {
  let portableRequest = null;
  let listRequest = null;
  let downloadRequest = null;
  let reconcileStageRequest = null;
  let reconcileCommitRequest = null;
  const application = new ProductMcpContentApplication({
    discovery: {
      async listMinds() { return {}; },
      async resolveMind() { return {}; },
      async getMindInfo(_actor, _selector, revisionSelector) {
        return {
          mind: { mindId: "space_bundle_stage", name: "Bundle stage" },
          resolvedRevision: {
            revisionId: revisionSelector?.kind === "revision"
              ? revisionSelector.revisionId
              : "revision_head",
          },
          contentCapabilities: ["commit"],
        };
      },
    },
    bindings: {
      async read() {
        return {
          kind: "ready",
          bindings: {
            bindingSet: { state: "active" },
            readBindings: [],
            writeBinding: {
              state: "active",
              spaceId: "space_bundle_stage",
              writeBindingId: "write_binding_stage",
            },
          },
        };
      },
      async mutateRead() { throw new Error("unused"); },
      async mutateWrite() { throw new Error("unused"); },
    },
    nativeFiles: {
      async download(file) {
        assert.deepEqual(file, {
          fileId: "provider-secret-id",
          downloadUrl: "https://files.oaiusercontent.com/file/temporary-secret",
          fileName: "diagram.png",
          mimeType: "image/png",
        });
        return {
          stream: (async function* () { yield PNG; })(),
          fileName: "diagram.png",
          mimeType: "image/png",
        };
      },
    },
    staging: {
      async stageStream(request) {
        portableRequest = request;
        return {
          kind: "staged",
          replayed: false,
          record: {
            stagedFileId: "staged_safe_ref",
            state: "verified",
            displayFilename: "diagram.png",
            mediaType: "image/png",
            sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            size: PNG.byteLength,
            expiresAt: "2026-08-22T13:00:00.000Z",
          },
        };
      },
    },
    ingress: {
      capabilities() {
        return [
          {
            sourceKind: "session_attachment",
            status: "available_hosted",
            transport: "native_file_parameter",
            maxBytes: 67_108_864,
            fallback: "none",
          },
          ...[
            ["local_path", "local_companion", 67_108_864],
            ["workspace/generated_artifact", "local_companion", 67_108_864],
            ["connector_object", "authorized_connector", 67_108_864],
            ["bounded_in_memory", "bounded_bytes", 4_194_304],
            ["server_generated", "producer_stream", 67_108_864],
          ].map(([sourceKind, transport, maxBytes]) => ({
            sourceKind,
            status: "not_available",
            transport,
            maxBytes,
            fallback: "none",
          })),
        ];
      },
      async reconcileStage(request) {
        reconcileStageRequest = request;
        return {
          kind: "staged",
          replayed: true,
          record: {
            stagedFileId: "staged_safe_ref",
            state: "verified",
            displayFilename: "diagram.png",
            mediaType: "image/png",
            sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            size: PNG.byteLength,
            expiresAt: "2026-08-22T13:00:00.000Z",
          },
        };
      },
      async reconcileCommit(request) {
        reconcileCommitRequest = request;
        return {
          kind: "committed",
          previousRevisionId: "revision_head",
          envelope: { revision: { revisionId: "revision_committed" } },
        };
      },
    },
    browse: {
      async listBundleFiles(_actor, input) {
        listRequest = input;
        return {
          mind: { mindId: "space_bundle_stage", name: "Bundle stage" },
          resolvedRevision: { revisionId: "revision_exact" },
          files: [{
            path: "assets/diagram.png",
            kind: "opaque",
            mediaType: "image/png",
            size: PNG.byteLength,
            sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            revisionId: "revision_exact",
            inlineEligible: true,
            referenceStatus: "referenced",
          }],
          diagnostics: [],
          nextCursor: null,
        };
      },
    },
    bundleFileDownloads: {
      async issue(_actor, input) {
        downloadRequest = input;
        return {
          mind: { mindId: "space_bundle_stage", name: "Bundle stage" },
          resolvedRevision: { revisionId: "revision_exact" },
          file: {
            path: "assets/diagram.png",
            kind: "opaque",
            mediaType: "image/png",
            size: PNG.byteLength,
            sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            revisionId: "revision_exact",
            inlineEligible: true,
          },
          downloadUrl: "https://mind-diary.invalid/api/bundle-download/one-use-secret",
          downloadExpiresAt: "2026-08-22T12:05:00.000Z",
          disposition: "inline",
        };
      },
    },
    search: {}, history: {}, validation: {}, commits: {}, capture: {}, exports: {},
  });
  const result = await application.executeToolCall({
    actor: ACTOR,
    name: "stage_bundle_file",
    arguments: {
      mind: "bundle-stage",
      write_binding_id: "write_binding_stage",
      file: {
        file_id: "provider-secret-id",
        download_url: "https://files.oaiusercontent.com/file/temporary-secret",
        file_name: "diagram.png",
        mime_type: "image/png",
      },
      idempotency_key: "stage-diagram",
      expected_size: PNG.byteLength,
    },
  });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.data.staged_file.staged_file_ref, "staged_safe_ref");
  const stagedChunks = [];
  for await (const chunk of portableRequest.stream) {
    stagedChunks.push(chunk);
  }
  assert.deepEqual(
    Buffer.concat(stagedChunks.map((chunk) => Buffer.from(chunk))),
    Buffer.from(PNG),
  );
  assert.equal("file" in portableRequest, false);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /provider-secret|temporary-secret|download_url|file_id|137,80,78,71/iu);

  const listed = await application.executeToolCall({
    actor: ACTOR,
    name: "list_bundle_files",
    arguments: {
      mind: "bundle-stage",
      revision_selector: { kind: "revision", revision_id: "revision_exact" },
      limit: 10,
    },
  });
  assert.deepEqual(listRequest, {
    mind: "bundle-stage",
    revisionSelector: { kind: "revision", revisionId: "revision_exact" },
    limit: 10,
  });
  assert.equal(listed.files[0].media_type, "image/png");
  assert.equal(listed.files[0].reference_status, "referenced");
  assert.doesNotMatch(JSON.stringify(listed), /download_url|bytes|provider/iu);

  const download = await application.executeToolCall({
    actor: ACTOR,
    name: "get_bundle_file_download",
    arguments: {
      mind: "bundle-stage",
      revision_selector: { kind: "revision", revision_id: "revision_exact" },
      path: "assets/diagram.png",
    },
  });
  assert.deepEqual(downloadRequest, {
    mind: "bundle-stage",
    revisionSelector: { kind: "revision", revisionId: "revision_exact" },
    path: "assets/diagram.png",
  });
  assert.equal(download.isError, false);
  assert.match(
    download.structuredContent.data.download_url,
    /\/api\/bundle-download\/one-use-secret$/u,
  );
  assert.equal(download.structuredContent.data.file.inline_eligible, true);
  assert.doesNotMatch(
    JSON.stringify(download.structuredContent.data.file),
    /bytes|provider|object_key/iu,
  );

  const capabilities = await application.executeToolCall({
    actor: ACTOR,
    name: "get_file_ingress_capabilities",
    arguments: {},
  });
  assert.equal(capabilities.isError, false);
  assert.deepEqual(
    capabilities.structuredContent.data.sources.map(({
      source_kind,
      server_adapter_status,
      server_transport,
      requires_write_binding,
      max_bytes,
    }) => [
      source_kind,
      server_adapter_status,
      server_transport,
      requires_write_binding,
      max_bytes,
    ]),
    [
      ["session_attachment", "not_available", "none", false, 0],
      ["local_path", "not_available", "none", false, 0],
      ["workspace/generated_artifact", "not_available", "none", false, 0],
      ["connector_object", "not_available", "none", false, 0],
      ["bounded_in_memory", "not_available", "none", false, 0],
      ["server_generated", "not_available", "none", false, 0],
    ],
  );
  assert.equal(
    capabilities.structuredContent.data.report_scope,
    "hosted_server_adapters_only",
  );
  assert.equal(capabilities.structuredContent.data.client_companion_status, "not_reported");
  assert.equal(capabilities.structuredContent.data.path_admission_status, "not_reported");

  const reconciledStage = await application.executeToolCall({
    actor: ACTOR,
    name: "reconcile_file_stage",
    arguments: {
      mind: "bundle-stage",
      write_binding_id: "write_binding_stage",
      source_kind: "session_attachment",
      display_filename: "diagram.png",
      claimed_media_type: "image/png",
      media_type: "image/png",
      sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      size: PNG.byteLength,
      idempotency_key: "stage-diagram",
      expected_size: PNG.byteLength,
    },
  });
  assert.equal(reconciledStage.isError, false);
  assert.equal(reconciledStage.structuredContent.data.status, "staged");
  assert.equal(
    reconciledStage.structuredContent.data.staged_file.staged_file_ref,
    "staged_safe_ref",
  );
  assert.equal(reconcileStageRequest.spaceId, "space_bundle_stage");
  assert.equal(reconcileStageRequest.sourceKind, "session_attachment");
  assert.equal("bytes" in reconcileStageRequest, false);

  const reconciledCommit = await application.executeToolCall({
    actor: ACTOR,
    name: "reconcile_changeset",
    arguments: {
      mind: "bundle-stage",
      write_binding_id: "write_binding_stage",
      expected_revision: "revision_head",
      idempotency_key: "commit-diagram",
      summary: "Publish diagram",
      operations: [
        {
          type: "create_bundle_file",
          path: "assets/diagram.png",
          staged_file_ref: "staged_safe_ref",
        },
      ],
    },
  });
  assert.equal(reconciledCommit.isError, false);
  assert.equal(reconciledCommit.structuredContent.data.status, "committed");
  assert.equal(
    reconciledCommit.structuredContent.data.revision.revision_id,
    "revision_committed",
  );
  assert.deepEqual(reconcileCommitRequest.operations, [
    {
      type: "create_bundle_file",
      path: "assets/diagram.png",
      staged_file_id: "staged_safe_ref",
    },
  ]);
});

test("read-only catalog omits native staging and direct calls fail before execution", async () => {
  let executed = 0;
  const readActor = Object.freeze({
    ...ACTOR,
    authentication: Object.freeze({
      ...ACTOR.authentication,
      effectiveScopes: Object.freeze(["content:read"]),
    }),
  });
  const handler = createMcpHttpHandler({
    authenticator: { async authenticate() { return { kind: "authenticated", actor: readActor }; } },
    requestIds: { nextRequestId() { return "request_read_only_stage"; } },
    content: {
      async listTools() { return MCP_TOOL_DEFINITIONS; },
      async listRootResources() { return { resources: [], nextCursor: null }; },
      async readResource() { throw new Error("unused"); },
      async authorizeToolCall() { return { kind: "allowed" }; },
      async executeToolCall() { executed += 1; return {}; },
    },
  });
  const send = (body) => handler(new Request("https://mind-diary.invalid/api/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer read-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-method": body.method,
      "mcp-protocol-version": "2026-07-28",
      ...(body.method === "tools/call" ? { "mcp-name": body.params.name } : {}),
    },
    body: JSON.stringify(body),
  }));
  const listed = (await (await send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: { _meta: modernMeta() },
  })).json()).result;
  assert.equal(listed.tools.some(({ name }) => name === "stage_bundle_file"), false);
  assert.equal(
    listed.tools.some(({ name }) => name === "create_file_upload_intent"),
    false,
  );

  const called = (await (await send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "stage_bundle_file",
      arguments: {},
      _meta: modernMeta(),
    },
  })).json()).result;
  assert.equal(called.isError, true);
  assert.equal(called.structuredContent.error.code, "insufficient_scope");
  const intentCalled = (await (await send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "create_file_upload_intent",
      arguments: {},
      _meta: modernMeta(),
    },
  })).json()).result;
  assert.equal(intentCalled.isError, true);
  assert.equal(intentCalled.structuredContent.error.code, "insufficient_scope");
  assert.equal(executed, 0);
});
