import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY_SCHEMA = "mind-diary/readiness-registry/v1";
const REPORT_SCHEMA = "mind-diary/readiness-report/v1";
const RECEIPT_SCHEMA = "mind-diary/readiness-evidence/v1";
const TRACEABILITY_PATH = "docs/specs/traceability.md";
const EXPECTED_CRITERIA = Array.from({ length: 29 }, (_, index) => index + 1);
const EXPECTED_LIVE_SLOTS = ["W", "P", "MI", "CX", "R"];
const EXPECTED_DENYLIST = [
  "aws-runtime",
  "imports",
  "checkpoints",
  "bundle-file-expansion",
  "personalization",
  "oauth-company-knowledge",
  "claude-support",
  "anonymous-access",
  "draft-approval",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertRelativeRepositoryPath(path, label) {
  assert(typeof path === "string" && path.length > 0, `${label} must be a non-empty path`);
  assert(!isAbsolute(path), `${label} must be repository-relative: ${path}`);
  assert(!path.includes("\\"), `${label} must use forward slashes: ${path}`);
  const segments = path.split("/");
  assert(!segments.includes("") && !segments.includes(".") && !segments.includes(".."), `${label} is not canonical: ${path}`);
}

function exactArray(value, expected) {
  return Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index]);
}

function uniqueStrings(value, label) {
  assert(Array.isArray(value), `${label} must be an array`);
  assert(value.every((item) => typeof item === "string" && item.length > 0), `${label} must contain non-empty strings`);
  assert(new Set(value).size === value.length, `${label} must not contain duplicates`);
}

export function parseTraceabilityDocument(markdown) {
  const matches = [...markdown.matchAll(
    /<!-- readiness-registry:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- readiness-registry:end -->/g,
  )];
  assert(matches.length === 1, "traceability must contain exactly one readiness registry block");

  let registry;
  try {
    registry = JSON.parse(matches[0][1]);
  } catch (error) {
    throw new Error(`readiness registry is not valid JSON: ${error.message}`);
  }

  const tableRows = new Map();
  for (const line of markdown.split("\n")) {
    const row = line.match(/^\|\s*(\d+)\s*\|.*?\|\s*`(AND-\d+)`\s*\|/);
    if (!row) continue;
    const criterion = Number(row[1]);
    const releaseCell = line.split("|").at(-2) ?? "";
    const slots = [...releaseCell.matchAll(/\b(W|P|MI|CX|R)\b/g)].map((match) => match[1]);
    tableRows.set(criterion, { owner: row[2], slots: [...new Set(slots)] });
  }

  return { registry, tableRows };
}

