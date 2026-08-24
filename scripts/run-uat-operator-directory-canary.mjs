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
const CLEANUP_EVIDENCE_SCHEMA =
  "mind-diary/uat-operator-directory-cleanup-evidence/v1";
const ACTOR_SOURCE = "environment-backed-sites-session";
const DEFAULT_BASE_URL = "https://mind-diary.example.invalid";
const MCP_PROTOCOL = "2026-07-28";
const TOKEN_TTL_MILLISECONDS = 60 * 60 * 1_000;
const ACTOR_CLASSES = Object.freeze(["operator", "mind_role", "ordinary"]);
const ENVIRONMENT = Object.freeze({
  operator: "MIND_DIARY_UAT_OPERATOR_SITES_TOKEN",
  mind_role: "MIND_DIARY_UAT_MIND_ROLE_SITES_TOKEN",
  ordinary: "MIND_DIARY_UAT_ORDINARY_SITES_TOKEN",
});

export const OPERATOR_CANARY_ASSERTION_IDS = Object.freeze([
  "sessions.environment_backed_only",
  "sessions.three_distinct_registered_principals",
  "accounts.normal_bootstrap_completed",
  "tokens.per_run_read_only_and_revoked",
  "roles.mind_role_created_temporary_ordinary_mind_as_owner",
  "roles.mind_role_has_ordinary_owner_or_admin_membership",
  "activity.successful_web_read_observed",
  "activity.successful_mcp_read_observed",
  "directory.operator_api_three_actor_readback",
  "directory.operator_ui_readback",
  "directory.stable_bounded_projection",
  "directory.cursor_pagination_nonduplicating",
  "directory.exact_display_name_search",
  "directory.registered_at_sort_both_directions",
  "directory.last_activity_at_sort_both_directions",
  "directory.display_name_sort_both_directions",
  "directory.utc_registration_and_activity_ranges",
  "directory.empty_exact_search",
  "directory.never_active_projection",
  "directory.never_active_ui_state",
  "directory.mind_role_api_exact_404",
  "directory.mind_role_ui_exact_404",
  "directory.ordinary_api_exact_404",
  "directory.ordinary_ui_exact_404",
  "directory.denied_reads_do_not_advance_activity",
  "cleanup.no_ephemeral_product_resources",
]);

