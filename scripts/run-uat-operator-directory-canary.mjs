#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  ProbeFailure,
  assertRedactedDocument,
  canonical,
  candidateSha,
  digest,
  fail,
  isRecord,
  required,
  safeCode,
} from "./lib/multi-principal-probe-core.mjs";

export { ProbeFailure, assertRedactedDocument };

const STATE_SCHEMA = "mind-diary/uat-operator-directory-canary-state/v1";
const EVIDENCE_SCHEMA = "mind-diary/uat-operator-directory-canary-evidence/v1";
const ACTOR_SOURCE = "environment-backed-sites-session";
const DEFAULT_BASE_URL = "https://mind-diary.example.invalid";
const MCP_PROTOCOL = "2026-07-28";
const ACTOR_CLASSES = Object.freeze(["operator", "mind_role", "ordinary"]);
const ENVIRONMENT = Object.freeze({
  operator: Object.freeze({
    sites: "MIND_DIARY_UAT_OPERATOR_SITES_TOKEN",
    mcp: "MIND_DIARY_UAT_OPERATOR_MCP_TOKEN",
  }),
  mind_role: Object.freeze({
    sites: "MIND_DIARY_UAT_MIND_ROLE_SITES_TOKEN",
    mcp: "MIND_DIARY_UAT_MIND_ROLE_MCP_TOKEN",
  }),
  ordinary: Object.freeze({
    sites: "MIND_DIARY_UAT_ORDINARY_SITES_TOKEN",
    mcp: "MIND_DIARY_UAT_ORDINARY_MCP_TOKEN",
  }),
});

export const OPERATOR_CANARY_ASSERTION_IDS = Object.freeze([
  "sessions.environment_backed_only",
  "sessions.three_distinct_registered_principals",
  "roles.mind_role_has_ordinary_owner_or_admin_membership",
  "activity.successful_web_read_observed",
  "activity.successful_mcp_read_observed",
  "directory.operator_api_three_actor_readback",
  "directory.operator_ui_readback",
  "directory.stable_bounded_projection",
  "directory.mind_role_api_exact_404",
  "directory.mind_role_ui_exact_404",
  "directory.ordinary_api_exact_404",
  "directory.ordinary_ui_exact_404",
  "directory.denied_reads_do_not_advance_activity",
  "cleanup.no_ephemeral_product_resources",
]);

function deploymentId(value) {
  if (typeof value !== "string" || !/^appgdep_[a-z0-9]+$/u.test(value)) {
    fail("invalid_deployment_id");
  }
  return value;
}

function baseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("invalid_base_url");
  }
  if (
    parsed.protocol !== "https:" || parsed.username || parsed.password ||
    parsed.search || parsed.hash
  ) fail("invalid_base_url");
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  return parsed.toString().replace(/\/$/u, "");
}

function nonce(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{16}$/u.test(value)) {
    fail("invalid_run_nonce");
  }
  return value;
}

function actorFingerprint(value) {
  if (typeof value !== "string" || !/^uatop-[0-9a-f]{32}$/u.test(value)) {
    fail("invalid_actor_fingerprint");
  }
  return value;
}

