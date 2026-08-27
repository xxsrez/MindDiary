#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  candidateSha,
  canonical,
  digest,
  fail,
  isRecord,
  ProbeFailure,
  safeCode,
} from "./lib/multi-principal-probe-core.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const RECEIPT_SCHEMA = "mind-diary/admin-shell-uat-evidence/v2";
const PROVIDER_READBACK_SCHEMA = "mind-diary/admin-shell-sites-provider-readback/v1";
const BROWSER_READBACK_SCHEMA = "mind-diary/admin-shell-in-app-browser-readback/v1";
const UAT_URL = "https://mind-diary.example.invalid";
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PROVIDER_PROJECT = /^appgprj_[a-z0-9]+$/u;
const PROVIDER_VERSION = /^appgver_[a-z0-9]+$/u;
const PROVIDER_DEPLOYMENT = /^appgdep_[a-z0-9]+$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const SERVER_ENTRY = "dist/server/index.js";
const LIVE_ASSETS = Object.freeze([
  Object.freeze({
    path: "/ui/mind-diary-shell.css",
    sources: Object.freeze(["packages/adapter-web/src/ui-shell.css"]),
    contentType: "text/css; charset=utf-8",
  }),
  Object.freeze({
    path: "/ui/mind-diary-shell-client.js",
    sources: Object.freeze([
      "packages/adapter-web/assets/shell-interactions.js",
      "packages/adapter-web/assets/product-ui-client.js",
    ]),
    contentType: "text/javascript; charset=utf-8",
  }),
]);

export const ADMIN_SHELL_UAT_JOURNEYS = Object.freeze([
  Object.freeze({
    id: "wide-minds",
    route: "/minds",
    viewport: Object.freeze({ width: 1440, height: 900 }),
    currentItems: Object.freeze(["minds"]),
    checks: Object.freeze(["rail-visible", "settings-visible", "first-row-complete"]),
  }),
  Object.freeze({
    id: "narrow-settings",
    route: "/settings/connections",
    viewport: Object.freeze({ width: 390, height: 844 }),
    currentItems: Object.freeze(["settings", "connections"]),
    checks: Object.freeze([
      "drawer-initially-closed",
      "drawer-focus-my-mind",
      "drawer-focus-trapped",
      "escape-focus-return",
    ]),
  }),
  Object.freeze({
    id: "personal-mind",
    route: "/me",
    viewport: Object.freeze({ width: 390, height: 844 }),
    currentItems: Object.freeze(["my-mind"]),
    checks: Object.freeze(["private-disclosure-adjacent", "no-share-transfer-separate-delete"]),
  }),
  Object.freeze({
    id: "direct-settings-and-back",
    route: "/settings/developer/mcp",
    viewport: Object.freeze({ width: 1024, height: 768 }),
    currentItems: Object.freeze(["settings", "advanced-mcp"]),
    checks: Object.freeze(["direct-current", "back-restores-minds-current"]),
  }),
]);

export function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (!argument.startsWith("--")) fail("invalid_cli_argument");
    const key = argument.slice(2).replaceAll("-", "_");
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--") || Object.hasOwn(options, key)) {
      fail("invalid_cli_argument");
    }
    options[key] = value;
    index += 1;
  }
  const supported = [
    "provider_readback",
    "browser_readback",
    "artifact_archive",
    "candidate_sha",
    "receipt_out",
  ];
  for (const key of Object.keys(options)) if (!supported.includes(key)) fail("unsupported_cli_argument");
  for (const key of supported) if (typeof options[key] !== "string") fail(`missing_${key}`);
  return options;
}

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizedSha256(value, code) {
  if (typeof value !== "string") fail(code);
  const normalized = value.startsWith("sha256:") ? value : `sha256:${value}`;
  if (!SHA256.test(normalized)) fail(code);
  return normalized;
}

function utc(value, code) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) ||
      new Date(value).toISOString() !== value) fail(code);
  return value;
}

function exactStrings(actual, expected, code) {
  if (!Array.isArray(actual) || actual.length !== expected.length ||
      actual.some((value, index) => value !== expected[index])) fail(code);
}

function finiteNumber(value, code) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(code);
  return value;
}

