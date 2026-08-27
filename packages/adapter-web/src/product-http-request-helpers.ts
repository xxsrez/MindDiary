import {
  type MindDiaryRoutePageModel,
  type UiMindCard,
} from "./ui-shell.js";

import {
  MIND_DIARY_CODEX_CONCIERGE_PLAYBOOK,
  MIND_DIARY_CODEX_STARTER_PLAYBOOK,
  type MindBindingUiMind,
} from "./token-management.js";

import {
  type OrdinaryMindCapacity,
  type OrdinaryMindUiMember,
  type OrdinaryMindUiMind,
} from "./ordinary-minds-management.js";

import {
  type PublicMindCatalogItem,
} from "./visibility-catalog.js";

import {
  type InvitationMembershipGlobalInvitation,
  type InvitationMembershipInvitation,
} from "./invitations-membership.js";

import {
  type ConnectionDetail,
  type ConnectionListItem,
  type SafeConnectionMind,
  type SafeCredentialAccess,
} from "./connections.js";

import {
  type RegisteredSitesActor,
  type ProductSitesIdentityResolution,
  type ProductWebControlApplication,
  type ProductWebOAuthConnections,
  type ProductWebMindBindingOwner,
  type ProductWebMindBindings,
  type ProductWebPerformanceRecorder,
} from "./product-http-contracts.js";

