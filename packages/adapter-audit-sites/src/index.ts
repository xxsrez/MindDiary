import {
  PILOT_COHORTS,
  PRIVACY_SAFE_OBSERVABILITY_OPERATIONS,
  PRIVACY_SAFE_OBSERVABILITY_OUTCOMES,
  PRIVACY_SAFE_OBSERVABILITY_SURFACES,
  PRIVACY_SAFE_OBSERVABILITY_UNITS,
  PRIVACY_SAFE_OPERATIONAL_METRICS,
  PRIVACY_SAFE_PILOT_METRICS,
  type PrivacySafeObservabilityEvent,
  type PrivacySafeObservabilityMetric,
  type PrivacySafeObservabilitySink,
  type PrivacySafeObservabilityUnit,
  type AuditEvent,
  type AuditSink,
} from "@mind-diary/application-ports";

export const SITES_OBSERVABILITY_ADAPTER =
  "sites-worker-privacy-safe-observability" as const;
export const SITES_OBSERVABILITY_EVENT =
  "mind-diary.privacy-safe-observability" as const;
export const SITES_OBSERVABILITY_SCHEMA =
  "mind-diary/privacy-safe-observability/v2" as const;

const OBSERVABILITY_EVENT_KEYS = Object.freeze([
  "kind",
  "metric",
  "surface",
  "operation",
  "outcome",
  "unit",
  "value",
  "occurredAtUtc",
  "requestId",
  "jobId",
  "cohort",
] as const);
const OBSERVABILITY_EVENT_KEY_SET = new Set<string>(OBSERVABILITY_EVENT_KEYS);
const OPERATIONAL_METRICS = new Set<string>(PRIVACY_SAFE_OPERATIONAL_METRICS);
const PILOT_METRICS = new Set<string>(PRIVACY_SAFE_PILOT_METRICS);
const OBSERVABILITY_SURFACES = new Set<string>(PRIVACY_SAFE_OBSERVABILITY_SURFACES);
const OBSERVABILITY_OPERATIONS = new Set<string>(PRIVACY_SAFE_OBSERVABILITY_OPERATIONS);
const OBSERVABILITY_OUTCOMES = new Set<string>(PRIVACY_SAFE_OBSERVABILITY_OUTCOMES);
const OBSERVABILITY_UNITS = new Set<string>(PRIVACY_SAFE_OBSERVABILITY_UNITS);
const OBSERVABILITY_COHORTS = new Set<string>(PILOT_COHORTS);
const SAFE_REQUEST_ID = /^(?:req|request|background-request|download-request)[_-][A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const SAFE_JOB_ID = /^(?:(?:job(?:-[a-z]+)?)|export|index|audit|invitation|deletion)[_-][A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const SAFE_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const SAFE_BENCHMARK_CORRELATION = /^benchmark_[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;

const OBSERVABILITY_METRIC_UNITS: Readonly<
  Record<PrivacySafeObservabilityMetric, PrivacySafeObservabilityUnit>
> = Object.freeze({
  request_latency_ms: "milliseconds",
  request_error: "count",
  authentication_outcome: "count",
  cas_conflict: "count",
  index_lag_ms: "milliseconds",
  export_lag_ms: "milliseconds",
  invitation_expiry_lag_ms: "milliseconds",
  invitation_outcome: "count",
  token_outcome: "count",
  deletion_outcome: "count",
  rate_limit: "count",
  storage_cost_bytes: "bytes",
  query_cost_units: "query_units",
  cleanup_queue_age_ms: "milliseconds",
  cleanup_reclaimed_bytes: "bytes",
  cleanup_orphan_count: "count",
  cleanup_retry_count: "count",
  cleanup_failure_count: "count",
  setup_completion: "count",
  time_to_first_useful_search_ms: "milliseconds",
  time_to_first_meaningful_commit_ms: "milliseconds",
  usage: "count",
  retention: "count",
  lexical_search_effectiveness: "ratio",
  citation_success: "ratio",
});

export class UnsafeSitesObservabilityEventError extends TypeError {
  constructor() {
    super("privacy-safe Sites observability event rejected");
    this.name = "UnsafeSitesObservabilityEventError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeCorrelation(value: unknown, pattern: RegExp): value is string | null {
  return value === null || (typeof value === "string" && pattern.test(value));
}

function validateObservabilityEvent(
  value: unknown,
): asserts value is PrivacySafeObservabilityEvent {
  if (!isRecord(value)) throw new UnsafeSitesObservabilityEventError();
  const keys = Object.keys(value);
  if (
    keys.length !== OBSERVABILITY_EVENT_KEYS.length ||
    keys.some((key) => !OBSERVABILITY_EVENT_KEY_SET.has(key))
  ) {
    throw new UnsafeSitesObservabilityEventError();
  }
  const metric = value.metric;
  const operational = typeof metric === "string" && OPERATIONAL_METRICS.has(metric);
  const pilot = typeof metric === "string" && PILOT_METRICS.has(metric);
  if (
    (value.kind !== "operational" && value.kind !== "pilot") ||
    (value.kind === "operational" && !operational) ||
    (value.kind === "pilot" && !pilot) ||
    typeof metric !== "string" ||
    !OBSERVABILITY_SURFACES.has(String(value.surface)) ||
    !OBSERVABILITY_OPERATIONS.has(String(value.operation)) ||
    !OBSERVABILITY_OUTCOMES.has(String(value.outcome)) ||
    !OBSERVABILITY_UNITS.has(String(value.unit)) ||
    OBSERVABILITY_METRIC_UNITS[metric as PrivacySafeObservabilityMetric] !== value.unit ||
    typeof value.value !== "number" ||
    !Number.isFinite(value.value) ||
    value.value < 0 ||
    value.value > Number.MAX_SAFE_INTEGER ||
    (value.unit === "ratio" && value.value > 1) ||
    typeof value.occurredAtUtc !== "string" ||
    !SAFE_UTC_INSTANT.test(value.occurredAtUtc) ||
    !Number.isFinite(Date.parse(value.occurredAtUtc)) ||
    !isSafeCorrelation(value.requestId, SAFE_REQUEST_ID) ||
    !isSafeCorrelation(value.jobId, SAFE_JOB_ID) ||
    (value.kind === "operational" && value.cohort !== null) ||
    (value.kind === "pilot" &&
      (typeof value.cohort !== "string" || !OBSERVABILITY_COHORTS.has(value.cohort)))
  ) {
    throw new UnsafeSitesObservabilityEventError();
  }
}

function safeObservabilityProjection(
  event: Readonly<PrivacySafeObservabilityEvent>,
): Readonly<PrivacySafeObservabilityEvent> {
  return Object.freeze({
    kind: event.kind,
    metric: event.metric,
    surface: event.surface,
    operation: event.operation,
    outcome: event.outcome,
    unit: event.unit,
    value: event.value,
    occurredAtUtc: event.occurredAtUtc,
    requestId: event.requestId,
    jobId: event.jobId,
    cohort: event.cohort,
  });
}

export interface SitesObservabilityWriter {
  write(serializedEvent: string): void | Promise<void>;
}

export interface SitesObservabilityContext {
  readonly benchmarkCorrelationId?: (requestId: string | null) => string | null;
}

const DEFAULT_SITES_OBSERVABILITY_WRITER: SitesObservabilityWriter = Object.freeze({
  write(serializedEvent: string): void {
    console.info(serializedEvent);
  },
});

/**
 * Deployable Sites sink. It accepts only the closed event projection and emits
 * one bounded JSON line; request inputs and application payloads are impossible
 * to pass through its typed/runtime-validated boundary.
 */
export class SitesPrivacySafeObservabilitySink implements PrivacySafeObservabilitySink {
  readonly kind = "privacy-safe-observability-sink" as const;
  readonly #writer: SitesObservabilityWriter;
  readonly #benchmarkCorrelationId: (requestId: string | null) => string | null;

  constructor(
    writer: SitesObservabilityWriter = DEFAULT_SITES_OBSERVABILITY_WRITER,
    context: SitesObservabilityContext = Object.freeze({}),
  ) {
    this.#writer = writer;
    this.#benchmarkCorrelationId = context.benchmarkCorrelationId ?? (() => null);
  }

  record(event: Readonly<PrivacySafeObservabilityEvent>): void | Promise<void> {
    validateObservabilityEvent(event);
    const safe = safeObservabilityProjection(event);
    let benchmarkCorrelationId: string | null = null;
    try {
      const candidate = this.#benchmarkCorrelationId(event.requestId);
      if (candidate !== null && SAFE_BENCHMARK_CORRELATION.test(candidate)) {
        benchmarkCorrelationId = candidate;
      }
    } catch {
      benchmarkCorrelationId = null;
    }
    return this.#writer.write(JSON.stringify({
      event: SITES_OBSERVABILITY_EVENT,
      schema: SITES_OBSERVABILITY_SCHEMA,
      ...safe,
      benchmarkCorrelationId,
    }));
  }
}

export function createSitesPrivacySafeObservabilitySink(
  writer?: SitesObservabilityWriter,
  context?: SitesObservabilityContext,
): SitesPrivacySafeObservabilitySink {
  return writer === undefined
    ? new SitesPrivacySafeObservabilitySink(DEFAULT_SITES_OBSERVABILITY_WRITER, context)
    : new SitesPrivacySafeObservabilitySink(writer, context);
}

export const SITES_AUDIT_ADAPTER = "sites-d1-privacy-safe-audit" as const;
const SITES_AUDIT_SCHEMA_VERSION = 1;
const SITES_AUDIT_SCHEMA_OBJECTS = Object.freeze([
  "md_audit_schema_migrations",
  "md_delivered_audit_events",
  "md_audit_space_idx",
  "md_audit_principal_idx",
]);

export interface D1ResultLike<Row = Record<string, unknown>> {
  readonly results?: readonly Row[];
  readonly meta?: { readonly changes?: number };
}

export interface D1PreparedStatementLike {
  bind(...values: readonly unknown[]): D1PreparedStatementLike;
  run<Row = Record<string, unknown>>(): Promise<D1ResultLike<Row>>;
  all<Row = Record<string, unknown>>(): Promise<D1ResultLike<Row>>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch(statements: readonly D1PreparedStatementLike[]): Promise<readonly D1ResultLike[]>;
}

export const SITES_AUDIT_MIGRATIONS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS md_audit_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS md_delivered_audit_events (
    audit_event_id TEXT PRIMARY KEY,
    space_id TEXT,
    actor_kind TEXT NOT NULL,
    principal_id TEXT,
    event_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS md_audit_space_idx
   ON md_delivered_audit_events(space_id)`,
  `CREATE INDEX IF NOT EXISTS md_audit_principal_idx
   ON md_delivered_audit_events(principal_id)`,
]);

interface AuditRow {
  readonly audit_event_id: string;
  readonly event_json: string;
}

interface SchemaProbeRow {
  readonly name?: string;
  readonly version?: number | string;
}

function cloneEvent(event: Readonly<AuditEvent>): Readonly<AuditEvent> {
  return Object.freeze({
    ...event,
    actor: Object.freeze({ ...event.actor }),
    safeMetadata: Object.freeze({ ...event.safeMetadata }),
  });
}

function parseEvent(row: AuditRow): Readonly<AuditEvent> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.event_json);
  } catch {
    throw new Error("Sites audit event is corrupt");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("auditEventId" in parsed) ||
    (parsed as { auditEventId: unknown }).auditEventId !== row.audit_event_id
  ) {
    throw new Error("Sites audit event is corrupt");
  }
  return cloneEvent(parsed as AuditEvent);
}

/** D1 idempotent audit delivery; only the closed AuditEvent projection is stored. */
export class SitesAuditSink implements AuditSink {
  readonly kind = "audit-sink" as const;
  readonly #database: D1DatabaseLike;
  #ready: Promise<void> | null = null;

  constructor(database: D1DatabaseLike) {
    this.#database = database;
  }

  async ready(): Promise<this> {
    this.#ready ??= this.#ensureReady().catch((error) => {
      this.#ready = null;
      throw error;
    });
    await this.#ready;
    return this;
  }

  async #ensureReady(): Promise<void> {
    try {
      const result = await this.#database
        .prepare(
          `/*md-audit-schema-probe*/ SELECT name,
             (SELECT COALESCE(MAX(version), 0)
              FROM md_audit_schema_migrations) AS version
           FROM sqlite_master
           WHERE type IN ('table', 'index')
             AND name IN ('md_audit_schema_migrations',
                          'md_delivered_audit_events',
                          'md_audit_space_idx',
                          'md_audit_principal_idx')`,
        )
        .all<SchemaProbeRow>();
      const rows = result.results ?? [];
      const names = new Set(rows.map((row) => row.name));
      if (
        Number(rows[0]?.version ?? 0) >= SITES_AUDIT_SCHEMA_VERSION &&
        SITES_AUDIT_SCHEMA_OBJECTS.every((name) => names.has(name))
      ) {
        return;
      }
    } catch {
      // The migration table is absent or an older D1 adapter does not expose
      // the probe. Fall through to the idempotent schema batch below.
    }
    const statements = SITES_AUDIT_MIGRATIONS.map((sql) => this.#database.prepare(sql));
    statements.push(
      this.#database
        .prepare(
          `/*md-audit-migration*/ INSERT OR IGNORE INTO md_audit_schema_migrations
           (version, name, applied_at) VALUES (1, 'privacy-safe-audit-v1', ?1)`,
        )
        .bind(new Date().toISOString()),
    );
    await this.#database.batch(statements);
  }

  async deliver(event: Readonly<AuditEvent>): Promise<"delivered" | "duplicate"> {
    await this.ready();
    const safe = cloneEvent(event);
    const principalId = safe.actor.kind === "principal" ? safe.actor.principalId : null;
    const result = await this.#database
      .prepare(
        `/*md-audit-deliver*/ INSERT OR IGNORE INTO md_delivered_audit_events
         (audit_event_id, space_id, actor_kind, principal_id, event_json)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(
        safe.auditEventId,
        safe.spaceId,
        safe.actor.kind,
        principalId,
        JSON.stringify(safe),
      )
      .run();
    return Number(result.meta?.changes ?? 0) === 1 ? "delivered" : "duplicate";
  }

  async purgeSpace(spaceId: NonNullable<AuditEvent["spaceId"]>): Promise<number> {
    await this.ready();
    const result = await this.#database
      .prepare(`/*md-audit-purge*/ DELETE FROM md_delivered_audit_events WHERE space_id = ?1`)
      .bind(spaceId)
      .run();
    return Number(result.meta?.changes ?? 0);
  }

  async tombstonePrincipal(
    principalId: Extract<AuditEvent["actor"], { kind: "principal" }>["principalId"],
    deletedPrincipalId: Extract<
      AuditEvent["actor"],
      { kind: "deleted-principal" }
    >["opaqueId"],
  ): Promise<number> {
    await this.ready();
    const result = await this.#database
      .prepare(
        `/*md-audit-by-principal*/ SELECT audit_event_id, event_json
         FROM md_delivered_audit_events WHERE principal_id = ?1
         ORDER BY audit_event_id ASC`,
      )
      .bind(principalId)
      .all<AuditRow>();
    const statements = (result.results ?? []).map((row) => {
      const event = parseEvent(row);
      const tombstoned = cloneEvent({
        ...event,
        actor: Object.freeze({
          kind: "deleted-principal" as const,
          opaqueId: deletedPrincipalId,
        }),
      });
      return this.#database
        .prepare(
          `/*md-audit-tombstone*/ UPDATE md_delivered_audit_events
           SET actor_kind = 'deleted-principal', principal_id = NULL, event_json = ?1
           WHERE audit_event_id = ?2 AND principal_id = ?3`,
        )
        .bind(JSON.stringify(tombstoned), row.audit_event_id, principalId);
    });
    if (statements.length === 0) return 0;
    const updates = await this.#database.batch(statements);
    return updates.reduce((total, update) => total + Number(update.meta?.changes ?? 0), 0);
  }
}

export async function createSitesAuditSink(database: D1DatabaseLike): Promise<SitesAuditSink> {
  return new SitesAuditSink(database);
}
