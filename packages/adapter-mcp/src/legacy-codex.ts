import {
  type McpBearerAuthenticationResult,
} from "@mind-diary/application-content";

import {
  MCP_TARGET_PROTOCOL,
  MCP_LEGACY_CODEX_PROTOCOL,
  MCP_LEGACY_CODEX_ENDPOINT,
} from "./tool-definitions.js";

import {
  pathname,
  jsonResponse,
  authenticationResponse,
  authenticationUnavailableResponse,
  jsonRpcError,
  noContentResponse,
  jsonRpcResult,
  acceptedResponseFormat,
  hasJsonContentType,
  invalidRequestOrigin,
  validRpcId,
  nonEmptyString,
  isRecord,
  authenticateRequest,
  safeLog,
  createMcpHttpHandlerAtEndpoint,
  type McpHttpHandlerDependencies,
  type McpProtocolError,
} from "./http-handler.js";

interface LegacyCodexJsonRpcMessage {
  readonly jsonrpc: "2.0";
  readonly id?: string | number;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

function parseLegacyCodexJsonRpcMessage(
  value: unknown,
): LegacyCodexJsonRpcMessage | null {
  if (
    !isRecord(value) ||
    value.jsonrpc !== "2.0" ||
    !nonEmptyString(value.method) ||
    !validRpcId(value.id) ||
    (value.params !== undefined && !isRecord(value.params))
  ) {
    return null;
  }
  return value as unknown as LegacyCodexJsonRpcMessage;
}

function validLegacyCodexInitialize(
  rpc: LegacyCodexJsonRpcMessage,
): boolean {
  if (rpc.id === undefined || !isRecord(rpc.params)) return false;
  const clientInfo = rpc.params.clientInfo;
  return (
    (rpc.params.protocolVersion === "2025-06-18" ||
      rpc.params.protocolVersion === MCP_LEGACY_CODEX_PROTOCOL) &&
    isRecord(rpc.params.capabilities) &&
    isRecord(clientInfo) &&
    nonEmptyString(clientInfo.name) &&
    nonEmptyString(clientInfo.version)
  );
}

function legacyCodexProtocolHeader(request: Request): McpProtocolError | null {
  return request.headers.get("mcp-protocol-version") === MCP_LEGACY_CODEX_PROTOCOL
    ? null
    : { code: -32022, message: "Unsupported MCP protocol version." };
}

function modernizedLegacyCodexRequest(
  request: Request,
  rpc: LegacyCodexJsonRpcMessage,
): Request {
  const params: Readonly<Record<string, unknown>> =
    rpc.params ?? Object.freeze({});
  const existingMeta = isRecord(params._meta) ? params._meta : Object.freeze({});
  const modernParams: Readonly<Record<string, unknown>> = Object.freeze({
    ...params,
    _meta: Object.freeze({
      ...existingMeta,
      "io.modelcontextprotocol/protocolVersion": MCP_TARGET_PROTOCOL,
      "io.modelcontextprotocol/clientInfo": Object.freeze({
        name: "codex-legacy-bridge",
        version: MCP_LEGACY_CODEX_PROTOCOL,
      }),
      "io.modelcontextprotocol/clientCapabilities": Object.freeze({}),
    }),
  });
  const headers = new Headers(request.headers);
  headers.set("accept", "application/json, text/event-stream");
  headers.set("mcp-protocol-version", MCP_TARGET_PROTOCOL);
  headers.set("mcp-method", rpc.method);
  headers.delete("mcp-session-id");
  const name =
    rpc.method === "tools/call"
      ? modernParams.name
      : rpc.method === "resources/read"
        ? modernParams.uri
        : null;
  if (nonEmptyString(name)) headers.set("mcp-name", name);
  else headers.delete("mcp-name");
  return new Request(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(rpc.id === undefined ? {} : { id: rpc.id }),
      method: rpc.method,
      params: modernParams,
    }),
  });
}

async function legacyCodexResponse(response: Response): Promise<Response> {
  if (
    response.status !== 200 ||
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return response;
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return jsonRpcError(null, -32603, "Internal error", 500);
  }
  if (!isRecord(payload) || !isRecord(payload.result)) {
    return jsonResponse(response.status, payload);
  }
  const {
    resultType: _resultType,
    ttlMs: _ttlMs,
    cacheScope: _cacheScope,
    ...result
  } = payload.result;
  return jsonResponse(response.status, { ...payload, result });
}

/**
 * Isolated Streamable HTTP 2025-11-25 lifecycle bridge for Codex 0.147.
 *
 * It deliberately does not create protocol sessions. Authentication and all
 * content authorization still run per request, while operational messages are
 * translated into the current stateless application boundary.
 */
