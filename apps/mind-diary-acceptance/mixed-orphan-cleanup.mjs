import { createSitesMetadataStore } from "../../packages/adapter-metadata-sites/dist/index.js";
import { createSitesObjectStore } from "../../packages/adapter-object-sites/dist/index.js";
import { acceptanceInventory } from "./inventory.mjs";

const fail = (code) => { throw new Error(code); };
const id = (value, prefix) => typeof value === "string" &&
  new RegExp(`^${prefix}[A-Za-z0-9_-]{1,120}$`, "u").test(value);
const digest = (value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
const withinRun = (value, run) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= run.created_at && time <= run.expires_at;
};

// Only a deleted, isolated synthetic run with one committed import and two
// uploaded ZIPs is eligible. The existing import recovery removes its three
// staged Markdown files after these ZIPs are gone.
export async function recoverMixedFixtureOrphans(store, runId, input, environment) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== "import_id,space_id,zip_files" ||
      !id(input.import_id, "import_") || !id(input.space_id, "space_") ||
      !Array.isArray(input.zip_files) || input.zip_files.length !== 2 ||
      input.zip_files.some((file) => !file || typeof file !== "object" || Array.isArray(file) ||
        Object.keys(file).sort().join(",") !== "sha256,size,staged_file_ref" ||
        !digest(file.sha256) || !id(file.staged_file_ref, "staged_") ||
        !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 268_435_456) ||
      new Set(input.zip_files.map((file) => file.sha256)).size !== 2 ||
      new Set(input.zip_files.map((file) => file.staged_file_ref)).size !== 2) {
    fail("mixed_orphan_invalid_request");
  }
  const run = await store.run(runId);
  if (run.state !== "cleaning") fail("mixed_orphan_run_not_cleaning");
  const done = await store.statement(`SELECT COUNT(*) AS count FROM md_acceptance_cleanup_journal
    WHERE done = 1 AND actor_id IN (SELECT id FROM md_acceptance_actors WHERE run_id = ?)`, runId).first();
  if (done.count !== run.actors.length) fail("mixed_orphan_actors_not_cleaned");
  const others = await store.statement("SELECT COUNT(*) AS count FROM md_acceptance_runs WHERE id != ? AND state != 'cleaned'", runId).first();
  if (others.count !== 0) fail("mixed_orphan_other_run_present");
  const inventory = await acceptanceInventory(environment);
  if (!inventory.complete || inventory.principals !== 0 || inventory.owned_minds !== 0) {
    fail("mixed_orphan_inventory_not_isolated");
  }
  const metadata = await createSitesMetadataStore(environment.DB);
  const session = await metadata.readMarkdownImportSession(input.import_id);
  if (!session || session.spaceId !== input.space_id || session.state !== "committed" ||
      session.principalId !== run.actors[0]?.principal_id ||
      await metadata.readHead(input.space_id) !== null) fail("mixed_orphan_source_not_owned");
  const records = await metadata.listMarkdownImportStagedFiles(input.import_id);
  if (records.length > 3 || records.some((record) => record.importId !== input.import_id)) {
    fail("mixed_orphan_import_records_invalid");
  }
  const page = await environment.MIND_DIARY_BUCKET.list({ limit: 250, include: ["customMetadata"] });
  if (page.truncated || page.objects.length !== inventory.object_count) fail("mixed_orphan_inventory_incomplete");
  const byKey = new Map(page.objects.map((object) => [object.key, object]));
  if (byKey.size !== page.objects.length) fail("mixed_orphan_duplicate_object");
  const expected = new Set(records.map((record) => `staged-bundle-files/${encodeURIComponent(record.stagedFileId)}`));
  for (const record of records) {
    const object = byKey.get(`staged-bundle-files/${encodeURIComponent(record.stagedFileId)}`);
    const value = object?.customMetadata ?? {};
    if (!object || !object.etag || value.schema !== "md-r2-staged-bundle-file-v1" ||
        value.stagedFileId !== record.stagedFileId || value.spaceId !== input.space_id ||
        value.bindingOwnerId !== `import-owner_${input.import_id}` ||
        Number(value.size) !== object.size || !withinRun(value.createdAt, run)) {
      fail("mixed_orphan_import_object_invalid");
    }
  }
  let bindingOwnerId = null;
  const remaining = [];
  for (const file of input.zip_files) {
    const stagedKey = `staged-bundle-files/${encodeURIComponent(file.staged_file_ref)}`;
    const primaryKey = `bundle-files/${encodeURIComponent(input.space_id)}/sha256/${file.sha256.slice(7)}`;
    const sidecarKey = `spaces/${encodeURIComponent(input.space_id)}/integrity/${encodeURIComponent(primaryKey)}`;
    expected.add(stagedKey); expected.add(primaryKey); expected.add(sidecarKey);
    const staged = byKey.get(stagedKey), primary = byKey.get(primaryKey), sidecar = byKey.get(sidecarKey);
    if (staged) {
      const value = staged.customMetadata ?? {};
      if (!staged.etag || staged.size !== file.size ||
          value.schema !== "md-r2-staged-bundle-file-stream-v1" ||
          value.stagedFileId !== file.staged_file_ref || value.spaceId !== input.space_id ||
          !/^md_oauth_grant_[0-9a-f-]{36}$/u.test(value.bindingOwnerId ?? "") ||
          !withinRun(value.createdAt, run)) fail("mixed_orphan_staged_provenance_unknown");
      if (bindingOwnerId !== null && bindingOwnerId !== value.bindingOwnerId) {
        fail("mixed_orphan_binding_mismatch");
      }
      bindingOwnerId = value.bindingOwnerId;
    }
    if (!!primary !== !!sidecar) fail("mixed_orphan_pair_incomplete");
    if (primary) {
      const value = primary.customMetadata ?? {}, integrity = sidecar.customMetadata ?? {};
      if (!primary.etag || !sidecar.etag || primary.size !== file.size ||
          value.schema !== "md-r2-bundle-file-v1" || value.state !== "active" ||
          value.spaceId !== input.space_id || value.sha256 !== file.sha256 ||
          value.mediaType !== "application/zip" || value.size !== String(file.size) ||
          !withinRun(value.createdAt, run) || !withinRun(value.protectedAt, run) ||
          integrity.schema !== "md-r2-object-integrity-v1" ||
          integrity.objectKey !== primaryKey || integrity.spaceId !== input.space_id ||
          integrity.kind !== "bundle_file" || integrity.sha256 !== file.sha256 ||
          integrity.size !== String(file.size)) fail("mixed_orphan_canonical_provenance_unknown");
    }
    remaining.push({ file, stagedKey, primaryKey, sidecarKey, staged, primary });
  }
  if (page.objects.some((object) => !expected.has(object.key))) fail("mixed_orphan_unknown_object");
  const objects = await createSitesObjectStore(environment.MIND_DIARY_BUCKET);
  const staged = remaining.find((item) => item.staged);
  if (staged) {
    if (!(await objects.deleteStagedBundleFile(staged.file.staged_file_ref))) {
      fail("mixed_orphan_staged_delete_uncertain");
    }
    const after = await environment.MIND_DIARY_BUCKET.list({ prefix: staged.stagedKey, limit: 250 });
    if (after.truncated || after.objects.some((object) => object.key === staged.stagedKey)) {
      fail("mixed_orphan_staged_delete_uncertain");
    }
    return { state: "cleaning", deleted_staged: 1, remaining_objects: page.objects.length - 1 };
  }
  const canonical = remaining.find((item) => item.primary);
  if (canonical) {
    if (!(await objects.deleteBundleFileObject({ spaceId: input.space_id,
      sha256: canonical.file.sha256,
      expectedProtectedAt: canonical.primary.customMetadata.protectedAt,
      createdBefore: new Date().toISOString() }))) fail("mixed_orphan_canonical_delete_uncertain");
    const after = await environment.MIND_DIARY_BUCKET.list({ limit: 250 });
    if (after.truncated || after.objects.some((object) =>
      object.key === canonical.primaryKey || object.key === canonical.sidecarKey)) {
      fail("mixed_orphan_canonical_delete_uncertain");
    }
    return { state: "cleaning", deleted_pair: 1, remaining_objects: page.objects.length - 2 };
  }
  return { state: "ready_for_import_cleanup", remaining_objects: page.objects.length };
}
