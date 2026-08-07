const PROTOCOL_VERSION = "2026-07-28";
const REALM = "mind-diary-sites-probe";
const MAX_BODY_BYTES = 64 * 1024;
const OPERATION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{7,63}$/;

interface ProbeEnv {
  DB?: D1Database;
  PROBE_BUCKET?: R2Bucket;
  SITES_PROBE_BEARER_TOKEN?: string;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface ProbeOperation {
  operation_id: string;
  expected_counter: number;
  result_counter: number;
  object_key: string;
}

function requestId(): string {
  return `req_${crypto.randomUUID()}`;
}

function noStoreHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

function json(data: unknown, status = 200, extra?: HeadersInit): Response {
  return Response.json(data, {
    status,
    headers: noStoreHeaders(extra),
  });
}

function safeError(status: number, code: string, message: string, extra?: HeadersInit): Response {
  return json(
    {
      error: {
        code,
        message,
        request_id: requestId(),
      },
    },
    status,
    extra,
  );
}

function identityPresence(headers: Headers) {
  const encoding = headers.get("oai-authenticated-user-full-name-encoding");
  return {
    user_id_present: Boolean(headers.get("oai-authenticated-user-id")),
    email_present: Boolean(headers.get("oai-authenticated-user-email")),
    full_name_present: Boolean(headers.get("oai-authenticated-user-full-name")),
    full_name_encoding_present: Boolean(encoding),
    full_name_encoding_valid: encoding === "percent-encoded-utf-8",
  };
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function secretsMatch(candidate: string, expected: string): Promise<boolean> {
  const [candidateHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(candidate)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
  ]);
  const left = new Uint8Array(candidateHash);
  const right = new Uint8Array(expectedHash);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function bearerFailure(request: Request, env: ProbeEnv): Promise<Response | null> {
  const expected = env.SITES_PROBE_BEARER_TOKEN;
  if (!expected) {
    return safeError(503, "probe_not_configured", "The capability probe is not configured.");
  }

  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([\x21-\x7e]{1,512})$/.exec(authorization);
  if (!match || !(await secretsMatch(match[1], expected))) {
    return safeError(
      401,
      "authentication_required",
      "A valid bearer credential is required.",
      { "WWW-Authenticate": `Bearer realm="${REALM}", error="invalid_token"` },
    );
  }
  return null;
}

function isSecureOrLocal(url: URL): boolean {
  return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

async function ensureSchema(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare(
      "CREATE TABLE IF NOT EXISTS probe_counter (id INTEGER PRIMARY KEY, counter INTEGER NOT NULL)",
    ),
    database.prepare(
      "CREATE TABLE IF NOT EXISTS probe_operations (operation_id TEXT PRIMARY KEY, expected_counter INTEGER NOT NULL, result_counter INTEGER NOT NULL, object_key TEXT NOT NULL)",
    ),
    database.prepare("INSERT OR IGNORE INTO probe_counter (id, counter) VALUES (1, 0)"),
  ]);
}

async function readCounter(database: D1Database): Promise<number> {
  const row = await database
    .prepare("SELECT counter FROM probe_counter WHERE id = 1")
    .first<{ counter: number }>();
  if (!row || !Number.isInteger(row.counter)) {
    throw new Error("probe_counter_unavailable");
  }
  return row.counter;
}

async function findOperation(database: D1Database, operationId: string): Promise<ProbeOperation | null> {
  return database
    .prepare(
      "SELECT operation_id, expected_counter, result_counter, object_key FROM probe_operations WHERE operation_id = ?",
    )
    .bind(operationId)
    .first<ProbeOperation>();
}

function objectPayload(operation: ProbeOperation): string {
  return JSON.stringify({
    schema_version: 1,
    operation_id: operation.operation_id,
    counter: operation.result_counter,
  });
}

async function verifyObject(bucket: R2Bucket, operation: ProbeOperation): Promise<{ digest: string; present: true }> {
  const expected = objectPayload(operation);
  let object = await bucket.get(operation.object_key);
  if (!object) {
    await bucket.put(operation.object_key, expected, {
      httpMetadata: { contentType: "application/json" },
    });
    object = await bucket.get(operation.object_key);
  }
  if (!object || (await object.text()) !== expected) {
    throw new Error("probe_object_verification_failed");
  }
  return { digest: await sha256(expected), present: true };
}

async function stateSnapshot(env: Required<Pick<ProbeEnv, "DB" | "PROBE_BUCKET">>, operationId?: string) {
  await ensureSchema(env.DB);
  const counter = await readCounter(env.DB);
  if (!operationId) {
    return { counter, operation: null };
  }
  const operation = await findOperation(env.DB, operationId);
  if (!operation) {
    return { counter, operation: null };
  }
  const object = await env.PROBE_BUCKET.get(operation.object_key);
  const expectedPayload = objectPayload(operation);
  const text = object ? await object.text() : null;
  return {
    counter,
    operation: {
      operation_id: operation.operation_id,
      expected_counter: operation.expected_counter,
      result_counter: operation.result_counter,
      r2_present: text !== null,
      r2_matches: text === expectedPayload,
      r2_digest: text === expectedPayload ? await sha256(expectedPayload) : null,
    },
  };
}

async function parseBoundedJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new Error("body_too_large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new Error("body_too_large");
  }
  return JSON.parse(text);
}

