#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  link,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ProbeFailure,
  assertRedactedDocument,
  canonical,
  candidateSha,
  digest,
  fail,
  isRecord,
  mcpResultData,
  required,
  safeCode,
} from "./lib/multi-principal-probe-core.mjs";

export { ProbeFailure };

const STATE_SCHEMA = "mind-diary/uat-generated-producer-canary-state/v1";
const RECEIPT_SCHEMA = "mind-diary/uat-generated-producer-canary-receipt/v1";
const FIXTURE_PROFILE = "md290-generated-producer-v1";
const DEFAULT_BASE_URL = "https://mind-diary.example.invalid";
const CANARY_PATH = "/api/v1/internal/operators/generated-ingress-canary";
const MCP_PROTOCOL = "2026-07-28";
const PRIVATE_MODE = 0o600;
const ENVIRONMENT = Object.freeze({
  sites: "MIND_DIARY_UAT_GENERATED_CANARY_SITES_TOKEN",
  mcp: "MIND_DIARY_UAT_GENERATED_CANARY_MCP_TOKEN",
});

export const FIXTURE_SHA256 = Object.freeze([
  "sha256:1b56b50ac4e976f488f128cabdcdffb2fc9331d6974bb9968131a415d14ade24",
  "sha256:95acc04f9967f3f6971471ac9903c3a0135f010cc246039bb186e6f079bb6af0",
]);

const ROUTE_SETUP_ASSERTION_IDS = Object.freeze([
  "target.synthetic_private_owner_mind",
  "binding.preexisting_current_generation",
  "negative.foreign_binding_no_head",
  "negative.expired_binding_no_head",
  "negative.mime_no_head",
  "negative.size_no_head",
  "negative.quota_no_head",
  "negative.cancel_no_head",
  "negative.replay_no_head",
  "negative.writer_failure_no_head",
  "stage.bounded_replay_exact",
  "stage.server_stream_exact",
  "commit.atomic_generated_files_and_markdown",
]);

const ROUTE_VERIFY_ASSERTION_IDS = Object.freeze([
  "persistence.reconstruction_after_redeploy",
  "history.head_and_historical_exact_bytes_sha",
  "binding.current_generation_after_redeploy",
]);

export const GENERATED_CANARY_ASSERTION_IDS = Object.freeze([
  "sessions.environment_backed_only",
  "target.synthetic_private_owned_mind",
  "binding.preexisting_generation_invalidated",
  ...ROUTE_SETUP_ASSERTION_IDS,
  "redeploy.distinct_deployment",
  ...ROUTE_VERIFY_ASSERTION_IDS,
  "cleanup.write_binding_unbound",
  "cleanup.canary_owned_mind_deleted",
]);

const STATE_STATUSES = new Set([
  "setup_started",
  "priming_started",
  "canary_created",
  "canary_target_active",
  "awaiting_redeploy",
  "verified",
  "cleanup_complete",
  "passed",
  "recovered",
]);

function deploymentId(value) {
  if (typeof value !== "string" || !/^appgdep_[a-z0-9]+$/u.test(value)) {
    fail("invalid_deployment_id");
  }
  return value;
}

function runNonce(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{16}$/u.test(value)) {
    fail("invalid_run_nonce");
  }
  return value;
}

