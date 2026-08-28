import assert from "node:assert/strict";
import test from "node:test";

import {
  FILE_INGRESS_WIDGET_HTML,
  FILE_INGRESS_WIDGET_URI,
  MCP_APPS_ENDPOINT,
  MCP_APPS_RESOURCE_MIME_TYPE,
  MCP_BUNDLE_FILE_TOOL_DEFINITIONS,
  NativeFileParameterRoute,
  ProductMcpContentApplication,
  createMcpHttpHandlerAtEndpoint,
} from "../../packages/adapter-mcp/dist/index.js";

const ACTOR = Object.freeze({
  kind: "registered_principal",
  principalId: "principal_apps_widget",
  authentication: Object.freeze({
    kind: "mcp_token",
    tokenId: "token_apps_widget",
    bindingOwnerId: "binding_owner_apps_widget",
    effectiveScopes: Object.freeze(["content:read", "content:write"]),
  }),
  deploymentCapabilities: Object.freeze(["content:read", "content:write"]),
  requestId: "request_apps_widget",
  occurredAtUtc: "2026-08-28T19:00:00.000Z",
});

function dependencies(nativeFileRoute, staging = {
  async stageStream() { throw new Error("unused"); },
}) {
  return {
    discovery: {
      async listMinds() { return { minds: [], nextCursor: null }; },
      async resolveMind() { throw new Error("unused"); },
      async getMindInfo() {
        return {
          mind: { mindId: "space_apps_widget" },
          head: { revisionId: "revision_apps_widget" },
          contentCapabilities: ["commit"],
        };
      },
    },
    browse: {
      async browseEntries() { throw new Error("unused"); },
      async listBundleFiles() { throw new Error("unused"); },
      async fetch() { throw new Error("unused"); },
      async readResource() { throw new Error("unexpected OKF resource read"); },
    },
    search: { async searchEntries() { throw new Error("unused"); } },
    history: {
      async listRevisions() { throw new Error("unused"); },
      async getRevision() { throw new Error("unused"); },
    },
    validation: { async validateMind() { throw new Error("unused"); } },
    bindings: {
      async read() {
        return {
          kind: "ready",
          bindings: {
            bindingSet: { state: "active", bindingVersion: 1 },
            readBindings: [],
            writeBinding: {
              state: "active",
              spaceId: "space_apps_widget",
              writeBindingId: "write_binding_apps_widget",
            },
          },
        };
      },
      async mutateRead() { throw new Error("unused"); },
      async mutateWrite() { throw new Error("unused"); },
    },
    commits: { async commit() { throw new Error("unused"); } },
    staging,
    ingress: {
      capabilities() {
        return [{
          sourceKind: "session_attachment",
          status: "available_hosted",
          transport: "native_file_parameter",
          maxBytes: 268_435_456,
          fallback: "none",
        }];
      },
      async reconcileStage() { throw new Error("unused"); },
      async reconcileCommit() { throw new Error("unused"); },
    },
    bundleFileDownloads: { async issue() { throw new Error("unused"); } },
    nativeFileRoute,
    capture: { async capture() { throw new Error("unused"); } },
  };
}

function protocolMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "apps-widget-test", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

test("publishes one privacy-bounded MCP Apps picker and app-only native stage", async () => {
  const picker = MCP_BUNDLE_FILE_TOOL_DEFINITIONS.find(
    ({ name }) => name === "open_bundle_file_picker",
  );
  const stage = MCP_BUNDLE_FILE_TOOL_DEFINITIONS.find(
    ({ name }) => name === "stage_bundle_file",
  );
  assert.deepEqual(picker.inputSchema.required, ["mind", "path", "idempotency_key"]);
  assert.equal(picker._meta.ui.resourceUri, FILE_INGRESS_WIDGET_URI);
  assert.deepEqual(picker._meta.ui.visibility, ["model", "app"]);
  assert.deepEqual(stage._meta, {
    "openai/fileParams": ["file"],
    ui: { visibility: ["app"] },
  });
  assert.deepEqual(stage.inputSchema.properties.file.required, ["file_id", "download_url"]);
  assert.deepEqual(Object.keys(stage.inputSchema.properties.file.properties), [
    "file_id",
    "download_url",
    "file_name",
    "mime_type",
  ]);

  const direct = new ProductMcpContentApplication(dependencies(undefined));
  const apps = new ProductMcpContentApplication(dependencies(
    NativeFileParameterRoute.createOpenAiMcpApps({
      async fetcher() { throw new Error("fetch must not run during picker preflight"); },
    }),
  ));
  const directNames = (await direct.listTools({ actor: ACTOR })).map(({ name }) => name);
  assert.equal(directNames.includes("open_bundle_file_picker"), false);
  assert.equal(directNames.includes("stage_bundle_file"), false);
  const appsNames = (await apps.listTools({ actor: ACTOR })).map(({ name }) => name);
  assert.equal(appsNames.includes("open_bundle_file_picker"), true);
  assert.equal(appsNames.includes("stage_bundle_file"), true);

  const opened = await apps.executeToolCall({
    actor: ACTOR,
    name: "open_bundle_file_picker",
    arguments: {
      mind: "/me",
      path: "attachments/selected-file.bin",
      idempotency_key: "picker-operation-0001",
    },
  });
  assert.deepEqual(opened.structuredContent, { ok: true, data: { status: "ready" } });
  assert.doesNotMatch(JSON.stringify(opened), /file_id|download_url|filename|bytes/iu);
});

