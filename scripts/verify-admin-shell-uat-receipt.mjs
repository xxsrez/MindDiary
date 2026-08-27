#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
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
const RECEIPT_SCHEMA = "mind-diary/admin-shell-uat-evidence/v1";
const UAT_URL = "https://mind-diary.example.invalid";
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;

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
  const supported = ["receipt", "candidate_sha", "site_version_id", "deployment_id"];
  for (const key of Object.keys(options)) if (!supported.includes(key)) fail("unsupported_cli_argument");
  for (const key of supported) if (typeof options[key] !== "string") fail(`missing_${key}`);
  return options;
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
  ]) {
    if (pattern.test(text)) fail("unsafe_uat_receipt");
  }
}

export function validateReceipt(receipt, expected) {
  if (!isRecord(receipt) || receipt.schema !== RECEIPT_SCHEMA || receipt.status !== "passed" ||
      receipt.candidate_sha !== expected.candidateSha || receipt.live_url !== UAT_URL ||
      receipt.evidence_basis !== "in-app-browser-dom-accessibility-geometry" ||
      receipt.browser_surface !== "codex-in-app-browser" || !isRecord(receipt.lineage) ||
      !Array.isArray(receipt.journeys)) {
    fail("invalid_uat_receipt");
  }
  if (
    receipt.lineage.site_project_id !== expected.siteProjectId ||
    receipt.lineage.site_version_id !== expected.siteVersionId ||
    receipt.lineage.deployment_id !== expected.deploymentId ||
    receipt.lineage.candidate_sha !== expected.candidateSha ||
    receipt.lineage.source_tree_sha !== expected.sourceTreeSha
  ) fail("uat_lineage_mismatch");
  for (const key of [
    "artifact_archive_sha256",
    "server_bundle_sha256",
    "shell_css_sha256",
    "shell_client_sha256",
  ]) {
    if (!SHA256.test(receipt.lineage[key] ?? "")) fail("uat_asset_identity_missing");
  }
  if (!OPAQUE_ID.test(receipt.lineage.site_version_id) ||
      !OPAQUE_ID.test(receipt.lineage.deployment_id)) fail("invalid_uat_provider_identity");
  if (Number.isNaN(Date.parse(receipt.observed_at_utc ?? ""))) fail("invalid_uat_observed_at");
  if (receipt.journeys.length !== ADMIN_SHELL_UAT_JOURNEYS.length) {
    fail("uat_journey_registry_mismatch");
  }
  for (const expectedJourney of ADMIN_SHELL_UAT_JOURNEYS) {
    const matches = receipt.journeys.filter((journey) => journey?.id === expectedJourney.id);
    if (matches.length !== 1) fail("uat_journey_registry_mismatch");
    validateJourney(matches[0], expectedJourney);
  }
  const { artifact_sha256: artifactSha256, ...unsigned } = receipt;
  if (!SHA256.test(artifactSha256 ?? "") || artifactSha256 !== digest(canonical(unsigned))) {
    fail("uat_receipt_digest_mismatch");
  }
  assertPrivacySafe(receipt);
  return receipt;
}

async function trackedContext(options) {
  const hosting = JSON.parse(await readFile(
    resolve(ROOT, "apps/mind-diary-site/.openai/hosting.json"),
    "utf8",
  ));
  const sourceTree = execFileSync(
    "git",
    ["rev-parse", `${options.candidate_sha}^{tree}`],
    { cwd: ROOT, encoding: "utf8" },
  ).trim();
  return Object.freeze({
    candidateSha: candidateSha(options.candidate_sha),
    sourceTreeSha: candidateSha(sourceTree),
    siteProjectId: hosting.project_id,
    siteVersionId: options.site_version_id,
    deploymentId: options.deployment_id,
  });
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) {
      process.stdout.write("Usage: npm run verify:admin-shell-uat -- --receipt <private-json> --candidate-sha <exact-sha> --site-version-id <exact-id> --deployment-id <exact-id>\n");
      return;
    }
    const expected = await trackedContext(options);
    const receipt = JSON.parse(await readFile(options.receipt, "utf8"));
    validateReceipt(receipt, expected);
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
