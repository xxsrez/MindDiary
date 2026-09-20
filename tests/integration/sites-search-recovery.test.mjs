import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createSitesSearchIndex,
  SITES_SEARCH_MIGRATIONS,
} from "../../packages/adapter-search-sites/dist/index.js";
import { SqliteD1 } from "../../scripts/lib/sqlite-d1.mjs";

for (const missingTable of [
  "md_search_documents",
  "md_search_document_lexical",
  "md_search_document_fields",
]) {
  test(`search preserves damaged membership after losing a row in ${missingTable}`, async (t) => {
    const database = new SqliteD1();
    t.after(() => database.close());
    const index = await createSitesSearchIndex(database);
    const spaceId = "space_partial_search";
    const revisionId = "revision_partial_search";
    const documents = Array.from({ length: 3 }, (_, i) => ({ path: `wiki/${i}.md`, text: `searchable ${i}` }));
    await index.replaceExactRevision({ spaceId, revisionId, documents });
    await database.prepare(`DELETE FROM ${missingTable} WHERE digest = (
      SELECT digest FROM md_search_revision_documents WHERE space_id = ?1 AND ordinal = 1
    )`).bind(spaceId).run();

    assert.equal((await index.inspectExactRevision(spaceId, revisionId)).kind, "unavailable");
    const queried = await index.queryExactRevision(spaceId, revisionId, ["searchable"]);
    if (missingTable === "md_search_documents" || missingTable === "md_search_document_fields") {
      assert.deepEqual(queried, { kind: "unavailable" });
      assert.equal((await index.inspectExactRevision(spaceId, revisionId)).kind, "unavailable");
    } else {
      // Missing lexical rows are safely recoverable when full documents and
      // parsed field projections remain. Missing fields require canonical rebuild.
      assert.equal(queried.kind, "ready");
      assert.deepEqual(queried.documents, documents);
    }
    assert.equal((await index.readStorageMetricsForTest(spaceId)).membershipCount, 3);

    // Restart plus a rebuild from canonical documents restores all results.
    const restarted = await createSitesSearchIndex(database);
    await restarted.replaceExactRevision({ spaceId, revisionId, documents });
    const found = await restarted.queryExactRevision(spaceId, revisionId, ["searchable"]);
    assert.equal(found.kind, "ready");
    assert.equal(found.totalDocuments, 3);
    assert.deepEqual(found.documents, documents);
  });
}

test("v5 migration invalidates ambiguous field projections before digest reuse", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());
  for (const sql of SITES_SEARCH_MIGRATIONS.slice(0, 8)) {
    await database.prepare(sql).run();
  }
  const text = "body without either filename";
  const digest = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  await database.prepare(
    `INSERT INTO md_search_schema_migrations (version, name, applied_at)
     VALUES (5, 'bounded-ranked-search-v5', '2026-09-20T00:00:00.000Z')`,
  ).run();
  await database.prepare(
    `INSERT INTO md_search_documents (space_id, digest, text, byte_size)
     VALUES ('space_v5_search', ?1, ?2, ?3)`,
  ).bind(digest, text, Buffer.byteLength(text)).run();
  await database.prepare(
    `INSERT INTO md_search_document_lexical (space_id, digest, normalized_text, byte_size)
     VALUES ('space_v5_search', ?1, ?2, ?3)`,
  ).bind(digest, text, Buffer.byteLength(text)).run();
  await database.prepare(
    `INSERT INTO md_search_document_fields
       (space_id, digest, normalized_title, normalized_description,
        normalized_tags, normalized_headings, normalized_body)
     VALUES ('space_v5_search', ?1, 'old', '', '', '', ?2)`,
  ).bind(digest, text).run();
  await database.prepare(
    `INSERT INTO md_search_revision_documents
       (space_id, revision_id, ordinal, path, digest)
     VALUES ('space_v5_search', 'revision_v5_search', 0, 'old.md', ?1)`,
  ).bind(digest).run();

  const index = await createSitesSearchIndex(database);
  assert.equal(
    (await index.inspectExactRevision("space_v5_search", "revision_v5_search")).kind,
    "unavailable",
  );
  assert.deepEqual(
    await index.queryExactRevision("space_v5_search", "revision_v5_search", ["old"]),
    { kind: "unavailable" },
  );

  await index.replaceExactRevision({
    spaceId: "space_v5_search",
    revisionId: "revision_v5_search",
    entries: [{ path: "old.md", sha256: digest }],
    documents: [{
      path: "old.md",
      text,
      sha256: digest,
      titleDerivedFromPath: true,
      fields: { title: ["old"], description: [], tags: [], headings: [], body: [text] },
    }],
  });
  await index.replaceExactRevision({
    spaceId: "space_v5_search",
    revisionId: "revision_v6_search",
    entries: [{ path: "new.md", sha256: digest }],
    documents: [],
  });
  assert.deepEqual(
    (await index.queryExactRevision("space_v5_search", "revision_v6_search", ["new"])).documents,
    [{ path: "new.md", text }],
  );
});