test("serves the exact unlisted MCP Apps resource without provider-data persistence surfaces", async () => {
  const apps = new ProductMcpContentApplication(dependencies(
    NativeFileParameterRoute.createOpenAiMcpApps(),
  ));
  const read = await apps.readResource({ actor: ACTOR, uri: FILE_INGRESS_WIDGET_URI });
  assert.equal(read.mimeType, MCP_APPS_RESOURCE_MIME_TYPE);
  assert.equal(read._meta.ui.prefersBorder, true);
  assert.deepEqual(read._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
  assert.match(read.text, /ui\/notifications\/tool-input/u);
  assert.match(read.text, /request\("tools\/call"/u);
  assert.match(read.text, /selectFiles/u);
  assert.match(read.text, /uploadFile/u);
  assert.match(read.text, /getFileDownloadUrl/u);
  assert.match(read.text, /display_filename: "selected-file"/u);
  assert.match(read.text, /request\("ui\/update-model-context"/u);
  assert.match(read.text, /mind-diary\/file-ingress-context\/v1/u);
  assert.match(read.text, /staged_file_ref: stagedRef/u);
  assert.match(read.text, /path: input\.path/u);
  assert.doesNotMatch(read.text, /file_name:/u);
  assert.doesNotMatch(read.text, /local\.name/u);
  assert.doesNotMatch(read.text, /localStorage|sessionStorage|widgetState|setWidgetState|sendFollowUpMessage/u);
  assert.equal(read.text, FILE_INGRESS_WIDGET_HTML);

  let requestId = 0;
  const handler = createMcpHttpHandlerAtEndpoint({
    authenticator: { async authenticate() { return { kind: "authenticated", actor: ACTOR }; } },
    requestIds: { nextRequestId() { requestId += 1; return `request_apps_${requestId}`; } },
    content: apps,
  }, MCP_APPS_ENDPOINT);
  const response = await handler(new Request(`https://mind-diary.invalid${MCP_APPS_ENDPOINT}`, {
    method: "POST",
    headers: {
      authorization: "Bearer write-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-method": "resources/read",
      "mcp-name": FILE_INGRESS_WIDGET_URI,
      "mcp-protocol-version": "2026-07-28",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: FILE_INGRESS_WIDGET_URI, _meta: protocolMeta() },
    }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.contents[0].uri, FILE_INGRESS_WIDGET_URI);
  assert.equal(body.result.contents[0].mimeType, MCP_APPS_RESOURCE_MIME_TYPE);
  assert.equal(body.result.contents[0]._meta.ui.prefersBorder, true);
});

test("MCP Apps stage discards private provider and caller filenames at the server boundary", async () => {
  let stageRequest;
  const bytes = Uint8Array.from([1, 2, 3]);
  const apps = new ProductMcpContentApplication(dependencies(
    NativeFileParameterRoute.createOpenAiMcpApps({
      async fetcher() { return new Response(bytes, { status: 200 }); },
    }),
    {
      async stageStream(request) {
        stageRequest = request;
        const consumed = [];
        for await (const chunk of request.stream) consumed.push(...chunk);
        assert.deepEqual(consumed, [...bytes]);
        return {
          kind: "staged",
          replayed: false,
          record: {
            stagedFileId: "staged_apps_private_name",
            state: "verified",
            displayFilename: request.displayFilename,
            mediaType: "application/octet-stream",
            sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            size: bytes.byteLength,
            expiresAt: "2026-08-28T20:00:00.000Z",
          },
        };
      },
    },
  ));

  const staged = await apps.executeToolCall({
    actor: ACTOR,
    name: "stage_bundle_file",
    arguments: {
      mind: "/me",
      file: {
        file_id: "provider-private-id",
        download_url: "https://files.openai.com/private-download",
        file_name: "private-family-name.pdf",
        mime_type: "application/pdf",
      },
      display_filename: "caller-private-name.pdf",
      idempotency_key: "picker-operation-privacy-0001",
    },
  });

  assert.equal(staged.isError, false);
  assert.equal(stageRequest.displayFilename, "selected-file");
  assert.equal(
    staged.structuredContent.data.staged_file.display_filename,
    "selected-file",
  );
  assert.doesNotMatch(
    JSON.stringify(staged),
    /private-family-name|caller-private-name|provider-private-id|private-download/u,
  );
});
