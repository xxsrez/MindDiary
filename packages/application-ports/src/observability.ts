import type {
  ActorContext,
} from "@mind-diary/application-contracts";

import {
  type AuditEvent,
  type DeletedPrincipalId,
  type PrincipalId,
  type JobId,
  type SpaceId,
  type UtcInstant,
} from "@mind-diary/domain";

export interface AuditSink {
  readonly kind: "audit-sink";
  /** Delivery is idempotent by auditEventId. */
  deliver(event: Readonly<AuditEvent>): Promise<"delivered" | "duplicate">;
  /** Delete-all policy removes delivered events still linked to the target Space. */
  purgeSpace(spaceId: SpaceId): Promise<number>;
  /** Retained foreign-Space events lose the deleted account's principal identity. */
  tombstonePrincipal(
    principalId: PrincipalId,
    deletedPrincipalId: DeletedPrincipalId,
  ): Promise<number>;
}

/**
 * Closed telemetry vocabulary. Events intentionally have no free-form labels,
 * payload, query, URL, email, token, principal, Space, or content fields.
 */
export const PRIVACY_SAFE_OPERATIONAL_METRICS = [
  "request_latency_ms",
  "request_error",
  "authentication_outcome",
  "cas_conflict",
  "index_lag_ms",
  "export_lag_ms",
  "invitation_expiry_lag_ms",
  "invitation_outcome",
  "token_outcome",
  "deletion_outcome",
  "rate_limit",
  "storage_cost_bytes",
  "query_cost_units",
  "cleanup_queue_age_ms",
  "cleanup_reclaimed_bytes",
  "cleanup_orphan_count",
  "cleanup_retry_count",
  "cleanup_failure_count",
] as const;

export const PRIVACY_SAFE_PILOT_METRICS = [
  "setup_completion",
  "time_to_first_useful_search_ms",
  "time_to_first_meaningful_commit_ms",
  "usage",
  "retention",
  "lexical_search_effectiveness",
  "citation_success",
] as const;

export const PRIVACY_SAFE_OBSERVABILITY_SURFACES = [
  "control",
  "content",
  "background",
  "mcp",
] as const;

export const PRIVACY_SAFE_OBSERVABILITY_OPERATIONS = [
  "request",
  "home",
  "authentication",
  "mcp_modern",
  "mcp_compatibility",
  "stage_authentication",
  "stage_application",
  "stage_total",
  "list_minds",
  "resolve_mind",
  "get_mind_info",
  "get_personal_mind_configuration",
  "set_personal_mind_description",
  "get_mind_bindings",
  "get_file_ingress_capabilities",
  "open_bundle_file_picker",
  "create_file_upload_intent",
  "browse_entries",
  "fetch",
  "list_files",
  "grep_files",
  "read_files",
  "list_revisions",
  "get_revision",
  "validate_mind",
  "set_read_mind_binding",
  "set_write_mind_binding",
  "stage_bundle_file",
  "reconcile_file_stage",
  "list_bundle_files",
  "get_bundle_file_download",
  "capture_knowledge",
  "enqueue_note",
  "get_note_status",
  "start_export",
  "get_export_status",
  "commit_changeset",
  "reconcile_changeset",
  "revision_index",
  "export",
  "invitation",
  "token",
  "deletion",
  "rate_limit",
  "setup",
  "retention_week_1",
  "retention_week_4",
  "search",
  "read",
  "write",
  "history",
  "storage",
  "cleanup",
  "recovery_index_gaps",
  "recovery_index_dispatch",
  "recovery_invitation_expiry_dispatch",
  "recovery_export_dispatch",
  "recovery_staging_cleanup",
  "recovery_import_cleanup",
  "recovery_object_cleanup",
  "recovery_total",
  "citation",
] as const;

export const PRIVACY_SAFE_OBSERVABILITY_OUTCOMES = [
  "success",
  "failure",
  "denied",
  "conflict",
  "retry",
  "replayed",
  "rate_limited",
  "unavailable",
  "completed",
  "due",
  "claimed",
  "retried",
  "retained",
  "resolved",
  "unresolved",
] as const;

export const PRIVACY_SAFE_OBSERVABILITY_UNITS = [
  "count",
  "milliseconds",
  "bytes",
  "query_units",
  "ratio",
] as const;

export const PILOT_COHORTS = ["close_circle", "external"] as const;

export type PrivacySafeOperationalMetric =
  (typeof PRIVACY_SAFE_OPERATIONAL_METRICS)[number];
export type PrivacySafePilotMetric =
  (typeof PRIVACY_SAFE_PILOT_METRICS)[number];
export type PrivacySafeObservabilityMetric =
  | PrivacySafeOperationalMetric
  | PrivacySafePilotMetric;
export type PrivacySafeObservabilitySurface =
  (typeof PRIVACY_SAFE_OBSERVABILITY_SURFACES)[number];
export type PrivacySafeObservabilityOperation =
  (typeof PRIVACY_SAFE_OBSERVABILITY_OPERATIONS)[number];
export type PrivacySafeObservabilityOutcome =
  (typeof PRIVACY_SAFE_OBSERVABILITY_OUTCOMES)[number];
export type PrivacySafeObservabilityUnit =
  (typeof PRIVACY_SAFE_OBSERVABILITY_UNITS)[number];
export type PilotCohort = (typeof PILOT_COHORTS)[number];

export interface PrivacySafeObservabilityEvent {
  readonly kind: "operational" | "pilot";
  readonly metric: PrivacySafeObservabilityMetric;
  readonly surface: PrivacySafeObservabilitySurface;
  readonly operation: PrivacySafeObservabilityOperation;
  readonly outcome: PrivacySafeObservabilityOutcome;
  readonly unit: PrivacySafeObservabilityUnit;
  readonly value: number;
  readonly occurredAtUtc: UtcInstant;
  readonly requestId: ActorContext["requestId"] | null;
  readonly jobId: JobId | null;
  readonly cohort: PilotCohort | null;
}

/** Best-effort telemetry must never participate in an authoritative transaction. */
export interface PrivacySafeObservabilitySink {
  readonly kind: "privacy-safe-observability-sink";
  record(event: Readonly<PrivacySafeObservabilityEvent>): void | Promise<void>;
}
