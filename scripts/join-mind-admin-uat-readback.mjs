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
import { MIND_ADMIN_BROWSER_ASSERTION_IDS } from "./run-mind-admin-browser-gate.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const STRUCTURAL_JOIN_SCHEMA = "mind-diary/mind-admin-uat-readback-join/v1";
const LOCAL_SCHEMA = "mind-diary/mind-admin-browser-evidence/v1";
const PROVIDER_SCHEMA = "mind-diary/mind-admin-sites-provider-readback/v1";
const BROWSER_SCHEMA = "mind-diary/mind-admin-in-app-browser-readback/v1";
const UAT_URL = "https://mind-diary.example.invalid";
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PROVIDER_PROJECT = /^appgprj_[a-z0-9]+$/u;
const PROVIDER_VERSION = /^appgver_[a-z0-9]+$/u;
const PROVIDER_DEPLOYMENT = /^appgdep_[a-z0-9]+$/u;

const JOURNEY_CHECKS = Object.freeze({
    "admin.personal-projection": ["personal-first", "private", "ordinary-controls-absent"],
    "admin.create-private-run-owned": ["created-private", "nonmember-404"],
    "admin.metadata-update-clear": ["name-and-description-updated", "description-cleared", "metadata-versions-recorded"],
    "admin.metadata-two-context-conflict": ["stale-write-conflicted", "fresh-state-reloaded", "metadata-versions-recorded"],
    "admin.visibility-warning-unlisted": ["history-warning-acknowledged", "exact-route-reader", "catalog-absent"],
    "admin.visibility-public-catalog": ["authenticated-catalog-present", "direct-route-reader"],
    "admin.visibility-private-nondisclosure": ["future-access-warning", "direct-route-404", "catalog-absent"],
    "admin.role-projections": ["reader-projection", "admin-projection", "owner-only-controls-absent"],
    "admin.persistence-reconstruction": ["controlled-redeploy", "metadata-role-visibility-restored"],
    "admin.personal-invariants": ["personal-controls-absent", "personal-mutation-403", "other-personal-undisclosed"],
    "admin.deletion-impact-confirmation": ["impact-counts-recorded", "exact-confirmation", "no-recovery-acknowledged"],
  "admin.cleanup-absence-readback": ["owner-404", "participant-404", "catalog-absent"],
});

export const MIND_ADMIN_UAT_JOURNEYS = Object.freeze(
  MIND_ADMIN_BROWSER_ASSERTION_IDS.map((id) => Object.freeze({
    id,
    checks: Object.freeze(JOURNEY_CHECKS[id]),
  })),
);

export function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (!argument.startsWith("--")) fail("invalid_cli_argument");
    const key = argument.slice(2).replaceAll("-", "_");
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--") || Object.hasOwn(options, key)) fail("invalid_cli_argument");
    options[key] = value;
    index += 1;
  }
  const supported = ["local_receipt", "provider_readback", "browser_readback", "artifact_archive", "candidate_sha", "join_out"];
  for (const key of Object.keys(options)) if (!supported.includes(key)) fail("unsupported_cli_argument");
  for (const key of supported) if (typeof options[key] !== "string") fail(`missing_${key}`);
  return options;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function utc(value, code) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) fail(code);
  return value;
}

