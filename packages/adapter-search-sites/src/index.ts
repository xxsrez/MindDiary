import type {
  ExactRevisionIndexDocument,
  ExactRevisionIndexEntry,
  QueryExactRevisionIndexResult,
  ReadExactRevisionIndexResult,
  ReplaceExactRevisionIndexRequest,
  SearchIndex,
} from "@mind-diary/application-ports";

export const SITES_SEARCH_ADAPTER = "sites-d1-exact-revision" as const;
const SITES_SEARCH_SCHEMA_VERSION = 6;
const SITES_SEARCH_SCHEMA_OBJECTS = Object.freeze([
  "md_search_schema_migrations",
  "md_exact_revision_search",
  "md_search_documents",
  "md_search_revision_documents",
  "md_search_revision_order",
  "md_search_document_digest_lookup",
  "md_search_document_lexical",
  "md_search_document_fields",
]);

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
  `CREATE INDEX IF NOT EXISTS md_search_document_digest_lookup
    ON md_search_documents(space_id, digest)`,
  `CREATE TABLE IF NOT EXISTS md_search_document_lexical (
    space_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    normalized_text TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    PRIMARY KEY (space_id, digest)
  )`,
  `CREATE TABLE IF NOT EXISTS md_search_document_fields (
    space_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    normalized_title TEXT NOT NULL,
    normalized_description TEXT NOT NULL,
    normalized_tags TEXT NOT NULL,
    normalized_headings TEXT NOT NULL,
    normalized_body TEXT NOT NULL,
    PRIMARY KEY (space_id, digest)
  )`,
  `ALTER TABLE md_search_revision_documents
    ADD COLUMN normalized_path_title TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE md_search_document_fields
    ADD COLUMN title_from_path INTEGER NOT NULL DEFAULT 0`,
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

interface SearchMatchCountRow {
  readonly total_matches: number;
}

interface SchemaProbeRow {
  readonly name?: string;
  readonly version?: number | string;
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
        (document.titleDerivedFromPath !== undefined &&
          typeof document.titleDerivedFromPath !== "boolean") ||
        paths.has(document.path)
      ) {
        throw new TypeError("exact revision search documents are invalid");
      }
      paths.add(document.path);
      return Object.freeze({
        path: document.path,
        text: document.text,
        ...(document.sha256 === undefined ? {} : { sha256: document.sha256 }),
        ...(document.titleDerivedFromPath === undefined
          ? {}
          : { titleDerivedFromPath: document.titleDerivedFromPath }),
        ...(document.fields === undefined ? {} : { fields: document.fields }),
      });
    }),
  );
}

function cloneEntries(
  entries: readonly Readonly<ExactRevisionIndexEntry>[],
): readonly Readonly<ExactRevisionIndexEntry>[] {
  const paths = new Set<string>();
  return Object.freeze(entries.map((entry) => {
    if (
      typeof entry.path !== "string" || entry.path.length < 1 ||
      typeof entry.sha256 !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(entry.sha256) || paths.has(entry.path)
    ) throw new TypeError("exact revision search entries are invalid");
    paths.add(entry.path);
    return Object.freeze({ path: entry.path, sha256: entry.sha256 });
  }));
}

async function digestText(
  text: string,
): Promise<ExactRevisionIndexEntry["sha256"]> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return `sha256:${[...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}` as ExactRevisionIndexEntry["sha256"];
}

function normalizedLexicalText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("en-US");
}

function normalizedPathTitle(path: string): string {
  return normalizedLexicalText((path.split("/").at(-1) ?? path).replace(/\.md$/u, ""));
}

