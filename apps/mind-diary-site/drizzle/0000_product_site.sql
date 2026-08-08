CREATE TABLE IF NOT EXISTS md_metadata_schema_migrations (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS md_metadata_events (
  sequence INTEGER PRIMARY KEY,
  target TEXT NOT NULL CHECK (target IN ('metadata', 'tokens')),
  operation TEXT NOT NULL, payload_json TEXT NOT NULL, committed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS md_search_schema_migrations (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS md_exact_revision_search (
  space_id TEXT NOT NULL, revision_id TEXT NOT NULL, documents_json TEXT NOT NULL,
  PRIMARY KEY (space_id, revision_id)
);
CREATE TABLE IF NOT EXISTS md_audit_schema_migrations (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS md_delivered_audit_events (
  audit_event_id TEXT PRIMARY KEY, space_id TEXT, actor_kind TEXT NOT NULL,
  principal_id TEXT, event_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS md_audit_space_idx ON md_delivered_audit_events(space_id);
CREATE INDEX IF NOT EXISTS md_audit_principal_idx ON md_delivered_audit_events(principal_id);