function assertPrivacySafe(value) {
  const text = JSON.stringify(value);
  for (const pattern of [/@[a-z0-9.-]+\.[a-z]{2,}/iu, /mdp_v1_/iu, /authorization["']?\s*:/iu,
    /cookie["']?\s*:/iu, /principal_/iu, /space_/iu, /revision_/iu, /download_url/iu,
    /body_base64/iu, /screenshot/iu]) {
    if (pattern.test(text)) fail("unsafe_uat_receipt");
  }
}

function localBinding(receipt, expected, receiptBytes) {
  if (!isRecord(receipt) || receipt.schema !== LOCAL_SCHEMA || receipt.status !== "passed" ||
      receipt.hosted_evidence !== false || receipt.acceptance !== "local-only" ||
      receipt.provenance !== "exact-local-playwright-composition" ||
      receipt.candidate_sha !== expected.candidateSha || receipt.candidate_tree_sha !== expected.sourceTreeSha ||
      !SHA256.test(receipt.artifact_sha256 ?? "") || !Array.isArray(receipt.assertions) ||
      receipt.assertions.length !== MIND_ADMIN_BROWSER_ASSERTION_IDS.length) fail("invalid_local_receipt");
  const { artifact_sha256: suppliedDigest, ...unsigned } = receipt;
  if (suppliedDigest !== digest(canonical(unsigned))) fail("local_receipt_digest_mismatch");
  for (const [index, id] of MIND_ADMIN_BROWSER_ASSERTION_IDS.entries()) {
    if (receipt.assertions[index]?.id !== id || receipt.assertions[index]?.status !== "passed") fail("local_assertion_registry_mismatch");
  }
  return Object.freeze({ artifactSha256: suppliedDigest, inputSha256: sha256(receiptBytes) });
}

function providerBinding(readback, expected, archiveBytes) {
  if (!isRecord(readback) || readback.schema !== PROVIDER_SCHEMA ||
      readback.generator !== "codex-sites-connector-readback/v1" || !isRecord(readback.site) ||
      !isRecord(readback.saved_version) || !isRecord(readback.version) ||
      !isRecord(readback.deployment_start) || !isRecord(readback.deployment)) fail("invalid_provider_readback");
  const { site, saved_version: saved, version, deployment_start: started, deployment } = readback;
  const observedAt = utc(readback.observed_at_utc, "invalid_provider_observed_at");
  if (!PROVIDER_PROJECT.test(site.id ?? "") || site.id !== expected.siteProjectId || site.status !== "active" ||
      site.current_live_url !== UAT_URL || !PROVIDER_VERSION.test(version.id ?? "") || saved.id !== version.id ||
      saved.project_id !== site.id || version.project_id !== site.id ||
      saved.source?.commit_sha !== expected.candidateSha || version.source?.commit_sha !== expected.candidateSha ||
      !PROVIDER_DEPLOYMENT.test(deployment.id ?? "") || started.id !== deployment.id ||
      started.version_id !== version.id || deployment.version_id !== version.id ||
      deployment.project_id !== site.id || deployment.status !== "succeeded" || deployment.type !== "publish" ||
      deployment.url !== UAT_URL || !isRecord(saved.archive_storage) || !isRecord(version.archive_storage)) {
    fail("provider_readback_lineage_mismatch");
  }
  utc(site.updated_at, "invalid_provider_site_readback");
  utc(started.updated_at, "invalid_provider_deployment_start");
  utc(deployment.updated_at, "invalid_provider_deployment_readback");
  if (Date.parse(observedAt) < Date.parse(deployment.updated_at)) fail("provider_readback_lineage_mismatch");
  const archiveSha = sha256(archiveBytes);
  for (const storage of [saved.archive_storage, version.archive_storage]) {
    const normalized = String(storage.content_hash ?? "").replace(/^((?!sha256:).*)$/u, "sha256:$1");
    if (normalized !== archiveSha || storage.archive_format !== "tar.gz" || storage.size_bytes !== archiveBytes.byteLength) {
      fail("uat_archive_identity_mismatch");
    }
  }
  return Object.freeze({
    siteProjectId: site.id,
    siteVersionId: version.id,
    deploymentId: deployment.id,
    versionNumber: version.version_number,
    observedAt,
    archiveSha,
  });
}

function browserBinding(readback, expected) {
  if (!isRecord(readback) || readback.schema !== BROWSER_SCHEMA ||
      readback.generator !== "codex-in-app-browser-direct-observation/v1" ||
      readback.browser_surface !== "codex-in-app-browser" || readback.live_url !== UAT_URL ||
      readback.candidate_sha !== expected.candidateSha || readback.source_tree_sha !== expected.sourceTreeSha ||
      readback.local_receipt_sha256 !== expected.localReceiptInputSha256 || !Array.isArray(readback.journeys)) {
    fail("invalid_browser_readback");
  }
  const observedAt = utc(readback.observed_at_utc, "invalid_browser_observed_at");
  if (Date.parse(observedAt) < Date.parse(expected.providerObservedAt)) fail("browser_readback_precedes_provider_readback");
  if (readback.journeys.length !== MIND_ADMIN_UAT_JOURNEYS.length) fail("uat_journey_registry_mismatch");
  const journeys = MIND_ADMIN_UAT_JOURNEYS.map((expectedJourney) => {
    const matches = readback.journeys.filter((journey) => journey?.id === expectedJourney.id);
    if (matches.length !== 1 || matches[0].status !== "passed" ||
        canonical(matches[0].checks) !== canonical(expectedJourney.checks)) fail("uat_journey_mismatch");
    const facts = matches[0].facts;
    if (!isRecord(facts) || !Number.isSafeInteger(facts.metadata_version_before) ||
        !Number.isSafeInteger(facts.metadata_version_after) || facts.metadata_version_before < 1 ||
        facts.metadata_version_after < facts.metadata_version_before || !Number.isSafeInteger(facts.negative_status) ||
        ![0, 403, 404, 409].includes(facts.negative_status)) fail("uat_journey_facts_missing");
    return Object.freeze(structuredClone(matches[0]));
  });
  return Object.freeze({ observedAt, journeys });
}

export function createStructuralJoin(input, expected) {
  const local = localBinding(input.localReceipt, expected, input.localReceiptBytes);
  const provider = providerBinding(input.providerReadback, expected, input.archiveBytes);
  const browser = browserBinding(input.browserReadback, {
    ...expected,
    localReceiptInputSha256: local.inputSha256,
    providerObservedAt: provider.observedAt,
  });
  const unsigned = Object.freeze({
    schema: STRUCTURAL_JOIN_SCHEMA,
    status: "structurally_verified_readback",
    hosted_evidence: false,
    acceptance: "nonterminal",
    provenance: "unverified-local-files",
    candidate_sha: expected.candidateSha,
    source_tree_sha: expected.sourceTreeSha,
    live_url: UAT_URL,
    evidence_basis: "offline-byte-and-shape-join-only",
    claimed_lineage: Object.freeze({
      site_project_id: provider.siteProjectId,
      site_version_id: provider.siteVersionId,
      deployment_id: provider.deploymentId,
      version_number: provider.versionNumber,
      artifact_archive_sha256: provider.archiveSha,
    }),
    input_hashes: Object.freeze({
      local_receipt_sha256: local.inputSha256,
      provider_readback_sha256: sha256(input.providerReadbackBytes),
      browser_readback_sha256: sha256(input.browserReadbackBytes),
    }),
    unresolved_provenance: Object.freeze([
      "sites-connector-call-origin-not-authenticated-offline",
      "in-app-browser-observation-origin-not-authenticated-offline",
    ]),
    journeys: browser.journeys,
  });
  const join = Object.freeze({ ...unsigned, artifact_sha256: digest(canonical(unsigned)) });
  assertPrivacySafe(join);
  return join;
}

async function trackedContext(candidate) {
  const hosting = JSON.parse(await readFile(resolve(ROOT, "apps/mind-diary-site/.openai/hosting.json"), "utf8"));
  const tree = execFileSync("git", ["rev-parse", `${candidate}^{tree}`], { cwd: ROOT, encoding: "utf8" }).trim();
  return Object.freeze({ candidateSha: candidateSha(candidate), sourceTreeSha: candidateSha(tree), siteProjectId: hosting.project_id });
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) {
      process.stdout.write("Usage: npm run join:mind-admin-uat-readback -- --local-receipt <local-json> --provider-readback <private-json> --browser-readback <private-json> --artifact-archive <exact-sites-tar.gz> --candidate-sha <exact-deployed-sha> --join-out <new-private-json>\n");
      return;
    }
    const expected = await trackedContext(options.candidate_sha);
    const [localReceiptBytes, providerReadbackBytes, browserReadbackBytes, archiveBytes] = await Promise.all([
      readFile(options.local_receipt), readFile(options.provider_readback), readFile(options.browser_readback), readFile(options.artifact_archive),
    ]);
    const join = createStructuralJoin({
      localReceipt: JSON.parse(localReceiptBytes),
      providerReadback: JSON.parse(providerReadbackBytes),
      browserReadback: JSON.parse(browserReadbackBytes),
      localReceiptBytes,
      providerReadbackBytes,
      browserReadbackBytes,
      archiveBytes,
    }, expected);
    await writeFile(options.join_out, `${JSON.stringify(join, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ status: join.status, hosted_evidence: false, acceptance: "nonterminal", candidate_sha: join.candidate_sha, artifact_sha256: join.artifact_sha256 })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "failed", code: error instanceof ProbeFailure ? error.code : safeCode(error?.code) })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
