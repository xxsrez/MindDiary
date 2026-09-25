import type { D1DatabaseLike } from "@mind-diary/adapter-metadata-sites";
import type { ProductSitesIdentityResolution, ProductWebActor } from "@mind-diary/adapter-web";

/** One-time, read-only UAT incident projection. Remove after read-back. */
export const UAT191_CAPACITY_HISTORY_PATH =
  "/api/v1/internal/operators/diagnostics/md485-uat191-capacity";

const FROM = "2026-09-20T15:30:00.000Z";
const AT = "2026-09-21T15:40:15.540Z";
const MAX_EVENTS = 2000;
const HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

interface EventRow {
  readonly sequence: number;
  readonly payload_json: string;
  readonly committed_at: string;
}

interface ChunkRow { readonly chunk_index: number; readonly payload_json: string; }
interface HeadRow {
  readonly sequence: number;
  readonly chunk_count: number;
  readonly payload_chars: number;
  readonly updated_at: string;
}
interface HistoricalStatsRow {
  readonly event_count: number;
  readonly payload_chars: number;
  readonly first_sequence: number;
  readonly last_sequence: number;
}
interface LegacySnapshotRow {
  readonly sequence: number;
  readonly payload_json: string;
  readonly updated_at: string;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function pairs(value: unknown): readonly (readonly [unknown, unknown])[] {
  const source = object(value);
  return source?.__md_sites_type === "map" && Array.isArray(source.entries)
    ? source.entries as (readonly [unknown, unknown])[] : [];
}

function safeId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/u.test(value)
    ? value : null;
}

function response(status: number, data: unknown): Response {
  return new Response(`${JSON.stringify(data)}\n`, { status, headers: HEADERS });
}

function calls(value: unknown): readonly Record<string, unknown>[] {
  const event = object(value);
  if (event?.v !== 1 || event.target !== "metadata") return [];
  const raw = event.kind === "transaction" ? event.calls :
    [{ method: event.method, args: event.args }];
  return Array.isArray(raw) && raw.length <= 128
    ? raw.flatMap((item) => {
      const call = object(item);
      return call === null ? [] : [call];
    }) : [];
}

function firstArg(call: Record<string, unknown>): Record<string, unknown> | null {
  return Array.isArray(call.args) ? object(call.args[0]) : null;
}

export function authorizedUat191CapacityActor(input: {
  readonly resolveIdentity: (request: Request) => Promise<ProductSitesIdentityResolution>;
  readonly operatorPrincipalIds: ReadonlySet<string>;
  readonly resolveTargetMind: (actor: ProductWebActor) => Promise<{
    readonly isPersonal: boolean;
    readonly mindId: string;
    readonly access: { readonly kind: string; readonly role: string | null };
  }>;
}): (request: Request) => Promise<{ principalId: string; mindId: string } | null> {
  return async (request) => {
    const identity = await input.resolveIdentity(request);
    if (identity.kind !== "authenticated" ||
        identity.actor.authentication.kind !== "sites_identity" ||
        !input.operatorPrincipalIds.has(identity.actor.principalId)) return null;
    try {
      const mind = await input.resolveTargetMind(identity.actor);
      return !mind.isPersonal && mind.access.kind === "membership" &&
        mind.access.role === "owner"
        ? { principalId: identity.actor.principalId, mindId: mind.mindId } : null;
    } catch { return null; }
  };
}

