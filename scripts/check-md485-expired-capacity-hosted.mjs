import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AcceptanceClient } from "./lib/acceptance-client.mjs";

const [phase, tag, expectedCandidate] = process.argv.slice(2);
if (!["seed", "recover", "cleanup"].includes(phase) ||
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
// Deployment identity is established by separate native Sites read-backs.
// This runner checks the durable reservation across two hosted invocations.

if (phase === "seed") {
  assert.ok(["prepared", "created"].includes(client.state.phase));
  if (!client.state.md485Expiry?.baseline) {
    const baseline = await client.control("/_acceptance/inventory");
    assert.equal(baseline.complete, true);
    assert.equal(baseline.principals, 0);
    assert.equal(baseline.owned_minds, 0);
    client.state.md485Expiry = { baseline, candidate: expectedCandidate };
    await client.save();
  }
  await client.setup({ profile: "operator" });
  const owner = client.state.run.actors[0];
  await client.session(owner.actor_id);
  const page = await client.request("/", { headers: { cookie: client.state.actors[owner.actor_id].cookie } });
  assert.equal(page.status, 200);
  const csrf = /name="mind-diary-csrf-token" content="([^"]+)"/.exec(await page.text())?.[1];
  assert.ok(csrf);
  const bootstrap = await client.mutation("bootstrap:expiry-owner", owner.actor_id, {
    path: "/api/v1/account", body: { action: "create_isolated_account" }, csrf,
  });
  assert.equal(bootstrap.ok, true);
  assert.ok(bootstrap.data?.principal_id && bootstrap.data?.personal_mind?.mind_id);
  const seeded = await client.control(
    `/_acceptance/runs/${client.state.run.run_id}/expired-heavy-reservation`,
    "POST", { phase: "seed" },
  );
  assert.equal(seeded.phase, "seeded");
  assert.equal(seeded.state, "active");
  assert.equal(seeded.expired_at_seed, true);
  client.state.md485Expiry = { ...client.state.md485Expiry,
    reservationId: seeded.reservation_id, seededAt: new Date().toISOString() };
  await client.save();
  console.log(JSON.stringify({ phase: "seeded", candidate: expectedCandidate,
    reservation_state: seeded.state,
    expired_at_seed: true }));
}

if (phase === "recover") {
  const record = client.state.md485Expiry;
  assert.ok(record?.reservationId && record.candidate === expectedCandidate);
  const recovered = await client.control(
    `/_acceptance/runs/${client.state.run.run_id}/expired-heavy-reservation`,
    "POST", { phase: "recover" },
  );
  assert.deepEqual(recovered, { phase: "recovered",
    expired_reservation_state: "released", successor_state: "released",
    run_reservations_released: true });
  client.state.md485Expiry = { ...record, recoveredAt: new Date().toISOString() };
  await client.save();
  console.log(JSON.stringify({ phase: "recovered", candidate: expectedCandidate,
    expired_reservation_state: "released",
    successor_state: "released", run_reservations_released: true }));
}

if (phase === "cleanup") {
  const record = client.state.md485Expiry;
  assert.ok(record?.baseline && record.recoveredAt && record.candidate === expectedCandidate);
  const receipt = await client.cleanup();
  assert.equal(receipt.state, "cleaned");
  const final = await client.control("/_acceptance/inventory");
  assert.deepEqual(final, record.baseline);
  console.log(JSON.stringify({ phase: "cleaned", baseline_restored: true }));
}
