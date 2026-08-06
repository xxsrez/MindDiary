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
  McpTokenMetadata,
  McpTokenStore,
  MetadataStore,
  CreateMcpTokenRequest,
  CreateMcpTokenResult,
  CurrentAuthorizationToken,
  RevokeMcpTokenRequest,
  RevokeMcpTokenResult,
  RevokePrincipalTokensForAccountDeletionRequest,
  RevokePrincipalTokensForAccountDeletionResult,
  RetiredHandleMarker,
  RevisionCommitRequest,
  RevisionCommitResult,
  RevisionMetadataStore,
  VerifiedSpaceHost,
  TokenVerifier,
} from "@mind-diary/application-ports";
import {
  isReservedTopLevelHandle,
  isReservedTopLevelRoute,
  parseCanonicalSpaceHandle,
  version,
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

interface StoredMcpToken extends McpTokenMetadata {
  readonly verifier: TokenVerifier;
}

const TOKEN_VERIFIER_PATTERN = /^hmac-sha256:v1:[0-9a-f]{64}$/u;
const TOKEN_DISPLAY_PREFIX_PATTERN = /^mdp_v1_[A-Za-z0-9_-]{6}…$/u;

function validEffectiveScopes(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    ((value.length === 1 && value[0] === "content:read") ||
      (value.length === 2 &&
        value[0] === "content:read" &&
        value[1] === "content:write"))
  );
}

function cloneTokenMetadata(
  token: Readonly<McpTokenMetadata>,
): Readonly<McpTokenMetadata> {
  return Object.freeze({
    tokenId: token.tokenId,
    principalId: token.principalId,
    name: token.name,
    displayPrefix: token.displayPrefix,
    scopes: Object.freeze([...token.scopes]) as McpTokenMetadata["scopes"],
    state: token.state,
    version: token.version,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    lastUsedAt: token.lastUsedAt,
    revokedAt: token.revokedAt,
  });
}

function authorizationToken(
  token: Readonly<StoredMcpToken>,
): Readonly<CurrentAuthorizationToken> {
  return Object.freeze({
    tokenId: token.tokenId,
    principalId: token.principalId,
    state: token.state,
    scopes: Object.freeze([...token.scopes]) as CurrentAuthorizationToken["scopes"],
    version: token.version,
    expiresAt: token.expiresAt,
  });
}

function validTokenCreateRequest(request: CreateMcpTokenRequest): boolean {
  const createdAt = Date.parse(request.createdAt);
  const expiresAt = Date.parse(request.expiresAt);
  return (
    typeof request.tokenId === "string" &&
    request.tokenId.length > 0 &&
    typeof request.principalId === "string" &&
    request.principalId.length > 0 &&
    typeof request.name === "string" &&
    request.name.trim().length > 0 &&
    TOKEN_VERIFIER_PATTERN.test(request.verifier) &&
    TOKEN_DISPLAY_PREFIX_PATTERN.test(request.displayPrefix) &&
    validEffectiveScopes(request.scopes) &&
    Number.isFinite(createdAt) &&
    Number.isFinite(expiresAt) &&
    expiresAt > createdAt
  );
}

/** Deterministic transactional token adapter for local/unit execution. */
export class InMemoryMcpTokenStore implements McpTokenStore {
  readonly kind = "metadata-store" as const;
  readonly #tokensById = new Map<McpTokenMetadata["tokenId"], StoredMcpToken>();
  readonly #tokenIdByVerifier = new Map<TokenVerifier, McpTokenMetadata["tokenId"]>();
  readonly #deletedPrincipals = new Set<McpTokenMetadata["principalId"]>();

