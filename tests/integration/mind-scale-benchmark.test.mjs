import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_MIND_SCALE_COUNTS,
  LOCAL_MIND_SCALE_SCHEMA,
  runLocalMindScaleBenchmark,
} from "../../scripts/lib/mind-scale-benchmark.mjs";

test("local 1/10/100 Mind fixture records deterministic list query counts and ordering", async () => {
  const report = await runLocalMindScaleBenchmark();
  assert.equal(report.schema, LOCAL_MIND_SCALE_SCHEMA);
  assert.equal(report.environment, "local-synthetic-in-memory");
  assert.equal(report.hosted_evidence, false);
  assert.deepEqual(
    report.list_minds.map((row) => row.mind_count),
    LOCAL_MIND_SCALE_COUNTS,
  );
  for (const row of report.list_minds) {
    assert.ok(row.latency_ms <= 2_000);
    assert.ok(row.metadata.maximumConcurrent <= 8);
    assert.equal(row.metadata.calls.listPublicMindCatalogPage, 1);
  }
});

test("authenticated scaled browse preserves manifest order, caps reads, and denies before objects", async () => {
  const report = await runLocalMindScaleBenchmark();
  assert.equal(report.browse_entries.entry_count, 100);
  assert.ok(report.browse_entries.latency_ms <= 2_000);
  assert.ok(report.browse_entries.objects.maximumConcurrent <= 8);
  assert.equal(report.browse_entries.objects.calls.getImmutable, 100);
  assert.equal(report.browse_entries.denied_object_reads, 0);
});
