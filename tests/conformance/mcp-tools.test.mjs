import assert from "node:assert/strict";
import test from "node:test";

import { MindSearchFailure } from "../../packages/application-content/dist/index.js";
import {
  MCP_CONTENT_TOOLS,
  MCP_READ_TOOL_DEFINITIONS,
  MCP_TOOL_DEFINITIONS,
  createMcpHttpHandler,
} from "../../packages/adapter-mcp/dist/index.js";

const PROTOCOL = "2026-07-28";
const READ_TOOL_NAMES = [
  "list_minds",
  "resolve_mind",
  "get_mind_info",
  "browse_entries",
  "search",
  "fetch",
  "list_revisions",
  "get_revision",
  "validate_mind",
];

function actor() {
  return Object.freeze({
    kind: "registered_principal",
    principalId: "principal_mcp_tools",
    authentication: Object.freeze({
      kind: "mcp_token",
      tokenId: "token_read",
      effectiveScopes: Object.freeze(["content:read"]),
    }),
    deploymentCapabilities: Object.freeze(["content:read"]),
    requestId: "request_actor",
    occurredAtUtc: "2026-08-07T20:00:00.000Z",
  });
}

function protocolMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": PROTOCOL,
    "io.modelcontextprotocol/clientInfo": {
      name: "read-tools-conformance",
      version: "0.0.0",
    },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

function rpc(method, { id = 1, name, arguments: args = {} } = {}) {
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
  let nextRequestId = 0;
  const authorizationCalls = [];
  const executionCalls = [];
  const authenticatedActor = actor();

  const handler = createMcpHttpHandler({
    authenticator: {
      async authenticate(candidate) {
        return candidate === "read-token"
          ? { kind: "authenticated", actor: authenticatedActor }
          : { kind: "invalid" };
      },
    },
    requestIds: {
      nextRequestId() {
        nextRequestId += 1;
        return `request_read_tools_${nextRequestId}`;
      },
    },
    content: {
      async listTools() {
        return [
          { name: "unknown_private_tool" },
          ...[...MCP_TOOL_DEFINITIONS]
            .reverse()
            .flatMap(({ name }) => [{ name }, { name }]),
        ];
      },
      async authorizeToolCall(request) {
        authorizationCalls.push(request);
        if (request.arguments.mind === "private-mind") {
          return { kind: "denied", code: "private_membership_row_42" };
        }
        return { kind: "allowed" };
      },
      async executeToolCall(request) {
        executionCalls.push(request);
        if (
          request.name === "search" &&
          request.arguments.query === "private-query"
        ) {
          throw new MindSearchFailure(
            "search_index_unavailable",
            "private-query from mind_secret leaked from an index exception",
            true,
          );
        }
        if (request.name === "search") {
          return {
            mind: { mind_id: "mind_one" },
            resolved_revision: { revision_id: "rev_exact" },
            results: [],
            next_cursor: null,
            index_status: "ready",
          };
        }
        return {};
      },
    },
  });

  async function send(body) {
    const name = body.method === "tools/call" ? body.params.name : undefined;
    return handler(
      new Request("https://mind-diary.invalid/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer read-token",
          "content-type": "application/json",
          "mcp-method": body.method,
          "mcp-protocol-version": PROTOCOL,
          ...(name === undefined ? {} : { "mcp-name": name }),
        },
        body: JSON.stringify(body),
      }),
    );
  }

  return { send, authorizationCalls, executionCalls };
}

async function rpcResult(response) {
  assert.equal(response.status, 200);
  return (await response.json()).result;
}

