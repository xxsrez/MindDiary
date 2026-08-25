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
import {
  renderAuthenticatedOnboardingDocument,
  type AuthenticatedOnboardingModel,
} from "./onboarding.js";
import {
  normalizeAccountDeletionImpact,
  renderAccountDeletionDocument,
  type AccountDeletionViewState,
} from "./account-deletion.js";
import {
  renderMindDiaryUiShellDocument,
  renderMindDiaryRoutePageDocument,
  type MindDiaryUiShellModel,
  type MindDiaryRoutePageModel,
  type UiMindCard,
} from "./ui-shell.js";
import {
  MIND_DIARY_CODEX_CONCIERGE_PLAYBOOK,
  MIND_DIARY_CODEX_STARTER_PLAYBOOK,
  renderMcpTokenManagementDocument,
  type MindBindingOwnerUiState,
  type MindBindingUiMind,
  type McpTokenManagementModel,
  type McpTokenUiToken,
} from "./token-management.js";
import {
  renderOrdinaryMindsManagementDocument,
  type OrdinaryMindOwnershipCandidates,
  type OrdinaryMindCapacity,
  type OrdinaryMindUiMember,
  type OrdinaryMindUiMind,
  type OrdinaryMindsManagementModel,
} from "./ordinary-minds-management.js";
import {
  renderVisibilityCatalogDocument,
  type PublicMindCatalogCollection,
  type PublicMindCatalogItem,
} from "./visibility-catalog.js";
import {
  renderInvitationsMembershipDocument,
  type InvitationMembershipGlobalInvitation,
  type InvitationMembershipInvitation,
  type InvitationMembershipMember,
  type InvitationMembershipPageModel,
} from "./invitations-membership.js";
import { renderServiceOperatorDirectoryDocument } from "./operator-directory.js";
import {
  renderAdvancedMcpPageDocument,
  renderCodexHelpPageDocument,
  renderConnectionDetailDocument,
  renderConnectionsPageDocument,
  type AdvancedMcpPageModel,
  type ConnectionDetail,
  type ConnectionListItem,
  type PersonalTokenItem,
  type SafeConnectionMind,
  type SafeCredentialAccess,
} from "./connections.js";
import {
  PRODUCT_COLLABORATION_CLIENT_JAVASCRIPT,
  PRODUCT_CONNECTIONS_LAYOUT_CSS,
  PRODUCT_CONNECTIONS_CLIENT_JAVASCRIPT,
  PRODUCT_MARKDOWN_IMPORT_CLIENT_JAVASCRIPT,
  PRODUCT_ORDINARY_MINDS_CLIENT_JAVASCRIPT,
  PRODUCT_UI_APPLE_TOUCH_ICON_PNG,
  PRODUCT_VISIBILITY_CATALOG_CLIENT_JAVASCRIPT,
  PRODUCT_UI_CLIENT_JAVASCRIPT,
  PRODUCT_UI_FAVICON_ICO,
  PRODUCT_UI_FAVICON_PNG,
  PRODUCT_UI_FAVICON_SVG,
  PRODUCT_UI_LOCKUP_SVG,
  PRODUCT_UI_MARK_SVG,
  PRODUCT_UI_SHELL_CSS,
  PRODUCT_UI_TOKENS_CSS,
} from "./product-ui-assets.js";

type RegisteredSitesActor = Extract<
  ControlBoundaryMarker["actor"],
  { readonly kind: "registered_principal" }
>;
export type ProductWebActor = RegisteredSitesActor | SitesIdentityBeforeRegistration;

export interface ProductSitesSessionSnapshot {
  readonly principal: {
    readonly displayName: string;
    readonly profileVersion: number;
  };
  readonly personalMind: {
    readonly name: string;
    readonly headRevisionId: string;
  };
}

