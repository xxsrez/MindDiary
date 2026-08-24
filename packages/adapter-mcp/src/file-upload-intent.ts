import {
  LOCAL_FILE_UPLOAD_INTENT_LIMITS,
  type LocalFileUploadIntentService,
  type ReadLocalFileUploadIntentApplicationResult,
  type UploadLocalFileIntentApplicationResult,
} from "@mind-diary/application-content";

export const FILE_UPLOAD_INTENT_ROUTE_PREFIX = "/api/file-ingress/upload-intents/" as const;

type UploadService = Pick<LocalFileUploadIntentService, "upload" | "status">;
type UploadRequestId = Parameters<LocalFileUploadIntentService["status"]>[0]["requestId"];

export interface FileUploadIntentHttpHandlerDependencies {
  readonly application: UploadService;
  readonly publicOrigin: string;
  readonly nextRequestId: () => UploadRequestId;
}

export interface HostedFileUploadStagedReceipt {
  readonly staged_file_ref: string;
  readonly state: "verified";
  readonly source_kind: string;
  readonly display_filename: string;
  readonly media_type: string;
  readonly sha256: string;
  readonly size: number;
  readonly expires_at: string;
  readonly replayed: boolean;
}

export type HostedFileUploadIntentStatus =
  | Readonly<{ status: "pending"; expires_at: string }>
  | Readonly<{ status: "staged"; staged_file: Readonly<HostedFileUploadStagedReceipt> }>
  | Readonly<{ status: "rejected"; code: "file_ingress_intent_conflict" }>;

const JSON_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

const CAPABILITY = /^mdupload_v1_[A-Za-z0-9_-]{16,4096}$/u;

function exactPublicOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("file upload intent public origin is invalid");
  }
  if (
    parsed.origin === "null" || parsed.username !== "" || parsed.password !== "" ||
    parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== ""
  ) throw new TypeError("file upload intent public origin is invalid");
  return parsed.origin;
}

function json(status: number, data: unknown): Response {
  return new Response(`${JSON.stringify(data)}\n`, { status, headers: JSON_HEADERS });
}

function problem(
  status: number,
  code: string,
  retryable = false,
): Response {
  const message = status === 404
    ? "The upload intent is unavailable."
    : status === 410
      ? "The upload intent has expired."
      : status === 409
        ? "The upload intent cannot be reused."
        : status === 503
          ? "The upload transport is temporarily unavailable."
          : "The upload request was not accepted.";
  return json(status, { ok: false, error: { code, message, retryable } });
}

function unavailable(): Response {
  return problem(404, "file_ingress_source_unavailable");
}

