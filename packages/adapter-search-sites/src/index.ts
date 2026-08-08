import type {
  ExactRevisionIndexDocument,
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
]);

interface SearchRow {
  readonly documents_json: string;
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
             (version, name, applied_at) VALUES (1, 'exact-revision-json-v1', ?1)`,
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
    await this.#database
      .prepare(
        `/*md-search-replace*/ INSERT INTO md_exact_revision_search
         (space_id, revision_id, documents_json) VALUES (?1, ?2, ?3)
         ON CONFLICT(space_id, revision_id)
         DO UPDATE SET documents_json = excluded.documents_json`,
      )
      .bind(request.spaceId, request.revisionId, JSON.stringify(documents))
      .run();
  }

  async readExactRevision(
    spaceId: ReplaceExactRevisionIndexRequest["spaceId"],
    revisionId: ReplaceExactRevisionIndexRequest["revisionId"],
  ): Promise<ReadExactRevisionIndexResult> {
    await this.ready();
    validateIdentity(spaceId, "space_id");
    validateIdentity(revisionId, "revision_id");
    const result = await this.#database
      .prepare(
        `/*md-search-read*/ SELECT documents_json FROM md_exact_revision_search
         WHERE space_id = ?1 AND revision_id = ?2`,
      )
      .bind(spaceId, revisionId)
      .all<SearchRow>();
    const row = result.results?.[0];
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
    return Object.freeze({
      kind: "ready",
      spaceId,
      revisionId,
      documents: cloneDocuments(parsed as ExactRevisionIndexDocument[]),
    });
  }

  async purgeSpace(spaceId: ReplaceExactRevisionIndexRequest["spaceId"]): Promise<number> {
    await this.ready();
    validateIdentity(spaceId, "space_id");
    const result = await this.#database
      .prepare(
        `/*md-search-purge*/ DELETE FROM md_exact_revision_search WHERE space_id = ?1`,
      )
      .bind(spaceId)
      .run();
    return Number(result.meta?.changes ?? 0);
  }
}

export async function createSitesSearchIndex(
  database: D1DatabaseLike,
): Promise<SitesExactRevisionSearchIndex> {
  return new SitesExactRevisionSearchIndex(database).ready();
}
