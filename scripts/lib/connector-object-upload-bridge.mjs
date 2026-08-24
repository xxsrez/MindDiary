import { createHash } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const CONNECTOR_OBJECT_BRIDGE_FORMAT =
  "mind-diary-connector-object-upload-private-v1";
export const CONNECTOR_OBJECT_RECEIPT_FORMAT =
  "mind-diary-connector-object-upload-receipt-v1";
export const CONNECTOR_OBJECT_BRIDGE_LIMITS = Object.freeze({
  maxFileBytes: 67_108_864,
  requestTimeoutMilliseconds: 30_000,
  statusTimeoutMilliseconds: 5_000,
  maxResponseBytes: 65_536,
  maxPrivateStateBytes: 32_768,
});

/**
 * Exact wire seam implemented by MD-272 `create_file_upload_intent`.
 *
 * - The MCP tool pins write binding, source kind, safe metadata and
 *   idempotency, then returns one private `upload_url`.
 * - This bridge PUTs raw `application/octet-stream` bytes to that URL without
 *   Authorization, Cookie or redirects.
 * - A GET to the same URL is status-only and never consumes the intent.
 * - `reconcile_file_stage` remains the authoritative MCP reconciliation step;
 *   this bridge deliberately does not emit a staged ref.
 */
export const MD272_UPLOAD_INTENT_WIRE = Object.freeze({
  issueTool: "create_file_upload_intent",
  issueInputFields: Object.freeze([
    "write_binding_id",
    "source_kind",
    "display_filename",
    "claimed_media_type",
    "expected_size",
    "expected_sha256",
    "idempotency_key",
  ]),
  issueOutputFields: Object.freeze(["upload_url", "expires_at", "replayed"]),
  sourceKind: "connector_object",
  uploadPathPrefix: "/api/file-ingress/upload-intents/mdupload_v1_",
  method: "PUT",
  statusMethod: "GET",
  contentType: "application/octet-stream",
  authorization: "none",
  redirect: "manual",
  intentTtlSeconds: 600,
  putSuccessStatus: 201,
  putSuccessDataStatus: "staged",
  getPendingDataStatus: "pending",
  getStagedDataStatus: "staged",
  getRejectedDataStatus: "rejected",
  errorStatuses: Object.freeze({
    file_ingress_intent_conflict: 409,
    file_ingress_intent_expired: 410,
    file_ingress_source_unavailable: 404,
    transient_unavailable: 503,
  }),
  sameOriginRequired: true,
});

const PRIVATE_STATE_KEYS = Object.freeze([
  "format",
  "provider_profile",
  "source_kind",
  "materialized_file_path",
  "upload_url",
  "display_filename",
  "claimed_media_type",
  "expected_size",
  "expected_sha256",
]);
// Google Drive raw fetch/download returns a materializable `file_uri` and an
// outer `workspace_path`. The caller maps only that already-materialized path
// to `materialized_file_path`; `file_uri`, provider URL and base64 are
// deliberately absent from this exact private schema. The containing trusted
// root arrives separately through local configuration.
const CONTROL = /[\u0000-\u001f\u007f]/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const CAPABILITY_PATH =
  /^\/api\/file-ingress\/upload-intents\/mdupload_v1_[A-Za-z0-9_-]{16,4096}$/u;
const ALLOWED_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/zip",
]);
const EXTENSIONS = Object.freeze({
  "image/png": Object.freeze([".png"]),
  "image/jpeg": Object.freeze([".jpg", ".jpeg"]),
  "image/gif": Object.freeze([".gif"]),
  "image/webp": Object.freeze([".webp"]),
  "application/pdf": Object.freeze([".pdf"]),
  "application/zip": Object.freeze([".zip"]),
});
const SUCCESS_STATUSES = new Set([
  "staged",
  "already_staged",
  "staged_reconciled",
]);

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length &&
    keys.every((key, index) => key === sorted[index]);
}

function safeFilename(value) {
  return typeof value === "string" && value.length > 0 &&
    value === value.normalize("NFC") &&
    !value.includes("/") && !value.includes("\\") &&
    value !== "." && value !== ".." && !CONTROL.test(value) &&
    new TextEncoder().encode(value).byteLength <= 255;
}

function safeAbsolutePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384 &&
    isAbsolute(value) && resolve(value) === value && !CONTROL.test(value);
}

function safeMaterializationRoot(value) {
  return safeAbsolutePath(value) && value !== resolve("/");
}

function canonicalMaterializationRoot(value) {
  if (!safeMaterializationRoot(value)) return null;
  try {
    const entry = lstatSync(value);
    const canonicalPath = realpathSync(value);
    return !entry.isSymbolicLink() && entry.isDirectory() && canonicalPath === value
      ? canonicalPath
      : null;
  } catch {
    return null;
  }
}

function pathBelowRoot(value, root) {
  if (!safeAbsolutePath(value) || !safeMaterializationRoot(root)) return false;
  const below = relative(root, value);
  return below.length > 0 && below !== ".." && !below.startsWith(`..${sep}`) &&
    !isAbsolute(below);
}

function extensionMatches(filename, mediaType) {
  const extensions = EXTENSIONS[mediaType];
  const lower = filename.toLocaleLowerCase("en-US");
  return extensions?.some((extension) => lower.endsWith(extension)) === true;
}

function canonicalOrigin(value) {
  if (typeof value !== "string" || value.length > 2_048 || CONTROL.test(value)) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" &&
      value === url.origin ? url.origin : null;
  } catch {
    return null;
  }
}

