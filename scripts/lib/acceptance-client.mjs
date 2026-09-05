import { mkdir, readFile, writeFile, rename, lstat } from "node:fs/promises";
import { join } from "node:path";
import { ACCEPTANCE_ORIGIN } from "../../apps/mind-diary-acceptance/runtime-target.mjs";

// Private recovery journal: exact payloads and credentials never reach stdout.
export class AcceptanceClient {
  constructor({ directory, platformToken, controllerKey, fetch: transport = fetch }) {
    this.directory = directory; this.platformToken = platformToken;
    this.controllerKey = controllerKey; this.transport = transport;
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
    const response = await this.request(path, { method, body, headers: { "x-md-acceptance-controller": this.controllerKey,
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
    if (!path.startsWith("/api/v1/") || !["POST", "PATCH", "DELETE"].includes(method)) throw new Error("invalid_product_mutation");
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
  async cleanup() {
    if (this.state.phase === "cleaned") return this.state.receipt;
    if (!this.state.run) await this.setup(this.state.runInput ?? {});
    this.state.phase = "cleanup_pending"; await this.save();
    for (let attempt = 0; attempt < 9; attempt++) {
      this.state.receipt = await this.control(`/_acceptance/runs/${this.state.run.run_id}/cleanup`, "POST", {});
      await this.save();
      if (this.state.receipt.state === "cleaned") break;
    }
    if (this.state.receipt.state !== "cleaned") throw new Error("cleanup_still_pending");
    this.state.phase = "cleaned"; this.state.actors = {}; this.state.operations = {};
    await this.save(); return this.state.receipt;
  }
}
