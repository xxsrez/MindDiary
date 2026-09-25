import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AcceptanceClient } from "./lib/acceptance-client.mjs";
import { ACCEPTANCE_ORIGIN } from "../apps/mind-diary-acceptance/runtime-target.mjs";

const [phase, tag, expectedCandidate] = process.argv.slice(2);
if (!["prepare", "recover", "cleanup"].includes(phase) ||
    !/^[A-Za-z0-9_-]{1,70}$/.test(tag ?? "") ||
    !/^[a-f0-9]{40}$/.test(expectedCandidate ?? "")) {
  throw new Error("phase_tag_candidate_required");
}
const root = join(homedir(), ".codex/private/mind-diary-acceptance");
const client = await new AcceptanceClient({
  directory: join(root, "runs", tag),
  platformToken: JSON.parse(await readFile(join(root, "platform-token.json"), "utf8")).token,
  controllerKey: await readFile(join(root, "controller-key"), "utf8"),
}).open();
const build = await client.request("/_acceptance/build");
assert.equal(build.status, 200);
assert.equal((await build.json()).candidate_sha, expectedCandidate);
const owner = () => client.state.run.actors[0];
const cookie = () => client.state.actors[owner().actor_id].cookie;
const route = () => `/_acceptance/runs/${client.state.run.run_id}/export-job-expiry`;
async function csrf() {
  const page = await client.request("/", { headers: { cookie: cookie() } });
  assert.equal(page.status, 200);
  const token = /name="mind-diary-csrf-token" content="([^"]+)"/.exec(await page.text())?.[1];
  assert.ok(token);
  return token;
}
async function startExport(key) {
  const response = await client.request("/api/v1/minds/me/exports", {
    method: "POST",
    body: { revision_selector: { kind: "head" }, profile: "MD-OKF-ZIP-1" },
    headers: { cookie: cookie(), origin: ACCEPTANCE_ORIGIN,
      "content-type": "application/json", "x-csrf-token": await csrf(),
      "idempotency-key": key },
  });
  assert.equal(response.status, 202);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.ok(result.data?.job?.job_id);
  return result.data;
}
async function status(jobId) {
  const response = await client.request(`/api/v1/export-jobs/${jobId}`, {
    headers: { cookie: cookie() },
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  return result.data;
}

if (phase === "prepare") {
  const deploymentId = process.env.MD485_PREPARE_DEPLOYMENT_ID;
  assert.match(deploymentId ?? "", /^appgdep_[a-f0-9]{32}$/);
  assert.ok(["prepared", "created"].includes(client.state.phase));
  if (!client.state.md485ExportExpiry?.baseline) {
    const baseline = await client.control("/_acceptance/inventory");
    assert.equal(baseline.complete, true);
    assert.equal(baseline.principals, 0);
    assert.equal(baseline.owned_minds, 0);
    client.state.md485ExportExpiry = { baseline, candidate: expectedCandidate,
      prepareDeploymentId: deploymentId };
    await client.save();
  }
  await client.setup({ profile: "operator" });
  await client.session(owner().actor_id);
  const bootstrap = await client.mutation("bootstrap:export-expiry", owner().actor_id, {
    path: "/api/v1/account", body: { action: "create_isolated_account" },
    csrf: await csrf(),
  });
  assert.equal(bootstrap.ok, true);
  const armed = await client.control(route(), "POST", { phase: "arm" });
  assert.equal(armed.phase, "armed");
  const key = `acceptance-export-expiry:${client.state.run.run_id}`;
  const started = await startExport(key);
  assert.equal(started.replayed, false);
  assert.equal(started.job.status, "queued");
  const inspected = await client.control(route(), "POST", {
    phase: "inspect", job_id: started.job.job_id,
  });
  assert.equal(inspected.job_state, "queued");
  assert.equal(inspected.reservation_state, "active");
  assert.ok(inspected.reserved_temporary_bytes > 0);
  assert.equal(inspected.expired_now, false);
  client.state.md485ExportExpiry = { ...client.state.md485ExportExpiry,
    jobId: started.job.job_id, jobExpiresAt: inspected.job_expires_at,
    reservedTemporaryBytes: inspected.reserved_temporary_bytes,
    preparedAt: new Date().toISOString() };
  await client.save();
  console.log(JSON.stringify({ phase: "prepared", candidate: expectedCandidate,
    job_state: "queued", reservation_state: "active",
    reserved_temporary_bytes: inspected.reserved_temporary_bytes }));
}

if (phase === "recover") {
  const record = client.state.md485ExportExpiry;
  const coldDeploymentId = process.env.MD485_COLD_DEPLOYMENT_ID;
  assert.match(coldDeploymentId ?? "", /^appgdep_[a-f0-9]{32}$/);
  assert.ok(record?.jobId && record.candidate === expectedCandidate &&
    record.prepareDeploymentId !== coldDeploymentId);
  while (Date.now() < Date.parse(record.jobExpiresAt) + 1000) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(15000,
      Date.parse(record.jobExpiresAt) + 1000 - Date.now())));
  }
  const before = await client.control(route(), "POST", {
    phase: "inspect", job_id: record.jobId,
  });
  assert.equal(before.job_state, "queued");
  assert.equal(before.reservation_state, "active");
  assert.equal(before.expired_now, true);
  const recovered = await client.control(route(), "POST", {
    phase: "recover", job_id: record.jobId,
  });
  assert.equal(recovered.job_state, "expired");
  assert.equal(recovered.reservation_state, "released");
  assert.ok(recovered.archive_cleaned_at);
  const repeated = await client.control(route(), "POST", {
    phase: "recover", job_id: record.jobId,
  });
  assert.equal(repeated.replayed, true);
  const old = await startExport(`acceptance-export-expiry:${client.state.run.run_id}`);
  assert.equal(old.replayed, true);
  assert.equal(old.job.job_id, record.jobId);
  assert.equal(old.job.status, "expired");
  const next = await startExport(`acceptance-export-successor:${client.state.run.run_id}`);
  assert.equal(next.replayed, false);
  assert.notEqual(next.job.job_id, record.jobId);
  let successor = await status(next.job.job_id);
  for (let i = 0; i < 12 && successor.job?.status !== "succeeded"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    successor = await status(next.job.job_id);
  }
  assert.equal(successor.job?.status, "succeeded");
  assert.match(successor.job?.sha256 ?? "", /^sha256:[a-f0-9]{64}$/);
  client.state.md485ExportExpiry = { ...record, coldDeploymentId,
    recoveredAt: new Date().toISOString(), successorJobId: next.job.job_id };
  await client.save();
  console.log(JSON.stringify({ phase: "recovered", candidate: expectedCandidate,
    expired_job_state: "expired", expired_reservation_state: "released",
    exact_key_replayed: true, successor_state: "succeeded" }));
}

if (phase === "cleanup") {
  const record = client.state.md485ExportExpiry;
  assert.ok(record?.baseline && record.candidate === expectedCandidate);
  if (client.state.run) {
    const receipt = await client.cleanup();
    assert.equal(receipt.state, "cleaned");
  }
  const final = await client.control("/_acceptance/inventory");
  assert.deepEqual(final, record.baseline);
  console.log(JSON.stringify({ phase: "cleaned", baseline_restored: true }));
}
