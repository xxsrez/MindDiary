import assert from "node:assert/strict";
import test from "node:test";

import {
  SITES_AUDIT_MIGRATIONS,
  SitesAuditSink,
} from "../../packages/adapter-audit-sites/dist/index.js";
import {
  SITES_SEARCH_MIGRATIONS,
  SitesExactRevisionSearchIndex,
} from "../../packages/adapter-search-sites/dist/index.js";

const AUDIT_OBJECTS = Object.freeze([
  "md_audit_schema_migrations",
  "md_delivered_audit_events",
  "md_audit_space_idx",
  "md_audit_principal_idx",
]);

const SEARCH_OBJECTS = Object.freeze([
  "md_search_schema_migrations",
  "md_exact_revision_search",
  "md_search_documents",
  "md_search_revision_documents",
  "md_search_revision_order",
  "md_search_document_digest_lookup",
  "md_search_document_lexical",
  "md_search_document_fields",
]);

class ProbeStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
  }

  bind() {
    return this;
  }

  async all() {
    return { results: this.database.probeRows };
  }

  async run() {
    return { meta: { changes: 0 } };
  }
}

class ProbeDatabase {
  batches = [];

  constructor(probeRows) {
    this.probeRows = probeRows;
  }

  prepare(sql) {
    return new ProbeStatement(this, sql);
  }

  async batch(statements) {
    this.batches.push(statements);
    return statements.map(() => ({ meta: { changes: 0 } }));
  }
}

function rows(names, version) {
  return names.map((name) => ({ name, version }));
}

test("audit schema probe skips DDL only for a complete current schema", async () => {
  const complete = new ProbeDatabase(rows(AUDIT_OBJECTS, 1));
  await new SitesAuditSink(complete).ready();
  assert.equal(complete.batches.length, 0);

  const incomplete = new ProbeDatabase(rows(AUDIT_OBJECTS.slice(0, -1), 1));
  await new SitesAuditSink(incomplete).ready();
  assert.equal(incomplete.batches.length, 1);
  assert.equal(incomplete.batches[0].length, SITES_AUDIT_MIGRATIONS.length + 1);
});

test("search schema probe skips DDL only for a complete current schema", async () => {
  const complete = new ProbeDatabase(rows(SEARCH_OBJECTS, 5));
  await new SitesExactRevisionSearchIndex(complete).ready();
  assert.equal(complete.batches.length, 0);

  const incomplete = new ProbeDatabase(rows(SEARCH_OBJECTS.slice(0, -1), 5));
  await new SitesExactRevisionSearchIndex(incomplete).ready();
  assert.equal(incomplete.batches.length, 1);
  assert.equal(incomplete.batches[0].length, SITES_SEARCH_MIGRATIONS.length + 1);
});
