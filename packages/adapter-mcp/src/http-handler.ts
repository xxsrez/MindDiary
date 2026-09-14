import {
  FILE_INGRESS_WIDGET_URI,
  MCP_APPS_RESOURCE_MIME_TYPE,
} from "./file-ingress-widget.js";
import {
  MindBrowseFailure,
  MindDiscoveryFailure,
  MindHistoryFailure,
  MindSearchFailure,
  MindValidationFailure,
  BundleFileDownloadFailure,
  type McpBearerAuthenticationResult,
  type McpBearerAuthenticator,
} from "@mind-diary/application-content";

import {
  MCP_TARGET_PROTOCOL,
  MCP_ENDPOINT,
  MCP_WWW_AUTHENTICATE,
  MCP_CONTENT_TOOLS,
  MCP_RETIRED_BINDING_TOOLS,
  MCP_RETIRED_CAPTURE_TOOLS,
  MCP_MOVED_EXPORT_TOOLS,
  MCP_AGENT_INSTRUCTIONS,
  MCP_READ_TOOL_DEFINITIONS,
  MCP_ADVERTISED_CAPABILITIES,
  RESOURCE_CONTROL_CHARACTER,
  parseMcpResourceUri,
  isRootIndexResourceUri,
  type McpResourceDescriptor,
  type McpRootResourcePage,
  type McpImmutableResourceRead,
} from "./tool-definitions.js";

type McpAuthenticatedActor = Extract<
  McpBearerAuthenticationResult,
  { readonly kind: "authenticated" }
>["actor"];
type McpRequestId = Parameters<McpBearerAuthenticator["authenticate"]>[1];
type McpApplicationToolName =
  | (typeof MCP_CONTENT_TOOLS)[number]
  | (typeof MCP_MOVED_EXPORT_TOOLS)[number];
type McpRetiredToolName =
  | (typeof MCP_RETIRED_BINDING_TOOLS)[number]
  | (typeof MCP_RETIRED_CAPTURE_TOOLS)[number];
type McpToolName = McpApplicationToolName | McpRetiredToolName;
type McpReadToolName = (typeof MCP_READ_TOOL_DEFINITIONS)[number]["name"];

