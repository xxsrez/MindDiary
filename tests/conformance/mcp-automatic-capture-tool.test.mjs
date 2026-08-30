import assert from "node:assert/strict";
import test from "node:test";

import { CAPABILITIES } from "@mind-diary/domain";
import {
  MCP_CONTENT_TOOLS,
  MCP_RETIRED_CAPTURE_TOOLS,
  MCP_TOOL_DEFINITIONS,
  createMcpHttpHandler,
} from "../../packages/adapter-mcp/dist/index.js";

const PROTOCOL = "2026-07-28";

function rpc(argumentsValue, id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "capture_knowledge",
      arguments: argumentsValue,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": PROTOCOL,
        "io.modelcontextprotocol/clientInfo": {
          name: "retired-capture-conformance",
          version: "0.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
}

test("fresh MCP discovery retires capture_knowledge in favor of commit_changeset", () => {
  assert.deepEqual(MCP_RETIRED_CAPTURE_TOOLS, ["capture_knowledge"]);
  assert.equal(MCP_CONTENT_TOOLS.includes("capture_knowledge"), false);
  assert.equal(MCP_TOOL_DEFINITIONS.some(({ name }) => name === "capture_knowledge"), false);
  assert.equal(MCP_CONTENT_TOOLS.includes("commit_changeset"), true);
});

test("cached capture_knowledge calls are side-effect-free and redact arguments", async () => {
  const calls = { authorize: 0, execute: 0 };
  const actor = Object.freeze({
    kind: "registered_principal",
    principalId: "principal_retired_capture",
    authentication: Object.freeze({
      kind: "mcp_token",
      tokenId: "token_retired_capture",
      bindingOwnerId: "grant_retired_capture",
      effectiveScopes: Object.freeze(["content:read", "content:write"]),
    }),
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_retired_capture",
    occurredAtUtc: "2026-08-30T20:00:00.000Z",
  });
  const handler = createMcpHttpHandler({
    authenticator: {
      async authenticate() { return { kind: "authenticated", actor }; },
    },
    requestIds: { nextRequestId: () => "request_retired_capture_http" },
    content: {
      async listTools() { return MCP_TOOL_DEFINITIONS; },
      async listRootResources() { return { resources: [], nextCursor: null }; },
      async readResource() { throw new Error("unused"); },
      async authorizeToolCall() {
        calls.authorize += 1;
        throw new Error("retired capture must bypass application authorization");
      },
      async executeToolCall() {
        calls.execute += 1;
        throw new Error("retired capture must bypass application execution");
      },
    },
  });
  const privateMarker = "PRIVATE_CAPTURE_BODY_MUST_NOT_ECHO";
  const response = await handler(new Request("https://mind-diary.invalid/api/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: "Bearer write-token",
      "content-type": "application/json",
      "mcp-method": "tools/call",
      "mcp-name": "capture_knowledge",
      "mcp-protocol-version": PROTOCOL,
    },
    body: JSON.stringify(rpc({ body: privateMarker, write_binding_id: "secret-binding" })),
  }));

  assert.equal(response.status, 200);
  const result = (await response.json()).result;
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    schema: "mind-diary/mcp-operation-retired/v1",
    error: {
      code: "operation_retired_from_content_mcp",
      operation: "capture_knowledge",
      remediation: "use_commit_changeset",
      retryable: false,
    },
  });
  assert.equal(JSON.stringify(result).includes(privateMarker), false);
  assert.equal(JSON.stringify(result).includes("secret-binding"), false);
  assert.deepEqual(calls, { authorize: 0, execute: 0 });
});
