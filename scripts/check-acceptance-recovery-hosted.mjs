import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { AcceptanceClient } from "./lib/acceptance-client.mjs";
import { createCollaborationFixture } from "./lib/acceptance-fixture.mjs";
import { acceptanceDigest, createAcceptanceComponent } from "./lib/acceptance-evidence.mjs";

const [tag, identityPath] = process.argv.slice(2);
if (!/^[a-zA-Z0-9_-]{1,70}$/.test(tag ?? "")) throw Error("invalid_recovery_tag");
const root = join(homedir(), ".codex/private/mind-diary-acceptance");
const credentials = { platformToken: JSON.parse(await readFile(join(root, "platform-token.json"), "utf8")).token,
  controllerKey: await readFile(join(root, "controller-key"), "utf8") };
const identity = JSON.parse(await readFile(identityPath, "utf8"));
const runnerSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), "", "clean_runner_required");
let phase = "setup";
process.once("uncaughtException", () => { console.error(JSON.stringify({ status: "failed", phase })); process.exit(1); });
const config = suffix => ({ ...credentials, directory: join(root, "runs", tag + suffix) });
let primary = await new AcceptanceClient(config("")).open();
let secondary = await new AcceptanceClient(config("-ttl")).open();
assert.equal(primary.state.phase, "prepared", "fresh_recovery_tag_required");
const build = await (await primary.request("/_acceptance/build")).json();
assert.equal(identity.project_id, "appgprj_example8ca2ca9e5243cfd6");
for (const key of ["candidate_sha", "common_modules_sha256", "test_adapter_sha256"]) assert.equal(identity[key], build[key]);
const baseline = await primary.control("/_acceptance/inventory");
primary.state.recovery = { baseline }; await primary.save();
const assertions = {}, events = [];
const record = (name, details = {}) => { events.push({ name, at: new Date().toISOString(), ...details }); console.log(JSON.stringify({ phase: name, status: "passed" })); };
function loseResponse(client, matches, message) {
  const transport = client.transport;
  let injected = false;
  client.transport = async (url, options) => {
    const response = await transport(url, options);
    if (!injected && matches(url, options) && response.ok) {
      const body = await response.clone().json();
      if (body.result?.isError) return response;
      injected = true; throw Error(message);
    }
    return response;
  };
}
let passed = false, final, failure;
try {
  loseResponse(primary, url => url.endsWith("/_acceptance/runs"), "lost_setup_response");
  await assert.rejects(primary.setup(), /lost_setup_response/);
  primary = await new AcceptanceClient(config("")).open(); await primary.setup();
  assertions.setup_interruption = true; record("setup_interruption");
  const expiring = await secondary.setup({ ttl_seconds: 60 });
  const expiringCookie = await secondary.session(expiring.actors[0].actor_id);
  const beforeExpiry = await secondary.request("/api/v1/session", { headers: { cookie: expiringCookie } });
  assert.equal(beforeExpiry.status, 409); // Authenticated, not registered yet.
  assertions.overlap = true;
  for (const point of ["bootstrap", "commit"]) {
    phase = point;
    loseResponse(primary, (url, options) => point === "bootstrap" ? url.endsWith("/api/v1/account") : options.body && JSON.parse(options.body).params?.name === "commit_changeset", `lost_${point}_response`);
    await assert.rejects(createCollaborationFixture(primary), new RegExp(`lost_${point}_response`));
    primary = await new AcceptanceClient(config("")).open();
    record(`${point}_interruption`);
  }
  const fixture = await createCollaborationFixture(primary);
  const token = primary.state.operations["token:owner"].result.data.secret;
  const ownerCookie = primary.state.actors[fixture.actors.owner.actor_id].cookie;
  assert.equal((await primary.mcp(token, "list_revisions", { mind: "/me" })).revisions.length, 3);
  assertions.commit_interruption = true; assertions.unknown_reconciliation = true;
  phase = "ttl_expiry";
  while (Date.now() <= expiring.expires_at + 1000) await new Promise(resolve => setTimeout(resolve, Math.min(1000, expiring.expires_at + 1001 - Date.now())));
  assert.equal((await secondary.request("/api/v1/session", { headers: { cookie: expiringCookie } })).status, 401);
  assertions.ttl_expiry = true;
  const recovered = await primary.recoverDueRuns([expiring.run_id]);
  assert.ok(recovered.runs.some(result => result.run_id === expiring.run_id && result.state === "cleaned"));
  assert.equal((await primary.control(`/_acceptance/runs/${primary.state.run.run_id}`)).state, "active");
  assert.equal((await primary.mcp(token, "list_minds")).minds.length, 2);
  assertions.active_run_preserved = true; record("expired_run_cleaned_active_run_preserved");
  phase = "revocation";
  await primary.control(`/_acceptance/runs/${primary.state.run.run_id}`, "DELETE");
  assert.equal((await primary.request("/api/v1/session", { headers: { cookie: ownerCookie } })).status, 401);
  await assert.rejects(primary.mcp(token, "list_minds"), /mcp_http_401/);
  assertions.revoked_session = true; assertions.credential_denied = true;
  phase = "service_unavailable";
  const transport = primary.transport;
  primary.transport = async (url, options) => url.endsWith("/cleanup") ? Response.json({ error: "injected_service_unavailable" }, { status: 503 }) : transport(url, options);
  await assert.rejects(primary.cleanup({ retryTransient: false }), /acceptance_control_http_503/);
  assert.equal(primary.state.phase, "cleanup_pending");
  assertions.service_unavailable = true; record("service_unavailable", { injection: "controller_transport_503", provider_outage_claimed: false });
  primary = await new AcceptanceClient(config("")).open();
  loseResponse(primary, url => url.endsWith("/cleanup"), "lost_cleanup_response");
  await assert.rejects(primary.cleanup(), /lost_cleanup_response/);
  primary = await new AcceptanceClient(config("")).open();
  const cleaned = await primary.cleanup(); assert.equal(cleaned.state, "cleaned");
  const repeated = await primary.control(`/_acceptance/runs/${primary.state.run.run_id}/cleanup`, "POST", {});
  assert.deepEqual(repeated, cleaned);
  assertions.cleanup_interruption = true; assertions.idempotent_cleanup = true;
  record("cleanup_interruption_recovered"); passed = true;
} catch (error) {
  failure = { phase, kind: error.name, ...( /^acceptance_control_http_[0-9]{3}$/.test(error.message) ? { code: error.message } : {}) };
  throw error;
} finally {
  phase = "final_cleanup";
  primary.transport = fetch; secondary.transport = fetch;
  for (const client of [secondary, primary]) if (client.state.run || client.state.runInput) await client.cleanup();
  final = await primary.control("/_acceptance/inventory"); assert.deepEqual(final, baseline);
  const source = { schema: "mind-diary/acceptance-recovery/v1", status: passed ? "passed" : "failed", identity, runner_sha: runnerSha, assertions, events, ...(failure ? { failure } : {}),
    cleanup: { status: "baseline_restored", baseline, final } };
  await writeFile(join(primary.directory, "recovery-source.json"), JSON.stringify(source), { mode: 0o600 });
  if (passed) {
    const component = createAcceptanceComponent({ kind: "recovery", status: "passed", identity, runner_sha: runnerSha, assertions, details: { faults: events },
      cleanup: source.cleanup, source_receipts: [acceptanceDigest(source)] });
    await writeFile(join(primary.directory, "recovery-component.json"), JSON.stringify(component), { mode: 0o600 });
    console.log(JSON.stringify({ status: "passed", component: component.artifact_sha256, cleanup: "baseline_restored" }));
  }
}
