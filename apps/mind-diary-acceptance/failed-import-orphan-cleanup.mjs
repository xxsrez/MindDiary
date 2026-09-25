import { createSitesMetadataStore } from "../../packages/adapter-metadata-sites/dist/index.js";
import { createSitesObjectStore } from "../../packages/adapter-object-sites/dist/index.js";

const fail = (code) => { throw new Error(code); };

// A failed, deleted synthetic import can leave one physical staged object.
// This helper deletes only the object whose metadata proves the exact run and
// import; it never invokes the global product recovery or an R2 prefix sweep.
export async function cleanupFailedImportOrphan(store, runId, input, environment, {
  createMetadata = createSitesMetadataStore,
  createObjects = createSitesObjectStore,
} = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).join(",") !== "import_id" ||
      !/^import_[A-Za-z0-9_-]{1,120}$/u.test(input.import_id)) fail("failed_import_orphan_invalid_request");
  const run = await store.run(runId);
  if (run.state !== "cleaned" || run.profile !== "collaboration" || run.actor_count !== 4 ||
      run.actors.length !== 0) {
    fail("failed_import_orphan_run_not_cleaned");
  }
  const receiptRow = await store.statement(
    "SELECT receipt_json FROM md_acceptance_cleanup_receipts WHERE run_id = ?",
    runId,
  ).first();
  const receipt = receiptRow ? JSON.parse(receiptRow.receipt_json) : null;
  if (receipt?.state !== "cleaned" || receipt.actors_cleaned !== run.actor_count) {
    fail("failed_import_orphan_receipt_missing");
  }
  const others = await store.statement(
    "SELECT COUNT(*) AS count FROM md_acceptance_runs WHERE id != ? AND state != 'cleaned'",
    runId,
  ).first();
  if (others.count !== 0) fail("failed_import_orphan_other_run_present");

  const metadata = await createMetadata(environment.DB);
  const state = (await metadata.captureSystemBackupState()).snapshot;
  if (!(state.principals instanceof Map) || state.principals.size !== 0 ||
      !(state.spaces instanceof Map) || state.spaces.size !== 0 ||
      !(state.knowledgeSpaces instanceof Map) || state.knowledgeSpaces.size !== 0) {
    fail("failed_import_orphan_product_not_empty");
  }
  const session = await metadata.readMarkdownImportSession(input.import_id);
  const sessionCreated = Date.parse(session?.createdAt);
  if (session === null || session.state !== "validation_failed" ||
      typeof session.spaceId !== "string" || typeof session.principalId !== "string" ||
      !Number.isFinite(sessionCreated) || sessionCreated < run.created_at ||
      sessionCreated > run.expires_at ||
      await metadata.readHead(session.spaceId) !== null) {
    fail("failed_import_orphan_session_mismatch");
  }
  const stagedRecords = await metadata.listMarkdownImportStagedFiles(input.import_id);
  if (stagedRecords.length !== 1 || stagedRecords[0].importId !== input.import_id) {
    fail("failed_import_orphan_staged_record_mismatch");
  }
  const page = await environment.MIND_DIARY_BUCKET.list({ limit: 2, include: ["customMetadata"] });
  if (page.truncated || page.objects.length !== 1) fail("failed_import_orphan_object_inventory");
  const object = page.objects[0];
  const value = object.customMetadata ?? {};
  const createdAt = Date.parse(value.createdAt);
  if (value.schema !== "md-r2-staged-bundle-file-v1" ||
      value.spaceId !== session.spaceId ||
      value.bindingOwnerId !== `import-owner_${input.import_id}` ||
      value.stagedFileId !== stagedRecords[0].stagedFileId ||
      object.key !== `staged-bundle-files/${encodeURIComponent(value.stagedFileId)}` ||
      Number(value.size) !== object.size || !object.etag ||
      !Number.isFinite(createdAt) || createdAt < run.created_at || createdAt > run.expires_at) {
    fail("failed_import_orphan_provenance_unknown");
  }
  const objects = await createObjects(environment.MIND_DIARY_BUCKET);
  if (!(await objects.deleteStagedBundleFile(value.stagedFileId))) {
    fail("failed_import_orphan_delete_uncertain");
  }
  const after = await environment.MIND_DIARY_BUCKET.list({ limit: 2 });
  if (after.truncated || after.objects.length !== 0) fail("failed_import_orphan_delete_uncertain");
  return { run_id: runId, deleted_staged: 1, baseline_objects: 0 };
}