function utc(value) {
  if (
    typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) fail("invalid_observed_at_utc");
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

function canaryHandle(nonce) {
  return `md290-generated-${runNonce(nonce)}`;
}

function canaryName(nonce) {
  return `MD-290 Generated Canary ${runNonce(nonce)}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function targetFingerprint(value) {
  if (typeof value !== "string" || !/^md290-target-[0-9a-f]{32}$/u.test(value)) {
    fail("invalid_target_fingerprint");
  }
  return value;
}

function fingerprintTarget(target) {
  return targetFingerprint(`md290-target-${sha256(baseUrl(target)).slice(0, 32)}`);
}

function runFingerprint(value) {
  if (typeof value !== "string" || !/^md290-run-[0-9a-f]{32}$/u.test(value)) {
    fail("invalid_run_fingerprint");
  }
  return value;
}

function fingerprintRun(nonce, candidate, setupDeploymentId, target) {
  return runFingerprint(`md290-run-${sha256(canonical({
    nonce,
    candidate,
    setupDeploymentId,
    target,
  })).slice(0, 32)}`);
}

function resourceFingerprint(value) {
  if (typeof value !== "string" || !/^md290-resource-[0-9a-f]{32}$/u.test(value)) {
    fail("invalid_resource_fingerprint");
  }
  return value;
}

function fingerprintResource(run, mindId) {
  return resourceFingerprint(`md290-resource-${sha256(canonical({
    run,
    mindId: required(mindId, "invalid_mind_projection"),
  })).slice(0, 32)}`);
}

function sameStrings(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

export function assertCanaryDocument(value) {
  assertRedactedDocument(value);
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (
        /^https?:\/\//iu.test(current) || /^\/(?!\/)/u.test(current) ||
        /(?:^|\s)(?:[A-Za-z]:\\|~\/|\/Users\/|\/private\/|\/tmp\/)/u.test(current) ||
        /^write_binding_[a-z0-9]/iu.test(current)
      ) fail("unsafe_canary_document");
    } else if (Array.isArray(current)) {
      pending.push(...current);
    } else if (isRecord(current)) {
      pending.push(...Object.values(current));
    }
  }
  return value;
}

function assertionList(value, allowed, code) {
  if (!sameStrings(value, allowed)) fail(code);
  return Object.freeze([...allowed]);
}

function fixtureSha256(value) {
  if (!sameStrings(value, FIXTURE_SHA256)) fail("fixture_sha_mismatch");
  return FIXTURE_SHA256;
}

function validateState(value) {
  if (!isRecord(value) || value.schema !== STATE_SCHEMA) fail("invalid_state_schema");
  if (!STATE_STATUSES.has(value.status)) fail("invalid_state_status");
  const status = value.status;
  const setupDeploymentId = deploymentId(value.setup_deployment_id);
  const candidate = candidateSha(value.candidate_sha);
  const nonce = runNonce(value.run_nonce);
  const target = targetFingerprint(value.target_fingerprint);
  const run = runFingerprint(value.run_fingerprint);
  if (run !== fingerprintRun(nonce, candidate, setupDeploymentId, target)) {
    fail("run_fingerprint_mismatch");
  }
  const resource = value.resource_fingerprint === null
    ? null
    : resourceFingerprint(value.resource_fingerprint);
  if (
    (status === "setup_started" || status === "priming_started") &&
    resource !== null
  ) fail("unexpected_resource_fingerprint");
  if (
    status !== "setup_started" && status !== "priming_started" &&
    status !== "recovered" && resource === null
  ) fail("resource_fingerprint_missing");
  let verifyDeploymentId = null;
  if (value.verify_deployment_id !== null) {
    verifyDeploymentId = deploymentId(value.verify_deployment_id);
    if (verifyDeploymentId === setupDeploymentId) fail("redeploy_boundary_not_observed");
  }
  if (
    (status === "verified" || status === "cleanup_complete" || status === "passed") &&
    verifyDeploymentId === null
  ) fail("verify_deployment_missing");
  if (
    (
      status === "setup_started" || status === "priming_started" ||
      status === "canary_created" || status === "canary_target_active" ||
      status === "awaiting_redeploy"
    ) &&
    verifyDeploymentId !== null
  ) fail("unexpected_verify_deployment");
  const setupAssertions = value.setup_assertions === null
    ? null
    : assertionList(
      value.setup_assertions,
      ROUTE_SETUP_ASSERTION_IDS,
      "setup_assertions_mismatch",
    );
  const verifyAssertions = value.verify_assertions === null
    ? null
    : assertionList(
      value.verify_assertions,
      ROUTE_VERIFY_ASSERTION_IDS,
      "verify_assertions_mismatch",
    );
  const fixture = value.fixture_sha256 === null
    ? null
    : fixtureSha256(value.fixture_sha256);
  if (
    (
      status === "setup_started" || status === "priming_started" ||
      status === "canary_created" || status === "canary_target_active"
    ) &&
    (setupAssertions !== null || verifyAssertions !== null || fixture !== null)
  ) fail("unexpected_setup_evidence");
  if (
    (
      status === "awaiting_redeploy" || status === "verified" ||
      status === "cleanup_complete" || status === "passed"
    ) &&
    (setupAssertions === null || fixture === null)
  ) fail("setup_evidence_missing");
  if (
    (
      status === "verified" || status === "cleanup_complete" || status === "passed"
    ) && verifyAssertions === null
  ) fail("verify_evidence_missing");
  const state = Object.freeze({
    schema: STATE_SCHEMA,
    status,
    candidate_sha: candidate,
    setup_deployment_id: setupDeploymentId,
    verify_deployment_id: verifyDeploymentId,
    run_nonce: nonce,
    target_fingerprint: target,
    run_fingerprint: run,
    resource_fingerprint: resource,
    fixture_profile: value.fixture_profile === FIXTURE_PROFILE
      ? FIXTURE_PROFILE
      : fail("invalid_fixture_profile"),
    fixture_sha256: fixture,
    setup_assertions: setupAssertions,
    verify_assertions: verifyAssertions,
  });
  return Object.freeze(assertCanaryDocument(state));
}

function makeInitialState(options) {
  const candidate = candidateSha(options.candidate_sha);
  const setupDeploymentId = deploymentId(options.deployment_id);
  const nonce = runNonce(options.nonce ?? randomBytes(8).toString("hex"));
  const target = fingerprintTarget(options.base_url ?? DEFAULT_BASE_URL);
  return validateState({
    schema: STATE_SCHEMA,
    status: "setup_started",
    candidate_sha: candidate,
    setup_deployment_id: setupDeploymentId,
    verify_deployment_id: null,
    run_nonce: nonce,
    target_fingerprint: target,
    run_fingerprint: fingerprintRun(nonce, candidate, setupDeploymentId, target),
    resource_fingerprint: null,
    fixture_profile: FIXTURE_PROFILE,
    fixture_sha256: null,
    setup_assertions: null,
    verify_assertions: null,
  });
}

export function createReceipt(input) {
  const unsigned = Object.freeze({
    schema: RECEIPT_SCHEMA,
    status: "passed",
    candidate_sha: candidateSha(input.candidateSha),
    setup_deployment_id: deploymentId(input.setupDeploymentId),
    verify_deployment_id: deploymentId(input.verifyDeploymentId),
    target_fingerprint: targetFingerprint(input.targetFingerprint),
    run_fingerprint: runFingerprint(input.runFingerprint),
    resource_fingerprint: resourceFingerprint(input.resourceFingerprint),
    fixture_profile: FIXTURE_PROFILE,
    fixture_sha256: fixtureSha256(input.fixtureSha256),
    assertions: Object.freeze(GENERATED_CANARY_ASSERTION_IDS.map((id) =>
      Object.freeze({ id, status: "passed" }))),
    observed_at_utc: utc(input.observedAtUtc),
  });
  if (unsigned.setup_deployment_id === unsigned.verify_deployment_id) {
    fail("redeploy_boundary_not_observed");
  }
  return Object.freeze(assertCanaryDocument({
    ...unsigned,
    artifact_sha256: digest(canonical(unsigned)),
  }));
}

function validateReceipt(value) {
  if (!isRecord(value) || value.schema !== RECEIPT_SCHEMA || value.status !== "passed") {
    fail("invalid_receipt_schema");
  }
  if (!Array.isArray(value.assertions) ||
    value.assertions.length !== GENERATED_CANARY_ASSERTION_IDS.length) {
    fail("receipt_assertions_mismatch");
  }
  for (let index = 0; index < GENERATED_CANARY_ASSERTION_IDS.length; index += 1) {
    const assertion = value.assertions[index];
    if (
      !isRecord(assertion) || assertion.id !== GENERATED_CANARY_ASSERTION_IDS[index] ||
      assertion.status !== "passed"
    ) fail("receipt_assertions_mismatch");
  }
  const unsigned = Object.freeze({
    schema: RECEIPT_SCHEMA,
    status: "passed",
    candidate_sha: candidateSha(value.candidate_sha),
    setup_deployment_id: deploymentId(value.setup_deployment_id),
    verify_deployment_id: deploymentId(value.verify_deployment_id),
    target_fingerprint: targetFingerprint(value.target_fingerprint),
    run_fingerprint: runFingerprint(value.run_fingerprint),
    resource_fingerprint: resourceFingerprint(value.resource_fingerprint),
    fixture_profile: value.fixture_profile === FIXTURE_PROFILE
      ? FIXTURE_PROFILE
      : fail("invalid_fixture_profile"),
    fixture_sha256: fixtureSha256(value.fixture_sha256),
    assertions: Object.freeze(value.assertions.map((assertion) => Object.freeze({
      id: assertion.id,
      status: "passed",
    }))),
    observed_at_utc: utc(value.observed_at_utc),
  });
  const artifactSha256 = digest(canonical(unsigned));
  if (value.artifact_sha256 !== artifactSha256) fail("receipt_digest_mismatch");
  return Object.freeze(assertCanaryDocument({
    ...unsigned,
    artifact_sha256: artifactSha256,
  }));
}

function assertReceiptMatchesState(receipt, state) {
  if (
    receipt.candidate_sha !== state.candidate_sha ||
    receipt.setup_deployment_id !== state.setup_deployment_id ||
    receipt.verify_deployment_id !== state.verify_deployment_id ||
    receipt.target_fingerprint !== state.target_fingerprint ||
    receipt.run_fingerprint !== state.run_fingerprint ||
    receipt.resource_fingerprint !== state.resource_fingerprint ||
    !sameStrings(receipt.fixture_sha256, state.fixture_sha256)
  ) fail("receipt_state_mismatch");
  return receipt;
}

export function loadCredentialEnvironment(environment = process.env) {
  const sitesToken = required(
    environment[ENVIRONMENT.sites],
    `missing_${ENVIRONMENT.sites.toLowerCase()}`,
  );
  const mcpToken = required(
    environment[ENVIRONMENT.mcp],
    `missing_${ENVIRONMENT.mcp.toLowerCase()}`,
  );
  if (!mcpToken.startsWith("mdp_v1_")) fail("invalid_mcp_token_reference");
  return Object.freeze({ sitesToken, mcpToken });
}

export function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (!argument.startsWith("--")) fail("invalid_cli_argument");
    const key = argument.slice(2).replaceAll("-", "_");
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      fail("missing_cli_value");
    }
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
    "receipt_out",
    "nonce",
  ]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) fail("unsupported_cli_argument");
  }
  if (!new Set(["setup", "verify", "cleanup", "recover"]).has(options.phase)) {
    fail("invalid_phase");
  }
  return options;
}

async function assertPrivateMode(path, code) {
  const metadata = await stat(path);
  if ((metadata.mode & 0o777) !== PRIVATE_MODE || !metadata.isFile()) fail(code);
}

async function writeHandleJson(handle, value) {
  await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await handle.sync();
}

async function writeExclusiveJson(path, value) {
  assertCanaryDocument(value);
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", PRIVATE_MODE);
  } catch (error) {
    throw error;
  }
  try {
    await writeHandleJson(handle, value);
    await handle.close();
    handle = null;
    await link(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (error?.code === "EEXIST") fail("output_exists");
    throw error;
  }
  await unlink(temporary).catch(() => undefined);
  await assertPrivateMode(path, "unsafe_output_permissions");
}

async function writeAtomicJson(path, value) {
  assertCanaryDocument(value);
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", PRIVATE_MODE);
    await writeHandleJson(handle, value);
    await handle.close();
    handle = null;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await assertPrivateMode(path, "unsafe_state_permissions");
}

async function readState(path) {
  await assertPrivateMode(path, "unsafe_state_permissions");
  try {
    return validateState(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    fail("invalid_state_json");
  }
}

async function readReceipt(path) {
  await assertPrivateMode(path, "unsafe_output_permissions");
  try {
    return validateReceipt(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    fail("invalid_receipt_json");
  }
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

class CanaryClient {
  constructor({ baseUrl: target, credentials, fetchImpl }) {
    this.baseUrl = baseUrl(target);
    this.origin = new URL(this.baseUrl).origin;
    this.sitesToken = credentials.sitesToken;
    this.mcpToken = credentials.mcpToken;
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
        fail("invalid_json_response", { status: response.status });
      }
    }
    return Object.freeze({ status: response.status, body, text });
  }

  async csrf(path = "/") {
    const response = await this.request(path, {
      headers: { accept: "text/html" },
    });
    const match = response.status === 200 &&
      /<meta name="mind-diary-csrf-token" content="([^"]+)">/u.exec(response.text);
    if (!match) fail("csrf_token_missing", { status: response.status });
    return match[1];
  }

  async api(path, {
    method = "GET",
    body,
    idempotencyKey,
    csrfPath = "/minds",
    expectedStatuses = [200],
  } = {}) {
    const headers = { accept: "application/json" };
    if (method !== "GET") {
      headers.origin = this.origin;
      headers["x-csrf-token"] = await this.csrf(csrfPath);
      if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
      if (body !== undefined) headers["content-type"] = "application/json";
    }
    const response = await this.request(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!expectedStatuses.includes(response.status)) {
      fail("api_request_failed", {
        status: response.status,
        code: safeCode(response.body?.error?.code),
      });
    }
    return response;
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
        id: `md290-${name}`,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL,
            "io.modelcontextprotocol/clientInfo": {
              name: "uat-generated-producer-canary",
              version: "1",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    return mcpResultData(response);
  }

  async canary(input) {
    const response = await this.request(CANARY_PATH, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.mcpToken}`,
        "content-type": "application/json; charset=utf-8",
        origin: this.origin,
        "x-csrf-token": await this.csrf("/"),
      },
      body: JSON.stringify(input),
    });
    if (response.status !== 200 || response.body?.ok !== true ||
      !isRecord(response.body?.data)) {
      fail("generated_canary_request_failed", {
        status: response.status,
        code: safeCode(response.body?.error?.code),
      });
    }
    return response.body.data;
  }
}

