export type NativeFileInputFailureCode =
  | "native_file_input_unsupported"
  | "bundle_file_size_limit_exceeded";

export class NativeFileInputFailure extends Error {
  readonly code: NativeFileInputFailureCode;
  readonly retryable: boolean;

  constructor(code: NativeFileInputFailureCode, retryable = false) {
    super(code === "bundle_file_size_limit_exceeded"
      ? "The native file exceeds the staging byte limit."
      : "The client native file input could not be read safely.");
    this.name = "NativeFileInputFailure";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface VerifiedNativeFileDownload {
  readonly stream: AsyncIterable<Uint8Array>;
  readonly fileName?: string;
  readonly mimeType?: string;
}

export interface NativeFileTransport {
  download(value: unknown): Promise<Readonly<VerifiedNativeFileDownload>>;
}

export interface NativeFileHostRewriteAssertion {
  readonly profileId: string;
  readonly assertionId: string;
  readonly observedAtUtc: string;
  readonly toolName: "stage_bundle_file";
  readonly parameterName: "file";
  readonly sourceKind: "session_attachment";
  readonly transport: "native_file_parameter";
}

export interface NativeFileParameterRouteOptions {
  readonly assertion: NativeFileHostRewriteAssertion;
  readonly fetcher?: typeof fetch;
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
}

export interface OpenAiFileParameterRouteOptions {
  readonly fetcher?: typeof fetch;
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
}

const NATIVE_FILE_MAX_BYTES = 268_435_456;
const SAFE_EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const NATIVE_FILE_ROUTE_CONSTRUCTION = Symbol("native-file-route-construction");
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function validHostRewriteAssertion(
  value: NativeFileHostRewriteAssertion,
): boolean {
  return record(value) &&
    Object.keys(value).length === 7 &&
    boundedString(value.profileId, 128) &&
    SAFE_EVIDENCE_ID.test(value.profileId) &&
    boundedString(value.assertionId, 256) &&
    SAFE_EVIDENCE_ID.test(value.assertionId) &&
    boundedString(value.observedAtUtc, 64) &&
    CANONICAL_UTC.test(value.observedAtUtc) &&
    Number.isFinite(Date.parse(value.observedAtUtc)) &&
    value.toolName === "stage_bundle_file" &&
    value.parameterName === "file" &&
    value.sourceKind === "session_attachment" &&
    value.transport === "native_file_parameter";
}

/**
 * One server-side route profile backed by an external receipt that the host
 * rewrites the native `file` parameter before this adapter sees the request.
 * Construction is intentionally closed so a raw transport cannot accidentally
 * make the tool appear in a direct custom-MCP catalog.
 */
export class NativeFileParameterRoute {
  readonly routeKind: "verified_host_rewrite" | "openai_file_parameter";
  readonly profileId: string;
  readonly verificationStatus: "declared_unverified" | "verified";
  readonly hostRewriteAssertionId: string | null;
  readonly hostRewriteObservedAtUtc: string | null;
  readonly sourceKind = "session_attachment" as const;
  readonly transport = "native_file_parameter" as const;
  readonly #nativeFiles: NativeFileTransport;

  private constructor(
    construction: symbol,
    profile: Readonly<{
      routeKind: "verified_host_rewrite" | "openai_file_parameter";
      profileId: string;
      verificationStatus: "declared_unverified" | "verified";
      hostRewriteAssertionId: string | null;
      hostRewriteObservedAtUtc: string | null;
    }>,
    nativeFiles: NativeFileTransport,
  ) {
    if (construction !== NATIVE_FILE_ROUTE_CONSTRUCTION) {
      throw new TypeError("native file route construction is closed");
    }
    this.routeKind = profile.routeKind;
    this.profileId = profile.profileId;
    this.verificationStatus = profile.verificationStatus;
    this.hostRewriteAssertionId = profile.hostRewriteAssertionId;
    this.hostRewriteObservedAtUtc = profile.hostRewriteObservedAtUtc;
    this.#nativeFiles = nativeFiles;
    Object.freeze(this);
  }

  static create(options: NativeFileParameterRouteOptions): NativeFileParameterRoute {
    if (!validHostRewriteAssertion(options.assertion)) {
      throw new TypeError("native file route requires an exact host rewrite assertion");
    }
    return new NativeFileParameterRoute(
      NATIVE_FILE_ROUTE_CONSTRUCTION,
      Object.freeze({
        routeKind: "verified_host_rewrite" as const,
        profileId: options.assertion.profileId,
        verificationStatus: "verified" as const,
        hostRewriteAssertionId: options.assertion.assertionId,
        hostRewriteObservedAtUtc: new Date(options.assertion.observedAtUtc).toISOString(),
      }),
      new OpenAiNativeFileTransport({
        maxBytes: NATIVE_FILE_MAX_BYTES,
        ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
        ...(options.maxRedirects === undefined
          ? {}
          : { maxRedirects: options.maxRedirects }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      }),
    );
  }

  /**
   * Standard OpenAI file-parameter route. Publication follows the documented
   * fileParams contract; whether a particular client supplies a file remains
   * client-specific acceptance evidence rather than a server route gate.
   */
  static createOpenAiFileParameter(
    options: OpenAiFileParameterRouteOptions = {},
  ): NativeFileParameterRoute {
    return new NativeFileParameterRoute(
      NATIVE_FILE_ROUTE_CONSTRUCTION,
      Object.freeze({
        routeKind: "openai_file_parameter" as const,
        profileId: "openai-file-params-v1",
        verificationStatus: "declared_unverified" as const,
        hostRewriteAssertionId: null,
        hostRewriteObservedAtUtc: null,
      }),
      new OpenAiNativeFileTransport({
        maxBytes: NATIVE_FILE_MAX_BYTES,
        ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
        ...(options.maxRedirects === undefined
          ? {}
          : { maxRedirects: options.maxRedirects }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      }),
    );
  }

  download(value: unknown): Promise<Readonly<VerifiedNativeFileDownload>> {
    return this.#nativeFiles.download(value);
  }
}

export interface OpenAiNativeFileTransportOptions {
  readonly fetcher?: typeof fetch;
  readonly maxBytes: number;
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
  readonly allowedHostSuffixes?: readonly string[];
  readonly allowedHosts?: readonly string[];
}

const DEFAULT_ALLOWED_HOST_SUFFIXES = Object.freeze(["oaiusercontent.com"]);
const DEFAULT_ALLOWED_HOSTS = Object.freeze(["files.openai.com"]);
const DEFAULT_TIMEOUT_MS = 30_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function exactNativeFile(value: unknown): Readonly<{
  fileId: string;
  downloadUrl: string;
  fileName?: string;
  mimeType?: string;
}> | null {
  if (!record(value)) return null;
  const allowed = new Set(["fileId", "downloadUrl", "fileName", "mimeType"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (
    !boundedString(value.fileId, 1_024) ||
    !boundedString(value.downloadUrl, 8_192) ||
    (value.fileName !== undefined && !boundedString(value.fileName, 1_024)) ||
    (value.mimeType !== undefined && !boundedString(value.mimeType, 256))
  ) return null;
  return Object.freeze({
    fileId: value.fileId,
    downloadUrl: value.downloadUrl,
    ...(value.fileName === undefined ? {} : { fileName: value.fileName }),
    ...(value.mimeType === undefined ? {} : { mimeType: value.mimeType }),
  });
}

export class OpenAiNativeFileTransport implements NativeFileTransport {
  readonly #fetcher: typeof fetch;
  readonly #maxBytes: number;
  readonly #maxRedirects: number;
  readonly #timeoutMs: number;
  readonly #allowedHostSuffixes: ReadonlySet<string>;
  readonly #allowedHosts: ReadonlySet<string>;

  constructor(options: OpenAiNativeFileTransportOptions) {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
      throw new TypeError("native file maxBytes must be a positive safe integer");
    }
    const maxRedirects = options.maxRedirects ?? 4;
    if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 8) {
      throw new TypeError("native file maxRedirects must be between zero and eight");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new TypeError("native file timeoutMs must be between one and 120000 milliseconds");
    }
    const fetcher = options.fetcher ?? globalThis.fetch;
    if (typeof fetcher !== "function") {
      throw new TypeError("native file fetch capability is unavailable");
    }
    this.#fetcher = fetcher;
    this.#maxBytes = options.maxBytes;
    this.#maxRedirects = maxRedirects;
    this.#timeoutMs = timeoutMs;
    this.#allowedHostSuffixes = new Set(
      options.allowedHostSuffixes ?? DEFAULT_ALLOWED_HOST_SUFFIXES,
    );
    this.#allowedHosts = new Set(options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS);
  }

  #url(value: string, base?: URL): URL {
    let parsed: URL;
    try {
      parsed = base === undefined ? new URL(value) : new URL(value, base);
    } catch {
      throw new NativeFileInputFailure("native_file_input_unsupported");
    }
    const host = parsed.hostname.toLocaleLowerCase("en-US");
    const allowed = this.#allowedHosts.has(host) ||
      [...this.#allowedHostSuffixes].some(
        (suffix) => host === suffix || host.endsWith(`.${suffix}`),
      );
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      (parsed.port !== "" && parsed.port !== "443") ||
      !allowed
    ) throw new NativeFileInputFailure("native_file_input_unsupported");
    return parsed;
  }

  async download(value: unknown): Promise<Readonly<VerifiedNativeFileDownload>> {
    const input = exactNativeFile(value);
    if (input === null) {
      throw new NativeFileInputFailure("native_file_input_unsupported");
    }
    let target = this.#url(input.downloadUrl);
    let response: Response | null = null;
    const controller = new AbortController();
    const deadlineFailure = new NativeFileInputFailure(
      "native_file_input_unsupported",
      true,
    );
    const deadline = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(deadlineFailure), {
        once: true,
      });
    });
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    let handedOff = false;
    try {
      for (let redirect = 0; redirect <= this.#maxRedirects; redirect += 1) {
        try {
          response = await Promise.race([
            this.#fetcher(target, {
              method: "GET",
              redirect: "manual",
              credentials: "omit",
              cache: "no-store",
              referrerPolicy: "no-referrer",
              signal: controller.signal,
              headers: Object.freeze({ accept: "application/octet-stream" }),
            }),
            deadline,
          ]);
        } catch (error) {
          if (error instanceof NativeFileInputFailure) throw error;
          throw new NativeFileInputFailure("native_file_input_unsupported", true);
        }
        if (!REDIRECT_STATUSES.has(response.status)) break;
        const location = response.headers.get("location");
        if (location === null || redirect === this.#maxRedirects) {
          throw new NativeFileInputFailure("native_file_input_unsupported");
        }
        void response.body?.cancel().catch(() => undefined);
        target = this.#url(location, target);
        response = null;
      }
      if (response === null || !response.ok || response.body === null) {
        throw new NativeFileInputFailure(
          "native_file_input_unsupported",
          response !== null && response.status >= 500,
        );
      }
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null) {
        const size = Number(declaredLength);
        if (Number.isFinite(size) && size > this.#maxBytes) {
          void response.body.cancel().catch(() => undefined);
          throw new NativeFileInputFailure("bundle_file_size_limit_exceeded");
        }
      }
      const body = response.body;
      const maxBytes = this.#maxBytes;
      let consumed = false;
      handedOff = true;
      return Object.freeze({
        stream: Object.freeze({
          async *[Symbol.asyncIterator]() {
            if (consumed) throw new NativeFileInputFailure("native_file_input_unsupported");
            consumed = true;
            const reader = body.getReader();
            let total = 0;
            try {
              while (true) {
                let next: ReadableStreamReadResult<Uint8Array>;
                try {
                  next = await Promise.race([reader.read(), deadline]);
                } catch (error) {
                  if (error instanceof NativeFileInputFailure) throw error;
                  throw new NativeFileInputFailure("native_file_input_unsupported", true);
                }
                if (next.done) break;
                total += next.value.byteLength;
                if (total > maxBytes) {
                  throw new NativeFileInputFailure("bundle_file_size_limit_exceeded");
                }
                yield next.value;
              }
            } finally {
              clearTimeout(timeout);
              await reader.cancel().catch(() => undefined);
              reader.releaseLock();
            }
          },
        }),
        ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
        ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
      });
    } finally {
      if (!handedOff) clearTimeout(timeout);
    }
  }
}
