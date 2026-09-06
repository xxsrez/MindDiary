export const ACCEPTANCE_TELEMETRY_TABLE = "md_acceptance_telemetry";
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const correlation = /^benchmark_[a-f0-9]{32}$/;

// Only the common runtime's validated, signed-correlation sink calls write.
// No HTTP endpoint accepts telemetry values from a caller.
export class AcceptanceTelemetryJournal {
  constructor(db, identity, consoleWriter = value => console.info(value)) {
    this.db = db; this.identity = identity; this.consoleWriter = consoleWriter; this.pending = new Map();
  }
  async ready() {
    this.initializing ??= this.db.prepare(`CREATE TABLE IF NOT EXISTS md_acceptance_telemetry (
      run_id TEXT NOT NULL, correlation_id TEXT NOT NULL, event_index INTEGER NOT NULL,
      candidate_sha TEXT NOT NULL, adapter_sha256 TEXT NOT NULL,
      event_json_0 TEXT NOT NULL, event_json_1 TEXT NOT NULL, event_json_2 TEXT NOT NULL, event_json_3 TEXT NOT NULL,
      PRIMARY KEY(run_id,correlation_id,event_index))`).run().catch(error => { this.initializing = undefined; throw error; });
    await this.initializing;
  }
  async begin(runId, correlationId) {
    if (!uuid.test(runId ?? "") || !correlation.test(correlationId ?? "")) return null;
    if (!/^[a-f0-9]{40}$/.test(this.identity?.candidate_sha ?? "") || !/^[a-f0-9]{64}$/.test(this.identity?.test_adapter_sha256 ?? "")
      || this.pending.size >= 8 || this.pending.has(correlationId)) throw Error("acceptance_telemetry_unavailable");
    await this.ready();
    // Recheck after schema initialization: concurrent starts may have awaited it.
    if (this.pending.size >= 8 || this.pending.has(correlationId)) throw Error("acceptance_telemetry_unavailable");
    const entry = { runId, correlationId, events: [], invalid: false };
    this.pending.set(correlationId, entry); return entry;
  }
  write(serialized) {
    this.consoleWriter(serialized);
    const event = JSON.parse(serialized), entry = this.pending.get(event.benchmarkCorrelationId);
    if (!entry || event.event !== "mind-diary.privacy-safe-observability" || event.schema !== "mind-diary/privacy-safe-observability/v2"
      || event.metric !== "request_latency_ms") return;
    if (serialized.length > 960 || entry.events.length >= 16) { entry.invalid = true; return; }
    entry.events.push({ serialized, outcome: event.outcome });
  }
  cancel(entry) { if (entry && this.pending.get(entry.correlationId) === entry) this.pending.delete(entry.correlationId); }
  async finish(entry, successfulResponse) {
    if (!entry) return;
    this.cancel(entry);
    // Rejected signatures have no trusted correlation in the common sink.
    if (!successfulResponse) return;
    if (entry.invalid) throw Error("acceptance_telemetry_unavailable");
    if (entry.events.length === 0 || entry.events.some(event => event.outcome !== "success")) return;
    const statements = entry.events.map(({ serialized }, index) => this.db.prepare(`INSERT INTO md_acceptance_telemetry
      (run_id,correlation_id,event_index,candidate_sha,adapter_sha256,event_json_0,event_json_1,event_json_2,event_json_3)
      SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM md_acceptance_runs WHERE id = ? AND state = 'active' AND expires_at > ?)
      AND (SELECT COUNT(*) FROM md_acceptance_telemetry WHERE run_id = ?) < 4096`).bind(entry.runId, entry.correlationId, index,
      this.identity.candidate_sha, this.identity.test_adapter_sha256, ...[0, 1, 2, 3].map(part => serialized.slice(part * 240, (part + 1) * 240)),
      entry.runId, Date.now(), entry.runId));
    const results = await this.db.batch(statements);
    if (results.some(result => result.meta?.changes !== 1)) throw Error("acceptance_telemetry_unavailable");
  }
}