function bindingProjection(value) {
  if (
    !isRecord(value) || !Number.isSafeInteger(value.binding_version) ||
    value.binding_version < 0
  ) fail("invalid_binding_projection");
  return value;
}

function writeBindingId(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) fail(code);
  return value;
}

function assertRouteData(data, action) {
  const expectedStatus = action === "setup" ? "awaiting_redeploy" : "verified";
  const expectedAssertions = action === "setup"
    ? ROUTE_SETUP_ASSERTION_IDS
    : ROUTE_VERIFY_ASSERTION_IDS;
  if (
    data.status !== expectedStatus || data.fixture_profile !== FIXTURE_PROFILE ||
    !sameStrings(data.fixture_sha256, FIXTURE_SHA256) ||
    !sameStrings(data.assertions, expectedAssertions)
  ) fail("generated_canary_response_mismatch");
  return Object.freeze({
    fixtureSha256: FIXTURE_SHA256,
    assertions: expectedAssertions,
  });
}

function mindData(response, nonce) {
  if (!isRecord(response.body?.data)) fail("invalid_mind_projection");
  const mind = response.body.data;
  const handle = canaryHandle(nonce);
  if (
    mind.name !== canaryName(nonce) || mind.route !== `/${handle}` ||
    mind.visibility !== "private" || mind.access?.kind !== "membership" ||
    mind.access?.role !== "owner"
  ) fail("canary_ownership_unverified");
  return mind;
}