async function handleIdentity(request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return safeError(405, "method_not_allowed", "Only GET is allowed.", { Allow: "GET" });
  }
  return json({
    probe: "mind-diary-sites-capability-gate",
    non_product: true,
    identity: identityPresence(request.headers),
  });
}

function stateBindings(env: ProbeEnv): Required<Pick<ProbeEnv, "DB" | "PROBE_BUCKET">> | null {
  if (!env.DB || !env.PROBE_BUCKET) {
    return null;
  }
  return { DB: env.DB, PROBE_BUCKET: env.PROBE_BUCKET };
}

async function handleState(request: Request, env: ProbeEnv): Promise<Response> {
  const authFailure = await bearerFailure(request, env);
  if (authFailure) return authFailure;
  const bindings = stateBindings(env);
  if (!bindings) {
    return safeError(503, "storage_unavailable", "Required probe storage is unavailable.");
  }

  try {
    if (request.method === "GET") {
      const operationId = new URL(request.url).searchParams.get("operation_id") ?? undefined;
      if (operationId && !OPERATION_ID_PATTERN.test(operationId)) {
        return safeError(400, "invalid_operation_id", "operation_id is invalid.");
      }
      return json({ probe: "mind-diary-sites-capability-gate", state: await stateSnapshot(bindings, operationId) });
    }

    if (request.method !== "POST") {
      return safeError(405, "method_not_allowed", "Only GET and POST are allowed.", { Allow: "GET, POST" });
    }

    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return safeError(415, "unsupported_media_type", "Content-Type must be application/json.");
    }
    const body = await parseBoundedJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return safeError(400, "invalid_request", "A JSON object is required.");
    }
    const record = body as Record<string, unknown>;
    const operationId = record.operation_id;
    const expectedCounter = record.expected_counter;
    if (
      typeof operationId !== "string" ||
      !OPERATION_ID_PATTERN.test(operationId) ||
      !Number.isInteger(expectedCounter) ||
      (expectedCounter as number) < 0
    ) {
      return safeError(400, "invalid_request", "operation_id and expected_counter are required.");
    }

    await ensureSchema(bindings.DB);
    let operation = await findOperation(bindings.DB, operationId);
    let replayed = false;
    if (operation) {
      if (operation.expected_counter !== expectedCounter) {
        return safeError(409, "idempotency_conflict", "operation_id was used with different input.");
      }
      replayed = true;
    } else {
      const resultCounter = (expectedCounter as number) + 1;
      const objectKey = `sites-capability-gate/state/${operationId}.json`;
      const results = await bindings.DB.batch([
        bindings.DB
          .prepare("UPDATE probe_counter SET counter = counter + 1 WHERE id = 1 AND counter = ?")
          .bind(expectedCounter),
        bindings.DB
          .prepare(
            "INSERT INTO probe_operations (operation_id, expected_counter, result_counter, object_key) SELECT ?, ?, ?, ? WHERE changes() = 1",
          )
          .bind(operationId, expectedCounter, resultCounter, objectKey),
      ]);
      const changed = Number(results[0]?.meta?.changes ?? 0) === 1;
      operation = await findOperation(bindings.DB, operationId);
      if (!changed || !operation) {
        const racedOperation = await findOperation(bindings.DB, operationId);
        if (racedOperation && racedOperation.expected_counter === expectedCounter) {
          operation = racedOperation;
          replayed = true;
        } else {
          return json(
            {
              error: {
                code: "state_conflict",
                message: "Counter changed; read current state and retry with a new operation_id.",
                retryable: true,
                request_id: requestId(),
                details: { current_counter: await readCounter(bindings.DB) },
              },
            },
            409,
          );
        }
      }
    }

    const object = await verifyObject(bindings.PROBE_BUCKET, operation);
    return json({
      probe: "mind-diary-sites-capability-gate",
      result: {
        operation_id: operation.operation_id,
        counter: operation.result_counter,
        replayed,
        r2_present: object.present,
        r2_digest: object.digest,
      },
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return safeError(400, "invalid_json", "Request body is not valid JSON.");
    }
    if (error instanceof Error && error.message === "body_too_large") {
      return safeError(413, "request_too_large", "Request body is too large.");
    }
    return safeError(503, "probe_dependency_error", "A probe dependency failed; retry is safe.");
  }
}

