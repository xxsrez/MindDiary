#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  ProbeFailure,
  UAT_ASSERTION_IDS,
  assertRedactedDocument,
  canonical,
  digest,
  fail,
  isRecord,
  required,
} from "./lib/multi-principal-probe-core.mjs";

export { ProbeFailure, assertRedactedDocument };

const STATE_SCHEMA = "mind-diary/uat-multi-principal-state/v1";
const EVIDENCE_SCHEMA = "mind-diary/multi-principal-evidence/v1";
const ACTOR_SOURCE = "explicit-test-principal-reference";
const MCP_PROTOCOL = "2026-07-28";
const DEFAULT_BASE_URL = "https://mind-diary.example.invalid";
const ENVIRONMENT = Object.freeze({
  ownerSitesToken: ["MIND_DIARY_UAT_OWNER", "SITES_TOKEN"].join("_"),
  participantSitesToken: ["MIND_DIARY_UAT_PARTICIPANT", "SITES_TOKEN"].join("_"),
  participantEmail: "MIND_DIARY_UAT_PARTICIPANT_EMAIL",
  ownerMcpToken: ["MIND_DIARY_UAT_OWNER", "MCP_TOKEN"].join("_"),
  participantMcpToken: ["MIND_DIARY_UAT_PARTICIPANT", "MCP_TOKEN"].join("_"),
  ownerMcpTokenRef: ["MIND_DIARY_UAT_OWNER", "MCP_TOKEN_REF"].join("_"),
  participantMcpTokenRef: ["MIND_DIARY_UAT_PARTICIPANT", "MCP_TOKEN_REF"].join("_"),
});
const ASSERTIONS = UAT_ASSERTION_IDS;

function safeCode(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value) ? value : "unexpected_response";
}
function candidateSha(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) fail("invalid_candidate_sha");
  return value;
}
function deploymentId(value) {
  if (typeof value !== "string" || !/^appgdep_[a-z0-9]+$/u.test(value)) fail("invalid_deployment_id");
  return value;
}
function fingerprint(value) {
  if (typeof value !== "string" || !/^pilot-[a-z0-9]{16,64}$/u.test(value)) fail("invalid_actor_fingerprint");
  return value;
}
function baseUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { fail("invalid_base_url"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) fail("invalid_base_url");
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  return parsed.toString().replace(/\/$/u, "");
}
export function createEvidence(input) {
  const unsigned = Object.freeze({
    schema: EVIDENCE_SCHEMA,
    status: "passed",
    candidate_sha: candidateSha(input.candidateSha),
    deployment_id: deploymentId(input.deploymentId),
    prepared_deployment_id: deploymentId(input.preparedDeploymentId),
    actor_class: "owner-and-explicit-test-principal",
    actor_source: ACTOR_SOURCE,
    actors: Object.freeze([
      Object.freeze({ actor_class: "existing-owner", opaque_fingerprint: fingerprint(input.ownerFingerprint) }),
      Object.freeze({ actor_class: "explicit-test-principal", opaque_fingerprint: fingerprint(input.participantFingerprint) }),
    ]),
    assertions: Object.freeze(ASSERTIONS.map((id) => Object.freeze({ id, status: "passed" }))),
    observed_at_utc: required(input.observedAtUtc, "missing_observed_at_utc"),
  });
  return assertRedactedDocument(Object.freeze({ ...unsigned, artifact_sha256: digest(canonical(unsigned)) }));
}

export function loadCredentialEnvironment(environment = process.env) {
  const values = {};
  for (const [key, name] of Object.entries(ENVIRONMENT)) values[key] = required(environment[name], `missing_${name.toLowerCase()}`);
  if (!values.participantEmail.includes("@")) fail("invalid_participant_email_reference");
  if (!values.ownerMcpToken.startsWith("mdp_v1_") || !values.participantMcpToken.startsWith("mdp_v1_")) fail("invalid_mcp_token_reference");
  if (
    !/^ptok_v1_[0-9a-f]{32}$/u.test(values.ownerMcpTokenRef) ||
    !/^ptok_v1_[0-9a-f]{32}$/u.test(values.participantMcpTokenRef)
  ) fail("invalid_personal_token_ref");
  if (values.ownerSitesToken === values.participantSitesToken) fail("shared_sites_credential_forbidden");
  if (values.ownerMcpToken === values.participantMcpToken) fail("shared_mcp_credential_forbidden");
  return Object.freeze(values);
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
  const allowed = new Set(["phase", "candidate_sha", "deployment_id", "base_url", "owner_fingerprint", "participant_fingerprint", "state", "state_out", "evidence_out", "nonce"]);
  for (const key of Object.keys(options)) if (!allowed.has(key)) fail("unsupported_cli_argument");
  if (!new Set(["setup", "verify", "cleanup"]).has(options.phase)) fail("invalid_phase");
  return options;
}