export async function validateRegistry(registry, { tableRows, pathExists, packageCheck }) {
  assert(registry?.schema === REGISTRY_SCHEMA, `registry schema must be ${REGISTRY_SCHEMA}`);
  assert(Array.isArray(registry.criteria), "registry criteria must be an array");
  assert(registry.local_evidence && typeof registry.local_evidence === "object" && !Array.isArray(registry.local_evidence), "local_evidence must be an object");
  assert(registry.live_evidence && typeof registry.live_evidence === "object" && !Array.isArray(registry.live_evidence), "live_evidence must be an object");
  assert(Array.isArray(registry.post_mvp_denylist), "post_mvp_denylist must be an array");

  const criterionIds = registry.criteria.map((criterion) => criterion.id).sort((left, right) => left - right);
  assert(exactArray(criterionIds, EXPECTED_CRITERIA), "criteria must contain every integer from 1 through 29 exactly once");
  assert(tableRows.size === 29, "human-readable matrix must contain exactly 29 criterion rows");

  const referencedEvidence = new Set();
  for (const criterion of registry.criteria) {
    assert(typeof criterion.owner === "string" && /^AND-\d+$/.test(criterion.owner), `criterion ${criterion.id} must have exactly one AND owner`);
    uniqueStrings(criterion.local_evidence, `criterion ${criterion.id} local_evidence`);
    uniqueStrings(criterion.live_evidence, `criterion ${criterion.id} live_evidence`);
    assert(criterion.release_evidence === "R", `criterion ${criterion.id} must require release evidence R`);
    if (criterion.id < 29) {
      assert(criterion.local_evidence.length > 0, `criterion ${criterion.id} must not remain manual-only`);
    }
    for (const evidenceId of criterion.local_evidence) {
      assert(Object.hasOwn(registry.local_evidence, evidenceId), `criterion ${criterion.id} references unknown local evidence ${evidenceId}`);
      referencedEvidence.add(evidenceId);
    }
    for (const slot of criterion.live_evidence) {
      assert(slot !== "R" && EXPECTED_LIVE_SLOTS.includes(slot), `criterion ${criterion.id} references invalid live slot ${slot}`);
    }

    const tableRow = tableRows.get(criterion.id);
    assert(tableRow?.owner === criterion.owner, `criterion ${criterion.id} owner differs between table and registry`);
    const expectedSlots = [...criterion.live_evidence, "R"].sort();
    assert(exactArray([...tableRow.slots].sort(), expectedSlots), `criterion ${criterion.id} release slots differ between table and registry`);
  }

  // Post-MVP evidence may remain executable without becoming a Release 0.1
  // criterion dependency. Count those explicit denylist references as owned
  // before rejecting genuinely orphaned evidence definitions.
  for (const item of registry.post_mvp_denylist) {
    if (!Array.isArray(item?.evidence)) continue;
    for (const evidenceId of item.evidence) referencedEvidence.add(evidenceId);
  }

  for (const [evidenceId, evidence] of Object.entries(registry.local_evidence)) {
    assert(/^[a-z0-9][a-z0-9-]*$/.test(evidenceId), `invalid local evidence id ${evidenceId}`);
    assert(typeof evidence.title === "string" && evidence.title.length > 0, `${evidenceId} must have a title`);
    uniqueStrings(evidence.command, `${evidenceId} command`);
    uniqueStrings(evidence.paths, `${evidenceId} paths`);
    assert(evidence.command[0] === "node" || evidence.command[0] === "npm", `${evidenceId} command must use the canonical Node/npm toolchain`);
    for (const path of evidence.paths) {
      assertRelativeRepositoryPath(path, `${evidenceId} path`);
      assert(await pathExists(path), `${evidenceId} references a path absent from the candidate: ${path}`);
    }
    assert(referencedEvidence.has(evidenceId), `local evidence ${evidenceId} is orphaned`);
  }

  assert(exactArray(Object.keys(registry.live_evidence).sort(), [...EXPECTED_LIVE_SLOTS].sort()), "live evidence registry must define exactly W, P, MI, CX and R");
  for (const slot of EXPECTED_LIVE_SLOTS) {
    const evidence = registry.live_evidence[slot];
    assert(typeof evidence.owner === "string" && /^AND-\d+$/.test(evidence.owner), `live slot ${slot} must have one owner`);
    assertRelativeRepositoryPath(evidence.artifact_path.replace("{candidate_sha}", "candidate"), `live slot ${slot} artifact_path`);
    assert(evidence.artifact_path.includes("{candidate_sha}"), `live slot ${slot} artifact_path must include {candidate_sha}`);
  }

  const denylistIds = registry.post_mvp_denylist.map((item) => item.id).sort();
  assert(exactArray(denylistIds, [...EXPECTED_DENYLIST].sort()), "post-MVP denylist must cover every accepted exclusion exactly once");
  for (const item of registry.post_mvp_denylist) {
    assert(typeof item.claim === "string" && item.claim.length > 0, `denylist ${item.id} must describe the excluded claim`);
    uniqueStrings(item.evidence, `denylist ${item.id} evidence`);
    assert(item.evidence.length > 0, `denylist ${item.id} must have automated evidence`);
    for (const evidenceId of item.evidence) {
      assert(Object.hasOwn(registry.local_evidence, evidenceId), `denylist ${item.id} references unknown evidence ${evidenceId}`);
    }
  }

  const requiredGateFragments = [
    "node --test tests/unit/*.test.mjs tests/integration/*.test.mjs tests/conformance/*.test.mjs",
    "npm run validate:fixtures",
    "npm run check:architecture",
    "npm run check:docs",
    "npm run check:secrets",
    "node scripts/generate-readiness-report.mjs --sha HEAD --output build/readiness-report.json --local-gate-status passed",
  ];
  for (const fragment of requiredGateFragments) {
    assert(packageCheck.includes(fragment), `canonical check is missing required fragment: ${fragment}`);
  }
}

function validateDeploymentIdentity(deployment) {
  const fields = ["site_project_id", "site_version_id", "deployment_id", "live_url"];
  if (!deployment || typeof deployment !== "object" || Array.isArray(deployment)) return false;
  if (!fields.every((field) => typeof deployment[field] === "string" && deployment[field].length > 0)) return false;
  try {
    return new URL(deployment.live_url).protocol === "https:";
  } catch {
    return false;
  }
}

