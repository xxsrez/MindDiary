import type { ActorContext } from "@mind-diary/application-contracts";
import {
  CapabilityAuthorizer,
  type AuthorizationDecision,
  type Authorizer,
  type ReadExactRevisionIndexResult,
  type QueryExactRevisionIndexResult,
  type SearchIndex,
} from "@mind-diary/application-ports";
import {
  MARKDOWN_MEDIA_TYPE,
  type RevisionId,
  type RevisionManifestEntry,
  type RevisionMode,
  type Sha256Digest,
  type SpaceId,
  type VerifiedSpaceHost,
} from "@mind-diary/domain";
import { okfFileKind, parseOkfFile, type ParsedOkfFile } from "@mind-diary/okf-codec";

import {
  exactRevisionResourceUri,
  type BrowseCursorLocatorPayload,
  type MindEntrySummary,
  type MindLocatorCodec,
} from "./mind-browse.js";
import {
  MindDiscoveryFailure,
  MindDiscoveryService,
  type MindDiscoveryDescriptor,
  type MindDiscoveryFailureCode,
  type MindDiscoveryRevisionDescriptor,
  type MindDiscoveryStore,
  type MindRevisionSelector,
} from "./mind-discovery.js";

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;
export const MAX_SEARCH_QUERY_CHARACTERS = 1_024;

const SEARCH_CURSOR_PATH_PREFIX = "search/";
const MAX_CURSOR_CHARACTERS = 8 * 1_024;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/u;
const QUERY_TERM = /[\p{L}\p{N}_-]+/gu;

type AllowedAuthorization = Extract<AuthorizationDecision, { readonly kind: "allowed" }>;

export type SearchMatchedField =
  | "title"
  | "description"
  | "tags"
  | "headings"
  | "body";

export type MindSearchFailureCode =
  | MindDiscoveryFailureCode
  | "invalid_request"
  | "invalid_query"
  | "invalid_limit"
  | "invalid_cursor"
  | "search_index_unavailable"
  | "read_conflict"
  | "mind_binding_required"
  | "binding_owner_revoked"
  | "binding_state_unavailable";

/** Safe exact-revision search failure; it never carries query or indexed text. */
export class MindSearchFailure extends Error {
  readonly code: MindSearchFailureCode;
  readonly retryable: boolean;