function assertResourceOwnership(mind, state) {
  if (
    state.resource_fingerprint === null ||
    fingerprintResource(state.run_fingerprint, mind?.mind_id) !==
      state.resource_fingerprint
  ) fail("canary_ownership_unattested");
  return mind;
}

async function assertSingleOwner(client, nonce) {
  const response = await client.api(
    `/api/v1/minds/${canaryHandle(nonce)}/members`,
  );
  const members = response.body?.data?.members;
  if (
    !Array.isArray(members) || members.length !== 1 ||
    members[0]?.role !== "owner" || members[0]?.is_self !== true
  ) fail("canary_ownership_unverified");
}

async function assertRegisteredSamePrincipal(client) {
  const session = await client.api("/api/v1/session", {
    expectedStatuses: [200, 409],
  });
  if (session.status === 409 && session.body?.error?.code === "registration_required") {
    fail("canary_account_not_registered");
  }
  if (!isRecord(session.body?.data)) fail("invalid_session_projection");
  const principalId = required(
    session.body.data.principal?.principal_id,
    "invalid_session_projection",
  );
  const personalMindId = required(
    session.body.data.personal_mind?.mind_id,
    "invalid_session_projection",
  );
  const minds = await client.mcp("list_minds");
  if (
    !Array.isArray(minds.minds) ||
    minds.minds.find((mind) => mind?.route === "/me")?.mind_id !== personalMindId
  ) fail("mcp_token_principal_mismatch");
  return principalId;
}