function validateJourney(value, expected) {
  if (!isRecord(value) || value.id !== expected.id || value.status !== "passed" ||
      value.route !== expected.route || !isRecord(value.viewport) ||
      value.viewport.width !== expected.viewport.width ||
      value.viewport.height !== expected.viewport.height || !isRecord(value.metrics)) {
    fail("uat_journey_identity_mismatch");
  }
  exactStrings(value.current_items, expected.currentItems, "uat_journey_current_state_mismatch");
  exactStrings(value.checks, expected.checks, "uat_journey_checks_mismatch");
  const documentOverflow = finiteNumber(
    value.metrics.document_overflow_px,
    "uat_document_overflow_missing",
  );
  const bodyOverflow = finiteNumber(value.metrics.body_overflow_px, "uat_body_overflow_missing");
  const minimumTarget = finiteNumber(
    value.metrics.minimum_hit_target_px,
    "uat_hit_target_missing",
  );
  const pageHeaderBottom = finiteNumber(
    value.metrics.page_header_bottom_px,
    "uat_page_header_metric_missing",
  );
  const firstContentTop = finiteNumber(
    value.metrics.first_key_content_top_px,
    "uat_first_content_metric_missing",
  );
  if (documentOverflow < 0 || documentOverflow > 1 || bodyOverflow < 0 || bodyOverflow > 1) {
    fail("uat_overflow_budget_failed");
  }
  if (minimumTarget < 44) fail("uat_hit_target_budget_failed");
  if (value.metrics.h1_count !== 1) fail("uat_heading_count_failed");
  if (pageHeaderBottom < 0 || pageHeaderBottom > expected.viewport.height ||
      firstContentTop < 0 || firstContentTop >= expected.viewport.height) {
    fail("uat_first_viewport_budget_failed");
  }
  return Object.freeze(structuredClone(value));
}

