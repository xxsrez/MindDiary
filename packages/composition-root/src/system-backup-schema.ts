// Runtime allowlist for the exact candidate. check:backup-completeness compares
// this with the source registry so a new durable table/column cannot silently
// enter a backup-capable deployment.
export const SYSTEM_BACKUP_D1_SCHEMA = Object.freeze({
  md_metadata_schema_migrations: "version name applied_at",
  md_metadata_events: "sequence target operation payload_json committed_at",
  md_metadata_snapshots: "singleton_id sequence payload_json updated_at",
  md_metadata_snapshot_heads: "singleton_id sequence chunk_count payload_chars updated_at",
  md_metadata_snapshot_chunks: "sequence chunk_index payload_json",
  md_principal_activity: "principal_id last_web_seen_at last_mcp_seen_at last_activity_at last_activity_surface last_activity_kind",
  md_search_schema_migrations: "version name applied_at",
  md_exact_revision_search: "space_id revision_id documents_json",
  md_search_documents: "space_id digest text byte_size",
  md_search_revision_documents: "space_id revision_id ordinal path digest",
  md_search_document_lexical: "space_id digest normalized_text byte_size",
  md_audit_schema_migrations: "version name applied_at",
  md_delivered_audit_events: "audit_event_id space_id actor_kind principal_id event_json",
  md_oauth_registered_clients: "id client_name redirect_uris_json grant_types_json response_types_json token_endpoint_auth_method created_at last_used_at",
  md_oauth_authorization_requests: "id principal_id client_id client_name redirect_uri resource scopes_json state code_challenge expires_at created_at",
  md_oauth_grants: "id principal_id client_id client_name resource scopes_json revoked_at created_at updated_at last_used_at connection_ref",
  md_oauth_authorization_codes: "id code_verifier grant_id principal_id client_id redirect_uri resource scopes_json code_challenge expires_at consumed_at",
  md_oauth_access_tokens: "id token_verifier grant_id principal_id client_id resource scopes_json expires_at created_at last_used_at revoked_at",
  md_oauth_refresh_tokens: "id token_verifier grant_id family_id parent_id principal_id client_id resource scopes_json expires_at created_at used_at revoked_at",
  md_mind_locator_handles: "verifier encrypted_payload expires_at created_at",
  md_local_file_upload_intents: "intent_id namespace_hash expires_at record_version record_json",
  md_backup_control: "singleton_id origin_id generation backup_sequence invalidation_epoch",
  md_backup_sessions: "session_id origin_id generation base_sequence base_digest base_session_id base_captured_at base_schema_digest mode target_sequence target_digest invalidation_epoch status created_at completed_at expires_at page_count record_count object_count manifest_digest schema_digest",
  md_backup_pages: "session_id page_index payload_json sha256 byte_size",
  md_backup_record_digests: "session_id record_key sha256",
  md_backup_inventory: "session_id object_index namespace object_key sha256 byte_size media_type",
  md_backup_cleanup_ops: "operation_id started_at",
} as const);

export function assertSystemBackupD1Schema(
  rows: readonly Readonly<{ table_name: string; column_name: string }>[],
  extraTables: Readonly<Record<string, string>> = {},
): void {
  const actual = new Map<string, Set<string>>();
  for (const row of rows) {
    if (typeof row.table_name !== "string" ||
      typeof row.column_name !== "string") {
      throw new TypeError("system backup D1 schema inventory is invalid");
    }
    const columns = actual.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    actual.set(row.table_name, columns);
  }
  const expectedTables = Object.keys(SYSTEM_BACKUP_D1_SCHEMA);
  if (Object.keys(extraTables).some((table) =>
    !table.startsWith("md_acceptance_") || expectedTables.includes(table))) {
    throw new TypeError("system backup D1 schema extra tables are invalid");
  }
  const allowedTables = { ...SYSTEM_BACKUP_D1_SCHEMA, ...extraTables };
  if ([...actual.keys()].some((table) => !Object.hasOwn(allowedTables, table)) ||
    ["md_backup_control", "md_backup_sessions", "md_backup_pages",
      "md_backup_record_digests", "md_backup_inventory",
      "md_backup_cleanup_ops", "md_metadata_events"]
      .some((table) => !actual.has(table))) {
    throw new TypeError("system backup D1 schema contains an unknown or missing required table");
  }
  for (const [table, columns] of Object.entries(allowedTables)) {
    const expected = new Set(columns.split(" "));
    const present = actual.get(table);
    if (present === undefined) continue;
    if (present.size !== expected.size ||
      [...expected].some((column) => !present.has(column))) {
      throw new TypeError("system backup D1 schema contains an unknown or missing column");
    }
  }
}
