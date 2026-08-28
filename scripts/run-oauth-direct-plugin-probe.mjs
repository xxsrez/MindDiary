#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createSitesMetadataStore } from "../packages/adapter-metadata-sites/dist/index.js";
import { createProductSiteRuntime } from "../packages/composition-root/dist/index.js";
import {
  MultiPrincipalActorClient,
  ProbeFailure,
  assertRedactedDocument,
  canonical,
  candidateSha,
  digest,
  fail,
  isRecord,
  safeCode,
} from "./lib/multi-principal-probe-core.mjs";
import {
  FakeD1Database,
  FakeR2Bucket,
  deterministicKey,
} from "./lib/fake-sites-storage.mjs";
import {
  matchesExactMcpToolInventory,
  matchesExactReadOnlyMcpToolInventory,
} from "./lib/exact-mcp-tool-inventory.mjs";
import { assertNoSyntheticProductAuthority } from "./lib/synthetic-product-negative.mjs";

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_MARKETPLACE_ROOT = resolve(ROOT, "..", "Srez Marketplace");
const ORIGIN = "https://oauth-gate.invalid";
const RESOURCE = `${ORIGIN}/api/mcp`;
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const EVIDENCE_SCHEMA = "mind-diary/oauth-direct-plugin-evidence/v1";
const BINDING_NAMESPACE = "synthetic-test";
const CLIENT = "codex-cli";
const CLIENT_VERSION = "0.150.1";
const CODEX_SKILL_DISCOVERY_PROMPT =
  "Check whether the installed Mind Diary skill is available. Do not call tools.";
const MAX_CODEX_PROMPT_INPUT_BYTES = 2 * 1024 * 1024;
const MODERN_PROTOCOL = "2026-07-28";
const COMPAT_PROTOCOL = "2025-11-25";
export const CODEX_PLUGIN_MCP_URL =
  "https://mind-diary.example.invalid/api/mcp/2025-11-25";
export const CODEX_PLUGIN_OAUTH_RESOURCE =
  "https://mind-diary.example.invalid/api/mcp";

export const OAUTH_DIRECT_PLUGIN_ASSERTION_IDS = Object.freeze([
  "package.marketplace-head-tree-clean",
  "package.snapshot-content-digest",
  "package.catalog-available-on-use",
  "package.direct-resource-exact",
  "package.no-app-or-private-app",
  "package.fresh-context-discovery-before-install",
  "package.install-before-oauth",
  "package.skill-discovery",
  "package.automatic-capture-skill-policy",
  "package.mcp-resolution",
  "package.task-manager-separate",
  "oauth.codex-compatible-write-binding-schema",
  "oauth.catalog-modern-exact-18",
  "oauth.catalog-compat-exact-18",
  "oauth.protected-resource-discovery",
  "oauth.authorization-server-discovery",
  "oauth.public-dcr-no-secret",
  "oauth.dcr-negative-client-policy",
  "oauth.redirect-resource-pkce-negative",
  "oauth.pending-wrong-identity-denied",
  "oauth.explicit-deny-state-preserved",
  "oauth.bad-verifier-code-replay-denied",
  "oauth.authorization-code-expiry",
  "oauth.read-grant-modern-runtime",
  "oauth.read-grant-compat-runtime",
  "oauth.read-grant-write-challenge",
  "oauth.access-token-expiry",
  "oauth.refresh-rotation",
  "oauth.refresh-concurrent-reuse-tolerated",
  "oauth.refresh-late-reuse-revokes-family",
  "oauth.rfc7009-revoke-next-request",
  "oauth.write-step-up",
  "oauth.authorization-mirror-active",
  "oauth.current-acl-readback",
  "oauth.explicit-write-binding-readback",
  "oauth.refresh-preserves-write-binding",
  "oauth.connection-safe-projection",
  "oauth.connection-stale-cas",
  "oauth.product-runtime-commit",
  "oauth.product-runtime-idempotent-replay",
  "oauth.product-runtime-stale-cas",
  "oauth.connected-app-mirror-revoke",
  "oauth.connected-app-binding-revoke",
  "oauth.reconnect-new-grant",
  "oauth.reconnect-empty-binding-generation",
  "personal-token.modern-regression",
  "personal-token.compat-regression",
  "production-negative.no-synthetic-authority",
  "evidence.external-ui-canary-separated",
]);

export function assertDirectPackageServer(server) {
  if (
    server?.type !== "http" ||
    server?.url !== CODEX_PLUGIN_MCP_URL ||
    server?.oauth_resource !== CODEX_PLUGIN_OAUTH_RESOURCE
  ) fail("direct_resource_mismatch");
  return true;
}

export function assertCodexCompatibleWriteBindingSchema(tools) {
  if (!matchesExactMcpToolInventory(tools)) {
    fail("codex_write_binding_schema_incompatible", {
      toolCount: Array.isArray(tools) ? tools.length : null,
      toolNames: Array.isArray(tools)
        ? tools.map((tool) => typeof tool?.name === "string" ? tool.name : "invalid")
        : [],
    });
  }
  return true;
}