async function setup(state, client, checkpoint) {
  await assertRegisteredSamePrincipal(client);
  const initialBindings = bindingProjection(await client.mcp("get_mind_bindings"));
  if (initialBindings.write_binding !== null) {
    fail("dedicated_write_binding_not_empty");
  }
  let working = validateState({ ...state, status: "priming_started" });
  await checkpoint(working);
  const old = bindingProjection(await client.mcp("set_write_mind_binding", {
    action: "bind",
    mind: "/me",
    expected_binding_version: initialBindings.binding_version,
    idempotency_key: `md290:${state.run_nonce}:binding:prime`,
  }));
  const staleBindingId = writeBindingId(
    old.current?.write_binding_id,
    "primed_write_binding_missing",
  );
  if (old.current?.mind?.route !== "/me") fail("primed_write_binding_mismatch");

  const creation = await client.api("/api/v1/minds", {
    method: "POST",
    body: {
      name: canaryName(state.run_nonce),
      handle: canaryHandle(state.run_nonce),
    },
    idempotencyKey: `md290:${state.run_nonce}:mind:create`,
    csrfPath: "/minds",
  });
  const createdMind = mindData(creation, state.run_nonce);
  working = validateState({
    ...working,
    status: "canary_created",
    resource_fingerprint: fingerprintResource(
      working.run_fingerprint,
      createdMind.mind_id,
    ),
  });
  await checkpoint(working);
  const created = await client.api(`/api/v1/minds/${canaryHandle(state.run_nonce)}`);
  assertResourceOwnership(mindData(created, state.run_nonce), working);
  await assertSingleOwner(client, state.run_nonce);

  const current = bindingProjection(await client.mcp("set_write_mind_binding", {
    action: "bind",
    mind: `/${canaryHandle(state.run_nonce)}`,
    expected_binding_version: old.binding_version,
    idempotency_key: `md290:${state.run_nonce}:binding:canary`,
  }));
  const currentBindingId = writeBindingId(
    current.current?.write_binding_id,
    "canary_write_binding_missing",
  );
  if (
    current.current?.mind?.route !== `/${canaryHandle(state.run_nonce)}` ||
    currentBindingId === staleBindingId ||
    current.previous?.write_binding_id !== staleBindingId ||
    current.previous?.state !== "invalidated"
  ) fail("canary_write_binding_mismatch");

  working = validateState({ ...working, status: "canary_target_active" });
  await checkpoint(working);

  const route = assertRouteData(await client.canary({
    action: "setup",
    run_nonce: state.run_nonce,
    write_binding_id: currentBindingId,
    stale_write_binding_id: staleBindingId,
  }), "setup");
  return validateState({
    ...working,
    status: "awaiting_redeploy",
    fixture_sha256: route.fixtureSha256,
    setup_assertions: route.assertions,
  });
}