function validateState(value) {
  if (!isRecord(value) || value.schema !== STATE_SCHEMA) fail("invalid_state_schema");
  const state = {
    schema: STATE_SCHEMA,
    status: value.status === "awaiting_redeploy" ? value.status : "setup_started",
    candidate_sha: candidateSha(value.candidate_sha),
    prepared_deployment_id: deploymentId(value.prepared_deployment_id),
    base_url: baseUrl(value.base_url),
    actor_source: value.actor_source === ACTOR_SOURCE ? ACTOR_SOURCE : fail("invalid_actor_source"),
    actors: { owner: fingerprint(value.actors?.owner), participant: fingerprint(value.actors?.participant) },
    run_nonce: required(value.run_nonce, "missing_run_nonce"),
    mind: { handle: required(value.mind?.handle, "missing_mind_handle"), name: required(value.mind?.name, "missing_mind_name") },
  };
  if (!/^[0-9a-f]{16}$/u.test(state.run_nonce) || state.mind.handle !== `uat-boundary-${state.run_nonce}`) fail("invalid_probe_nonce");
  return Object.freeze(assertRedactedDocument(state));
}
function makeState(options) {
  const nonce = options.nonce ?? randomBytes(8).toString("hex");
  return validateState({
    schema: STATE_SCHEMA,
    status: "setup_started",
    candidate_sha: options.candidate_sha,
    prepared_deployment_id: options.deployment_id,
    base_url: options.base_url ?? DEFAULT_BASE_URL,
    actor_source: ACTOR_SOURCE,
    actors: { owner: options.owner_fingerprint, participant: options.participant_fingerprint },
    run_nonce: nonce,
    mind: { handle: `uat-boundary-${nonce}`, name: `UAT Boundary ${nonce}` },
  });
}
async function readState(path) { return validateState(JSON.parse(await readFile(path, "utf8"))); }
async function writeJson(path, value) {
  assertRedactedDocument(value);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

class ActorClient {
  constructor({ state, sitesToken, mcpToken, actorClass, fetchImpl }) {
    this.baseUrl = state.base_url;
    this.sitesToken = sitesToken;
    this.mcpToken = mcpToken;
    this.actorClass = actorClass;
    this.fetchImpl = fetchImpl;
  }
  async request(path, options = {}) {
    const headers = new Headers(options.headers ?? {});
    headers.set("OAI-Sites-Authorization", `Bearer ${this.sitesToken}`);
    const response = await this.fetchImpl(new URL(path, this.baseUrl), { ...options, headers, redirect: "error" });
    const text = await response.text();
    let body = null;
    if (text && response.headers.get("content-type")?.includes("json")) {
      try { body = JSON.parse(text); } catch { fail("invalid_json_response", { actorClass: this.actorClass, status: response.status }); }
    }
    return { status: response.status, body, text };
  }
  async csrf(path = "/") {
    const response = await this.request(path);
    const match = response.status === 200 && /<meta name="mind-diary-csrf-token" content="([^"]+)">/u.exec(response.text);
    if (!match) fail("csrf_token_missing", { actorClass: this.actorClass, status: response.status });
    return match[1];
  }
  async api(path, { method = "GET", body, idempotencyKey, expectedStatus = 200, csrfPath = "/minds" } = {}) {
    const headers = { accept: "application/json" };
    if (method !== "GET") {
      headers.origin = this.baseUrl;
      headers["x-csrf-token"] = await this.csrf(csrfPath);
      if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
      if (body !== undefined) headers["content-type"] = "application/json";
    }
    const response = await this.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status !== expectedStatus) fail("api_request_failed", { actorClass: this.actorClass, status: response.status, code: safeCode(response.body?.error?.code) });
    return response;
  }
  async session(bootstrapKey) {
    let response = await this.request("/api/v1/session", { headers: { accept: "application/json" } });
    if (response.status === 409 && response.body?.error?.code === "registration_required" && bootstrapKey) {
      await this.api("/api/v1/account", { method: "POST", body: { action: "create_isolated_account" }, idempotencyKey: bootstrapKey, csrfPath: "/" });
      response = await this.request("/api/v1/session", { headers: { accept: "application/json" } });
    }
    if (response.status !== 200 || !isRecord(response.body?.data)) fail("session_unavailable", { actorClass: this.actorClass, status: response.status });
    return response.body.data;
  }
  async mcp(name, args = {}) {
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
        params: { name, arguments: args, _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL,
          "io.modelcontextprotocol/clientInfo": { name: "uat-multi-principal-probe", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        } },
      }),
    });
  }
}

