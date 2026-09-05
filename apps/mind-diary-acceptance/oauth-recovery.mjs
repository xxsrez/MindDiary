// Only the isolated test entrypoint calls this bounded recovery helper. It never
// deletes product rows itself and cannot select an active account for deletion.
export async function recoverOrphanOAuth(database, purgeDeletedPrincipal) {
  const existing = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  const names = new Set(existing.results.map(row => row.name));
  const tables = ["md_oauth_grants", "md_oauth_authorization_requests", "md_oauth_authorization_codes", "md_oauth_access_tokens", "md_oauth_refresh_tokens"].filter(name => names.has(name));
  if (!tables.length) return { checked: 0, purged: 0 };
  const candidates = await database.prepare(tables.map(table => `SELECT principal_id FROM ${table}`).join(" UNION ") + " ORDER BY principal_id LIMIT 32").all();
  let purged = 0;
  for (const row of candidates.results) {
    if ((await purgeDeletedPrincipal(row.principal_id)).purged) purged++;
  }
  return { checked: candidates.results.length, purged };
}
