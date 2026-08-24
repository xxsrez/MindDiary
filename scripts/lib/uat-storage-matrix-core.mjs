import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const STORAGE_MATRIX_STATE_SCHEMA =
  "mind-diary/uat-storage-matrix-state/v1";
export const STORAGE_MATRIX_EVIDENCE_SCHEMA =
  "mind-diary/uat-storage-matrix-evidence/v1";
export const STORAGE_MATRIX_LINEAGE_SCHEMA =
  "mind-diary/sites-deployment-readback/v1";
export const STORAGE_MATRIX_FIXTURE_SCHEMA =
  "mind-diary/md288-brain-markdown-fixture/v1";

export const BRAIN_FIXTURE_FILE_COUNT = 1_741;
export const BRAIN_FIXTURE_LOGICAL_BYTES = 5_681_704;
export const BRAIN_FIXTURE_MARKER = "md288searchanchorunique";
export const BRAIN_FIXTURE_MARKER_PATH = "concepts/brain-note-1738.md";

export const IMPORT_BATCH_MAX_FILES = 256;
export const IMPORT_BATCH_MAX_BYTES = 4_194_304;

export const STORAGE_MATRIX_ASSERTIONS = Object.freeze([
  "lineage.same-candidate-distinct-deployments",
  "fixture.exact-brain-markdown-profile",
  "import.rest-plan-descriptor-readback",
  "import.multipart-checkpoint-before-redeploy",
  "import.checkpoint-persistence-after-redeploy",
  "import.bounded-validation-and-promotion-resume",
  "import.one-exact-head-revision",
  "mcp.modern-semantic-search-fetch-sha",
  "mcp.compat-semantic-search-fetch-sha",
  "export.exact-revision-download-sha",
  "cleanup.run-owned-mind-and-token-only",
]);

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const CANDIDATE_SHA = /^[0-9a-f]{40}$/u;
const PROJECT_ID = /^appgprj_[a-z0-9]+$/u;
const VERSION_ID = /^appgver_[a-z0-9]+$/u;
const DEPLOYMENT_ID = /^appgdep_[a-z0-9]+$/u;
const NONCE = /^[0-9a-f]{16}$/u;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

export class StorageMatrixFailure extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "StorageMatrixFailure";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function fail(code, details) {
  throw new StorageMatrixFailure(code, details);
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function safeCode(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value)
    ? value
    : "unexpected_response";
}

function requiredString(value, code) {
  if (typeof value !== "string" || value.length === 0) fail(code);
  return value;
}

export function candidateSha(value) {
  if (typeof value !== "string" || !CANDIDATE_SHA.test(value)) {
    fail("invalid_candidate_sha");
  }
  return value;
}

export function runNonce(value) {
  if (typeof value !== "string" || !NONCE.test(value)) fail("invalid_run_nonce");
  return value;
}

export function tokenIdFingerprint(value) {
  const tokenId = requiredString(value, "missing_dedicated_token_id");
  if (tokenId.length > 256 || /[\u0000-\u001f\u007f]/u.test(tokenId)) {
    fail("invalid_dedicated_token_id");
  }
  return sha256(`mind-diary:md288:token-id\0${tokenId}`);
}

function normalizedOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("invalid_lineage_live_url");
  }
  if (
    url.protocol !== "https:" || url.username || url.password ||
    url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")
  ) fail("invalid_lineage_live_url");
  return url.origin;
}

function exactKeys(value, expected, code) {
  if (!isRecord(value)) fail(code);
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    fail(code);
  }
}

export function validateLineageReceipt(value) {
  const keys = [
    "schema",
    "status",
    "candidate_sha",
    "site_project_id",
    "site_version_id",
    "deployment_id",
    "live_url",
    "observed_at_utc",
  ];
  exactKeys(value, keys, "invalid_lineage_receipt");
  if (value.schema !== STORAGE_MATRIX_LINEAGE_SCHEMA || value.status !== "succeeded") {
    fail("lineage_not_succeeded");
  }
  if (typeof value.site_project_id !== "string" || !PROJECT_ID.test(value.site_project_id)) {
    fail("invalid_lineage_project_id");
  }
  if (typeof value.site_version_id !== "string" || !VERSION_ID.test(value.site_version_id)) {
    fail("invalid_lineage_version_id");
  }
  if (typeof value.deployment_id !== "string" || !DEPLOYMENT_ID.test(value.deployment_id)) {
    fail("invalid_lineage_deployment_id");
  }
  if (
    typeof value.observed_at_utc !== "string" ||
    !UTC_INSTANT.test(value.observed_at_utc) ||
    !Number.isFinite(Date.parse(value.observed_at_utc))
  ) fail("invalid_lineage_observed_at");
  return Object.freeze({
    schema: STORAGE_MATRIX_LINEAGE_SCHEMA,
    status: "succeeded",
    candidate_sha: candidateSha(value.candidate_sha),
    site_project_id: value.site_project_id,
    site_version_id: value.site_version_id,
    deployment_id: value.deployment_id,
    live_url: normalizedOrigin(value.live_url),
    observed_at_utc: value.observed_at_utc,
  });
}