function actors(state, credentials, fetchImpl) {
  return Object.freeze({
    owner: new ActorClient({ state, sitesToken: credentials.ownerSitesToken, mcpToken: credentials.ownerMcpToken, actorClass: "existing-owner", fetchImpl }),
    participant: new ActorClient({ state, sitesToken: credentials.participantSitesToken, mcpToken: credentials.participantMcpToken, actorClass: "explicit-test-principal", fetchImpl }),
  });
}
function ids(session) {
  return { principal: required(session.principal?.principal_id, "missing_principal_id"), mind: required(session.personal_mind?.mind_id, "missing_personal_mind_id") };
}
function data(response, code = "invalid_projection") {
  if (!isRecord(response.body?.data)) fail(code);
  return response.body.data;
}
function mcpMinds(response, actorClass) {
  const minds = response.body?.result?.structuredContent?.data?.minds;
  if (response.status !== 200 || response.body?.result?.isError === true || !Array.isArray(minds)) fail("mcp_list_failed", { actorClass, status: response.status });
  return minds;
}
async function expectMcpMind(actor, handle, expected) {
  const present = mcpMinds(await actor.mcp("list_minds"), actor.actorClass).some((mind) => mind?.route === `/${handle}`);
  if (present !== expected) fail(expected ? "mcp_mind_missing" : "mcp_mind_leaked", { actorClass: actor.actorClass });
}
async function visibility(actor, state, value, version) {
  return data(await actor.api(`/api/v1/minds/${state.mind.handle}/visibility`, {
    method: "PUT",
    body: { visibility: value, acknowledge_live_head_and_history_exposure: value === "public", expected_metadata_version: version },
    idempotencyKey: `probe:${state.run_nonce}:visibility:${value}`,
    csrfPath: `/${state.mind.handle}`,
  }));
}

