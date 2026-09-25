import { PRODUCT_UI_ASSET_VERSION } from "./product-ui-assets.generated.js";

import {
  type MindDiaryRoutePageModel,
  type UiMindCard,
} from "./ui-shell.js";

import {
  MIND_DIARY_CODEX_CONCIERGE_PLAYBOOK,
  MIND_DIARY_CODEX_STARTER_PLAYBOOK,
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
  type PersonalTokenItem,
} from "./connections.js";

import {
  type ProductSitesIdentityResolution,
  type ProductWebOAuthConnections,
  type ProductWebPersonalTokenRecord,
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
  details?: unknown,
): Response {
  const capacityDetails = safeCapacityErrorDetails(code, details);
  return json(status, {
    ok: false,
    error: {
      code,
      message: safeErrorMessage(code),
      retryable,
      request_id: requestId,
      ...(capacityDetails === null ? {} : { details: capacityDetails }),
    },
  });
}

function safeCapacityErrorDetails(code: string, value: unknown): Readonly<Record<string, unknown>> | null {
  if (![
    "capacity_accounting_untrusted",
    "capacity_soft_limit",
    "capacity_hard_limit",
    "capacity_fairness_limit",
  ].includes(code)) return null;
  const isAllowed = (candidate: unknown, allowed: readonly string[]): candidate is string =>
    typeof candidate === "string" && allowed.includes(candidate);
  try {
    const detail = record(value);
    const recovery = record(detail?.recovery);
    if (
      detail === null || recovery === null ||
      !isAllowed(detail.operation, ["commit", "stage", "export", "import"]) ||
      !isAllowed(detail.spaceScope, ["mind", "principal", "site"]) ||
      !isAllowed(detail.metric, ["active_heavy_operations", "physical_canonical_bytes", "temporary_bytes", "d1_metadata_bytes", "reservation_state"]) ||
      !isAllowed(detail.state, ["normal", "warning", "soft_limit", "hard_limit", "untrusted"]) ||
      typeof detail.heavy !== "boolean" ||
      !isAllowed(recovery.action, ["retry_after_previous_operation", "retry_after_capacity_change", "retry_after_reconciliation"])
    ) return null;
    const counters = [detail.requested, detail.committed, detail.reserved];
    if (counters.some((counter) => counter !== undefined && (!Number.isSafeInteger(counter) || Number(counter) < 0))) return null;
    return Object.freeze({
      operation: detail.operation,
      space_scope: detail.spaceScope,
      metric: detail.metric,
      ...(detail.requested === undefined ? {} : { requested: detail.requested }),
      ...(detail.committed === undefined ? {} : { committed: detail.committed }),
      ...(detail.reserved === undefined ? {} : { reserved: detail.reserved }),
      state: detail.state,
      heavy: detail.heavy,
      recovery: Object.freeze({ action: recovery.action }),
    });
  } catch {
    return null;
  }
}