export function evaluateReceiptDocument({ slot, text, candidateSha, artifactPath }) {
  if (text === null) {
    return { slot, status: "pending", artifact_path: artifactPath, reason: "missing" };
  }

  const receiptHash = sha256(text);
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch {
    return { slot, status: "failed", artifact_path: artifactPath, reason: "invalid_json", receipt_sha256: receiptHash };
  }
  if (receipt.schema !== RECEIPT_SCHEMA || receipt.slot !== slot) {
    return { slot, status: "failed", artifact_path: artifactPath, reason: "contract_mismatch", receipt_sha256: receiptHash };
  }
  if (receipt.candidate_sha !== candidateSha) {
    return { slot, status: "failed", artifact_path: artifactPath, reason: "candidate_sha_mismatch", receipt_sha256: receiptHash };
  }
  if (!validateDeploymentIdentity(receipt.deployment)) {
    return { slot, status: "failed", artifact_path: artifactPath, reason: "deployment_identity_missing", receipt_sha256: receiptHash };
  }
  if (receipt.status !== "passed" && receipt.status !== "failed") {
    return { slot, status: "failed", artifact_path: artifactPath, reason: "invalid_status", receipt_sha256: receiptHash };
  }
  return {
    slot,
    status: receipt.status,
    artifact_path: artifactPath,
    reason: receipt.status === "failed" ? "owner_reported_failure" : null,
    receipt_sha256: receiptHash,
    deployment: receipt.deployment,
  };
}

function aggregateStatuses(statuses) {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("pending")) return "pending";
  if (statuses.every((status) => status === "not_required")) return "not_required";
  return "passed";
}

function normalizeReceiptIdentities(receipts) {
  const release = receipts.R;
  if (release.status !== "passed") return receipts;
  const releaseIdentity = JSON.stringify(release.deployment);
  for (const slot of ["W", "P", "MI", "CX"]) {
    const receipt = receipts[slot];
    if (receipt.status === "passed" && JSON.stringify(receipt.deployment) !== releaseIdentity) {
      receipts[slot] = {
        ...receipt,
        status: "failed",
        reason: "deployment_identity_mismatch",
      };
    }
  }
  return receipts;
}

