CREATE TABLE IF NOT EXISTS md_oauth_registered_clients (
  id TEXT PRIMARY KEY, client_name TEXT NOT NULL, redirect_uris_json TEXT NOT NULL,
  grant_types_json TEXT NOT NULL, response_types_json TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS md_oauth_authorization_requests (
  id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, client_id TEXT NOT NULL,
  client_name TEXT NOT NULL, redirect_uri TEXT NOT NULL, resource TEXT NOT NULL,
  scopes_json TEXT NOT NULL, state TEXT, code_challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS md_oauth_grants (
  id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, client_id TEXT NOT NULL,
  client_name TEXT NOT NULL, resource TEXT NOT NULL, scopes_json TEXT NOT NULL,
  revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT,
  UNIQUE(principal_id, client_id, resource)
);
CREATE TABLE IF NOT EXISTS md_oauth_authorization_codes (
  id TEXT PRIMARY KEY, code_verifier TEXT NOT NULL UNIQUE, grant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL, scopes_json TEXT NOT NULL, code_challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL, consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS md_oauth_access_tokens (
  id TEXT PRIMARY KEY, token_verifier TEXT NOT NULL UNIQUE, grant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL, client_id TEXT NOT NULL, resource TEXT NOT NULL,
  scopes_json TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
  last_used_at TEXT, revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS md_oauth_refresh_tokens (
  id TEXT PRIMARY KEY, token_verifier TEXT NOT NULL UNIQUE, grant_id TEXT NOT NULL,
  family_id TEXT NOT NULL, parent_id TEXT, principal_id TEXT NOT NULL,
  client_id TEXT NOT NULL, resource TEXT NOT NULL, scopes_json TEXT NOT NULL,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, used_at TEXT, revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS md_oauth_grants_principal_idx
  ON md_oauth_grants(principal_id, revoked_at);
CREATE INDEX IF NOT EXISTS md_oauth_refresh_family_idx
  ON md_oauth_refresh_tokens(family_id);
