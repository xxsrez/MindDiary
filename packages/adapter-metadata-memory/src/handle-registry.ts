import type {
  CanonicalSpaceHandle,
  HandleRegistry,
  HandleReservationRequest,
  HandleReservationResult,
  HandleReservationSnapshot,
  HandleResolutionRequest,
  HandleResolutionResult,
  HandleRetirementRequest,
  HandleRetirementResult,
  RetiredHandleMarker,
  VerifiedSpaceHost,
} from "@mind-diary/application-ports";
import {
  isReservedTopLevelHandle,
  isReservedTopLevelRoute,
  parseCanonicalSpaceHandle,
} from "@mind-diary/application-ports";
import {
  compareUnicodeScalarValues,
} from "./metadata-store-internals.js";

export type HandleSpaceId = HandleReservationSnapshot["spaceId"];

export interface InMemoryHandleRegistrySnapshot {
  readonly reservations: readonly Readonly<HandleReservationSnapshot>[];
  readonly retiredMarkers: readonly Readonly<RetiredHandleMarker>[];
}

export const HANDLE_UNAVAILABLE = Object.freeze({ kind: "handle_unavailable" } as const);
export const HANDLE_NOT_FOUND = Object.freeze({ kind: "not_found" } as const);

export function handleKey(
  host: VerifiedSpaceHost,
  handle: CanonicalSpaceHandle,
): string {
  return `${host}\u0000${handle}`;
}

export function freezeReservation(
  host: VerifiedSpaceHost,
  canonicalHandle: CanonicalSpaceHandle,
  spaceId: HandleSpaceId,
): Readonly<HandleReservationSnapshot> {
  return Object.freeze({ host, canonicalHandle, spaceId });
}

export function freezeRetiredMarker(
  host: VerifiedSpaceHost,
  canonicalHandle: CanonicalSpaceHandle,
): Readonly<RetiredHandleMarker> {
  return Object.freeze({ host, canonicalHandle });
}

export type ActiveHandleByKeyMap = Map<
  string,
  Readonly<HandleReservationSnapshot>
>;
export type ActiveHandleBySpaceMap = Map<
  HandleSpaceId,
  Readonly<HandleReservationSnapshot>
>;
export type RetiredHandleMap = Map<string, Readonly<RetiredHandleMarker>>;

export interface MutableHandleRegistryState {
  readonly activeByHandle: ActiveHandleByKeyMap;
  readonly activeBySpace: ActiveHandleBySpaceMap;
  readonly retired: RetiredHandleMap;
}

export function reserveHandleAgainst(
  request: HandleReservationRequest,
  state: MutableHandleRegistryState,
): HandleReservationResult {
  if (isReservedTopLevelRoute(request.handle)) return HANDLE_UNAVAILABLE;
  const parsed = parseCanonicalSpaceHandle(request.handle);
  if (parsed.kind === "invalid") {
    return Object.freeze({
      kind: "invalid_handle",
      reason: parsed.reason,
    });
  }

  const canonicalHandle = parsed.canonicalHandle;
  const key = handleKey(request.host, canonicalHandle);
  if (isReservedTopLevelHandle(canonicalHandle) || state.retired.has(key)) {
    return HANDLE_UNAVAILABLE;
  }

  const occupied = state.activeByHandle.get(key);
  if (occupied) {
    if (occupied.spaceId === request.spaceId) {
      return Object.freeze({
        kind: "reserved",
        reservation: occupied,
        replayed: true,
      });
    }
    return HANDLE_UNAVAILABLE;
  }

  const currentIdentity = state.activeBySpace.get(request.spaceId);
  if (currentIdentity) return Object.freeze({ kind: "immutable_handle" });

  const reservation = freezeReservation(
    request.host,
    canonicalHandle,
    request.spaceId,
  );
  state.activeByHandle.set(key, reservation);
  state.activeBySpace.set(request.spaceId, reservation);
  return Object.freeze({ kind: "reserved", reservation, replayed: false });
}

export function resolveHandleAgainst(
  request: HandleResolutionRequest,
  state: Pick<MutableHandleRegistryState, "activeByHandle">,
): HandleResolutionResult {
  const parsed = parseCanonicalSpaceHandle(request.handle);
  if (parsed.kind === "invalid") return HANDLE_NOT_FOUND;
  const reservation = state.activeByHandle.get(
    handleKey(request.host, parsed.canonicalHandle),
  );
  return reservation
    ? Object.freeze({ kind: "resolved", spaceId: reservation.spaceId })
    : HANDLE_NOT_FOUND;
}

export function retireHandleAgainst(
  request: HandleRetirementRequest,
  state: MutableHandleRegistryState,
): HandleRetirementResult {
  const parsed = parseCanonicalSpaceHandle(request.handle);
  if (parsed.kind === "invalid") return HANDLE_NOT_FOUND;
  const key = handleKey(request.host, parsed.canonicalHandle);
  const reservation = state.activeByHandle.get(key);
  if (!reservation || reservation.spaceId !== request.spaceId) {
    return HANDLE_NOT_FOUND;
  }

  const marker = freezeRetiredMarker(request.host, parsed.canonicalHandle);
  state.activeByHandle.delete(key);
  state.activeBySpace.delete(request.spaceId);
  state.retired.set(key, marker);
  return Object.freeze({ kind: "retired", marker });
}

export class InMemoryHandleRegistry implements HandleRegistry {
  readonly kind = "metadata-store" as const;
  readonly #activeByHandle = new Map<string, Readonly<HandleReservationSnapshot>>();
  readonly #activeBySpace = new Map<HandleSpaceId, Readonly<HandleReservationSnapshot>>();
  readonly #retired = new Map<string, Readonly<RetiredHandleMarker>>();

  async reserveHandle(
    request: HandleReservationRequest,
  ): Promise<HandleReservationResult> {
    return reserveHandleAgainst(request, {
      activeByHandle: this.#activeByHandle,
      activeBySpace: this.#activeBySpace,
      retired: this.#retired,
    });
  }

  async resolveHandle(
    request: HandleResolutionRequest,
  ): Promise<HandleResolutionResult> {
    return resolveHandleAgainst(request, {
      activeByHandle: this.#activeByHandle,
    });
  }

  async retireHandle(
    request: HandleRetirementRequest,
  ): Promise<HandleRetirementResult> {
    return retireHandleAgainst(request, {
      activeByHandle: this.#activeByHandle,
      activeBySpace: this.#activeBySpace,
      retired: this.#retired,
    });
  }

  snapshot(): Readonly<InMemoryHandleRegistrySnapshot> {
    const reservations = [...this.#activeByHandle.values()]
      .map((reservation) => freezeReservation(
        reservation.host,
        reservation.canonicalHandle,
        reservation.spaceId,
      ))
      .sort((left, right) =>
        compareUnicodeScalarValues(
          `${left.host}/${left.canonicalHandle}`,
          `${right.host}/${right.canonicalHandle}`,
        ));
    const retiredMarkers = [...this.#retired.values()]
      .map((marker) => freezeRetiredMarker(marker.host, marker.canonicalHandle))
      .sort((left, right) =>
        compareUnicodeScalarValues(
          `${left.host}/${left.canonicalHandle}`,
          `${right.host}/${right.canonicalHandle}`,
        ));
    return Object.freeze({
      reservations: Object.freeze(reservations),
      retiredMarkers: Object.freeze(retiredMarkers),
    });
  }
}
