import type {
  CanonicalRevisionEnvelope,
  CanonicalSpaceHandle,
  HandleRegistry,
  HandleReservationRequest,
  HandleReservationResult,
  HandleResolutionRequest,
  HandleResolutionResult,
  HandleRetirementRequest,
  HandleRetirementResult,
  HandleReservationSnapshot,
  MetadataStore,
  RetiredHandleMarker,
  RevisionCommitRequest,
  RevisionCommitResult,
  RevisionMetadataStore,
  VerifiedSpaceHost,
} from "@mind-diary/application-ports";
import {
  isReservedTopLevelHandle,
  isReservedTopLevelRoute,
  parseCanonicalSpaceHandle,
} from "@mind-diary/application-ports";

export const METADATA_ADAPTER = "memory-revision-envelope" as const;
export type MetadataAdapterContract = MetadataStore;

type Envelope = Readonly<CanonicalRevisionEnvelope>;
type RevisionId = Envelope["revision"]["revisionId"];
type SpaceId = Envelope["revision"]["spaceId"];
type Digest = Envelope["revision"]["manifestHash"];
type HandleSpaceId = HandleReservationSnapshot["spaceId"];

interface SpaceState {
  head: RevisionId | null;
  revisions: Map<RevisionId, Envelope>;
}

export interface InMemoryHandleRegistrySnapshot {
  readonly reservations: readonly Readonly<HandleReservationSnapshot>[];
  readonly retiredMarkers: readonly Readonly<RetiredHandleMarker>[];
}

const HANDLE_UNAVAILABLE = Object.freeze({ kind: "handle_unavailable" } as const);
const HANDLE_NOT_FOUND = Object.freeze({ kind: "not_found" } as const);

function handleKey(
  host: VerifiedSpaceHost,
  handle: CanonicalSpaceHandle,
): string {
  return `${host}\u0000${handle}`;
}

function freezeReservation(
  host: VerifiedSpaceHost,
  canonicalHandle: CanonicalSpaceHandle,
  spaceId: HandleSpaceId,
): Readonly<HandleReservationSnapshot> {
  return Object.freeze({ host, canonicalHandle, spaceId });
}

function freezeRetiredMarker(
  host: VerifiedSpaceHost,
  canonicalHandle: CanonicalSpaceHandle,
): Readonly<RetiredHandleMarker> {
  return Object.freeze({ host, canonicalHandle });
}

export class InMemoryHandleRegistry implements HandleRegistry {
  readonly kind = "metadata-store" as const;
  readonly #activeByHandle = new Map<string, Readonly<HandleReservationSnapshot>>();
  readonly #activeBySpace = new Map<HandleSpaceId, Readonly<HandleReservationSnapshot>>();
  readonly #retired = new Map<string, Readonly<RetiredHandleMarker>>();

  async reserveHandle(
    request: HandleReservationRequest,
  ): Promise<HandleReservationResult> {
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
    if (isReservedTopLevelHandle(canonicalHandle) || this.#retired.has(key)) {
      return HANDLE_UNAVAILABLE;
    }

    const occupied = this.#activeByHandle.get(key);
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

    const currentIdentity = this.#activeBySpace.get(request.spaceId);
    if (currentIdentity) {
      return Object.freeze({ kind: "immutable_handle" });
    }

    const reservation = freezeReservation(
      request.host,
      canonicalHandle,
      request.spaceId,
    );
    // Adjacent synchronous writes are the in-memory transaction boundary.
    this.#activeByHandle.set(key, reservation);
    this.#activeBySpace.set(request.spaceId, reservation);
    return Object.freeze({ kind: "reserved", reservation, replayed: false });
  }