export function assertLineageTransition(prepared, observed) {
  const left = validateLineageReceipt(prepared);
  const right = validateLineageReceipt(observed);
  if (left.candidate_sha !== right.candidate_sha) fail("lineage_candidate_mismatch");
  if (left.site_project_id !== right.site_project_id) fail("lineage_project_mismatch");
  if (left.live_url !== right.live_url) fail("lineage_live_url_mismatch");
  if (left.deployment_id === right.deployment_id) fail("redeploy_boundary_not_observed");
  return Object.freeze({ prepared: left, observed: right });
}

function compareUnicodeScalar(left, right) {
  const a = Array.from(left, (value) => value.codePointAt(0));
  const b = Array.from(right, (value) => value.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function conceptSource(index, padding) {
  const ordinal = String(index).padStart(4, "0");
  const marker = index === 1_738
    ? `\nSearch marker: ${BRAIN_FIXTURE_MARKER}.`
    : "";
  return `---\ntype: Reference\ntitle: Synthetic Brain Note ${ordinal}\ndescription: Deterministic MD-288 storage fixture.\nstatus: stable\ngenerated:\n  by: process:mind-diary-md288\n  at: 2026-08-24T00:00:00Z\n---\n\n# Synthetic Brain Note ${ordinal}\n\nFixture ordinal ${ordinal}.${marker}\n\nPadding:\n${"x".repeat(padding)}\n`;
}

function fixtureSkeleton() {
  const links = Array.from({ length: BRAIN_FIXTURE_FILE_COUNT - 2 }, (_unused, index) => {
    const ordinal = String(index).padStart(4, "0");
    return `- [Synthetic Brain Note ${ordinal}](concepts/brain-note-${ordinal}.md)`;
  }).join("\n");
  const files = [
    {
      path: "index.md",
      text: `---\nokf_version: "0.2"\n---\n\n# MD-288 Synthetic Brain\n\nDeterministic public synthetic storage fixture.\n\n${links}\n`,
    },
    {
      path: "log.md",
      text: "# Fixture Log\n\n## 2026-08-24\n\n- **Create**: Generated the deterministic MD-288 Brain-scale fixture.\n",
    },
    ...Array.from({ length: BRAIN_FIXTURE_FILE_COUNT - 2 }, (_unused, index) => ({
      path: `concepts/brain-note-${String(index).padStart(4, "0")}.md`,
      text: conceptSource(index, 0),
    })),
  ];
  return files.sort((left, right) => compareUnicodeScalar(left.path, right.path));
}

export function createBrainMarkdownFixture() {
  const encoder = new TextEncoder();
  const skeleton = fixtureSkeleton();
  const baseBytes = skeleton.reduce(
    (total, file) => total + encoder.encode(file.text).byteLength,
    0,
  );
  const deficit = BRAIN_FIXTURE_LOGICAL_BYTES - baseBytes;
  const conceptCount = BRAIN_FIXTURE_FILE_COUNT - 2;
  if (deficit < 0) fail("fixture_target_too_small", { baseBytes });
  const perConcept = Math.floor(deficit / conceptCount);
  const remainder = deficit % conceptCount;
  const files = skeleton.map((file) => {
    let text = file.text;
    if (file.path.startsWith("concepts/")) {
      const index = Number(/brain-note-(\d{4})\.md$/u.exec(file.path)?.[1]);
      text = conceptSource(index, perConcept + (index < remainder ? 1 : 0));
    }
    const bytes = encoder.encode(text);
    return Object.freeze({
      path: file.path,
      text,
      bytes,
      size: bytes.byteLength,
      sha256: sha256(bytes),
    });
  });
  const logicalBytes = files.reduce((total, file) => total + file.size, 0);
  if (files.length !== BRAIN_FIXTURE_FILE_COUNT || logicalBytes !== BRAIN_FIXTURE_LOGICAL_BYTES) {
    fail("fixture_size_invariant_failed", { fileCount: files.length, logicalBytes });
  }
  if (files.some((file) => file.size > 1_048_576)) fail("fixture_file_too_large");
  const descriptors = files.map(({ path, sha256: digest, size }) => ({
    path,
    sha256: digest,
    size,
  }));
  const descriptorSha256 = sha256(JSON.stringify(descriptors));
  const marker = files.find(({ path }) => path === BRAIN_FIXTURE_MARKER_PATH);
  if (marker === undefined || !marker.text.includes(BRAIN_FIXTURE_MARKER)) {
    fail("fixture_marker_missing");
  }
  return Object.freeze({
    schema: STORAGE_MATRIX_FIXTURE_SCHEMA,
    files: Object.freeze(files),
    descriptors: Object.freeze(descriptors.map(Object.freeze)),
    file_count: files.length,
    logical_bytes: logicalBytes,
    descriptor_sha256: descriptorSha256,
    marker_sha256: marker.sha256,
  });
}

export function createImportBatches(files) {
  if (!Array.isArray(files) || files.length === 0) fail("empty_fixture");
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const file of files) {
    if (
      current.length > 0 &&
      (current.length >= IMPORT_BATCH_MAX_FILES || bytes + file.size > IMPORT_BATCH_MAX_BYTES)
    ) {
      batches.push(Object.freeze(current));
      current = [];
      bytes = 0;
    }
    if (file.size > IMPORT_BATCH_MAX_BYTES) fail("fixture_file_exceeds_batch_limit");
    current.push(file);
    bytes += file.size;
  }
  if (current.length > 0) batches.push(Object.freeze(current));
  if (batches.some((batch) =>
    batch.length > IMPORT_BATCH_MAX_FILES ||
    batch.reduce((total, file) => total + file.size, 0) > IMPORT_BATCH_MAX_BYTES)) {
    fail("fixture_batch_invariant_failed");
  }
  return Object.freeze(batches);
}

function parseJson(text, code) {
  try {
    return JSON.parse(text);
  } catch {
    fail(code);
  }
}

export function parseMcpHttpPayload(text, contentType = "application/json") {
  if (typeof text !== "string") fail("invalid_mcp_response");
  if (contentType.toLowerCase().startsWith("text/event-stream")) {
    const payloads = [];
    for (const record of text.split(/\r?\n\r?\n/u)) {
      const data = record.split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data && data !== "[DONE]") payloads.push(parseJson(data, "invalid_mcp_sse_json"));
    }
    if (payloads.length === 0) fail("missing_mcp_sse_payload");
    return payloads.at(-1);
  }
  return parseJson(text, "invalid_mcp_json");
}

