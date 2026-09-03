import {
  PILOT_COHORTS,
  PRIVACY_SAFE_OBSERVABILITY_OPERATIONS,
  PRIVACY_SAFE_OBSERVABILITY_OUTCOMES,
  PRIVACY_SAFE_OBSERVABILITY_SURFACES,
  PRIVACY_SAFE_OBSERVABILITY_UNITS,
  PRIVACY_SAFE_OPERATIONAL_METRICS,
  PRIVACY_SAFE_PILOT_METRICS,
  type AuditEvent,
  type AuditSink,
  type PrivacySafeObservabilityEvent,
  type PrivacySafeObservabilityMetric,
  type PrivacySafeObservabilitySink,
  type PrivacySafeObservabilityUnit,
} from "@mind-diary/application-ports";

export const AUDIT_ADAPTER = "memory-idempotent-delivery" as const;
export type AuditAdapterContract = AuditSink;
export const OBSERVABILITY_ADAPTER = "memory-privacy-safe-metrics" as const;

function cloneEvent(event: Readonly<AuditEvent>): Readonly<AuditEvent> {
  return Object.freeze({
    ...event,
    actor: Object.freeze({ ...event.actor }),
    safeMetadata: Object.freeze({ ...event.safeMetadata }),
  });
}

/** Test/local sink with durable-id semantics and no payload logging. */
export class InMemoryAuditSink implements AuditSink {
  readonly kind = "audit-sink" as const;
  readonly #delivered = new Map<AuditEvent["auditEventId"], Readonly<AuditEvent>>();
  #nextFailure: Error | null = null;

