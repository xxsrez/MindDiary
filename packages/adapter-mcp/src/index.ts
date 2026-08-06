import {
  CONTENT_COMMANDS,
  CONTENT_QUERIES,
  type McpBearerAuthenticationResult,
  type McpBearerAuthenticator,
} from "@mind-diary/application-content";

export const MCP_TARGET_PROTOCOL = "2026-07-28" as const;
export const MCP_ENDPOINT = "/mcp" as const;
export const MCP_WWW_AUTHENTICATE = 'Bearer realm="mind-diary"' as const;
export const MCP_AUTHENTICATION_POLICY = Object.freeze({
  scheme: "Bearer",
  requiredOnEveryPost: true,
  cachesActorAcrossRequests: false,
});

export const MCP_APPLICATION_BOUNDARY = {
  queries: CONTENT_QUERIES,
  commands: CONTENT_COMMANDS,
  authentication: MCP_AUTHENTICATION_POLICY,
} as const;

export const MCP_CONTENT_TOOLS = [
  "list_minds",
  "resolve_mind",
  "get_mind_info",
  "browse_entries",
  "search",
  "fetch",
  "list_revisions",
  "get_revision",
  "validate_mind",
  "commit_changeset",
  "start_export",
  "get_export_status",
] as const;

export const MCP_RESOURCE_CAPABILITIES = [
  "resources/list",
  "resources/read",
  "resources/templates/list-empty",
] as const;

type McpAuthenticatedActor = Extract<
  McpBearerAuthenticationResult,
  { readonly kind: "authenticated" }
>["actor"];
type McpRequestId = Parameters<McpBearerAuthenticator["authenticate"]>[1];
type McpToolName = (typeof MCP_CONTENT_TOOLS)[number];

export interface McpRequestIdGenerator {
  nextRequestId(): McpRequestId;
}

export type McpToolAuthorizationDecision =
  | { readonly kind: "allowed" }
  | {
      readonly kind: "denied";
      readonly code: string;
      readonly retryable?: boolean;
    };

export interface McpContentApplication {
  /** Returns the deployed version's complete MCP tool definitions. */
  listTools(request: {
    readonly actor: McpAuthenticatedActor;
  }): Promise<readonly Readonly<Record<string, unknown>>[]>;
  /** Resolves the target and reads current Authorizer state for every call. */
  authorizeToolCall(request: {
    readonly actor: McpAuthenticatedActor;
    readonly name: McpToolName;
    readonly arguments: Readonly<Record<string, unknown>>;
  }): Promise<McpToolAuthorizationDecision>;
  executeToolCall(request: {
    readonly actor: McpAuthenticatedActor;
    readonly name: McpToolName;
    readonly arguments: Readonly<Record<string, unknown>>;
  }): Promise<unknown>;
}

