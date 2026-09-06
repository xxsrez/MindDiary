import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../helpers/performance-fixture.mjs";
import { createSitesLogPerformanceCapture, verifyPerformanceTelemetryCaptureReceipt } from "../../scripts/lib/performance-telemetry-capture.mjs";
function inputs() {
  const f = fixture();
  const input = { candidate_sha: f.candidate_sha, environment: "uat", target_url: f.target_url, deployment: f.profile_readback.deployment,
    started_at: f.started_at, completed_at: f.completed_at, provider_script: "test-provider-worker" };
  const result = { project_id: input.deployment.site_project_id, events: f.server_telemetry.map((event, index) => ({
    $metadata: { id: `synthetic_${index}` }, $workers: { scriptName: input.provider_script, scriptVersion: { id: "synthetic-version" }, truncated: false },
    source: { ...event, event: "mind-diary.privacy-safe-observability", schema: "mind-diary/privacy-safe-observability/v2" },
  })) };
  return { input, result, ids: [...new Set(f.server_telemetry.map(e => e.benchmarkCorrelationId))] };
}
test("Sites capture records actual source envelope and verifies exact JSONL without inventing a request id", () => {
  const { input, result, ids } = inputs();
  const captured = createSitesLogPerformanceCapture(input, result, ids);
  assert.equal(captured.receipt.schema, "mind-diary/performance-telemetry-capture/v2");
  assert.equal(Object.hasOwn(captured.receipt, "control_plane_query_id"), false);
  assert.equal(verifyPerformanceTelemetryCaptureReceipt(captured.receipt, captured.telemetryJsonl).event_count, result.events.length);
  assert.throws(() => verifyPerformanceTelemetryCaptureReceipt(captured.receipt, captured.telemetryJsonl + " "), /invalid_capture_receipt/);
});
test("foreign provider, missing signed correlation, truncation and mixed versions fail capture", () => {
  for (const mutate of [r => { r.project_id = "appgprj_wrong"; }, r => { r.events[0].$workers.scriptName = "other"; },
    r => { r.events[0].$workers.truncated = true; }, r => { r.events[0].$workers.scriptVersion.id = "other-version"; },
    r => { r.events.forEach(e => { delete e.source.benchmarkCorrelationId; }); }]) {
    const { input, result, ids } = inputs(); mutate(result); assert.throws(() => createSitesLogPerformanceCapture(input, result, ids));
  }
});
test("bounded overlapping captures preserve each actual envelope and reject conflicting duplicate events", () => {
  const { input, result, ids } = inputs();
  const captures = [{ ...result, events: result.events.slice(0, 100) }, { ...result, events: result.events.slice(50) }];
  const captured = createSitesLogPerformanceCapture(input, captures, ids);
  assert.equal(captured.receipt.control_plane_source.result_kind, "sites-log-envelope-batch");
  assert.equal(captured.receipt.control_plane_source.envelope_sha256s.length, 2);
  assert.equal(verifyPerformanceTelemetryCaptureReceipt(captured.receipt, captured.telemetryJsonl).event_count, result.events.length);
  const duplicate = structuredClone(result.events[0]); duplicate.source.value += 1;
  assert.throws(() => createSitesLogPerformanceCapture(input, [result, { ...result, events: [duplicate] }], ids), /conflicting_provider_event/);
});
