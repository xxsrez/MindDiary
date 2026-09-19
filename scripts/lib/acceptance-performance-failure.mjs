// Closed diagnostic vocabulary: never serialize messages, URLs, bodies or headers.
const names = new Set(["TimeoutError", "AbortError", "TypeError", "AssertionError", "PerformanceResponseError", "Error"]);
const codes = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "ERR_ASSERTION"]);
const responseCodes = new Set(["response_too_large", "request_id_missing", "correlation_echo_mismatch", "unexpected_http_status", "web_response_not_successful", "invalid_json", "invalid_sse_envelope", "unsupported_content_type", "invalid_jsonrpc_envelope", "jsonrpc_id_mismatch", "jsonrpc_error", "jsonrpc_result_missing", "mcp_tool_error", "mcp_tool_success_not_explicit", "mcp_structured_success_missing"]);
const definitionIds = new Set(["web.home", ...["mcp_modern"].flatMap(profile => [
  ...["list_minds", "browse_entries", "list_files", "grep_files", "read_files", "search", "fetch"].map(operation => `${profile}.starter.${operation}`),
  ...["history1", "history10"].map(fixture => `${profile}.${fixture}.get_revision`),
])]);

export function acceptancePerformanceFailureDiagnostic(error) {
  const chain = [];
  const seen = new Set();
  for (let current = error; current && typeof current === "object" && chain.length < 4 && !seen.has(current); current = current.cause) {
    seen.add(current);
    chain.push({
      name: names.has(current.name) ? current.name : "unknown",
      code: codes.has(current.code) || (current.name === "PerformanceResponseError" && responseCodes.has(current.code)) ? current.code : "unknown",
      ...(current.name === "PerformanceResponseError" && definitionIds.has(current.requestId) ? { definition_id: current.requestId } : {}),
    });
  }
  return { chain };
}