  async deliver(event: Readonly<AuditEvent>): Promise<"delivered" | "duplicate"> {
    if (this.#delivered.has(event.auditEventId)) return "duplicate";
    if (this.#nextFailure) {
      const failure = this.#nextFailure;
      this.#nextFailure = null;
      throw failure;
    }
    this.#delivered.set(event.auditEventId, cloneEvent(event));
    return "delivered";
  }

  async purgeSpace(spaceId: NonNullable<AuditEvent["spaceId"]>): Promise<number> {
    const ids = [...this.#delivered]
      .filter(([, event]) => event.spaceId === spaceId)
      .map(([id]) => id);
    ids.forEach((id) => this.#delivered.delete(id));
    return ids.length;
  }

  async tombstonePrincipal(
    principalId: Extract<AuditEvent["actor"], { kind: "principal" }>["principalId"],
    deletedPrincipalId: Extract<
      AuditEvent["actor"],
      { kind: "deleted-principal" }
    >["opaqueId"],
  ): Promise<number> {
    let changed = 0;
    for (const [id, event] of this.#delivered) {
      if (
        event.actor.kind !== "principal" ||
        event.actor.principalId !== principalId
      ) {
        continue;
      }
      this.#delivered.set(
        id,
        cloneEvent({
          ...event,
          actor: Object.freeze({
            kind: "deleted-principal" as const,
            opaqueId: deletedPrincipalId,
          }),
        }),
      );
      changed += 1;
    }
    return changed;
  }

  deliveredForTest(): readonly Readonly<AuditEvent>[] {
    return Object.freeze([...this.#delivered.values()].map(cloneEvent));
  }

  failNextDeliveryForTest(error: Error = new Error("injected audit delivery failure")): void {
    this.#nextFailure = error;
  }
}

const EVENT_KEYS = Object.freeze([
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
const EVENT_KEY_SET = new Set<string>(EVENT_KEYS);
const OPERATIONAL_METRICS = new Set<string>(PRIVACY_SAFE_OPERATIONAL_METRICS);
const PILOT_METRICS = new Set<string>(PRIVACY_SAFE_PILOT_METRICS);
const SURFACES = new Set<string>(PRIVACY_SAFE_OBSERVABILITY_SURFACES);
const OPERATIONS = new Set<string>(PRIVACY_SAFE_OBSERVABILITY_OPERATIONS);
const OUTCOMES = new Set<string>(PRIVACY_SAFE_OBSERVABILITY_OUTCOMES);
const UNITS = new Set<string>(PRIVACY_SAFE_OBSERVABILITY_UNITS);
const COHORTS = new Set<string>(PILOT_COHORTS);
const REQUEST_ID = /^(?:req|request)_[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const JOB_ID = /^(?:job|export|index|audit|invitation|deletion)_[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

const METRIC_UNITS: Readonly<Record<PrivacySafeObservabilityMetric, PrivacySafeObservabilityUnit>> =
  Object.freeze({
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

export class UnsafeObservabilityEventError extends TypeError {
  constructor() {
    super("privacy-safe observability event rejected");
    this.name = "UnsafeObservabilityEventError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeUtcInstant(value: unknown): boolean {
  return (
    typeof value === "string" &&
    UTC_INSTANT.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function safeCorrelation(
  value: unknown,
  pattern: RegExp,
): value is string | null {
  return value === null || (typeof value === "string" && pattern.test(value));
}

function validateEvent(value: unknown): asserts value is PrivacySafeObservabilityEvent {
  if (!isRecord(value)) throw new UnsafeObservabilityEventError();
  const keys = Object.keys(value);
  if (
    keys.length !== EVENT_KEYS.length ||
    keys.some((key) => !EVENT_KEY_SET.has(key))
  ) {
    throw new UnsafeObservabilityEventError();
  }
  const metric = value.metric;
  const operational = typeof metric === "string" && OPERATIONAL_METRICS.has(metric);
  const pilot = typeof metric === "string" && PILOT_METRICS.has(metric);
  if (
    (value.kind !== "operational" && value.kind !== "pilot") ||
    (value.kind === "operational" && !operational) ||
    (value.kind === "pilot" && !pilot) ||
    typeof metric !== "string" ||
    !SURFACES.has(String(value.surface)) ||
    !OPERATIONS.has(String(value.operation)) ||
    !OUTCOMES.has(String(value.outcome)) ||
    !UNITS.has(String(value.unit)) ||
    METRIC_UNITS[metric as PrivacySafeObservabilityMetric] !== value.unit ||
    typeof value.value !== "number" ||
    !Number.isFinite(value.value) ||
    value.value < 0 ||
    value.value > Number.MAX_SAFE_INTEGER ||
    (value.unit === "ratio" && value.value > 1) ||
    !safeUtcInstant(value.occurredAtUtc) ||
    !safeCorrelation(value.requestId, REQUEST_ID) ||
    !safeCorrelation(value.jobId, JOB_ID) ||
    (value.kind === "operational" && value.cohort !== null) ||
    (value.kind === "pilot" &&
      (typeof value.cohort !== "string" || !COHORTS.has(value.cohort)))
  ) {
    throw new UnsafeObservabilityEventError();
  }
}

function cloneObservabilityEvent(
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

export interface PrivacySafeMetricAggregate {
  readonly metric: PrivacySafeObservabilityMetric;
  readonly surface: PrivacySafeObservabilityEvent["surface"];
  readonly operation: PrivacySafeObservabilityEvent["operation"];
  readonly outcome: PrivacySafeObservabilityEvent["outcome"];
  readonly unit: PrivacySafeObservabilityUnit;
  readonly cohort: PrivacySafeObservabilityEvent["cohort"];
  readonly samples: number;
  readonly total: number;
  readonly maximum: number;
}

export type PrivacySafeAlertCode =
  | "request_errors_present"
  | "authentication_failures_present"
  | "cas_conflicts_present"
  | "index_lag_present"
  | "export_lag_present"
  | "rate_limits_present";

/** In-memory pilot/dashboard adapter that stores only the closed safe projection. */
export class InMemoryPrivacySafeObservabilitySink
  implements PrivacySafeObservabilitySink
{
  readonly kind = "privacy-safe-observability-sink" as const;
  readonly #events: PrivacySafeObservabilityEvent[] = [];

  record(event: Readonly<PrivacySafeObservabilityEvent>): void {
    validateEvent(event);
    this.#events.push(cloneObservabilityEvent(event));
  }

  eventsForTest(): readonly Readonly<PrivacySafeObservabilityEvent>[] {
    return Object.freeze(this.#events.map(cloneObservabilityEvent));
  }

  dashboard(): Readonly<{
    metrics: readonly Readonly<PrivacySafeMetricAggregate>[];
    alerts: readonly PrivacySafeAlertCode[];
    correlations: readonly Readonly<{
      requestId: PrivacySafeObservabilityEvent["requestId"];
      jobId: PrivacySafeObservabilityEvent["jobId"];
      metric: PrivacySafeObservabilityMetric;
      outcome: PrivacySafeObservabilityEvent["outcome"];
    }>[];
  }> {
    const aggregates = new Map<string, PrivacySafeMetricAggregate>();
    for (const event of this.#events) {
      const key = [
        event.metric,
        event.surface,
        event.operation,
        event.outcome,
        event.unit,
        event.cohort ?? "none",
      ].join("|");
      const current = aggregates.get(key);
      aggregates.set(
        key,
        Object.freeze({
          metric: event.metric,
          surface: event.surface,
          operation: event.operation,
          outcome: event.outcome,
          unit: event.unit,
          cohort: event.cohort,
          samples: (current?.samples ?? 0) + 1,
          total: (current?.total ?? 0) + event.value,
          maximum: Math.max(current?.maximum ?? 0, event.value),
        }),
      );
    }
    const alerts = new Set<PrivacySafeAlertCode>();
    for (const event of this.#events) {
      if (event.metric === "request_error" && event.value > 0) {
        alerts.add("request_errors_present");
      }
      if (
        event.metric === "authentication_outcome" &&
        (event.outcome === "failure" || event.outcome === "denied")
      ) {
        alerts.add("authentication_failures_present");
      }
      if (event.metric === "cas_conflict" && event.value > 0) {
        alerts.add("cas_conflicts_present");
      }
      if (event.metric === "index_lag_ms" && event.value > 0) {
        alerts.add("index_lag_present");
      }
      if (event.metric === "export_lag_ms" && event.value > 0) {
        alerts.add("export_lag_present");
      }
      if (event.metric === "rate_limit" && event.value > 0) {
        alerts.add("rate_limits_present");
      }
    }
    return Object.freeze({
      metrics: Object.freeze([...aggregates.values()]),
      alerts: Object.freeze([...alerts]),
      correlations: Object.freeze(
        this.#events.map((event) =>
          Object.freeze({
            requestId: event.requestId,
            jobId: event.jobId,
            metric: event.metric,
            outcome: event.outcome,
          }),
        ),
      ),
    });
  }
}