function safeErrorMessage(code: string): string {
  if (code === "authentication_required") return "Authentication is required.";
  if (code === "registration_required") return "Account registration is required.";
  if (code === "account_bootstrap_conflict") return "Account setup changed in another request. Reload the current account state before trying again.";
  if (code === "profile_conflict") return "The profile changed in another session. Reload the current account state before saving again.";
  if (code === "invalid_request") return "The request is invalid.";
  if (code === "commit_in_progress") return "This exact changeset may still be committing. Reconcile its result before retrying.";
  if (code === "usage_conflict") return "Mind usage changed in another session. Reload the current settings before trying again.";
  if (code === "description_required") return "Add a routing description before allowing automatic writes.";
  if (code === "description_required_for_write") return "Change the Mind mode before clearing its writable routing description.";
  if (code === "usage_not_allowed") return "Current Mind access does not allow that usage mode.";
  if (code === "mind_usage_unavailable") return "Mind usage settings are temporarily unavailable.";
  if (code === "not_found") return "The resource was not found.";
  if (code === "connection_not_found") return "The connection was not found.";
  if (code === "personal_token_not_found") return "The personal token was not found.";
  if (code === "export_job_not_found") return "The export job was not found.";
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
  // Stable paths remain supported, but each HTML response pins its own asset set.
  // This prevents a warm browser cache from mixing a new page with old clients.
  const versioned = document.replace(
    /((?:src|href)=")((?:\/ui\/|\/brand\/)[^"?]+\.(?:css|js))(")/gu,
    `$1$2?v=${PRODUCT_UI_ASSET_VERSION}$3`,
  );
  return new Response(versioned, {
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
  return value === null
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

export interface ProductUiSession {
  readonly displayName: string;
  readonly profileVersion: number;
  readonly personalMindName: string;
  readonly personalMindDescription: string | null;
  readonly personalMindMetadataVersion: number | null;
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
      shellCurrent: null,
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
  const personalMindDescription = ordinaryDescription(personalMind?.description);
  const personalMindMetadataVersion = positiveInteger(personalMind?.metadataVersion);
  const personalMindHeadRevisionId = requiredString(personalMind?.headRevisionId);
  return displayName === null || profileVersion === null || personalMindName === null ||
      personalMindHeadRevisionId === null
    ? null
    : Object.freeze({
        displayName,
        profileVersion,
        personalMindName,
        personalMindDescription: personalMindDescription ?? null,
        personalMindMetadataVersion,
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
      ? descriptionExcerpt(description ?? null, "No topics configured. Used only when you ask.")
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
  const sourceMindRoute = requiredString(source?.mindRoute);
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
    state !== "pending"
  ) return null;
  const mind = minds.get(mindId);
  const mindRoute = sourceMindRoute !== null &&
    /^\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(sourceMindRoute)
    ? sourceMindRoute
    : mind === undefined
      ? "#"
      : `/${mind.handle}`;
  const canManage = direction === "incoming" || (
    mind?.accessKind !== "visibility" &&
    (mind?.role === "owner" || mind?.role === "admin")
  );
  return Object.freeze({
    invitationId,
    mindId,
    mindName,
    mindRoute,
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
  invitations: readonly InvitationMembershipGlobalInvitation[];
}> | null {
  const source = record(value);
  if (!Array.isArray(source?.invitations)) return null;
  const invitations = Object.freeze(source.invitations
    .map((invitation) => invitationUi(invitation, new Map()))
    .filter((invitation): invitation is InvitationMembershipGlobalInvitation =>
      invitation !== null &&
      invitation.direction === "incoming" &&
      invitation.mindRoute !== "#"));
  return Object.freeze({ invitations });
}

export function safeConnectionListItem(
  connection: Awaited<ReturnType<ProductWebOAuthConnections["listPage"]>>["items"][number],
): ConnectionListItem {
  const canWrite = connection.scopes.includes("content:write");
  return Object.freeze({
    connectionRef: connection.connectionRef,
    clientName: connection.clientName,
    createdAt: connection.createdAt,
    lastUsedAt: connection.lastUsedAt,
    canRead: connection.scopes.includes("content:read"),
    canWrite,
  });
}

export function safeConnectionDetail(
  connection: Awaited<ReturnType<ProductWebOAuthConnections["read"]>>,
): ConnectionDetail | null {
  if (connection === null) return null;
  return safeConnectionListItem(connection);
}

export function safePersonalTokenItem(
  record: ProductWebPersonalTokenRecord,
): PersonalTokenItem {
  return Object.freeze({
    personalTokenRef: record.personalTokenRef,
    name: record.name,
    displayPrefix: record.displayPrefix,
    scopes: Object.freeze([...record.scopes]),
    state: record.state,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
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

const PUBLIC_CATALOG_CURSOR_PATTERN = /^mdc1_[A-Za-z0-9_-]{1,251}$/u;

export function strictPublicCatalogQuery(
  url: URL,
): Readonly<{
  readonly limit: number;
  readonly cursor?: string;
}> | null {
  let keysAreValid = true;
  url.searchParams.forEach((_value, key) => {
    if (
      (key !== "limit" && key !== "cursor") ||
      url.searchParams.getAll(key).length !== 1
    ) keysAreValid = false;
  });
  if (!keysAreValid) return null;
  const limitValue = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  if (
    (limitValue !== null && !/^(?:[1-9]|[1-4][0-9]|50)$/u.test(limitValue)) ||
    (cursor !== null && !PUBLIC_CATALOG_CURSOR_PATTERN.test(cursor))
  ) return null;
  return Object.freeze({
    limit: limitValue === null ? 24 : Number(limitValue),
    ...(cursor === null ? {} : { cursor }),
  });
}

export function safePublicCatalogCursor(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && PUBLIC_CATALOG_CURSOR_PATTERN.test(value)
    ? value
    : undefined;
}
