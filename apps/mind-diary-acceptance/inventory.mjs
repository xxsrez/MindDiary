import { createSitesMetadataStore } from "../../packages/adapter-metadata-sites/dist/index.js";

const tables = ["md_acceptance_actors", "md_acceptance_sessions", "md_acceptance_external_mcp", "md_acceptance_cleanup_journal", "md_acceptance_telemetry",
  "md_backup_sessions", "md_backup_pages", "md_backup_record_digests", "md_backup_inventory", "md_backup_cleanup_ops",
  "md_canonical_key_gates", "md_canonical_creation_intents",
  "md_search_documents", "md_search_revision_documents", "md_exact_revision_search",
  "md_oauth_grants", "md_oauth_access_tokens", "md_oauth_refresh_tokens", "md_oauth_authorization_codes", "md_oauth_authorization_requests"];
export async function acceptanceInventory(environment) {
  const metadata = await createSitesMetadataStore(environment.DB);
  const page = await metadata.listServiceOperatorPrincipals({ sort: "registered_at", direction: "asc", limit: 100 });
  const objects = await environment.MIND_DIARY_BUCKET.list({ limit: 1000 });
  const existing = await environment.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  const names = new Set(existing.results.map(row => row.name));
  const rows = {};
  for (const table of tables) rows[table] = names.has(table)
    ? (await environment.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).count : 0;
  return { schema: "mind-diary/acceptance-inventory/v2", complete: page.nextCursor === null && !objects.truncated,
    principals: page.principals.length, owned_minds: page.principals.reduce((total, p) => total + p.ownedMindCount, 0),
    object_count: objects.objects.length, object_bytes: objects.objects.reduce((total, o) => total + o.size, 0), rows };
}
