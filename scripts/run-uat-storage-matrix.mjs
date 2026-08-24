#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  BRAIN_FIXTURE_FILE_COUNT,
  BRAIN_FIXTURE_LOGICAL_BYTES,
  BRAIN_FIXTURE_MARKER,
  BRAIN_FIXTURE_MARKER_PATH,
  STORAGE_MATRIX_LINEAGE_SCHEMA,
  STORAGE_MATRIX_STATE_SCHEMA,
  StorageMatrixFailure,
  assertLineageTransition,
  candidateSha,
  classifyMcpEnvelope,
  createBrainMarkdownFixture,
  createImportBatches,
  createStorageMatrixEvidence,
  fail,
  fixtureStateProjection,
  inspectDeterministicStoredZip,
  isRecord,
  parseMcpHttpPayload,
  readPrivateState,
  requireMcpData,
  runNonce,
  safeCode,
  safeLocalPath,
  sha256,
  tokenIdFingerprint,
  validateLineageReceipt,
  writePrivateJson,
  writePrivateState,
} from "./lib/uat-storage-matrix-core.mjs";

const MODERN_PROTOCOL = "2026-07-28";
const COMPAT_PROTOCOL = "2025-11-25";
const MODERN_ENDPOINT = "/api/mcp";
const COMPAT_ENDPOINT = "/api/mcp/2025-11-25";
const CLIENT_NAME = "mind-diary-uat-storage-matrix";
const CLIENT_VERSION = "1";
const ENVIRONMENT = Object.freeze({
  sitesCredential: "MIND_DIARY_UAT_STORAGE_SITES_TOKEN",
  mcpCredential: "MIND_DIARY_UAT_STORAGE_MCP_TOKEN",
  mcpTokenId: "MIND_DIARY_UAT_STORAGE_MCP_TOKEN_ID",
});
const REQUIRED_TOOLS = Object.freeze([
  "get_mind_bindings",
  "set_write_mind_binding",
  "get_mind_info",
  "get_revision",
  "search",
  "fetch",
  "start_export",
  "get_export_status",
]);
const ACTIVE_IMPORT_STATES = new Set([
  "active",
  "validating",
  "validated",
  "finalizing",
]);
const TERMINAL_IMPORT_STATES = new Set([
  "committed",
  "canceled",
  "expired",
  "validation_failed",
]);

function help() {
  return `Usage:
  npm run uat:storage-matrix -- --phase setup --candidate-sha <40-hex> --lineage <deployment-a.json> --nonce <16-hex> --state-out <private.json>
  npm run uat:storage-matrix -- --phase start --lineage <deployment-a.json> --state <private.json> [--interrupt-after-batches 1]
  npm run uat:storage-matrix -- --phase interrupt --lineage <deployment-a.json> --state <private.json>
  npm run uat:storage-matrix -- --phase verify --lineage <deployment-b.json> --state <private.json> [--poll-timeout-ms 600000]
  npm run uat:storage-matrix -- --phase cleanup --state <private.json> [--evidence-out <private-receipt.json>]
  npm run uat:storage-matrix -- --phase recover --state <private.json>

Required environment variables (values are never written to state/evidence):
  ${ENVIRONMENT.sitesCredential}
  ${ENVIRONMENT.mcpCredential}
  ${ENVIRONMENT.mcpTokenId}

The dedicated token must be named exactly "UAT Storage Matrix <nonce>", have
content:write, and have empty bindings before setup. The lineage files use
schema ${STORAGE_MATRIX_LINEAGE_SCHEMA}.`;
}

function positiveInteger(value, code, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail(code);
  return parsed;
}

export function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return Object.freeze({ help: true });
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
    "lineage",
    "nonce",
    "state",
    "state_out",
    "evidence_out",
    "interrupt_after_batches",
    "poll_timeout_ms",
  ]);
  for (const key of Object.keys(options)) if (!allowed.has(key)) fail("unsupported_cli_argument");
  if (!new Set(["setup", "start", "interrupt", "verify", "cleanup", "recover"]).has(options.phase)) {
    fail("invalid_phase");
  }
  if (options.interrupt_after_batches !== undefined) {
    options.interrupt_after_batches = positiveInteger(
      options.interrupt_after_batches,
      "invalid_interrupt_batch_count",
      { max: 64 },
    );
  }
  if (options.poll_timeout_ms !== undefined) {
    options.poll_timeout_ms = positiveInteger(
      options.poll_timeout_ms,
      "invalid_poll_timeout",
      { min: 1_000, max: 900_000 },
    );
  }
  return Object.freeze(options);
}

function required(value, code) {
  if (typeof value !== "string" || value.length === 0) fail(code);
  return value;
}

export function loadCredentialEnvironment(environment = process.env) {
  const values = {};
  for (const [key, name] of Object.entries(ENVIRONMENT)) {
    values[key] = required(environment[name], `missing_${name.toLowerCase()}`);
  }
  if (!values.mcpCredential.startsWith("mdp_v1_")) fail("invalid_mcp_token_reference");
  if (values.sitesCredential === values.mcpCredential) fail("shared_credential_forbidden");
  return Object.freeze(values);
}

async function readLineage(path) {
  const target = safeLocalPath(path, "invalid_lineage_path");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) fail("invalid_lineage_json");
    throw error;
  }
  return validateLineageReceipt(parsed);
}

function withoutStateDigest(state) {
  const { state_sha256: _digest, ...unsigned } = state;
  return unsigned;
}

async function saveState(path, state) {
  await writePrivateState(path, withoutStateDigest(state));
  return readPrivateState(path);
}

function samePreparedLineage(state, lineage) {
  const prepared = validateLineageReceipt(state.prepared_lineage);
  const current = validateLineageReceipt(lineage);
  if (
    prepared.candidate_sha !== current.candidate_sha ||
    prepared.site_project_id !== current.site_project_id ||
    prepared.site_version_id !== current.site_version_id ||
    prepared.deployment_id !== current.deployment_id ||
    prepared.live_url !== current.live_url
  ) fail("prepared_lineage_changed");
  return current;
}

