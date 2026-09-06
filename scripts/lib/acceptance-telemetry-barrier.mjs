import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { requiredPerformanceGroupOperations } from "./performance-gate.mjs";

// Backpressure for the provider's bounded, eventually visible log query.
// This is scheduling only: the final gate still verifies the original capture.
export async function waitForAcceptanceTelemetry({ journalPath, projectId, samples, timeoutMs = 120000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  assert.ok(samples.length > 0 && samples.length <= 7);
  assert.equal(new Set(samples.map(sample => sample.benchmark_correlation_id)).size, samples.length);
  assert.ok(timeoutMs > 0 && timeoutMs <= 120000);
  const started = now();
  for (;;) {
    let text = "";
    try { text = await readFile(journalPath, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const operations = new Map(samples.map(sample => [sample.benchmark_correlation_id, new Set()]));
    // An append may be in progress. Only complete JSONL records are visible.
    for (const line of text.split("\n").slice(0, -1)) {
      if (!line) continue;
      const envelope = JSON.parse(line);
      assert.equal(envelope.project_id, projectId, "foreign_telemetry_journal");
      assert.ok(Array.isArray(envelope.events), "invalid_telemetry_journal");
      for (const event of envelope.events) {
        const source = event.source;
        if (source?.event !== "mind-diary.privacy-safe-observability" || source.schema !== "mind-diary/privacy-safe-observability/v2" || source.metric !== "request_latency_ms") continue;
        const sample = samples.find(value => value.benchmark_correlation_id === source.benchmarkCorrelationId && value.request_id === source.requestId);
        if (sample && source.surface === (sample.profile === "web" ? "control" : "mcp")) operations.get(sample.benchmark_correlation_id).add(source.operation);
      }
    }
    const elapsed = now() - started;
    if (elapsed > timeoutMs) throw Error("provider_telemetry_barrier_timeout");
    if (samples.every(sample => requiredPerformanceGroupOperations(sample.profile, sample.operation).every(operation => operations.get(sample.benchmark_correlation_id).has(operation)))) {
      return { sample_ids: samples.map(sample => sample.benchmark_correlation_id), waited_ms: elapsed };
    }
    if (now() - started >= timeoutMs) throw Error("provider_telemetry_barrier_timeout");
    await sleep(Math.min(1000, timeoutMs - (now() - started)));
  }
}
