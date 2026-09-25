import test from "node:test";
import assert from "node:assert/strict";
import { cleanupFailedImportOrphan } from "../../apps/mind-diary-acceptance/failed-import-orphan-cleanup.mjs";
import { FakeR2Bucket } from "../../scripts/lib/fake-sites-storage.mjs";

test("failed import cleanup deletes only the single run-proven staged object", async () => {
  const now = Date.now();
  const run = { state: "cleaned", profile: "collaboration", actor_count: 4,
    actors: [], created_at: now - 1000, expires_at: now + 1000 };
  const importId = "import_synthetic", spaceId = "space_synthetic", stagedFileId = "staged_synthetic";
  const bucket = new FakeR2Bucket();
  await bucket.put(`staged-bundle-files/${stagedFileId}`, new Uint8Array([1, 2]), {
    customMetadata: { schema: "md-r2-staged-bundle-file-v1", spaceId,
      bindingOwnerId: `import-owner_${importId}`, stagedFileId, size: "2",
      createdAt: new Date(now).toISOString() },
  });
  const store = {
    run: async () => run,
    statement: (sql) => ({ first: async () => sql.includes("cleanup_receipts")
      ? { receipt_json: JSON.stringify({ state: "cleaned", actors_cleaned: 4 }) }
      : { count: 0 } }),
  };
  const metadata = {
    captureSystemBackupState: async () => ({ snapshot: {
      principals: new Map(), spaces: new Map(), knowledgeSpaces: new Map(),
    } }),
    readMarkdownImportSession: async (id) => id === importId
      ? { importId, spaceId, principalId: "principal_synthetic", state: "validation_failed",
        createdAt: new Date(now).toISOString() } : null,
    readHead: async () => null,
    listMarkdownImportStagedFiles: async () => [{ importId, stagedFileId }],
  };
  const dependencies = {
    createMetadata: async () => metadata,
    createObjects: async () => ({ deleteStagedBundleFile: async (id) => {
      if (id !== stagedFileId) return false;
      await bucket.delete(`staged-bundle-files/${id}`);
      return true;
    } }),
  };
  const cleanup = (input) => cleanupFailedImportOrphan(store, "run_synthetic", input,
    { DB: {}, MIND_DIARY_BUCKET: bucket }, dependencies);
  await assert.rejects(cleanup({ import_id: "import_foreign" }), /failed_import_orphan_session_mismatch/);
  assert.equal((await bucket.list()).objects.length, 1);
  await bucket.put("foreign-object", new Uint8Array([3]));
  await assert.rejects(cleanup({ import_id: importId }), /failed_import_orphan_object_inventory/);
  assert.equal((await bucket.list()).objects.length, 2);
  await bucket.delete("foreign-object");
  assert.equal((await cleanup({ import_id: importId })).deleted_staged, 1);
  assert.equal((await bucket.list()).objects.length, 0);
});