async function setup(state, credentials, fetchImpl) {
  const client = actors(state, credentials, fetchImpl);
  const ownerIds = ids(await client.owner.session(`probe:${state.run_nonce}:bootstrap:owner`));
  const participantIds = ids(await client.participant.session(`probe:${state.run_nonce}:bootstrap:participant`));
  if (ownerIds.principal === participantIds.principal || ownerIds.mind === participantIds.mind) fail("accounts_not_isolated");
  if (ids(await client.owner.session()).principal !== ownerIds.principal || ids(await client.participant.session()).principal !== participantIds.principal) fail("cross_session_identity_changed");
  const ownerPersonal = mcpMinds(await client.owner.mcp("list_minds"), client.owner.actorClass).find((mind) => mind?.route === "/me");
  const participantPersonal = mcpMinds(await client.participant.mcp("list_minds"), client.participant.actorClass).find((mind) => mind?.route === "/me");
  if (ownerPersonal?.mind_id !== ownerIds.mind || participantPersonal?.mind_id !== participantIds.mind) fail("mcp_token_principal_mismatch");

  let current = data(await client.owner.api("/api/v1/minds", {
    method: "POST", body: { name: state.mind.name, handle: state.mind.handle },
    idempotencyKey: `probe:${state.run_nonce}:mind:create`,
  }));
  const privateDenied = await client.participant.api(`/api/v1/minds/${state.mind.handle}`, { expectedStatus: 404 });
  if (privateDenied.body?.error?.code !== "mind_not_found" || JSON.stringify(privateDenied.body).includes(state.mind.name)) fail("private_metadata_leak");

  current = await visibility(client.owner, state, "public", current.metadata_version);
  const publicView = data(await client.participant.api(`/api/v1/minds/${state.mind.handle}`));
  if (publicView.access?.kind !== "visibility" || publicView.visibility !== "public") fail("public_baseline_failed");
  const catalog = await client.participant.request("/public");
  if (catalog.status !== 200 || !catalog.text.includes(state.mind.handle)) fail("public_catalog_missing");
  await expectMcpMind(client.participant, state.mind.handle, true);
  if (data(await client.owner.api(`/api/v1/minds/${state.mind.handle}/members`)).members?.length !== 1) fail("baseline_created_membership");

  current = await visibility(client.owner, state, "unlisted", current.metadata_version);
  const unlistedView = data(await client.participant.api(`/api/v1/minds/${state.mind.handle}`));
  if (unlistedView.access?.kind !== "visibility" || unlistedView.visibility !== "unlisted") fail("unlisted_exact_failed");
  if ((await client.participant.request("/public")).text.includes(state.mind.handle)) fail("unlisted_catalog_leak");
  if (data(await client.owner.api(`/api/v1/minds/${state.mind.handle}/members`)).members?.length !== 1) fail("unlisted_created_membership");

  current = await visibility(client.owner, state, "private", current.metadata_version);
  if ((await client.participant.api(`/api/v1/minds/${state.mind.handle}`, { expectedStatus: 404 })).body?.error?.code !== "mind_not_found") fail("private_visibility_web_revoke_failed");
  await expectMcpMind(client.participant, state.mind.handle, false);

  await client.owner.api(`/api/v1/minds/${state.mind.handle}/invitations`, {
    method: "POST",
    body: { target_verified_email: credentials.participantEmail, role: "reader", expected_metadata_version: current.metadata_version },
    idempotencyKey: `probe:${state.run_nonce}:invite`, csrfPath: `/${state.mind.handle}`,
  });
  const invitation = data(await client.participant.api("/api/v1/invitations")).invitations?.find((item) =>
    item?.direction === "incoming" && (item.mind_route === `/${state.mind.handle}` || item.mind_handle === state.mind.handle || item.mind_name === state.mind.name));
  if (!invitation) fail("incoming_invitation_missing");
  await client.participant.api(`/api/v1/invitations/${encodeURIComponent(invitation.invitation_id)}/accept`, {
    method: "POST", body: { expected_invitation_version: invitation.invitation_version },
    idempotencyKey: `probe:${state.run_nonce}:accept`, csrfPath: "/invitations",
  });
  if (data(await client.participant.api(`/api/v1/minds/${state.mind.handle}`)).access?.role !== "reader") fail("reader_access_failed");
  const reader = data(await client.owner.api(`/api/v1/minds/${state.mind.handle}/members`)).members?.find((item) => item?.is_self === false && item?.role === "reader");
  if (!reader) fail("participant_membership_missing");
  await client.owner.api(`/api/v1/minds/${state.mind.handle}/members/${encodeURIComponent(reader.member_id)}`, {
    method: "PATCH", body: { role: "editor", expected_membership_version: reader.membership_version },
    idempotencyKey: `probe:${state.run_nonce}:role:editor`, csrfPath: `/${state.mind.handle}`,
  });
  if (data(await client.participant.api(`/api/v1/minds/${state.mind.handle}`)).access?.role !== "editor") fail("editor_access_failed");
  await expectMcpMind(client.owner, state.mind.handle, true);
  await expectMcpMind(client.participant, state.mind.handle, true);

  const ownerMind = data(await client.owner.api(`/api/v1/minds/${state.mind.handle}`));
  const target = data(await client.owner.api(`/api/v1/minds/${state.mind.handle}/members`)).members?.find((item) => item?.is_self === false && item?.role === "editor");
  if (!target) fail("transfer_target_missing");
  await client.owner.api(`/api/v1/minds/${state.mind.handle}/ownership-transfer`, {
    method: "POST",
    body: { target_member_id: target.member_id, expected_metadata_version: ownerMind.metadata_version, confirmation: "transfer-ownership" },
    idempotencyKey: `probe:${state.run_nonce}:transfer`, csrfPath: `/${state.mind.handle}`,
  });
  const sourceAfter = data(await client.owner.api(`/api/v1/minds/${state.mind.handle}`));
  const targetAfter = data(await client.participant.api(`/api/v1/minds/${state.mind.handle}`));
  const membersAfter = data(await client.participant.api(`/api/v1/minds/${state.mind.handle}/members`)).members;
  if (sourceAfter.access?.role !== "admin" || targetAfter.access?.role !== "owner" || membersAfter?.filter((item) => item?.role === "owner").length !== 1) fail("ownership_transfer_failed");
}

