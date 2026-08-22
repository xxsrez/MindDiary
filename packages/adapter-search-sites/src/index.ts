import type {
  ExactRevisionIndexDocument,
  QueryExactRevisionIndexResult,
  ReadExactRevisionIndexResult,
  ReplaceExactRevisionIndexRequest,
  SearchIndex,
} from "@mind-diary/application-ports";

export const SITES_SEARCH_ADAPTER = "sites-d1-exact-revision" as const;

export interface D1ResultLike<Row = Record<string, unknown>> {
  readonly results?: readonly Row[];
  readonly meta?: { readonly changes?: number };
}

export interface D1PreparedStatementLike {
  bind(...values: readonly unknown[]): D1PreparedStatementLike;
  run<Row = Record<string, unknown>>(): Promise<D1ResultLike<Row>>;
  all<Row = Record<string, unknown>>(): Promise<D1ResultLike<Row>>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch(statements: readonly D1PreparedStatementLike[]): Promise<readonly D1ResultLike[]>;
}

export const SITES_SEARCH_MIGRATIONS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS md_search_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS md_exact_revision_search (
    space_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    documents_json TEXT NOT NULL,
    PRIMARY KEY (space_id, revision_id)
  )`,
  `CREATE TABLE IF NOT EXISTS md_search_documents (
    space_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    text TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    PRIMARY KEY (space_id, digest)
  )`,
  `CREATE TABLE IF NOT EXISTS md_search_revision_documents (
    space_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    path TEXT NOT NULL,
    digest TEXT NOT NULL,
    PRIMARY KEY (space_id, revision_id, path)
  )`,
  `CREATE INDEX IF NOT EXISTS md_search_revision_order
    ON md_search_revision_documents(space_id, revision_id, ordinal)`,
  `CREATE TABLE IF NOT EXISTS md_search_document_lexical (
    space_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    normalized_text TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    PRIMARY KEY (space_id, digest)
  )`,
]);

interface SearchRow {
  readonly documents_json: string;
}

interface NormalizedSearchRow {
  readonly path: string;
  readonly text: string;
}

interface SearchStorageMetricsRow {
  readonly document_count: number;
  readonly document_bytes: number;
  readonly lexical_bytes: number;
  readonly membership_count: number;
}

interface SearchRevisionCountRow {
  readonly revision_count: number;
}

interface SearchProjectionCountRow {
  readonly membership_count: number;
  readonly indexed_count: number;
}

function validateIdentity(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
}

function cloneDocuments(
  documents: readonly Readonly<ExactRevisionIndexDocument>[],
): readonly Readonly<ExactRevisionIndexDocument>[] {
  const paths = new Set<string>();
  return Object.freeze(
    documents.map((document) => {
      if (
        typeof document.path !== "string" ||
        document.path.length < 1 ||
        typeof document.text !== "string" ||
        paths.has(document.path)
      ) {
        throw new TypeError("exact revision search documents are invalid");
      }
      paths.add(document.path);
      return Object.freeze({ path: document.path, text: document.text });
    }),
  );
}

async function digestText(text: string): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return `sha256:${[...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function normalizedLexicalText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("en-US");
}

function chunks<Value>(values: readonly Value[], size: number): readonly (readonly Value[])[] {
  const result: Value[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function placeholders(rows: number, columns: number): string {
  let parameter = 1;
  return Array.from({ length: rows }, () =>
    `(${Array.from({ length: columns }, () => `?${parameter++}`).join(", ")})`
  ).join(", ");
}

/** D1 derived projection keyed only by exact Space + immutable revision. */
export class SitesExactRevisionSearchIndex implements SearchIndex {
  readonly kind = "search-index" as const;
  readonly #database: D1DatabaseLike;
  #initialized = false;

  constructor(database: D1DatabaseLike) {
    this.#database = database;
  }

  async ready(): Promise<this> {
    if (!this.#initialized) {
      const statements = SITES_SEARCH_MIGRATIONS.map((sql) => this.#database.prepare(sql));
      statements.push(
        this.#database
          .prepare(
            `/*md-search-migration*/ INSERT OR IGNORE INTO md_search_schema_migrations
             (version, name, applied_at) VALUES (3, 'query-lexical-v3', ?1)`,
          )
          .bind(new Date().toISOString()),
      );
      await this.#database.batch(statements);
      this.#initialized = true;
    }
    return this;
  }

  async replaceExactRevision(request: ReplaceExactRevisionIndexRequest): Promise<void> {
    await this.ready();
    validateIdentity(request.spaceId, "space_id");
    validateIdentity(request.revisionId, "revision_id");
    const documents = cloneDocuments(request.documents);
    const normalized = await Promise.all(
      documents.map(async (document, ordinal) => Object.freeze({
        ...document,
        ordinal,
        digest: await digestText(document.text),
        byteSize: new TextEncoder().encode(document.text).byteLength,
        normalizedText: normalizedLexicalText(document.text),
      })),
    );
    const statements = [
      this.#database
        .prepare(
          `/*md-search-membership-delete*/ DELETE FROM md_search_revision_documents
           WHERE space_id = ?1 AND revision_id = ?2`,
        )
        .bind(request.spaceId, request.revisionId),
      ...chunks(normalized, 25).map((batch) =>
        this.#database
          .prepare(
            `/*md-search-document-upsert*/ INSERT INTO md_search_documents
             (space_id, digest, text, byte_size) VALUES ${placeholders(batch.length, 4)}
             ON CONFLICT(space_id, digest) DO NOTHING`,
          )
          .bind(...batch.flatMap((document) => [
            request.spaceId,
            document.digest,
            document.text,
            document.byteSize,
          ]))),
      ...chunks(normalized, 25).map((batch) =>
        this.#database
          .prepare(
            `/*md-search-lexical-upsert*/ INSERT INTO md_search_document_lexical
             (space_id, digest, normalized_text, byte_size) VALUES ${placeholders(batch.length, 4)}
             ON CONFLICT(space_id, digest) DO NOTHING`,
          )
          .bind(...batch.flatMap((document) => [
            request.spaceId,
            document.digest,
            document.normalizedText,
            new TextEncoder().encode(document.normalizedText).byteLength,
          ]))),
      ...chunks(normalized, 20).map((batch) =>
        this.#database
          .prepare(
            `/*md-search-membership-insert*/ INSERT INTO md_search_revision_documents
             (space_id, revision_id, ordinal, path, digest)
             VALUES ${placeholders(batch.length, 5)}`,
          )
          .bind(...batch.flatMap((document) => [
            request.spaceId,
            request.revisionId,
            document.ordinal,
            document.path,
            document.digest,
          ]))),
      this.#database
        .prepare(
          `/*md-search-legacy-delete*/ DELETE FROM md_exact_revision_search
           WHERE space_id = ?1 AND revision_id = ?2`,
        )
        .bind(request.spaceId, request.revisionId),
      this.#database
        .prepare(
          `/*md-search-orphan-document-cleanup*/ DELETE FROM md_search_documents
           WHERE space_id = ?1 AND NOT EXISTS (
             SELECT 1 FROM md_search_revision_documents AS membership
             WHERE membership.space_id = md_search_documents.space_id
               AND membership.digest = md_search_documents.digest
           )`,
        )
        .bind(request.spaceId),
      this.#database
        .prepare(
          `/*md-search-orphan-lexical-cleanup*/ DELETE FROM md_search_document_lexical
           WHERE space_id = ?1 AND NOT EXISTS (
             SELECT 1 FROM md_search_revision_documents AS membership
             WHERE membership.space_id = md_search_document_lexical.space_id
               AND membership.digest = md_search_document_lexical.digest
           )`,
        )
        .bind(request.spaceId),
    ];
    await this.#database.batch(statements);
  }

  async readExactRevision(
    spaceId: ReplaceExactRevisionIndexRequest["spaceId"],
    revisionId: ReplaceExactRevisionIndexRequest["revisionId"],
  ): Promise<ReadExactRevisionIndexResult> {
    await this.ready();
    validateIdentity(spaceId, "space_id");
    validateIdentity(revisionId, "revision_id");
    const normalized = await this.#database
      .prepare(
        `/*md-search-read-normalized*/ SELECT membership.path, document.text
         FROM md_search_revision_documents AS membership
         JOIN md_search_documents AS document
           ON document.space_id = membership.space_id
          AND document.digest = membership.digest
         WHERE membership.space_id = ?1 AND membership.revision_id = ?2
         ORDER BY membership.ordinal ASC`,
      )
      .bind(spaceId, revisionId)
      .all<NormalizedSearchRow>();
    if ((normalized.results?.length ?? 0) > 0) {
      return Object.freeze({
        kind: "ready",
        spaceId,
        revisionId,
        documents: cloneDocuments(normalized.results as ExactRevisionIndexDocument[]),
      });
    }
    const legacy = await this.#database
      .prepare(
        `/*md-search-read-legacy*/ SELECT documents_json FROM md_exact_revision_search
         WHERE space_id = ?1 AND revision_id = ?2`,
      )
      .bind(spaceId, revisionId)
      .all<SearchRow>();
    const row = legacy.results?.[0];
    if (!row) return Object.freeze({ kind: "unavailable" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.documents_json);
    } catch {
      throw new Error("Sites exact revision search state is corrupt");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("Sites exact revision search state is corrupt");
    }
    const documents = cloneDocuments(parsed as ExactRevisionIndexDocument[]);
    await this.replaceExactRevision({ spaceId, revisionId, documents });
    return Object.freeze({
      kind: "ready",
      spaceId,
      revisionId,
      documents,
    });
  }

  async queryExactRevision(
    spaceId: ReplaceExactRevisionIndexRequest["spaceId"],
    revisionId: ReplaceExactRevisionIndexRequest["revisionId"],
    normalizedTerms: readonly string[],
  ): Promise<QueryExactRevisionIndexResult> {
    await this.ready();
    validateIdentity(spaceId, "space_id");
    validateIdentity(revisionId, "revision_id");
    if (
      !Array.isArray(normalizedTerms) ||
      normalizedTerms.length < 1 ||
      normalizedTerms.length > 128 ||
      normalizedTerms.some((term) =>
        typeof term !== "string" ||
        term.length < 1 ||
        term.length > 1_024 ||
        /[\u0000-\u001f\u007f]/u.test(term) ||
        normalizedLexicalText(term) !== term)
    ) {
      throw new TypeError("exact revision search terms are invalid");
    }
    const counts = await this.#database
      .prepare(
        `/*md-search-projection-count*/ SELECT
           (SELECT COUNT(*) FROM md_search_revision_documents
             WHERE space_id = ?1 AND revision_id = ?2) AS membership_count,
           (SELECT COUNT(*)
              FROM md_search_revision_documents AS membership
              JOIN md_search_documents AS document
                ON document.space_id = membership.space_id
               AND document.digest = membership.digest
              JOIN md_search_document_lexical AS lexical
                ON lexical.space_id = membership.space_id
               AND lexical.digest = membership.digest
             WHERE membership.space_id = ?1 AND membership.revision_id = ?2)
             AS indexed_count`,
      )
      .bind(spaceId, revisionId)
      .all<SearchProjectionCountRow>();
    const membershipCount = Number(counts.results?.[0]?.membership_count ?? 0);
    const indexedCount = Number(counts.results?.[0]?.indexed_count ?? 0);
    if (membershipCount === 0 || indexedCount !== membershipCount) {
      const legacy = await this.readExactRevision(spaceId, revisionId);
      if (legacy.kind !== "ready") return legacy;
      await this.replaceExactRevision({
        spaceId,
        revisionId,
        documents: legacy.documents,
      });
      return this.queryExactRevision(spaceId, revisionId, normalizedTerms);
    }
    const storageTerms = normalizedTerms.slice(0, 98);
    const predicates = storageTerms.map(
      (_term, index) => `instr(lexical.normalized_text, ?${index + 3}) > 0`,
    );
    const matches = await this.#database
      .prepare(
        `/*md-search-query-normalized*/ SELECT membership.path, document.text
         FROM md_search_revision_documents AS membership
         JOIN md_search_documents AS document
           ON document.space_id = membership.space_id
          AND document.digest = membership.digest
         JOIN md_search_document_lexical AS lexical
           ON lexical.space_id = membership.space_id
          AND lexical.digest = membership.digest
         WHERE membership.space_id = ?1 AND membership.revision_id = ?2
           AND ${predicates.join(" AND ")}
         ORDER BY membership.ordinal ASC`,
      )
      .bind(
        spaceId,
        revisionId,
        ...storageTerms,
      )
      .all<NormalizedSearchRow>();
    return Object.freeze({
      kind: "ready",
      spaceId,
      revisionId,
      totalDocuments: membershipCount,
      documents: cloneDocuments(matches.results ?? []),
    });
  }

  async purgeSpace(spaceId: ReplaceExactRevisionIndexRequest["spaceId"]): Promise<number> {
    await this.ready();
    validateIdentity(spaceId, "space_id");
    const count = await this.#database
      .prepare(
        `/*md-search-count-revisions*/ SELECT COUNT(DISTINCT revision_id) AS revision_count
         FROM md_search_revision_documents WHERE space_id = ?1`,
      )
      .bind(spaceId)
      .all<SearchRevisionCountRow>();
    const results = await this.#database.batch([
      this.#database
        .prepare(
          `/*md-search-purge-memberships*/ DELETE FROM md_search_revision_documents
           WHERE space_id = ?1`,
        )
        .bind(spaceId),
      this.#database
        .prepare(
          `/*md-search-purge-documents*/ DELETE FROM md_search_documents
           WHERE space_id = ?1`,
        )
        .bind(spaceId),
      this.#database
        .prepare(
          `/*md-search-purge-lexical*/ DELETE FROM md_search_document_lexical
           WHERE space_id = ?1`,
        )
        .bind(spaceId),
      this.#database
        .prepare(
          `/*md-search-purge-legacy*/ DELETE FROM md_exact_revision_search
           WHERE space_id = ?1`,
        )
        .bind(spaceId),
    ]);
    return Number(count.results?.[0]?.revision_count ?? 0) +
      Number(results[3]?.meta?.changes ?? 0);
  }

  /** Privacy-safe capacity evidence: counts and UTF-8 bytes only. */
  async readStorageMetricsForTest(spaceId: string) {
    await this.ready();
    validateIdentity(spaceId, "space_id");
    const result = await this.#database
      .prepare(
        `/*md-search-storage-metrics*/ SELECT
           (SELECT COUNT(*) FROM md_search_documents WHERE space_id = ?1)
             AS document_count,
           (SELECT COALESCE(SUM(byte_size), 0) FROM md_search_documents
             WHERE space_id = ?1) AS document_bytes,
           (SELECT COALESCE(SUM(byte_size), 0) FROM md_search_document_lexical
             WHERE space_id = ?1) AS lexical_bytes,
           (SELECT COUNT(*) FROM md_search_revision_documents WHERE space_id = ?1)
             AS membership_count`,
      )
      .bind(spaceId)
      .all<SearchStorageMetricsRow>();
    const row = result.results?.[0];
    return Object.freeze({
      documentCount: Number(row?.document_count ?? 0),
      documentBytes: Number(row?.document_bytes ?? 0),
      lexicalBytes: Number(row?.lexical_bytes ?? 0),
      membershipCount: Number(row?.membership_count ?? 0),
    });
  }
}

export async function createSitesSearchIndex(
  database: D1DatabaseLike,
): Promise<SitesExactRevisionSearchIndex> {
  return new SitesExactRevisionSearchIndex(database).ready();
}
