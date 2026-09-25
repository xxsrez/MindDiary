import type { ActorContext } from "@mind-diary/application-contracts";
import type {
  Authorizer,
  CapacityAdmissionRequest,
  CapacityAdmissionResult,
  CapacityAmounts,
  CapacityLedgerStore,
  CapacityLimits,
  CapacityTelemetrySnapshot,
  CapacityUsageSnapshot,
  CapacityUtilizationState,
  Clock,
} from "@mind-diary/application-ports";
import {
  idempotencyKey,
  type IdempotencyKey,
  type RevisionId,
  type SpaceId,
  type UtcInstant,
} from "@mind-diary/domain";

export const DEFAULT_CAPACITY_LIMITS: Readonly<CapacityLimits> = Object.freeze({
  mindPhysicalCanonicalBytes: 2_147_483_648,
  principalPhysicalCanonicalBytes: 8_589_934_592,
  sitePhysicalCanonicalBytes: 34_359_738_368,
  siteTemporaryBytes: 8_589_934_592,
  siteD1MetadataBytes: 536_870_912,
  ordinaryCommitSoftGrowthBytes: 4_194_304,
  activeHeavyPerMind: 1,
  activeHeavyPerPrincipal: 2,
  activeHeavyPerSite: 8,
});

export const CAPACITY_RESERVATION_TTL_MS = Object.freeze({
  commit: 15 * 60 * 1_000,
  stage: 60 * 60 * 1_000,
  export: 24 * 60 * 60 * 1_000,
  import: 24 * 60 * 60 * 1_000,
});

export const ZERO_CAPACITY_REQUEST: Readonly<CapacityAmounts> = Object.freeze({
  physicalCanonicalBytes: 0,
  temporaryBytes: 0,
  d1MetadataBytes: 0,
});

const CAPACITY_STATE_RANK: Readonly<Record<CapacityUtilizationState, number>> =
  Object.freeze({
    normal: 0,
    warning: 1,
    soft_limit: 2,
    hard_limit: 3,
  });

function utilizationForRatio(ratio: number): CapacityUtilizationState {
  if (ratio >= 1) return "hard_limit";
  if (ratio >= 0.85) return "soft_limit";
  if (ratio >= 0.7) return "warning";
  return "normal";
}

function highestUtilization(
  states: readonly CapacityUtilizationState[],
): CapacityUtilizationState {
  return states.reduce((highest, state) =>
    CAPACITY_STATE_RANK[state] > CAPACITY_STATE_RANK[highest]
      ? state
      : highest, "normal");
}

function validateCapacityLimits(limits: Readonly<CapacityLimits>): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError("capacity limits must be positive safe integers");
    }
  }
}

export function capacityExpiry(
  operation: keyof typeof CAPACITY_RESERVATION_TTL_MS,
  createdAt: UtcInstant,
): UtcInstant {
  return new Date(
    Date.parse(createdAt) + CAPACITY_RESERVATION_TTL_MS[operation],
  ).toISOString() as UtcInstant;
}

export function capacityReservationId(
  operation: keyof typeof CAPACITY_RESERVATION_TTL_MS,
  spaceId: SpaceId,
  operationRef: string,
): string {
  return `capacity:${operation}:${spaceId}:${operationRef}`;
}

export function capacityOperationKey(
  operation: keyof typeof CAPACITY_RESERVATION_TTL_MS,
  value: string,
): IdempotencyKey {
  return idempotencyKey(`capacity:${operation}:${value}`);
}

export interface ReserveCapacityRequest {
  readonly actor: Extract<ActorContext, { readonly kind: "registered_principal" }>;
  readonly spaceId: SpaceId;
  readonly operation: CapacityAdmissionRequest["operation"];
  readonly operationRef: string;
  /** Optional stable claim identity when operationRef is a payload fingerprint. */
  readonly reservationId?: string;
  readonly baseRevisionId: RevisionId | null;
  readonly idempotencyKey: IdempotencyKey;
  readonly requested: Readonly<CapacityAmounts>;
  readonly bulk: boolean;
  readonly heavy: boolean;
  readonly createdAt: UtcInstant;
}

/** Thin application boundary shared by content and future import orchestration. */
export class CapacityAdmissionService {
  readonly #metadata: CapacityLedgerStore;
  readonly #limits: Readonly<CapacityLimits>;
  readonly #clock: Clock;
  readonly #authorizer: Authorizer;