export function createUat191CapacityHistory(input: {
  readonly database: D1DatabaseLike;
  readonly authorizedActor: (request: Request) => Promise<{
    principalId: string;
    mindId: string;
  } | null>;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "GET" || new URL(request.url).search !== "") {
      return response(404, { ok: false, error: "not_found" });
    }
    const actor = await input.authorizedActor(request).catch(() => null);
    if (actor === null) return response(404, { ok: false, error: "not_found" });
    try {
      const headResult = await input.database.prepare(
        `/*md485-capacity-head*/ SELECT sequence, chunk_count, payload_chars, updated_at
         FROM md_metadata_snapshot_heads WHERE singleton_id = 1`,
      ).all<HeadRow>();
      const head = headResult.results?.[0];
      if (headResult.success === false || head === undefined ||
          head.chunk_count < 1 || head.chunk_count > 256 ||
          head.payload_chars > 25_000_000) throw new Error("snapshot unavailable");
      const chunkResult = await input.database.prepare(
        `/*md485-capacity-chunks*/ SELECT chunk_index, payload_json
         FROM md_metadata_snapshot_chunks WHERE sequence = ?1 ORDER BY chunk_index ASC`,
      ).bind(head.sequence).all<ChunkRow>();
      const chunks = chunkResult.results ?? [];
      if (chunkResult.success === false || chunks.length !== head.chunk_count ||
          chunks.some((chunk, index) => chunk.chunk_index !== index)) {
        throw new Error("snapshot incomplete");
      }
      const encoded = chunks.map((chunk) => chunk.payload_json).join("");
      if (encoded.length !== head.payload_chars) throw new Error("snapshot length mismatch");
      const snapshot = object(JSON.parse(encoded));
      const metadata = object(snapshot?.metadata);
      if (snapshot?.v !== 1 || metadata === null) throw new Error("snapshot invalid");
      const historicalStatsResult = await input.database.prepare(
        `/*md485-capacity-historical-stats*/ SELECT COUNT(*) AS event_count,
          COALESCE(SUM(LENGTH(payload_json)), 0) AS payload_chars,
          MIN(sequence) AS first_sequence, MAX(sequence) AS last_sequence
         FROM md_metadata_events WHERE sequence BETWEEN 1269 AND 13024`,
      ).all<HistoricalStatsRow>();
      const historicalStats = historicalStatsResult.results?.[0];
      if (historicalStatsResult.success === false || historicalStats === undefined) {
        throw new Error("historical event stats unavailable");
      }
      const legacySnapshotResult = await input.database.prepare(
        `/*md485-capacity-legacy-snapshot*/ SELECT sequence, payload_json, updated_at
         FROM md_metadata_snapshots WHERE singleton_id = 1`,
      ).all<LegacySnapshotRow>();
      const legacySnapshot = legacySnapshotResult.results?.[0];
      if (legacySnapshotResult.success === false || legacySnapshot === undefined ||
          legacySnapshot.sequence !== 1268) throw new Error("legacy snapshot unavailable");
      const legacyEnvelope = object(JSON.parse(legacySnapshot.payload_json));
      const legacyMetadata = object(legacyEnvelope?.metadata);
      if (legacyEnvelope?.v !== 1 || legacyMetadata === null) {
        throw new Error("legacy snapshot invalid");
      }
      const ownedMindIds = new Set<string>();
      for (const [, entry] of pairs(metadata.memberships)) {
        const membership = object(entry);
        if (membership?.principalId === actor.principalId &&
            membership.state === "active" && membership.role === "owner" &&
            typeof membership.spaceId === "string") ownedMindIds.add(membership.spaceId);
      }
      if (!ownedMindIds.has(actor.mindId)) throw new Error("ownership changed");

      const snapshotReservations = new Map<string, Record<string, unknown>>();
      for (const [id, entry] of pairs(metadata.capacityReservations)) {
        const reservation = object(entry);
        if (typeof id === "string" && reservation !== null) {
          snapshotReservations.set(id, reservation);
        }
      }

      const eventResult = await input.database.prepare(
        `/*md485-capacity-events*/ SELECT sequence, payload_json, committed_at
         FROM md_metadata_events
         WHERE committed_at >= ?1 AND committed_at < ?2 AND target = 'metadata'
           AND (instr(payload_json, 'capacity:') > 0 OR
                instr(payload_json, '"heavy":true') > 0 OR
                instr(payload_json, '"method":"completeExportJob"') > 0 OR
                instr(payload_json, '"method":"expireExportJob"') > 0 OR
                instr(payload_json, '"method":"completeExpiredExportCleanup"') > 0 OR
                instr(payload_json, '"method":"collectExpiredCapacityReservations"') > 0)
         ORDER BY sequence ASC LIMIT ?3`,
      ).bind(FROM, AT, MAX_EVENTS + 1).all<EventRow>();
      const rows = eventResult.results ?? [];
      if (eventResult.success === false || rows.length > MAX_EVENTS) {
        throw new Error("event scan unavailable");
      }
      const observed = rows.map((row) => {
        const event = object(JSON.parse(row.payload_json));
        return { sequence: row.sequence, committedAt: row.committed_at,
          calls: calls(event) };
      });

      const admissions: Array<{
        id: string;
        spaceId: string;
        operation: string;
        operationRef: string | null;
        createdAt: string;
        expiresAt: string;
        sequence: number;
        confirmedInTransaction: boolean;
      }> = [];
      for (const event of observed) {
        for (const call of event.calls) {
          if (call.method !== "admitCapacityReservation") continue;
          const requestArgs = firstArg(call);
          const id = safeId(requestArgs?.reservationId);
          if (requestArgs?.heavy !== true || id === null ||
              typeof requestArgs.spaceId !== "string" ||
              typeof requestArgs.createdAt !== "string" ||
              typeof requestArgs.expiresAt !== "string") continue;
          admissions.push({
            id, spaceId: requestArgs.spaceId,
            operation: String(requestArgs.operation ?? "unknown"),
            operationRef: safeId(requestArgs.operationRef),
            createdAt: requestArgs.createdAt, expiresAt: requestArgs.expiresAt,
            sequence: event.sequence,
            confirmedInTransaction: event.calls.some((candidate) =>
              candidate.method === "createExportJob" ||
              candidate.method === "createMarkdownImportSession"),
          });
        }
      }
      const uniqueById = new Map<string, typeof admissions[number]>();
      for (const item of admissions) {
        const existing = uniqueById.get(item.id);
        if (existing === undefined ||
            (item.confirmedInTransaction && !existing.confirmedInTransaction)) {
          uniqueById.set(item.id, item);
        }
      }
      const unique = [...uniqueById.values()];
      const byScope = { target: 0, owned_other: 0, site_other: 0 };
      const confirmed = { target: 0, owned_other: 0, site_other: 0 };
      const confirmedNoTerminalUnexpired = { target: 0, owned_other: 0, site_other: 0 };
      const confirmedWithTerminalCall = { target: 0, owned_other: 0, site_other: 0 };
      const confirmedExpiredBeforeCutoff = { target: 0, owned_other: 0, site_other: 0 };
      const confirmedOperations = {
        target: { export: 0, import: 0, stage: 0, other: 0 },
        owned_other: { export: 0, import: 0, stage: 0, other: 0 },
        site_other: { export: 0, import: 0, stage: 0, other: 0 },
      };
      const existingAtSnapshot = { target: 0, owned_other: 0, site_other: 0 };
      const owned: Record<string, unknown>[] = [];
      for (const item of unique) {
        const scope = item.spaceId === actor.mindId ? "target" :
          ownedMindIds.has(item.spaceId) ? "owned_other" : "site_other";
        byScope[scope] += 1;
        const laterStage = observed.some((event) => event.sequence > item.sequence &&
          event.calls.some((call) => call.method === "createStagedBundleFile" &&
            firstArg(call)?.capacityReservationId === item.id));
        const confirmedCreate = item.confirmedInTransaction || laterStage;
        const atSnapshot = snapshotReservations.get(item.id);
        if (atSnapshot !== undefined) existingAtSnapshot[scope] += 1;
        const lifecycleCalls = observed.flatMap((event) =>
          event.sequence <= item.sequence ? [] : event.calls.flatMap((call) => {
            const args = firstArg(call);
            const directId = args?.reservationId === item.id &&
              ["consumeCapacityReservation", "cancelCapacityReservation",
                "releaseCapacityReservation"].includes(String(call.method));
            const jobId = Array.isArray(call.args) && call.args[0] === item.operationRef;
            return directId || (item.operation === "export" && jobId &&
              ["completeExportJob", "expireExportJob", "completeExpiredExportCleanup"].includes(String(call.method)))
              ? [{ sequence: event.sequence, method: call.method }] : [];
          }));
        if (confirmedCreate) {
          confirmed[scope] += 1;
          const operation = item.operation === "export" || item.operation === "import" ||
            item.operation === "stage" ? item.operation : "other";
          confirmedOperations[scope][operation] += 1;
          if (lifecycleCalls.length > 0) confirmedWithTerminalCall[scope] += 1;
          if (item.expiresAt <= AT) confirmedExpiredBeforeCutoff[scope] += 1;
          if (lifecycleCalls.length === 0 && item.expiresAt > AT) {
            confirmedNoTerminalUnexpired[scope] += 1;
          }
        }
        if (scope !== "target") continue;
        owned.push({ reservation_id: item.id, operation: item.operation,
          scope, sequence: item.sequence, created_at: item.createdAt,
          expires_at: item.expiresAt, confirmed_create: confirmedCreate,
          state_at_snapshot: atSnapshot?.state ?? null,
          updated_at_snapshot: atSnapshot?.updatedAt ?? null,
          lifecycle_calls_before_incident: lifecycleCalls.slice(0, 20),
        });
      }
      const older = { target: 0, owned_other: 0, site_other: 0 };
      const olderStateActiveAtSnapshot = { target: 0, owned_other: 0, site_other: 0 };
      for (const reservation of snapshotReservations.values()) {
        if (reservation.heavy !== true ||
            typeof reservation.createdAt !== "string" ||
            reservation.createdAt >= FROM ||
            typeof reservation.spaceId !== "string") continue;
        const scope = reservation.spaceId === actor.mindId ? "target" :
          ownedMindIds.has(reservation.spaceId) ? "owned_other" : "site_other";
        older[scope] += 1;
        if (reservation.state === "active") olderStateActiveAtSnapshot[scope] += 1;
      }
      return response(200, { ok: true, data: {
        incident: "MD-485/UAT191", from_utc: FROM, before_utc: AT,
        historical_replay_feasibility: {
          checkpoint_sequence: legacySnapshot.sequence,
          checkpoint_updated_at: legacySnapshot.updated_at,
          checkpoint_payload_chars: legacySnapshot.payload_json.length,
          metadata_snapshot_version: legacyMetadata.v ?? null,
          checkpoint_heavy_reservations: pairs(legacyMetadata.capacityReservations)
            .filter(([, value]) => object(value)?.heavy === true).length,
          event_count: historicalStats.event_count,
          event_payload_chars: historicalStats.payload_chars,
          first_sequence: historicalStats.first_sequence,
          last_sequence: historicalStats.last_sequence,
          contiguous_by_count: historicalStats.event_count === 11756 &&
            historicalStats.first_sequence === 1269 && historicalStats.last_sequence === 13024,
        },
        snapshot_sequence: head.sequence, snapshot_updated_at: head.updated_at,
        events_scanned: rows.length,
        distinct_heavy_admission_ids_seen: byScope,
        creation_confirmed_by_followup: confirmed,
        confirmed_operations: confirmedOperations,
        confirmed_without_terminal_call_unexpired_at_cutoff: confirmedNoTerminalUnexpired,
        confirmed_with_terminal_call_before_cutoff: confirmedWithTerminalCall,
        confirmed_expired_before_cutoff: confirmedExpiredBeforeCutoff,
        expiry_collector_calls_in_window: observed.reduce((total, event) => total +
          event.calls.filter((call) => call.method === "collectExpiredCapacityReservations").length, 0),
        present_in_snapshot_ledger: existingAtSnapshot,
        older_than_window_in_snapshot_ledger: older,
        older_than_window_state_active_at_snapshot: olderStateActiveAtSnapshot,
        target_reservations: owned,
        limits_at_incident: { mind: 1, owner: 2, site: 8 },
        interpretation: "Events list committed callbacks' attempted calls, not return values; failed import admission can be absent. Confirmed create follows an export/import admission in the same transaction or a later stage record. Terminal calls are observed calls, not proof of successful state transitions. Ledger and memberships are as of snapshot_sequence, may lag the latest event, and are not historical state at the incident. A snapshot state of active can be expired by time. IDs are disclosed only for the currently owner-authorized target Mind.",
      } });
    } catch {
      return response(503, { ok: false, error: "diagnostic_unavailable" });
    }
  };
}
