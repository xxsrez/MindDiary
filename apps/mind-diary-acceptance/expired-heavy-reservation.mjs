import { createSitesMetadataStore } from "../../packages/adapter-metadata-sites/dist/index.js";
import {
  CAPACITY_RESERVATION_TTL_MS,
  CapacityAdmissionService,
  DEFAULT_CAPACITY_LIMITS,
  capacityReservationId,
} from "../../packages/application-content/dist/index.js";

const fail = (code) => { throw new Error(code); };
const ZERO = Object.freeze({ physicalCanonicalBytes: 0, temporaryBytes: 0, d1MetadataBytes: 1 });

// This probes only the durable capacity ledger of one synthetic operator run.
// The old timestamp belongs to its reservation, never to the Site clock.
export async function expiredHeavyReservation(store, runId, input, environment, {
  createMetadata = createSitesMetadataStore,
  now = () => Date.now(),
} = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).join(",") !== "phase" ||
      !["seed", "recover"].includes(input.phase)) fail("expired_heavy_invalid_request");
  const run = await store.run(runId);
  const instant = now();
  if (run.profile !== "operator" || run.state !== "active" ||
      run.expires_at <= instant || run.actors.length !== 4 ||
      !run.actors[0].principal_id ||
      run.actors.slice(1).some((actor) => actor.principal_id !== null)) {
    fail("expired_heavy_run_not_isolated");
  }
  const otherRuns = await store.statement(
    "SELECT COUNT(*) AS count FROM md_acceptance_runs WHERE id != ? AND state != 'cleaned'",
    runId,
  ).first();
  if (otherRuns.count !== 0) fail("expired_heavy_other_run_present");

  const metadata = await createMetadata(environment.DB);
  const snapshot = (await metadata.captureSystemBackupState()).snapshot;
  const principalId = run.actors[0].principal_id;
  const spaceId = snapshot.personalBindings?.get(principalId)?.spaceId;
  if (!(snapshot.principals instanceof Map) || snapshot.principals.size !== 1 ||
      !snapshot.principals.has(principalId) ||
      !(snapshot.spaces instanceof Map) || snapshot.spaces.size !== 1 ||
      !snapshot.spaces.has(spaceId) ||
      !(snapshot.knowledgeSpaces instanceof Map) || snapshot.knowledgeSpaces.size !== 1 ||
      !snapshot.knowledgeSpaces.has(spaceId) ||
      !(snapshot.capacityReservations instanceof Map) ||
      !(snapshot.exportJobs instanceof Map) || snapshot.exportJobs.size !== 0 ||
      !(snapshot.markdownImportSessions instanceof Map) || snapshot.markdownImportSessions.size !== 0) {
    fail("expired_heavy_product_not_isolated");
  }
  const operationRef = `acceptance-expired-${runId}`;
  const reservationId = capacityReservationId("export", spaceId, operationRef);
  const successorId = capacityReservationId("import", spaceId, `acceptance-successor-${runId}`);
  if ([...snapshot.capacityReservations.values()].some((reservation) =>
    reservation.reservationId !== reservationId &&
    reservation.reservationId !== successorId &&
    (reservation.state === "active" || reservation.state === "cleanup_pending"))) {
    fail("expired_heavy_foreign_reservation");
  }
  const createdAt = new Date(run.created_at - CAPACITY_RESERVATION_TTL_MS.export - 60_000).toISOString();
  const expiresAt = new Date(run.created_at - 60_000).toISOString();
  const request = Object.freeze({
    reservationId, requestedByPrincipalId: principalId, spaceId,
    operation: "export", operationRef, baseRevisionId: null,
    idempotencyKey: `acceptance-expired:${runId}`, requested: ZERO,
    bulk: true, heavy: true, createdAt, expiresAt,
  });
  const read = async (id) => metadata.runCapacityTransaction((tx) => tx.readCapacityReservation(id));
  if (input.phase === "seed") {
    if (snapshot.capacityReservations.has(successorId)) fail("expired_heavy_successor_already_present");
    let reservation = await read(reservationId);
    if (reservation === null) {
      const result = await metadata.runCapacityTransaction((tx) =>
        tx.admitCapacityReservation(request, DEFAULT_CAPACITY_LIMITS));
      if (result.kind !== "admitted" || result.replayed) fail("expired_heavy_admission_failed");
      reservation = result.reservation;
    }
    if (reservation.state !== "active" || reservation.expiresAt !== expiresAt ||
        reservation.requestedByPrincipalId !== principalId ||
        reservation.spaceId !== spaceId || reservation.operationRef !== operationRef ||
        reservation.heavy !== true || reservation.requested.temporaryBytes !== 0) {
      fail("expired_heavy_seed_mismatch");
    }
    return { phase: "seeded", reservation_id: reservationId, state: reservation.state,
      expires_at: reservation.expiresAt, expired_at_seed: Date.parse(reservation.expiresAt) <= instant };
  }

  let reservation = await read(reservationId);
  if (reservation === null || reservation.spaceId !== spaceId ||
      reservation.requestedByPrincipalId !== principalId ||
      reservation.expiresAt !== expiresAt || Date.parse(expiresAt) > instant) {
    fail("expired_heavy_seed_missing");
  }
  if (reservation.state === "active") {
    const retry = await metadata.runCapacityTransaction((tx) =>
      tx.admitCapacityReservation({ ...request,
        createdAt: new Date(instant).toISOString(),
        expiresAt: new Date(instant + CAPACITY_RESERVATION_TTL_MS.export).toISOString(),
      }, DEFAULT_CAPACITY_LIMITS));
    if (retry.kind !== "rejected" || retry.reason !== "accounting_untrusted") {
      fail("expired_heavy_stale_retry_not_rejected");
    }
    reservation = await read(reservationId);
  }
  if (reservation.state === "cleanup_pending") {
    const capacity = new CapacityAdmissionService({
      metadata, clock: { now: () => new Date(instant).toISOString() },
      authorizer: { authorize: () => fail("expired_heavy_authorization_unexpected") },
    });
    const cleanup = await capacity.cleanupExpired(1);
    if (cleanup.scanned !== 1 || cleanup.released !== 1) fail("expired_heavy_cleanup_failed");
    reservation = await read(reservationId);
  }
  if (reservation.state !== "released") fail("expired_heavy_not_released");

  let successor = await read(successorId);
  if (successor === null) {
    const result = await metadata.runCapacityTransaction((tx) =>
      tx.admitCapacityReservation({
        ...request, reservationId: successorId, operation: "import",
        operationRef: `acceptance-successor-${runId}`,
        idempotencyKey: `acceptance-successor:${runId}`,
        createdAt: new Date(instant).toISOString(),
        expiresAt: new Date(instant + CAPACITY_RESERVATION_TTL_MS.import).toISOString(),
      }, DEFAULT_CAPACITY_LIMITS));
    if (result.kind !== "admitted" || result.replayed) fail("expired_heavy_successor_denied");
    successor = result.reservation;
  }
  if (successor.state === "active") {
    const canceled = await metadata.runCapacityTransaction((tx) =>
      tx.cancelCapacityReservation({ reservationId: successorId,
        canceledAt: new Date(instant).toISOString() }));
    if (canceled !== "cleanup_pending") fail("expired_heavy_successor_cancel_failed");
    successor = await read(successorId);
  }
  if (successor.state === "cleanup_pending") {
    if (!await metadata.releaseCapacityReservation({ reservationId: successorId,
      releasedAt: new Date(instant).toISOString() })) fail("expired_heavy_successor_release_failed");
    successor = await read(successorId);
  }
  const final = (await metadata.listCapacityReservationsForTest()).filter((item) =>
    item.reservationId === reservationId || item.reservationId === successorId);
  if (successor.state !== "released" || final.length !== 2 ||
      final.some((item) => item.state !== "released")) fail("expired_heavy_final_state_mismatch");
  return { phase: "recovered", expired_reservation_state: reservation.state,
    successor_state: successor.state, reservation_count: final.length,
    duplicate_reservations: false };
}
