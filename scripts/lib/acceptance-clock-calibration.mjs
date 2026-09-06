import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const hash = value => "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function observeAcceptanceClock(client, expectedCandidate) {
  const observations = [];
  for (let i = 0; i < 3; i++) {
    const sent_at = new Date().toISOString();
    const response = await client.request("/_acceptance/build");
    const body = await response.text(), received_at = new Date().toISOString();
    assert.equal(response.status, 200); assert.equal(JSON.parse(body).candidate_sha, expectedCandidate);
    const server_date = response.headers.get("date"); assert.ok(server_date);
    observations.push({ sent_at, received_at, server_date, status: response.status,
      body_sha256: "sha256:" + createHash("sha256").update(body).digest("hex") });
  }
  return observations;
}
export function createAcceptanceClockCalibration({ candidate_sha, target_url, before, after }) {
  const unsigned = { schema: "mind-diary/acceptance-clock-calibration/v1", candidate_sha, target_url, before, after };
  return { ...unsigned, artifact_sha256: hash(unsigned) };
}
export function verifyAcceptanceClockCalibration(value, { candidate_sha, target_url, started_at, completed_at }) {
  const { artifact_sha256, ...unsigned } = value;
  assert.deepEqual(Object.keys(unsigned).sort(), ["schema", "candidate_sha", "target_url", "before", "after"].sort());
  assert.equal(value.schema, "mind-diary/acceptance-clock-calibration/v1");
  assert.equal(artifact_sha256, hash(unsigned));
  assert.equal(value.candidate_sha, candidate_sha); assert.equal(value.target_url, target_url);
  let lower = -Infinity, upper = Infinity;
  const bodyHashes = new Set();
  for (const [kind, observations] of [["before", value.before], ["after", value.after]]) {
    assert.equal(observations.length, 3);
    let previous = -Infinity;
    for (const observation of observations) {
      assert.deepEqual(Object.keys(observation).sort(), ["sent_at", "received_at", "server_date", "status", "body_sha256"].sort());
      const sent = Date.parse(observation.sent_at), received = Date.parse(observation.received_at), server = Date.parse(observation.server_date);
      assert.ok(Number.isFinite(sent) && Number.isFinite(received) && Number.isFinite(server));
      assert.equal(new Date(sent).toISOString(), observation.sent_at); assert.equal(new Date(received).toISOString(), observation.received_at);
      assert.equal(new Date(server).toUTCString(), observation.server_date);
      assert.equal(observation.status, 200); assert.match(observation.body_sha256, /^sha256:[a-f0-9]{64}$/); bodyHashes.add(observation.body_sha256);
      assert.ok(received >= sent && received - sent <= 2000 && sent >= previous); previous = received;
      assert.ok(kind === "before" ? received <= Date.parse(started_at) : sent >= Date.parse(completed_at));
      lower = Math.max(lower, server - received); upper = Math.min(upper, server + 999 - sent);
    }
  }
  assert.equal(bodyHashes.size, 1, "clock_probe_build_changed");
  assert.ok(lower <= upper && upper - lower <= 3000 && lower >= -5000 && upper <= 5000, "clock_offset_unbounded_or_inconsistent");
  return { lower_ms: lower, upper_ms: upper, artifact_sha256 };
}