export const OPERATOR_CANARY_CLEANUP_ASSERTION_IDS = Object.freeze([
  "tokens.named_per_run_revoked_or_absent",
  "mind.temporary_ordinary_mind_absent",
  "membership.temporary_owner_removed_with_mind",
  "accounts.no_account_deletion_attempted",
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
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/u.test(value)) {
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

export function verifyEvidence(value) {
  if (!isRecord(value) || value.schema !== EVIDENCE_SCHEMA || value.status !== "passed") {
    fail("invalid_operator_canary_evidence");
  }
  const actors = {};
  if (!Array.isArray(value.actors) || value.actors.length !== ACTOR_CLASSES.length) {
    fail("invalid_operator_canary_evidence");
  }
  for (const entry of value.actors) {
    const actorClass = entry?.actor_class === "mind-role"
      ? "mind_role"
      : entry?.actor_class;
    if (!ACTOR_CLASSES.includes(actorClass) || Object.hasOwn(actors, actorClass)) {
      fail("invalid_operator_canary_evidence");
    }
    actors[actorClass] = entry.opaque_fingerprint;
  }
  const recreated = createEvidence({
    candidateSha: value.candidate_sha,
    deploymentId: value.deployment_id,
    runFingerprint: value.run_fingerprint,
    actors,
    observedAtUtc: value.observed_at_utc,
  });
  if (canonical(recreated) !== canonical(value)) {
    fail("invalid_operator_canary_evidence");
  }
  return recreated;
}

export function createCleanupEvidence(input) {
  const unsigned = Object.freeze({
    schema: CLEANUP_EVIDENCE_SCHEMA,
    status: "passed",
    phase: input.phase === "recovery" ? "recovery" : "cleanup",
    candidate_sha: candidateSha(input.candidateSha),
    deployment_id: deploymentId(input.deploymentId),
    run_fingerprint: runFingerprint(input.runFingerprint),
    assertions: Object.freeze(OPERATOR_CANARY_CLEANUP_ASSERTION_IDS.map((id) =>
      Object.freeze({ id, status: "passed" }))),
    observed_at_utc: observedAtUtc(input.observedAtUtc),
  });
  return assertRedactedDocument(Object.freeze({
    ...unsigned,
    artifact_sha256: digest(canonical(unsigned)),
  }));
}

export function verifyCleanupEvidence(value) {
  if (!isRecord(value) || value.schema !== CLEANUP_EVIDENCE_SCHEMA || value.status !== "passed") {
    fail("invalid_operator_cleanup_evidence");
  }
  const recreated = createCleanupEvidence({
    phase: value.phase,
    candidateSha: value.candidate_sha,
    deploymentId: value.deployment_id,
    runFingerprint: value.run_fingerprint,
    observedAtUtc: value.observed_at_utc,
  });
  if (canonical(recreated) !== canonical(value)) {
    fail("invalid_operator_cleanup_evidence");
  }
  return recreated;
}

export function loadCredentialEnvironment(environment = process.env) {
  const credentials = {};
  for (const actorClass of ACTOR_CLASSES) {
    const name = ENVIRONMENT[actorClass];
    const sitesToken = required(
      environment[name],
      `missing_${name.toLowerCase()}`,
    );
    credentials[actorClass] = Object.freeze({ sitesToken });
  }
  if (new Set(ACTOR_CLASSES.map((key) => credentials[key].sitesToken)).size !== 3) {
    fail("shared_sites_credential_forbidden");
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
  if (!new Set([
    "setup_started",
    "ready_for_verify",
    "recovery_required",
    "verified",
    "cleaned",
    "recovered",
  ]).has(status)) {
    fail("invalid_state_status");
  }
  const actors = actorFingerprintMap(
    value.actors,
    status === "ready_for_verify" || status === "verified",
  );
  const actorCount = ACTOR_CLASSES.filter((actorClass) =>
    actors[actorClass] !== null).length;
  if (actorCount !== 0 && actorCount !== ACTOR_CLASSES.length) {
    fail("partial_actor_fingerprints_forbidden");
  }
  const runNonce = nonce(value.run_nonce);
  const expectedResources = Object.freeze({
    mind_handle: `uat-operator-directory-${runNonce}`,
    mind_name: `UAT Operator Directory ${runNonce}`,
    token_name_prefix: `UAT Operator Directory ${runNonce}`,
  });
  if (
    !isRecord(value.resources) ||
    canonical(value.resources) !== canonical(expectedResources)
  ) fail("invalid_canary_resources");
  const state = Object.freeze({
    schema: STATE_SCHEMA,
    status,
    candidate_sha: candidateSha(value.candidate_sha),
    deployment_id: deploymentId(value.deployment_id),
    base_url: baseUrl(value.base_url),
    actor_source: value.actor_source === ACTOR_SOURCE
      ? ACTOR_SOURCE
      : fail("invalid_actor_source"),
    run_nonce: runNonce,
    run_fingerprint: runFingerprint(value.run_fingerprint),
    actors,
    resources: expectedResources,
  });
  return Object.freeze(assertRedactedDocument(state));
}

function makeState(options, nonceFactory) {
  const runNonce = nonce(nonceFactory());
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
    resources: {
      mind_handle: `uat-operator-directory-${runNonce}`,
      mind_name: `UAT Operator Directory ${runNonce}`,
      token_name_prefix: `UAT Operator Directory ${runNonce}`,
    },
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
  constructor({ state, actorClass, sitesToken, fetchImpl }) {
    this.baseUrl = state.base_url;
    this.actorClass = actorClass;
    this.sitesToken = sitesToken;
    this.mcpToken = null;
    this.mcpTokenId = null;
    this.mcpTokenPhase = null;
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

  async csrf(path = "/") {
    const response = await this.request(path, {
      headers: { accept: "text/html" },
    });
    const match = response.status === 200 &&
      /<meta name="mind-diary-csrf-token" content="([^"]+)">/u.exec(response.text);
    if (!match) fail("csrf_token_missing", {
      actorClass: this.actorClass,
      status: response.status,
    });
    return match[1];
  }

  async api(path, {
    method = "GET",
    body,
    idempotencyKey,
    expectedStatus = 200,
    csrfPath = "/minds",
  } = {}) {
    const headers = { accept: "application/json" };
    if (method !== "GET") {
      headers.origin = this.baseUrl;
      headers["x-csrf-token"] = await this.csrf(csrfPath);
      if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
      if (body !== undefined) headers["content-type"] = "application/json";
    }
    const response = await this.request(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

  async session(bootstrapKey) {
    let response = await this.request("/api/v1/session", {
      headers: { accept: "application/json" },
    });
    if (
      response.status === 409 &&
      response.body?.error?.code === "registration_required" &&
      bootstrapKey
    ) {
      await this.api("/api/v1/account", {
        method: "POST",
        body: { action: "create_isolated_account" },
        idempotencyKey: bootstrapKey,
        csrfPath: "/",
      });
      response = await this.request("/api/v1/session", {
        headers: { accept: "application/json" },
      });
    }
    if (response.status !== 200 || !isRecord(response.body?.data)) {
      fail("session_unavailable", {
        actorClass: this.actorClass,
        status: response.status,
      });
    }
    return response.body.data;
  }

  async sessionIfRegistered() {
    const response = await this.request("/api/v1/session", {
      headers: { accept: "application/json" },
    });
    if (
      response.status === 409 &&
      response.body?.error?.code === "registration_required"
    ) return null;
    if (response.status !== 200 || !isRecord(response.body?.data)) {
      fail("session_unavailable", {
        actorClass: this.actorClass,
        status: response.status,
      });
    }
    return response.body.data;
  }

  async issueReadOnlyMcpToken(state, now, phase) {
    const issuedAt = Date.parse(now());
    if (!Number.isFinite(issuedAt)) fail("invalid_token_issuance_time");
    const expiresAt = new Date(issuedAt + TOKEN_TTL_MILLISECONDS).toISOString();
    const issued = await this.api("/api/v1/mcp-tokens", {
      method: "POST",
      body: {
        name: tokenName(state, this.actorClass, phase),
        scopes: ["content:read"],
        expires_at: expiresAt,
      },
      idempotencyKey: `uat-operator:${state.run_nonce}:token:${phase}:${this.actorClass}`,
      csrfPath: "/settings/mcp",
    });
    const projection = issued.body?.data;
    if (
      typeof projection?.secret !== "string" ||
      !projection.secret.startsWith("mdp_v1_") ||
      typeof projection.token?.token_id !== "string" ||
      projection.token?.name !== tokenName(state, this.actorClass, phase) ||
      !Array.isArray(projection.token?.scopes) ||
      !projection.token.scopes.includes("content:read") ||
      projection.token.scopes.includes("content:write")
    ) fail("token_issue_projection_invalid", { actorClass: this.actorClass });
    this.mcpToken = projection.secret;
    this.mcpTokenId = projection.token.token_id;
    this.mcpTokenPhase = phase;
  }

  async revokeCurrentTokenAndAssertDenied(state) {
    if (this.mcpToken === null || this.mcpTokenId === null) return;
    const token = this.mcpToken;
    const tokenId = this.mcpTokenId;
    const revoked = await this.api(
      `/api/v1/mcp-tokens/${encodeURIComponent(tokenId)}`,
      {
        method: "DELETE",
        idempotencyKey:
          `uat-operator:${state.run_nonce}:revoke:${this.mcpTokenPhase}:${this.actorClass}`,
        csrfPath: "/settings/mcp",
      },
    );
    if (revoked.body?.data?.token?.state !== "revoked") {
      fail("token_revoke_failed", { actorClass: this.actorClass });
    }
    this.mcpToken = token;
    const denied = await this.mcpRequest("list_minds");
    if (denied.status !== 401) {
      fail("revoked_token_still_accepted", { actorClass: this.actorClass });
    }
    this.mcpToken = null;
    this.mcpTokenId = null;
    this.mcpTokenPhase = null;
  }

  async mcpRequest(name, args = {}) {
    if (this.mcpToken === null) fail("mcp_token_not_issued");
    return this.request("/api/mcp", {
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
  }

  async mcp(name, args = {}) {
    const response = await this.mcpRequest(name, args);
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
      fetchImpl,
    });
  }
  return Object.freeze(result);
}

function tokenName(state, actorClass, phase) {
  if (!new Set(["setup", "verify"]).has(phase)) fail("invalid_token_phase");
  return `${state.resources.token_name_prefix} ${phase} ${actorClass.replaceAll("_", "-")}`;
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

async function readSessions(clients, state) {
  const sessions = {};
  for (const actorClass of ACTOR_CLASSES) {
    sessions[actorClass] = sessionIds(
      await clients[actorClass].session(
        `uat-operator:${state.run_nonce}:bootstrap:${actorClass}`,
      ),
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

function temporaryMind(minds, state) {
  return minds.find((mind) =>
    isRecord(mind) &&
    mind.is_personal === false &&
    (mind.handle === state.resources.mind_handle ||
      mind.route === `/${state.resources.mind_handle}`));
}

function assertTemporaryMindOwner(minds, state) {
  const ordinary = temporaryMind(minds, state);
  if (
    !ordinary ||
    ordinary.access?.kind !== "membership" ||
    ordinary.access?.role !== "owner"
  ) fail("temporary_mind_owner_missing");
  return ordinary;
}

async function ensureTemporaryMind(state, clients) {
  const before = mindList(
    await clients.mind_role.api("/api/v1/minds"),
    "mind_role",
  );
  if (temporaryMind(before, state) !== undefined) {
    fail("temporary_mind_handle_collision");
  }
  const created = await clients.mind_role.api("/api/v1/minds", {
    method: "POST",
    body: {
      name: state.resources.mind_name,
      handle: state.resources.mind_handle,
    },
    idempotencyKey: `uat-operator:${state.run_nonce}:mind:create`,
    csrfPath: "/minds",
  });
  const projection = created.body?.data;
  if (
    !isRecord(projection) ||
    projection.is_personal !== false ||
    projection.access?.kind !== "membership" ||
    projection.access?.role !== "owner"
  ) fail("temporary_mind_create_invalid");
  assertTemporaryMindOwner(
    mindList(await clients.mind_role.api("/api/v1/minds"), "mind_role"),
    state,
  );
  for (const actorClass of ["operator", "ordinary"]) {
    if (temporaryMind(
      mindList(await clients[actorClass].api("/api/v1/minds"), actorClass),
      state,
    ) !== undefined) fail("temporary_private_mind_leaked", { actorClass });
  }
}

async function withReadOnlyTokens(state, clients, now, phase, action) {
  let result;
  let primaryError = null;
  try {
    for (const actorClass of ACTOR_CLASSES) {
      await clients[actorClass].issueReadOnlyMcpToken(state, now, phase);
    }
    result = await action();
  } catch (error) {
    primaryError = error;
  }
  let cleanupError = null;
  for (const actorClass of [...ACTOR_CLASSES].reverse()) {
    try {
      await clients[actorClass].revokeCurrentTokenAndAssertDenied(state);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (primaryError !== null) throw primaryError;
  if (cleanupError !== null) throw cleanupError;
  return result;
}

async function setup(state, credentials, fetchImpl, now, persistActorState) {
  const clients = actorClients(state, credentials, fetchImpl);
  const sessions = await readSessions(clients, state);
  const actorState = validateState({
    ...state,
    actors: fingerprintsFor(state, sessions),
  });
  await persistActorState(actorState);
  await ensureTemporaryMind(actorState, clients);
  await withReadOnlyTokens(actorState, clients, now, "setup", async () => {
    for (const actorClass of ACTOR_CLASSES) {
      const minds = mindList(
        await clients[actorClass].api("/api/v1/minds"),
        actorClass,
      );
      if (actorClass === "mind_role") assertTemporaryMindOwner(minds, actorState);
      await clients[actorClass].mcp("list_minds");
    }
  });
  return validateState({
    ...actorState,
    status: "ready_for_verify",
  });
}

function validUtc(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function optionalUtc(value, code) {
  if (value === null || value === undefined) return null;
  if (!validUtc(value)) fail(code);
  return value;
}

function normalizeActivity(value) {
  if (value === null) return null;
  if (!isRecord(value)) fail("invalid_operator_activity_projection");
  const lastWebSeenAt = optionalUtc(
    value.last_web_seen_at,
    "invalid_operator_web_activity_time",
  );
  const lastMcpSeenAt = optionalUtc(
    value.last_mcp_seen_at,
    "invalid_operator_mcp_activity_time",
  );
  const lastActivityAt = optionalUtc(
    value.last_activity_at,
    "invalid_operator_activity_time",
  );
  if (lastActivityAt === null) fail("invalid_operator_activity_projection");
  return Object.freeze({ lastWebSeenAt, lastMcpSeenAt, lastActivityAt });
}

function nonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function normalizeDirectoryRow(value) {
  if (!isRecord(value)) fail("invalid_operator_directory_row");
  const principalId = required(
    value.principal_id,
    "invalid_operator_principal_projection",
  );
  const displayName = required(
    value.display_name,
    "invalid_operator_display_name_projection",
  );
  required(value.verified_email, "invalid_operator_email_projection");
  required(value.state, "invalid_operator_account_state_projection");
  const registeredAt = value.registered_at;
  if (!validUtc(registeredAt)) fail("invalid_operator_registration_time");
  return Object.freeze({
    principalId,
    displayName,
    registeredAt,
    activity: normalizeActivity(value.activity),
    ownedMindCount: nonNegativeInteger(
      value.owned_mind_count,
      "invalid_operator_owned_count",
    ),
    participatingMindCount: nonNegativeInteger(
      value.participating_mind_count,
      "invalid_operator_participating_count",
    ),
    activeMcpCredentialCount: nonNegativeInteger(
      value.active_mcp_credential_count,
      "invalid_operator_credential_count",
    ),
  });
}

function directoryPage(response) {
  const page = response.body?.data;
  if (!isRecord(page) || !Array.isArray(page.principals)) {
    fail("invalid_operator_directory_projection");
  }
  const nextCursor = page.next_cursor;
  if (nextCursor !== null && (typeof nextCursor !== "string" || nextCursor.length === 0)) {
    fail("invalid_operator_directory_cursor");
  }
  return Object.freeze({
    rows: Object.freeze(page.principals.map(normalizeDirectoryRow)),
    nextCursor,
  });
}

function rowByPrincipal(rows, principalId) {
  const row = rows.find((candidate) => candidate?.principalId === principalId);
  if (!isRecord(row)) fail("actor_missing_from_operator_directory");
  return row;
}

function activitySnapshot(row) {
  if (!isRecord(row.activity)) fail("activity_summary_missing");
  const { lastWebSeenAt, lastMcpSeenAt, lastActivityAt } = row.activity;
  if (!validUtc(lastWebSeenAt) || !validUtc(lastMcpSeenAt) || !validUtc(lastActivityAt)) {
    fail("activity_summary_incomplete");
  }
  return Object.freeze({ lastWebSeenAt, lastMcpSeenAt, lastActivityAt });
}

async function directory(clients, query = {}) {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) parameters.set(key, String(value));
  }
  const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
  return directoryPage(await clients.operator.api(
    `/api/v1/internal/operators/users${suffix}`,
  ));
}

function compareUnicodeScalars(left, right) {
  const leftPoints = [...left].map((value) => value.codePointAt(0));
  const rightPoints = [...right].map((value) => value.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index] < rightPoints[index] ? -1 : 1;
    }
  }
  return leftPoints.length === rightPoints.length
    ? 0
    : leftPoints.length < rightPoints.length ? -1 : 1;
}

function normalizedDisplayName(value) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function compareRows(left, right, sort, direction) {
  let compared;
  if (sort === "registered_at") {
    compared = left.registeredAt.localeCompare(right.registeredAt);
  } else if (sort === "last_activity_at") {
    compared = (left.activity?.lastActivityAt ?? "").localeCompare(
      right.activity?.lastActivityAt ?? "",
    );
  } else if (sort === "display_name") {
    compared = normalizedDisplayName(left.displayName).localeCompare(
      normalizedDisplayName(right.displayName),
      "en-US",
    );
  } else {
    fail("unsupported_operator_sort");
  }
  if (compared === 0) compared = compareUnicodeScalars(left.principalId, right.principalId);
  return direction === "asc" ? compared : -compared;
}

function assertSorted(rows, sort, direction) {
  for (let index = 1; index < rows.length; index += 1) {
    if (compareRows(rows[index - 1], rows[index], sort, direction) > 0) {
      fail("operator_directory_sort_invalid", { sort, direction });
    }
  }
}

function assertExactIds(rows, expectedRows, code) {
  const observed = rows.map(({ principalId }) => principalId).sort(compareUnicodeScalars);
  const expected = expectedRows.map(({ principalId }) => principalId).sort(compareUnicodeScalars);
  if (canonical(observed) !== canonical(expected)) fail(code);
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

async function verifyDirectory(state, clients, sessions) {
  if (state.status !== "ready_for_verify") fail("setup_not_complete");
  assertSameActors(state, sessions);
  assertTemporaryMindOwner(
    mindList(await clients.mind_role.api("/api/v1/minds"), "mind_role"),
    state,
  );

  const firstPage = await directory(clients, {
    limit: 100,
    sort: "registered_at",
    direction: "asc",
  });
  const firstRows = firstPage.rows;
  if (firstRows.length < 3) fail("operator_directory_too_small");
  const firstActorRows = {};
  for (const actorClass of ACTOR_CLASSES) {
    firstActorRows[actorClass] = rowByPrincipal(
      firstRows,
      sessions[actorClass].principalId,
    );
    activitySnapshot(firstActorRows[actorClass]);
  }
  const operatorUi = await clients.operator.request("/internal/operators/users?limit=100", {
    headers: { accept: "text/html" },
  });
  if (
    operatorUi.status !== 200 ||
    !operatorUi.headers?.get?.("content-type")?.includes?.("text/html") ||
    !operatorUi.text.includes("UAT users")
  ) fail("operator_directory_ui_unavailable");

  const secondRows = (await directory(clients, {
    limit: 100,
    sort: "registered_at",
    direction: "asc",
  })).rows;
  const firstOrder = firstRows.map((row) => row?.principalId);
  const secondOrder = secondRows.map((row) => row?.principalId);
  if (canonical(firstOrder) !== canonical(secondOrder)) {
    fail("operator_directory_unstable");
  }

  const firstCursorPage = await directory(clients, {
    limit: 1,
    sort: "registered_at",
    direction: "asc",
  });
  if (firstCursorPage.rows.length !== 1 || firstCursorPage.nextCursor === null) {
    fail("operator_directory_cursor_missing");
  }
  const secondCursorPage = await directory(clients, {
    limit: 1,
    sort: "registered_at",
    direction: "asc",
    cursor: firstCursorPage.nextCursor,
  });
  if (
    secondCursorPage.rows.length !== 1 ||
    firstCursorPage.rows[0].principalId === secondCursorPage.rows[0].principalId
  ) fail("operator_directory_cursor_repeated_row");

  const searched = await directory(clients, {
    query: firstActorRows.ordinary.displayName,
    limit: 100,
  });
  if (
    !searched.rows.some((row) => row.principalId === sessions.ordinary.principalId) ||
    searched.rows.some((row) =>
      normalizedDisplayName(row.displayName) !==
        normalizedDisplayName(firstActorRows.ordinary.displayName))
  ) fail("operator_directory_exact_search_failed");

  for (const sort of ["registered_at", "last_activity_at", "display_name"]) {
    for (const direction of ["asc", "desc"]) {
      const sorted = await directory(clients, { limit: 100, sort, direction });
      assertSorted(sorted.rows, sort, direction);
    }
  }

  const registrationTarget = firstActorRows.ordinary.registeredAt;
  const registrationRange = await directory(clients, {
    registered_from: registrationTarget,
    registered_to: registrationTarget,
    limit: 100,
  });
  const expectedRegistrationRows = firstRows.filter(
    ({ registeredAt }) => registeredAt === registrationTarget,
  );
  if (expectedRegistrationRows.length === 0) fail("operator_registration_fixture_missing");
  assertExactIds(
    registrationRange.rows,
    expectedRegistrationRows,
    "operator_registration_range_failed",
  );

  const activityTarget = firstActorRows.mind_role.activity.lastActivityAt;
  const activityRange = await directory(clients, {
    activity_from: activityTarget,
    activity_to: activityTarget,
    limit: 100,
  });
  const expectedActivityRows = firstRows.filter(
    ({ activity, principalId }) =>
      principalId !== sessions.operator.principalId &&
      activity?.lastActivityAt === activityTarget,
  );
  if (expectedActivityRows.length === 0) fail("operator_activity_fixture_missing");
  assertExactIds(
    activityRange.rows,
    expectedActivityRows,
    "operator_activity_range_failed",
  );

  const empty = await directory(clients, {
    query: `__uat_operator_canary_no_match_${state.run_nonce}__`,
    limit: 100,
  });
  if (empty.rows.length !== 0 || empty.nextCursor !== null) {
    fail("operator_directory_empty_search_failed");
  }

  const neverActive = await directory(clients, {
    never_active: true,
    limit: 100,
    sort: "registered_at",
    direction: "asc",
  });
  if (neverActive.rows.some(({ activity }) => activity !== null)) {
    fail("operator_directory_never_active_failed");
  }
  const neverActiveUi = await clients.operator.request(
    "/internal/operators/users?neverActive=true&limit=100",
    { headers: { accept: "text/html" } },
  );
  if (
    neverActiveUi.status !== 200 ||
    !neverActiveUi.headers?.get?.("content-type")?.includes?.("text/html") ||
    (!neverActiveUi.text.includes("Never") &&
      !neverActiveUi.text.includes("No accounts match this bounded view."))
  ) fail("operator_directory_never_active_ui_failed");

  const deniedReferenceRows = (await directory(clients, {
    limit: 100,
    sort: "registered_at",
    direction: "asc",
  })).rows;
  const deniedBaseline = {};
  for (const actorClass of ["mind_role", "ordinary"]) {
    deniedBaseline[actorClass] = activitySnapshot(
      rowByPrincipal(deniedReferenceRows, sessions[actorClass].principalId),
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

  const afterDeniedRows = (await directory(clients, {
    limit: 100,
    sort: "registered_at",
    direction: "asc",
  })).rows;
  for (const actorClass of ["mind_role", "ordinary"]) {
    const after = activitySnapshot(
      rowByPrincipal(afterDeniedRows, sessions[actorClass].principalId),
    );
    if (canonical(after) !== canonical(deniedBaseline[actorClass])) {
      fail("denied_request_advanced_activity", { actorClass });
    }
  }

}

function listedTokens(response, actorClass) {
  const tokens = response.body?.data?.tokens;
  if (!Array.isArray(tokens)) fail("invalid_token_list", { actorClass });
  return tokens;
}

async function revokeNamedTokens(state, clients) {
  for (const actorClass of ACTOR_CLASSES) {
    const client = clients[actorClass];
    if (await client.sessionIfRegistered() === null) continue;
    const before = listedTokens(
      await client.api("/api/v1/mcp-tokens"),
      actorClass,
    );
    for (const token of before) {
      if (
        !isRecord(token) ||
        typeof token.name !== "string" ||
        !token.name.startsWith(`${state.resources.token_name_prefix} `) ||
        token.state === "revoked"
      ) continue;
      if (typeof token.token_id !== "string") {
        fail("invalid_token_list", { actorClass });
      }
      const revoked = await client.api(
        `/api/v1/mcp-tokens/${encodeURIComponent(token.token_id)}`,
        {
          method: "DELETE",
          idempotencyKey:
            `uat-operator:${state.run_nonce}:recovery-revoke:${actorClass}:` +
            sha256(token.token_id).slice(0, 16),
          csrfPath: "/settings/mcp",
        },
      );
      if (revoked.body?.data?.token?.state !== "revoked") {
        fail("token_revoke_failed", { actorClass });
      }
    }
    const after = listedTokens(
      await client.api("/api/v1/mcp-tokens"),
      actorClass,
    );
    if (after.some((token) =>
      isRecord(token) &&
      typeof token.name === "string" &&
      token.name.startsWith(`${state.resources.token_name_prefix} `) &&
      token.state !== "revoked")) {
      fail("named_token_cleanup_failed", { actorClass });
    }
  }
}

async function deleteTemporaryMind(state, clients) {
  if (await clients.mind_role.sessionIfRegistered() === null) return;
  const path = `/api/v1/minds/${state.resources.mind_handle}`;
  const current = await clients.mind_role.request(path, {
    headers: { accept: "application/json" },
  });
  if (current.status === 200) {
    if (current.body?.data?.access?.role !== "owner") {
      fail("temporary_mind_cleanup_not_owner");
    }
    const ownershipReplay = await clients.mind_role.api("/api/v1/minds", {
      method: "POST",
      body: {
        name: state.resources.mind_name,
        handle: state.resources.mind_handle,
      },
      idempotencyKey: `uat-operator:${state.run_nonce}:mind:create`,
      csrfPath: "/minds",
    });
    if (
      ownershipReplay.body?.data?.route !== `/${state.resources.mind_handle}` ||
      ownershipReplay.body?.data?.name !== state.resources.mind_name ||
      ownershipReplay.body?.data?.access?.role !== "owner"
    ) fail("temporary_mind_ownership_replay_invalid");
    const impact = await clients.mind_role.api(`${path}/deletion-impact`);
    const impactId = impact.body?.data?.impact_id;
    const confirmation = impact.body?.data?.confirmation;
    if (typeof impactId !== "string" || typeof confirmation !== "string") {
      fail("temporary_mind_deletion_impact_invalid");
    }
    await clients.mind_role.api(path, {
      method: "DELETE",
      body: { impact_id: impactId, confirmation },
      idempotencyKey: `uat-operator:${state.run_nonce}:mind:delete`,
      csrfPath: `/${state.resources.mind_handle}`,
    });
  } else if (
    current.status !== 404 ||
    current.body?.error?.code !== "mind_not_found"
  ) {
    fail("temporary_mind_cleanup_read_failed", { status: current.status });
  }
  const absent = await clients.mind_role.request(path, {
    headers: { accept: "application/json" },
  });
  if (absent.status !== 404 || absent.body?.error?.code !== "mind_not_found") {
    fail("temporary_mind_cleanup_failed");
  }
}

async function cleanupProductResources(state, credentials, fetchImpl) {
  const clients = actorClients(state, credentials, fetchImpl);
  const sessions = {};
  for (const actorClass of ACTOR_CLASSES) {
    const session = await clients[actorClass].sessionIfRegistered();
    sessions[actorClass] = session === null
      ? null
      : sessionIds(session, actorClass);
  }
  if (state.actors.operator === null) {
    // Reversible resources are created only after the all-actor snapshot is
    // durably written. A pre-snapshot failure can leave durable pool accounts,
    // but it cannot leave a canary token or temporary Mind.
    return;
  }
  if (ACTOR_CLASSES.some((actorClass) => sessions[actorClass] === null)) {
    fail("cleanup_actor_session_missing");
  }
  assertSameActors(state, sessions);
  await revokeNamedTokens(state, clients);
  await deleteTemporaryMind(state, clients);
  await revokeNamedTokens(state, clients);
}

async function closeLocalState(state, status) {
  return validateState({ ...state, status });
}

export async function run(options, {
  environment = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  nonceFactory = () => randomBytes(16).toString("hex"),
} = {}) {
  if (!new Set(["setup", "verify", "cleanup", "recovery"]).has(options?.phase)) {
    fail("invalid_phase");
  }
  if (options.phase === "setup") {
    if (!options.state_out) fail("missing_state_out");
    if (typeof fetchImpl !== "function") fail("fetch_unavailable");
    const initial = makeState(options, nonceFactory);
    await writeJson(options.state_out, initial);
    let recoveryState = initial;
    try {
      const prepared = await setup(
        initial,
        loadCredentialEnvironment(environment),
        fetchImpl,
        now,
        async (actorState) => {
          recoveryState = actorState;
          await writeJson(options.state_out, actorState);
        },
      );
      await writeJson(options.state_out, prepared);
      return Object.freeze({
        status: "ready_for_verify",
        state_path: options.state_out,
        run_fingerprint: prepared.run_fingerprint,
      });
    } catch (error) {
      await writeJson(
        options.state_out,
        await closeLocalState(recoveryState, "recovery_required"),
      );
      throw error;
    }
  }
  if (!options.state) fail("missing_state");
  const state = await readState(options.state);
  if (options.phase === "verify") {
    if (state.status !== "ready_for_verify") fail("setup_not_complete");
    if (!options.evidence_out) fail("missing_evidence_out");
    if (typeof fetchImpl !== "function") fail("fetch_unavailable");
    if (
      options.deployment_id !== undefined &&
      deploymentId(options.deployment_id) !== state.deployment_id
    ) fail("deployment_changed_since_setup");
    const credentials = loadCredentialEnvironment(environment);
    try {
      const clients = actorClients(state, credentials, fetchImpl);
      const sessions = await readSessions(clients, state);
      await withReadOnlyTokens(state, clients, now, "verify", async () => {
        for (const actorClass of ACTOR_CLASSES) {
          await clients[actorClass].mcp("list_minds");
        }
        await verifyDirectory(state, clients, sessions);
      });
      await cleanupProductResources(state, credentials, fetchImpl);
      const evidence = createEvidence({
        candidateSha: state.candidate_sha,
        deploymentId: state.deployment_id,
        runFingerprint: state.run_fingerprint,
        actors: state.actors,
        observedAtUtc: now(),
      });
      await writeJson(options.evidence_out, evidence);
      await writeJson(options.state, await closeLocalState(state, "verified"));
      return Object.freeze({
        status: "passed",
        evidence_path: options.evidence_out,
        artifact_sha256: evidence.artifact_sha256,
      });
    } catch (error) {
      try {
        await cleanupProductResources(state, credentials, fetchImpl);
      } catch {
        // The deterministic names in state remain the recovery carrier.
      }
      await writeJson(
        options.state,
        await closeLocalState(state, "recovery_required"),
      );
      throw error;
    }
  }
  if (!options.evidence_out) fail("missing_cleanup_evidence_out");
  if (typeof fetchImpl !== "function") fail("fetch_unavailable");
  if (
    options.deployment_id !== undefined &&
    deploymentId(options.deployment_id) !== state.deployment_id
  ) fail("deployment_changed_since_setup");
  await cleanupProductResources(
    state,
    loadCredentialEnvironment(environment),
    fetchImpl,
  );
  const cleanupEvidence = createCleanupEvidence({
    phase: options.phase,
    candidateSha: state.candidate_sha,
    deploymentId: state.deployment_id,
    runFingerprint: state.run_fingerprint,
    observedAtUtc: now(),
  });
  await writeJson(options.evidence_out, cleanupEvidence);
  const terminal = await closeLocalState(
    state,
    options.phase === "cleanup" ? "cleaned" : "recovered",
  );
  await writeJson(options.state, terminal);
  return Object.freeze({
    status: terminal.status,
    state_path: options.state,
    run_fingerprint: terminal.run_fingerprint,
    evidence_path: options.evidence_out,
    artifact_sha256: cleanupEvidence.artifact_sha256,
  });
}

function help() {
  return `Usage:\n  npm run uat:operator-directory-canary -- --phase setup --candidate-sha <sha> --deployment-id <id> --state-out <private-path>\n  npm run uat:operator-directory-canary -- --phase verify --deployment-id <same-id> --state <private-path> --evidence-out <private-path>\n  npm run uat:operator-directory-canary -- --phase cleanup --deployment-id <same-id> --state <private-path> --evidence-out <private-path>\n  npm run uat:operator-directory-canary -- --phase recovery --deployment-id <same-id> --state <private-path> --evidence-out <private-path>\n\nThe three distinct Sites sessions are read only from MIND_DIARY_UAT_{OPERATOR,MIND_ROLE,ORDINARY}_SITES_TOKEN. The runner performs normal product bootstrap, issues and revokes named one-hour content:read MCP tokens, and deletes its deterministic temporary ordinary Mind. Identity, email and credentials are not CLI inputs or evidence fields.`;
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
