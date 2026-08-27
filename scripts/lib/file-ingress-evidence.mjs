import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const REGISTRY_PATH = "tests/fixtures/file-ingress-evidence/registry.json";
export const FIXTURE_PLAN_PATH =
  "tests/fixtures/file-ingress-evidence/synthetic-fixtures.json";
export const HOSTED_TOOL_INVENTORY_PATH =
  "tests/fixtures/file-ingress-evidence/hosted-tool-inventory.json";
export const HOSTING_CONFIG_PATH = "apps/mind-diary-site/.openai/hosting.json";
export const RELEASE_PROFILE_PATH = "docs/operations/ship-work-release-profile.md";
export const REGISTRY_SCHEMA = "mind-diary/file-ingress-evidence-registry/v2";
export const FIXTURE_SCHEMA = "mind-diary/file-ingress-synthetic-fixtures/v1";
export const HOSTED_TOOL_INVENTORY_SCHEMA =
  "mind-diary/file-ingress-hosted-tool-inventory/v1";
export const LOCAL_RECEIPT_SCHEMA = "mind-diary/file-ingress-local-evidence/v1";
export const HOSTED_DEPLOYMENT_ANCHOR_SCHEMA =
  "mind-diary/file-ingress-hosted-deployment-anchor/v1";
export const HOSTED_RECEIPT_SCHEMA = "mind-diary/file-ingress-hosted-evidence/v2";
export const REPORT_SCHEMA = "mind-diary/file-ingress-matrix-report/v2";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9._/-]{0,127}$/u;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const CODEX_VERSION = /^0\.[0-9]+\.[0-9]+$/u;
const PLUGIN_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+\+codex\.[0-9]{14}$/u;
const LOCAL_STATUSES = Object.freeze(["passed", "failed", "not_run"]);
const ROW_STATUSES = Object.freeze(["passed", "not_available", "failed"]);
const NOT_AVAILABLE_CODES = Object.freeze([
  "native_file_input_unsupported",
  "file_ingress_source_unavailable",
  "file_ingress_source_unsupported",
  "file_ingress_transport_unavailable",
]);
const FAILED_CODES = Object.freeze([
  "assertion_failed",
  "cleanup_incomplete",
  "transport_failure",
  "product_failure",
]);

const EXPECTED_TRANSPORTS = Object.freeze({
  session_attachment: "native_file_parameter",
  local_path: "companion_upload_intent",
  "workspace/generated_artifact": "companion_upload_intent",
  connector_object: "authorized_connector_object",
  bounded_in_memory: "bounded_bytes",
  server_generated: "producer_stream",
});

const EXPECTED_SNAPSHOTS = Object.freeze({
  session_attachment: "provider_native_snapshot",
  local_path: "same_host_stable_snapshot",
  "workspace/generated_artifact": "same_host_stable_snapshot",
  connector_object: "provider_native_snapshot",
  bounded_in_memory: "service_owned_snapshot",
  server_generated: "service_owned_snapshot",
});

export class FileIngressEvidenceError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "FileIngressEvidenceError";
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new FileIngressEvidenceError(code, message);
}

