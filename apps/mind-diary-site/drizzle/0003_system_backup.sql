CREATE TABLE IF NOT EXISTS md_backup_control (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  origin_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  backup_sequence INTEGER NOT NULL CHECK (backup_sequence >= 0),
  invalidation_epoch INTEGER NOT NULL CHECK (invalidation_epoch >= 0)
);

CREATE TABLE IF NOT EXISTS md_backup_sessions (
  session_id TEXT PRIMARY KEY,
  origin_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  base_sequence INTEGER,
  base_digest TEXT,
  base_session_id TEXT,
  base_captured_at TEXT,
  base_schema_digest TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('baseline', 'incremental', 'rebaseline')),
  target_sequence INTEGER NOT NULL,
  target_digest TEXT NOT NULL,
  invalidation_epoch INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('building', 'ready', 'invalidated', 'completed', 'released')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at TEXT NOT NULL,
  page_count INTEGER NOT NULL,
  record_count INTEGER NOT NULL,
  object_count INTEGER NOT NULL,
  manifest_digest TEXT NOT NULL,
  schema_digest TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS md_backup_pages (
  session_id TEXT NOT NULL,
  page_index INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  PRIMARY KEY (session_id, page_index)
);

CREATE TABLE IF NOT EXISTS md_backup_record_digests (
  session_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (session_id, record_key)
);

CREATE TABLE IF NOT EXISTS md_backup_inventory (
  session_id TEXT NOT NULL,
  object_index INTEGER NOT NULL,
  namespace TEXT NOT NULL,
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  PRIMARY KEY (session_id, object_index)
);

CREATE TABLE IF NOT EXISTS md_backup_cleanup_ops (
  operation_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL
);