export function assertCodexCompatibleReadCatalog(tools) {
  if (!matchesExactReadOnlyMcpToolInventory(tools)) {
    fail("codex_read_catalog_incompatible", {
      toolCount: Array.isArray(tools) ? tools.length : null,
      toolNames: Array.isArray(tools)
        ? tools.map((tool) => typeof tool?.name === "string" ? tool.name : "invalid")
        : [],
    });
  }
  return true;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requiredString(value, code) {
  if (typeof value !== "string" || value.length === 0) fail(code);
  return value;
}

function safeJson(text, code) {
  try {
    const value = JSON.parse(text);
    if (!isRecord(value) && !Array.isArray(value)) fail(code);
    return value;
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    fail(code);
  }
}

function expectStatus(response, status, code) {
  if (response.status !== status) {
    fail(code, { status: response.status, responseCode: safeCode(response.body?.error) });
  }
  return response;
}

function passedTracker() {
  const passed = new Set();
  return Object.freeze({
    add(id) {
      if (!OAUTH_DIRECT_PLUGIN_ASSERTION_IDS.includes(id)) fail("unknown_assertion_id");
      passed.add(id);
    },
    values: passed,
  });
}

function assertReceiptSafe(value) {
  assertRedactedDocument(value);
  const text = JSON.stringify(value);
  for (const pattern of [
    /@[a-z0-9.-]+\.[a-z]{2,}/iu,
    /https?:\/\//iu,
    /mdo_(?:code|access|refresh)_/iu,
    /mdp_v1_/iu,
    /hmac-sha256:/iu,
    /(?:authorization|cookie|csrf|secret|verifier)["']?\s*:/iu,
  ]) {
    if (pattern.test(text)) fail("unsafe_oauth_evidence_document");
  }
  return value;
}

export function createEvidence({
  candidate,
  marketplace,
  startedAt,
  completedAt,
  passed,
}) {
  if (
    passed.size !== OAUTH_DIRECT_PLUGIN_ASSERTION_IDS.length ||
    OAUTH_DIRECT_PLUGIN_ASSERTION_IDS.some((id) => !passed.has(id))
  ) fail("incomplete_assertion_registry");
  const unsigned = Object.freeze({
    schema: EVIDENCE_SCHEMA,
    status: "passed",
    candidate_sha: candidateSha(candidate),
    marketplace_candidate_sha: candidateSha(marketplace.head),
    marketplace_tree_sha: candidateSha(marketplace.tree),
    plugin_version: requiredString(marketplace.pluginVersion, "missing_plugin_version"),
    plugin_snapshot_sha256: requiredString(
      marketplace.snapshotSha256,
      "missing_plugin_snapshot_sha256",
    ),
    client: CLIENT,
    client_version: CLIENT_VERSION,
    route: Object.freeze(["/api/mcp", "/api/mcp/2025-11-25"]),
    binding_namespace: BINDING_NAMESPACE,
    started_at: requiredString(startedAt, "missing_started_at"),
    completed_at: requiredString(completedAt, "missing_completed_at"),
    external_ui_canary: Object.freeze({
      status: "not-run",
      requirement: "informational",
      claim: "not-verified",
    }),
    assertions: Object.freeze(OAUTH_DIRECT_PLUGIN_ASSERTION_IDS.map((id) =>
      Object.freeze({ id, status: "passed" }))),
  });
  return assertReceiptSafe(Object.freeze({
    ...unsigned,
    artifact_sha256: digest(canonical(unsigned)),
  }));
}

export function assertAutomaticCaptureSkillPolicy(skill) {
  if (typeof skill !== "string") {
    fail("installed_automatic_capture_skill_policy_missing");
  }
  const normalized = skill.replace(/\s+/gu, " ");
  const required = [
    "## Automatic capture workflow",
    "automatic_capture.mode` is `routine_non_sensitive",
    "The Sites control plane is the only place that can enable or disable this",
    "Never call `capture_knowledge` for credentials or authentication material",
    "Treat `captured` as one new immutable revision and `no_op` as successful",
    "never move, replace, merge or retry the payload against a different target",
  ];
  if (required.some((fragment) => !normalized.includes(fragment))) {
    fail("installed_automatic_capture_skill_policy_missing");
  }
  return true;
}

async function git(root, args, options = {}) {
  const result = await execFileAsync("git", args, {
    cwd: root,
    encoding: options.binary ? null : "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout;
}

async function exactGitFile(root, revision, path) {
  return git(root, ["show", `${revision}:${path}`], { binary: true });
}

async function pluginFiles(root, revision) {
  const raw = await git(root, ["ls-tree", "-r", "-z", revision, "--", "plugins/mind-diary"], {
    binary: true,
  });
  const records = raw.toString("utf8").split("\0").filter(Boolean);
  const result = [];
  for (const record of records) {
    const match = /^(\d+) blob ([0-9a-f]{40})\t(.+)$/u.exec(record);
    if (!match) fail("unexpected_marketplace_tree_entry");
    const bytes = await git(root, ["cat-file", "blob", match[2]], { binary: true });
    result.push(Object.freeze({
      path: match[3].slice("plugins/mind-diary/".length),
      size: bytes.byteLength,
      sha256: `sha256:${sha256(bytes)}`,
    }));
  }
  return Object.freeze(result.sort((left, right) => left.path.localeCompare(right.path)));
}

async function directoryFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await directoryFiles(root, path));
    else if (entry.isFile()) {
      const bytes = await readFile(path);
      result.push(Object.freeze({
        path: relative(root, path).split(sep).join("/"),
        size: bytes.byteLength,
        sha256: `sha256:${sha256(bytes)}`,
      }));
    } else fail("unsupported_installed_plugin_entry");
  }
  return result;
}

export async function assertMarketplaceCheckoutAvailable(
  marketplaceRoot,
  { statImpl = stat } = {},
) {
  if (typeof marketplaceRoot !== "string" || marketplaceRoot.length === 0) {
    fail("marketplace_checkout_unavailable");
  }
  try {
    const value = await statImpl(marketplaceRoot);
    if (!value?.isDirectory()) fail("marketplace_checkout_unavailable");
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    fail("marketplace_checkout_unavailable");
  }
  return true;
}

async function inspectMarketplace(marketplaceRoot) {
  await assertMarketplaceCheckoutAvailable(marketplaceRoot);
  let status;
  try {
    status = String(await git(
      marketplaceRoot,
      ["status", "--porcelain", "--untracked-files=all"],
    ));
  } catch {
    fail("marketplace_checkout_unavailable");
  }
  if (status.trim() !== "") fail("marketplace_worktree_not_clean");
  const head = String(await git(marketplaceRoot, ["rev-parse", "HEAD"])).trim();
  const tree = String(await git(marketplaceRoot, ["rev-parse", "HEAD^{tree}"])).trim();
  const files = await pluginFiles(marketplaceRoot, head);
  const catalog = safeJson(
    (await exactGitFile(marketplaceRoot, head, ".agents/plugins/marketplace.json")).toString("utf8"),
    "invalid_marketplace_manifest",
  );
  const pluginJson = safeJson(
    (await exactGitFile(marketplaceRoot, head, "plugins/mind-diary/.codex-plugin/plugin.json"))
      .toString("utf8"),
    "invalid_plugin_manifest",
  );
  const mcpJson = safeJson(
    (await exactGitFile(marketplaceRoot, head, "plugins/mind-diary/.mcp.json")).toString("utf8"),
    "invalid_plugin_mcp_config",
  );
  const entry = catalog.plugins?.find((candidate) => candidate?.name === "mind-diary");
  if (!isRecord(entry)) fail("mind_diary_catalog_entry_missing");
  const pluginContentSha256 = digest(canonical(files));
  return Object.freeze({
    root: marketplaceRoot,
    name: requiredString(catalog.name, "marketplace_name_missing"),
    head: candidateSha(head),
    tree: candidateSha(tree),
    files,
    pluginContentSha256,
    snapshotSha256: digest(canonical({ files, catalog: entry })),
    pluginVersion: requiredString(pluginJson.version, "plugin_version_missing"),
    pluginJson,
    mcpJson,
    catalogEntry: entry,
  });
}

async function codexJson(codexHome, args, code) {
  const result = await execFileAsync("codex", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, CODEX_HOME: codexHome },
  }).catch(() => fail(code));
  return safeJson(result.stdout, code);
}