export function classifyMcpEnvelope(status, envelope) {
  if (status !== 200 || !isRecord(envelope)) {
    return Object.freeze({
      kind: "failure",
      status,
      code: status === 401 ? "authentication_required" : "mcp_transport_failed",
      retryable: status >= 500,
    });
  }
  if (isRecord(envelope.error)) {
    return Object.freeze({
      kind: "failure",
      status,
      code: safeCode(envelope.error.code),
      retryable: false,
    });
  }
  const result = envelope.result;
  if (!isRecord(result)) {
    return Object.freeze({ kind: "failure", status, code: "invalid_mcp_result", retryable: false });
  }
  if (result.isError === true) {
    const error = result.structuredContent?.error;
    return Object.freeze({
      kind: "failure",
      status,
      code: safeCode(error?.code),
      retryable: error?.retryable === true,
    });
  }
  const data = result.structuredContent?.data;
  if (!isRecord(data)) {
    return Object.freeze({ kind: "failure", status, code: "invalid_mcp_result", retryable: false });
  }
  return Object.freeze({ kind: "success", status, data });
}

export function requireMcpData(status, envelope, failureCode = "mcp_request_failed") {
  const outcome = classifyMcpEnvelope(status, envelope);
  if (outcome.kind !== "success") {
    fail(failureCode, {
      status: outcome.status,
      applicationCode: safeCode(outcome.code),
      retryable: outcome.retryable,
    });
  }
  return outcome.data;
}

