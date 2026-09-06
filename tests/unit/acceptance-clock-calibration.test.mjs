import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../helpers/performance-fixture.mjs";
import { createAcceptanceClockCalibration, verifyAcceptanceClockCalibration } from "../../scripts/lib/acceptance-clock-calibration.mjs";
import { evaluatePerformanceGate, verifyPerformanceGateArtifact } from "../../scripts/lib/performance-gate.mjs";
import { createPerformanceTelemetryCaptureReceipt } from "../../scripts/lib/performance-telemetry-capture.mjs";
function calibration(f, serverOffset = 750) {
  const probes = base => [0, 1, 2].map(i => {
    const sent = Math.floor(base / 1000) * 1000 + i * 1000 + 250;
    return { sent_at: new Date(sent).toISOString(), received_at: new Date(sent + 100).toISOString(), server_date: new Date(sent + serverOffset).toUTCString(), status: 200, body_sha256: "sha256:" + "a".repeat(64) };
  });
  return createAcceptanceClockCalibration({ candidate_sha: f.candidate_sha, target_url: f.target_url,
    before: probes(Date.parse(f.started_at) - 5000), after: probes(Date.parse(f.completed_at) + 5000) });
}
function recapture(f) {
  const c = f.telemetry_capture;
  f.telemetry_capture = createPerformanceTelemetryCaptureReceipt({ status: c.status, candidate_sha: c.candidate_sha, environment: c.environment,
    target_url: c.target_url, deployment: c.deployment, started_at: c.started_at, completed_at: c.completed_at, generator: c.generator,
    control_plane_query_id: c.control_plane_query_id }, f.server_telemetry.map(e => JSON.stringify(e)).join("\n") + "\n");
}
test("v4 admits measured clock offset without changing any duration or v3 behavior", () => {
  const f = fixture();
  const original = evaluatePerformanceGate(f); assert.equal(original.status, "passed"); assert.equal(original.schema, "mind-diary/performance-gate/v3");
  f.server_telemetry = f.server_telemetry.map(e => ({ ...e, occurredAtUtc: new Date(Date.parse(e.occurredAtUtc) + 750).toISOString() })); recapture(f);
  assert.equal(evaluatePerformanceGate(f).status, "failed");
  f.clock_calibration = calibration(f);
  const report = evaluatePerformanceGate(f);
  assert.equal(report.status, "passed", JSON.stringify(report.failures)); assert.equal(report.schema, "mind-diary/performance-gate/v4");
  assert.deepEqual(report.connector, original.connector); assert.deepEqual(report.server, original.server); assert.deepEqual(report.budgets_ms, original.budgets_ms);
  assert.equal(verifyPerformanceGateArtifact(report), report);
  f.server_telemetry[0].occurredAtUtc = new Date(Date.parse(f.server_telemetry[0].occurredAtUtc) + 10000).toISOString(); recapture(f);
  assert.equal(evaluatePerformanceGate(f).status, "failed");
});
test("a claimed offset, foreign target, missing bracketing probes or inconsistent clock cannot pass", () => {
  const f = fixture(), c = calibration(f);
  const changed = structuredClone(c); changed.before[0].server_date = new Date(0).toUTCString();
  assert.throws(() => verifyAcceptanceClockCalibration(changed, f));
  assert.throws(() => verifyAcceptanceClockCalibration(calibration(f, 20000), f));
  assert.throws(() => verifyAcceptanceClockCalibration(c, { ...f, target_url: "https://other.invalid" }));
  const resealed = createAcceptanceClockCalibration({ candidate_sha: c.candidate_sha, target_url: c.target_url, before: c.after, after: c.after });
  assert.throws(() => verifyAcceptanceClockCalibration(resealed, f));
});