export function assertCodexClientVersion(stdout) {
  if (typeof stdout !== "string" || stdout.trim() !== `${CLIENT} ${CLIENT_VERSION}`) {
    fail("codex_version_mismatch");
  }
}

export async function readCodexPromptInput(codexHome, execute = execFileAsync) {
  let result;
  try {
    result = await execute(
      "codex",
      ["debug", "prompt-input", CODEX_SKILL_DISCOVERY_PROMPT],
      {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: MAX_CODEX_PROMPT_INPUT_BYTES,
        env: { ...process.env, CODEX_HOME: codexHome },
      },
    );
  } catch {
    fail("codex_prompt_input_unavailable");
  }
  return safeJson(result.stdout, "invalid_codex_prompt_input");
}

export function parseCodexSkillDiscovery(promptInput, { installedRoot, description }) {
  if (!Array.isArray(promptInput)) fail("invalid_codex_prompt_input");
  const root = requiredString(installedRoot, "missing_installed_plugin_root");
  const expectedDescription = requiredString(description, "missing_installed_skill_description");
  const expectedPath = join(root, "skills", "mind-diary", "SKILL.md");
  const prefix = "- mind-diary:mind-diary: ";
  const expected = `${prefix}${expectedDescription} (file: ${expectedPath})`;
  const entries = [];
  for (const message of promptInput) {
    if (!isRecord(message) || message.role !== "developer" || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (
        !isRecord(block) ||
        block.type !== "input_text" ||
        typeof block.text !== "string" ||
        !block.text.startsWith("<skills_instructions>\n") ||
        !block.text.endsWith("\n</skills_instructions>")
      ) continue;
      entries.push(...block.text.split("\n").filter((line) => line.startsWith(prefix)));
    }
  }
  if (entries.length !== 1 || entries[0] !== expected) {
    fail("installed_skill_not_model_visible");
  }
  return Object.freeze({
    name: "mind-diary:mind-diary",
    description: expectedDescription,
    source: "file",
    path: expectedPath,
  });
}

async function verifyFreshPluginContext(snapshot, assertions) {
  const codexHome = await mkdtemp(join(tmpdir(), "mind-diary-oauth-plugin-gate-"));
  try {
    const version = await execFileAsync("codex", ["--version"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: codexHome },
    }).catch(() => fail("codex_version_unavailable"));
    assertCodexClientVersion(version.stdout);
    const added = await codexJson(
      codexHome,
      ["plugin", "marketplace", "add", snapshot.root, "--json"],
      "marketplace_add_failed",
    );
    if (added.marketplaceName !== snapshot.name || added.alreadyAdded !== false) {
      fail("fresh_marketplace_add_mismatch");
    }
    const available = await codexJson(
      codexHome,
      ["plugin", "list", "--available", "--json"],
      "plugin_available_list_failed",
    );
    const mindDiary = available.available?.find((entry) => entry.pluginId === `mind-diary@${snapshot.name}`);
    const taskManager = available.available?.find((entry) => entry.pluginId === `task-manager@${snapshot.name}`);
    if (
      mindDiary?.installed !== false ||
      mindDiary?.installPolicy !== "AVAILABLE" ||
      mindDiary?.authPolicy !== "ON_USE"
    ) fail("available_plugin_policy_mismatch");
    assertions.add("package.fresh-context-discovery-before-install");
    if (taskManager?.installed !== false || taskManager?.pluginId === mindDiary.pluginId) {
      fail("task_manager_plugin_not_separate");
    }
    assertions.add("package.task-manager-separate");

    const installed = await codexJson(
      codexHome,
      ["plugin", "add", `mind-diary@${snapshot.name}`, "--json"],
      "plugin_install_failed",
    );
    if (
      installed.version !== snapshot.pluginVersion ||
      installed.authPolicy !== "ON_USE" ||
      typeof installed.installedPath !== "string"
    ) fail("installed_plugin_projection_mismatch");
    const installedRoot = await realpath(installed.installedPath);
    const homeRoot = `${await realpath(codexHome)}${sep}`;
    if (!`${installedRoot}${sep}`.startsWith(homeRoot)) fail("installed_plugin_outside_fresh_context");
    assertions.add("package.install-before-oauth");

    const installedFiles = Object.freeze(await directoryFiles(installedRoot));
    if (digest(canonical(installedFiles)) !== snapshot.pluginContentSha256) {
      fail("installed_plugin_content_mismatch");
    }
    const skill = await readFile(join(installedRoot, "skills", "mind-diary", "SKILL.md"), "utf8");
    if (!/^---[\s\S]*?^name:\s*mind-diary\s*$/mu.test(skill)) {
      fail("installed_skill_manifest_invalid");
    }
    const description = /^description:\s*(.+)$/mu.exec(skill)?.[1]?.trim();
    if (!description || description.includes("\n")) fail("installed_skill_manifest_invalid");
    parseCodexSkillDiscovery(
      await readCodexPromptInput(codexHome),
      { installedRoot, description },
    );
    assertions.add("package.skill-discovery");
    assertAutomaticCaptureSkillPolicy(skill);
    assertions.add("package.automatic-capture-skill-policy");

    const installedList = await codexJson(
      codexHome,
      ["plugin", "list", "--json"],
      "installed_plugin_list_failed",
    );
    const installedProjection = installedList.installed?.find((entry) =>
      entry.pluginId === `mind-diary@${snapshot.name}`);
    if (!installedProjection?.installed || !installedProjection.enabled) {
      fail("installed_plugin_not_enabled");
    }
    const mcpList = await codexJson(codexHome, ["mcp", "list", "--json"], "mcp_list_failed");
    const server = mcpList.find?.((entry) => entry.name === "mind-diary");
    if (
      server?.transport?.type !== "streamable_http" ||
      server?.transport?.url !== CODEX_PLUGIN_MCP_URL ||
      server?.auth_status !== "not_logged_in"
    ) fail("installed_mcp_resolution_mismatch");
    assertions.add("package.mcp-resolution");
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

function validatePackage(snapshot, assertions) {
  if (!/^[0-9a-f]{40}$/u.test(snapshot.head) || !/^[0-9a-f]{40}$/u.test(snapshot.tree)) {
    fail("invalid_marketplace_identity");
  }
  assertions.add("package.marketplace-head-tree-clean");
  if (!/^sha256:[0-9a-f]{64}$/u.test(snapshot.snapshotSha256)) {
    fail("invalid_plugin_snapshot_digest");
  }
  assertions.add("package.snapshot-content-digest");
  if (
    snapshot.catalogEntry.policy?.installation !== "AVAILABLE" ||
    snapshot.catalogEntry.policy?.authentication !== "ON_USE"
  ) fail("catalog_policy_mismatch");
  assertions.add("package.catalog-available-on-use");
  const server = snapshot.mcpJson.mcpServers?.["mind-diary"];
  assertDirectPackageServer(server);
  assertions.add("package.direct-resource-exact");
  if (
    Object.hasOwn(snapshot.pluginJson, "apps") ||
    snapshot.files.some((file) => basename(file.path) === ".app.json")
  ) fail("private_app_surface_present");
  assertions.add("package.no-app-or-private-app");
}

function createHarness({ database, bucket, identities, scheduled, now }) {
  const runtimeRef = { current: null };
  const options = {
    database,
    bucket,
    publicOrigin: ORIGIN,
    identity: {
      readVerifiedIdentity(request) {
        return identities.get(request) ?? { kind: "unauthenticated" };
      },
    },
    identityBindingProvider: BINDING_NAMESPACE,
    tokenVerifierKey: deterministicKey(17),
    locatorKey: deterministicKey(57),
    exportDownloadVerifierKey: deterministicKey(97),
    csrfKey: deterministicKey(137),
    now,
    verifiedNativeFileParameterRoute: {
      mcpProfiles: ["modern", "compatibility"],
      assertion: {
        profileId: "oauth-direct-plugin-local-native-v1",
        assertionId: "local-synthetic:oauth-direct-plugin:native-route:v1",
        observedAtUtc: "2026-08-28T00:00:00.000Z",
        toolName: "stage_bundle_file",
        parameterName: "file",
        sourceKind: "session_attachment",
        transport: "native_file_parameter",
      },
      async fetcher() {
        throw new Error("OAuth direct-plugin catalog probe must not fetch native file bytes.");
      },
    },
    observabilityWriter: { write() {} },
    schedule(work) { scheduled.push(work); },
  };
  return Object.freeze({
    runtimeRef,
    async start() {
      runtimeRef.current = await createProductSiteRuntime(options);
      return runtimeRef.current;
    },
  });
}

function createActor({ runtimeRef, identities, alias, name, actorClass }) {
  return new MultiPrincipalActorClient({
    origin: ORIGIN,
    actorClass,
    identitySnapshot: {
      kind: "authenticated",
      verifiedEmail: alias,
      verifiedFullName: name,
    },
    async dispatch(request, identitySnapshot) {
      identities.set(request, identitySnapshot);
      return runtimeRef.current.fetch(request);
    },
  });
}

async function raw(actor, path, options = {}) {
  const request = new Request(new URL(path, ORIGIN), {
    ...options,
    headers: new Headers(options.headers ?? {}),
    redirect: "manual",
  });
  const response = await actor.dispatch(request, actor.identitySnapshot);
  if (!(response instanceof Response)) fail("runtime_route_unavailable");
  const text = await response.text();
  let body = null;
  if (text && response.headers.get("content-type")?.includes("json")) {
    body = safeJson(text, "invalid_runtime_json");
  }
  return Object.freeze({ status: response.status, body, text, headers: response.headers });
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function pkce(verifier) {
  return base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

async function registerClient(actor, overrides = {}) {
  return raw(actor, "/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Codex Mind Diary gate",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...overrides,
    }),
  });
}

