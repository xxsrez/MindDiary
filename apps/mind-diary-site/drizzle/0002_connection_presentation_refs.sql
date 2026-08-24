ALTER TABLE md_oauth_grants ADD COLUMN connection_ref TEXT;

UPDATE md_oauth_grants
SET connection_ref = 'conn_v1_' || lower(hex(randomblob(16)))
WHERE connection_ref IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS md_oauth_grants_connection_ref_idx
  ON md_oauth_grants(connection_ref);

CREATE UNIQUE INDEX IF NOT EXISTS md_oauth_grants_principal_connection_idx
  ON md_oauth_grants(principal_id, connection_ref);
