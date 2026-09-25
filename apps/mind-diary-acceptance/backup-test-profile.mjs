// Acceptance-owned transient tables are never portable Mind Diary records.
// The common backup schema validator still checks every live table and column.
export const ACCEPTANCE_BACKUP_EXTRA_D1_SCHEMA = Object.freeze({
  md_acceptance_runs: "id request_key actor_count profile created_at expires_at state",
  md_acceptance_actors: "id run_id ordinal subject principal_id revoked",
  md_acceptance_exchanges: "verifier run_id actor_id audience expires_at used_at",
  md_acceptance_sessions: "verifier run_id actor_id audience expires_at revoked",
  md_acceptance_external_mcp: "run_id actor_id expires_at revoked",
  md_acceptance_export_holds: "run_id principal_id space_id expires_at",
  md_acceptance_cleanup_locks: "run_id holder expires_at",
  md_acceptance_cleanup_journal: "actor_id command_json result_json done",
  md_acceptance_cleanup_receipts: "run_id receipt_json",
  md_acceptance_telemetry: "run_id correlation_id event_index candidate_sha adapter_sha256 event_json_0 event_json_1 event_json_2 event_json_3",
  md_acceptance_probe: "id marker",
});
