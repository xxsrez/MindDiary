import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_BUNDLE_FILE_TOOL_DEFINITIONS,
  MCP_TOOL_DEFINITIONS,
  NativeFileParameterRoute,
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
    "contract_version",
    "source_selection_required",
    "max_bytes",
    "native_file_input",
    "companion_upload",
  ]);
  assert.equal(
    capabilityData.properties.source_selection_required.const,
    false,
  );
  assert.equal(
    capabilityData.properties.native_file_input.properties.transport.const,
    "openai_file_parameter",
  );
  assert.equal(
    capabilityData.properties.companion_upload.properties.transport.const,
    "one_use_upload_intent",
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
    "file",
    "idempotency_key",
  ]);
  assert.equal(stage.inputSchema.additionalProperties, false);
  assert.deepEqual(stage.inputSchema.properties.file, { $ref: "#/$defs/OpenAIFile" });
  assert.deepEqual(stage.inputSchema.$defs.OpenAIFile.required, ["file_id", "download_url"]);
  assert.equal(stage.inputSchema.$defs.OpenAIFile.additionalProperties, false);
  assert.deepEqual(stage._meta, {
    "openai/fileParams": ["file"],
  });
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
  const retrievalSchema = download.outputSchema.properties.data.properties.retrieval;
  assert.deepEqual(retrievalSchema.required, [
    "method",
    "executor",
    "execution_boundary",
    "one_use",
    "redirect_policy",
    "verify",
    "failure_code_on_policy_block",
  ]);
  assert.equal(retrievalSchema.additionalProperties, false);
  assert.equal(retrievalSchema.properties.method.const, "https_get");
  assert.equal(
    retrievalSchema.properties.executor.const,
    "client_or_same_host_trusted_download_companion",
  );
  assert.equal(
    retrievalSchema.properties.execution_boundary.const,
    "originating_mcp_client_host",
  );
  assert.equal(retrievalSchema.properties.one_use.const, true);
  assert.equal(retrievalSchema.properties.redirect_policy.const, "reject");
  assert.deepEqual(retrievalSchema.properties.verify.const, [
    "content_type",
    "content_length",
    "etag",
    "content_disposition",
    "sha256",
  ]);
  assert.equal(
    retrievalSchema.properties.failure_code_on_policy_block.const,
    "client_transport_unsupported",
  );

  const commit = MCP_TOOL_DEFINITIONS.find(({ name }) => name === "commit_changeset");
  const uploadIntent = MCP_TOOL_DEFINITIONS.find(
    ({ name }) => name === "create_file_upload_intent",
  );
  assert.match(uploadIntent.description, /client has no native file bridge/u);
  assert.match(uploadIntent.description, /uncertain or retryable outcome/u);
  assert.match(uploadIntent.description, /Never provide a local path, source class/u);
  assert.match(commit.description, /20 operations and 256 MiB of staged bytes/u);
  assert.match(commit.description, /Track committed, pending, failed and unknown files internally/u);
  assert.deepEqual(
    commit.inputSchema.properties.operations.items.oneOf
      .slice(-4)
      .map((variant) => variant.properties.type.const),
    [
      "create_bundle_file",
      "replace_bundle_file",
      "delete_bundle_file",
      "reclassify_bundle_file",
    ],
  );
  assert.equal(
    commit.inputSchema.properties.operations.items.oneOf.at(-4)
      .properties.staged_file_ref.type,
    "string",
  );
});

