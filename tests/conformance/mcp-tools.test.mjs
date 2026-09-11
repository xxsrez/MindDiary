import assert from "node:assert/strict";
import test from "node:test";

import {
  BundleFileDownloadFailure,
  MindBrowseFailure,
  MindSearchFailure,
} from "../../packages/application-content/dist/index.js";
import {
  MCP_CONTENT_TOOLS,
  MCP_READ_TOOL_DEFINITIONS,
  MCP_TOOL_DEFINITIONS,
  ProductMcpContentApplication,
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
  "list_files",
  "grep_files",
  "read_files",
  "list_revisions",
  "get_revision",
  "validate_mind",
  "list_bundle_files",
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
            .flatMap((definition) => [definition, definition]),
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
        if (request.name === "search" && request.arguments.query === "metadata-timeout") {
          throw Object.assign(new Error("private SQL parameters must not escape"), { code: "metadata_queue_timeout" });
        }
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
        if (
          request.name === "grep_files" &&
          request.arguments.after_context === 4
        ) {
          throw new MindBrowseFailure(
            "invalid_file_operation",
            "after_context exceeded the private implementation limit",
          );
        }
        if (
          request.name === "get_bundle_file_download" &&
          request.arguments.path === "assets/private.png"
        ) {
          throw new BundleFileDownloadFailure(
            "bundle_file_not_found",
            "private object key and provider diagnostic",
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
      new Request("https://mind-diary.invalid/api/mcp", {
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
    "list_bundle_files",
    "list_files",
    "grep_files",
    "read_files",
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
  assert.match(search.description, /implicit cross-Mind search/iu);
  assert.match(search.description, /enabled explicit Mind/iu);
  assert.deepEqual(
    search.inputSchema.properties.revision_selector.oneOf.map(
      (variant) => variant.properties.kind.const,
    ),
    ["head", "revision", "as_of"],
  );
  assert.deepEqual(definitions.get("fetch").inputSchema.required, ["id"]);
  assert.doesNotMatch(
    JSON.stringify(definitions.get("list_bundle_files").outputSchema),
    /download_url|bytes|provider|object_key/iu,
  );
  const listedMediaType = definitions.get("list_bundle_files")
    .outputSchema.properties.data.properties.files.items.properties.media_type;
  assert.equal(listedMediaType.enum, undefined);
  assert.equal(listedMediaType.maxLength, 127);
  assert.equal(
    listedMediaType.pattern,
    "^[!#$%&'*+.^_`|~0-9a-z-]+/[!#$%&'*+.^_`|~0-9a-z-]+$",
  );
  assert.deepEqual(
    Object.keys(definitions.get("fetch").inputSchema.properties),
    ["id"],
  );
  assert.deepEqual(definitions.get("get_revision").inputSchema.required, [
    "mind",
    "revision_id",
  ]);

  let nestedFilter = definitions.get("list_files").inputSchema.properties.where;
  for (let depth = 0; depth < 4; depth += 1) {
    const allGroup = nestedFilter.oneOf.find((variant) => variant.required?.[0] === "all");
    assert.ok(allGroup, `nested metadata all-group must be available at depth ${depth}`);
    nestedFilter = allGroup.properties.all.items;
  }
  assert.deepEqual(nestedFilter.required, ["field", "op"]);

  const grep = definitions.get("grep_files");
  for (const field of ["before_context", "after_context"]) {
    assert.equal(grep.inputSchema.properties[field].minimum, 0);
    assert.equal(grep.inputSchema.properties[field].maximum, 3);
  }
  assert.match(grep.description, /0 through 3/iu);
  const grepItemError = grep.outputSchema.properties.data.properties.errors
    .items.properties.error;
  assert.ok(grepItemError.required.includes("recovery"));
  assert.deepEqual(
    grepItemError.properties.recovery.properties.retry_policy.enum,
    ["after_refresh", "manual_alternative", "after_correction"],
  );
  const readError = definitions.get("read_files").outputSchema.properties.data
    .properties.items.items.oneOf.find(
      (variant) => variant.properties?.kind?.const === "error",
    ).properties.error;
  assert.ok(readError.required.includes("recovery"));
});

test("file-operation wrappers attach bounded recovery without changing product codes", async () => {
  const application = new ProductMcpContentApplication({
    browse: {
      async grepFiles() {
        return {
          errors: [{
            path: "assets/data.bin",
            error: { code: "file_not_text", retryable: false },
          }],
        };
      },
      async readFiles() {
        return {
          items: [{
            kind: "error",
            path: "notes.txt",
            error: { code: "range_out_of_bounds", retryable: false },
          }],
        };
      },
    },
  });
  const grepped = await application.executeToolCall({
    actor: actor(),
    name: "grep_files",
    arguments: {},
  });
  assert.deepEqual(grepped.errors[0].error, {
    code: "file_not_text",
    retryable: false,
    recovery: {
      action: "use_bundle_file_download",
      retry_policy: "manual_alternative",
    },
  });
  const read = await application.executeToolCall({
    actor: actor(),
    name: "read_files",
    arguments: {},
  });
  assert.deepEqual(read.items[0].error, {
    code: "range_out_of_bounds",
    retryable: false,
    recovery: {
      action: "correct_range",
      retry_policy: "after_correction",
    },
  });
});

test("tools/list ignores provider order, duplicates, and undeclared tools", async () => {
  const fixture = harness();
  const result = await rpcResult(await fixture.send(rpc("tools/list")));
  assert.deepEqual(
    result.tools.map(({ name }) => name),
    MCP_CONTENT_TOOLS.filter(
      (name) => name !== "open_bundle_file_picker" &&
        name !== "stage_bundle_file" &&
        name !== "create_file_upload_intent",
    ),
  );
  for (const tool of result.tools) {
    assert.equal(tool.inputSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(tool.outputSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.deepEqual(
      tool.securitySchemes,
      [{
        type: "oauth2",
        scopes: [
          tool.name === "get_personal_mind_configuration" || tool.name === "set_personal_mind_description" ? "personal:configure" :
          tool.name === "commit_changeset" ||
            tool.name === "reconcile_changeset" ||
            tool.name === "capture_knowledge" ||
            tool.name === "create_file_upload_intent" ||
            tool.name === "reconcile_file_stage"
            ? "content:write"
            : "content:read",
        ],
      }],
    );
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
  assert.ok(fixture.executionCalls[0].signal instanceof AbortSignal);
});

test("metadata queue deadline is retryable without leaking provider diagnostics", async () => {
  const fixture = harness();
  const response = await fixture.send(rpc("tools/call", {
    name: "search",
    arguments: { mind: "research-notes", query: "metadata-timeout" },
  }));
  const result = await rpcResult(response);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "metadata_queue_timeout");
  assert.equal(result.structuredContent.error.retryable, true);
  assert.doesNotMatch(JSON.stringify(result), /private SQL parameters/);
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
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent.error, {
    code: "search_index_unavailable",
    message: "Search is unavailable for the exact requested revision; continue with list_files, grep_files, and read_files for the same Mind and revision.",
    retryable: true,
    request_id: "request_read_tools_1",
    details: {
      category: "service_state",
      state: "index_unavailable",
      recovery: {
        action: "use_file_workflow_same_revision",
        retry_policy: "bounded",
        preserve: ["mind", "revision"],
        tools: ["list_files", "grep_files", "read_files"],
      },
    },
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("private-query"), false);
  assert.equal(serialized.includes("mind_secret"), false);
  assert.deepEqual(result.content, [
    {
      type: "text",
      text: "Search is unavailable for the exact requested revision; continue with list_files, grep_files, and read_files for the same Mind and revision.",
    },
  ]);
});

test("invalid grep context stays a non-retryable product validation result", async () => {
  const fixture = harness();
  const result = await rpcResult(await fixture.send(rpc("tools/call", {
    name: "grep_files",
    arguments: {
      mind: "research-notes",
      revision_selector: { kind: "revision", revision_id: "rev_exact" },
      patterns: ["known"],
      after_context: 4,
    },
  })));
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent.error, {
    code: "invalid_file_operation",
    message: "The file operation arguments are invalid; correct them before retrying.",
    retryable: false,
    request_id: "request_read_tools_1",
    details: {
      category: "validation",
      state: "request_rejected",
      recovery: {
        action: "correct_arguments",
        retry_policy: "after_correction",
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /INVALID_ARGUMENT|private implementation/iu);
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

test("download-grant application failures stay structured and privacy-safe", async () => {
  const fixture = harness();
  const result = await rpcResult(await fixture.send(rpc("tools/call", {
    name: "get_bundle_file_download",
    arguments: {
      mind: "research-notes",
      revision_selector: { kind: "revision", revision_id: "rev_exact" },
      path: "assets/private.png",
    },
  })));
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent.error, {
    code: "bundle_file_not_found",
    message: "BundleFile was not found.",
    retryable: false,
    request_id: "request_read_tools_1",
    details: {
      category: "content_state",
      state: "file_unavailable",
      recovery: {
        action: "refresh_file_list",
        retry_policy: "after_refresh",
        preserve: ["mind", "revision"],
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /private object|provider diagnostic/iu);
  assert.doesNotMatch(JSON.stringify(result), /https?:\/\/|download_url|token|secret/iu);
});