function assertPrivacySafe(value) {
  const text = JSON.stringify(value);
  for (const pattern of [
    /mdp_v1_/iu,
    /authorization["']?\s*:/iu,
    /cookie["']?\s*:/iu,
    /@[a-z0-9.-]+\.[a-z]{2,}/iu,
    /principal_/iu,
    /space_/iu,
    /revision_/iu,
    /download_url/iu,
    /screenshot/iu,
    /body_base64/iu,
  ]) {
    if (pattern.test(text)) fail("unsafe_uat_receipt");
  }
}

function providerBinding(readback, expected, archiveBytes) {
  if (!isRecord(readback) || readback.schema !== PROVIDER_READBACK_SCHEMA ||
      readback.generator !== "codex-sites-connector-readback/v1" ||
      !isRecord(readback.site) || !isRecord(readback.saved_version) ||
      !isRecord(readback.version) || !isRecord(readback.deployment_start) ||
      !isRecord(readback.deployment)) fail("invalid_provider_readback");
  const site = readback.site;
  const savedVersion = readback.saved_version;
  const version = readback.version;
  const deploymentStart = readback.deployment_start;
  const deployment = readback.deployment;
  const observedAt = utc(readback.observed_at_utc, "invalid_provider_observed_at");
  utc(site.updated_at, "invalid_provider_site_readback");
  utc(deploymentStart.updated_at, "invalid_provider_deployment_start");
  utc(deployment.updated_at, "invalid_provider_deployment_readback");
  if (
    !PROVIDER_PROJECT.test(site.id ?? "") || site.id !== expected.siteProjectId ||
    site.status !== "active" || site.current_live_url !== UAT_URL ||
    savedVersion.id !== version.id || savedVersion.project_id !== site.id ||
    savedVersion.version_number !== version.version_number ||
    savedVersion.source?.commit_sha !== expected.candidateSha ||
    !isRecord(savedVersion.archive_storage) ||
    !PROVIDER_VERSION.test(version.id ?? "") || version.project_id !== site.id ||
    version.source?.commit_sha !== expected.candidateSha ||
    !Number.isSafeInteger(version.version_number) || version.version_number < 1 ||
    !isRecord(version.archive_storage) ||
    deploymentStart.id !== deployment.id || deploymentStart.project_id !== site.id ||
    deploymentStart.version_id !== version.id || deploymentStart.type !== "publish" ||
    !["pending", "building", "publishing", "succeeded"].includes(deploymentStart.status) ||
    !PROVIDER_DEPLOYMENT.test(deployment.id ?? "") || deployment.project_id !== site.id ||
    deployment.version_id !== version.id || deployment.status !== "succeeded" ||
    deployment.type !== "publish" || deployment.url !== UAT_URL ||
    Date.parse(deployment.updated_at) < Date.parse(deploymentStart.updated_at) ||
    Date.parse(observedAt) < Date.parse(deployment.updated_at)
  ) fail("provider_readback_lineage_mismatch");
  const archiveSha256 = sha256Bytes(archiveBytes);
  for (const archiveStorage of [savedVersion.archive_storage, version.archive_storage]) {
    if (normalizedSha256(
      archiveStorage.content_hash,
      "invalid_provider_archive_hash",
    ) !== archiveSha256) fail("uat_archive_digest_mismatch");
  }
  if ([savedVersion.archive_storage, version.archive_storage].some((archiveStorage) =>
    archiveStorage.archive_format !== "tar.gz" ||
    archiveStorage.size_bytes !== archiveBytes.byteLength)) {
    fail("uat_archive_identity_mismatch");
  }
  return Object.freeze({
    site_project_id: site.id,
    site_version_id: version.id,
    deployment_id: deployment.id,
    version_number: version.version_number,
    artifact_archive_sha256: archiveSha256,
    provider_observed_at_utc: observedAt,
  });
}

function decodeAsset(value) {
  if (typeof value !== "string" || !BASE64.test(value)) fail("invalid_live_asset_bytes");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) fail("invalid_live_asset_bytes");
  return decoded;
}

function browserBinding(readback, expected, candidateAssets) {
  if (!isRecord(readback) || readback.schema !== BROWSER_READBACK_SCHEMA ||
      readback.generator !== "codex-in-app-browser-same-origin-readback/v1" ||
      readback.browser_surface !== "codex-in-app-browser" || readback.live_url !== UAT_URL ||
      !Array.isArray(readback.assets) || !Array.isArray(readback.journeys)) {
    fail("invalid_browser_readback");
  }
  const observedAt = utc(readback.observed_at_utc, "invalid_browser_observed_at");
  if (Date.parse(observedAt) < Date.parse(expected.providerObservedAt)) {
    fail("browser_readback_precedes_provider_readback");
  }
  const assets = {};
  for (const expectedAsset of LIVE_ASSETS) {
    const matches = readback.assets.filter((asset) => asset?.path === expectedAsset.path);
    if (matches.length !== 1) fail("live_asset_registry_mismatch");
    const asset = matches[0];
    if (asset.status !== 200 || asset.response_url !== `${UAT_URL}${expectedAsset.path}` ||
        asset.content_type !== expectedAsset.contentType) fail("live_asset_response_mismatch");
    const bytes = decodeAsset(asset.body_base64);
    const actualDigest = sha256Bytes(bytes);
    if (asset.body_sha256 !== actualDigest) fail("live_asset_supplied_digest_mismatch");
    if (!bytes.equals(candidateAssets[expectedAsset.path])) fail("live_asset_candidate_mismatch");
    assets[expectedAsset.path] = actualDigest;
  }
  if (readback.assets.length !== LIVE_ASSETS.length) fail("live_asset_registry_mismatch");
  if (readback.journeys.length !== ADMIN_SHELL_UAT_JOURNEYS.length) {
    fail("uat_journey_registry_mismatch");
  }
  const journeys = ADMIN_SHELL_UAT_JOURNEYS.map((expectedJourney) => {
    const matches = readback.journeys.filter((journey) => journey?.id === expectedJourney.id);
    if (matches.length !== 1) fail("uat_journey_registry_mismatch");
    return validateJourney(matches[0], expectedJourney);
  });
  return Object.freeze({ assets: Object.freeze(assets), journeys, observedAt });
}

export function createVerifiedReceipt(input, expected) {
  const provider = providerBinding(input.providerReadback, expected, input.archiveBytes);
  const browser = browserBinding(input.browserReadback, {
    providerObservedAt: provider.provider_observed_at_utc,
  }, input.candidateAssets);
  const serverBundleSha256 = sha256Bytes(input.serverBundleBytes);
  const unsigned = Object.freeze({
    schema: RECEIPT_SCHEMA,
    status: "passed",
    candidate_sha: expected.candidateSha,
    live_url: UAT_URL,
    evidence_basis: "provider-readback-plus-in-app-browser-raw-bytes-dom-accessibility-geometry",
    browser_surface: "codex-in-app-browser",
    observed_at_utc: browser.observedAt,
    lineage: Object.freeze({
      candidate_sha: expected.candidateSha,
      source_tree_sha: expected.sourceTreeSha,
      site_project_id: provider.site_project_id,
      site_version_id: provider.site_version_id,
      deployment_id: provider.deployment_id,
      version_number: provider.version_number,
      artifact_archive_sha256: provider.artifact_archive_sha256,
      server_bundle_sha256: serverBundleSha256,
      shell_css_sha256: browser.assets["/ui/mind-diary-shell.css"],
      shell_client_sha256: browser.assets["/ui/mind-diary-shell-client.js"],
    }),
    evidence_inputs: Object.freeze({
      provider_readback_sha256: sha256Bytes(input.providerReadbackBytes),
      browser_readback_sha256: sha256Bytes(input.browserReadbackBytes),
    }),
    journeys: browser.journeys,
  });
  const receipt = Object.freeze({
    ...unsigned,
    artifact_sha256: digest(canonical(unsigned)),
  });
  validateReceipt(receipt, { ...expected, provider, browser, serverBundleSha256, input });
  return receipt;
}

export function validateReceipt(receipt, binding) {
  if (!isRecord(receipt) || receipt.schema !== RECEIPT_SCHEMA || receipt.status !== "passed" ||
      receipt.candidate_sha !== binding.candidateSha || receipt.live_url !== UAT_URL ||
      receipt.evidence_basis !==
        "provider-readback-plus-in-app-browser-raw-bytes-dom-accessibility-geometry" ||
      receipt.browser_surface !== "codex-in-app-browser" || !isRecord(receipt.lineage) ||
      !isRecord(receipt.evidence_inputs) || !Array.isArray(receipt.journeys)) {
    fail("invalid_uat_receipt");
  }
  const expectedLineage = {
    candidate_sha: binding.candidateSha,
    source_tree_sha: binding.sourceTreeSha,
    site_project_id: binding.provider.site_project_id,
    site_version_id: binding.provider.site_version_id,
    deployment_id: binding.provider.deployment_id,
    version_number: binding.provider.version_number,
    artifact_archive_sha256: binding.provider.artifact_archive_sha256,
    server_bundle_sha256: binding.serverBundleSha256,
    shell_css_sha256: binding.browser.assets["/ui/mind-diary-shell.css"],
    shell_client_sha256: binding.browser.assets["/ui/mind-diary-shell-client.js"],
  };
  if (canonical(receipt.lineage) !== canonical(expectedLineage) ||
      receipt.evidence_inputs.provider_readback_sha256 !==
        sha256Bytes(binding.input.providerReadbackBytes) ||
      receipt.evidence_inputs.browser_readback_sha256 !==
        sha256Bytes(binding.input.browserReadbackBytes) ||
      canonical(receipt.journeys) !== canonical(binding.browser.journeys)) {
    fail("uat_evidence_binding_mismatch");
  }
  const { artifact_sha256: artifactSha256, ...unsigned } = receipt;
  if (!SHA256.test(artifactSha256 ?? "") || artifactSha256 !== digest(canonical(unsigned))) {
    fail("uat_receipt_digest_mismatch");
  }
  assertPrivacySafe(receipt);
  return receipt;
}

async function trackedContext(candidate) {
  const hosting = JSON.parse(await readFile(
    resolve(ROOT, "apps/mind-diary-site/.openai/hosting.json"),
    "utf8",
  ));
  const sourceTree = execFileSync(
    "git",
    ["rev-parse", `${candidate}^{tree}`],
    { cwd: ROOT, encoding: "utf8" },
  ).trim();
  const candidateAssets = {};
  for (const asset of LIVE_ASSETS) {
    const sourceParts = asset.sources.map((source) => execFileSync(
      "git",
      ["show", `${candidate}:${source}`],
      { cwd: ROOT, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
    ));
    candidateAssets[asset.path] = Buffer.concat(
      sourceParts.flatMap((part, index) => index === 0 ? [part] : [Buffer.from("\n"), part]),
    );
  }
  return Object.freeze({
    candidateSha: candidateSha(candidate),
    sourceTreeSha: candidateSha(sourceTree),
    siteProjectId: hosting.project_id,
    candidateAssets: Object.freeze(candidateAssets),
  });
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) {
      process.stdout.write("Usage: npm run verify:admin-shell-uat -- --provider-readback <private-json> --browser-readback <private-json> --artifact-archive <exact-sites-tar.gz> --candidate-sha <exact-deployed-sha> --receipt-out <new-private-json>\n");
      return;
    }
    const tracked = await trackedContext(options.candidate_sha);
    const [providerReadbackBytes, browserReadbackBytes, archiveBytes] = await Promise.all([
      readFile(options.provider_readback),
      readFile(options.browser_readback),
      readFile(options.artifact_archive),
    ]);
    let serverBundleBytes;
    try {
      serverBundleBytes = execFileSync(
        "tar",
        ["-xOzf", options.artifact_archive, SERVER_ENTRY],
        { encoding: "buffer", maxBuffer: 128 * 1024 * 1024 },
      );
    } catch {
      fail("artifact_server_bundle_missing");
    }
    const input = Object.freeze({
      providerReadback: JSON.parse(providerReadbackBytes.toString("utf8")),
      browserReadback: JSON.parse(browserReadbackBytes.toString("utf8")),
      providerReadbackBytes,
      browserReadbackBytes,
      archiveBytes,
      serverBundleBytes,
      candidateAssets: tracked.candidateAssets,
    });
    const receipt = createVerifiedReceipt(input, tracked);
    await writeFile(options.receipt_out, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    process.stdout.write(`${JSON.stringify({
      status: "passed",
      candidate_sha: receipt.candidate_sha,
      site_version_id: receipt.lineage.site_version_id,
      deployment_id: receipt.lineage.deployment_id,
      artifact_sha256: receipt.artifact_sha256,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: "failed",
      code: error instanceof ProbeFailure ? error.code : safeCode(error?.code),
    })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
