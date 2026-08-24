function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class PerformanceResponseError extends Error {
  constructor(code, requestId) {
    super(`performance response rejected: ${code}:${requestId}`);
    this.name = "PerformanceResponseError";
    this.code = code;
    this.requestId = requestId;
  }
}

function reject(code, definition) {
  throw new PerformanceResponseError(code, definition.id);
}

function parseJson(text, definition) {
  try {
    return JSON.parse(text);
  } catch {
    reject("invalid_json", definition);
  }
}

function parseSse(text, definition) {
  const data = text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
  if (data.length !== 1) reject("invalid_sse_envelope", definition);
  return parseJson(data[0], definition);
}

export function parsePerformanceResponsePayload(
  definition,
  { contentType, text },
) {
  const normalized = String(contentType ?? "").toLowerCase();
  if (normalized.startsWith("application/json")) {
    return parseJson(text, definition);
  }
  if (normalized.startsWith("text/event-stream")) {
    return parseSse(text, definition);
  }
  reject("unsupported_content_type", definition);
}

/**
 * HTTP success is not MCP success. A benchmarked MCP request must return the
 * matching JSON-RPC response and an explicit non-error tool result. Raw bodies
 * are intentionally absent from every thrown error.
 */
export function assertSuccessfulPerformanceResponse(
  definition,
  response,
) {
  if (response.status !== definition.expected_status) {
    reject("unexpected_http_status", definition);
  }
  if (definition.profile === "web") {
    if (response.status < 200 || response.status >= 300) {
      reject("web_response_not_successful", definition);
    }
    return Object.freeze({ kind: "web", status: response.status });
  }

  const envelope = parsePerformanceResponsePayload(definition, response);
  if (!isRecord(envelope) || envelope.jsonrpc !== "2.0") {
    reject("invalid_jsonrpc_envelope", definition);
  }
  if (envelope.id !== definition.body.id) {
    reject("jsonrpc_id_mismatch", definition);
  }
  if (isRecord(envelope.error)) reject("jsonrpc_error", definition);
  if (!isRecord(envelope.result)) reject("jsonrpc_result_missing", definition);
  if (envelope.result.isError !== false) {
    reject(
      envelope.result.isError === true
        ? "mcp_tool_error"
        : "mcp_tool_success_not_explicit",
      definition,
    );
  }
  if (
    !isRecord(envelope.result.structuredContent) ||
    envelope.result.structuredContent.ok !== true
  ) {
    reject("mcp_structured_success_missing", definition);
  }
  return Object.freeze({ kind: "mcp", status: response.status });
}
