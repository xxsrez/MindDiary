import { ACCEPTANCE_ORIGIN } from "./runtime-target.mjs";
import { AcceptanceTelemetryJournal } from "./telemetry-journal.mjs";
import { acceptanceInventory } from "./inventory.mjs";

export async function cleanupRun(store, runId, productCall, resumeDeletion, fault = async () => {}, maxActors = 1, bucket = null) {
  await store.ready();
  await new AcceptanceTelemetryJournal(store.db, null).ready();
  await store.db.batch([
    store.db.prepare("CREATE TABLE IF NOT EXISTS md_acceptance_cleanup_locks (run_id TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at INTEGER NOT NULL)"),
    store.db.prepare("CREATE TABLE IF NOT EXISTS md_acceptance_cleanup_journal (actor_id TEXT PRIMARY KEY, command_json TEXT, result_json TEXT, done INTEGER NOT NULL DEFAULT 0)"),
    store.db.prepare("CREATE TABLE IF NOT EXISTS md_acceptance_cleanup_receipts (run_id TEXT PRIMARY KEY, receipt_json TEXT NOT NULL)"),
  ]);
  const run = await store.run(runId);
  if (run.state === "cleaned") return JSON.parse((await store.statement("SELECT receipt_json FROM md_acceptance_cleanup_receipts WHERE run_id = ?", runId).first()).receipt_json);
  const holder = crypto.randomUUID(), now = store.now();
  const lock = await store.statement(`INSERT INTO md_acceptance_cleanup_locks (run_id,holder,expires_at) VALUES (?,?,?)
    ON CONFLICT(run_id) DO UPDATE SET holder=excluded.holder, expires_at=excluded.expires_at
    WHERE md_acceptance_cleanup_locks.expires_at <= ?`, runId, holder, now + 120000, now).run();
  if (lock.meta?.changes !== 1) throw new Error("cleanup_busy");
  const assertLease = async () => {
    const lease = await store.statement("SELECT holder FROM md_acceptance_cleanup_locks WHERE run_id = ? AND holder = ? AND expires_at > ?", runId, holder, store.now()).first();
    if (!lease) throw new Error("cleanup_lease_expired");
  };
  try {
    await store.statement("UPDATE md_acceptance_runs SET state = 'cleaning' WHERE id = ? AND state != 'cleaned'", runId).run();
    await fault("after_revoke");
    const results = []; let processed = 0;
    for (const actor of run.actors) {
      await assertLease();
      await store.statement("INSERT OR IGNORE INTO md_acceptance_cleanup_journal (actor_id) VALUES (?)", actor.id).run();
      let journal = await store.statement("SELECT * FROM md_acceptance_cleanup_journal WHERE actor_id = ?", actor.id).first();
      if (journal.done) { results.push(JSON.parse(journal.result_json)); continue; }
      const call = async (path, options = {}) => {
        await assertLease();
        return productCall(actor, new Request(ACCEPTANCE_ORIGIN + path, options));
      };
      const session = await call("/api/v1/session");
      const sessionBody = await session.json();
      if (session.status === 200) {
        const principalId = sessionBody.data.principal.principal_id;
        await store.bindPrincipal(actor, principalId); actor.principal_id = principalId;
        if (!journal.command_json) {
          const impact = await call("/api/v1/account/deletion-impact");
          if (impact.status !== 200) throw new Error("cleanup_preview_failed");
          const preview = (await impact.json()).data;
          journal.command_json = JSON.stringify({ principalId, impact_id: preview.impact_id, confirmation: preview.confirmation, idempotencyKey: `acceptance-delete:${crypto.randomUUID()}` });
          await store.statement("UPDATE md_acceptance_cleanup_journal SET command_json = ? WHERE actor_id = ?", journal.command_json, actor.id).run();
        }
        await fault("before_delete", actor.id);
        const command = JSON.parse(journal.command_json);
        const page = await call("/settings/account");
        const csrf = /name="mind-diary-csrf-token" content="([^"]+)"/.exec(await page.text())?.[1];
        if (!csrf) throw new Error("cleanup_csrf_unavailable");
        const deleted = await call("/api/v1/account", { method: "DELETE", headers: { origin: ACCEPTANCE_ORIGIN, "content-type": "application/json", "x-csrf-token": csrf, "idempotency-key": command.idempotencyKey }, body: JSON.stringify({ impact_id: command.impact_id, confirmation: command.confirmation }) });
        await fault("after_delete", actor.id);
        if (deleted.status !== 200) {
          const error = await deleted.json().catch(() => null);
          if (deleted.status === 409 && ["deletion_impact_changed", "deletion_impact_expired"].includes(error?.error?.code)) {
            await store.statement("UPDATE md_acceptance_cleanup_journal SET command_json = NULL WHERE actor_id = ?", actor.id).run();
          }
          throw new Error("cleanup_delete_incomplete");
        }
        journal.result_json = JSON.stringify((await deleted.json()).data);
        await store.statement("UPDATE md_acceptance_cleanup_journal SET result_json = ? WHERE actor_id = ?", journal.result_json, actor.id).run();
      } else if (session.status !== 409 || sessionBody.error?.code !== "registration_required") {
        throw new Error("cleanup_identity_unavailable");
      }
      if (journal.command_json) {
        const command = JSON.parse(journal.command_json);
        await resumeDeletion({ principalId: command.principalId, impactId: command.impact_id, idempotencyKey: command.idempotencyKey });
      }
      const absent = await call("/api/v1/session");
      if (absent.status !== 409 || (await absent.json()).error?.code !== "registration_required") throw new Error("cleanup_account_remains");
      const result = journal.result_json ? JSON.parse(journal.result_json) : { reconciled: true, registered: journal.command_json !== null };
      await store.statement("UPDATE md_acceptance_cleanup_journal SET done = 1, result_json = ? WHERE actor_id = ?", JSON.stringify(result), actor.id).run();
      results.push(result);
      await fault("after_actor", actor.id);
      processed++;
      if (processed >= maxActors && results.length < run.actors.length) {
        return { run_id: runId, state: "cleaning", actors_cleaned: results.length, actors_remaining: run.actors.length - results.length };
      }
    }
    await assertLease();
    const backupTables = ["md_backup_sessions", "md_backup_pages",
      "md_backup_record_digests", "md_backup_inventory", "md_backup_cleanup_ops"];
    let backupCleanup = [];
    const present = await store.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'md_backup_%'").all();
    const names = new Set((present.results ?? []).map((row) => row.name));
    if (backupTables.some((table) => names.has(table))) {
      if (backupTables.some((table) => !names.has(table))) throw new Error("backup_cleanup_schema_incomplete");
      const active = await store.statement("SELECT COUNT(*) AS count FROM md_backup_sessions WHERE status IN ('building', 'ready')").first();
      const operations = await store.statement("SELECT COUNT(*) AS count FROM md_backup_cleanup_ops").first();
      if (active.count !== 0) throw new Error("backup_cleanup_active");
      if (operations.count > 0) {
        if (bucket === null || operations.count > 16) throw new Error("backup_cleanup_unreconciled");
        if (run.profile === "operator") {
          const rows = await store.statement("SELECT started_at FROM md_backup_cleanup_ops").all();
          if (rows.results.length !== operations.count || rows.results.some(({ started_at }) =>
            !Number.isFinite(Date.parse(started_at)) ||
            store.now() - Date.parse(started_at) < 300_000)) {
            throw new Error("backup_cleanup_still_uncertain");
          }
        }
        const inventory = await acceptanceInventory({ DB: store.db, MIND_DIARY_BUCKET: bucket });
        if (!inventory.complete || inventory.principals !== 0 ||
          inventory.owned_minds !== 0 || inventory.object_count !== 0 ||
          inventory.object_bytes !== 0) {
          throw new Error("backup_cleanup_unreconciled");
        }
        backupCleanup.push(store.db.prepare("DELETE FROM md_backup_cleanup_ops"));
      }
      backupCleanup.push(
        store.db.prepare("DELETE FROM md_backup_pages"),
        store.db.prepare("DELETE FROM md_backup_record_digests"),
        store.db.prepare("DELETE FROM md_backup_inventory"),
        store.db.prepare("DELETE FROM md_backup_sessions"),
      );
    }
    const receipt = { run_id: runId, state: "cleaned", actors_cleaned: run.actors.length, results };
    await store.db.batch([
      ...backupCleanup,
      store.statement("INSERT OR REPLACE INTO md_acceptance_cleanup_receipts (run_id,receipt_json) VALUES (?,?)", runId, JSON.stringify(receipt)),
      store.statement("DELETE FROM md_acceptance_telemetry WHERE run_id = ?", runId),
      store.statement("DELETE FROM md_acceptance_cleanup_journal WHERE actor_id IN (SELECT id FROM md_acceptance_actors WHERE run_id = ?)", runId),
      store.statement("DELETE FROM md_acceptance_sessions WHERE run_id = ?", runId),
      store.statement("DELETE FROM md_acceptance_external_mcp WHERE run_id = ?", runId),
      store.statement("DELETE FROM md_acceptance_export_holds WHERE run_id = ?", runId),
      store.statement("DELETE FROM md_acceptance_exchanges WHERE run_id = ?", runId),
      store.statement("DELETE FROM md_acceptance_actors WHERE run_id = ?", runId),
      store.statement("UPDATE md_acceptance_runs SET state = 'cleaned' WHERE id = ?", runId),
    ]);
    return receipt;
  } finally {
    await store.statement("DELETE FROM md_acceptance_cleanup_locks WHERE run_id = ? AND holder = ?", runId, holder).run();
  }
}