export function buildReadinessReport({
  registry,
  candidateSha,
  candidateCommittedAt,
  traceabilitySha256,
  packageSha256,
  localGateStatus,
  receipts,
}) {
  assert(["pending", "passed", "failed"].includes(localGateStatus), "local gate status must be pending, passed or failed");
  const normalizedReceipts = normalizeReceiptIdentities(structuredClone(receipts));
  const criteria = registry.criteria
    .slice()
    .sort((left, right) => left.id - right.id)
    .map((criterion) => {
      const localStatus = criterion.local_evidence.length === 0 ? "not_required" : localGateStatus;
      const liveSlots = criterion.live_evidence.map((slot) => normalizedReceipts[slot]);
      const liveStatus = liveSlots.length === 0 ? "not_required" : aggregateStatuses(liveSlots.map((receipt) => receipt.status));
      const releaseStatus = normalizedReceipts.R.status;
      const acceptanceStatus = aggregateStatuses([localStatus, liveStatus]);
      return {
        id: criterion.id,
        evidence_id: `A${criterion.id}`,
        owner: criterion.owner,
        status: acceptanceStatus,
        release_readiness_status: aggregateStatuses([acceptanceStatus, releaseStatus]),
        local: {
          status: localStatus,
          evidence: criterion.local_evidence.map((id) => ({ id, ...registry.local_evidence[id] })),
        },
        live: { status: liveStatus, evidence: liveSlots },
        release_manifest: { status: releaseStatus, evidence: normalizedReceipts.R },
      };
    });

  const summary = { passed: 0, pending: 0, failed: 0 };
  for (const criterion of criteria) summary[criterion.status] += 1;
  const releaseSummary = { passed: 0, pending: 0, failed: 0 };
  for (const criterion of criteria) releaseSummary[criterion.release_readiness_status] += 1;
  const denylistStatus = localGateStatus;
  const reportStatus = aggregateStatuses(criteria.map((criterion) => criterion.release_readiness_status));

  return {
    schema: REPORT_SCHEMA,
    candidate_sha: candidateSha,
    candidate_committed_at: candidateCommittedAt,
    status: reportStatus,
    summary,
    release_summary: releaseSummary,
    local_gate: {
      status: localGateStatus,
      command: ["npm", "run", "check"],
      note: localGateStatus === "passed"
        ? "The report was reached after the canonical same-process gate sequence completed."
        : "No passing canonical-gate receipt was supplied; local evidence is not counted as passing.",
    },
    sources: {
      traceability: { path: TRACEABILITY_PATH, sha256: traceabilitySha256 },
      package: { path: "package.json", sha256: packageSha256 },
    },
    post_mvp_denylist: {
      status: denylistStatus,
      items: registry.post_mvp_denylist.map((item) => ({
        ...item,
        status: denylistStatus,
      })),
    },
    live_evidence: normalizedReceipts,
    criteria,
  };
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function git(repositoryRoot, args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function resolveCandidateSha(repositoryRoot, candidate) {
  try {
    const sha = git(repositoryRoot, ["rev-parse", "--verify", `${candidate}^{commit}`]);
    assert(/^[0-9a-f]{40}$/.test(sha), `candidate did not resolve to a full commit SHA: ${candidate}`);
    return sha;
  } catch (error) {
    throw new Error(`cannot resolve candidate commit ${candidate}: ${error.stderr?.trim() || error.message}`);
  }
}

function readCandidateText(repositoryRoot, candidateSha, path) {
  assertRelativeRepositoryPath(path, "candidate path");
  try {
    return execFileSync("git", ["show", `${candidateSha}:${path}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    throw new Error(`candidate ${candidateSha} does not contain ${path}`);
  }
}

function candidatePathExists(repositoryRoot, candidateSha, path) {
  try {
    execFileSync("git", ["cat-file", "-e", `${candidateSha}:${path}`], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function loadReceipts({ registry, repositoryRoot, candidateSha, evidenceDirectory }) {
  const receipts = {};
  for (const slot of EXPECTED_LIVE_SLOTS) {
    const configuredPath = registry.live_evidence[slot].artifact_path.replaceAll("{candidate_sha}", candidateSha);
    const artifactPath = evidenceDirectory
      ? resolve(evidenceDirectory, `${slot}.json`)
      : resolve(repositoryRoot, configuredPath);
    let text = null;
    try {
      text = await readFile(artifactPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    receipts[slot] = evaluateReceiptDocument({
      slot,
      text,
      candidateSha,
      artifactPath: configuredPath,
    });
  }
  return receipts;
}

function parseArguments(argv) {
  const options = {
    localGateStatus: "pending",
    requireReady: false,
    evidenceDirectory: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--require-ready") {
      options.requireReady = true;
      continue;
    }
    const value = argv[index + 1];
    assert(value !== undefined, `missing value for ${argument}`);
    index += 1;
    if (argument === "--sha") options.candidate = value;
    else if (argument === "--output") options.output = value;
    else if (argument === "--evidence-dir") options.evidenceDirectory = resolve(value);
    else if (argument === "--local-gate-status") options.localGateStatus = value;
    else throw new Error(`unknown argument ${argument}`);
  }
  assert(options.candidate, "--sha is required");
  assert(options.output, "--output is required");
  assert(["pending", "passed", "failed"].includes(options.localGateStatus), "--local-gate-status must be pending, passed or failed");
  return options;
}

export async function generateReadinessReport({
  repositoryRoot,
  candidate,
  output,
  evidenceDirectory = null,
  localGateStatus = "pending",
}) {
  const candidateSha = resolveCandidateSha(repositoryRoot, candidate);
  const traceabilityText = readCandidateText(repositoryRoot, candidateSha, TRACEABILITY_PATH);
  const packageText = readCandidateText(repositoryRoot, candidateSha, "package.json");
  const packageJson = JSON.parse(packageText);
  const { registry, tableRows } = parseTraceabilityDocument(traceabilityText);
  await validateRegistry(registry, {
    tableRows,
    pathExists: async (path) => candidatePathExists(repositoryRoot, candidateSha, path),
    packageCheck: packageJson.scripts?.check ?? "",
  });
  const receipts = await loadReceipts({ registry, repositoryRoot, candidateSha, evidenceDirectory });
  const report = buildReadinessReport({
    registry,
    candidateSha,
    candidateCommittedAt: git(repositoryRoot, ["show", "-s", "--format=%cI", candidateSha]),
    traceabilitySha256: sha256(traceabilityText),
    packageSha256: sha256(packageText),
    localGateStatus,
    receipts,
  });

  const outputPath = resolve(repositoryRoot, output);
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = resolve(dirname(outputPath), `.${basename(outputPath)}.${process.pid}.tmp`);
  await writeFile(temporaryPath, stableJson(report), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, outputPath);
  return { report, outputPath };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const { report, outputPath } = await generateReadinessReport({
    repositoryRoot,
    candidate: options.candidate,
    output: options.output,
    evidenceDirectory: options.evidenceDirectory,
    localGateStatus: options.localGateStatus,
  });
  console.log(`Readiness report ${report.status} for ${report.candidate_sha}: ${relative(repositoryRoot, outputPath)}`);
  if (report.status === "failed") process.exitCode = 1;
  else if (options.requireReady && report.status !== "passed") process.exitCode = 2;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Readiness report failed: ${error.message}`);
    process.exitCode = 1;
  });
}
