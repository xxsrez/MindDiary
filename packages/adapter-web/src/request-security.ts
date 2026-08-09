import type { ControlBoundaryMarker } from "@mind-diary/application-control";

type WebControlActor = ControlBoundaryMarker["actor"];

export const WEB_CONTROL_MUTATION_METHODS = Object.freeze([
  "POST",
  "PATCH",
  "PUT",
  "DELETE",
] as const);

export const WEB_CONTROL_REQUEST_SECURITY_POLICY = Object.freeze({
  origin: "configured-exact-origin",
  csrf: "principal-bound-session-verifier",
  mutationMethods: WEB_CONTROL_MUTATION_METHODS,
  forwardsSecurityCredentials: false,
});

export interface WebControlCsrfVerificationRequest {
  readonly actor: WebControlActor;
  readonly token: string;
}

export interface WebControlCsrfVerifier {
  verify(
    request: Readonly<WebControlCsrfVerificationRequest>,
  ): boolean | Promise<boolean>;
}

export interface SecuredWebControlMutation {
  readonly actor: WebControlActor;
  /** Origin, CSRF, cookies and authorization headers have been removed. */
  readonly request: Request;
}

export interface WebControlMutationExecutor<Result> {
  execute(
    mutation: Readonly<SecuredWebControlMutation>,
  ): Result | Promise<Result>;
}

export interface WebControlRequestSecurityOptions<Result> {
  /** Canonical public origin, for example `https://mind-diary.example`. */
  readonly applicationOrigin: string;
  readonly csrf: WebControlCsrfVerifier;
  readonly executor: WebControlMutationExecutor<Result>;
}

export type WebControlRequestSecurityResult<Result> =
  | { readonly kind: "executed"; readonly value: Result }
  | {
      readonly kind: "denied";
      readonly status: 403;
      readonly code: "forbidden";
      readonly retryable: false;
    };

const DENIED = Object.freeze({
  kind: "denied" as const,
  status: 403 as const,
  code: "forbidden" as const,
  retryable: false as const,
});
const MUTATION_METHODS = new Set<string>(WEB_CONTROL_MUTATION_METHODS);
const SAFE_DOWNSTREAM_HEADERS = Object.freeze([
  "accept",
  "content-type",
  "idempotency-key",
  "if-match",
] as const);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function canonicalApplicationOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("applicationOrigin must be a canonical HTTPS or loopback HTTP origin");
  }
  const loopbackHttp = parsed.protocol === "http:"
    && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
  if (
    (parsed.protocol !== "https:" && !loopbackHttp) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== value
  ) {
    throw new TypeError("applicationOrigin must be a canonical HTTPS or loopback HTTP origin");
  }
  return parsed.origin;
}

function trustedSitesActor(actor: WebControlActor): boolean {
  return (
    actor?.kind === "registered_principal" &&
    typeof actor.principalId === "string" &&
    actor.principalId.length > 0 &&
    actor.authentication.kind === "sites_identity"
  );
}

function csrfCandidate(headers: Headers): string | null {
  const token = headers.get("x-csrf-token");
  if (
    token === null ||
    token.length === 0 ||
    token.length > 512 ||
    token.includes(",") ||
    CONTROL_CHARACTER.test(token) ||
    token.trim() !== token
  ) {
    return null;
  }
  return token;
}

function safeDownstreamRequest(request: Request): Request {
  const headers = new Headers();
  for (const name of SAFE_DOWNSTREAM_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Request(request.clone(), { headers });
}

/**
 * Fail-closed browser mutation boundary. The command executor is unreachable
 * until the trusted Sites actor, exact public origin and principal-bound CSRF
 * token have all been verified. Security credentials are stripped before the
 * request reaches the command adapter.
 */
export class WebControlRequestSecurityBoundary<Result> {
  readonly #applicationOrigin: string;
  readonly #csrf: WebControlCsrfVerifier;
  readonly #executor: WebControlMutationExecutor<Result>;

  constructor(options: WebControlRequestSecurityOptions<Result>) {
    this.#applicationOrigin = canonicalApplicationOrigin(options.applicationOrigin);
    if (typeof options.csrf?.verify !== "function") {
      throw new TypeError("csrf verifier is required");
    }
    if (typeof options.executor?.execute !== "function") {
      throw new TypeError("mutation executor is required");
    }
    this.#csrf = options.csrf;
    this.#executor = options.executor;
  }

  async execute(
    actor: WebControlActor,
    request: Request,
  ): Promise<Readonly<WebControlRequestSecurityResult<Result>>> {
    if (!trustedSitesActor(actor) || !(request instanceof Request)) return DENIED;
    if (!MUTATION_METHODS.has(request.method)) return DENIED;

    let requestUrl: URL;
    try {
      requestUrl = new URL(request.url);
    } catch {
      return DENIED;
    }
    if (
      requestUrl.origin !== this.#applicationOrigin ||
      !requestUrl.pathname.startsWith("/api/v1/") ||
      request.headers.get("origin") !== this.#applicationOrigin
    ) {
      return DENIED;
    }

    const token = csrfCandidate(request.headers);
    if (token === null) return DENIED;
    let verified = false;
    try {
      verified = await this.#csrf.verify(Object.freeze({ actor, token }));
    } catch {
      return DENIED;
    }
    if (verified !== true) return DENIED;

    const value = await this.#executor.execute(
      Object.freeze({ actor, request: safeDownstreamRequest(request) }),
    );
    return Object.freeze({ kind: "executed", value });
  }
}