  constructor(dependencies: {
    readonly metadata: CapacityLedgerStore;
    readonly limits?: Readonly<CapacityLimits>;
    readonly clock: Clock;
    readonly authorizer: Authorizer;
  }) {
    this.#metadata = dependencies.metadata;
    this.#limits = dependencies.limits ?? DEFAULT_CAPACITY_LIMITS;
    validateCapacityLimits(this.#limits);
    this.#clock = dependencies.clock;
    this.#authorizer = dependencies.authorizer;
  }

  reserve(request: ReserveCapacityRequest): Promise<CapacityAdmissionResult> {
    return this.#metadata.runCapacityTransaction((transaction) =>
      transaction.admitCapacityReservation(Object.freeze({
        reservationId: request.reservationId ?? capacityReservationId(
          request.operation,
          request.spaceId,
          request.operationRef,
        ),
        attemptId: crypto.randomUUID(),
        requireActiveWritablePrincipal: request.operation === "commit",
        authorizationTokenId: request.actor.authentication.kind === "mcp_token"
          ? request.actor.authentication.tokenId
          : null,
        requestedByPrincipalId: request.actor.principalId,
        spaceId: request.spaceId,
        operation: request.operation,
        operationRef: request.operationRef,
        baseRevisionId: request.baseRevisionId,
        idempotencyKey: request.idempotencyKey,
        requested: Object.freeze({ ...request.requested }),
        bulk: request.bulk,
        heavy: request.heavy,
        createdAt: request.createdAt,
        expiresAt: capacityExpiry(request.operation, request.createdAt),
      }), this.#limits),
    );
  }

  async cancel(reservationId: string): Promise<void> {
    const canceledAt = this.#clock.now();
    await this.#metadata.runCapacityTransaction(async (transaction) => {
      await transaction.cancelCapacityReservation({ reservationId, canceledAt });
    });
  }

  async readMindUsage(request: Readonly<{
    actor: ActorContext;
    spaceId: SpaceId;
  }>){
    const decision = await this.#authorizer.authorize({
      actor: request.actor,
      spaceId: request.spaceId,
      capability: "settings:configure",
      revisionMode: "head",
    });
    if (decision.kind === "denied") {
      return Object.freeze({ kind: "denied" as const, decision });
    }
    if (
      request.actor.kind !== "registered_principal" ||
      decision.grant.kind !== "membership" ||
      decision.grant.role !== "owner"
    ) {
      return Object.freeze({ kind: "denied" as const, decision });
    }
    const usage = await this.#metadata.readMindCapacityUsage(request.spaceId);
    if (usage === null) return Object.freeze({ kind: "not_found" as const });
    const [principalUsage, siteTelemetry] = await Promise.all([
      this.#metadata.readPrincipalCapacityUsage(request.actor.principalId),
      this.#metadata.readCapacityTelemetry(this.#limits, this.#clock.now()),
    ]);
    return Object.freeze({
      kind: "found" as const,
      usage,
      principalUsage,
      mindCanonicalHeadroomBytes: Math.max(
        0,
        this.#limits.mindPhysicalCanonicalBytes - usage.physicalCanonicalBytes,
      ),
      principalCanonicalHeadroomBytes: Math.max(
        0,
        this.#limits.principalPhysicalCanonicalBytes -
          principalUsage.physicalCanonicalBytes,
      ),
      utilization: highestUtilization([
        utilizationForRatio(
          usage.physicalCanonicalBytes /
            this.#limits.mindPhysicalCanonicalBytes,
        ),
        utilizationForRatio(
          principalUsage.physicalCanonicalBytes /
            this.#limits.principalPhysicalCanonicalBytes,
        ),
        siteTelemetry.utilization,
      ]),
    });
  }

  readSiteUsage(): Promise<Readonly<CapacityUsageSnapshot>> {
    return this.#metadata.readSiteCapacityUsage();
  }

  telemetry(): Promise<Readonly<CapacityTelemetrySnapshot>> {
    return this.#metadata.readCapacityTelemetry(this.#limits, this.#clock.now());
  }

  reconcile(spaceId?: SpaceId) {
    return this.#metadata.reconcileCapacityUsage({
      ...(spaceId === undefined ? {} : { spaceId }),
      reconciledAt: this.#clock.now(),
    });
  }

  async cleanupExpired(limit = 100): Promise<Readonly<{
    scanned: number;
    released: number;
  }>> {
    const now = this.#clock.now();
    const expired = await this.#metadata.collectExpiredCapacityReservations({
      now,
      limit,
    });
    let released = 0;
    for (const reservation of expired) {
      // Actual temporary-object deletion belongs to the staging/export/import
      // collector. Zero-temporary reservations can be finalized here.
      if (
        reservation.requested.temporaryBytes === 0 &&
        reservation.requested.physicalCanonicalBytes === 0 &&
        await this.#metadata.releaseCapacityReservation({
          reservationId: reservation.reservationId,
          releasedAt: now,
        })
      ) released += 1;
    }
    return Object.freeze({ scanned: expired.length, released });
  }
}
