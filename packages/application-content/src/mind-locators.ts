import {
  canonicalMarkdownPath,
  type RevisionId,
  type Sha256Digest,
  type SpaceId,
} from "@mind-diary/domain";

const LOCATOR_PREFIX = "mdl1_";
const LOCATOR_VERSION = 1;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BITS = 128;
export const MAX_LOCATOR_CHARACTERS = 8 * 1024;
const MAX_LOCATOR_PLAINTEXT_BYTES = 6 * 1024;
const LOCATOR_AAD = new TextEncoder().encode("mind-diary:opaque-locator:v1");
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const ENCODED_SEPARATOR = /%(?:2f|5c)/iu;

export interface ExactEntryLocatorPayload {
  readonly version: 1;
  readonly kind: "entry" | "continuation";
  readonly spaceId: SpaceId;
  readonly revisionId: RevisionId;
  readonly path: string;
  readonly sha256: Sha256Digest;
  readonly start: number;
  readonly end: number;
  readonly okfType?: string | null;
  readonly title?: string;
  readonly description?: string | null;
  readonly tags?: readonly string[];
}

export interface BrowseCursorLocatorPayload {
  readonly version: 1;
  readonly kind: "browse";
  readonly spaceId: SpaceId;
  readonly revisionId: RevisionId;
  readonly path: string;
  readonly manifestHash: Sha256Digest;
  readonly start: number;
  readonly end: number;
}

export interface BundleFileListCursorLocatorPayload {
  readonly version: 1;
  readonly kind: "bundle_files";
  readonly spaceId: SpaceId;
  readonly revisionId: RevisionId;
  readonly manifestHash: Sha256Digest;
  readonly start: number;
  readonly end: number;
}

export interface FileOperationCursorLocatorPayload {
  readonly version: 1;
  readonly kind: "file_operation";
  readonly operation: "list" | "grep" | "read";
  readonly spaceId: SpaceId;
  readonly usageVersion: number | null;
  readonly revisionId: RevisionId;
  readonly manifestHash: Sha256Digest;
  readonly requestHash: Sha256Digest;
  readonly fileOffset: number;
  readonly lineOffset: number;
  readonly end: number;
}

export interface ValidationIssueCursorLocatorPayload {
  readonly version: 1;
  readonly kind: "validation_issues";
  readonly spaceId: SpaceId;
  readonly revisionId: RevisionId;
  readonly manifestHash: Sha256Digest;
  readonly rulesVersion: string;
  readonly issuesHash: Sha256Digest;
  readonly start: number;
  readonly end: number;
}

export type MindLocatorPayload =
  | ExactEntryLocatorPayload
  | BrowseCursorLocatorPayload
  | BundleFileListCursorLocatorPayload
  | ValidationIssueCursorLocatorPayload
  | FileOperationCursorLocatorPayload;

