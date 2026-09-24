import { createSitesMetadataStore } from "../../packages/adapter-metadata-sites/dist/index.js";
import { acceptanceInventory } from "./inventory.mjs";

const id = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
const fail = (code) => { throw new Error(code); };

async function listAll(bucket) {
  const objects = [];
  let cursor;
  do {
    const page = await bucket.list({ limit: 250, include: ["customMetadata"], ...(cursor ? { cursor } : {}) });
    objects.push(...page.objects);
    if (objects.length > 1_000 || (page.truncated && !page.cursor)) fail("orphan_inventory_incomplete");
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

async function primaryAbsent(bucket, key) {
  const page = await bucket.list({ prefix: key, limit: 250 });
  if (page.truncated) fail("orphan_primary_inventory_incomplete");
  return !page.objects.some((object) => object.key === key);
}

async function assertExclusiveRun(store, runId, environment) {
  const run = await store.run(runId);
  if (run.state !== "cleaning") fail("orphan_run_not_cleaning");
  const done = await store.statement(`SELECT COUNT(*) AS count FROM md_acceptance_cleanup_journal
    WHERE done = 1 AND actor_id IN (SELECT id FROM md_acceptance_actors WHERE run_id = ?)`, runId).first();
  if (done.count !== run.actors.length) fail("orphan_actors_not_cleaned");
  const others = await store.statement("SELECT COUNT(*) AS count FROM md_acceptance_runs WHERE id != ? AND state != 'cleaned'", runId).first();
  if (others.count !== 0) fail("orphan_other_run_present");
  const activeBackup = await store.statement("SELECT COUNT(*) AS count FROM md_backup_sessions WHERE status IN ('building', 'ready')").first();
  if (activeBackup.count !== 0) fail("orphan_backup_active");
  const inventory = await acceptanceInventory(environment);
  if (!inventory.complete || inventory.principals !== 0 || inventory.owned_minds !== 0) fail("orphan_inventory_not_isolated");
  return run;
}

export async function recoverRunOrphans(store, runId, input, environment, productRecovery) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== "dry_run,import_id,space_id" ||
      !id(input.import_id) || !id(input.space_id) || typeof input.dry_run !== "boolean") {
    fail("invalid_request");
  }
  const run = await assertExclusiveRun(store, runId, environment);
  const metadata = await createSitesMetadataStore(environment.DB);
  const session = await metadata.readMarkdownImportSession(input.import_id);
  if (!session || session.spaceId !== input.space_id || session.state !== "committed") {
    fail("orphan_import_not_owned");
  }
  const records = await metadata.listMarkdownImportStagedFiles(input.import_id);
  const stagedIds = new Set(records.map((record) => record.stagedFileId));
  if (stagedIds.size !== records.length || records.some((record) => record.importId !== input.import_id)) {
    fail("orphan_staged_records_invalid");
  }
  const objects = await listAll(environment.MIND_DIARY_BUCKET);
  const staged = [];
  const sidecars = [];
  for (const object of objects) {
    const value = object.customMetadata ?? {};
    if (object.key.startsWith("staged-bundle-files/")) {
      const created = Date.parse(value.createdAt);
      if (value.schema !== "md-r2-staged-bundle-file-v1" ||
          value.spaceId !== input.space_id ||
          value.bindingOwnerId !== `import-owner_${input.import_id}` ||
          !stagedIds.has(value.stagedFileId) ||
          object.key !== `staged-bundle-files/${encodeURIComponent(value.stagedFileId)}` ||
          Number(value.size) !== object.size || !object.etag ||
          !Number.isFinite(created) || created < run.created_at || created > run.expires_at) {
        fail("orphan_staged_provenance_unknown");
      }
      staged.push(object);
      continue;
    }
    const primaryKey = value.objectKey;
    if (typeof primaryKey === "string" && value.schema === "md-r2-object-integrity-v1" &&
        value.spaceId === input.space_id && value.kind === "markdown" && object.etag &&
        primaryKey.startsWith(`spaces/${encodeURIComponent(input.space_id)}/markdown/sha256/`) &&
        object.key === `spaces/${encodeURIComponent(input.space_id)}/integrity/${encodeURIComponent(primaryKey)}` &&
        await primaryAbsent(environment.MIND_DIARY_BUCKET, primaryKey)) {
      sidecars.push(object);
      continue;
    }
    fail("orphan_object_provenance_unknown");
  }
  if (sidecars.length > 1) fail("orphan_sidecar_count_invalid");
  const state = {
    run_id: runId, state: "cleaning", staged_objects: staged.length,
    staged_records: records.length, integrity_sidecars: sidecars.length,
  };
  if (input.dry_run || objects.length === 0) return state;
  await assertExclusiveRun(store, runId, environment);
  if (staged.length > 0) {
    const result = await productRecovery();
    if (result.failed !== 0 || result.cleanupDeleted < 1) fail("orphan_import_cleanup_incomplete");
    return { ...state, cleanup_deleted: result.cleanupDeleted };
  }
  if (records.length !== 0 || session.cleanupCompletedAt === null) fail("orphan_import_cleanup_incomplete");
  const sidecar = sidecars[0];
  if (sidecar) {
    await assertExclusiveRun(store, runId, environment);
    if (!(await primaryAbsent(environment.MIND_DIARY_BUCKET, sidecar.customMetadata.objectKey))) {
      fail("orphan_primary_reappeared");
    }
    const page = await environment.MIND_DIARY_BUCKET.list({ prefix: sidecar.key, limit: 250, include: ["customMetadata"] });
    if (page.truncated || page.objects.length !== 1 || page.objects[0].key !== sidecar.key ||
        page.objects[0].etag !== sidecar.etag) fail("orphan_sidecar_changed");
    await environment.MIND_DIARY_BUCKET.delete(sidecar.key);
    const after = await environment.MIND_DIARY_BUCKET.list({ prefix: sidecar.key, limit: 250 });
    if (after.truncated || after.objects.some((object) => object.key === sidecar.key)) {
      fail("orphan_sidecar_delete_uncertain");
    }
    return { ...state, integrity_sidecars_deleted: 1 };
  }
  return state;
}
