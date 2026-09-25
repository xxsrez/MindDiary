import { createSitesMetadataStore } from "../../packages/adapter-metadata-sites/dist/index.js";
import { capacityReservationId } from "../../packages/application-content/dist/index.js";

const fail = (code) => { throw new Error(code); };
const phases = new Set(["arm", "inspect", "recover"]);

// Controller-only probe for one real, run-owned queued export. Its short
// retention is configured by the acceptance composition, not by Site clock.
export async function exportJobExpiry(store, runId, input, environment, recoverBackground, {
  createMetadata = createSitesMetadataStore, now = () => Date.now(),
} = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      !phases.has(input.phase) ||
      Object.keys(input).sort().join(",") !==
        (input.phase === "arm" ? "phase" : "job_id,phase") ||
      (input.phase !== "arm" &&
        (typeof input.job_id !== "string" || !/^job-export_[0-9a-f-]{36}$/u.test(input.job_id)))) {
    fail("export_expiry_invalid_request");
  }
  const run = await store.run(runId);
  const instant = now();
  if (run.profile !== "operator" || run.state !== "active" ||
      run.expires_at <= instant || run.actors.length !== 4 ||
      !run.actors[0].principal_id ||
      run.actors.slice(1).some((actor) => actor.principal_id !== null)) {
    fail("export_expiry_run_not_isolated");
  }
  const otherRuns = await store.statement(
    "SELECT COUNT(*) AS count FROM md_acceptance_runs WHERE id != ? AND state != 'cleaned'",
    runId,
  ).first();
  if (otherRuns.count !== 0) fail("export_expiry_other_run_present");
  const metadata = await createMetadata(environment.DB);
  const principalId = run.actors[0].principal_id;
  const directory = await metadata.listServiceOperatorPrincipals({
    sort: "registered_at", direction: "asc", limit: 2,
  });
  const personal = await metadata.resolvePersonalMind(principalId);
  if (directory.principals.length !== 1 || directory.nextCursor !== null ||
      directory.principals[0].principalId !== principalId ||
      directory.principals[0].ownedMindCount !== 0 ||
      directory.principals[0].participatingMindCount !== 0 ||
      !personal?.spaceId) fail("export_expiry_product_not_isolated");
  const spaceId = personal.spaceId;
  if (input.phase === "arm") {
    await store.statement(`INSERT OR IGNORE INTO md_acceptance_export_holds
      (run_id,principal_id,space_id,expires_at) VALUES (?,?,?,?)`,
    runId, principalId, spaceId, Math.min(run.expires_at, instant + 600_000)).run();
    const hold = await store.statement(
      "SELECT principal_id,space_id,expires_at FROM md_acceptance_export_holds WHERE run_id = ?",
      runId,
    ).first();
    if (hold?.principal_id !== principalId || hold.space_id !== spaceId ||
        hold.expires_at <= instant) fail("export_expiry_hold_mismatch");
    return { phase: "armed", space_id: spaceId, expires_at: hold.expires_at };
  }
  const job = await metadata.readExportJob(input.job_id);
  if (!job || job.requestedByPrincipalId !== principalId ||
      job.spaceId !== spaceId || job.idempotencyKey !== `acceptance-export-expiry:${runId}`) {
    fail("export_expiry_job_mismatch");
  }
  const reservationId = capacityReservationId("export", spaceId, input.job_id);
  const reservation = await metadata.runCapacityTransaction((tx) =>
    tx.readCapacityReservation(reservationId));
  if (!reservation || reservation.requestedByPrincipalId !== principalId ||
      reservation.spaceId !== spaceId || reservation.operationRef !== input.job_id ||
      reservation.heavy !== true || reservation.requested.temporaryBytes <= 0) {
    fail("export_expiry_reservation_mismatch");
  }
  if (input.phase === "inspect") {
    return { phase: "inspected", job_id: input.job_id, job_state: job.state,
      job_expires_at: job.expiresAt, expired_now: Date.parse(job.expiresAt) <= instant,
      archive_cleaned_at: job.archiveCleanedAt,
      reservation_state: reservation.state,
      reserved_temporary_bytes: reservation.requested.temporaryBytes };
  }
  if (job.state === "expired" && job.archiveCleanedAt && reservation.state === "released") {
    return { phase: "recovered", job_id: input.job_id, job_state: job.state,
      archive_cleaned_at: job.archiveCleanedAt, reservation_state: reservation.state,
      replayed: true };
  }
  if (Date.parse(job.expiresAt) > instant || job.state !== "queued" ||
      reservation.state !== "active") fail("export_expiry_not_queued_and_due");
  const hold = await store.statement(
    "SELECT principal_id,space_id,expires_at FROM md_acceptance_export_holds WHERE run_id = ?",
    runId,
  ).first();
  if (hold?.principal_id !== principalId || hold.space_id !== spaceId ||
      hold.expires_at <= instant) fail("export_expiry_hold_missing");
  await recoverBackground();
  const after = await metadata.readExportJob(input.job_id);
  const released = await metadata.runCapacityTransaction((tx) =>
    tx.readCapacityReservation(reservationId));
  if (after?.state !== "expired" || !after.archiveCleanedAt ||
      released?.state !== "released") fail("export_expiry_recovery_incomplete");
  await store.statement("DELETE FROM md_acceptance_export_holds WHERE run_id = ?", runId).run();
  return { phase: "recovered", job_id: input.job_id, job_state: after.state,
    archive_cleaned_at: after.archiveCleanedAt, reservation_state: released.state,
    replayed: false };
}