async function verify(state, observedDeploymentId, client) {
  if (state.status !== "awaiting_redeploy") fail("setup_not_complete");
  const verifyDeploymentId = deploymentId(observedDeploymentId);
  if (verifyDeploymentId === state.setup_deployment_id) {
    fail("redeploy_boundary_not_observed");
  }
  await assertRegisteredSamePrincipal(client);
  const bindings = bindingProjection(await client.mcp("get_mind_bindings"));
  const currentBindingId = writeBindingId(
    bindings.write_binding?.write_binding_id,
    "canary_write_binding_missing",
  );
  if (bindings.write_binding?.mind?.route !== `/${canaryHandle(state.run_nonce)}`) {
    fail("canary_write_binding_mismatch");
  }
  const route = assertRouteData(await client.canary({
    action: "verify",
    run_nonce: state.run_nonce,
    write_binding_id: currentBindingId,
  }), "verify");
  return validateState({
    ...state,
    status: "verified",
    verify_deployment_id: verifyDeploymentId,
    verify_assertions: route.assertions,
  });
}

async function unbindExpectedRoute(client, state, { expectedRoute, requiredTarget, suffix }) {
  const bindings = bindingProjection(await client.mcp("get_mind_bindings"));
  if (bindings.write_binding === null) {
    if (requiredTarget) fail("canary_write_binding_missing");
    return false;
  }
  if (bindings.write_binding?.mind?.route !== expectedRoute) {
    if (requiredTarget) fail("canary_write_binding_changed");
    return false;
  }
  const unbound = bindingProjection(await client.mcp("set_write_mind_binding", {
    action: "unbind",
    expected_binding_version: bindings.binding_version,
    idempotency_key: `md290:${state.run_nonce}:binding:${suffix}`,
  }));
  if (
    unbound.current !== null ||
    unbound.previous?.mind?.route !== expectedRoute ||
    unbound.previous?.state !== "invalidated"
  ) fail("canary_unbind_failed");
  return true;
}

async function unbindCanary(client, state, { requiredTarget }) {
  return unbindExpectedRoute(client, state, {
    expectedRoute: `/${canaryHandle(state.run_nonce)}`,
    requiredTarget,
    suffix: "unbind",
  });
}

