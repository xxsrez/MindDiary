import type { D1DatabaseLike } from "@mind-diary/adapter-metadata-sites";
import type { ProductSitesIdentityResolution, ProductWebActor } from "@mind-diary/adapter-web";

/** Temporary, fixed-scope UAT diagnostic for MD-485. Remove after read-back. */
export const UAT191_INCIDENT_DIAGNOSTIC_PATH =
  "/api/v1/internal/operators/diagnostics/md485-uat191";

const START = "2026-09-20T15:30:00.000Z";
const END = "2026-09-21T16:00:00.000Z";
const PAGE_SIZE = 40;
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

interface EventRow {
  readonly sequence: number;
  readonly target: string;
  readonly operation: string;
  readonly payload_json: string;
  readonly committed_at: string;
}

function response(status: number, data: unknown): Response {
  return new Response(`${JSON.stringify(data)}\n`, { status, headers: HEADERS });
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function capacityIdForMind(value: unknown, mindId: string): string | undefined {
  if (typeof value !== "string" || value.length > 256 ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(mindId)) return undefined;
  const prefix = /^(capacity:(?:commit|stage|export|import):)/u.exec(value)?.[1];
  if (prefix === undefined || !value.startsWith(`${prefix}${mindId}:`)) return undefined;
  const operationRef = value.slice(prefix.length + mindId.length + 1);
  return /^[A-Za-z0-9._:-]{1,160}$/u.test(operationRef) ? value : undefined;
}

function targetReference(value: unknown, mindId: string, depth = 0): boolean {
  if (depth > 5) return false;
  if (Array.isArray(value)) {
    return value.slice(0, 64).some((item) => targetReference(item, mindId, depth + 1));
  }
  const source = object(value);
  if (source === null) return false;
  if (source.spaceId === mindId || source.mindId === mindId ||
      capacityIdForMind(source.reservationId, mindId) !== undefined) return true;
  return Object.entries(source).some(([key, item]) =>
    !["content", "text", "bytes", "body", "markdown", "payload", "description", "metadata"].includes(key) &&
    (Array.isArray(item) || object(item) !== null) &&
    targetReference(item, mindId, depth + 1));
}

function safeId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value)
    ? value : undefined;
}

