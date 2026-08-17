import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_COMMIT_EXPORT_TOOL_DEFINITIONS,
  MCP_READ_TOOL_DEFINITIONS,
  createMcpHttpHandler,
  createMcpToolErrorResult,
  createMcpToolSuccessResult,
} from "../../packages/adapter-mcp/dist/index.js";

const PROTOCOL = "2026-07-28";

function actor(scopes) {
  return Object.freeze({
    kind: "registered_principal",
    principalId: "principal_tools",
    authentication: Object.freeze({
      kind: "mcp_token",
      tokenId: `token_${scopes.at(-1)}`,
      effectiveScopes: Object.freeze(scopes),
    }),
    deploymentCapabilities: Object.freeze(["content:read", "content:write"]),
    requestId: "request_actor",
    occurredAtUtc: "2026-08-07T13:00:00.000Z",
  });
}

function protocolMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": PROTOCOL,
    "io.modelcontextprotocol/clientInfo": {
      name: "commit-export-conformance",
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

function commitArguments(overrides = {}) {
  return {
    mind: "research-notes",
    expected_revision: "rev_1",
    idempotency_key: "commit-key",
    summary: "Add one Memory",
    operations: [
      {
        type: "create_file",
        path: "concepts/new.md",
        text: "---\ntype: Reference\n---\n\nNew.\n",
      },
    ],
    ...overrides,
  };
}

function harness() {
  let nextRequestId = 0;
  let head = "rev_1";
  let commits = 0;
  let exportJobs = 0;
  let accessAllowed = true;
  let denyAsInactiveToken = false;
  const commitResults = new Map();
  const exportResults = new Map();
  const authorizationCalls = [];
  const executionCalls = [];
  const writeActor = actor(["content:read", "content:write"]);
  const readActor = actor(["content:read"]);

  const handler = createMcpHttpHandler({
    authenticator: {
      async authenticate(candidate) {
        if (candidate === "write-token") {
          return { kind: "authenticated", actor: writeActor };
        }
        if (candidate === "read-token") {
          return { kind: "authenticated", actor: readActor };
        }
        return { kind: "invalid" };
      },
    },
    requestIds: {
      nextRequestId() {
        nextRequestId += 1;
        return `request_tools_${nextRequestId}`;
      },
    },
    content: {
      async listTools() {
        return MCP_COMMIT_EXPORT_TOOL_DEFINITIONS.map(({ name }) => ({ name }));
      },
      async authorizeToolCall(request) {
        authorizationCalls.push(request.name);
        if (denyAsInactiveToken) {
          denyAsInactiveToken = false;
          return { kind: "denied", code: "token_inactive" };
        }
        return accessAllowed
          ? { kind: "allowed" }
          : { kind: "denied", code: "capability_denied" };
      },
      async executeToolCall(request) {
        executionCalls.push(request.name);
        if (request.name === "commit_changeset") {
          const prior = commitResults.get(request.arguments.idempotency_key);
          if (prior !== undefined) return prior;
          if (request.arguments.expected_revision !== head) {
            return createMcpToolErrorResult(
              request.actor.requestId,
              "revision_conflict",
              "HEAD changed; fetch the current revision and rebuild the changeset.",
              true,
              { current_revision: head },
            );
          }
          const path = request.arguments.operations?.[0]?.path;
          if (path === "concepts/invalid.md") {
            return createMcpToolErrorResult(
              request.actor.requestId,
              "okf_validation_failed",
              "The resulting Mind is not a valid OKF 0.2 bundle.",
              false,
              { path },
            );
          }
          if (path === "concepts/missing.md") {
            return createMcpToolErrorResult(
              request.actor.requestId,
              "file_not_found",
              "The requested file does not exist in the expected revision.",
              false,
              { path },
            );
          }
          const previous = head;
          commits += 1;
          head = `rev_${commits + 1}`;
          const result = createMcpToolSuccessResult(
            {
              mind: { mind_id: "mind_research" },
              previous_revision_id: previous,
              revision: { revision_id: head, revision_number: commits + 1 },
              index_status: "queued",
            },
            `Committed revision ${head}.`,
          );
          commitResults.set(request.arguments.idempotency_key, result);
          return result;
        }

        if (request.name === "start_export") {
          const prior = exportResults.get(request.arguments.idempotency_key);
          if (prior !== undefined) return prior;
          const revisionId =
            request.arguments.revision_selector?.kind === "revision"
              ? request.arguments.revision_selector.revision_id
              : head;
          exportJobs += 1;
          const result = createMcpToolSuccessResult(
            {
              job: {
                job_id: `export_${exportJobs}`,
                status: "queued",
                revision_id: revisionId,
                created_at: "2026-08-07T13:00:00.000Z",
              },
            },
            `Export queued for revision ${revisionId}.`,
          );
          exportResults.set(request.arguments.idempotency_key, result);
          return result;
        }

        return createMcpToolSuccessResult(
          {
            job: {
              job_id: request.arguments.job_id,
              status: "running",
              revision_id: "rev_1",
            },
          },
          "Export is still running.",
        );
      },
    },
  });

  async function send(body, token = "write-token") {
    const name = body.method === "tools/call" ? body.params.name : undefined;
    const headers = new Headers({
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-method": body.method,
      "mcp-protocol-version": PROTOCOL,
      ...(name === undefined ? {} : { "mcp-name": name }),
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    });
    return handler(
      new Request("https://mind-diary.invalid/api/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
  }

  return {
    send,
    state: {
      authorizationCalls,
      executionCalls,
      commits: () => commits,
      exportJobs: () => exportJobs,
      head: () => head,
      setAccessAllowed(value) {
        accessAllowed = value;
      },
      denyNextAsInactiveToken() {
        denyAsInactiveToken = true;
      },
    },
  };
}

async function result(response) {
  return (await response.json()).result;
}

test("publishes strict commit/export schemas and truthful annotations", () => {
  const definitions = new Map(
    MCP_COMMIT_EXPORT_TOOL_DEFINITIONS.map((definition) => [
      definition.name,
      definition,
    ]),
  );
  assert.deepEqual([...definitions.keys()], [
    "commit_changeset",
    "start_export",
    "get_export_status",
  ]);

  const commit = definitions.get("commit_changeset");
  assert.equal(commit.inputSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(commit.inputSchema.additionalProperties, false);
  assert.deepEqual(commit.inputSchema.required, [
    "mind",
    "expected_revision",
    "idempotency_key",
    "summary",
    "operations",
  ]);
  assert.deepEqual(
    commit.inputSchema.properties.operations.items.oneOf.map(
      (operation) => operation.properties.type.const,
    ),
    ["create_file", "replace_file", "delete_file", "replace_index", "add_log_entry"],
  );
  assert.deepEqual(commit.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  });
  assert.match(commit.description, /preview exact paths and visibility impact/u);
  assert.match(commit.description, /obtain explicit confirmation/u);
  assert.match(commit.description, /re-read HEAD/u);
  assert.match(commit.description, /revision_conflict/u);

  const startExport = definitions.get("start_export");
  assert.deepEqual(startExport.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  });
  assert.match(startExport.description, /exact revision/u);
  const exportStatus = definitions.get("get_export_status");
  assert.deepEqual(exportStatus.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  });
  assert.match(exportStatus.description, /exact SHA-256 and size/u);
  assert.match(exportStatus.description, /Keep the URL out of logs and prompts/u);
  assert.equal(
    "bytes" in
      exportStatus.outputSchema.properties.data.properties.job
        .properties,
    false,
  );
});

test("history tool descriptions keep historical restore read-only and require a fresh confirmed commit", () => {
  const definitions = new Map(
    MCP_READ_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]),
  );
  assert.match(definitions.get("list_revisions").description, /restore preview/u);
  assert.match(definitions.get("list_revisions").description, /never makes history writable/u);
  assert.match(definitions.get("get_revision").description, /Historical reads remain read-only/u);
  assert.match(definitions.get("get_revision").description, /confirmed commit_changeset against a fresh current HEAD/u);
});

