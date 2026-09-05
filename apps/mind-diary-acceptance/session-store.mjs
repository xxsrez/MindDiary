import { ACCEPTANCE_ORIGIN, ACCEPTANCE_LIMITS } from "./runtime-target.mjs";

export const SESSION_COOKIE = "__Host-md-acceptance";
const secret = (prefix) => prefix + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (b) => b.toString(16).padStart(2, "0")).join("");
const fail = (code) => { throw new Error(code); };
const uuid = (value) => typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const schema = [
  `CREATE TABLE IF NOT EXISTS md_acceptance_runs (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, actor_count INTEGER NOT NULL, profile TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS md_acceptance_actors (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, ordinal INTEGER NOT NULL, subject TEXT UNIQUE NOT NULL, principal_id TEXT UNIQUE, revoked INTEGER NOT NULL DEFAULT 0, UNIQUE(run_id, ordinal))`,
  `CREATE TABLE IF NOT EXISTS md_acceptance_exchanges (verifier TEXT PRIMARY KEY, run_id TEXT NOT NULL, actor_id TEXT NOT NULL, audience TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS md_acceptance_sessions (verifier TEXT PRIMARY KEY, run_id TEXT NOT NULL, actor_id TEXT NOT NULL, audience TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS md_acceptance_sessions_actor ON md_acceptance_sessions(actor_id)`,
];