  constructor(code: MindSearchFailureCode, message: string, retryable = false) {
    super(message);
    this.name = "MindSearchFailure";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface SearchEntriesQuery {
  readonly mind: unknown;
  readonly revisionSelector?: unknown;
  readonly query: unknown;
  readonly cursor?: unknown;
  readonly limit?: unknown;
}

export interface MindSearchResultEntry {
  readonly entry: Readonly<MindEntrySummary>;
  /** Ranking signal only inside this exact query response; never a trust signal. */
  readonly score: number;
  readonly snippet: string;
  readonly matchedFields: readonly SearchMatchedField[];
}

export interface SearchEntriesResult {
  readonly mind: Readonly<MindDiscoveryDescriptor>;
  readonly resolvedRevision: Readonly<MindDiscoveryRevisionDescriptor>;
  readonly results: readonly Readonly<MindSearchResultEntry>[];
  readonly nextCursor: string | null;
  readonly indexStatus: "ready";
}

export interface ReadyExactRevisionIndexReader {
  read(spaceId: SpaceId, revisionId: RevisionId): Promise<ReadExactRevisionIndexResult>;
  query?(
    spaceId: SpaceId,
    revisionId: RevisionId,
    normalizedTerms: readonly string[],
  ): Promise<QueryExactRevisionIndexResult>;
}

export interface MindSearchDependencies {
  readonly store: MindDiscoveryStore;
  /**
   * Production composition should pass the ready-state gate. A raw SearchIndex
   * is accepted for deterministic adapter fixtures and still has no HEAD API.
   */
  readonly index: ReadyExactRevisionIndexReader | SearchIndex;
  readonly host: VerifiedSpaceHost;
  readonly locators: MindLocatorCodec;
  readonly authorizer?: Authorizer;
}

interface NormalizedSearchQuery {
  readonly mind: unknown;
  readonly revisionSelector: unknown;
  readonly hasRevisionSelector: boolean;
  readonly query: string;
  readonly terms: readonly string[];
  readonly cursor: string | null;
  readonly limit: number;
}

interface SearchableDocument {
  readonly entry: Readonly<MindEntrySummary>;
  readonly fields: Readonly<Record<SearchMatchedField, readonly string[]>>;
}

interface RankedDocument {
  readonly document: Readonly<SearchableDocument>;
  readonly score: number;
  readonly snippet: string;
  readonly matchedFields: readonly SearchMatchedField[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeLexicalText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function normalizeSearchQuery(value: unknown): Readonly<NormalizedSearchQuery> {
  if (!isRecord(value)) {
    throw new MindSearchFailure("invalid_request", "Search request is invalid.");
  }
  const allowed = new Set(["mind", "revisionSelector", "query", "cursor", "limit"]);
  if (
    !Object.keys(value).every((key) => allowed.has(key)) ||
    !("mind" in value) ||
    !("query" in value)
  ) {
    throw new MindSearchFailure("invalid_request", "Search request is invalid.");
  }
  if (
    typeof value.query !== "string" ||
    value.query.length > MAX_SEARCH_QUERY_CHARACTERS ||
    CONTROL_CHARACTER.test(value.query)
  ) {
    throw new MindSearchFailure("invalid_query", "Search query is invalid.");
  }
  const query = value.query.trim();
  const terms = [...new Set(normalizeLexicalText(query).match(QUERY_TERM) ?? [])];
  if (query.length === 0 || terms.length === 0) {
    throw new MindSearchFailure("invalid_query", "Search query is invalid.");
  }
  const limit = value.limit ?? DEFAULT_SEARCH_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > MAX_SEARCH_LIMIT
  ) {
    throw new MindSearchFailure("invalid_limit", "Search limit is invalid.");
  }
  let cursor: string | null = null;
  if (value.cursor !== undefined) {
    if (
      typeof value.cursor !== "string" ||
      value.cursor.length === 0 ||
      value.cursor.length > MAX_CURSOR_CHARACTERS
    ) {
      throw new MindSearchFailure("invalid_cursor", "Search cursor is invalid.");
    }
    cursor = value.cursor;
  }
  return Object.freeze({
    mind: value.mind,
    revisionSelector: value.revisionSelector,
    hasRevisionSelector: Object.hasOwn(value, "revisionSelector"),
    query,
    terms: Object.freeze(terms),
    cursor,
    limit: limit as number,
  });
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

async function sha256(value: Uint8Array | string): Promise<Sha256Digest> {
  const source = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}` as Sha256Digest;
}

function displayTitle(
  path: string,
  frontmatter: Readonly<Record<string, unknown>> | null,
): string {
  if (frontmatter !== null && typeof frontmatter.title === "string") {
    const title = frontmatter.title.trim();
    if (title.length > 0) return title;
  }
  const name = path.split("/").at(-1) ?? path;
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

function description(
  frontmatter: Readonly<Record<string, unknown>> | null,
): string | null {
  if (frontmatter === null || typeof frontmatter.description !== "string") return null;
  const value = frontmatter.description.trim();
  return value.length === 0 ? null : value;
}

function tags(frontmatter: Readonly<Record<string, unknown>> | null): readonly string[] {
  if (
    frontmatter === null ||
    !Array.isArray(frontmatter.tags) ||
    !frontmatter.tags.every((tag) => typeof tag === "string")
  ) {
    return Object.freeze([]);
  }
  return Object.freeze(frontmatter.tags.map((tag) => tag as string));
}

function bodyFor(file: Readonly<ParsedOkfFile>): string {
  return file.kind === "log" ? file.sourceText : file.body;
}

function splitMarkdownFields(body: string): Readonly<{
  headings: readonly string[];
  body: string;
}> {
  const headings: string[] = [];
  const bodyLines: string[] = [];
  for (const line of body.split(/\r?\n/u)) {
    const match = HEADING.exec(line);
    if (match?.[1] !== undefined) headings.push(match[1].trim());
    else bodyLines.push(line);
  }
  return Object.freeze({
    headings: Object.freeze(headings),
    body: bodyLines.join("\n"),
  });
}

function countOccurrences(value: string, term: string): number {
  let count = 0;
  let offset = 0;
  while (count < 20) {
    const found = value.indexOf(term, offset);
    if (found === -1) break;
    count += 1;
    offset = found + Math.max(1, term.length);
  }
  return count;
}

const FIELD_ORDER = Object.freeze([
  "title",
  "description",
  "tags",
  "headings",
  "body",
] as const satisfies readonly SearchMatchedField[]);

const FIELD_WEIGHT: Readonly<Record<SearchMatchedField, number>> = Object.freeze({
  title: 8,
  description: 4,
  tags: 6,
  headings: 5,
  body: 1,
});

function snippet(values: readonly string[], terms: readonly string[]): string {
  const compact = values.join(" ").replace(/\s+/gu, " ").trim();
  if (compact.length <= 240) return compact;
  const normalized = normalizeLexicalText(compact);
  const positions = terms
    .map((term) => normalized.indexOf(term))
    .filter((position) => position >= 0);
  const first = positions.length === 0 ? 0 : Math.min(...positions);
  const start = Math.max(0, first - 80);
  const end = Math.min(compact.length, start + 220);
  return `${start > 0 ? "…" : ""}${compact.slice(start, end).trim()}${
    end < compact.length ? "…" : ""
  }`;
}

function rankDocument(
  document: Readonly<SearchableDocument>,
  terms: readonly string[],
): Readonly<RankedDocument> | null {
  const normalizedFields: Readonly<Record<SearchMatchedField, readonly string[]>> =
    Object.freeze({
      title: document.fields.title.map(normalizeLexicalText),
      description: document.fields.description.map(normalizeLexicalText),
      tags: document.fields.tags.map(normalizeLexicalText),
      headings: document.fields.headings.map(normalizeLexicalText),
      body: document.fields.body.map(normalizeLexicalText),
    });
  if (
    terms.some(
      (term) =>
        !FIELD_ORDER.some((field) =>
          normalizedFields[field].some((value) => value.includes(term)),
        ),
    )
  ) {
    return null;
  }
  const matchedFields = FIELD_ORDER.filter((field) =>
    normalizedFields[field].some((value) => terms.some((term) => value.includes(term))),
  );
  let weighted = 0;
  for (const field of matchedFields) {
    for (const value of normalizedFields[field]) {
      for (const term of terms) {
        weighted += FIELD_WEIGHT[field] * countOccurrences(value, term);
      }
    }
  }
  const preferredSnippetField = [...matchedFields].sort(
    (left, right) => FIELD_WEIGHT[right] - FIELD_WEIGHT[left],
  )[0]!;
  return Object.freeze({
    document,
    score: Number((weighted / (weighted + 12)).toFixed(6)),
    snippet: snippet(document.fields[preferredSnippetField], terms),
    matchedFields: Object.freeze(matchedFields),
  });
}

function mapDiscoveryFailure(error: unknown): never {
  if (error instanceof MindDiscoveryFailure) {
    throw new MindSearchFailure(error.code, error.message);
  }
  throw error;
}

/** Lexical search over one authorized, exact, immutable revision snapshot. */
export class MindSearchService {
  readonly #store: MindDiscoveryStore;
  readonly #index: ReadyExactRevisionIndexReader | SearchIndex;
  readonly #locators: MindLocatorCodec;
  readonly #discovery: MindDiscoveryService;
  readonly #authorizer: Authorizer;

  constructor(dependencies: MindSearchDependencies) {
    this.#store = dependencies.store;
    this.#index = dependencies.index;
    this.#locators = dependencies.locators;
    this.#discovery = new MindDiscoveryService({
      store: dependencies.store,
      host: dependencies.host,
    });
    this.#authorizer =
      dependencies.authorizer ?? new CapabilityAuthorizer(dependencies.store);
  }

  async searchEntries(
    actor: ActorContext,
    queryValue: unknown,
  ): Promise<Readonly<SearchEntriesResult>> {
    const request = normalizeSearchQuery(queryValue);
    const queryHash = await sha256(request.terms.join("\u001f"));
    const searchCursorPath = `${SEARCH_CURSOR_PATH_PREFIX}${queryHash.slice(7)}`;
    let cursor: Readonly<BrowseCursorLocatorPayload> | null = null;
    if (request.cursor !== null) {
      const decoded = await this.#locators.decode(request.cursor);
      if (
        decoded === null ||
        decoded.kind !== "browse" ||
        decoded.path !== searchCursorPath
      ) {
        throw new MindSearchFailure("invalid_cursor", "Search cursor is invalid.");
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
        throw new MindSearchFailure("invalid_cursor", "Search cursor is invalid.");
      }
      mapDiscoveryFailure(error);
    }
    if (
      cursor !== null &&
      (cursor.spaceId !== info.mind.mindId ||
        cursor.revisionId !== info.resolvedRevision.revisionId)
    ) {
      throw new MindSearchFailure("invalid_cursor", "Search cursor is invalid.");
    }
    const initialAuthorization = await this.#requireAuthorization(
      actor,
      info.mind.mindId,
      info.revisionMode,
    );
    const documents = await this.#loadVerifiedDocuments(
      info.mind.mindId,
      info.resolvedRevision,
      request.terms,
    );
    const ranked = documents
      .map((document) => rankDocument(document, request.terms))
      .filter((candidate): candidate is Readonly<RankedDocument> => candidate !== null)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.document.entry.path.localeCompare(right.document.entry.path, "en"),
      );
    const resultFingerprint = await sha256(
      JSON.stringify({
        query: queryHash,
        revision: info.resolvedRevision.revisionId,
        results: ranked.map((candidate) => [
          candidate.document.entry.path,
          candidate.document.entry.sha256,
          candidate.score,
        ]),
      }),
    );
    const offset = cursor?.start ?? 0;
    if (
      cursor !== null &&
      (cursor.manifestHash !== resultFingerprint ||
        cursor.end !== ranked.length ||
        offset >= ranked.length)
    ) {
      throw new MindSearchFailure("invalid_cursor", "Search cursor is invalid.");
    }
    const page = ranked.slice(offset, offset + request.limit);
    const nextOffset = offset + page.length;
    const nextCursor =
      nextOffset < ranked.length
        ? await this.#locators.encode(
            Object.freeze({
              version: 1,
              kind: "browse",
              spaceId: info.mind.mindId,
              revisionId: info.resolvedRevision.revisionId,
              path: searchCursorPath,
              manifestHash: resultFingerprint,
              start: nextOffset,
              end: ranked.length,
            }),
          )
        : null;
    await this.#requireSameAuthorization(
      actor,
      info.mind.mindId,
      info.revisionMode,
      initialAuthorization,
    );
    return Object.freeze({
      mind: info.mind,
      resolvedRevision: info.resolvedRevision,
      results: Object.freeze(
        page.map((candidate) =>
          Object.freeze({
            entry: candidate.document.entry,
            score: candidate.score,
            snippet: candidate.snippet,
            matchedFields: candidate.matchedFields,
          }),
        ),
      ),
      nextCursor,
      indexStatus: "ready",
    });
  }

  async #readIndex(
    spaceId: SpaceId,
    revisionId: RevisionId,
    normalizedTerms: readonly string[],
  ): Promise<QueryExactRevisionIndexResult> {
    try {
      if ("query" in this.#index && typeof this.#index.query === "function") {
        return await this.#index.query(spaceId, revisionId, normalizedTerms);
      }
      if (
        "queryExactRevision" in this.#index &&
        typeof this.#index.queryExactRevision === "function"
      ) {
        return await this.#index.queryExactRevision(
          spaceId,
          revisionId,
          normalizedTerms,
        );
      }
      if ("read" in this.#index && typeof this.#index.read === "function") {
        const indexed = await this.#index.read(spaceId, revisionId);
        return indexed.kind === "ready"
          ? Object.freeze({ ...indexed, totalDocuments: indexed.documents.length })
          : indexed;
      }
      const indexed = await (this.#index as SearchIndex).readExactRevision(
        spaceId,
        revisionId,
      );
      return indexed.kind === "ready"
        ? Object.freeze({ ...indexed, totalDocuments: indexed.documents.length })
        : indexed;
    } catch {
      return Object.freeze({ kind: "unavailable" });
    }
  }

  async #loadVerifiedDocuments(
    spaceId: SpaceId,
    resolvedRevision: Readonly<MindDiscoveryRevisionDescriptor>,
    normalizedTerms: readonly string[],
  ): Promise<readonly Readonly<SearchableDocument>[]> {
    const envelope = await this.#store.readRevision(spaceId, resolvedRevision.revisionId);
    if (
      envelope === null ||
      envelope.revision.spaceId !== spaceId ||
      envelope.revision.revisionId !== resolvedRevision.revisionId ||
      envelope.revision.manifestHash !== resolvedRevision.manifestHash
    ) {
      throw this.#unavailable();
    }
    const indexed = await this.#readIndex(
      spaceId,
      resolvedRevision.revisionId,
      normalizedTerms,
    );
    if (
      indexed.kind !== "ready" ||
      indexed.spaceId !== spaceId ||
      indexed.revisionId !== resolvedRevision.revisionId ||
      indexed.totalDocuments !== envelope.manifest.entries.length
    ) {
      throw this.#unavailable();
    }
    const entries = new Map(
      envelope.manifest.entries.map((entry) => [entry.path, entry] as const),
    );
    const seen = new Set<string>();
    const documents: SearchableDocument[] = [];
    for (const document of indexed.documents) {
      const entry = entries.get(document.path);
      if (
        entry === undefined ||
        seen.has(document.path) ||
        typeof document.text !== "string"
      ) {
        throw this.#unavailable();
      }
      seen.add(document.path);
      documents.push(
        await this.#searchableDocument(
          spaceId,
          resolvedRevision.revisionId,
          document.path,
          document.text,
          entry,
        ),
      );
    }
    return Object.freeze(documents);
  }

  async #searchableDocument(
    spaceId: SpaceId,
    revisionId: RevisionId,
    path: string,
    text: string,
    entry: Readonly<RevisionManifestEntry>,
  ): Promise<Readonly<SearchableDocument>> {
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength !== entry.size || (await sha256(bytes)) !== entry.sha256) {
      throw this.#unavailable();
    }
    const parsed = parseOkfFile({ path, bytes });
    if (!parsed.valid || parsed.file === null) throw this.#unavailable();
    const frontmatter =
      parsed.file.kind === "concept" || parsed.file.kind === "index"
        ? parsed.file.frontmatter
        : null;
    const title = displayTitle(path, frontmatter);
    const entryDescription = description(frontmatter);
    const entryTags = tags(frontmatter);
    const markdown = splitMarkdownFields(bodyFor(parsed.file));
    const entrySummary: MindEntrySummary = Object.freeze({
      entryId: await this.#locators.encode(
        Object.freeze({
          version: 1,
          kind: "entry",
          spaceId,
          revisionId,
          path,
          sha256: entry.sha256,
          start: 0,
          end: entry.size,
        }),
      ),
      resourceUri: exactRevisionResourceUri(spaceId, revisionId, path),
      path,
      kind: okfFileKind(path),
      title,
      description: entryDescription,
      tags: entryTags,
      mimeType: MARKDOWN_MEDIA_TYPE,
      revisionId,
      sha256: entry.sha256,
      size: entry.size,
      okfType: parsed.file.kind === "concept" ? parsed.file.okfType : null,
    });
    return Object.freeze({
      entry: entrySummary,
      fields: Object.freeze({
        title: Object.freeze([title]),
        description: Object.freeze(entryDescription === null ? [] : [entryDescription]),
        tags: entryTags,
        headings: markdown.headings,
        body: Object.freeze([markdown.body]),
      }),
    });
  }

  #unavailable(): MindSearchFailure {
    return new MindSearchFailure(
      "search_index_unavailable",
      "The exact revision search index is unavailable.",
      true,
    );
  }

  async #requireAuthorization(
    actor: ActorContext,
    spaceId: SpaceId,
    revisionMode: RevisionMode,
  ): Promise<AllowedAuthorization> {
    const decision = await this.#authorizer.authorize({
      actor,
      spaceId,
      capability: "content:search",
      revisionMode,
    });
    if (decision.kind === "denied") {
      if (
        decision.code === "mind_binding_required" ||
        decision.code === "binding_owner_revoked" ||
        decision.code === "binding_state_unavailable"
      ) {
        throw new MindSearchFailure(
          decision.code,
          "The current MCP credential cannot use this Mind binding.",
          decision.retryable,
        );
      }
      throw new MindSearchFailure("mind_not_found", "Mind was not found.");
    }
    return decision;
  }

  async #requireSameAuthorization(
    actor: ActorContext,
    spaceId: SpaceId,
    revisionMode: RevisionMode,
    expected: AllowedAuthorization,
  ): Promise<void> {
    const decision = await this.#authorizer.authorize({
      actor,
      spaceId,
      capability: "content:search",
      revisionMode,
    });
    if (decision.kind === "denied") {
      if (decision.code === "authorization_state_changed") {
        throw new MindSearchFailure(
          "read_conflict",
          "Mind binding changed during the search; retry from a fresh descriptor.",
          true,
        );
      }
      if (
        decision.code === "mind_binding_required" ||
        decision.code === "binding_owner_revoked" ||
        decision.code === "binding_state_unavailable"
      ) {
        throw new MindSearchFailure(
          decision.code,
          "The current MCP credential cannot use this Mind binding.",
          decision.retryable,
        );
      }
      throw new MindSearchFailure("mind_not_found", "Mind was not found.");
    }
    if (!sameAuthorization(expected, decision)) {
      throw new MindSearchFailure(
        "read_conflict",
        "Mind access changed during the search; retry from a fresh descriptor.",
        true,
      );
    }
  }
}