function runFingerprint(value) {
  if (typeof value !== "string" || !/^uatop-run-[0-9a-f]{32}$/u.test(value)) {
    fail("invalid_run_fingerprint");
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprintActor(runNonce, actorClass, principalId) {
  return actorFingerprint(`uatop-${sha256(`${runNonce}:${actorClass}:${principalId}`).slice(0, 32)}`);
}

function fingerprintRun(runNonce, candidate, deployment) {
  return runFingerprint(`uatop-run-${sha256(`${runNonce}:${candidate}:${deployment}`).slice(0, 32)}`);
}

function observedAtUtc(value) {
  if (
    typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) fail("invalid_observed_at_utc");
  return value;
}

function actorFingerprintMap(value, requiredActors) {
  if (!isRecord(value)) fail("invalid_actor_fingerprints");
  const actors = {};
  for (const actorClass of ACTOR_CLASSES) {
    const candidate = value[actorClass];
    if (candidate === null && !requiredActors) actors[actorClass] = null;
    else actors[actorClass] = actorFingerprint(candidate);
  }
  return Object.freeze(actors);
}

export function createEvidence(input) {
  const actors = actorFingerprintMap(input.actors, true);
  const unsigned = Object.freeze({
    schema: EVIDENCE_SCHEMA,
    status: "passed",
    candidate_sha: candidateSha(input.candidateSha),
    deployment_id: deploymentId(input.deploymentId),
    actor_source: ACTOR_SOURCE,
    run_fingerprint: runFingerprint(input.runFingerprint),
    actors: Object.freeze(ACTOR_CLASSES.map((actorClass) => Object.freeze({
      actor_class: actorClass === "mind_role" ? "mind-role" : actorClass,
      opaque_fingerprint: actors[actorClass],
    }))),
    assertions: Object.freeze(OPERATOR_CANARY_ASSERTION_IDS.map((id) =>
      Object.freeze({ id, status: "passed" }))),
    observed_at_utc: observedAtUtc(input.observedAtUtc),
  });
  return assertRedactedDocument(Object.freeze({
    ...unsigned,
    artifact_sha256: digest(canonical(unsigned)),
  }));
}

export function loadCredentialEnvironment(environment = process.env) {
  const credentials = {};
  for (const actorClass of ACTOR_CLASSES) {
    const names = ENVIRONMENT[actorClass];
    const sitesToken = required(
      environment[names.sites],
      `missing_${names.sites.toLowerCase()}`,
    );
    const mcpToken = required(
      environment[names.mcp],
      `missing_${names.mcp.toLowerCase()}`,
    );
    if (!mcpToken.startsWith("mdp_v1_")) fail("invalid_mcp_token_reference");
    credentials[actorClass] = Object.freeze({ sitesToken, mcpToken });
  }
  if (new Set(ACTOR_CLASSES.map((key) => credentials[key].sitesToken)).size !== 3) {
    fail("shared_sites_credential_forbidden");
  }
  if (new Set(ACTOR_CLASSES.map((key) => credentials[key].mcpToken)).size !== 3) {
    fail("shared_mcp_credential_forbidden");
  }
  return Object.freeze(credentials);
}

export function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (!argument.startsWith("--")) fail("invalid_cli_argument");
    const key = argument.slice(2).replaceAll("-", "_");
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) fail("missing_cli_value");
    if (Object.hasOwn(options, key)) fail("duplicate_cli_argument");
    options[key] = value;
    index += 1;
  }
  const allowed = new Set([
    "phase",
    "candidate_sha",
    "deployment_id",
    "base_url",
    "state",
    "state_out",
    "evidence_out",
    "nonce",
  ]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) fail("unsupported_cli_argument");
  }
  if (!new Set(["setup", "verify", "cleanup", "recovery"]).has(options.phase)) {
    fail("invalid_phase");
  }
  return options;
}

function validateState(value) {
  if (!isRecord(value) || value.schema !== STATE_SCHEMA) fail("invalid_state_schema");
  const status = value.status;
  if (!new Set(["setup_started", "ready_for_verify", "verified", "cleaned", "recovered"]).has(status)) {
    fail("invalid_state_status");
  }
  const actors = actorFingerprintMap(
    value.actors,
    status === "ready_for_verify" || status === "verified",
  );
  const state = Object.freeze({
    schema: STATE_SCHEMA,
    status,
    candidate_sha: candidateSha(value.candidate_sha),
    deployment_id: deploymentId(value.deployment_id),
    base_url: baseUrl(value.base_url),
    actor_source: value.actor_source === ACTOR_SOURCE
      ? ACTOR_SOURCE
      : fail("invalid_actor_source"),
    run_nonce: nonce(value.run_nonce),
    run_fingerprint: runFingerprint(value.run_fingerprint),
    actors,
  });
  return Object.freeze(assertRedactedDocument(state));
}

function makeState(options) {
  const runNonce = nonce(options.nonce ?? randomBytes(8).toString("hex"));
  const candidate = candidateSha(options.candidate_sha);
  const deployment = deploymentId(options.deployment_id);
  return validateState({
    schema: STATE_SCHEMA,
    status: "setup_started",
    candidate_sha: candidate,
    deployment_id: deployment,
    base_url: baseUrl(options.base_url ?? DEFAULT_BASE_URL),
    actor_source: ACTOR_SOURCE,
    run_nonce: runNonce,
    run_fingerprint: fingerprintRun(runNonce, candidate, deployment),
    actors: { operator: null, mind_role: null, ordinary: null },
  });
}