const MCP_READ_TOOL_NAMES: ReadonlySet<string> = new Set(
  MCP_READ_TOOL_DEFINITIONS.map((definition) => definition.name),
);

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
  /** Enumerates bounded current-access roots; exact-only unlisted Minds stay absent. */
  listRootResources(request: {
    readonly actor: McpAuthenticatedActor;
    readonly cursor?: string;
  }): Promise<Readonly<McpRootResourcePage>>;
  /** Reauthorizes current access and reads one exact immutable Markdown resource. */
  readResource(request: {
    readonly actor: McpAuthenticatedActor;
    readonly uri: string;
  }): Promise<Readonly<McpImmutableResourceRead>>;
  /** Legacy compatibility hook; fused handlers execute application authorization once. */
  authorizeToolCall(request: {
    readonly actor: McpAuthenticatedActor;
    readonly name: McpApplicationToolName;
    readonly arguments: Readonly<Record<string, unknown>>;
  }): Promise<McpToolAuthorizationDecision>;
  /** Preferred product path: validates, authorizes and executes in one application graph. */
  executeAuthorizedToolCall?(request: {
    readonly actor: McpAuthenticatedActor;
    readonly name: McpApplicationToolName;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
  executeToolCall(request: {
    readonly actor: McpAuthenticatedActor;
    readonly name: McpApplicationToolName;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
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
  /** Canonical HTTPS origin allowed when a browser supplies an Origin header. */
  readonly allowedOrigin?: string;
  readonly oauth?: Readonly<{
    readonly protectedResourceMetadataUrl: string;
  }>;
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
  "mcp-method",
  "mcp-name",
  "mcp-protocol-version",
  "mcp-session-id",
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

export function pathname(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "<invalid-path>";
  }
}

export function jsonResponse(
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

function oauthChallenge(
  oauth: McpHttpHandlerDependencies["oauth"],
  scope: "content:read" | "content:write" | "personal:configure" = "content:read",
): string {
  return oauth === undefined
    ? MCP_WWW_AUTHENTICATE
    : `Bearer resource_metadata="${oauth.protectedResourceMetadataUrl}", scope="${scope}"`;
}

export function authenticationResponse(
  requestId: McpRequestId,
  oauth?: McpHttpHandlerDependencies["oauth"],
): Response {
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
      "www-authenticate": oauthChallenge(oauth),
    },
  );
}

export function authenticationUnavailableResponse(requestId: McpRequestId): Response {
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

export function jsonRpcError(
  id: unknown,
  code: number,
  message: string,
  status: number,
  headers: Readonly<Record<string, string>> = {},
  data?: Readonly<Record<string, unknown>>,
): Response {
  return jsonResponse(
    status,
    {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    },
    headers,
  );
}

type McpResponseFormat = "json" | "sse";

interface AcceptedRepresentation {
  readonly format: McpResponseFormat;
  readonly preference: number;
  readonly position: number;
}

interface McpJsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface McpProtocolError {
  readonly code: -32600 | -32020 | -32021 | -32022;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export function noContentResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function jsonRpcResult(
  id: string | number | undefined,
  result: unknown,
  format: McpResponseFormat,
): Response {
  if (id === undefined) return noContentResponse(202);
  const payload = { jsonrpc: "2.0", id, result };
  if (format === "json") return jsonResponse(200, payload);
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

export function acceptedResponseFormat(value: string | null): McpResponseFormat | null {
  if (value === null) return null;
  const supported = new Map<McpResponseFormat, AcceptedRepresentation>();
  for (const [position, item] of value.split(",").entries()) {
    const [rawMediaType, ...rawParameters] = item.split(";");
    const mediaType = rawMediaType?.trim().toLowerCase();
    const format =
      mediaType === "application/json"
        ? "json"
        : mediaType === "text/event-stream"
          ? "sse"
          : null;
    if (format === null) continue;

    let preference = 1;
    for (const rawParameter of rawParameters) {
      const [rawName, rawValue] = rawParameter.split("=", 2);
      if (rawName?.trim().toLowerCase() !== "q") continue;
      const parsed = Number(rawValue?.trim());
      preference = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
    }
    if (preference <= 0) continue;
    const existing = supported.get(format);
    if (
      existing === undefined ||
      preference > existing.preference ||
      (preference === existing.preference && position < existing.position)
    ) {
      supported.set(format, { format, preference, position });
    }
  }

  const json = supported.get("json");
  const sse = supported.get("sse");
  if (json === undefined || sse === undefined) return null;
  if (sse.preference !== json.preference) {
    return sse.preference > json.preference ? "sse" : "json";
  }
  return sse.position < json.position ? "sse" : "json";
}

export function hasJsonContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

export function invalidRequestOrigin(
  request: Request,
  allowedOrigin: string | undefined,
): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin !== allowedOrigin;
}

export function validRpcId(value: unknown): value is string | number | undefined {
  return (
    value === undefined ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function parseJsonRpcRequest(value: unknown): McpJsonRpcRequest | null {
  if (
    !isRecord(value) ||
    value.jsonrpc !== "2.0" ||
    typeof value.method !== "string" ||
    value.method.length === 0 ||
    !validRpcId(value.id) ||
    !isRecord(value.params)
  ) {
    return null;
  }
  return value as unknown as McpJsonRpcRequest;
}

export function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function expectedMcpName(request: McpJsonRpcRequest): unknown {
  if (request.method === "tools/call") return request.params.name;
  if (request.method === "resources/read") return request.params.uri;
  return null;
}

function decodedMcpHeaderValue(value: string | null): string | null {
  if (value === null) return null;
  if (!value.startsWith("=?base64?") || !value.endsWith("?=")) return value;
  const encoded = value.slice("=?base64?".length, -2);
  if (encoded.length === 0) return null;
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function validateProtocolEnvelope(
  request: McpJsonRpcRequest,
  headers: Headers,
): McpProtocolError | null {
  const headerVersion = headers.get("mcp-protocol-version");
  if (headerVersion === null) {
    return { code: -32020, message: "MCP-Protocol-Version is required." };
  }
  if (headerVersion !== MCP_TARGET_PROTOCOL) {
    return {
      code: -32022,
      message: "Unsupported MCP protocol version.",
      data: Object.freeze({
        requested: headerVersion,
        supported: Object.freeze([MCP_TARGET_PROTOCOL]),
      }),
    };
  }

  const methodHeader = headers.get("mcp-method");
  if (methodHeader === null || methodHeader !== request.method) {
    return { code: -32020, message: "Mcp-Method does not match the request body." };
  }

  const expectedName = expectedMcpName(request);
  const nameHeader = headers.get("mcp-name");
  const decodedNameHeader = decodedMcpHeaderValue(nameHeader);
  if (expectedName === null) {
    if (nameHeader !== null) {
      return { code: -32020, message: "Mcp-Name is not valid for this method." };
    }
  } else if (
    !nonEmptyString(expectedName) ||
    decodedNameHeader !== expectedName
  ) {
    return { code: -32020, message: "Mcp-Name does not match the request body." };
  }

  const meta = request.params._meta;
  if (!isRecord(meta)) {
    return { code: -32020, message: "Request protocol metadata is required." };
  }
  const metaVersion = meta["io.modelcontextprotocol/protocolVersion"];
  if (typeof metaVersion !== "string") {
    return { code: -32020, message: "Request protocol metadata is incomplete." };
  }
  if (metaVersion !== MCP_TARGET_PROTOCOL || metaVersion !== headerVersion) {
    return {
      code: -32022,
      message: "Unsupported MCP protocol version.",
      data: Object.freeze({
        requested: metaVersion,
        supported: Object.freeze([MCP_TARGET_PROTOCOL]),
      }),
    };
  }

  const clientInfo = meta["io.modelcontextprotocol/clientInfo"];
  if (
    !isRecord(clientInfo) ||
    !nonEmptyString(clientInfo.name) ||
    !nonEmptyString(clientInfo.version)
  ) {
    return { code: -32020, message: "Client information is required." };
  }
  if (!isRecord(meta["io.modelcontextprotocol/clientCapabilities"])) {
    return { code: -32021, message: "Client capabilities are required." };
  }
  return null;
}

export function createMcpToolSuccessResult(
  data: unknown,
  message: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    resultType: "complete",
    content: Object.freeze([
      Object.freeze({ type: "text" as const, text: message }),
    ]),
    structuredContent: Object.freeze({ ok: true, data }),
    isError: false,
  });
}

export function createMcpToolErrorResult(
  requestId: McpRequestId,
  code: string,
  message: string,
  retryable = false,
  details?: Readonly<Record<string, unknown>>,
  meta?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const error = Object.freeze({
    code,
    message,
    retryable,
    request_id: requestId,
    ...(details === undefined ? {} : { details }),
  });
  return Object.freeze({
    resultType: "complete",
    content: Object.freeze([
      Object.freeze({ type: "text" as const, text: message }),
    ]),
    structuredContent: Object.freeze({ ok: false, error }),
    isError: true,
    ...(meta === undefined ? {} : { _meta: meta }),
  });
}

function isReadToolName(name: McpApplicationToolName): name is McpReadToolName {
  return MCP_READ_TOOL_NAMES.has(name);
}

function readToolSuccessMessage(name: McpReadToolName): string {
  switch (name) {
    case "list_minds":
      return "Listed accessible Minds.";
    case "resolve_mind":
      return "Resolved the Mind.";
    case "get_mind_info":
      return "Resolved the Mind and revision.";
    case "browse_entries":
      return "Browsed entries in the resolved Mind revision.";
    case "search":
      return "Searched the resolved Mind revision.";
    case "fetch":
      return "Fetched the exact entry revision.";
    case "list_files":
      return "Listed files in the exact Mind revision.";
    case "grep_files":
      return "Searched file content in the exact Mind revision.";
    case "read_files":
      return "Read exact file ranges from the Mind revision.";
    case "list_revisions":
      return "Listed Mind revisions.";
    case "get_revision":
      return "Fetched the exact Mind revision.";
    case "validate_mind":
      return "Validated the complete Mind revision.";
    case "list_bundle_files":
      return "Listed BundleFiles in the exact Mind revision.";
  }
}

function normalizeReadToolExecutionResult(
  name: McpReadToolName,
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (
    !isRecord(value) ||
    value.resultType !== "complete" ||
    !isRecord(value.structuredContent) ||
    typeof value.isError !== "boolean"
  ) {
    return createMcpToolSuccessResult(value, readToolSuccessMessage(name));
  }
  if (Array.isArray(value.content)) return value;
  return Object.freeze({
    ...value,
    content: Object.freeze([
      Object.freeze({
        type: "text" as const,
        text: value.isError ? "The tool call failed." : readToolSuccessMessage(name),
      }),
    ]),
  });
}

interface SafeReadToolFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

const CREDENTIAL_ACCESS_UPGRADE_DETAILS = Object.freeze({
  schema: "mind-diary/credential-access-upgrade-required/v1",
  remediation: Object.freeze(["upgrade", "re-consent", "reissue"]),
});

function credentialAccessUpgradeToolResult(
  requestId: McpRequestId,
): Readonly<Record<string, unknown>> {
  const message = "Upgrade, re-consent, or reissue this credential before reading content.";
  return Object.freeze({
    resultType: "complete",
    content: Object.freeze([
      Object.freeze({ type: "text" as const, text: message }),
    ]),
    structuredContent: Object.freeze({
      schema: CREDENTIAL_ACCESS_UPGRADE_DETAILS.schema,
      ok: false,
      error: Object.freeze({
        code: "credential_access_upgrade_required",
        message,
        retryable: false,
        request_id: requestId,
        remediation: CREDENTIAL_ACCESS_UPGRADE_DETAILS.remediation,
      }),
    }),
    isError: true,
  });
}

function readFailureMessage(code: string): string {
  switch (code) {
    case "authentication_required":
      return "Authentication is required.";
    case "forbidden":
      return "The requested operation is not allowed.";
    case "mind_not_found":
      return "Mind was not found.";
    case "revision_not_found":
      return "Revision was not found.";
    case "locator_not_found":
    case "resource_not_found":
      return "The requested entry was not found.";
    case "bundle_file_not_found":
      return "BundleFile was not found.";
    case "search_index_unavailable":
      return "Search is unavailable for the exact requested revision; continue with list_files, grep_files, and read_files for the same Mind and revision.";
    case "discovery_unavailable":
      return "Mind discovery is unavailable.";
    case "revision_integrity_failure":
      return "The exact revision could not be materialized safely.";
    case "read_conflict":
      return "The Mind changed while it was being read; retry the call.";
    case "mind_binding_required":
      return "Enable this Mind for reading in the Mind Diary Site, then refresh list_minds.";
    case "credential_access_upgrade_required":
      return "Upgrade, re-consent, or reissue this credential before reading content.";
    case "write_binding_required":
    case "writable_mind_required":
      return "Configure the exact target Mind as read_write in the Mind Diary Site, then refresh list_minds.";
    case "write_binding_stale":
    case "writable_mind_stale":
      return "The writable Mind changed; refresh list_minds and rebuild the commit from the current HEAD.";
    case "binding_owner_revoked":
      return "The current credential can no longer use this principal's enabled Minds.";
    case "binding_state_unavailable":
      return "Mind usage settings are unavailable.";
    case "invalid_cursor":
      return "The pagination cursor is invalid.";
    case "invalid_limit":
      return "The page limit is invalid.";
    case "invalid_path":
      return "The content path is invalid.";
    case "invalid_fetch_budget":
      return "The fetch response budget is invalid.";
    case "invalid_mind_selector":
      return "The Mind selector is invalid.";
    case "invalid_revision_selector":
      return "The revision selector is invalid.";
    case "invalid_query":
      return "The query is invalid.";
    case "invalid_file_operation":
      return "The file operation arguments are invalid; correct them before retrying.";
    case "invalid_glob":
      return "The file glob is invalid.";
    case "invalid_metadata_filter":
      return "The metadata filter is invalid.";
    case "invalid_sort":
      return "The file sort is invalid.";
    case "unsupported_pattern":
      return "The search pattern is unsupported.";
    case "file_operation_cursor_invalid":
      return "The file operation cursor is invalid.";
    case "file_operation_budget_exhausted":
      return "The bounded file operation budget is exhausted.";
    case "invalid_request":
    default:
      return "The tool arguments are invalid.";
  }
}

const VALIDATION_READ_FAILURES = new Set([
  "invalid_cursor",
  "invalid_limit",
  "invalid_path",
  "invalid_fetch_budget",
  "invalid_mind_selector",
  "invalid_revision_selector",
  "invalid_query",
  "invalid_file_operation",
  "invalid_glob",
  "invalid_metadata_filter",
  "invalid_sort",
  "unsupported_pattern",
  "file_operation_cursor_invalid",
]);

function readFailureDetails(
  code: string,
  retryable: boolean,
): Readonly<Record<string, unknown>> | undefined {
  if (code === "search_index_unavailable") {
    return Object.freeze({
      category: "service_state",
      state: "index_unavailable",
      recovery: Object.freeze({
        action: "use_file_workflow_same_revision",
        retry_policy: "bounded",
        preserve: Object.freeze(["mind", "revision"]),
        tools: Object.freeze(["list_files", "grep_files", "read_files"]),
      }),
    });
  }
  if (VALIDATION_READ_FAILURES.has(code)) {
    return Object.freeze({
      category: "validation",
      state: "request_rejected",
      recovery: Object.freeze({
        action: "correct_arguments",
        retry_policy: "after_correction",
      }),
    });
  }
  if (code === "file_operation_budget_exhausted") {
    return Object.freeze({
      category: "resource_limit",
      state: "budget_exhausted",
      recovery: Object.freeze({
        action: retryable ? "retry_same_request" : "reduce_response_scope",
        retry_policy: retryable ? "bounded" : "after_correction",
        preserve: Object.freeze(["mind", "revision"]),
      }),
    });
  }
  if (code === "bundle_file_not_found") {
    return Object.freeze({
      category: "content_state",
      state: "file_unavailable",
      recovery: Object.freeze({
        action: "refresh_file_list",
        retry_policy: "after_refresh",
        preserve: Object.freeze(["mind", "revision"]),
      }),
    });
  }
  return undefined;
}

function safeReadToolFailure(error: unknown): SafeReadToolFailure | null {
  if (isRecord(error) && (error.code === "metadata_queue_timeout" || error.code === "metadata_d1_timeout")) {
    return Object.freeze({
      code: error.code,
      message: "Metadata is temporarily unavailable. Reconcile any write using its original idempotency key before retrying.",
      retryable: true,
    });
  }
  if (
    !(
      error instanceof MindDiscoveryFailure ||
      error instanceof MindBrowseFailure ||
      error instanceof MindHistoryFailure ||
      error instanceof MindSearchFailure ||
      error instanceof MindValidationFailure ||
      error instanceof BundleFileDownloadFailure
    )
  ) {
    return null;
  }
  const retryable =
    "retryable" in error
      ? error.retryable === true
      : error.code === "discovery_unavailable";
  const details = error.code === "credential_access_upgrade_required"
    ? CREDENTIAL_ACCESS_UPGRADE_DETAILS
    : readFailureDetails(error.code, retryable);
  return Object.freeze({
    code: error.code,
    message: readFailureMessage(error.code),
    retryable,
    ...(details === undefined ? {} : { details }),
  });
}

function toolError(
  id: string | number | undefined,
  requestId: McpRequestId,
  code: string,
  message: string,
  format: McpResponseFormat,
  retryable = false,
  meta?: Readonly<Record<string, unknown>>,
  details?: Readonly<Record<string, unknown>>,
): Response {
  return jsonRpcResult(
    id,
    createMcpToolErrorResult(requestId, code, message, retryable, details, meta),
    format,
  );
}

function recoverableToolState(
  id: string | number | undefined,
  requestId: McpRequestId,
  code: string,
  message: string,
  format: McpResponseFormat,
  retryable: boolean,
  details?: Readonly<Record<string, unknown>>,
): Response {
  return jsonRpcResult(
    id,
    Object.freeze({
      ...createMcpToolErrorResult(
        requestId,
        code,
        message,
        retryable,
        details,
      ),
      isError: false,
    }),
    format,
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolName(value: unknown): value is McpToolName {
  return (
    typeof value === "string" &&
    ((MCP_CONTENT_TOOLS as readonly string[]).includes(value) ||
      (MCP_RETIRED_BINDING_TOOLS as readonly string[]).includes(value) ||
      (MCP_RETIRED_CAPTURE_TOOLS as readonly string[]).includes(value) ||
      (MCP_MOVED_EXPORT_TOOLS as readonly string[]).includes(value))
  );
}

function isRetiredToolName(
  value: McpToolName,
): value is McpRetiredToolName {
  return (MCP_RETIRED_BINDING_TOOLS as readonly string[]).includes(value) ||
    (MCP_RETIRED_CAPTURE_TOOLS as readonly string[]).includes(value);
}

function retiredToolResult(
  operation: McpRetiredToolName,
): Readonly<Record<string, unknown>> {
  const remediation = operation === "get_mind_bindings"
    ? "inspect_mind_usage_on_site"
    : operation === "set_read_mind_binding"
      ? "manage_mind_usage_on_site"
      : operation === "set_write_mind_binding"
        ? "manage_mind_usage_on_site"
        : "use_commit_changeset";
  const text = operation === "get_mind_bindings"
    ? "Mind usage is configured on each Mind in the authenticated Mind Diary Site; use list_minds for the current enabled projection."
    : operation === "set_read_mind_binding"
      ? "Configure read or read_write on the Mind Diary Site, then refresh list_minds."
      : operation === "set_write_mind_binding"
        ? "Configure each intended Mind independently as read_write on the Mind Diary Site, then refresh list_minds."
        : "capture_knowledge is retired; use the canonical commit_changeset automatic-save workflow.";
  return Object.freeze({
    resultType: "complete",
    content: Object.freeze([
      Object.freeze({ type: "text" as const, text }),
    ]),
    structuredContent: Object.freeze({
      schema: "mind-diary/mcp-operation-retired/v1",
      error: Object.freeze({
        code: "operation_retired_from_content_mcp",
        operation,
        remediation,
        retryable: false,
      }),
    }),
    isError: true,
  });
}

function tokenAllowsWrite(actor: McpAuthenticatedActor): boolean {
  return actor.authentication.effectiveScopes.some(
    (scope) => scope === "content:write",
  );
}

export async function authenticateRequest(
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

export async function safeLog(
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
  const available = new Map(
    definitions.flatMap((definition) =>
      typeof definition.name === "string"
        ? [[definition.name, definition] as const]
        : [],
    ),
  );
  return Object.freeze(
    MCP_CONTENT_TOOLS
      .filter(
        (name) =>
          available.has(name) &&
          ((name !== "stage_bundle_file" &&
            name !== "create_file_upload_intent" &&
            name !== "open_bundle_file_picker") ||
            tokenAllowsWrite(actor)),
      )
      .map((name) => available.get(name))
      .filter(
        (definition): definition is Readonly<Record<string, unknown>> =>
          definition !== undefined,
      ),
  );
}

type ResourceListParameters =
  | { readonly kind: "valid"; readonly cursor?: string }
  | { readonly kind: "invalid" };

function resourceListParameters(
  params: Readonly<Record<string, unknown>>,
): ResourceListParameters {
  if (Object.keys(params).some((key) => key !== "_meta" && key !== "cursor")) {
    return Object.freeze({ kind: "invalid" });
  }
  if (params.cursor === undefined) return Object.freeze({ kind: "valid" });
  if (
    typeof params.cursor !== "string" ||
    params.cursor.length === 0 ||
    params.cursor.length > 4_096 ||
    RESOURCE_CONTROL_CHARACTER.test(params.cursor)
  ) {
    return Object.freeze({ kind: "invalid" });
  }
  return Object.freeze({ kind: "valid", cursor: params.cursor });
}

function exactResourceReadUri(
  params: Readonly<Record<string, unknown>>,
): string | null {
  const keys = Object.keys(params).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "_meta" ||
    keys[1] !== "uri" ||
    (parseMcpResourceUri(params.uri) === null && params.uri !== FILE_INGRESS_WIDGET_URI)
  ) {
    return null;
  }
  return params.uri as string;
}

function validSafeResourceText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1_024 &&
    !RESOURCE_CONTROL_CHARACTER.test(value)
  );
}

function normalizedRootResourcePage(
  value: unknown,
): Readonly<McpRootResourcePage> | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.resources) ||
    (value.nextCursor !== null &&
      (typeof value.nextCursor !== "string" ||
        value.nextCursor.length === 0 ||
        value.nextCursor.length > 4_096 ||
        RESOURCE_CONTROL_CHARACTER.test(value.nextCursor)))
  ) {
    return null;
  }
  const resources: McpResourceDescriptor[] = [];
  const seen = new Set<string>();
  for (const candidate of value.resources) {
    if (
      !isRecord(candidate) ||
      !isRootIndexResourceUri(candidate.uri) ||
      !validSafeResourceText(candidate.name) ||
      candidate.mimeType !== "text/markdown; charset=utf-8" ||
      (candidate.title !== undefined && !validSafeResourceText(candidate.title)) ||
      (candidate.description !== undefined &&
        !validSafeResourceText(candidate.description)) ||
      seen.has(candidate.uri)
    ) {
      return null;
    }
    seen.add(candidate.uri);
    resources.push(
      Object.freeze({
        uri: candidate.uri,
        name: candidate.name,
        ...(candidate.title === undefined ? {} : { title: candidate.title }),
        ...(candidate.description === undefined
          ? {}
          : { description: candidate.description }),
        mimeType: candidate.mimeType,
      }),
    );
  }
  resources.sort((left, right) =>
    left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0,
  );
  return Object.freeze({
    resources: Object.freeze(resources),
    nextCursor: value.nextCursor,
  });
}

function normalizedResourceRead(
  expectedUri: string,
  value: unknown,
): Readonly<McpImmutableResourceRead> | null {
  if (
    !isRecord(value) ||
    value.uri !== expectedUri ||
    !(
      (parseMcpResourceUri(value.uri) !== null &&
        value.mimeType === "text/markdown; charset=utf-8") ||
      (value.uri === FILE_INGRESS_WIDGET_URI &&
        value.mimeType === MCP_APPS_RESOURCE_MIME_TYPE)
    ) ||
    typeof value.text !== "string" ||
    (value._meta !== undefined && !isRecord(value._meta))
  ) {
    return null;
  }
  return Object.freeze({
    uri: value.uri,
    mimeType: value.mimeType,
    text: value.text,
    ...(value._meta === undefined ? {} : { _meta: value._meta }),
  });
}

function resourceNotFoundResponse(
  id: string | number | undefined,
  format: McpResponseFormat,
): Response {
  const payload = {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code: -32602, message: "Resource not found" },
  };
  if (format === "json") return jsonResponse(400, payload);
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 400,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

function credentialAccessUpgradeResponse(
  id: string | number | undefined,
  format: McpResponseFormat,
): Response {
  const payload = {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code: -32043,
      message: "Credential access upgrade required",
      data: Object.freeze({
        schema: "mind-diary/credential-access-upgrade-required/v1",
        code: "credential_access_upgrade_required",
        retryable: false,
        remediation: Object.freeze(["upgrade", "re-consent", "reissue"]),
      }),
    },
  };
  if (format === "json") return jsonResponse(400, payload);
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 400,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

function credentialAccessUpgradeRequired(error: unknown): boolean {
  return (
    error instanceof MindDiscoveryFailure ||
    error instanceof MindBrowseFailure ||
    error instanceof MindHistoryFailure ||
    error instanceof MindSearchFailure ||
    error instanceof MindValidationFailure ||
    error instanceof BundleFileDownloadFailure
  ) &&
    error.code === "credential_access_upgrade_required";
}

function indistinguishableResourceNotFound(error: unknown): boolean {
  return (
    error instanceof MindBrowseFailure &&
    error.code !== "revision_integrity_failure"
  );
}

/**
 * Request-scoped Streamable HTTP boundary. It intentionally does not retain an
 * actor, token, role, authorization decision, request body, query, or result.
 */
export function createMcpHttpHandlerAtEndpoint(
  dependencies: McpHttpHandlerDependencies,
  endpoint: string,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const requestId = dependencies.requestIds.nextRequestId();
    if (pathname(request) !== endpoint) {
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
    if (request.method !== "POST") {
      const response = jsonRpcError(
        null,
        -32600,
        "Stateless MCP accepts POST only.",
        405,
        { allow: "POST" },
      );
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "protocol_error",
      );
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
    const actor = authentication.actor;

    if (!hasJsonContentType(request.headers.get("content-type"))) {
      const response = jsonRpcError(
        null,
        -32600,
        "Content-Type must be application/json.",
        400,
      );
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "protocol_error",
      );
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
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "protocol_error",
      );
      return response;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await request.text());
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

    const rpc = parseJsonRpcRequest(parsed);
    if (rpc === null) {
      const id = isRecord(parsed) && validRpcId(parsed.id) ? parsed.id : null;
      const response = jsonRpcError(id, -32600, "Invalid request", 400);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "protocol_error",
      );
      return response;
    }

    const protocolError = validateProtocolEnvelope(rpc, request.headers);
    if (protocolError !== null) {
      const response = jsonRpcError(
        rpc.id,
        protocolError.code,
        protocolError.message,
        400,
        {},
        protocolError.data,
      );
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "protocol_error",
      );
      return response;
    }

    if (rpc.method === "server/discover") {
      if (
        rpc.id === undefined ||
        Object.keys(rpc.params).length !== 1 ||
        !Object.hasOwn(rpc.params, "_meta")
      ) {
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
      const response = jsonRpcResult(
        rpc.id,
        Object.freeze({
          resultType: "complete" as const,
          supportedVersions: Object.freeze([MCP_TARGET_PROTOCOL]),
          capabilities: MCP_ADVERTISED_CAPABILITIES,
          _meta: Object.freeze({
            "io.modelcontextprotocol/serverInfo": Object.freeze({
              name: "mind-diary",
              title: "Mind Diary",
              version: "0.1.0",
            }),
          }),
          instructions: MCP_AGENT_INSTRUCTIONS,
          ttlMs: 60_000,
          cacheScope: "private" as const,
        }),
        responseFormat,
      );
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "authenticated",
      );
      return response;
    }

    if (rpc.method === "resources/templates/list") {
      if (
        Object.keys(rpc.params).length !== 1 ||
        !Object.hasOwn(rpc.params, "_meta")
      ) {
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
      const response = jsonRpcResult(
        rpc.id,
        {
          resultType: "complete",
          resourceTemplates: Object.freeze([]),
        },
        responseFormat,
      );
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "authenticated",
      );
      return response;
    }

    if (rpc.method === "resources/list") {
      const parameters = resourceListParameters(rpc.params);
      if (parameters.kind === "invalid") {
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
      let response: Response;
      let outcome: McpSafeRequestLogEvent["outcome"];
      try {
        const listed = await dependencies.content.listRootResources({
          actor,
          ...(parameters.cursor === undefined
            ? {}
            : { cursor: parameters.cursor }),
        });
        const page = normalizedRootResourcePage(listed);
        response =
          page === null
            ? jsonResponse(500, {
                code: "internal_error",
                request_id: requestId,
              })
            : jsonRpcResult(
                rpc.id,
                Object.freeze({
                  resultType: "complete",
                  resources: page.resources,
                  ...(page.nextCursor === null
                    ? {}
                    : { nextCursor: page.nextCursor }),
                  ttlMs: 60_000,
                  cacheScope: "private",
                }),
                responseFormat,
              );
        outcome = response.status === 200 || response.status === 202
          ? "authenticated"
          : "internal_error";
      } catch (error) {
        if (credentialAccessUpgradeRequired(error)) {
          response = credentialAccessUpgradeResponse(rpc.id, responseFormat);
          outcome = "tool_denied";
        } else {
          response = jsonResponse(500, {
            code: "internal_error",
            request_id: requestId,
          });
          outcome = "internal_error";
        }
      }
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        outcome,
      );
      return response;
    }

    if (rpc.method === "resources/read") {
      const uri = exactResourceReadUri(rpc.params);
      if (uri === null) {
        const response = resourceNotFoundResponse(rpc.id, responseFormat);
        await safeLog(
          dependencies.logger,
          request,
          requestId,
          response,
          "protocol_error",
        );
        return response;
      }
      let response: Response;
      let outcome: McpSafeRequestLogEvent["outcome"];
      try {
        const read = normalizedResourceRead(
          uri,
          await dependencies.content.readResource({ actor, uri }),
        );
        if (read === null) {
          response = jsonResponse(500, {
            code: "internal_error",
            request_id: requestId,
          });
          outcome = "internal_error";
        } else {
          response = jsonRpcResult(
            rpc.id,
            {
              resultType: "complete",
              contents: Object.freeze([
                Object.freeze({
                  uri: read.uri,
                  mimeType: read.mimeType,
                  text: read.text,
                  ...(read._meta === undefined ? {} : { _meta: read._meta }),
                }),
              ]),
            },
            responseFormat,
          );
          outcome = "authenticated";
        }
      } catch (error) {
        if (credentialAccessUpgradeRequired(error)) {
          response = credentialAccessUpgradeResponse(rpc.id, responseFormat);
          outcome = "tool_denied";
        } else if (indistinguishableResourceNotFound(error)) {
          response = resourceNotFoundResponse(rpc.id, responseFormat);
          outcome = "protocol_error";
        } else {
          response = jsonResponse(500, {
            code: "internal_error",
            request_id: requestId,
          });
          outcome = "internal_error";
        }
      }
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        outcome,
      );
      return response;
    }

    if (rpc.method === "tools/list") {
      let response: Response;
      try {
        const definitions = await dependencies.content.listTools({ actor });
        response = jsonRpcResult(
          rpc.id,
          {
            resultType: "complete",
            tools: listedTools(actor, definitions),
            ttlMs: 60_000,
            cacheScope: "private",
          },
          responseFormat,
        );
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
        response.status === 200 || response.status === 202
          ? "authenticated"
          : "internal_error",
      );
      return response;
    }

    if (rpc.method !== "tools/call" || !isRecord(rpc.params)) {
      const message =
        rpc.method === "initialize"
          ? "Method not found; initialize is not part of the stateless 2026-07-28 profile."
          : "Method not found";
      const response = jsonRpcError(rpc.id, -32601, message, 404);
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

    if (isRetiredToolName(name)) {
      const response = jsonRpcResult(
        rpc.id,
        retiredToolResult(name),
        responseFormat,
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

    if ((name === "get_personal_mind_configuration" || name === "set_personal_mind_description")
      && !actor.authentication.effectiveScopes.some((scope) => scope === "personal:configure")) {
      return toolError(rpc.id, requestId, "insufficient_scope", "Personal configuration permission is required.", responseFormat, false,
        Object.freeze({ "mcp/www_authenticate": Object.freeze([oauthChallenge(dependencies.oauth, "personal:configure")]) }));
    }

    if (
      (name === "commit_changeset" ||
        name === "enqueue_note" ||
        name === "reconcile_changeset" ||
        name === "create_file_upload_intent" ||
        name === "open_bundle_file_picker" ||
        name === "stage_bundle_file" ||
        name === "reconcile_file_stage") &&
      !tokenAllowsWrite(actor)
    ) {
      const challenge = oauthChallenge(dependencies.oauth, "content:write");
      const response = toolError(
        rpc.id,
        requestId,
        "insufficient_scope",
        "The token does not allow content writes.",
        responseFormat,
        false,
        Object.freeze({ "mcp/www_authenticate": Object.freeze([challenge]) }),
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

    const fusedExecution = dependencies.content.executeAuthorizedToolCall;
    if (fusedExecution === undefined) {
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
        const code = SAFE_AUTHORIZATION_DENIALS.has(authorization.code)
          ? authorization.code
          : "forbidden";
        const response = toolError(
          rpc.id,
          requestId,
          code,
          "The requested operation is not allowed.",
          responseFormat,
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
    }

    try {
      const execution = await (fusedExecution === undefined
        ? dependencies.content.executeToolCall({
            actor,
            name,
            arguments: toolArguments,
            signal: request.signal,
          })
        : fusedExecution.call(dependencies.content, {
            actor,
            name,
            arguments: toolArguments,
            signal: request.signal,
          }));
      const result = isReadToolName(name)
        ? normalizeReadToolExecutionResult(name, execution)
        : execution;
      const response = jsonRpcResult(rpc.id, result, responseFormat);
      await safeLog(
        dependencies.logger,
        request,
        requestId,
        response,
        "tool_completed",
      );
      return response;
    } catch (error) {
      const safeFailure = isReadToolName(name) || name === "get_bundle_file_download"
        || (isRecord(error) && (error.code === "metadata_queue_timeout" || error.code === "metadata_d1_timeout"))
        ? safeReadToolFailure(error)
        : null;
      if (safeFailure !== null) {
        if (safeFailure.code === "credential_access_upgrade_required") {
          const response = jsonRpcResult(
            rpc.id,
            credentialAccessUpgradeToolResult(requestId),
            responseFormat,
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
        const response = safeFailure.code === "search_index_unavailable"
          ? recoverableToolState(
              rpc.id,
              requestId,
              safeFailure.code,
              safeFailure.message,
              responseFormat,
              safeFailure.retryable,
              safeFailure.details,
            )
          : toolError(
              rpc.id,
              requestId,
              safeFailure.code,
              safeFailure.message,
              responseFormat,
              safeFailure.retryable,
              undefined,
              safeFailure.details,
            );
        await safeLog(
          dependencies.logger,
          request,
          requestId,
          response,
          safeFailure.code === "forbidden" ? "tool_denied" : "tool_completed",
        );
        return response;
      }
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

/** Current stateless MCP 2026-07-28 endpoint. */
export function createMcpHttpHandler(
  dependencies: McpHttpHandlerDependencies,
): (request: Request) => Promise<Response> {
  return createMcpHttpHandlerAtEndpoint(dependencies, MCP_ENDPOINT);
}