export const MUTATION_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
export const PRODUCT_UI_ROUTES = new Set([
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
export const RESERVED_UI_HANDLES = new Set([
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
export const SITES_SIGN_IN_PATH = "/signin-with-chatgpt";
export const MAX_JSON_BYTES = 64 * 1024;
export const MAX_IMPORT_PLAN_BODY_BYTES = 16 * 1024 * 1024;
export const MAX_IMPORT_BATCH_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_BATCH_BYTES = 4 * 1024 * 1024;
export const ENCODER = new TextEncoder();
export const SAFE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'self'; img-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});
export const STATIC_ASSET_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";
export function canonicalOrigin(value: string): string {
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

export function json(status: number, body: unknown): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: {
      ...SAFE_HEADERS,
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function errorResponse(
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

export function safeRequestId(resolution: ProductSitesIdentityResolution): string {
  return "actor" in resolution && typeof resolution.actor.requestId === "string"
    ? resolution.actor.requestId
    : "request_denied";
}

export function safeBenchmarkCorrelationId(request: Request): string | null {
  const value = request.headers.get("x-mind-diary-performance-correlation-id");
  return value !== null && /^benchmark_[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(value)
    ? value
    : null;
}

export function recordWebPerformance(
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

export function camelInput(value: Readonly<Record<string, unknown>>) {
  return mapPlainKeys(
    value,
    (key) => key.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase()),
  ) as Readonly<Record<string, unknown>>;
}

export function snakeOutput(value: unknown): unknown {
  return mapPlainKeys(value, (key) =>
    key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`),
  );
}

export function html(document: string): Response {
  return new Response(document, {
    status: 200,
    headers: { ...SAFE_HEADERS, "content-type": "text/html; charset=utf-8" },
  });
}

export function withCsrfMeta(document: string, csrfToken: string): string {
  return document.replace(
    "</head>",
    `  <meta name="mind-diary-csrf-token" content="${escapeHtml(csrfToken)}">\n</head>`,
  );
}

export function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

export function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function ordinaryDescription(value: unknown): string | null | undefined {
  return value === undefined || value === null
    ? null
    : typeof value === "string"
      ? value
      : undefined;
}

function descriptionExcerpt(value: string | null, fallback: string): string {
  if (value === null) return fallback;
  const compact = value.replace(/\s+/gu, " ").trim();
  const points = [...compact];
  return points.length <= 180 ? compact : `${points.slice(0, 179).join("")}…`;
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

export interface ProductUiSession {
  readonly displayName: string;
  readonly profileVersion: number;
  readonly personalMindName: string;
  readonly personalMindHeadRevisionId: string;
}

export function pilotRoutePage(
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

export function uiSession(value: unknown): ProductUiSession | null {
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

export function uiMind(value: unknown): UiMindCard | null {
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
  const description = ordinaryDescription(source?.description);
  if (!isPersonal && description === undefined) return null;
  return Object.freeze({
    id: requiredString(source?.mindId) ?? route,
    name,
    route,
    description: isPersonal
      ? "Your private place for personal Memories."
      : descriptionExcerpt(
          description ?? null,
          "A versioned Mind available through your current access.",
        ),
    visibility,
    role: roleLabel(access?.role),
    updatedLabel: "Current HEAD is ready",
    ...(isPersonal ? { isPersonal: true } : {}),
  });
}

export function ordinaryUiMind(value: unknown): OrdinaryMindUiMind | null {
  const source = record(value);
  const access = record(source?.access);
  const mindId = requiredString(source?.mindId);
  const handle = requiredString(source?.handle);
  const name = requiredString(source?.name);
  const description = ordinaryDescription(source?.description);
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
    description === undefined ||
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
    description,
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

export function ordinaryMindCapacity(value: unknown): OrdinaryMindCapacity | null {
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

export function ordinaryUiMember(value: unknown): OrdinaryMindUiMember | null {
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

export function invitationUi(
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

export function perMindInvitation(
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

export function publicUiMind(value: unknown): PublicMindCatalogItem | null {
  const source = record(value);
  const mindId = requiredString(source?.mindId);
  const route = requiredString(source?.route);
  const name = requiredString(source?.name);
  const description = ordinaryDescription(source?.description);
  if (
    mindId === null || route === null || name === null || description === undefined ||
    !/^\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(route) ||
    source?.isPersonal !== false || source?.visibility !== "public" ||
    source?.discovery !== "public_catalog"
  ) return null;
  return Object.freeze({
    mindId,
    route,
    name,
    description,
    summary: descriptionExcerpt(
      description,
      "A versioned Mind shared by its Owner.",
    ),
    visibility: "public",
    isPersonal: false,
    discovery: "public_catalog",
  });
}

export function safeInvitationOverview(value: unknown): Readonly<{
  minds: readonly Readonly<{
    mindId: string;
    route: `/${string}`;
    role: OrdinaryMindUiMind["role"];
  }>[];
  invitations: Readonly<{
    invitations: readonly InvitationMembershipGlobalInvitation[];
  }>;
}> | null {
  const source = record(value);
  const invitationSource = record(source?.invitations);
  if (!Array.isArray(source?.minds) || !Array.isArray(invitationSource?.invitations)) {
    return null;
  }
  const ordinaryMinds = source.minds
    .map(ordinaryUiMind)
    .filter((mind): mind is OrdinaryMindUiMind => mind !== null);
  const mindMap = new Map(ordinaryMinds.map((mind) => [mind.mindId, mind] as const));
  const minds = Object.freeze(ordinaryMinds.map((mind) => Object.freeze({
    mindId: mind.mindId,
    route: `/${mind.handle}` as `/${string}`,
    role: mind.role,
  })));
  const invitations = Object.freeze(invitationSource.invitations
    .map((invitation) => invitationUi(invitation, mindMap))
    .filter((invitation): invitation is InvitationMembershipGlobalInvitation => invitation !== null));
  return Object.freeze({
    minds,
    invitations: Object.freeze({ invitations }),
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

export function safeConnectionListItem(
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

export function safeConnectionDetail(
  connection: Awaited<ReturnType<ProductWebOAuthConnections["read"]>>,
  access: SafeCredentialAccess,
): ConnectionDetail | null {
  if (connection === null) return null;
  return Object.freeze({
    ...safeConnectionListItem(connection, access),
    access,
  });
}

export function strictListQuery(
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

export async function safeBindingAccessByOwner(
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

export async function mutateCredentialAccess(input: {
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
