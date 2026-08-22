import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import process from "node:process";

import { evaluatePerformanceGate } from "./lib/performance-gate.mjs";

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

function safeScenario(value) {
  if (!value || value.schema !== "mind-diary/performance-scenario/v1") return false;
  if (!Number.isSafeInteger(value.warm_samples) || value.warm_samples < 20) return false;
  if (!Array.isArray(value.requests) || value.requests.length === 0) return false;
  return value.requests.every((request) =>
    typeof request.id === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(request.id) &&
    typeof request.operation === "string" &&
    typeof request.method === "string" &&
    typeof request.path === "string" &&
    request.path.startsWith("/") &&
    !request.path.includes("?") &&
    Number.isInteger(request.expected_status));
}

function requestHeaders(definition) {
  const headers = new Headers(definition.headers ?? {});
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
  const startedAt = performance.now();
  const response = await fetch(new URL(definition.path, targetUrl), {
    method: definition.method,
    headers: requestHeaders(definition),
    ...(definition.body === undefined ? {} : { body: JSON.stringify(definition.body) }),
    redirect: "manual",
  });
  await response.arrayBuffer();
  const elapsed = Math.max(0, performance.now() - startedAt);
  if (response.status !== definition.expected_status) {
    throw new Error(`unexpected status for ${definition.id}: ${response.status}`);
  }
  return elapsed;
}

function parseTelemetry(text) {
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

async function main() {
  const args = argumentsMap(process.argv.slice(2));
  const scenarioPath = required(args, "scenario");
  const outputPath = required(args, "output");
  const candidateSha = required(args, "candidate-sha");
  const deploymentId = required(args, "deployment-id");
  if (!/^[0-9a-f]{40}$/u.test(candidateSha)) throw new Error("candidate SHA must be exact");
  const scenario = JSON.parse(await readFile(scenarioPath, "utf8"));
  if (!safeScenario(scenario)) throw new Error("invalid performance scenario");

  const connectorResults = [];
  for (const definition of scenario.requests) {
    const observedCold = await timedFetch(scenario.target_url, definition);
    const warm = [];
    for (let sample = 0; sample < scenario.warm_samples; sample += 1) {
      warm.push(await timedFetch(scenario.target_url, definition));
    }
    connectorResults.push({
      id: definition.id,
      operation: definition.operation,
      observed_cold_ms: observedCold,
      warm_ms: warm,
      history_scale: definition.history_scale ?? null,
    });
  }
  const telemetryPath = required(args, "telemetry-jsonl");
  const serverTelemetry = parseTelemetry(await readFile(telemetryPath, "utf8"));
  const report = evaluatePerformanceGate({
    candidate_sha: candidateSha,
    deployment_id: deploymentId,
    environment: scenario.environment,
    warm_samples: scenario.warm_samples,
    profile_matrix: scenario.profile_matrix,
    connector_results: connectorResults,
    server_telemetry: serverTelemetry,
  });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    schema: report.schema,
    status: report.status,
    candidate_sha: report.candidate_sha,
    deployment_id: report.deployment_id,
    failures: report.failures,
  })}\n`);
  if (report.status !== "passed") process.exitCode = 1;
}

main().catch((error) => fail(error instanceof Error ? error.message : "performance gate failed"));
