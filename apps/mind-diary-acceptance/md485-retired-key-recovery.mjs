import { acceptanceInventory } from "./inventory.mjs";
import { createSitesMetadataStore } from "../../packages/adapter-metadata-sites/dist/index.js";

// One disposable, deleted MD-485 acceptance Space. No caller-supplied key.
const RUN_ID = "c9520f86-1879-46a6-81ff-d1b5a5f92db2";
const SPACE_ID = "space_f631d87d-b34a-4bf2-94e7-53f6cc38f653";
const SHA256 = "01d91ab7a09b83c2ab09ea27fc224a2d9aaf0c8604892e50cb943df4010c1ba4";
const GATE_DIGEST = "d773c772d58519ef94f1099579ffe64f4be9db93af1f2d58f0164b351743fe57";
const GATE_OPERATION = "e21698c6-8e4c-4bfa-86c3-080d45711b9c";
const BACKUP_OPERATION = "66467e32-39a4-4ada-aec2-c0627352710f";
const KEY = `spaces/${SPACE_ID}/objects/sha256/${SHA256}`;
const SIDECAR = `spaces/${SPACE_ID}/integrity/${encodeURIComponent(KEY)}`;
const IMPORT_ID = "import_02d9cd7c-c7d8-4928-877f-a69e10df7fa0";
const STAGED_FILES = [
  ["import-file_082b0fa6-b42a-4e68-9f07-7bbfbf7b74b8", 75],
  ["import-file_9f913556-f976-45ba-af28-d60417278ea9", 61],
  ["import-file_cece5305-7fea-4bbe-98a3-a3cdeba20f51", 59],
];

const first = (database, sql, ...args) => database.prepare(sql).bind(...args).first();

export function stagingWriterClosed(session) {
  return session === null || (session.importId === IMPORT_ID &&
    session.spaceId === SPACE_ID && session.state === "committed" &&
    session.activeStepId == null && session.unsettledWriterPossible === false &&
    Array.isArray(session.activeStagingStepIds) && session.activeStagingStepIds.length === 0 &&
    Array.isArray(session.armedStagingStepIds) && session.armedStagingStepIds.length === 0 &&
    Array.isArray(session.unsettledStepIds) && session.unsettledStepIds.length === 0);
}

