import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import process from "node:process";

import {
  evaluatePerformanceGate,
  parsePerformanceTelemetryJsonl,
  validatePerformanceScenario,
  verifyPerformanceScenarioCredentialBindings,
} from "./lib/performance-gate.mjs";
import { verifyPerformanceProfileReadbackReceipt } from "./lib/performance-profile-readback.mjs";
import { assertSuccessfulPerformanceResponse } from "./lib/performance-request.mjs";
import { verifyPerformanceTelemetryCaptureReceipt } from "./lib/performance-telemetry-capture.mjs";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const TELEMETRY_POLL_INTERVAL_MS = 500;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function argumentsMap(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("invalid arguments");
    result.set(key.slice(2), value);
  }
  return result;
}

function required(args, name) {
  const value = args.get(name);
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

function requestHeaders(definition, benchmarkCorrelationId) {
  const headers = new Headers(definition.headers ?? {});
  headers.set("x-mind-diary-performance-correlation-id", benchmarkCorrelationId);
  if (definition.bearer_token_env) {
    const secret = process.env[definition.bearer_token_env];
    if (!secret) throw new Error(`missing environment ${definition.bearer_token_env}`);
    headers.set("authorization", `Bearer ${secret}`);
  }
  if (definition.sites_authorization_env) {
    const credential = process.env[definition.sites_authorization_env];
    if (!credential) throw new Error(`missing environment ${definition.sites_authorization_env}`);
    headers.set("oai-sites-authorization", credential);
  }
  return headers;
}

async function timedFetch(targetUrl, definition) {
  const benchmarkCorrelationId = `benchmark_${randomUUID().replaceAll("-", "")}`;
  const startedAtUtc = new Date().toISOString();
  const startedAt = performance.now();
  const response = await fetch(new URL(definition.path, targetUrl), {
    method: definition.method,
    headers: requestHeaders(definition, benchmarkCorrelationId),
    ...(definition.body === undefined ? {} : { body: JSON.stringify(definition.body) }),
    redirect: "manual",
  });
  const bytes = await response.arrayBuffer();
  const elapsed = Math.max(0, performance.now() - startedAt);
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error(`performance response rejected: response_too_large:${definition.id}`);
  }
  assertSuccessfulPerformanceResponse(definition, {
    status: response.status,
    contentType: response.headers.get("content-type"),
    text: new TextDecoder().decode(bytes),
  });
  const requestId = response.headers.get("x-mind-diary-request-id");
  if (!/^(?:req|request)[_-][A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(requestId ?? "")) {
    throw new Error(`performance response rejected: request_id_missing:${definition.id}`);
  }
  if (
    response.headers.get("x-mind-diary-performance-correlation-id") !==
    benchmarkCorrelationId
  ) {
    throw new Error(`performance response rejected: correlation_echo_mismatch:${definition.id}`);
  }
  return Object.freeze({
    elapsed_ms: elapsed,
    request_id: requestId,
    benchmark_correlation_id: benchmarkCorrelationId,
    started_at: startedAtUtc,
    completed_at: new Date().toISOString(),
  });
}

function pendingTelemetry(report) {
  return report.failures.some((failure) =>
    failure.startsWith("telemetry_correlation_count_mismatch:") ||
    failure.startsWith("server_samples_below_20:"));
}

async function waitForTelemetry({ telemetryPath, telemetryCapturePath, timeoutSeconds, evaluation }) {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  let lastReport = null;
  let lastError = null;
  do {
    try {
      const telemetryJsonl = await readFile(telemetryPath, "utf8");
      const telemetry = parsePerformanceTelemetryJsonl(telemetryJsonl);
      const telemetryCapture = verifyPerformanceTelemetryCaptureReceipt(
        JSON.parse(await readFile(telemetryCapturePath, "utf8")),
        telemetryJsonl,
      );
      const report = evaluatePerformanceGate({
        ...evaluation,
        server_telemetry: telemetry,
        telemetry_capture: telemetryCapture,
      });
      lastReport = report;
      if (!pendingTelemetry(report) || Date.now() >= deadline) return report;
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
    }
    await new Promise((resolve) => setTimeout(resolve, TELEMETRY_POLL_INTERVAL_MS));
  } while (Date.now() <= deadline);
  if (lastReport !== null) return lastReport;
  throw lastError ?? new Error("performance telemetry unavailable");
}

async function main() {
  const args = argumentsMap(process.argv.slice(2));
  const scenarioPath = required(args, "scenario");
  const outputPath = required(args, "output");
  const candidateSha = required(args, "candidate-sha");
  const deploymentId = required(args, "deployment-id");
  const profileReadbackPath = required(args, "profile-readback");
  const telemetryPath = required(args, "telemetry-jsonl");
  const telemetryCapturePath = required(args, "telemetry-capture");
  if (!/^[0-9a-f]{40}$/u.test(candidateSha)) throw new Error("candidate SHA must be exact");
  if (!/^appgdep_[a-z0-9]+$/u.test(deploymentId)) throw new Error("deployment ID must be exact");

  const profileReadback = verifyPerformanceProfileReadbackReceipt(
    JSON.parse(await readFile(profileReadbackPath, "utf8")),
  );
  const scenario = validatePerformanceScenario(
    JSON.parse(await readFile(scenarioPath, "utf8")),
    profileReadback,
  );
  if (scenario.candidate_sha !== candidateSha || profileReadback.candidate_sha !== candidateSha) {
    throw new Error("candidate SHA mismatch");
  }
  if (
    scenario.deployment_id !== deploymentId ||
    profileReadback.deployment.deployment_id !== deploymentId
  ) throw new Error("deployment ID mismatch");
  if (profileReadback.target_url !== scenario.target_url) {
    throw new Error("performance target mismatch");
  }
  verifyPerformanceScenarioCredentialBindings(scenario, profileReadback, process.env);

  const startedAt = new Date().toISOString();
  const connectorResults = [];
  for (const definition of scenario.requests) {
    const observedCold = await timedFetch(scenario.target_url, definition);
    const warm = [];
    const sampleWindows = [{
      kind: "cold",
      index: 0,
      started_at: observedCold.started_at,
      completed_at: observedCold.completed_at,
      request_id: observedCold.request_id,
      benchmark_correlation_id: observedCold.benchmark_correlation_id,
    }];
    let completedAt = observedCold.completed_at;
    for (let sample = 0; sample < scenario.warm_samples; sample += 1) {
      const observed = await timedFetch(scenario.target_url, definition);
      warm.push(observed.elapsed_ms);
      sampleWindows.push({
        kind: "warm",
        index: sample,
        started_at: observed.started_at,
        completed_at: observed.completed_at,
        request_id: observed.request_id,
        benchmark_correlation_id: observed.benchmark_correlation_id,
      });
      completedAt = observed.completed_at;
    }
    connectorResults.push(Object.freeze({
      id: definition.id,
      profile: definition.profile,
      fixture_profile_id: definition.fixture_profile_id,
      operation: definition.operation,
      response_verified: true,
      fixture_binding_verified: true,
      observed_cold_ms: observedCold.elapsed_ms,
      warm_ms: Object.freeze(warm),
      sample_windows: Object.freeze(sampleWindows.map(Object.freeze)),
      started_at: observedCold.started_at,
      cold_completed_at: observedCold.completed_at,
      completed_at: completedAt,
    }));
  }
  const completedAt = new Date().toISOString();
  const report = await waitForTelemetry({
    telemetryPath,
    telemetryCapturePath,
    timeoutSeconds: scenario.telemetry_wait_seconds,
    evaluation: {
      candidate_sha: candidateSha,
      deployment_id: deploymentId,
      environment: scenario.environment,
      target_url: scenario.target_url,
      started_at: startedAt,
      completed_at: completedAt,
      warm_samples: scenario.warm_samples,
      scenario,
      profile_readback: profileReadback,
      connector_results: connectorResults,
    },
  });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    schema: report.schema,
    status: report.status,
    candidate_sha: report.candidate_sha,
    deployment_id: report.deployment?.deployment_id ?? null,
    artifact_sha256: report.artifact_sha256,
    failures: report.failures,
  })}\n`);
  if (report.status !== "passed") process.exitCode = 1;
}

main().catch((error) => fail(error instanceof Error ? error.message : "performance gate failed"));