async function deleteOwnedCanary(client, state) {
  const handle = canaryHandle(state.run_nonce);
  const inspected = await client.api(`/api/v1/minds/${handle}`, {
    expectedStatuses: [200, 404],
  });
  if (inspected.status === 404) {
    if (inspected.body?.error?.code !== "mind_not_found") {
      fail("canary_cleanup_lookup_failed");
    }
    return false;
  }
  assertResourceOwnership(mindData(inspected, state.run_nonce), state);
  await assertSingleOwner(client, state.run_nonce);
  const impact = await client.api(`/api/v1/minds/${handle}/deletion-impact`);
  if (
    !isRecord(impact.body?.data) ||
    impact.body.data.confirmation !== `delete-mind:${handle}` ||
    typeof impact.body.data.impact_id !== "string"
  ) fail("canary_deletion_impact_mismatch");
  await client.api(`/api/v1/minds/${handle}`, {
    method: "DELETE",
    body: {
      impact_id: impact.body.data.impact_id,
      confirmation: impact.body.data.confirmation,
    },
    idempotencyKey: `md290:${state.run_nonce}:mind:delete`,
    csrfPath: `/${handle}`,
  });
  const after = await client.api(`/api/v1/minds/${handle}`, {
    expectedStatuses: [404],
  });
  if (after.body?.error?.code !== "mind_not_found") fail("canary_cleanup_failed");
  return true;
}

async function cleanupResources(state, client, { recovery }) {
  await assertRegisteredSamePrincipal(client);
  const handle = canaryHandle(state.run_nonce);
  const before = await client.api(`/api/v1/minds/${handle}`, {
    expectedStatuses: [200, 404],
  });
  if (before.status === 200) {
    assertResourceOwnership(mindData(before, state.run_nonce), state);
    await assertSingleOwner(client, state.run_nonce);
  } else if (before.body?.error?.code !== "mind_not_found") {
    fail("canary_cleanup_lookup_failed");
  }
  const unbound = await unbindCanary(client, state, {
    requiredTarget: false,
  });
  const deleted = await deleteOwnedCanary(client, state);
  const bindings = bindingProjection(await client.mcp("get_mind_bindings"));
  if (bindings.write_binding?.mind?.route === `/${canaryHandle(state.run_nonce)}`) {
    fail("canary_cleanup_binding_retained");
  }
  return Object.freeze({ unbound, deleted, recovery });
}

async function recoverResources(state, client) {
  if (state.status === "setup_started") {
    return Object.freeze({ unbound: false, deleted: false });
  }
  await assertRegisteredSamePrincipal(client);
  const handle = canaryHandle(state.run_nonce);
  const route = `/${handle}`;
  const before = await client.api(`/api/v1/minds/${handle}`, {
    expectedStatuses: [200, 404],
  });
  if (before.status === 200) {
    if (state.resource_fingerprint === null) {
      if (state.status === "priming_started") {
        const bindings = bindingProjection(await client.mcp("get_mind_bindings"));
        if (bindings.write_binding?.mind?.route === "/me") {
          await unbindExpectedRoute(client, state, {
            expectedRoute: "/me",
            requiredTarget: true,
            suffix: "recover-prime",
          });
        }
      }
      fail("canary_ownership_unattested");
    }
    assertResourceOwnership(mindData(before, state.run_nonce), state);
    await assertSingleOwner(client, state.run_nonce);
  } else if (before.body?.error?.code !== "mind_not_found") {
    fail("canary_cleanup_lookup_failed");
  }

  const bindings = bindingProjection(await client.mcp("get_mind_bindings"));
  const currentRoute = bindings.write_binding?.mind?.route ?? null;
  let unbound = false;
  if (currentRoute === route) {
    unbound = await unbindCanary(client, state, { requiredTarget: true });
  } else if (
    currentRoute === "/me" &&
    (state.status === "priming_started" || state.status === "canary_created")
  ) {
    unbound = await unbindExpectedRoute(client, state, {
      expectedRoute: "/me",
      requiredTarget: true,
      suffix: "recover-prime",
    });
  }
  const deleted = await deleteOwnedCanary(client, state);
  const after = bindingProjection(await client.mcp("get_mind_bindings"));
  if (after.write_binding?.mind?.route === route) {
    fail("canary_cleanup_binding_retained");
  }
  if (
    (state.status === "priming_started" || state.status === "canary_created") &&
    currentRoute === "/me" &&
    after.write_binding !== null
  ) fail("priming_binding_cleanup_failed");
  return Object.freeze({ unbound, deleted });
}

