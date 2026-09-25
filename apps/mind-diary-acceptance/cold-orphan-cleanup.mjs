import { createSitesMetadataStore } from "../../packages/adapter-metadata-sites/dist/index.js";
import { createSitesObjectStore } from "../../packages/adapter-object-sites/dist/index.js";
import { acceptanceInventory } from "./inventory.mjs";

const fail = (code) => { throw new Error(code); };
const id = (value) => typeof value === "string" && /^space_[A-Za-z0-9-]{1,120}$/u.test(value);
const fixtureDigest = async (index) => {
  const bytes = new TextEncoder().encode(`ZIP fixture ${index}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

// Only the two fixture ZIPs inserted without product lifecycle bindings are
// eligible. A complete unknown-object inventory fails closed.
export async function recoverColdFixtureOrphans(store, runId, input, environment) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).join(",") !== "space_id" || !id(input.space_id)) fail("invalid_request");
  const run = await store.run(runId);
  if (run.state !== "cleaning") fail("cold_orphan_run_not_cleaning");
  const done = await store.statement(`SELECT COUNT(*) AS count FROM md_acceptance_cleanup_journal
    WHERE done = 1 AND actor_id IN (SELECT id FROM md_acceptance_actors WHERE run_id = ?)`, runId).first();
  if (done.count !== run.actors.length) fail("cold_orphan_actors_not_cleaned");
  const others = await store.statement("SELECT COUNT(*) AS count FROM md_acceptance_runs WHERE id != ? AND state != 'cleaned'", runId).first();
  if (others.count !== 0) fail("cold_orphan_other_run_present");
  const inventory = await acceptanceInventory(environment);
  if (!inventory.complete || inventory.principals !== 0 || inventory.owned_minds !== 0 ||
      inventory.rows.md_backup_sessions !== 0) fail("cold_orphan_inventory_not_isolated");
  const metadata = await createSitesMetadataStore(environment.DB);
  if (await metadata.readHead(input.space_id) !== null) fail("cold_orphan_space_still_live");
  const page = await environment.MIND_DIARY_BUCKET.list({ limit: 250, include: ["customMetadata"] });
  if (page.truncated || page.objects.length !== inventory.object_count ||
      ![2, 4].includes(page.objects.length)) fail("cold_orphan_inventory_incomplete");
  const expected = await Promise.all([fixtureDigest(0), fixtureDigest(1)]);
  const pairs = [];
  for (const digest of expected) {
    const key = `bundle-files/${encodeURIComponent(input.space_id)}/sha256/${digest.slice(7)}`;
    const sidecarKey = `spaces/${encodeURIComponent(input.space_id)}/integrity/${encodeURIComponent(key)}`;
    const primary = page.objects.find((object) => object.key === key);
    const sidecar = page.objects.find((object) => object.key === sidecarKey);
    if (!!primary !== !!sidecar) fail("cold_orphan_pair_incomplete");
    if (!primary) continue;
    const value = primary.customMetadata ?? {};
    const integrity = sidecar.customMetadata ?? {};
    const created = Date.parse(value.createdAt), protectedAt = Date.parse(value.protectedAt);
    if (value.schema !== "md-r2-bundle-file-v1" || value.state !== "active" ||
        value.spaceId !== input.space_id || value.sha256 !== digest ||
        value.mediaType !== "application/zip" || value.size !== "13" ||
        primary.size !== 13 || !primary.etag ||
        !Number.isFinite(created) || created < run.created_at || created > run.expires_at ||
        !Number.isFinite(protectedAt) || protectedAt < created || protectedAt > run.expires_at ||
        integrity.schema !== "md-r2-object-integrity-v1" ||
        integrity.objectKey !== key || integrity.spaceId !== input.space_id ||
        integrity.kind !== "bundle_file" || integrity.sha256 !== digest ||
        integrity.size !== "13" || !sidecar.etag) fail("cold_orphan_provenance_unknown");
    pairs.push({ digest, key, sidecarKey, protectedAt: value.protectedAt });
  }
  if (pairs.length * 2 !== page.objects.length) fail("cold_orphan_unknown_object");
  const pair = pairs[0];
  const objects = await createSitesObjectStore(environment.MIND_DIARY_BUCKET);
  const deleted = await objects.deleteBundleFileObject({
    spaceId: input.space_id, sha256: pair.digest,
    expectedProtectedAt: pair.protectedAt, createdBefore: new Date().toISOString(),
  });
  if (!deleted) fail("cold_orphan_delete_not_confirmed");
  const after = await environment.MIND_DIARY_BUCKET.list({ limit: 250 });
  if (after.truncated || after.objects.some((object) => object.key === pair.key || object.key === pair.sidecarKey)) {
    fail("cold_orphan_delete_uncertain");
  }
  return { state: "cleaning", objects_before: page.objects.length, deleted_pair: 1,
    remaining_objects: after.objects.length };
}
