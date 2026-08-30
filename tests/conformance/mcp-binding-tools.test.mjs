import assert from "node:assert/strict";
import test from "node:test";

import { CAPABILITIES } from "@mind-diary/domain";
import {
  MCP_CONTENT_TOOLS,
  MCP_AGENT_INSTRUCTIONS,
  MCP_LEGACY_CODEX_PROTOCOL,
  MCP_MOVED_EXPORT_TOOLS,
  MCP_RETIRED_BINDING_TOOLS,
  MCP_RETIRED_CAPTURE_TOOLS,
  MCP_TOOL_DEFINITIONS,
  createLegacyCodexMcpHttpHandler,
  createMcpHttpHandler,
} from "../../packages/adapter-mcp/dist/index.js";

const MODERN = "2026-07-28";
const COMPAT = "2025-11-25";
const NOW = "2026-08-27T22:00:00.000Z";

function protocolMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN,
    "io.modelcontextprotocol/clientInfo": {
      name: "retired-binding-conformance",
      version: "0.0.0",
    },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

function modernRpc(method, { id = 1, name, arguments: args = {} } = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...(name === undefined ? {} : { name }),
      ...(method === "tools/call" ? { arguments: args } : {}),
      _meta: protocolMeta(),
    },
  };
}

function harness() {
  const calls = {
    authorize: 0,
    executeAuthorized: 0,
    execute: 0,
  };
  const actor = Object.freeze({
    kind: "registered_principal",
    principalId: "principal_retired_binding",
    authentication: Object.freeze({
      kind: "mcp_token",
      tokenId: "token_retired_binding",
      bindingOwnerId: "owner_retired_binding",
      effectiveScopes: Object.freeze(["content:read"]),
    }),
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_retired_binding_actor",
    occurredAtUtc: NOW,
  });
  const content = {
    async listTools() {
      return MCP_TOOL_DEFINITIONS;
    },
    async listRootResources() {
      return { resources: [], nextCursor: null };
    },
    async readResource() {
      throw new Error("resource read must not run");
    },
    async authorizeToolCall() {
      calls.authorize += 1;
      return { kind: "allowed" };
    },
    async executeAuthorizedToolCall() {
      calls.executeAuthorized += 1;
      throw new Error("retired tool must not reach the application");
    },
    async executeToolCall() {
      calls.execute += 1;
      throw new Error("retired tool must not reach the application");
    },
  };
  let request = 0;
  const dependencies = {
    authenticator: {
      async authenticate(candidate) {
        return candidate === "read-token"
          ? { kind: "authenticated", actor }
          : { kind: "invalid" };
      },
    },
    requestIds: { nextRequestId: () => `request_retired_binding_${++request}` },
    content,
  };
  const modern = createMcpHttpHandler(dependencies);
  const compatibility = createLegacyCodexMcpHttpHandler(dependencies);

  async function sendModern(body) {
    const name = body.method === "tools/call" ? body.params.name : null;
    return modern(new Request("https://mind-diary.invalid/api/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer read-token",
        "content-type": "application/json",
        "mcp-method": body.method,
        "mcp-protocol-version": MODERN,
        ...(name === null ? {} : { "mcp-name": name }),
      },
      body: JSON.stringify(body),
    }));
  }

  async function sendCompatibility(body) {
    return compatibility(new Request(
      "https://mind-diary.invalid/api/mcp/2025-11-25",
      {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer read-token",
          "content-type": "application/json",
          ...(body.method === "initialize"
            ? {}
            : { "mcp-protocol-version": COMPAT }),
        },
        body: JSON.stringify(body),
      },
    ));
  }

  return { calls, sendModern, sendCompatibility };
}

async function payload(response, status = 200) {
  assert.equal(response.status, status);
  return response.json();
}

function assertNoApplicationCalls(calls) {
  assert.deepEqual(calls, {
    authorize: 0,
    executeAuthorized: 0,
    execute: 0,
  });
}