test("search evaluates every accepted term beyond the former D1 bind ceiling", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());
  const index = await createSitesSearchIndex(database);
  const terms = Array.from({ length: 99 }, (_, index) =>
    `term-${String(index).padStart(3, "0")}`);
  await index.replaceExactRevision({
    spaceId: "space_many_search_terms",
    revisionId: "revision_many_search_terms",
    documents: [
      { path: "complete.md", text: terms.join(" ") },
      { path: "missing-last.md", text: terms.slice(0, -1).join(" ") },
    ],
  });

  assert.deepEqual(
    await index.queryExactRevision(
      "space_many_search_terms",
      "revision_many_search_terms",
      terms,
      { offset: 0, limit: 1 },
    ),
    {
      kind: "ready",
      spaceId: "space_many_search_terms",
      revisionId: "revision_many_search_terms",
      totalDocuments: 2,
      totalMatches: 1,
      pageApplied: true,
      documents: [{ path: "complete.md", text: terms.join(" ") }],
    },
  );
});

test("digest reuse keeps path-derived title current without rereading the body", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());
  const index = await createSitesSearchIndex(database);
  const text = "body without either filename";
  const sha256 = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  await index.replaceExactRevision({
    spaceId: "space_renamed_search",
    revisionId: "revision_renamed_search_old",
    entries: [{ path: "old.md", sha256 }],
    documents: [{
      path: "old.md",
      text,
      sha256,
      titleDerivedFromPath: true,
      fields: {
        title: ["old"],
        description: [],
        tags: [],
        headings: [],
        body: [text],
      },
    }],
  });
  await index.replaceExactRevision({
    spaceId: "space_renamed_search",
    revisionId: "revision_renamed_search_new",
    entries: [{ path: "new.md", sha256 }],
    documents: [],
  });

  assert.deepEqual(
    (await index.queryExactRevision(
      "space_renamed_search",
      "revision_renamed_search_new",
      ["new"],
    )).documents,
    [{ path: "new.md", text }],
  );
  assert.deepEqual(
    (await index.queryExactRevision(
      "space_renamed_search",
      "revision_renamed_search_new",
      ["old"],
    )).documents,
    [],
  );
});

test("same-revision replacement reclaims bounded orphan projections", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());
  const index = await createSitesSearchIndex(database);
  const target = {
    spaceId: "space_replaced_search",
    revisionId: "revision_replaced_search",
  };
  await index.replaceExactRevision({
    ...target,
    documents: [{ path: "old.md", text: "old projection" }],
  });
  await index.replaceExactRevision({
    ...target,
    documents: [{ path: "new.md", text: "new projection" }],
  });

  assert.deepEqual(await index.readStorageMetricsForTest(target.spaceId), {
    documentCount: 1,
    documentBytes: Buffer.byteLength("new projection"),
    lexicalBytes: Buffer.byteLength("new projection"),
    membershipCount: 1,
  });
});
