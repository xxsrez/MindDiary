import assert from "node:assert/strict";
import test from "node:test";

import { assertSuccessfulPerformanceResponse } from "../../scripts/lib/performance-request.mjs";

function definition() {
  return {
    id: "mcp_modern.search.mixed",
    profile: "mcp_modern",
    expected_status: 200,
    body: { id: "rpc-performance-1" },
  };
}

function envelope(result) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: "rpc-performance-1",
    result,
  });
}

test("HTTP 200 MCP tool isError is a failing performance sample", () => {
  assert.throws(
    () => assertSuccessfulPerformanceResponse(definition(), {
      status: 200,
      contentType: "application/json; charset=utf-8",
      text: envelope({
        isError: true,
        structuredContent: { ok: false, error: { code: "search_unavailable" } },
      }),
    }),
    (error) => error.code === "mcp_tool_error" && !error.message.includes("search_unavailable"),
  );
});

test("missing explicit MCP success and JSON-RPC errors fail closed", () => {
  assert.throws(
    () => assertSuccessfulPerformanceResponse(definition(), {
      status: 200,
      contentType: "application/json",
      text: envelope({ structuredContent: { ok: true, data: {} } }),
    }),
    (error) => error.code === "mcp_tool_success_not_explicit",
  );
  assert.throws(
    () => assertSuccessfulPerformanceResponse(definition(), {
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({
        jsonrpc: "2.0",
        id: "rpc-performance-1",
        error: { code: -32603, message: "Internal error" },
      }),
    }),
    (error) => error.code === "jsonrpc_error",
  );
});

test("matching explicit JSON and one-event SSE success pass without retaining body", () => {
  const payload = envelope({ isError: false, structuredContent: { ok: true, data: {} } });
  assert.equal(assertSuccessfulPerformanceResponse(definition(), {
    status: 200,
    contentType: "application/json",
    text: payload,
  }).kind, "mcp");
  assert.equal(assertSuccessfulPerformanceResponse(definition(), {
    status: 200,
    contentType: "text/event-stream; charset=utf-8",
    text: `event: message\ndata: ${payload}\n\n`,
  }).kind, "mcp");
});

test("web sample still requires the declared successful HTTP status", () => {
  assert.throws(
    () => assertSuccessfulPerformanceResponse({
      id: "web.home.minds1",
      profile: "web",
      expected_status: 200,
    }, {
      status: 503,
      contentType: "text/html",
      text: "private body not surfaced",
    }),
    (error) => error.code === "unexpected_http_status" &&
      !error.message.includes("private body not surfaced"),
  );
});
