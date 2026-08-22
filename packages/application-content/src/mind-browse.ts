import type { ActorContext } from "@mind-diary/application-contracts";
import {
  CapabilityAuthorizer,
  ObjectStoreFailure,
  type AuthorizationDecision,
  type Authorizer,
  type ObjectStore,
} from "@mind-diary/application-ports";
import {
  MARKDOWN_MEDIA_TYPE,
  canonicalMarkdownPath,
  serializeRevisionManifest,
  type CanonicalRevisionEnvelope,
  type RevisionId,
  type RevisionManifestEntry,
  type RevisionMode,
  type Sha256Digest,
  type SpaceId,
  type VerifiedSpaceHost,
} from "@mind-diary/domain";
import { okfFileKind, parseOkfFile } from "@mind-diary/okf-codec";

import {
  MindDiscoveryFailure,
  MindDiscoveryService,
  type MindDiscoveryDescriptor,
  type MindDiscoveryFailureCode,
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

export type MindBrowseFailureCode =
  | MindDiscoveryFailureCode
  | "invalid_request"
  | "invalid_path"
  | "invalid_limit"
  | "invalid_cursor"
  | "invalid_fetch_budget"
  | "locator_not_found"
  | "resource_not_found"
  | "revision_integrity_failure"
  | "read_conflict"
  | "mind_binding_required"
  | "binding_owner_revoked"
  | "binding_state_unavailable";

/** Safe content-read failure. It never embeds a locator payload or private content. */
export class MindBrowseFailure extends Error {
  readonly code: MindBrowseFailureCode;
  readonly retryable: boolean;

  constructor(code: MindBrowseFailureCode, message: string, retryable = false) {
    super(message);
    this.name = "MindBrowseFailure";
    this.code = code;
    this.retryable = retryable;
  }
}

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

export type MindLocatorPayload =
  | ExactEntryLocatorPayload
  | BrowseCursorLocatorPayload;

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
        const bytes = await this.#readVerifiedObject(entry);
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

  async #entrySummary(
    spaceId: SpaceId,
    revisionId: RevisionId,
    entry: Readonly<RevisionManifestEntry>,
    bytes: Uint8Array,
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
    const entryId = await this.#locators.encode(
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
    const bytes = await this.#readVerifiedObject(entry);
    await this.#requireSameAuthorization(
      actor,
      spaceId,
      "content:fetch",
      "historical",
      initialAuthorization,
      notFoundCode,
    );
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
    const manifestHash = await this.#objects.calculateSha256(
      new TextEncoder().encode(serializeRevisionManifest(envelope.manifest)),
    );
    if (manifestHash !== envelope.revision.manifestHash) {
      throw new MindBrowseFailure(
        "revision_integrity_failure",
        "The exact revision manifest failed integrity verification.",
      );
    }
    return envelope;
  }

  async #readVerifiedObject(entry: Readonly<RevisionManifestEntry>): Promise<Uint8Array> {
    let object;
    try {
      object = await this.#objects.getImmutable(entry.sha256);
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

  async #requireAuthorization(
    actor: ActorContext,
    spaceId: SpaceId,
    capability: "content:browse" | "content:fetch",
    revisionMode: RevisionMode,
    denialCode: "mind_not_found" | "locator_not_found" | "resource_not_found",
  ): Promise<AllowedAuthorization> {
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
    capability: "content:browse" | "content:fetch",
    revisionMode: RevisionMode,
    expected: AllowedAuthorization,
    denialCode: "mind_not_found" | "locator_not_found" | "resource_not_found",
  ): Promise<void> {
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