export function createLegacyCodexMcpHttpHandler(
  dependencies: McpHttpHandlerDependencies,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const requestId = dependencies.requestIds.nextRequestId();
    if (pathname(request) !== MCP_LEGACY_CODEX_ENDPOINT) {
      const response = jsonRpcError(null, -32600, "Invalid request", 404);
      await safeLog(dependencies.logger, request, requestId, response, "protocol_error");
      return response;
    }
    if (request.method !== "POST") {
      const response = jsonRpcError(
        null,
        -32600,
        "Legacy Codex MCP accepts POST only.",
        405,
        { allow: "POST" },
      );
      await safeLog(dependencies.logger, request, requestId, response, "protocol_error");
      return response;
    }

    if (invalidRequestOrigin(request, dependencies.allowedOrigin)) {
      const response = jsonRpcError(null, -32600, "Invalid Origin", 403);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "protocol_error",
      );
      return response;
    }

    let authentication: McpBearerAuthenticationResult;
    try {
      authentication = await authenticateRequest(
        request,
        dependencies.authenticator,
        requestId,
      );
    } catch {
      const response = authenticationUnavailableResponse(requestId);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "authentication_unavailable",
      );
      return response;
    }
    if (authentication.kind !== "authenticated") {
      const response = authenticationResponse(requestId, dependencies.oauth);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "authentication_failed",
      );
      return response;
    }

    if (request.headers.has("mcp-session-id")) {
      const response = jsonRpcError(
        null,
        -32020,
        "Mcp-Session-Id is not used by the stateless Codex compatibility profile.",
        400,
      );
      await safeLog(dependencies.logger, request, requestId, response, "protocol_error");
      return response;
    }
    if (!hasJsonContentType(request.headers.get("content-type"))) {
      const response = jsonRpcError(
        null,
        -32600,
        "Content-Type must be application/json.",
        400,
      );
      await safeLog(dependencies.logger, request, requestId, response, "protocol_error");
      return response;
    }
    const responseFormat = acceptedResponseFormat(request.headers.get("accept"));
    if (responseFormat === null) {
      const response = jsonRpcError(
        null,
        -32600,
        "Accept must allow application/json and text/event-stream.",
        400,
      );
      await safeLog(dependencies.logger, request, requestId, response, "protocol_error");
      return response;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await request.text());
    } catch {
      const response = jsonRpcError(null, -32700, "Parse error", 400);
      await safeLog(dependencies.logger, request, requestId, response, "protocol_error");
      return response;
    }
    const rpc = parseLegacyCodexJsonRpcMessage(parsed);
    if (rpc === null) {
      const id = isRecord(parsed) && validRpcId(parsed.id) ? parsed.id : null;
      const response = jsonRpcError(id, -32600, "Invalid request", 400);
      await safeLog(dependencies.logger, request, requestId, response, "protocol_error");
      return response;
    }

    if (rpc.method === "initialize") {
      const initializationVersionHeader = request.headers.get(
        "mcp-protocol-version",
      );
      const response =
        initializationVersionHeader !== null
          ? jsonRpcError(
              rpc.id,
              -32022,
              "MCP-Protocol-Version is not valid before legacy negotiation.",
              400,
            )
          : validLegacyCodexInitialize(rpc)
            ? jsonResponse(200, {
                jsonrpc: "2.0",
                id: rpc.id,
                result: {
                  protocolVersion: MCP_LEGACY_CODEX_PROTOCOL,
                  capabilities: {
                    tools: Object.freeze({}),
                  },
                  serverInfo: {
                    name: "mind-diary",
                    title: "Mind Diary",
                    version: "0.1.0",
                  },
                  instructions:
                    "Use list_minds to discover currently accessible Minds. Every read explicitly selects one Mind and revision from current access; there is no attach step, implicit /me, or cross-Mind fallback. Manage the writable target and export only on the authenticated Mind Diary Site.",
                },
              })
            : jsonRpcError(rpc.id, -32602, "Invalid params", 400);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        response.status === 200 ? "authenticated" : "protocol_error",
      );
      return response;
    }

    const protocolError = legacyCodexProtocolHeader(request);
    if (protocolError !== null) {
      const response = jsonRpcError(
        rpc.id,
        protocolError.code,
        protocolError.message,
        400,
      );
      await safeLog(dependencies.logger, request, requestId, response, "protocol_error");
      return response;
    }

    if (rpc.method === "notifications/initialized") {
      const valid =
        rpc.id === undefined &&
        (rpc.params === undefined || Object.keys(rpc.params).length === 0);
      const response = valid
        ? noContentResponse(202)
        : jsonRpcError(rpc.id, -32602, "Invalid params", 400);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        valid ? "authenticated" : "protocol_error",
      );
      return response;
    }

    if (rpc.method === "ping") {
      const response =
        rpc.id !== undefined &&
        (rpc.params === undefined || Object.keys(rpc.params).length === 0)
          ? jsonRpcResult(rpc.id, Object.freeze({}), responseFormat)
          : jsonRpcError(rpc.id, -32602, "Invalid params", 400);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        response.status === 200 ? "authenticated" : "protocol_error",
      );
      return response;
    }

    if (rpc.method !== "tools/list" && rpc.method !== "tools/call") {
      const response = jsonRpcError(rpc.id, -32601, "Method not found", 404);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "protocol_error",
      );
      return response;
    }

    const translated = modernizedLegacyCodexRequest(request, rpc);
    const authenticatedDependencies: McpHttpHandlerDependencies = {
      ...dependencies,
      authenticator: {
        async authenticate() {
          return authentication;
        },
      },
      requestIds: {
        nextRequestId() {
          return requestId;
        },
      },
    };
    return legacyCodexResponse(
      await createMcpHttpHandlerAtEndpoint(
        authenticatedDependencies,
        MCP_LEGACY_CODEX_ENDPOINT,
      )(translated),
    );
  };
}

export * from "./product-application.js";
