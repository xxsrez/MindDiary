export const PERFORMANCE_GATE_SCHEMA = "mind-diary/performance-gate/v1";

export const PERFORMANCE_BUDGETS_MS = Object.freeze({
  server: Object.freeze({
    list_minds: 2_000,
    browse_entries: 2_000,
    search: 2_000,
    fetch: 1_000,
  }),
  connector_read: 5_000,
  home: 3_000,
  observed_cold: 5_000,
  history_growth_ratio: 1.2,
});

export const REQUIRED_PROFILE_MATRIX = Object.freeze({
  mind_counts: Object.freeze([1, 10, 100]),
  revision_counts: Object.freeze([1, 20, 100, 1_000]),
  brain_markdown_minimum: Object.freeze({ files: 1_741, bytes: 5_681_704 }),
  mixed_corpus_minimum_bytes: 590_000_000,
});

const READ_OPERATIONS = new Set([
  "list_minds",
  "browse_entries",
  "search",
  "fetch",
  "get_mind_info",
  "get_mind_bindings",
  "list_revisions",
  "get_revision",
  "validate_mind",
  "get_export_status",
]);

export function percentile(samples, fraction) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const sorted = samples.map(Number).sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

function sameRequiredValues(actual, required) {
  return Array.isArray(actual) && required.every((value) => actual.includes(value));
}

function rounded(value) {
  return value === null ? null : Number(value.toFixed(3));
}

function summarizeSamples(samples) {
  return Object.freeze({
    samples: samples.length,
    min_ms: rounded(Math.min(...samples)),
    p50_ms: rounded(percentile(samples, 0.5)),
    p95_ms: rounded(percentile(samples, 0.95)),
    max_ms: rounded(Math.max(...samples)),
  });
}

export function evaluatePerformanceGate(input) {
  const failures = [];
  const warmMinimum = Number(input.warm_samples);
  if (!Number.isSafeInteger(warmMinimum) || warmMinimum < 20) {
    failures.push("warm_samples_below_20");
  }
  const matrix = input.profile_matrix ?? {};
  if (!sameRequiredValues(matrix.mind_counts, REQUIRED_PROFILE_MATRIX.mind_counts)) {
    failures.push("mind_count_matrix_incomplete");
  }
  if (!sameRequiredValues(matrix.revision_counts, REQUIRED_PROFILE_MATRIX.revision_counts)) {
    failures.push("revision_count_matrix_incomplete");
  }
  if (
    !matrix.brain_markdown ||
    Number(matrix.brain_markdown.files) < REQUIRED_PROFILE_MATRIX.brain_markdown_minimum.files ||
    Number(matrix.brain_markdown.bytes) < REQUIRED_PROFILE_MATRIX.brain_markdown_minimum.bytes
  ) {
    failures.push("brain_markdown_profile_incomplete");
  }
  if (Number(matrix.mixed_corpus_bytes) < REQUIRED_PROFILE_MATRIX.mixed_corpus_minimum_bytes) {
    failures.push("mixed_corpus_profile_incomplete");
  }

  const connector = [];
  for (const result of input.connector_results ?? []) {
    const warm = result.warm_ms ?? [];
    const summary = summarizeSamples(warm);
    connector.push(Object.freeze({
      id: result.id,
      operation: result.operation,
      observed_cold_ms: rounded(result.observed_cold_ms),
      warm: summary,
      history_scale: result.history_scale ?? null,
    }));
    if (warm.length < 20) failures.push(`connector_samples_below_20:${result.id}`);
    if (Number(result.observed_cold_ms) > PERFORMANCE_BUDGETS_MS.observed_cold) {
      failures.push(`observed_cold_budget_exceeded:${result.id}`);
    }
    const budget = result.operation === "home"
      ? PERFORMANCE_BUDGETS_MS.home
      : READ_OPERATIONS.has(result.operation)
        ? PERFORMANCE_BUDGETS_MS.connector_read
        : null;
    if (budget !== null && summary.p95_ms > budget) {
      failures.push(`connector_p95_budget_exceeded:${result.id}`);
    }
  }

  const server = [];
  const serverByOperation = new Map();
  for (const event of input.server_telemetry ?? []) {
    if (
      event?.event !== "mind-diary.privacy-safe-observability" ||
      event?.metric !== "request_latency_ms" ||
      event?.surface !== "mcp" ||
      event?.outcome !== "success" ||
      typeof event?.value !== "number"
    ) continue;
    const values = serverByOperation.get(event.operation) ?? [];
    values.push(event.value);
    serverByOperation.set(event.operation, values);
  }
  for (const [operation, budget] of Object.entries(PERFORMANCE_BUDGETS_MS.server)) {
    const samples = serverByOperation.get(operation) ?? [];
    const summary = samples.length === 0
      ? Object.freeze({ samples: 0, min_ms: null, p50_ms: null, p95_ms: null, max_ms: null })
      : summarizeSamples(samples);
    server.push(Object.freeze({ operation, warm: summary }));
    if (samples.length < 20) failures.push(`server_samples_below_20:${operation}`);
    if (summary.p95_ms !== null && summary.p95_ms > budget) {
      failures.push(`server_p95_budget_exceeded:${operation}`);
    }
  }

  const historyOne = connector.find((result) => result.history_scale === 1);
  const historyTen = connector.find((result) => result.history_scale === 10);
  let historyGrowth = null;
  if (!historyOne || !historyTen) {
    failures.push("history_1x_10x_comparison_missing");
  } else {
    const baseline = historyOne.warm.p95_ms;
    const scaled = historyTen.warm.p95_ms;
    const ratio = baseline === 0 ? (scaled === 0 ? 1 : Number.POSITIVE_INFINITY) : scaled / baseline;
    historyGrowth = Object.freeze({
      baseline_id: historyOne.id,
      scaled_id: historyTen.id,
      baseline_p95_ms: baseline,
      scaled_p95_ms: scaled,
      ratio: Number.isFinite(ratio) ? rounded(ratio) : null,
      budget_ratio: PERFORMANCE_BUDGETS_MS.history_growth_ratio,
    });
    if (!Number.isFinite(ratio) || ratio > PERFORMANCE_BUDGETS_MS.history_growth_ratio) {
      failures.push("history_point_read_growth_exceeded");
    }
  }

  return Object.freeze({
    schema: PERFORMANCE_GATE_SCHEMA,
    status: failures.length === 0 ? "passed" : "failed",
    candidate_sha: input.candidate_sha,
    deployment_id: input.deployment_id,
    environment: input.environment,
    warm_samples: warmMinimum,
    budgets_ms: PERFORMANCE_BUDGETS_MS,
    profile_matrix: matrix,
    connector: Object.freeze(connector),
    server: Object.freeze(server),
    history_growth: historyGrowth,
    failures: Object.freeze(failures),
  });
}