test("bounded native transport validates every redirect host and never exposes provider locators", async () => {
  const requested = [];
  const transport = new OpenAiNativeFileTransport({
    maxBytes: 64,
    fetcher: async (input, init) => {
      requested.push({ url: String(input), init });
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
  for (const request of requested) {
    assert.equal(typeof request.url, "string");
    assert.equal(request.init.redirect, "manual");
    assert.equal("credentials" in request.init, false);
    assert.equal("cache" in request.init, false);
    assert.equal("referrerPolicy" in request.init, false);
  }

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
  for (const invalid of [
    "/tmp/private.png",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
    { localPath: "/tmp/private.png" },
    { fileId: "invented-without-provider-object" },
    {
      fileId: "provider-secret-id",
      downloadUrl: "https://files.oaiusercontent.com/file/temporary-secret",
      bytes: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
    },
  ]) {
    await assert.rejects(
      transport.download(invalid),
      (error) => error instanceof NativeFileInputFailure &&
        error.code === "native_file_input_unsupported",
    );
  }
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

test("native transport reports a privacy-safe runtime fetch category", async () => {
  const transport = new OpenAiNativeFileTransport({
    maxBytes: 64,
    fetcher: async () => {
      throw new TypeError("The 'cache' field on 'RequestInitializerDict' is not implemented.");
    },
  });
  await assert.rejects(
    transport.download({
      fileId: "provider-secret-id",
      downloadUrl: "https://files.oaiusercontent.com/file/temporary-secret",
    }),
    (error) => {
      assert.ok(error instanceof NativeFileInputFailure);
      assert.equal(error.code, "native_file_input_unsupported");
      assert.equal(error.retryable, true);
      assert.match(error.message, /category: unsupported_fetch_option/u);
      assert.match(error.message, /detail: The 'cache' field/u);
      assert.doesNotMatch(error.message, /provider-secret|temporary-secret|oaiusercontent/iu);
      return true;
    },
  );

  const redacted = new OpenAiNativeFileTransport({
    maxBytes: 64,
    fetcher: async () => {
      throw new TypeError(
        "fetch failed for https://files.oaiusercontent.com/file/provider-secret-id?sig=secret at /workspace/private/file",
      );
    },
  });
  await assert.rejects(
    redacted.download({
      fileId: "provider-secret-id",
      downloadUrl: "https://files.oaiusercontent.com/file/temporary-secret",
    }),
    (error) => {
      assert.match(error.message, /detail: fetch failed for \[url\]/u);
      assert.doesNotMatch(error.message, /oaiusercontent|provider-secret|workspace|sig=/iu);
      return true;
    },
  );
});

test("native route activation requires an exact externally observed rewrite assertion", () => {
  assert.throws(
    () => NativeFileParameterRoute.create({
      assertion: {
        profileId: "test-profile",
        assertionId: "test-receipt",
        observedAtUtc: "not-a-canonical-observation",
        toolName: "stage_bundle_file",
        parameterName: "file",
        sourceKind: "session_attachment",
        transport: "native_file_parameter",
      },
      async fetcher() { throw new Error("must not fetch"); },
    }),
    /exact host rewrite assertion/u,
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
    nativeFileRoute: NativeFileParameterRoute.create({
      assertion: {
        profileId: "test-app-session-attachment-v1",
        assertionId: "test-receipt:host-rewrite:stage-bundle-file:v1",
        observedAtUtc: "2026-08-27T22:30:00.000Z",
        toolName: "stage_bundle_file",
        parameterName: "file",
        sourceKind: "session_attachment",
        transport: "native_file_parameter",
      },
      async fetcher(input, init) {
        assert.equal(
          String(input),
          "https://files.oaiusercontent.com/file/temporary-secret",
        );
        assert.equal(init.redirect, "manual");
        assert.equal("credentials" in init, false);
        assert.equal("cache" in init, false);
        assert.equal("referrerPolicy" in init, false);
        return new Response(PNG, { status: 200 });
      },
    }),
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
            status: sourceKind === "bounded_in_memory"
              ? "available_local"
              : "not_available",
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
  const supportedCatalog = await application.listTools({ actor: ACTOR });
  const nativeDefinition = supportedCatalog.find(
    ({ name }) => name === "stage_bundle_file",
  );
  assert.deepEqual(nativeDefinition._meta, {
    "openai/fileParams": ["file"],
  });
  assert.deepEqual(nativeDefinition.inputSchema.properties.file, {
    $ref: "#/$defs/OpenAIFile",
  });
  assert.deepEqual(nativeDefinition.inputSchema.$defs.OpenAIFile.required, [
    "file_id",
    "download_url",
  ]);
  const result = await application.executeToolCall({
    actor: ACTOR,
    name: "stage_bundle_file",
    arguments: {
      mind: "bundle-stage",
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
  assert.equal(portableRequest.sourceKind, "session_attachment");
  assert.equal(portableRequest.maxBytes, 268_435_456);
  assert.equal(portableRequest.spaceId, "space_bundle_stage");
  assert.equal("writeBindingId" in portableRequest, false);
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
  assert.deepEqual(download.structuredContent.data.retrieval, {
    method: "https_get",
    executor: "client_or_same_host_trusted_download_companion",
    execution_boundary: "originating_mcp_client_host",
    one_use: true,
    redirect_policy: "reject",
    verify: [
      "content_type",
      "content_length",
      "etag",
      "content_disposition",
      "sha256",
    ],
    failure_code_on_policy_block: "client_transport_unsupported",
  });
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
  assert.equal(capabilities.structuredContent.data.contract_version, 2);
  assert.equal(capabilities.structuredContent.data.source_selection_required, false);
  assert.equal(capabilities.structuredContent.data.max_bytes, 268_435_456);
  assert.deepEqual(capabilities.structuredContent.data.native_file_input, {
    transport: "openai_file_parameter",
    status: "available",
    route_profile_id: "test-app-session-attachment-v1",
    verification_status: "verified",
  });
  assert.deepEqual(capabilities.structuredContent.data.companion_upload, {
    transport: "one_use_upload_intent",
    status: "not_available",
  });

  const reconciledStage = await application.executeToolCall({
    actor: ACTOR,
    name: "reconcile_file_stage",
    arguments: {
      mind: "bundle-stage",
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

test("a client profile without fileParams omits native staging and fails closed before target or fetch work", async () => {
  let touched = 0;
  const unused = new Proxy({}, {
    get() {
      return async () => {
        touched += 1;
        throw new Error("direct route must fail first");
      };
    },
  });
  const application = new ProductMcpContentApplication({
    discovery: unused,
    browse: unused,
    search: unused,
    history: unused,
    validation: unused,
    bindings: unused,
    commits: unused,
    ingress: {
      capabilities() { return []; },
      reconcileStage: unused.reconcileStage,
      reconcileCommit: unused.reconcileCommit,
    },
    bundleFileDownloads: unused,
    capture: unused,
  });

  const listed = await application.listTools({ actor: ACTOR });
  assert.equal(listed.some(({ name }) => name === "stage_bundle_file"), false);
  const capabilities = await application.executeToolCall({
    actor: ACTOR,
    name: "get_file_ingress_capabilities",
    arguments: {},
  });
  assert.deepEqual(capabilities.structuredContent.data.native_file_input, {
    transport: "openai_file_parameter",
    status: "not_available",
    route_profile_id: null,
    verification_status: "not_available",
  });
  const called = await application.executeToolCall({
    actor: ACTOR,
    name: "stage_bundle_file",
    arguments: {
      mind: "bundle-stage",
      file: {
        file_id: "invented-provider-id",
        download_url: "https://files.oaiusercontent.com/file/invented-url",
      },
      idempotency_key: "direct-custom-stage",
    },
  });
  assert.equal(called.isError, true);
  assert.equal(
    called.structuredContent.error.code,
    "native_file_input_unsupported",
  );
  assert.equal(touched, 0);
});

test("public capability projection reports transports without exposing source classes", async () => {
  const application = new ProductMcpContentApplication({
    ingress: {
      capabilities() {
        return [
          {
            sourceKind: "session_attachment",
            status: "available_local",
            transport: "native_file_parameter",
            maxBytes: 268_435_456,
            fallback: "none",
          },
          {
            sourceKind: "local_path",
            status: "available_hosted",
            transport: "local_companion",
            maxBytes: 67_108_864,
            fallback: "none",
          },
          {
            sourceKind: "workspace/generated_artifact",
            status: "available_local",
            transport: "local_companion",
            maxBytes: 67_108_864,
            fallback: "none",
          },
          {
            sourceKind: "connector_object",
            status: "available_hosted",
            transport: "authorized_connector",
            maxBytes: 67_108_864,
            fallback: "none",
          },
          {
            sourceKind: "bounded_in_memory",
            status: "available_hosted",
            transport: "bounded_bytes",
            maxBytes: 4_194_304,
            fallback: "none",
          },
          {
            sourceKind: "server_generated",
            status: "available_local",
            transport: "producer_stream",
            maxBytes: 67_108_864,
            fallback: "none",
          },
        ];
      },
    },
    nativeFileRoute: NativeFileParameterRoute.create({
      assertion: {
        profileId: "test-local-only-session-attachment-v1",
        assertionId: "test-receipt:local-only-host-rewrite:v1",
        observedAtUtc: "2026-08-28T18:00:00.000Z",
        toolName: "stage_bundle_file",
        parameterName: "file",
        sourceKind: "session_attachment",
        transport: "native_file_parameter",
      },
      async fetcher() {
        throw new Error("capability projection must not fetch");
      },
    }),
    staging: {},
    uploadIntents: {},
    uploadIntentUrl() {
      return "https://mind-diary.invalid/api/v1/file-upload-intents/test";
    },
  });
  const capabilities = await application.executeToolCall({
    actor: ACTOR,
    name: "get_file_ingress_capabilities",
    arguments: {},
  });
  assert.equal(capabilities.isError, false);
  assert.deepEqual(capabilities.structuredContent.data.native_file_input, {
    transport: "openai_file_parameter",
    status: "available",
    route_profile_id: "test-local-only-session-attachment-v1",
    verification_status: "verified",
  });
  assert.deepEqual(capabilities.structuredContent.data.companion_upload, {
    transport: "one_use_upload_intent",
    status: "available",
  });
  assert.equal("sources" in capabilities.structuredContent.data, false);
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