function safeInstant(value: unknown): string | undefined {
  if (typeof value !== "string" ||
      !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return undefined;
  const parsed = Date.parse(value);
  return parsed >= Date.parse("2026-01-01T00:00:00.000Z") &&
    parsed < Date.parse("2028-01-01T00:00:00.000Z") &&
    new Date(parsed).toISOString() === value ? value : undefined;
}

function safeNumber(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? value as number : undefined;
}

function safeEnum(value: unknown, allowed: readonly string[]): string | undefined {
  return typeof value === "string" && allowed.includes(value) ? value : undefined;
}

function numericAxes(value: unknown): Record<string, number> | undefined {
  const source = object(value);
  if (source === null) return undefined;
  const result: Record<string, number> = {};
  for (const key of [
    "physicalCanonicalBytes", "temporaryBytes", "d1MetadataBytes", "logicalBytes",
    "activeHeavyPerMind", "activeHeavyPerPrincipal", "activeHeavyPerSite",
  ]) {
    const number = safeNumber(source[key]);
    if (number !== undefined) result[key] = number;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function safeDetails(value: unknown, mindId: string): Readonly<Record<string, unknown>> | null {
  const source = object(value);
  if (source === null) return null;
  const result: Record<string, unknown> = {};
  const reservationId = capacityIdForMind(source.reservationId, mindId);
  if (reservationId !== undefined) result.reservationId = reservationId;
  for (const key of ["jobId", "sessionId", "operationRef"]) {
    const id = safeId(source[key]);
    if (id !== undefined) result[key] = id;
  }
  for (const key of ["createdAt", "updatedAt", "expiresAt", "releasedAt", "completedAt", "consumedAt", "canceledAt"]) {
    const instant = safeInstant(source[key]);
    if (instant !== undefined) result[key] = instant;
  }
  const operation = safeEnum(source.operation, ["commit", "stage", "export", "import"]);
  if (operation !== undefined) result.operation = operation;
  const state = safeEnum(source.state, [
    "active", "consumed", "released", "expired", "cleanup_pending", "queued", "running",
    "ready", "completed", "failed", "canceled",
  ]);
  if (state !== undefined) result.state = state;
  if (typeof source.heavy === "boolean") result.heavy = source.heavy;
  for (const key of ["requested", "actual", "reserved", "limits"]) {
    const axes = numericAxes(source[key]);
    if (axes !== undefined) result[key] = axes;
  }
  for (const key of ["reservation", "job"]) {
    const nested = safeDetailsShallow(source[key], mindId);
    if (nested !== null) result[key] = nested;
  }
  return Object.keys(result).length === 0 ? null : Object.freeze(result);
}

function safeDetailsShallow(value: unknown, mindId: string): Readonly<Record<string, unknown>> | null {
  const source = object(value);
  if (source === null) return null;
  const result: Record<string, unknown> = {};
  const reservationId = capacityIdForMind(source.reservationId, mindId);
  if (reservationId !== undefined) result.reservationId = reservationId;
  for (const key of ["jobId", "operationRef"]) {
    const id = safeId(source[key]);
    if (id !== undefined) result[key] = id;
  }
  for (const key of ["createdAt", "expiresAt", "releasedAt", "completedAt", "consumedAt", "canceledAt"]) {
    const instant = safeInstant(source[key]);
    if (instant !== undefined) result[key] = instant;
  }
  const operation = safeEnum(source.operation, ["commit", "stage", "export", "import"]);
  if (operation !== undefined) result.operation = operation;
  const state = safeEnum(source.state, ["active", "consumed", "released", "expired", "cleanup_pending", "queued", "running", "ready", "completed", "failed", "canceled"]);
  if (state !== undefined) result.state = state;
  if (typeof source.heavy === "boolean") result.heavy = source.heavy;
  const requested = numericAxes(source.requested);
  if (requested !== undefined) result.requested = requested;
  return Object.keys(result).length === 0 ? null : Object.freeze(result);
}

export function projectUat191Event(row: EventRow, mindId: string): Readonly<Record<string, unknown>> | null {
  let event: Record<string, unknown> | null;
  try { event = object(JSON.parse(row.payload_json)); } catch { return null; }
  if (event === null || event.v !== 1 || event.target !== "metadata" ||
      event.method !== row.operation) return null;
  const calls = event.kind === "transaction" ? event.calls :
    [{ method: event.method, args: event.args }];
  if (!Array.isArray(calls) || calls.length > 128) return null;
  const selected = calls.flatMap((call) => {
    const item = object(call);
    if (item === null || typeof item.method !== "string" ||
        !/^[A-Za-z][A-Za-z0-9]{0,80}$/u.test(item.method) ||
        !Array.isArray(item.args) || !targetReference(item.args, mindId)) return [];
    const details = safeDetails(item.args[0], mindId);
    return [Object.freeze({
      method: item.method,
      ...(details === null ? {} : { details }),
    })];
  });
  if (selected.length === 0) return null;
  return Object.freeze({
    sequence: row.sequence,
    committed_at: row.committed_at,
    operation: row.operation,
    calls: Object.freeze(selected),
  });
}

export function authorizedUat191MindId(input: {
  readonly resolveIdentity: (request: Request) => Promise<ProductSitesIdentityResolution>;
  readonly operatorPrincipalIds: ReadonlySet<string>;
  readonly resolveTargetMind: (actor: ProductWebActor) => Promise<{
    readonly isPersonal: boolean;
    readonly mindId: string;
    readonly access: { readonly kind: string; readonly role: string | null };
  }>;
}): (request: Request) => Promise<string | null> {
  return async (request) => {
    const identity = await input.resolveIdentity(request);
    if (identity.kind !== "authenticated" ||
        identity.actor.authentication.kind !== "sites_identity" ||
        !input.operatorPrincipalIds.has(identity.actor.principalId)) return null;
    try {
      const mind = await input.resolveTargetMind(identity.actor);
      return !mind.isPersonal && mind.access.kind === "membership" &&
        mind.access.role === "owner" ? mind.mindId : null;
    } catch { return null; }
  };
}

export function createUat191IncidentDiagnostic(input: {
  readonly database: D1DatabaseLike;
  /** Returns the exact current Mind ID only after operator and owner authorization. */
  readonly authorizedMindId: (request: Request) => Promise<string | null>;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "GET") return response(404, { ok: false, error: "not_found" });
    const mindId = await input.authorizedMindId(request).catch(() => null);
    if (mindId === null) return response(404, { ok: false, error: "not_found" });
    const url = new URL(request.url);
    const queryKeys: string[] = [];
    url.searchParams.forEach((_value, key) => { queryKeys.push(key); });
    if (queryKeys.some((key) => key !== "before") || queryKeys.filter((key) => key === "before").length > 1) {
      return response(400, { ok: false, error: "invalid_request" });
    }
    const rawBefore = url.searchParams.get("before");
    const before = rawBefore === null ? MAX_SEQUENCE : Number(rawBefore);
    if (rawBefore !== null && (!/^[1-9]\d{0,15}$/u.test(rawBefore) ||
      !Number.isSafeInteger(before))) return response(400, { ok: false, error: "invalid_request" });
    try {
      const result = await input.database.prepare(
        `/*md485-uat191-temporary*/ SELECT sequence, target, operation, payload_json, committed_at
         FROM md_metadata_events
         WHERE committed_at >= ?1 AND committed_at < ?2 AND sequence < ?3
           AND target = 'metadata' AND instr(payload_json, ?4) > 0
         ORDER BY sequence DESC LIMIT ?5`,
      ).bind(START, END, before, mindId, PAGE_SIZE + 1).all<EventRow>();
      if (result.success === false) throw new Error("D1 diagnostic read failed");
      const rows = result.results ?? [];
      const page = rows.slice(0, PAGE_SIZE);
      const events = page.flatMap((row) => {
        const projected = projectUat191Event(row, mindId);
        return projected === null ? [] : [projected];
      });
      return response(200, {
        ok: true,
        data: {
          incident: "MD-485/UAT191",
          from_utc: START,
          to_utc: END,
          history_coverage: "20 September 15:30 through 21 September 16:00 UTC; older stale reservations remain outside this window",
          event_semantics: "transaction calls record attempted operations, not their return values or confirmed reservation state",
          events,
          next_before: rows.length > PAGE_SIZE && page.length > 0
            ? page[page.length - 1]!.sequence : null,
        },
      });
    } catch {
      return response(503, { ok: false, error: "diagnostic_unavailable" });
    }
  };
}
