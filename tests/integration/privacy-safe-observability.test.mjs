import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryPrivacySafeObservabilitySink,
  UnsafeObservabilityEventError,
} from "@mind-diary/adapter-audit-memory";
import {
  SITES_OBSERVABILITY_EVENT,
  SITES_OBSERVABILITY_SCHEMA,
  SitesPrivacySafeObservabilitySink,
  UnsafeSitesObservabilityEventError,
} from "@mind-diary/adapter-audit-sites";
import {
  createLocalMcpHttpBoundary,
  createLocalPrivacySafeObservabilityBoundary,
} from "@mind-diary/composition-root";

const T0 = "2026-08-07T22:00:00.000Z";
const PRIVATE_QUERY = "private corpus needle";
const PRIVATE_BODY = "my private Memory body";
const TOKEN = `mdp_v1_${"A".repeat(43)}`;
const DOWNLOAD_URL = "https://objects.example/private-grant";
const VERIFIED_EMAIL = "private.person@example.invalid";
const SOURCE_ADDRESS = "198.51.100.73";
const USER_AGENT = "MindDiary-Private-Client/9.9";
const PRIVATE_PATH = "/me/private-memory?query=hidden";
const AUTHORIZATION = `Bearer ${"B".repeat(48)}`;
const SIGNED_URL = "https://objects.example/private?signature=hidden";

const REQUEST_ENVELOPE_SENTINELS = Object.freeze([
  PRIVATE_QUERY,
  PRIVATE_BODY,
  TOKEN,
  DOWNLOAD_URL,
  VERIFIED_EMAIL,
  SOURCE_ADDRESS,
  USER_AGENT,
  PRIVATE_PATH,
  AUTHORIZATION,
  SIGNED_URL,
]);

function actor(requestId, occurredAtUtc = T0) {
  return { requestId, occurredAtUtc };
}

function validEvent(overrides = {}) {
  return {
    kind: "operational",
    metric: "request_error",
    surface: "mcp",
    operation: "request",
    outcome: "failure",
    unit: "count",
    value: 1,
    occurredAtUtc: T0,
    requestId: "request_redaction_1",
    jobId: null,
    cohort: null,
    ...overrides,
  };
}