async function readState(path) {
  return validateState(JSON.parse(await readFile(path, "utf8")));
}

async function writeJson(path, value) {
  assertRedactedDocument(value);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

class ActorClient {
  constructor({ state, actorClass, sitesToken, mcpToken, fetchImpl }) {
    this.baseUrl = state.base_url;
    this.actorClass = actorClass;
    this.sitesToken = sitesToken;
    this.mcpToken = mcpToken;
    this.fetchImpl = fetchImpl;
  }

  async request(path, options = {}) {
    const headers = new Headers(options.headers ?? {});
    headers.set("OAI-Sites-Authorization", `Bearer ${this.sitesToken}`);
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      ...options,
      headers,
      redirect: "error",
    });
    if (!(response instanceof Response)) fail("runtime_route_unavailable");
    const text = await response.text();
    let body = null;
    if (text && response.headers.get("content-type")?.includes("json")) {
      try {
        body = JSON.parse(text);
      } catch {
        fail("invalid_json_response", {
          actorClass: this.actorClass,
          status: response.status,
        });
      }
    }
    return Object.freeze({ status: response.status, headers: response.headers, body, text });
  }

  async api(path, expectedStatus = 200) {
    const response = await this.request(path, {
      headers: { accept: "application/json" },
    });
    if (response.status !== expectedStatus) {
      fail("api_request_failed", {
        actorClass: this.actorClass,
        status: response.status,
        code: safeCode(response.body?.error?.code),
      });
    }
    return response;
  }

  async session() {
    const response = await this.request("/api/v1/session", {
      headers: { accept: "application/json" },
    });
    if (response.status === 409 && response.body?.error?.code === "registration_required") {
      fail("actor_not_registered", { actorClass: this.actorClass });
    }
    if (response.status !== 200 || !isRecord(response.body?.data)) {
      fail("session_unavailable", {
        actorClass: this.actorClass,
        status: response.status,
      });
    }
    return response.body.data;
  }

  async mcp(name, args = {}) {
    const response = await this.request("/api/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${this.mcpToken}`,
        "content-type": "application/json; charset=utf-8",
        "mcp-method": "tools/call",
        "mcp-name": name,
        "mcp-protocol-version": MCP_PROTOCOL,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `${this.actorClass}-${name}`,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL,
            "io.modelcontextprotocol/clientInfo": {
              name: "uat-operator-directory-canary",
              version: "1",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    if (
      response.status !== 200 || response.body?.result?.isError === true ||
      !isRecord(response.body?.result?.structuredContent?.data)
    ) {
      fail("mcp_request_failed", {
        actorClass: this.actorClass,
        status: response.status,
      });
    }
    return response;
  }
}

function actorClients(state, credentials, fetchImpl) {
  const result = {};
  for (const actorClass of ACTOR_CLASSES) {
    result[actorClass] = new ActorClient({
      state,
      actorClass,
      sitesToken: credentials[actorClass].sitesToken,
      mcpToken: credentials[actorClass].mcpToken,
      fetchImpl,
    });
  }
  return Object.freeze(result);
}

function sessionIds(session, actorClass) {
  const principalId = session.principal?.principal_id;
  const personalMindId = session.personal_mind?.mind_id;
  if (
    typeof principalId !== "string" || principalId.length === 0 ||
    typeof personalMindId !== "string" || personalMindId.length === 0
  ) fail("invalid_session_projection", { actorClass });
  return Object.freeze({ principalId, personalMindId });
}

async function readSessions(clients) {
  const sessions = {};
  for (const actorClass of ACTOR_CLASSES) {
    sessions[actorClass] = sessionIds(
      await clients[actorClass].session(),
      actorClass,
    );
  }
  if (new Set(ACTOR_CLASSES.map((key) => sessions[key].principalId)).size !== 3) {
    fail("principals_not_isolated");
  }
  if (new Set(ACTOR_CLASSES.map((key) => sessions[key].personalMindId)).size !== 3) {
    fail("personal_minds_not_isolated");
  }
  return Object.freeze(sessions);
}

function fingerprintsFor(state, sessions) {
  const result = {};
  for (const actorClass of ACTOR_CLASSES) {
    result[actorClass] = fingerprintActor(
      state.run_nonce,
      actorClass,
      sessions[actorClass].principalId,
    );
  }
  return Object.freeze(result);
}

function assertSameActors(state, sessions) {
  const observed = fingerprintsFor(state, sessions);
  for (const actorClass of ACTOR_CLASSES) {
    if (observed[actorClass] !== state.actors[actorClass]) {
      fail("actor_session_changed", { actorClass });
    }
  }
}

function mindList(response, actorClass) {
  const minds = response.body?.data;
  if (!Array.isArray(minds)) fail("invalid_mind_list", { actorClass });
  return minds;
}

function assertMindRole(minds) {
  const ordinary = minds.find((mind) =>
    isRecord(mind) && mind.isPersonal === false &&
    mind.access?.kind === "membership" &&
    (mind.access?.role === "owner" || mind.access?.role === "admin"));
  if (!ordinary) fail("mind_role_membership_missing");
}

async function setup(state, credentials, fetchImpl) {
  const clients = actorClients(state, credentials, fetchImpl);
  const sessions = await readSessions(clients);
  for (const actorClass of ACTOR_CLASSES) {
    const response = await clients[actorClass].api("/api/v1/minds");
    const minds = mindList(response, actorClass);
    if (actorClass === "mind_role") assertMindRole(minds);
    await clients[actorClass].mcp("list_minds");
  }
  return validateState({
    ...state,
    status: "ready_for_verify",
    actors: fingerprintsFor(state, sessions),
  });
}

function directoryRows(response) {
  const page = response.body?.data;
  if (!isRecord(page) || !Array.isArray(page.principals)) {
    fail("invalid_operator_directory_projection");
  }
  return page.principals;
}

function rowByPrincipal(rows, principalId) {
  const row = rows.find((candidate) => candidate?.principalId === principalId);
  if (!isRecord(row)) fail("actor_missing_from_operator_directory");
  return row;
}

function validUtc(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function activitySnapshot(row) {
  if (!isRecord(row.activity)) fail("activity_summary_missing");
  const { lastWebSeenAt, lastMcpSeenAt, lastActivityAt } = row.activity;
  if (!validUtc(lastWebSeenAt) || !validUtc(lastMcpSeenAt) || !validUtc(lastActivityAt)) {
    fail("activity_summary_incomplete");
  }
  return Object.freeze({ lastWebSeenAt, lastMcpSeenAt, lastActivityAt });
}

async function directory(clients) {
  return clients.operator.api(
    "/api/v1/internal/operators/users?limit=100&sort=registered_at&direction=asc",
  );
}

function assertExactNotFound(response, actorClass, surface) {
  if (response.status !== 404 || response.body?.error?.code !== "not_found") {
    fail("operator_boundary_not_hidden", {
      actorClass,
      surface,
      status: response.status,
      code: safeCode(response.body?.error?.code),
    });
  }
}

async function verify(state, credentials, fetchImpl, now) {
  if (state.status !== "ready_for_verify") fail("setup_not_complete");
  const clients = actorClients(state, credentials, fetchImpl);
  const sessions = await readSessions(clients);
  assertSameActors(state, sessions);

  const firstRows = directoryRows(await directory(clients));
  if (firstRows.length < 3) fail("operator_directory_too_small");
  const firstActorRows = {};
  for (const actorClass of ACTOR_CLASSES) {
    firstActorRows[actorClass] = rowByPrincipal(
      firstRows,
      sessions[actorClass].principalId,
    );
    activitySnapshot(firstActorRows[actorClass]);
  }
  if (
    Number(firstActorRows.mind_role.ownedMindCount ?? 0) +
      Number(firstActorRows.mind_role.participatingMindCount ?? 0) < 1
  ) fail("mind_role_support_count_missing");

  const operatorUi = await clients.operator.request("/internal/operators/users?limit=100", {
    headers: { accept: "text/html" },
  });
  if (
    operatorUi.status !== 200 ||
    !operatorUi.headers?.get?.("content-type")?.includes?.("text/html") ||
    !operatorUi.text.includes("UAT users")
  ) fail("operator_directory_ui_unavailable");

  const secondRows = directoryRows(await directory(clients));
  const firstOrder = firstRows.map((row) => row?.principalId);
  const secondOrder = secondRows.map((row) => row?.principalId);
  if (canonical(firstOrder) !== canonical(secondOrder)) {
    fail("operator_directory_unstable");
  }
  const deniedBaseline = {};
  for (const actorClass of ["mind_role", "ordinary"]) {
    deniedBaseline[actorClass] = activitySnapshot(
      rowByPrincipal(secondRows, sessions[actorClass].principalId),
    );
    assertExactNotFound(
      await clients[actorClass].request("/api/v1/internal/operators/users?limit=1", {
        headers: { accept: "application/json" },
      }),
      actorClass,
      "api",
    );
    assertExactNotFound(
      await clients[actorClass].request("/internal/operators/users?limit=1", {
        headers: { accept: "text/html" },
      }),
      actorClass,
      "ui",
    );
  }

  const afterDeniedRows = directoryRows(await directory(clients));
  for (const actorClass of ["mind_role", "ordinary"]) {
    const after = activitySnapshot(
      rowByPrincipal(afterDeniedRows, sessions[actorClass].principalId),
    );
    if (canonical(after) !== canonical(deniedBaseline[actorClass])) {
      fail("denied_request_advanced_activity", { actorClass });
    }
  }

  return createEvidence({
    candidateSha: state.candidate_sha,
    deploymentId: state.deployment_id,
    runFingerprint: state.run_fingerprint,
    actors: state.actors,
    observedAtUtc: now(),
  });
}

async function closeLocalState(state, status) {
  return validateState({ ...state, status });
}

export async function run(options, {
  environment = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
} = {}) {
  if (options.phase === "setup") {
    if (!options.state_out) fail("missing_state_out");
    if (typeof fetchImpl !== "function") fail("fetch_unavailable");
    const initial = makeState(options);
    await writeJson(options.state_out, initial);
    const prepared = await setup(
      initial,
      loadCredentialEnvironment(environment),
      fetchImpl,
    );
    await writeJson(options.state_out, prepared);
    return Object.freeze({
      status: "ready_for_verify",
      state_path: options.state_out,
      run_fingerprint: prepared.run_fingerprint,
    });
  }
  if (!options.state) fail("missing_state");
  const state = await readState(options.state);
  if (options.phase === "verify") {
    if (!options.evidence_out) fail("missing_evidence_out");
    if (typeof fetchImpl !== "function") fail("fetch_unavailable");
    if (
      options.deployment_id !== undefined &&
      deploymentId(options.deployment_id) !== state.deployment_id
    ) fail("deployment_changed_since_setup");
    const evidence = await verify(
      state,
      loadCredentialEnvironment(environment),
      fetchImpl,
      now,
    );
    await writeJson(options.evidence_out, evidence);
    await writeJson(options.state, await closeLocalState(state, "verified"));
    return Object.freeze({
      status: "passed",
      evidence_path: options.evidence_out,
      artifact_sha256: evidence.artifact_sha256,
    });
  }
  const terminal = await closeLocalState(
    state,
    options.phase === "cleanup" ? "cleaned" : "recovered",
  );
  await writeJson(options.state, terminal);
  return Object.freeze({
    status: terminal.status,
    state_path: options.state,
    run_fingerprint: terminal.run_fingerprint,
  });
}

function help() {
  return `Usage:\n  npm run uat:operator-directory-canary -- --phase setup --candidate-sha <sha> --deployment-id <id> --state-out <private-path>\n  npm run uat:operator-directory-canary -- --phase verify --deployment-id <same-id> --state <private-path> --evidence-out <private-path>\n  npm run uat:operator-directory-canary -- --phase cleanup --state <private-path>\n  npm run uat:operator-directory-canary -- --phase recovery --state <private-path>\n\nAll three Sites sessions and MCP tokens are read only from MIND_DIARY_UAT_{OPERATOR,MIND_ROLE,ORDINARY}_{SITES_TOKEN,MCP_TOKEN}. Identity, email and credentials are not CLI inputs.`;
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) process.stdout.write(`${help()}\n`);
    else process.stdout.write(`${JSON.stringify(await run(options))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: "failed",
      code: error instanceof ProbeFailure ? error.code : "operator_canary_failed",
    })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