async function prepareAuthorization(actor, clientId, {
  scope = "content:read",
  state = "state-oauth-gate",
  verifier = "v".repeat(64),
  redirectUri = REDIRECT,
  resource = RESOURCE,
  challengeMethod = "S256",
} = {}) {
  const url = new URL("/oauth/authorize", ORIGIN);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    resource,
    scope,
    state,
    code_challenge: await pkce(verifier),
    code_challenge_method: challengeMethod,
  }).toString();
  const response = await raw(actor, `${url.pathname}${url.search}`);
  const requestId = /name="request_id" value="([^"]+)"/u.exec(response.text)?.[1];
  return Object.freeze({ response, requestId, verifier, state, clientId, redirectUri, resource });
}

async function completeAuthorization(actor, prepared, decision = "approve") {
  return raw(actor, "/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      request_id: requiredString(prepared.requestId, "authorization_request_missing"),
      decision,
    }),
  });
}

async function exchangeCode(actor, prepared, code, verifier = prepared.verifier) {
  return raw(actor, "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: prepared.clientId,
      redirect_uri: prepared.redirectUri,
      resource: prepared.resource,
      code_verifier: verifier,
    }),
  });
}

async function authorize(actor, clientId, options = {}) {
  const prepared = await prepareAuthorization(actor, clientId, options);
  expectStatus(prepared.response, 200, "oauth_consent_unavailable");
  const completed = expectStatus(
    await completeAuthorization(actor, prepared),
    303,
    "oauth_consent_completion_failed",
  );
  const location = new URL(requiredString(completed.headers.get("location"), "oauth_redirect_missing"));
  if (location.searchParams.get("state") !== prepared.state) fail("oauth_state_mismatch");
  const code = requiredString(location.searchParams.get("code"), "authorization_code_missing");
  const exchanged = expectStatus(
    await exchangeCode(actor, prepared, code),
    200,
    "authorization_code_exchange_failed",
  );
  return Object.freeze({ prepared, code, tokens: exchanged.body });
}

async function refresh(actor, clientId, token, overrides = {}) {
  return raw(actor, "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token,
      client_id: clientId,
      resource: RESOURCE,
      ...overrides,
    }),
  });
}

async function revoke(actor, clientId, token) {
  return raw(actor, "/oauth/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, client_id: clientId }),
  });
}

function modernBody(id, name, args = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": { name: "oauth-direct-plugin-gate", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
}

async function modern(actor, token, body) {
  return raw(actor, "/api/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
      "mcp-method": body.method,
      "mcp-protocol-version": MODERN_PROTOCOL,
      ...(body.method === "tools/call" && typeof body.params?.name === "string"
        ? { "mcp-name": body.params.name }
        : {}),
    },
    body: JSON.stringify(body),
  });
}

async function modernTool(actor, token, id, name, args = {}) {
  return modern(actor, token, modernBody(id, name, args));
}