export type ProductSitesIdentityResolution =
  | {
      readonly kind: "authenticated";
      readonly actor: RegisteredSitesActor;
      /** Safe projection captured by the same durable read that authenticated the request. */
      readonly session?: Readonly<ProductSitesSessionSnapshot>;
    }
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
  readonly bindingProvider?: string;
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
  const bindingProvider = input.bindingProvider ?? SITES_IDENTITY_PROVIDER;
  if (
    typeof bindingProvider !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/u.test(bindingProvider)
  ) {
    return Object.freeze({ kind: "unavailable" as const });
  }
  const binding = await input.bindings.readActiveBinding({
    provider: bindingProvider,
    normalizedBinding,
  });
  if (binding.kind === "unavailable") {
    return Object.freeze({ kind: "unavailable" as const });
  }
  if (binding.kind === "bound") {
    if (
      binding.provider !== bindingProvider ||
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
      provider: bindingProvider,
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

export interface ProductWebOAuthConnections {
  listPage(principalId: string, query: Readonly<{
    readonly limit?: number;
    readonly cursor?: string | null;
  }>): Promise<Readonly<{
    readonly items: readonly {
      readonly connectionRef: string;
      readonly bindingOwnerId: string;
      readonly clientName: string;
      readonly scopes: readonly ("content:read" | "content:write")[];
      readonly createdAt: string;
      readonly lastUsedAt: string | null;
    }[];
    readonly nextCursor: string | null;
  }>>;
  read(principalId: string, connectionRef: string): Promise<Readonly<{
    readonly connectionRef: string;
    readonly bindingOwnerId: string;
    readonly clientName: string;
    readonly scopes: readonly ("content:read" | "content:write")[];
    readonly createdAt: string;
    readonly lastUsedAt: string | null;
  }> | null>;
  revoke(principalId: string, connectionRef: string): Promise<boolean>;
}

export interface ProductWebPersonalTokenRecord extends PersonalTokenItem {
  readonly bindingOwnerId: string;
}

export interface ProductWebPersonalTokens {
  listPage(
    actor: RegisteredSitesActor,
    query: Readonly<{
      readonly state?: "active" | "revoked" | "expired";
      readonly limit?: number;
      readonly cursor?: string | null;
    }>,
  ): Promise<Readonly<{
    readonly items: readonly ProductWebPersonalTokenRecord[];
    readonly nextCursor: string | null;
  }>>;
  read(
    actor: RegisteredSitesActor,
    personalTokenRef: string,
  ): Promise<Readonly<ProductWebPersonalTokenRecord> | null>;
}

export interface ProductWebMindBindingOwner {
  readonly ownerId: string;
  readonly bindingVersion: number;
  readonly state: "active" | "revoked" | "deleted";
  readonly readBindings: readonly {
    readonly readBindingId: string;
    readonly staleAccessRef: string;
    readonly mindId: string;
  }[];
  readonly writeBinding: {
    readonly writeBindingId: string;
    readonly mindId: string;
  } | null;
  readonly automaticCapture: {
    readonly mode: "disabled" | "routine_non_sensitive";
    readonly writeBindingId: string | null;
    readonly updatedAt: string | null;
  };
}

export interface ProductWebMindBindings {
  list(
    actor: RegisteredSitesActor,
    ownerIds: readonly string[],
  ): Promise<readonly ProductWebMindBindingOwner[]>;
  listResolved(
    actor: RegisteredSitesActor,
    credentials: readonly Readonly<{
      readonly ownerId: string;
      readonly scopes: readonly ("content:read" | "content:write")[];
      readonly state: "active" | "revoked";
    }>[],
  ): Promise<readonly ProductWebMindBindingOwner[]>;
  mutate(
    actor: RegisteredSitesActor,
    request: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  mutateResolved(
    actor: RegisteredSitesActor,
    credential: Readonly<{
      readonly ownerId: string;
      readonly scopes: readonly ("content:read" | "content:write")[];
      readonly state: "active" | "revoked";
    }>,
    request: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<{
    readonly changed: boolean;
    readonly replayed: boolean;
    readonly bindingVersion: number;
  }>>;
}

export interface ProductWebActivityRecorder {
  recordSuccessful(
    actor: RegisteredSitesActor,
    surface: "web",
    kind: "page" | "control_read" | "control_write",
  ): void | Promise<void>;
}

export type ProductWebPerformanceOperation =
  | "home"
  | "stage_authentication"
  | "stage_application"
  | "stage_total";

export interface ProductWebPerformanceRecorder {
  record(event: {
    readonly requestId: string;
    readonly benchmarkCorrelationId: string | null;
    readonly operation: ProductWebPerformanceOperation;
    readonly durationMs: number;
    readonly outcome: "success" | "failure";
  }): void | Promise<void>;
}

export interface ProductWebHttpHandlerDependencies {
  readonly applicationOrigin: string;
  readonly resolveIdentity: (
    request: Request,
  ) => ProductSitesIdentityResolution | Promise<ProductSitesIdentityResolution>;
  readonly csrf: ProductWebCsrf;
  readonly control: ProductWebControlApplication;
  readonly oauthConnections?: ProductWebOAuthConnections;
  readonly personalTokens?: ProductWebPersonalTokens;
  readonly mindBindings?: ProductWebMindBindings;
  readonly activity?: ProductWebActivityRecorder;
  readonly performance?: ProductWebPerformanceRecorder;
}

type ProductWebActivityDeferrer = (promise: Promise<unknown>) => void;

async function recordSuccessfulProductWebActivity(
  recorder: ProductWebActivityRecorder | undefined,
  defer: ProductWebActivityDeferrer | undefined,
  actor: RegisteredSitesActor,
  kind: "page" | "control_read" | "control_write",
): Promise<void> {
  if (recorder === undefined) return;
  let pending: Promise<void>;
  try {
    pending = Promise.resolve(recorder.recordSuccessful(actor, "web", kind));
  } catch {
    return;
  }
  if (defer !== undefined) {
    try {
      defer(pending.catch(() => undefined));
      return;
    } catch {
      // Fall through to the bounded foreground fallback when host deferral fails.
    }
  }
  try {
    await pending;
  } catch {
    // Activity is observational and must never change the product response.
  }
}

const MUTATION_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const PRODUCT_UI_ROUTES = new Set([
  "/",
  "/me",
  "/minds",
  "/public",
  "/invitations",
  "/settings/account",
  "/settings/mcp",
  "/settings/connections",
  "/settings/developer/mcp",
  "/help/codex",
  "/help",
  "/internal/operators/users",
]);
const RESERVED_UI_HANDLES = new Set([
  "api",
  "brand",
  "callback",
  "help",
  "invitations",
  "internal",
  "mcp",
  "me",
  "minds",
  "public",
  "settings",
  "signin-with-chatgpt",
  "signout-with-chatgpt",
  "ui",
]);
const SITES_SIGN_IN_PATH = "/signin-with-chatgpt";
const MAX_JSON_BYTES = 64 * 1024;
const MAX_IMPORT_PLAN_BODY_BYTES = 16 * 1024 * 1024;
const MAX_IMPORT_BATCH_BODY_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_BATCH_BYTES = 4 * 1024 * 1024;
const ENCODER = new TextEncoder();
const SAFE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'self'; img-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});
const STATIC_ASSET_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";
const PRODUCT_UI_PILOT_SHELL_CSS = `
.md-brand-lockup{display:inline-flex;align-items:center;gap:.55rem;min-width:0}
.md-environment{padding:.2rem .5rem;border:1px solid var(--mind-diary-memory-plum);border-radius:999px;color:var(--mind-diary-memory-plum);background:#fff;font-size:.72rem;font-weight:800;letter-spacing:.08em}
.md-navigation{flex-wrap:wrap}
.md-profile{text-decoration:none}
.md-profile[aria-current=page]{background:#eee5fa;box-shadow:inset 0 -3px var(--mind-diary-memory-plum)}
.md-route-links{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.25rem}
.md-setup-card>*{min-width:0}
.md-setup-card--single{grid-template-columns:minmax(0,1fr)}
.md-setup-card pre{min-width:0;max-width:100%;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.md-setup-card pre code{white-space:inherit;overflow-wrap:anywhere}
.md-binding-panel{display:grid;gap:.9rem;margin-top:1rem;padding-top:1rem;border-top:1px solid var(--mind-diary-border-subtle);min-width:0}
.md-binding-panel__heading,.md-binding-write,.md-capture-policy{display:flex;align-items:flex-start;justify-content:space-between;gap:.75rem;flex-wrap:wrap}
.md-capture-policy{padding:.85rem;border:1px solid var(--mind-diary-border-subtle);border-radius:.75rem;background:#fff}.md-capture-policy>div{display:grid;gap:.45rem;min-width:0;flex:1 1 18rem}.md-capture-policy p{margin:0}.md-capture-policy .md-button{flex:none}
.md-binding-panel h4{margin:0;font-family:var(--mind-diary-font-display);font-size:1.2rem}
.md-binding-list{display:grid;gap:.75rem;margin:0;padding:0;list-style:none}
.md-binding-list li{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:.75rem;padding:.75rem;border:1px solid var(--mind-diary-border-subtle);border-radius:.75rem}
.md-binding-target{display:grid;gap:.2rem;min-width:0}.md-binding-target code,.md-binding-target span{overflow-wrap:anywhere}.md-binding-target--unavailable{color:#5b6473}
.md-binding-controls{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,17rem),1fr));gap:.9rem}.md-binding-controls form{display:grid;align-content:start;gap:.65rem;padding:.85rem;border:1px solid var(--mind-diary-border-subtle);border-radius:.75rem}.md-binding-controls label{display:grid;gap:.35rem;font-weight:750}.md-binding-controls select{width:100%;min-width:0;min-height:2.9rem;padding:.55rem;border:2px solid #7c8492;border-radius:var(--mind-diary-radius-control);background:#fff}.md-binding-controls .md-caveat{grid-column:1/-1}
@media(max-width:52rem){.md-header{grid-template-columns:1fr auto auto}.md-menu-button{grid-column:2}.md-profile{display:inline-flex;grid-column:3}.md-navigation{grid-column:1/-1}.md-setup-card{grid-template-columns:minmax(0,1fr)}}
@media(max-width:36rem){.md-header{grid-template-columns:1fr auto}.md-brand-lockup{grid-column:1}.md-menu-button{grid-column:2}.md-profile{display:inline-flex;grid-column:1/-1;justify-self:stretch;justify-content:center}.md-binding-list li{grid-template-columns:minmax(0,1fr)}.md-binding-list .md-button,.md-binding-controls .md-button,.md-capture-policy .md-button{width:100%}}
`;

function canonicalOrigin(value: string): string {
  const parsed = new URL(value);
  const loopbackHttp = parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
  if (
    (parsed.protocol !== "https:" && !loopbackHttp) ||
    parsed.origin !== value ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError("applicationOrigin must be one canonical HTTPS or loopback HTTP origin");
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
  if (code === "connection_not_found") return "The connection was not found.";
  if (code === "personal_token_not_found") return "The personal token was not found.";
  if (code === "forbidden") return "The request is forbidden.";
  if (code === "method_not_allowed") return "The method is not allowed.";
  return "The request could not be completed.";
}

function safeRequestId(resolution: ProductSitesIdentityResolution): string {
  return "actor" in resolution && typeof resolution.actor.requestId === "string"
    ? resolution.actor.requestId
    : "request_denied";
}

function safeBenchmarkCorrelationId(request: Request): string | null {
  const value = request.headers.get("x-mind-diary-performance-correlation-id");
  return value !== null && /^benchmark_[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(value)
    ? value
    : null;
}

function recordWebPerformance(
  recorder: ProductWebPerformanceRecorder | undefined,
  event: Parameters<ProductWebPerformanceRecorder["record"]>[0],
): void {
  if (recorder === undefined) return;
  try {
    const pending = recorder.record(Object.freeze(event));
    if (
      typeof pending === "object" &&
      pending !== null &&
      "catch" in pending &&
      typeof pending.catch === "function"
    ) {
      void pending.catch(() => undefined);
    }
  } catch {
    // Performance evidence is best-effort and never changes a web outcome.
  }
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

function html(document: string): Response {
  return new Response(document, {
    status: 200,
    headers: { ...SAFE_HEADERS, "content-type": "text/html; charset=utf-8" },
  });
}

function withCsrfMeta(document: string, csrfToken: string): string {
  return document.replace(
    "</head>",
    `  <meta name="mind-diary-csrf-token" content="${escapeHtml(csrfToken)}">\n</head>`,
  );
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

interface ProductUiSession {
  readonly displayName: string;
  readonly profileVersion: number;
  readonly personalMindName: string;
  readonly personalMindHeadRevisionId: string;
}

function pilotRoutePage(
  pathname: string,
  displayName: string,
): MindDiaryRoutePageModel | null {
  if (pathname === "/invitations") {
    return {
      displayName,
      activeNavigation: "invitations",
      eyebrow: "People and access",
      title: "Invitations",
      description: "Review incoming invitations and collaboration access from one signed-in page.",
      state: {
        kind: "ready",
        message: "The route is isolated from Mind content and waits for its issue-owned current invitation projection before showing any account-specific state.",
      },
      links: [{ href: "/minds", label: "Open your Minds" }],
    };
  }
  if (pathname === "/help") {
    return {
      displayName,
      activeNavigation: "help",
      eyebrow: "Pilot help",
      title: "Help and accessibility",
      description: "Mind Diary is hosted in UAT for a restricted authenticated pilot, not production. It has no production SLA or guaranteed recovery.",
      state: {
        kind: "ready",
        message: "Keep your own export before risky work; Mind and account deletion are immediate and irreversible. Never share an MCP token, Sites credential, authorization header, private content, raw query, email, or export/download URL with support. Report only the symptom, UTC time, and safe request ID. Keyboard users can skip to content and open the same navigation from every page.",
      },
      links: [
        { href: "/minds", label: "Open Minds" },
        { href: "/settings/developer/mcp", label: "Open Advanced MCP" },
      ],
      guides: [
        {
          id: "mind-diary-help-starter-playbook",
          title: "Create and prove one starter Mind",
          description: "Copy this into Codex after MCP setup. You choose Personal or ordinary Mind without constructing wire schemas.",
          prompt: MIND_DIARY_CODEX_STARTER_PLAYBOOK,
          copyLabel: "Copy starter playbook",
        },
        {
          id: "mind-diary-help-concierge-playbook",
          title: "Convert a bounded Markdown set",
          description: "This assisted path composes existing tools and remains distinct from productized import.",
          prompt: MIND_DIARY_CODEX_CONCIERGE_PLAYBOOK,
          copyLabel: "Copy concierge playbook",
        },
      ],
    };
  }
  return null;
}

function uiSession(value: unknown): ProductUiSession | null {
  const source = record(value);
  const principal = record(source?.principal);
  const personalMind = record(source?.personalMind);
  const displayName = requiredString(principal?.displayName);
  const profileVersion = positiveInteger(principal?.profileVersion);
  const personalMindName = requiredString(personalMind?.name);
  const personalMindHeadRevisionId = requiredString(personalMind?.headRevisionId);
  return displayName === null || profileVersion === null || personalMindName === null ||
      personalMindHeadRevisionId === null
    ? null
    : Object.freeze({
        displayName,
        profileVersion,
        personalMindName,
        personalMindHeadRevisionId,
      });
}

function roleLabel(value: unknown): UiMindCard["role"] {
  if (value === "editor") return "Editor";
  if (value === "admin") return "Admin";
  if (value === "owner") return "Owner";
  return "Reader";
}

function uiMind(value: unknown): UiMindCard | null {
  const source = record(value);
  const access = record(source?.access);
  const route = requiredString(source?.route);
  const name = requiredString(source?.name);
  const visibility = source?.visibility;
  if (
    route === null || name === null ||
    !/^\/(?:me|[a-z0-9]+(?:-[a-z0-9]+)*)$/u.test(route) ||
    !(visibility === "private" || visibility === "unlisted" || visibility === "public")
  ) return null;
  const isPersonal = source?.isPersonal === true;
  return Object.freeze({
    id: requiredString(source?.mindId) ?? route,
    name,
    route,
    description: isPersonal
      ? "Your private place for personal Memories."
      : "A versioned Mind available through your current access.",
    visibility,
    role: roleLabel(access?.role),
    updatedLabel: "Current HEAD is ready",
    ...(isPersonal ? { isPersonal: true } : {}),
  });
}

function ordinaryUiMind(value: unknown): OrdinaryMindUiMind | null {
  const source = record(value);
  const access = record(source?.access);
  const mindId = requiredString(source?.mindId);
  const handle = requiredString(source?.handle);
  const name = requiredString(source?.name);
  const route = requiredString(source?.route);
  const metadataVersion = positiveInteger(source?.metadataVersion);
  const headRevisionId = requiredString(source?.headRevisionId);
  const visibility = source?.visibility;
  const role = access?.role;
  if (
    source?.isPersonal === true ||
    mindId === null ||
    handle === null ||
    name === null ||
    headRevisionId === null ||
    route !== `/${handle}` ||
    handle.length < 3 ||
    handle.length > 63 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(handle) ||
    metadataVersion === null ||
    !(visibility === "private" || visibility === "unlisted" || visibility === "public") ||
    !(role === null || role === "reader" || role === "editor" || role === "admin" || role === "owner")
  ) return null;
  return Object.freeze({
    mindId,
    handle,
    name,
    headRevisionId,
    visibility,
    role: role ?? "reader",
    metadataVersion,
    updatedLabel: "Current HEAD is ready",
    accessKind: access?.kind === "visibility" ? "visibility" : "membership",
    discovery: source?.discovery === "exact_handle" || source?.discovery === "public_catalog"
      ? source.discovery
      : "membership",
  });
}

function ordinaryMindCapacity(value: unknown): OrdinaryMindCapacity | null {
  const source = record(value);
  const usage = record(source?.usage);
  const principalUsage = record(source?.principalUsage);
  if (source?.kind !== "found" || usage === null || principalUsage === null) return null;
  const fields = [
    "logicalHeadBytes",
    "logicalRetainedBytes",
    "physicalCanonicalBytes",
    "temporaryBytes",
    "d1MetadataBytes",
    "reservedBytes",
  ] as const;
  if (fields.some((field) =>
    !Number.isSafeInteger(usage[field]) || (usage[field] as number) < 0)) return null;
  if (typeof usage.storageAmplification !== "number" || usage.storageAmplification < 0) {
    return null;
  }
  const utilization = source.utilization;
  if (
    utilization !== "normal" && utilization !== "warning" &&
    utilization !== "soft_limit" && utilization !== "hard_limit"
  ) return null;
  if (
    !Number.isSafeInteger(principalUsage.physicalCanonicalBytes) ||
    (principalUsage.physicalCanonicalBytes as number) < 0 ||
    !Number.isSafeInteger(source.mindCanonicalHeadroomBytes) ||
    (source.mindCanonicalHeadroomBytes as number) < 0 ||
    !Number.isSafeInteger(source.principalCanonicalHeadroomBytes) ||
    (source.principalCanonicalHeadroomBytes as number) < 0
  ) return null;
  return Object.freeze({
    kind: "ready" as const,
    usage: Object.freeze({
      logicalHeadBytes: usage.logicalHeadBytes as number,
      logicalRetainedBytes: usage.logicalRetainedBytes as number,
      physicalCanonicalBytes: usage.physicalCanonicalBytes as number,
      temporaryBytes: usage.temporaryBytes as number,
      d1MetadataBytes: usage.d1MetadataBytes as number,
      reservedBytes: usage.reservedBytes as number,
      principalPhysicalCanonicalBytes:
        principalUsage.physicalCanonicalBytes as number,
      mindCanonicalHeadroomBytes: source.mindCanonicalHeadroomBytes as number,
      principalCanonicalHeadroomBytes:
        source.principalCanonicalHeadroomBytes as number,
      storageAmplification: usage.storageAmplification,
      utilization,
    }),
  });
}

function ordinaryUiMember(value: unknown): OrdinaryMindUiMember | null {
  const source = record(value);
  const memberId = requiredString(source?.memberId);
  const displayName = requiredString(source?.displayName);
  const membershipVersion = positiveInteger(source?.membershipVersion);
  const role = source?.role;
  if (
    memberId === null || displayName === null || membershipVersion === null ||
    !(role === "reader" || role === "editor" || role === "admin" || role === "owner") ||
    typeof source?.isSelf !== "boolean"
  ) return null;
  return Object.freeze({ memberId, displayName, membershipVersion, role, isSelf: source.isSelf });
}

function invitationUi(
  value: unknown,
  minds: ReadonlyMap<string, OrdinaryMindUiMind>,
): InvitationMembershipGlobalInvitation | null {
  const source = record(value);
  const invitationId = requiredString(source?.invitationId);
  const mindId = requiredString(source?.mindId);
  const mindName = requiredString(source?.mindName);
  const counterpartyDisplayName = requiredString(source?.counterpartyDisplayName);
  const expiresAt = requiredString(source?.expiresAt);
  const invitationVersion = positiveInteger(source?.invitationVersion);
  const direction = source?.direction;
  const proposedRole = source?.proposedRole;
  const state = source?.state;
  if (
    invitationId === null || mindId === null || mindName === null ||
    counterpartyDisplayName === null || expiresAt === null || invitationVersion === null ||
    !(direction === "incoming" || direction === "outgoing") ||
    !(proposedRole === "reader" || proposedRole === "editor" || proposedRole === "admin") ||
    !(state === "pending" || state === "expired" || state === "accepted" ||
      state === "rejected" || state === "cancelled")
  ) return null;
  const mind = minds.get(mindId);
  const canManage = direction === "incoming" || (
    mind?.accessKind !== "visibility" &&
    (mind?.role === "owner" || mind?.role === "admin")
  );
  return Object.freeze({
    invitationId,
    mindId,
    mindName,
    mindRoute: mind === undefined ? "#" : `/${mind.handle}`,
    direction,
    counterpartyDisplayName,
    proposedRole,
    state,
    expiresAt,
    invitationVersion,
    canManage,
  });
}

function perMindInvitation(
  invitation: InvitationMembershipGlobalInvitation,
): InvitationMembershipInvitation {
  return Object.freeze({
    invitationId: invitation.invitationId,
    direction: invitation.direction,
    counterpartyDisplayName: invitation.counterpartyDisplayName,
    proposedRole: invitation.proposedRole,
    state: invitation.state,
    expiresAt: invitation.expiresAt,
    invitationVersion: invitation.invitationVersion,
    ...(invitation.canManage === undefined ? {} : { canManage: invitation.canManage }),
  });
}

function publicUiMind(value: unknown): PublicMindCatalogItem | null {
  const source = record(value);
  const mindId = requiredString(source?.mindId);
  const route = requiredString(source?.route);
  const name = requiredString(source?.name);
  if (
    mindId === null || route === null || name === null ||
    !/^\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(route) ||
    source?.isPersonal !== false || source?.visibility !== "public" ||
    source?.discovery !== "public_catalog"
  ) return null;
  return Object.freeze({
    mindId,
    route,
    name,
    summary: "A versioned Mind shared by its Owner.",
    visibility: "public",
    isPersonal: false,
    discovery: "public_catalog",
  });
}

function uiToken(value: unknown): McpTokenUiToken | null {
  const source = record(value);
  const tokenId = requiredString(source?.tokenId);
  const name = requiredString(source?.name);
  const displayPrefix = requiredString(source?.displayPrefix);
  const createdAt = requiredString(source?.createdAt);
  const expiresAt = requiredString(source?.expiresAt);
  const state = source?.state;
  const rawScopes = source?.scopes;
  if (
    tokenId === null || name === null || displayPrefix === null ||
    createdAt === null || expiresAt === null ||
    !(state === "active" || state === "expired" || state === "revoked") ||
    !Array.isArray(rawScopes)
  ) return null;
  const scopes = rawScopes.filter(
    (scope): scope is "content:read" | "content:write" =>
      scope === "content:read" || scope === "content:write",
  );
  if (scopes.length === 0) return null;
  return Object.freeze({
    tokenId,
    name,
    displayPrefix,
    scopes: Object.freeze(scopes),
    state,
    createdAt,
    expiresAt,
    lastUsedAt: requiredString(source?.lastUsedAt),
    revokedAt: requiredString(source?.revokedAt),
  });
}

interface ProductBindingUiCandidate {
  readonly mindId: string;
  readonly mind: MindBindingUiMind;
}

function bindingUiCandidate(value: unknown): ProductBindingUiCandidate | null {
  const source = record(value);
  const access = record(source?.access);
  const mindId = requiredString(source?.mindId);
  const route = requiredString(source?.route);
  const name = requiredString(source?.name);
  const visibility = source?.visibility;
  const role = access?.role;
  if (
    mindId === null || route === null || name === null ||
    !/^\/(?:me|[a-z0-9]+(?:-[a-z0-9]+)*)$/u.test(route) ||
    !(visibility === "private" || visibility === "unlisted" || visibility === "public")
  ) return null;
  return Object.freeze({
    mindId,
    mind: Object.freeze({
      name,
      route,
      visibility,
      canWrite: role === "editor" || role === "admin" || role === "owner",
    }),
  });
}

function bindingOwnerUi(
  value: unknown,
  candidates: ReadonlyMap<string, MindBindingUiMind>,
): MindBindingOwnerUiState | null {
  const source = record(value);
  const ownerId = requiredString(source?.ownerId);
  const bindingVersion = nonnegativeInteger(source?.bindingVersion);
  if (
    ownerId === null || bindingVersion === null ||
    !(source?.state === "active" || source?.state === "revoked" || source?.state === "deleted") ||
    !Array.isArray(source.readBindings)
  ) return null;
  const readBindings = source.readBindings.map((value) => {
    const binding = record(value);
    const readBindingId = requiredString(binding?.readBindingId);
    const mindId = requiredString(binding?.mindId);
    return readBindingId === null || mindId === null
      ? null
      : Object.freeze({
          readBindingId,
          mind: candidates.get(mindId) ?? null,
        });
  });
  if (readBindings.some((binding) => binding === null)) return null;
  const writeSource = source.writeBinding === null ? null : record(source.writeBinding);
  const writeBindingId = writeSource === null ? null : requiredString(writeSource.writeBindingId);
  const writeMindId = writeSource === null ? null : requiredString(writeSource.mindId);
  if (writeSource !== null && (writeBindingId === null || writeMindId === null)) return null;
  const captureSource = record(source.automaticCapture);
  if (
    captureSource === null ||
    !("mode" in captureSource) ||
    !("writeBindingId" in captureSource) ||
    !("updatedAt" in captureSource)
  ) return null;
  const captureMode = captureSource.mode;
  const captureWriteBindingId = captureSource.writeBindingId === null
    ? null
    : requiredString(captureSource.writeBindingId);
  const captureUpdatedAt = captureSource.updatedAt === null
    ? null
    : requiredString(captureSource.updatedAt);
  if (
    !(captureMode === "disabled" || captureMode === "routine_non_sensitive") ||
    (captureSource.writeBindingId !== null && captureWriteBindingId === null) ||
    (captureSource.updatedAt !== null && captureUpdatedAt === null) ||
    (captureMode === "disabled" && captureWriteBindingId !== null) ||
    (captureMode === "routine_non_sensitive" && captureWriteBindingId === null)
  ) return null;
  return Object.freeze({
    kind: "ready" as const,
    ownerId,
    bindingVersion,
    state: source.state === "active" ? "active" : "revoked",
    readBindings: Object.freeze(readBindings as Exclude<(typeof readBindings)[number], null>[]),
    writeBinding: writeSource === null
      ? null
      : Object.freeze({
          writeBindingId: writeBindingId!,
          mind: candidates.get(writeMindId!) ?? null,
        }),
    automaticCapture: Object.freeze({
      mode: captureMode,
      writeBindingId: captureWriteBindingId,
      updatedAt: captureUpdatedAt,
    }),
    eligibleMinds: Object.freeze([...candidates.values()]),
  });
}

function safeCredentialAccess(
  owner: ProductWebMindBindingOwner | undefined,
  candidates: ReadonlyMap<string, MindBindingUiMind>,
  canWrite: boolean,
): SafeCredentialAccess | null {
  if (
    owner === undefined ||
    owner.state !== "active" ||
    !Number.isSafeInteger(owner.bindingVersion) ||
    owner.bindingVersion < 0
  ) return null;
  const readableMinds = owner.readBindings.map((binding) => {
    const mind = candidates.get(binding.mindId);
    if (mind !== undefined) {
      return Object.freeze({ kind: "available" as const, mind });
    }
    if (!/^stale_v1_[0-9a-f]{32}$/u.test(binding.staleAccessRef)) return null;
    return Object.freeze({
      kind: "unavailable" as const,
      staleAccessRef: binding.staleAccessRef,
    });
  });
  if (readableMinds.some((target) => target === null)) return null;
  const writeCandidate = owner.writeBinding === null
    ? null
    : candidates.get(owner.writeBinding.mindId) ?? null;
  return Object.freeze({
    bindingVersion: owner.bindingVersion,
    readableMinds: Object.freeze(readableMinds as Exclude<(typeof readableMinds)[number], null>[]),
    ...(canWrite ? { writableMind: writeCandidate } : {}),
    eligibleMinds: Object.freeze([...candidates.values()]) as readonly SafeConnectionMind[],
  });
}

function safeConnectionListItem(
  connection: Awaited<ReturnType<ProductWebOAuthConnections["listPage"]>>["items"][number],
  access: SafeCredentialAccess,
): ConnectionListItem {
  const canWrite = connection.scopes.includes("content:write");
  return Object.freeze({
    connectionRef: connection.connectionRef,
    clientName: connection.clientName,
    createdAt: connection.createdAt,
    lastUsedAt: connection.lastUsedAt,
    canRead: connection.scopes.includes("content:read"),
    canWrite,
    readableMindCount: access.readableMinds.length,
    writableMindSelected:
      canWrite && access.writableMind !== null && access.writableMind !== undefined,
  });
}

function safeConnectionDetail(
  connection: Awaited<ReturnType<ProductWebOAuthConnections["read"]>>,
  access: SafeCredentialAccess,
): ConnectionDetail | null {
  if (connection === null) return null;
  return Object.freeze({
    ...safeConnectionListItem(connection, access),
    access,
  });
}

function strictListQuery(
  url: URL,
  includeState: boolean,
): Readonly<{
  readonly state?: "active" | "revoked" | "expired";
  readonly limit?: number;
  readonly cursor?: string;
}> | null {
  const allowed = new Set(includeState ? ["state", "limit", "cursor"] : ["limit", "cursor"]);
  let keysAreValid = true;
  url.searchParams.forEach((_value, key) => {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) keysAreValid = false;
  });
  if (!keysAreValid) return null;
  const limitValue = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  const state = url.searchParams.get("state");
  if (
    (limitValue !== null && !/^(?:[1-9]|[1-4][0-9]|50)$/u.test(limitValue)) ||
    (cursor !== null && !/^[A-Za-z0-9_-]{1,2048}$/u.test(cursor)) ||
    (state !== null && state !== "active" && state !== "revoked" && state !== "expired")
  ) return null;
  return Object.freeze({
    ...(state === null ? {} : { state }),
    ...(limitValue === null ? {} : { limit: Number(limitValue) }),
    ...(cursor === null ? {} : { cursor }),
  });
}

async function safeBindingCandidates(
  control: ProductWebControlApplication,
  actor: RegisteredSitesActor,
): Promise<ReadonlyMap<string, MindBindingUiMind>> {
  const listed = await control.execute({
    operation: "list_minds",
    actor,
    input: Object.freeze({}),
  });
  if (!Array.isArray(listed)) throw new TypeError("safe Mind list projection is unavailable");
  const candidates = new Map<string, MindBindingUiMind>();
  for (const value of listed) {
    const candidate = bindingUiCandidate(value);
    if (candidate !== null) candidates.set(candidate.mindId, candidate.mind);
  }
  return candidates;
}

async function safeBindingAccessByOwner(
  control: ProductWebControlApplication,
  mindBindings: ProductWebMindBindings,
  actor: RegisteredSitesActor,
  credentials: readonly Readonly<{
    readonly ownerId: string;
    readonly scopes: readonly ("content:read" | "content:write")[];
    readonly state: "active" | "revoked";
  }>[],
): Promise<ReadonlyMap<string, SafeCredentialAccess>> {
  if (credentials.length === 0) return new Map();
  const [candidates, owners] = await Promise.all([
    safeBindingCandidates(control, actor),
    mindBindings.listResolved(actor, credentials),
  ]);
  const byOwner = new Map(owners.map((owner) => [owner.ownerId, owner] as const));
  const projections = new Map<string, SafeCredentialAccess>();
  for (const credential of credentials) {
    const access = safeCredentialAccess(
      byOwner.get(credential.ownerId),
      candidates,
      credential.scopes.includes("content:write"),
    );
    if (access === null) throw new TypeError("safe Mind access projection is unavailable");
    projections.set(credential.ownerId, access);
  }
  return projections;
}

async function mutateCredentialAccess(input: {
  readonly actor: RegisteredSitesActor;
  readonly mindBindings: ProductWebMindBindings;
  readonly control: ProductWebControlApplication;
  readonly ownerId: string;
  readonly scopes: readonly ("content:read" | "content:write")[];
  readonly request: Readonly<Record<string, unknown>>;
  readonly presentationKey: "connection_ref" | "personal_token_ref";
}): Promise<Readonly<{ readonly changed: boolean; readonly replayed: boolean }>> {
  const action = input.request.action;
  const expectedBindingVersion = nonnegativeInteger(input.request.expectedBindingVersion);
  const idempotencyKey = requiredString(input.request.idempotencyKey);
  if (
    expectedBindingVersion === null ||
    idempotencyKey === null ||
    !["attach_read", "detach_read", "select_write", "clear_write"].includes(String(action))
  ) {
    throw Object.assign(new Error("Invalid access mutation."), { code: "invalid_request" });
  }
  const actionKeys = action === "attach_read" || action === "select_write"
    ? ["mindRef"]
    : action === "detach_read"
      ? ["mindRef", "staleAccessRef"]
      : [];
  const allowed = new Set([
    "action",
    "expectedBindingVersion",
    "idempotencyKey",
    input.presentationKey,
    ...actionKeys,
  ]);
  if (Object.keys(input.request).some((key) => !allowed.has(key))) {
    throw Object.assign(new Error("Invalid access mutation."), { code: "invalid_request" });
  }
  const mindRef = input.request.mindRef;
  const staleAccessRef = input.request.staleAccessRef;
  if (
    ((action === "attach_read" || action === "select_write") &&
      (typeof mindRef !== "string" || !/^\/(?:me|[a-z0-9]+(?:-[a-z0-9]+)*)$/u.test(mindRef))) ||
    (action === "detach_read" &&
      !(
        (typeof mindRef === "string" && /^\/(?:me|[a-z0-9]+(?:-[a-z0-9]+)*)$/u.test(mindRef) && staleAccessRef === undefined) ||
        (typeof staleAccessRef === "string" && /^stale_v1_[0-9a-f]{32}$/u.test(staleAccessRef) && mindRef === undefined)
      )) ||
    (action === "clear_write" && (mindRef !== undefined || staleAccessRef !== undefined))
  ) {
    throw Object.assign(new Error("Invalid access mutation."), { code: "invalid_request" });
  }
  if (
    (action === "select_write" || action === "clear_write") &&
    !input.scopes.includes("content:write")
  ) {
    throw Object.assign(new Error("Write permission is required."), {
      code: "write_step_up_required",
    });
  }
  const [owners, candidates] = await Promise.all([
    input.mindBindings.listResolved(input.actor, [Object.freeze({
      ownerId: input.ownerId,
      scopes: input.scopes,
      state: "active" as const,
    })]),
    safeBindingCandidates(input.control, input.actor),
  ]);
  const owner = owners.find((candidate) => candidate.ownerId === input.ownerId);
  if (owner === undefined || owner.state !== "active") {
    throw Object.assign(new Error("Credential was not found."), { code: "not_found" });
  }
  let readBindingId: string | undefined;
  if (action === "detach_read") {
    const matches = owner.readBindings.filter((binding) =>
      typeof staleAccessRef === "string"
        ? binding.staleAccessRef === staleAccessRef
        : candidates.get(binding.mindId)?.route === mindRef);
    if (matches.length !== 1) {
      throw Object.assign(new Error("Readable Mind was not found."), { code: "not_found" });
    }
    readBindingId = matches[0]!.readBindingId;
  }
  const result = await input.mindBindings.mutateResolved(input.actor, Object.freeze({
    ownerId: input.ownerId,
    scopes: input.scopes,
    state: "active" as const,
  }), Object.freeze({
    action: action === "select_write"
      ? "bind_write"
      : action === "clear_write"
        ? "unbind_write"
        : action,
    binding_owner_id: input.ownerId,
    expectedBindingVersion,
    idempotencyKey,
    ...(typeof mindRef === "string" ? { mindRef } : {}),
    ...(readBindingId === undefined ? {} : { readBindingId }),
  }));
  return Object.freeze({ changed: result.changed, replayed: result.replayed });
}

function staticAsset(pathname: string): { readonly body: BodyInit; readonly type: string } | null {
  if (pathname === "/favicon.ico") return { body: PRODUCT_UI_FAVICON_ICO, type: "image/x-icon" };
  if (pathname === "/favicon.svg") return { body: PRODUCT_UI_FAVICON_SVG, type: "image/svg+xml; charset=utf-8" };
  if (pathname === "/favicon-32x32.png") return { body: PRODUCT_UI_FAVICON_PNG, type: "image/png" };
  if (pathname === "/apple-touch-icon.png") return { body: PRODUCT_UI_APPLE_TOUCH_ICON_PNG, type: "image/png" };
  if (pathname === "/brand/mind-diary-tokens.css") return { body: PRODUCT_UI_TOKENS_CSS, type: "text/css; charset=utf-8" };
  if (pathname === "/ui/mind-diary-shell.css") return { body: `${PRODUCT_UI_SHELL_CSS}\n${PRODUCT_CONNECTIONS_LAYOUT_CSS}\n${PRODUCT_UI_PILOT_SHELL_CSS}`, type: "text/css; charset=utf-8" };
  if (pathname === "/brand/mind-diary-lockup.svg") return { body: PRODUCT_UI_LOCKUP_SVG, type: "image/svg+xml; charset=utf-8" };
  if (pathname === "/brand/mind-diary-mark.svg") return { body: PRODUCT_UI_MARK_SVG, type: "image/svg+xml; charset=utf-8" };
  if (pathname === "/ui/mind-diary-onboarding-client.js") {
    return {
      body: `${PRODUCT_UI_CLIENT_JAVASCRIPT}\n${PRODUCT_MARKDOWN_IMPORT_CLIENT_JAVASCRIPT}`,
      type: "text/javascript; charset=utf-8",
    };
  }
  if (
    pathname === "/ui/mind-diary-shell-client.js" ||
    pathname === "/ui/mind-diary-token-client.js" ||
    pathname === "/ui/mind-diary-account-client.js"
  ) return { body: PRODUCT_UI_CLIENT_JAVASCRIPT, type: "text/javascript; charset=utf-8" };
  if (pathname === "/ui/mind-diary-ordinary-minds-client.js") {
    return {
      body: `${PRODUCT_ORDINARY_MINDS_CLIENT_JAVASCRIPT}\n${PRODUCT_MARKDOWN_IMPORT_CLIENT_JAVASCRIPT}\n${PRODUCT_COLLABORATION_CLIENT_JAVASCRIPT}`,
      type: "text/javascript; charset=utf-8",
    };
  }
  if (pathname === "/ui/mind-diary-collaboration-client.js") {
    return {
      body: PRODUCT_COLLABORATION_CLIENT_JAVASCRIPT,
      type: "text/javascript; charset=utf-8",
    };
  }
  if (pathname === "/ui/mind-diary-visibility-client.js") {
    return {
      body: PRODUCT_VISIBILITY_CATALOG_CLIENT_JAVASCRIPT,
      type: "text/javascript; charset=utf-8",
    };
  }
  if (pathname === "/ui/mind-diary-connections-client.js") {
    return {
      body: `${PRODUCT_UI_CLIENT_JAVASCRIPT}\n${PRODUCT_CONNECTIONS_CLIENT_JAVASCRIPT}`,
      type: "text/javascript; charset=utf-8",
    };
  }
  return null;
}

/** Serves compile-time product assets without requiring product runtime composition. */
export function createProductUiStaticAssetResponse(request: Request): Response | null {
  const asset = staticAsset(new URL(request.url).pathname);
  if (asset === null) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(405, "method_not_allowed", "asset_request");
  }
  return new Response(request.method === "HEAD" ? null : asset.body, {
    status: 200,
    headers: {
      ...SAFE_HEADERS,
      "cache-control": STATIC_ASSET_CACHE_CONTROL,
      "content-type": asset.type,
    },
  });
}

async function productUiDocument(input: {
  readonly pathname: string;
  readonly siteOrigin: string;
  readonly identity: Exclude<ProductSitesIdentityResolution, { readonly kind: "denied" | "unavailable" }>;
  readonly csrfToken: string;
  readonly control: ProductWebControlApplication;
  readonly oauthConnections?: ProductWebOAuthConnections;
  readonly personalTokens?: ProductWebPersonalTokens;
  readonly mindBindings?: ProductWebMindBindings;
  readonly query: Readonly<Record<string, string>>;
  readonly listQuery?: Readonly<{
    readonly state?: "active" | "revoked" | "expired";
    readonly limit?: number;
    readonly cursor?: string;
  }>;
}): Promise<string> {
  if (input.identity.kind === "registration_required") {
    const model: AuthenticatedOnboardingModel = {
      kind: "registration_required",
      ...(input.identity.actor.suggestedDisplayName === undefined
        ? {}
        : { suggestedDisplayName: input.identity.actor.suggestedDisplayName }),
      bootstrapIdempotencyKey: `bootstrap:${crypto.randomUUID()}`,
      manualRecoveryStatus: "available",
    };
    return withCsrfMeta(renderAuthenticatedOnboardingDocument(model), input.csrfToken);
  }
  const authenticatedIdentity = input.identity;
  const readSession = async (): Promise<ProductUiSession> => {
    const captured = uiSession(authenticatedIdentity.session);
    if (captured !== null) return captured;
    const current = uiSession(await input.control.execute({
      operation: "get_session",
      actor: authenticatedIdentity.actor,
      input: Object.freeze({}),
    }));
    if (current === null) throw new TypeError("safe session projection is unavailable");
    return current;
  };
  if (input.pathname === "/" || input.pathname === "/minds") {
    try {
      const listed = await input.control.execute({
        operation: "list_minds",
        actor: input.identity.actor,
        input: Object.freeze({}),
      });
      if (!Array.isArray(listed)) throw new TypeError("safe Mind list projection is unavailable");
      const cards = listed
        .map(uiMind)
        .filter((mind): mind is UiMindCard => mind !== null);
      const displayName = cards.find((mind) => mind.isPersonal === true)?.name;
      if (displayName === undefined) {
        throw new TypeError("Personal Mind is absent from the safe Mind list projection");
      }
      if (input.pathname === "/minds") {
        const minds = listed
          .map(ordinaryUiMind)
          .filter((mind): mind is OrdinaryMindUiMind => mind !== null);
        return withCsrfMeta(renderOrdinaryMindsManagementDocument({
          displayName,
          view: {
            kind: "list",
            collection: minds.length === 0
              ? { kind: "empty" }
              : { kind: "ready", minds: Object.freeze(minds) },
          },
        }, "/ui/mind-diary-ordinary-minds-client.js"), input.csrfToken);
      }
      return withCsrfMeta(renderMindDiaryUiShellDocument({
        displayName,
        activeNavigation: "home",
        collection: cards.length === 0
          ? { kind: "empty" }
          : { kind: "ready", minds: Object.freeze(cards) },
      }), input.csrfToken);
    } catch {
      const session = await readSession();
      if (input.pathname === "/minds") {
        return withCsrfMeta(renderOrdinaryMindsManagementDocument({
          displayName: session.displayName,
          view: {
            kind: "list",
            collection: { kind: "error", message: "Mind metadata is unavailable. Try again." },
          },
        }, "/ui/mind-diary-ordinary-minds-client.js"), input.csrfToken);
      }
      return withCsrfMeta(renderMindDiaryUiShellDocument({
        displayName: session.displayName,
        activeNavigation: "home",
        collection: { kind: "error", message: "Mind summaries are unavailable. Try again." },
      }), input.csrfToken);
    }
  }
  const session = await readSession();

  if (input.pathname === "/help/codex") {
    return withCsrfMeta(renderCodexHelpPageDocument(session.displayName), input.csrfToken);
  }

  if (input.pathname === "/settings/connections") {
    if (input.oauthConnections === undefined || input.mindBindings === undefined) {
      throw new TypeError("Connections projection is unavailable");
    }
    try {
      const page = await input.oauthConnections.listPage(
        input.identity.actor.principalId,
        input.listQuery ?? {},
      );
      if (page.items.length === 0) {
        return withCsrfMeta(renderConnectionsPageDocument({
          displayName: session.displayName,
          collection: { kind: "empty" },
        }), input.csrfToken);
      }
      const access = await safeBindingAccessByOwner(
        input.control,
        input.mindBindings,
        input.identity.actor,
        page.items.map((connection) => Object.freeze({
          ownerId: connection.bindingOwnerId,
          scopes: connection.scopes,
          state: "active" as const,
        })),
      );
      const items = page.items.map((connection) =>
        safeConnectionListItem(connection, access.get(connection.bindingOwnerId)!));
      return withCsrfMeta(renderConnectionsPageDocument({
        displayName: session.displayName,
        collection: {
          kind: "ready",
          items: Object.freeze(items),
          nextCursor: page.nextCursor,
        },
      }), input.csrfToken);
    } catch {
      return withCsrfMeta(renderConnectionsPageDocument({
        displayName: session.displayName,
        collection: { kind: "error", message: "Reload to check current connection access." },
      }), input.csrfToken);
    }
  }

  const connectionDetailMatch = /^\/settings\/connections\/([^/]+)$/u.exec(input.pathname);
  if (connectionDetailMatch !== null) {
    if (input.oauthConnections === undefined || input.mindBindings === undefined) {
      throw Object.assign(new Error("Connection was not found."), { code: "connection_not_found" });
    }
    const connectionRef = connectionDetailMatch[1]!;
    const connection = await input.oauthConnections.read(
      input.identity.actor.principalId,
      connectionRef,
    );
    if (connection === null) {
      throw Object.assign(new Error("Connection was not found."), { code: "connection_not_found" });
    }
    const accessByOwner = await safeBindingAccessByOwner(
      input.control,
      input.mindBindings,
      input.identity.actor,
      [Object.freeze({
        ownerId: connection.bindingOwnerId,
        scopes: connection.scopes,
        state: "active" as const,
      })],
    );
    const access = accessByOwner.get(connection.bindingOwnerId);
    if (access === undefined) throw new TypeError("safe connection access is unavailable");
    const detail = safeConnectionDetail(connection, access);
    if (detail === null) {
      throw Object.assign(new Error("Connection was not found."), { code: "connection_not_found" });
    }
    return withCsrfMeta(renderConnectionDetailDocument({
      displayName: session.displayName,
      connection: detail,
    }), input.csrfToken);
  }

  if (input.pathname === "/settings/developer/mcp") {
    if (input.personalTokens === undefined || input.mindBindings === undefined) {
      throw new TypeError("Personal token projection is unavailable");
    }
    const state = input.listQuery?.state ?? "active";
    let collection: AdvancedMcpPageModel["collection"];
    try {
      const page = await input.personalTokens.listPage(input.identity.actor, {
        ...input.listQuery,
        state,
      });
      if (page.items.length === 0) {
        collection = { kind: "empty" };
      } else {
        let access = new Map<string, SafeCredentialAccess>();
        if (state === "active") {
          access = new Map(await safeBindingAccessByOwner(
            input.control,
            input.mindBindings,
            input.identity.actor,
            page.items.map((token) => Object.freeze({
              ownerId: token.bindingOwnerId,
              scopes: token.scopes,
              state: "active" as const,
            })),
          ));
        }
        collection = {
          kind: "ready",
          items: Object.freeze(page.items.map(({ bindingOwnerId, ...token }) => {
            const tokenAccess = access.get(bindingOwnerId);
            return Object.freeze({
              ...token,
              ...(state === "active" && tokenAccess !== undefined ? { access: tokenAccess } : {}),
            });
          })),
          nextCursor: page.nextCursor,
        };
      }
    } catch {
      collection = { kind: "error", message: "Reload before using a personal token." };
    }
    return withCsrfMeta(renderAdvancedMcpPageDocument({
      displayName: session.displayName,
      siteOrigin: input.siteOrigin,
      state,
      collection,
    }), input.csrfToken);
  }

  if (input.pathname === "/internal/operators/users") {
    const page = await input.control.execute({
      operation: "list_service_operator_principals",
      actor: input.identity.actor,
      input: input.query,
    });
    return withCsrfMeta(renderServiceOperatorDirectoryDocument({
      displayName: session.displayName,
      page,
      query: input.query,
    }), input.csrfToken);
  }

  if (input.pathname === "/public") {
    let collection: PublicMindCatalogCollection;
    try {
      const result = record(await input.control.execute({
        operation: "list_public_minds",
        actor: input.identity.actor,
        input: Object.freeze({}),
      }));
      const minds = Array.isArray(result?.minds)
        ? result.minds.map(publicUiMind).filter((mind): mind is PublicMindCatalogItem => mind !== null)
        : [];
      collection = minds.length === 0
        ? { kind: "empty" }
        : { kind: "ready", minds: Object.freeze(minds) };
    } catch {
      collection = { kind: "error", message: "Public Minds are unavailable. No private metadata was returned." };
    }
    return withCsrfMeta(renderVisibilityCatalogDocument({
      kind: "catalog",
      displayName: session.displayName,
      authenticated: true,
      collection,
    }, "/ui/mind-diary-visibility-client.js"), input.csrfToken);
  }

  if (input.pathname === "/invitations") {
    let collection: InvitationMembershipPageModel["collection"];
    try {
      const overview = record(await input.control.execute({
        operation: "get_invitations_overview",
        actor: input.identity.actor,
        input: Object.freeze({}),
      }));
      if (overview === null) throw new TypeError("safe invitation overview is unavailable");
      const listedInvitations = overview.invitations;
      const listedMinds = overview.minds;
      const minds = Array.isArray(listedMinds)
        ? listedMinds.map(ordinaryUiMind).filter((mind): mind is OrdinaryMindUiMind => mind !== null)
        : [];
      const mindMap = new Map(minds.map((mind) => [mind.mindId, mind] as const));
      const invitationRecord = record(listedInvitations);
      const invitations = Array.isArray(invitationRecord?.invitations)
        ? invitationRecord.invitations
          .map((invitation) => invitationUi(invitation, mindMap))
          .filter((invitation): invitation is InvitationMembershipGlobalInvitation => invitation !== null)
        : [];
      collection = { kind: "global_ready", invitations: Object.freeze(invitations) };
    } catch {
      collection = {
        kind: "error",
        message: "Invitation metadata is unavailable. No Mind content was requested.",
      };
    }
    return withCsrfMeta(renderInvitationsMembershipDocument({
      displayName: session.displayName,
      collection,
    }, "/ui/mind-diary-collaboration-client.js"), input.csrfToken);
  }

  if (input.pathname === "/settings/account") {
    let state: AccountDeletionViewState;
    try {
      const impact = normalizeAccountDeletionImpact(await input.control.execute({
        operation: "get_account_deletion_impact",
        actor: input.identity.actor,
        input: Object.freeze({}),
      }));
      state = impact === null
        ? { kind: "load_error", reason: "invalid" }
        : Date.parse(impact.expiresAt) <= Date.now()
          ? { kind: "stale", reason: "expired" }
          : {
              kind: "preview",
              impact,
              idempotencyKey: `account-delete:${crypto.randomUUID()}`,
            };
    } catch {
      state = { kind: "load_error", reason: "unavailable" };
    }
    return withCsrfMeta(renderAccountDeletionDocument({
      displayName: session.displayName,
      profile: {
        profileVersion: session.profileVersion,
        personalMindName: session.personalMindName,
        idempotencyKey: `profile:${crypto.randomUUID()}`,
      },
      state,
    }, "/ui/mind-diary-account-client.js"), input.csrfToken);
  }

  const routePage = pilotRoutePage(input.pathname, session.displayName);
  if (routePage !== null) {
    return withCsrfMeta(renderMindDiaryRoutePageDocument(routePage), input.csrfToken);
  }

  if (input.pathname === "/me") {
    return withCsrfMeta(renderAuthenticatedOnboardingDocument({
      kind: "authenticated",
      displayName: session.displayName,
      profileVersion: session.profileVersion,
      personalMind: {
        route: "/me",
        name: session.personalMindName,
        headRevisionId: session.personalMindHeadRevisionId,
        updatedLabel: "Current HEAD is ready",
      },
      profileUpdate: { kind: "idle", idempotencyKey: `profile:${crypto.randomUUID()}` },
    }), input.csrfToken);
  }

  const routeMatch = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(input.pathname);
  const reservedUiRoute = routeMatch === null || RESERVED_UI_HANDLES.has(routeMatch[1]!);
  if (!reservedUiRoute && routeMatch !== null) {
    const handle = routeMatch[1]!;
    let view: OrdinaryMindsManagementModel["view"];
    try {
      const resolved = ordinaryUiMind(await input.control.execute({
        operation: "get_mind_info",
        actor: input.identity.actor,
        input: Object.freeze({ mind_ref: handle }),
      }));
      if (resolved === null) {
        view = { kind: "route_error", handle, message: "Mind settings are unavailable." };
      } else {
        let ownership: OrdinaryMindOwnershipCandidates | undefined;
        let capacity: OrdinaryMindCapacity | undefined;
        let collaboration: Extract<
          OrdinaryMindsManagementModel["view"],
          { readonly kind: "detail" }
        >["collaboration"];
        if (resolved.accessKind !== "visibility") {
          try {
            const [memberResult, invitationResult] = await Promise.all([
              input.control.execute({
                operation: "list_members",
                actor: input.identity.actor,
                input: Object.freeze({ mind_ref: handle }),
              }),
              input.control.execute({
                operation: "list_invitations",
                actor: input.identity.actor,
                input: Object.freeze({}),
              }),
            ]);
            const memberRecord = record(memberResult);
            const members = Array.isArray(memberRecord?.members)
              ? memberRecord.members
                .map(ordinaryUiMember)
                .filter((member): member is OrdinaryMindUiMember => member !== null)
              : [];
            const self = members.find((member) => member.isSelf);
            if (self === undefined || self.role !== resolved.role) {
              throw new TypeError("current membership projection is unavailable");
            }
            const mindMap = new Map([[resolved.mindId, resolved] as const]);
            const invitationRecord = record(invitationResult);
            const invitations = Array.isArray(invitationRecord?.invitations)
              ? invitationRecord.invitations
                .map((invitation) => invitationUi(invitation, mindMap))
                .filter((invitation): invitation is InvitationMembershipGlobalInvitation =>
                  invitation !== null && invitation.mindId === resolved.mindId)
                .map(perMindInvitation)
              : [];
            const collaborationMembers: readonly InvitationMembershipMember[] = Object.freeze(
              members.map((member) => Object.freeze({
                ...member,
                state: "active" as const,
              })),
            );
            collaboration = {
              kind: "ready",
              snapshot: Object.freeze({
                mind: Object.freeze({
                  mindId: resolved.mindId,
                  name: resolved.name,
                  route: `/${resolved.handle}`,
                  metadataVersion: resolved.metadataVersion,
                }),
                actor: Object.freeze({
                  memberId: self.memberId,
                  role: self.role,
                  membershipVersion: self.membershipVersion,
                }),
                members: collaborationMembers,
                invitations: Object.freeze(invitations),
              }),
            };
            if (resolved.role === "owner") {
              ownership = { kind: "ready", members: Object.freeze(members) };
            }
          } catch {
            collaboration = { kind: "error" };
            if (resolved.role === "owner") ownership = { kind: "error" };
          }
        }
        if (resolved.role === "owner") {
          try {
            capacity = ordinaryMindCapacity(await input.control.execute({
              operation: "get_capacity_usage",
              actor: input.identity.actor,
              input: Object.freeze({ mind_ref: handle }),
            })) ?? { kind: "error" };
          } catch {
            capacity = { kind: "error" };
          }
        }
        view = {
          kind: "detail",
          mind: resolved,
          ...(ownership === undefined ? {} : { ownership }),
          ...(collaboration === undefined ? {} : { collaboration }),
          ...(capacity === undefined ? {} : { capacity }),
        };
      }
    } catch {
      view = { kind: "route_error", handle, message: "Mind settings are unavailable." };
    }
    return withCsrfMeta(renderOrdinaryMindsManagementDocument({
      displayName: session.displayName,
      view,
    }, "/ui/mind-diary-ordinary-minds-client.js"), input.csrfToken);
  }

  let collection: MindDiaryUiShellModel["collection"];
  try {
    const listed = await input.control.execute({
      operation: "list_minds",
      actor: input.identity.actor,
      input: Object.freeze({}),
    });
    const minds = Array.isArray(listed)
      ? listed.map(uiMind).filter((mind): mind is UiMindCard => mind !== null)
      : [];
    collection = minds.length === 0
      ? { kind: "empty" }
      : { kind: "ready", minds: Object.freeze(minds) };
  } catch {
    collection = { kind: "error", message: "Mind summaries are unavailable. Try again." };
  }
  return withCsrfMeta(renderMindDiaryUiShellDocument({
    displayName: session.displayName,
    activeNavigation: "home",
    collection,
  }), input.csrfToken);
}

async function readInput(
  request: Request,
  maxBytes = MAX_JSON_BYTES,
): Promise<Readonly<Record<string, unknown>>> {
  if (request.method === "GET") {
    const url = new URL(request.url);
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    return Object.freeze(query);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new TypeError("request body is too large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new TypeError("request body is too large");
  }
  if (text.length === 0) return Object.freeze({});
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("request body must be an object");
  }
  return Object.freeze({ ...(value as Record<string, unknown>) });
}

async function readImportBatchInput(
  request: Request,
): Promise<Readonly<Record<string, unknown>>> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMPORT_BATCH_BODY_BYTES) {
    throw new TypeError("import batch body is too large");
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    return readInput(request);
  }
  const reader = request.body?.getReader();
  if (reader === undefined) throw new TypeError("import batch body is missing");
  const chunks: Uint8Array[] = [];
  let bodyBytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bodyBytes += next.value.byteLength;
    if (bodyBytes > MAX_IMPORT_BATCH_BODY_BYTES) {
      await reader.cancel();
      throw new TypeError("import batch body is too large");
    }
    chunks.push(next.value);
  }
  const boundedBody = new Uint8Array(bodyBytes);
  let offset = 0;
  for (const chunk of chunks) {
    boundedBody.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const boundedRequest = new Request(request.url, {
    method: request.method,
    headers: { "content-type": request.headers.get("content-type") ?? "" },
    body: boundedBody,
  });
  const form = await boundedRequest.formData();
  const manifestValue = form.get("manifest");
  if (typeof manifestValue !== "string" || ENCODER.encode(manifestValue).byteLength > MAX_JSON_BYTES) {
    throw new TypeError("import batch manifest is invalid");
  }
  const manifest: unknown = JSON.parse(manifestValue);
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new TypeError("import batch manifest is invalid");
  }
  const source = manifest as Record<string, unknown>;
  if (!Array.isArray(source.files) || source.files.length < 1 || source.files.length > 256) {
    throw new TypeError("import batch manifest is invalid");
  }
  let totalBytes = 0;
  const files = [];
  for (const descriptor of source.files) {
    if (typeof descriptor !== "object" || descriptor === null || Array.isArray(descriptor)) {
      throw new TypeError("import batch descriptor is invalid");
    }
    const record = descriptor as Record<string, unknown>;
    if (typeof record.field !== "string" || !/^file_[0-9]{1,3}$/u.test(record.field)) {
      throw new TypeError("import batch descriptor is invalid");
    }
    const value = form.get(record.field);
    if (
      value === null || typeof value === "string" ||
      typeof (value as Blob).arrayBuffer !== "function"
    ) throw new TypeError("import batch file is missing");
    const bytes = new Uint8Array(await (value as Blob).arrayBuffer());
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_IMPORT_BATCH_BYTES) throw new TypeError("import batch is too large");
    files.push(Object.freeze({
      path: record.path,
      sha256: record.sha256,
      size: record.size,
      bytes,
    }));
  }
  return Object.freeze({
    expected_version: source.expected_version,
    files: Object.freeze(files),
  });
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
  if (
    method === "GET" && one === "internal" && two === "operators" &&
    three === "users" && tail.length === 3
  ) return { operation: "list_service_operator_principals", path: {} };
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
    if (three === "capacity" && tail.length === 3 && method === "GET") return { operation: "get_capacity_usage", path };
    if (three === "markdown-import-plans" && tail.length === 3 && method === "POST") return { operation: "plan_markdown_import", path };
    if (three === "markdown-imports" && tail.length === 3 && method === "POST") return { operation: "start_markdown_import", path };
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
  if (one === "markdown-imports" && two !== null) {
    const path = { import_id: two };
    if (tail.length === 2 && method === "GET") return { operation: "get_markdown_import", path };
    if (tail.length === 2 && method === "DELETE") return { operation: "cancel_markdown_import", path };
    if (three === "batches" && four !== null && tail.length === 4 && method === "PUT") {
      const checkpoint = Number(four);
      if (!Number.isSafeInteger(checkpoint) || checkpoint < 1) return null;
      return { operation: "stage_markdown_import_batch", path: { ...path, checkpoint: String(checkpoint) } };
    }
    if (three === "validate" && tail.length === 3 && method === "POST") return { operation: "validate_markdown_import", path };
    if (three === "commit" && tail.length === 3 && method === "POST") return { operation: "commit_markdown_import", path };
  }
  if (one === "invitations") {
    if (tail.length === 1 && method === "GET") return { operation: "list_invitations", path: {} };
    if (two !== null && tail.length === 2 && method === "DELETE") return { operation: "cancel_invitation", path: { invitation_id: two } };
    if (two !== null && three === "accept" && tail.length === 3 && method === "POST") return { operation: "accept_invitation", path: { invitation_id: two } };
    if (two !== null && three === "reject" && tail.length === 3 && method === "POST") return { operation: "reject_invitation", path: { invitation_id: two } };
    if (two !== null && three === "reissue" && tail.length === 3 && method === "POST") return { operation: "reissue_invitation", path: { invitation_id: two } };
  }
  if (one === "mcp-tokens") {
    if (tail.length === 1 && method === "GET") return { operation: "list_personal_token_page", path: {} };
    if (tail.length === 1 && method === "POST") return { operation: "issue_mcp_token", path: {} };
    if (two !== null && tail.length === 2 && method === "DELETE") return { operation: "revoke_personal_token", path: { personal_token_ref: two } };
    if (two !== null && three === "mind-access" && tail.length === 3 && method === "PATCH") {
      return { operation: "mutate_personal_token_access", path: { personal_token_ref: two } };
    }
  }
  if (one === "connections") {
    if (tail.length === 1 && method === "GET") return { operation: "list_connections", path: {} };
    if (two !== null && tail.length === 2 && method === "GET") return { operation: "get_connection", path: { connection_ref: two } };
    if (two !== null && tail.length === 2 && method === "DELETE") return { operation: "revoke_connection", path: { connection_ref: two } };
    if (two !== null && three === "mind-access" && tail.length === 3 && method === "PATCH") {
      return { operation: "mutate_connection_access", path: { connection_ref: two } };
    }
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

function applicationErrorStatus(code: string): number {
  if (code === "authentication_required") return 401;
  if (code === "rate_limited") return 429;
  if (code === "search_index_unavailable") return 503;
  if (code === "binding_state_unavailable") return 503;
  if (code === "capacity_accounting_untrusted") return 503;
  if (
    code === "okf_validation_failed" ||
    code === "import_validation_failed" ||
    code === "import_file_limit_exceeded" ||
    code === "import_byte_limit_exceeded" ||
    code === "capacity_soft_limit" ||
    code === "capacity_hard_limit" ||
    code === "capacity_fairness_limit"
  ) return 422;
  if (
    code === "handle_unavailable" ||
    code === "write_step_up_required" ||
    code === "deletion_impact_changed" ||
    code === "deletion_impact_expired" ||
    code === "import_plan_expired" ||
    code === "import_session_expired" ||
    code === "ownership_state_changed" ||
    code.includes("conflict")
  ) return 409;
  if (code.includes("not_found") || code.endsWith("_unavailable")) return 404;
  if (code.startsWith("invalid_")) return 400;
  return 403;
}

/** Authenticated web/control handler. It deliberately never reads Bearer auth. */
export function createProductWebHttpHandler(
  dependencies: ProductWebHttpHandlerDependencies,
): (
  request: Request,
  deferActivity?: ProductWebActivityDeferrer,
) => Promise<Response | null> {
  const origin = canonicalOrigin(dependencies.applicationOrigin);
  return async (request, deferActivity) => {
    const url = new URL(request.url);
    const staticResponse = createProductUiStaticAssetResponse(request);
    if (staticResponse !== null) return staticResponse;
    const isApi = url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/");
    const isOperatorPath =
      url.pathname === "/internal/operators/users" ||
      url.pathname === "/api/v1/internal/operators/users";
    const detailMatch = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(url.pathname);
    const connectionUiDetail = /^\/settings\/connections\/[^/]+$/u.test(url.pathname);
    const isUi = PRODUCT_UI_ROUTES.has(url.pathname) || (
      detailMatch !== null && !RESERVED_UI_HANDLES.has(detailMatch[1]!)
    ) || connectionUiDetail;
    if (!isApi && !isUi) return null;
    const homeStartedAt = url.pathname === "/" &&
      isUi &&
      (request.method === "GET" || request.method === "HEAD")
      ? performance.now()
      : null;
    const performanceCorrelationId = homeStartedAt === null
      ? null
      : safeBenchmarkCorrelationId(request);
    const identityStartedAt = homeStartedAt === null ? null : performance.now();

    let identity: ProductSitesIdentityResolution;
    try {
      identity = await dependencies.resolveIdentity(request);
    } catch {
      identity = { kind: "unavailable" };
    }
    const requestId = safeRequestId(identity);
    if (
      identityStartedAt !== null &&
      identity.kind === "authenticated"
    ) {
      recordWebPerformance(dependencies.performance, {
        requestId,
        benchmarkCorrelationId: performanceCorrelationId,
        operation: "stage_authentication",
        durationMs: Math.max(0, performance.now() - identityStartedAt),
        outcome: "success",
      });
    }
    if (identity.kind === "denied") {
      if (isOperatorPath) {
        return errorResponse(404, "not_found", requestId);
      }
      if (isUi && (request.method === "GET" || request.method === "HEAD")) {
        const response = html(renderAuthenticatedOnboardingDocument({
          kind: "anonymous",
          authEntryPath: SITES_SIGN_IN_PATH,
        }));
        return request.method === "HEAD" ? new Response(null, response) : response;
      }
      return errorResponse(401, "authentication_required", requestId);
    }
    if (identity.kind === "unavailable") return errorResponse(503, "identity_binding_unavailable", requestId, true);
    if (
      isOperatorPath &&
      identity.kind !== "authenticated"
    ) return errorResponse(404, "not_found", requestId);

    if (
      url.pathname === "/settings/mcp" &&
      identity.kind === "authenticated" &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      return new Response(null, {
        status: 308,
        headers: {
          ...SAFE_HEADERS,
          location: "/settings/developer/mcp",
          "x-mind-diary-request-id": requestId,
        },
      });
    }

    if (isUi) {
      if (request.method !== "GET" && request.method !== "HEAD") return errorResponse(405, "method_not_allowed", requestId);
      const listQuery = url.pathname === "/settings/connections"
        ? strictListQuery(url, false)
        : url.pathname === "/settings/developer/mcp"
          ? strictListQuery(url, true)
          : Object.freeze({});
      if (listQuery === null) return errorResponse(400, "invalid_request", requestId);
      const uiQuery: Record<string, string> = {};
      url.searchParams.forEach((value, key) => { uiQuery[key] = value; });
      const applicationStartedAt = homeStartedAt !== null && identity.kind === "authenticated"
        ? performance.now()
        : null;
      let response: Response;
      try {
        response = html(await productUiDocument({
          pathname: url.pathname,
          siteOrigin: url.origin,
          identity,
          csrfToken: await dependencies.csrf.issue(identity.actor),
          control: dependencies.control,
          ...(dependencies.oauthConnections === undefined
            ? {}
            : { oauthConnections: dependencies.oauthConnections }),
          ...(dependencies.personalTokens === undefined
            ? {}
            : { personalTokens: dependencies.personalTokens }),
          ...(dependencies.mindBindings === undefined
            ? {}
            : { mindBindings: dependencies.mindBindings }),
          query: Object.freeze(uiQuery),
          listQuery,
        }));
      } catch (error) {
        const code = failureCode(error);
        response = code === "connection_not_found"
          ? errorResponse(404, "connection_not_found", requestId)
          : url.pathname === "/internal/operators/users"
          ? errorResponse(applicationErrorStatus(code), code, requestId)
          : errorResponse(503, "operation_failed", requestId, true);
      }
      if (response.ok && identity.kind === "authenticated") {
        await recordSuccessfulProductWebActivity(
          dependencies.activity,
          deferActivity,
          identity.actor,
          "page",
        );
      }
      const finalResponse = request.method === "HEAD"
        ? new Response(null, response)
        : response;
      finalResponse.headers.set("x-mind-diary-request-id", requestId);
      if (performanceCorrelationId !== null) {
        finalResponse.headers.set(
          "x-mind-diary-performance-correlation-id",
          performanceCorrelationId,
        );
      }
      if (
        homeStartedAt !== null &&
        applicationStartedAt !== null &&
        identity.kind === "authenticated"
      ) {
        const outcome = response.ok ? "success" as const : "failure" as const;
        const completedAt = performance.now();
        recordWebPerformance(dependencies.performance, {
          requestId,
          benchmarkCorrelationId: performanceCorrelationId,
          operation: "stage_application",
          durationMs: Math.max(0, completedAt - applicationStartedAt),
          outcome,
        });
        const totalDurationMs = Math.max(0, completedAt - homeStartedAt);
        for (const operation of ["stage_total", "home"] as const) {
          recordWebPerformance(dependencies.performance, {
            requestId,
            benchmarkCorrelationId: performanceCorrelationId,
            operation,
            durationMs: totalDurationMs,
            outcome,
          });
        }
      }
      return finalResponse;
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
      const parsed = camelInput(await (matched.operation === "stage_markdown_import_batch"
        ? readImportBatchInput(request)
        : matched.operation === "plan_markdown_import"
          ? readInput(request, MAX_IMPORT_PLAN_BODY_BYTES)
          : readInput(request)));
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
      if (
        matched.operation === "list_connections" ||
        matched.operation === "get_connection" ||
        matched.operation === "revoke_connection" ||
        matched.operation === "mutate_connection_access"
      ) {
        if (
          identity.kind !== "authenticated" ||
          dependencies.oauthConnections === undefined ||
          dependencies.mindBindings === undefined
        ) return errorResponse(404, "connection_not_found", requestId);
        if (matched.operation === "list_connections") {
          const query = strictListQuery(url, false);
          if (query === null) return errorResponse(400, "invalid_request", requestId);
          const page = await dependencies.oauthConnections.listPage(
            identity.actor.principalId,
            query,
          );
          const access = await safeBindingAccessByOwner(
            dependencies.control,
            dependencies.mindBindings,
            identity.actor,
            page.items.map((connection) => Object.freeze({
              ownerId: connection.bindingOwnerId,
              scopes: connection.scopes,
              state: "active" as const,
            })),
          );
          const items = page.items.map((connection) =>
            safeConnectionListItem(connection, access.get(connection.bindingOwnerId)!));
          await recordSuccessfulProductWebActivity(
            dependencies.activity,
            deferActivity,
            identity.actor,
            "control_read",
          );
          return json(200, { ok: true, data: snakeOutput({ items, nextCursor: page.nextCursor }) });
        }
        const connectionRef = String(matched.path.connection_ref ?? "");
        const connection = await dependencies.oauthConnections.read(
          identity.actor.principalId,
          connectionRef,
        );
        if (connection === null) return errorResponse(404, "connection_not_found", requestId);
        if (matched.operation === "revoke_connection") {
          if (requiredString(input.idempotencyKey) === null) {
            return errorResponse(400, "invalid_request", requestId);
          }
          if (!(await dependencies.oauthConnections.revoke(identity.actor.principalId, connectionRef))) {
            return errorResponse(404, "connection_not_found", requestId);
          }
          await recordSuccessfulProductWebActivity(
            dependencies.activity,
            deferActivity,
            identity.actor,
            "control_write",
          );
          return json(200, { ok: true, data: { revoked: true } });
        }
        const mutation = matched.operation === "mutate_connection_access"
          ? await mutateCredentialAccess({
            actor: identity.actor,
            mindBindings: dependencies.mindBindings,
            control: dependencies.control,
            ownerId: connection.bindingOwnerId,
            scopes: connection.scopes,
            request: input,
            presentationKey: "connection_ref",
          })
          : null;
        const fresh = matched.operation === "mutate_connection_access"
          ? await dependencies.oauthConnections.read(identity.actor.principalId, connectionRef)
          : connection;
        if (fresh === null) return errorResponse(404, "connection_not_found", requestId);
        const access = await safeBindingAccessByOwner(
          dependencies.control,
          dependencies.mindBindings,
          identity.actor,
          [Object.freeze({
            ownerId: fresh.bindingOwnerId,
            scopes: fresh.scopes,
            state: "active" as const,
          })],
        );
        const detail = safeConnectionDetail(fresh, access.get(fresh.bindingOwnerId)!);
        if (detail === null) return errorResponse(404, "connection_not_found", requestId);
        await recordSuccessfulProductWebActivity(
          dependencies.activity,
          deferActivity,
          identity.actor,
          matched.operation === "mutate_connection_access" ? "control_write" : "control_read",
        );
        return json(200, {
          ok: true,
          data: snakeOutput(mutation === null ? detail : { ...detail, ...mutation }),
        });
      }
      if (
        matched.operation === "list_personal_token_page" ||
        matched.operation === "mutate_personal_token_access"
      ) {
        if (
          identity.kind !== "authenticated" ||
          dependencies.personalTokens === undefined ||
          dependencies.mindBindings === undefined
        ) return errorResponse(404, "personal_token_not_found", requestId);
        if (matched.operation === "list_personal_token_page") {
          const query = strictListQuery(url, true);
          if (query === null) return errorResponse(400, "invalid_request", requestId);
          const state = query.state ?? "active";
          const page = await dependencies.personalTokens.listPage(identity.actor, { ...query, state });
          const access = state === "active"
            ? await safeBindingAccessByOwner(
                dependencies.control,
                dependencies.mindBindings,
                identity.actor,
                page.items.map((token) => Object.freeze({
                  ownerId: token.bindingOwnerId,
                  scopes: token.scopes,
                  state: "active" as const,
                })),
              )
            : new Map<string, SafeCredentialAccess>();
          const items = page.items.map(({ bindingOwnerId, ...token }) => {
            const tokenAccess = access.get(bindingOwnerId);
            if (state === "active" && tokenAccess === undefined) {
              throw new TypeError("safe personal token access is unavailable");
            }
            return Object.freeze({
              ...token,
              ...(tokenAccess === undefined ? {} : { access: tokenAccess }),
            });
          });
          await recordSuccessfulProductWebActivity(
            dependencies.activity,
            deferActivity,
            identity.actor,
            "control_read",
          );
          return json(200, { ok: true, data: snakeOutput({ items, nextCursor: page.nextCursor }) });
        }
        const personalTokenRef = String(matched.path.personal_token_ref ?? "");
        const token = await dependencies.personalTokens.read(identity.actor, personalTokenRef);
        if (token === null || token.state !== "active") {
          return errorResponse(404, "personal_token_not_found", requestId);
        }
        const mutation = await mutateCredentialAccess({
          actor: identity.actor,
          mindBindings: dependencies.mindBindings,
          control: dependencies.control,
          ownerId: token.bindingOwnerId,
          scopes: token.scopes,
          request: input,
          presentationKey: "personal_token_ref",
        });
        const fresh = await dependencies.personalTokens.read(identity.actor, personalTokenRef);
        if (fresh === null) return errorResponse(404, "personal_token_not_found", requestId);
        const access = await safeBindingAccessByOwner(
          dependencies.control,
          dependencies.mindBindings,
          identity.actor,
          [Object.freeze({
            ownerId: fresh.bindingOwnerId,
            scopes: fresh.scopes,
            state: "active" as const,
          })],
        );
        const { bindingOwnerId, ...safeToken } = fresh;
        const freshAccess = access.get(bindingOwnerId);
        if (freshAccess === undefined) {
          throw new TypeError("safe personal token access is unavailable");
        }
        await recordSuccessfulProductWebActivity(
          dependencies.activity,
          deferActivity,
          identity.actor,
          "control_write",
        );
        return json(200, {
          ok: true,
          data: snakeOutput({ ...safeToken, access: freshAccess, ...mutation }),
        });
      }
      if (matched.operation === "revoke_personal_token") {
        if (identity.kind !== "authenticated") {
          return errorResponse(404, "personal_token_not_found", requestId);
        }
        if (requiredString(input.idempotencyKey) === null) {
          return errorResponse(400, "invalid_request", requestId);
        }
        try {
          const data = await dependencies.control.execute({
            operation: matched.operation,
            actor: identity.actor,
            input,
          });
          await recordSuccessfulProductWebActivity(
            dependencies.activity,
            deferActivity,
            identity.actor,
            "control_write",
          );
          return json(200, { ok: true, data: snakeOutput(data) });
        } catch (error) {
          const code = failureCode(error);
          if (code === "token_not_found" || code === "invalid_token_id") {
            return errorResponse(404, "personal_token_not_found", requestId);
          }
          throw error;
        }
      }
      const data = await dependencies.control.execute({
        operation: matched.operation,
        actor: identity.actor,
        input,
      });
      if (identity.kind === "authenticated") {
        await recordSuccessfulProductWebActivity(
          dependencies.activity,
          deferActivity,
          identity.actor,
          MUTATION_METHODS.has(request.method) ? "control_write" : "control_read",
        );
      }
      return json(200, { ok: true, data: snakeOutput(data) });
    } catch (error) {
      const code = failureCode(error);
      return errorResponse(applicationErrorStatus(code), code, requestId);
    }
  };
}