function normalizedFields(document: Readonly<ExactRevisionIndexDocument>) {
  const fields = document.fields ?? Object.freeze({
    title: Object.freeze([]),
    description: Object.freeze([]),
    tags: Object.freeze([]),
    headings: Object.freeze([]),
    body: Object.freeze([document.text]),
  });
  for (const values of Object.values(fields)) {
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
      throw new TypeError("exact revision search field projection is invalid");
    }
  }
  const normalize = (values: readonly string[]) =>
    values.map(normalizedLexicalText).join("\n");
  return Object.freeze({
    title: normalize(fields.title),
    description: normalize(fields.description),
    tags: normalize(fields.tags),
    headings: normalize(fields.headings),
    body: normalize(fields.body),
    titleFromPath: document.titleDerivedFromPath === true,
  });
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
  #ready: Promise<void> | null = null;

  constructor(database: D1DatabaseLike) {
    this.#database = database;
  }

  async ready(): Promise<this> {
    this.#ready ??= this.#ensureReady().catch((error) => {
      this.#ready = null;
      throw error;
    });
    await this.#ready;
    return this;
  }

  async #ensureReady(): Promise<void> {
    try {
      const result = await this.#database
        .prepare(
          `/*md-search-schema-probe*/ SELECT name,
             (SELECT COALESCE(MAX(version), 0)
              FROM md_search_schema_migrations) AS version
           FROM sqlite_master
           WHERE type IN ('table', 'index')
             AND name IN ('md_search_schema_migrations',
                          'md_exact_revision_search',
                          'md_search_documents',
                          'md_search_revision_documents',
                          'md_search_revision_order',
                          'md_search_document_digest_lookup',
                          'md_search_document_lexical',
                          'md_search_document_fields')`,
        )
        .all<SchemaProbeRow>();
      const rows = result.results ?? [];
      const names = new Set(rows.map((row) => row.name));
      if (
        Number(rows[0]?.version ?? 0) >= SITES_SEARCH_SCHEMA_VERSION &&
        SITES_SEARCH_SCHEMA_OBJECTS.every((name) => names.has(name))
      ) {
        return;
      }
    } catch {
      // The migration table is absent or an older D1 adapter does not expose
      // the probe. Fall through to the idempotent schema batch below.
    }
    const statements = SITES_SEARCH_MIGRATIONS.map((sql) => this.#database.prepare(sql));
    statements.push(
      this.#database
        .prepare(
          `/*md-search-migration*/ INSERT OR IGNORE INTO md_search_schema_migrations
           (version, name, applied_at) VALUES (6, 'path-aware-bounded-search-v6', ?1)`,
        )
        .bind(new Date().toISOString()),
    );
    await this.#database.batch(statements);
  }

  async findMissingDigests(
    spaceId: ReplaceExactRevisionIndexRequest["spaceId"],
    digests: readonly ExactRevisionIndexEntry["sha256"][],
  ) {
    await this.ready();
    validateIdentity(spaceId, "space_id");
    const unique = [...new Set(digests)];
    if (unique.some((digest) => !/^sha256:[0-9a-f]{64}$/u.test(digest))) {
      throw new TypeError("exact revision search digests are invalid");
    }
    const present = new Set<ExactRevisionIndexEntry["sha256"]>();
    for (const batch of chunks(unique, 90)) {
      if (batch.length === 0) continue;
      const result = await this.#database.prepare(
        `/*md-search-existing-digests*/ SELECT document.digest
         FROM md_search_documents AS document
         JOIN md_search_document_fields AS fields
           ON fields.space_id = document.space_id AND fields.digest = document.digest
         WHERE document.space_id = ?1 AND document.digest IN (${
           batch.map((_digest, index) => `?${index + 2}`).join(", ")
         })`,
      ).bind(spaceId, ...batch).all<{ readonly digest: ExactRevisionIndexEntry["sha256"] }>();
      for (const row of result.results ?? []) present.add(row.digest);
    }
    return Object.freeze(unique.filter((digest) => !present.has(digest)));
  }

  async replaceExactRevision(request: ReplaceExactRevisionIndexRequest): Promise<void> {
    await this.ready();
    validateIdentity(request.spaceId, "space_id");
    validateIdentity(request.revisionId, "revision_id");
    const documents = cloneDocuments(request.documents);
    const entries = request.entries === undefined
      ? undefined
      : cloneEntries(request.entries);
    const normalized = await Promise.all(
      documents.map(async (document, ordinal) => {
        const digest = await digestText(document.text);
        if (document.sha256 !== undefined && document.sha256 !== digest) {
          throw new TypeError("exact revision search document digest is invalid");
        }
        return Object.freeze({
        ...document,
        ordinal,
        digest,
        byteSize: new TextEncoder().encode(document.text).byteLength,
        normalizedText: normalizedLexicalText(document.text),
        normalizedFields: normalizedFields(document),
        });
      }),
    );
    const memberships = entries ?? normalized.map((document) => Object.freeze({
      path: document.path,
      sha256: document.digest,
    }));
    if (entries !== undefined) {
      const membership = new Map(entries.map((entry) => [entry.path, entry.sha256]));
      for (const document of normalized) {
        if (membership.get(document.path) !== document.digest) {
          throw new TypeError("exact revision search document is not in its manifest");
        }
      }
    }
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
      ...chunks(normalized, 12).map((batch) =>
        this.#database
          .prepare(
            `/*md-search-fields-upsert*/ INSERT INTO md_search_document_fields
             (space_id, digest, normalized_title, normalized_description,
              normalized_tags, normalized_headings, normalized_body, title_from_path)
             VALUES ${placeholders(batch.length, 8)}
             ON CONFLICT(space_id, digest) DO NOTHING`,
          )
          .bind(...batch.flatMap((document) => [
            request.spaceId,
            document.digest,
            document.normalizedFields.title,
            document.normalizedFields.description,
            document.normalizedFields.tags,
            document.normalizedFields.headings,
            document.normalizedFields.body,
            document.normalizedFields.titleFromPath ? 1 : 0,
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
      ...chunks(memberships, 16).map((batch, batchIndex) =>
        this.#database
          .prepare(
            `/*md-search-membership-insert*/ INSERT INTO md_search_revision_documents
             (space_id, revision_id, ordinal, path, digest, normalized_path_title)
             VALUES ${placeholders(batch.length, 6)}`,
          )
          .bind(...batch.flatMap((document, index) => [
            request.spaceId,
            request.revisionId,
            batchIndex * 16 + index,
            document.path,
            document.sha256,
            normalizedPathTitle(document.path),
          ]))),
      memberships.length === 0
        ? this.#database
            .prepare(
              `/*md-search-empty-marker-upsert*/ INSERT INTO md_exact_revision_search
               (space_id, revision_id, documents_json) VALUES (?1, ?2, '[]')
               ON CONFLICT(space_id, revision_id) DO UPDATE SET documents_json = '[]'`,
            )
            .bind(request.spaceId, request.revisionId)
        : this.#database
            .prepare(
              `/*md-search-legacy-delete*/ DELETE FROM md_exact_revision_search
               WHERE space_id = ?1 AND revision_id = ?2`,
            )
            .bind(request.spaceId, request.revisionId),
      this.#database
        .prepare(
          `/*md-search-orphan-fields-cleanup*/ DELETE FROM md_search_document_fields
           WHERE rowid IN (
             SELECT fields.rowid FROM md_search_document_fields AS fields
              WHERE fields.space_id = ?1 AND NOT EXISTS (
                SELECT 1 FROM md_search_revision_documents AS membership
                 WHERE membership.space_id = fields.space_id
                   AND membership.digest = fields.digest
              )
              LIMIT 100
           )`,
        )
        .bind(request.spaceId),
      this.#database
        .prepare(
          `/*md-search-orphan-lexical-cleanup*/ DELETE FROM md_search_document_lexical
           WHERE rowid IN (
             SELECT lexical.rowid FROM md_search_document_lexical AS lexical
              WHERE lexical.space_id = ?1 AND NOT EXISTS (
                SELECT 1 FROM md_search_revision_documents AS membership
                 WHERE membership.space_id = lexical.space_id
                   AND membership.digest = lexical.digest
              )
              LIMIT 100
           )`,
        )
        .bind(request.spaceId),
      this.#database
        .prepare(
          `/*md-search-orphan-document-cleanup*/ DELETE FROM md_search_documents
           WHERE rowid IN (
             SELECT document.rowid FROM md_search_documents AS document
              WHERE document.space_id = ?1 AND NOT EXISTS (
                SELECT 1 FROM md_search_revision_documents AS membership
                 WHERE membership.space_id = document.space_id
                   AND membership.digest = document.digest
              )
              LIMIT 100
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

  async inspectExactRevision(
    spaceId: ReplaceExactRevisionIndexRequest["spaceId"],
    revisionId: ReplaceExactRevisionIndexRequest["revisionId"],
  ) {
    await this.ready();
    validateIdentity(spaceId, "space_id");
    validateIdentity(revisionId, "revision_id");
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
              JOIN md_search_document_fields AS fields
                ON fields.space_id = membership.space_id
               AND fields.digest = membership.digest
             WHERE membership.space_id = ?1 AND membership.revision_id = ?2)
             AS indexed_count`,
      )
      .bind(spaceId, revisionId)
      .all<SearchProjectionCountRow>();
    const membershipCount = Number(counts.results?.[0]?.membership_count ?? 0);
    const indexedCount = Number(counts.results?.[0]?.indexed_count ?? 0);
    if (membershipCount > 0 && indexedCount === membershipCount) {
      return Object.freeze({ kind: "ready" as const, spaceId, revisionId });
    }
    // Legacy projection is rare and migration-only. Healthy normalized rows
    // never load document text during the recurring physical presence probe.
    const legacy = await this.#database
      .prepare(
        `/*md-search-read-legacy*/ SELECT documents_json FROM md_exact_revision_search
         WHERE space_id = ?1 AND revision_id = ?2`,
      )
      .bind(spaceId, revisionId)
      .all<SearchRow>();
    return legacy.results?.[0] === undefined
      ? Object.freeze({ kind: "unavailable" as const })
      : Object.freeze({ kind: "ready" as const, spaceId, revisionId });
  }

  async queryExactRevision(
    spaceId: ReplaceExactRevisionIndexRequest["spaceId"],
    revisionId: ReplaceExactRevisionIndexRequest["revisionId"],
    normalizedTerms: readonly string[],
    page?: Readonly<{ readonly offset: number; readonly limit: number }>,
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
    if (
      page !== undefined &&
      (!Number.isSafeInteger(page.offset) || page.offset < 0 ||
        !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100)
    ) throw new TypeError("exact revision search page is invalid");
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
              JOIN md_search_document_fields AS fields
                ON fields.space_id = membership.space_id
               AND fields.digest = membership.digest
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
      // Complete stored text can rebuild a missing lexical projection. A partial
      // document JOIN cannot: replacing membership would conceal its damage.
      if (membershipCount > 0 && legacy.documents.length !== membershipCount) {
        return Object.freeze({ kind: "unavailable" });
      }
      if (legacy.documents.length === 0) {
        return Object.freeze({
          kind: "ready" as const,
          spaceId,
          revisionId,
          totalDocuments: 0,
          ...(page === undefined ? {} : { totalMatches: 0, pageApplied: true }),
          documents: Object.freeze([]),
        });
      }
      await this.replaceExactRevision({
        spaceId,
        revisionId,
        documents: legacy.documents,
      });
      return this.queryExactRevision(spaceId, revisionId, normalizedTerms, page);
    }
    const termsJson = JSON.stringify(normalizedTerms);
    const columns = [
      ["(CASE WHEN fields.title_from_path = 1 THEN membership.normalized_path_title ELSE fields.normalized_title END)", 8],
      ["fields.normalized_description", 4],
      ["fields.normalized_tags", 6],
      ["fields.normalized_headings", 5],
      ["fields.normalized_body", 1],
    ] as const;
    const termValue = "CAST(term.value AS TEXT)";
    const predicate = columns
      .map(([column]) => `instr(${column}, ${termValue}) > 0`)
      .join(" OR ");
    const score = columns
      .map(([column, weight]) =>
        `${weight} * min(20, (length(${column}) - length(replace(${column}, ${termValue}, ''))) / length(${termValue}))`
      )
      .join(" + ");
    const joins = `FROM md_search_revision_documents AS membership
         JOIN md_search_documents AS document
           ON document.space_id = membership.space_id
          AND document.digest = membership.digest
         JOIN md_search_document_fields AS fields
           ON fields.space_id = membership.space_id
          AND fields.digest = membership.digest
         WHERE membership.space_id = ?1 AND membership.revision_id = ?2
           AND NOT EXISTS (
             SELECT 1 FROM json_each(?3) AS term
              WHERE NOT (${predicate})
           )`;
    const matchCount = await this.#database
      .prepare(`/*md-search-match-count*/ SELECT COUNT(*) AS total_matches ${joins}`)
      .bind(spaceId, revisionId, termsJson)
      .all<SearchMatchCountRow>();
    const totalMatches = Number(matchCount.results?.[0]?.total_matches ?? 0);
    const pagination = page === undefined
      ? ""
      : " LIMIT ?4 OFFSET ?5";
    const matches = await this.#database
      .prepare(
        `/*md-search-query-normalized*/ SELECT membership.path, document.text,
           (SELECT COALESCE(SUM(${score}), 0) FROM json_each(?3) AS term) AS weighted_score
         ${joins}
         ORDER BY weighted_score DESC, membership.path ASC${pagination}`,
      )
      .bind(
        spaceId,
        revisionId,
        termsJson,
        ...(page === undefined ? [] : [page.limit, page.offset]),
      )
      .all<NormalizedSearchRow>();
    return Object.freeze({
      kind: "ready",
      spaceId,
      revisionId,
      totalDocuments: membershipCount,
      ...(page === undefined ? {} : { totalMatches, pageApplied: true }),
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
          `/*md-search-purge-fields*/ DELETE FROM md_search_document_fields
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
      Number(results[4]?.meta?.changes ?? 0);
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
  return new SitesExactRevisionSearchIndex(database);
}
