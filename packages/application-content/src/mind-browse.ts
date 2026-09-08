import type { ActorContext } from "@mind-diary/application-contracts";
import {
  CapabilityAuthorizer,
  ObjectStoreFailure,
  REVISION_MANIFEST_MEDIA_TYPE,
  type AuthorizationDecision,
  type Authorizer,
  type BundleFileObjectStore,
  type ObjectStore,
  type CredentialContentAccessAuthorizer,
} from "@mind-diary/application-ports";
import {
  MARKDOWN_MEDIA_TYPE,
  REVISION_MANIFEST_FORMAT_V3,
  REVISION_MANIFEST_FORMAT_V4,
  canonicalMarkdownPath,
  parseRevisionManifest,
  revisionEnvelopesEqual,
  serializeRevisionManifest,
  type CanonicalRevisionEnvelope,
  type BundleFileMediaType,
  type RevisionId,
  type RevisionManifestEntry,
  type RevisionMode,
  type Sha256Digest,
  type SpaceId,
  type VerifiedSpaceHost,
} from "@mind-diary/domain";
import { okfFileKind, parseOkfFile } from "@mind-diary/okf-codec";
import type { OkfDiagnostic } from "@mind-diary/okf-codec";
import { RE2JS } from "re2js";
import { parse as parseYaml } from "yaml";
import {
  analyzeBundleFileReferences,
  type BundleFileReferenceStatus,
} from "./bundle-file-references.js";
import { inspectSafeRasterPreview } from "./bundle-file-downloads.js";
import { MindBrowseFailure } from "./mind-browse-failure.js";
import {
  FILE_OPERATION_WALL_CLOCK_BUDGET_MS,
  MAX_GREP_SCAN_BYTES,
  MAX_METADATA_SCAN_BYTES,
  MAX_TEXT_BUNDLE_FILE_BYTES,
  byteOffsetAt,
  compareUnknown,
  evaluateMetadataFilter,
  exactJsonEqual,
  fileFields,
  fileOperationBudgetState,
  fileOperationRequestValue,
  isTextMediaType,
  isUtf8Boundary,
  jsonValue,
  metadataAt,
  normalizeGrepFilesRequest,
  normalizeListFilesRequest,
  normalizeReadFilesRequest,
  loadTextFileHead,
  regexEscape,
  scalarAfter,
  scalarBefore,
  scalarCompare,
  selectEntries,
  splitTextLines,
  wordScalar,
  type ExactTextFile,
  type FileMetadataStatus,
  type FileOperationItemError,
  type GrepFileResult,
  type GrepFilesResult,
  type GrepLineMatch,
  type GrepMatchSpan,
  type ListFilesResult,
  type MindFileDescriptor,
  type ReadFileResultItem,
  type ReadFilesResult,
} from "./file-operations.js";

import {
  MindDiscoveryFailure,
  MindDiscoveryService,
  type MindDiscoveryDescriptor,
  type MindDiscoveryRevisionDescriptor,
  type MindDiscoveryStore,
  type MindRevisionSelector,
} from "./mind-discovery.js";

export const DEFAULT_BROWSE_LIMIT = 20;
export const MAX_BROWSE_LIMIT = 100;
export const DEFAULT_FETCH_BYTE_BUDGET = 64 * 1024;
export const MAX_FETCH_BYTE_BUDGET = 1024 * 1024;
export const MIN_FETCH_BYTE_BUDGET = 4;

const LOCATOR_PREFIX = "mdl1_";
const LOCATOR_VERSION = 1;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BITS = 128;
const MAX_LOCATOR_CHARACTERS = 8 * 1024;
const MAX_LOCATOR_PLAINTEXT_BYTES = 6 * 1024;
const LOCATOR_AAD = new TextEncoder().encode("mind-diary:opaque-locator:v1");
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const ENCODED_SEPARATOR = /%(?:2f|5c)/iu;
const MAX_BROWSE_OBJECT_CONCURRENCY = 8;
const INLINE_BUNDLE_FILE_MEDIA_TYPES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

