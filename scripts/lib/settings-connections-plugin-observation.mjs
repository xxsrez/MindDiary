import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { MCP_TOOL_DEFINITIONS } from "../../packages/adapter-mcp/dist/index.js";
import {
  canonical,
  candidateSha,
  digest,
  fail,
  isRecord,
} from "./multi-principal-probe-core.mjs";
import {
  matchesExactDefaultMcpToolInventory,
  matchesExactMcpToolInventory,
  matchesExactReadOnlyMcpToolInventory,
  matchesExactVerifiedNativeMcpToolInventory,
} from "./exact-mcp-tool-inventory.mjs";
import {
  assertCodexClientVersion,
  assertDirectPackageServer,
  assertFreshOAuthMcpServerProjection,
  assertMarketplaceCheckoutAvailable,
} from "../run-oauth-direct-plugin-probe.mjs";

const execFileAsync = promisify(execFile);
const SCHEMA = "mind-diary/settings-connections-plugin-observation/v1";
const CLIENT = "codex-cli";
const CLIENT_VERSION = "0.153.4";
const ROUTES = Object.freeze(["/api/mcp", "/api/mcp/2025-11-25"]);

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function git(root, args) {
  try {
    return (await execFileAsync("git", args, {
      cwd: root,
      encoding: args.includes("show") ? "buffer" : "utf8",
      maxBuffer: 8 * 1024 * 1024,
    })).stdout;
  } catch {
    fail("settings_connections_marketplace_git_failed");
  }
}

function parseJson(value, code) {
  try {
    return JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value);
  } catch {
    fail(code);
  }
}

async function marketplaceFiles(root, head) {
  const names = String(await git(root, [
    "ls-tree", "-r", "--name-only", "-z", head, "--", "plugins/mind-diary",
  ])).split("\0").filter(Boolean);
  if (names.length === 0) fail("settings_connections_plugin_tree_empty");
  const files = [];
  for (const name of names) {
    const bytes = await git(root, ["show", `${head}:${name}`]);
    files.push(Object.freeze({
      path: name.slice("plugins/mind-diary/".length),
      size: bytes.byteLength,
      sha256: sha256Bytes(bytes),
    }));
  }
  return Object.freeze(files.sort((left, right) => left.path.localeCompare(right.path)));
}

async function directoryFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await directoryFiles(root, path));
    else if (entry.isFile()) {
      const bytes = await readFile(path);
      files.push(Object.freeze({
        path: relative(root, path).split(sep).join("/"),
        size: bytes.byteLength,
        sha256: sha256Bytes(bytes),
      }));
    } else fail("settings_connections_installed_plugin_entry_unsupported");
  }
  return files;
}