function jsonRpcError(id: unknown, code: number, message: string, status = 400): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);
}

function validRpcId(id: unknown): boolean {
  return id === undefined || typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
}

function metaIsValid(params: unknown): boolean {
  if (!params || typeof params !== "object" || Array.isArray(params)) return false;
  const meta = (params as Record<string, unknown>)._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
  const record = meta as Record<string, unknown>;
  const clientInfo = record["io.modelcontextprotocol/clientInfo"];
  const capabilities = record["io.modelcontextprotocol/clientCapabilities"];
  return (
    record["io.modelcontextprotocol/protocolVersion"] === PROTOCOL_VERSION &&
    Boolean(clientInfo && typeof clientInfo === "object" && !Array.isArray(clientInfo)) &&
    Boolean(capabilities && typeof capabilities === "object" && !Array.isArray(capabilities))
  );
}

function toolDefinition() {
  return {
    name: "probe_capabilities",
    title: "Check Sites capability probe",
    description: "Returns redacted request and binding presence for this non-product capability gate.",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { mode: { type: "string", enum: ["positive", "denied"] } },
      additionalProperties: false,
    },
    outputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["ok"],
      properties: { ok: { type: "boolean" }, data: { type: "object" }, error: { type: "object" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  };
}

function rpcResult(request: Request, env: ProbeEnv, body: JsonRpcRequest): unknown {
  if (body.method === "server/discover") {
    return {
      resultType: "complete",
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {} },
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "mind-diary-sites-capability-probe",
          version: "0.1.0",
        },
      },
      instructions: "Non-product capability probe. Use probe_capabilities only for redacted transport checks.",
      ttlMs: 0,
      cacheScope: "private",
    };
  }
  if (body.method === "tools/list") {
    return {
      resultType: "complete",
      tools: [toolDefinition()],
      ttlMs: 0,
      cacheScope: "private",
    };
  }
  if (body.method !== "tools/call") {
    return null;
  }
  const params = body.params as Record<string, unknown>;
  const args = params.arguments;
  const mode = args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>).mode ?? "positive"
    : "positive";
  if (params.name !== "probe_capabilities" || (mode !== "positive" && mode !== "denied")) {
    return null;
  }
  if (mode === "denied") {
    return {
      resultType: "complete",
      content: [{ type: "text", text: "The requested synthetic probe mode was denied." }],
      structuredContent: {
        ok: false,
        error: { code: "forbidden", message: "The synthetic denied case is active.", retryable: false, request_id: requestId() },
      },
      isError: true,
    };
  }
  return {
    resultType: "complete",
    content: [{ type: "text", text: "Sites capability probe request metadata is consistent." }],
    structuredContent: {
      ok: true,
      data: {
        probe: "mind-diary-sites-capability-gate",
        non_product: true,
        protocol_version: PROTOCOL_VERSION,
        identity: identityPresence(request.headers),
        bindings: { d1_present: Boolean(env.DB), r2_present: Boolean(env.PROBE_BUCKET) },
      },
    },
    isError: false,
  };
}