function capabilityFromRequest(request: Request, publicOrigin: string): string | null {
  const url = new URL(request.url);
  const originHeader = request.headers.get("origin");
  if (
    url.origin !== publicOrigin || url.username !== "" || url.password !== "" ||
    url.search !== "" || url.hash !== "" ||
    (originHeader !== null && originHeader !== publicOrigin) ||
    request.headers.has("authorization") || request.headers.has("cookie")
  ) return null;
  const match = /^\/api\/file-ingress\/upload-intents\/([^/]+)$/u.exec(url.pathname);
  if (match === null) return null;
  let capability: string;
  try {
    capability = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  return CAPABILITY.test(capability) ? capability : null;
}

async function* requestChunks(request: Request): AsyncGenerator<Uint8Array> {
  const reader = request.body?.getReader();
  if (reader === undefined) return;
  let completed = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        completed = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function safeStagedReceipt(
  result: Extract<
    UploadLocalFileIntentApplicationResult | ReadLocalFileUploadIntentApplicationResult,
    { readonly kind: "staged" }
  >,
): Readonly<HostedFileUploadStagedReceipt> {
  return Object.freeze({
    staged_file_ref: result.record.stagedFileId,
    state: "verified",
    source_kind: result.record.sourceKind,
    display_filename: result.record.displayFilename,
    media_type: result.record.mediaType,
    sha256: result.record.sha256,
    size: result.record.size,
    expires_at: result.record.expiresAt,
    replayed: result.replayed,
  });
}

function intentFailure(code: string): Response {
  switch (code) {
    case "file_ingress_source_unavailable":
    case "insufficient_scope":
    case "write_binding_required":
    case "write_binding_stale":
      return unavailable();
    case "file_ingress_intent_expired":
      return problem(410, code);
    case "file_ingress_intent_conflict":
      return problem(409, code);
    case "file_ingress_transport_unavailable":
      return problem(503, code, true);
    default:
      return problem(400, "invalid_request");
  }
}

function stageFailure(result: Exclude<UploadLocalFileIntentApplicationResult, { readonly kind: "staged" }>): Response {
  if (result.kind === "intent_invalid") return intentFailure(result.code);
  if (result.kind === "denied") return unavailable();
  if (result.kind === "stream_invalid") {
    if (result.code === "stream_cancelled" || result.code === "stream_transport_unavailable") {
      return problem(503, "file_ingress_transport_unavailable", true);
    }
    return result.code === "stream_size_limit_exceeded"
      ? problem(413, "bundle_file_size_limit_exceeded")
      : problem(400, "invalid_request");
  }
  if (result.code === "binding_mismatch") return unavailable();
  if (result.code === "idempotency_conflict") {
    return problem(409, "file_ingress_intent_conflict");
  }
  if (result.code === "file_size_limit_exceeded") {
    return problem(413, "bundle_file_size_limit_exceeded");
  }
  if (result.code.startsWith("capacity_")) {
    return problem(429, result.code, result.code === "capacity_soft_limit");
  }
  const code = result.code === "media_type_not_allowed" ||
      result.code === "unsupported_bundle_file_type"
    ? "unsupported_bundle_file_type"
    : result.code === "file_signature_mismatch" ||
        result.code === "file_extension_mismatch" ||
        result.code === "expected_size_mismatch" ||
        result.code === "bundle_file_media_mismatch"
      ? "bundle_file_media_mismatch"
      : result.code === "expected_sha256_mismatch"
        ? "bundle_file_digest_mismatch"
        : result.code === "invalid_filename"
          ? "invalid_bundle_file_name"
          : result.code === "outstanding_staged_byte_limit_exceeded"
            ? "staging_quota_exceeded"
            : result.code;
  return problem(422, code);
}

/** Capability-only binary route. It never authenticates or logs the secret-bearing path. */
export function createFileUploadIntentHttpHandler(
  dependencies: FileUploadIntentHttpHandlerDependencies,
): (request: Request) => Promise<Response | null> {
  const publicOrigin = exactPublicOrigin(dependencies.publicOrigin);
  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(FILE_UPLOAD_INTENT_ROUTE_PREFIX)) return null;
    if (request.method !== "GET" && request.method !== "PUT") return unavailable();
    const capability = capabilityFromRequest(request, publicOrigin);
    if (capability === null) return unavailable();
    const requestId = dependencies.nextRequestId();
    try {
      if (request.method === "GET") {
        const result = await dependencies.application.status({ capability, requestId });
        if (result.kind === "intent_invalid") return intentFailure(result.code);
        if (result.kind === "pending") {
          return json(200, { ok: true, data: { status: "pending", expires_at: result.expiresAt } });
        }
        if (result.kind === "rejected") {
          return json(200, {
            ok: true,
            data: { status: "rejected", code: "file_ingress_intent_conflict" },
          });
        }
        return json(200, {
          ok: true,
          data: { status: "staged", staged_file: safeStagedReceipt(result) },
        });
      }

      if ((request.headers.get("content-type") ?? "").trim().toLowerCase() !== "application/octet-stream") {
        return problem(415, "invalid_request");
      }
      const contentLength = request.headers.get("content-length");
      if (contentLength !== null) {
        if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) return problem(400, "invalid_request");
        if (Number(contentLength) > LOCAL_FILE_UPLOAD_INTENT_LIMITS.maxBytes) {
          void request.body?.cancel().catch(() => undefined);
          return problem(413, "bundle_file_size_limit_exceeded");
        }
      }
      const result = await dependencies.application.upload({
        capability,
        requestId,
        stream: requestChunks(request),
        signal: request.signal,
      });
      if (result.kind !== "staged") return stageFailure(result);
      return json(201, {
        ok: true,
        data: { status: "staged", staged_file: safeStagedReceipt(result) },
      });
    } catch {
      return problem(503, "file_ingress_transport_unavailable", true);
    }
  };
}

export class HostedFileUploadIntentClientFailure extends Error {
  readonly name = "HostedFileUploadIntentClientFailure";