export interface MindLocatorCodec {
  encode(payload: Readonly<MindLocatorPayload>): Promise<string>;
  decode(candidate: unknown): Promise<Readonly<MindLocatorPayload> | null>;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return null;
  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat(
    (4 - (value.length % 4)) % 4,
  )}`;
  try {
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    return bytesToBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function validOpaqueIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !CONTROL_CHARACTER.test(value);
}

function validRange(start: unknown, end: unknown, allowEmpty: boolean): boolean {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
    (start as number) >= 0 &&
    (allowEmpty ? (end as number) >= (start as number) : (end as number) > (start as number));
}

function validBrowsePath(value: unknown): value is string {
  if (value === "") return true;
  if (typeof value !== "string" || value.length > 2048 || value.startsWith("/") ||
    value.endsWith("/") || value.includes("\\") || CONTROL_CHARACTER.test(value) ||
    ENCODED_SEPARATOR.test(value)) return false;
  return !value.split("/").some((segment) =>
    segment.length === 0 || segment === "." || segment === "..");
}

function parseLocatorPayload(value: unknown): Readonly<MindLocatorPayload> | null {
  if (!isRecord(value) || value.version !== LOCATOR_VERSION) return null;
  if (value.kind === "entry" || value.kind === "continuation") {
    const baseKeys = ["version", "kind", "spaceId", "revisionId", "path", "sha256", "start", "end"];
    const hasSummary = Object.hasOwn(value, "okfType");
    if (!hasExactKeys(value, hasSummary
      ? [...baseKeys, "okfType", "title", "description", "tags"]
      : baseKeys) ||
      !validOpaqueIdentity(value.spaceId) || !validOpaqueIdentity(value.revisionId) ||
      typeof value.path !== "string" || typeof value.sha256 !== "string" ||
      !SHA256_PATTERN.test(value.sha256) || !validRange(value.start, value.end, value.kind === "entry") ||
      (hasSummary && value.okfType !== null && typeof value.okfType !== "string") ||
      (hasSummary && typeof value.title !== "string") ||
      (hasSummary && value.description !== null && typeof value.description !== "string") ||
      (hasSummary && (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string")))) {
      return null;
    }
    try { canonicalMarkdownPath(value.path); } catch { return null; }
    return Object.freeze({
      version: LOCATOR_VERSION,
      kind: value.kind,
      spaceId: value.spaceId as SpaceId,
      revisionId: value.revisionId as RevisionId,
      path: value.path,
      sha256: value.sha256 as Sha256Digest,
      start: value.start as number,
      end: value.end as number,
      ...(hasSummary ? {
        okfType: value.okfType as string | null,
        title: value.title as string,
        description: value.description as string | null,
        tags: Object.freeze([...(value.tags as string[])]),
      } : {}),
    });
  }
  if (value.kind === "browse") {
    if (!hasExactKeys(value, ["version", "kind", "spaceId", "revisionId", "path", "manifestHash", "start", "end"]) ||
      !validOpaqueIdentity(value.spaceId) || !validOpaqueIdentity(value.revisionId) ||
      !validBrowsePath(value.path) || typeof value.manifestHash !== "string" ||
      !SHA256_PATTERN.test(value.manifestHash) || !validRange(value.start, value.end, false)) return null;
    return Object.freeze({ version: LOCATOR_VERSION, kind: "browse",
      spaceId: value.spaceId as SpaceId, revisionId: value.revisionId as RevisionId,
      path: value.path, manifestHash: value.manifestHash as Sha256Digest,
      start: value.start as number, end: value.end as number });
  }
  if (value.kind === "bundle_files") {
    if (!hasExactKeys(value, ["version", "kind", "spaceId", "revisionId", "manifestHash", "start", "end"]) ||
      !validOpaqueIdentity(value.spaceId) || !validOpaqueIdentity(value.revisionId) ||
      typeof value.manifestHash !== "string" || !SHA256_PATTERN.test(value.manifestHash) ||
      !validRange(value.start, value.end, false)) return null;
    return Object.freeze({ version: LOCATOR_VERSION, kind: "bundle_files",
      spaceId: value.spaceId as SpaceId, revisionId: value.revisionId as RevisionId,
      manifestHash: value.manifestHash as Sha256Digest,
      start: value.start as number, end: value.end as number });
  }
  if (value.kind === "validation_issues") {
    if (!hasExactKeys(value, ["version", "kind", "spaceId", "revisionId", "manifestHash",
      "rulesVersion", "issuesHash", "start", "end"]) ||
      !validOpaqueIdentity(value.spaceId) || !validOpaqueIdentity(value.revisionId) ||
      typeof value.manifestHash !== "string" || !SHA256_PATTERN.test(value.manifestHash) ||
      !validOpaqueIdentity(value.rulesVersion) ||
      typeof value.issuesHash !== "string" || !SHA256_PATTERN.test(value.issuesHash) ||
      !validRange(value.start, value.end, false)) return null;
    return Object.freeze({
      version: LOCATOR_VERSION,
      kind: "validation_issues",
      spaceId: value.spaceId as SpaceId,
      revisionId: value.revisionId as RevisionId,
      manifestHash: value.manifestHash as Sha256Digest,
      rulesVersion: value.rulesVersion,
      issuesHash: value.issuesHash as Sha256Digest,
      start: value.start as number,
      end: value.end as number,
    });
  }
  if (value.kind !== "file_operation" ||
    !hasExactKeys(value, ["version", "kind", "operation", "spaceId", "usageVersion", "revisionId",
      "manifestHash", "requestHash", "fileOffset", "lineOffset", "end"]) ||
    !["list", "grep", "read"].includes(value.operation as string) ||
    !validOpaqueIdentity(value.spaceId) || !validOpaqueIdentity(value.revisionId) ||
    !(value.usageVersion === null || (Number.isSafeInteger(value.usageVersion) && (value.usageVersion as number) >= 0)) ||
    typeof value.manifestHash !== "string" || !SHA256_PATTERN.test(value.manifestHash) ||
    typeof value.requestHash !== "string" || !SHA256_PATTERN.test(value.requestHash) ||
    !Number.isSafeInteger(value.fileOffset) || (value.fileOffset as number) < 0 ||
    !Number.isSafeInteger(value.lineOffset) || (value.lineOffset as number) < 0 ||
    !Number.isSafeInteger(value.end) || (value.end as number) < 0 ||
    (value.fileOffset as number) > (value.end as number)) return null;
  return Object.freeze({
    version: LOCATOR_VERSION,
    kind: "file_operation",
    operation: value.operation as FileOperationCursorLocatorPayload["operation"],
    spaceId: value.spaceId as SpaceId,
    usageVersion: value.usageVersion as number | null,
    revisionId: value.revisionId as RevisionId,
    manifestHash: value.manifestHash as Sha256Digest,
    requestHash: value.requestHash as Sha256Digest,
    fileOffset: value.fileOffset as number,
    lineOffset: value.lineOffset as number,
    end: value.end as number,
  });
}

/** AES-256-GCM keeps locator contents confidential and unforgeable. */
export class WebCryptoMindLocatorCodec implements MindLocatorCodec {
  readonly #crypto: Crypto;
  readonly #key: Promise<CryptoKey>;

  constructor(secret: Uint8Array, cryptoImplementation: Crypto = globalThis.crypto) {
    if (!(secret instanceof Uint8Array) || secret.byteLength !== 32) {
      throw new TypeError("Mind locator secret must contain exactly 32 bytes.");
    }
    if (cryptoImplementation?.subtle === undefined) {
      throw new TypeError("Web Crypto is required for Mind locator protection.");
    }
    this.#crypto = cryptoImplementation;
    this.#key = this.#crypto.subtle.importKey("raw", new Uint8Array(secret),
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  async encode(payload: Readonly<MindLocatorPayload>): Promise<string> {
    const normalized = parseLocatorPayload(payload);
    if (normalized === null) throw new TypeError("Mind locator payload is invalid.");
    const plaintext = new TextEncoder().encode(JSON.stringify(normalized));
    if (plaintext.byteLength > MAX_LOCATOR_PLAINTEXT_BYTES) {
      throw new TypeError("Mind locator payload is too large.");
    }
    const iv = this.#crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
    const ciphertext = new Uint8Array(await this.#crypto.subtle.encrypt({
      name: "AES-GCM", iv, additionalData: LOCATOR_AAD, tagLength: AES_GCM_TAG_BITS,
    }, await this.#key, plaintext));
    const encoded = new Uint8Array(iv.byteLength + ciphertext.byteLength);
    encoded.set(iv);
    encoded.set(ciphertext, iv.byteLength);
    return `${LOCATOR_PREFIX}${bytesToBase64Url(encoded)}`;
  }

  async decode(candidate: unknown): Promise<Readonly<MindLocatorPayload> | null> {
    if (typeof candidate !== "string" || candidate.length <= LOCATOR_PREFIX.length ||
      candidate.length > MAX_LOCATOR_CHARACTERS || !candidate.startsWith(LOCATOR_PREFIX)) return null;
    const encoded = base64UrlToBytes(candidate.slice(LOCATOR_PREFIX.length));
    if (encoded === null || encoded.byteLength <= AES_GCM_IV_BYTES + 16) return null;
    try {
      const plaintext = new Uint8Array(await this.#crypto.subtle.decrypt({
        name: "AES-GCM",
        iv: encoded.slice(0, AES_GCM_IV_BYTES),
        additionalData: LOCATOR_AAD,
        tagLength: AES_GCM_TAG_BITS,
      }, await this.#key, encoded.slice(AES_GCM_IV_BYTES)));
      if (plaintext.byteLength > MAX_LOCATOR_PLAINTEXT_BYTES) return null;
      return parseLocatorPayload(JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
      ) as unknown);
    } catch {
      return null;
    }
  }
}
