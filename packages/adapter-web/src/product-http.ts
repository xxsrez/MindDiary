import type {
  ControlBoundaryMarker,
  SitesIdentityBeforeRegistration,
} from "@mind-diary/application-control";
import {
  SITES_IDENTITY_PROVIDER,
  normalizeSitesVerifiedEmail,
  type SitesIdentityBindingReader,
  type SitesIdentityRequestContext,
  type TrustedSitesIdentitySnapshot,
} from "./sites-identity-binding.js";

type RegisteredSitesActor = Extract<
  ControlBoundaryMarker["actor"],
  { readonly kind: "registered_principal" }
>;
export type ProductWebActor = RegisteredSitesActor | SitesIdentityBeforeRegistration;

export type ProductSitesIdentityResolution =
  | { readonly kind: "authenticated"; readonly actor: RegisteredSitesActor }
  | { readonly kind: "registration_required"; readonly actor: SitesIdentityBeforeRegistration }
  | { readonly kind: "denied" }
  | { readonly kind: "unavailable" };

/**
 * Converts one server-owned Sites identity snapshot into application authority.
 * The normalized binding is returned only inside the bootstrap actor and is
 * never serialized by this adapter.
 */
export async function resolveProductSitesIdentity(input: {
  readonly snapshot: TrustedSitesIdentitySnapshot;
  readonly bindings: SitesIdentityBindingReader;
  readonly context: SitesIdentityRequestContext;
}): Promise<Readonly<ProductSitesIdentityResolution>> {
  if (input.snapshot.kind !== "authenticated") {
    return Object.freeze({ kind: "denied" as const });
  }
  const normalizedBinding = normalizeSitesVerifiedEmail(
    input.snapshot.verifiedEmail,
  );
  if (normalizedBinding === null) {
    return Object.freeze({ kind: "denied" as const });
  }
  const binding = await input.bindings.readActiveBinding({
    provider: SITES_IDENTITY_PROVIDER,
    normalizedBinding,
  });
  if (binding.kind === "unavailable") {
    return Object.freeze({ kind: "unavailable" as const });
  }
  if (binding.kind === "bound") {
    if (
      binding.provider !== SITES_IDENTITY_PROVIDER ||
      binding.normalizedBinding !== normalizedBinding ||
      typeof binding.principalId !== "string" ||
      binding.principalId.length === 0
    ) {
      return Object.freeze({ kind: "unavailable" as const });
    }
    return Object.freeze({
      kind: "authenticated" as const,
      actor: Object.freeze({
        kind: "registered_principal" as const,
        principalId: binding.principalId,
        authentication: Object.freeze({
          kind: "sites_identity" as const,
          verifiedByPlatform: true as const,
        }),
        requestId: input.context.requestId,
        occurredAtUtc: input.context.occurredAtUtc,
        deploymentCapabilities: Object.freeze([
          ...input.context.deploymentCapabilities,
        ]),
      }) as RegisteredSitesActor,
    });
  }
  if (binding.kind !== "unbound") {
    return Object.freeze({ kind: "unavailable" as const });
  }
  return Object.freeze({
    kind: "registration_required" as const,
    actor: Object.freeze({
      kind: "sites_identity_before_registration" as const,
      authentication: Object.freeze({
        kind: "sites_identity" as const,
        verifiedByPlatform: true as const,
      }),
      provider: SITES_IDENTITY_PROVIDER,
      normalizedBinding:
        normalizedBinding as unknown as SitesIdentityBeforeRegistration["normalizedBinding"],
      ...(input.snapshot.verifiedFullName === undefined
        ? {}
        : { suggestedDisplayName: input.snapshot.verifiedFullName }),
      deploymentCapabilities: Object.freeze([
        ...input.context.deploymentCapabilities,
      ]),
      requestId: input.context.requestId,
      occurredAtUtc: input.context.occurredAtUtc,
    }),
  });
}

export interface ProductWebCsrf {
  issue(actor: ProductWebActor): string | Promise<string>;
  verify(actor: ProductWebActor, token: string): boolean | Promise<boolean>;
}