async function revokeToken(actor, tokenRef, state, suffix) {
  const response = await actor.api(`/api/v1/mcp-tokens/${encodeURIComponent(tokenRef)}`, {
    method: "DELETE", idempotencyKey: `probe:${state.run_nonce}:token-revoke:${suffix}`, csrfPath: "/settings/developer/mcp",
  });
  if (response.body?.data?.token?.state !== "revoked") fail("token_revoke_failed", { actorClass: actor.actorClass });
}
async function deleteMind(actor, state) {
  const impact = data(await actor.api(`/api/v1/minds/${state.mind.handle}/deletion-impact`));
  await actor.api(`/api/v1/minds/${state.mind.handle}`, {
    method: "DELETE", body: { impact_id: impact.impact_id, confirmation: impact.confirmation },
    idempotencyKey: `probe:${state.run_nonce}:mind:delete`, csrfPath: `/${state.mind.handle}`,
  });
}

async function verify(state, newDeploymentId, credentials, fetchImpl) {
  const observedDeployment = deploymentId(newDeploymentId);
  if (state.status !== "awaiting_redeploy") fail("setup_not_complete");
  if (observedDeployment === state.prepared_deployment_id) fail("redeploy_boundary_not_observed");
  const client = actors(state, credentials, fetchImpl);
  const ownerIds = ids(await client.owner.session());
  const participantIds = ids(await client.participant.session());
  if (ownerIds.principal === participantIds.principal || ownerIds.mind === participantIds.mind) fail("accounts_not_isolated_after_redeploy");
  const source = data(await client.owner.api(`/api/v1/minds/${state.mind.handle}`));
  const target = data(await client.participant.api(`/api/v1/minds/${state.mind.handle}`));
  if (source.access?.role !== "admin" || target.access?.role !== "owner") fail("persistence_after_redeploy_failed");
  await expectMcpMind(client.owner, state.mind.handle, true);
  await expectMcpMind(client.participant, state.mind.handle, true);

  const members = data(await client.participant.api(`/api/v1/minds/${state.mind.handle}/members`)).members;
  const sourceMember = members?.find((item) => item?.is_self === false && item?.role === "admin");
  if (!sourceMember || members.filter((item) => item?.role === "owner").length !== 1) fail("durable_membership_invalid");
  await client.participant.api(`/api/v1/minds/${state.mind.handle}/members/${encodeURIComponent(sourceMember.member_id)}`, {
    method: "DELETE", body: { expected_membership_version: sourceMember.membership_version },
    idempotencyKey: `probe:${state.run_nonce}:membership:revoke`, csrfPath: `/${state.mind.handle}`,
  });
  const revoked = await client.owner.api(`/api/v1/minds/${state.mind.handle}`, { expectedStatus: 404 });
  if (revoked.body?.error?.code !== "mind_not_found" || JSON.stringify(revoked.body).includes(state.mind.name)) fail("membership_revoke_web_failed");
  await expectMcpMind(client.owner, state.mind.handle, false);
  const history = await client.owner.mcp("list_revisions", { mind: `/${state.mind.handle}` });
  if (history.status === 200 && history.body?.result?.isError !== true) fail("membership_revoke_history_failed");

  await deleteMind(client.participant, state);
  const [ownerDeleted, participantDeleted] = await Promise.all([
    client.owner.api(`/api/v1/minds/${state.mind.handle}`, { expectedStatus: 404 }),
    client.participant.api(`/api/v1/minds/${state.mind.handle}`, { expectedStatus: 404 }),
  ]);
  if (ownerDeleted.body?.error?.code !== "mind_not_found" || participantDeleted.body?.error?.code !== "mind_not_found") fail("probe_mind_cleanup_failed");
  await revokeToken(client.owner, credentials.ownerMcpTokenRef, state, "owner");
  await revokeToken(client.participant, credentials.participantMcpTokenRef, state, "participant");
  const [ownerDenied, participantDenied] = await Promise.all([client.owner.mcp("list_minds"), client.participant.mcp("list_minds")]);
  if (ownerDenied.status !== 401 || participantDenied.status !== 401) fail("probe_token_cleanup_failed");
  return createEvidence({
    candidateSha: state.candidate_sha,
    deploymentId: observedDeployment,
    preparedDeploymentId: state.prepared_deployment_id,
    ownerFingerprint: state.actors.owner,
    participantFingerprint: state.actors.participant,
    observedAtUtc: new Date().toISOString(),
  });
}