  async createMcpToken(
    request: CreateMcpTokenRequest,
  ): Promise<CreateMcpTokenResult> {
    if (!validTokenCreateRequest(request)) {
      return Object.freeze({ kind: "invalid_record" });
    }
    if (this.#deletedPrincipals.has(request.principalId)) {
      return Object.freeze({ kind: "principal_deleted" });
    }
    if (this.#tokensById.has(request.tokenId)) {
      return Object.freeze({ kind: "token_id_conflict" });
    }
    if (this.#tokenIdByVerifier.has(request.verifier)) {
      return Object.freeze({ kind: "verifier_conflict" });
    }

    const stored = Object.freeze({
      tokenId: request.tokenId,
      principalId: request.principalId,
      name: request.name,
      verifier: request.verifier,
      displayPrefix: request.displayPrefix,
      scopes: Object.freeze([...request.scopes]) as McpTokenMetadata["scopes"],
      state: "active" as const,
      version: version(1),
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    });
    // Adjacent synchronous mutations are the in-memory transaction boundary.
    this.#tokensById.set(stored.tokenId, stored);
    this.#tokenIdByVerifier.set(stored.verifier, stored.tokenId);
    return Object.freeze({
      kind: "created",
      token: cloneTokenMetadata(stored),
    });
  }

  async listMcpTokenMetadata(
    principalId: McpTokenMetadata["principalId"],
  ): Promise<readonly Readonly<McpTokenMetadata>[]> {
    const tokens = [...this.#tokensById.values()]
      .filter((token) => token.principalId === principalId)
      .sort((left, right) => {
        const byCreatedAt = Date.parse(right.createdAt) - Date.parse(left.createdAt);
        return byCreatedAt !== 0
          ? byCreatedAt
          : compareUnicodeScalarValues(left.tokenId, right.tokenId);
      })
      .map(cloneTokenMetadata);
    return Object.freeze(tokens);
  }

  async readMcpTokenForAuthorization(
    tokenId: McpTokenMetadata["tokenId"],
  ): Promise<Readonly<CurrentAuthorizationToken> | null> {
    const token = this.#tokensById.get(tokenId);
    return token ? authorizationToken(token) : null;
  }

  async findByVerifier(verifier: TokenVerifier) {
    const tokenId = this.#tokenIdByVerifier.get(verifier);
    const token = tokenId ? this.#tokensById.get(tokenId) : undefined;
    if (!token) return Object.freeze({ kind: "not_found" } as const);
    return Object.freeze({
      kind: "found" as const,
      verifier: token.verifier,
      value: authorizationToken(token),
    });
  }

  async revokeMcpToken(
    request: RevokeMcpTokenRequest,
  ): Promise<RevokeMcpTokenResult> {
    const current = this.#tokensById.get(request.tokenId);
    if (!current || current.principalId !== request.principalId) {
      return Object.freeze({ kind: "not_found" });
    }
    if (current.state === "revoked") {
      return Object.freeze({
        kind: "revoked",
        token: cloneTokenMetadata(current),
        replayed: true,
      });
    }
    const revoked = Object.freeze({
      ...current,
      state: "revoked" as const,
      version: version(current.version + 1),
      revokedAt: request.revokedAt,
    });
    this.#tokensById.set(revoked.tokenId, revoked);
    return Object.freeze({
      kind: "revoked",
      token: cloneTokenMetadata(revoked),
      replayed: false,
    });
  }

  async revokePrincipalTokensForAccountDeletion(
    request: RevokePrincipalTokensForAccountDeletionRequest,
  ): Promise<RevokePrincipalTokensForAccountDeletionResult> {
    const replayed = this.#deletedPrincipals.has(request.principalId);
    this.#deletedPrincipals.add(request.principalId);
    let revokedCount = 0;
    for (const current of this.#tokensById.values()) {
      if (
        current.principalId !== request.principalId ||
        current.state === "revoked"
      ) {
        continue;
      }
      const revoked = Object.freeze({
        ...current,
        state: "revoked" as const,
        version: version(current.version + 1),
        revokedAt: request.revokedAt,
      });
      this.#tokensById.set(revoked.tokenId, revoked);
      revokedCount += 1;
    }
    return Object.freeze({ revokedCount, replayed });
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
