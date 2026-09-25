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
  const principalId = run.actors[0].principal_id;
  const directory = await metadata.listServiceOperatorPrincipals({
    sort: "registered_at", direction: "asc", limit: 2,
  });
  const personal = await metadata.resolvePersonalMind(principalId);
  if (directory.principals.length !== 1 || directory.nextCursor !== null ||
      directory.principals[0].principalId !== principalId ||
      directory.principals[0].ownedMindCount !== 0 ||
      directory.principals[0].participatingMindCount !== 0 ||
      !personal?.spaceId) {
    fail("expired_heavy_product_not_isolated");
  }
  const spaceId = personal.spaceId;
  const operationRef = `acceptance-expired-${runId}`;
  const reservationId = capacityReservationId("export", spaceId, operationRef);
  const successorId = capacityReservationId("import", spaceId, `acceptance-successor-${runId}`);
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
    if (await read(successorId) !== null) fail("expired_heavy_successor_already_present");
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
    // Keep the production cleanup rule, but expose only this run-owned row to it.
    // The ordinary collector scans the whole Site ledger.
    const scopedMetadata = {
      collectExpiredCapacityReservations: async ({ now: cleanupAt, limit }) => {
        if (limit !== 1) fail("expired_heavy_cleanup_scope_mismatch");
        const current = await read(reservationId);
        if (current?.state !== "cleanup_pending" ||
            current.spaceId !== spaceId ||
            current.requestedByPrincipalId !== principalId ||
            Date.parse(current.expiresAt) > Date.parse(cleanupAt)) {
          fail("expired_heavy_cleanup_target_mismatch");
        }
        return [current];
      },
      releaseCapacityReservation: async ({ reservationId: targetId, releasedAt }) => {
        if (targetId !== reservationId) fail("expired_heavy_foreign_release");
        return metadata.releaseCapacityReservation({ reservationId: targetId, releasedAt });
      },
    };
    const capacity = new CapacityAdmissionService({
      metadata: scopedMetadata, clock: { now: () => new Date(instant).toISOString() },
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
  const finalExpired = await read(reservationId);
  const finalSuccessor = await read(successorId);
  if (successor.state !== "released" ||
      finalExpired?.state !== "released" ||
      finalSuccessor?.state !== "released" ||
      reservationId === successorId) fail("expired_heavy_final_state_mismatch");
  return { phase: "recovered", expired_reservation_state: reservation.state,
    successor_state: successor.state, run_reservations_released: true };
}