async function inspect(environment) {
  const database = environment.DB;
  const bucket = environment.MIND_DIARY_BUCKET;
  const digest = [...new Uint8Array(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(KEY),
  ))].map((part) => part.toString(16).padStart(2, "0")).join("");
  if (digest !== GATE_DIGEST) throw new Error("recovery_key_mismatch");
  const metadata = await createSitesMetadataStore(database);
  const snapshot = await metadata.captureSystemBackupState();
  const canDelete = await metadata.canPhysicallyDeleteCanonicalObject({
    namespace: "space_canonical", spaceId: SPACE_ID,
    kind: "markdown", sha256: `sha256:${SHA256}`,
  });
  const inventory = await acceptanceInventory(environment);
  const [run, unfinished, gate, backup, backupCount, activeBackup, actorCount,
    journal, receipt, object, sidecar] = await Promise.all([
    first(database, "SELECT state FROM md_acceptance_runs WHERE id = ?", RUN_ID),
    first(database, "SELECT COUNT(*) AS count FROM md_acceptance_runs WHERE state != 'cleaned'"),
    first(database, "SELECT operation_id, acquired_at FROM md_canonical_key_gates WHERE key_digest = ?", GATE_DIGEST),
    first(database, "SELECT started_at FROM md_backup_cleanup_ops WHERE operation_id = ?", BACKUP_OPERATION),
    first(database, "SELECT COUNT(*) AS count FROM md_backup_cleanup_ops"),
    first(database, "SELECT COUNT(*) AS count FROM md_backup_sessions WHERE status IN ('building', 'ready')"),
    first(database, "SELECT COUNT(*) AS count FROM md_acceptance_actors WHERE run_id = ? AND principal_id IS NOT NULL", RUN_ID),
    first(database, `SELECT j.done FROM md_acceptance_cleanup_journal j
      JOIN md_acceptance_actors a ON a.id = j.actor_id
      WHERE a.run_id = ? AND a.principal_id IS NOT NULL`, RUN_ID),
    first(database, "SELECT receipt_json FROM md_acceptance_cleanup_receipts WHERE run_id = ?", RUN_ID),
    bucket.head(KEY), bucket.head(SIDECAR),
  ]);
  const gateTime = Date.parse(gate?.acquired_at ?? "");
  const backupTime = Date.parse(backup?.started_at ?? "");
  const cleanBase = canDelete && inventory.complete && inventory.principals === 0 &&
    inventory.owned_minds === 0 && inventory.rows.md_canonical_creation_intents === 0 &&
    activeBackup?.count === 0;
  const sameRun = cleanBase && unfinished?.count === 1 && run?.state === "cleaning" &&
    actorCount?.count === 1 && backupCount?.count === 1 &&
    Number.isFinite(backupTime) && backupTime < Date.now() - 300_000;
  const exactGate = sameRun && inventory.rows.md_canonical_key_gates === 1 &&
    gate?.operation_id === GATE_OPERATION && Number.isFinite(gateTime) &&
    backupTime >= gateTime && backupTime - gateTime < 5_000;
  const objectValid = object === null ||
    (object.customMetadata?.spaceId === SPACE_ID &&
      object.customMetadata?.kind === "markdown" &&
      object.customMetadata?.sha256 === `sha256:${SHA256}` && object.size === 61);
  const sidecarValid = sidecar === null ||
    (sidecar.customMetadata?.spaceId === SPACE_ID &&
      sidecar.customMetadata?.objectKey === KEY &&
      sidecar.customMetadata?.sha256 === `sha256:${SHA256}`);
  let cleanedReceipt = false;
  if (receipt?.receipt_json) {
    try {
      const value = JSON.parse(receipt.receipt_json);
      cleanedReceipt = value.run_id === RUN_ID && value.state === "cleaned";
    } catch { /* Malformed receipts never prove a completed run. */ }
  }
  const zeroObjects = inventory.object_count === 0 && inventory.object_bytes === 0 &&
    object === null && sidecar === null;
  const releasedReplay = (sameRun && gate === null &&
    inventory.rows.md_canonical_key_gates === 0 && zeroObjects && journal?.done === 1) ||
    (cleanBase && run?.state === "cleaned" && unfinished?.count === 0 &&
      cleanedReceipt && gate === null && backupCount?.count === 0 && zeroObjects &&
      Object.values(inventory.rows).every((count) => count === 0));
  return { safe: exactGate && objectValid && sidecarValid,
    releasedReplay, inventory, backupSequence: snapshot.eventSequence,
    actorDone: journal?.done === 1,
    objectPresent: object !== null, sidecarPresent: sidecar !== null };
}

