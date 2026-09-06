import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { join } from "node:path";
import { SqliteD1 } from "../../scripts/lib/sqlite-d1.mjs";
import { AcceptanceSessionStore } from "../../apps/mind-diary-acceptance/session-store.mjs";
import { AcceptanceTelemetryJournal } from "../../apps/mind-diary-acceptance/telemetry-journal.mjs";
import { cleanupRun } from "../../apps/mind-diary-acceptance/cleanup.mjs";
import { AcceptanceClient } from "../../scripts/lib/acceptance-client.mjs";
import { createAcceptancePerformanceFixture } from "../../scripts/lib/acceptance-performance-fixture.mjs";
import { acceptanceRuntime } from "../helpers/acceptance-runtime.mjs";
const identity = { candidate_sha: "a".repeat(40), test_adapter_sha256: "b".repeat(64) };
const correlation = () => "benchmark_" + randomUUID().replaceAll("-", "");
const event = id => JSON.stringify({ event: "mind-diary.privacy-safe-observability", schema: "mind-diary/privacy-safe-observability/v2",
  kind: "operational", metric: "request_latency_ms", surface: "mcp", operation: "fetch", outcome: "success", unit: "milliseconds", value: 17,
  occurredAtUtc: new Date().toISOString(), requestId: "request_test", jobId: null, cohort: null, benchmarkCorrelationId: id });

test("journal preserves actual events, enforces bounds and clears only the cleaned run", async t => {
  const db = new SqliteD1(); t.after(() => db.close()); const store = new AcceptanceSessionStore(db);
  const run = await store.create({}, "telemetry-primary-run-0001"), other = await store.create({}, "telemetry-other-run-0001");
  const journal = new AcceptanceTelemetryJournal(db, identity, () => {});
  for (const target of [run, other]) {
    const id = correlation(), entry = await journal.begin(target.id, id), source = event(id); journal.write(source); await journal.finish(entry, true);
    const row = await db.prepare("SELECT * FROM md_acceptance_telemetry WHERE run_id = ?").bind(target.id).first();
    assert.equal([0, 1, 2, 3].map(n => row[`event_json_${n}`]).join(""), source);
  }
  const rejected = await journal.begin(run.id, correlation());
  for (let n = 0; n < 17; n++) journal.write(event(rejected.correlationId));
  await assert.rejects(journal.finish(rejected, true), /acceptance_telemetry_unavailable/);
  const oversized = await journal.begin(run.id, correlation()); journal.write(event(oversized.correlationId).replace('"request_test"', '"' + "x".repeat(1000) + '"'));
  await assert.rejects(journal.finish(oversized, true), /acceptance_telemetry_unavailable/);
  const foreign = await journal.begin(randomUUID(), correlation()); journal.write(event(foreign.correlationId));
  await assert.rejects(journal.finish(foreign, true), /acceptance_telemetry_unavailable/);
  const skipped = await journal.begin(run.id, correlation()); journal.write(event(skipped.correlationId)); await journal.finish(skipped, false);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM md_acceptance_telemetry").first()).n, 2);
  const absent = async () => Response.json({ error: { code: "registration_required" } }, { status: 409 });
  assert.equal((await cleanupRun(store, run.id, absent, async () => {}, undefined, 4)).state, "cleaned");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM md_acceptance_telemetry WHERE run_id = ?").bind(run.id).first()).n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM md_acceptance_telemetry WHERE run_id = ?").bind(other.id).first()).n, 1);
});

