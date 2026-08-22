import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_CONTENT_TOOLS,
  MCP_LEGACY_CODEX_ENDPOINT,
  MCP_LEGACY_CODEX_PROTOCOL,
  createLegacyCodexMcpHttpHandler,
  createMcpHttpHandler,
} from "../../packages/adapter-mcp/dist/index.js";

const PROTOCOL = "2026-07-28";

function protocolMeta(overrides = {}) {
  return {
    "io.modelcontextprotocol/protocolVersion": PROTOCOL,
    "io.modelcontextprotocol/clientInfo": {
      name: "mind-diary-transport-tests",
      version: "0.0.0",
    },
    "io.modelcontextprotocol/clientCapabilities": {},
    ...overrides,
  };
}

function rpcRequest(method, { id = 1, name, arguments: args = {}, meta } = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...(name === undefined ? {} : { name }),
      ...(method === "tools/call" ? { arguments: args } : {}),
      _meta: meta ?? protocolMeta(),
    },
  };
}

function harness({ fused = false } = {}) {
  let nextRequestId = 0;
  let authenticationCalls = 0;
  let listCalls = 0;
  let authorizationCalls = 0;
  let executionCalls = 0;
  let fusedExecutionCalls = 0;
  let committedRevisions = 0;
  const idempotencyResults = new Map();
  const actor = Object.freeze({
    kind: "registered_principal",
    principalId: "principal_transport",
    authentication: Object.freeze({
      kind: "mcp_token",
      tokenId: "token_transport",
      effectiveScopes: Object.freeze(["content:read", "content:write"]),
    }),
    deploymentCapabilities: Object.freeze(["content:read", "content:write"]),
    requestId: "request_transport_actor",
    occurredAtUtc: "2026-08-07T02:40:00.000Z",
  });

  const content = {
    async listTools() {
      listCalls += 1;
      return MCP_CONTENT_TOOLS.map((name) => ({ name }));
    },
    async authorizeToolCall(request) {
      authorizationCalls += 1;
      if (request.arguments.mode === "deny") {
        return { kind: "denied", code: "capability_denied" };
      }
      if (request.arguments.mode === "race") {
        return {
          kind: "denied",
          code: "authorization_state_changed",
          retryable: true,
        };
      }
      return { kind: "allowed" };
    },
    async executeToolCall(request) {
      executionCalls += 1;
      if (request.arguments.mode === "application_error") {
        return {
          resultType: "complete",
          content: [{ type: "text", text: "HEAD changed." }],
          structuredContent: {
            ok: false,
            error: {
              code: "revision_conflict",
              message: "HEAD changed.",
              retryable: true,
              request_id: "request_application_error",
            },
          },
          isError: true,
        };
      }
      if (request.name === "commit_changeset") {
        const key = request.arguments.idempotency_key;
        const existing = idempotencyResults.get(key);
        if (existing !== undefined) return existing;
        committedRevisions += 1;
        const result = {
          resultType: "complete",
          structuredContent: {
            ok: true,
            data: { revision_id: `revision_${committedRevisions}` },
          },
          isError: false,
        };
        idempotencyResults.set(key, result);
        return result;
      }
      return {
        resultType: "complete",
        structuredContent: { ok: true, data: {} },
        isError: false,
      };
    },
  };
  if (fused) {
    content.executeAuthorizedToolCall = async () => {
      fusedExecutionCalls += 1;
      return {
        resultType: "complete",
        structuredContent: { ok: true, data: { fused: true } },
        isError: false,
      };
    };
  }
  const dependencies = {
    allowedOrigin: "https://mind-diary.invalid",
    authenticator: {
      async authenticate(candidate) {
        authenticationCalls += 1;
        return candidate === "valid-transport-token"
          ? { kind: "authenticated", actor }
          : { kind: "invalid" };
      },
    },
    requestIds: {
      nextRequestId() {
        nextRequestId += 1;
        return `request_transport_${nextRequestId}`;
      },
    },
    content,
  };
  const handler = createMcpHttpHandler(dependencies);
  const legacyCodexHandler = createLegacyCodexMcpHttpHandler(dependencies);

  async function send({
    body = rpcRequest("tools/list"),
    httpMethod = "POST",
    path = "/api/mcp",
    token = "valid-transport-token",
    headerOverrides = {},
  } = {}) {
    const method = typeof body === "string" ? "tools/list" : body.method;
    const name =
      typeof body === "string" || method !== "tools/call"
        ? undefined
        : body.params?.name;
    const headers = new Headers({
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
      "mcp-method": method,
      "mcp-protocol-version": PROTOCOL,
      ...(typeof name === "string" ? { "mcp-name": name } : {}),
    });
    for (const [header, value] of Object.entries(headerOverrides)) {
      if (value === null) headers.delete(header);
      else headers.set(header, value);
    }
    const requestInit = { method: httpMethod, headers };
    if (httpMethod !== "GET" && httpMethod !== "HEAD") {
      requestInit.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    return handler(new Request(`https://mind-diary.invalid${path}`, requestInit));
  }

  async function sendLegacyCodex({
    body,
    token = "valid-transport-token",
    headerOverrides = {},
    path = MCP_LEGACY_CODEX_ENDPOINT,
  }) {
    const headers = new Headers({
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
      ...(body.method === "initialize"
        ? {}
        : { "mcp-protocol-version": MCP_LEGACY_CODEX_PROTOCOL }),
    });
    for (const [header, value] of Object.entries(headerOverrides)) {
      if (value === null) headers.delete(header);
      else headers.set(header, value);
    }
    return legacyCodexHandler(
      new Request(`https://mind-diary.invalid${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
  }

  return {
    send,
    sendLegacyCodex,
    state: {
      authenticationCalls: () => authenticationCalls,
      listCalls: () => listCalls,
      authorizationCalls: () => authorizationCalls,
      executionCalls: () => executionCalls,
      fusedExecutionCalls: () => fusedExecutionCalls,
      committedRevisions: () => committedRevisions,
    },
  };
}

async function jsonRpcBody(response) {
  return response.json();
}

async function sseBody(response) {
  const text = await response.text();
  assert.match(text, /^event: message\ndata: /);
  assert.match(text, /\n\n$/);
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(data.slice("data: ".length));
}

test("stateless POST negotiates JSON and one request-scoped SSE event", async () => {
  const fixture = harness();
  const jsonResponse = await fixture.send();
  assert.equal(jsonResponse.status, 200);
  assert.match(jsonResponse.headers.get("content-type"), /^application\/json/);
  assert.equal((await jsonRpcBody(jsonResponse)).result.tools.length, MCP_CONTENT_TOOLS.length);

  const sseResponse = await fixture.send({
    body: rpcRequest("tools/call", { name: "search" }),
    headerOverrides: { accept: "text/event-stream, application/json" },
  });
  assert.equal(sseResponse.status, 200);
  assert.match(sseResponse.headers.get("content-type"), /^text\/event-stream/);
  assert.equal(sseResponse.headers.get("x-accel-buffering"), "no");
  assert.equal((await sseBody(sseResponse)).result.isError, false);
  assert.equal(fixture.state.authenticationCalls(), 2);
  assert.equal(fixture.state.executionCalls(), 1);
});

test("product application fusion invokes one application boundary without protocol preflight", async () => {
  const fixture = harness({ fused: true });
  const response = await fixture.send({
    body: rpcRequest("tools/call", { name: "search" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await jsonRpcBody(response)).result.isError, false);
  assert.equal(fixture.state.authenticationCalls(), 1);
  assert.equal(fixture.state.authorizationCalls(), 0);
  assert.equal(fixture.state.executionCalls(), 0);
  assert.equal(fixture.state.fusedExecutionCalls(), 1);
});

test("GET, DELETE, and legacy initialize are rejected while obsolete session state is ignored", async () => {
  const fixture = harness();
  for (const httpMethod of ["GET", "DELETE"]) {
    const response = await fixture.send({ httpMethod });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
    assert.equal((await jsonRpcBody(response)).error.code, -32600);
  }
  assert.equal(fixture.state.authenticationCalls(), 0);

  const session = await fixture.send({
    headerOverrides: { "mcp-session-id": "legacy-session" },
  });
  assert.equal(session.status, 200);
  assert.equal((await jsonRpcBody(session)).result.resultType, "complete");

  const initialize = await fixture.send({ body: rpcRequest("initialize") });
  assert.equal(initialize.status, 404);
  assert.equal((await jsonRpcBody(initialize)).error.code, -32601);
  assert.equal(fixture.state.listCalls(), 1);
  assert.equal(fixture.state.executionCalls(), 0);
});

test("modern discovery advertises the isolated stateless profile", async () => {
  const fixture = harness();
  const response = await fixture.send({ body: rpcRequest("server/discover") });
  assert.equal(response.status, 200);
  const result = (await jsonRpcBody(response)).result;
  assert.equal(result.resultType, "complete");
  assert.deepEqual(result.supportedVersions, [PROTOCOL]);
  assert.deepEqual(result.capabilities, { tools: {}, resources: {} });
  assert.equal(result._meta["io.modelcontextprotocol/serverInfo"].name, "mind-diary");
  assert.equal(result.cacheScope, "private");
  assert.equal(fixture.state.listCalls(), 0);
  assert.equal(fixture.state.executionCalls(), 0);
});

test("isolated Codex bridge negotiates 2025-11-25 and translates tools without a session", async () => {
  const fixture = harness();
  const initialize = await fixture.sendLegacyCodex({
    body: {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: { elicitation: { form: {}, url: {} } },
        clientInfo: {
          name: "codex-mcp-client",
          title: "Codex",
          version: "0.147.0",
        },
      },
    },
  });
  assert.equal(initialize.status, 200);
  assert.equal(initialize.headers.get("mcp-session-id"), null);
  const initializedBody = await jsonRpcBody(initialize);
  assert.equal(initializedBody.result.protocolVersion, MCP_LEGACY_CODEX_PROTOCOL);
  assert.deepEqual(initializedBody.result.capabilities, { tools: {} });

  const initialized = await fixture.sendLegacyCodex({
    body: {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    },
  });
  assert.equal(initialized.status, 202);
  assert.equal(await initialized.text(), "");

  const listed = await fixture.sendLegacyCodex({
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: { progressToken: 0 } },
    },
  });
  assert.equal(listed.status, 200);
  const listedResult = (await jsonRpcBody(listed)).result;
  assert.equal(listedResult.tools.length, MCP_CONTENT_TOOLS.length);
  assert.equal(listedResult.resultType, undefined);

  const called = await fixture.sendLegacyCodex({
    body: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        _meta: { progressToken: 1 },
        name: "list_minds",
        arguments: {},
      },
    },
  });
  assert.equal(called.status, 200);
  const calledResult = (await jsonRpcBody(called)).result;
  assert.equal(calledResult.isError, false);
  assert.equal(calledResult.resultType, undefined);
  assert.equal(fixture.state.authenticationCalls(), 4);
  assert.equal(fixture.state.listCalls(), 1);
  assert.equal(fixture.state.authorizationCalls(), 1);
  assert.equal(fixture.state.executionCalls(), 1);
});

test("Codex bridge remains fail-closed and does not accept session or modern-profile framing", async () => {
  const fixture = harness();
  const malformedWithoutToken = await fixture.sendLegacyCodex({
    body: "not-json",
    token: "invalid-token",
  });
  assert.equal(malformedWithoutToken.status, 401);

  const session = await fixture.sendLegacyCodex({
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    headerOverrides: { "mcp-session-id": "unexpected-session" },
  });
  assert.equal(session.status, 400);
  assert.equal((await jsonRpcBody(session)).error.code, -32020);

  const wrongVersion = await fixture.sendLegacyCodex({
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    headerOverrides: { "mcp-protocol-version": PROTOCOL },
  });
  assert.equal(wrongVersion.status, 400);
  assert.equal((await jsonRpcBody(wrongVersion)).error.code, -32022);

  const modernFramedInitialize = await fixture.sendLegacyCodex({
    body: {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "codex-mcp-client", version: "0.147.0" },
      },
    },
    headerOverrides: { "mcp-protocol-version": PROTOCOL },
  });
  assert.equal(modernFramedInitialize.status, 400);
  assert.equal(
    (await jsonRpcBody(modernFramedInitialize)).error.code,
    -32022,
  );

  for (const method of ["server/discover", "resources/list"]) {
    const unsupported = await fixture.sendLegacyCodex({
      body: { jsonrpc: "2.0", id: 2, method, params: {} },
    });
    assert.equal(unsupported.status, 404);
    assert.equal((await jsonRpcBody(unsupported)).error.code, -32601);
  }

  const wrongPath = await fixture.sendLegacyCodex({
    body: {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "codex-mcp-client", version: "0.147.0" },
      },
    },
    path: "/api/mcp",
  });
  assert.equal(wrongPath.status, 404);
  assert.equal(fixture.state.listCalls(), 0);
  assert.equal(fixture.state.executionCalls(), 0);
});

test("unsupported modern versions advertise the exact retry set", async () => {
  const fixture = harness();
  const response = await fixture.send({
    body: rpcRequest("tools/list"),
    headerOverrides: { "mcp-protocol-version": "2025-11-25" },
  });
  assert.equal(response.status, 400);
  assert.deepEqual((await jsonRpcBody(response)).error.data, {
    requested: "2025-11-25",
    supported: [PROTOCOL],
  });
});

test("modern routing decodes the protocol Base64 sentinel before comparing Mcp-Name", async () => {
  const fixture = harness();
  const response = await fixture.send({
    body: rpcRequest("tools/call", { name: "search" }),
    headerOverrides: { "mcp-name": "=?base64?c2VhcmNo?=" },
  });
  assert.equal(response.status, 200);
  assert.equal((await jsonRpcBody(response)).result.isError, false);
  assert.equal(fixture.state.executionCalls(), 1);
});

test("media types, version, headers, body metadata, and capabilities are exact", async () => {
  const fixture = harness();
  const baseCall = rpcRequest("tools/call", { name: "search" });
  const cases = [
    {
      expected: -32600,
      headerOverrides: { "content-type": "text/plain" },
    },
    {
      expected: -32600,
      headerOverrides: { accept: "application/json" },
    },
    {
      expected: -32020,
      headerOverrides: { "mcp-protocol-version": null },
    },
    {
      expected: -32022,
      headerOverrides: { "mcp-protocol-version": "2025-11-25" },
    },
    {
      expected: -32022,
      body: rpcRequest("tools/call", {
        name: "search",
        meta: protocolMeta({
          "io.modelcontextprotocol/protocolVersion": "2025-11-25",
        }),
      }),
    },
    {
      expected: -32020,
      headerOverrides: { "mcp-method": null },
    },
    {
      expected: -32020,
      headerOverrides: { "mcp-method": "tools/list" },
    },
    {
      expected: -32020,
      headerOverrides: { "mcp-name": null },
    },
    {
      expected: -32020,
      headerOverrides: { "mcp-name": "fetch" },
    },
    {
      expected: -32020,
      body: rpcRequest("tools/list"),
      headerOverrides: { "mcp-name": "search" },
    },
    {
      expected: -32020,
      body: {
        ...baseCall,
        params: { ...baseCall.params, _meta: undefined },
      },
    },
    {
      expected: -32020,
      body: rpcRequest("tools/call", {
        name: "search",
        meta: protocolMeta({ "io.modelcontextprotocol/clientInfo": undefined }),
      }),
    },
    {
      expected: -32021,
      body: rpcRequest("tools/call", {
        name: "search",
        meta: protocolMeta({
          "io.modelcontextprotocol/clientCapabilities": undefined,
        }),
      }),
    },
  ];

  for (const scenario of cases) {
    const response = await fixture.send({
      body: scenario.body ?? baseCall,
      headerOverrides: scenario.headerOverrides,
    });
    assert.equal(response.status, 400);
    assert.equal((await jsonRpcBody(response)).error.code, scenario.expected);
  }
  assert.equal(fixture.state.authorizationCalls(), 0);
  assert.equal(fixture.state.executionCalls(), 0);
});

test("authentication is a transport 401 before framing; authenticated framing errors are JSON-RPC", async () => {
  const fixture = harness();
  const unauthenticated = await fixture.send({
    body: "{not-json",
    token: "invalid-token",
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("www-authenticate"), 'Bearer realm="mind-diary"');
  assert.equal((await unauthenticated.json()).code, "authentication_required");

  const parseError = await fixture.send({ body: "{not-json" });
  assert.equal(parseError.status, 400);
  assert.equal((await jsonRpcBody(parseError)).error.code, -32700);

  const invalidRequest = await fixture.send({
    body: { ...rpcRequest("tools/list"), jsonrpc: "1.0" },
  });
  assert.equal(invalidRequest.status, 400);
  assert.equal((await jsonRpcBody(invalidRequest)).error.code, -32600);
  assert.equal(fixture.state.listCalls(), 0);
});

test("a supplied browser Origin must match before token authentication", async () => {
  const fixture = harness();
  const response = await fixture.send({
    headerOverrides: { origin: "https://attacker.invalid" },
  });
  assert.equal(response.status, 403);
  assert.equal((await jsonRpcBody(response)).error.message, "Invalid Origin");
  assert.equal(fixture.state.authenticationCalls(), 0);
  assert.equal(fixture.state.listCalls(), 0);
});

test("application denials and domain errors stay HTTP 200 and retries/races preserve final state", async () => {
  const fixture = harness();
  const denied = await fixture.send({
    body: rpcRequest("tools/call", {
      name: "commit_changeset",
      arguments: { mode: "deny" },
    }),
  });
  assert.equal(denied.status, 200);
  assert.equal((await jsonRpcBody(denied)).result.structuredContent.error.code, "capability_denied");

  const applicationError = await fixture.send({
    body: rpcRequest("tools/call", {
      name: "commit_changeset",
      arguments: { mode: "application_error" },
    }),
  });
  assert.equal(applicationError.status, 200);
  assert.equal((await jsonRpcBody(applicationError)).result.structuredContent.error.code, "revision_conflict");

  const commit = rpcRequest("tools/call", {
    name: "commit_changeset",
    arguments: { idempotency_key: "retry-once" },
  });
  const first = await fixture.send({ body: commit });
  const retry = await fixture.send({ body: commit });
  assert.deepEqual((await jsonRpcBody(retry)).result, (await jsonRpcBody(first)).result);
  assert.equal(fixture.state.committedRevisions(), 1);

  const race = await fixture.send({
    body: rpcRequest("tools/call", {
      name: "commit_changeset",
      arguments: { mode: "race" },
    }),
  });
  assert.equal(race.status, 200);
  assert.equal(
    (await jsonRpcBody(race)).result.structuredContent.error.code,
    "authorization_state_changed",
  );
  assert.equal(fixture.state.committedRevisions(), 1);
  assert.equal(fixture.state.executionCalls(), 3);
});