function assertCredentialOwnership(state, credentials) {
  if (state.dedicated_token.id_fingerprint !== tokenIdFingerprint(credentials.mcpTokenId)) {
    fail("dedicated_token_id_changed");
  }
  if (state.dedicated_token.name !== `UAT Storage Matrix ${state.run_nonce}`) {
    fail("dedicated_token_name_changed");
  }
}

async function responseJson(response, code) {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    fail(code, { status: response.status });
  }
}

class StorageUatClient {
  constructor({ origin, credentials, fetchImpl, delay }) {
    this.origin = origin;
    this.credentials = credentials;
    this.fetchImpl = fetchImpl;
    this.delay = delay;
    this.csrfToken = null;
    this.rpcId = 0;
    this.compatReady = false;
  }

  nextId(label) {
    this.rpcId += 1;
    return `storage-matrix-${label}-${this.rpcId}`;
  }

  async request(path, options = {}) {
    const headers = new Headers(options.headers ?? {});
    headers.set("OAI-Sites-Authorization", `Bearer ${this.credentials.sitesCredential}`);
    return this.fetchImpl(new URL(path, this.origin), {
      ...options,
      headers,
      redirect: "error",
    });
  }

  async csrf() {
    if (this.csrfToken !== null) return this.csrfToken;
    const response = await this.request("/minds", { headers: { accept: "text/html" } });
    const text = await response.text();
    const match = response.status === 200 &&
      /<meta name="mind-diary-csrf-token" content="([^"]+)">/u.exec(text);
    if (!match) fail("csrf_token_missing", { status: response.status });
    this.csrfToken = match[1];
    return this.csrfToken;
  }

  async api(path, {
    method = "GET",
    body,
    idempotencyKey,
    expectedStatus = 200,
  } = {}) {
    const headers = new Headers({ accept: "application/json" });
    let requestBody;
    if (method !== "GET") {
      headers.set("origin", this.origin);
      headers.set("x-csrf-token", await this.csrf());
      if (idempotencyKey !== undefined) headers.set("idempotency-key", idempotencyKey);
      if (body instanceof FormData) requestBody = body;
      else if (body !== undefined) {
        headers.set("content-type", "application/json; charset=utf-8");
        requestBody = JSON.stringify(body);
      }
    }
    const response = await this.request(path, {
      method,
      headers,
      ...(requestBody === undefined ? {} : { body: requestBody }),
    });
    const payload = await responseJson(response, "invalid_api_json");
    if (response.status !== expectedStatus) {
      fail("api_request_failed", {
        status: response.status,
        applicationCode: safeCode(payload?.error?.code),
      });
    }
    if (expectedStatus === 204) return null;
    if (!isRecord(payload) || payload.ok !== true || !isRecord(payload.data)) {
      fail("invalid_api_projection", { status: response.status });
    }
    return payload.data;
  }

  modernBody(method, params = undefined) {
    return {
      jsonrpc: "2.0",
      id: this.nextId(method.replaceAll("/", "-")),
      method,
      ...(params === undefined ? {} : { params }),
    };
  }

  async mcpRequest(profile, body) {
    const modern = profile === "modern";
    const endpoint = modern ? MODERN_ENDPOINT : COMPAT_ENDPOINT;
    const protocol = modern ? MODERN_PROTOCOL : COMPAT_PROTOCOL;
    const headers = new Headers({
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.credentials.mcpCredential}`,
      "content-type": "application/json; charset=utf-8",
    });
    if (modern) {
      headers.set("mcp-method", body.method);
      headers.set("mcp-protocol-version", protocol);
      if (body.method === "tools/call" && typeof body.params?.name === "string") {
        headers.set("mcp-name", body.params.name);
      }
    } else if (body.method !== "initialize") {
      headers.set("mcp-protocol-version", protocol);
    }
    const response = await this.request(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (response.status === 202 && text.length === 0) {
      return Object.freeze({ status: response.status, envelope: null });
    }
    const envelope = parseMcpHttpPayload(
      text,
      response.headers.get("content-type") ?? "application/json",
    );
    return Object.freeze({ status: response.status, envelope });
  }

  async ensureCompatibility() {
    if (this.compatReady) return;
    const initialized = await this.mcpRequest("compat", {
      jsonrpc: "2.0",
      id: this.nextId("compat-initialize"),
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "codex-mcp-client", title: "Codex", version: "0.147.0" },
      },
    });
    if (
      initialized.status !== 200 ||
      initialized.envelope?.result?.protocolVersion !== COMPAT_PROTOCOL
    ) fail("compat_initialize_failed", { status: initialized.status });
    const notified = await this.mcpRequest("compat", {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    if (notified.status !== 202) fail("compat_initialized_notification_failed", { status: notified.status });
    this.compatReady = true;
  }

  async mcpRpc(profile, method, params = undefined) {
    if (profile === "compat") await this.ensureCompatibility();
    return this.mcpRequest(profile, this.modernBody(method, params));
  }

  async mcpToolOutcome(profile, name, args = {}) {
    const meta = profile === "modern"
      ? {
          "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL,
          "io.modelcontextprotocol/clientInfo": { name: CLIENT_NAME, version: CLIENT_VERSION },
          "io.modelcontextprotocol/clientCapabilities": {},
        }
      : { progressToken: this.rpcId + 1 };
    const response = await this.mcpRpc(profile, "tools/call", {
      name,
      arguments: args,
      _meta: meta,
    });
    return classifyMcpEnvelope(response.status, response.envelope);
  }

  async mcpTool(profile, name, args = {}, failureCode = `${profile}_${name}_failed`) {
    const outcome = await this.mcpToolOutcome(profile, name, args);
    if (outcome.kind !== "success") {
      fail(failureCode, {
        status: outcome.status,
        applicationCode: safeCode(outcome.code),
        retryable: outcome.retryable,
      });
    }
    return outcome.data;
  }

  async assertCatalog(profile) {
    const response = await this.mcpRpc(profile, "tools/list", {});
    if (response.status !== 200 || !Array.isArray(response.envelope?.result?.tools)) {
      fail(`${profile}_tools_list_failed`, { status: response.status });
    }
    const names = new Set(response.envelope.result.tools.map((tool) => tool?.name));
    if (REQUIRED_TOOLS.some((name) => !names.has(name))) {
      fail(`${profile}_required_tool_missing`);
    }
  }

  async downloadExport(urlValue) {
    let url;
    try {
      url = new URL(urlValue);
    } catch {
      fail("invalid_export_download_url");
    }
    if (
      url.origin !== this.origin || url.username || url.password ||
      !/^\/api\/v1\/exports\/[^/]+$/u.test(url.pathname) || url.search || url.hash
    ) fail("invalid_export_download_url");
    const response = await this.request(url.pathname, { method: "GET" });
    if (response.status !== 200) fail("export_download_failed", { status: response.status });
    if (response.headers.get("content-type") !== "application/zip") {
      fail("export_download_media_type_mismatch");
    }
    if (response.headers.get("cache-control") !== "no-store") {
      fail("export_download_cache_policy_mismatch");
    }
    return Object.freeze({
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentLength: response.headers.get("content-length"),
    });
  }
}

function makeClient(state, credentials, fetchImpl, delay) {
  return new StorageUatClient({
    origin: state.prepared_lineage.live_url,
    credentials,
    fetchImpl,
    delay,
  });
}

function fixtureForState(state) {
  const fixture = createBrainMarkdownFixture();
  if (
    fixture.descriptor_sha256 !== state.fixture.descriptor_sha256 ||
    fixture.marker_sha256 !== state.fixture.marker_sha256 ||
    fixture.file_count !== state.fixture.file_count ||
    fixture.logical_bytes !== state.fixture.logical_bytes
  ) fail("fixture_state_mismatch");
  return fixture;
}

function sessionProjection(value) {
  if (!isRecord(value)) fail("invalid_import_session_projection");
  const state = required(value.state, "missing_import_session_state");
  if (!ACTIVE_IMPORT_STATES.has(state) && !TERMINAL_IMPORT_STATES.has(state)) {
    fail("invalid_import_session_state");
  }
  const numeric = (field) => positiveInteger(value[field] ?? 0, `invalid_${field}`, { min: 0 });
  return Object.freeze({
    import_id: required(value.import_id, "missing_import_id"),
    plan_id: required(value.plan_id, "missing_import_plan_id"),
    state,
    version: positiveInteger(value.version, "invalid_import_version"),
    checkpoint: numeric("checkpoint"),
    staged_file_count: numeric("staged_file_count"),
    staged_bytes: numeric("staged_bytes"),
    validation_checkpoint: numeric("validation_checkpoint"),
    validated_bytes: numeric("validated_bytes"),
    promotion_checkpoint: numeric("promotion_checkpoint"),
    promoted_bytes: numeric("promoted_bytes"),
    revision_id: value.revision_id === null || value.revision_id === undefined
      ? null
      : required(value.revision_id, "invalid_import_revision_id"),
  });
}

function importStateProjection(current, session) {
  return Object.freeze({
    ...(current ?? {}),
    import_id: session.import_id,
    plan_id: session.plan_id,
    session_state: session.state,
    version: session.version,
    checkpoint: session.checkpoint,
    staged_file_count: session.staged_file_count,
    staged_bytes: session.staged_bytes,
    validation_checkpoint: session.validation_checkpoint,
    validated_bytes: session.validated_bytes,
    promotion_checkpoint: session.promotion_checkpoint,
    promoted_bytes: session.promoted_bytes,
    committed_revision_id: session.revision_id,
  });
}

function assertPlanProjection(plan, fixture) {
  if (!isRecord(plan)) fail("invalid_import_plan_projection");
  if (plan.descriptor_hash !== fixture.descriptor_sha256) fail("import_descriptor_hash_mismatch");
  if (plan.file_count !== undefined && plan.file_count !== fixture.file_count) {
    fail("import_plan_file_count_mismatch");
  }
  if (plan.logical_bytes !== fixture.logical_bytes) fail("import_plan_byte_count_mismatch");
}

async function readImportStatus(client, state, fixture) {
  const importId = required(state.import?.import_id, "missing_import_id");
  const data = await client.api(`/api/v1/markdown-imports/${encodeURIComponent(importId)}`);
  assertPlanProjection(data.plan, fixture);
  return sessionProjection(data.session);
}

async function readOwnedMind(client, state, { allowMissing = false } = {}) {
  const path = `/api/v1/minds/${encodeURIComponent(state.mind.handle)}`;
  const response = await client.request(path, { headers: { accept: "application/json" } });
  const payload = await responseJson(response, "invalid_mind_projection");
  if (allowMissing && response.status === 404 && payload?.error?.code === "mind_not_found") {
    return null;
  }
  if (response.status !== 200 || payload?.ok !== true || !isRecord(payload.data)) {
    fail("run_owned_mind_unavailable", {
      status: response.status,
      applicationCode: safeCode(payload?.error?.code),
    });
  }
  const mind = payload.data;
  if (
    mind.handle !== state.mind.handle || mind.name !== state.mind.name ||
    mind.visibility !== "private" || mind.access?.role !== "owner"
  ) fail("run_owned_mind_identity_mismatch");
  return mind;
}

async function assertDedicatedToken(client, state, credentials, { allowRevoked = false } = {}) {
  assertCredentialOwnership(state, credentials);
  const data = await client.api("/api/v1/mcp-tokens");
  if (!Array.isArray(data.tokens)) fail("invalid_token_list_projection");
  const token = data.tokens.find((item) => item?.token_id === credentials.mcpTokenId);
  if (token === undefined) return null;
  if (token.name !== state.dedicated_token.name) fail("dedicated_token_name_mismatch");
  if (!allowRevoked && token.state !== "active") fail("dedicated_token_not_active");
  if (!allowRevoked && (!Array.isArray(token.scopes) || !token.scopes.includes("content:write"))) {
    fail("dedicated_token_write_scope_missing");
  }
  return token;
}

async function ensureSetup(statePath, state, credentials, fetchImpl, delay) {
  const client = makeClient(state, credentials, fetchImpl, delay);
  const session = await client.api("/api/v1/session");
  if (!isRecord(session.principal) || !isRecord(session.personal_mind)) {
    fail("active_registered_account_required");
  }
  await assertDedicatedToken(client, state, credentials);
  let mind;
  if (state.mind.initial_revision_id === null) {
    mind = await client.api("/api/v1/minds", {
      method: "POST",
      body: { name: state.mind.name, handle: state.mind.handle },
      idempotencyKey: `storage:${state.run_nonce}:mind:create`,
    });
    if (
      mind.handle !== state.mind.handle || mind.name !== state.mind.name ||
      mind.visibility !== "private" || mind.access?.role !== "owner"
    ) fail("run_owned_mind_create_mismatch");
  } else {
    mind = await readOwnedMind(client, state);
  }
  const initialRevisionId = required(mind.head?.revision_id, "missing_initial_revision_id");
  if (
    state.mind.initial_revision_id !== null &&
    state.mind.initial_revision_id !== initialRevisionId
  ) fail("run_owned_mind_head_changed_before_import");

  const bindings = await client.mcpTool("modern", "get_mind_bindings");
  const alreadyBound =
    bindings.write_binding?.mind?.route === `/${state.mind.handle}` &&
    bindings.write_binding?.state === "active" &&
    bindings.write_binding?.availability === "available";
  if (!alreadyBound) {
    if (
      bindings.binding_version !== 0 || bindings.write_binding !== null ||
      !Array.isArray(bindings.read_bindings) || bindings.read_bindings.length !== 0 ||
      bindings.automatic_capture?.mode !== "disabled"
    ) fail("dedicated_token_bindings_not_pristine");
    const bound = await client.api(
      `/api/v1/mind-bindings/${encodeURIComponent(credentials.mcpTokenId)}`,
      {
        method: "PATCH",
        body: {
          action: "bind_write",
          mind_ref: `/${state.mind.handle}`,
          expected_binding_version: 0,
        },
        idempotencyKey: `storage:${state.run_nonce}:bind`,
      },
    );
    if (bound.binding_version !== 1) fail("dedicated_token_binding_failed");
    const readBack = await client.mcpTool("modern", "get_mind_bindings");
    if (
      readBack.binding_version !== 1 ||
      readBack.write_binding?.mind?.route !== `/${state.mind.handle}` ||
      readBack.write_binding?.state !== "active" ||
      readBack.write_binding?.availability !== "available"
    ) {
      fail("dedicated_token_secret_id_mismatch");
    }
  } else if (
    !Array.isArray(bindings.read_bindings) || bindings.read_bindings.length !== 0 ||
    bindings.automatic_capture?.mode !== "disabled"
  ) fail("dedicated_token_binding_state_changed");

  const next = {
    ...withoutStateDigest(state),
    status: "setup_complete",
    mind: { ...state.mind, initial_revision_id: initialRevisionId },
  };
  await writePrivateState(statePath, next);
  return readPrivateState(statePath);
}

async function setup(options, dependencies) {
  const candidate = candidateSha(required(options.candidate_sha, "missing_candidate_sha"));
  const nonce = runNonce(required(options.nonce, "missing_run_nonce"));
  const statePath = safeLocalPath(required(options.state_out, "missing_state_out"));
  const lineage = await readLineage(required(options.lineage, "missing_lineage"));
  if (lineage.candidate_sha !== candidate) fail("lineage_candidate_mismatch");
  const fixture = createBrainMarkdownFixture();
  const credentials = loadCredentialEnvironment(dependencies.environment);
  const prepared = {
    schema: STORAGE_MATRIX_STATE_SCHEMA,
    status: "prepared",
    run_nonce: nonce,
    candidate_sha: candidate,
    prepared_lineage: lineage,
    observed_lineage: null,
    fixture: fixtureStateProjection(fixture),
    dedicated_token: {
      name: `UAT Storage Matrix ${nonce}`,
      id_fingerprint: tokenIdFingerprint(credentials.mcpTokenId),
    },
    mind: {
      handle: `uat-storage-${nonce}`,
      name: `UAT Storage Matrix ${nonce}`,
      initial_revision_id: null,
    },
    import: null,
    verification: null,
  };
  await writePrivateState(statePath, prepared, { exclusive: true });
  const state = await readPrivateState(statePath);
  const completed = await ensureSetup(
    statePath,
    state,
    credentials,
    dependencies.fetchImpl,
    dependencies.delay,
  );
  return Object.freeze({ status: completed.status, next_phase: "start", state_path: statePath });
}

async function createOrRecoverImport(client, statePath, state, fixture, batches) {
  let current = state;
  let importState = current.import;
  if (importState === null || importState.plan_id === null) {
    const mind = await readOwnedMind(client, current);
    if (mind.head?.revision_id !== current.mind.initial_revision_id) {
      fail("run_owned_mind_head_changed_before_import");
    }
    const data = await client.api(
      `/api/v1/minds/${encodeURIComponent(current.mind.handle)}/markdown-import-plans`,
      {
        method: "POST",
        body: {
          expected_revision_id: current.mind.initial_revision_id,
          files: fixture.descriptors,
        },
        idempotencyKey: `storage:${current.run_nonce}:import:plan`,
      },
    );
    if (!isRecord(data.plan)) fail("invalid_import_plan_projection");
    if (data.plan.descriptor_hash !== fixture.descriptor_sha256) {
      fail("import_descriptor_hash_mismatch");
    }
    if (data.plan.logical_bytes !== fixture.logical_bytes) {
      fail("import_plan_byte_count_mismatch");
    }
    importState = {
      plan_id: required(data.plan.plan_id, "missing_import_plan_id"),
      import_id: null,
      descriptor_hash: data.plan.descriptor_hash,
      logical_bytes: fixture.logical_bytes,
      file_count: fixture.file_count,
      total_batches: batches.length,
      interrupt_after_batches: current.import?.interrupt_after_batches ?? null,
      interrupted_checkpoint: null,
      session_state: null,
      version: null,
      checkpoint: 0,
      staged_file_count: 0,
      staged_bytes: 0,
      validation_checkpoint: 0,
      validated_bytes: 0,
      promotion_checkpoint: 0,
      promoted_bytes: 0,
      committed_revision_id: null,
      export_job_id: null,
    };
    current = await saveState(statePath, {
      ...current,
      status: "setup_complete",
      import: importState,
    });
  }
  if (importState.import_id === null) {
    const data = await client.api(
      `/api/v1/minds/${encodeURIComponent(current.mind.handle)}/markdown-imports`,
      {
        method: "POST",
        body: { plan_id: importState.plan_id },
        idempotencyKey: `storage:${current.run_nonce}:import:start`,
      },
    );
    const session = sessionProjection(data.session);
    if (session.plan_id !== importState.plan_id) fail("import_session_plan_mismatch");
    importState = importStateProjection(importState, session);
    current = await saveState(statePath, {
      ...current,
      status: "import_started",
      import: importState,
    });
  } else {
    const session = await readImportStatus(client, current, fixture);
    importState = importStateProjection(importState, session);
    current = await saveState(statePath, { ...current, import: importState });
  }
  return current;
}

async function stageBatch(client, state, fixtureBatch, checkpoint) {
  const form = new FormData();
  const manifest = {
    expected_version: state.import.version,
    files: fixtureBatch.map((file, index) => ({
      field: `file_${index}`,
      path: file.path,
      sha256: file.sha256,
      size: file.size,
    })),
  };
  form.append("manifest", JSON.stringify(manifest));
  for (let index = 0; index < fixtureBatch.length; index += 1) {
    const file = fixtureBatch[index];
    form.append(
      `file_${index}`,
      new Blob([file.bytes], { type: "text/markdown; charset=utf-8" }),
      `fixture-${String(index).padStart(3, "0")}.md`,
    );
  }
  const data = await client.api(
    `/api/v1/markdown-imports/${encodeURIComponent(state.import.import_id)}/batches/${checkpoint}`,
    { method: "PUT", body: form },
  );
  return sessionProjection(data.session);
}

async function start(options, dependencies) {
  const statePath = safeLocalPath(required(options.state, "missing_state"));
  let state = await readPrivateState(statePath);
  const lineage = await readLineage(required(options.lineage, "missing_lineage"));
  samePreparedLineage(state, lineage);
  if (!new Set(["setup_complete", "import_started"]).has(state.status)) {
    fail("invalid_start_state");
  }
  const credentials = loadCredentialEnvironment(dependencies.environment);
  assertCredentialOwnership(state, credentials);
  const fixture = fixtureForState(state);
  const batches = createImportBatches(fixture.files);
  const interruptAfter = options.interrupt_after_batches ?? state.import?.interrupt_after_batches ?? 1;
  if (interruptAfter < 1 || interruptAfter >= batches.length) {
    fail("invalid_interrupt_batch_count");
  }
  if (
    state.import?.interrupt_after_batches !== null &&
    state.import?.interrupt_after_batches !== undefined &&
    state.import.interrupt_after_batches !== interruptAfter
  ) fail("interrupt_batch_count_changed");
  const client = makeClient(state, credentials, dependencies.fetchImpl, dependencies.delay);
  state = await createOrRecoverImport(client, statePath, state, fixture, batches);
  state = await saveState(statePath, {
    ...state,
    import: { ...state.import, interrupt_after_batches: interruptAfter },
  });
  if (state.import.session_state !== "active") fail("import_not_active_before_interrupt");
  if (state.import.checkpoint > interruptAfter) fail("import_checkpoint_past_interrupt_boundary");
  for (let checkpoint = state.import.checkpoint + 1; checkpoint <= interruptAfter; checkpoint += 1) {
    const session = await stageBatch(client, state, batches[checkpoint - 1], checkpoint);
    state = await saveState(statePath, {
      ...state,
      status: "import_started",
      import: importStateProjection(state.import, session),
    });
  }
  if (
    state.import.checkpoint !== interruptAfter ||
    state.import.staged_file_count <= 0 ||
    state.import.staged_file_count >= fixture.file_count
  ) fail("interrupt_checkpoint_not_bounded");
  return Object.freeze({
    status: "import_started",
    next_phase: "interrupt",
    checkpoint: state.import.checkpoint,
    total_batches: batches.length,
    state_path: statePath,
  });
}

async function interrupt(options, dependencies) {
  const statePath = safeLocalPath(required(options.state, "missing_state"));
  let state = await readPrivateState(statePath);
  const lineage = await readLineage(required(options.lineage, "missing_lineage"));
  samePreparedLineage(state, lineage);
  if (state.status !== "import_started") fail("invalid_interrupt_state");
  const credentials = loadCredentialEnvironment(dependencies.environment);
  assertCredentialOwnership(state, credentials);
  const fixture = fixtureForState(state);
  const client = makeClient(state, credentials, dependencies.fetchImpl, dependencies.delay);
  const session = await readImportStatus(client, state, fixture);
  const batches = createImportBatches(fixture.files);
  if (
    session.state !== "active" || session.checkpoint < 1 ||
    session.checkpoint >= batches.length ||
    session.checkpoint !== state.import.interrupt_after_batches
  ) fail("invalid_interrupt_checkpoint");
  state = await saveState(statePath, {
    ...state,
    status: "awaiting_redeploy",
    import: {
      ...importStateProjection(state.import, session),
      interrupted_checkpoint: session.checkpoint,
    },
  });
  return Object.freeze({
    status: state.status,
    next_phase: "redeploy_then_verify",
    checkpoint: state.import.interrupted_checkpoint,
    state_path: statePath,
  });
}

async function pollSearch(client, profile, args, timeoutMs, delay) {
  const started = Date.now();
  while (true) {
    const outcome = await client.mcpToolOutcome(profile, "search", args);
    if (outcome.kind === "success") return outcome.data;
    if (
      outcome.code !== "search_index_unavailable" ||
      !outcome.retryable || Date.now() - started >= timeoutMs
    ) {
      fail(`${profile}_search_failed`, {
        status: outcome.status,
        applicationCode: safeCode(outcome.code),
        retryable: outcome.retryable,
      });
    }
    await delay(1_000);
  }
}

async function verifySearchFetch(client, profile, state, fixture, revisionId, timeoutMs, delay) {
  const search = await pollSearch(client, profile, {
    mind: `/${state.mind.handle}`,
    revision_selector: { kind: "revision", revision_id: revisionId },
    query: BRAIN_FIXTURE_MARKER,
    limit: 10,
  }, timeoutMs, delay);
  if (
    search.resolved_revision?.revision_id !== revisionId ||
    search.index_status !== "ready" || !Array.isArray(search.results)
  ) fail(`${profile}_search_projection_invalid`);
  const result = search.results.find((item) => item?.entry?.path === BRAIN_FIXTURE_MARKER_PATH);
  if (
    result?.entry?.revision_id !== revisionId ||
    result.entry.sha256 !== fixture.marker_sha256 ||
    typeof result.entry.entry_id !== "string"
  ) fail(`${profile}_search_exact_result_missing`);
  const fetchedData = await client.mcpTool(profile, "fetch", { id: result.entry.entry_id });
  const fetched = isRecord(fetchedData.fetched) ? fetchedData.fetched : fetchedData;
  if (
    fetched.entry?.revision_id !== revisionId ||
    fetched.entry?.sha256 !== fixture.marker_sha256 ||
    fetched.entry?.path !== BRAIN_FIXTURE_MARKER_PATH ||
    fetched.truncated !== false || typeof fetched.text !== "string" ||
    !fetched.text.includes(BRAIN_FIXTURE_MARKER) ||
    sha256(new TextEncoder().encode(fetched.text)) !== fixture.marker_sha256
  ) fail(`${profile}_fetch_sha_mismatch`);
  return fixture.marker_sha256;
}

async function ensureExportJob(client, statePath, state, revisionId) {
  let current = state;
  if (current.import.export_job_id === null) {
    const started = await client.mcpTool("modern", "start_export", {
      mind: `/${current.mind.handle}`,
      revision_selector: { kind: "revision", revision_id: revisionId },
      profile: "MD-OKF-ZIP-1",
      idempotency_key: `storage:${current.run_nonce}:export`,
    });
    if (
      started.job?.status !== "queued" ||
      started.job?.revision_id !== revisionId ||
      typeof started.job?.job_id !== "string"
    ) fail("export_start_projection_invalid");
    current = await saveState(statePath, {
      ...current,
      import: { ...current.import, export_job_id: started.job.job_id },
    });
  }
  return current;
}

async function pollExport(client, jobId, revisionId, timeoutMs, delay) {
  const started = Date.now();
  while (true) {
    const data = await client.mcpTool("compat", "get_export_status", { job_id: jobId });
    const job = data.job;
    if (!isRecord(job) || job.revision_id !== revisionId) fail("export_status_revision_mismatch");
    if (job.status === "succeeded") return job;
    if (job.status === "failed" || job.status === "expired") {
      fail("export_terminal_failure", { applicationCode: safeCode(job.last_failure_code) });
    }
    if (!new Set(["queued", "running"]).has(job.status)) fail("invalid_export_status");
    if (Date.now() - started >= timeoutMs) fail("export_poll_timeout");
    await delay(1_000);
  }
}

async function completeVerification(statePath, state, client, fixture, timeoutMs, delay) {
  let current = state;
  let session = await readImportStatus(client, current, fixture);
  current = await saveState(statePath, {
    ...current,
    import: importStateProjection(current.import, session),
  });
  const batches = createImportBatches(fixture.files);
  if (session.checkpoint < current.import.interrupted_checkpoint) {
    fail("import_checkpoint_lost_after_redeploy");
  }
  while (session.state === "active" && session.checkpoint < batches.length) {
    const checkpoint = session.checkpoint + 1;
    session = await stageBatch(client, current, batches[checkpoint - 1], checkpoint);
    current = await saveState(statePath, {
      ...current,
      import: importStateProjection(current.import, session),
    });
  }
  if (session.checkpoint !== batches.length || session.staged_file_count !== fixture.file_count) {
    fail("import_staging_incomplete");
  }
  let validationCalls = 0;
  while (session.state === "active" || session.state === "validating") {
    validationCalls += 1;
    if (validationCalls > 100) fail("import_validation_did_not_converge");
    const data = await client.api(
      `/api/v1/markdown-imports/${encodeURIComponent(session.import_id)}/validate`,
      { method: "POST", body: { expected_version: session.version } },
    );
    session = sessionProjection(data.session);
    current = await saveState(statePath, {
      ...current,
      import: importStateProjection(current.import, session),
    });
  }
  if (
    session.state !== "validated" ||
    session.validation_checkpoint !== fixture.file_count ||
    session.validated_bytes !== fixture.logical_bytes
  ) fail("import_validation_incomplete");
  let promotionCalls = 0;
  let committedRevisionId = null;
  while (session.state === "validated" || session.state === "finalizing") {
    promotionCalls += 1;
    if (promotionCalls > 100) fail("import_promotion_did_not_converge");
    const data = await client.api(
      `/api/v1/markdown-imports/${encodeURIComponent(session.import_id)}/commit`,
      {
        method: "POST",
        body: {
          expected_version: session.version,
          summary: "MD-288 deterministic Brain-scale storage matrix",
        },
      },
    );
    if (isRecord(data.session)) {
      session = sessionProjection(data.session);
      current = await saveState(statePath, {
        ...current,
        import: importStateProjection(current.import, session),
      });
    } else {
      committedRevisionId = required(data.revision_id, "missing_committed_revision_id");
      break;
    }
  }
  session = await readImportStatus(client, current, fixture);
  if (
    session.state !== "committed" || session.revision_id === null ||
    (committedRevisionId !== null && committedRevisionId !== session.revision_id) ||
    session.promotion_checkpoint !== fixture.file_count ||
    session.promoted_bytes !== fixture.logical_bytes
  ) fail("import_commit_readback_failed");
  const revisionId = session.revision_id;
  current = await saveState(statePath, {
    ...current,
    import: importStateProjection(current.import, session),
  });

  await client.assertCatalog("modern");
  await client.assertCatalog("compat");
  for (const profile of ["modern", "compat"]) {
    const revision = await client.mcpTool(profile, "get_revision", {
      mind: `/${current.mind.handle}`,
      revision_id: revisionId,
    });
    if (
      revision.revision?.revision_id !== revisionId ||
      revision.manifest_summary?.file_count !== fixture.file_count ||
      revision.manifest_summary?.total_bytes !== fixture.logical_bytes
    ) fail(`${profile}_revision_manifest_readback_failed`);
  }
  const modernFetchSha = await verifySearchFetch(
    client,
    "modern",
    current,
    fixture,
    revisionId,
    timeoutMs,
    delay,
  );
  const compatFetchSha = await verifySearchFetch(
    client,
    "compat",
    current,
    fixture,
    revisionId,
    timeoutMs,
    delay,
  );

  current = await ensureExportJob(client, statePath, current, revisionId);
  const exportJob = await pollExport(
    client,
    current.import.export_job_id,
    revisionId,
    timeoutMs,
    delay,
  );
  if (
    exportJob.archive_format !== "MD-OKF-ZIP-1" ||
    exportJob.media_type !== "application/zip" ||
    typeof exportJob.download_url !== "string" ||
    typeof exportJob.download_expires_at !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(String(exportJob.sha256 ?? "")) ||
    !Number.isSafeInteger(exportJob.size) || exportJob.size < 1
  ) fail("export_succeeded_projection_invalid");
  const downloaded = await client.downloadExport(exportJob.download_url);
  if (
    downloaded.bytes.byteLength !== exportJob.size ||
    sha256(downloaded.bytes) !== exportJob.sha256 ||
    downloaded.contentLength !== String(exportJob.size)
  ) fail("export_download_sha_mismatch");
  const archive = inspectDeterministicStoredZip(downloaded.bytes, fixture);
  if (
    archive.archive_sha256 !== exportJob.sha256 ||
    archive.entry_count !== fixture.file_count ||
    archive.content_bytes !== fixture.logical_bytes
  ) fail("export_snapshot_readback_mismatch");

  current = await saveState(statePath, {
    ...current,
    status: "verified",
    verification: {
      committed_file_count: fixture.file_count,
      committed_logical_bytes: fixture.logical_bytes,
      modern_fetch_sha256: modernFetchSha,
      compat_fetch_sha256: compatFetchSha,
      archive_sha256: archive.archive_sha256,
      archive_size: archive.archive_size,
      export_entry_count: archive.entry_count,
      export_content_bytes: archive.content_bytes,
    },
  });
  return current;
}

async function verify(options, dependencies) {
  const statePath = safeLocalPath(required(options.state, "missing_state"));
  let state = await readPrivateState(statePath);
  if (!new Set(["awaiting_redeploy", "verifying", "verified"]).has(state.status)) {
    fail("invalid_verify_state");
  }
  const observed = await readLineage(required(options.lineage, "missing_lineage"));
  assertLineageTransition(state.prepared_lineage, observed);
  if (
    state.observed_lineage !== null &&
    (
      state.observed_lineage.candidate_sha !== observed.candidate_sha ||
      state.observed_lineage.site_project_id !== observed.site_project_id ||
      state.observed_lineage.site_version_id !== observed.site_version_id ||
      state.observed_lineage.deployment_id !== observed.deployment_id ||
      state.observed_lineage.live_url !== observed.live_url
    )
  ) fail("observed_lineage_changed");
  const credentials = loadCredentialEnvironment(dependencies.environment);
  assertCredentialOwnership(state, credentials);
  const fixture = fixtureForState(state);
  state = await saveState(statePath, {
    ...state,
    status: state.status === "verified" ? "verified" : "verifying",
    observed_lineage: observed,
  });
  if (state.status !== "verified") {
    const client = makeClient(state, credentials, dependencies.fetchImpl, dependencies.delay);
    state = await completeVerification(
      statePath,
      state,
      client,
      fixture,
      options.poll_timeout_ms ?? 600_000,
      dependencies.delay,
    );
  }
  return Object.freeze({
    status: "verified_cleanup_pending",
    next_phase: "cleanup",
    state_path: statePath,
  });
}

async function cancelImportIfNeeded(client, statePath, state, fixture) {
  if (state.import?.import_id === null || state.import?.import_id === undefined) return state;
  let session;
  try {
    session = await readImportStatus(client, state, fixture);
  } catch (error) {
    if (
      error instanceof StorageMatrixFailure &&
      error.code === "api_request_failed" &&
      error.details.applicationCode === "import_session_not_found"
    ) return state;
    throw error;
  }
  let current = await saveState(statePath, {
    ...state,
    import: importStateProjection(state.import, session),
  });
  if (!ACTIVE_IMPORT_STATES.has(session.state)) return current;
  const data = await client.api(
    `/api/v1/markdown-imports/${encodeURIComponent(session.import_id)}`,
    { method: "DELETE", body: { expected_version: session.version } },
  );
  const canceled = sessionProjection(data.session);
  if (canceled.state !== "canceled") fail("import_cancel_failed");
  current = await saveState(statePath, {
    ...current,
    import: importStateProjection(current.import, canceled),
  });
  return current;
}

async function writeTerminalEvidenceReceipt(statePath, state, evidenceOut) {
  if (!isRecord(state.verification)) fail("verification_or_cleanup_incomplete");
  if (state.observed_lineage === null) fail("missing_observed_lineage");
  const evidencePath = safeLocalPath(required(evidenceOut, "missing_evidence_out"));
  if (evidencePath === statePath) fail("evidence_path_conflicts_with_state");
  const evidence = createStorageMatrixEvidence({
    state,
    observedLineage: state.observed_lineage,
    completedAt: state.cleanup_completed_at_utc,
  });
  await writePrivateJson(evidencePath, evidence);
  if (state.status !== "cleaned") {
    await saveState(statePath, { ...state, status: "cleaned" });
  }
  return Object.freeze({
    status: "cleaned",
    evidence_path: evidencePath,
    artifact_sha256: evidence.artifact_sha256,
    state_path: statePath,
  });
}

async function cleanup(options, dependencies) {
  const statePath = safeLocalPath(required(options.state, "missing_state"));
  let state = await readPrivateState(statePath);
  if (state.status === "cleaned_evidence_pending") {
    return writeTerminalEvidenceReceipt(statePath, state, options.evidence_out);
  }
  if (state.status === "cleaned") {
    if (state.verification !== null && options.evidence_out !== undefined) {
      return writeTerminalEvidenceReceipt(statePath, state, options.evidence_out);
    }
    return Object.freeze({ status: "cleaned", state_path: statePath });
  }
  if (state.verification !== null) {
    if (state.observed_lineage === null) fail("missing_observed_lineage");
    safeLocalPath(required(options.evidence_out, "missing_evidence_out"));
  }
  const credentials = loadCredentialEnvironment(dependencies.environment);
  assertCredentialOwnership(state, credentials);
  const fixture = fixtureForState(state);
  state = await saveState(statePath, { ...state, status: "cleanup_pending" });
  const client = makeClient(state, credentials, dependencies.fetchImpl, dependencies.delay);
  state = await cancelImportIfNeeded(client, statePath, state, fixture);

  const mind = await readOwnedMind(client, state, { allowMissing: true });
  if (mind !== null) {
    const impact = await client.api(
      `/api/v1/minds/${encodeURIComponent(state.mind.handle)}/deletion-impact`,
    );
    if (
      impact.mind?.route !== `/${state.mind.handle}` ||
      impact.mind?.name !== state.mind.name ||
      impact.confirmation !== `delete-mind:${state.mind.handle}` ||
      impact.irreversible !== true
    ) fail("run_owned_mind_deletion_impact_mismatch");
    await client.api(`/api/v1/minds/${encodeURIComponent(state.mind.handle)}`, {
      method: "DELETE",
      body: { impact_id: impact.impact_id, confirmation: impact.confirmation },
      idempotencyKey: `storage:${state.run_nonce}:mind:delete`,
    });
  }
  if (await readOwnedMind(client, state, { allowMissing: true }) !== null) {
    fail("run_owned_mind_cleanup_failed");
  }

  const token = await assertDedicatedToken(client, state, credentials, { allowRevoked: true });
  if (token !== null && token.state !== "revoked") {
    const data = await client.api(
      `/api/v1/mcp-tokens/${encodeURIComponent(credentials.mcpTokenId)}`,
      {
        method: "DELETE",
        idempotencyKey: `storage:${state.run_nonce}:token:revoke`,
      },
    );
    if (data.token?.state !== "revoked") fail("dedicated_token_revoke_failed");
  }
  const denied = await client.mcpRequest("modern", client.modernBody("tools/list", {}));
  if (denied.status !== 401) fail("dedicated_token_revoke_not_effective", { status: denied.status });

  state = await saveState(statePath, {
    ...state,
    status: state.verification === null ? "cleaned" : "cleaned_evidence_pending",
    cleanup_completed_at_utc: state.cleanup_completed_at_utc ?? new Date().toISOString(),
  });
  if (state.verification !== null) {
    return writeTerminalEvidenceReceipt(statePath, state, options.evidence_out);
  }
  return Object.freeze({
    status: "cleaned",
    state_path: statePath,
  });
}

export function recoveryNextPhase(state) {
  switch (state.status) {
    case "cleaned": return null;
    case "verified":
    case "cleanup_pending":
    case "cleaned_evidence_pending": return "cleanup";
    case "awaiting_redeploy":
    case "verifying": return "verify";
    case "import_started": {
      const checkpoint = state.import?.checkpoint;
      const interruptAfter = state.import?.interrupt_after_batches;
      return Number.isSafeInteger(checkpoint) && Number.isSafeInteger(interruptAfter) &&
          checkpoint >= interruptAfter
        ? "interrupt"
        : "start";
    }
    case "prepared":
    case "setup_complete": return "start";
    default: fail("unsupported_recovery_state");
  }
}

async function recover(options, dependencies) {
  const statePath = safeLocalPath(required(options.state, "missing_state"));
  let state = await readPrivateState(statePath);
  if (state.status === "cleaned") {
    return Object.freeze({ status: state.status, next_phase: null, state_path: statePath });
  }
  if (state.status === "cleaned_evidence_pending") {
    return Object.freeze({ status: state.status, next_phase: "cleanup", state_path: statePath });
  }
  const credentials = loadCredentialEnvironment(dependencies.environment);
  assertCredentialOwnership(state, credentials);
  if (state.status === "prepared") {
    state = await ensureSetup(
      statePath,
      state,
      credentials,
      dependencies.fetchImpl,
      dependencies.delay,
    );
    return Object.freeze({ status: state.status, next_phase: "start", state_path: statePath });
  }
  if (state.status === "setup_complete" && state.import === null) {
    return Object.freeze({ status: state.status, next_phase: "start", state_path: statePath });
  }
  if (state.status === "verified" || state.status === "cleanup_pending") {
    return Object.freeze({ status: state.status, next_phase: "cleanup", state_path: statePath });
  }
  const client = makeClient(state, credentials, dependencies.fetchImpl, dependencies.delay);
  const fixture = fixtureForState(state);
  if (state.import?.import_id !== null && state.import?.import_id !== undefined) {
    const session = await readImportStatus(client, state, fixture);
    state = await saveState(statePath, {
      ...state,
      import: importStateProjection(state.import, session),
    });
    if (session.state === "committed" && state.status !== "verified") {
      state = await saveState(statePath, { ...state, status: "verifying" });
      return Object.freeze({ status: state.status, next_phase: "verify", state_path: statePath });
    }
  }
  const nextPhase = recoveryNextPhase(state);
  return Object.freeze({ status: state.status, next_phase: nextPhase, state_path: statePath });
}

export async function run(options, {
  environment = process.env,
  fetchImpl = globalThis.fetch,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (typeof fetchImpl !== "function") fail("fetch_unavailable");
  const dependencies = { environment, fetchImpl, delay };
  switch (options.phase) {
    case "setup": return setup(options, dependencies);
    case "start": return start(options, dependencies);
    case "interrupt": return interrupt(options, dependencies);
    case "verify": return verify(options, dependencies);
    case "cleanup": return cleanup(options, dependencies);
    case "recover": return recover(options, dependencies);
    default: fail("invalid_phase");
  }
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  try {
    const result = await run(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    if (error instanceof StorageMatrixFailure) {
      process.stderr.write(`${JSON.stringify({
        status: "failed",
        code: error.code,
        ...(Object.keys(error.details).length === 0 ? {} : { details: error.details }),
      })}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${JSON.stringify({ status: "failed", code: "unexpected_failure" })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}

export {
  BRAIN_FIXTURE_FILE_COUNT,
  BRAIN_FIXTURE_LOGICAL_BYTES,
  requireMcpData,
};
