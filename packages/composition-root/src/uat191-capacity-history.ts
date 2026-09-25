import type { D1DatabaseLike } from "@mind-diary/adapter-metadata-sites";
import { InMemoryRevisionMetadataStore } from "@mind-diary/adapter-metadata-memory";
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
interface ReplayRow {
  readonly sequence: number;
  readonly target: string;
  readonly operation: string;
  readonly payload_json: string;
  readonly committed_at: string;
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

function revive<T>(payload: string): T {
  return JSON.parse(payload, (_key, value: unknown) => {
    const tagged = object(value);
    if (tagged?.__md_sites_type === "undefined") return undefined;
    if (tagged?.__md_sites_type === "uint8array" && Array.isArray(tagged.bytes)) {
      return Uint8Array.from(tagged.bytes as number[]);
    }
    if (tagged?.__md_sites_type === "map" && Array.isArray(tagged.entries)) {
      return new Map(tagged.entries as readonly (readonly [unknown, unknown])[]);
    }
    if (tagged?.__md_sites_type === "set" && Array.isArray(tagged.values)) {
      return new Set(tagged.values);
    }
    return value;
  }) as T;
}

function callable(target: object, method: string): (...args: unknown[]) => unknown {
  const candidate = Reflect.get(target, method) as unknown;
  if (typeof candidate !== "function") throw new Error("historical method unavailable");
  return candidate.bind(target) as (...args: unknown[]) => unknown;
}

async function replayHistoricalCapacity(input: {
  database: D1DatabaseLike;
  checkpointJson: string;
  principalId: string;
  mindId: string;
}): Promise<Record<string, unknown>> {
  const checkpoint = revive<Record<string, unknown>>(input.checkpointJson);
  const metadata = InMemoryRevisionMetadataStore.fromDurableSnapshot(checkpoint.metadata);
  const endSequence = 13025;
  let nextSequence = 1269;
  let tokenEventsSkipped = 0;
  let replayStage = "read_page";
  let beforeExport: Record<string, unknown> | null = null;
  let exportAdmission: Record<string, unknown> | null = null;
  try {
  while (nextSequence <= endSequence) {
    const result = await input.database.prepare(
      `/*md485-capacity-replay*/ SELECT sequence, target, operation, payload_json, committed_at
       FROM md_metadata_events WHERE sequence >= ?1 AND sequence <= ?2
       ORDER BY sequence ASC LIMIT 512`,
    ).bind(nextSequence, endSequence).all<ReplayRow>();
    const rows = result.results ?? [];
    if (result.success === false || rows.length === 0) {
      throw new Error("historical replay gap");
    }
    for (const row of rows) {
      replayStage = "validate_event";
      if (row.sequence !== nextSequence) throw new Error("historical replay gap");
      const event = revive<Record<string, unknown>>(row.payload_json);
      if (event.v !== 1 || event.target !== row.target || event.method !== row.operation) {
        throw new Error("historical event envelope invalid");
      }
      if (row.sequence === endSequence) {
        replayStage = "incident_identity";
        const targetCalls = calls(event).filter((call) => {
          const args = firstArg(call);
          return call.method === "admitCapacityReservation" &&
            args?.spaceId === input.mindId && args.operation === "export" &&
            args.createdAt === AT;
        });
        if (row.target !== "metadata" || event.kind !== "transaction" ||
            row.operation !== "runExportStartTransaction" ||
            row.committed_at !== AT || targetCalls.length !== 1) {
          throw new Error("incident event identity mismatch");
        }
        replayStage = "incident_state";
        const state = object(metadata.exportDurableSnapshot());
        const reservations = state?.capacityReservations;
        const memberships = state?.memberships;
        if (!(reservations instanceof Map) || !(memberships instanceof Map)) {
          throw new Error("historical replay state unavailable");
        }
        const ownedMindIds = new Set<string>([input.mindId]);
        for (const value of memberships.values()) {
          const membership = object(value);
          if (membership?.principalId === input.principalId &&
              membership.state === "active" && membership.role === "owner" &&
              typeof membership.spaceId === "string") {
            ownedMindIds.add(membership.spaceId);
          }
        }
        const active = [...reservations.values()].filter((value) => {
          const reservation = object(value);
          return reservation?.state === "active" && reservation.heavy === true;
        });
        const target = active.filter((value) => object(value)?.spaceId === input.mindId);
        const owned = active.filter((value) =>
          ownedMindIds.has(String(object(value)?.spaceId)));
        beforeExport = {
          active_heavy_target: target.length,
          active_heavy_owner: owned.length,
          active_heavy_site: active.length,
          expired_active_target: target.filter((value) =>
            String(object(value)?.expiresAt) <= AT).length,
          expired_active_owner: owned.filter((value) =>
            String(object(value)?.expiresAt) <= AT).length,
          expired_active_site: active.filter((value) =>
            String(object(value)?.expiresAt) <= AT).length,
          holders_by_scope: {
            target: target.length,
            owned_other: owned.length - target.length,
            site_other: active.length - owned.length,
          },
          target_reservations: target.map((value) => {
            const reservation = object(value);
            return { reservation_id: reservation?.reservationId,
              operation: reservation?.operation, state: reservation?.state,
              created_at: reservation?.createdAt, expires_at: reservation?.expiresAt };
          }),
        };
      }
      if (row.target === "tokens") {
        tokenEventsSkipped += 1;
      } else if (row.target === "metadata" && event.kind === "direct") {
        replayStage = "apply_metadata";
        await callable(metadata, String(event.method))(...event.args as unknown[]);
      } else if (row.target === "metadata" && event.kind === "transaction") {
        replayStage = "apply_metadata";
        await callable(metadata, String(event.method))(async (transaction: object) => {
          let last: unknown;
          for (const call of event.calls as Array<Record<string, unknown>>) {
            last = await callable(transaction, String(call.method))(...call.args as unknown[]);
            if (row.sequence === endSequence && call.method === "admitCapacityReservation" &&
                firstArg(call)?.spaceId === input.mindId) {
              const admission = object(last);
              exportAdmission = { kind: admission?.kind ?? null,
                reason: admission?.reason ?? null };
            }
          }
          return last;
        });
      } else {
        throw new Error("historical event kind invalid");
      }
      nextSequence += 1;
      replayStage = "read_page";
    }
  }
  } catch {
    return { status: "incompatible_or_unavailable",
      last_contiguous_sequence: nextSequence - 1, failed_stage: replayStage,
      limitation: "Read-only replay did not complete; no historical holder is inferred." };
  }
  return { status: "replayed_under_current_semantics", from_sequence: 1268,
    through_sequence: endSequence, metadata_events_replayed: endSequence - 1268 - tokenEventsSkipped,
    token_events_skipped: tokenEventsSkipped, before_export: beforeExport,
    export_admission_under_current_semantics: exportAdmission,
    limitation: "Current metadata-store behavior can differ from the UAT191 artifact; this replay is a diagnostic comparison, not historical proof until semantics are reconciled." };
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
  /** Unit-only replay switch; live UAT uses bounded ledger projection. */
  readonly replay?: boolean;
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
      let historicalReplay: Record<string, unknown> = {
        status: "skipped_after_hosted_timeout",
        limitation: "Full replay exceeded the UAT request deadline; no historical holder is inferred.",
      };
      if (input.replay === true) {
        try {
          historicalReplay = await replayHistoricalCapacity({ database: input.database,
            checkpointJson: legacySnapshot.payload_json,
            principalId: actor.principalId, mindId: actor.mindId });
        } catch {
          historicalReplay = { status: "incompatible_or_unavailable",
            limitation: "The temporary read-only replay did not complete; no historical holder is inferred." };
        }
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
      const possibleActiveAtCutoff = { target: 0, owned_other: 0, site_other: 0 };
      const lastTransitionBeforeCutoffNonactive = { target: 0, owned_other: 0, site_other: 0 };
      const possibleExpiredAtCutoff = { target: 0, owned_other: 0, site_other: 0 };
      const snapshotRowsCreatedAfterCutoff = { target: 0, owned_other: 0, site_other: 0 };
      const targetCandidates: Record<string, unknown>[] = [];
      for (const reservation of snapshotReservations.values()) {
        if (reservation.heavy !== true ||
            typeof reservation.createdAt !== "string" ||
            typeof reservation.spaceId !== "string") continue;
        const scope = reservation.spaceId === actor.mindId ? "target" :
          ownedMindIds.has(reservation.spaceId) ? "owned_other" : "site_other";
        if (reservation.createdAt < FROM) {
          older[scope] += 1;
          if (reservation.state === "active") olderStateActiveAtSnapshot[scope] += 1;
        }
        if (reservation.createdAt >= AT) {
          snapshotRowsCreatedAfterCutoff[scope] += 1;
          continue;
        }
        if (reservation.state === "active" ||
            typeof reservation.updatedAt !== "string" || reservation.updatedAt >= AT) {
          possibleActiveAtCutoff[scope] += 1;
          if (typeof reservation.expiresAt === "string" && reservation.expiresAt <= AT) {
            possibleExpiredAtCutoff[scope] += 1;
          }
          if (scope === "target") targetCandidates.push(reservation);
        } else {
          lastTransitionBeforeCutoffNonactive[scope] += 1;
        }
      }
      if (targetCandidates.length > 10) throw new Error("too many target candidates");
      const targetCandidateTraces: Record<string, unknown>[] = [];
      for (const candidate of targetCandidates) {
        const id = safeId(candidate.reservationId);
        const ref = safeId(candidate.operationRef);
        if (id === null || ref === null) throw new Error("invalid candidate identifier");
        const relatedResult = await input.database.prepare(
          `/*md485-target-related*/ SELECT sequence, payload_json, committed_at
           FROM md_metadata_events WHERE target = 'metadata'
             AND (instr(payload_json, ?1) > 0 OR instr(payload_json, ?2) > 0)
           ORDER BY sequence ASC LIMIT 201`,
        ).bind(id, ref).all<EventRow>();
        const relatedRows = relatedResult.results ?? [];
        if (relatedResult.success === false || relatedRows.length > 200) {
          throw new Error("target event trace unavailable");
        }
        const relatedCalls = relatedRows.map((row) => {
          const event = object(JSON.parse(row.payload_json));
          return { sequence: row.sequence, committed_at: row.committed_at,
            methods: calls(event).filter((call) => {
              const args = JSON.stringify(call.args ?? []);
              return args.includes(id) || args.includes(ref);
            }).map((call) => String(call.method)).slice(0, 20) };
        }).filter((item) => item.methods.length > 0);
        const exportJobs = metadata.exportJobs;
        const job = pairs(exportJobs).map(([, value]) => object(value))
          .find((value) => value?.jobId === ref);
        targetCandidateTraces.push({ reservation_id: id, operation_ref: ref,
          operation: candidate.operation, created_at_snapshot: candidate.createdAt,
          expires_at_snapshot: candidate.expiresAt, state_at_snapshot: candidate.state,
          updated_at_snapshot: candidate.updatedAt,
          related_calls: relatedCalls,
          job_at_snapshot: job == null ? null : {
            state: job.state, version: job.version, updated_at: job.updatedAt,
            completed_at: job.completedAt, expires_at: job.expiresAt,
            archive_cleaned_at: job.archiveCleanedAt,
          } });
      }
      const collectorResult = await input.database.prepare(
        `/*md485-target-collectors*/ SELECT sequence, payload_json, committed_at
         FROM md_metadata_events WHERE target = 'metadata' AND committed_at < ?1
           AND instr(payload_json, 'collectExpiredCapacityReservations') > 0
         ORDER BY sequence ASC LIMIT 201`,
      ).bind("2026-09-21T15:41:52.951Z").all<EventRow>();
      const collectorRows = collectorResult.results ?? [];
      if (collectorResult.success === false || collectorRows.length > 200) {
        throw new Error("collector trace unavailable");
      }
      const collectorCallsBeforeImport = collectorRows.flatMap((row) => {
        const event = object(JSON.parse(row.payload_json));
        return calls(event).filter((call) =>
          call.method === "collectExpiredCapacityReservations").map(() => ({
            committed_at: row.committed_at,
          }));
      });
      const collectorCounts = {
        before_export: collectorCallsBeforeImport.filter((call) =>
          call.committed_at < AT).length,
        export_to_import: collectorCallsBeforeImport.filter((call) =>
          call.committed_at >= AT).length,
        since_target_expiry_before_export: targetCandidates.map((candidate) => ({
          reservation_id: candidate.reservationId,
          count: collectorCallsBeforeImport.filter((call) =>
            typeof candidate.expiresAt === "string" &&
            call.committed_at >= candidate.expiresAt && call.committed_at < AT).length,
        })),
      };
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
        historical_replay: historicalReplay,
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
        snapshot_rows_created_before_cutoff_possible_active: possibleActiveAtCutoff,
        snapshot_rows_created_before_cutoff_last_transition_nonactive: lastTransitionBeforeCutoffNonactive,
        snapshot_rows_created_before_cutoff_possible_expired: possibleExpiredAtCutoff,
        snapshot_rows_created_after_cutoff: snapshotRowsCreatedAfterCutoff,
        target_candidate_traces: targetCandidateTraces,
        collector_counts: collectorCounts,
        target_reservations: owned,
        limits_at_incident: { mind: 1, owner: 2, site: 8 },
        interpretation: "Events list committed callbacks' attempted calls, not return values; failed import admission can be absent. Confirmed create follows an export/import admission in the same transaction or a later stage record. Terminal calls are observed calls, not proof of successful state transitions. Ledger and memberships are as of snapshot_sequence, may lag the latest event, and are not historical state at the incident. Snapshot rows cannot exclude deleted or reacquired reservations. A snapshot state of active can be expired by time. IDs are disclosed only for the currently owner-authorized target Mind.",
      } });
    } catch {
      return response(503, { ok: false, error: "diagnostic_unavailable" });
    }
  };
}
