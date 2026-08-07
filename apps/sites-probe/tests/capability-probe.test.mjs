import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import test from "node:test";

const LOCAL_TOKEN = "local-capability-probe-token";
const PROTOCOL_VERSION = "2026-07-28";
const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
const { default: worker } = await import(workerUrl.href);

function context() {
  return {
    waitUntil() {},
    passThroughOnException() {},
  };
}

async function createBindings() {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-01-01",
    d1Databases: ["DB"],
    r2Buckets: ["PROBE_BUCKET"],
  });
  return {
    miniflare,
    env: {
      DB: await miniflare.getD1Database("DB"),
      PROBE_BUCKET: await miniflare.getR2Bucket("PROBE_BUCKET"),
      SITES_PROBE_BEARER_TOKEN: LOCAL_TOKEN,
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
  };
}

function bearerHeaders(token = LOCAL_TOKEN) {
  return { authorization: `Bearer ${token}` };
}

function metadata() {
  return {
    "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": { name: "local-conformance", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

function mcpRequest(method, options = {}) {
  const id = Object.hasOwn(options, "id") ? options.id : 1;
  const { name, arguments: args, response = "json", token = LOCAL_TOKEN } = options;
  const params = { _meta: metadata() };
  if (name) params.name = name;
  if (args) params.arguments = args;
  const headers = {
    ...bearerHeaders(token),
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": PROTOCOL_VERSION,
    "mcp-method": method,
  };
  if (name) headers["mcp-name"] = name;
  const body = { jsonrpc: "2.0", method, params };
  if (id !== undefined) body.id = id;
  return new Request(`http://localhost/mcp?response=${response}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function dispatch(request, env) {
  return worker.fetch(request, env, context());
}

async function postState(env, operationId, expectedCounter) {
  return dispatch(
    new Request("http://localhost/probe/state", {
      method: "POST",
      headers: { ...bearerHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ operation_id: operationId, expected_counter: expectedCounter }),
    }),
    env,
  );
}

test("renders an explicit non-product capability surface", async () => {
  const { miniflare, env } = await createBindings();
  try {
    const response = await dispatch(new Request("http://localhost/", { headers: { accept: "text/html" } }), env);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<title>Mind Diary Sites capability probe<\/title>/i);
    assert.match(html, /non-product verification surface/i);
    assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
  } finally {
    await miniflare.dispose();
  }
});

test("reports identity header presence without exposing values", async () => {
  const { miniflare, env } = await createBindings();
  try {
    const canaries = ["user-secret-canary", "email-secret-canary@example.test", "Name%20Canary"];
    const response = await dispatch(
      new Request("http://localhost/probe/identity", {
        headers: {
          "oai-authenticated-user-id": canaries[0],
          "oai-authenticated-user-email": canaries[1],
          "oai-authenticated-user-full-name": canaries[2],
          "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
        },
      }),
      env,
    );
    assert.equal(response.status, 200);
    const text = await response.text();
    for (const canary of canaries) assert.doesNotMatch(text, new RegExp(canary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const body = JSON.parse(text);
    assert.deepEqual(body.identity, {
      user_id_present: true,
      email_present: true,
      full_name_present: true,
      full_name_encoding_present: true,
      full_name_encoding_valid: true,
    });
  } finally {
    await miniflare.dispose();
  }
});

test("requires a bearer credential on every MCP request and returns a safe challenge", async () => {
  const { miniflare, env } = await createBindings();
  try {
    const missing = mcpRequest("tools/list");
    missing.headers.delete("authorization");
    const missingResponse = await dispatch(missing, env);
    assert.equal(missingResponse.status, 401);
    assert.match(missingResponse.headers.get("www-authenticate") ?? "", /^Bearer realm="mind-diary-sites-probe"/);

    const invalidToken = "invalid-token-canary";
    const invalidResponse = await dispatch(mcpRequest("tools/list", { token: invalidToken }), env);
    assert.equal(invalidResponse.status, 401);
    assert.doesNotMatch(await invalidResponse.text(), new RegExp(invalidToken));

    const validResponse = await dispatch(mcpRequest("tools/list"), env);
    assert.equal(validResponse.status, 200);
    const validBody = await validResponse.json();
    assert.equal(validBody.result.tools[0].name, "probe_capabilities");
    assert.equal(validBody.result.ttlMs, 0);
    assert.equal(validBody.result.cacheScope, "private");
  } finally {
    await miniflare.dispose();
  }
});

test("serves JSON and one request-scoped SSE event without initialize or session state", async () => {
  const { miniflare, env } = await createBindings();
  try {
    const jsonResponse = await dispatch(
      mcpRequest("tools/call", { name: "probe_capabilities", arguments: { mode: "positive" } }),
      env,
    );
    assert.equal(jsonResponse.status, 200);
    const jsonBody = await jsonResponse.json();
    assert.equal(jsonBody.result.structuredContent.ok, true);
    assert.equal(jsonBody.result.structuredContent.data.protocol_version, PROTOCOL_VERSION);

    const discoverResponse = await dispatch(mcpRequest("server/discover", { id: "discover-1" }), env);
    assert.equal(discoverResponse.status, 200);
    const discoverBody = await discoverResponse.json();
    assert.deepEqual(discoverBody.result.supportedVersions, [PROTOCOL_VERSION]);
    assert.equal(discoverBody.result.resultType, "complete");
    assert.equal(discoverBody.result.cacheScope, "private");

    const sseResponse = await dispatch(
      mcpRequest("tools/call", {
        id: "sse-1",
        name: "probe_capabilities",
        arguments: { mode: "positive" },
        response: "sse",
      }),
      env,
    );
    assert.equal(sseResponse.status, 200);
    assert.match(sseResponse.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.equal(sseResponse.headers.get("mcp-session-id"), null);
    const sseText = await sseResponse.text();
    assert.equal((sseText.match(/^event: message$/gm) ?? []).length, 1);
    assert.match(sseText, /"id":"sse-1"/);

    const notificationResponse = await dispatch(mcpRequest("tools/list", { id: undefined }), env);
    assert.equal(notificationResponse.status, 202);
    assert.equal(await notificationResponse.text(), "");
  } finally {
    await miniflare.dispose();
  }
});

test("rejects GET, DELETE, session headers, invalid Origin, metadata mismatch, and initialize", async () => {
  const { miniflare, env } = await createBindings();
  try {
    for (const method of ["GET", "DELETE"]) {
      const response = await dispatch(new Request("http://localhost/mcp", { method }), env);
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "POST");
    }

    const sessionRequest = mcpRequest("tools/list");
    sessionRequest.headers.set("mcp-session-id", "legacy-session-canary");
    const sessionResponse = await dispatch(sessionRequest, env);
    assert.equal(sessionResponse.status, 400);
    assert.equal((await sessionResponse.json()).error.code, -32020);

    const mismatchRequest = mcpRequest("tools/list");
    mismatchRequest.headers.set("mcp-method", "tools/call");
    const mismatchResponse = await dispatch(mismatchRequest, env);
    assert.equal((await mismatchResponse.json()).error.code, -32020);

    const originRequest = mcpRequest("tools/list");
    originRequest.headers.set("origin", "https://untrusted.example");
    const originResponse = await dispatch(originRequest, env);
    assert.equal(originResponse.status, 403);
    assert.equal((await originResponse.json()).error.code, "origin_denied");

    const initializeResponse = await dispatch(mcpRequest("initialize"), env);
    assert.equal((await initializeResponse.json()).error.code, -32601);
  } finally {
    await miniflare.dispose();
  }
});

test("returns a synthetic denied tool result without changing durable state", async () => {
  const { miniflare, env } = await createBindings();
  try {
    const before = await dispatch(new Request("http://localhost/probe/state", { headers: bearerHeaders() }), env);
    assert.equal((await before.json()).state.counter, 0);
    const denied = await dispatch(
      mcpRequest("tools/call", { name: "probe_capabilities", arguments: { mode: "denied" } }),
      env,
    );
    assert.equal(denied.status, 200);
    const deniedBody = await denied.json();
    assert.equal(deniedBody.result.isError, true);
    assert.equal(deniedBody.result.structuredContent.error.code, "forbidden");
    const after = await dispatch(new Request("http://localhost/probe/state", { headers: bearerHeaders() }), env);
    assert.equal((await after.json()).state.counter, 0);
  } finally {
    await miniflare.dispose();
  }
});

test("persists D1 and R2 state, replays safely, and rejects conflicting reuse", async () => {
  const { miniflare, env } = await createBindings();
  try {
    const first = await postState(env, "persist_op_0001", 0);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.result.counter, 1);
    assert.equal(firstBody.result.replayed, false);
    assert.equal(firstBody.result.r2_present, true);

    const retry = await postState(env, "persist_op_0001", 0);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).result.replayed, true);

    const conflict = await postState(env, "persist_op_0001", 1);
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, "idempotency_conflict");

    const state = await dispatch(
      new Request("http://localhost/probe/state?operation_id=persist_op_0001", { headers: bearerHeaders() }),
      env,
    );
    const stateBody = await state.json();
    assert.equal(stateBody.state.counter, 1);
    assert.equal(stateBody.state.operation.r2_matches, true);
    assert.match(stateBody.state.operation.r2_digest, /^sha256:[0-9a-f]{64}$/);
  } finally {
    await miniflare.dispose();
  }
});

test("keeps state unchanged after invalid input and lets one concurrent CAS win", async () => {
  const { miniflare, env } = await createBindings();
  try {
    const invalid = await postState(env, "bad", 0);
    assert.equal(invalid.status, 400);
    const invalidJson = await dispatch(
      new Request("http://localhost/probe/state", {
        method: "POST",
        headers: { ...bearerHeaders(), "content-type": "application/json" },
        body: "{",
      }),
      env,
    );
    assert.equal(invalidJson.status, 400);
    assert.equal((await invalidJson.json()).error.code, "invalid_json");
    const afterInvalid = await dispatch(new Request("http://localhost/probe/state", { headers: bearerHeaders() }), env);
    assert.equal((await afterInvalid.json()).state.counter, 0);

    const responses = await Promise.all([
      postState(env, "concurrent_op_a", 0),
      postState(env, "concurrent_op_b", 0),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const afterRace = await dispatch(new Request("http://localhost/probe/state", { headers: bearerHeaders() }), env);
    assert.equal((await afterRace.json()).state.counter, 1);
  } finally {
    await miniflare.dispose();
  }
});

test("retries an R2 failure without incrementing D1 twice", async () => {
  const { miniflare, env } = await createBindings();
  try {
    let failOnce = true;
    const realBucket = env.PROBE_BUCKET;
    const failingBucket = {
      get: realBucket.get.bind(realBucket),
      put: async (...args) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("synthetic-r2-failure");
        }
        return realBucket.put(...args);
      },
    };
    const first = await postState({ ...env, PROBE_BUCKET: failingBucket }, "retry_r2_op_01", 0);
    assert.equal(first.status, 503);

    const incomplete = await dispatch(
      new Request("http://localhost/probe/state?operation_id=retry_r2_op_01", { headers: bearerHeaders() }),
      env,
    );
    const incompleteBody = await incomplete.json();
    assert.equal(incompleteBody.state.counter, 1);
    assert.equal(incompleteBody.state.operation.r2_present, false);

    const retry = await postState(env, "retry_r2_op_01", 0);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).result.replayed, true);
    const complete = await dispatch(new Request("http://localhost/probe/state", { headers: bearerHeaders() }), env);
    assert.equal((await complete.json()).state.counter, 1);
  } finally {
    await miniflare.dispose();
  }
});