test("privacy-safe operational and pilot metrics retain only closed dimensions", async () => {
  const clock = { now: () => T0 };
  const telemetry = createLocalPrivacySafeObservabilityBoundary({
    clock,
    cohort: "external",
  });
  assert.equal(telemetry.adapter, "memory-privacy-safe-metrics");

  telemetry.control.record({
    event: "account_bootstrap_succeeded",
    requestId: "request_setup_1",
  });
  telemetry.control.record({
    event: "invitation_denied",
    requestId: "request_invitation_1",
  });
  telemetry.control.record({
    event: "token_issued",
    requestId: "request_token_1",
  });
  telemetry.control.record({
    event: "account_delete_failed",
    requestId: "request_deletion_1",
  });
  telemetry.control.record({
    event: "ordinary_mind_conflict",
    requestId: "request_control_conflict_1",
  });
  telemetry.control.recordRetention({
    ...actor("request_retention_week_4"),
    week: 4,
    retained: true,
    count: 1,
  });

  telemetry.content.recordCasConflict(actor("request_content_conflict_1"));
  telemetry.content.recordPilot({
    actor: actor("request_first_search_1"),
    metric: "time_to_first_useful_search_ms",
    operation: "search",
    outcome: "completed",
    value: 1_200,
  });
  telemetry.content.recordPilot({
    actor: actor("request_first_commit_1"),
    metric: "time_to_first_meaningful_commit_ms",
    operation: "commit_changeset",
    outcome: "completed",
    value: 2_400,
  });
  for (const operation of ["read", "write", "history", "export"]) {
    telemetry.content.recordPilot({
      actor: actor(`request_usage_${operation}`),
      metric: "usage",
      operation,
      outcome: "completed",
      value: 1,
    });
  }
  telemetry.content.recordPilot({
    actor: actor("request_lexical_1"),
    metric: "lexical_search_effectiveness",
    operation: "search",
    outcome: "resolved",
    value: 1,
  });
  telemetry.content.recordPilot({
    actor: actor("request_citation_1"),
    metric: "citation_success",
    operation: "citation",
    outcome: "resolved",
    value: 1,
  });
  telemetry.content.recordCost({
    actor: actor("request_storage_1"),
    metric: "storage_cost_bytes",
    value: 4_096,
  });
  telemetry.content.recordCost({
    actor: actor("request_query_cost_1"),
    metric: "query_cost_units",
    value: 3,
  });
  telemetry.content.recordMcpRequest({
    ...actor("request_rate_limit_1"),
    durationMs: 8,
    status: 429,
    outcome: "internal_error",
  });
  telemetry.content.recordMcpPerformance({
    requestId: "request_mcp_performance_1",
    occurredAtUtc: T0,
    durationMs: 12.5,
    profile: "mcp_modern",
    stage: "stage_application",
    tool: "list_minds",
    outcome: "success",
  });

  telemetry.background.recordJob({
    actor: actor("request_index_worker_1"),
    jobId: "index_job_1",
    occurredAtUtc: T0,
    job: "revision_index",
    outcome: "retry",
    lagMs: 500,
  });
  telemetry.background.recordJob({
    actor: actor("request_index_terminal_1"),
    jobId: "index_job_terminal_1",
    occurredAtUtc: T0,
    job: "revision_index",
    outcome: "unresolved",
    lagMs: 750,
  });
  telemetry.background.recordJob({
    actor: actor("request_export_worker_1"),
    jobId: "export_job_1",
    occurredAtUtc: T0,
    job: "export",
    outcome: "success",
    lagMs: 900,
  });
  telemetry.background.recordExportUsage({
    actor: actor("request_export_usage_1"),
    jobId: "export_job_1",
    occurredAtUtc: T0,
    count: 1,
  });

  const boundary = await createLocalMcpHttpBoundary({
    verifierKey: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    clock,
    requestIds: { nextRequestId: () => "request_mcp_auth_1" },
    content: {},
    observability: telemetry.content,
  });
  const response = await boundary.handler(
    new Request("https://mind-diary.example/api/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: "{}",
    }),
  );
  assert.equal(response.status, 401);

  const dashboard = telemetry.sink.dashboard();
  const metricNames = new Set(dashboard.metrics.map((metric) => metric.metric));
  for (const required of [
    "request_latency_ms",
    "request_error",
    "authentication_outcome",
    "cas_conflict",
    "index_lag_ms",
    "export_lag_ms",
    "invitation_outcome",
    "token_outcome",
    "deletion_outcome",
    "rate_limit",
    "storage_cost_bytes",
    "query_cost_units",
    "setup_completion",
    "time_to_first_useful_search_ms",
    "time_to_first_meaningful_commit_ms",
    "usage",
    "retention",
    "lexical_search_effectiveness",
    "citation_success",
  ]) {
    assert.ok(metricNames.has(required), `missing ${required}`);
  }
  assert.ok(dashboard.alerts.includes("request_errors_present"));
  assert.ok(dashboard.alerts.includes("authentication_failures_present"));
  assert.ok(dashboard.alerts.includes("cas_conflicts_present"));
  assert.ok(dashboard.alerts.includes("index_lag_present"));
  assert.ok(dashboard.alerts.includes("export_lag_present"));
  assert.ok(dashboard.alerts.includes("rate_limits_present"));
  assert.ok(
    dashboard.correlations.some(
      (item) =>
        item.requestId === "request_export_worker_1" &&
        item.jobId === "export_job_1",
    ),
  );
  assert.ok(telemetry.sink.eventsForTest().some((event) =>
    event.operation === "revision_index" &&
    event.outcome === "unresolved" &&
    event.jobId === "index_job_terminal_1"
  ));

  const serialized = JSON.stringify({
    events: telemetry.sink.eventsForTest(),
    dashboard,
  });
  for (const secret of REQUEST_ENVELOPE_SENTINELS) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(serialized.includes("inference"), false);
});