async function compatibility(actor, token, body) {
  return raw(actor, "/api/mcp/2025-11-25", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
      ...(body.method === "initialize" ? {} : { "mcp-protocol-version": COMPAT_PROTOCOL }),
    },
    body: JSON.stringify(body),
  });
}

function mcpData(response, code) {
  const result = response.body?.result;
  if (response.status !== 200 || result?.isError === true || !isRecord(result?.structuredContent?.data)) {
    fail(code, { status: response.status, applicationCode: safeCode(result?.structuredContent?.error?.code) });
  }
  return result.structuredContent.data;
}

function expectMcpError(response, expected, code) {
  const actual = response.body?.result?.structuredContent?.error?.code;
  if (response.status !== 200 || response.body?.result?.isError !== true || actual !== expected) {
    fail(code, { status: response.status, applicationCode: safeCode(actual) });
  }
  return response.body.result;
}

async function assertCompatibilityRead(actor, token, { writeCatalog = false } = {}) {
  const initialized = await compatibility(actor, token, {
    jsonrpc: "2.0",
    id: "oauth-compat-init",
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "codex-mcp-client", title: "Codex", version: CLIENT_VERSION },
    },
  });
  if (initialized.status !== 200 || initialized.body?.result?.protocolVersion !== COMPAT_PROTOCOL) {
    fail("oauth_compat_initialize_failed");
  }
  expectStatus(await compatibility(actor, token, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  }), 202, "oauth_compat_initialized_failed");
  const tools = await compatibility(actor, token, {
    jsonrpc: "2.0",
    id: "oauth-compat-tools",
    method: "tools/list",
    params: {},
  });
  if (tools.status !== 200) fail("oauth_compat_tools_list_failed");
  if (writeCatalog) assertCodexCompatibleWriteBindingSchema(tools.body?.result?.tools);
  else assertCodexCompatibleReadCatalog(tools.body?.result?.tools);
  const listed = await compatibility(actor, token, {
    jsonrpc: "2.0",
    id: "oauth-compat-list",
    method: "tools/call",
    params: { _meta: { progressToken: 1 }, name: "list_minds", arguments: {} },
  });
  return mcpData(listed, "oauth_compat_list_failed");
}

function latestAccessRecord(database) {
  const rows = [...database.oauthAccess.values()];
  const row = rows.at(-1);
  if (!row) fail("oauth_access_record_missing");
  return row;
}