test("tools/list advertises write scope for step-up while enforcing read-only tokens", async () => {
  const fixture = harness();
  const writable = await result(await fixture.send(rpc("tools/list")));
  assert.deepEqual(
    writable.tools.map((definition) => definition.name),
    ["commit_changeset", "start_export", "get_export_status"],
  );
  assert.equal(writable.tools[0].inputSchema.additionalProperties, false);

  const readable = await result(
    await fixture.send(rpc("tools/list", { id: 2 }), "read-token"),
  );
  assert.deepEqual(
    readable.tools.map((definition) => definition.name),
    ["commit_changeset", "start_export", "get_export_status"],
  );
  assert.deepEqual(readable.tools[0].securitySchemes, [
    { type: "oauth2", scopes: ["content:write"] },
  ]);

  const denied = await fixture.send(
    rpc("tools/call", {
      id: 3,
      name: "commit_changeset",
      arguments: commitArguments(),
    }),
    "read-token",
  );
  const deniedResult = await result(denied);
  assert.equal(denied.status, 200);
  assert.equal(deniedResult.structuredContent.error.code, "insufficient_scope");
  assert.equal(fixture.state.authorizationCalls.length, 0);
  assert.equal(fixture.state.executionCalls.length, 0);
});

test("commit is immediate, idempotent, and leaves final state unchanged on invalid, stale, denied, and auth-race attempts", async () => {
  const fixture = harness();
  const call = rpc("tools/call", {
    name: "commit_changeset",
    arguments: commitArguments(),
  });
  const first = await result(await fixture.send(call));
  const retry = await result(await fixture.send(call));
  assert.deepEqual(retry, first);
  assert.equal(fixture.state.commits(), 1);
  assert.equal(fixture.state.head(), "rev_2");
  assert.equal(JSON.stringify(first).includes("draft"), false);
  assert.equal(JSON.stringify(first).includes("approval"), false);

  for (const [id, path, code] of [
    [2, "concepts/invalid.md", "okf_validation_failed"],
    [3, "concepts/missing.md", "file_not_found"],
  ]) {
    const response = await result(
      await fixture.send(
        rpc("tools/call", {
          id,
          name: "commit_changeset",
          arguments: commitArguments({
            expected_revision: "rev_2",
            idempotency_key: `invalid-${id}`,
            operations: [{ type: "delete_file", path }],
          }),
        }),
      ),
    );
    assert.equal(response.structuredContent.error.code, code);
    assert.equal(fixture.state.head(), "rev_2");
  }

  const stale = await result(
    await fixture.send(
      rpc("tools/call", {
        id: 4,
        name: "commit_changeset",
        arguments: commitArguments({ idempotency_key: "stale" }),
      }),
    ),
  );
  assert.equal(stale.structuredContent.error.code, "revision_conflict");
  assert.equal(stale.structuredContent.error.details.current_revision, "rev_2");
  assert.equal(fixture.state.head(), "rev_2");

  fixture.state.setAccessAllowed(false);
  const denied = await result(
    await fixture.send(
      rpc("tools/call", {
        id: 5,
        name: "commit_changeset",
        arguments: commitArguments({
          expected_revision: "rev_2",
          idempotency_key: "role-denied",
        }),
      }),
    ),
  );
  assert.equal(denied.structuredContent.error.code, "capability_denied");
  assert.equal(fixture.state.head(), "rev_2");

  fixture.state.setAccessAllowed(true);
  fixture.state.denyNextAsInactiveToken();
  const race = await fixture.send(
    rpc("tools/call", {
      id: 6,
      name: "commit_changeset",
      arguments: commitArguments({
        expected_revision: "rev_2",
        idempotency_key: "auth-race",
      }),
    }),
  );
  assert.equal(race.status, 401);
  assert.equal((await race.json()).code, "authentication_required");
  assert.equal(fixture.state.head(), "rev_2");
});