export interface ProductWebControlApplication {
  execute(request: {
    readonly operation: string;
    readonly actor: ProductWebActor;
    readonly input: Readonly<Record<string, unknown>>;
  }): unknown | Promise<unknown>;
}

export interface ProductWebHttpHandlerDependencies {
  readonly applicationOrigin: string;
  readonly resolveIdentity: (
    request: Request,
  ) => ProductSitesIdentityResolution | Promise<ProductSitesIdentityResolution>;
  readonly csrf: ProductWebCsrf;
  readonly control: ProductWebControlApplication;
}

const MUTATION_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const MAX_JSON_BYTES = 64 * 1024;
const SAFE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

function canonicalOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== value ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError("applicationOrigin must be one canonical HTTPS origin");
  }
  return value;
}

function json(status: number, body: unknown): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: {
      ...SAFE_HEADERS,
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function errorResponse(
  status: number,
  code: string,
  requestId: string,
  retryable = false,
): Response {
  return json(status, {
    ok: false,
    error: { code, message: safeErrorMessage(code), retryable, request_id: requestId },
  });
}

function safeErrorMessage(code: string): string {
  if (code === "authentication_required") return "Authentication is required.";
  if (code === "registration_required") return "Account registration is required.";
  if (code === "invalid_request") return "The request is invalid.";
  if (code === "not_found") return "The resource was not found.";
  if (code === "forbidden") return "The request is forbidden.";
  if (code === "method_not_allowed") return "The method is not allowed.";
  return "The request could not be completed.";
}

function safeRequestId(resolution: ProductSitesIdentityResolution): string {
  return "actor" in resolution && typeof resolution.actor.requestId === "string"
    ? resolution.actor.requestId
    : "request_denied";
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function mapPlainKeys(value: unknown, mapper: (key: string) => string): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => mapPlainKeys(item, mapper)));
  }
  if (value === null || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        mapper(key),
        mapPlainKeys(item, mapper),
      ]),
    ),
  );
}

function camelInput(value: Readonly<Record<string, unknown>>) {
  return mapPlainKeys(
    value,
    (key) => key.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase()),
  ) as Readonly<Record<string, unknown>>;
}

function snakeOutput(value: unknown): unknown {
  return mapPlainKeys(value, (key) =>
    key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`),
  );
}

function page(input: {
  readonly title: string;
  readonly subtitle: string;
  readonly csrfToken: string;
  readonly route: string;
  readonly registrationRequired: boolean;
}): Response {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.title)} · Mind Diary</title>
<style>:root{color-scheme:light;--ink:#17221d;--leaf:#255b45;--paper:#f6f0e5;--sun:#e5a94d}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,sans-serif}header,main{max-width:72rem;margin:auto;padding:1.25rem}header{display:flex;align-items:center;justify-content:space-between}a{color:var(--leaf)}.brand{font:700 1.15rem Georgia,serif}.hero{padding:7vh 0 3rem;max-width:48rem}h1{font:700 clamp(2.5rem,7vw,5.5rem)/.98 Georgia,serif;margin:.3rem 0 1rem}p{max-width:42rem}.card{background:#fffaf2;border:1px solid #d8cfbf;border-radius:1rem;padding:1.25rem;box-shadow:0 12px 35px #45372212}.button{display:inline-block;border:0;border-radius:999px;background:var(--leaf);color:white;padding:.75rem 1.1rem;text-decoration:none}.eyebrow{color:var(--leaf);font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:.75rem}</style></head>
<body><header><a class="brand" href="/">Mind Diary</a><nav><a href="/me">My Mind</a></nav></header><main>
<section class="hero"><div class="eyebrow">Your shared, versioned memory</div><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.subtitle)}</p></section>
<section class="card" data-route="${escapeHtml(input.route)}" data-registration-required="${String(input.registrationRequired)}"><p>${input.registrationRequired ? "Create an isolated account to begin. Existing access is never inferred from a similar identity." : "Open your Mind, browse exact immutable history, or manage collaboration from this authenticated control surface."}</p></section>
<script type="application/json" id="mind-diary-session">${JSON.stringify({ csrf_token: input.csrfToken }).replaceAll("<", "\\u003c")}</script>
</main></body></html>`;
  return new Response(body, {
    status: 200,
    headers: {
      ...SAFE_HEADERS,
      "content-type": "text/html; charset=utf-8",
    },
  });
}

async function readInput(request: Request): Promise<Readonly<Record<string, unknown>>> {
  if (request.method === "GET") {
    const url = new URL(request.url);
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    return Object.freeze(query);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new TypeError("request body is too large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
    throw new TypeError("request body is too large");
  }
  if (text.length === 0) return Object.freeze({});
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("request body must be an object");
  }
  return Object.freeze({ ...(value as Record<string, unknown>) });
}

function segment(value: string | undefined): string | null {
  if (value === undefined || value.length === 0) return null;
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && !decoded.includes("/") && !decoded.includes("\\")
      ? decoded
      : null;
  } catch {
    return null;
  }
}

