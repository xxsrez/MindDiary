import assert from "node:assert/strict";
import test from "node:test";

import {
  PERFORMANCE_BUDGETS_MS,
  evaluatePerformanceGate,
  percentile,
} from "../../scripts/lib/performance-gate.mjs";

const matrix = {
  mind_counts: [1, 10, 100],
  revision_counts: [1, 20, 100, 1000],
  brain_markdown: { files: 1741, bytes: 5681704 },
  mixed_corpus_bytes: 590000000,
};

function samples(value) {
  return Array.from({ length: 20 }, () => value);
}

function telemetry(operation, value) {
  return samples(value).map((duration) => ({
    event: "mind-diary.privacy-safe-observability",
    metric: "request_latency_ms",
    surface: "mcp",
    operation,
    outcome: "success",
    value: duration,
  }));
}

function validInput() {
  return {
    candidate_sha: "a".repeat(40),
    deployment_id: "deployment_fixture",
    environment: "uat",
    warm_samples: 20,
    profile_matrix: matrix,
    connector_results: [
      { id: "home", operation: "home", observed_cold_ms: 100, warm_ms: samples(50) },
      { id: "list", operation: "list_minds", observed_cold_ms: 100, warm_ms: samples(80) },
      { id: "history-1x", operation: "get_revision", history_scale: 1, observed_cold_ms: 100, warm_ms: samples(100) },
      { id: "history-10x", operation: "get_revision", history_scale: 10, observed_cold_ms: 100, warm_ms: samples(110) },
    ],
    server_telemetry: [
      ...telemetry("list_minds", 100),
      ...telemetry("browse_entries", 100),
      ...telemetry("search", 100),
      ...telemetry("fetch", 100),
    ],
  };
}

test("nearest-rank percentile is deterministic", () => {
  assert.equal(percentile([4, 1, 3, 2, 5], 0.95), 5);
  assert.equal(percentile(samples(7), 0.95), 7);
  assert.equal(percentile([], 0.95), null);
});

test("performance gate passes only complete nonzero budgets and 20-sample evidence", () => {
  assert.ok(PERFORMANCE_BUDGETS_MS.server.list_minds > 0);
  assert.ok(PERFORMANCE_BUDGETS_MS.connector_read > 0);
  const report = evaluatePerformanceGate(validInput());
  assert.equal(report.status, "passed", JSON.stringify(report.failures));
  assert.deepEqual(report.failures, []);
  assert.equal(report.history_growth.ratio, 1.1);
});

test("performance gate fails closed on budget, coverage, sample and history regressions", () => {
  const input = validInput();
  input.warm_samples = 19;
  input.profile_matrix = { ...matrix, mind_counts: [1] };
  input.connector_results[0] = {
    ...input.connector_results[0],
    observed_cold_ms: 6_000,
    warm_ms: samples(4_000).slice(0, 19),
  };
  input.connector_results[3] = {
    ...input.connector_results[3],
    warm_ms: samples(150),
  };
  input.server_telemetry = input.server_telemetry.filter(
    (event) => event.operation !== "fetch",
  );
  const report = evaluatePerformanceGate(input);
  assert.equal(report.status, "failed");
  for (const failure of [
    "warm_samples_below_20",
    "mind_count_matrix_incomplete",
    "connector_samples_below_20:home",
    "observed_cold_budget_exceeded:home",
    "connector_p95_budget_exceeded:home",
    "server_samples_below_20:fetch",
    "history_point_read_growth_exceeded",
  ]) assert.ok(report.failures.includes(failure), failure);
});
