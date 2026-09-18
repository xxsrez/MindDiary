import { mkdir, readFile, writeFile, rename, lstat } from "node:fs/promises";
import { join } from "node:path";
import { ACCEPTANCE_ORIGIN } from "../../apps/mind-diary-acceptance/runtime-target.mjs";

// Private recovery journal: exact payloads and credentials never reach stdout.
export class AcceptanceClient {
  constructor({ directory, platformToken, controllerKey, fetch: transport = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    this.directory = directory; this.platformToken = platformToken;
    this.controllerKey = controllerKey; this.transport = transport; this.sleep = sleep;
  }
  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error("private_journal_directory_required");
    this.path = join(this.directory, "run.json");
    try {
      const entry = await lstat(this.path);
      if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077)) throw new Error("private_journal_file_required");
      this.state = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.state = { schema: 1, runKey: "acceptance-run:" + crypto.randomUUID(), phase: "prepared", actors: {}, operations: {} };
      await this.save();
    }
    if (this.state.schema !== 1) throw new Error("unsupported_journal_schema");
    return this;
  }
  async save() {
    const temporary = this.path + "." + crypto.randomUUID();
    await writeFile(temporary, JSON.stringify(this.state), { mode: 0o600, flag: "wx" });
    await rename(temporary, this.path);
  }
  async request(path, { method = "GET", body, headers = {} } = {}) {
    if (!path.startsWith("/") || new URL(path, ACCEPTANCE_ORIGIN).origin !== ACCEPTANCE_ORIGIN) throw new Error("foreign_target_denied");
    return this.transport(ACCEPTANCE_ORIGIN + path, { method,
      headers: { "OAI-Sites-Authorization": `Bearer ${this.platformToken}`, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "manual", signal: AbortSignal.timeout(45000) });
  }
  async control(path, method = "GET", body) {
    const response = await this.request(path, { method, body, headers: { authorization: `Bearer ${this.controllerKey}`,
      "idempotency-key": this.state.runKey, "content-type": "application/json" } });
    if (!response.ok) throw new Error(`acceptance_control_http_${response.status}`);
    return response.json();
  }
  async setup(input = {}) {
    if (this.state.phase === "cleaned") throw new Error("journal_already_cleaned");
    if (this.state.runInput && JSON.stringify(input) !== JSON.stringify(this.state.runInput)) throw new Error("run_input_changed");
    this.state.runInput = input; await this.save();
    // Retrying the same creation after an unknown response resolves its exact run.
    this.state.run = await this.control("/_acceptance/runs", "POST", input);
    this.state.phase = "created"; await this.save();
    return this.state.run;
  }
  async session(actorId) {
    if (!this.state.run?.actors.some(a => a.actor_id === actorId)) throw new Error("actor_outside_run");
    const exchange = await this.control(`/_acceptance/runs/${this.state.run.run_id}/exchanges`, "POST", { actor_id: actorId });
    const response = await this.request("/_acceptance/session", { method: "POST", body: { code: exchange.code }, headers: { origin: ACCEPTANCE_ORIGIN, "content-type": "application/json" } });
    if (!response.ok) throw new Error(`session_exchange_http_${response.status}`);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("session_cookie_missing");
    this.state.actors[actorId] = { ...this.state.actors[actorId], cookie }; await this.save();
    return cookie;
  }
  async mutation(name, actorId, { path, method = "POST", body, csrf }) {
    if (!path.startsWith("/api/v1/") || !["POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("invalid_product_mutation");
    const actor = this.state.actors[actorId]; if (!actor?.cookie) throw new Error("actor_session_required");
    const payload = { actorId, path, method, body };
    let operation = this.state.operations[name];
    if (operation && JSON.stringify(operation.payload) !== JSON.stringify(payload)) throw new Error("operation_payload_changed");
    if (operation?.phase === "completed") return operation.result;
    operation ??= { payload, key: "acceptance-op:" + crypto.randomUUID(), phase: "pending" };
    this.state.operations[name] = operation; await this.save();
    const response = await this.request(path, { method, body, headers: { cookie: actor.cookie, origin: ACCEPTANCE_ORIGIN,
      "content-type": "application/json", "x-csrf-token": csrf, "idempotency-key": operation.key } });
    if (!response.ok) throw new Error(`product_mutation_http_${response.status}`);
    operation.result = await response.json(); operation.phase = "completed"; await this.save();
    return operation.result;
  }
  async reconcileBootstrap(name, actorId) {
    const operation = this.state.operations[name];
    if (!operation || operation.phase === "completed") return;
    if (operation.payload.actorId !== actorId || operation.payload.path !== "/api/v1/account" || operation.payload.method !== "POST"
      || operation.payload.body?.action !== "create_isolated_account") throw new Error("invalid_bootstrap_reconciliation");
    const response = await this.request("/api/v1/session", { headers: { cookie: this.state.actors[actorId].cookie } });
    const body = await response.json();
    if (response.status === 409 && body.error?.code === "registration_required") return;
    if (response.status !== 200 || !body.data?.principal?.principal_id || !body.data.personal_mind?.mind_id) throw new Error("bootstrap_reconciliation_failed");
    operation.result = { ok: true, data: { principal_id: body.data.principal.principal_id, personal_mind: body.data.personal_mind, replayed: true } };
    operation.reconciled = true; operation.phase = "completed"; await this.save();
  }
  async cleanup({ retryTransient = true } = {}) {
    if (this.state.phase === "cleaned") return this.state.receipt;
    if (!this.state.run) await this.setup(this.state.runInput ?? {});
    this.state.phase = "cleanup_pending"; await this.save();
    // R2 delete uncertainty lasts five minutes; allow its full window plus
    // bounded Worker timeouts before declaring this run unrecovered.
    const deadline = Date.now() + 420000;
    for (let attempt = 0; attempt < 32; attempt++) {
      try { this.state.receipt = await this.control(`/_acceptance/runs/${this.state.run.run_id}/cleanup`, "POST", {}); }
      catch (error) {
        const transient = error.message === "acceptance_control_http_503" || ["AbortError", "TimeoutError"].includes(error.name);
        if (!retryTransient || !transient || attempt === 31 || Date.now() >= deadline) throw error;
        await this.sleep(Math.min(15000, 1000 * 2 ** Math.min(attempt, 4)));
        continue;
      }
      await this.save();
      if (this.state.receipt.state === "cleaned") break;
    }
    if (this.state.receipt?.state !== "cleaned") throw new Error("cleanup_still_pending");
    this.state.phase = "cleaned"; this.state.actors = {}; this.state.operations = {};
    await this.save(); return this.state.receipt;
  }
  async recoverDueRuns(runIds) {
    if (!Array.isArray(runIds) || runIds.length < 1 || runIds.length > 2 || runIds.some(id => !/^[a-f0-9-]{36}$/.test(id))) throw new Error("invalid_recovery_targets");
    const deadline = Date.now() + 300000;
    for (let attempt = 0; attempt < 16; attempt++) {
      try {
        const sweep = await this.control("/_acceptance/recover", "POST", {});
        const runs = [];
        for (const id of runIds) runs.push(await this.control(`/_acceptance/runs/${id}`));
        if (runs.every(run => run.state === "cleaned")) return { sweep, runs, attempts: attempt + 1 };
      } catch (error) {
        if (error.message !== "acceptance_control_http_503" && !["AbortError", "TimeoutError"].includes(error.name)) throw error;
      }
      if (attempt === 15 || Date.now() >= deadline) throw new Error("recovery_still_pending");
      await this.sleep(Math.min(15000, 1000 * 2 ** Math.min(attempt, 4)));
    }
    throw new Error("recovery_still_pending");
  }
  async mcpEnvelope(token, method, params = {}) {
    const response = await this.request("/api/mcp", { method: "POST", headers: {
      authorization: `Bearer ${token}`, "x-md-acceptance-run": this.state.run.run_id,
      "mcp-method": method, ...(params.name ? { "mcp-name": params.name } : {}), "mcp-protocol-version": "2026-07-28",
      "content-type": "application/json", accept: "application/json, text/event-stream",
    }, body: { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "mind-diary-acceptance", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    } } } });
    if (!response.ok) {
      const error = new Error(`mcp_http_${response.status}`);
      // Preserve the actual product error for a model under test; never retry
      // its tool call invisibly or discard the unknown-write explanation.
      try {
        const payload = await response.json();
        if (payload?.ok === false && typeof payload.error?.code === "string") {
          error.productError = payload.error;
        }
      } catch { /* A non-JSON upstream failure retains its HTTP outcome. */ }
      throw error;
    }
    return response.json();
  }
  async mcp(token, name, args = {}) {
    const envelope = await this.mcpEnvelope(token, "tools/call", { name, arguments: args }), result = envelope.result;
    if (envelope.error || result?.isError || !result?.structuredContent?.ok) {
      const error = new Error("mcp_tool_failed:" + (result?.structuredContent?.error?.code ?? "protocol_error"));
      error.productError = result?.structuredContent?.error;
      throw error;
    }
    return result.structuredContent.data;
  }
  async commit(name, token, payload) {
    // Fixture setup owns this bounded recovery. Model calls use mcpEnvelope
    // directly and must choose reconciliation themselves.
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this.commitOnce(name, token, payload); }
      catch (error) {
        if (error.message !== "mcp_http_503" || attempt === 2) throw error;
      }
    }
  }
  async commitOnce(name, token, payload) {
    const key = `mcp:${name}`;
    let operation = this.state.operations[key];
    if (operation?.phase === "completed") return operation.result;
    if (operation) {
      const reconciled = await this.mcp(token, "reconcile_changeset", operation.payload);
      if (reconciled.status === "committed") {
        operation.result = reconciled; operation.phase = "completed"; await this.save(); return reconciled;
      }
    } else {
      operation = { phase: "pending", payload: { ...payload, idempotency_key: "acceptance-commit:" + crypto.randomUUID() } };
      this.state.operations[key] = operation; await this.save();
    }
    operation.result = await this.mcp(token, "commit_changeset", operation.payload);
    operation.phase = "completed"; await this.save(); return operation.result;
  }
}
