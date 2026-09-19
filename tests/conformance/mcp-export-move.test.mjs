import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_CONTENT_TOOLS,
  MCP_TARGET_PROTOCOL,
  ProductMcpContentApplication,
  createMcpHttpHandler,
} from "../../packages/adapter-mcp/dist/index.js";

const actor = Object.freeze({
  kind: "registered_principal",
  principalId: "principal_mcp_export_move",
  authentication: Object.freeze({
    kind: "mcp_token",
    tokenId: "token_mcp_export_move",
    effectiveScopes: Object.freeze(["content:read"]),
  }),
  deploymentCapabilities: Object.freeze(["content:read"]),
  requestId: "request_mcp_export_move",
  occurredAtUtc: "2026-08-27T20:00:00.000Z",
});

function dependencies() {
  return {
    authenticator: {
      async authenticate(candidate) {
        return candidate === "export-move-token"
          ? { kind: "authenticated", actor }
          : { kind: "invalid" };
      },
    },
    requestIds: { nextRequestId: () => "request_mcp_export_move" },
    // The migration paths must complete without touching any content/export
    // dependency. Missing dependencies make an accidental call fail loudly.
    content: new ProductMcpContentApplication({}),
  };
}

function modernRequest(method, params, id = 1) {
  const body = {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": {
          name: "mcp-export-move-test",
          version: "1.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
  const name = method === "tools/call" ? params.name : null;
  return new Request("https://mind-diary.invalid/api/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: "Bearer export-move-token",
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": MCP_TARGET_PROTOCOL,
      ...(name === null ? {} : { "mcp-name": name }),
    },
    body: JSON.stringify(body),
  });
}

function assertMoved(result, operation, replacementRoute) {
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.schema, "mind-diary/mcp-operation-moved/v1");
  assert.deepEqual(result.structuredContent.error, {
    code: "operation_moved_to_sites",
    operation,
    destination: "sites_control_plane",
    replacement_route: replacementRoute,
    retryable: false,
  });
  assert.doesNotMatch(
    JSON.stringify(result),
    /download_url|downloadUrl|mind_id|mindId|principal|https:\/\//u,
  );
}

test("modern catalog omit administrative export", async () => {
  assert.equal(MCP_CONTENT_TOOLS.includes("start_export"), false);
  assert.equal(MCP_CONTENT_TOOLS.includes("get_export_status"), false);

  const modern = createMcpHttpHandler(dependencies());
  const modernResponse = await modern(modernRequest("tools/list", {}));
  assert.equal(modernResponse.status, 200);
  const modernNames = (await modernResponse.json()).result.tools.map(({ name }) => name);
  assert.equal(modernNames.includes("start_export"), false);
  assert.equal(modernNames.includes("get_export_status"), false);

});

test("removed export names return the same side-effect-free moved result", async () => {
  const profiles = [
    {
      handler: createMcpHttpHandler(dependencies()),
      request: modernRequest,
    },
  ];
  for (const profile of profiles) {
    for (const [operation, replacementRoute] of [
      ["start_export", "POST /api/v1/minds/{mind_ref}/exports"],
      ["get_export_status", "GET /api/v1/export-jobs/{job_id}"],
    ]) {
      const response = await profile.handler(profile.request("tools/call", {
        name: operation,
        arguments: operation === "start_export"
          ? { mind: "private-mind", idempotency_key: "must-not-run" }
          : { job_id: "must-not-be-read" },
      }));
      assert.equal(response.status, 200);
      assertMoved((await response.json()).result, operation, replacementRoute);
    }
  }
});

test("unknown tools and profile-specific removed methods keep protocol errors", async () => {
  const modern = createMcpHttpHandler(dependencies());
  const unknown = await modern(modernRequest("tools/call", {
    name: "start_import",
    arguments: {},
  }));
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.code, -32602);

  const modernPing = await modern(modernRequest("ping", {}));
  assert.equal(modernPing.status, 404);
  assert.equal((await modernPing.json()).error.code, -32601);

});
