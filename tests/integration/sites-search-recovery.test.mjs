import assert from "node:assert/strict";
import test from "node:test";
import { createSitesSearchIndex } from "../../packages/adapter-search-sites/dist/index.js";
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
    if (missingTable === "md_search_documents") {
      assert.deepEqual(queried, { kind: "unavailable" });
      assert.equal((await index.inspectExactRevision(spaceId, revisionId)).kind, "unavailable");
    } else {
      // Missing lexical rows are safely recoverable when all document text remains.
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