function sendRpc(request: Request, body: JsonRpcRequest, result: unknown): Response {
  const response = { jsonrpc: "2.0", id: body.id, result };
  const mode = new URL(request.url).searchParams.get("response") ?? "json";
  if (mode === "sse") {
    return new Response(`event: message\ndata: ${JSON.stringify(response)}\n\n`, {
      status: 200,
      headers: noStoreHeaders({
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      }),
    });
  }
  return json(response);
}

async function handleMcp(request: Request, env: ProbeEnv): Promise<Response> {
  if (request.method !== "POST") {
    return safeError(405, "method_not_allowed", "Stateless MCP accepts POST only.", { Allow: "POST" });
  }
  const url = new URL(request.url);
  if (!isSecureOrLocal(url)) {
    return safeError(400, "https_required", "HTTPS is required outside localhost.");
  }
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).origin !== url.origin) {
        return safeError(403, "origin_denied", "Origin is not allowed.");
      }
    } catch {
      return safeError(403, "origin_denied", "Origin is not allowed.");
    }
  }
  const authFailure = await bearerFailure(request, env);
  if (authFailure) return authFailure;
  if (request.headers.has("mcp-session-id")) {
    return jsonRpcError(null, -32020, "Mcp-Session-Id is not supported by the stateless profile.");
  }
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  const accept = (request.headers.get("accept") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json") || !accept.includes("application/json") || !accept.includes("text/event-stream")) {
    return jsonRpcError(null, -32600, "Content-Type and Accept headers are invalid.");
  }
  if (request.headers.get("mcp-protocol-version") !== PROTOCOL_VERSION) {
    return jsonRpcError(null, -32022, "Unsupported MCP protocol version.");
  }

  let body: JsonRpcRequest;
  try {
    body = (await parseBoundedJson(request)) as JsonRpcRequest;
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "body_too_large";
    return jsonRpcError(null, tooLarge ? -32600 : -32700, tooLarge ? "Request body is too large." : "Invalid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string" || !validRpcId(body.id)) {
    return jsonRpcError(body?.id, -32600, "Invalid JSON-RPC request.");
  }
  if (request.headers.get("mcp-method") !== body.method || !metaIsValid(body.params)) {
    return jsonRpcError(body.id, -32020, "Required MCP headers and body metadata do not match.");
  }
  const nameHeader = request.headers.get("mcp-name");
  const expectedName = body.method === "tools/call" && body.params && typeof body.params === "object"
    ? (body.params as Record<string, unknown>).name
    : null;
  if ((body.method === "tools/call" && (typeof expectedName !== "string" || nameHeader !== expectedName)) || (body.method !== "tools/call" && nameHeader)) {
    return jsonRpcError(body.id, -32020, "Mcp-Name does not match the request body.");
  }
  const responseMode = url.searchParams.get("response") ?? "json";
  if (responseMode !== "json" && responseMode !== "sse") {
    return jsonRpcError(body.id, -32602, "Unsupported response mode.");
  }

  const result = rpcResult(request, env, body);
  if (result === null) {
    const code = body.method === "tools/call" ? -32602 : -32601;
    return jsonRpcError(body.id, code, body.method === "tools/call" ? "Unknown tool or invalid arguments." : "Method not found.");
  }
  if (body.id === undefined) {
    return new Response(null, { status: 202, headers: noStoreHeaders() });
  }
  return sendRpc(request, body, result);
}

export async function handleCapabilityProbe(request: Request, env: ProbeEnv): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/probe/identity") return handleIdentity(request);
  if (pathname === "/probe/state") return handleState(request, env);
  if (pathname === "/mcp") return handleMcp(request, env);
  return null;
}
