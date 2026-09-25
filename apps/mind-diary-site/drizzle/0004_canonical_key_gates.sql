CREATE TABLE IF NOT EXISTS md_canonical_key_gates (
  key_digest TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  acquired_at TEXT NOT NULL
);