async function runOAuthScenario({ assertions, nowState }) {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  const identities = new WeakMap();
  const scheduled = [];
  const harness = createHarness({
    database,
    bucket,
    identities,
    scheduled,
    now: () => new Date(nowState.value),
  });
  await harness.start();
  const nonce = sha256(`${nowState.value.toISOString()}:oauth-gate`).slice(0, 16);
  const owner = createActor({
    runtimeRef: harness.runtimeRef,
    identities,
    alias: `oauth-owner-${nonce}@synthetic.invalid`,
    name: "OAuth Gate Owner",
    actorClass: "oauth-gate-owner",
  });
  const other = createActor({
    runtimeRef: harness.runtimeRef,
    identities,
    alias: `oauth-other-${nonce}@synthetic.invalid`,
    name: "OAuth Gate Other",
    actorClass: "oauth-gate-other",
  });
  const ownerSession = await owner.session(`oauth:${nonce}:bootstrap:owner`);
  await other.session(`oauth:${nonce}:bootstrap:other`);

  const protectedResource = expectStatus(
    await raw(owner, "/.well-known/oauth-protected-resource/api/mcp"),
    200,
    "protected_resource_discovery_failed",
  );
  if (
    protectedResource.body?.resource !== RESOURCE ||
    !protectedResource.body?.authorization_servers?.includes(ORIGIN)
  ) fail("protected_resource_metadata_mismatch");
  assertions.add("oauth.protected-resource-discovery");
  const serverMetadata = expectStatus(
    await raw(owner, "/.well-known/oauth-authorization-server"),
    200,
    "authorization_server_discovery_failed",
  );
  if (
    !serverMetadata.body?.code_challenge_methods_supported?.includes("S256") ||
    !serverMetadata.body?.grant_types_supported?.includes("refresh_token") ||
    Object.hasOwn(serverMetadata.body, "client_id_metadata_document_supported")
  ) fail("authorization_server_metadata_mismatch");
  assertions.add("oauth.authorization-server-discovery");

  const invalidDcr = await registerClient(owner, { token_endpoint_auth_method: "client_secret_post" });
  if (invalidDcr.status !== 400 || invalidDcr.body?.error !== "invalid_client") {
    fail("oauth_dcr_negative_failed");
  }
  assertions.add("oauth.dcr-negative-client-policy");
  const registered = expectStatus(await registerClient(owner), 201, "oauth_dcr_failed");
  const clientId = requiredString(registered.body?.client_id, "oauth_client_id_missing");
  if (Object.hasOwn(registered.body, "client_secret")) fail("oauth_client_secret_issued");
  assertions.add("oauth.public-dcr-no-secret");

  const wrongRedirect = await prepareAuthorization(owner, clientId, {
    redirectUri: "https://chatgpt.com/not-registered",
  });
  const wrongResource = await prepareAuthorization(owner, clientId, {
    resource: "https://other.invalid/api/mcp",
  });
  const wrongPkce = await prepareAuthorization(owner, clientId, { challengeMethod: "plain" });
  if (
    wrongRedirect.response.status !== 400 || wrongRedirect.response.body?.error !== "invalid_client" ||
    wrongResource.response.status !== 400 || wrongResource.response.body?.error !== "invalid_target" ||
    wrongPkce.response.status !== 400 || wrongPkce.response.body?.error !== "invalid_request"
  ) fail("oauth_authorization_negative_failed");
  assertions.add("oauth.redirect-resource-pkce-negative");

  const pending = await prepareAuthorization(owner, clientId, { state: "state-wrong-identity" });
  expectStatus(pending.response, 200, "oauth_pending_request_failed");
  const wrongIdentity = await completeAuthorization(other, pending);
  if (wrongIdentity.status !== 400 || wrongIdentity.body?.error !== "invalid_request") {
    fail("oauth_wrong_identity_completion_not_denied");
  }
  assertions.add("oauth.pending-wrong-identity-denied");
  const denied = await completeAuthorization(owner, pending, "deny");
  expectStatus(denied, 303, "oauth_explicit_deny_failed");
  const deniedLocation = new URL(requiredString(denied.headers.get("location"), "oauth_deny_redirect_missing"));
  if (
    deniedLocation.searchParams.get("error") !== "access_denied" ||
    deniedLocation.searchParams.get("state") !== pending.state
  ) fail("oauth_deny_redirect_mismatch");
  assertions.add("oauth.explicit-deny-state-preserved");

  const replayPrepared = await prepareAuthorization(owner, clientId, { state: "state-code-replay" });
  const replayCompleted = expectStatus(
    await completeAuthorization(owner, replayPrepared),
    303,
    "oauth_code_prepare_failed",
  );
  const replayLocation = new URL(requiredString(replayCompleted.headers.get("location"), "oauth_code_redirect_missing"));
  const replayCode = requiredString(replayLocation.searchParams.get("code"), "oauth_code_missing");
  const badVerifier = await exchangeCode(owner, replayPrepared, replayCode, "x".repeat(64));
  if (badVerifier.status !== 400 || badVerifier.body?.error !== "invalid_grant") {
    fail("oauth_bad_verifier_not_denied");
  }
  expectStatus(
    await exchangeCode(owner, replayPrepared, replayCode),
    200,
    "oauth_valid_code_after_bad_verifier_failed",
  );
  const replay = await exchangeCode(owner, replayPrepared, replayCode);
  if (replay.status !== 400 || replay.body?.error !== "invalid_grant") {
    fail("oauth_code_replay_not_denied");
  }
  assertions.add("oauth.bad-verifier-code-replay-denied");

  const expiringPrepared = await prepareAuthorization(owner, clientId, { state: "state-code-expiry" });
  const expiringCompleted = expectStatus(
    await completeAuthorization(owner, expiringPrepared),
    303,
    "oauth_expiring_code_prepare_failed",
  );
  const expiringCode = requiredString(
    new URL(requiredString(expiringCompleted.headers.get("location"), "oauth_expiring_code_redirect_missing"))
      .searchParams.get("code"),
    "oauth_expiring_code_missing",
  );
  nowState.value = new Date(nowState.value.getTime() + 6 * 60 * 1_000);
  const expiredCode = await exchangeCode(owner, expiringPrepared, expiringCode);
  if (expiredCode.status !== 400 || expiredCode.body?.error !== "invalid_grant") {
    fail("oauth_expired_code_not_denied");
  }
  assertions.add("oauth.authorization-code-expiry");

  const readGrant = await authorize(owner, clientId, { state: "state-read-runtime" });
  if (readGrant.tokens?.scope !== "content:read") fail("oauth_read_scope_mismatch");
  const advertisedModernTools = await modern(owner, readGrant.tokens.access_token, {
    jsonrpc: "2.0",
    id: "oauth-modern-tools",
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": { name: "oauth-direct-plugin-gate", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  if (advertisedModernTools.status !== 200) fail("oauth_modern_tools_list_failed");
  assertCodexCompatibleReadCatalog(advertisedModernTools.body?.result?.tools);
  const discovery = await modern(owner, readGrant.tokens.access_token, {
    jsonrpc: "2.0",
    id: "oauth-modern-discovery",
    method: "server/discover",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": { name: "oauth-direct-plugin-gate", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  if (discovery.status !== 200 || discovery.body?.result?.supportedVersions?.[0] !== MODERN_PROTOCOL) {
    fail("oauth_modern_discovery_failed");
  }
  const modernList = mcpData(
    await modernTool(owner, readGrant.tokens.access_token, "oauth-read-list", "list_minds"),
    "oauth_modern_read_failed",
  );
  if (!modernList.minds?.some((mind) => mind.route === "/me")) fail("oauth_personal_mind_missing");
  assertions.add("oauth.read-grant-modern-runtime");
  const compatList = await assertCompatibilityRead(owner, readGrant.tokens.access_token);
  if (!compatList.minds?.some((mind) => mind.route === "/me")) fail("oauth_compat_personal_mind_missing");
  assertions.add("oauth.read-grant-compat-runtime");
  const personal = modernList.minds.find((mind) => mind.route === "/me");
  const writeChallenge = expectMcpError(
    await modernTool(owner, readGrant.tokens.access_token, "oauth-read-write", "commit_changeset", {
      mind: "/me",
      expected_revision: personal.head.revision_id,
      idempotency_key: `oauth:${nonce}:read-denied`,
      summary: "OAuth read grant denial",
      operations: [{
        type: "create_file",
        path: "concepts/read-denied.md",
        text: "---\ntype: Note\ntitle: Read denied\n---\nDenied.\n",
      }],
    }),
    "insufficient_scope",
    "oauth_read_write_not_denied",
  );
  if (!writeChallenge._meta?.["mcp/www_authenticate"]?.[0]?.includes("content:write")) {
    fail("oauth_write_challenge_missing");
  }
  assertions.add("oauth.read-grant-write-challenge");

  nowState.value = new Date(nowState.value.getTime() + 16 * 60 * 1_000);
  if ((await modernTool(owner, readGrant.tokens.access_token, "oauth-expired-access", "list_minds")).status !== 401) {
    fail("oauth_expired_access_not_denied");
  }
  assertions.add("oauth.access-token-expiry");

  const rotationGrant = await authorize(owner, clientId, { state: "state-refresh-rotation" });
  const rotated = expectStatus(
    await refresh(owner, clientId, rotationGrant.tokens.refresh_token),
    200,
    "oauth_refresh_rotation_failed",
  );
  if (rotated.body?.refresh_token === rotationGrant.tokens.refresh_token) {
    fail("oauth_refresh_token_not_rotated");
  }
  mcpData(
    await modernTool(owner, rotated.body.access_token, "oauth-rotated-read", "list_minds"),
    "oauth_rotated_access_failed",
  );
  assertions.add("oauth.refresh-rotation");
  const reused = await refresh(owner, clientId, rotationGrant.tokens.refresh_token);
  if (reused.status !== 400 || reused.body?.error !== "invalid_grant") {
    fail("oauth_refresh_reuse_not_detected");
  }
  mcpData(
    await modernTool(owner, rotated.body.access_token, "oauth-concurrent-reuse-read", "list_minds"),
    "oauth_concurrent_refresh_reuse_revoked_access",
  );
  assertions.add("oauth.refresh-concurrent-reuse-tolerated");
  nowState.value = new Date(nowState.value.getTime() + 30 * 1_000 + 1);
  const lateReuse = await refresh(owner, clientId, rotationGrant.tokens.refresh_token);
  if (lateReuse.status !== 400 || lateReuse.body?.error !== "invalid_grant") {
    fail("oauth_late_refresh_reuse_not_detected");
  }
  if ((await modernTool(owner, rotated.body.access_token, "oauth-late-reuse-denied", "list_minds")).status !== 401) {
    fail("oauth_late_refresh_reuse_did_not_revoke_access");
  }
  assertions.add("oauth.refresh-late-reuse-revokes-family");

  const rfcGrant = await authorize(owner, clientId, { state: "state-rfc7009" });
  expectStatus(await revoke(owner, clientId, rfcGrant.tokens.access_token), 200, "oauth_rfc7009_failed");
  if ((await modernTool(owner, rfcGrant.tokens.access_token, "oauth-rfc-denied", "list_minds")).status !== 401) {
    fail("oauth_rfc7009_access_not_revoked");
  }
  assertions.add("oauth.rfc7009-revoke-next-request");

  const writeGrant = await authorize(owner, clientId, {
    state: "state-write-step-up",
    scope: "content:write",
  });
  if (writeGrant.tokens?.scope !== "content:read content:write") fail("oauth_write_scope_mismatch");
  assertions.add("oauth.write-step-up");
  const advertisedWriteTools = await modern(owner, writeGrant.tokens.access_token, {
    jsonrpc: "2.0",
    id: "oauth-write-tools",
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": { name: "oauth-direct-plugin-gate", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  if (advertisedWriteTools.status !== 200) fail("oauth_write_tools_list_failed");
  assertCodexCompatibleWriteBindingSchema(advertisedWriteTools.body?.result?.tools);
  assertions.add("oauth.catalog-modern-exact-18");
  await assertCompatibilityRead(owner, writeGrant.tokens.access_token, { writeCatalog: true });
  assertions.add("oauth.catalog-compat-exact-18");
  assertions.add("oauth.codex-compatible-write-binding-schema");
  const writeAccessRecord = latestAccessRecord(database);
  const metadata = await createSitesMetadataStore(database);
  const activeMirror = await metadata.readMcpTokenForAuthorization(writeAccessRecord.id);
  if (activeMirror?.state !== "active") fail("oauth_authorization_mirror_not_active");
  assertions.add("oauth.authorization-mirror-active");

  const info = mcpData(
    await modernTool(owner, writeGrant.tokens.access_token, "oauth-write-info", "get_mind_info", { mind: "/me" }),
    "oauth_current_acl_read_failed",
  );
  if (!info.content_capabilities?.includes("commit")) fail("oauth_current_acl_missing_commit");
  assertions.add("oauth.current-acl-readback");
  const connections = await owner.api("/api/v1/connections");
  const connection = connections.body?.data?.items?.find((item) => item?.can_write === true);
  const connectionRef = requiredString(
    connection?.connection_ref,
    "oauth_connected_app_not_visible",
  );
  const initialConnection = await owner.api(
    `/api/v1/connections/${encodeURIComponent(connectionRef)}`,
  );
  if (
    initialConnection.body?.data?.access?.target_version !== 0 ||
    initialConnection.body?.data?.access?.writable_mind !== null
  ) fail("oauth_initial_bindings_not_empty");
  const selected = await owner.api(
    `/api/v1/connections/${encodeURIComponent(connectionRef)}/mind-access`,
    {
      method: "PATCH",
      body: {
        action: "select_write",
        mind_ref: "/me",
        expected_target_version: 0,
      },
      idempotencyKey: `oauth:${nonce}:select-target`,
      csrfPath: `/settings/connections/${encodeURIComponent(connectionRef)}`,
    },
  );
  const targetReadback = selected.body?.data?.access;
  if (
    targetReadback?.target_version !== 1 ||
    targetReadback?.writable_mind?.route !== "/me" ||
    /write_binding|binding_owner|space_id|generation/u.test(JSON.stringify(selected.body))
  ) fail("oauth_write_binding_readback_mismatch");
  assertions.add("oauth.explicit-write-binding-readback");
  const refreshedWriteGrant = expectStatus(
    await refresh(owner, clientId, writeGrant.tokens.refresh_token),
    200,
    "oauth_bound_grant_refresh_failed",
  );
  mcpData(
    await modernTool(owner, refreshedWriteGrant.body.access_token, "oauth-refreshed-target-read", "list_minds"),
    "oauth_refreshed_write_binding_readback_failed",
  );
  const refreshedConnection = await owner.api(
    `/api/v1/connections/${encodeURIComponent(connectionRef)}`,
  );
  if (
    refreshedConnection.body?.data?.access?.target_version !== 1 ||
    refreshedConnection.body?.data?.access?.writable_mind?.route !== "/me"
  ) fail("oauth_refresh_changed_write_binding");
  assertions.add("oauth.refresh-preserves-write-binding");
  const connectionDetail = await owner.api(
    `/api/v1/connections/${encodeURIComponent(connectionRef)}`,
  );
  if (
    connectionDetail.body?.data?.access?.target_version !== 1 ||
    connectionDetail.body?.data?.access?.writable_mind?.route !== "/me" ||
    JSON.stringify(connectionDetail.body).includes(String(writeAccessRecord.grant_id))
  ) fail("oauth_connection_safe_projection_mismatch");
  assertions.add("oauth.connection-safe-projection");
  const staleAccess = await owner.api(
    `/api/v1/connections/${encodeURIComponent(connectionRef)}/mind-access`,
    {
      method: "PATCH",
      body: {
        action: "clear_write",
        expected_target_version: 0,
      },
      idempotencyKey: `oauth:${nonce}:stale-access`,
      csrfPath: `/settings/connections/${encodeURIComponent(connectionRef)}`,
      expectedStatus: 409,
    },
  );
  if (staleAccess.body?.error?.code !== "target_conflict") {
    fail("oauth_connection_stale_cas_not_denied");
  }
  assertions.add("oauth.connection-stale-cas");
  const expectedRevision = info.resolved_revision.revision_id;
  const commitArguments = {
    mind: "/me",
    expected_revision: expectedRevision,
    idempotency_key: `oauth:${nonce}:commit`,
    summary: "OAuth exact-candidate fixture",
    operations: [{
      type: "create_file",
      path: "concepts/oauth-gate.md",
      text: "---\ntype: Note\ntitle: OAuth gate\n---\nExact candidate fixture.\n",
    }],
  };
  const committed = mcpData(
    await modernTool(owner, writeGrant.tokens.access_token, "oauth-write-commit", "commit_changeset", commitArguments),
    "oauth_product_commit_failed",
  );
  if (committed.revision?.revision_id === expectedRevision) fail("oauth_commit_did_not_advance_head");
  assertions.add("oauth.product-runtime-commit");
  const replayed = mcpData(
    await modernTool(owner, writeGrant.tokens.access_token, "oauth-write-replay", "commit_changeset", commitArguments),
    "oauth_product_commit_replay_failed",
  );
  if (replayed.revision?.revision_id !== committed.revision?.revision_id) {
    fail("oauth_commit_replay_changed_revision");
  }
  assertions.add("oauth.product-runtime-idempotent-replay");
  expectMcpError(
    await modernTool(owner, writeGrant.tokens.access_token, "oauth-write-stale", "commit_changeset", {
      ...commitArguments,
      idempotency_key: `oauth:${nonce}:stale`,
      summary: "OAuth stale fixture",
      operations: [{
        type: "create_file",
        path: "concepts/oauth-stale.md",
        text: "---\ntype: Note\ntitle: OAuth stale\n---\nStale.\n",
      }],
    }),
    "revision_conflict",
    "oauth_stale_cas_not_denied",
  );
  assertions.add("oauth.product-runtime-stale-cas");

  await owner.api(`/api/v1/connections/${encodeURIComponent(connectionRef)}`, {
    method: "DELETE",
    idempotencyKey: `oauth:${nonce}:connected-app-revoke`,
    csrfPath: `/settings/connections/${encodeURIComponent(connectionRef)}`,
  });
  if ((await modernTool(owner, writeGrant.tokens.access_token, "oauth-connected-revoked", "list_minds")).status !== 401) {
    fail("oauth_connected_app_revoke_not_enforced");
  }
  const revokedMirror = await metadata.readMcpTokenForAuthorization(writeAccessRecord.id);
  if (revokedMirror?.state !== "revoked") fail("oauth_authorization_mirror_not_revoked");
  assertions.add("oauth.connected-app-mirror-revoke");
  const revokedTarget = await metadata.readCredentialWriteTarget(
    String(writeAccessRecord.grant_id),
    String(writeAccessRecord.principal_id),
  );
  if (
    revokedTarget?.kind !== "current" ||
    revokedTarget.state.lifecycleState !== "revoked" ||
    revokedTarget.state.activeGeneration !== null
  ) fail("oauth_connected_app_binding_owner_not_revoked");
  assertions.add("oauth.connected-app-binding-revoke");

  const reconnect = await authorize(owner, clientId, { state: "state-reconnect" });
  mcpData(
    await modernTool(owner, reconnect.tokens.access_token, "oauth-reconnect-read", "list_minds"),
    "oauth_reconnect_failed",
  );
  const reconnectAccess = latestAccessRecord(database);
  const reconnectConnections = await owner.api("/api/v1/connections");
  const reconnectConnection = reconnectConnections.body?.data?.items?.find(
    (item) => item?.connection_ref !== connectionRef,
  );
  const reconnectRef = requiredString(
    reconnectConnection?.connection_ref,
    "oauth_reconnect_bindings_failed",
  );
  const reconnectDetail = await owner.api(
    `/api/v1/connections/${encodeURIComponent(reconnectRef)}`,
  );
  if (
    reconnectAccess.grant_id === writeAccessRecord.grant_id ||
    reconnectRef === connectionRef ||
    reconnectDetail.body?.data?.access?.target_version !== 0 ||
    reconnectDetail.body?.data?.access?.writable_mind !== null
  ) fail("oauth_reconnect_binding_generation_not_empty");
  assertions.add("oauth.reconnect-new-grant");
  assertions.add("oauth.reconnect-empty-binding-generation");

  await owner.issueMcpToken({
    name: "Personal token regression",
    idempotencyKey: `oauth:${nonce}:personal-token`,
  });
  mcpData(
    await modernTool(owner, owner.mcpToken, "personal-modern-list", "list_minds"),
    "personal_token_modern_failed",
  );
  assertions.add("personal-token.modern-regression");
  await assertCompatibilityRead(owner, owner.mcpToken, { writeCatalog: true });
  assertions.add("personal-token.compat-regression");

  if (ownerSession.personal_mind?.route !== "/me") fail("oauth_owner_session_invalid");
  await assertNoSyntheticProductAuthority(ROOT);
  assertions.add("production-negative.no-synthetic-authority");
  assertions.add("evidence.external-ui-canary-separated");
  database.destroy();
  bucket.destroy();
}

async function headSha() {
  return candidateSha(String(await git(ROOT, ["rev-parse", "HEAD"])).trim());
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
  const allowed = new Set(["candidate_sha", "evidence_out", "marketplace_root"]);
  if (Object.keys(options).some((key) => !allowed.has(key))) fail("unsupported_cli_argument");
  if (!options.evidence_out) fail("missing_evidence_out");
  return options;
}

export async function run(options, { now = () => new Date() } = {}) {
  const currentHead = await headSha();
  const requested = options.candidate_sha === undefined
    ? currentHead
    : candidateSha(options.candidate_sha);
  if (requested !== currentHead) fail("candidate_sha_not_head");
  const startedAt = now().toISOString();
  const assertions = passedTracker();
  const marketplace = await inspectMarketplace(resolve(options.marketplace_root ?? DEFAULT_MARKETPLACE_ROOT));
  validatePackage(marketplace, assertions);
  await verifyFreshPluginContext(marketplace, assertions);
  const after = await inspectMarketplace(marketplace.root);
  if (
    after.head !== marketplace.head ||
    after.tree !== marketplace.tree ||
    after.snapshotSha256 !== marketplace.snapshotSha256
  ) fail("marketplace_snapshot_changed_during_probe");
  const nowState = { value: new Date("2026-08-20T00:00:00.000Z") };
  await runOAuthScenario({ assertions, nowState });
  const evidence = createEvidence({
    candidate: requested,
    marketplace,
    startedAt,
    completedAt: now().toISOString(),
    passed: assertions.values,
  });
  await writeFile(requiredString(options.evidence_out, "missing_evidence_out"), `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const mode = (await stat(options.evidence_out)).mode & 0o777;
  if (mode !== 0o600) fail("evidence_mode_not_private");
  return evidence;
}

function help() {
  return "Usage: npm run gate:oauth-direct-plugin -- --evidence-out <private-temp-path> [--candidate-sha <exact-HEAD-sha>] [--marketplace-root <clean-marketplace-checkout>]";
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) process.stdout.write(`${help()}\n`);
    else {
      const evidence = await run(options);
      process.stdout.write(`${JSON.stringify({
        status: evidence.status,
        candidate_sha: evidence.candidate_sha,
        artifact_sha256: evidence.artifact_sha256,
      })}\n`);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: "failed",
      code: error instanceof ProbeFailure ? error.code : safeCode(error?.code),
    })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
