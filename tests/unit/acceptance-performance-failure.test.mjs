import assert from "node:assert/strict";
import test from "node:test";
import { acceptancePerformanceFailureDiagnostic } from "../../scripts/lib/acceptance-performance-failure.mjs";
import { PerformanceResponseError } from "../../scripts/lib/performance-request.mjs";

test("preserves bounded response failure codes and only known fixture definitions", () => {
  for (const code of ["response_too_large", "request_id_missing", "correlation_echo_mismatch"]) {
    assert.deepEqual(acceptancePerformanceFailureDiagnostic(new PerformanceResponseError(code, "mcp_modern.starter.grep_files")).chain,
      [{ name: "PerformanceResponseError", code, definition_id: "mcp_modern.starter.grep_files" }]);
  }
  assert.doesNotMatch(JSON.stringify(acceptancePerformanceFailureDiagnostic(new PerformanceResponseError("request_id_missing", "private-path"))), /private-path/);
});

test("preserves transport failure categories without private error details", () => {
  const error = new TypeError("secret URL and token", { cause: Object.assign(new Error("private body"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });
  const result = acceptancePerformanceFailureDiagnostic(error);
  assert.deepEqual(result.chain, [{ name: "TypeError", code: "unknown" }, { name: "Error", code: "UND_ERR_CONNECT_TIMEOUT" }]);
  assert.doesNotMatch(JSON.stringify(result), /secret|private|token/);
});

test("handles timeout, unknown values, and cyclic causes with a closed bounded result", () => {
  assert.equal(acceptancePerformanceFailureDiagnostic(new DOMException("private", "TimeoutError")).chain[0].name, "TimeoutError");
  const error = { name: "private", code: "secret" }; error.cause = error;
  assert.deepEqual(acceptancePerformanceFailureDiagnostic(error), { chain: [{ name: "unknown", code: "unknown" }] });
  assert.deepEqual(acceptancePerformanceFailureDiagnostic(null), { chain: [] });
});