function clientFor(options, credentials, fetchImpl, state = null) {
  const target = options.base_url ?? DEFAULT_BASE_URL;
  if (
    state !== null && fingerprintTarget(target) !== state.target_fingerprint
  ) fail("uat_target_fingerprint_mismatch");
  return new CanaryClient({
    baseUrl: target,
    credentials,
    fetchImpl,
  });
}

export async function run(options, {
  environment = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof fetchImpl !== "function") fail("fetch_unavailable");
  if (options.phase === "setup") {
    if (!options.state_out) fail("missing_state_out");
    const state = makeInitialState(options);
    const credentials = loadCredentialEnvironment(environment);
    const client = clientFor(options, credentials, fetchImpl, state);
    await writeExclusiveJson(options.state_out, state);
    const prepared = await setup(state, client, async (checkpoint) => {
      await writeAtomicJson(options.state_out, checkpoint);
    });
    await writeAtomicJson(options.state_out, prepared);
    return Object.freeze({ status: "awaiting_redeploy", run_nonce: state.run_nonce });
  }

  if (!options.state) fail("missing_state");
  const state = await readState(options.state);
  if (options.phase === "verify") {
    if (!options.deployment_id) fail("missing_verify_deployment");
    const credentials = loadCredentialEnvironment(environment);
    const client = clientFor(options, credentials, fetchImpl, state);
    const verified = await verify(state, options.deployment_id, client);
    await writeAtomicJson(options.state, verified);
    return Object.freeze({ status: "verified" });
  }

  if (options.phase === "cleanup") {
    if (state.status !== "verified" && state.status !== "cleanup_complete") {
      fail("verify_not_complete");
    }
    if (!options.receipt_out) fail("missing_receipt_out");
    const receiptInput = Object.freeze({
      candidateSha: state.candidate_sha,
      setupDeploymentId: state.setup_deployment_id,
      verifyDeploymentId: state.verify_deployment_id,
      targetFingerprint: state.target_fingerprint,
      runFingerprint: state.run_fingerprint,
      resourceFingerprint: state.resource_fingerprint,
      fixtureSha256: state.fixture_sha256,
      observedAtUtc: now(),
    });
    let existingReceipt = null;
    if (await pathExists(options.receipt_out)) {
      existingReceipt = assertReceiptMatchesState(
        await readReceipt(options.receipt_out),
        state,
      );
    }
    let cleaned = state;
    if (state.status === "verified") {
      const credentials = loadCredentialEnvironment(environment);
      const client = clientFor(options, credentials, fetchImpl, state);
      await cleanupResources(state, client, { recovery: false });
      cleaned = validateState({ ...state, status: "cleanup_complete" });
      await writeAtomicJson(options.state, cleaned);
    }
    const receipt = existingReceipt ?? createReceipt(receiptInput);
    if (existingReceipt === null) {
      await writeExclusiveJson(options.receipt_out, receipt);
    }
    await writeAtomicJson(options.state, validateState({
      ...cleaned,
      status: "passed",
    }));
    return Object.freeze({
      status: "passed",
      artifact_sha256: receipt.artifact_sha256,
    });
  }

  if (state.status === "passed" || state.status === "recovered") {
    fail("state_already_terminal");
  }
  const credentials = loadCredentialEnvironment(environment);
  const client = clientFor(options, credentials, fetchImpl, state);
  await recoverResources(state, client);
  await writeAtomicJson(options.state, validateState({
    ...state,
    status: "recovered",
  }));
  return Object.freeze({ status: "recovered" });
}

export function help() {
  return [
    "Usage:",
    "  node scripts/run-uat-generated-producer-canary.mjs --phase setup --candidate-sha <sha> --deployment-id <id> --state-out <path>",
    "  node scripts/run-uat-generated-producer-canary.mjs --phase verify --deployment-id <new-id> --state <path>",
    "  node scripts/run-uat-generated-producer-canary.mjs --phase cleanup --state <path> --receipt-out <path>",
    "  node scripts/run-uat-generated-producer-canary.mjs --phase recover --state <path>",
    "",
    "Use --base-url only for the exact UAT origin. Sites and MCP credentials are accepted only through MIND_DIARY_UAT_GENERATED_CANARY_* environment variables.",
  ].join("\n");
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) process.stdout.write(`${help()}\n`);
    else process.stdout.write(`${JSON.stringify(await run(options))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: "failed",
      code: error instanceof ProbeFailure ? error.code : "generated_canary_failed",
    })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