export async function recoverMd485RetiredKey(environment, phase) {
  if (!["inspect", "delete", "delete_staging", "release"].includes(phase)) throw new Error("invalid_request");
  const before = await inspect(environment);
  if (phase === "inspect") {
    const metadata = await createSitesMetadataStore(environment.DB);
    const session = before.safe ? await metadata.readMarkdownImportSession(IMPORT_ID) : null;
    const stagedRecords = before.safe ? await Promise.all(STAGED_FILES.map(async ([id]) =>
      ({ id, present: await metadata.readStagedBundleFile(id) !== null }))) : null;
    const residual = before.safe && before.inventory.object_count <= 16
      ? await environment.MIND_DIARY_BUCKET.list({ limit: 17, include: ["customMetadata"] }) : null;
    if (residual && (residual.truncated ||
        residual.objects.length !== before.inventory.object_count)) {
      throw new Error("recovery_inventory_changed");
    }
    return {
      eligible: before.safe, object_present: before.objectPresent,
      sidecar_present: before.sidecarPresent, actor_cleanup_done: before.actorDone,
      object_count: before.inventory.object_count,
      import_record: session ? { state: session.state, active_step: session.activeStepId ?? null,
        staging_steps: session.activeStagingStepIds?.length ?? null,
        armed_staging_steps: session.armedStagingStepIds?.length ?? null,
        unsettled_steps: session.unsettledStepIds?.length ?? null,
        unsettled_writer: session.unsettledWriterPossible ?? null,
        cleanup_completed_at: session.cleanupCompletedAt } : null,
      staged_records: stagedRecords,
      residual_objects: residual?.objects.map((item) => ({
        key: item.key, bytes: item.size,
        metadata: item.customMetadata ? {
          schema: item.customMetadata.schema ?? null,
          staged_file_id: item.customMetadata.stagedFileId ?? null,
          binding_owner_id: item.customMetadata.bindingOwnerId ?? null,
          space_id: item.customMetadata.spaceId ?? null,
          declared_size: item.customMetadata.size ?? null,
          created_at: item.customMetadata.createdAt ?? null,
        } : null,
      })) ?? null,
    };
  }
  if (phase === "release" && before.releasedReplay) {
    return { released: true, replayed: true };
  }
  if (!before.safe) throw new Error("recovery_preflight_failed");
  if (phase === "delete_staging") {
    const metadata = await createSitesMetadataStore(environment.DB);
    if (!before.actorDone || before.objectPresent || before.sidecarPresent ||
        !stagingWriterClosed(await metadata.readMarkdownImportSession(IMPORT_ID))) {
      throw new Error("recovery_staging_preflight_failed");
    }
    // Validate the entire exact allowlist before the first destructive call.
    for (const [id, size] of STAGED_FILES) {
      const item = await environment.MIND_DIARY_BUCKET.head(`staged-bundle-files/${id}`);
      if (await metadata.readStagedBundleFile(id) !== null || (item !== null && (
        item.size !== size || item.customMetadata?.schema !== "md-r2-staged-bundle-file-v1" ||
        item.customMetadata?.stagedFileId !== id || item.customMetadata?.spaceId !== SPACE_ID ||
        item.customMetadata?.bindingOwnerId !== `import-owner_${IMPORT_ID}` ||
        item.customMetadata?.size !== String(size) ||
        item.customMetadata?.createdAt !== "2026-09-25T19:03:11.134Z"
      ))) throw new Error("recovery_staging_preflight_failed");
    }
    for (const [id] of STAGED_FILES) {
      const key = `staged-bundle-files/${id}`;
      await environment.MIND_DIARY_BUCKET.delete(key);
      if (await environment.MIND_DIARY_BUCKET.head(key) !== null) {
        throw new Error("recovery_delete_unconfirmed");
      }
    }
    return { staging_deleted: true };
  }
  if (phase === "delete") {
    await environment.MIND_DIARY_BUCKET.delete(KEY);
    await environment.MIND_DIARY_BUCKET.delete(SIDECAR);
    if (await environment.MIND_DIARY_BUCKET.head(KEY) !== null ||
        await environment.MIND_DIARY_BUCKET.head(SIDECAR) !== null) {
      throw new Error("recovery_delete_unconfirmed");
    }
    return { deleted: true };
  }
  const after = await acceptanceInventory(environment);
  if (!before.actorDone || !after.complete || after.principals !== 0 ||
      after.owned_minds !== 0 || after.object_count !== 0 || after.object_bytes !== 0 ||
      after.rows.md_canonical_key_gates !== 1 ||
      after.rows.md_canonical_creation_intents !== 0 ||
      await environment.MIND_DIARY_BUCKET.head(KEY) !== null ||
      await environment.MIND_DIARY_BUCKET.head(SIDECAR) !== null) {
    throw new Error("recovery_release_preflight_failed");
  }
  const result = await environment.DB.prepare(
    `DELETE FROM md_canonical_key_gates WHERE key_digest = ? AND operation_id = ?
      AND NOT EXISTS (SELECT 1 FROM md_canonical_creation_intents)
      AND NOT EXISTS (SELECT 1 FROM md_backup_sessions WHERE status IN ('building', 'ready'))
      AND (SELECT backup_sequence FROM md_backup_control WHERE singleton_id = 1) = ?`,
  ).bind(GATE_DIGEST, GATE_OPERATION, before.backupSequence).run();
  if (result.meta?.changes !== 1) throw new Error("recovery_release_unconfirmed");
  return { released: true };
}