test("redaction contract rejects extra payload fields and unsafe correlations", () => {
  const sink = new InMemoryPrivacySafeObservabilitySink();
  for (const event of [
    { ...validEvent(), privateQuery: PRIVATE_QUERY },
    { ...validEvent(), corpusBody: PRIVATE_BODY },
    { ...validEvent(), tokenSecret: TOKEN },
    { ...validEvent(), downloadUrl: DOWNLOAD_URL },
    { ...validEvent(), verifiedEmail: VERIFIED_EMAIL },
    { ...validEvent(), sourceAddress: SOURCE_ADDRESS },
    { ...validEvent(), userAgent: USER_AGENT },
    { ...validEvent(), requestPath: PRIVATE_PATH },
    { ...validEvent(), authorization: AUTHORIZATION },
    { ...validEvent(), signedUrl: SIGNED_URL },
    validEvent({ requestId: TOKEN }),
    validEvent({ requestId: VERIFIED_EMAIL }),
    validEvent({ requestId: SOURCE_ADDRESS }),
    validEvent({ requestId: USER_AGENT }),
    validEvent({ requestId: AUTHORIZATION }),
    validEvent({ jobId: DOWNLOAD_URL }),
    validEvent({ jobId: SIGNED_URL }),
    validEvent({ operation: "inference" }),
  ]) {
    assert.throws(
      () => sink.record(event),
      (error) =>
        error instanceof UnsafeObservabilityEventError &&
        REQUEST_ENVELOPE_SENTINELS.every((value) =>
          !JSON.stringify(error).includes(value)),
    );
  }
  assert.deepEqual(sink.eventsForTest(), []);
  assert.deepEqual(sink.dashboard().metrics, []);
});

test("deployable Sites telemetry emits one closed JSON projection and rejects private dimensions", () => {
  const lines = [];
  const sink = new SitesPrivacySafeObservabilitySink({
    write(serializedEvent) {
      lines.push(serializedEvent);
    },
  });
  sink.record(validEvent({
    requestId: "request_sites_observability_1",
    jobId: "job-export_fixture_1",
  }));
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.event, SITES_OBSERVABILITY_EVENT);
  assert.equal(event.schema, SITES_OBSERVABILITY_SCHEMA);
  assert.deepEqual(Object.keys(event).sort(), [
    "cohort",
    "event",
    "jobId",
    "kind",
    "metric",
    "occurredAtUtc",
    "operation",
    "outcome",
    "requestId",
    "schema",
    "surface",
    "unit",
    "value",
  ]);

  for (const unsafe of [
    { ...validEvent(), privateQuery: PRIVATE_QUERY },
    { ...validEvent(), body: PRIVATE_BODY },
    { ...validEvent(), email: VERIFIED_EMAIL },
    { ...validEvent(), token: TOKEN },
    { ...validEvent(), downloadUrl: DOWNLOAD_URL },
    { ...validEvent(), sourceAddress: SOURCE_ADDRESS },
    { ...validEvent(), userAgent: USER_AGENT },
    { ...validEvent(), requestPath: PRIVATE_PATH },
    { ...validEvent(), authorization: AUTHORIZATION },
    { ...validEvent(), signedUrl: SIGNED_URL },
    validEvent({ requestId: VERIFIED_EMAIL }),
    validEvent({ requestId: SOURCE_ADDRESS }),
    validEvent({ requestId: USER_AGENT }),
    validEvent({ requestId: AUTHORIZATION }),
    validEvent({ jobId: DOWNLOAD_URL }),
    validEvent({ jobId: SIGNED_URL }),
  ]) {
    assert.throws(
      () => sink.record(unsafe),
      (error) => error instanceof UnsafeSitesObservabilityEventError &&
        REQUEST_ENVELOPE_SENTINELS.every((value) =>
          !JSON.stringify(error).includes(value)),
    );
  }
  assert.equal(lines.length, 1);
});