export class AcceptanceSessionStore {
  constructor(database, now = () => Date.now()) { this.db = database; this.now = now; }
  async ready() {
    this.initializing ??= this.db.batch(schema.map((sql) => this.db.prepare(sql))).catch((error) => { this.initializing = undefined; throw error; });
    await this.initializing;
  }
  statement(sql, ...values) { return this.db.prepare(sql).bind(...values); }
  async run(id) {
    await this.ready();
    if (!uuid(id)) fail("invalid_run");
    const run = await this.statement("SELECT * FROM md_acceptance_runs WHERE id = ?", id).first();
    if (!run) fail("run_not_found");
    const actors = await this.statement("SELECT id, run_id, ordinal, subject, principal_id, revoked FROM md_acceptance_actors WHERE run_id = ? ORDER BY ordinal", id).all();
    return { ...run, actors: actors.results };
  }
  async create(input, idempotencyKey) {
    await this.ready();
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((k) => !["actor_count", "ttl_seconds", "profile"].includes(k))) fail("invalid_run_request");
    if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9:_-]{16,128}$/.test(idempotencyKey)) fail("invalid_idempotency_key");
    const count = input.actor_count ?? 4, ttl = input.ttl_seconds ?? 3600, profile = input.profile ?? "collaboration";
    if (!Number.isInteger(count) || count < 4 || count > ACCEPTANCE_LIMITS.maxActorsPerRun || !Number.isInteger(ttl) || ttl < 60 || ttl > ACCEPTANCE_LIMITS.maxRunSeconds || !["collaboration", "operator"].includes(profile)) fail("invalid_run_request");
    const requestKey = await digest(idempotencyKey), id = crypto.randomUUID(), now = this.now();
    const statements = [this.statement(`INSERT OR IGNORE INTO md_acceptance_runs (id,request_key,actor_count,profile,created_at,expires_at,state)
      SELECT ?,?,?,?,?,?,'active' WHERE
      (SELECT COUNT(*) FROM md_acceptance_runs WHERE state != 'cleaned') < ?
      AND NOT EXISTS (SELECT 1 FROM md_acceptance_runs WHERE state != 'cleaned' AND (profile = 'operator' OR ? = 'operator'))`,
    id, requestKey, count, profile, now, now + ttl * 1000, ACCEPTANCE_LIMITS.maxParallelRuns, profile)];
    for (let ordinal = 0; ordinal < count; ordinal++) {
      const actorId = crypto.randomUUID();
      statements.push(this.statement(`INSERT INTO md_acceptance_actors (id,run_id,ordinal,subject)
        SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM md_acceptance_runs WHERE id = ?)`, actorId, id, ordinal, `actor-${actorId}@run-${id}.acceptance.invalid`, id));
    }
    await this.db.batch(statements);
    const stored = await this.statement("SELECT id FROM md_acceptance_runs WHERE request_key = ?", requestKey).first();
    if (!stored) fail("run_capacity_reached");
    const result = await this.run(stored.id);
    if (result.actor_count !== count || result.profile !== profile || result.expires_at - result.created_at !== ttl * 1000) fail("idempotency_conflict");
    return result;
  }
  async mintExchange(runId, actorId) {
    await this.ready();
    if (!uuid(runId) || !uuid(actorId)) fail("invalid_actor");
    const code = secret("mdtx_v1_"), verifier = await digest(code), now = this.now();
    // Expired hashes carry no authority and can be removed without product cleanup.
    await this.statement("DELETE FROM md_acceptance_exchanges WHERE expires_at <= ?", now).run();
    const result = await this.statement(`INSERT INTO md_acceptance_exchanges (verifier,run_id,actor_id,audience,expires_at)
      SELECT ?,r.id,a.id,?,MIN(r.expires_at,?) FROM md_acceptance_runs r JOIN md_acceptance_actors a ON a.run_id = r.id
      WHERE r.id = ? AND a.id = ? AND r.state = 'active' AND r.expires_at > ? AND a.revoked = 0
      AND (SELECT COUNT(*) FROM md_acceptance_exchanges WHERE run_id = r.id AND used_at IS NULL) < 32
      AND (SELECT COUNT(*) FROM md_acceptance_exchanges WHERE run_id = r.id) < 128`,
    verifier, ACCEPTANCE_ORIGIN, now + ACCEPTANCE_LIMITS.maxExchangeSeconds * 1000, runId, actorId, now).run();
    if (result.meta?.changes !== 1) fail("exchange_denied");
    return { code, expires_in: ACCEPTANCE_LIMITS.maxExchangeSeconds };
  }
  async exchange(code, audience) {
    await this.ready();
    if (audience !== ACCEPTANCE_ORIGIN || typeof code !== "string" || !/^mdtx_v1_[A-Za-z0-9_-]{43}$/.test(code)) fail("exchange_denied");
    const verifier = await digest(code), token = secret("mdts_v1_"), session = await digest(token), now = this.now();
    const results = await this.db.batch([
      this.statement(`INSERT INTO md_acceptance_sessions (verifier,run_id,actor_id,audience,expires_at)
        SELECT ?,e.run_id,e.actor_id,e.audience,MIN(r.expires_at,?) FROM md_acceptance_exchanges e
        JOIN md_acceptance_runs r ON r.id = e.run_id JOIN md_acceptance_actors a ON a.id = e.actor_id AND a.run_id = e.run_id
        WHERE e.verifier = ? AND e.used_at IS NULL AND e.expires_at > ? AND e.audience = ? AND r.state = 'active' AND r.expires_at > ? AND a.revoked = 0`,
      session, now + ACCEPTANCE_LIMITS.maxSessionSeconds * 1000, verifier, now, audience, now),
      this.statement(`UPDATE md_acceptance_sessions SET revoked = 1 WHERE verifier != ?
        AND actor_id = (SELECT actor_id FROM md_acceptance_sessions WHERE verifier = ?)`, session, session),
      this.statement(`UPDATE md_acceptance_exchanges SET used_at = ? WHERE verifier = ? AND used_at IS NULL
        AND EXISTS (SELECT 1 FROM md_acceptance_sessions WHERE verifier = ?)`, now, verifier, session),
      this.statement(`DELETE FROM md_acceptance_sessions WHERE revoked = 1
        AND actor_id = (SELECT actor_id FROM md_acceptance_sessions WHERE verifier = ?)`, session),
    ]);
    if (results[0].meta?.changes !== 1 || results[2].meta?.changes !== 1) fail("exchange_denied");
    const row = await this.statement("SELECT expires_at FROM md_acceptance_sessions WHERE verifier = ?", session).first();
    return { token, cookie: `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor((row.expires_at - now) / 1000))}` };
  }
  async actorForRequest(request) {
    await this.ready();
    if (new URL(request.url).origin !== ACCEPTANCE_ORIGIN) return null;
    const cookie = request.headers.get("cookie") ?? "";
    if (cookie.length > 8192) return null;
    const values = cookie.split(";").map((v) => v.trim()).filter((v) => v.startsWith(`${SESSION_COOKIE}=`));
    if (values.length !== 1) return null;
    const token = values[0].slice(SESSION_COOKIE.length + 1);
    if (!/^mdts_v1_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const now = this.now();
    const actor = await this.statement(`SELECT a.* FROM md_acceptance_sessions s JOIN md_acceptance_runs r ON r.id = s.run_id
      JOIN md_acceptance_actors a ON a.id = s.actor_id AND a.run_id = s.run_id
      WHERE s.verifier = ? AND s.audience = ? AND s.revoked = 0 AND s.expires_at > ?
      AND r.state = 'active' AND r.expires_at > ? AND a.revoked = 0`, await digest(token), ACCEPTANCE_ORIGIN, now, now).first();
    const declaredRun = request.headers.get("x-md-acceptance-run");
    return actor && (!declaredRun || declaredRun === actor.run_id) ? actor : null;
  }
  async bindPrincipal(actor, principalId) {
    if (typeof principalId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(principalId)) fail("invalid_principal_readback");
    const result = await this.statement(`UPDATE md_acceptance_actors SET principal_id = ? WHERE id = ? AND run_id = ?
      AND (principal_id IS NULL OR principal_id = ?)`, principalId, actor.id, actor.run_id, principalId).run();
    if (result.meta?.changes !== 1) fail("actor_binding_conflict");
  }
  async admitPrincipal(principalId, request) {
    await this.ready();
    const runId = request.headers.get("x-md-acceptance-run");
    if (!uuid(runId)) return false;
    const row = await this.statement(`SELECT a.id FROM md_acceptance_actors a JOIN md_acceptance_runs r ON r.id = a.run_id
      WHERE a.principal_id = ? AND r.id = ? AND r.state = 'active' AND r.expires_at > ? AND a.revoked = 0`, principalId, runId, this.now()).first();
    return row !== null;
  }
  async operatorPrincipalIds() {
    await this.ready();
    const rows = await this.statement(`SELECT a.principal_id FROM md_acceptance_actors a JOIN md_acceptance_runs r ON r.id = a.run_id
      WHERE r.profile = 'operator' AND r.state = 'active' AND r.expires_at > ? AND a.ordinal = 0 AND a.revoked = 0 AND a.principal_id IS NOT NULL`, this.now()).all();
    return rows.results.map((row) => row.principal_id);
  }
  async revoke(runId) {
    await this.ready();
    if (!uuid(runId)) fail("invalid_run");
    await this.statement("UPDATE md_acceptance_runs SET state = 'revoked' WHERE id = ? AND state = 'active'", runId).run();
    return this.run(runId);
  }
}