test("fresh modern and compatibility discovery omit retired binding/capture mutations and export admin", async () => {
  assert.deepEqual(MCP_TOOL_DEFINITIONS.map(({ name }) => name), MCP_CONTENT_TOOLS);
  for (const retired of [
    ...MCP_RETIRED_BINDING_TOOLS,
    ...MCP_RETIRED_CAPTURE_TOOLS,
    ...MCP_MOVED_EXPORT_TOOLS,
  ]) {
    assert.equal(MCP_CONTENT_TOOLS.includes(retired), false, retired);
    assert.equal(JSON.stringify(MCP_TOOL_DEFINITIONS).includes(retired), false, retired);
  }

  const env = harness();
  const advertisedNames = MCP_CONTENT_TOOLS.filter(
    (name) => name !== "open_bundle_file_picker" &&
      name !== "create_file_upload_intent" &&
      name !== "stage_bundle_file",
  );
  const discover = (await payload(await env.sendModern(
    modernRpc("server/discover", { id: 0 }),
  ))).result;
  assert.equal(discover.instructions, MCP_AGENT_INSTRUCTIONS);
  assert.match(discover.instructions, /current access/u);
  assert.match(discover.instructions, /writable_mount\.active=true/u);
  assert.doesNotMatch(discover.instructions, /get_mind_bindings|set_read_mind_binding|set_write_mind_binding|capture_knowledge/u);

  const modern = (await payload(await env.sendModern(modernRpc("tools/list")))).result;
  assert.deepEqual(modern.tools.map(({ name }) => name), advertisedNames);

  const initialize = (await payload(await env.sendCompatibility({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: MCP_LEGACY_CODEX_PROTOCOL,
      capabilities: {},
      clientInfo: { name: "codex-mcp-client", version: "0.147.0" },
    },
  }))).result;
  assert.equal(initialize.protocolVersion, MCP_LEGACY_CODEX_PROTOCOL);
  assert.equal(initialize.instructions, MCP_AGENT_INSTRUCTIONS);
  assert.match(initialize.instructions, /current access/u);
  assert.match(initialize.instructions, /writable_mount\.active=true/u);
  assert.doesNotMatch(initialize.instructions, /get_mind_bindings|set_read_mind_binding|set_write_mind_binding|capture_knowledge/u);

  const compatibility = (await payload(await env.sendCompatibility({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  }))).result;
  assert.deepEqual(compatibility.tools.map(({ name }) => name), advertisedNames);
  assert.deepEqual(compatibility.tools, modern.tools);
  assertNoApplicationCalls(env.calls);
});

test("exact cached binding and capture calls return the same versioned fail-closed result without side effects", async () => {
  const env = harness();
  const expectedRemediation = {
    get_mind_bindings: "inspect_mind_usage_on_site",
    set_read_mind_binding: "manage_mind_usage_on_site",
    set_write_mind_binding: "manage_mind_usage_on_site",
    capture_knowledge: "use_commit_changeset",
  };
  let id = 10;
  for (const name of [
    ...MCP_RETIRED_BINDING_TOOLS,
    ...MCP_RETIRED_CAPTURE_TOOLS,
  ]) {
    const secretArgument = `raw-${name}-must-not-echo`;
    const args = {
      mind: secretArgument,
      binding_id: `binding-${secretArgument}`,
      generation: 999,
      nested: { principal_id: `principal-${secretArgument}` },
    };
    const modern = (await payload(await env.sendModern(
      modernRpc("tools/call", { id: ++id, name, arguments: args }),
    ))).result;
    const compatibility = (await payload(await env.sendCompatibility({
      jsonrpc: "2.0",
      id: ++id,
      method: "tools/call",
      params: { name, arguments: args },
    }))).result;

    assert.equal(modern.resultType, "complete");
    assert.equal("resultType" in compatibility, false);
    for (const result of [modern, compatibility]) {
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, {
        schema: "mind-diary/mcp-operation-retired/v1",
        error: {
          code: "operation_retired_from_content_mcp",
          operation: name,
          remediation: expectedRemediation[name],
          retryable: false,
        },
      });
      assert.equal(JSON.stringify(result).includes(secretArgument), false);
      assert.equal(JSON.stringify(result).includes("binding_id"), false);
      assert.equal(JSON.stringify(result).includes("principal_id"), false);
    }
  }
  assertNoApplicationCalls(env.calls);
});

test("unknown near-miss names remain protocol errors and never reach the application", async () => {
  const env = harness();
  const modern = await payload(await env.sendModern(
    modernRpc("tools/call", {
      id: 31,
      name: "get_mind_binding",
      arguments: {},
    }),
  ), 400);
  assert.equal(modern.error.code, -32602);
  assert.equal(modern.error.message, "Invalid params");

  const compatibility = await payload(await env.sendCompatibility({
    jsonrpc: "2.0",
    id: 32,
    method: "tools/call",
    params: { name: "set_write_mind_bindings", arguments: {} },
  }), 400);
  assert.equal(compatibility.error.code, -32602);
  assert.equal(compatibility.error.message, "Invalid params");
  assertNoApplicationCalls(env.calls);
});