function apiOperation(method: string, pathname: string): {
  readonly operation: string;
  readonly path: Readonly<Record<string, string>>;
} | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "v1") return null;
  const tail = parts.slice(2);
  const one = segment(tail[0]);
  const two = segment(tail[1]);
  const three = segment(tail[2]);
  const four = segment(tail[3]);
  if (method === "GET" && one === "session" && tail.length === 1) return { operation: "get_session", path: {} };
  if (one === "account" && tail.length === 1) {
    if (method === "POST") return { operation: "bootstrap_account", path: {} };
    if (method === "PATCH") return { operation: "rename_account", path: {} };
    if (method === "DELETE") return { operation: "delete_account", path: {} };
  }
  if (method === "GET" && one === "account" && two === "deletion-impact" && tail.length === 2) return { operation: "get_account_deletion_impact", path: {} };
  if (one === "minds" && tail.length === 1) {
    if (method === "GET") return { operation: "list_minds", path: {} };
    if (method === "POST") return { operation: "create_space_with_owner", path: {} };
  }
  if (method === "GET" && one === "public-minds" && tail.length === 1) return { operation: "list_public_minds", path: {} };
  if (one === "minds" && two !== null) {
    const path = { mind_ref: two };
    if (tail.length === 2 && method === "GET") return { operation: "get_mind_info", path };
    if (tail.length === 2 && method === "PATCH") return { operation: "rename_space", path };
    if (tail.length === 2 && method === "DELETE") return { operation: "delete_space", path };
    if (three === "deletion-impact" && tail.length === 3 && method === "GET") return { operation: "get_mind_deletion_impact", path };
    if (three === "visibility" && tail.length === 3 && method === "PUT") return { operation: "change_visibility", path };
    if (three === "members" && tail.length === 3 && method === "GET") return { operation: "list_members", path };
    if (three === "members" && four !== null && tail.length === 4) {
      const memberPath = { ...path, member_id: four };
      if (method === "PATCH") return { operation: "change_membership_role", path: memberPath };
      if (method === "DELETE") return { operation: "revoke_membership", path: memberPath };
    }
    if (three === "leave" && tail.length === 3 && method === "POST") return { operation: "leave_space", path };
    if (three === "ownership-transfer" && tail.length === 3 && method === "POST") return { operation: "transfer_ownership", path };
    if (three === "invitations" && tail.length === 3 && method === "POST") return { operation: "create_invitation", path };
  }
  if (one === "invitations") {
    if (tail.length === 1 && method === "GET") return { operation: "list_invitations", path: {} };
    if (two !== null && tail.length === 2 && method === "DELETE") return { operation: "cancel_invitation", path: { invitation_id: two } };
    if (two !== null && three === "accept" && tail.length === 3 && method === "POST") return { operation: "accept_invitation", path: { invitation_id: two } };
    if (two !== null && three === "reject" && tail.length === 3 && method === "POST") return { operation: "reject_invitation", path: { invitation_id: two } };
    if (two !== null && three === "reissue" && tail.length === 3 && method === "POST") return { operation: "reissue_invitation", path: { invitation_id: two } };
  }
  if (one === "mcp-tokens") {
    if (tail.length === 1 && method === "GET") return { operation: "list_mcp_tokens", path: {} };
    if (tail.length === 1 && method === "POST") return { operation: "issue_mcp_token", path: {} };
    if (two !== null && tail.length === 2 && method === "DELETE") return { operation: "revoke_mcp_token", path: { token_id: two } };
  }
  return null;
}

function failureCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/u.test(error.code)
  ) return error.code;
  return "operation_failed";
}

/** Authenticated web/control handler. It deliberately never reads Bearer auth. */
export function createProductWebHttpHandler(
  dependencies: ProductWebHttpHandlerDependencies,
): (request: Request) => Promise<Response | null> {
  const origin = canonicalOrigin(dependencies.applicationOrigin);
  return async (request) => {
    const url = new URL(request.url);
    const isApi = url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/");
    const isUi = url.pathname === "/" || url.pathname === "/me" || /^\/[a-z0-9][a-z0-9-]{0,62}$/u.test(url.pathname);
    if (!isApi && !isUi) return null;

    let identity: ProductSitesIdentityResolution;
    try {
      identity = await dependencies.resolveIdentity(request);
    } catch {
      identity = { kind: "unavailable" };
    }
    const requestId = safeRequestId(identity);
    if (identity.kind === "denied") return errorResponse(401, "authentication_required", requestId);
    if (identity.kind === "unavailable") return errorResponse(503, "identity_binding_unavailable", requestId, true);

    if (isUi) {
      if (request.method !== "GET" && request.method !== "HEAD") return errorResponse(405, "method_not_allowed", requestId);
      const token = await dependencies.csrf.issue(identity.actor);
      const title = url.pathname === "/" ? "A home for what you know." : url.pathname === "/me" ? "My Mind" : `Mind ${url.pathname}`;
      const response = page({
        title,
        subtitle: "Private by default. Shared deliberately. Every committed change stays addressable.",
        csrfToken: token,
        route: url.pathname,
        registrationRequired: identity.kind === "registration_required",
      });
      return request.method === "HEAD" ? new Response(null, response) : response;
    }

    const matched = apiOperation(request.method, url.pathname);
    if (matched === null) return errorResponse(404, "not_found", requestId);
    if (
      identity.kind === "registration_required" &&
      !(matched.operation === "bootstrap_account" && request.method === "POST")
    ) {
      return errorResponse(409, "registration_required", requestId);
    }
    if (MUTATION_METHODS.has(request.method)) {
      if (url.origin !== origin || request.headers.get("origin") !== origin) {
        return errorResponse(403, "forbidden", requestId);
      }
      const csrf = request.headers.get("x-csrf-token");
      if (
        csrf === null ||
        csrf.length === 0 ||
        csrf.length > 512 ||
        !(await dependencies.csrf.verify(identity.actor, csrf))
      ) {
        return errorResponse(403, "forbidden", requestId);
      }
    }
    let input: Readonly<Record<string, unknown>>;
    try {
      const parsed = camelInput(await readInput(request));
      const idempotencyKey = request.headers.get("idempotency-key");
      input = Object.freeze({
        ...parsed,
        ...(idempotencyKey === null || "idempotencyKey" in parsed
          ? {}
          : { idempotencyKey }),
        ...matched.path,
      });
    } catch {
      return errorResponse(400, "invalid_request", requestId);
    }
    try {
      const data = await dependencies.control.execute({
        operation: matched.operation,
        actor: identity.actor,
        input,
      });
      return json(200, { ok: true, data: snakeOutput(data) });
    } catch (error) {
      const code = failureCode(error);
      const status = code.includes("not_found") ? 404 : code.includes("conflict") ? 409 : code.includes("authentication") ? 401 : code.includes("invalid") ? 400 : 403;
      return errorResponse(status, code, requestId);
    }
  };
}