  async resolveHandle(
    request: HandleResolutionRequest,
  ): Promise<HandleResolutionResult> {
    const parsed = parseCanonicalSpaceHandle(request.handle);
    if (parsed.kind === "invalid") return HANDLE_NOT_FOUND;
    const reservation = this.#activeByHandle.get(
      handleKey(request.host, parsed.canonicalHandle),
    );
    if (!reservation) return HANDLE_NOT_FOUND;
    return Object.freeze({ kind: "resolved", spaceId: reservation.spaceId });
  }

  async retireHandle(
    request: HandleRetirementRequest,
  ): Promise<HandleRetirementResult> {
    const parsed = parseCanonicalSpaceHandle(request.handle);
    if (parsed.kind === "invalid") return HANDLE_NOT_FOUND;
    const key = handleKey(request.host, parsed.canonicalHandle);
    const reservation = this.#activeByHandle.get(key);
    if (!reservation || reservation.spaceId !== request.spaceId) {
      return HANDLE_NOT_FOUND;
    }

    const marker = freezeRetiredMarker(request.host, parsed.canonicalHandle);
    // Remove every linkable identity before retaining the minimal marker.
    this.#activeByHandle.delete(key);
    this.#activeBySpace.delete(request.spaceId);
    this.#retired.set(key, marker);
    return Object.freeze({ kind: "retired", marker });
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

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MARKDOWN_MEDIA_TYPE = "text/markdown; charset=utf-8";
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const ENCODED_SEPARATOR = /%(?:2f|5c)/iu;

function compareUnicodeScalarValues(left: string, right: string): number {
  const leftPoints = [...left].map((value) => value.codePointAt(0)!);
  const rightPoints = [...right].map((value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function validPath(path: string): boolean {
  const segments = path.split("/");
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !CONTROL_CHARACTER.test(path) &&
    !ENCODED_SEPARATOR.test(path) &&
    segments.every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    ) &&
    path.endsWith(".md")
  );
}

function canonicalManifestSource(envelope: Envelope): string | null {
  const entries = envelope.manifest.entries;
  const sorted = [...entries].sort((left, right) =>
    compareUnicodeScalarValues(left.path, right.path),
  );
  const seen = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (
      entry !== sorted[index] ||
      seen.has(entry.path) ||
      !validPath(entry.path) ||
      !SHA256_PATTERN.test(entry.sha256) ||
      entry.mediaType !== MARKDOWN_MEDIA_TYPE ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    ) {
      return null;
    }
    seen.add(entry.path);
  }
  return `${JSON.stringify({
    format: "mind-diary-revision-manifest-v1",
    entries: entries.map((entry) => ({
      path: entry.path,
      sha256: entry.sha256,
      media_type: entry.mediaType,
      size: entry.size,
    })),
  })}\n`;
}

async function sha256(source: string): Promise<string> {
  const bytes = new TextEncoder().encode(source);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function envelopesEqual(left: Envelope, right: Envelope): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneEnvelope(envelope: Envelope): Envelope {
  const entries = envelope.manifest.entries.map((entry) => Object.freeze({ ...entry }));
  return Object.freeze({
    revision: Object.freeze({
      ...envelope.revision,
      committedBy: Object.freeze({ ...envelope.revision.committedBy }),
    }),
    manifest: Object.freeze({ entries: Object.freeze(entries) }),
  });
}

export class InMemoryRevisionMetadataStore implements RevisionMetadataStore {
  readonly kind = "metadata-store" as const;
  readonly #spaces = new Map<SpaceId, SpaceState>();
  readonly #revisionsById = new Map<RevisionId, Envelope>();
  #nextCommitFailure: Error | null = null;

  async readHead(spaceId: SpaceId): Promise<RevisionId | null> {
    return this.#spaces.get(spaceId)?.head ?? null;
  }

  async readRevision(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<Envelope | null> {
    return this.#spaces.get(spaceId)?.revisions.get(revisionId) ?? null;
  }

  async listRevisions(spaceId: SpaceId): Promise<readonly Envelope[]> {
    const revisions = [...(this.#spaces.get(spaceId)?.revisions.values() ?? [])];
    revisions.sort(
      (left, right) =>
        left.revision.revisionNumber - right.revision.revisionNumber,
    );
    return Object.freeze(revisions);
  }

  async commitRevision(request: RevisionCommitRequest): Promise<RevisionCommitResult> {
    const envelope = request.envelope;
    const revision = envelope.revision;
    const manifestSource = canonicalManifestSource(envelope);
    if (
      manifestSource === null ||
      !SHA256_PATTERN.test(revision.manifestHash) ||
      (await sha256(manifestSource)) !== revision.manifestHash
    ) {
      return Object.freeze({
        kind: "invalid_revision_chain",
        reason: "manifest_hash_mismatch",
      });
    }

    const existingGlobal = this.#revisionsById.get(revision.revisionId);
    if (existingGlobal) {
      if (envelopesEqual(existingGlobal, envelope)) {
        return Object.freeze({
          kind: "committed",
          envelope: existingGlobal,
          replayed: true,
        });
      }
      return Object.freeze({ kind: "revision_id_collision" });
    }

    const state = this.#spaces.get(revision.spaceId);
    const expected = request.expectedHeadRevisionId;
    if (revision.parentRevisionId !== expected) {
      return Object.freeze({
        kind: "invalid_revision_chain",
        reason: "parent_mismatch",
      });
    }

    if (expected === null) {
      if (revision.revisionNumber !== 1) {
        return Object.freeze({
          kind: "invalid_revision_chain",
          reason: "revision_number_mismatch",
        });
      }
    } else {
      const parent = state?.revisions.get(expected);
      if (!parent) {
        return Object.freeze({
          kind: "invalid_revision_chain",
          reason: "missing_parent",
        });
      }
      if (revision.revisionNumber !== parent.revision.revisionNumber + 1) {
        return Object.freeze({
          kind: "invalid_revision_chain",
          reason: "revision_number_mismatch",
        });
      }
    }

    const currentHead = state?.head ?? null;
    if (currentHead !== expected) {
      return Object.freeze({
        kind: "stale_head",
        currentHeadRevisionId: currentHead,
      });
    }
    if (this.#nextCommitFailure) {
      const failure = this.#nextCommitFailure;
      this.#nextCommitFailure = null;
      throw failure;
    }

    const stored = cloneEnvelope(envelope);
    const nextState = state ?? { head: null, revisions: new Map<RevisionId, Envelope>() };
    // These adjacent synchronous mutations are the in-memory transaction boundary.
    nextState.revisions.set(revision.revisionId, stored);
    nextState.head = revision.revisionId;
    this.#spaces.set(revision.spaceId, nextState);
    this.#revisionsById.set(revision.revisionId, stored);
    return Object.freeze({ kind: "committed", envelope: stored, replayed: false });
  }

  async listReachableObjectDigests(): Promise<readonly Digest[]> {
    const reachable = new Set<Digest>();
    for (const revision of this.#revisionsById.values()) {
      for (const entry of revision.manifest.entries) reachable.add(entry.sha256);
    }
    return Object.freeze([...reachable].sort());
  }

  failNextCommitForTest(
    error: Error = new Error("injected revision metadata transaction failure"),
  ): void {
    this.#nextCommitFailure = error;
  }
}