export interface McpSafeRequestLogEvent {
  readonly requestId: McpRequestId;
  readonly method: string;
  /** Pathname only: URL query and fragment are intentionally absent. */
  readonly path: string;
  readonly status: number;
  readonly outcome:
    | "authenticated"
    | "authentication_failed"
    | "authentication_unavailable"
    | "protocol_error"
    | "tool_denied"
    | "tool_completed"
    | "internal_error";
  /** Only allowlisted protocol headers survive; secrets are redacted. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface McpSafeLogger {
  record(event: McpSafeRequestLogEvent): void | Promise<void>;
}

export interface McpHttpHandlerDependencies {
  readonly authenticator: McpBearerAuthenticator;
  readonly requestIds: McpRequestIdGenerator;
  readonly content: McpContentApplication;
  readonly logger?: McpSafeLogger;
}

const REDACTED_HEADER = "[REDACTED]";
const PRESENT_HEADER = "[PRESENT]";
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-csrf-token",
]);
const SAFE_PROTOCOL_HEADERS = new Set([
  "accept",
  "content-type",
  "mcp-protocol-version",
]);
const SAFE_AUTHORIZATION_DENIALS = new Set([
  "access_denied",
  "capability_denied",
  "insufficient_scope",
  "deployment_capability_disabled",
  "historical_read_only",
  "authorization_state_changed",
]);

/** Header values default to omission so unknown private metadata cannot leak. */
export function redactMcpHeaders(
  headers: Headers,
): Readonly<Record<string, string>> {
  const redacted: Record<string, string> = {};
  for (const name of SENSITIVE_HEADERS) {
    if (headers.has(name)) redacted[name] = REDACTED_HEADER;
  }
  for (const name of SAFE_PROTOCOL_HEADERS) {
    if (headers.has(name)) redacted[name] = PRESENT_HEADER;
  }
  return Object.freeze(redacted);
}

function pathname(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "<invalid-path>";
  }
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function authenticationResponse(requestId: McpRequestId): Response {
  return jsonResponse(
    401,
    {
      type: "about:blank",
      title: "Authentication required",
      status: 401,
      code: "authentication_required",
      request_id: requestId,
    },
    {
      "content-type": "application/problem+json; charset=utf-8",
      "www-authenticate": MCP_WWW_AUTHENTICATE,
    },
  );
}

function authenticationUnavailableResponse(requestId: McpRequestId): Response {
  return jsonResponse(
    503,
    {
      type: "about:blank",
      title: "Service unavailable",
      status: 503,
      code: "authentication_unavailable",
      request_id: requestId,
    },
    { "content-type": "application/problem+json; charset=utf-8" },
  );
}

function jsonRpcError(
  id: unknown,
  code: number,
  message: string,
  status: number,
): Response {
  return jsonResponse(status, {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  });
}

function toolError(
  id: unknown,
  requestId: McpRequestId,
  code: string,
  message: string,
  retryable = false,
): Response {
  return jsonResponse(200, {
    jsonrpc: "2.0",
    id: id ?? null,
    result: {
      resultType: "complete",
      content: [{ type: "text", text: message }],
      structuredContent: {
        ok: false,
        error: {
          code,
          message,
          retryable,
          request_id: requestId,
        },
      },
      isError: true,
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolName(value: unknown): value is McpToolName {
  return (
    typeof value === "string" &&
    (MCP_CONTENT_TOOLS as readonly string[]).includes(value)
  );
}

function tokenAllowsWrite(actor: McpAuthenticatedActor): boolean {
  return actor.authentication.effectiveScopes.some(
    (scope) => scope === "content:write",
  );
}

async function authenticateRequest(
  request: Request,
  authenticator: McpBearerAuthenticator,
  requestId: McpRequestId,
): Promise<McpBearerAuthenticationResult> {
  const header = request.headers.get("authorization");
  if (header === null) return { kind: "invalid" };
  const match = /^Bearer ([^\s,]+)$/iu.exec(header);
  if (match?.[1] === undefined) return { kind: "invalid" };
  return authenticator.authenticate(match[1], requestId);
}

async function safeLog(
  logger: McpSafeLogger | undefined,
  request: Request,
  requestId: McpRequestId,
  response: Response,
  outcome: McpSafeRequestLogEvent["outcome"],
): Promise<void> {
  if (!logger) return;
  try {
    await logger.record(
      Object.freeze({
        requestId,
        method: request.method,
        path: pathname(request),
        status: response.status,
        outcome,
        headers: redactMcpHeaders(request.headers),
      }),
    );
  } catch {
    // Logging is best-effort and cannot change authentication/tool outcomes.
  }
}

function listedTools(
  actor: McpAuthenticatedActor,
  definitions: readonly Readonly<Record<string, unknown>>[],
): readonly Readonly<Record<string, unknown>>[] {
  return Object.freeze(
    definitions.filter(
      (definition) =>
        isToolName(definition.name) &&
        (definition.name !== "commit_changeset" || tokenAllowsWrite(actor)),
    ),
  );
}

/**
 * Request-scoped Streamable HTTP boundary. It intentionally does not retain an
 * actor, token, role, authorization decision, request body, query, or result.
 */
export function createMcpHttpHandler(
  dependencies: McpHttpHandlerDependencies,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const requestId = dependencies.requestIds.nextRequestId();
    if (request.method !== "POST" || pathname(request) !== MCP_ENDPOINT) {
      const response = jsonRpcError(null, -32600, "Invalid request", 404);
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
      const response = authenticationResponse(requestId);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "authentication_failed",
      );
      return response;
    }
    const actor = authentication.actor;

    let rpc: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await request.text());
      if (!isRecord(parsed)) throw new TypeError("invalid request");
      rpc = parsed;
    } catch {
      const response = jsonRpcError(null, -32700, "Parse error", 400);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "protocol_error",
      );
      return response;
    }

    if (rpc.method === "tools/list") {
      let response: Response;
      try {
        const definitions = await dependencies.content.listTools({ actor });
        response = jsonResponse(200, {
          jsonrpc: "2.0",
          id: rpc.id ?? null,
          result: { tools: listedTools(actor, definitions) },
        });
      } catch {
        response = jsonResponse(500, {
          code: "internal_error",
          request_id: requestId,
        });
      }
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        response.status === 200 ? "authenticated" : "internal_error",
      );
      return response;
    }

    if (rpc.method !== "tools/call" || !isRecord(rpc.params)) {
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

    const name = rpc.params.name;
    const argumentsValue = rpc.params.arguments;
    if (!isToolName(name) || !isRecord(argumentsValue)) {
      const response = jsonRpcError(rpc.id, -32602, "Invalid params", 400);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "protocol_error",
      );
      return response;
    }
    const toolArguments = Object.freeze({ ...argumentsValue });

    if (name === "commit_changeset" && !tokenAllowsWrite(actor)) {
      const response = toolError(
        rpc.id,
        requestId,
        "insufficient_scope",
        "The token does not allow content writes.",
      );
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "tool_denied",
      );
      return response;
    }

    let authorization: McpToolAuthorizationDecision;
    try {
      authorization = await dependencies.content.authorizeToolCall({
        actor,
        name,
        arguments: toolArguments,
      });
    } catch {
      const response = jsonResponse(500, {
        code: "internal_error",
        request_id: requestId,
      });
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "internal_error",
      );
      return response;
    }

    if (authorization.kind === "denied") {
      if (
        authorization.code === "authentication_required" ||
        authorization.code === "token_inactive"
      ) {
        const response = authenticationResponse(requestId);
        await safeLog(
          dependencies.logger,
          request,
          requestId,
          response,
          "authentication_failed",
        );
        return response;
      }
      const code = SAFE_AUTHORIZATION_DENIALS.has(authorization.code)
        ? authorization.code
        : "forbidden";
      const response = toolError(
        rpc.id,
        requestId,
        code,
        "The requested operation is not allowed.",
        authorization.retryable === true,
      );
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "tool_denied",
      );
      return response;
    }

    try {
      const result = await dependencies.content.executeToolCall({
        actor,
        name,
        arguments: toolArguments,
      });
      const response = jsonResponse(200, {
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        result,
      });
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "tool_completed",
      );
      return response;
    } catch {
      const response = jsonResponse(500, {
        code: "internal_error",
        request_id: requestId,
      });
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "internal_error",
      );
      return response;
    }
  };
}