  constructor(
    readonly code:
      | "invalid_upload_url"
      | "file_ingress_source_unavailable"
      | "file_ingress_intent_expired"
      | "file_ingress_intent_conflict"
      | "file_ingress_transport_unavailable"
      | "invalid_request"
      | "bundle_file_size_limit_exceeded"
      | "bundle_file_media_mismatch"
      | "bundle_file_digest_mismatch"
      | "unsupported_bundle_file_type"
      | "invalid_bundle_file_name"
      | "staging_quota_exceeded",
    readonly retryable = code === "file_ingress_transport_unavailable",
    readonly unknownOutcome = false,
  ) {
    super("The hosted file upload operation did not complete.");
  }
}

export interface HostedFileUploadIntentClient {
  upload(input: Readonly<{
    uploadUrl: string;
    bytes: Uint8Array | ReadableStream<Uint8Array>;
    signal?: AbortSignal;
  }>): Promise<Extract<HostedFileUploadIntentStatus, { readonly status: "staged" }>>;
  status(uploadUrl: string, signal?: AbortSignal): Promise<HostedFileUploadIntentStatus>;
}

function exactCapabilityUrl(value: unknown, publicOrigin: string): string {
  if (typeof value !== "string" || value.length > 4096) {
    throw new HostedFileUploadIntentClientFailure("invalid_upload_url");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HostedFileUploadIntentClientFailure("invalid_upload_url");
  }
  if (
    parsed.origin !== publicOrigin || parsed.username !== "" || parsed.password !== "" ||
    parsed.search !== "" || parsed.hash !== ""
  ) throw new HostedFileUploadIntentClientFailure("invalid_upload_url");
  const match = /^\/api\/file-ingress\/upload-intents\/([^/]+)$/u.exec(parsed.pathname);
  if (match === null) throw new HostedFileUploadIntentClientFailure("invalid_upload_url");
  let capability: string;
  try {
    capability = decodeURIComponent(match[1]!);
  } catch {
    throw new HostedFileUploadIntentClientFailure("invalid_upload_url");
  }
  if (!CAPABILITY.test(capability)) {
    throw new HostedFileUploadIntentClientFailure("invalid_upload_url");
  }
  return parsed.href;
}

async function responseData(response: Response): Promise<unknown> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 65_536) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? value : null;
  } catch {
    return null;
  }
}

function statusData(value: unknown): HostedFileUploadIntentStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const envelope = value as { readonly ok?: unknown; readonly data?: unknown };
  if (envelope.ok !== true || typeof envelope.data !== "object" || envelope.data === null) return null;
  const data = envelope.data as Record<string, unknown>;
  if (data.status === "pending" && typeof data.expires_at === "string") {
    return Object.freeze({ status: "pending", expires_at: data.expires_at });
  }
  if (data.status === "rejected" && data.code === "file_ingress_intent_conflict") {
    return Object.freeze({ status: "rejected", code: data.code });
  }
  if (data.status !== "staged" || typeof data.staged_file !== "object" || data.staged_file === null) return null;
  const staged = data.staged_file as Record<string, unknown>;
  if (
    typeof staged.staged_file_ref !== "string" || staged.state !== "verified" ||
    typeof staged.source_kind !== "string" || typeof staged.display_filename !== "string" ||
    typeof staged.media_type !== "string" || typeof staged.sha256 !== "string" ||
    !Number.isSafeInteger(staged.size) || typeof staged.expires_at !== "string" ||
    typeof staged.replayed !== "boolean"
  ) return null;
  return Object.freeze({
    status: "staged",
    staged_file: Object.freeze({
      staged_file_ref: staged.staged_file_ref,
      state: "verified",
      source_kind: staged.source_kind,
      display_filename: staged.display_filename,
      media_type: staged.media_type,
      sha256: staged.sha256,
      size: staged.size as number,
      expires_at: staged.expires_at,
      replayed: staged.replayed,
    }),
  });
}

