import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForAcceptanceTelemetry } from "../../scripts/lib/acceptance-telemetry-barrier.mjs";
const projectId = "appgprj_test";
const sample = { request_id: "request_one", benchmark_correlation_id: "benchmark_one", profile: "mcp_modern", operation: "fetch" };
const operations = ["mcp_modern", "stage_authentication", "stage_application", "stage_total", "fetch"];
const envelope = (ops, requestId = sample.request_id, project = projectId) => JSON.stringify({ project_id: project, events: ops.map(operation => ({ source: {
  event: "mind-diary.privacy-safe-observability", schema: "mind-diary/privacy-safe-observability/v2", metric: "request_latency_ms",
  surface: "mcp", operation, requestId, benchmarkCorrelationId: sample.benchmark_correlation_id,
} })) }) + "\n";
test("a batch waits for delayed operations, ignoring an incomplete append", async () => {
  const dir = await mkdtemp(join(tmpdir(), "md-barrier-")); const journalPath = join(dir, "logs.jsonl"); let clock = 0;
  try {
    await writeFile(journalPath, envelope(["fetch"]) + '{"project_id":');
    const result = await waitForAcceptanceTelemetry({ journalPath, projectId, samples: [sample], timeoutMs: 1000,
      now: () => clock, sleep: async () => { clock += 100; await writeFile(journalPath, envelope(operations)); } });
    assert.equal(result.waited_ms, 100); assert.deepEqual(result.sample_ids, [sample.benchmark_correlation_id]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("missing operations, a different request ID and foreign target never release a batch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "md-barrier-")); const journalPath = join(dir, "logs.jsonl");
  try {
    for (const content of [envelope(["fetch"]), envelope(operations, "request_other")]) {
      await writeFile(journalPath, content); let clock = 0;
      await assert.rejects(waitForAcceptanceTelemetry({ journalPath, projectId, samples: [sample], timeoutMs: 200,
        now: () => clock, sleep: async () => { clock += 100; } }), /provider_telemetry_barrier_timeout/);
    }
    await writeFile(journalPath, envelope(operations, sample.request_id, "appgprj_other"));
    await assert.rejects(waitForAcceptanceTelemetry({ journalPath, projectId, samples: [sample] }), /foreign_telemetry_journal/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("provider visibility after one minute is accepted within the declared two-minute bound", async () => {
  const dir = await mkdtemp(join(tmpdir(), "md-barrier-")); const journalPath = join(dir, "logs.jsonl"); let clock = 0;
  try {
    await writeFile(journalPath, envelope(["fetch"]));
    const result = await waitForAcceptanceTelemetry({ journalPath, projectId, samples: [sample],
      now: () => clock, sleep: async ms => { clock += ms; if (clock === 75000) await writeFile(journalPath, envelope(operations)); } });
    assert.equal(result.waited_ms, 75000);
    await assert.rejects(waitForAcceptanceTelemetry({ journalPath, projectId, samples: [sample], timeoutMs: 120001 }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
