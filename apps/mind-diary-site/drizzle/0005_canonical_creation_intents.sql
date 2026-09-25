CREATE TABLE IF NOT EXISTS md_canonical_creation_intents (
  intent_id TEXT NOT NULL,
  key_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (intent_id, key_digest)
);

CREATE INDEX IF NOT EXISTS md_canonical_creation_intents_key
  ON md_canonical_creation_intents (key_digest);
