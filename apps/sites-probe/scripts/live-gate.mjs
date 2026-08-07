import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const baseUrl = process.env.SITES_PROBE_URL;
const bearerToken = process.env.MIND_DIARY_SITES_PROBE_TOKEN;
const verifyOperationId = process.env.SITES_PROBE_VERIFY_OPERATION_ID;
const protocolVersion = "2026-07-28";

if (!baseUrl || !bearerToken) {
  throw new Error("Set SITES_PROBE_URL and MIND_DIARY_SITES_PROBE_TOKEN without printing their values.");
}

const endpoint = new URL(baseUrl);
if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1") {
  throw new Error("SITES_PROBE_URL must use HTTPS outside localhost.");
}

function auth(value = bearerToken) {
  return { authorization: `Bearer ${value}` };
}

function operationId(label) {
  return `${label}_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`.slice(0, 64);
}

function requestMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": protocolVersion,
    "io.modelcontextprotocol/clientInfo": { name: "mind-diary-live-gate", version: "0.1.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON at status ${response.status}.`);
  }
}

async function stateGet(operation) {
  const url = new URL("/probe/state", endpoint);
  if (operation) url.searchParams.set("operation_id", operation);
  const response = await fetch(url, { headers: auth() });
  assert.equal(response.status, 200);
  return readJson(response);
}

async function statePost(operation, expectedCounter) {
  return fetch(new URL("/probe/state", endpoint), {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ operation_id: operation, expected_counter: expectedCounter }),
  });
}

function mcpRequest(method, { id = 1, name, arguments: args, response = "json", token = bearerToken, extraHeaders } = {}) {
  const url = new URL("/mcp", endpoint);
  url.searchParams.set("response", response);
  const params = { _meta: requestMeta() };
  if (name) params.name = name;
  if (args) params.arguments = args;
  return fetch(url, {
    method: "POST",
    headers: {
      ...auth(token),
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion,
      "mcp-method": method,
      ...(name ? { "mcp-name": name } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

const initial = await stateGet();
const startingCounter = initial.state.counter;
const priorOperation = verifyOperationId ? await stateGet(verifyOperationId) : null;
if (priorOperation) {
  assert.equal(priorOperation.state.operation?.r2_present, true);
  assert.equal(priorOperation.state.operation?.r2_matches, true);
}

const firstOperation = operationId("live_state");
const first = await statePost(firstOperation, startingCounter);
assert.equal(first.status, 200);
const firstBody = await readJson(first);
assert.equal(firstBody.result.counter, startingCounter + 1);
assert.equal(firstBody.result.replayed, false);

const replay = await statePost(firstOperation, startingCounter);
assert.equal(replay.status, 200);
assert.equal((await readJson(replay)).result.replayed, true);

const conflictingReplay = await statePost(firstOperation, startingCounter + 1);
assert.equal(conflictingReplay.status, 409);
assert.equal((await readJson(conflictingReplay)).error.code, "idempotency_conflict");
assert.equal((await stateGet()).state.counter, startingCounter + 1);

const invalid = await statePost("bad", startingCounter + 1);
assert.equal(invalid.status, 400);
assert.equal((await stateGet()).state.counter, startingCounter + 1);

const raceCounter = startingCounter + 1;
const raceOperations = [operationId("live_race_a"), operationId("live_race_b")];
const raceResponses = await Promise.all(raceOperations.map((operation) => statePost(operation, raceCounter)));
assert.deepEqual(raceResponses.map((response) => response.status).sort(), [200, 409]);
const endingState = await stateGet();
assert.equal(endingState.state.counter, raceCounter + 1);
const persisted = await stateGet(firstOperation);
assert.equal(persisted.state.operation.r2_present, true);
assert.equal(persisted.state.operation.r2_matches, true);

const missingAuth = await fetch(new URL("/mcp", endpoint), { method: "POST" });
assert.equal(missingAuth.status, 401);
assert.match(missingAuth.headers.get("www-authenticate") ?? "", /^Bearer /);
const randomInvalidToken = randomBytes(32).toString("base64url");
const invalidAuth = await mcpRequest("tools/list", { token: randomInvalidToken });
assert.equal(invalidAuth.status, 401);

const discover = await mcpRequest("server/discover", { id: "discover-live" });
assert.equal(discover.status, 200);
assert.deepEqual((await readJson(discover)).result.supportedVersions, [protocolVersion]);

const toolsList = await mcpRequest("tools/list");
assert.equal(toolsList.status, 200);
assert.equal((await readJson(toolsList)).result.tools[0].name, "probe_capabilities");

const headerMismatch = await mcpRequest("tools/list", { extraHeaders: { "mcp-method": "tools/call" } });
assert.equal(headerMismatch.status, 400);
assert.equal((await readJson(headerMismatch)).error.code, -32020);

const positive = await mcpRequest("tools/call", {
  name: "probe_capabilities",
  arguments: { mode: "positive" },
});
assert.equal(positive.status, 200);
assert.equal((await readJson(positive)).result.structuredContent.ok, true);

const denied = await mcpRequest("tools/call", {
  name: "probe_capabilities",
  arguments: { mode: "denied" },
});
assert.equal(denied.status, 200);
assert.equal((await readJson(denied)).result.structuredContent.error.code, "forbidden");
assert.equal((await stateGet()).state.counter, endingState.state.counter);

const sse = await mcpRequest("tools/call", {
  id: "sse-live",
  name: "probe_capabilities",
  arguments: { mode: "positive" },
  response: "sse",
});
assert.equal(sse.status, 200);
assert.match(sse.headers.get("content-type") ?? "", /^text\/event-stream/);
const sseText = await sse.text();
assert.equal((sseText.match(/^event: message$/gm) ?? []).length, 1);
assert.match(sseText, /"id":"sse-live"/);

const session = await mcpRequest("tools/list", { extraHeaders: { "mcp-session-id": "legacy-probe" } });
assert.equal(session.status, 400);
assert.equal((await readJson(session)).error.code, -32020);

for (const method of ["GET", "DELETE"]) {
  const response = await fetch(new URL("/mcp", endpoint), { method });
  assert.equal(response.status, 405);
}

const summary = {
  ok: true,
  protocol_version: protocolVersion,
  starting_counter: startingCounter,
  ending_counter: endingState.state.counter,
  persisted_operation_id: firstOperation,
  persisted_r2_digest: persisted.state.operation.r2_digest,
  prior_operation_verified: Boolean(priorOperation),
  prior_r2_digest: priorOperation?.state.operation?.r2_digest ?? null,
  race_statuses: raceResponses.map((response) => response.status).sort(),
  json_status: positive.status,
  sse_status: sse.status,
  denied_status: denied.status,
  header_mismatch_status: headerMismatch.status,
  session_status: session.status,
  get_delete_status: 405,
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