test("export stays asynchronous and exact-revision while status and authentication are rechecked", async () => {
  const fixture = harness();
  const start = rpc("tools/call", {
    name: "start_export",
    arguments: {
      mind: "research-notes",
      revision_selector: { kind: "revision", revision_id: "rev_1" },
      idempotency_key: "export-key",
    },
  });
  const first = await result(await fixture.send(start));
  const retry = await result(await fixture.send(start));
  assert.deepEqual(retry, first);
  assert.equal(fixture.state.exportJobs(), 1);
  assert.equal(first.structuredContent.data.job.status, "queued");
  assert.equal(first.structuredContent.data.job.revision_id, "rev_1");
  assert.equal("bytes" in first.structuredContent.data.job, false);
  assert.equal("download_url" in first.structuredContent.data.job, false);

  const statusCall = rpc("tools/call", {
    id: 2,
    name: "get_export_status",
    arguments: { job_id: "export_1" },
  });
  const running = await result(await fixture.send(statusCall));
  assert.equal(running.structuredContent.data.job.status, "running");

  fixture.state.setAccessAllowed(false);
  const revoked = await result(await fixture.send(statusCall));
  assert.equal(revoked.structuredContent.error.code, "capability_denied");
  assert.equal(
    fixture.state.authorizationCalls.filter((name) => name === "get_export_status").length,
    2,
  );
  assert.equal(
    fixture.state.executionCalls.filter((name) => name === "get_export_status").length,
    1,
  );

  const unauthenticated = await fixture.send(statusCall, null);
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json()).code, "authentication_required");
});
