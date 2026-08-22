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
  assert.equal(MCP_BUNDLE_FILE_TOOL_DEFINITIONS.length, 1);
  const stage = MCP_BUNDLE_FILE_TOOL_DEFINITIONS[0];
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
  assert.deepEqual(downloaded.bytes, PNG);
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
    tooSmall.download({
      fileId: "provider-secret-id",
      downloadUrl: "https://files.oaiusercontent.com/file/temporary-secret",
    }),
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
    stalled.download({
      fileId: "provider-secret-id",
      downloadUrl: "https://files.oaiusercontent.com/file/stalled-secret",
    }),
    (error) => error instanceof NativeFileInputFailure &&
      error.code === "native_file_input_unsupported" &&
      error.retryable === true,
  );
});

test("product adapter terminates provider metadata and returns only verified staged metadata", async () => {
  let portableRequest = null;
  const application = new ProductMcpContentApplication({
    discovery: {
      async listMinds() { return {}; },
      async resolveMind() { return {}; },
      async getMindInfo() {
        return {
          mind: { mindId: "space_bundle_stage", name: "Bundle stage" },
          resolvedRevision: { revisionId: "revision_head" },
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
        return { bytes: PNG, fileName: "diagram.png", mimeType: "image/png" };
      },
    },
    staging: {
      async stage(request) {
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
    browse: {}, search: {}, history: {}, validation: {}, commits: {}, capture: {}, exports: {},
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
  assert.deepEqual(portableRequest.bytes, PNG);
  assert.equal("file" in portableRequest, false);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /provider-secret|temporary-secret|download_url|file_id|137,80,78,71/iu);
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
  assert.equal(executed, 0);
});