async function codexJson(codexHome, args, code) {
  try {
    const result = await execFileAsync("codex", args, {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    return parseJson(result.stdout, code);
  } catch {
    fail(code);
  }
}

export function verifySettingsConnectionsCatalogProfiles() {
  const full = MCP_TOOL_DEFINITIONS.map(({ name, inputSchema, outputSchema }) => ({
    name,
    inputSchema,
    outputSchema,
  }));
  const apps = full;
  const verifiedNative = full.filter(({ name }) => name !== "open_bundle_file_picker");
  const defaultWrite = full.filter(({ name }) =>
    name !== "open_bundle_file_picker" && name !== "stage_bundle_file");
  const readOnly = full.filter(({ name }) =>
    name !== "open_bundle_file_picker" &&
    name !== "create_file_upload_intent" &&
    name !== "stage_bundle_file");
  if (!matchesExactDefaultMcpToolInventory(defaultWrite) ||
      !matchesExactReadOnlyMcpToolInventory(readOnly) ||
      !matchesExactVerifiedNativeMcpToolInventory(verifiedNative) ||
      !matchesExactMcpToolInventory(apps)) {
    fail("settings_connections_catalog_profile_mismatch");
  }
  return Object.freeze({
    default_product_site_write: defaultWrite.length,
    read_only: readOnly.length,
    verified_native: verifiedNative.length,
  });
}

async function inspectMarketplace(root) {
  await assertMarketplaceCheckoutAvailable(root);
  const status = String(await git(root, ["status", "--porcelain", "--untracked-files=all"]));
  if (status.trim() !== "") fail("settings_connections_marketplace_not_clean");
  const head = candidateSha(String(await git(root, ["rev-parse", "HEAD"])).trim());
  const tree = candidateSha(String(await git(root, ["rev-parse", "HEAD^{tree}"])).trim());
  const files = await marketplaceFiles(root, head);
  const plugin = parseJson(
    await git(root, ["show", `${head}:plugins/mind-diary/.codex-plugin/plugin.json`]),
    "settings_connections_plugin_manifest_invalid",
  );
  const mcp = parseJson(
    await git(root, ["show", `${head}:plugins/mind-diary/.mcp.json`]),
    "settings_connections_plugin_mcp_invalid",
  );
  const catalog = parseJson(
    await git(root, ["show", `${head}:.agents/plugins/marketplace.json`]),
    "settings_connections_marketplace_manifest_invalid",
  );
  const entry = catalog.plugins?.find((candidate) => candidate?.name === "mind-diary");
  if (!isRecord(entry) || entry.policy?.installation !== "AVAILABLE" ||
      entry.policy?.authentication !== "ON_USE" || typeof plugin.version !== "string") {
    fail("settings_connections_marketplace_policy_mismatch");
  }
  assertDirectPackageServer(mcp.mcpServers?.["mind-diary"]);
  return Object.freeze({
    root,
    name: catalog.name,
    head,
    tree,
    files,
    pluginVersion: plugin.version,
    pluginContentSha256: digest(canonical(files)),
    snapshotSha256: digest(canonical({ files, catalog: entry })),
  });
}

async function verifyFreshInstall(snapshot) {
  const codexHome = await mkdtemp(join(tmpdir(), "mind-diary-md358-plugin-"));
  try {
    const version = await execFileAsync("codex", ["--version"], {
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: codexHome },
    }).catch(() => fail("settings_connections_codex_version_unavailable"));
    assertCodexClientVersion(version.stdout);
    const added = await codexJson(codexHome,
      ["plugin", "marketplace", "add", snapshot.root, "--json"],
      "settings_connections_marketplace_add_failed");
    if (added.marketplaceName !== snapshot.name || added.alreadyAdded !== false) {
      fail("settings_connections_marketplace_add_mismatch");
    }
    const installed = await codexJson(codexHome,
      ["plugin", "add", `mind-diary@${snapshot.name}`, "--json"],
      "settings_connections_plugin_install_failed");
    if (installed.version !== snapshot.pluginVersion || installed.authPolicy !== "ON_USE" ||
        typeof installed.installedPath !== "string") {
      fail("settings_connections_plugin_install_mismatch");
    }
    const installedRoot = await realpath(installed.installedPath);
    const homeRoot = `${await realpath(codexHome)}${sep}`;
    if (!`${installedRoot}${sep}`.startsWith(homeRoot) ||
        digest(canonical(await directoryFiles(installedRoot))) !== snapshot.pluginContentSha256) {
      fail("settings_connections_plugin_content_mismatch");
    }
    const mcpList = await codexJson(codexHome, ["mcp", "list", "--json"],
      "settings_connections_mcp_list_failed");
    const server = mcpList.find?.((entry) => entry.name === "mind-diary");
    try {
      assertFreshOAuthMcpServerProjection(
        server,
        "https://mind-diary.example.invalid/api/mcp/2025-11-25",
      );
    } catch {
      fail("settings_connections_mcp_resolution_mismatch");
    }
    return Object.freeze({ marketplace_added: true, plugin_installed: true, mcp_resolved: true });
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

export async function observeSettingsConnectionsPlugin({ candidate, marketplaceRoot }) {
  const marketplace = await inspectMarketplace(resolve(marketplaceRoot));
  const freshContext = await verifyFreshInstall(marketplace);
  const catalogProfiles = verifySettingsConnectionsCatalogProfiles();
  const unsigned = Object.freeze({
    schema: SCHEMA,
    status: "passed",
    candidate_sha: candidateSha(candidate),
    marketplace_candidate_sha: marketplace.head,
    marketplace_tree_sha: marketplace.tree,
    plugin_version: marketplace.pluginVersion,
    plugin_snapshot_sha256: marketplace.snapshotSha256,
    client: CLIENT,
    client_version: CLIENT_VERSION,
    routes: ROUTES,
    fresh_context: freshContext,
    catalog_profiles: catalogProfiles,
    cleanup: Object.freeze({ temporary_codex_home_removed: true }),
  });
  return Object.freeze({ ...unsigned, artifact_sha256: digest(canonical(unsigned)) });
}