function validCapabilityUrl(value, expectedOrigin) {
  const origin = canonicalOrigin(expectedOrigin);
  if (origin === null) return false;
  if (typeof value !== "string" || value.length > 8_192 || CONTROL.test(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.origin === origin && url.protocol === "https:" &&
      url.username === "" && url.password === "" &&
      url.search === "" && url.hash === "" && CAPABILITY_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

function parsePrivateState(value, expectedOrigin, materializationRoot) {
  if (!record(value) || !exactKeys(value, PRIVATE_STATE_KEYS) ||
      value.format !== CONNECTOR_OBJECT_BRIDGE_FORMAT ||
      value.provider_profile !== "google_drive" ||
      value.source_kind !== "connector_object" ||
      !pathBelowRoot(value.materialized_file_path, materializationRoot) ||
      !validCapabilityUrl(value.upload_url, expectedOrigin) ||
      !safeFilename(value.display_filename) ||
      typeof value.claimed_media_type !== "string" ||
      !ALLOWED_MEDIA_TYPES.has(value.claimed_media_type) ||
      !Number.isSafeInteger(value.expected_size) || value.expected_size < 0 ||
      value.expected_size > CONNECTOR_OBJECT_BRIDGE_LIMITS.maxFileBytes ||
      typeof value.expected_sha256 !== "string" ||
      !SHA256.test(value.expected_sha256)) {
    return null;
  }
  return Object.freeze({ ...value });
}

export function connectorObjectReceipt({
  status,
  displayFilename = null,
  mediaType = null,
  size = null,
  sha256 = null,
}) {
  return Object.freeze({
    format: CONNECTOR_OBJECT_RECEIPT_FORMAT,
    provider_profile: "google_drive",
    source_kind: "connector_object",
    status,
    safe_filename: displayFilename,
    media_type: mediaType,
    size,
    sha256,
  });
}

export function isSuccessfulConnectorObjectReceipt(receipt) {
  return record(receipt) && SUCCESS_STATUSES.has(receipt.status);
}

function fileKind(entry) {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "regular";
  return "special";
}

function snapshot(entry, canonicalPath) {
  return [
    canonicalPath,
    String(entry.dev),
    String(entry.ino),
    String(entry.size),
    String(entry.mtimeMs),
    String(entry.ctimeMs),
  ].join(":");
}

function cancelled(signal) {
  return signal?.aborted === true;
}

async function inspectMaterializationRoot(materializationRoot) {
  let entry;
  let canonicalPath;
  try {
    [entry, canonicalPath] = await Promise.all([
      lstat(materializationRoot),
      realpath(materializationRoot),
    ]);
  } catch {
    return null;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory() ||
      canonicalPath !== materializationRoot) {
    return null;
  }
  return Object.freeze({
    canonicalPath,
    snapshot: snapshot(entry, canonicalPath),
  });
}

async function inspectMaterializedPath(materializationRoot, privatePath) {
  if (!pathBelowRoot(privatePath, materializationRoot)) {
    return Object.freeze({ kind: "outside_root" });
  }
  const parts = relative(materializationRoot, privatePath).split(sep);
  let cursor = materializationRoot;
  let entry = null;
  try {
    for (let index = 0; index < parts.length; index += 1) {
      cursor = resolve(cursor, parts[index]);
      entry = await lstat(cursor);
      if (entry.isSymbolicLink()) return Object.freeze({ kind: "symlink" });
      if (index < parts.length - 1 && !entry.isDirectory()) {
        return Object.freeze({ kind: "special" });
      }
    }
  } catch {
    return Object.freeze({ kind: "missing" });
  }
  const kind = fileKind(entry);
  return kind === "regular"
    ? Object.freeze({ kind, entry })
    : Object.freeze({ kind });
}

/** Node/macOS source adapter. The private path never leaves this method. */
export class NodeMaterializedConnectorFileSource {
  #materializationRoot;

  constructor({ materializationRoot } = {}) {
    const canonicalRoot = canonicalMaterializationRoot(materializationRoot);
    if (canonicalRoot === null) {
      throw new TypeError("Connector materialization root is invalid");
    }
    this.#materializationRoot = canonicalRoot;
  }

  async read(privatePath, { maxBytes, signal } = {}) {
    if (!pathBelowRoot(privatePath, this.#materializationRoot) ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      return Object.freeze({ kind: "unavailable" });
    }
    if (cancelled(signal)) return Object.freeze({ kind: "interrupted" });
    const rootBefore = await inspectMaterializationRoot(this.#materializationRoot);
    if (rootBefore === null) return Object.freeze({ kind: "invalid_root" });
    const inspectedBefore = await inspectMaterializedPath(
      this.#materializationRoot,
      privatePath,
    );
    if (inspectedBefore.kind !== "regular") return inspectedBefore;
    const before = inspectedBefore.entry;
    let canonicalBefore;
    try {
      canonicalBefore = await realpath(privatePath);
    } catch {
      return Object.freeze({ kind: "missing" });
    }
    if (!pathBelowRoot(canonicalBefore, rootBefore.canonicalPath)) {
      return Object.freeze({ kind: "outside_root" });
    }
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxBytes) {
      return Object.freeze({ kind: "oversize" });
    }
    const beforeSnapshot = snapshot(before, canonicalBefore);
    let handle;
    try {
      handle = await open(privatePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch {
      return Object.freeze({ kind: "changed" });
    }
    const chunks = [];
    let total = 0;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || snapshot(opened, canonicalBefore) !== beforeSnapshot) {
        return Object.freeze({ kind: "changed" });
      }
      const bufferSize = Math.min(1024 * 1024, Math.max(1, maxBytes || 1));
      while (true) {
        if (cancelled(signal)) return Object.freeze({ kind: "interrupted" });
        const buffer = new Uint8Array(bufferSize);
        const next = await handle.read(buffer, 0, buffer.byteLength, null);
        if (next.bytesRead === 0) break;
        total += next.bytesRead;
        if (total > maxBytes) return Object.freeze({ kind: "oversize" });
        chunks.push(new Uint8Array(buffer.subarray(0, next.bytesRead)));
      }
      const openedAfter = await handle.stat();
      if (snapshot(openedAfter, canonicalBefore) !== beforeSnapshot || total !== before.size) {
        return Object.freeze({ kind: "changed" });
      }
    } catch {
      return Object.freeze({ kind: cancelled(signal) ? "interrupted" : "unavailable" });
    } finally {
      await handle.close().catch(() => undefined);
    }
    const inspectedAfter = await inspectMaterializedPath(
      this.#materializationRoot,
      privatePath,
    );
    if (inspectedAfter.kind !== "regular") {
      return Object.freeze({ kind: "changed" });
    }
    const after = inspectedAfter.entry;
    let canonicalAfter;
    try {
      canonicalAfter = await realpath(privatePath);
    } catch {
      return Object.freeze({ kind: "changed" });
    }
    const rootAfter = await inspectMaterializationRoot(this.#materializationRoot);
    if (rootAfter === null || rootAfter.snapshot !== rootBefore.snapshot ||
        !pathBelowRoot(canonicalAfter, rootAfter.canonicalPath) ||
        snapshot(after, canonicalAfter) !== beforeSnapshot) {
      return Object.freeze({ kind: "changed" });
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return Object.freeze({ kind: "ready", bytes });
  }
}

function startsWith(bytes, signature) {
  return signature.every((value, index) => bytes[index] === value);
}

export function detectConnectorObjectMediaType(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
      startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return "image/gif";
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 &&
      bytes[11] === 0x50) {
    return "image/webp";
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
      startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
      startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])) {
    return "application/zip";
  }
  return null;
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function deadlineSignal(upstream, milliseconds) {
  const controller = new AbortController();
  let reason = null;
  const interrupt = () => {
    reason = "interrupted";
    controller.abort();
  };
  if (upstream?.aborted) interrupt();
  else upstream?.addEventListener("abort", interrupt, { once: true });
  const timer = setTimeout(() => {
    reason = "timeout";
    controller.abort();
  }, milliseconds);
  let closed = false;
  return Object.freeze({
    signal: controller.signal,
    reason: () => reason,
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      upstream?.removeEventListener("abort", interrupt);
    },
  });
}

async function readWithSignal(reader, signal) {
  if (signal?.aborted) throw new Error("response read interrupted");
  if (signal === undefined) return reader.read();
  return new Promise((resolveRead, rejectRead) => {
    const abort = () => rejectRead(new Error("response read interrupted"));
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then(resolveRead, rejectRead).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

async function boundedJson(response, signal) {
  const declared = response.headers.get("content-length");
  if (declared !== null &&
      (!/^(?:0|[1-9][0-9]*)$/u.test(declared) ||
       Number(declared) > CONNECTOR_OBJECT_BRIDGE_LIMITS.maxResponseBytes)) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const next = await readWithSignal(reader, signal);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) ||
          size + next.value.byteLength > CONNECTOR_OBJECT_BRIDGE_LIMITS.maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(new Uint8Array(next.value));
      size += next.value.byteLength;
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

function validUtc(value) {
  return typeof value === "string" && UTC.test(value) && Number.isFinite(Date.parse(value));
}

function stagedMetadata(value) {
  const staged = value?.ok === true && value?.data?.status === "staged"
    ? value.data.staged_file
    : null;
  if (!record(staged) || typeof staged.staged_file_ref !== "string" ||
      staged.staged_file_ref.length === 0 || staged.staged_file_ref.length > 1_024 ||
      CONTROL.test(staged.staged_file_ref) || staged.source_kind !== "connector_object" ||
      staged.state !== "verified" || !safeFilename(staged.display_filename) ||
      typeof staged.media_type !== "string" || !ALLOWED_MEDIA_TYPES.has(staged.media_type) ||
      typeof staged.sha256 !== "string" || !SHA256.test(staged.sha256) ||
      !Number.isSafeInteger(staged.size) || staged.size < 0 ||
      !validUtc(staged.expires_at) || typeof staged.replayed !== "boolean") {
    return null;
  }
  return Object.freeze({
    displayFilename: staged.display_filename,
    mediaType: staged.media_type,
    sha256: staged.sha256,
    size: staged.size,
  });
}

function matches(expected, actual) {
  return actual !== null &&
    actual.displayFilename === expected.displayFilename &&
    actual.mediaType === expected.mediaType &&
    actual.size === expected.size && actual.sha256 === expected.sha256;
}

function statusFromHttp(status) {
  if (status === 404) return "unavailable";
  if (status === 410) return "expired";
  if (status === 409) return "replay_conflict";
  return "unavailable";
}

export class UploadIntentHttpTransport {
  #fetcher;
  #expectedOrigin;
  #requestTimeoutMilliseconds;
  #statusTimeoutMilliseconds;

  constructor({
    expectedOrigin,
    fetcher = globalThis.fetch,
    requestTimeoutMilliseconds = CONNECTOR_OBJECT_BRIDGE_LIMITS.requestTimeoutMilliseconds,
    statusTimeoutMilliseconds = CONNECTOR_OBJECT_BRIDGE_LIMITS.statusTimeoutMilliseconds,
  } = {}) {
    const origin = canonicalOrigin(expectedOrigin);
    if (origin === null || typeof fetcher !== "function" ||
        !Number.isSafeInteger(requestTimeoutMilliseconds) ||
        requestTimeoutMilliseconds < 1 ||
        !Number.isSafeInteger(statusTimeoutMilliseconds) ||
        statusTimeoutMilliseconds < 1) {
      throw new TypeError("Connector upload transport options are invalid");
    }
    this.#expectedOrigin = origin;
    this.#fetcher = fetcher;
    this.#requestTimeoutMilliseconds = requestTimeoutMilliseconds;
    this.#statusTimeoutMilliseconds = statusTimeoutMilliseconds;
  }

  async consume({ uploadUrl, bytes, metadata, signal }) {
    if (!validCapabilityUrl(uploadUrl, this.#expectedOrigin) ||
        !(bytes instanceof Uint8Array)) {
      return Object.freeze({ status: "unavailable" });
    }
    const requestDeadline = deadlineSignal(signal, this.#requestTimeoutMilliseconds);
    let response;
    let uncertain = null;
    try {
      response = await this.#fetcher(uploadUrl, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(bytes),
        signal: requestDeadline.signal,
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
    } catch {
      uncertain = requestDeadline.reason() ?? "interrupted";
      requestDeadline.close();
    }
    if (response !== undefined && (response.status === 200 || response.status === 201)) {
      const returned = stagedMetadata(await boundedJson(response, requestDeadline.signal));
      const responseReason = requestDeadline.reason();
      requestDeadline.close();
      if (returned !== null) {
        return Object.freeze({ status: matches(metadata, returned) ? "staged" : "changed" });
      }
      uncertain = responseReason ?? "unavailable";
    } else if (response !== undefined) {
      await response.body?.cancel().catch(() => undefined);
      requestDeadline.close();
    }
    if (response !== undefined && response.status === 410) {
      return Object.freeze({ status: "expired" });
    }
    const shouldReconcile = uncertain !== null || response?.status === 409 ||
      response?.status === 408 || response?.status === 429 ||
      (response?.status ?? 0) >= 500;
    if (!shouldReconcile) {
      return Object.freeze({ status: statusFromHttp(response?.status ?? 0) });
    }
    const status = await this.inspectStatus({ uploadUrl, metadata });
    if (status.status === "staged") {
      return Object.freeze({
        status: response?.status === 409 ? "already_staged" : "staged_reconciled",
      });
    }
    if (status.status === "changed") return status;
    if (status.status === "replay_conflict") return status;
    if (status.status === "expired") return status;
    if (status.status === "status_timeout" || status.status === "unavailable") {
      if (response?.status === 409) return Object.freeze({ status: "replay_conflict" });
      return Object.freeze({ status: uncertain ?? "unavailable" });
    }
    if (response?.status === 409) return Object.freeze({ status: "replay_conflict" });
    return Object.freeze({ status: uncertain ?? "unavailable" });
  }

  /** GET is status-only and cannot consume the one-use upload capability. */
  async inspectStatus({ uploadUrl, metadata }) {
    if (!validCapabilityUrl(uploadUrl, this.#expectedOrigin)) {
      return Object.freeze({ status: "unavailable" });
    }
    const statusDeadline = deadlineSignal(undefined, this.#statusTimeoutMilliseconds);
    let response;
    try {
      response = await this.#fetcher(uploadUrl, {
        method: "GET",
        signal: statusDeadline.signal,
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
    } catch {
      const reason = statusDeadline.reason();
      statusDeadline.close();
      return Object.freeze({
        status: reason === "timeout" ? "status_timeout" : "unavailable",
      });
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      statusDeadline.close();
      return Object.freeze({ status: statusFromHttp(response.status) });
    }
    const body = await boundedJson(response, statusDeadline.signal);
    const responseReason = statusDeadline.reason();
    statusDeadline.close();
    if (body === null) return Object.freeze({
      status: responseReason === "timeout" ? "status_timeout" : "unavailable",
    });
    if (body?.ok === true && body?.data?.status === "pending" &&
        validUtc(body.data.expires_at)) {
      return Object.freeze({ status: "pending" });
    }
    if (body?.ok === true && body?.data?.status === "rejected" &&
        body.data.code === "file_ingress_intent_conflict") {
      return Object.freeze({ status: "replay_conflict" });
    }
    const returned = stagedMetadata(body);
    if (returned === null) return Object.freeze({ status: "unavailable" });
    return Object.freeze({ status: matches(metadata, returned) ? "staged" : "changed" });
  }
}

function mapSourceFailure(kind) {
  if (kind === "invalid_root") return "invalid_materialization_root";
  if (kind === "oversize") return "oversize";
  if (kind === "changed") return "changed";
  if (kind === "interrupted") return "interrupted";
  if (kind === "missing" || kind === "unavailable") return "source_unavailable";
  return "source_unsupported";
}

export class ConnectorObjectCompanionUploader {
  #source;
  #transport;
  #expectedOrigin;
  #materializationRoot;
  #maxFileBytes;

  constructor({
    expectedOrigin,
    materializationRoot,
    source,
    transport,
    maxFileBytes = CONNECTOR_OBJECT_BRIDGE_LIMITS.maxFileBytes,
  } = {}) {
    const origin = canonicalOrigin(expectedOrigin);
    const canonicalRoot = canonicalMaterializationRoot(materializationRoot);
    if (origin === null || canonicalRoot === null ||
        !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 ||
        maxFileBytes > CONNECTOR_OBJECT_BRIDGE_LIMITS.maxFileBytes) {
      throw new TypeError("Connector object bridge options are invalid");
    }
    this.#expectedOrigin = origin;
    this.#materializationRoot = canonicalRoot;
    this.#source = source ?? new NodeMaterializedConnectorFileSource({
      materializationRoot: canonicalRoot,
    });
    this.#transport = transport ?? new UploadIntentHttpTransport({ expectedOrigin: origin });
    this.#maxFileBytes = maxFileBytes;
  }

  async upload(privateState, { signal } = {}) {
    const state = parsePrivateState(
      privateState,
      this.#expectedOrigin,
      this.#materializationRoot,
    );
    if (state === null) return connectorObjectReceipt({ status: "invalid_private_state" });
    if (state.expected_size > this.#maxFileBytes) {
      return connectorObjectReceipt({
        status: "oversize",
        displayFilename: state.display_filename,
      });
    }
    let source;
    try {
      source = await this.#source.read(state.materialized_file_path, {
        maxBytes: this.#maxFileBytes,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      source = Object.freeze({ kind: "unavailable" });
    }
    if (source.kind !== "ready") {
      return connectorObjectReceipt({
        status: mapSourceFailure(source.kind),
        displayFilename: state.display_filename,
      });
    }
    const bytes = source.bytes instanceof Uint8Array
      ? new Uint8Array(source.bytes)
      : null;
    if (bytes === null || bytes.byteLength > this.#maxFileBytes) {
      return connectorObjectReceipt({
        status: "oversize",
        displayFilename: state.display_filename,
      });
    }
    const mediaType = detectConnectorObjectMediaType(bytes);
    const sha256 = digest(bytes);
    const safe = {
      displayFilename: state.display_filename,
      mediaType,
      size: bytes.byteLength,
      sha256,
    };
    if (mediaType === null) {
      return connectorObjectReceipt({
        status: "unsupported_type",
        displayFilename: safe.displayFilename,
        size: safe.size,
        sha256: safe.sha256,
      });
    }
    if (mediaType !== state.claimed_media_type ||
        !extensionMatches(state.display_filename, mediaType)) {
      return connectorObjectReceipt({
        status: "mime_mismatch",
        ...safe,
      });
    }
    if (bytes.byteLength !== state.expected_size || sha256 !== state.expected_sha256) {
      return connectorObjectReceipt({ status: "changed", ...safe });
    }
    let transport;
    try {
      transport = await this.#transport.consume({
        uploadUrl: state.upload_url,
        bytes,
        metadata: safe,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      transport = Object.freeze({ status: "interrupted" });
    }
    return connectorObjectReceipt({ status: transport.status, ...safe });
  }
}

export function parseConnectorObjectPrivateState(
  value,
  expectedOrigin,
  materializationRoot,
) {
  const canonicalRoot = canonicalMaterializationRoot(materializationRoot);
  return canonicalRoot === null
    ? null
    : parsePrivateState(value, expectedOrigin, canonicalRoot);
}

export function isValidUploadCapabilityUrl(value, expectedOrigin) {
  return validCapabilityUrl(value, expectedOrigin);
}