async function cleanup(state, credentials, fetchImpl) {
  const client = actors(state, credentials, fetchImpl);
  for (const actor of [client.participant, client.owner]) {
    const response = await actor.request(`/api/v1/minds/${state.mind.handle}`, { headers: { accept: "application/json" } });
    if (response.status === 200 && response.body?.data?.access?.role === "owner") { await deleteMind(actor, state); break; }
  }
  for (const [actor, tokenRef, suffix] of [[client.owner, credentials.ownerMcpTokenRef, "owner"], [client.participant, credentials.participantMcpTokenRef, "participant"]]) {
    const listed = await actor.request("/api/v1/mcp-tokens", { headers: { accept: "application/json" } });
    const token = listed.body?.data?.items?.find((item) => item?.personal_token_ref === tokenRef);
    if (listed.status === 200 && token?.state !== "revoked") await revokeToken(actor, tokenRef, state, suffix);
  }
  return Object.freeze({ schema: STATE_SCHEMA, status: "cleaned", run_nonce: state.run_nonce });
}

export async function run(options, { environment = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") fail("fetch_unavailable");
  const credentials = loadCredentialEnvironment(environment);
  if (options.phase === "setup") {
    if (!options.state_out) fail("missing_state_out");
    const state = makeState(options);
    await writeJson(options.state_out, state);
    await setup(state, credentials, fetchImpl);
    await writeJson(options.state_out, validateState({ ...state, status: "awaiting_redeploy" }));
    return { status: "awaiting_redeploy", state_path: options.state_out, run_nonce: state.run_nonce };
  }
  if (!options.state) fail("missing_state");
  const state = await readState(options.state);
  if (options.phase === "verify") {
    if (!options.deployment_id || !options.evidence_out) fail("missing_verify_output");
    const evidence = await verify(state, options.deployment_id, credentials, fetchImpl);
    await writeJson(options.evidence_out, evidence);
    return { status: "passed", evidence_path: options.evidence_out, artifact_sha256: evidence.artifact_sha256 };
  }
  return cleanup(state, credentials, fetchImpl);
}

function help() {
  return `Usage:\n  node scripts/run-uat-multi-principal-probe.mjs --phase setup --candidate-sha <sha> --deployment-id <id> --owner-fingerprint <pilot-random> --participant-fingerprint <pilot-random> --state-out <path>\n  node scripts/run-uat-multi-principal-probe.mjs --phase verify --deployment-id <new-id> --state <path> --evidence-out <path>\n  node scripts/run-uat-multi-principal-probe.mjs --phase cleanup --state <path>\n\nSecrets and participant email are accepted only through MIND_DIARY_UAT_* environment references.`;
}
async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) process.stdout.write(`${help()}\n`);
    else process.stdout.write(`${JSON.stringify(await run(options))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "failed", code: error instanceof ProbeFailure ? error.code : "probe_failed" })}\n`);
    process.exitCode = 1;
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