function readUint16(bytes, offset) {
  if (offset + 2 > bytes.byteLength) fail("invalid_export_zip");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function readUint32(bytes, offset) {
  if (offset + 4 > bytes.byteLength) fail("invalid_export_zip");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function inspectDeterministicStoredZip(archive, fixture) {
  const bytes = archive instanceof Uint8Array ? archive : new Uint8Array(archive);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const expected = new Map(fixture.files.map((file) => [file.path, file]));
  const seen = new Set();
  const localEntries = [];
  let offset = 0;
  let contentBytes = 0;
  while (offset + 4 <= bytes.byteLength && readUint32(bytes, offset) === 0x04034b50) {
    const localOffset = offset;
    if (offset + 30 > bytes.byteLength) fail("invalid_export_zip");
    const versionNeeded = readUint16(bytes, offset + 4);
    const flags = readUint16(bytes, offset + 6);
    const compression = readUint16(bytes, offset + 8);
    const modifiedTime = readUint16(bytes, offset + 10);
    const modifiedDate = readUint16(bytes, offset + 12);
    const expectedCrc = readUint32(bytes, offset + 14);
    const compressedSize = readUint32(bytes, offset + 18);
    const size = readUint32(bytes, offset + 22);
    const nameLength = readUint16(bytes, offset + 26);
    const extraLength = readUint16(bytes, offset + 28);
    if (
      versionNeeded !== 20 || flags !== 0x0800 || compression !== 0 ||
      modifiedTime !== 0 || modifiedDate !== 0x0021
    ) {
      fail("unsupported_export_zip_profile");
    }
    if (compressedSize !== size || extraLength !== 0 || nameLength === 0) {
      fail("invalid_export_zip_entry");
    }
    const nameStart = offset + 30;
    const bodyStart = nameStart + nameLength;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > bytes.byteLength) fail("invalid_export_zip_entry");
    let path;
    try {
      path = decoder.decode(bytes.subarray(nameStart, bodyStart));
    } catch {
      fail("invalid_export_zip_path");
    }
    if (seen.has(path)) fail("duplicate_export_zip_entry");
    const expectedFile = expected.get(path);
    if (expectedFile === undefined) fail("unexpected_export_zip_entry");
    const body = bytes.subarray(bodyStart, bodyEnd);
    if (
      expectedFile.size !== body.byteLength ||
      expectedFile.sha256 !== sha256(body) ||
      expectedCrc !== crc32(body)
    ) fail("export_zip_entry_integrity_failed");
    seen.add(path);
    localEntries.push(Object.freeze({
      path,
      crc32: expectedCrc,
      size,
      flags,
      local_offset: localOffset,
    }));
    contentBytes += body.byteLength;
    offset = bodyEnd;
  }
  const expectedOrder = fixture.files.map((file) => file.path);
  if (
    localEntries.length !== expectedOrder.length ||
    localEntries.some((entry, index) => entry.path !== expectedOrder[index])
  ) fail("export_zip_entry_order_mismatch");
  if (seen.size !== expected.size || [...expected.keys()].some((path) => !seen.has(path))) {
    fail("export_zip_snapshot_incomplete");
  }
  const centralOffset = offset;
  for (const local of localEntries) {
    if (offset + 46 > bytes.byteLength || readUint32(bytes, offset) !== 0x02014b50) {
      fail("export_zip_central_directory_missing");
    }
    const versionMadeBy = readUint16(bytes, offset + 4);
    const versionNeeded = readUint16(bytes, offset + 6);
    const flags = readUint16(bytes, offset + 8);
    const compression = readUint16(bytes, offset + 10);
    const modifiedTime = readUint16(bytes, offset + 12);
    const modifiedDate = readUint16(bytes, offset + 14);
    const entryCrc = readUint32(bytes, offset + 16);
    const compressedSize = readUint32(bytes, offset + 20);
    const size = readUint32(bytes, offset + 24);
    const nameLength = readUint16(bytes, offset + 28);
    const extraLength = readUint16(bytes, offset + 30);
    const commentLength = readUint16(bytes, offset + 32);
    const diskStart = readUint16(bytes, offset + 34);
    const internalAttributes = readUint16(bytes, offset + 36);
    const externalAttributes = readUint32(bytes, offset + 38);
    const localOffset = readUint32(bytes, offset + 42);
    const nameStart = offset + 46;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (next > bytes.byteLength) fail("invalid_export_zip_central_entry");
    let path;
    try {
      path = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    } catch {
      fail("invalid_export_zip_path");
    }
    if (
      versionMadeBy !== 0x0314 || versionNeeded !== 20 ||
      flags !== local.flags || compression !== 0 || modifiedTime !== 0 ||
      modifiedDate !== 0x0021 || entryCrc !== local.crc32 ||
      compressedSize !== local.size || size !== local.size ||
      extraLength !== 0 || commentLength !== 0 || diskStart !== 0 ||
      internalAttributes !== 0 || externalAttributes !== 0x81a40000 ||
      localOffset !== local.local_offset || path !== local.path
    ) fail("invalid_export_zip_central_entry");
    offset = next;
  }
  const centralSize = offset - centralOffset;
  if (offset + 22 > bytes.byteLength || readUint32(bytes, offset) !== 0x06054b50) {
    fail("export_zip_eocd_missing");
  }
  const diskNumber = readUint16(bytes, offset + 4);
  const centralDisk = readUint16(bytes, offset + 6);
  const entriesOnDisk = readUint16(bytes, offset + 8);
  const totalEntries = readUint16(bytes, offset + 10);
  const recordedCentralSize = readUint32(bytes, offset + 12);
  const recordedCentralOffset = readUint32(bytes, offset + 16);
  const commentLength = readUint16(bytes, offset + 20);
  if (
    diskNumber !== 0 || centralDisk !== 0 ||
    entriesOnDisk !== localEntries.length || totalEntries !== localEntries.length ||
    recordedCentralSize !== centralSize || recordedCentralOffset !== centralOffset ||
    commentLength !== 0 || offset + 22 !== bytes.byteLength
  ) fail("invalid_export_zip_eocd");
  return Object.freeze({
    entry_count: seen.size,
    content_bytes: contentBytes,
    archive_sha256: sha256(bytes),
    archive_size: bytes.byteLength,
  });
}

function assertPrivateDocumentSafe(value) {
  const text = JSON.stringify(value);
  for (const pattern of [
    /mdp_v1_/iu,
    /mdg_v1_/iu,
    /mdo_(?:code|access|refresh)_/iu,
    /hmac-sha256:/iu,
    /@[a-z0-9.-]+\.[a-z]{2,}/iu,
    /(?:authorization|cookie|csrf|password|secret|download_url)["']?\s*:/iu,
  ]) {
    if (pattern.test(text)) fail("unsafe_private_state_document");
  }
  return value;
}

export function sealPrivateState(value) {
  if (!isRecord(value) || Object.hasOwn(value, "state_sha256")) fail("invalid_private_state");
  assertPrivateDocumentSafe(value);
  return Object.freeze({
    ...value,
    state_sha256: sha256(canonical(value)),
  });
}

export function validatePrivateState(value) {
  if (!isRecord(value) || value.schema !== STORAGE_MATRIX_STATE_SCHEMA) {
    fail("invalid_state_schema");
  }
  const { state_sha256: stateSha256, ...unsigned } = value;
  if (!SHA256.test(String(stateSha256 ?? "")) || sha256(canonical(unsigned)) !== stateSha256) {
    fail("state_integrity_mismatch");
  }
  candidateSha(value.candidate_sha);
  runNonce(value.run_nonce);
  if (!isRecord(value.prepared_lineage)) fail("missing_prepared_lineage");
  validateLineageReceipt(value.prepared_lineage);
  if (!isRecord(value.fixture) || value.fixture.schema !== STORAGE_MATRIX_FIXTURE_SCHEMA) {
    fail("invalid_state_fixture");
  }
  if (
    value.fixture.file_count !== BRAIN_FIXTURE_FILE_COUNT ||
    value.fixture.logical_bytes !== BRAIN_FIXTURE_LOGICAL_BYTES ||
    !SHA256.test(String(value.fixture.descriptor_sha256 ?? "")) ||
    !SHA256.test(String(value.fixture.marker_sha256 ?? ""))
  ) fail("invalid_state_fixture");
  assertPrivateDocumentSafe(value);
  return Object.freeze({ ...value });
}

async function assertPrivateFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) fail("state_file_not_regular");
  if ((info.mode & 0o077) !== 0) fail("state_file_permissions_too_broad");
}