async function mapBounded<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  operation: (value: Input, index: number) => Promise<Output>,
): Promise<readonly Output[]> {
  const results = new Array<Output>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= values.length) return;
        results[index] = await operation(values[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return Object.freeze(results);
}

type AllowedAuthorization = Extract<AuthorizationDecision, { readonly kind: "allowed" }>;

export interface ExactEntryLocatorPayload {
  readonly version: 1;
  readonly kind: "entry" | "continuation";
  readonly spaceId: SpaceId;
  readonly revisionId: RevisionId;
  readonly path: string;
  readonly sha256: Sha256Digest;
  /** Inclusive UTF-8 byte offset. */
  readonly start: number;
  /** Exclusive UTF-8 byte boundary fixed by the server-issued locator. */
  readonly end: number;
}

export interface BrowseCursorLocatorPayload {
  readonly version: 1;
  readonly kind: "browse";
  readonly spaceId: SpaceId;
  readonly revisionId: RevisionId;
  readonly path: string;
  readonly manifestHash: Sha256Digest;
  /** Inclusive entry offset inside the exact immutable directory listing. */
  readonly start: number;
  /** Exclusive entry count captured when the cursor was issued. */
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
  readonly revisionId: RevisionId;
  readonly manifestHash: Sha256Digest;
  readonly requestHash: Sha256Digest;
  readonly fileOffset: number;
  readonly lineOffset: number;
  readonly end: number;
}

export type MindLocatorPayload =
  | ExactEntryLocatorPayload
  | BrowseCursorLocatorPayload
  | BundleFileListCursorLocatorPayload
  | FileOperationCursorLocatorPayload;

/** Server-side opaque locator boundary. Decoding is never exposed to MCP clients. */
export interface MindLocatorCodec {
  encode(payload: Readonly<MindLocatorPayload>): Promise<string>;
  decode(candidate: unknown): Promise<Readonly<MindLocatorPayload> | null>;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return null;
  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat(
    (4 - (value.length % 4)) % 4,
  )}`;
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
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
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function validOpaqueIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !CONTROL_CHARACTER.test(value)
  );
}

function validRange(start: unknown, end: unknown, allowEmpty: boolean): boolean {
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    (start as number) >= 0 &&
    (allowEmpty ? (end as number) >= (start as number) : (end as number) > (start as number))
  );
}

function normalizeBrowsePathValue(value: unknown): string | null {
  if (value === "") return "";
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    CONTROL_CHARACTER.test(value) ||
    ENCODED_SEPARATOR.test(value)
  ) {
    return null;
  }
  const segments = value.split("/");
  return segments.some(
    (segment) => segment.length === 0 || segment === "." || segment === "..",
  )
    ? null
    : value;
}

function parseLocatorPayload(value: unknown): Readonly<MindLocatorPayload> | null {
  if (!isRecord(value) || value.version !== LOCATOR_VERSION) return null;
  if (value.kind === "entry" || value.kind === "continuation") {
    if (
      !hasExactKeys(value, [
        "version",
        "kind",
        "spaceId",
        "revisionId",
        "path",
        "sha256",
        "start",
        "end",
      ]) ||
      !validOpaqueIdentity(value.spaceId) ||
      !validOpaqueIdentity(value.revisionId) ||
      typeof value.path !== "string" ||
      typeof value.sha256 !== "string" ||
      !SHA256_PATTERN.test(value.sha256) ||
      !validRange(value.start, value.end, value.kind === "entry")
    ) {
      return null;
    }
    try {
      canonicalMarkdownPath(value.path);
    } catch {
      return null;
    }
    return Object.freeze({
      version: LOCATOR_VERSION,
      kind: value.kind,
      spaceId: value.spaceId as SpaceId,
      revisionId: value.revisionId as RevisionId,
      path: value.path,
      sha256: value.sha256 as Sha256Digest,
      start: value.start as number,
      end: value.end as number,
    });
  }
  if (value.kind === "browse") {
    if (
      !hasExactKeys(value, [
        "version",
        "kind",
        "spaceId",
        "revisionId",
        "path",
        "manifestHash",
        "start",
        "end",
      ]) ||
      !validOpaqueIdentity(value.spaceId) ||
      !validOpaqueIdentity(value.revisionId) ||
      normalizeBrowsePathValue(value.path) === null ||
      typeof value.manifestHash !== "string" ||
      !SHA256_PATTERN.test(value.manifestHash) ||
      !validRange(value.start, value.end, false)
    ) {
      return null;
    }
    return Object.freeze({
      version: LOCATOR_VERSION,
      kind: "browse",
      spaceId: value.spaceId as SpaceId,
      revisionId: value.revisionId as RevisionId,
      path: value.path as string,
      manifestHash: value.manifestHash as Sha256Digest,
      start: value.start as number,
      end: value.end as number,
    });
  }
  if (value.kind === "bundle_files") {
    if (
      !hasExactKeys(value, [
        "version",
        "kind",
        "spaceId",
        "revisionId",
        "manifestHash",
        "start",
        "end",
      ]) ||
      !validOpaqueIdentity(value.spaceId) ||
      !validOpaqueIdentity(value.revisionId) ||
      typeof value.manifestHash !== "string" ||
      !SHA256_PATTERN.test(value.manifestHash) ||
      !validRange(value.start, value.end, false)
    ) {
      return null;
    }
    return Object.freeze({
      version: LOCATOR_VERSION,
      kind: "bundle_files",
      spaceId: value.spaceId as SpaceId,
      revisionId: value.revisionId as RevisionId,
      manifestHash: value.manifestHash as Sha256Digest,
      start: value.start as number,
      end: value.end as number,
    });
  }
  if (value.kind === "file_operation") {
    if (
      !hasExactKeys(value, [
        "version",
        "kind",
        "operation",
        "spaceId",
        "revisionId",
        "manifestHash",
        "requestHash",
        "fileOffset",
        "lineOffset",
        "end",
      ]) ||
      (value.operation !== "list" &&
        value.operation !== "grep" &&
        value.operation !== "read") ||
      !validOpaqueIdentity(value.spaceId) ||
      !validOpaqueIdentity(value.revisionId) ||
      typeof value.manifestHash !== "string" ||
      !SHA256_PATTERN.test(value.manifestHash) ||
      typeof value.requestHash !== "string" ||
      !SHA256_PATTERN.test(value.requestHash) ||
      !Number.isSafeInteger(value.fileOffset) ||
      (value.fileOffset as number) < 0 ||
      !Number.isSafeInteger(value.lineOffset) ||
      (value.lineOffset as number) < 0 ||
      !Number.isSafeInteger(value.end) ||
      (value.end as number) < 0 ||
      (value.fileOffset as number) > (value.end as number)
    ) {
      return null;
    }
    return Object.freeze({
      version: LOCATOR_VERSION,
      kind: "file_operation",
      operation: value.operation,
      spaceId: value.spaceId as SpaceId,
      revisionId: value.revisionId as RevisionId,
      manifestHash: value.manifestHash as Sha256Digest,
      requestHash: value.requestHash as Sha256Digest,
      fileOffset: value.fileOffset as number,
      lineOffset: value.lineOffset as number,
      end: value.end as number,
    });
  }
  return null;
}

/**
 * AES-256-GCM makes locator contents confidential as well as unforgeable.
 * The key is deployment secret material and is copied before import.
 */
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
    this.#key = this.#crypto.subtle.importKey(
      "raw",
      new Uint8Array(secret),
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  async encode(payload: Readonly<MindLocatorPayload>): Promise<string> {
    const normalized = parseLocatorPayload(payload);
    if (normalized === null) throw new TypeError("Mind locator payload is invalid.");
    const plaintext = new TextEncoder().encode(JSON.stringify(normalized));
    if (plaintext.byteLength > MAX_LOCATOR_PLAINTEXT_BYTES) {
      throw new TypeError("Mind locator payload is too large.");
    }
    const iv = this.#crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
    const ciphertext = new Uint8Array(
      await this.#crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: LOCATOR_AAD,
          tagLength: AES_GCM_TAG_BITS,
        },
        await this.#key,
        plaintext,
      ),
    );
    const encoded = new Uint8Array(iv.byteLength + ciphertext.byteLength);
    encoded.set(iv, 0);
    encoded.set(ciphertext, iv.byteLength);
    return `${LOCATOR_PREFIX}${bytesToBase64Url(encoded)}`;
  }

  async decode(candidate: unknown): Promise<Readonly<MindLocatorPayload> | null> {
    if (
      typeof candidate !== "string" ||
      candidate.length <= LOCATOR_PREFIX.length ||
      candidate.length > MAX_LOCATOR_CHARACTERS ||
      !candidate.startsWith(LOCATOR_PREFIX)
    ) {
      return null;
    }
    const encoded = base64UrlToBytes(candidate.slice(LOCATOR_PREFIX.length));
    if (encoded === null || encoded.byteLength <= AES_GCM_IV_BYTES + 16) return null;
    const iv = encoded.slice(0, AES_GCM_IV_BYTES);
    const ciphertext = encoded.slice(AES_GCM_IV_BYTES);
    try {
      const plaintext = new Uint8Array(
        await this.#crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv,
            additionalData: LOCATOR_AAD,
            tagLength: AES_GCM_TAG_BITS,
          },
          await this.#key,
          ciphertext,
        ),
      );
      if (plaintext.byteLength > MAX_LOCATOR_PLAINTEXT_BYTES) return null;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      return parseLocatorPayload(JSON.parse(text) as unknown);
    } catch {
      return null;
    }
  }
}

export interface MindEntrySummary {
  readonly entryId: string;
  readonly resourceUri: string;
  readonly path: string;
  readonly kind: "concept" | "index" | "log";
  readonly title: string;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly mimeType: typeof MARKDOWN_MEDIA_TYPE;
  readonly revisionId: RevisionId;
  readonly sha256: Sha256Digest;
  readonly size: number;
  readonly okfType: string | null;
}

export interface BrowseEntriesQuery {
  readonly mind: unknown;
  readonly revisionSelector?: unknown;
  readonly path?: unknown;
  readonly cursor?: unknown;
  readonly limit?: unknown;
}

export interface BrowseEntriesResult {
  readonly mind: Readonly<MindDiscoveryDescriptor>;
  readonly resolvedRevision: Readonly<MindDiscoveryRevisionDescriptor>;
  readonly path: string;
  readonly entries: readonly Readonly<MindEntrySummary>[];
  readonly nextCursor: string | null;
}

export interface BundleFileDescriptor {
  readonly path: string;
  readonly kind: "opaque";
  readonly mediaType: BundleFileMediaType;
  readonly size: number;
  readonly sha256: Sha256Digest;
  readonly revisionId: RevisionId;
  readonly inlineEligible: boolean;
  readonly referenceStatus: BundleFileReferenceStatus;
}

export interface ListBundleFilesResult {
  readonly mind: Readonly<MindDiscoveryDescriptor>;
  readonly resolvedRevision: Readonly<MindDiscoveryRevisionDescriptor>;
  readonly files: readonly Readonly<BundleFileDescriptor>[];
  readonly diagnostics: readonly Readonly<OkfDiagnostic>[];
  readonly nextCursor: string | null;
}

export interface FetchEntryRequest {
  readonly id: unknown;
  /** UTF-8 byte budget. The server never splits a Unicode scalar value. */
  readonly maxBytes?: unknown;
}

export interface FetchedEntryResult {
  readonly entry: Readonly<MindEntrySummary>;
  readonly text: string;
  readonly truncated: boolean;
  readonly continuationId: string | null;
  readonly byteBudget: number;
  readonly range: Readonly<{
    readonly start: number;
    readonly end: number;
    readonly total: number;
  }>;
}

export interface ImmutableResourceReadResult {
  readonly uri: string;
  readonly mimeType: typeof MARKDOWN_MEDIA_TYPE;
  readonly text: string;
  readonly entry: Readonly<MindEntrySummary>;
}

export interface MindBrowseDependencies {
  readonly store: MindDiscoveryStore;
  readonly objects: ObjectStore;
  readonly host: VerifiedSpaceHost;
  readonly locators: MindLocatorCodec;
  readonly authorizer?: Authorizer;
  readonly credentialAccess?: CredentialContentAccessAuthorizer;
}

interface NormalizedBrowseQuery {
  readonly mind: unknown;
  readonly revisionSelector: unknown;
  readonly hasRevisionSelector: boolean;
  readonly path: string;
  readonly cursor: string | null;
  readonly limit: number;
}

interface LoadedExactFile {
  readonly entry: Readonly<RevisionManifestEntry>;
  readonly bytes: Uint8Array;
  readonly authorization: AllowedAuthorization;
}

interface ResourceTarget {
  readonly spaceId: SpaceId;
  readonly revisionId: RevisionId;
  readonly path: string;
}

function normalizeBrowseQuery(value: unknown): Readonly<NormalizedBrowseQuery> {
  if (!isRecord(value)) {
    throw new MindBrowseFailure("invalid_request", "Browse request is invalid.");
  }
  const allowed = new Set(["mind", "revisionSelector", "path", "cursor", "limit"]);
  if (!Object.keys(value).every((key) => allowed.has(key)) || !("mind" in value)) {
    throw new MindBrowseFailure("invalid_request", "Browse request is invalid.");
  }
  const path = normalizeBrowsePathValue(value.path ?? "");
  if (path === null) throw new MindBrowseFailure("invalid_path", "Browse path is invalid.");
  const limit = value.limit ?? DEFAULT_BROWSE_LIMIT;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_BROWSE_LIMIT) {
    throw new MindBrowseFailure("invalid_limit", "Browse limit is invalid.");
  }
  let cursor: string | null = null;
  if (value.cursor !== undefined) {
    if (
      typeof value.cursor !== "string" ||
      value.cursor.length === 0 ||
      value.cursor.length > MAX_LOCATOR_CHARACTERS
    ) {
      throw new MindBrowseFailure("invalid_cursor", "Browse cursor is invalid.");
    }
    cursor = value.cursor;
  }
  return Object.freeze({
    mind: value.mind,
    revisionSelector: value.revisionSelector,
    hasRevisionSelector: Object.hasOwn(value, "revisionSelector"),
    path,
    cursor,
    limit: limit as number,
  });
}

function normalizeBundleFileListQuery(value: unknown): Readonly<{
  mind: unknown;
  revisionSelector: unknown;
  hasRevisionSelector: boolean;
  cursor: string | null;
  limit: number;
}> {
  if (!isRecord(value) || !("mind" in value)) {
    throw new MindBrowseFailure("invalid_request", "BundleFile list request is invalid.");
  }
  const allowed = new Set(["mind", "revisionSelector", "cursor", "limit"]);
  if (!Object.keys(value).every((key) => allowed.has(key))) {
    throw new MindBrowseFailure("invalid_request", "BundleFile list request is invalid.");
  }
  const limit = value.limit ?? DEFAULT_BROWSE_LIMIT;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_BROWSE_LIMIT) {
    throw new MindBrowseFailure("invalid_limit", "BundleFile list limit is invalid.");
  }
  const cursor = value.cursor ?? null;
  if (
    cursor !== null &&
    (typeof cursor !== "string" || cursor.length === 0 || cursor.length > MAX_LOCATOR_CHARACTERS)
  ) {
    throw new MindBrowseFailure("invalid_cursor", "BundleFile list cursor is invalid.");
  }
  return Object.freeze({
    mind: value.mind,
    revisionSelector: value.revisionSelector,
    hasRevisionSelector: Object.hasOwn(value, "revisionSelector"),
    cursor: cursor as string | null,
    limit: limit as number,
  });
}

function normalizeFetchRequest(value: unknown): Readonly<{ id: unknown; maxBytes: number }> {
  if (!isRecord(value)) {
    throw new MindBrowseFailure("invalid_request", "Fetch request is invalid.");
  }
  const allowed = new Set(["id", "maxBytes"]);
  if (!Object.keys(value).every((key) => allowed.has(key)) || !("id" in value)) {
    throw new MindBrowseFailure("invalid_request", "Fetch request is invalid.");
  }
  const maxBytes = value.maxBytes ?? DEFAULT_FETCH_BYTE_BUDGET;
  if (
    !Number.isSafeInteger(maxBytes) ||
    (maxBytes as number) < MIN_FETCH_BYTE_BUDGET ||
    (maxBytes as number) > MAX_FETCH_BYTE_BUDGET
  ) {
    throw new MindBrowseFailure(
      "invalid_fetch_budget",
      "Fetch byte budget is invalid.",
    );
  }
  return Object.freeze({ id: value.id, maxBytes: maxBytes as number });
}

function directoryOf(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
}

function sameAuthorization(
  left: AllowedAuthorization,
  right: AllowedAuthorization,
): boolean {
  const sameGrant =
    left.grant.kind === "membership" && right.grant.kind === "membership"
      ? left.grant.role === right.grant.role
      : left.grant.kind === "baseline_visibility" &&
          right.grant.kind === "baseline_visibility"
        ? left.grant.visibility === right.grant.visibility
        : false;
  return (
    sameGrant &&
    left.stamp.accessVersion === right.stamp.accessVersion &&
    left.stamp.membershipVersion === right.stamp.membershipVersion &&
    left.stamp.tokenVersion === right.stamp.tokenVersion
  );
}

function entryTitle(path: string, frontmatter: Readonly<Record<string, unknown>> | null): string {
  if (frontmatter !== null && typeof frontmatter.title === "string") {
    const title = frontmatter.title.trim();
    if (title.length > 0) return title;
  }
  const name = path.split("/").at(-1) ?? path;
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

function entryDescription(
  frontmatter: Readonly<Record<string, unknown>> | null,
): string | null {
  if (frontmatter === null || typeof frontmatter.description !== "string") return null;
  const description = frontmatter.description.trim();
  return description.length === 0 ? null : description;
}

function entryTags(frontmatter: Readonly<Record<string, unknown>> | null): readonly string[] {
  if (
    frontmatter === null ||
    !Array.isArray(frontmatter.tags) ||
    !frontmatter.tags.every((tag) => typeof tag === "string")
  ) {
    return Object.freeze([]);
  }
  return Object.freeze(frontmatter.tags.map((tag) => tag as string));
}

function encodeRfc3986Segment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function validResourceIdentity(value: string): boolean {
  return (
    validOpaqueIdentity(value) &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

export function exactRevisionResourceUri(
  spaceId: SpaceId,
  revisionId: RevisionId,
  path: string,
): string {
  if (!validResourceIdentity(spaceId) || !validResourceIdentity(revisionId)) {
    throw new TypeError("Resource identity is invalid.");
  }
  const canonicalPath = canonicalMarkdownPath(path);
  const prefix = `okf://spaces/${encodeRfc3986Segment(spaceId)}/revisions/${encodeRfc3986Segment(
    revisionId,
  )}`;
  if (canonicalPath === "index.md") return `${prefix}/index`;
  return `${prefix}/entries/${canonicalPath
    .split("/")
    .map((segment) => encodeRfc3986Segment(segment))
    .join("/")}`;
}

function decodeCanonicalSegment(value: string): string | null {
  if (value.length === 0 || ENCODED_SEPARATOR.test(value)) return null;
  try {
    const decoded = decodeURIComponent(value);
    if (
      decoded.length === 0 ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      CONTROL_CHARACTER.test(decoded) ||
      encodeRfc3986Segment(decoded) !== value
    ) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function parseResourceUri(value: unknown): Readonly<ResourceTarget> | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    !value.startsWith("okf://spaces/") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return null;
  }
  const segments = value.slice("okf://spaces/".length).split("/");
  if (segments.length < 4 || segments[1] !== "revisions") return null;
  const spaceId = decodeCanonicalSegment(segments[0]!);
  const revisionId = decodeCanonicalSegment(segments[2]!);
  if (
    spaceId === null ||
    revisionId === null ||
    !validResourceIdentity(spaceId) ||
    !validResourceIdentity(revisionId)
  ) {
    return null;
  }
  let path: string;
  if (segments.length === 4 && segments[3] === "index") {
    path = "index.md";
  } else if (segments[3] === "entries" && segments.length > 4) {
    const decodedPath = segments.slice(4).map(decodeCanonicalSegment);
    if (decodedPath.some((segment) => segment === null)) return null;
    path = (decodedPath as string[]).join("/");
    if (path === "index.md") return null;
  } else {
    return null;
  }
  try {
    canonicalMarkdownPath(path);
  } catch {
    return null;
  }
  return Object.freeze({
    spaceId: spaceId as SpaceId,
    revisionId: revisionId as RevisionId,
    path,
  });
}

function safeUtf8PageEnd(
  bytes: Uint8Array,
  start: number,
  end: number,
  budget: number,
): number {
  let pageEnd = Math.min(end, start + budget);
  if (pageEnd === end) return pageEnd;
  while (pageEnd > start && (bytes[pageEnd]! & 0xc0) === 0x80) pageEnd -= 1;
  if (pageEnd <= start) {
    throw new MindBrowseFailure(
      "revision_integrity_failure",
      "The exact revision could not be decoded safely.",
    );
  }
  return pageEnd;
}

function mapDiscoveryFailure(error: unknown): never {
  if (error instanceof MindDiscoveryFailure) {
    throw new MindBrowseFailure(error.code, error.message);
  }
  throw error;
}

/** Browse/fetch/resource application service over exact canonical revisions. */
export class MindBrowseService {
  readonly #store: MindDiscoveryStore;
  readonly #objects: ObjectStore;
  readonly #locators: MindLocatorCodec;
  readonly #discovery: MindDiscoveryService;
  readonly #authorizer: Authorizer;

  constructor(dependencies: MindBrowseDependencies) {
    this.#store = dependencies.store;
    this.#objects = dependencies.objects;
    this.#locators = dependencies.locators;
    this.#discovery = new MindDiscoveryService({
      store: dependencies.store,
      host: dependencies.host,
      ...(dependencies.credentialAccess === undefined
        ? {}
        : { credentialAccess: dependencies.credentialAccess }),
    });
    this.#authorizer =
      dependencies.authorizer ?? new CapabilityAuthorizer(dependencies.store);
  }

  async browseEntries(
    actor: ActorContext,
    query: unknown,
  ): Promise<Readonly<BrowseEntriesResult>> {
    const request = normalizeBrowseQuery(query);
    let cursor: Readonly<BrowseCursorLocatorPayload> | null = null;
    if (request.cursor !== null) {
      const decoded = await this.#locators.decode(request.cursor);
      if (decoded === null || decoded.kind !== "browse" || decoded.path !== request.path) {
        throw new MindBrowseFailure("invalid_cursor", "Browse cursor is invalid.");
      }
      cursor = decoded;
    }

    const selector: unknown =
      cursor !== null && !request.hasRevisionSelector
        ? ({ kind: "revision", revisionId: cursor.revisionId } satisfies MindRevisionSelector)
        : request.revisionSelector;
    let info;
    try {
      info = await this.#discovery.getMindInfo(actor, request.mind, selector);
    } catch (error) {
      if (
        cursor !== null &&
        error instanceof MindDiscoveryFailure &&
        error.code === "revision_not_found"
      ) {
        throw new MindBrowseFailure("invalid_cursor", "Browse cursor is invalid.");
      }
      mapDiscoveryFailure(error);
    }
    if (
      cursor !== null &&
      (cursor.spaceId !== info.mind.mindId ||
        cursor.revisionId !== info.resolvedRevision.revisionId)
    ) {
      throw new MindBrowseFailure("invalid_cursor", "Browse cursor is invalid.");
    }

    const initialAuthorization = await this.#requireAuthorization(
      actor,
      info.mind.mindId,
      "content:browse",
      info.revisionMode,
      "mind_not_found",
    );
    const envelope = await this.#readVerifiedEnvelope(
      info.mind.mindId,
      info.resolvedRevision.revisionId,
      "revision_not_found",
    );
    if (envelope.revision.manifestHash !== info.resolvedRevision.manifestHash) {
      throw new MindBrowseFailure(
        "revision_integrity_failure",
        "The exact revision manifest failed integrity verification.",
      );
    }
    const entries = envelope.manifest.entries.filter(
      (entry) => entry.kind === "markdown" && directoryOf(entry.path) === request.path,
    );
    const offset = cursor?.start ?? 0;
    if (
      cursor !== null &&
      (cursor.manifestHash !== envelope.revision.manifestHash ||
        cursor.end !== entries.length ||
        offset >= entries.length)
    ) {
      throw new MindBrowseFailure("invalid_cursor", "Browse cursor is invalid.");
    }
    const page = entries.slice(offset, offset + request.limit);
    const summaries = await mapBounded(
      page,
      MAX_BROWSE_OBJECT_CONCURRENCY,
      async (entry) => {
        const bytes = await this.#readVerifiedObject(
          envelope.revision.spaceId,
          envelope.manifest.format,
          entry,
        );
        return this.#entrySummary(
          envelope.revision.spaceId,
          envelope.revision.revisionId,
          entry,
          bytes,
        );
      },
    );
    const nextOffset = offset + page.length;
    const nextCursor =
      nextOffset < entries.length
        ? await this.#locators.encode(
            Object.freeze({
              version: LOCATOR_VERSION,
              kind: "browse",
              spaceId: info.mind.mindId,
              revisionId: info.resolvedRevision.revisionId,
              path: request.path,
              manifestHash: envelope.revision.manifestHash,
              start: nextOffset,
              end: entries.length,
            }),
          )
        : null;
    await this.#requireSameAuthorization(
      actor,
      info.mind.mindId,
      "content:browse",
      info.revisionMode,
      initialAuthorization,
      "mind_not_found",
    );
    return Object.freeze({
      mind: info.mind,
      resolvedRevision: info.resolvedRevision,
      path: request.path,
      entries: summaries,
      nextCursor,
    });
  }

  async listBundleFiles(
    actor: ActorContext,
    query: unknown,
  ): Promise<Readonly<ListBundleFilesResult>> {
    const request = normalizeBundleFileListQuery(query);
    let cursor: Readonly<BundleFileListCursorLocatorPayload> | null = null;
    if (request.cursor !== null) {
      const decoded = await this.#locators.decode(request.cursor);
      if (decoded === null || decoded.kind !== "bundle_files") {
        throw new MindBrowseFailure("invalid_cursor", "BundleFile list cursor is invalid.");
      }
      cursor = decoded;
    }
    const selector: unknown = cursor !== null && !request.hasRevisionSelector
      ? ({ kind: "revision", revisionId: cursor.revisionId } satisfies MindRevisionSelector)
      : request.revisionSelector;
    let info;
    try {
      info = await this.#discovery.getMindInfo(actor, request.mind, selector);
    } catch (error) {
      if (cursor !== null && error instanceof MindDiscoveryFailure) {
        throw new MindBrowseFailure("invalid_cursor", "BundleFile list cursor is invalid.");
      }
      mapDiscoveryFailure(error);
    }
    if (
      cursor !== null &&
      (cursor.spaceId !== info.mind.mindId || cursor.revisionId !== info.resolvedRevision.revisionId)
    ) {
      throw new MindBrowseFailure("invalid_cursor", "BundleFile list cursor is invalid.");
    }
    const initialAuthorization = await this.#requireAuthorization(
      actor,
      info.mind.mindId,
      "content:browse",
      info.revisionMode,
      "mind_not_found",
    );
    const envelope = await this.#readVerifiedEnvelope(
      info.mind.mindId,
      info.resolvedRevision.revisionId,
      "revision_not_found",
    );
    if (envelope.revision.manifestHash !== info.resolvedRevision.manifestHash) {
      throw new MindBrowseFailure(
        "revision_integrity_failure",
        "The exact revision manifest failed integrity verification.",
      );
    }
    const entries = envelope.manifest.entries.filter((entry) => entry.kind === "opaque");
    const offset = cursor?.start ?? 0;
    if (
      cursor !== null &&
      (cursor.manifestHash !== envelope.revision.manifestHash ||
        cursor.end !== entries.length ||
        offset >= entries.length)
    ) {
      throw new MindBrowseFailure("invalid_cursor", "BundleFile list cursor is invalid.");
    }
    const markdown = await mapBounded(
      envelope.manifest.entries.filter((entry) => entry.kind === "markdown"),
      MAX_BROWSE_OBJECT_CONCURRENCY,
      async (entry) => {
        const bytes = await this.#readVerifiedObject(
          envelope.revision.spaceId,
          envelope.manifest.format,
          entry,
        );
        try {
          return Object.freeze({
            path: entry.path,
            text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          });
        } catch {
          throw new MindBrowseFailure(
            "revision_integrity_failure",
            "The exact revision Markdown failed UTF-8 verification.",
          );
        }
      },
    );
    const preliminaryReferences = analyzeBundleFileReferences({
      markdown,
      bundleFiles: entries.map((entry) => Object.freeze({
        path: entry.path,
        mediaType: entry.mediaType as BundleFileMediaType,
      })),
    });
    const page = entries.slice(offset, offset + request.limit);
    const pagePaths = new Set(page.map((entry) => entry.path));
    const previewCandidates = entries.filter((entry) =>
      INLINE_BUNDLE_FILE_MEDIA_TYPES.has(entry.mediaType) &&
      (pagePaths.has(entry.path) ||
        preliminaryReferences.statusByPath.get(entry.path) !== "unreferenced"));
    const previewEligibility = new Map(await mapBounded(
      previewCandidates,
      MAX_BROWSE_OBJECT_CONCURRENCY,
      async (entry) => [entry.path, await this.#inspectBundleFilePreview(
        envelope.revision.spaceId,
        entry,
      )] as const,
    ));
    const references = analyzeBundleFileReferences({
      markdown,
      bundleFiles: entries.map((entry) => Object.freeze({
        path: entry.path,
        mediaType: entry.mediaType as BundleFileMediaType,
        ...(previewEligibility.has(entry.path)
          ? { inlineEligible: previewEligibility.get(entry.path)! }
          : {}),
      })),
    });
    const files = page.map((entry) => Object.freeze({
      path: entry.path,
      kind: "opaque" as const,
      mediaType: entry.mediaType as BundleFileMediaType,
      size: entry.size,
      sha256: entry.sha256,
      revisionId: envelope.revision.revisionId,
      inlineEligible: previewEligibility.get(entry.path) ?? false,
      referenceStatus: references.statusByPath.get(entry.path) ?? "unreferenced",
    }));
    const nextOffset = offset + page.length;
    const nextCursor = nextOffset < entries.length
      ? await this.#locators.encode(Object.freeze({
          version: LOCATOR_VERSION,
          kind: "bundle_files",
          spaceId: info.mind.mindId,
          revisionId: info.resolvedRevision.revisionId,
          manifestHash: envelope.revision.manifestHash,
          start: nextOffset,
          end: entries.length,
        }))
      : null;
    await this.#requireSameAuthorization(
      actor,
      info.mind.mindId,
      "content:browse",
      info.revisionMode,
      initialAuthorization,
      "mind_not_found",
    );
    return Object.freeze({
      mind: info.mind,
      resolvedRevision: info.resolvedRevision,
      files: Object.freeze(files),
      diagnostics: references.diagnostics,
      nextCursor,
    });
  }

  async listFiles(
    actor: ActorContext,
    query: unknown,
    signal?: AbortSignal,
  ): Promise<Readonly<ListFilesResult>> {
    const deadlineAt = Date.now() + FILE_OPERATION_WALL_CLOCK_BUDGET_MS;
    const request = normalizeListFilesRequest(query);
    const cursor = await this.#fileOperationCursor(request.cursor, "list");
    const selector = cursor !== null && !request.hasRevisionSelector
      ? ({ kind: "revision", revisionId: cursor.revisionId } satisfies MindRevisionSelector)
      : request.revisionSelector;
    let info;
    try {
      info = await this.#discovery.getMindInfo(actor, request.mind, selector);
    } catch (error) {
      if (cursor !== null && error instanceof MindDiscoveryFailure) {
        throw new MindBrowseFailure("file_operation_cursor_invalid", "File operation cursor is invalid.");
      }
      mapDiscoveryFailure(error);
    }
    const initialAuthorization = await this.#requireAuthorization(
      actor,
      info.mind.mindId,
      "content:browse",
      info.revisionMode,
      "mind_not_found",
    );
    const envelope = await this.#readVerifiedEnvelope(
      info.mind.mindId,
      info.resolvedRevision.revisionId,
      "revision_not_found",
    );
    const requestHash = await this.#objects.calculateSha256(new TextEncoder().encode(
      JSON.stringify(fileOperationRequestValue("list", request)),
    ));
    const selected = selectEntries(envelope.manifest.entries, request.selector);
    this.#validateFileOperationCursor(cursor, info.mind.mindId, envelope, requestHash, selected.length);

    const manifestFields = new Set([
      "path", "kind", "mediaType", "size", "sha256", "revisionId",
      "revisionCommittedAt", "metadataStatus",
    ]);
    const referencedFields = [
      ...request.selectMetadataFields,
      ...request.sort.map((item) => item.field),
      ...(request.aggregate.kind === "distinct" ? [request.aggregate.field] : []),
    ];
    const metadataNeeded = request.where !== undefined ||
      referencedFields.some((field) => !manifestFields.has(field));
    const metadataSort = request.sort.some((item) => !manifestFields.has(item.field));
    if (metadataSort && selected.reduce((sum, entry) => sum + (
      entry.size <= MAX_TEXT_BUNDLE_FILE_BYTES &&
      (entry.kind === "markdown" || isTextMediaType(entry.mediaType))
        ? entry.size
        : 0
    ), 0) > MAX_METADATA_SCAN_BYTES) {
      throw new MindBrowseFailure(
        "file_operation_budget_exhausted",
        "Metadata sort exceeds the bounded scan budget.",
      );
    }

    const prepared: Array<Readonly<{
      entry: Readonly<RevisionManifestEntry>;
      descriptor: Readonly<MindFileDescriptor>;
      fields: Readonly<Record<string, unknown>>;
      nextOffset: number;
    }>> = [];
    let scannedFiles = 0;
    let scannedBytes = 0;
    let rawOffset = metadataSort ? 0 : (cursor?.fileOffset ?? 0);
    let scanBudgetHit = false;
    let timeBudgetHit = false;
    for (let index = rawOffset; index < selected.length; index += 1) {
      const budgetState = fileOperationBudgetState(signal, deadlineAt);
      if (budgetState === "aborted") {
        throw new MindBrowseFailure("file_operation_budget_exhausted", "File operation was aborted.", true);
      }
      if (budgetState === "deadline") {
        timeBudgetHit = true;
        rawOffset = index;
        break;
      }
      const entry = selected[index]!;
      let metadataStatus: FileMetadataStatus = "not_requested";
      let metadata: Readonly<Record<string, unknown>> | null = null;
      if (metadataNeeded) {
        if (entry.size > MAX_TEXT_BUNDLE_FILE_BYTES ||
          (entry.kind === "opaque" && !isTextMediaType(entry.mediaType))) {
          metadataStatus = "unsupported";
        } else if (scannedBytes + entry.size > MAX_METADATA_SCAN_BYTES) {
          scanBudgetHit = true;
          rawOffset = index;
          break;
        } else {
          const parsed = await this.#fileMetadata(envelope.revision.spaceId, envelope.manifest.format, entry);
          metadataStatus = parsed.status;
          metadata = parsed.metadata;
          scannedFiles += 1;
          scannedBytes += entry.size;
        }
      }
      const fields = fileFields(
        entry,
        metadataStatus,
        metadata,
        envelope.revision.revisionId,
        info.resolvedRevision.committedAt,
      );
      if (request.where === undefined || evaluateMetadataFilter(request.where, fields)) {
        const projected = request.selectMetadataFields.length === 0 || metadata === null
          ? metadata
          : Object.freeze(Object.fromEntries(request.selectMetadataFields.flatMap((field) => {
              const selectedValue = metadataAt(fields, field);
              return selectedValue.exists ? [[field, jsonValue(selectedValue.value)]] : [];
            })));
        prepared.push(Object.freeze({
          entry,
          fields,
          nextOffset: index + 1,
          descriptor: Object.freeze({
            path: entry.path,
            kind: entry.kind,
            mediaType: entry.mediaType,
            size: entry.size,
            sha256: entry.sha256,
            revisionId: envelope.revision.revisionId,
            revisionCommittedAt: info.resolvedRevision.committedAt,
            metadataStatus,
            metadata: projected,
          }),
        }));
      }
      rawOffset = index + 1;
      if (!metadataSort && prepared.length >= request.limit) break;
    }
    prepared.sort((left, right) => {
      for (const sort of request.sort) {
        const order = compareUnknown(metadataAt(left.fields, sort.field).value, metadataAt(right.fields, sort.field).value);
        if (order !== 0) return sort.direction === "asc" ? order : -order;
      }
      return scalarCompare(left.entry.path, right.entry.path);
    });
    const candidatePage = metadataSort
      ? prepared.slice(cursor?.fileOffset ?? 0, (cursor?.fileOffset ?? 0) + request.limit)
      : prepared;
    const page: typeof prepared = [];
    let returnedBytes = 0;
    let responseBudgetHit = false;
    for (const item of candidatePage) {
      const descriptorBytes = new TextEncoder().encode(JSON.stringify(item.descriptor)).byteLength;
      if (descriptorBytes > request.maxOutputBytes) {
        throw new MindBrowseFailure(
          "file_operation_budget_exhausted",
          "One file descriptor exceeds the requested response budget.",
        );
      }
      if (returnedBytes + descriptorBytes > request.maxOutputBytes) {
        responseBudgetHit = true;
        break;
      }
      page.push(item);
      returnedBytes += descriptorBytes;
    }
    const nextOffset = metadataSort
      ? (cursor?.fileOffset ?? 0) + page.length
      : responseBudgetHit ? page.at(-1)!.nextOffset : rawOffset;
    const pageDomainLength = metadataSort ? prepared.length : selected.length;
    const incomplete = scanBudgetHit || timeBudgetHit || responseBudgetHit || nextOffset < pageDomainLength;
    const nextCursor = incomplete
      ? await this.#encodeFileOperationCursor(
          "list",
          info.mind.mindId,
          envelope,
          requestHash,
          nextOffset,
          0,
          selected.length,
        )
      : null;
    let aggregate: ListFilesResult["aggregate"] = Object.freeze({ kind: "none" });
    if (request.aggregate.kind === "count") {
      aggregate = Object.freeze({ kind: "count", count: page.length });
    } else if (request.aggregate.kind === "distinct") {
      const values: unknown[] = [];
      for (const item of page) {
        const selectedValue = metadataAt(item.fields, request.aggregate.field);
        if (selectedValue.exists && !values.some((value) => exactJsonEqual(value, selectedValue.value))) {
          values.push(jsonValue(selectedValue.value));
        }
      }
      values.sort(compareUnknown);
      aggregate = Object.freeze({
        kind: "distinct",
        field: request.aggregate.field,
        values: Object.freeze(values),
      });
    }
    await this.#requireSameAuthorization(
      actor,
      info.mind.mindId,
      "content:browse",
      info.revisionMode,
      initialAuthorization,
      "mind_not_found",
    );
    return Object.freeze({
      mind: info.mind,
      resolvedRevision: info.resolvedRevision,
      files: Object.freeze(page.map((item) => item.descriptor)),
      aggregate,
      scanned: Object.freeze({ files: scannedFiles, bytes: scannedBytes }),
      returnedBytes,
      incomplete,
      incompleteReason: incomplete ? (timeBudgetHit ? "time_budget" : scanBudgetHit ? "scan_budget" : responseBudgetHit ? "response_budget" : "page_limit") : null,
      nextCursor,
    });
  }

  async grepFiles(
    actor: ActorContext,
    query: unknown,
    signal?: AbortSignal,
  ): Promise<Readonly<GrepFilesResult>> {
    const deadlineAt = Date.now() + FILE_OPERATION_WALL_CLOCK_BUDGET_MS;
    const request = normalizeGrepFilesRequest(query);
    const cursor = await this.#fileOperationCursor(request.cursor, "grep");
    const selector = cursor !== null && !request.hasRevisionSelector
      ? ({ kind: "revision", revisionId: cursor.revisionId } satisfies MindRevisionSelector)
      : request.revisionSelector;
    let info;
    try {
      info = await this.#discovery.getMindInfo(actor, request.mind, selector);
    } catch (error) {
      if (cursor !== null && error instanceof MindDiscoveryFailure) {
        throw new MindBrowseFailure("file_operation_cursor_invalid", "File operation cursor is invalid.");
      }
      mapDiscoveryFailure(error);
    }
    const initialAuthorization = await this.#requireAuthorization(
      actor,
      info.mind.mindId,
      "content:search",
      info.revisionMode,
      "mind_not_found",
    );
    const envelope = await this.#readVerifiedEnvelope(
      info.mind.mindId,
      info.resolvedRevision.revisionId,
      "revision_not_found",
    );
    const requestHash = await this.#objects.calculateSha256(new TextEncoder().encode(
      JSON.stringify(fileOperationRequestValue("grep", request)),
    ));
    const selected = selectEntries(envelope.manifest.entries, request.selector);
    this.#validateFileOperationCursor(cursor, info.mind.mindId, envelope, requestHash, selected.length);
    const expressions = request.patterns.map((pattern) => RE2JS.compile(
      request.syntax === "literal" ? regexEscape(pattern) : pattern,
      request.caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE,
    ));
    const files: GrepFileResult[] = [];
    const errors: Array<{ path: string; error: FileOperationItemError }> = [];
    let scannedFiles = 0;
    let scannedBytes = 0;
    let returnedRows = 0;
    let returnedBytes = 0;
    let fileOffset = cursor?.fileOffset ?? 0;
    let lineOffset = cursor?.lineOffset ?? 0;
    let incompleteReason: GrepFilesResult["incompleteReason"] = null;

    outer: for (; fileOffset < selected.length; fileOffset += 1, lineOffset = 0) {
      const fileBudgetState = fileOperationBudgetState(signal, deadlineAt);
      if (fileBudgetState === "aborted") {
        throw new MindBrowseFailure("file_operation_budget_exhausted", "File operation was aborted.", true);
      }
      if (fileBudgetState === "deadline") {
        incompleteReason = "time_budget";
        break;
      }
      const entry = selected[fileOffset]!;
      if (entry.size > MAX_TEXT_BUNDLE_FILE_BYTES ||
        (entry.kind === "opaque" && !isTextMediaType(entry.mediaType))) {
        const skipped = await this.#loadTextFile(envelope.revision.spaceId, envelope.manifest.format, entry);
        scannedFiles += 1;
        if (skipped.kind === "error") {
          errors.push(Object.freeze({ path: entry.path, error: skipped.error }));
          continue;
        }
        throw new MindBrowseFailure("revision_integrity_failure", "File admission state is inconsistent.");
      }
      if (scannedBytes + entry.size > MAX_GREP_SCAN_BYTES) {
        incompleteReason = "scan_budget";
        break;
      }
      const loaded = await this.#loadTextFile(envelope.revision.spaceId, envelope.manifest.format, entry);
      scannedFiles += 1;
      scannedBytes += entry.size;
      if (loaded.kind === "error") {
        errors.push(Object.freeze({ path: entry.path, error: loaded.error }));
        continue;
      }
      const lines = splitTextLines(loaded.file.text);
      const matches: GrepLineMatch[] = [];
      let matchingLines = 0;
      let occurrences = 0;
      let stopAfterFile = false;
      for (let index = lineOffset; index < lines.length; index += 1) {
        const lineBudgetState = fileOperationBudgetState(signal, deadlineAt);
        if (lineBudgetState === "aborted") {
          throw new MindBrowseFailure("file_operation_budget_exhausted", "File operation was aborted.", true);
        }
        if (lineBudgetState === "deadline") {
          incompleteReason = "time_budget";
          lineOffset = index;
          stopAfterFile = true;
          break;
        }
        const line = lines[index]!;
        const spans: GrepMatchSpan[] = [];
        expressions.forEach((expression, patternIndex) => {
          const matcher = expression.matcher(line.text);
          while (matcher.find()) {
            const start = matcher.start();
            const end = matcher.end();
            const accepted = (!request.wholeLine || (start === 0 && end === line.text.length)) &&
              (!request.wholeWord || (!wordScalar(scalarBefore(line.text, start)) && !wordScalar(scalarAfter(line.text, end))));
            if (accepted) {
              const startInLine = byteOffsetAt(line.text, start);
              const endInLine = byteOffsetAt(line.text, end);
              spans.push(Object.freeze({
                patternIndex,
                startColumn: Array.from(line.text.slice(0, start)).length + 1,
                endColumn: Array.from(line.text.slice(0, end)).length + 1,
                startByte: line.startByte + startInLine,
                endByte: line.startByte + endInLine,
              }));
            }
          }
        });
        if (spans.length === 0) continue;
        spans.sort((left, right) => left.startByte - right.startByte || left.patternIndex - right.patternIndex);
        if (request.output === "matches") {
          const beforeContext = lines.slice(Math.max(0, index - request.beforeContext), index).map((item) => item.text);
          const afterContext = lines.slice(index + 1, index + 1 + request.afterContext).map((item) => item.text);
          const rowBytes = [line.text, ...beforeContext, ...afterContext]
            .reduce((sum, value) => sum + new TextEncoder().encode(value).byteLength, 0);
          if (rowBytes > request.maxOutputBytes) {
            throw new MindBrowseFailure(
              "file_operation_budget_exhausted",
              "One grep result row exceeds the requested response budget.",
            );
          }
          if (returnedRows >= request.limit || returnedBytes + rowBytes > request.maxOutputBytes) {
            incompleteReason = returnedRows >= request.limit ? "page_limit" : "response_budget";
            lineOffset = index;
            stopAfterFile = true;
            break;
          }
          matchingLines += 1;
          occurrences += spans.length;
          matches.push(Object.freeze({
            lineNumber: index + 1,
            startByte: line.startByte,
            endByte: line.endByte,
            text: line.text,
            spans: Object.freeze(spans),
            beforeContext: Object.freeze(beforeContext),
            afterContext: Object.freeze(afterContext),
          }));
          returnedRows += 1;
          returnedBytes += rowBytes;
        } else {
          matchingLines += 1;
          occurrences += spans.length;
        }
      }
      const qualifies = request.output === "count" ||
        (request.output === "matches" && matches.length > 0) ||
        (request.output === "files_with_matches" && matchingLines > 0) ||
        (request.output === "files_without_match" && matchingLines === 0);
      if (qualifies) {
        if (request.output !== "matches" && returnedRows >= request.limit) {
          incompleteReason = "page_limit";
          break;
        }
        files.push(Object.freeze({
          path: entry.path,
          kind: entry.kind,
          mediaType: entry.mediaType,
          sha256: entry.sha256,
          revisionId: envelope.revision.revisionId,
          matchingLines,
          occurrences,
          count: request.countUnit === "occurrences" ? occurrences : matchingLines,
          matches: Object.freeze(matches),
        }));
        if (request.output !== "matches") returnedRows += 1;
      }
      if (stopAfterFile) break outer;
    }
    const incomplete = incompleteReason !== null || fileOffset < selected.length;
    const nextCursor = incomplete
      ? await this.#encodeFileOperationCursor(
          "grep",
          info.mind.mindId,
          envelope,
          requestHash,
          fileOffset,
          lineOffset,
          selected.length,
        )
      : null;
    await this.#requireSameAuthorization(
      actor,
      info.mind.mindId,
      "content:search",
      info.revisionMode,
      initialAuthorization,
      "mind_not_found",
    );
    return Object.freeze({
      mind: info.mind,
      resolvedRevision: info.resolvedRevision,
      output: request.output,
      countUnit: request.countUnit,
      files: Object.freeze(files),
      errors: Object.freeze(errors),
      scanned: Object.freeze({ files: scannedFiles, bytes: scannedBytes }),
      returned: Object.freeze({ rows: returnedRows, bytes: returnedBytes }),
      incomplete,
      incompleteReason: incomplete ? (incompleteReason ?? "page_limit") : null,
      nextCursor,
    });
  }

  async readFiles(
    actor: ActorContext,
    query: unknown,
    signal?: AbortSignal,
  ): Promise<Readonly<ReadFilesResult>> {
    const deadlineAt = Date.now() + FILE_OPERATION_WALL_CLOCK_BUDGET_MS;
    const request = normalizeReadFilesRequest(query);
    const cursor = await this.#fileOperationCursor(request.cursor, "read");
    const selector = cursor !== null && !request.hasRevisionSelector
      ? ({ kind: "revision", revisionId: cursor.revisionId } satisfies MindRevisionSelector)
      : request.revisionSelector;
    let info;
    try {
      info = await this.#discovery.getMindInfo(actor, request.mind, selector);
    } catch (error) {
      if (cursor !== null && error instanceof MindDiscoveryFailure) {
        throw new MindBrowseFailure("file_operation_cursor_invalid", "File operation cursor is invalid.");
      }
      mapDiscoveryFailure(error);
    }
    const initialAuthorization = await this.#requireAuthorization(
      actor,
      info.mind.mindId,
      "content:fetch",
      info.revisionMode,
      "mind_not_found",
    );
    const envelope = await this.#readVerifiedEnvelope(
      info.mind.mindId,
      info.resolvedRevision.revisionId,
      "revision_not_found",
    );
    const requestHash = await this.#objects.calculateSha256(new TextEncoder().encode(
      JSON.stringify(fileOperationRequestValue("read", request)),
    ));
    this.#validateFileOperationCursor(cursor, info.mind.mindId, envelope, requestHash, request.requests.length);
    const items: Array<ReadFilesResult["items"][number]> = [];
    let returnedBytes = 0;
    let requestOffset = cursor?.fileOffset ?? 0;
    let continuationByte = cursor?.lineOffset ?? 0;
    let incomplete = false;
    let incompleteReason: ReadFilesResult["incompleteReason"] = null;
    for (; requestOffset < request.requests.length; requestOffset += 1, continuationByte = 0) {
      const budgetState = fileOperationBudgetState(signal, deadlineAt);
      if (budgetState === "aborted") {
        throw new MindBrowseFailure("file_operation_budget_exhausted", "File operation was aborted.", true);
      }
      if (budgetState === "deadline") {
        incomplete = true;
        incompleteReason = "time_budget";
        break;
      }
      const selection = request.requests[requestOffset]!;
      const entry = envelope.manifest.entries.find((candidate) => candidate.path === selection.path);
      if (entry === undefined) {
        items.push(Object.freeze({
          kind: "error",
          path: selection.path,
          error: Object.freeze({ code: "file_not_found", retryable: false }),
        }));
        continue;
      }
      const loaded = selection.mode === "head"
        ? await loadTextFileHead(
            this.#objects,
            envelope.revision.spaceId,
            envelope.manifest.format,
            entry,
            selection.count,
            signal,
            deadlineAt,
            () => this.#loadTextFile(envelope.revision.spaceId, envelope.manifest.format, entry),
          )
        : await this.#loadTextFile(envelope.revision.spaceId, envelope.manifest.format, entry);
      if (loaded.kind === "error") {
        items.push(Object.freeze({ kind: "error", path: selection.path, error: loaded.error }));
        continue;
      }
      const lines = splitTextLines(loaded.file.text);
      const total = entry.size;
      let start = 0;
      let end = total;
      let requestedLineRange: ReadFileResultItem["lineRange"] = null;
      if (selection.mode === "head") {
        const count = Math.min(selection.count, lines.length);
        end = loaded.file.bytes.byteLength;
        requestedLineRange = Object.freeze({
          start: count === 0 ? 0 : 1,
          end: count,
          total: "complete" in loaded && loaded.complete ? lines.length : null,
        });
      } else if (selection.mode === "tail") {
        const count = Math.min(selection.count, lines.length);
        const first = lines.length - count;
        start = count === 0 ? 0 : lines[first]!.startByte;
        requestedLineRange = Object.freeze({ start: count === 0 ? 0 : first + 1, end: lines.length, total: lines.length });
      } else if (selection.mode === "lines") {
        if (selection.startLine > lines.length || selection.endLine > lines.length) {
          items.push(Object.freeze({
            kind: "error",
            path: selection.path,
            error: Object.freeze({ code: "range_out_of_bounds", retryable: false }),
          }));
          continue;
        }
        start = lines[selection.startLine - 1]!.startByte;
        end = lines[selection.endLine - 1]!.endWithTerminatorByte;
        requestedLineRange = Object.freeze({ start: selection.startLine, end: selection.endLine, total: lines.length });
      } else if (selection.mode === "bytes") {
        if (selection.endByte > total || !isUtf8Boundary(loaded.file.bytes, selection.startByte) ||
          !isUtf8Boundary(loaded.file.bytes, selection.endByte)) {
          items.push(Object.freeze({
            kind: "error",
            path: selection.path,
            error: Object.freeze({
              code: selection.endByte > total ? "range_out_of_bounds" : "utf8_boundary_required",
              retryable: false,
            }),
          }));
          continue;
        }
        start = selection.startByte;
        end = selection.endByte;
      }
      if (continuationByte > 0) start = Math.max(start, continuationByte);
      const remaining = request.maxOutputBytes - returnedBytes;
      if (remaining < MIN_FETCH_BYTE_BUDGET && start < end) {
        incomplete = true;
        incompleteReason = "response_budget";
        break;
      }
      const pageEnd = safeUtf8PageEnd(loaded.file.bytes, start, end, remaining);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(loaded.file.bytes.slice(start, pageEnd));
      returnedBytes += pageEnd - start;
      items.push(Object.freeze({
        kind: "file",
        file: Object.freeze({
          path: entry.path,
          kind: entry.kind,
          mediaType: entry.mediaType,
          sha256: entry.sha256,
          revisionId: envelope.revision.revisionId,
          text,
          byteRange: Object.freeze({ start, end: pageEnd, total }),
          lineRange: requestedLineRange,
          truncated: pageEnd < end,
          nextRange: pageEnd < end ? Object.freeze({ startByte: pageEnd, endByte: end }) : null,
        }),
      }));
      if (pageEnd < end) {
        continuationByte = pageEnd;
        incomplete = true;
        incompleteReason = "response_budget";
        break;
      }
    }
    const nextCursor = incomplete
      ? await this.#encodeFileOperationCursor(
          "read",
          info.mind.mindId,
          envelope,
          requestHash,
          requestOffset,
          continuationByte,
          request.requests.length,
        )
      : null;
    await this.#requireSameAuthorization(
      actor,
      info.mind.mindId,
      "content:fetch",
      info.revisionMode,
      initialAuthorization,
      "mind_not_found",
    );
    return Object.freeze({
      mind: info.mind,
      resolvedRevision: info.resolvedRevision,
      items: Object.freeze(items),
      returnedBytes,
      incomplete,
      incompleteReason,
      nextCursor,
    });
  }

  async fetch(
    actor: ActorContext,
    requestValue: unknown,
  ): Promise<Readonly<FetchedEntryResult>> {
    const request = normalizeFetchRequest(requestValue);
    const locator = await this.#locators.decode(request.id);
    if (locator === null || (locator.kind !== "entry" && locator.kind !== "continuation")) {
      throw new MindBrowseFailure("locator_not_found", "Entry was not found.");
    }
    const loaded = await this.#loadExactFile(
      actor,
      locator.spaceId,
      locator.revisionId,
      locator.path,
      "locator_not_found",
      locator,
    );
    const pageEnd = safeUtf8PageEnd(
      loaded.bytes,
      locator.start,
      locator.end,
      request.maxBytes,
    );
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        loaded.bytes.slice(locator.start, pageEnd),
      );
    } catch {
      throw new MindBrowseFailure(
        "revision_integrity_failure",
        "The exact revision could not be decoded safely.",
      );
    }
    const continuationId =
      pageEnd < locator.end
        ? await this.#locators.encode(
            Object.freeze({
              version: LOCATOR_VERSION,
              kind: "continuation",
              spaceId: locator.spaceId,
              revisionId: locator.revisionId,
              path: locator.path,
              sha256: locator.sha256,
              start: pageEnd,
              end: locator.end,
            }),
          )
        : null;
    const result = Object.freeze({
      entry: await this.#entrySummary(
        locator.spaceId,
        locator.revisionId,
        loaded.entry,
        loaded.bytes,
        locator.kind === "entry" &&
          locator.start === 0 &&
          locator.end === loaded.entry.size &&
          typeof request.id === "string"
          ? request.id
          : undefined,
      ),
      text,
      truncated: continuationId !== null,
      continuationId,
      byteBudget: request.maxBytes,
      range: Object.freeze({
        start: locator.start,
        end: pageEnd,
        total: locator.end,
      }),
    });
    await this.#requireSameAuthorization(
      actor,
      locator.spaceId,
      "content:fetch",
      "historical",
      loaded.authorization,
      "locator_not_found",
    );
    return result;
  }

  async readResource(
    actor: ActorContext,
    uri: unknown,
  ): Promise<Readonly<ImmutableResourceReadResult>> {
    const target = parseResourceUri(uri);
    if (target === null) {
      throw new MindBrowseFailure("resource_not_found", "Resource was not found.");
    }
    const loaded = await this.#loadExactFile(
      actor,
      target.spaceId,
      target.revisionId,
      target.path,
      "resource_not_found",
    );
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(loaded.bytes);
    } catch {
      throw new MindBrowseFailure(
        "revision_integrity_failure",
        "The exact revision could not be decoded safely.",
      );
    }
    const result = Object.freeze({
      uri: uri as string,
      mimeType: MARKDOWN_MEDIA_TYPE,
      text,
      entry: await this.#entrySummary(
        target.spaceId,
        target.revisionId,
        loaded.entry,
        loaded.bytes,
      ),
    });
    await this.#requireSameAuthorization(
      actor,
      target.spaceId,
      "content:fetch",
      "historical",
      loaded.authorization,
      "resource_not_found",
    );
    return result;
  }

  async #fileOperationCursor(
    encoded: string | null,
    operation: FileOperationCursorLocatorPayload["operation"],
  ): Promise<Readonly<FileOperationCursorLocatorPayload> | null> {
    if (encoded === null) return null;
    const decoded = await this.#locators.decode(encoded);
    if (
      decoded === null || decoded.kind !== "file_operation" || decoded.operation !== operation
    ) {
      throw new MindBrowseFailure(
        "file_operation_cursor_invalid",
        "File operation cursor is invalid.",
      );
    }
    return decoded;
  }

  #validateFileOperationCursor(
    cursor: Readonly<FileOperationCursorLocatorPayload> | null,
    spaceId: SpaceId,
    envelope: Readonly<CanonicalRevisionEnvelope>,
    requestHash: Sha256Digest,
    end: number,
  ): void {
    if (cursor === null) return;
    if (
      cursor.spaceId !== spaceId ||
      cursor.revisionId !== envelope.revision.revisionId ||
      cursor.manifestHash !== envelope.revision.manifestHash ||
      cursor.requestHash !== requestHash ||
      cursor.end !== end ||
      cursor.fileOffset < 0 || cursor.fileOffset >= end ||
      cursor.lineOffset < 0
    ) {
      throw new MindBrowseFailure(
        "file_operation_cursor_invalid",
        "File operation cursor is invalid.",
      );
    }
  }

  async #encodeFileOperationCursor(
    operation: FileOperationCursorLocatorPayload["operation"],
    spaceId: SpaceId,
    envelope: Readonly<CanonicalRevisionEnvelope>,
    requestHash: Sha256Digest,
    fileOffset: number,
    lineOffset: number,
    end: number,
  ): Promise<string> {
    return await this.#locators.encode(Object.freeze({
      version: LOCATOR_VERSION,
      kind: "file_operation",
      operation,
      spaceId,
      revisionId: envelope.revision.revisionId,
      manifestHash: envelope.revision.manifestHash,
      requestHash,
      fileOffset,
      lineOffset,
      end,
    }));
  }

  async #loadTextFile(
    spaceId: SpaceId,
    manifestFormat: CanonicalRevisionEnvelope["manifest"]["format"],
    entry: Readonly<RevisionManifestEntry>,
  ): Promise<Readonly<
    | { readonly kind: "file"; readonly file: Readonly<ExactTextFile> }
    | { readonly kind: "error"; readonly error: FileOperationItemError }
  >> {
    if (entry.kind === "opaque" && !isTextMediaType(entry.mediaType)) {
      return Object.freeze({
        kind: "error",
        error: Object.freeze({ code: "file_not_text", retryable: false }),
      });
    }
    if (entry.kind === "opaque" && entry.size > MAX_TEXT_BUNDLE_FILE_BYTES) {
      return Object.freeze({
        kind: "error",
        error: Object.freeze({ code: "file_scan_limit_exceeded", retryable: false }),
      });
    }
    let bytes: Uint8Array;
    if (entry.kind === "markdown") {
      bytes = await this.#readVerifiedObject(spaceId, manifestFormat, entry);
    } else {
      if (!("getBundleFile" in this.#objects)) {
        throw new MindBrowseFailure(
          "revision_integrity_failure",
          "The exact revision object store cannot read BundleFiles.",
        );
      }
      let object;
      try {
        object = await (this.#objects as BundleFileObjectStore).getBundleFile(spaceId, entry.sha256);
      } catch (error) {
        if (error instanceof ObjectStoreFailure) {
          throw new MindBrowseFailure(
            "revision_integrity_failure",
            "The exact revision BundleFile failed integrity verification.",
          );
        }
        throw error;
      }
      if (
        object === null || object.sha256 !== entry.sha256 || object.mediaType !== entry.mediaType ||
        object.size !== entry.size || object.bytes.byteLength !== entry.size ||
        (await this.#objects.calculateSha256(object.bytes)) !== entry.sha256
      ) {
        throw new MindBrowseFailure(
          "revision_integrity_failure",
          "The exact revision BundleFile failed integrity verification.",
        );
      }
      bytes = new Uint8Array(object.bytes);
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return Object.freeze({
        kind: "file",
        file: Object.freeze({ entry, bytes, text }),
      });
    } catch {
      return Object.freeze({
        kind: "error",
        error: Object.freeze({ code: "unsupported_text_encoding", retryable: false }),
      });
    }
  }

  async #fileMetadata(
    spaceId: SpaceId,
    manifestFormat: CanonicalRevisionEnvelope["manifest"]["format"],
    entry: Readonly<RevisionManifestEntry>,
  ): Promise<Readonly<{
    status: FileMetadataStatus;
    metadata: Readonly<Record<string, unknown>> | null;
  }>> {
    const loaded = await this.#loadTextFile(spaceId, manifestFormat, entry);
    if (loaded.kind === "error") {
      return Object.freeze({ status: "unsupported", metadata: null });
    }
    if (entry.kind === "markdown") {
      const parsed = parseOkfFile({ path: entry.path, bytes: loaded.file.bytes });
      if (!parsed.valid || parsed.file === null) {
        return Object.freeze({ status: "invalid", metadata: null });
      }
      if (parsed.file.kind !== "concept" && parsed.file.kind !== "index") {
        return Object.freeze({ status: "unsupported", metadata: null });
      }
      return Object.freeze({
        status: "available",
        metadata: jsonValue(parsed.file.frontmatter) as Readonly<Record<string, unknown>>,
      });
    }
    try {
      let value: unknown;
      if (entry.mediaType === "application/json" || entry.mediaType.endsWith("+json")) {
        value = JSON.parse(loaded.file.text);
      } else if (
        entry.mediaType === "application/yaml" || entry.mediaType === "application/x-yaml" ||
        entry.mediaType === "text/yaml"
      ) {
        value = parseYaml(loaded.file.text, { schema: "core", maxAliasCount: 0 });
      } else {
        return Object.freeze({ status: "unsupported", metadata: null });
      }
      if (!isRecord(value)) return Object.freeze({ status: "unsupported", metadata: null });
      return Object.freeze({
        status: "available",
        metadata: jsonValue(value) as Readonly<Record<string, unknown>>,
      });
    } catch {
      return Object.freeze({ status: "invalid", metadata: null });
    }
  }

  async #entrySummary(
    spaceId: SpaceId,
    revisionId: RevisionId,
    entry: Readonly<RevisionManifestEntry>,
    bytes: Uint8Array,
    reusableEntryId?: string,
  ): Promise<Readonly<MindEntrySummary>> {
    const parsed = parseOkfFile({ path: entry.path, bytes });
    if (!parsed.valid || parsed.file === null) {
      throw new MindBrowseFailure(
        "revision_integrity_failure",
        "The exact revision contains invalid canonical Markdown.",
      );
    }
    const frontmatter =
      parsed.file.kind === "concept" || parsed.file.kind === "index"
        ? parsed.file.frontmatter
        : null;
    let resourceUri: string;
    try {
      resourceUri = exactRevisionResourceUri(spaceId, revisionId, entry.path);
    } catch {
      throw new MindBrowseFailure(
        "revision_integrity_failure",
        "The exact revision contains an invalid resource identity.",
      );
    }
    const entryId = reusableEntryId ?? await this.#locators.encode(
      Object.freeze({
        version: LOCATOR_VERSION,
        kind: "entry",
        spaceId,
        revisionId,
        path: entry.path,
        sha256: entry.sha256,
        start: 0,
        end: entry.size,
      }),
    );
    return Object.freeze({
      entryId,
      resourceUri,
      path: entry.path,
      kind: okfFileKind(entry.path),
      title: entryTitle(entry.path, frontmatter),
      description: entryDescription(frontmatter),
      tags: entryTags(frontmatter),
      mimeType: MARKDOWN_MEDIA_TYPE,
      revisionId,
      sha256: entry.sha256,
      size: entry.size,
      okfType: parsed.file.kind === "concept" ? parsed.file.okfType : null,
    });
  }

  async #loadExactFile(
    actor: ActorContext,
    spaceId: SpaceId,
    revisionId: RevisionId,
    path: string,
    notFoundCode: "locator_not_found" | "resource_not_found",
    locator?: Readonly<ExactEntryLocatorPayload>,
  ): Promise<Readonly<LoadedExactFile>> {
    const initialAuthorization = await this.#requireAuthorization(
      actor,
      spaceId,
      "content:fetch",
      "historical",
      notFoundCode,
    );
    const envelope = await this.#readVerifiedEnvelope(
      spaceId,
      revisionId,
      notFoundCode,
    );
    const entry = envelope.manifest.entries.find(
      (candidate) => candidate.kind === "markdown" && candidate.path === path,
    );
    if (
      entry === undefined ||
      (locator !== undefined &&
        (locator.sha256 !== entry.sha256 ||
          locator.end !== entry.size ||
          locator.start < 0 ||
          locator.start > locator.end))
    ) {
      throw new MindBrowseFailure(notFoundCode, "Entry was not found.");
    }
    await this.#requireSameAuthorization(
      actor,
      spaceId,
      "content:fetch",
      "historical",
      initialAuthorization,
      notFoundCode,
    );
    const bytes = await this.#readVerifiedObject(
      envelope.revision.spaceId,
      envelope.manifest.format,
      entry,
    );
    // The caller performs the final current-access recheck after response
    // materialization; repeating it here would add an identical D1 refresh.
    return Object.freeze({
      entry,
      bytes,
      authorization: initialAuthorization,
    });
  }

  async #readVerifiedEnvelope(
    spaceId: SpaceId,
    revisionId: RevisionId,
    notFoundCode: "revision_not_found" | "locator_not_found" | "resource_not_found",
  ): Promise<Readonly<CanonicalRevisionEnvelope>> {
    const envelope = await this.#store.readRevision(spaceId, revisionId);
    if (
      envelope === null ||
      envelope.revision.spaceId !== spaceId ||
      envelope.revision.revisionId !== revisionId
    ) {
      throw new MindBrowseFailure(
        notFoundCode,
        notFoundCode === "revision_not_found" ? "Revision was not found." : "Entry was not found.",
      );
    }
    let manifest = envelope.manifest;
    try {
      if (
        manifest.format === REVISION_MANIFEST_FORMAT_V3 ||
        manifest.format === REVISION_MANIFEST_FORMAT_V4
      ) {
        const stored = "getSpaceCanonicalObject" in this.#objects
          ? await (this.#objects as BundleFileObjectStore).getSpaceCanonicalObject(
              "revision_manifest",
              spaceId,
              envelope.revision.manifestHash,
            )
          : null;
        if (
          stored === null || stored.mediaType !== REVISION_MANIFEST_MEDIA_TYPE ||
          (envelope.revision.manifestSize !== undefined &&
            stored.size !== envelope.revision.manifestSize)
        ) throw new Error("missing manifest");
        manifest = parseRevisionManifest(
          new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes),
        );
        if (!revisionEnvelopesEqual({ revision: envelope.revision, manifest }, envelope)) {
          throw new Error("manifest projection mismatch");
        }
      } else {
        const manifestHash = await this.#objects.calculateSha256(
          new TextEncoder().encode(serializeRevisionManifest(manifest)),
        );
        if (manifestHash !== envelope.revision.manifestHash) throw new Error("manifest hash");
      }
    } catch {
      throw new MindBrowseFailure(
        "revision_integrity_failure",
        "The exact revision manifest failed integrity verification.",
      );
    }
    return Object.freeze({ revision: envelope.revision, manifest });
  }

  async #readVerifiedObject(
    spaceId: SpaceId,
    manifestFormat: CanonicalRevisionEnvelope["manifest"]["format"],
    entry: Readonly<RevisionManifestEntry>,
  ): Promise<Uint8Array> {
    let object;
    try {
      object = (manifestFormat === REVISION_MANIFEST_FORMAT_V3 ||
          manifestFormat === REVISION_MANIFEST_FORMAT_V4) &&
          "getSpaceCanonicalObject" in this.#objects
        ? await (this.#objects as BundleFileObjectStore).getSpaceCanonicalObject(
            "markdown",
            spaceId,
            entry.sha256,
          ) ?? await this.#objects.getImmutable(entry.sha256)
        : await this.#objects.getImmutable(entry.sha256);
    } catch (error) {
      if (error instanceof ObjectStoreFailure) {
        throw new MindBrowseFailure(
          "revision_integrity_failure",
          "The exact revision object failed integrity verification.",
        );
      }
      throw error;
    }
    if (
      object === null ||
      object.sha256 !== entry.sha256 ||
      object.mediaType !== entry.mediaType ||
      object.size !== entry.size ||
      object.bytes.byteLength !== entry.size
    ) {
      throw new MindBrowseFailure(
        "revision_integrity_failure",
        "The exact revision object failed integrity verification.",
      );
    }
    const bytes = new Uint8Array(object.bytes);
    if ((await this.#objects.calculateSha256(bytes)) !== entry.sha256) {
      throw new MindBrowseFailure(
        "revision_integrity_failure",
        "The exact revision object failed integrity verification.",
      );
    }
    return bytes;
  }

  async #inspectBundleFilePreview(
    spaceId: SpaceId,
    entry: Readonly<RevisionManifestEntry>,
  ): Promise<boolean> {
    if (
      entry.kind !== "opaque" ||
      !INLINE_BUNDLE_FILE_MEDIA_TYPES.has(entry.mediaType) ||
      !("openBundleFile" in this.#objects)
    ) return false;
    try {
      const object = await (this.#objects as BundleFileObjectStore).openBundleFile(
        spaceId,
        entry.sha256,
      );
      if (object === null) return false;
      if (object.mediaType !== entry.mediaType || object.size !== entry.size) {
        await object.body.cancel().catch(() => undefined);
        return false;
      }
      return await inspectSafeRasterPreview(
        object.body,
        entry.mediaType as BundleFileMediaType,
        entry.size,
      );
    } catch {
      // Preview verification is a derived serving capability. Failure leaves
      // canonical storage intact and safely falls back to attachment.
      return false;
    }
  }

  async #requireAuthorization(
    actor: ActorContext,
    spaceId: SpaceId,
    capability: "content:browse" | "content:fetch" | "content:search",
    revisionMode: RevisionMode,
    denialCode: "mind_not_found" | "locator_not_found" | "resource_not_found",
  ): Promise<AllowedAuthorization> {
    try {
      await this.#discovery.requireEnabledMindUsage(actor, spaceId);
    } catch (error) {
      if (error instanceof MindDiscoveryFailure) {
        throw new MindBrowseFailure(
          denialCode,
          denialCode === "mind_not_found" ? "Mind was not found." : "Entry was not found.",
        );
      }
      throw error;
    }
    const decision = await this.#authorizer.authorize({
      actor,
      spaceId,
      capability,
      revisionMode,
    });
    if (decision.kind === "denied") {
      if (
        decision.code === "mind_binding_required" ||
        decision.code === "binding_owner_revoked" ||
        decision.code === "binding_state_unavailable"
      ) {
        throw new MindBrowseFailure(
          decision.code,
          "The current MCP credential cannot use this Mind binding.",
          decision.retryable,
        );
      }
      throw new MindBrowseFailure(
        denialCode,
        denialCode === "mind_not_found" ? "Mind was not found." : "Entry was not found.",
      );
    }
    return decision;
  }

  async #requireSameAuthorization(
    actor: ActorContext,
    spaceId: SpaceId,
    capability: "content:browse" | "content:fetch" | "content:search",
    revisionMode: RevisionMode,
    expected: AllowedAuthorization,
    denialCode: "mind_not_found" | "locator_not_found" | "resource_not_found",
  ): Promise<void> {
    try {
      await this.#discovery.requireEnabledMindUsage(actor, spaceId);
    } catch (error) {
      if (error instanceof MindDiscoveryFailure) {
        throw new MindBrowseFailure(
          denialCode,
          denialCode === "mind_not_found" ? "Mind was not found." : "Entry was not found.",
        );
      }
      throw error;
    }
    const decision = await this.#authorizer.authorize({
      actor,
      spaceId,
      capability,
      revisionMode,
    });
    if (decision.kind === "denied") {
      if (decision.code === "authorization_state_changed") {
        throw new MindBrowseFailure(
          "read_conflict",
          "Mind binding changed during the read; retry from a fresh descriptor.",
          true,
        );
      }
      if (
        decision.code === "mind_binding_required" ||
        decision.code === "binding_owner_revoked" ||
        decision.code === "binding_state_unavailable"
      ) {
        throw new MindBrowseFailure(
          decision.code,
          "The current MCP credential cannot use this Mind binding.",
          decision.retryable,
        );
      }
      throw new MindBrowseFailure(
        denialCode,
        denialCode === "mind_not_found" ? "Mind was not found." : "Entry was not found.",
      );
    }
    if (!sameAuthorization(expected, decision)) {
      if (denialCode !== "mind_not_found") {
        throw new MindBrowseFailure(denialCode, "Entry was not found.");
      }
      throw new MindBrowseFailure(
        "read_conflict",
        "Mind access changed during the read; retry from a fresh descriptor.",
        true,
      );
    }
  }
}