function assert(condition, code, message = code) {
  if (!condition) fail(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, code) {
  assert(isRecord(value), code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(
    actual.length === wanted.length && actual.every((key, index) => key === wanted[index]),
    code,
  );
}

function exactArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function uniqueStrings(value, code) {
  assert(Array.isArray(value), code);
  assert(value.every((item) => typeof item === "string" && item.length > 0), code);
  assert(new Set(value).size === value.length, code);
}

function safeString(value, code, maximum = 128) {
  assert(
    typeof value === "string" && value.length > 0 && value.length <= maximum &&
      !/[\u0000-\u001f\u007f]/u.test(value),
    code,
  );
}

function assertionMap(assertions, expectedIds, code, statuses = LOCAL_STATUSES) {
  assert(Array.isArray(assertions), code);
  assert(assertions.length === expectedIds.length, code);
  const result = new Map();
  for (let index = 0; index < expectedIds.length; index += 1) {
    const assertion = assertions[index];
    exactKeys(assertion, ["id", "status"], code);
    assert(assertion.id === expectedIds[index], code);
    assert(statuses.includes(assertion.status), code);
    result.set(assertion.id, assertion.status);
  }
  return result;
}

function aggregate(statuses) {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("pending") || statuses.includes("not_run")) return "pending";
  if (statuses.includes("not_available")) return "not_available";
  return "passed";
}

function rowStatus(assertions, requiredIds) {
  const statuses = requiredIds.map((id) => assertions.get(id));
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("not_run") || statuses.includes(undefined)) return "pending";
  return "passed";
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function documentDigest(unsigned) {
  return sha256(canonicalJson(unsigned));
}

function unsignedDocument(document) {
  const { artifact_sha256: _artifactSha256, ...unsigned } = document;
  return unsigned;
}

export function sealDocument(unsigned) {
  return Object.freeze({
    ...unsigned,
    artifact_sha256: documentDigest(unsigned),
  });
}

function validateArtifactDigest(document, code) {
  assert(SHA256_HEX.test(document.artifact_sha256), code);
  assert(document.artifact_sha256 === documentDigest(unsignedDocument(document)), code);
}

function validateToolInventory(toolInventory) {
  exactKeys(toolInventory, ["schema", "source", "entries"], "invalid_hosted_tool_inventory");
  assert(
    toolInventory.schema === HOSTED_TOOL_INVENTORY_SCHEMA,
    "invalid_hosted_tool_inventory_schema",
  );
  assert(
    toolInventory.source === "mind-diary-hosted-mcp-tools-list",
    "invalid_hosted_tool_inventory_source",
  );
  assert(Array.isArray(toolInventory.entries) && toolInventory.entries.length > 0, "invalid_hosted_tool_inventory");
  let previous = null;
  for (const entry of toolInventory.entries) {
    exactKeys(
      entry,
      ["name", "source", "input_schema_sha256", "output_schema_sha256"],
      "invalid_hosted_tool_inventory_entry",
    );
    assert(SAFE_ID.test(entry.name), "invalid_hosted_tool_inventory_entry");
    assert(entry.source === toolInventory.source, "invalid_hosted_tool_inventory_entry");
    assert(SHA256.test(entry.input_schema_sha256), "invalid_hosted_tool_inventory_entry");
    assert(SHA256.test(entry.output_schema_sha256), "invalid_hosted_tool_inventory_entry");
    assert(previous === null || previous.localeCompare(entry.name) < 0, "invalid_hosted_tool_inventory_order");
    previous = entry.name;
  }
  return toolInventory;
}

function extractUatProfile(profileText) {
  const body = /^uat:\n(?<body>(?:(?: {2,}[^\n]*|[ \t]*)\n)*)/mu.exec(profileText)?.groups?.body;
  assert(typeof body === "string", "invalid_release_profile_uat");
  const field = (pattern, code = "invalid_release_profile_uat") => {
    const value = pattern.exec(body)?.[1];
    assert(typeof value === "string" && value.length > 0, code);
    return value;
  };
  assert(/^  configured: true$/mu.test(body), "invalid_release_profile_uat");
  assert(/^  product_environment: uat$/mu.test(body), "invalid_release_profile_uat");
  const provider = field(/^  provider:\n    id: ([^\n]+)$/mu);
  const targetProvider = field(/^  target:\n    provider: ([^\n]+)$/mu);
  const targetKind = field(/^    kind: ([^\n]+)$/mu);
  const configPath = field(/^      document: ([^\n]+)$/mu);
  const pointer = field(/^      pointer: ([^\n]+)$/mu);
  const liveUrl = field(/^  url: ([^\n]+)$/mu);
  assert(provider === "openai-sites" && targetProvider === provider, "invalid_release_profile_uat");
  assert(targetKind === "project", "invalid_release_profile_uat");
  assert(configPath === HOSTING_CONFIG_PATH && pointer === "/project_id", "invalid_release_profile_uat");
  try {
    const url = new URL(liveUrl);
    assert(url.protocol === "https:" && url.pathname === "/", "invalid_release_profile_uat");
  } catch {
    fail("invalid_release_profile_uat");
  }
  return Object.freeze({ provider, targetKind, liveUrl });
}

function resolveHostedAuthority(hostingConfig, releaseProfileText) {
  exactKeys(hostingConfig, ["project_id", "d1", "r2"], "invalid_hosting_config");
  assert(/^appgprj_[a-z0-9]+$/u.test(hostingConfig.project_id), "invalid_hosting_project_id");
  const profile = extractUatProfile(releaseProfileText);
  return Object.freeze({
    provider: profile.provider,
    product_environment: "uat",
    target_kind: profile.targetKind,
    site_project_id: hostingConfig.project_id,
    live_url: profile.liveUrl,
    target_config_path: HOSTING_CONFIG_PATH,
    target_config_sha256: `sha256:${sha256(canonicalJson(hostingConfig))}`,
    release_profile_path: RELEASE_PROFILE_PATH,
    release_profile_sha256: `sha256:${sha256(releaseProfileText)}`,
  });
}

export async function loadFileIngressEvidenceConfig(repositoryRoot) {
  const [registryText, fixtureText, toolInventoryText, hostingConfigText, releaseProfileText] = await Promise.all([
    readFile(resolve(repositoryRoot, REGISTRY_PATH), "utf8"),
    readFile(resolve(repositoryRoot, FIXTURE_PLAN_PATH), "utf8"),
    readFile(resolve(repositoryRoot, HOSTED_TOOL_INVENTORY_PATH), "utf8"),
    readFile(resolve(repositoryRoot, HOSTING_CONFIG_PATH), "utf8"),
    readFile(resolve(repositoryRoot, RELEASE_PROFILE_PATH), "utf8"),
  ]);
  let registry;
  let fixtures;
  let toolInventory;
  let hostingConfig;
  try {
    registry = JSON.parse(registryText);
    fixtures = JSON.parse(fixtureText);
    toolInventory = JSON.parse(toolInventoryText);
    hostingConfig = JSON.parse(hostingConfigText);
  } catch (error) {
    fail("invalid_evidence_json", error.message);
  }
  const validated = validateFileIngressEvidenceConfig(registry, fixtures, toolInventory);
  return Object.freeze({
    ...validated,
    registry,
    fixtures,
    toolInventory,
    hostedAuthority: resolveHostedAuthority(hostingConfig, releaseProfileText),
    registrySha256: sha256(canonicalJson(registry)),
    fixturePlanSha256: sha256(canonicalJson(fixtures)),
    toolInventorySha256: sha256(canonicalJson(toolInventory)),
  });
}

export function validateFileIngressEvidenceConfig(registry, fixtures, toolInventory) {
  exactKeys(
    registry,
    [
      "schema",
      "release",
      "hosted_authority",
      "source_kinds",
      "client_profiles",
      "assertion_ids",
      "local_command_groups",
      "rows",
    ],
    "invalid_registry",
  );
  assert(registry.schema === REGISTRY_SCHEMA, "invalid_registry_schema");
  assert(registry.release === "0.3", "invalid_registry_release");
  exactKeys(
    registry.hosted_authority,
    [
      "target_config_path",
      "release_profile_path",
      "trusted_runner_boundary",
      "plugin_package",
      "tool_inventory_path",
      "tool_inventory_sha256",
    ],
    "invalid_hosted_authority_registry",
  );
  assert(
    registry.hosted_authority.target_config_path === HOSTING_CONFIG_PATH &&
      registry.hosted_authority.release_profile_path === RELEASE_PROFILE_PATH,
    "invalid_hosted_authority_registry",
  );
  assert(
    registry.hosted_authority.trusted_runner_boundary ===
      "trusted-runner-no-cryptographic-attestation",
    "invalid_hosted_authority_registry",
  );
  assert(
    registry.hosted_authority.tool_inventory_path === HOSTED_TOOL_INVENTORY_PATH &&
      SHA256_HEX.test(registry.hosted_authority.tool_inventory_sha256),
    "invalid_hosted_authority_registry",
  );
  assert(
    registry.hosted_authority.tool_inventory_sha256 === sha256(canonicalJson(toolInventory)),
    "hosted_tool_inventory_registry_mismatch",
  );
  validateToolInventory(toolInventory);
  exactKeys(
    registry.hosted_authority.plugin_package,
    [
      "plugin_id",
      "plugin_version",
      "plugin_snapshot_sha256",
      "marketplace_candidate_sha",
      "marketplace_tree_sha",
    ],
    "invalid_hosted_plugin_contract",
  );
  const pluginPackage = registry.hosted_authority.plugin_package;
  assert(pluginPackage.plugin_id === "mind-diary@srez-marketplace", "invalid_hosted_plugin_contract");
  assert(PLUGIN_VERSION.test(pluginPackage.plugin_version), "invalid_hosted_plugin_contract");
  assert(SHA256.test(pluginPackage.plugin_snapshot_sha256), "invalid_hosted_plugin_contract");
  assert(GIT_SHA.test(pluginPackage.marketplace_candidate_sha), "invalid_hosted_plugin_contract");
  assert(GIT_SHA.test(pluginPackage.marketplace_tree_sha), "invalid_hosted_plugin_contract");
  const sourceKinds = Object.keys(EXPECTED_TRANSPORTS);
  assert(exactArray(registry.source_kinds, sourceKinds), "invalid_source_kind_registry");

  assert(Array.isArray(registry.client_profiles), "invalid_client_profiles");
  const profiles = new Map();
  for (const profile of registry.client_profiles) {
    const hosted = profile.environment === "hosted_uat";
    exactKeys(profile, hosted
      ? [
          "id",
          "environment",
          "client_class",
          "client_name",
          "client_version",
          "protocol_profile",
          "tool_inventory_route",
        ]
      : ["id", "environment", "client_class", "protocol_profile"], "invalid_client_profile");
    assert(SAFE_ID.test(profile.id), "invalid_client_profile");
    assert(
      profile.environment === "local_contract" || profile.environment === "hosted_uat",
      "invalid_client_profile",
    );
    safeString(profile.client_class, "invalid_client_profile");
    safeString(profile.protocol_profile, "invalid_client_profile");
    if (hosted) {
      assert(profile.client_class === "codex", "invalid_client_profile");
      assert(profile.client_name === "codex-cli", "invalid_client_profile");
      assert(CODEX_VERSION.test(profile.client_version), "invalid_client_profile");
      assert(
        profile.tool_inventory_route === "/api/mcp" ||
          profile.tool_inventory_route === "/api/mcp/2025-11-25",
        "invalid_client_profile",
      );
    }
    assert(!profiles.has(profile.id), "duplicate_client_profile");
    profiles.set(profile.id, profile);
  }
  assert(
    exactArray(
      [...profiles.keys()],
      [
        "repository-node-test-v1",
        "codex-modern-2026-07-28",
        "codex-compat-2025-11-25",
      ],
    ),
    "invalid_client_profile_registry",
  );
  assert(
    profiles.get("codex-modern-2026-07-28")?.client_version === "0.149.1" &&
      profiles.get("codex-modern-2026-07-28")?.protocol_profile === "2026-07-28" &&
      profiles.get("codex-modern-2026-07-28")?.tool_inventory_route === "/api/mcp",
    "invalid_client_profile_registry",
  );
  assert(
    profiles.get("codex-compat-2025-11-25")?.client_version === "0.149.1" &&
      profiles.get("codex-compat-2025-11-25")?.protocol_profile === "2025-11-25" &&
      profiles.get("codex-compat-2025-11-25")?.tool_inventory_route ===
        "/api/mcp/2025-11-25",
    "invalid_client_profile_registry",
  );

  exactKeys(registry.assertion_ids, ["local", "hosted"], "invalid_assertion_registry");
  uniqueStrings(registry.assertion_ids.local, "invalid_local_assertion_registry");
  uniqueStrings(registry.assertion_ids.hosted, "invalid_hosted_assertion_registry");
  const localAssertions = new Set(registry.assertion_ids.local);
  const hostedAssertions = new Set(registry.assertion_ids.hosted);
  assert([...localAssertions].every((id) => id.startsWith("local.")), "invalid_local_assertion_registry");
  assert([...hostedAssertions].every((id) => id.startsWith("hosted.")), "invalid_hosted_assertion_registry");

  assert(Array.isArray(registry.local_command_groups), "invalid_local_command_groups");
  const commandAssertions = new Set([
    "local.registry.closed-versioned",
    "local.fixtures.deterministic-streamed",
  ]);
  for (const group of registry.local_command_groups) {
    exactKeys(group, ["id", "command", "assertion_ids"], "invalid_local_command_group");
    assert(SAFE_ID.test(group.id), "invalid_local_command_group");
    uniqueStrings(group.command, "invalid_local_command_group");
    assert(group.command[0] === "node", "invalid_local_command_group");
    uniqueStrings(group.assertion_ids, "invalid_local_command_group");
    for (const id of group.assertion_ids) {
      assert(localAssertions.has(id), "unknown_local_command_assertion");
      assert(!commandAssertions.has(id), "duplicate_local_command_assertion");
      commandAssertions.add(id);
    }
  }
  assert(
    exactArray([...commandAssertions].sort(), [...localAssertions].sort()),
    "unowned_local_assertion",
  );

  exactKeys(fixtures, ["schema", "fixtures"], "invalid_fixture_plan");
  assert(fixtures.schema === FIXTURE_SCHEMA, "invalid_fixture_schema");
  assert(Array.isArray(fixtures.fixtures), "invalid_fixture_plan");
  const fixtureMap = new Map();
  for (const fixture of fixtures.fixtures) {
    exactKeys(
      fixture,
      [
        "id",
        "source_kind",
        "materialization",
        "size_bytes",
        "chunk_bytes",
        "fill_byte",
        "sha256",
      ],
      "invalid_fixture",
    );
    assert(SAFE_ID.test(fixture.id), "invalid_fixture");
    assert(sourceKinds.includes(fixture.source_kind), "invalid_fixture_source_kind");
    assert(fixture.materialization === "repeated_byte_stream", "invalid_fixture_materialization");
    assert(Number.isSafeInteger(fixture.size_bytes) && fixture.size_bytes >= 0, "invalid_fixture_size");
    assert(Number.isSafeInteger(fixture.chunk_bytes) && fixture.chunk_bytes > 0 && fixture.chunk_bytes <= 1_048_576, "invalid_fixture_chunk");
    assert(Number.isInteger(fixture.fill_byte) && fixture.fill_byte >= 0 && fixture.fill_byte <= 255, "invalid_fixture_byte");
    assert(SHA256.test(fixture.sha256), "invalid_fixture_digest");
    assert(!fixtureMap.has(fixture.id), "duplicate_fixture");
    fixtureMap.set(fixture.id, fixture);
  }

  assert(Array.isArray(registry.rows), "invalid_rows");
  const rows = new Map();
  const expectedRows = [];
  for (const profile of registry.client_profiles) {
    for (const sourceKind of sourceKinds) {
      expectedRows.push([profile.id, sourceKind]);
    }
  }
  assert(registry.rows.length === expectedRows.length, "invalid_row_count");
  for (let index = 0; index < registry.rows.length; index += 1) {
    const row = registry.rows[index];
    exactKeys(
      row,
      [
        "id",
        "evidence_scope",
        "source_kind",
        "transport_id",
        "client_profile_id",
        "actor_class",
        "credential_class",
        "snapshot_semantics",
        "external_prerequisite",
        "human_only_boundary",
        "fixture_ids",
        "pass_assertion_ids",
        "not_available_assertion_ids",
      ],
      "invalid_row",
    );
    const [expectedProfileId, expectedSourceKind] = expectedRows[index];
    assert(row.client_profile_id === expectedProfileId, "invalid_row_order");
    assert(row.source_kind === expectedSourceKind, "invalid_row_order");
    const profile = profiles.get(row.client_profile_id);
    assert(row.evidence_scope === profile.environment, "invalid_row_scope");
    assert(row.transport_id === EXPECTED_TRANSPORTS[row.source_kind], "invalid_row_transport");
    assert(row.snapshot_semantics === EXPECTED_SNAPSHOTS[row.source_kind], "invalid_row_snapshot");
    assert(SAFE_ID.test(row.id) && !rows.has(row.id), "invalid_row_id");
    safeString(row.actor_class, "invalid_row_actor_class");
    safeString(row.credential_class, "invalid_row_credential_class");
    safeString(row.external_prerequisite, "invalid_row_prerequisite");
    assert(row.human_only_boundary === "none", "invalid_row_human_boundary");
    uniqueStrings(row.fixture_ids, "invalid_row_fixtures");
    for (const fixtureId of row.fixture_ids) {
      const fixture = fixtureMap.get(fixtureId);
      assert(fixture?.source_kind === row.source_kind, "invalid_row_fixture_source");
    }
    uniqueStrings(row.pass_assertion_ids, "invalid_row_assertions");
    uniqueStrings(row.not_available_assertion_ids, "invalid_row_assertions");
    const allowed = row.evidence_scope === "local_contract" ? localAssertions : hostedAssertions;
    assert(row.pass_assertion_ids.every((id) => allowed.has(id)), "unknown_row_assertion");
    assert(row.not_available_assertion_ids.every((id) => allowed.has(id)), "unknown_row_assertion");
    if (row.evidence_scope === "local_contract") {
      assert(row.actor_class === "synthetic_registered_principal", "invalid_local_actor_class");
      assert(row.credential_class === "synthetic_mcp_content_write", "invalid_local_credential_class");
      assert(row.not_available_assertion_ids.length === 0, "invalid_local_not_available_contract");
    } else {
      assert(row.actor_class === "synthetic_registered_principal", "invalid_hosted_actor_class");
      assert(row.credential_class === "synthetic_oauth_content_write", "invalid_hosted_credential_class");
      assert(row.not_available_assertion_ids.length > 0, "missing_hosted_not_available_contract");
    }
    rows.set(row.id, row);
  }
  const referencedFixtures = new Set(registry.rows.flatMap((row) => row.fixture_ids));
  assert(
    exactArray([...referencedFixtures].sort(), [...fixtureMap.keys()].sort()),
    "orphaned_fixture",
  );
  return Object.freeze({ profiles, rows, fixtureMap });
}

export async function* deterministicFixtureChunks(fixture) {
  const chunk = new Uint8Array(fixture.chunk_bytes).fill(fixture.fill_byte);
  let remaining = fixture.size_bytes;
  while (remaining > 0) {
    const take = Math.min(remaining, chunk.byteLength);
    yield take === chunk.byteLength ? chunk : chunk.subarray(0, take);
    remaining -= take;
  }
}

export async function verifyDeterministicFixtures(fixtures) {
  for (const fixture of fixtures.fixtures) {
    const digest = createHash("sha256");
    let size = 0;
    let largestChunk = 0;
    for await (const chunk of deterministicFixtureChunks(fixture)) {
      size += chunk.byteLength;
      largestChunk = Math.max(largestChunk, chunk.byteLength);
      digest.update(chunk);
    }
    assert(size === fixture.size_bytes, "fixture_size_mismatch");
    assert(largestChunk <= fixture.chunk_bytes, "fixture_chunk_mismatch");
    assert(`sha256:${digest.digest("hex")}` === fixture.sha256, "fixture_digest_mismatch");
  }
  return true;
}

export function resolveCandidateSha(repositoryRoot, candidate) {
  try {
    const result = execFileSync(
      "git",
      ["rev-parse", "--verify", `${candidate}^{commit}`],
      { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    assert(GIT_SHA.test(result), "invalid_candidate_sha");
    return result;
  } catch (error) {
    fail("candidate_not_found", error.stderr?.trim() || error.message);
  }
}

export function createLocalReceipt({
  registry,
  candidateSha,
  registrySha256,
  fixturePlanSha256,
  assertionStatuses,
}) {
  assert(GIT_SHA.test(candidateSha), "invalid_candidate_sha");
  const assertions = registry.assertion_ids.local.map((id) => Object.freeze({
    id,
    status: assertionStatuses.get(id) ?? "not_run",
  }));
  const map = new Map(assertions.map(({ id, status }) => [id, status]));
  const localRows = registry.rows.filter(({ evidence_scope }) => evidence_scope === "local_contract");
  const rows = localRows.map((row) => Object.freeze({
    row_id: row.id,
    status: rowStatus(map, row.pass_assertion_ids),
    assertion_ids: Object.freeze([...row.pass_assertion_ids]),
  }));
  const status = aggregate(rows.map((row) => row.status));
  return sealDocument(Object.freeze({
    schema: LOCAL_RECEIPT_SCHEMA,
    status,
    candidate_sha: candidateSha,
    registry_sha256: registrySha256,
    fixture_plan_sha256: fixturePlanSha256,
    client_profile_id: "repository-node-test-v1",
    actor_class: "synthetic_registered_principal",
    credential_class: "synthetic_mcp_content_write",
    assertions: Object.freeze(assertions),
    rows: Object.freeze(rows),
  }));
}

export function validateLocalReceipt(
  receipt,
  { registry, candidateSha, registrySha256, fixturePlanSha256 },
) {
  exactKeys(
    receipt,
    [
      "schema",
      "status",
      "candidate_sha",
      "registry_sha256",
      "fixture_plan_sha256",
      "client_profile_id",
      "actor_class",
      "credential_class",
      "assertions",
      "rows",
      "artifact_sha256",
    ],
    "invalid_local_receipt",
  );
  assert(receipt.schema === LOCAL_RECEIPT_SCHEMA, "invalid_local_receipt_schema");
  assert(receipt.candidate_sha === candidateSha, "local_candidate_sha_mismatch");
  assert(receipt.registry_sha256 === registrySha256, "local_registry_sha_mismatch");
  assert(receipt.fixture_plan_sha256 === fixturePlanSha256, "local_fixture_sha_mismatch");
  assert(receipt.client_profile_id === "repository-node-test-v1", "invalid_local_profile");
  assert(receipt.actor_class === "synthetic_registered_principal", "invalid_local_actor_class");
  assert(receipt.credential_class === "synthetic_mcp_content_write", "invalid_local_credential_class");
  const assertions = assertionMap(
    receipt.assertions,
    registry.assertion_ids.local,
    "invalid_local_receipt_assertions",
  );
  const localRows = registry.rows.filter(({ evidence_scope }) => evidence_scope === "local_contract");
  assert(Array.isArray(receipt.rows) && receipt.rows.length === localRows.length, "invalid_local_receipt_rows");
  for (let index = 0; index < localRows.length; index += 1) {
    const expected = localRows[index];
    const row = receipt.rows[index];
    exactKeys(row, ["row_id", "status", "assertion_ids"], "invalid_local_receipt_row");
    assert(row.row_id === expected.id, "invalid_local_receipt_row");
    assert(exactArray(row.assertion_ids, expected.pass_assertion_ids), "invalid_local_receipt_row");
    assert(row.status === rowStatus(assertions, expected.pass_assertion_ids), "invalid_local_receipt_row_status");
  }
  assert(receipt.status === aggregate(receipt.rows.map((row) => row.status)), "invalid_local_receipt_status");
  validateArtifactDigest(receipt, "invalid_local_receipt_digest");
  return receipt;
}

function targetFingerprint(hostedAuthority, candidateSha, siteVersionId, deploymentId) {
  return `sha256:${sha256(canonicalJson({
    candidate_sha: candidateSha,
    deployment_id: deploymentId,
    live_url: hostedAuthority.live_url,
    provider: hostedAuthority.provider,
    release_profile_sha256: hostedAuthority.release_profile_sha256,
    site_project_id: hostedAuthority.site_project_id,
    site_version_id: siteVersionId,
    target_config_sha256: hostedAuthority.target_config_sha256,
  }))}`;
}

export function createHostedDeploymentAnchor({
  candidateSha,
  hostedAuthority,
  siteVersionId,
  deploymentId,
}) {
  assert(GIT_SHA.test(candidateSha), "invalid_candidate_sha");
  assert(SAFE_PROVIDER_ID.test(siteVersionId), "invalid_hosted_deployment_anchor");
  assert(SAFE_PROVIDER_ID.test(deploymentId), "invalid_hosted_deployment_anchor");
  return sealDocument({
    schema: HOSTED_DEPLOYMENT_ANCHOR_SCHEMA,
    candidate_sha: candidateSha,
    provider: hostedAuthority.provider,
    product_environment: hostedAuthority.product_environment,
    target_kind: hostedAuthority.target_kind,
    site_project_id: hostedAuthority.site_project_id,
    site_version_id: siteVersionId,
    deployment_id: deploymentId,
    live_url: hostedAuthority.live_url,
    target_config_sha256: hostedAuthority.target_config_sha256,
    release_profile_sha256: hostedAuthority.release_profile_sha256,
    target_fingerprint: targetFingerprint(
      hostedAuthority,
      candidateSha,
      siteVersionId,
      deploymentId,
    ),
    provenance: Object.freeze({
      kind: "trusted_sites_control_plane_runner",
      receipt_schema: "ship-work-release/sites-deployment-result/v1",
      cryptographic_attestation: "unavailable",
    }),
  });
}

export function validateHostedDeploymentAnchor(
  anchor,
  { candidateSha, hostedAuthority },
) {
  exactKeys(
    anchor,
    [
      "schema",
      "candidate_sha",
      "provider",
      "product_environment",
      "target_kind",
      "site_project_id",
      "site_version_id",
      "deployment_id",
      "live_url",
      "target_config_sha256",
      "release_profile_sha256",
      "target_fingerprint",
      "provenance",
      "artifact_sha256",
    ],
    "invalid_hosted_deployment_anchor",
  );
  assert(anchor.schema === HOSTED_DEPLOYMENT_ANCHOR_SCHEMA, "invalid_hosted_deployment_anchor_schema");
  assert(anchor.candidate_sha === candidateSha, "hosted_deployment_candidate_sha_mismatch");
  assert(anchor.provider === hostedAuthority.provider, "hosted_deployment_target_mismatch");
  assert(
    anchor.product_environment === hostedAuthority.product_environment &&
      anchor.target_kind === hostedAuthority.target_kind,
    "hosted_deployment_target_mismatch",
  );
  assert(anchor.site_project_id === hostedAuthority.site_project_id, "hosted_deployment_project_mismatch");
  assert(anchor.live_url === hostedAuthority.live_url, "hosted_deployment_url_mismatch");
  assert(SAFE_PROVIDER_ID.test(anchor.site_version_id), "invalid_hosted_deployment_anchor");
  assert(SAFE_PROVIDER_ID.test(anchor.deployment_id), "invalid_hosted_deployment_anchor");
  assert(
    anchor.target_config_sha256 === hostedAuthority.target_config_sha256 &&
      anchor.release_profile_sha256 === hostedAuthority.release_profile_sha256,
    "hosted_deployment_profile_mismatch",
  );
  assert(
    anchor.target_fingerprint === targetFingerprint(
      hostedAuthority,
      candidateSha,
      anchor.site_version_id,
      anchor.deployment_id,
    ),
    "hosted_deployment_fingerprint_mismatch",
  );
  exactKeys(
    anchor.provenance,
    ["kind", "receipt_schema", "cryptographic_attestation"],
    "invalid_hosted_deployment_provenance",
  );
  assert(
    anchor.provenance.kind === "trusted_sites_control_plane_runner" &&
      anchor.provenance.receipt_schema === "ship-work-release/sites-deployment-result/v1" &&
      anchor.provenance.cryptographic_attestation === "unavailable",
    "invalid_hosted_deployment_provenance",
  );
  validateArtifactDigest(anchor, "invalid_hosted_deployment_anchor_digest");
  return anchor;
}

function deploymentProjection(anchor) {
  return Object.freeze({
    provider: anchor.provider,
    product_environment: anchor.product_environment,
    target_kind: anchor.target_kind,
    site_project_id: anchor.site_project_id,
    site_version_id: anchor.site_version_id,
    deployment_id: anchor.deployment_id,
    live_url: anchor.live_url,
    candidate_sha: anchor.candidate_sha,
    target_fingerprint: anchor.target_fingerprint,
  });
}

function validateDeployment(deployment, anchor) {
  exactKeys(
    deployment,
    [
      "provider",
      "product_environment",
      "target_kind",
      "site_project_id",
      "site_version_id",
      "deployment_id",
      "live_url",
      "candidate_sha",
      "target_fingerprint",
    ],
    "invalid_hosted_deployment",
  );
  assert(
    canonicalJson(deployment) === canonicalJson(deploymentProjection(anchor)),
    "hosted_deployment_anchor_mismatch",
  );
}

function validateArtifactTuple(tuple, code) {
  exactKeys(tuple, ["canonical_path", "sha256", "size"], code);
  assert(
    typeof tuple.canonical_path === "string" &&
      /^synthetic\/md314\/[a-z0-9][a-z0-9._/-]{0,255}$/u.test(tuple.canonical_path) &&
      !tuple.canonical_path.split("/").some((segment) => segment === "." || segment === ".."),
    code,
  );
  assert(SHA256.test(tuple.sha256), code);
  assert(Number.isSafeInteger(tuple.size) && tuple.size >= 0 && tuple.size <= 268_435_456, code);
}

function validateArtifactObservations(observations, registryRow) {
  exactKeys(
    observations,
    ["source_snapshot", "commit", "history", "download", "web_export", "post_redeploy"],
    "invalid_hosted_artifact_observations",
  );
  exactKeys(
    observations.source_snapshot,
    ["sha256", "size", "snapshot_semantics", "snapshot_fingerprint"],
    "invalid_hosted_source_snapshot",
  );
  assert(observations.source_snapshot.snapshot_semantics === registryRow.snapshot_semantics, "hosted_snapshot_semantics_mismatch");
  assert(SHA256.test(observations.source_snapshot.snapshot_fingerprint), "invalid_hosted_source_snapshot");
  assert(SHA256.test(observations.source_snapshot.sha256), "invalid_hosted_source_snapshot");
  assert(Number.isSafeInteger(observations.source_snapshot.size) && observations.source_snapshot.size >= 0, "invalid_hosted_source_snapshot");
  const names = ["commit", "history", "download", "web_export", "post_redeploy"];
  for (const name of names) validateArtifactTuple(observations[name], "invalid_hosted_artifact_tuple");
  const canonical = canonicalJson(observations.commit);
  assert(names.every((name) => canonicalJson(observations[name]) === canonical), "hosted_artifact_readback_mismatch");
  assert(observations.source_snapshot.sha256 === observations.commit.sha256, "hosted_source_artifact_mismatch");
  assert(observations.source_snapshot.size === observations.commit.size, "hosted_source_artifact_mismatch");
}

function validateMixedChangeset(value, passingRows, failedRows) {
  exactKeys(
    value,
    [
      "status",
      "row_ids",
      "revision_fingerprint",
      "markdown_sha256",
      "head_transitions",
      "post_redeploy",
      "error_code",
    ],
    "invalid_hosted_mixed_changeset",
  );
  uniqueStrings(value.row_ids, "invalid_hosted_mixed_changeset");
  if (failedRows.length > 0) {
    assert(value.status === "failed", "invalid_hosted_mixed_changeset");
    assert(exactArray(value.row_ids, passingRows.map(({ row_id }) => row_id)), "invalid_hosted_mixed_changeset");
    assert(value.revision_fingerprint === null || SHA256.test(value.revision_fingerprint), "invalid_hosted_mixed_changeset");
    assert(value.markdown_sha256 === null || SHA256.test(value.markdown_sha256), "invalid_hosted_mixed_changeset");
    assert(Number.isSafeInteger(value.head_transitions) && value.head_transitions >= 0 && value.head_transitions <= 1, "invalid_hosted_mixed_changeset");
    assert(typeof value.post_redeploy === "boolean", "invalid_hosted_mixed_changeset");
    assert(FAILED_CODES.includes(value.error_code), "invalid_hosted_mixed_changeset");
    return;
  }
  if (passingRows.length === 0) {
    assert(value.status === "not_available", "invalid_hosted_mixed_changeset");
    assert(value.row_ids.length === 0, "invalid_hosted_mixed_changeset");
    assert(value.revision_fingerprint === null && value.markdown_sha256 === null, "invalid_hosted_mixed_changeset");
    assert(value.head_transitions === 0 && value.post_redeploy === false, "invalid_hosted_mixed_changeset");
    assert(NOT_AVAILABLE_CODES.includes(value.error_code), "invalid_hosted_mixed_changeset");
    return;
  }
  assert(value.status === "passed", "invalid_hosted_mixed_changeset");
  assert(exactArray(value.row_ids, passingRows.map(({ row_id }) => row_id)), "invalid_hosted_mixed_changeset");
  assert(SHA256.test(value.revision_fingerprint), "invalid_hosted_mixed_changeset");
  assert(SHA256.test(value.markdown_sha256), "invalid_hosted_mixed_changeset");
  assert(value.head_transitions === 1 && value.post_redeploy === true, "invalid_hosted_mixed_changeset");
  assert(value.error_code === null, "invalid_hosted_mixed_changeset");
}

export function validateHostedReceipt(
  receipt,
  {
    registry,
    candidateSha,
    registrySha256,
    toolInventory,
    hostedAuthority,
    hostedDeploymentAnchor,
  },
) {
  exactKeys(
    receipt,
    [
      "schema",
      "status",
      "candidate_sha",
      "registry_sha256",
      "client_profile_id",
      "actor_class",
      "credential_class",
      "client_snapshot",
      "deployment",
      "setup_cleanup",
      "mixed_changeset",
      "assertions",
      "rows",
      "artifact_sha256",
    ],
    "invalid_hosted_receipt",
  );
  assert(receipt.schema === HOSTED_RECEIPT_SCHEMA, "invalid_hosted_receipt_schema");
  assert(receipt.candidate_sha === candidateSha, "hosted_candidate_sha_mismatch");
  assert(receipt.registry_sha256 === registrySha256, "hosted_registry_sha_mismatch");
  const profile = registry.client_profiles.find(({ id }) => id === receipt.client_profile_id);
  assert(profile?.environment === "hosted_uat", "invalid_hosted_profile");
  const profileRows = registry.rows.filter(({ client_profile_id }) => client_profile_id === profile.id);
  assert(receipt.actor_class === profileRows[0].actor_class, "invalid_hosted_actor_class");
  assert(receipt.credential_class === profileRows[0].credential_class, "invalid_hosted_credential_class");
  validateToolInventory(toolInventory);
  validateHostedDeploymentAnchor(hostedDeploymentAnchor, { candidateSha, hostedAuthority });

  exactKeys(
    receipt.client_snapshot,
    [
      "client_class",
      "client_name",
      "client_version",
      "protocol_profile",
      "tool_inventory_route",
      "host_fingerprint",
      "plugin_package",
      "tool_inventory",
      "tool_inventory_sha256",
      "capture_boundary",
      "captured_at",
    ],
    "invalid_hosted_client_snapshot",
  );
  assert(receipt.client_snapshot.client_class === profile.client_class, "invalid_hosted_client_snapshot");
  assert(receipt.client_snapshot.client_name === profile.client_name, "invalid_hosted_client_snapshot");
  assert(
    CODEX_VERSION.test(receipt.client_snapshot.client_version) &&
      receipt.client_snapshot.client_version === profile.client_version,
    "invalid_hosted_client_version",
  );
  assert(receipt.client_snapshot.protocol_profile === profile.protocol_profile, "invalid_hosted_client_snapshot");
  assert(
    receipt.client_snapshot.tool_inventory_route === profile.tool_inventory_route,
    "invalid_hosted_client_snapshot",
  );
  assert(SHA256.test(receipt.client_snapshot.host_fingerprint), "invalid_hosted_client_snapshot");
  exactKeys(
    receipt.client_snapshot.plugin_package,
    [
      "plugin_id",
      "plugin_version",
      "plugin_snapshot_sha256",
      "marketplace_candidate_sha",
      "marketplace_tree_sha",
    ],
    "invalid_hosted_plugin_snapshot",
  );
  assert(
    canonicalJson(receipt.client_snapshot.plugin_package) ===
      canonicalJson(registry.hosted_authority.plugin_package),
    "hosted_plugin_snapshot_mismatch",
  );
  assert(Array.isArray(receipt.client_snapshot.tool_inventory), "invalid_hosted_client_snapshot");
  assert(
    `sha256:${sha256(canonicalJson(receipt.client_snapshot.tool_inventory))}` ===
      receipt.client_snapshot.tool_inventory_sha256,
    "hosted_tool_inventory_digest_mismatch",
  );
  assert(
    canonicalJson(receipt.client_snapshot.tool_inventory) === canonicalJson(toolInventory.entries),
    "hosted_tool_inventory_contract_mismatch",
  );
  assert(
    receipt.client_snapshot.capture_boundary ===
      registry.hosted_authority.trusted_runner_boundary,
    "invalid_hosted_client_capture_boundary",
  );
  assert(Number.isFinite(Date.parse(receipt.client_snapshot.captured_at)), "invalid_hosted_client_snapshot");
  validateDeployment(receipt.deployment, hostedDeploymentAnchor);

  exactKeys(
    receipt.setup_cleanup,
    [
      "fixture_namespace",
      "synthetic_only",
      "setup_replayed",
      "recovery_replayed",
      "cleanup_replayed",
      "remaining_side_effects",
    ],
    "invalid_hosted_setup_cleanup",
  );
  assert(/^md314-synthetic-[a-z0-9-]{1,64}$/u.test(receipt.setup_cleanup.fixture_namespace), "invalid_hosted_fixture_namespace");
  assert(typeof receipt.setup_cleanup.synthetic_only === "boolean", "invalid_hosted_setup_cleanup");
  assert(typeof receipt.setup_cleanup.setup_replayed === "boolean", "invalid_hosted_setup_cleanup");
  assert(typeof receipt.setup_cleanup.recovery_replayed === "boolean", "invalid_hosted_setup_cleanup");
  assert(typeof receipt.setup_cleanup.cleanup_replayed === "boolean", "invalid_hosted_setup_cleanup");
  assert(Number.isSafeInteger(receipt.setup_cleanup.remaining_side_effects) && receipt.setup_cleanup.remaining_side_effects >= 0, "invalid_hosted_setup_cleanup");

  const assertions = assertionMap(
    receipt.assertions,
    registry.assertion_ids.hosted,
    "invalid_hosted_receipt_assertions",
  );
  assert(Array.isArray(receipt.rows) && receipt.rows.length === profileRows.length, "invalid_hosted_receipt_rows");
  for (let index = 0; index < profileRows.length; index += 1) {
    const expected = profileRows[index];
    const row = receipt.rows[index];
    exactKeys(
      row,
      [
        "row_id",
        "status",
        "assertion_ids",
        "error_code",
        "unexpected_side_effect_count",
        "artifact_observations",
      ],
      "invalid_hosted_receipt_row",
    );
    assert(row.row_id === expected.id, "invalid_hosted_receipt_row");
    assert(ROW_STATUSES.includes(row.status), "invalid_hosted_receipt_row");
    uniqueStrings(row.assertion_ids, "invalid_hosted_receipt_row");
    assert(Number.isSafeInteger(row.unexpected_side_effect_count) && row.unexpected_side_effect_count >= 0, "invalid_hosted_receipt_row");
    const required = row.status === "passed"
      ? expected.pass_assertion_ids
      : row.status === "not_available"
        ? expected.not_available_assertion_ids
        : row.assertion_ids;
    assert(exactArray(row.assertion_ids, required), "invalid_hosted_receipt_row_assertions");
    if (row.status === "passed") {
      assert(required.every((id) => assertions.get(id) === "passed"), "hosted_required_assertion_not_passed");
      assert(row.error_code === null && row.unexpected_side_effect_count === 0, "invalid_hosted_passed_row");
      validateArtifactObservations(row.artifact_observations, expected);
    } else if (row.status === "not_available") {
      assert(required.every((id) => assertions.get(id) === "passed"), "hosted_required_assertion_not_passed");
      assert(NOT_AVAILABLE_CODES.includes(row.error_code), "invalid_hosted_not_available_row");
      assert(row.unexpected_side_effect_count === 0, "hosted_not_available_side_effect");
      assert(row.artifact_observations === null, "invalid_hosted_not_available_row");
    } else {
      assert(required.length > 0 && required.every((id) => registry.assertion_ids.hosted.includes(id)), "invalid_hosted_failed_row");
      assert(required.some((id) => assertions.get(id) === "failed"), "invalid_hosted_failed_row");
      assert(FAILED_CODES.includes(row.error_code), "invalid_hosted_failed_row");
      assert(row.artifact_observations === null, "invalid_hosted_failed_row");
    }
  }
  const nonFailedRows = receipt.rows.filter(({ status }) => status !== "failed");
  if (nonFailedRows.length > 0) {
    assert(receipt.setup_cleanup.synthetic_only === true, "hosted_setup_not_synthetic");
    assert(receipt.setup_cleanup.setup_replayed === true, "hosted_setup_not_idempotent");
    assert(receipt.setup_cleanup.recovery_replayed === true, "hosted_recovery_not_idempotent");
    assert(receipt.setup_cleanup.cleanup_replayed === true, "hosted_cleanup_not_idempotent");
    assert(receipt.setup_cleanup.remaining_side_effects === 0, "hosted_cleanup_incomplete");
  }
  validateMixedChangeset(
    receipt.mixed_changeset,
    receipt.rows.filter(({ status }) => status === "passed"),
    receipt.rows.filter(({ status }) => status === "failed"),
  );
  assert(receipt.status === aggregate(receipt.rows.map(({ status }) => status)), "invalid_hosted_receipt_status");
  validateArtifactDigest(receipt, "invalid_hosted_receipt_digest");
  return receipt;
}

function receiptIdentity(receipt) {
  return canonicalJson(receipt.deployment);
}

function pendingRow(registryRow, code) {
  return Object.freeze({
    ...registryRowProjection(registryRow),
    status: "pending",
    status_code: code,
    assertion_statuses: Object.freeze([]),
  });
}

function invalidRows(rows, code) {
  return rows.map((row) => Object.freeze({
    ...registryRowProjection(row),
    status: "failed",
    status_code: code,
    assertion_statuses: Object.freeze([]),
  }));
}

function registryRowProjection(row) {
  return Object.freeze({
    row_id: row.id,
    evidence_scope: row.evidence_scope,
    source_kind: row.source_kind,
    transport_id: row.transport_id,
    client_profile_id: row.client_profile_id,
    actor_class: row.actor_class,
    credential_class: row.credential_class,
    snapshot_semantics: row.snapshot_semantics,
    external_prerequisite: row.external_prerequisite,
    human_only_boundary: row.human_only_boundary,
  });
}

function projectedReceiptRow(registryRow, receiptRow, assertionMapValue) {
  const assertionStatuses = receiptRow.assertion_ids.map((id) => Object.freeze({
    id,
    status: assertionMapValue.get(id),
  }));
  return Object.freeze({
    ...registryRowProjection(registryRow),
    status: receiptRow.status,
    status_code: receiptRow.status === "passed" ? null : receiptRow.error_code,
    assertion_statuses: Object.freeze(assertionStatuses),
  });
}

function gapRows(rows) {
  const gaps = [];
  for (const row of rows) {
    if (row.status === "passed") continue;
    const failedAssertions = row.assertion_statuses.filter(({ status }) => status !== "passed");
    if (failedAssertions.length === 0) {
      gaps.push(Object.freeze({
        row_id: row.row_id,
        assertion_id: null,
        status: row.status,
        code: row.status_code,
      }));
      continue;
    }
    for (const assertion of failedAssertions) {
      gaps.push(Object.freeze({
        row_id: row.row_id,
        assertion_id: assertion.id,
        status: assertion.status === "not_run" ? "pending" : assertion.status,
        code: row.status_code,
      }));
    }
  }
  return Object.freeze(gaps);
}

export function joinFileIngressEvidence({
  registry,
  fixtures,
  toolInventory,
  hostedAuthority,
  candidateSha,
  registrySha256,
  fixturePlanSha256,
  localReceipt = null,
  hostedReceipts = [],
  hostedDeploymentAnchor = null,
}) {
  validateFileIngressEvidenceConfig(registry, fixtures, toolInventory);
  assert(GIT_SHA.test(candidateSha), "invalid_candidate_sha");
  assert(SHA256_HEX.test(registrySha256), "invalid_registry_sha");
  assert(SHA256_HEX.test(fixturePlanSha256), "invalid_fixture_plan_sha");
  const localRegistryRows = registry.rows.filter(({ evidence_scope }) => evidence_scope === "local_contract");
  let localRows;
  if (localReceipt === null) {
    localRows = localRegistryRows.map((row) => pendingRow(row, "local_receipt_missing"));
  } else {
    try {
      validateLocalReceipt(localReceipt, {
        registry,
        candidateSha,
        registrySha256,
        fixturePlanSha256,
      });
      const assertions = new Map(localReceipt.assertions.map(({ id, status }) => [id, status]));
      localRows = localRegistryRows.map((row, index) => {
        const receiptRow = localReceipt.rows[index];
        return Object.freeze({
          ...registryRowProjection(row),
          status: receiptRow.status,
          status_code: receiptRow.status === "passed" ? null : "local_assertion_failed",
          assertion_statuses: Object.freeze(receiptRow.assertion_ids.map((id) => Object.freeze({
            id,
            status: assertions.get(id),
          }))),
        });
      });
    } catch (error) {
      localRows = invalidRows(
        localRegistryRows,
        error instanceof FileIngressEvidenceError ? error.code : "invalid_local_receipt",
      );
    }
  }

  const hostedProfiles = registry.client_profiles.filter(({ environment }) => environment === "hosted_uat");
  const hostedProfileIds = new Set(hostedProfiles.map(({ id }) => id));
  const byProfile = new Map();
  const duplicateProfiles = new Set();
  let unknownProfile = false;
  for (const receipt of hostedReceipts) {
    const profileId = receipt?.client_profile_id;
    if (!hostedProfileIds.has(profileId)) {
      unknownProfile = true;
      continue;
    }
    if (byProfile.has(profileId)) duplicateProfiles.add(profileId);
    else byProfile.set(profileId, receipt);
  }
  const validatedHosted = new Map();
  const hostedFailures = new Map();
  if (hostedReceipts.length > 0) {
    if (hostedDeploymentAnchor === null) {
      for (const profile of hostedProfiles) {
        hostedFailures.set(profile.id, "hosted_deployment_anchor_missing");
      }
    } else {
      try {
        validateHostedDeploymentAnchor(hostedDeploymentAnchor, { candidateSha, hostedAuthority });
      } catch (error) {
        const code = error instanceof FileIngressEvidenceError
          ? error.code
          : "invalid_hosted_deployment_anchor";
        for (const profile of hostedProfiles) hostedFailures.set(profile.id, code);
      }
    }
  }
  if (unknownProfile) {
    for (const profile of hostedProfiles) {
      hostedFailures.set(profile.id, "unknown_hosted_receipt_profile");
    }
  }
  for (const profile of hostedProfiles) {
    if (hostedFailures.has(profile.id)) continue;
    const receipt = byProfile.get(profile.id);
    if (duplicateProfiles.has(profile.id)) {
      hostedFailures.set(profile.id, "duplicate_hosted_receipt");
      continue;
    }
    if (receipt === undefined) continue;
    try {
      validatedHosted.set(
        profile.id,
        validateHostedReceipt(receipt, {
          registry,
          candidateSha,
          registrySha256,
          toolInventory,
          hostedAuthority,
          hostedDeploymentAnchor,
        }),
      );
    } catch (error) {
      hostedFailures.set(
        profile.id,
        error instanceof FileIngressEvidenceError ? error.code : "invalid_hosted_receipt",
      );
    }
  }
  const identities = new Set([...validatedHosted.values()].map(receiptIdentity));
  if (identities.size > 1) {
    for (const profileId of validatedHosted.keys()) {
      hostedFailures.set(profileId, "cross_profile_deployment_mismatch");
    }
    validatedHosted.clear();
  }

  const hostedRows = [];
  for (const profile of hostedProfiles) {
    const profileRows = registry.rows.filter(({ client_profile_id }) => client_profile_id === profile.id);
    const failure = hostedFailures.get(profile.id);
    if (failure !== undefined) {
      hostedRows.push(...invalidRows(profileRows, failure));
      continue;
    }
    const receipt = validatedHosted.get(profile.id);
    if (receipt === undefined) {
      hostedRows.push(...profileRows.map((row) => pendingRow(row, "hosted_receipt_missing")));
      continue;
    }
    const assertions = new Map(receipt.assertions.map(({ id, status }) => [id, status]));
    for (let index = 0; index < profileRows.length; index += 1) {
      hostedRows.push(projectedReceiptRow(profileRows[index], receipt.rows[index], assertions));
    }
  }

  const rows = Object.freeze([...localRows, ...hostedRows]);
  const summary = Object.freeze({
    passed: rows.filter(({ status }) => status === "passed").length,
    not_available: rows.filter(({ status }) => status === "not_available").length,
    pending: rows.filter(({ status }) => status === "pending").length,
    failed: rows.filter(({ status }) => status === "failed").length,
  });
  const status = aggregate(rows.map(({ status: rowState }) => rowState));
  const deployment = identities.size === 1
    ? deploymentProjection(hostedDeploymentAnchor)
    : null;
  return Object.freeze({
    schema: REPORT_SCHEMA,
    release: registry.release,
    candidate_sha: candidateSha,
    registry: Object.freeze({ path: REGISTRY_PATH, sha256: registrySha256 }),
    fixture_plan: Object.freeze({ path: FIXTURE_PLAN_PATH, sha256: fixturePlanSha256 }),
    status,
    summary,
    deployment,
    rows,
    gaps: gapRows(rows),
  });
}