function responseFailure(response: Response, value: unknown, unknownOutcome = false): HostedFileUploadIntentClientFailure {
  const code = typeof value === "object" && value !== null &&
      typeof (value as { error?: { code?: unknown } }).error?.code === "string"
    ? (value as { error: { code: string } }).error.code
    : "";
  if (response.status === 410 || code === "file_ingress_intent_expired") {
    return new HostedFileUploadIntentClientFailure("file_ingress_intent_expired");
  }
  if (response.status === 409 || code === "file_ingress_intent_conflict") {
    return new HostedFileUploadIntentClientFailure("file_ingress_intent_conflict");
  }
  if (response.status === 404 || code === "file_ingress_source_unavailable") {
    return new HostedFileUploadIntentClientFailure("file_ingress_source_unavailable");
  }
  const safeDefinitiveCodes = new Set([
    "invalid_request",
    "bundle_file_size_limit_exceeded",
    "bundle_file_media_mismatch",
    "bundle_file_digest_mismatch",
    "unsupported_bundle_file_type",
    "invalid_bundle_file_name",
    "staging_quota_exceeded",
  ]);
  if (safeDefinitiveCodes.has(code)) {
    return new HostedFileUploadIntentClientFailure(
      code as Exclude<HostedFileUploadIntentClientFailure["code"],
        "invalid_upload_url" | "file_ingress_source_unavailable" |
        "file_ingress_intent_expired" | "file_ingress_intent_conflict" |
        "file_ingress_transport_unavailable">,
      false,
    );
  }
  return new HostedFileUploadIntentClientFailure(
    "file_ingress_transport_unavailable",
    response.status >= 500 || response.status === 429,
    unknownOutcome,
  );
}

/**
 * Narrow capability client for repository companions and connector bridges.
 * It has no OAuth/token input and never exposes the capability in an error.
 */
export function createHostedFileUploadIntentClient(options: Readonly<{
  publicOrigin: string;
  fetcher?: typeof fetch;
}>): HostedFileUploadIntentClient {
  const publicOrigin = exactPublicOrigin(options.publicOrigin);
  const fetcher = options.fetcher ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new TypeError("file upload fetch capability is unavailable");

  const readStatus = async (uploadUrl: string, signal?: AbortSignal): Promise<HostedFileUploadIntentStatus> => {
    const url = exactCapabilityUrl(uploadUrl, publicOrigin);
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: Object.freeze({ accept: "application/json" }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      throw new HostedFileUploadIntentClientFailure("file_ingress_transport_unavailable", true);
    }
    const value = await responseData(response);
    if (!response.ok) throw responseFailure(response, value);
    const result = statusData(value);
    if (result === null) throw new HostedFileUploadIntentClientFailure("file_ingress_transport_unavailable", true);
    return result;
  };

  const reconcileUnknownPut = async (
    uploadUrl: string,
    signal?: AbortSignal,
  ): Promise<Extract<HostedFileUploadIntentStatus, { readonly status: "staged" }> | null> => {
    try {
      const reconciled = await readStatus(uploadUrl, signal);
      if (reconciled.status === "staged") return reconciled;
      if (reconciled.status === "rejected") {
        throw new HostedFileUploadIntentClientFailure("file_ingress_intent_conflict");
      }
    } catch (error) {
      if (
        error instanceof HostedFileUploadIntentClientFailure &&
        error.code !== "file_ingress_transport_unavailable"
      ) throw error;
    }
    return null;
  };

  return Object.freeze({
    status: readStatus,
    async upload(input: Parameters<HostedFileUploadIntentClient["upload"]>[0]) {
      const url = exactCapabilityUrl(input.uploadUrl, publicOrigin);
      const body = input.bytes instanceof Uint8Array
        ? Uint8Array.from(input.bytes).buffer
        : input.bytes;
      let response: Response;
      try {
        response = await fetcher(url, {
          method: "PUT",
          redirect: "error",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          headers: Object.freeze({ "content-type": "application/octet-stream" }),
          body,
          ...(input.bytes instanceof ReadableStream ? { duplex: "half" } : {}),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        } as RequestInit);
      } catch {
        const reconciled = await reconcileUnknownPut(input.uploadUrl, input.signal);
        if (reconciled !== null) return reconciled;
        throw new HostedFileUploadIntentClientFailure(
          "file_ingress_transport_unavailable",
          true,
          true,
        );
      }
      const value = await responseData(response);
      if (!response.ok) {
        if (response.status >= 500) {
          const reconciled = await reconcileUnknownPut(input.uploadUrl, input.signal);
          if (reconciled !== null) return reconciled;
        }
        throw responseFailure(response, value, response.status >= 500);
      }
      const result = statusData(value);
      if (result?.status !== "staged") {
        const reconciled = await reconcileUnknownPut(input.uploadUrl, input.signal);
        if (reconciled !== null) return reconciled;
        throw new HostedFileUploadIntentClientFailure(
          "file_ingress_transport_unavailable",
          true,
          true,
        );
      }
      return result;
    },
  });
}