test("publishes deterministic JSON Schema 2020-12 definitions for all read tools", () => {
  assert.deepEqual(
    MCP_READ_TOOL_DEFINITIONS.map(({ name }) => name),
    READ_TOOL_NAMES,
  );
  assert.deepEqual(
    MCP_TOOL_DEFINITIONS.map(({ name }) => name),
    MCP_CONTENT_TOOLS,
  );

  for (const definition of MCP_READ_TOOL_DEFINITIONS) {
    assert.equal(definition.inputSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(definition.outputSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(definition.inputSchema.type, "object");
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.equal(definition.outputSchema.type, "object");
    assert.equal(definition.outputSchema.additionalProperties, false);
    assert.match(definition.title, /\S/u);
    assert.match(definition.description, /\S/u);
    assert.deepEqual(definition.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
  }
});

test("schemas require one explicit Mind and one revision selector shape", () => {
  const definitions = new Map(
    MCP_READ_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]),
  );
  for (const name of [
    "get_mind_info",
    "browse_entries",
    "search",
    "list_revisions",
    "get_revision",
    "validate_mind",
  ]) {
    const input = definitions.get(name).inputSchema;
    assert.ok(input.required.includes("mind"), `${name} must require mind`);
    assert.ok("mind" in input.properties);
    assert.equal("minds" in input.properties, false);
  }

  const search = definitions.get("search");
  assert.deepEqual(search.inputSchema.required, ["mind", "query"]);
  assert.match(search.description, /never performs implicit cross-Mind search/u);
  assert.deepEqual(
    search.inputSchema.properties.revision_selector.oneOf.map(
      (variant) => variant.properties.kind.const,
    ),
    ["head", "revision", "as_of"],
  );
  assert.deepEqual(definitions.get("fetch").inputSchema.required, ["id"]);
  assert.deepEqual(
    Object.keys(definitions.get("fetch").inputSchema.properties),
    ["id"],
  );
  assert.deepEqual(definitions.get("get_revision").inputSchema.required, [
    "mind",
    "revision_id",
  ]);
});

test("tools/list ignores provider order, duplicates, and undeclared tools", async () => {
  const fixture = harness();
  const result = await rpcResult(await fixture.send(rpc("tools/list")));
  assert.deepEqual(
    result.tools.map(({ name }) => name),
    MCP_CONTENT_TOOLS.filter((name) => name !== "commit_changeset"),
  );
  for (const tool of result.tools) {
    assert.equal(tool.inputSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(tool.outputSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  }
});

test("read execution preserves explicit exact binding and adds structured/text results", async () => {
  const fixture = harness();
  const argumentsValue = {
    mind: "research-notes",
    revision_selector: { kind: "revision", revision_id: "rev_exact" },
    query: "API design",
  };
  const result = await rpcResult(
    await fixture.send(
      rpc("tools/call", {
        name: "search",
        arguments: argumentsValue,
      }),
    ),
  );

  assert.equal(result.resultType, "complete");
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.data.mind.mind_id, "mind_one");
  assert.equal(result.structuredContent.data.resolved_revision.revision_id, "rev_exact");
  assert.deepEqual(result.content, [
    { type: "text", text: "Searched the resolved Mind revision." },
  ]);
  assert.equal(fixture.authorizationCalls.length, 1);
  assert.equal(fixture.executionCalls.length, 1);
  assert.deepEqual(fixture.authorizationCalls[0].arguments, argumentsValue);
  assert.deepEqual(fixture.executionCalls[0].arguments, argumentsValue);
});

test("known read failures map to stable retryable errors without private text", async () => {
  const fixture = harness();
  const response = await fixture.send(
    rpc("tools/call", {
      name: "search",
      arguments: {
        mind: "research-notes",
        revision_selector: { kind: "revision", revision_id: "rev_exact" },
        query: "private-query",
      },
    }),
  );
  const result = await rpcResult(response);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent.error, {
    code: "search_index_unavailable",
    message: "Search is unavailable for the exact requested revision.",
    retryable: true,
    request_id: "request_read_tools_1",
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("private-query"), false);
  assert.equal(serialized.includes("mind_secret"), false);
  assert.deepEqual(result.content, [
    {
      type: "text",
      text: "Search is unavailable for the exact requested revision.",
    },
  ]);
});

test("authorization denial is generic and never reaches read execution", async () => {
  const fixture = harness();
  const result = await rpcResult(
    await fixture.send(
      rpc("tools/call", {
        name: "validate_mind",
        arguments: { mind: "private-mind" },
      }),
    ),
  );
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "forbidden");
  assert.equal(
    result.structuredContent.error.message,
    "The requested operation is not allowed.",
  );
  assert.equal(JSON.stringify(result).includes("private_membership_row_42"), false);
  assert.equal(fixture.executionCalls.length, 0);
});
