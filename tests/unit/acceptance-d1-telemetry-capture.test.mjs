import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../helpers/performance-fixture.mjs";
import { createSitesD1PerformanceCapture, verifyPerformanceTelemetryCaptureReceipt } from "../../scripts/lib/performance-telemetry-capture.mjs";
import { evaluatePerformanceGate } from "../../scripts/lib/performance-gate.mjs";

function inputs() {
  const f = fixture(), runId = "11111111-1111-4111-8111-111111111111", adapter = "b".repeat(64), indexes = new Map();
  const input = { candidate_sha: f.candidate_sha, environment: "uat", target_url: f.target_url, deployment: f.profile_readback.deployment,
    started_at: f.started_at, completed_at: f.completed_at, run_id: runId, test_adapter_sha256: adapter };
  const rows = f.server_telemetry.map(event => {
    const id = event.benchmarkCorrelationId, index = indexes.get(id) ?? 0; indexes.set(id, index + 1);
    const source = { event: "mind-diary.privacy-safe-observability", schema: "mind-diary/privacy-safe-observability/v2" };
    for (const key of ["kind", "metric", "surface", "operation", "outcome", "unit", "value", "occurredAtUtc", "requestId", "jobId", "cohort", "benchmarkCorrelationId"]) source[key] = event[key] ?? null;
    const serialized = JSON.stringify(source); assert.ok(serialized.length <= 960);
    return { run_id: runId, correlation_id: id, event_index: index, candidate_sha: f.candidate_sha, adapter_sha256: adapter,
      ...Object.fromEntries([0, 1, 2, 3].map(n => [`event_json_${n}`, serialized.slice(n * 240, (n + 1) * 240)])) };
  });
  const pages = [];
  for (let offset = 0; offset < rows.length; offset += 25) {
    const more = offset + 25 < rows.length;
    pages.push({ project_id: input.deployment.site_project_id, binding_name: "DB", table_name: "md_acceptance_telemetry", columns: Object.keys(rows[0]),
      offset, limit: 25, has_more: more, rows: rows.slice(offset, offset + 25), model_projection: { next_offset: more ? offset + 25 : null,
        omitted_columns: 0, omitted_rows: 0, truncated: false, truncated_values: 0 } });
  }
  return { f, input, pages, ids: [...indexes.keys()] };
}
test("D1 capture retains actual paginated source identity and passes the unchanged performance gate", () => {
  const { f, input, pages, ids } = inputs(), captured = createSitesD1PerformanceCapture(input, pages, ids);
  assert.equal(captured.receipt.control_plane_source.tool, "sites_read_database_table_rows");
  assert.equal(captured.receipt.control_plane_source.page_sha256s.length, pages.length);
  assert.equal(verifyPerformanceTelemetryCaptureReceipt(captured.receipt, captured.telemetryJsonl).event_count, f.server_telemetry.length);
  assert.equal(evaluatePerformanceGate({ ...f, server_telemetry: captured.telemetry, telemetry_capture: captured.receipt }).status, "passed");
  const forged = structuredClone(captured.receipt); forged.control_plane_source.run_id = "22222222-2222-4222-8222-222222222222";
  assert.throws(() => verifyPerformanceTelemetryCaptureReceipt(forged, captured.telemetryJsonl));
  assert.throws(() => verifyPerformanceTelemetryCaptureReceipt(captured.receipt, captured.telemetryJsonl.replace('"value":', '"value":9')));
});
test("foreign table, candidate, adapter or run, truncation, duplicate rows and pagination gaps fail", () => {
  for (const mutate of [p => { p[0].project_id = "appgprj_other"; }, p => { p[0].table_name = "other"; },
    p => { p[0].model_projection.truncated_values = 1; }, p => { p[0].model_projection.omitted_columns = 1; },
    p => { p[1].offset++; }, p => { p.pop(); }, p => { p[0].rows[0].candidate_sha = "c".repeat(40); },
    p => { p[0].rows[0].adapter_sha256 = "c".repeat(64); }, p => { p[0].rows[0].run_id = "22222222-2222-4222-8222-222222222222"; },
    p => { p[0].rows[1] = p[0].rows[0]; }, p => { p[0].rows[0].event_json_0 += "x"; }]) {
    const { input, pages, ids } = inputs(); mutate(pages); assert.throws(() => createSitesD1PerformanceCapture(input, pages, ids));
  }
});