test("a run cannot exceed the durable row budget or append after revocation", async t => {
  const db = new SqliteD1(); t.after(() => db.close()); const store = new AcceptanceSessionStore(db);
  const run = await store.create({}, "telemetry-cap-run-0001"), journal = new AcceptanceTelemetryJournal(db, identity, () => {});
  await journal.ready();
  await db.prepare(`WITH RECURSIVE n(value) AS (SELECT 0 UNION ALL SELECT value+1 FROM n WHERE value<4095)
    INSERT INTO md_acceptance_telemetry SELECT ?, 'fixture-' || value, 0, ?, ?, '', '', '', '' FROM n`).bind(run.id, identity.candidate_sha, identity.test_adapter_sha256).run();
  const entry = await journal.begin(run.id, correlation()); journal.write(event(entry.correlationId));
  await assert.rejects(journal.finish(entry, true), /acceptance_telemetry_unavailable/);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM md_acceptance_telemetry").first()).n, 4096);
  await db.prepare("DELETE FROM md_acceptance_telemetry WHERE run_id = ?").bind(run.id).run();
  await store.revoke(run.id);
  const revoked = await journal.begin(run.id, correlation()); journal.write(event(revoked.correlationId));
  await assert.rejects(journal.finish(revoked, true), /acceptance_telemetry_unavailable/);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM md_acceptance_telemetry").first()).n, 0);
});

test("only genuine signed successful product measurements reach D1 before response", async t => {
  const key = Buffer.alloc(32, 9), runtime = await acceptanceRuntime(t, { buildIdentity: identity, performanceCorrelationKey: key });
  const client = await new AcceptanceClient({ directory: join(runtime.directory, "telemetry"), platformToken: "synthetic", controllerKey: runtime.controllerKey, fetch: runtime.fetch }).open();
  try {
    const f = await createAcceptancePerformanceFixture(client, { ...identity, project_id: "appgprj_test", deployment_id: "appgdep_test", site_version_id: "appgver_test", archive_sha256: "c".repeat(64) }, "synthetic-binding-key-at-least-32-bytes");
    const request = async (signatureMode, runId = client.state.run.run_id) => {
      const id = correlation(), headers = { cookie: f.credentials.starter.cookie, "x-md-acceptance-run": runId, "x-mind-diary-performance-correlation-id": id };
      if (signatureMode !== "absent") headers["x-mind-diary-performance-correlation-signature"] = "hmac-sha256:" + createHmac("sha256", signatureMode === "valid" ? key : Buffer.alloc(32)).update("mind-diary/performance-correlation/v1\0" + id).digest("hex");
      return { id, response: await client.request("/", { headers }) };
    };
    for (const mode of ["absent", "invalid"]) assert.equal((await request(mode)).response.status, 200);
    assert.equal((await runtime.db.prepare("SELECT COUNT(*) AS n FROM md_acceptance_telemetry").first()).n, 0);
    const measured = await request("valid"); assert.equal(measured.response.status, 200);
    const rows = (await runtime.db.prepare("SELECT * FROM md_acceptance_telemetry").all()).results;
    assert.ok(rows.length >= 4); assert.ok(rows.every(row => row.correlation_id === measured.id && row.run_id === client.state.run.run_id && row.candidate_sha === identity.candidate_sha));
    const events = rows.map(row => JSON.parse([0, 1, 2, 3].map(n => row[`event_json_${n}`]).join("")));
    for (const operation of ["home", "stage_authentication", "stage_application", "stage_total"]) assert.ok(events.some(e => e.operation === operation));
    const definition = f.scenario.requests.find(r => r.profile === "mcp_modern" && r.operation === "list_minds");
    for (const foreign of [true, false]) {
      const id = correlation();
      const response = await client.request(definition.path, { method: "POST", body: definition.body, headers: { ...definition.headers,
        authorization: `Bearer ${f.credentials.starter.token}`, "x-md-acceptance-run": foreign ? randomUUID() : client.state.run.run_id,
        "x-mind-diary-performance-correlation-id": id,
        "x-mind-diary-performance-correlation-signature": "hmac-sha256:" + createHmac("sha256", key).update("mind-diary/performance-correlation/v1\0" + id).digest("hex") } });
      assert.equal(response.status, foreign ? 401 : 200);
      const stored = (await runtime.db.prepare("SELECT * FROM md_acceptance_telemetry WHERE correlation_id = ?").bind(id).all()).results;
      assert.equal(stored.length > 0, !foreign);
    }
  } finally { assert.equal((await client.cleanup()).state, "cleaned"); }
  assert.equal((await runtime.db.prepare("SELECT COUNT(*) AS n FROM md_acceptance_telemetry").first()).n, 0);
});