export async function readPrivateState(path) {
  const target = resolve(path);
  await assertPrivateFile(target);
  return validatePrivateState(parseJson(await readFile(target, "utf8"), "invalid_state_json"));
}

export async function writePrivateJson(path, value, { exclusive = false } = {}) {
  const target = resolve(path);
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let handle;
  try {
    if (exclusive) {
      try {
        await lstat(target);
        fail("state_file_already_exists");
      } catch (error) {
        if (error instanceof StorageMatrixFailure) throw error;
        if (error?.code !== "ENOENT") throw error;
      }
    }
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    await chmod(target, 0o600);
    await assertPrivateFile(target);
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return target;
}

export async function writePrivateState(path, value, options) {
  return writePrivateJson(path, sealPrivateState(value), options);
}

function assertEvidenceSafe(value) {
  const text = JSON.stringify(value);
  for (const pattern of [
    /https?:\/\//iu,
    /@[a-z0-9.-]+\.[a-z]{2,}/iu,
    /mdp_v1_/iu,
    /mdg_v1_/iu,
    /mdo_(?:code|access|refresh)_/iu,
    /hmac-sha256:/iu,
    /(?:authorization|cookie|csrf|password|secret|download_?url)["']?\s*:/iu,
    /(?:principal|space|revision|token|binding|import|export|job)_[a-z0-9]/iu,
  ]) {
    if (pattern.test(text)) fail("unsafe_evidence_document");
  }
  return value;
}

export function createStorageMatrixEvidence({
  state,
  observedLineage,
  completedAt,
}) {
  const current = validatePrivateState(state);
  const transition = assertLineageTransition(current.prepared_lineage, observedLineage);
  if (
    !new Set(["cleaned_evidence_pending", "cleaned"]).has(current.status) ||
    !isRecord(current.verification)
  ) {
    fail("verification_or_cleanup_incomplete");
  }
  if (
    typeof completedAt !== "string" || !UTC_INSTANT.test(completedAt) ||
    !Number.isFinite(Date.parse(completedAt))
  ) fail("invalid_completion_time");
  const verification = current.verification;
  for (const digest of [
    verification.modern_fetch_sha256,
    verification.compat_fetch_sha256,
    verification.archive_sha256,
  ]) if (!SHA256.test(String(digest ?? ""))) fail("invalid_verification_digest");
  const unsigned = Object.freeze({
    schema: STORAGE_MATRIX_EVIDENCE_SCHEMA,
    status: "passed",
    candidate_sha: current.candidate_sha,
    project_id: transition.observed.site_project_id,
    prepared_version_id: transition.prepared.site_version_id,
    prepared_deployment_id: transition.prepared.deployment_id,
    observed_version_id: transition.observed.site_version_id,
    observed_deployment_id: transition.observed.deployment_id,
    fixture: Object.freeze({
      file_count: current.fixture.file_count,
      logical_bytes: current.fixture.logical_bytes,
      descriptor_sha256: current.fixture.descriptor_sha256,
      marker_sha256: current.fixture.marker_sha256,
    }),
    import: Object.freeze({
      interrupted_checkpoint: current.import.interrupted_checkpoint,
      total_batches: current.import.total_batches,
      committed_file_count: verification.committed_file_count,
      committed_logical_bytes: verification.committed_logical_bytes,
    }),
    mcp: Object.freeze({
      protocols: Object.freeze(["2026-07-28", "2025-11-25"]),
      modern_fetch_sha256: verification.modern_fetch_sha256,
      compat_fetch_sha256: verification.compat_fetch_sha256,
    }),
    export: Object.freeze({
      archive_sha256: verification.archive_sha256,
      archive_size: verification.archive_size,
      entry_count: verification.export_entry_count,
      content_bytes: verification.export_content_bytes,
    }),
    assertions: Object.freeze(STORAGE_MATRIX_ASSERTIONS.map((id) =>
      Object.freeze({ id, status: "passed" }))),
    completed_at_utc: completedAt,
  });
  assertEvidenceSafe(unsigned);
  return Object.freeze({
    ...unsigned,
    artifact_sha256: sha256(canonical(unsigned)),
  });
}

export function fixtureStateProjection(fixture) {
  return Object.freeze({
    schema: fixture.schema,
    file_count: fixture.file_count,
    logical_bytes: fixture.logical_bytes,
    descriptor_sha256: fixture.descriptor_sha256,
    marker_sha256: fixture.marker_sha256,
  });
}

export function safeLocalPath(value, code = "invalid_path") {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) fail(code);
  return resolve(value);
}

export function stateDirectory(path) {
  return dirname(safeLocalPath(path));
}
