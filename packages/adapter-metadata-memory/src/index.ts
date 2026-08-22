import type {
  CanonicalRevisionEnvelope,
  CanonicalSpaceHandle,
  AccountBootstrapRecordSet,
  AccountBootstrapTransaction,
  AccountDeletionCleanupWorkItem,
  AccountDeletionContext,
  AccountDeletionImpactSnapshot,
  AccountDeletionStore,
  ApplyMembershipMutationRequest,
  ApplyMembershipMutationResult,
  ApplyMindBindingMutationResult,
  ApplyAutomaticCapturePolicyRequest,
  ApplyReadMindBindingRequest,
  ApplyWriteMindBindingRequest,
  BeginPrincipalTokenDeletionRequest,
  BeginPrincipalTokenDeletionResult,
  CancelPrincipalTokenDeletionRequest,
  CompleteAccountDeletionCleanupRequest,
  CompleteAccountDeletionCleanupResult,
  CompletePrincipalTokenDeletionRequest,
  CompletePrincipalTokenDeletionResult,
  ControlInvitationProjection,
  ControlMemberProjection,
  ControlReadStore,
  CreateAccountBootstrapResult,
  CreateAccountDeletionImpactRequest,
  CreateAccountDeletionImpactResult,
  CreateInvitationRequest,
  CreateInvitationResult,
  TransitionInvitationRequest,
  TransitionInvitationResult,
  ReissueInvitationRequest,
  ReissueInvitationResult,
  InvitationLifecycleSnapshot,
  ClaimInvitationExpiryJobResult,
  CompleteInvitationExpiryJobResult,
  ExternalIdentityBinding,
  ExternalIdentityBindingLookup,
  KnowledgeSpace,
  PersonalMindResolution,
  PersonalMindMetadataTransaction,
  PersonalMindProfileSnapshot,
  PersonalMindStore,
  PersonalMindTargetClassification,
  PersonalMindTargetRequest,
  PersonalSpaceBinding,
  Principal,
  PrincipalId,
  PrincipalAccountSnapshot,
  RegisteredPrincipalSnapshot,
  SpaceInvitation,
  SpaceMembership,
  AuthorizationStateQuery,
  AuditEvent,
  AuditOutboxMessage,
  BackgroundJob,
  CheckIdempotencyRequest,
  CheckIdempotencyResult,
  CompleteIdempotencyRequest,
  CompleteIdempotencyResult,
  ClaimAuditOutboxResult,
  ClaimExportJobResult,
  ClaimIndexJobResult,
  ContentCommitMetadataStore,
  ContentCommitMetadataTransaction,
  CurrentAuthorizationState,
  HandleRegistry,
  HandleReservationRequest,
  HandleReservationResult,
  HandleResolutionRequest,
  HandleResolutionResult,
  HandleRetirementRequest,
  HandleRetirementResult,
  HandleReservationSnapshot,
  IdempotencyNamespace,
  IdempotencyRecord,
  InvitationSnapshot,
  JobId,
  McpTokenMetadata,
  McpTokenStore,
  MindBindingOwnerId,
  MindBindingSet,
  MindBindingSetSnapshot,
  MindBindingStore,
  MindBindingTransaction,
  MembershipControlStore,
  MembershipControlTargetQuery,
  MembershipControlTransaction,
  MembershipMutationReplayRequest,
  MembershipMutationReplayResult,
  MetadataStore,
  MindRouteAuthorizationQuery,
  PublicMindCatalogPageRequest,
  PublicMindCatalogPageResult,
  PublicMindCatalogStore,
  CreateMcpTokenRequest,
  CreateMcpTokenResult,
  CurrentAuthorizationToken,
  CreateExportDownloadGrantResult,
  CreateExportJobResult,
  ExpireExportJobResult,
  ExportArchiveRecord,
  ExportDownloadGrant,
  ExportDownloadGrantStore,
  ExportDownloadGrantTransaction,
  ExportJob,
  ExportJobStore,
  ExportStartTransaction,
  ReadExportDownloadGrantResult,
  RevokeMcpTokenRequest,
  RevokeMcpTokenResult,
  RevokeMindBindingOwnerRequest,
  RevokeMindBindingOwnerResult,
  RevokePrincipalTokensForAccountDeletionRequest,
  RevokePrincipalTokensForAccountDeletionResult,
  PrincipalTokenDeletionSnapshot,
  ReadMindBinding,
  ReadMindBindingId,
  RetiredHandleMarker,
  RevisionIndexState,
  RevisionCommitRequest,
  RevisionCommitResult,
  RenamePersonalProfileRequest,
  RenamePersonalProfileResult,
  CreateOrdinaryMindResult,
  ChangeOrdinaryMindVisibilityRequest,
  ChangeOrdinaryMindVisibilityResult,
  CompleteOrdinaryMindDeletionCleanupRequest,
  CompleteOrdinaryMindDeletionCleanupResult,
  CreateOrdinaryMindDeletionImpactRequest,
  CreateOrdinaryMindDeletionImpactResult,
  DeleteOrdinaryMindRequest,
  DeleteOrdinaryMindResult,
  DeleteAccountCascadeRequest,
  DeleteAccountCascadeResult,
  OrdinaryMindDeletionCleanupWorkItem,
  OrdinaryMindDeletionImpactSnapshot,
  OrdinaryMindMetadataTransaction,
  OrdinaryMindRecordSet,
  OrdinaryMindRouteSnapshot,
  OrdinaryMindSnapshot,
  OrdinaryMindStore,
  OwnershipTransferSnapshot,
  RenameOrdinaryMindRequest,
  RenameOrdinaryMindResult,
  SpaceTargetPurgeResult,
  StageContentCommitEffectsRequest,
  StageContentCommitEffectsResult,
  TransferOrdinaryMindOwnershipRequest,
  TransferOrdinaryMindOwnershipResult,
  VerifiedSpaceHost,
  TokenVerifier,
  WriteMindBinding,
  WriteMindBindingId,
} from "@mind-diary/application-ports";
import {
  DomainInvariantError,
  PrincipalAccount,
  SpaceAggregate,
  bindingVersion,
  isReservedTopLevelHandle,
  isReservedTopLevelRoute,
  parseCanonicalSpaceHandle,
  revisionEnvelopesEqual,
  roleHasCapability,
  version,
} from "@mind-diary/application-ports";

export const METADATA_ADAPTER = "memory-revision-envelope" as const;
export type MetadataAdapterContract = MetadataStore;

type Envelope = Readonly<CanonicalRevisionEnvelope>;
type RevisionId = Envelope["revision"]["revisionId"];
type SpaceId = Envelope["revision"]["spaceId"];
type Digest = Envelope["revision"]["manifestHash"];
type HandleSpaceId = HandleReservationSnapshot["spaceId"];
type AuditEventId = AuditEvent["auditEventId"];
type OutboxMessageId = AuditOutboxMessage["outboxMessageId"];

interface SpaceState {
  head: RevisionId | null;
  revisions: Map<RevisionId, Envelope>;
}

type AuthorizationState = Readonly<CurrentAuthorizationState>;
type CompletedIdempotencyRecord = Readonly<
  Extract<IdempotencyRecord, { readonly state: "completed" }>
>;

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

type ActiveHandleByKeyMap = Map<
  string,
  Readonly<HandleReservationSnapshot>
>;
type ActiveHandleBySpaceMap = Map<
  HandleSpaceId,
  Readonly<HandleReservationSnapshot>
>;
type RetiredHandleMap = Map<string, Readonly<RetiredHandleMarker>>;

interface MutableHandleRegistryState {
  readonly activeByHandle: ActiveHandleByKeyMap;
  readonly activeBySpace: ActiveHandleBySpaceMap;
  readonly retired: RetiredHandleMap;
}

function reserveHandleAgainst(
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

function resolveHandleAgainst(
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

function retireHandleAgainst(
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

function principalTokenFingerprint(
  tokens: ReadonlyMap<McpTokenMetadata["tokenId"], Readonly<StoredMcpToken>>,
  principalId: McpTokenMetadata["principalId"],
): string {
  return JSON.stringify({
    format: "mind-diary-principal-token-deletion-v1",
    tokens: [...tokens.values()]
      .filter((token) => token.principalId === principalId)
      .sort((left, right) =>
        compareUnicodeScalarValues(left.tokenId, right.tokenId),
      )
      .map((token) => [
        token.tokenId,
        token.state,
        token.version,
        token.createdAt,
        token.expiresAt,
        token.revokedAt,
      ]),
  });
}

/** Deterministic transactional token adapter for local/unit execution. */
export class InMemoryMcpTokenStore implements McpTokenStore {
  readonly kind = "metadata-store" as const;
  readonly #tokensById = new Map<McpTokenMetadata["tokenId"], StoredMcpToken>();
  readonly #tokenIdByVerifier = new Map<TokenVerifier, McpTokenMetadata["tokenId"]>();
  readonly #deletedPrincipals = new Set<McpTokenMetadata["principalId"]>();
  readonly #accountDeletionReservations = new Map<
    McpTokenMetadata["principalId"],
    string
  >();

  async createMcpToken(
    request: CreateMcpTokenRequest,
  ): Promise<CreateMcpTokenResult> {
    if (!validTokenCreateRequest(request)) {
      return Object.freeze({ kind: "invalid_record" });
    }
    if (
      this.#deletedPrincipals.has(request.principalId) ||
      this.#accountDeletionReservations.has(request.principalId)
    ) {
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
    if (this.#accountDeletionReservations.has(token.principalId)) {
      return Object.freeze({ kind: "denied" } as const);
    }
    return Object.freeze({
      kind: "found" as const,
      verifier: token.verifier,
      value: authorizationToken(token),
    });
  }

  async revokeMcpToken(
    request: RevokeMcpTokenRequest,
  ): Promise<RevokeMcpTokenResult> {
    if (this.#accountDeletionReservations.has(request.principalId)) {
      return Object.freeze({ kind: "not_found" });
    }
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
    this.#accountDeletionReservations.delete(request.principalId);
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

  async readPrincipalTokenDeletionSnapshot(
    principalId: McpTokenMetadata["principalId"],
    occurredAt: BeginPrincipalTokenDeletionRequest["occurredAt"],
  ): Promise<Readonly<PrincipalTokenDeletionSnapshot>> {
    const now = Date.parse(occurredAt);
    const activeTokenCount = [...this.#tokensById.values()].filter(
      (token) =>
        token.principalId === principalId &&
        token.state === "active" &&
        Number.isFinite(now) &&
        Date.parse(token.expiresAt) > now,
    ).length;
    return Object.freeze({
      principalId,
      activeTokenCount,
      stateFingerprint: principalTokenFingerprint(this.#tokensById, principalId),
    });
  }

  async beginPrincipalTokenDeletion(
    request: BeginPrincipalTokenDeletionRequest,
  ): Promise<BeginPrincipalTokenDeletionResult> {
    if (this.#deletedPrincipals.has(request.principalId)) {
      return Object.freeze({ kind: "principal_deleted" });
    }
    const pending = this.#accountDeletionReservations.get(request.principalId);
    if (pending !== undefined) {
      return pending === request.expectedStateFingerprint
        ? Object.freeze({ kind: "reserved", replayed: true })
        : Object.freeze({ kind: "state_changed" });
    }
    if (
      principalTokenFingerprint(this.#tokensById, request.principalId) !==
      request.expectedStateFingerprint
    ) {
      return Object.freeze({ kind: "state_changed" });
    }
    this.#accountDeletionReservations.set(
      request.principalId,
      request.expectedStateFingerprint,
    );
    return Object.freeze({ kind: "reserved", replayed: false });
  }

  async completePrincipalTokenDeletion(
    request: CompletePrincipalTokenDeletionRequest,
  ): Promise<CompletePrincipalTokenDeletionResult> {
    if (this.#deletedPrincipals.has(request.principalId)) {
      return Object.freeze({ kind: "completed", revokedCount: 0, replayed: true });
    }
    const pending = this.#accountDeletionReservations.get(request.principalId);
    if (pending === undefined) {
      return Object.freeze({ kind: "reservation_not_found" });
    }
    if (pending !== request.expectedStateFingerprint) {
      return Object.freeze({ kind: "state_changed" });
    }
    let revokedCount = 0;
    for (const current of this.#tokensById.values()) {
      if (
        current.principalId !== request.principalId ||
        current.state === "revoked"
      ) {
        continue;
      }
      this.#tokensById.set(
        current.tokenId,
        Object.freeze({
          ...current,
          state: "revoked" as const,
          version: version(current.version + 1),
          revokedAt: request.revokedAt,
        }),
      );
      revokedCount += 1;
    }
    this.#accountDeletionReservations.delete(request.principalId);
    this.#deletedPrincipals.add(request.principalId);
    return Object.freeze({ kind: "completed", revokedCount, replayed: false });
  }

  async cancelPrincipalTokenDeletion(
    request: CancelPrincipalTokenDeletionRequest,
  ): Promise<boolean> {
    if (
      this.#accountDeletionReservations.get(request.principalId) !==
      request.expectedStateFingerprint
    ) {
      return false;
    }
    return this.#accountDeletionReservations.delete(request.principalId);
  }
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const EXPORT_DOWNLOAD_VERIFIER_PATTERN =
  /^hmac-sha256:export-download:v1:[0-9a-f]{64}$/u;
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

function cloneSpaces(source: ReadonlyMap<SpaceId, SpaceState>): Map<SpaceId, SpaceState> {
  return new Map(
    [...source].map(([spaceId, state]) => [
      spaceId,
      { head: state.head, revisions: new Map(state.revisions) },
    ]),
  );
}

function authorizationStateKey(query: AuthorizationStateQuery): string {
  return `${query.principalId}\u0000${query.spaceId}\u0000${query.tokenId ?? ""}`;
}

function cloneAuthorizationState(state: AuthorizationState): AuthorizationState {
  return Object.freeze({
    principal: Object.freeze({ ...state.principal }),
    space: Object.freeze({ ...state.space }),
    membership:
      state.membership === null ? null : Object.freeze({ ...state.membership }),
    token:
      state.token === null
        ? null
        : Object.freeze({
            ...state.token,
            scopes: Object.freeze([
              ...state.token.scopes,
            ]) as CurrentAuthorizationToken["scopes"],
          }),
  });
}

function idempotencyNamespaceKey(
  namespace: Readonly<IdempotencyNamespace>,
): string {
  return JSON.stringify([
    namespace.principalId,
    namespace.spaceId,
    namespace.operation,
    namespace.key,
  ]);
}

function cloneIdempotencyRecord(
  record: CompletedIdempotencyRecord,
): CompletedIdempotencyRecord {
  if (record.operation === "commit_changeset") {
    return Object.freeze({
      ...record,
      operation: "commit_changeset",
      result: Object.freeze({ ...record.result }),
    });
  }
  return Object.freeze({
    ...record,
    operation: "start_export",
    result: Object.freeze({ ...record.result }),
  });
}

function cloneIdempotencyRecords(
  source: ReadonlyMap<string, CompletedIdempotencyRecord>,
): Map<string, CompletedIdempotencyRecord> {
  return new Map(
    [...source].map(([key, record]) => [key, cloneIdempotencyRecord(record)]),
  );
}

function cloneAuditEvent(event: Readonly<AuditEvent>): Readonly<AuditEvent> {
  return Object.freeze({
    ...event,
    actor: Object.freeze({ ...event.actor }),
    safeMetadata: Object.freeze({ ...event.safeMetadata }),
  });
}

function cloneAuditOutbox(
  message: Readonly<AuditOutboxMessage>,
): Readonly<AuditOutboxMessage> {
  return Object.freeze({ ...message });
}

function cloneBackgroundJob(job: Readonly<BackgroundJob>): Readonly<BackgroundJob> {
  return Object.freeze({ ...job, target: Object.freeze({ ...job.target }) });
}

function cloneExportJob(job: Readonly<ExportJob>): Readonly<ExportJob> {
  return Object.freeze({
    ...job,
    archive: job.archive === null ? null : Object.freeze({ ...job.archive }),
  });
}

function cloneExportJobs(
  source: ReadonlyMap<JobId, Readonly<ExportJob>>,
): Map<JobId, Readonly<ExportJob>> {
  return new Map([...source].map(([id, job]) => [id, cloneExportJob(job)]));
}

function cloneExportDownloadGrant(
  grant: Readonly<ExportDownloadGrant>,
): Readonly<ExportDownloadGrant> {
  return Object.freeze({ ...grant });
}

function cloneExportDownloadGrants(
  source: ReadonlyMap<string, Readonly<ExportDownloadGrant>>,
): Map<string, Readonly<ExportDownloadGrant>> {
  return new Map(
    [...source].map(([verifier, grant]) => [verifier, cloneExportDownloadGrant(grant)]),
  );
}

function cloneIndexState(
  state: Readonly<RevisionIndexState>,
): Readonly<RevisionIndexState> {
  return Object.freeze({ ...state });
}

function indexStateKey(spaceId: SpaceId, revisionId: RevisionId): string {
  return `${spaceId}\u0000${revisionId}`;
}

const COMMIT_AUDIT_METADATA_KEYS = [
  "manifest_hash",
  "previous_revision_id",
  "revision_id",
  "revision_number",
] as const;
const CAPTURE_COMMIT_AUDIT_METADATA_KEYS = [
  "capture_key",
  "capture_mode",
  "capture_path",
  "capture_source_refs",
  ...COMMIT_AUDIT_METADATA_KEYS,
] as const;
const BOUNDED_OPAQUE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const CAPTURE_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const CAPTURE_SOURCE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)(?:[^\u0000-\u001f\u007f\\]+\/)*[^\u0000-\u001f\u007f\\]+\.md$/u;
const MAX_CLAIM_LEASE_MS = 5 * 60 * 1_000;

function validCaptureAuditSourceRefs(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 2_048) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8) return false;
  return parsed.every((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const record = item as Readonly<Record<string, unknown>>;
    if (record.kind === "user_statement") return Object.keys(record).length === 1;
    return (
      record.kind === "target_entry" &&
      Object.keys(record).sort().join(",") === "kind,path,revisionId" &&
      typeof record.revisionId === "string" &&
      BOUNDED_OPAQUE_ID.test(record.revisionId) &&
      typeof record.path === "string" &&
      record.path.length <= 512 &&
      CAPTURE_SOURCE_PATH_PATTERN.test(record.path)
    );
  });
}

function validCommitAuditMetadata(
  metadata: Readonly<Record<string, unknown>>,
  envelope: Envelope,
): boolean {
  const keys = Object.keys(metadata).sort();
  const capture = keys.length === CAPTURE_COMMIT_AUDIT_METADATA_KEYS.length &&
    keys.every((key, index) => key === CAPTURE_COMMIT_AUDIT_METADATA_KEYS[index]);
  const ordinary = keys.length === COMMIT_AUDIT_METADATA_KEYS.length &&
    keys.every((key, index) => key === COMMIT_AUDIT_METADATA_KEYS[index]);
  if (!ordinary && !capture) {
    return false;
  }
  const revision = envelope.revision;
  const previous = metadata.previous_revision_id;
  return (
    metadata.revision_id === revision.revisionId &&
    typeof metadata.revision_id === "string" &&
    BOUNDED_OPAQUE_ID.test(metadata.revision_id) &&
    previous === revision.parentRevisionId &&
    (previous === null ||
      (typeof previous === "string" && BOUNDED_OPAQUE_ID.test(previous))) &&
    typeof metadata.revision_number === "number" &&
    Number.isSafeInteger(metadata.revision_number) &&
    metadata.revision_number > 0 &&
    metadata.revision_number === revision.revisionNumber &&
    typeof metadata.manifest_hash === "string" &&
    SHA256_PATTERN.test(metadata.manifest_hash) &&
    metadata.manifest_hash === revision.manifestHash &&
    (!capture || (
      metadata.capture_mode === "routine_non_sensitive" &&
      typeof metadata.capture_key === "string" &&
      CAPTURE_KEY_PATTERN.test(metadata.capture_key) &&
      metadata.capture_path === `concepts/captured/${metadata.capture_key}.md` &&
      validCaptureAuditSourceRefs(metadata.capture_source_refs)
    ))
  );
}

function validClaimLease(now: string, claimExpiresAt: string): boolean {
  const start = Date.parse(now);
  const end = Date.parse(claimExpiresAt);
  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end > start &&
    end - start <= MAX_CLAIM_LEASE_MS
  );
}

function validExportArchive(archive: Readonly<ExportArchiveRecord>): boolean {
  return (
    typeof archive.objectKey === "string" &&
    archive.objectKey.length > 0 &&
    archive.objectKey.length <= 512 &&
    archive.archiveFormat === "MD-OKF-ZIP-1" &&
    archive.mediaType === "application/zip" &&
    archive.filename === "mind-diary-okf-bundle.zip" &&
    archive.contentDisposition ===
      'attachment; filename="mind-diary-okf-bundle.zip"' &&
    SHA256_PATTERN.test(archive.sha256) &&
    Number.isSafeInteger(archive.size) &&
    archive.size >= 0
  );
}

function validExportDownloadGrant(
  grant: Readonly<ExportDownloadGrant>,
  job: Readonly<ExportJob> | undefined,
): boolean {
  const createdAt = Date.parse(grant.createdAt);
  const expiresAt = Date.parse(grant.expiresAt);
  return (
    EXPORT_DOWNLOAD_VERIFIER_PATTERN.test(grant.secretVerifier) &&
    job !== undefined &&
    job.state === "succeeded" &&
    job.archive !== null &&
    grant.jobId === job.jobId &&
    typeof grant.requestedByPrincipalId === "string" &&
    grant.requestedByPrincipalId.length > 0 &&
    grant.spaceId === job.spaceId &&
    grant.revisionId === job.revisionId &&
    grant.objectKey === job.archive.objectKey &&
    grant.state === "active" &&
    grant.revokedAt === null &&
    Number.isFinite(createdAt) &&
    Number.isFinite(expiresAt) &&
    expiresAt > createdAt &&
    expiresAt <= Date.parse(job.expiresAt)
  );
}

function validInitialExportJob(
  job: Readonly<ExportJob>,
  revisionsById: ReadonlyMap<RevisionId, Envelope>,
): boolean {
  const createdAt = Date.parse(job.createdAt);
  const expiresAt = Date.parse(job.expiresAt);
  const revision = revisionsById.get(job.revisionId);
  return (
    typeof job.jobId === "string" &&
    job.jobId.length > 0 &&
    typeof job.requestedByPrincipalId === "string" &&
    job.requestedByPrincipalId.length > 0 &&
    typeof job.idempotencyKey === "string" &&
    job.idempotencyKey.length > 0 &&
    revision?.revision.spaceId === job.spaceId &&
    job.state === "queued" &&
    job.version === 1 &&
    job.attempts === 0 &&
    job.availableAt === job.createdAt &&
    job.updatedAt === job.createdAt &&
    job.claimExpiresAt === null &&
    job.completedAt === null &&
    job.lastFailureCode === null &&
    job.archive === null &&
    job.archiveCleanedAt === null &&
    Number.isFinite(createdAt) &&
    Number.isFinite(expiresAt) &&
    expiresAt > createdAt
  );
}

function stageContentCommitEffectsAgainst(
  request: StageContentCommitEffectsRequest,
  auditEvents: Map<AuditEventId, Readonly<AuditEvent>>,
  auditOutbox: Map<OutboxMessageId, Readonly<AuditOutboxMessage>>,
  backgroundJobs: Map<JobId, Readonly<BackgroundJob>>,
  indexStates: Map<string, Readonly<RevisionIndexState>>,
  revisionsById: ReadonlyMap<RevisionId, Envelope>,
): StageContentCommitEffectsResult {
  const { auditEvent, auditOutbox: outbox, indexJob, indexState } = request;
  const target = indexJob.target;
  if (target.kind !== "revision_index") {
    return Object.freeze({ kind: "invalid_effects" });
  }
  const exactRevision = revisionsById.get(target.revisionId);
  if (!exactRevision || exactRevision.revision.spaceId !== target.spaceId) {
    return Object.freeze({ kind: "invalid_effects" });
  }
  if (
    auditEvent.spaceId === null ||
    auditEvent.outcome !== "succeeded" ||
    auditEvent.eventType !== "content.changeset_committed" ||
    !validCommitAuditMetadata(auditEvent.safeMetadata, exactRevision) ||
    outbox.auditEventId !== auditEvent.auditEventId ||
    outbox.state !== "pending" ||
    outbox.attempts !== 0 ||
    outbox.claimExpiresAt !== null ||
    target.spaceId !== auditEvent.spaceId ||
    target.spaceId !== indexState.spaceId ||
    target.revisionId !== indexState.revisionId ||
    indexJob.state !== "queued" ||
    indexJob.attempts !== 0 ||
    indexJob.claimExpiresAt !== null ||
    indexState.status !== "queued" ||
    indexState.attempts !== 0
  ) {
    return Object.freeze({ kind: "invalid_effects" });
  }
  const indexKey = indexStateKey(indexState.spaceId, indexState.revisionId);
  const existing = [
    auditEvents.has(auditEvent.auditEventId),
    auditOutbox.has(outbox.outboxMessageId),
    backgroundJobs.has(indexJob.jobId),
    indexStates.has(indexKey),
  ];
  if (existing.every(Boolean)) {
    const same =
      JSON.stringify(auditEvents.get(auditEvent.auditEventId)) ===
        JSON.stringify(auditEvent) &&
      JSON.stringify(auditOutbox.get(outbox.outboxMessageId)) ===
        JSON.stringify(outbox) &&
      JSON.stringify(backgroundJobs.get(indexJob.jobId)) ===
        JSON.stringify(indexJob) &&
      JSON.stringify(indexStates.get(indexKey)) === JSON.stringify(indexState);
    return Object.freeze({ kind: same ? "duplicate" : "effect_id_collision" });
  }
  if (existing.some(Boolean)) return Object.freeze({ kind: "effect_id_collision" });
  if (
    [...auditOutbox.values()].some(
      (candidate) => candidate.auditEventId === auditEvent.auditEventId,
    ) ||
    [...backgroundJobs.values()].some(
      (candidate) =>
        candidate.target.kind === "revision_index" &&
        candidate.target.spaceId === target.spaceId &&
        candidate.target.revisionId === target.revisionId,
    )
  ) {
    return Object.freeze({ kind: "effect_id_collision" });
  }
  auditEvents.set(auditEvent.auditEventId, cloneAuditEvent(auditEvent));
  auditOutbox.set(outbox.outboxMessageId, cloneAuditOutbox(outbox));
  backgroundJobs.set(indexJob.jobId, cloneBackgroundJob(indexJob));
  indexStates.set(indexKey, cloneIndexState(indexState));
  return Object.freeze({ kind: "staged" });
}

function checkIdempotencyAgainst(
  request: CheckIdempotencyRequest,
  records: ReadonlyMap<string, CompletedIdempotencyRecord>,
): CheckIdempotencyResult {
  const record = records.get(idempotencyNamespaceKey(request.namespace));
  if (!record) return Object.freeze({ kind: "missing" });
  if (record.canonicalRequestHash !== request.canonicalRequestHash) {
    return Object.freeze({ kind: "conflict" });
  }
  return Object.freeze({
    kind: "replay",
    record: cloneIdempotencyRecord(record),
  });
}

function completeIdempotencyAgainst(
  request: CompleteIdempotencyRequest,
  records: Map<string, CompletedIdempotencyRecord>,
): CompleteIdempotencyResult {
  if (request.namespace.operation !== request.result.kind) {
    return Object.freeze({ kind: "operation_result_mismatch" });
  }
  const key = idempotencyNamespaceKey(request.namespace);
  if (records.has(key)) return Object.freeze({ kind: "already_exists" });
  const base = {
    idempotencyRecordId:
      `idempotency_record_${records.size + 1}` as IdempotencyRecord["idempotencyRecordId"],
    principalId: request.namespace.principalId,
    spaceId: request.namespace.spaceId,
    key: request.namespace.key,
    canonicalRequestHash: request.canonicalRequestHash,
    state: "completed",
    version: version(1),
    createdAt: request.completedAt,
    updatedAt: request.completedAt,
  } as const;
  const record: CompletedIdempotencyRecord =
    request.result.kind === "commit_changeset"
      ? Object.freeze({
          ...base,
          operation: "commit_changeset",
          result: Object.freeze({ ...request.result }),
        })
      : Object.freeze({
          ...base,
          operation: "start_export",
          result: Object.freeze({ ...request.result }),
        });
  records.set(key, record);
  return Object.freeze({
    kind: "completed",
    record: cloneIdempotencyRecord(record),
  });
}

type PrincipalMap = Map<Principal["principalId"], Readonly<Principal>>;
type ExternalBindingMap = Map<string, Readonly<ExternalIdentityBinding>>;
type KnowledgeSpaceMap = Map<KnowledgeSpace["spaceId"], Readonly<KnowledgeSpace>>;
type PersonalBindingMap = Map<
  PersonalSpaceBinding["principalId"],
  Readonly<PersonalSpaceBinding>
>;
type MembershipMap = Map<
  SpaceMembership["membershipId"],
  Readonly<SpaceMembership>
>;
type InvitationMap = Map<
  SpaceInvitation["invitationId"],
  Readonly<SpaceInvitation>
>;

interface PersonalProfileIdempotencyRecord {
  readonly principalId: Principal["principalId"];
  readonly key: RenamePersonalProfileRequest["idempotencyKey"];
  readonly canonicalRequestHash: RenamePersonalProfileRequest["canonicalRequestHash"];
  readonly profile: Readonly<PersonalMindProfileSnapshot>;
}

function externalBindingKey(
  lookup: Readonly<ExternalIdentityBindingLookup>,
): string {
  return `${lookup.provider}\u0000${lookup.normalizedBinding}`;
}

function freezePrincipal(record: Readonly<Principal>): Readonly<Principal> {
  return Object.freeze({ ...record });
}

function freezeExternalBinding(
  record: Readonly<ExternalIdentityBinding>,
): Readonly<ExternalIdentityBinding> {
  return Object.freeze({ ...record });
}

function freezeKnowledgeSpace(
  record: Readonly<KnowledgeSpace>,
): Readonly<KnowledgeSpace> {
  return Object.freeze({ ...record });
}

function freezePersonalBinding(
  record: Readonly<PersonalSpaceBinding>,
): Readonly<PersonalSpaceBinding> {
  return Object.freeze({ ...record });
}

function freezeMembership(
  record: Readonly<SpaceMembership>,
): Readonly<SpaceMembership> {
  return Object.freeze({ ...record });
}

function freezeInvitation(
  record: Readonly<SpaceInvitation>,
): Readonly<SpaceInvitation> {
  return Object.freeze({ ...record });
}

function freezeRegisteredPrincipalSnapshot(
  principal: Readonly<RegisteredPrincipalSnapshot>,
): Readonly<RegisteredPrincipalSnapshot> {
  return Object.freeze({ ...principal });
}

function freezeInvitationSnapshot(
  snapshot: Readonly<InvitationSnapshot>,
): Readonly<InvitationSnapshot> {
  return Object.freeze({
    invitation: freezeInvitation(snapshot.invitation),
    target: freezeRegisteredPrincipalSnapshot(snapshot.target),
  });
}

function freezeInvitationLifecycleSnapshot(
  snapshot: Readonly<InvitationLifecycleSnapshot>,
): Readonly<InvitationLifecycleSnapshot> {
  return Object.freeze({
    invitation: freezeInvitationSnapshot(snapshot.invitation),
    membership: snapshot.membership === null ? null : freezeMembership(snapshot.membership),
  });
}

function cloneRecordMap<Key, Value extends object>(
  source: ReadonlyMap<Key, Readonly<Value>>,
  clone: (value: Readonly<Value>) => Readonly<Value>,
): Map<Key, Readonly<Value>> {
  return new Map([...source].map(([key, value]) => [key, clone(value)]));
}

function currentSitesAuthorizationStateFromMaps(
  query: AuthorizationStateQuery,
  principals: ReadonlyMap<Principal["principalId"], Readonly<Principal>>,
  knowledgeSpaces: ReadonlyMap<
    KnowledgeSpace["spaceId"],
    Readonly<KnowledgeSpace>
  >,
  memberships: ReadonlyMap<
    SpaceMembership["membershipId"],
    Readonly<SpaceMembership>
  >,
): AuthorizationState | null {
  if (query.tokenId !== null) return null;
  const principal = principals.get(query.principalId);
  const space = knowledgeSpaces.get(query.spaceId);
  if (!principal || !space) return null;
  const matchingMemberships = [...memberships.values()]
    .filter(
      (membership) =>
        membership.principalId === query.principalId &&
        membership.spaceId === query.spaceId,
    )
    .sort((left, right) => right.version - left.version);
  const activeMemberships = matchingMemberships.filter(
    (membership) => membership.state === "active",
  );
  if (activeMemberships.length > 1) return null;
  const membership = activeMemberships[0] ?? matchingMemberships[0] ?? null;
  return Object.freeze({
    principal: Object.freeze({
      principalId: principal.principalId,
      state: principal.state,
    }),
    space: Object.freeze({
      spaceId: space.spaceId,
      state: space.state,
      visibility: space.visibility,
      accessVersion: space.accessVersion,
    }),
    membership:
      membership === null
        ? null
        : Object.freeze({
            principalId: membership.principalId,
            spaceId: membership.spaceId,
            role: membership.role,
            state: membership.state,
            version: membership.version,
          }),
    token: null,
  });
}

function accountFromMaps(
  principalId: Principal["principalId"],
  principals: ReadonlyMap<Principal["principalId"], Readonly<Principal>>,
  externalBindings: ReadonlyMap<string, Readonly<ExternalIdentityBinding>>,
  knowledgeSpaces: ReadonlyMap<KnowledgeSpace["spaceId"], Readonly<KnowledgeSpace>>,
  personalBindings: ReadonlyMap<
    PersonalSpaceBinding["principalId"],
    Readonly<PersonalSpaceBinding>
  >,
  memberships: ReadonlyMap<
    SpaceMembership["membershipId"],
    Readonly<SpaceMembership>
  >,
): Readonly<PrincipalAccountSnapshot> | null {
  const principal = principals.get(principalId);
  const personalBinding = personalBindings.get(principalId);
  if (!principal || !personalBinding) return null;
  const personalSpace = knowledgeSpaces.get(personalBinding.spaceId);
  if (!personalSpace) return null;
  const accountBindings = [...externalBindings.values()].filter(
    (binding) => binding.principalId === principalId,
  );
  const personalMemberships = [...memberships.values()].filter(
    (membership) => membership.spaceId === personalSpace.spaceId,
  );
  if (personalMemberships.length !== 1) return null;
  const personal = SpaceAggregate.restorePersonal({
    space: personalSpace,
    binding: personalBinding,
    membership: personalMemberships[0]!,
  });
  return PrincipalAccount.restore({
    principal,
    externalBindings: accountBindings,
    personalMind: personal,
  }).snapshot();
}

function accountByBindingFromMaps(
  lookup: Readonly<ExternalIdentityBindingLookup>,
  principals: ReadonlyMap<Principal["principalId"], Readonly<Principal>>,
  externalBindings: ReadonlyMap<string, Readonly<ExternalIdentityBinding>>,
  knowledgeSpaces: ReadonlyMap<KnowledgeSpace["spaceId"], Readonly<KnowledgeSpace>>,
  personalBindings: ReadonlyMap<
    PersonalSpaceBinding["principalId"],
    Readonly<PersonalSpaceBinding>
  >,
  memberships: ReadonlyMap<
    SpaceMembership["membershipId"],
    Readonly<SpaceMembership>
  >,
): Readonly<PrincipalAccountSnapshot> | null {
  const binding = externalBindings.get(externalBindingKey(lookup));
  if (!binding || binding.state !== "active") return null;
  return accountFromMaps(
    binding.principalId,
    principals,
    externalBindings,
    knowledgeSpaces,
    personalBindings,
    memberships,
  );
}

function freezePersonalMindProfile(
  profile: Readonly<PersonalMindProfileSnapshot>,
): Readonly<PersonalMindProfileSnapshot> {
  return Object.freeze({
    principalId: profile.principalId,
    displayName: profile.displayName,
    profileVersion: profile.profileVersion,
    personalMind: Object.freeze({ ...profile.personalMind }),
  });
}

function personalMindProfileFromAccount(
  account: Readonly<PrincipalAccountSnapshot>,
): Readonly<PersonalMindProfileSnapshot> {
  const space = account.personalMind.space;
  return freezePersonalMindProfile({
    principalId: account.principal.principalId,
    displayName: account.principal.displayName,
    profileVersion: account.principal.profileVersion,
    personalMind: {
      spaceId: space.spaceId,
      name: space.name,
      visibility: "private",
      metadataVersion: space.metadataVersion,
      headRevisionId: space.headRevisionId,
    },
  });
}

function personalProfileIdempotencyKey(
  principalId: Principal["principalId"],
  key: RenamePersonalProfileRequest["idempotencyKey"],
): string {
  return `${principalId}\u0000rename_account\u0000${key}`;
}

function clonePersonalProfileIdempotencyRecords(
  records: ReadonlyMap<string, Readonly<PersonalProfileIdempotencyRecord>>,
): Map<string, Readonly<PersonalProfileIdempotencyRecord>> {
  return new Map(
    [...records].map(([key, record]) => [
      key,
      Object.freeze({
        ...record,
        profile: freezePersonalMindProfile(record.profile),
      }),
    ]),
  );
}

function validateAccountBootstrapRecords(
  records: Readonly<AccountBootstrapRecordSet>,
): Readonly<PrincipalAccountSnapshot> | null {
  try {
    const { principal, externalBinding, personalSpace, personalBinding } = records;
    const ownerMembership = records.ownerMembership;
    const revision = records.initialRevision.revision;
    const parsedHandle = parseCanonicalSpaceHandle(personalSpace.spaceHandle);
    if (
      parsedHandle.kind !== "valid" ||
      isReservedTopLevelHandle(parsedHandle.canonicalHandle) ||
      personalSpace.normalizedHandle !== parsedHandle.canonicalHandle ||
      externalBinding.principalId !== principal.principalId ||
      personalBinding.principalId !== principal.principalId ||
      personalBinding.spaceId !== personalSpace.spaceId ||
      ownerMembership.spaceId !== personalSpace.spaceId ||
      ownerMembership.principalId !== principal.principalId ||
      revision.spaceId !== personalSpace.spaceId ||
      revision.revisionId !== personalSpace.headRevisionId ||
      revision.revisionNumber !== 1 ||
      revision.parentRevisionId !== null ||
      revision.committedBy.kind !== "principal" ||
      revision.committedBy.principalId !== principal.principalId ||
      records.initialRevision.manifest.entries.length === 0
    ) {
      return null;
    }
    const personal = SpaceAggregate.restorePersonal({
      space: personalSpace,
      binding: personalBinding,
      membership: ownerMembership,
    });
    return PrincipalAccount.restore({
      principal,
      externalBindings: [externalBinding],
      personalMind: personal,
    }).snapshot();
  } catch {
    return null;
  }
}

type OrdinaryMindIdempotencyRecord =
  | {
      readonly operation: "create_space_with_owner";
      readonly principalId: Principal["principalId"];
      readonly key: OrdinaryMindRecordSet["idempotencyKey"];
      readonly canonicalRequestHash: OrdinaryMindRecordSet["canonicalRequestHash"];
      readonly mind: Readonly<OrdinaryMindSnapshot>;
    }
  | {
      readonly operation: "rename_space";
      readonly principalId: Principal["principalId"];
      readonly spaceId: KnowledgeSpace["spaceId"];
      readonly key: RenameOrdinaryMindRequest["idempotencyKey"];
      readonly canonicalRequestHash: RenameOrdinaryMindRequest["canonicalRequestHash"];
      readonly mind: Readonly<OrdinaryMindSnapshot>;
    }
  | {
      readonly operation: "change_visibility";
      readonly principalId: Principal["principalId"];
      readonly spaceId: KnowledgeSpace["spaceId"];
      readonly key: ChangeOrdinaryMindVisibilityRequest["idempotencyKey"];
      readonly canonicalRequestHash: ChangeOrdinaryMindVisibilityRequest["canonicalRequestHash"];
      readonly mind: Readonly<OrdinaryMindSnapshot>;
      readonly changed: boolean;
    }
  | {
      readonly operation: "transfer_ownership";
      readonly principalId: Principal["principalId"];
      readonly spaceId: KnowledgeSpace["spaceId"];
      readonly key: TransferOrdinaryMindOwnershipRequest["idempotencyKey"];
      readonly canonicalRequestHash: TransferOrdinaryMindOwnershipRequest["canonicalRequestHash"];
      readonly transfer: Readonly<OwnershipTransferSnapshot>;
    }
  | {
      readonly operation: "create_invitation";
      readonly principalId: Principal["principalId"];
      readonly spaceId: KnowledgeSpace["spaceId"];
      readonly key: CreateInvitationRequest["idempotencyKey"];
      readonly canonicalRequestHash: CreateInvitationRequest["canonicalRequestHash"];
      readonly invitation: Readonly<InvitationSnapshot>;
    }
  | {
      readonly operation: "accept_invitation" | "reject_invitation" | "cancel_invitation";
      readonly principalId: Principal["principalId"];
      readonly spaceId: KnowledgeSpace["spaceId"];
      readonly key: TransitionInvitationRequest["idempotencyKey"];
      readonly canonicalRequestHash: TransitionInvitationRequest["canonicalRequestHash"];
      readonly lifecycle: Readonly<InvitationLifecycleSnapshot>;
    }
  | {
      readonly operation: "reissue_invitation";
      readonly principalId: Principal["principalId"];
      readonly spaceId: KnowledgeSpace["spaceId"];
      readonly key: ReissueInvitationRequest["idempotencyKey"];
      readonly canonicalRequestHash: ReissueInvitationRequest["canonicalRequestHash"];
      readonly invitation: Readonly<InvitationSnapshot>;
    };

type OrdinaryMindDeletionImpactMap = Map<
  OrdinaryMindDeletionImpactSnapshot["impactId"],
  Readonly<OrdinaryMindDeletionImpactSnapshot>
>;

type OrdinaryMindDeletionCleanupMap = Map<
  OrdinaryMindDeletionCleanupWorkItem["impactId"],
  Readonly<OrdinaryMindDeletionCleanupWorkItem>
>;

type AccountDeletionImpactMap = Map<
  AccountDeletionImpactSnapshot["impactId"],
  Readonly<AccountDeletionImpactSnapshot>
>;

type AccountDeletionCleanupMap = Map<
  AccountDeletionCleanupWorkItem["impactId"],
  Readonly<AccountDeletionCleanupWorkItem>
>;

function cloneAccountDeletionImpact(
  impact: Readonly<AccountDeletionImpactSnapshot>,
): Readonly<AccountDeletionImpactSnapshot> {
  return Object.freeze({
    ...impact,
    personalMind: Object.freeze({ ...impact.personalMind }),
    ownedMinds: Object.freeze(
      impact.ownedMinds.map((mind) => Object.freeze({ ...mind })),
    ),
  });
}

function cloneAccountDeletionImpacts(
  source: ReadonlyMap<
    AccountDeletionImpactSnapshot["impactId"],
    Readonly<AccountDeletionImpactSnapshot>
  >,
): AccountDeletionImpactMap {
  return new Map(
    [...source].map(([impactId, impact]) => [
      impactId,
      cloneAccountDeletionImpact(impact),
    ]),
  );
}

function cloneAccountDeletionCleanup(
  work: Readonly<AccountDeletionCleanupWorkItem>,
): Readonly<AccountDeletionCleanupWorkItem> {
  return Object.freeze({
    ...work,
    deletedSpaceIds: Object.freeze([...work.deletedSpaceIds]),
    objectDigests: Object.freeze([...work.objectDigests]),
    foreignExportJobIds: Object.freeze([...work.foreignExportJobIds]),
  });
}

function cloneAccountDeletionCleanups(
  source: ReadonlyMap<
    AccountDeletionCleanupWorkItem["impactId"],
    Readonly<AccountDeletionCleanupWorkItem>
  >,
): AccountDeletionCleanupMap {
  return new Map(
    [...source].map(([impactId, work]) => [
      impactId,
      cloneAccountDeletionCleanup(work),
    ]),
  );
}

function cloneOrdinaryMindDeletionImpact(
  impact: Readonly<OrdinaryMindDeletionImpactSnapshot>,
): Readonly<OrdinaryMindDeletionImpactSnapshot> {
  return Object.freeze({ ...impact });
}

function cloneOrdinaryMindDeletionImpacts(
  source: ReadonlyMap<
    OrdinaryMindDeletionImpactSnapshot["impactId"],
    Readonly<OrdinaryMindDeletionImpactSnapshot>
  >,
): OrdinaryMindDeletionImpactMap {
  return new Map(
    [...source].map(([impactId, impact]) => [
      impactId,
      cloneOrdinaryMindDeletionImpact(impact),
    ]),
  );
}

function cloneOrdinaryMindDeletionCleanup(
  work: Readonly<OrdinaryMindDeletionCleanupWorkItem>,
): Readonly<OrdinaryMindDeletionCleanupWorkItem> {
  return Object.freeze({ ...work, objectDigests: Object.freeze([...work.objectDigests]) });
}

function cloneOrdinaryMindDeletionCleanups(
  source: ReadonlyMap<
    OrdinaryMindDeletionCleanupWorkItem["impactId"],
    Readonly<OrdinaryMindDeletionCleanupWorkItem>
  >,
): OrdinaryMindDeletionCleanupMap {
  return new Map(
    [...source].map(([impactId, work]) => [
      impactId,
      cloneOrdinaryMindDeletionCleanup(work),
    ]),
  );
}

function freezeOrdinaryMindSnapshot(
  snapshot: Readonly<OrdinaryMindSnapshot>,
): Readonly<OrdinaryMindSnapshot> {
  return Object.freeze({
    space: freezeKnowledgeSpace(snapshot.space),
    ownerMembership: freezeMembership(snapshot.ownerMembership),
  });
}

function freezeOwnershipTransferSnapshot(
  snapshot: Readonly<OwnershipTransferSnapshot>,
): Readonly<OwnershipTransferSnapshot> {
  return Object.freeze({
    mind: freezeOrdinaryMindSnapshot(snapshot.mind),
    sourceMembership: freezeMembership(snapshot.sourceMembership),
    targetMembership: freezeMembership(snapshot.targetMembership),
  });
}

function sameKnowledgeSpaceRecord(
  left: Readonly<KnowledgeSpace>,
  right: Readonly<KnowledgeSpace>,
): boolean {
  return (
    left.spaceId === right.spaceId &&
    left.spaceHandle === right.spaceHandle &&
    left.normalizedHandle === right.normalizedHandle &&
    left.name === right.name &&
    left.visibility === right.visibility &&
    left.state === right.state &&
    left.metadataVersion === right.metadataVersion &&
    left.accessVersion === right.accessVersion &&
    left.headRevisionId === right.headRevisionId &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

function sameMembershipRecord(
  left: Readonly<SpaceMembership>,
  right: Readonly<SpaceMembership>,
): boolean {
  return (
    left.membershipId === right.membershipId &&
    left.spaceId === right.spaceId &&
    left.principalId === right.principalId &&
    left.role === right.role &&
    left.state === right.state &&
    left.version === right.version &&
    left.createdAt === right.createdAt &&
    left.createdBy === right.createdBy &&
    left.updatedAt === right.updatedAt &&
    left.updatedBy === right.updatedBy
  );
}

function sameOwnershipTransferSnapshot(
  left: Readonly<OwnershipTransferSnapshot>,
  right: Readonly<OwnershipTransferSnapshot>,
): boolean {
  return (
    sameKnowledgeSpaceRecord(left.mind.space, right.mind.space) &&
    sameMembershipRecord(
      left.mind.ownerMembership,
      right.mind.ownerMembership,
    ) &&
    sameMembershipRecord(left.sourceMembership, right.sourceMembership) &&
    sameMembershipRecord(left.targetMembership, right.targetMembership)
  );
}

function ordinaryMindSnapshotFromMaps(
  spaceId: KnowledgeSpace["spaceId"],
  knowledgeSpaces: ReadonlyMap<
    KnowledgeSpace["spaceId"],
    Readonly<KnowledgeSpace>
  >,
  memberships: ReadonlyMap<
    SpaceMembership["membershipId"],
    Readonly<SpaceMembership>
  >,
): Readonly<OrdinaryMindSnapshot> | null {
  const space = knowledgeSpaces.get(spaceId);
  if (!space) return null;
  try {
    const aggregate = SpaceAggregate.restoreOrdinary({
      space,
      memberships: [...memberships.values()].filter(
        (membership) => membership.spaceId === spaceId,
      ),
    }).snapshot();
    const owner = aggregate.memberships.find(
      (membership) =>
        membership.state === "active" && membership.role === "owner",
    );
    return owner
      ? freezeOrdinaryMindSnapshot({
          space: aggregate.space,
          ownerMembership: owner,
        })
      : null;
  } catch {
    return null;
  }
}

function ownershipTransferSnapshotFromMaps(
  spaceId: KnowledgeSpace["spaceId"],
  sourceMembershipId: SpaceMembership["membershipId"],
  targetMembershipId: SpaceMembership["membershipId"],
  knowledgeSpaces: ReadonlyMap<
    KnowledgeSpace["spaceId"],
    Readonly<KnowledgeSpace>
  >,
  memberships: ReadonlyMap<
    SpaceMembership["membershipId"],
    Readonly<SpaceMembership>
  >,
): Readonly<OwnershipTransferSnapshot> | null {
  const mind = ordinaryMindSnapshotFromMaps(
    spaceId,
    knowledgeSpaces,
    memberships,
  );
  const sourceMembership = memberships.get(sourceMembershipId);
  const targetMembership = memberships.get(targetMembershipId);
  if (
    mind === null ||
    !sourceMembership ||
    !targetMembership ||
    sourceMembership.spaceId !== spaceId ||
    targetMembership.spaceId !== spaceId ||
    sourceMembership.state !== "active" ||
    sourceMembership.role !== "admin" ||
    targetMembership.state !== "active" ||
    targetMembership.role !== "owner" ||
    mind.ownerMembership.membershipId !== targetMembership.membershipId
  ) {
    return null;
  }
  return freezeOwnershipTransferSnapshot({
    mind,
    sourceMembership,
    targetMembership,
  });
}

function ordinaryMindCreateIdempotencyKey(
  principalId: Principal["principalId"],
  key: OrdinaryMindRecordSet["idempotencyKey"],
): string {
  return `${principalId}\u0000create_space_with_owner\u0000${key}`;
}

function ordinaryMindRenameIdempotencyKey(
  principalId: Principal["principalId"],
  spaceId: KnowledgeSpace["spaceId"],
  key: RenameOrdinaryMindRequest["idempotencyKey"],
): string {
  return `${principalId}\u0000${spaceId}\u0000rename_space\u0000${key}`;
}

function ordinaryMindVisibilityIdempotencyKey(
  principalId: Principal["principalId"],
  spaceId: KnowledgeSpace["spaceId"],
  key: ChangeOrdinaryMindVisibilityRequest["idempotencyKey"],
): string {
  return `${principalId}\u0000${spaceId}\u0000change_visibility\u0000${key}`;
}

function ownershipTransferIdempotencyKey(
  principalId: Principal["principalId"],
  spaceId: KnowledgeSpace["spaceId"],
  key: TransferOrdinaryMindOwnershipRequest["idempotencyKey"],
): string {
  return `${principalId}\u0000${spaceId}\u0000transfer_ownership\u0000${key}`;
}

function invitationIdempotencyRecordKey(
  principalId: Principal["principalId"],
  spaceId: KnowledgeSpace["spaceId"],
  key: CreateInvitationRequest["idempotencyKey"],
): string {
  return `${principalId}\u0000${spaceId}\u0000create_invitation\u0000${key}`;
}

function invitationLifecycleIdempotencyRecordKey(
  principalId: Principal["principalId"],
  spaceId: KnowledgeSpace["spaceId"],
  operation: "accept_invitation" | "reject_invitation" | "cancel_invitation" | "reissue_invitation",
  key: TransitionInvitationRequest["idempotencyKey"],
): string {
  return `${principalId}\u0000${spaceId}\u0000${operation}\u0000${key}`;
}

function invitationLifecycleActorIsCurrentlyAuthorized(
  operation: "accept_invitation" | "reject_invitation" | "cancel_invitation" | "reissue_invitation",
  principalId: Principal["principalId"],
  invitation: Readonly<SpaceInvitation>,
  principals: ReadonlyMap<Principal["principalId"], Readonly<Principal>>,
  memberships: ReadonlyMap<SpaceMembership["membershipId"], Readonly<SpaceMembership>>,
): boolean {
  const principal = principals.get(principalId);
  if (!principal || principal.state !== "active") return false;
  if (operation === "accept_invitation" || operation === "reject_invitation") {
    return invitation.targetPrincipalId === principalId;
  }
  const membership = [...memberships.values()].find(
    (candidate) =>
      candidate.spaceId === invitation.spaceId &&
      candidate.principalId === principalId &&
      candidate.state === "active",
  );
  const capability = invitation.proposedRole === "admin"
    ? "members:manage-admin"
    : "members:manage-basic";
  return (
    invitation.createdBy === principalId &&
    membership !== undefined &&
    roleHasCapability(membership.role, capability)
  );
}

function ordinaryMindIdempotencySpaceId(
  record: Readonly<OrdinaryMindIdempotencyRecord>,
): KnowledgeSpace["spaceId"] {
  return record.operation === "create_space_with_owner"
    ? record.mind.space.spaceId
    : record.spaceId;
}

function cloneOrdinaryMindIdempotencyRecords(
  records: ReadonlyMap<string, Readonly<OrdinaryMindIdempotencyRecord>>,
): Map<string, Readonly<OrdinaryMindIdempotencyRecord>> {
  const cloned = new Map<string, Readonly<OrdinaryMindIdempotencyRecord>>();
  for (const [key, record] of records) {
    if (record.operation === "transfer_ownership") {
      cloned.set(key, Object.freeze({
        ...record,
        transfer: freezeOwnershipTransferSnapshot(record.transfer),
      }));
      continue;
    }
    if (record.operation === "create_invitation" || record.operation === "reissue_invitation") {
      cloned.set(key, Object.freeze({
        ...record,
        invitation: freezeInvitationSnapshot(record.invitation),
      }));
      continue;
    }
    if (
      record.operation === "accept_invitation" ||
      record.operation === "reject_invitation" ||
      record.operation === "cancel_invitation"
    ) {
      cloned.set(key, Object.freeze({
        ...record,
        lifecycle: freezeInvitationLifecycleSnapshot(record.lifecycle),
      }));
      continue;
    }
    if (!("mind" in record)) throw new TypeError("invalid ordinary idempotency record");
    cloned.set(key, Object.freeze({
      ...record,
      mind: freezeOrdinaryMindSnapshot(record.mind),
    }));
  }
  return cloned;
}

type MembershipMutationRecord = Readonly<{
  canonicalRequestHash: MembershipMutationReplayRequest["canonicalRequestHash"];
  membership: Readonly<SpaceMembership>;
  changed: boolean;
  requiredCapability: Extract<
    MembershipMutationReplayResult,
    { readonly kind: "replayed" }
  >["requiredCapability"];
}>;

function membershipMutationKey(
  request: Pick<
    MembershipMutationReplayRequest,
    "principalId" | "spaceId" | "operation" | "idempotencyKey"
  >,
): string {
  return [
    request.principalId,
    request.spaceId,
    request.operation,
    request.idempotencyKey,
  ].join("\u0000");
}

function cloneMembershipMutationRecords(
  records: ReadonlyMap<string, MembershipMutationRecord>,
): Map<string, MembershipMutationRecord> {
  return new Map(
    [...records].map(([key, record]) => [
      key,
      Object.freeze({
        ...record,
        membership: freezeMembership(record.membership),
      }),
    ]),
  );
}

function readMembershipReplay(
  records: ReadonlyMap<string, MembershipMutationRecord>,
  request: Readonly<MembershipMutationReplayRequest>,
): MembershipMutationReplayResult {
  const record = records.get(membershipMutationKey(request));
  if (!record) return Object.freeze({ kind: "not_found" });
  if (record.canonicalRequestHash !== request.canonicalRequestHash) {
    return Object.freeze({ kind: "idempotency_conflict" });
  }
  return Object.freeze({
    kind: "replayed",
    membership: freezeMembership(record.membership),
    changed: record.changed,
    requiredCapability: record.requiredCapability,
  });
}

const VISIBILITY_AUDIT_METADATA_KEYS = [
  "access_version",
  "from_visibility",
  "metadata_version",
  "to_visibility",
] as const;

function visibilityAuditEffects(
  request: Readonly<ChangeOrdinaryMindVisibilityRequest>,
  previous: Readonly<KnowledgeSpace>,
  current: Readonly<KnowledgeSpace>,
): Readonly<{
  event: Readonly<AuditEvent>;
  outbox: Readonly<AuditOutboxMessage>;
}> {
  return Object.freeze({
    event: Object.freeze({
      auditEventId: request.auditEventId,
      actor: Object.freeze({
        kind: "principal" as const,
        principalId: request.principalId,
      }),
      requestId: request.requestId,
      eventType: "space.visibility_changed",
      outcome: "succeeded" as const,
      spaceId: request.spaceId,
      occurredAt: request.occurredAt,
      safeMetadata: Object.freeze({
        access_version: current.accessVersion,
        from_visibility: previous.visibility,
        metadata_version: current.metadataVersion,
        to_visibility: current.visibility,
      }),
    }),
    outbox: Object.freeze({
      outboxMessageId: request.auditOutboxMessageId,
      auditEventId: request.auditEventId,
      state: "pending" as const,
      version: version(1),
      attempts: 0,
      availableAt: request.occurredAt,
      claimExpiresAt: null,
      createdAt: request.occurredAt,
      updatedAt: request.occurredAt,
    }),
  });
}

function validVisibilityAuditEffects(
  request: Readonly<ChangeOrdinaryMindVisibilityRequest>,
  previous: Readonly<KnowledgeSpace>,
  current: Readonly<KnowledgeSpace>,
  effects: ReturnType<typeof visibilityAuditEffects>,
): boolean {
  const { event, outbox } = effects;
  const keys = Object.keys(event.safeMetadata).sort();
  return (
    typeof event.auditEventId === "string" &&
    BOUNDED_OPAQUE_ID.test(event.auditEventId) &&
    event.auditEventId === request.auditEventId &&
    event.actor.kind === "principal" &&
    BOUNDED_OPAQUE_ID.test(event.actor.principalId) &&
    event.actor.principalId === request.principalId &&
    BOUNDED_OPAQUE_ID.test(event.requestId) &&
    event.requestId === request.requestId &&
    event.eventType === "space.visibility_changed" &&
    event.outcome === "succeeded" &&
    event.spaceId !== null &&
    BOUNDED_OPAQUE_ID.test(event.spaceId) &&
    event.spaceId === request.spaceId &&
    event.occurredAt === request.occurredAt &&
    Number.isFinite(Date.parse(event.occurredAt)) &&
    keys.length === VISIBILITY_AUDIT_METADATA_KEYS.length &&
    keys.every((key, index) => key === VISIBILITY_AUDIT_METADATA_KEYS[index]) &&
    event.safeMetadata.from_visibility === previous.visibility &&
    event.safeMetadata.to_visibility === current.visibility &&
    event.safeMetadata.metadata_version === current.metadataVersion &&
    event.safeMetadata.access_version === current.accessVersion &&
    previous.visibility !== current.visibility &&
    current.metadataVersion === previous.metadataVersion + 1 &&
    current.accessVersion === previous.accessVersion + 1 &&
    typeof outbox.outboxMessageId === "string" &&
    BOUNDED_OPAQUE_ID.test(outbox.outboxMessageId) &&
    outbox.outboxMessageId === request.auditOutboxMessageId &&
    outbox.auditEventId === event.auditEventId &&
    outbox.state === "pending" &&
    outbox.version === 1 &&
    outbox.attempts === 0 &&
    outbox.availableAt === request.occurredAt &&
    outbox.claimExpiresAt === null &&
    outbox.createdAt === request.occurredAt &&
    outbox.updatedAt === request.occurredAt
  );
}

function stageVisibilityAuditEffects(
  request: Readonly<ChangeOrdinaryMindVisibilityRequest>,
  previous: Readonly<KnowledgeSpace>,
  current: Readonly<KnowledgeSpace>,
  auditEvents: Map<AuditEventId, Readonly<AuditEvent>>,
  auditOutbox: Map<OutboxMessageId, Readonly<AuditOutboxMessage>>,
): boolean {
  const effects = visibilityAuditEffects(request, previous, current);
  if (!validVisibilityAuditEffects(request, previous, current, effects)) {
    return false;
  }
  if (
    auditEvents.has(effects.event.auditEventId) ||
    auditOutbox.has(effects.outbox.outboxMessageId) ||
    [...auditOutbox.values()].some(
      (candidate) => candidate.auditEventId === effects.event.auditEventId,
    )
  ) {
    return false;
  }
  auditEvents.set(effects.event.auditEventId, cloneAuditEvent(effects.event));
  auditOutbox.set(
    effects.outbox.outboxMessageId,
    cloneAuditOutbox(effects.outbox),
  );
  return true;
}

const OWNERSHIP_TRANSFER_AUDIT_METADATA_KEYS = [
  "access_version",
  "metadata_version",
  "source_member_id",
  "source_membership_version",
  "target_member_id",
  "target_membership_version",
] as const;

function ownershipTransferAuditEffects(
  request: Readonly<TransferOrdinaryMindOwnershipRequest>,
  previousSpace: Readonly<KnowledgeSpace>,
  currentSpace: Readonly<KnowledgeSpace>,
  previousSource: Readonly<SpaceMembership>,
  currentSource: Readonly<SpaceMembership>,
  previousTarget: Readonly<SpaceMembership>,
  currentTarget: Readonly<SpaceMembership>,
): Readonly<{
  event: Readonly<AuditEvent>;
  outbox: Readonly<AuditOutboxMessage>;
}> {
  return Object.freeze({
    event: Object.freeze({
      auditEventId: request.auditEventId,
      actor: Object.freeze({
        kind: "principal" as const,
        principalId: request.principalId,
      }),
      requestId: request.requestId,
      eventType: "space.ownership_transferred",
      outcome: "succeeded" as const,
      spaceId: request.spaceId,
      occurredAt: request.occurredAt,
      safeMetadata: Object.freeze({
        access_version: currentSpace.accessVersion,
        metadata_version: currentSpace.metadataVersion,
        source_member_id: currentSource.membershipId,
        source_membership_version: currentSource.version,
        target_member_id: currentTarget.membershipId,
        target_membership_version: currentTarget.version,
      }),
    }),
    outbox: Object.freeze({
      outboxMessageId: request.auditOutboxMessageId,
      auditEventId: request.auditEventId,
      state: "pending" as const,
      version: version(1),
      attempts: 0,
      availableAt: request.occurredAt,
      claimExpiresAt: null,
      createdAt: request.occurredAt,
      updatedAt: request.occurredAt,
    }),
  });
}

function validOwnershipTransferAuditEffects(
  request: Readonly<TransferOrdinaryMindOwnershipRequest>,
  previousSpace: Readonly<KnowledgeSpace>,
  currentSpace: Readonly<KnowledgeSpace>,
  previousSource: Readonly<SpaceMembership>,
  currentSource: Readonly<SpaceMembership>,
  previousTarget: Readonly<SpaceMembership>,
  currentTarget: Readonly<SpaceMembership>,
  effects: ReturnType<typeof ownershipTransferAuditEffects>,
): boolean {
  const { event, outbox } = effects;
  const keys = Object.keys(event.safeMetadata).sort();
  return (
    previousSpace.spaceId === currentSpace.spaceId &&
    previousSpace.spaceHandle === currentSpace.spaceHandle &&
    previousSpace.normalizedHandle === currentSpace.normalizedHandle &&
    previousSpace.name === currentSpace.name &&
    previousSpace.visibility === currentSpace.visibility &&
    previousSpace.state === currentSpace.state &&
    previousSpace.headRevisionId === currentSpace.headRevisionId &&
    previousSpace.createdAt === currentSpace.createdAt &&
    currentSpace.metadataVersion === previousSpace.metadataVersion + 1 &&
    currentSpace.accessVersion === previousSpace.accessVersion + 1 &&
    currentSpace.updatedAt === request.occurredAt &&
    previousSource.membershipId === currentSource.membershipId &&
    previousSource.spaceId === currentSource.spaceId &&
    previousSource.principalId === request.principalId &&
    previousSource.principalId === currentSource.principalId &&
    previousSource.role === "owner" &&
    currentSource.role === "admin" &&
    previousSource.state === "active" &&
    currentSource.state === "active" &&
    currentSource.version === previousSource.version + 1 &&
    currentSource.createdAt === previousSource.createdAt &&
    currentSource.createdBy === previousSource.createdBy &&
    currentSource.updatedAt === request.occurredAt &&
    currentSource.updatedBy === request.principalId &&
    previousTarget.membershipId === request.targetMembershipId &&
    previousTarget.membershipId === currentTarget.membershipId &&
    previousTarget.spaceId === currentTarget.spaceId &&
    previousTarget.principalId === currentTarget.principalId &&
    previousTarget.principalId !== request.principalId &&
    previousTarget.role !== "owner" &&
    currentTarget.role === "owner" &&
    previousTarget.state === "active" &&
    currentTarget.state === "active" &&
    currentTarget.version === previousTarget.version + 1 &&
    currentTarget.createdAt === previousTarget.createdAt &&
    currentTarget.createdBy === previousTarget.createdBy &&
    currentTarget.updatedAt === request.occurredAt &&
    currentTarget.updatedBy === request.principalId &&
    typeof event.auditEventId === "string" &&
    BOUNDED_OPAQUE_ID.test(event.auditEventId) &&
    event.auditEventId === request.auditEventId &&
    event.actor.kind === "principal" &&
    event.actor.principalId === request.principalId &&
    BOUNDED_OPAQUE_ID.test(event.actor.principalId) &&
    BOUNDED_OPAQUE_ID.test(event.requestId) &&
    event.requestId === request.requestId &&
    event.eventType === "space.ownership_transferred" &&
    event.outcome === "succeeded" &&
    event.spaceId === request.spaceId &&
    event.occurredAt === request.occurredAt &&
    Number.isFinite(Date.parse(event.occurredAt)) &&
    keys.length === OWNERSHIP_TRANSFER_AUDIT_METADATA_KEYS.length &&
    keys.every(
      (key, index) => key === OWNERSHIP_TRANSFER_AUDIT_METADATA_KEYS[index],
    ) &&
    event.safeMetadata.access_version === currentSpace.accessVersion &&
    event.safeMetadata.metadata_version === currentSpace.metadataVersion &&
    event.safeMetadata.source_member_id === currentSource.membershipId &&
    event.safeMetadata.source_membership_version === currentSource.version &&
    event.safeMetadata.target_member_id === currentTarget.membershipId &&
    event.safeMetadata.target_membership_version === currentTarget.version &&
    typeof outbox.outboxMessageId === "string" &&
    BOUNDED_OPAQUE_ID.test(outbox.outboxMessageId) &&
    outbox.outboxMessageId === request.auditOutboxMessageId &&
    outbox.auditEventId === event.auditEventId &&
    outbox.state === "pending" &&
    outbox.version === 1 &&
    outbox.attempts === 0 &&
    outbox.availableAt === request.occurredAt &&
    outbox.claimExpiresAt === null &&
    outbox.createdAt === request.occurredAt &&
    outbox.updatedAt === request.occurredAt
  );
}

function stageOwnershipTransferAuditEffects(
  request: Readonly<TransferOrdinaryMindOwnershipRequest>,
  previousSpace: Readonly<KnowledgeSpace>,
  currentSpace: Readonly<KnowledgeSpace>,
  previousSource: Readonly<SpaceMembership>,
  currentSource: Readonly<SpaceMembership>,
  previousTarget: Readonly<SpaceMembership>,
  currentTarget: Readonly<SpaceMembership>,
  auditEvents: Map<AuditEventId, Readonly<AuditEvent>>,
  auditOutbox: Map<OutboxMessageId, Readonly<AuditOutboxMessage>>,
): boolean {
  const effects = ownershipTransferAuditEffects(
    request,
    previousSpace,
    currentSpace,
    previousSource,
    currentSource,
    previousTarget,
    currentTarget,
  );
  if (
    !validOwnershipTransferAuditEffects(
      request,
      previousSpace,
      currentSpace,
      previousSource,
      currentSource,
      previousTarget,
      currentTarget,
      effects,
    ) ||
    auditEvents.has(effects.event.auditEventId) ||
    auditOutbox.has(effects.outbox.outboxMessageId) ||
    [...auditOutbox.values()].some(
      (candidate) => candidate.auditEventId === effects.event.auditEventId,
    )
  ) {
    return false;
  }
  auditEvents.set(effects.event.auditEventId, cloneAuditEvent(effects.event));
  auditOutbox.set(
    effects.outbox.outboxMessageId,
    cloneAuditOutbox(effects.outbox),
  );
  return true;
}

function validateOrdinaryMindRecords(
  records: Readonly<OrdinaryMindRecordSet>,
): Readonly<OrdinaryMindSnapshot> | null {
  try {
    const parsedHandle = parseCanonicalSpaceHandle(records.space.spaceHandle);
    const revision = records.initialRevision.revision;
    if (
      parsedHandle.kind !== "valid" ||
      isReservedTopLevelHandle(parsedHandle.canonicalHandle) ||
      records.space.normalizedHandle !== parsedHandle.canonicalHandle ||
      records.space.visibility !== "private" ||
      records.space.state !== "active" ||
      records.space.metadataVersion !== 1 ||
      records.space.accessVersion !== 1 ||
      records.ownerMembership.spaceId !== records.space.spaceId ||
      records.ownerMembership.role !== "owner" ||
      records.ownerMembership.state !== "active" ||
      revision.spaceId !== records.space.spaceId ||
      revision.revisionId !== records.space.headRevisionId ||
      revision.revisionNumber !== 1 ||
      revision.parentRevisionId !== null ||
      revision.committedBy.kind !== "principal" ||
      revision.committedBy.principalId !== records.ownerMembership.principalId ||
      records.initialRevision.manifest.entries.length === 0 ||
      !SHA256_PATTERN.test(records.canonicalRequestHash)
    ) {
      return null;
    }
    const aggregate = SpaceAggregate.restoreOrdinary({
      space: records.space,
      memberships: [records.ownerMembership],
    }).snapshot();
    return freezeOrdinaryMindSnapshot({
      space: aggregate.space,
      ownerMembership: aggregate.memberships[0]!,
    });
  } catch {
    return null;
  }
}

export type AccountBootstrapFailureStage =
  | "after_principal"
  | "after_binding"
  | "after_space"
  | "after_membership"
  | "after_revision"
  | "before_commit";

export type PersonalProfileFailureStage =
  | "after_principal"
  | "after_space"
  | "before_commit";

export type OrdinaryMindFailureStage =
  | "create_after_handle"
  | "create_after_revision"
  | "create_after_space"
  | "create_after_membership"
  | "create_after_idempotency"
  | "create_before_commit"
  | "rename_after_space"
  | "rename_after_idempotency"
  | "rename_before_commit"
  | "visibility_after_space"
  | "visibility_after_catalog"
  | "visibility_after_audit"
  | "visibility_after_idempotency"
  | "visibility_before_commit"
  | "ownership_after_space"
  | "ownership_after_memberships"
  | "ownership_after_audit"
  | "ownership_after_idempotency"
  | "ownership_before_commit"
  | "invitation_after_record"
  | "invitation_after_idempotency"
  | "invitation_after_expiry_job"
  | "invitation_before_commit"
  | "invitation_lifecycle_after_record"
  | "invitation_lifecycle_after_membership"
  | "invitation_lifecycle_after_idempotency"
  | "invitation_lifecycle_before_commit"
  | "invitation_reissue_after_record"
  | "invitation_reissue_after_job"
  | "invitation_reissue_after_idempotency"
  | "invitation_reissue_before_commit"
  | "invitation_expiry_after_record"
  | "invitation_expiry_before_commit"
  | "deletion_impact_after_record"
  | "deletion_impact_before_commit"
  | "delete_after_handle_retirement"
  | "delete_after_target_records"
  | "delete_after_catalog"
  | "delete_after_cleanup_work"
  | "delete_before_commit"
  | "delete_cleanup_before_commit";

export type AccountDeletionFailureStage =
  | "impact_after_record"
  | "impact_before_commit"
  | "delete_after_handle_retirement"
  | "delete_after_target_records"
  | "delete_after_foreign_tombstones"
  | "delete_after_identity"
  | "delete_after_cleanup_work"
  | "delete_before_commit"
  | "cleanup_before_commit";

const PUBLIC_CATALOG_CURSOR_PREFIX = "mdc1_";
const PUBLIC_CATALOG_CURSOR_QUERY = "public_minds";
const PUBLIC_CATALOG_MAX_CURSOR_BYTES = 256;
const PUBLIC_CATALOG_SNAPSHOT_RETENTION = 32;
const PUBLIC_CATALOG_BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

interface PublicCatalogCursorPayload {
  readonly v: 1;
  readonly q: typeof PUBLIC_CATALOG_CURSOR_QUERY;
  readonly g: number;
  readonly o: number;
}

function encodePublicCatalogCursor(generation: number, offset: number): string {
  const json = JSON.stringify({
    v: 1,
    q: PUBLIC_CATALOG_CURSOR_QUERY,
    g: generation,
    o: offset,
  });
  return `${PUBLIC_CATALOG_CURSOR_PREFIX}${btoa(json)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")}`;
}

function decodePublicCatalogCursor(
  cursor: string,
): Readonly<PublicCatalogCursorPayload> | null {
  if (
    cursor.length === 0 ||
    new TextEncoder().encode(cursor).byteLength >
      PUBLIC_CATALOG_MAX_CURSOR_BYTES ||
    !cursor.startsWith(PUBLIC_CATALOG_CURSOR_PREFIX)
  ) {
    return null;
  }
  const encoded = cursor.slice(PUBLIC_CATALOG_CURSOR_PREFIX.length);
  if (
    encoded.length === 0 ||
    encoded.length % 4 === 1 ||
    !PUBLIC_CATALOG_BASE64URL_PATTERN.test(encoded)
  ) {
    return null;
  }
  try {
    const padded = `${encoded}${"=".repeat((4 - (encoded.length % 4)) % 4)}`;
    const json = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).length !== 4 ||
      record.v !== 1 ||
      record.q !== PUBLIC_CATALOG_CURSOR_QUERY ||
      typeof record.g !== "number" ||
      !Number.isSafeInteger(record.g) ||
      record.g < 0 ||
      typeof record.o !== "number" ||
      !Number.isSafeInteger(record.o) ||
      record.o < 0
    ) {
      return null;
    }
    const payload = Object.freeze({
      v: 1 as const,
      q: PUBLIC_CATALOG_CURSOR_QUERY,
      g: record.g,
      o: record.o,
    });
    return encodePublicCatalogCursor(payload.g, payload.o) === cursor
      ? payload
      : null;
  } catch {
    return null;
  }
}

function clonePublicCatalogSnapshots(
  source: ReadonlyMap<number, readonly SpaceId[]>,
): Map<number, readonly SpaceId[]> {
  return new Map(
    [...source].map(([generation, spaceIds]) => [
      generation,
      Object.freeze([...spaceIds]),
    ]),
  );
}

function derivePublicMindCatalogSpaceIds(
  knowledgeSpaces: ReadonlyMap<SpaceId, Readonly<KnowledgeSpace>>,
  personalBindings: ReadonlyMap<
    PersonalSpaceBinding["principalId"],
    Readonly<PersonalSpaceBinding>
  >,
): Set<SpaceId> {
  const personalSpaceIds = new Set(
    [...personalBindings.values()].map((binding) => binding.spaceId),
  );
  return new Set(
    [...knowledgeSpaces.values()]
      .filter(
        (space) =>
          typeof space.spaceId === "string" &&
          space.spaceId.length > 0 &&
          space.state === "active" &&
          space.visibility === "public" &&
          !personalSpaceIds.has(space.spaceId),
      )
      .map((space) => space.spaceId),
  );
}

function stagePublicCatalogSnapshot(
  generation: number,
  spaceIds: ReadonlySet<SpaceId>,
  snapshots: Map<number, readonly SpaceId[]>,
): void {
  snapshots.set(
    generation,
    Object.freeze([...spaceIds].sort(compareUnicodeScalarValues)),
  );
  while (snapshots.size > PUBLIC_CATALOG_SNAPSHOT_RETENTION) {
    const oldest = Math.min(...snapshots.keys());
    snapshots.delete(oldest);
  }
}

interface OrdinaryMindDeletionState {
  readonly knowledgeSpaces: ReadonlyMap<SpaceId, Readonly<KnowledgeSpace>>;
  readonly memberships: ReadonlyMap<
    SpaceMembership["membershipId"],
    Readonly<SpaceMembership>
  >;
  readonly invitations: ReadonlyMap<
    SpaceInvitation["invitationId"],
    Readonly<SpaceInvitation>
  >;
  readonly revisionSpaces: ReadonlyMap<SpaceId, SpaceState>;
  readonly ordinaryIdempotency: ReadonlyMap<
    string,
    Readonly<OrdinaryMindIdempotencyRecord>
  >;
  readonly contentIdempotency: ReadonlyMap<string, CompletedIdempotencyRecord>;
  readonly auditEvents: ReadonlyMap<AuditEventId, Readonly<AuditEvent>>;
  readonly auditOutbox: ReadonlyMap<OutboxMessageId, Readonly<AuditOutboxMessage>>;
  readonly backgroundJobs: ReadonlyMap<JobId, Readonly<BackgroundJob>>;
  readonly exportJobs: ReadonlyMap<JobId, Readonly<ExportJob>>;
  readonly exportDownloadGrants: ReadonlyMap<
    string,
    Readonly<ExportDownloadGrant>
  >;
  readonly indexStates: ReadonlyMap<string, Readonly<RevisionIndexState>>;
  readonly activeBySpace: ReadonlyMap<
    SpaceId,
    Readonly<HandleReservationSnapshot>
  >;
}

function targetRecordSelection(
  spaceId: SpaceId,
  state: OrdinaryMindDeletionState,
) {
  const auditIds = [...state.auditEvents]
    .filter(([, event]) => event.spaceId === spaceId)
    .map(([id]) => id)
    .sort();
  const auditIdSet = new Set(auditIds);
  const outboxIds = [...state.auditOutbox]
    .filter(([, message]) => auditIdSet.has(message.auditEventId))
    .map(([id]) => id)
    .sort();
  const outboxIdSet = new Set(outboxIds);
  const invitationIds = [...state.invitations]
    .filter(([, invitation]) => invitation.spaceId === spaceId)
    .map(([id]) => id)
    .sort();
  const invitationIdSet = new Set(invitationIds);
  const backgroundJobIds = [...state.backgroundJobs]
    .filter(
      ([, job]) =>
        ("spaceId" in job.target && job.target.spaceId === spaceId) ||
        (job.target.kind === "audit_delivery" &&
          outboxIdSet.has(job.target.outboxMessageId)) ||
        (job.target.kind === "expire_invitation" &&
          invitationIdSet.has(job.target.invitationId)),
    )
    .map(([id]) => id)
    .sort();
  const exportJobIds = [...state.exportJobs]
    .filter(([, job]) => job.spaceId === spaceId)
    .map(([id]) => id)
    .sort();
  const exportGrantKeys = [...state.exportDownloadGrants]
    .filter(([, grant]) => grant.spaceId === spaceId)
    .map(([key]) => key)
    .sort();
  const indexKeys = [...state.indexStates]
    .filter(([, indexState]) => indexState.spaceId === spaceId)
    .map(([key]) => key)
    .sort();
  const contentIdempotencyKeys = [...state.contentIdempotency]
    .filter(([, record]) => record.spaceId === spaceId)
    .map(([key]) => key)
    .sort();
  const ordinaryIdempotencyKeys = [...state.ordinaryIdempotency]
    .filter(([, record]) => ordinaryMindIdempotencySpaceId(record) === spaceId)
    .map(([key]) => key)
    .sort();
  const membershipIds = [...state.memberships]
    .filter(([, membership]) => membership.spaceId === spaceId)
    .map(([id]) => id)
    .sort();
  const revisionIds = [...(state.revisionSpaces.get(spaceId)?.revisions.keys() ?? [])]
    .sort();
  return Object.freeze({
    auditIds: Object.freeze(auditIds),
    outboxIds: Object.freeze(outboxIds),
    backgroundJobIds: Object.freeze(backgroundJobIds),
    exportJobIds: Object.freeze(exportJobIds),
    exportGrantKeys: Object.freeze(exportGrantKeys),
    indexKeys: Object.freeze(indexKeys),
    contentIdempotencyKeys: Object.freeze(contentIdempotencyKeys),
    ordinaryIdempotencyKeys: Object.freeze(ordinaryIdempotencyKeys),
    membershipIds: Object.freeze(membershipIds),
    revisionIds: Object.freeze(revisionIds),
    invitationIds: Object.freeze(invitationIds),
  });
}

function ordinaryMindDeletionFingerprint(
  spaceId: SpaceId,
  state: OrdinaryMindDeletionState,
): string | null {
  const space = state.knowledgeSpaces.get(spaceId);
  const reservation = state.activeBySpace.get(spaceId);
  const revisionState = state.revisionSpaces.get(spaceId);
  if (!space || !reservation || !revisionState) return null;
  const records = targetRecordSelection(spaceId, state);
  return JSON.stringify({
    format: "mind-diary-ordinary-mind-deletion-impact-v1",
    space: {
      space_id: space.spaceId,
      state: space.state,
      visibility: space.visibility,
      metadata_version: space.metadataVersion,
      access_version: space.accessVersion,
      head_revision_id: space.headRevisionId,
      updated_at: space.updatedAt,
    },
    handle: {
      host: reservation.host,
      canonical_handle: reservation.canonicalHandle,
    },
    memberships: records.membershipIds.map((id) => {
      const membership = state.memberships.get(id)!;
      return [
        id,
        membership.principalId,
        membership.role,
        membership.state,
        membership.version,
      ];
    }),
    revisions: records.revisionIds.map((id) => {
      const envelope = revisionState.revisions.get(id)!;
      return [
        id,
        envelope.revision.revisionNumber,
        envelope.revision.parentRevisionId,
        envelope.revision.manifestHash,
      ];
    }),
    service_records: {
      invitation_ids: records.invitationIds,
      background_job_ids: records.backgroundJobIds,
      export_job_ids: records.exportJobIds,
      export_grants: records.exportGrantKeys.map((key) => {
        const grant = state.exportDownloadGrants.get(key)!;
        return [
          grant.jobId,
          grant.requestedByPrincipalId,
          grant.state,
          grant.expiresAt,
        ];
      }),
      index_keys: records.indexKeys,
      audit_ids: records.auditIds,
      outbox_ids: records.outboxIds,
      content_idempotency_keys: records.contentIdempotencyKeys,
      ordinary_idempotency_keys: records.ordinaryIdempotencyKeys,
    },
  });
}

interface AccountDeletionState extends OrdinaryMindDeletionState {
  readonly principals: ReadonlyMap<Principal["principalId"], Readonly<Principal>>;
  readonly externalBindings: ReadonlyMap<
    string,
    Readonly<ExternalIdentityBinding>
  >;
  readonly personalBindings: ReadonlyMap<
    PersonalSpaceBinding["principalId"],
    Readonly<PersonalSpaceBinding>
  >;
  readonly personalProfileIdempotency: ReadonlyMap<
    string,
    Readonly<PersonalProfileIdempotencyRecord>
  >;
}

function accountDeletionSelection(
  principalId: Principal["principalId"],
  host: VerifiedSpaceHost,
  state: AccountDeletionState,
) {
  const principal = state.principals.get(principalId);
  const personalBinding = state.personalBindings.get(principalId);
  const personalSpace = personalBinding
    ? state.knowledgeSpaces.get(personalBinding.spaceId)
    : undefined;
  const personalRevisionState = personalSpace
    ? state.revisionSpaces.get(personalSpace.spaceId)
    : undefined;
  if (
    !principal ||
    principal.state !== "active" ||
    !personalBinding ||
    !personalSpace ||
    personalSpace.state !== "active" ||
    !personalRevisionState
  ) {
    return null;
  }

  const personalSpaceIds = new Set(
    [...state.personalBindings.values()].map((binding) => binding.spaceId),
  );
  const ownedSpaceIds = [...state.memberships.values()]
    .filter(
      (membership) =>
        membership.principalId === principalId &&
        membership.role === "owner" &&
        membership.state === "active" &&
        !personalSpaceIds.has(membership.spaceId) &&
        state.knowledgeSpaces.get(membership.spaceId)?.state === "active",
    )
    .map((membership) => membership.spaceId)
    .sort(compareUnicodeScalarValues);
  const ownedMinds = ownedSpaceIds.map((spaceId) => {
    const space = state.knowledgeSpaces.get(spaceId)!;
    const reservation = state.activeBySpace.get(spaceId);
    const revisions = state.revisionSpaces.get(spaceId);
    if (!reservation || reservation.host !== host || !revisions) return null;
    return Object.freeze({
      spaceId,
      host: reservation.host,
      canonicalHandle: reservation.canonicalHandle,
      name: space.name,
      revisionCount: revisions.revisions.size,
    });
  });
  if (ownedMinds.some((mind) => mind === null)) return null;

  const deletedSpaceIds = Object.freeze([
    personalSpace.spaceId,
    ...ownedSpaceIds,
  ]);
  const deletedSpaceIdSet = new Set(deletedSpaceIds);
  const foreignMembershipIds = [...state.memberships]
    .filter(
      ([, membership]) =>
        membership.principalId === principalId &&
        !deletedSpaceIdSet.has(membership.spaceId),
    )
    .map(([id]) => id)
    .sort(compareUnicodeScalarValues);
  const foreignActiveMembershipCount = foreignMembershipIds.filter(
    (id) => state.memberships.get(id)?.state === "active",
  ).length;
  const targetInvitationIds = [...state.invitations]
    .filter(
      ([, invitation]) =>
        invitation.targetPrincipalId === principalId &&
        !deletedSpaceIdSet.has(invitation.spaceId),
    )
    .map(([id]) => id)
    .sort(compareUnicodeScalarValues);
  const pendingInvitationCount = targetInvitationIds.filter(
    (id) => state.invitations.get(id)?.state === "pending",
  ).length;
  const foreignExportJobIds = [...state.exportJobs]
    .filter(
      ([, job]) =>
        job.requestedByPrincipalId === principalId &&
        !deletedSpaceIdSet.has(job.spaceId),
    )
    .map(([id]) => id)
    .sort(compareUnicodeScalarValues);
  return Object.freeze({
    principal,
    personalBinding,
    personalSpace,
    personalRevisionCount: personalRevisionState.revisions.size,
    ownedMinds: Object.freeze(
      ownedMinds as readonly NonNullable<(typeof ownedMinds)[number]>[],
    ),
    deletedSpaceIds,
    deletedSpaceIdSet,
    foreignMembershipIds: Object.freeze(foreignMembershipIds),
    foreignActiveMembershipCount,
    targetInvitationIds: Object.freeze(targetInvitationIds),
    pendingInvitationCount,
    foreignExportJobIds: Object.freeze(foreignExportJobIds),
  });
}

function accountDeletionFingerprint(
  principalId: Principal["principalId"],
  host: VerifiedSpaceHost,
  state: AccountDeletionState,
): string | null {
  const selected = accountDeletionSelection(principalId, host, state);
  if (!selected) return null;
  const targetSpaces = selected.deletedSpaceIds.map((spaceId) => {
    const space = state.knowledgeSpaces.get(spaceId)!;
    const records = targetRecordSelection(spaceId, state);
    return {
      space: [
        space.spaceId,
        space.state,
        space.visibility,
        space.metadataVersion,
        space.accessVersion,
        space.headRevisionId,
        space.updatedAt,
      ],
      handle: state.activeBySpace.has(spaceId)
        ? [
            state.activeBySpace.get(spaceId)!.host,
            state.activeBySpace.get(spaceId)!.canonicalHandle,
          ]
        : null,
      memberships: records.membershipIds.map((id) => {
        const membership = state.memberships.get(id)!;
        return [
          id,
          membership.principalId,
          membership.role,
          membership.state,
          membership.version,
        ];
      }),
      revisions: records.revisionIds.map((id) => {
        const revision = state.revisionSpaces.get(spaceId)!.revisions.get(id)!;
        return [
          id,
          revision.revision.revisionNumber,
          revision.revision.manifestHash,
          revision.revision.committedBy,
        ];
      }),
      records: {
        invitations: records.invitationIds,
        background_jobs: records.backgroundJobIds,
        export_jobs: records.exportJobIds,
        export_grants: records.exportGrantKeys,
        indexes: records.indexKeys,
        audit: records.auditIds,
        outbox: records.outboxIds,
        content_idempotency: records.contentIdempotencyKeys,
        ordinary_idempotency: records.ordinaryIdempotencyKeys,
      },
    };
  });
  const foreignRevisionAuthors = [...state.revisionSpaces]
    .filter(([spaceId]) => !selected.deletedSpaceIdSet.has(spaceId))
    .flatMap(([spaceId, revisionState]) =>
      [...revisionState.revisions.values()]
        .filter(
          (envelope) =>
            envelope.revision.committedBy.kind === "principal" &&
            envelope.revision.committedBy.principalId === principalId,
        )
        .map((envelope) => [
          spaceId,
          envelope.revision.revisionId,
          envelope.revision.manifestHash,
        ]),
    )
    .sort((left, right) =>
      compareUnicodeScalarValues(String(left[1]), String(right[1])),
    );
  return JSON.stringify({
    format: "mind-diary-account-deletion-impact-v1",
    principal: [
      selected.principal.principalId,
      selected.principal.state,
      selected.principal.profileVersion,
      selected.principal.updatedAt,
    ],
    bindings: [...state.externalBindings.values()]
      .filter((binding) => binding.principalId === principalId)
      .sort((left, right) =>
        compareUnicodeScalarValues(left.bindingId, right.bindingId),
      )
      .map((binding) => [
        binding.bindingId,
        binding.provider,
        binding.state,
        binding.version,
        binding.updatedAt,
      ]),
    personal_binding: [
      selected.personalBinding.spaceId,
      selected.personalBinding.version,
    ],
    target_spaces: targetSpaces,
    foreign_memberships: selected.foreignMembershipIds.map((id) => {
      const membership = state.memberships.get(id)!;
      return [id, membership.spaceId, membership.role, membership.state, membership.version];
    }),
    target_invitations: selected.targetInvitationIds.map((id) => {
      const invitation = state.invitations.get(id)!;
      return [id, invitation.spaceId, invitation.state, invitation.version];
    }),
    foreign_revision_authors: foreignRevisionAuthors,
    foreign_audit_actor_ids: [...state.auditEvents]
      .filter(
        ([, event]) =>
          event.actor.kind === "principal" &&
          event.actor.principalId === principalId &&
          (event.spaceId === null || !selected.deletedSpaceIdSet.has(event.spaceId)),
      )
      .map(([id]) => id)
      .sort(compareUnicodeScalarValues),
    foreign_export_job_ids: selected.foreignExportJobIds,
    content_idempotency: [...state.contentIdempotency]
      .filter(([, record]) => record.principalId === principalId)
      .map(([key]) => key)
      .sort(compareUnicodeScalarValues),
    ordinary_idempotency: [...state.ordinaryIdempotency]
      .filter(([, record]) => record.principalId === principalId)
      .map(([key]) => key)
      .sort(compareUnicodeScalarValues),
    personal_profile_idempotency: [...state.personalProfileIdempotency]
      .filter(([, record]) => record.principalId === principalId)
      .map(([key]) => key)
      .sort(compareUnicodeScalarValues),
  });
}

type AppliedMindBindingMutation = Readonly<
  Extract<ApplyMindBindingMutationResult, { readonly kind: "applied" }>
>;

type MindBindingMutationRequest =
  | ApplyReadMindBindingRequest
  | ApplyWriteMindBindingRequest
  | ApplyAutomaticCapturePolicyRequest;

interface StoredMindBindingMutation {
  readonly canonicalRequestHash: ApplyReadMindBindingRequest["canonicalRequestHash"];
  readonly spaceId: SpaceId | null;
  readonly result: AppliedMindBindingMutation;
}

interface MutableMindBindingOwnerState {
  bindingSet: Readonly<MindBindingSet>;
  readBindingsById: Map<ReadMindBindingId, Readonly<ReadMindBinding>>;
  activeReadBindingBySpace: Map<SpaceId, ReadMindBindingId>;
  writeBindingsById: Map<WriteMindBindingId, Readonly<WriteMindBinding>>;
  activeWriteBindingId: WriteMindBindingId | null;
  idempotency: Map<string, StoredMindBindingMutation>;
}

function cloneReadMindBinding(binding: Readonly<ReadMindBinding>): Readonly<ReadMindBinding> {
  return Object.freeze({ ...binding });
}

function cloneWriteMindBinding(binding: Readonly<WriteMindBinding>): Readonly<WriteMindBinding> {
  return Object.freeze({ ...binding });
}

function cloneMindBindingSnapshot(
  snapshot: Readonly<MindBindingSetSnapshot>,
): Readonly<MindBindingSetSnapshot> {
  return Object.freeze({
    bindingSet: Object.freeze({ ...snapshot.bindingSet }),
    readBindings: Object.freeze(snapshot.readBindings.map(cloneReadMindBinding)),
    writeBinding:
      snapshot.writeBinding === null
        ? null
        : cloneWriteMindBinding(snapshot.writeBinding),
  });
}

function cloneAppliedMindBindingMutation(
  result: AppliedMindBindingMutation,
): AppliedMindBindingMutation {
  return Object.freeze({
    ...result,
    bindings: cloneMindBindingSnapshot(result.bindings),
    previousWriteBinding:
      result.previousWriteBinding === null
        ? null
        : cloneWriteMindBinding(result.previousWriteBinding),
  });
}

function cloneMindBindingOwnerState(
  state: MutableMindBindingOwnerState,
): MutableMindBindingOwnerState {
  return {
    bindingSet: Object.freeze({ ...state.bindingSet }),
    readBindingsById: new Map(
      [...state.readBindingsById].map(([id, binding]) => [
        id,
        cloneReadMindBinding(binding),
      ]),
    ),
    activeReadBindingBySpace: new Map(state.activeReadBindingBySpace),
    writeBindingsById: new Map(
      [...state.writeBindingsById].map(([id, binding]) => [
        id,
        cloneWriteMindBinding(binding),
      ]),
    ),
    activeWriteBindingId: state.activeWriteBindingId,
    idempotency: new Map(
      [...state.idempotency].map(([key, record]) => [
        key,
        {
          canonicalRequestHash: record.canonicalRequestHash,
          spaceId: record.spaceId,
          result: cloneAppliedMindBindingMutation(record.result),
        },
      ]),
    ),
  };
}

function cloneMindBindingOwners(
  owners: ReadonlyMap<MindBindingOwnerId, MutableMindBindingOwnerState>,
): Map<MindBindingOwnerId, MutableMindBindingOwnerState> {
  return new Map(
    [...owners].map(([ownerId, state]) => [
      ownerId,
      cloneMindBindingOwnerState(state),
    ]),
  );
}

function emptyMindBindingOwnerState(
  bindingOwnerId: MindBindingOwnerId,
  principalId: PrincipalId,
  occurredAt: ApplyReadMindBindingRequest["occurredAt"],
): MutableMindBindingOwnerState {
  return {
    bindingSet: Object.freeze({
      bindingOwnerId,
      principalId,
      state: "active" as const,
      bindingVersion: bindingVersion(0),
      automaticCaptureMode: "disabled" as const,
      captureWriteBindingId: null,
      captureUpdatedAt: null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }),
    readBindingsById: new Map(),
    activeReadBindingBySpace: new Map(),
    writeBindingsById: new Map(),
    activeWriteBindingId: null,
    idempotency: new Map(),
  };
}

function mindBindingSnapshot(
  state: MutableMindBindingOwnerState,
): Readonly<MindBindingSetSnapshot> {
  const readBindings = [...state.activeReadBindingBySpace]
    .sort(([left], [right]) => compareUnicodeScalarValues(left, right))
    .map(([, id]) => state.readBindingsById.get(id))
    .filter((binding): binding is Readonly<ReadMindBinding> =>
      binding !== undefined && binding.state === "active",
    )
    .map(cloneReadMindBinding);
  const write =
    state.activeWriteBindingId === null
      ? null
      : state.writeBindingsById.get(state.activeWriteBindingId) ?? null;
  return Object.freeze({
    bindingSet: Object.freeze({ ...state.bindingSet }),
    readBindings: Object.freeze(readBindings),
    writeBinding:
      write?.state === "active" ? cloneWriteMindBinding(write) : null,
  });
}

function validMindBindingMutationBase(
  request: Readonly<MindBindingMutationRequest>,
): boolean {
  return (
    BOUNDED_OPAQUE_ID.test(request.bindingOwnerId) &&
    BOUNDED_OPAQUE_ID.test(request.principalId) &&
    Number.isSafeInteger(request.expectedBindingVersion) &&
    request.expectedBindingVersion >= 0 &&
    typeof request.idempotencyKey === "string" &&
    request.idempotencyKey.length > 0 &&
    request.idempotencyKey.length <= 512 &&
    SHA256_PATTERN.test(request.canonicalRequestHash) &&
    BOUNDED_OPAQUE_ID.test(request.requestId) &&
    BOUNDED_OPAQUE_ID.test(request.auditEventId) &&
    BOUNDED_OPAQUE_ID.test(request.auditOutboxMessageId) &&
    Number.isFinite(Date.parse(request.occurredAt))
  );
}

function mindBindingIdempotencyKey(
  operation: "read" | "write" | "capture",
  request: Readonly<MindBindingMutationRequest>,
): string {
  return `${operation}\u0000${request.idempotencyKey}`;
}

function replayMindBindingMutation(
  state: MutableMindBindingOwnerState,
  operation: "read" | "write" | "capture",
  request: Readonly<MindBindingMutationRequest>,
): ApplyMindBindingMutationResult | null {
  const record = state.idempotency.get(
    mindBindingIdempotencyKey(operation, request),
  );
  if (!record) return null;
  if (record.canonicalRequestHash !== request.canonicalRequestHash) {
    return Object.freeze({ kind: "idempotency_conflict" });
  }
  return Object.freeze({
    ...cloneAppliedMindBindingMutation(record.result),
    replayed: true,
  });
}

function recordMindBindingMutation(
  state: MutableMindBindingOwnerState,
  operation: "read" | "write" | "capture",
  request: Readonly<MindBindingMutationRequest>,
  result: AppliedMindBindingMutation,
): void {
  state.idempotency.set(mindBindingIdempotencyKey(operation, request), {
    canonicalRequestHash: request.canonicalRequestHash,
    spaceId: request.spaceId,
    result: cloneAppliedMindBindingMutation(result),
  });
}

function mindBindingEffectsAvailable(
  auditEventId: AuditEventId,
  auditOutboxMessageId: OutboxMessageId,
  auditEvents: ReadonlyMap<AuditEventId, Readonly<AuditEvent>>,
  auditOutbox: ReadonlyMap<OutboxMessageId, Readonly<AuditOutboxMessage>>,
): boolean {
  return (
    !auditEvents.has(auditEventId) &&
    !auditOutbox.has(auditOutboxMessageId) &&
    ![...auditOutbox.values()].some(
      (message) => message.auditEventId === auditEventId,
    )
  );
}

function stageMindBindingAudit(
  request: Readonly<MindBindingMutationRequest>,
  result: AppliedMindBindingMutation,
  spaceId: SpaceId | null,
  auditEvents: Map<AuditEventId, Readonly<AuditEvent>>,
  auditOutbox: Map<OutboxMessageId, Readonly<AuditOutboxMessage>>,
): void {
  const operation =
    request.action === "attach"
      ? "attach_read"
      : request.action === "detach"
        ? "detach_read"
        : request.action === "bind"
          ? "bind_write"
          : request.action === "unbind"
            ? "unbind_write"
            : request.action === "enable"
              ? "enable_capture"
              : "disable_capture";
  const event = Object.freeze({
    auditEventId: request.auditEventId,
    actor: Object.freeze({
      kind: "principal" as const,
      principalId: request.principalId,
    }),
    requestId: request.requestId,
    eventType: `mind_binding.${operation}`,
    outcome: "succeeded" as const,
    spaceId,
    occurredAt: request.occurredAt,
    safeMetadata: Object.freeze({
      binding_version: result.bindings.bindingSet.bindingVersion,
      changed: result.changed,
      operation,
    }),
  });
  const outbox = Object.freeze({
    outboxMessageId: request.auditOutboxMessageId,
    auditEventId: request.auditEventId,
    state: "pending" as const,
    version: version(1),
    attempts: 0,
    availableAt: request.occurredAt,
    claimExpiresAt: null,
    createdAt: request.occurredAt,
    updatedAt: request.occurredAt,
  });
  auditEvents.set(event.auditEventId, cloneAuditEvent(event));
  auditOutbox.set(outbox.outboxMessageId, cloneAuditOutbox(outbox));
}

function stageMindBindingRevokeAudit(
  request: Readonly<RevokeMindBindingOwnerRequest>,
  invalidatedReadBindings: number,
  invalidatedWriteBindings: number,
  bindingVersionValue: number,
  auditEvents: Map<AuditEventId, Readonly<AuditEvent>>,
  auditOutbox: Map<OutboxMessageId, Readonly<AuditOutboxMessage>>,
): void {
  const event = Object.freeze({
    auditEventId: request.auditEventId,
    actor: Object.freeze({
      kind: "principal" as const,
      principalId: request.principalId,
    }),
    requestId: request.requestId,
    eventType: "mind_binding.owner_revoked",
    outcome: "succeeded" as const,
    spaceId: null,
    occurredAt: request.occurredAt,
    safeMetadata: Object.freeze({
      binding_version: bindingVersionValue,
      read_bindings_invalidated: invalidatedReadBindings,
      write_bindings_invalidated: invalidatedWriteBindings,
    }),
  });
  const outbox = Object.freeze({
    outboxMessageId: request.auditOutboxMessageId,
    auditEventId: request.auditEventId,
    state: "pending" as const,
    version: version(1),
    attempts: 0,
    availableAt: request.occurredAt,
    claimExpiresAt: null,
    createdAt: request.occurredAt,
    updatedAt: request.occurredAt,
  });
  auditEvents.set(event.auditEventId, cloneAuditEvent(event));
  auditOutbox.set(outbox.outboxMessageId, cloneAuditOutbox(outbox));
}

function purgeMindBindingsForSpace(
  owners: Map<MindBindingOwnerId, MutableMindBindingOwnerState>,
  spaceId: SpaceId,
  occurredAt: ApplyReadMindBindingRequest["occurredAt"],
): void {
  for (const state of owners.values()) {
    let activeChanged = false;
    const activeReadId = state.activeReadBindingBySpace.get(spaceId);
    if (activeReadId) {
      state.activeReadBindingBySpace.delete(spaceId);
      activeChanged = true;
    }
    for (const [id, binding] of state.readBindingsById) {
      if (binding.spaceId === spaceId) state.readBindingsById.delete(id);
    }
    if (state.activeWriteBindingId !== null) {
      const active = state.writeBindingsById.get(state.activeWriteBindingId);
      if (active?.spaceId === spaceId) {
        state.activeWriteBindingId = null;
        state.bindingSet = Object.freeze({
          ...state.bindingSet,
          automaticCaptureMode: "disabled" as const,
          captureWriteBindingId: null,
          captureUpdatedAt:
            state.bindingSet.automaticCaptureMode === "disabled"
              ? state.bindingSet.captureUpdatedAt
              : occurredAt,
        });
        activeChanged = true;
      }
    }
    for (const [id, binding] of state.writeBindingsById) {
      if (binding.spaceId === spaceId) state.writeBindingsById.delete(id);
    }
    for (const [key, record] of state.idempotency) {
      if (
        record.spaceId === spaceId ||
        record.result.bindings.readBindings.some(
          (binding) => binding.spaceId === spaceId,
        ) ||
        record.result.bindings.writeBinding?.spaceId === spaceId ||
        record.result.previousWriteBinding?.spaceId === spaceId
      ) {
        state.idempotency.delete(key);
      }
    }
    if (activeChanged && state.bindingSet.state === "active") {
      state.bindingSet = Object.freeze({
        ...state.bindingSet,
        bindingVersion: bindingVersion(state.bindingSet.bindingVersion + 1),
        updatedAt: occurredAt,
      });
    }
  }
}

function purgeMindBindingsForPrincipal(
  owners: Map<MindBindingOwnerId, MutableMindBindingOwnerState>,
  principalId: PrincipalId,
): void {
  for (const [ownerId, state] of owners) {
    if (state.bindingSet.principalId === principalId) owners.delete(ownerId);
  }
}

export class InMemoryRevisionMetadataStore
  implements
    ContentCommitMetadataStore,
    ExportDownloadGrantStore,
    PublicMindCatalogStore,
    PersonalMindStore,
    OrdinaryMindStore,
    AccountDeletionStore,
    MembershipControlStore,
    ControlReadStore,
    MindBindingStore {
  readonly kind = "metadata-store" as const;
  #spaces = new Map<SpaceId, SpaceState>();
  #revisionsById = new Map<RevisionId, Envelope>();
  #idempotencyRecords = new Map<string, CompletedIdempotencyRecord>();
  #auditEvents = new Map<AuditEventId, Readonly<AuditEvent>>();
  #auditOutbox = new Map<OutboxMessageId, Readonly<AuditOutboxMessage>>();
  #backgroundJobs = new Map<JobId, Readonly<BackgroundJob>>();
  #exportJobs = new Map<JobId, Readonly<ExportJob>>();
  #exportDownloadGrants = new Map<string, Readonly<ExportDownloadGrant>>();
  #indexStates = new Map<string, Readonly<RevisionIndexState>>();
  #principals: PrincipalMap = new Map();
  #externalBindings: ExternalBindingMap = new Map();
  #knowledgeSpaces: KnowledgeSpaceMap = new Map();
  #personalBindings: PersonalBindingMap = new Map();
  #memberships: MembershipMap = new Map();
  #invitations: InvitationMap = new Map();
  #personalProfileIdempotencyRecords = new Map<
    string,
    Readonly<PersonalProfileIdempotencyRecord>
  >();
  #ordinaryMindIdempotencyRecords = new Map<
    string,
    Readonly<OrdinaryMindIdempotencyRecord>
  >();
  #membershipMutationRecords = new Map<
    string,
    Readonly<{
      canonicalRequestHash: MembershipMutationReplayRequest["canonicalRequestHash"];
      membership: Readonly<SpaceMembership>;
      changed: boolean;
      requiredCapability: Extract<
        MembershipMutationReplayResult,
        { readonly kind: "replayed" }
      >["requiredCapability"];
    }>
  >();
  #ordinaryMindDeletionImpacts: OrdinaryMindDeletionImpactMap = new Map();
  #ordinaryMindDeletionCleanup: OrdinaryMindDeletionCleanupMap = new Map();
  #accountDeletionImpacts: AccountDeletionImpactMap = new Map();
  #accountDeletionCleanup: AccountDeletionCleanupMap = new Map();
  #mindBindingOwners = new Map<
    MindBindingOwnerId,
    MutableMindBindingOwnerState
  >();
  #activeHandlesByKey: ActiveHandleByKeyMap = new Map();
  #activeHandlesBySpace: ActiveHandleBySpaceMap = new Map();
  #retiredHandles: RetiredHandleMap = new Map();
  #publicMindCatalogGeneration = 0;
  #publicMindCatalogSpaceIds = new Set<SpaceId>();
  #publicMindCatalogSnapshots = new Map<number, readonly SpaceId[]>([
    [0, Object.freeze([])],
  ]);
  readonly #authorizationStates = new Map<string, AuthorizationState>();
  #transactionTail: Promise<void> = Promise.resolve();
  #nextCommitFailure: Error | null = null;
  #nextAccountBootstrapFailureStage: AccountBootstrapFailureStage | null = null;
  #nextPersonalProfileFailureStage: PersonalProfileFailureStage | null = null;
  #nextOrdinaryMindFailureStage: OrdinaryMindFailureStage | null = null;
  #nextAccountDeletionFailureStage: AccountDeletionFailureStage | null = null;

  async readMindBindingSet(
    bindingOwnerId: MindBindingOwnerId,
    principalId: PrincipalId,
    occurredAt: ApplyReadMindBindingRequest["occurredAt"],
  ): Promise<Readonly<MindBindingSetSnapshot> | null> {
    if (
      !BOUNDED_OPAQUE_ID.test(bindingOwnerId) ||
      !BOUNDED_OPAQUE_ID.test(principalId) ||
      !Number.isFinite(Date.parse(occurredAt))
    ) {
      return null;
    }
    const state = this.#mindBindingOwners.get(bindingOwnerId);
    if (state && state.bindingSet.principalId !== principalId) return null;
    return mindBindingSnapshot(
      state ?? emptyMindBindingOwnerState(bindingOwnerId, principalId, occurredAt),
    );
  }

  async runMindBindingTransaction<Result>(
    operation: (transaction: MindBindingTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.#runExclusive(async () => {
      const owners = cloneMindBindingOwners(this.#mindBindingOwners);
      const auditEvents = new Map(
        [...this.#auditEvents].map(([id, event]) => [id, cloneAuditEvent(event)]),
      );
      const auditOutbox = new Map(
        [...this.#auditOutbox].map(([id, message]) => [
          id,
          cloneAuditOutbox(message),
        ]),
      );
      const getOwner = (
        request: Readonly<MindBindingMutationRequest>,
      ): MutableMindBindingOwnerState | ApplyMindBindingMutationResult => {
        if (!validMindBindingMutationBase(request)) {
          return Object.freeze({ kind: "invalid_record" });
        }
        const existing = owners.get(request.bindingOwnerId);
        if (existing && existing.bindingSet.principalId !== request.principalId) {
          return Object.freeze({ kind: "owner_mismatch" });
        }
        const state =
          existing ??
          emptyMindBindingOwnerState(
            request.bindingOwnerId,
            request.principalId,
            request.occurredAt,
          );
        if (state.bindingSet.state !== "active") {
          return Object.freeze({ kind: "binding_owner_revoked" });
        }
        return state;
      };

      const transaction: MindBindingTransaction = Object.freeze({
        kind: "authorization-transaction" as const,
        readCurrentAuthorizationState: (query: AuthorizationStateQuery) =>
          this.readCurrentAuthorizationState(query),
        readMindBindingSet: async (
          bindingOwnerId: MindBindingOwnerId,
          principalId: PrincipalId,
          occurredAt: ApplyReadMindBindingRequest["occurredAt"],
        ) => {
          if (
            !BOUNDED_OPAQUE_ID.test(bindingOwnerId) ||
            !BOUNDED_OPAQUE_ID.test(principalId) ||
            !Number.isFinite(Date.parse(occurredAt))
          ) {
            return null;
          }
          const state = owners.get(bindingOwnerId);
          if (state && state.bindingSet.principalId !== principalId) return null;
          return mindBindingSnapshot(
            state ?? emptyMindBindingOwnerState(bindingOwnerId, principalId, occurredAt),
          );
        },
        applyReadMindBinding: async (
          request: Readonly<ApplyReadMindBindingRequest>,
        ): Promise<ApplyMindBindingMutationResult> => {
          if (
            (request.action !== "attach" && request.action !== "detach") ||
            !BOUNDED_OPAQUE_ID.test(request.spaceId) ||
            (request.action === "attach" &&
              !BOUNDED_OPAQUE_ID.test(request.readBindingId))
          ) {
            return Object.freeze({ kind: "invalid_record" });
          }
          const selected = getOwner(request);
          if (!("bindingSet" in selected)) return selected;
          const replay = replayMindBindingMutation(selected, "read", request);
          if (replay) return replay;
          if (
            selected.bindingSet.bindingVersion !==
            request.expectedBindingVersion
          ) {
            return Object.freeze({
              kind: "binding_version_conflict",
              currentBindingVersion: selected.bindingSet.bindingVersion,
            });
          }
          if (
            !mindBindingEffectsAvailable(
              request.auditEventId,
              request.auditOutboxMessageId,
              auditEvents,
              auditOutbox,
            )
          ) {
            return Object.freeze({ kind: "effect_conflict" });
          }
          if (!owners.has(request.bindingOwnerId)) {
            owners.set(request.bindingOwnerId, selected);
          }

          const activeId = selected.activeReadBindingBySpace.get(request.spaceId);
          let changed = false;
          if (request.action === "attach") {
            if (!activeId) {
              if (selected.readBindingsById.has(request.readBindingId)) {
                return Object.freeze({ kind: "invalid_record" });
              }
              selected.readBindingsById.set(
                request.readBindingId,
                Object.freeze({
                  readBindingId: request.readBindingId,
                  bindingOwnerId: request.bindingOwnerId,
                  spaceId: request.spaceId,
                  state: "active" as const,
                  createdAt: request.occurredAt,
                  invalidatedAt: null,
                }),
              );
              selected.activeReadBindingBySpace.set(
                request.spaceId,
                request.readBindingId,
              );
              changed = true;
            }
          } else if (activeId) {
            const current = selected.readBindingsById.get(activeId);
            if (!current) return Object.freeze({ kind: "invalid_record" });
            selected.readBindingsById.set(
              activeId,
              Object.freeze({
                ...current,
                state: "invalidated" as const,
                invalidatedAt: request.occurredAt,
              }),
            );
            selected.activeReadBindingBySpace.delete(request.spaceId);
            changed = true;
          }

          if (changed) {
            selected.bindingSet = Object.freeze({
              ...selected.bindingSet,
              bindingVersion: bindingVersion(
                selected.bindingSet.bindingVersion + 1,
              ),
              updatedAt: request.occurredAt,
            });
          }
          const result = Object.freeze({
            kind: "applied" as const,
            bindings: mindBindingSnapshot(selected),
            previousWriteBinding: null,
            changed,
            replayed: false,
          });
          stageMindBindingAudit(
            request,
            result,
            request.spaceId,
            auditEvents,
            auditOutbox,
          );
          recordMindBindingMutation(selected, "read", request, result);
          return result;
        },
        applyWriteMindBinding: async (
          request: Readonly<ApplyWriteMindBindingRequest>,
        ): Promise<ApplyMindBindingMutationResult> => {
          if (
            (request.action !== "bind" && request.action !== "unbind") ||
            (request.action === "bind" &&
              (!BOUNDED_OPAQUE_ID.test(request.spaceId) ||
                !BOUNDED_OPAQUE_ID.test(request.writeBindingId))) ||
            (request.action === "unbind" &&
              (request.spaceId !== null || request.writeBindingId !== null))
          ) {
            return Object.freeze({ kind: "invalid_record" });
          }
          const selected = getOwner(request);
          if (!("bindingSet" in selected)) return selected;
          const replay = replayMindBindingMutation(selected, "write", request);
          if (replay) return replay;
          if (
            selected.bindingSet.bindingVersion !==
            request.expectedBindingVersion
          ) {
            return Object.freeze({
              kind: "binding_version_conflict",
              currentBindingVersion: selected.bindingSet.bindingVersion,
            });
          }
          if (
            !mindBindingEffectsAvailable(
              request.auditEventId,
              request.auditOutboxMessageId,
              auditEvents,
              auditOutbox,
            )
          ) {
            return Object.freeze({ kind: "effect_conflict" });
          }

          const active =
            selected.activeWriteBindingId === null
              ? null
              : selected.writeBindingsById.get(selected.activeWriteBindingId) ??
                null;
          if (selected.activeWriteBindingId !== null && active === null) {
            return Object.freeze({ kind: "invalid_record" });
          }
          if (!owners.has(request.bindingOwnerId)) {
            owners.set(request.bindingOwnerId, selected);
          }
          let previous: Readonly<WriteMindBinding> | null = null;
          let changed = false;
          if (request.action === "bind") {
            if (active?.state === "active" && active.spaceId === request.spaceId) {
              // Same-target bind preserves the immutable generation.
            } else {
              if (selected.writeBindingsById.has(request.writeBindingId)) {
                return Object.freeze({ kind: "invalid_record" });
              }
              if (active?.state === "active") {
                previous = Object.freeze({
                  ...active,
                  state: "invalidated" as const,
                  invalidatedAt: request.occurredAt,
                });
                selected.writeBindingsById.set(active.writeBindingId, previous);
              }
              const nextVersion = bindingVersion(
                selected.bindingSet.bindingVersion + 1,
              );
              const current = Object.freeze({
                writeBindingId: request.writeBindingId,
                bindingOwnerId: request.bindingOwnerId,
                spaceId: request.spaceId,
                generation: nextVersion,
                state: "active" as const,
                createdAt: request.occurredAt,
                invalidatedAt: null,
              });
              selected.writeBindingsById.set(request.writeBindingId, current);
              selected.activeWriteBindingId = request.writeBindingId;
              selected.bindingSet = Object.freeze({
                ...selected.bindingSet,
                bindingVersion: nextVersion,
                automaticCaptureMode: "disabled" as const,
                captureWriteBindingId: null,
                captureUpdatedAt:
                  selected.bindingSet.automaticCaptureMode === "disabled"
                    ? selected.bindingSet.captureUpdatedAt
                    : request.occurredAt,
                updatedAt: request.occurredAt,
              });
              changed = true;
            }
          } else if (active?.state === "active") {
            previous = Object.freeze({
              ...active,
              state: "invalidated" as const,
              invalidatedAt: request.occurredAt,
            });
            selected.writeBindingsById.set(active.writeBindingId, previous);
            selected.activeWriteBindingId = null;
            selected.bindingSet = Object.freeze({
              ...selected.bindingSet,
              bindingVersion: bindingVersion(
                selected.bindingSet.bindingVersion + 1,
              ),
              automaticCaptureMode: "disabled" as const,
              captureWriteBindingId: null,
              captureUpdatedAt:
                selected.bindingSet.automaticCaptureMode === "disabled"
                  ? selected.bindingSet.captureUpdatedAt
                  : request.occurredAt,
              updatedAt: request.occurredAt,
            });
            changed = true;
          }

          const result = Object.freeze({
            kind: "applied" as const,
            bindings: mindBindingSnapshot(selected),
            previousWriteBinding: previous,
            changed,
            replayed: false,
          });
          stageMindBindingAudit(
            request,
            result,
            request.spaceId ?? previous?.spaceId ?? null,
            auditEvents,
            auditOutbox,
          );
          recordMindBindingMutation(selected, "write", request, result);
          return result;
        },
        applyAutomaticCapturePolicy: async (
          request: Readonly<ApplyAutomaticCapturePolicyRequest>,
        ): Promise<ApplyMindBindingMutationResult> => {
          if (
            (request.action !== "enable" && request.action !== "disable") ||
            (request.action === "enable" &&
              (request.mode !== "routine_non_sensitive" ||
                !BOUNDED_OPAQUE_ID.test(request.spaceId) ||
                !BOUNDED_OPAQUE_ID.test(request.writeBindingId))) ||
            (request.action === "disable" &&
              (request.mode !== "disabled" || request.writeBindingId !== null ||
                (request.spaceId !== null && !BOUNDED_OPAQUE_ID.test(request.spaceId))))
          ) {
            return Object.freeze({ kind: "invalid_record" });
          }
          const selected = getOwner(request);
          if (!("bindingSet" in selected)) return selected;
          const replay = replayMindBindingMutation(selected, "capture", request);
          if (replay) return replay;
          if (selected.bindingSet.bindingVersion !== request.expectedBindingVersion) {
            return Object.freeze({
              kind: "binding_version_conflict",
              currentBindingVersion: selected.bindingSet.bindingVersion,
            });
          }
          if (
            !mindBindingEffectsAvailable(
              request.auditEventId,
              request.auditOutboxMessageId,
              auditEvents,
              auditOutbox,
            )
          ) {
            return Object.freeze({ kind: "effect_conflict" });
          }
          const active = selected.activeWriteBindingId === null
            ? null
            : selected.writeBindingsById.get(selected.activeWriteBindingId) ?? null;
          if (
            request.action === "enable" &&
            (active?.state !== "active" ||
              active.spaceId !== request.spaceId ||
              active.writeBindingId !== request.writeBindingId)
          ) {
            return Object.freeze({ kind: "invalid_record" });
          }
          if (!owners.has(request.bindingOwnerId)) owners.set(request.bindingOwnerId, selected);
          const changed = request.action === "enable"
            ? selected.bindingSet.automaticCaptureMode !== request.mode ||
              selected.bindingSet.captureWriteBindingId !== request.writeBindingId
            : selected.bindingSet.automaticCaptureMode !== "disabled" ||
              selected.bindingSet.captureWriteBindingId !== null;
          if (changed) {
            selected.bindingSet = Object.freeze({
              ...selected.bindingSet,
              bindingVersion: bindingVersion(selected.bindingSet.bindingVersion + 1),
              automaticCaptureMode: request.mode,
              captureWriteBindingId:
                request.action === "enable" ? request.writeBindingId : null,
              captureUpdatedAt: request.occurredAt,
              updatedAt: request.occurredAt,
            });
          }
          const result = Object.freeze({
            kind: "applied" as const,
            bindings: mindBindingSnapshot(selected),
            previousWriteBinding: null,
            changed,
            replayed: false,
          });
          stageMindBindingAudit(
            request,
            result,
            request.spaceId,
            auditEvents,
            auditOutbox,
          );
          recordMindBindingMutation(selected, "capture", request, result);
          return result;
        },
      });

      const result = await operation(transaction);
      this.#mindBindingOwners = owners;
      this.#auditEvents = auditEvents;
      this.#auditOutbox = auditOutbox;
      return result;
    });
  }

  async revokeMindBindingOwner(
    request: Readonly<RevokeMindBindingOwnerRequest>,
  ): Promise<RevokeMindBindingOwnerResult> {
    return this.#runExclusive(async () => {
      if (
        !BOUNDED_OPAQUE_ID.test(request.bindingOwnerId) ||
        !BOUNDED_OPAQUE_ID.test(request.principalId) ||
        !BOUNDED_OPAQUE_ID.test(request.requestId) ||
        !BOUNDED_OPAQUE_ID.test(request.auditEventId) ||
        !BOUNDED_OPAQUE_ID.test(request.auditOutboxMessageId) ||
        !Number.isFinite(Date.parse(request.occurredAt))
      ) {
        return Object.freeze({ kind: "invalid_record" });
      }
      const state = this.#mindBindingOwners.get(request.bindingOwnerId);
      if (!state) return Object.freeze({ kind: "not_found" });
      if (state.bindingSet.principalId !== request.principalId) {
        return Object.freeze({ kind: "owner_mismatch" });
      }
      if (state.bindingSet.state !== "active") {
        return Object.freeze({
          kind: "revoked",
          invalidatedReadBindings: 0,
          invalidatedWriteBindings: 0,
          replayed: true,
        });
      }
      if (
        !mindBindingEffectsAvailable(
          request.auditEventId,
          request.auditOutboxMessageId,
          this.#auditEvents,
          this.#auditOutbox,
        )
      ) {
        return Object.freeze({ kind: "effect_conflict" });
      }
      const invalidatedReadBindings = state.activeReadBindingBySpace.size;
      for (const id of state.activeReadBindingBySpace.values()) {
        const current = state.readBindingsById.get(id);
        if (current) {
          state.readBindingsById.set(
            id,
            Object.freeze({
              ...current,
              state: "invalidated" as const,
              invalidatedAt: request.occurredAt,
            }),
          );
        }
      }
      state.activeReadBindingBySpace.clear();
      let invalidatedWriteBindings = 0;
      if (state.activeWriteBindingId !== null) {
        const current = state.writeBindingsById.get(state.activeWriteBindingId);
        if (current) {
          state.writeBindingsById.set(
            current.writeBindingId,
            Object.freeze({
              ...current,
              state: "invalidated" as const,
              invalidatedAt: request.occurredAt,
            }),
          );
          invalidatedWriteBindings = 1;
        }
      }
      state.activeWriteBindingId = null;
      state.bindingSet = Object.freeze({
        ...state.bindingSet,
        state: "revoked" as const,
        bindingVersion: bindingVersion(state.bindingSet.bindingVersion + 1),
        automaticCaptureMode: "disabled" as const,
        captureWriteBindingId: null,
        captureUpdatedAt:
          state.bindingSet.automaticCaptureMode === "disabled"
            ? state.bindingSet.captureUpdatedAt
            : request.occurredAt,
        updatedAt: request.occurredAt,
      });
      stageMindBindingRevokeAudit(
        request,
        invalidatedReadBindings,
        invalidatedWriteBindings,
        state.bindingSet.bindingVersion,
        this.#auditEvents,
        this.#auditOutbox,
      );
      return Object.freeze({
        kind: "revoked",
        invalidatedReadBindings,
        invalidatedWriteBindings,
        replayed: false,
      });
    });
  }

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

  async readAccount(
    principalId: Principal["principalId"],
  ): Promise<Readonly<PrincipalAccountSnapshot> | null> {
    return accountFromMaps(
      principalId,
      this.#principals,
      this.#externalBindings,
      this.#knowledgeSpaces,
      this.#personalBindings,
      this.#memberships,
    );
  }

  async readAccountByExternalBinding(
    lookup: Readonly<ExternalIdentityBindingLookup>,
  ): Promise<Readonly<PrincipalAccountSnapshot> | null> {
    return accountByBindingFromMaps(
      lookup,
      this.#principals,
      this.#externalBindings,
      this.#knowledgeSpaces,
      this.#personalBindings,
      this.#memberships,
    );
  }

  async resolvePersonalMind(
    principalId: Principal["principalId"],
  ): Promise<Readonly<PersonalMindResolution> | null> {
    try {
      const account = accountFromMaps(
        principalId,
        this.#principals,
        this.#externalBindings,
        this.#knowledgeSpaces,
        this.#personalBindings,
        this.#memberships,
      );
      if (account === null || account.personalMind.space.state !== "active") {
        return null;
      }
      return Object.freeze({
        spaceId: account.personalMind.space.spaceId,
        headRevisionId: account.personalMind.space.headRevisionId,
      });
    } catch {
      return null;
    }
  }

  async listActiveMembershipMindIds(
    principalId: Principal["principalId"],
  ): Promise<readonly SpaceId[]> {
    const principal = this.#principals.get(principalId);
    if (!principal || principal.state !== "active") return Object.freeze([]);
    const personalSpaceId = this.#personalBindings.get(principalId)?.spaceId;
    return Object.freeze(
      [...new Set(
        [...this.#memberships.values()]
          .filter(
            (membership) =>
              membership.principalId === principalId &&
              membership.state === "active" &&
              membership.spaceId !== personalSpaceId,
          )
          .map((membership) => membership.spaceId),
      )].sort(),
    );
  }

  async readMembershipMutationReplay(
    request: Readonly<MembershipMutationReplayRequest>,
  ): Promise<MembershipMutationReplayResult> {
    return readMembershipReplay(this.#membershipMutationRecords, request);
  }

  async runMembershipControlTransaction<Result>(
    operation: (transaction: MembershipControlTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.runOrdinaryMindTransaction((transaction) => operation(transaction));
  }

  async listControlMembers(
    spaceId: SpaceId,
  ): Promise<readonly Readonly<ControlMemberProjection>[]> {
    const space = this.#knowledgeSpaces.get(spaceId);
    if (!space || space.state !== "active") return Object.freeze([]);
    return Object.freeze(
      [...this.#memberships.values()]
        .filter((membership) => membership.spaceId === spaceId)
        .map((membership) => {
          const principal = this.#principals.get(membership.principalId);
          if (!principal) return null;
          return Object.freeze({
            memberId: membership.membershipId,
            principalId: membership.principalId,
            displayName: principal.displayName,
            role: membership.role,
            state: membership.state,
            membershipVersion: membership.version,
          });
        })
        .filter(
          (projection): projection is Readonly<ControlMemberProjection> =>
            projection !== null,
        )
        .sort((left, right) =>
          left.memberId.localeCompare(right.memberId, "en"),
        ),
    );
  }

  async listControlInvitations(
    principalId: PrincipalId,
  ): Promise<readonly Readonly<ControlInvitationProjection>[]> {
    const principal = this.#principals.get(principalId);
    if (!principal || principal.state !== "active") return Object.freeze([]);
    return Object.freeze(
      [...this.#invitations.values()]
        .filter(
          (invitation) =>
            invitation.targetPrincipalId === principalId ||
            invitation.createdBy === principalId,
        )
        .map((invitation) => {
          const outgoing = invitation.createdBy === principalId;
          const counterpartyId = outgoing
            ? invitation.targetPrincipalId
            : invitation.createdBy;
          const counterparty = this.#principals.get(counterpartyId);
          const mind = this.#knowledgeSpaces.get(invitation.spaceId);
          if (!counterparty || !mind || mind.state !== "active") return null;
          return Object.freeze({
            invitationId: invitation.invitationId,
            mindId: invitation.spaceId,
            mindName: mind.name,
            direction: outgoing ? ("outgoing" as const) : ("incoming" as const),
            counterpartyPrincipalId: counterpartyId,
            counterpartyDisplayName: counterparty.displayName,
            proposedRole: invitation.proposedRole,
            state: invitation.state,
            invitationVersion: invitation.version,
            expiresAt: invitation.expiresAt,
          });
        })
        .filter(
          (projection): projection is Readonly<ControlInvitationProjection> =>
            projection !== null,
        )
        .sort((left, right) =>
          left.invitationId.localeCompare(right.invitationId, "en"),
        ),
    );
  }

  async listPublicMindCatalogPage(
    request: Readonly<PublicMindCatalogPageRequest>,
  ): Promise<PublicMindCatalogPageResult> {
    if (
      typeof request !== "object" ||
      request === null ||
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 100
    ) {
      return Object.freeze({ kind: "invalid_cursor" });
    }
    const decoded =
      request.cursor === null
        ? Object.freeze({
            v: 1 as const,
            q: PUBLIC_CATALOG_CURSOR_QUERY,
            g: this.#publicMindCatalogGeneration,
            o: 0,
          })
        : typeof request.cursor === "string"
          ? decodePublicCatalogCursor(request.cursor)
          : null;
    if (decoded === null) return Object.freeze({ kind: "invalid_cursor" });
    const snapshot = this.#publicMindCatalogSnapshots.get(decoded.g);
    if (snapshot === undefined || decoded.o > snapshot.length) {
      return Object.freeze({ kind: "invalid_cursor" });
    }
    const end = Math.min(decoded.o + request.limit, snapshot.length);
    return Object.freeze({
      kind: "page",
      spaceIds: Object.freeze(snapshot.slice(decoded.o, end)),
      nextCursor:
        end < snapshot.length
          ? encodePublicCatalogCursor(decoded.g, end)
          : null,
    });
  }

  async readResolvedSpace(
    spaceId: SpaceId,
  ): Promise<Readonly<OrdinaryMindRouteSnapshot> | null> {
    return this.#ordinaryMindRouteSnapshot(spaceId);
  }

  #ordinaryMindRouteSnapshot(
    spaceId: SpaceId,
  ): Readonly<OrdinaryMindRouteSnapshot> | null {
    const space = this.#knowledgeSpaces.get(spaceId);
    if (
      !space ||
      space.state !== "active" ||
      [...this.#personalBindings.values()].some(
        (binding) => binding.spaceId === spaceId,
      )
    ) {
      return null;
    }
    const parsedHandle = parseCanonicalSpaceHandle(space.spaceHandle);
    const reservation = this.#activeHandlesBySpace.get(spaceId);
    if (
      parsedHandle.kind !== "valid" ||
      isReservedTopLevelHandle(parsedHandle.canonicalHandle) ||
      space.normalizedHandle !== parsedHandle.canonicalHandle ||
      !reservation ||
      reservation.spaceId !== spaceId ||
      reservation.canonicalHandle !== parsedHandle.canonicalHandle ||
      this.#activeHandlesByKey.get(
        handleKey(reservation.host, reservation.canonicalHandle),
      )?.spaceId !== spaceId ||
      ordinaryMindSnapshotFromMaps(
        spaceId,
        this.#knowledgeSpaces,
        this.#memberships,
      ) === null ||
      this.#spaces.get(spaceId)?.head !== space.headRevisionId ||
      !this.#spaces.get(spaceId)?.revisions.has(space.headRevisionId)
    ) {
      return null;
    }
    return Object.freeze({
      host: reservation.host,
      canonicalHandle: parsedHandle.canonicalHandle,
      space: freezeKnowledgeSpace(space),
    });
  }

  async readPersonalMindProfile(
    principalId: Principal["principalId"],
  ): Promise<Readonly<PersonalMindProfileSnapshot> | null> {
    try {
      const account = accountFromMaps(
        principalId,
        this.#principals,
        this.#externalBindings,
        this.#knowledgeSpaces,
        this.#personalBindings,
        this.#memberships,
      );
      return account === null ? null : personalMindProfileFromAccount(account);
    } catch {
      return null;
    }
  }

  async classifyPersonalMindTarget(
    request: PersonalMindTargetRequest,
  ): Promise<PersonalMindTargetClassification> {
    const target = this.#knowledgeSpaces.get(request.spaceId);
    if (!target || target.state !== "active") {
      return Object.freeze({ kind: "not_found" });
    }
    const personalBinding = [...this.#personalBindings.values()].find(
      (binding) => binding.spaceId === request.spaceId,
    );
    if (!personalBinding) {
      return Object.freeze({ kind: "ordinary", spaceId: request.spaceId });
    }
    if (personalBinding.principalId !== request.principalId) {
      return Object.freeze({ kind: "not_found" });
    }
    const account = await this.readAccount(request.principalId);
    if (
      account === null ||
      account.personalMind.personalBinding?.spaceId !== request.spaceId
    ) {
      return Object.freeze({ kind: "not_found" });
    }
    return Object.freeze({ kind: "own_personal", spaceId: request.spaceId });
  }

  async reserveHandle(
    request: HandleReservationRequest,
  ): Promise<HandleReservationResult> {
    return this.#runExclusive(async () =>
      reserveHandleAgainst(request, {
        activeByHandle: this.#activeHandlesByKey,
        activeBySpace: this.#activeHandlesBySpace,
        retired: this.#retiredHandles,
      }),
    );
  }

  async resolveHandle(
    request: HandleResolutionRequest,
  ): Promise<HandleResolutionResult> {
    return resolveHandleAgainst(request, {
      activeByHandle: this.#activeHandlesByKey,
    });
  }

  async retireHandle(
    request: HandleRetirementRequest,
  ): Promise<HandleRetirementResult> {
    return this.#runExclusive(async () =>
      retireHandleAgainst(request, {
        activeByHandle: this.#activeHandlesByKey,
        activeBySpace: this.#activeHandlesBySpace,
        retired: this.#retiredHandles,
      }),
    );
  }

  async readAccountDeletionContext(
    principalId: Principal["principalId"],
    impactId: string,
  ): Promise<Readonly<AccountDeletionContext> | null> {
    const impact = this.#accountDeletionImpacts.get(impactId);
    if (impact?.principalId === principalId) {
      return Object.freeze({
        kind: "impact",
        impact: cloneAccountDeletionImpact(impact),
      });
    }
    const cleanup = this.#accountDeletionCleanup.get(impactId);
    if (cleanup?.principalId === principalId) {
      return Object.freeze({
        kind: "cleanup",
        cleanup: cloneAccountDeletionCleanup(cleanup),
      });
    }
    return null;
  }

  async runAccountDeletionTransaction<Result>(
    operation: (transaction: OrdinaryMindMetadataTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.runOrdinaryMindTransaction(operation);
  }

  async runOrdinaryMindTransaction<Result>(
    operation: (transaction: OrdinaryMindMetadataTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.#runExclusive(async () => {
      let principals = cloneRecordMap(this.#principals, freezePrincipal);
      let externalBindings = cloneRecordMap(
        this.#externalBindings,
        freezeExternalBinding,
      );
      let personalBindings = cloneRecordMap(
        this.#personalBindings,
        freezePersonalBinding,
      );
      let knowledgeSpaces = cloneRecordMap(
        this.#knowledgeSpaces,
        freezeKnowledgeSpace,
      );
      let memberships = cloneRecordMap(this.#memberships, freezeMembership);
      let invitations = cloneRecordMap(this.#invitations, freezeInvitation);
      let revisionSpaces = cloneSpaces(this.#spaces);
      let revisionsById = new Map(this.#revisionsById);
      let idempotencyRecords = cloneOrdinaryMindIdempotencyRecords(
        this.#ordinaryMindIdempotencyRecords,
      );
      let membershipMutationRecords = cloneMembershipMutationRecords(
        this.#membershipMutationRecords,
      );
      let personalProfileIdempotencyRecords =
        clonePersonalProfileIdempotencyRecords(
          this.#personalProfileIdempotencyRecords,
        );
      let activeByHandle = new Map(this.#activeHandlesByKey);
      let activeBySpace = new Map(this.#activeHandlesBySpace);
      let retired = new Map(this.#retiredHandles);
      let publicCatalogGeneration = this.#publicMindCatalogGeneration;
      let publicCatalogSpaceIds = new Set(this.#publicMindCatalogSpaceIds);
      let publicCatalogSnapshots = clonePublicCatalogSnapshots(
        this.#publicMindCatalogSnapshots,
      );
      let auditEvents = new Map(
        [...this.#auditEvents].map(([id, event]) => [id, cloneAuditEvent(event)]),
      );
      let auditOutbox = new Map(
        [...this.#auditOutbox].map(([id, message]) => [
          id,
          cloneAuditOutbox(message),
        ]),
      );
      let contentIdempotencyRecords = cloneIdempotencyRecords(
        this.#idempotencyRecords,
      );
      let backgroundJobs = new Map(
        [...this.#backgroundJobs].map(([id, job]) => [
          id,
          cloneBackgroundJob(job),
        ]),
      );
      let exportJobs = cloneExportJobs(this.#exportJobs);
      let exportDownloadGrants = cloneExportDownloadGrants(
        this.#exportDownloadGrants,
      );
      let indexStates = new Map(
        [...this.#indexStates].map(([key, state]) => [
          key,
          cloneIndexState(state),
        ]),
      );
      let deletionImpacts = cloneOrdinaryMindDeletionImpacts(
        this.#ordinaryMindDeletionImpacts,
      );
      let deletionCleanup = cloneOrdinaryMindDeletionCleanups(
        this.#ordinaryMindDeletionCleanup,
      );
      let accountDeletionImpacts = cloneAccountDeletionImpacts(
        this.#accountDeletionImpacts,
      );
      let accountDeletionCleanup = cloneAccountDeletionCleanups(
        this.#accountDeletionCleanup,
      );
      let authorizationStates = new Map(
        [...this.#authorizationStates].map(([key, state]) => [
          key,
          cloneAuthorizationState(state),
        ]),
      );
      let mindBindingOwners = cloneMindBindingOwners(this.#mindBindingOwners);

      const deletionState = (): OrdinaryMindDeletionState => ({
        knowledgeSpaces,
        memberships,
        invitations,
        revisionSpaces,
        ordinaryIdempotency: idempotencyRecords,
        contentIdempotency: contentIdempotencyRecords,
        auditEvents,
        auditOutbox,
        backgroundJobs,
        exportJobs,
        exportDownloadGrants,
        indexStates,
        activeBySpace,
      });

      const accountState = (): AccountDeletionState => ({
        ...deletionState(),
        principals,
        externalBindings,
        personalBindings,
        personalProfileIdempotency: personalProfileIdempotencyRecords,
      });

      const transaction: OrdinaryMindMetadataTransaction = Object.freeze({
        kind: "authorization-transaction" as const,
        readMembershipControlTarget: async (
          query: Readonly<MembershipControlTargetQuery>,
        ) => {
          const space = knowledgeSpaces.get(query.spaceId);
          if (!space || space.state !== "active") {
            return Object.freeze({ kind: "mind_not_found" as const });
          }
          const membership = [...memberships.values()].find(
            (candidate) =>
              candidate.spaceId === query.spaceId &&
              (query.memberId !== undefined
                ? candidate.membershipId === query.memberId
                : candidate.principalId === query.principalId),
          );
          if (!membership) {
            return Object.freeze({ kind: "membership_not_found" as const });
          }
          const personal = [...personalBindings.values()].some(
            (binding) => binding.spaceId === query.spaceId,
          );
          return Object.freeze({
            kind: "found" as const,
            mindKind: personal ? ("personal" as const) : ("ordinary" as const),
            membership: freezeMembership(membership),
          });
        },
        applyMembershipMutation: async (
          request: Readonly<ApplyMembershipMutationRequest>,
        ): Promise<ApplyMembershipMutationResult> => {
          const replay = readMembershipReplay(membershipMutationRecords, request);
          if (replay.kind === "idempotency_conflict") return replay;
          if (replay.kind === "replayed") {
            return Object.freeze({
              kind: "applied",
              membership: replay.membership,
              changed: replay.changed,
              replayed: true,
            });
          }
          if (
            !SHA256_PATTERN.test(request.canonicalRequestHash) ||
            !BOUNDED_OPAQUE_ID.test(request.requestId) ||
            !BOUNDED_OPAQUE_ID.test(request.auditEventId) ||
            !BOUNDED_OPAQUE_ID.test(request.auditOutboxMessageId) ||
            !Number.isFinite(Date.parse(request.occurredAt))
          ) {
            return Object.freeze({ kind: "invalid_record" });
          }
          const principal = principals.get(request.principalId);
          const space = knowledgeSpaces.get(request.spaceId);
          if (!principal || principal.state !== "active") {
            return Object.freeze({ kind: "forbidden" });
          }
          if (!space || space.state !== "active") {
            return Object.freeze({ kind: "mind_not_found" });
          }
          if (
            [...personalBindings.values()].some(
              (binding) => binding.spaceId === request.spaceId,
            )
          ) {
            return Object.freeze({ kind: "personal_mind" });
          }
          const source = [...memberships.values()].find(
            (candidate) =>
              candidate.spaceId === request.spaceId &&
              candidate.principalId === request.principalId &&
              candidate.state === "active",
          );
          const target = memberships.get(request.targetMembershipId);
          if (
            !source ||
            !target ||
            target.spaceId !== request.spaceId ||
            target.state !== "active"
          ) {
            return Object.freeze({ kind: "membership_not_found" });
          }
          if (target.role === "owner") {
            return Object.freeze({ kind: "owner_membership" });
          }
          if (target.version !== request.expectedMembershipVersion) {
            return Object.freeze({ kind: "membership_version_conflict" });
          }
          if (
            request.authorizationStamp.accessVersion !== space.accessVersion ||
            request.authorizationStamp.membershipVersion !== source.version ||
            request.authorizationStamp.tokenVersion !== null
          ) {
            return Object.freeze({ kind: "authorization_state_changed" });
          }
          if (!roleHasCapability(source.role, request.requiredCapability)) {
            return Object.freeze({ kind: "forbidden" });
          }
          if (request.operation === "leave_space") {
            if (source.membershipId !== target.membershipId) {
              return Object.freeze({ kind: "forbidden" });
            }
          } else {
            const required =
              target.role === "admin" || request.role === "admin"
                ? "members:manage-admin"
                : "members:manage-basic";
            if (request.requiredCapability !== required) {
              return Object.freeze({ kind: "forbidden" });
            }
          }
          const changed =
            request.operation === "change_membership_role"
              ? target.role !== request.role
              : true;
          if (
            request.operation === "change_membership_role" &&
            request.role !== "reader" &&
            request.role !== "editor" &&
            request.role !== "admin"
          ) {
            return Object.freeze({ kind: "invalid_record" });
          }
          if (
            auditEvents.has(request.auditEventId) ||
            auditOutbox.has(request.auditOutboxMessageId) ||
            [...auditOutbox.values()].some(
              (message) => message.auditEventId === request.auditEventId,
            )
          ) {
            return Object.freeze({ kind: "effect_conflict" });
          }
          const updatedMembership = freezeMembership({
            ...target,
            ...(request.operation === "change_membership_role"
              ? { role: request.role! }
              : { state: "revoked" as const }),
            version: changed ? version(target.version + 1) : target.version,
            updatedAt: changed ? request.occurredAt : target.updatedAt,
            updatedBy: changed ? request.principalId : target.updatedBy,
          });
          const updatedSpace = changed
            ? freezeKnowledgeSpace({
                ...space,
                accessVersion: version(space.accessVersion + 1),
                updatedAt: request.occurredAt,
              })
            : space;
          const event = Object.freeze({
            auditEventId: request.auditEventId,
            actor: Object.freeze({
              kind: "principal" as const,
              principalId: request.principalId,
            }),
            requestId: request.requestId,
            eventType: `membership.${request.operation}`,
            outcome: "succeeded" as const,
            spaceId: request.spaceId,
            occurredAt: request.occurredAt,
            safeMetadata: Object.freeze({
              member_id: target.membershipId,
              previous_role: target.role,
              resulting_role: updatedMembership.role,
              previous_state: target.state,
              resulting_state: updatedMembership.state,
              changed,
            }),
          });
          const outbox = Object.freeze({
            outboxMessageId: request.auditOutboxMessageId,
            auditEventId: request.auditEventId,
            state: "pending" as const,
            version: version(1),
            attempts: 0,
            availableAt: request.occurredAt,
            claimExpiresAt: null,
            createdAt: request.occurredAt,
            updatedAt: request.occurredAt,
          });
          memberships.set(target.membershipId, updatedMembership);
          knowledgeSpaces.set(request.spaceId, updatedSpace);
          auditEvents.set(event.auditEventId, cloneAuditEvent(event));
          auditOutbox.set(outbox.outboxMessageId, cloneAuditOutbox(outbox));
          membershipMutationRecords.set(
            membershipMutationKey(request),
            Object.freeze({
              canonicalRequestHash: request.canonicalRequestHash,
              membership: updatedMembership,
              changed,
              requiredCapability: request.requiredCapability,
            }),
          );
          return Object.freeze({
            kind: "applied",
            membership: updatedMembership,
            changed,
            replayed: false,
          });
        },
        classifyPersonalMindTarget: async (
          request: PersonalMindTargetRequest,
        ): Promise<PersonalMindTargetClassification> => {
          const target = knowledgeSpaces.get(request.spaceId);
          if (!target || target.state !== "active") {
            return Object.freeze({ kind: "not_found" });
          }
          const personalBinding = [...personalBindings.values()].find(
            (binding) => binding.spaceId === request.spaceId,
          );
          if (!personalBinding) {
            return Object.freeze({ kind: "ordinary", spaceId: request.spaceId });
          }
          if (personalBinding.principalId !== request.principalId) {
            return Object.freeze({ kind: "not_found" });
          }
          try {
            const account = accountFromMaps(
              request.principalId,
              principals,
              externalBindings,
              knowledgeSpaces,
              personalBindings,
              memberships,
            );
            if (
              account === null ||
              account.personalMind.personalBinding?.spaceId !== request.spaceId
            ) {
              return Object.freeze({ kind: "not_found" });
            }
          } catch {
            return Object.freeze({ kind: "not_found" });
          }
          return Object.freeze({ kind: "own_personal", spaceId: request.spaceId });
        },
        readCurrentAuthorizationState: async (query: AuthorizationStateQuery) =>
          currentSitesAuthorizationStateFromMaps(
            query,
            principals,
            knowledgeSpaces,
            memberships,
          ),
        readRegisteredPrincipalByExternalBinding: async (
          lookup: Readonly<ExternalIdentityBindingLookup>,
        ): Promise<Readonly<RegisteredPrincipalSnapshot> | null> => {
          try {
            const account = accountByBindingFromMaps(
              lookup,
              principals,
              externalBindings,
              knowledgeSpaces,
              personalBindings,
              memberships,
            );
            if (account === null || account.principal.state !== "active") {
              return null;
            }
            return freezeRegisteredPrincipalSnapshot({
              principalId: account.principal.principalId,
              displayName: account.principal.displayName,
            });
          } catch {
            return null;
          }
        },
        createInvitation: async (
          request: Readonly<CreateInvitationRequest>,
        ): Promise<CreateInvitationResult> => {
          const actorPrincipal = principals.get(request.principalId);
          if (!actorPrincipal || actorPrincipal.state !== "active") {
            return Object.freeze({ kind: "forbidden" });
          }
          const space = knowledgeSpaces.get(request.spaceId);
          if (!space || space.state !== "active") {
            return Object.freeze({ kind: "mind_not_found" });
          }
          const personalBinding = [...personalBindings.values()].find(
            (binding) => binding.spaceId === request.spaceId,
          );
          if (personalBinding) {
            return Object.freeze({
              kind:
                personalBinding.principalId === request.principalId
                  ? "personal_mind"
                  : "mind_not_found",
            });
          }
          const targetPrincipal = principals.get(request.target.principalId);
          if (
            !targetPrincipal ||
            targetPrincipal.state !== "active" ||
            targetPrincipal.displayName !== request.target.displayName
          ) {
            return Object.freeze({ kind: "invalid_record" });
          }
          const aggregateMemberships = [...memberships.values()].filter(
            (membership) => membership.spaceId === request.spaceId,
          );
          const aggregateInvitations = [...invitations.values()].filter(
            (invitation) => invitation.spaceId === request.spaceId,
          );
          let currentAggregate: ReturnType<typeof SpaceAggregate.restoreOrdinary>;
          try {
            currentAggregate = SpaceAggregate.restoreOrdinary({
              space,
              memberships: aggregateMemberships,
              invitations: aggregateInvitations,
            });
          } catch {
            return Object.freeze({ kind: "invalid_record" });
          }
          const actorMembership = currentAggregate
            .snapshot()
            .memberships.find(
              (membership) =>
                membership.principalId === request.principalId &&
                membership.state === "active",
            );
          if (
            !actorMembership ||
            (request.invitation.proposedRole === "admin"
              ? actorMembership.role !== "owner"
              : !["admin", "owner"].includes(actorMembership.role))
          ) {
            return Object.freeze({ kind: "forbidden" });
          }

          const recordKey = invitationIdempotencyRecordKey(
            request.principalId,
            request.spaceId,
            request.idempotencyKey,
          );
          const previous = idempotencyRecords.get(recordKey);
          if (previous) {
            if (
              previous.operation !== "create_invitation" ||
              previous.canonicalRequestHash !== request.canonicalRequestHash
            ) {
              return Object.freeze({ kind: "idempotency_conflict" });
            }
            return Object.freeze({
              kind: "created",
              invitation: freezeInvitationSnapshot(previous.invitation),
              replayed: true,
            });
          }
          if (!SHA256_PATTERN.test(request.canonicalRequestHash)) {
            return Object.freeze({ kind: "invalid_record" });
          }
          if (space.metadataVersion !== request.expectedMetadataVersion) {
            return Object.freeze({
              kind: "metadata_conflict",
              currentMetadataVersion: space.metadataVersion,
            });
          }
          if (
            aggregateMemberships.some(
              (membership) =>
                membership.principalId === request.target.principalId &&
                membership.state === "active",
            )
          ) {
            return Object.freeze({ kind: "active_membership_exists" });
          }
          if (
            aggregateInvitations.some(
              (invitation) =>
                invitation.targetPrincipalId === request.target.principalId &&
                invitation.state === "pending",
            )
          ) {
            return Object.freeze({ kind: "pending_invitation_exists" });
          }

          const invitation = request.invitation;
          const occurredAt = Date.parse(request.occurredAt);
          const expiresAt = Date.parse(invitation.expiresAt);
          if (
            typeof invitation.invitationId !== "string" ||
            !BOUNDED_OPAQUE_ID.test(invitation.invitationId) ||
            invitations.has(invitation.invitationId) ||
            invitation.spaceId !== request.spaceId ||
            invitation.targetPrincipalId !== request.target.principalId ||
            !["reader", "editor", "admin"].includes(invitation.proposedRole) ||
            invitation.state !== "pending" ||
            invitation.version !== 1 ||
            invitation.createdBy !== request.principalId ||
            invitation.updatedBy !== request.principalId ||
            invitation.createdAt !== request.occurredAt ||
            invitation.updatedAt !== request.occurredAt ||
            !Number.isFinite(occurredAt) ||
            !Number.isFinite(expiresAt) ||
            expiresAt - occurredAt !== 7 * 24 * 60 * 60 * 1_000
          ) {
            return Object.freeze({
              kind: invitations.has(invitation.invitationId)
                ? "record_conflict"
                : "invalid_record",
            });
          }
          const expiryJob = request.expiryJob;
          if (
            typeof expiryJob.jobId !== "string" ||
            !BOUNDED_OPAQUE_ID.test(expiryJob.jobId) ||
            expiryJob.target.kind !== "expire_invitation" ||
            expiryJob.target.invitationId !== invitation.invitationId ||
            expiryJob.state !== "queued" ||
            expiryJob.version !== 1 ||
            expiryJob.attempts !== 0 ||
            expiryJob.availableAt !== invitation.expiresAt ||
            expiryJob.claimExpiresAt !== null ||
            expiryJob.createdAt !== request.occurredAt ||
            expiryJob.updatedAt !== request.occurredAt
          ) {
            return Object.freeze({ kind: "invalid_record" });
          }
          if (backgroundJobs.has(expiryJob.jobId)) {
            return Object.freeze({ kind: "expiry_job_conflict" });
          }

          let updatedAggregate: ReturnType<typeof SpaceAggregate.restoreOrdinary>;
          try {
            updatedAggregate = currentAggregate.addInvitation({
              actorPrincipalId: request.principalId,
              invitation: { ...invitation },
              expectedMetadataVersion: request.expectedMetadataVersion,
              occurredAt: request.occurredAt,
            });
          } catch (error) {
            if (
              error instanceof DomainInvariantError &&
              error.code === "duplicate_pending_invitation"
            ) {
              return Object.freeze({ kind: "pending_invitation_exists" });
            }
            if (
              error instanceof DomainInvariantError &&
              error.code === "pending_invitation_for_active_member"
            ) {
              return Object.freeze({ kind: "active_membership_exists" });
            }
            if (
              error instanceof DomainInvariantError &&
              error.code === "settings_permission_required"
            ) {
              return Object.freeze({ kind: "forbidden" });
            }
            if (
              error instanceof DomainInvariantError &&
              error.code === "stale_version"
            ) {
              return Object.freeze({
                kind: "metadata_conflict",
                currentMetadataVersion: space.metadataVersion,
              });
            }
            return Object.freeze({ kind: "invalid_record" });
          }
          const updatedSnapshot = updatedAggregate.snapshot();
          const persisted = updatedSnapshot
            .invitations.find(
              (candidate) => candidate.invitationId === invitation.invitationId,
            );
          if (!persisted) return Object.freeze({ kind: "invalid_record" });
          const candidateInvitations = cloneRecordMap(
            invitations,
            freezeInvitation,
          );
          const candidateKnowledgeSpaces = cloneRecordMap(
            knowledgeSpaces,
            freezeKnowledgeSpace,
          );
          candidateKnowledgeSpaces.set(
            updatedSnapshot.space.spaceId,
            freezeKnowledgeSpace(updatedSnapshot.space),
          );
          candidateInvitations.set(
            persisted.invitationId,
            freezeInvitation(persisted),
          );
          const candidateBackgroundJobs = new Map(backgroundJobs);
          candidateBackgroundJobs.set(expiryJob.jobId, cloneBackgroundJob(expiryJob));
          this.#failOrdinaryMindIfRequested("invitation_after_record");
          const candidateIdempotencyRecords =
            cloneOrdinaryMindIdempotencyRecords(idempotencyRecords);
          const snapshot = freezeInvitationSnapshot({
            invitation: persisted,
            target: request.target,
          });
          candidateIdempotencyRecords.set(
            recordKey,
            Object.freeze({
              operation: "create_invitation" as const,
              principalId: request.principalId,
              spaceId: request.spaceId,
              key: request.idempotencyKey,
              canonicalRequestHash: request.canonicalRequestHash,
              invitation: snapshot,
            }),
          );
          this.#failOrdinaryMindIfRequested("invitation_after_idempotency");
          this.#failOrdinaryMindIfRequested("invitation_after_expiry_job");
          this.#failOrdinaryMindIfRequested("invitation_before_commit");
          knowledgeSpaces = candidateKnowledgeSpaces;
          invitations = candidateInvitations;
          backgroundJobs = candidateBackgroundJobs;
          idempotencyRecords = candidateIdempotencyRecords;
          return Object.freeze({
            kind: "created",
            invitation: snapshot,
            replayed: false,
          });
        },
        transitionInvitation: async (
          request: Readonly<TransitionInvitationRequest>,
        ): Promise<TransitionInvitationResult> => {
          if (
            request.operation !== "accept_invitation" &&
            request.operation !== "reject_invitation" &&
            request.operation !== "cancel_invitation"
          ) {
            return Object.freeze({ kind: "invalid_record" });
          }
          const currentInvitation = invitations.get(request.invitationId);
          if (!currentInvitation) return Object.freeze({ kind: "invitation_not_found" });
          const space = knowledgeSpaces.get(currentInvitation.spaceId);
          if (!space || space.state !== "active") {
            return Object.freeze({ kind: "invitation_not_found" });
          }
          if ([...personalBindings.values()].some((binding) => binding.spaceId === space.spaceId)) {
            return Object.freeze({ kind: "personal_mind" });
          }
          if (
            !invitationLifecycleActorIsCurrentlyAuthorized(
              request.operation,
              request.principalId,
              currentInvitation,
              principals,
              memberships,
            )
          ) {
            return Object.freeze({ kind: "forbidden" });
          }
          const recordKey = invitationLifecycleIdempotencyRecordKey(
            request.principalId,
            space.spaceId,
            request.operation,
            request.idempotencyKey,
          );
          const previous = idempotencyRecords.get(recordKey);
          if (previous) {
            if (
              previous.operation !== request.operation ||
              previous.canonicalRequestHash !== request.canonicalRequestHash ||
              !("lifecycle" in previous)
            ) return Object.freeze({ kind: "idempotency_conflict" });
            return Object.freeze({
              kind: "transitioned",
              result: freezeInvitationLifecycleSnapshot(previous.lifecycle),
              replayed: true,
            });
          }
          if (!SHA256_PATTERN.test(request.canonicalRequestHash)) {
            return Object.freeze({ kind: "invalid_record" });
          }
          if (currentInvitation.version !== request.expectedInvitationVersion) {
            return Object.freeze({ kind: "invitation_version_conflict" });
          }
          if (!Number.isFinite(Date.parse(request.occurredAt))) {
            return Object.freeze({ kind: "invalid_record" });
          }
          const aggregateMemberships = [...memberships.values()].filter(
            (membership) => membership.spaceId === space.spaceId,
          );
          const aggregateInvitations = [...invitations.values()].filter(
            (invitation) => invitation.spaceId === space.spaceId,
          );
          let aggregate;
          try {
            aggregate = SpaceAggregate.restoreOrdinary({
              space,
              memberships: aggregateMemberships,
              invitations: aggregateInvitations,
            });
          } catch {
            return Object.freeze({ kind: "invalid_record" });
          }
          let acceptedMembership: Readonly<SpaceMembership> | null = null;
          try {
            if (request.operation === "accept_invitation") {
              if (
                request.membershipId === null ||
                typeof request.membershipId !== "string" ||
                !BOUNDED_OPAQUE_ID.test(request.membershipId)
              ) return Object.freeze({ kind: "invalid_record" });
              if (memberships.has(request.membershipId)) {
                return Object.freeze({ kind: "record_conflict" });
              }
              acceptedMembership = freezeMembership({
                membershipId: request.membershipId,
                spaceId: currentInvitation.spaceId,
                principalId: currentInvitation.targetPrincipalId,
                role: currentInvitation.proposedRole,
                state: "active",
                version: version(1),
                createdAt: request.occurredAt,
                createdBy: request.principalId,
                updatedAt: request.occurredAt,
                updatedBy: request.principalId,
              });
              aggregate = aggregate.acceptInvitation({
                invitationId: request.invitationId,
                targetPrincipalId: request.principalId,
                expectedInvitationVersion: request.expectedInvitationVersion,
                membership: acceptedMembership,
                occurredAt: request.occurredAt,
              });
            } else if (request.operation === "reject_invitation") {
              if (request.membershipId !== null) return Object.freeze({ kind: "invalid_record" });
              aggregate = aggregate.rejectInvitation({
                invitationId: request.invitationId,
                targetPrincipalId: request.principalId,
                expectedInvitationVersion: request.expectedInvitationVersion,
                occurredAt: request.occurredAt,
              });
            } else {
              if (request.membershipId !== null) return Object.freeze({ kind: "invalid_record" });
              aggregate = aggregate.cancelInvitation({
                invitationId: request.invitationId,
                actorPrincipalId: request.principalId,
                expectedInvitationVersion: request.expectedInvitationVersion,
                occurredAt: request.occurredAt,
              });
            }
          } catch (error) {
            if (!(error instanceof DomainInvariantError)) {
              return Object.freeze({ kind: "invalid_record" });
            }
            if (error.code === "invitation_not_pending") {
              return Object.freeze({ kind: "invitation_not_pending" });
            }
            if (error.code === "invitation_expired") {
              return Object.freeze({ kind: "invitation_expired" });
            }
            if (error.code === "invitation_target_mismatch" || error.code === "settings_permission_required") {
              return Object.freeze({ kind: "forbidden" });
            }
            if (error.code === "duplicate_active_membership" || error.code === "pending_invitation_for_active_member") {
              return Object.freeze({ kind: "active_membership_exists" });
            }
            if (error.code === "stale_version") {
              return Object.freeze({ kind: "invitation_version_conflict" });
            }
            return Object.freeze({ kind: "invalid_record" });
          }
          const updated = aggregate.snapshot();
          const transitioned = updated.invitations.find((item) => item.invitationId === request.invitationId);
          const target = principals.get(currentInvitation.targetPrincipalId);
          if (!transitioned || !target) return Object.freeze({ kind: "invalid_record" });
          const lifecycle = freezeInvitationLifecycleSnapshot({
            invitation: {
              invitation: transitioned,
              target: { principalId: target.principalId, displayName: target.displayName },
            },
            membership: acceptedMembership,
          });
          const candidateSpaces = cloneRecordMap(knowledgeSpaces, freezeKnowledgeSpace);
          const candidateInvitations = cloneRecordMap(invitations, freezeInvitation);
          const candidateMemberships = cloneRecordMap(memberships, freezeMembership);
          candidateSpaces.set(space.spaceId, freezeKnowledgeSpace(updated.space));
          candidateInvitations.set(transitioned.invitationId, freezeInvitation(transitioned));
          this.#failOrdinaryMindIfRequested("invitation_lifecycle_after_record");
          if (acceptedMembership) candidateMemberships.set(acceptedMembership.membershipId, acceptedMembership);
          this.#failOrdinaryMindIfRequested("invitation_lifecycle_after_membership");
          const candidateIdempotency = cloneOrdinaryMindIdempotencyRecords(idempotencyRecords);
          candidateIdempotency.set(recordKey, Object.freeze({
            operation: request.operation,
            principalId: request.principalId,
            spaceId: space.spaceId,
            key: request.idempotencyKey,
            canonicalRequestHash: request.canonicalRequestHash,
            lifecycle,
          }));
          this.#failOrdinaryMindIfRequested("invitation_lifecycle_after_idempotency");
          this.#failOrdinaryMindIfRequested("invitation_lifecycle_before_commit");
          knowledgeSpaces = candidateSpaces;
          invitations = candidateInvitations;
          memberships = candidateMemberships;
          idempotencyRecords = candidateIdempotency;
          return Object.freeze({ kind: "transitioned", result: lifecycle, replayed: false });
        },
        reissueInvitation: async (
          request: Readonly<ReissueInvitationRequest>,
        ): Promise<ReissueInvitationResult> => {
          const current = invitations.get(request.invitationId);
          if (!current) return Object.freeze({ kind: "invitation_not_found" });
          const space = knowledgeSpaces.get(current.spaceId);
          if (!space || space.state !== "active") return Object.freeze({ kind: "invitation_not_found" });
          if ([...personalBindings.values()].some((binding) => binding.spaceId === space.spaceId)) {
            return Object.freeze({ kind: "personal_mind" });
          }
          if (
            !invitationLifecycleActorIsCurrentlyAuthorized(
              "reissue_invitation",
              request.principalId,
              current,
              principals,
              memberships,
            )
          ) {
            return Object.freeze({ kind: "forbidden" });
          }
          const recordKey = invitationLifecycleIdempotencyRecordKey(
            request.principalId,
            space.spaceId,
            "reissue_invitation",
            request.idempotencyKey,
          );
          const previous = idempotencyRecords.get(recordKey);
          if (previous) {
            if (previous.operation !== "reissue_invitation" || previous.canonicalRequestHash !== request.canonicalRequestHash) {
              return Object.freeze({ kind: "idempotency_conflict" });
            }
            return Object.freeze({ kind: "reissued", invitation: freezeInvitationSnapshot(previous.invitation), replayed: true });
          }
          if (!SHA256_PATTERN.test(request.canonicalRequestHash)) return Object.freeze({ kind: "invalid_record" });
          if (current.version !== request.expectedInvitationVersion) return Object.freeze({ kind: "invitation_version_conflict" });
          if (current.state === "accepted") return Object.freeze({ kind: "accepted_invitation" });
          const target = principals.get(current.targetPrincipalId);
          if (!target || target.state !== "active") return Object.freeze({ kind: "invalid_record" });
          const occurredAt = Date.parse(request.occurredAt);
          const expiresAt = Date.parse(request.expiresAt);
          if (
            typeof request.replacementInvitationId !== "string" ||
            !BOUNDED_OPAQUE_ID.test(request.replacementInvitationId) ||
            typeof request.expiryJobId !== "string" ||
            !BOUNDED_OPAQUE_ID.test(request.expiryJobId) ||
            !Number.isFinite(occurredAt) ||
            !Number.isFinite(expiresAt) ||
            expiresAt - occurredAt !== 7 * 24 * 60 * 60 * 1_000
          ) {
            return Object.freeze({ kind: "invalid_record" });
          }
          if (
            invitations.has(request.replacementInvitationId) ||
            backgroundJobs.has(request.expiryJobId)
          ) return Object.freeze({ kind: invitations.has(request.replacementInvitationId) ? "record_conflict" : "expiry_job_conflict" });
          const aggregateMemberships = [...memberships.values()].filter((item) => item.spaceId === space.spaceId);
          const aggregateInvitations = [...invitations.values()].filter((item) => item.spaceId === space.spaceId);
          if (aggregateMemberships.some((item) => item.principalId === current.targetPrincipalId && item.state === "active")) {
            return Object.freeze({ kind: "active_membership_exists" });
          }
          if (aggregateInvitations.some((item) => item.invitationId !== current.invitationId && item.targetPrincipalId === current.targetPrincipalId && item.state === "pending")) {
            return Object.freeze({ kind: "pending_invitation_exists" });
          }
          const replacement = freezeInvitation({
            invitationId: request.replacementInvitationId,
            spaceId: current.spaceId,
            targetPrincipalId: current.targetPrincipalId,
            proposedRole: current.proposedRole,
            state: "pending",
            expiresAt: request.expiresAt,
            version: version(1),
            createdAt: request.occurredAt,
            createdBy: request.principalId,
            updatedAt: request.occurredAt,
            updatedBy: request.principalId,
          });
          let aggregate;
          try {
            aggregate = SpaceAggregate.restoreOrdinary({ space, memberships: aggregateMemberships, invitations: aggregateInvitations })
              .reissueInvitation({
                invitationId: current.invitationId,
                actorPrincipalId: request.principalId,
                expectedInvitationVersion: request.expectedInvitationVersion,
                replacement,
                occurredAt: request.occurredAt,
              });
          } catch (error) {
            if (error instanceof DomainInvariantError && error.code === "settings_permission_required") return Object.freeze({ kind: "forbidden" });
            if (error instanceof DomainInvariantError && error.code === "stale_version") return Object.freeze({ kind: "invitation_version_conflict" });
            if (error instanceof DomainInvariantError && error.code === "duplicate_pending_invitation") return Object.freeze({ kind: "pending_invitation_exists" });
            if (error instanceof DomainInvariantError && error.code === "pending_invitation_for_active_member") return Object.freeze({ kind: "active_membership_exists" });
            return Object.freeze({ kind: "invalid_record" });
          }
          const updated = aggregate.snapshot();
          const persisted = updated.invitations.find((item) => item.invitationId === replacement.invitationId);
          if (!persisted) return Object.freeze({ kind: "invalid_record" });
          const expiryJob = cloneBackgroundJob({
            jobId: request.expiryJobId,
            target: { kind: "expire_invitation", invitationId: persisted.invitationId },
            state: "queued",
            version: version(1),
            attempts: 0,
            availableAt: persisted.expiresAt,
            claimExpiresAt: null,
            createdAt: request.occurredAt,
            updatedAt: request.occurredAt,
          });
          const snapshot = freezeInvitationSnapshot({ invitation: persisted, target });
          const candidateSpaces = cloneRecordMap(knowledgeSpaces, freezeKnowledgeSpace);
          const candidateInvitations = cloneRecordMap(invitations, freezeInvitation);
          const candidateJobs = new Map(backgroundJobs);
          candidateSpaces.set(space.spaceId, freezeKnowledgeSpace(updated.space));
          for (const item of updated.invitations) candidateInvitations.set(item.invitationId, freezeInvitation(item));
          this.#failOrdinaryMindIfRequested("invitation_reissue_after_record");
          candidateJobs.set(expiryJob.jobId, expiryJob);
          this.#failOrdinaryMindIfRequested("invitation_reissue_after_job");
          const candidateIdempotency = cloneOrdinaryMindIdempotencyRecords(idempotencyRecords);
          candidateIdempotency.set(recordKey, Object.freeze({
            operation: "reissue_invitation",
            principalId: request.principalId,
            spaceId: space.spaceId,
            key: request.idempotencyKey,
            canonicalRequestHash: request.canonicalRequestHash,
            invitation: snapshot,
          }));
          this.#failOrdinaryMindIfRequested("invitation_reissue_after_idempotency");
          this.#failOrdinaryMindIfRequested("invitation_reissue_before_commit");
          knowledgeSpaces = candidateSpaces;
          invitations = candidateInvitations;
          backgroundJobs = candidateJobs;
          idempotencyRecords = candidateIdempotency;
          return Object.freeze({ kind: "reissued", invitation: snapshot, replayed: false });
        },
        createOrdinaryMind: async (
          records: Readonly<OrdinaryMindRecordSet>,
        ): Promise<CreateOrdinaryMindResult> => {
          const principalId = records.ownerMembership.principalId;
          const idempotencyRecordKey = ordinaryMindCreateIdempotencyKey(
            principalId,
            records.idempotencyKey,
          );
          const principal = this.#principals.get(principalId);
          if (!principal || principal.state !== "active") {
            return Object.freeze({ kind: "principal_not_found" });
          }
          const previous = idempotencyRecords.get(idempotencyRecordKey);
          if (previous) {
            if (
              previous.operation !== "create_space_with_owner"
            ) {
              return Object.freeze({ kind: "idempotency_conflict" });
            }
            const currentSpace = knowledgeSpaces.get(previous.mind.space.spaceId);
            const currentReservation = activeBySpace.get(
              previous.mind.space.spaceId,
            );
            const currentMembership = [...memberships.values()].find(
              (membership) =>
                membership.spaceId === previous.mind.space.spaceId &&
                membership.principalId === principalId &&
                membership.state === "active",
            );
            const isPersonal = [...this.#personalBindings.values()].some(
              (binding) => binding.spaceId === previous.mind.space.spaceId,
            );
            if (
              !currentSpace ||
              currentSpace.state !== "active" ||
              !currentReservation ||
              currentReservation.spaceId !== currentSpace.spaceId ||
              currentReservation.canonicalHandle !== currentSpace.normalizedHandle ||
              isPersonal ||
              ordinaryMindSnapshotFromMaps(
                currentSpace.spaceId,
                knowledgeSpaces,
                memberships,
              ) === null
            ) {
              return Object.freeze({ kind: "mind_not_found" });
            }
            if (
              !currentMembership ||
              !roleHasCapability(currentMembership.role, "settings:configure")
            ) {
              return Object.freeze({ kind: "forbidden" });
            }
            if (previous.canonicalRequestHash !== records.canonicalRequestHash) {
              return Object.freeze({ kind: "idempotency_conflict" });
            }
            return Object.freeze({
              kind: "created",
              mind: freezeOrdinaryMindSnapshot(previous.mind),
              replayed: true,
            });
          }
          const validated = validateOrdinaryMindRecords(records);
          if (validated === null) return Object.freeze({ kind: "invalid_record" });

          const space = records.space;
          const membership = records.ownerMembership;
          const revisionId = records.initialRevision.revision.revisionId;
          if (
            knowledgeSpaces.has(space.spaceId) ||
            memberships.has(membership.membershipId) ||
            revisionSpaces.has(space.spaceId) ||
            revisionsById.has(revisionId)
          ) {
            return Object.freeze({ kind: "record_conflict" });
          }
          const candidateKnowledgeSpaces = cloneRecordMap(
            knowledgeSpaces,
            freezeKnowledgeSpace,
          );
          const candidateMemberships = cloneRecordMap(
            memberships,
            freezeMembership,
          );
          const candidateRevisionSpaces = cloneSpaces(revisionSpaces);
          const candidateRevisionsById = new Map(revisionsById);
          const candidateIdempotencyRecords =
            cloneOrdinaryMindIdempotencyRecords(idempotencyRecords);
          const candidateActiveByHandle = new Map(activeByHandle);
          const candidateActiveBySpace = new Map(activeBySpace);
          const candidateRetired = new Map(retired);

          const reserved = reserveHandleAgainst(
            {
              host: records.host,
              handle: space.spaceHandle,
              spaceId: space.spaceId,
            },
            {
              activeByHandle: candidateActiveByHandle,
              activeBySpace: candidateActiveBySpace,
              retired: candidateRetired,
            },
          );
          if (reserved.kind !== "reserved") {
            return Object.freeze({
              kind:
                reserved.kind === "handle_unavailable"
                  ? "handle_unavailable"
                  : "invalid_record",
            });
          }
          if (reserved.replayed) {
            return Object.freeze({ kind: "record_conflict" });
          }
          this.#failOrdinaryMindIfRequested("create_after_handle");

          const revisionResult = await this.#commitRevisionAgainst(
            {
              expectedHeadRevisionId: null,
              envelope: records.initialRevision,
            },
            candidateRevisionSpaces,
            candidateRevisionsById,
          );
          if (
            revisionResult.kind !== "committed" ||
            revisionResult.replayed ||
            !revisionEnvelopesEqual(
              revisionResult.envelope,
              records.initialRevision,
            )
          ) {
            return Object.freeze({ kind: "record_conflict" });
          }
          this.#failOrdinaryMindIfRequested("create_after_revision");

          candidateKnowledgeSpaces.set(
            space.spaceId,
            freezeKnowledgeSpace(space),
          );
          this.#failOrdinaryMindIfRequested("create_after_space");
          candidateMemberships.set(
            membership.membershipId,
            freezeMembership(membership),
          );
          this.#failOrdinaryMindIfRequested("create_after_membership");
          const created = ordinaryMindSnapshotFromMaps(
            space.spaceId,
            candidateKnowledgeSpaces,
            candidateMemberships,
          );
          if (created === null) return Object.freeze({ kind: "invalid_record" });

          candidateIdempotencyRecords.set(
            idempotencyRecordKey,
            Object.freeze({
              operation: "create_space_with_owner" as const,
              principalId,
              key: records.idempotencyKey,
              canonicalRequestHash: records.canonicalRequestHash,
              mind: freezeOrdinaryMindSnapshot(created),
            }),
          );
          this.#failOrdinaryMindIfRequested("create_after_idempotency");
          this.#failOrdinaryMindIfRequested("create_before_commit");
          knowledgeSpaces = candidateKnowledgeSpaces;
          memberships = candidateMemberships;
          revisionSpaces = candidateRevisionSpaces;
          revisionsById = candidateRevisionsById;
          idempotencyRecords = candidateIdempotencyRecords;
          activeByHandle = candidateActiveByHandle;
          activeBySpace = candidateActiveBySpace;
          retired = candidateRetired;
          return Object.freeze({ kind: "created", mind: created, replayed: false });
        },

        renameOrdinaryMind: async (
          request: Readonly<RenameOrdinaryMindRequest>,
        ): Promise<RenameOrdinaryMindResult> => {
          const idempotencyRecordKey = ordinaryMindRenameIdempotencyKey(
            request.principalId,
            request.spaceId,
            request.idempotencyKey,
          );
          const principal = this.#principals.get(request.principalId);
          if (!principal || principal.state !== "active") {
            return Object.freeze({ kind: "forbidden" });
          }
          const space = knowledgeSpaces.get(request.spaceId);
          if (!space || space.state !== "active") {
            return Object.freeze({ kind: "mind_not_found" });
          }
          const personalBinding = [...this.#personalBindings.values()].find(
            (binding) => binding.spaceId === request.spaceId,
          );
          if (personalBinding) {
            return Object.freeze({
              kind:
                personalBinding.principalId === request.principalId
                  ? "personal_mind"
                  : "mind_not_found",
            });
          }

          const aggregateMemberships = [...memberships.values()].filter(
            (membership) => membership.spaceId === request.spaceId,
          );
          let currentAggregate: ReturnType<typeof SpaceAggregate.restoreOrdinary>;
          try {
            currentAggregate = SpaceAggregate.restoreOrdinary({
              space,
              memberships: aggregateMemberships,
            });
          } catch {
            return Object.freeze({ kind: "invalid_record" });
          }
          const currentMembership = currentAggregate
            .snapshot()
            .memberships.find(
              (membership) =>
                membership.principalId === request.principalId &&
                membership.state === "active",
            );
          if (
            !currentMembership ||
            !roleHasCapability(currentMembership.role, "settings:configure")
          ) {
            return Object.freeze({ kind: "forbidden" });
          }

          const previous = idempotencyRecords.get(idempotencyRecordKey);
          if (previous) {
            if (
              previous.operation !== "rename_space" ||
              previous.canonicalRequestHash !== request.canonicalRequestHash
            ) {
              return Object.freeze({ kind: "idempotency_conflict" });
            }
            return Object.freeze({
              kind: "renamed",
              mind: freezeOrdinaryMindSnapshot(previous.mind),
              replayed: true,
            });
          }
          if (!SHA256_PATTERN.test(request.canonicalRequestHash)) {
            return Object.freeze({ kind: "invalid_record" });
          }

          let renamedAggregate: ReturnType<typeof SpaceAggregate.restoreOrdinary>;
          try {
            renamedAggregate = currentAggregate.rename({
              actorPrincipalId: request.principalId,
              name: request.displayName,
              expectedMetadataVersion: request.expectedMetadataVersion,
              occurredAt: request.occurredAt,
            });
          } catch (error) {
            if (error instanceof DomainInvariantError) {
              if (error.code === "stale_version") {
                return Object.freeze({
                  kind: "metadata_conflict",
                  currentMetadataVersion: space.metadataVersion,
                });
              }
              if (error.code === "settings_permission_required") {
                return Object.freeze({ kind: "forbidden" });
              }
              if (error.code === "space_not_active") {
                return Object.freeze({ kind: "mind_not_found" });
              }
            }
            return Object.freeze({ kind: "invalid_record" });
          }

          const candidateKnowledgeSpaces = cloneRecordMap(
            knowledgeSpaces,
            freezeKnowledgeSpace,
          );
          const candidateIdempotencyRecords =
            cloneOrdinaryMindIdempotencyRecords(idempotencyRecords);
          const renamedSnapshot = renamedAggregate.snapshot();
          candidateKnowledgeSpaces.set(
            request.spaceId,
            freezeKnowledgeSpace(renamedSnapshot.space),
          );
          this.#failOrdinaryMindIfRequested("rename_after_space");
          const renamed = ordinaryMindSnapshotFromMaps(
            request.spaceId,
            candidateKnowledgeSpaces,
            memberships,
          );
          if (renamed === null) return Object.freeze({ kind: "invalid_record" });
          candidateIdempotencyRecords.set(
            idempotencyRecordKey,
            Object.freeze({
              operation: "rename_space" as const,
              principalId: request.principalId,
              spaceId: request.spaceId,
              key: request.idempotencyKey,
              canonicalRequestHash: request.canonicalRequestHash,
              mind: freezeOrdinaryMindSnapshot(renamed),
            }),
          );
          this.#failOrdinaryMindIfRequested("rename_after_idempotency");
          this.#failOrdinaryMindIfRequested("rename_before_commit");
          knowledgeSpaces = candidateKnowledgeSpaces;
          idempotencyRecords = candidateIdempotencyRecords;
          return Object.freeze({ kind: "renamed", mind: renamed, replayed: false });
        },

        changeOrdinaryMindVisibility: async (
          request: Readonly<ChangeOrdinaryMindVisibilityRequest>,
        ): Promise<ChangeOrdinaryMindVisibilityResult> => {
          const principal = principals.get(request.principalId);
          if (!principal || principal.state !== "active") {
            return Object.freeze({ kind: "forbidden" });
          }
          const space = knowledgeSpaces.get(request.spaceId);
          if (!space || space.state !== "active") {
            return Object.freeze({ kind: "mind_not_found" });
          }
          const personalBinding = [...personalBindings.values()].find(
            (binding) => binding.spaceId === request.spaceId,
          );
          if (personalBinding) {
            return Object.freeze({
              kind:
                personalBinding.principalId === request.principalId
                  ? "personal_mind"
                  : "mind_not_found",
            });
          }

          const aggregateMemberships = [...memberships.values()].filter(
            (membership) => membership.spaceId === request.spaceId,
          );
          let currentAggregate: ReturnType<typeof SpaceAggregate.restoreOrdinary>;
          try {
            currentAggregate = SpaceAggregate.restoreOrdinary({
              space,
              memberships: aggregateMemberships,
            });
          } catch {
            return Object.freeze({ kind: "invalid_record" });
          }
          const currentOwner = currentAggregate
            .snapshot()
            .memberships.find(
              (membership) =>
                membership.principalId === request.principalId &&
                membership.state === "active" &&
                membership.role === "owner",
            );
          if (!currentOwner) return Object.freeze({ kind: "forbidden" });

          const idempotencyRecordKey = ordinaryMindVisibilityIdempotencyKey(
            request.principalId,
            request.spaceId,
            request.idempotencyKey,
          );
          const previous = idempotencyRecords.get(idempotencyRecordKey);
          if (previous) {
            if (
              previous.operation !== "change_visibility" ||
              previous.canonicalRequestHash !== request.canonicalRequestHash
            ) {
              return Object.freeze({ kind: "idempotency_conflict" });
            }
            return Object.freeze({
              kind: "visibility_changed",
              mind: freezeOrdinaryMindSnapshot(previous.mind),
              changed: previous.changed,
              replayed: true,
            });
          }
          if (!SHA256_PATTERN.test(request.canonicalRequestHash)) {
            return Object.freeze({ kind: "invalid_record" });
          }
          if (space.metadataVersion !== request.expectedMetadataVersion) {
            return Object.freeze({
              kind: "metadata_conflict",
              currentMetadataVersion: space.metadataVersion,
            });
          }
          if (space.visibility === request.visibility) {
            const current = ordinaryMindSnapshotFromMaps(
              request.spaceId,
              knowledgeSpaces,
              memberships,
            );
            if (current === null) return Object.freeze({ kind: "invalid_record" });
            const candidateIdempotencyRecords =
              cloneOrdinaryMindIdempotencyRecords(idempotencyRecords);
            candidateIdempotencyRecords.set(
              idempotencyRecordKey,
              Object.freeze({
                operation: "change_visibility" as const,
                principalId: request.principalId,
                spaceId: request.spaceId,
                key: request.idempotencyKey,
                canonicalRequestHash: request.canonicalRequestHash,
                mind: freezeOrdinaryMindSnapshot(current),
                changed: false,
              }),
            );
            this.#failOrdinaryMindIfRequested("visibility_after_idempotency");
            this.#failOrdinaryMindIfRequested("visibility_before_commit");
            idempotencyRecords = candidateIdempotencyRecords;
            return Object.freeze({
              kind: "visibility_changed",
              mind: current,
              changed: false,
              replayed: false,
            });
          }
          if (
            space.visibility === "private" &&
            request.visibility !== "private" &&
            !request.acknowledgeLiveHeadAndHistoryExposure
          ) {
            return Object.freeze({
              kind: "exposure_acknowledgement_required",
            });
          }

          let changedAggregate: ReturnType<typeof SpaceAggregate.restoreOrdinary>;
          try {
            changedAggregate = currentAggregate.changeVisibility({
              actorPrincipalId: request.principalId,
              visibility: request.visibility,
              expectedMetadataVersion: request.expectedMetadataVersion,
              occurredAt: request.occurredAt,
            });
          } catch (error) {
            if (error instanceof DomainInvariantError) {
              if (error.code === "stale_version") {
                return Object.freeze({
                  kind: "metadata_conflict",
                  currentMetadataVersion: space.metadataVersion,
                });
              }
              if (error.code === "owner_required") {
                return Object.freeze({ kind: "forbidden" });
              }
              if (error.code === "space_not_active") {
                return Object.freeze({ kind: "mind_not_found" });
              }
              if (error.code === "personal_visibility") {
                return Object.freeze({ kind: "personal_mind" });
              }
            }
            return Object.freeze({ kind: "invalid_record" });
          }

          const candidateKnowledgeSpaces = cloneRecordMap(
            knowledgeSpaces,
            freezeKnowledgeSpace,
          );
          const candidateIdempotencyRecords =
            cloneOrdinaryMindIdempotencyRecords(idempotencyRecords);
          const candidateAuditEvents = new Map(
            [...auditEvents].map(([id, event]) => [id, cloneAuditEvent(event)]),
          );
          const candidateAuditOutbox = new Map(
            [...auditOutbox].map(([id, message]) => [
              id,
              cloneAuditOutbox(message),
            ]),
          );
          const changedSnapshot = changedAggregate.snapshot();
          candidateKnowledgeSpaces.set(
            request.spaceId,
            freezeKnowledgeSpace(changedSnapshot.space),
          );
          this.#failOrdinaryMindIfRequested("visibility_after_space");
          const candidatePublicCatalogSpaceIds =
            derivePublicMindCatalogSpaceIds(
              candidateKnowledgeSpaces,
              personalBindings,
            );
          const candidatePublicCatalogSnapshots = clonePublicCatalogSnapshots(
            publicCatalogSnapshots,
          );
          const candidatePublicCatalogGeneration = publicCatalogGeneration + 1;
          stagePublicCatalogSnapshot(
            candidatePublicCatalogGeneration,
            candidatePublicCatalogSpaceIds,
            candidatePublicCatalogSnapshots,
          );
          this.#failOrdinaryMindIfRequested("visibility_after_catalog");
          if (
            !stageVisibilityAuditEffects(
              request,
              space,
              changedSnapshot.space,
              candidateAuditEvents,
              candidateAuditOutbox,
            )
          ) {
            return Object.freeze({ kind: "effect_conflict" });
          }
          this.#failOrdinaryMindIfRequested("visibility_after_audit");
          const changed = ordinaryMindSnapshotFromMaps(
            request.spaceId,
            candidateKnowledgeSpaces,
            memberships,
          );
          if (changed === null) return Object.freeze({ kind: "invalid_record" });
          candidateIdempotencyRecords.set(
            idempotencyRecordKey,
            Object.freeze({
              operation: "change_visibility" as const,
              principalId: request.principalId,
              spaceId: request.spaceId,
              key: request.idempotencyKey,
              canonicalRequestHash: request.canonicalRequestHash,
              mind: freezeOrdinaryMindSnapshot(changed),
              changed: true,
            }),
          );
          this.#failOrdinaryMindIfRequested("visibility_after_idempotency");
          this.#failOrdinaryMindIfRequested("visibility_before_commit");
          knowledgeSpaces = candidateKnowledgeSpaces;
          publicCatalogGeneration = candidatePublicCatalogGeneration;
          publicCatalogSpaceIds = candidatePublicCatalogSpaceIds;
          publicCatalogSnapshots = candidatePublicCatalogSnapshots;
          idempotencyRecords = candidateIdempotencyRecords;
          auditEvents = candidateAuditEvents;
          auditOutbox = candidateAuditOutbox;
          return Object.freeze({
            kind: "visibility_changed",
            mind: changed,
            changed: true,
            replayed: false,
          });
        },

        transferOrdinaryMindOwnership: async (
          request: Readonly<TransferOrdinaryMindOwnershipRequest>,
        ): Promise<TransferOrdinaryMindOwnershipResult> => {
          const principal = principals.get(request.principalId);
          if (!principal || principal.state !== "active") {
            return Object.freeze({ kind: "forbidden" });
          }
          const space = knowledgeSpaces.get(request.spaceId);
          if (!space || space.state !== "active") {
            return Object.freeze({ kind: "mind_not_found" });
          }
          const personalBinding = [...personalBindings.values()].find(
            (binding) => binding.spaceId === request.spaceId,
          );
          if (personalBinding) {
            return Object.freeze({
              kind:
                personalBinding.principalId === request.principalId
                  ? "personal_mind"
                  : "mind_not_found",
            });
          }

          const recordKey = ownershipTransferIdempotencyKey(
            request.principalId,
            request.spaceId,
            request.idempotencyKey,
          );
          const previous = idempotencyRecords.get(recordKey);
          if (previous) {
            if (
              previous.operation !== "transfer_ownership" ||
              previous.canonicalRequestHash !== request.canonicalRequestHash
            ) {
              return Object.freeze({ kind: "idempotency_conflict" });
            }
            const current = ownershipTransferSnapshotFromMaps(
              request.spaceId,
              previous.transfer.sourceMembership.membershipId,
              previous.transfer.targetMembership.membershipId,
              knowledgeSpaces,
              memberships,
            );
            if (
              current === null ||
              !sameOwnershipTransferSnapshot(current, previous.transfer)
            ) {
              return Object.freeze({ kind: "ownership_state_changed" });
            }
            return Object.freeze({
              kind: "transferred",
              transfer: current,
              replayed: true,
            });
          }
          if (
            !SHA256_PATTERN.test(request.canonicalRequestHash) ||
            typeof request.targetMembershipId !== "string" ||
            !BOUNDED_OPAQUE_ID.test(request.targetMembershipId) ||
            typeof request.requestId !== "string" ||
            !BOUNDED_OPAQUE_ID.test(request.requestId) ||
            typeof request.auditEventId !== "string" ||
            !BOUNDED_OPAQUE_ID.test(request.auditEventId) ||
            typeof request.auditOutboxMessageId !== "string" ||
            !BOUNDED_OPAQUE_ID.test(request.auditOutboxMessageId) ||
            !Number.isFinite(Date.parse(request.occurredAt))
          ) {
            return Object.freeze({ kind: "invalid_record" });
          }
          if (space.metadataVersion !== request.expectedMetadataVersion) {
            return Object.freeze({
              kind: "metadata_conflict",
              currentMetadataVersion: space.metadataVersion,
            });
          }

          const aggregateMemberships = [...memberships.values()].filter(
            (membership) => membership.spaceId === request.spaceId,
          );
          const aggregateInvitations = [...invitations.values()].filter(
            (invitation) => invitation.spaceId === request.spaceId,
          );
          const source = aggregateMemberships.find(
            (membership) =>
              membership.principalId === request.principalId &&
              membership.state === "active",
          );
          const target = memberships.get(request.targetMembershipId);
          if (!source || source.role !== "owner") {
            return Object.freeze({ kind: "forbidden" });
          }
          if (
            !target ||
            target.spaceId !== request.spaceId ||
            target.state !== "active" ||
            target.role === "owner" ||
            target.principalId === request.principalId
          ) {
            return Object.freeze({ kind: "ownership_target_invalid" });
          }

          let transferredAggregate: ReturnType<
            typeof SpaceAggregate.restoreOrdinary
          >;
          try {
            transferredAggregate = SpaceAggregate.restoreOrdinary({
              space,
              memberships: aggregateMemberships,
              invitations: aggregateInvitations,
            }).transferOwnership({
              sourcePrincipalId: request.principalId,
              targetPrincipalId: target.principalId,
              expectedMetadataVersion: request.expectedMetadataVersion,
              expectedSourceMembershipVersion: source.version,
              expectedTargetMembershipVersion: target.version,
              occurredAt: request.occurredAt,
            });
          } catch (error) {
            if (error instanceof DomainInvariantError) {
              if (error.code === "stale_version") {
                return Object.freeze({
                  kind: "metadata_conflict",
                  currentMetadataVersion: space.metadataVersion,
                });
              }
              if (error.code === "owner_required") {
                return Object.freeze({ kind: "forbidden" });
              }
              if (error.code === "ownership_target_invalid") {
                return Object.freeze({ kind: "ownership_target_invalid" });
              }
              if (error.code === "space_not_active") {
                return Object.freeze({ kind: "mind_not_found" });
              }
            }
            return Object.freeze({ kind: "invalid_record" });
          }

          const updated = transferredAggregate.snapshot();
          const candidateKnowledgeSpaces = cloneRecordMap(
            knowledgeSpaces,
            freezeKnowledgeSpace,
          );
          const candidateMemberships = cloneRecordMap(
            memberships,
            freezeMembership,
          );
          const candidateAuditEvents = new Map(
            [...auditEvents].map(([id, event]) => [id, cloneAuditEvent(event)]),
          );
          const candidateAuditOutbox = new Map(
            [...auditOutbox].map(([id, message]) => [
              id,
              cloneAuditOutbox(message),
            ]),
          );
          const candidateIdempotencyRecords =
            cloneOrdinaryMindIdempotencyRecords(idempotencyRecords);
          candidateKnowledgeSpaces.set(
            request.spaceId,
            freezeKnowledgeSpace(updated.space),
          );
          this.#failOrdinaryMindIfRequested("ownership_after_space");
          for (const membership of updated.memberships) {
            candidateMemberships.set(
              membership.membershipId,
              freezeMembership(membership),
            );
          }
          this.#failOrdinaryMindIfRequested("ownership_after_memberships");
          const currentSource = candidateMemberships.get(source.membershipId);
          const currentTarget = candidateMemberships.get(target.membershipId);
          if (!currentSource || !currentTarget) {
            return Object.freeze({ kind: "invalid_record" });
          }
          const transfer = ownershipTransferSnapshotFromMaps(
            request.spaceId,
            currentSource.membershipId,
            currentTarget.membershipId,
            candidateKnowledgeSpaces,
            candidateMemberships,
          );
          if (transfer === null) {
            return Object.freeze({ kind: "invalid_record" });
          }
          if (
            !stageOwnershipTransferAuditEffects(
              request,
              space,
              updated.space,
              source,
              currentSource,
              target,
              currentTarget,
              candidateAuditEvents,
              candidateAuditOutbox,
            )
          ) {
            return Object.freeze({ kind: "effect_conflict" });
          }
          this.#failOrdinaryMindIfRequested("ownership_after_audit");
          candidateIdempotencyRecords.set(
            recordKey,
            Object.freeze({
              operation: "transfer_ownership" as const,
              principalId: request.principalId,
              spaceId: request.spaceId,
              key: request.idempotencyKey,
              canonicalRequestHash: request.canonicalRequestHash,
              transfer: freezeOwnershipTransferSnapshot(transfer),
            }),
          );
          this.#failOrdinaryMindIfRequested("ownership_after_idempotency");
          this.#failOrdinaryMindIfRequested("ownership_before_commit");
          knowledgeSpaces = candidateKnowledgeSpaces;
          memberships = candidateMemberships;
          auditEvents = candidateAuditEvents;
          auditOutbox = candidateAuditOutbox;
          idempotencyRecords = candidateIdempotencyRecords;
          return Object.freeze({
            kind: "transferred",
            transfer,
            replayed: false,
          });
        },

        createOrdinaryMindDeletionImpact: async (
          request: Readonly<CreateOrdinaryMindDeletionImpactRequest>,
        ): Promise<CreateOrdinaryMindDeletionImpactResult> => {
          const parsed = parseCanonicalSpaceHandle(request.handle);
          const occurredAt = Date.parse(request.occurredAt);
          const expiresAt = Date.parse(request.expiresAt);
          if (
            parsed.kind !== "valid" ||
            isReservedTopLevelHandle(parsed.canonicalHandle) ||
            parsed.canonicalHandle !== request.handle ||
            !BOUNDED_OPAQUE_ID.test(request.impactId) ||
            !Number.isFinite(occurredAt) ||
            !Number.isFinite(expiresAt) ||
            expiresAt <= occurredAt
          ) {
            return Object.freeze({ kind: "invalid_record" });
          }
          for (const [impactId, candidate] of deletionImpacts) {
            if (Date.parse(candidate.expiresAt) <= occurredAt) {
              deletionImpacts.delete(impactId);
            }
          }
          if (
            deletionImpacts.has(request.impactId) ||
            deletionCleanup.has(request.impactId)
          ) {
            return Object.freeze({ kind: "impact_id_collision" });
          }
          const principal = principals.get(request.principalId);
          if (!principal || principal.state !== "active") {
            return Object.freeze({ kind: "forbidden" });
          }
          const reservation = activeByHandle.get(
            handleKey(request.host, parsed.canonicalHandle),
          );
          if (!reservation) return Object.freeze({ kind: "mind_not_found" });
          const space = knowledgeSpaces.get(reservation.spaceId);
          if (!space || space.state !== "active") {
            return Object.freeze({ kind: "mind_not_found" });
          }
          const personal = [...personalBindings.values()].find(
            (binding) => binding.spaceId === space.spaceId,
          );
          if (personal) {
            return Object.freeze({
              kind:
                personal.principalId === request.principalId
                  ? "personal_mind"
                  : "mind_not_found",
            });
          }
          const aggregate = ordinaryMindSnapshotFromMaps(
            space.spaceId,
            knowledgeSpaces,
            memberships,
          );
          if (aggregate === null) return Object.freeze({ kind: "invalid_record" });
          if (
            aggregate.ownerMembership.principalId !== request.principalId ||
            aggregate.ownerMembership.state !== "active" ||
            aggregate.ownerMembership.role !== "owner"
          ) {
            return Object.freeze({ kind: "forbidden" });
          }
          const stateFingerprint = ordinaryMindDeletionFingerprint(
            space.spaceId,
            deletionState(),
          );
          const revisionState = revisionSpaces.get(space.spaceId);
          if (stateFingerprint === null || !revisionState) {
            return Object.freeze({ kind: "invalid_record" });
          }
          const selected = targetRecordSelection(space.spaceId, deletionState());
          const impact = cloneOrdinaryMindDeletionImpact({
            impactId: request.impactId,
            principalId: request.principalId,
            host: request.host,
            spaceId: space.spaceId,
            canonicalHandle: parsed.canonicalHandle,
            name: space.name,
            expiresAt: request.expiresAt,
            metadataVersion: space.metadataVersion,
            accessVersion: space.accessVersion,
            headRevisionId: space.headRevisionId,
            revisionCount: selected.revisionIds.length,
            membershipCount: selected.membershipIds.length,
            invitationCount: selected.invitationIds.length,
            backgroundJobCount: selected.backgroundJobIds.length,
            exportJobCount: selected.exportJobIds.length,
            stateFingerprint,
          });
          deletionImpacts.set(impact.impactId, impact);
          this.#failOrdinaryMindIfRequested("deletion_impact_after_record");
          this.#failOrdinaryMindIfRequested("deletion_impact_before_commit");
          return Object.freeze({ kind: "created", impact });
        },

        deleteOrdinaryMind: async (
          request: Readonly<DeleteOrdinaryMindRequest>,
        ): Promise<DeleteOrdinaryMindResult> => {
          const parsed = parseCanonicalSpaceHandle(request.handle);
          if (
            parsed.kind !== "valid" ||
            isReservedTopLevelHandle(parsed.canonicalHandle) ||
            parsed.canonicalHandle !== request.handle ||
            !BOUNDED_OPAQUE_ID.test(request.impactId) ||
            !Number.isFinite(Date.parse(request.occurredAt))
          ) {
            return Object.freeze({ kind: "invalid_record" });
          }
          const reservation = activeByHandle.get(
            handleKey(request.host, parsed.canonicalHandle),
          );
          if (!reservation) {
            const pending = [...deletionCleanup.values()].find(
              (work) =>
                work.host === request.host &&
                work.canonicalHandle === parsed.canonicalHandle,
            );
            if (!pending) return Object.freeze({ kind: "already_absent" });
            if (
              pending.impactId !== request.impactId ||
              pending.principalId !== request.principalId
            ) {
              return Object.freeze({ kind: "mind_not_found" });
            }
            if (pending.idempotencyKey !== request.idempotencyKey) {
              return Object.freeze({ kind: "idempotency_conflict" });
            }
            return Object.freeze({
              kind: "cleanup_pending",
              cleanup: cloneOrdinaryMindDeletionCleanup(pending),
            });
          }
          const principal = principals.get(request.principalId);
          if (!principal || principal.state !== "active") {
            return Object.freeze({ kind: "forbidden" });
          }
          const spaceId = reservation.spaceId;
          const space = knowledgeSpaces.get(spaceId);
          if (!space || space.state !== "active") {
            return Object.freeze({ kind: "mind_not_found" });
          }
          const personal = [...personalBindings.values()].find(
            (binding) => binding.spaceId === spaceId,
          );
          if (personal) {
            return Object.freeze({
              kind:
                personal.principalId === request.principalId
                  ? "personal_mind"
                  : "mind_not_found",
            });
          }
          const aggregate = ordinaryMindSnapshotFromMaps(
            spaceId,
            knowledgeSpaces,
            memberships,
          );
          if (aggregate === null) return Object.freeze({ kind: "invalid_record" });
          if (
            aggregate.ownerMembership.principalId !== request.principalId ||
            aggregate.ownerMembership.state !== "active" ||
            aggregate.ownerMembership.role !== "owner"
          ) {
            return Object.freeze({ kind: "forbidden" });
          }
          const impact = deletionImpacts.get(request.impactId);
          if (
            !impact ||
            impact.principalId !== request.principalId ||
            impact.spaceId !== spaceId ||
            impact.host !== request.host ||
            impact.canonicalHandle !== parsed.canonicalHandle
          ) {
            return Object.freeze({ kind: "deletion_impact_changed" });
          }
          if (Date.parse(request.occurredAt) >= Date.parse(impact.expiresAt)) {
            deletionImpacts.delete(impact.impactId);
            return Object.freeze({ kind: "deletion_impact_expired" });
          }
          const currentFingerprint = ordinaryMindDeletionFingerprint(
            spaceId,
            deletionState(),
          );
          if (
            currentFingerprint === null ||
            currentFingerprint !== impact.stateFingerprint
          ) {
            deletionImpacts.delete(impact.impactId);
            return Object.freeze({ kind: "deletion_impact_changed" });
          }
          if (deletionCleanup.has(request.impactId)) {
            return Object.freeze({ kind: "invalid_record" });
          }
          const selected = targetRecordSelection(spaceId, deletionState());
          const targetRevisions = revisionSpaces.get(spaceId)?.revisions;
          if (!targetRevisions) return Object.freeze({ kind: "invalid_record" });
          const targetDigests = new Set<Digest>();
          for (const envelope of targetRevisions.values()) {
            for (const entry of envelope.manifest.entries) {
              targetDigests.add(entry.sha256);
            }
          }
          const remainingReachable = new Set<Digest>();
          for (const [candidateSpaceId, state] of revisionSpaces) {
            if (candidateSpaceId === spaceId) continue;
            for (const envelope of state.revisions.values()) {
              for (const entry of envelope.manifest.entries) {
                remainingReachable.add(entry.sha256);
              }
            }
          }
          const cleanup = cloneOrdinaryMindDeletionCleanup({
            impactId: request.impactId,
            idempotencyKey: request.idempotencyKey,
            principalId: request.principalId,
            spaceId,
            host: request.host,
            canonicalHandle: parsed.canonicalHandle,
            objectDigests: Object.freeze(
              [...targetDigests]
                .filter((digest) => !remainingReachable.has(digest))
                .sort(),
            ),
            deleteBefore: request.occurredAt,
          });

          const retiredResult = retireHandleAgainst(
            {
              host: request.host,
              handle: parsed.canonicalHandle,
              spaceId,
            },
            { activeByHandle, activeBySpace, retired },
          );
          if (retiredResult.kind !== "retired") {
            return Object.freeze({ kind: "invalid_record" });
          }
          this.#failOrdinaryMindIfRequested("delete_after_handle_retirement");

          knowledgeSpaces.delete(spaceId);
          selected.membershipIds.forEach((id) => memberships.delete(id));
          selected.invitationIds.forEach((id) => invitations.delete(id));
          revisionSpaces.delete(spaceId);
          selected.revisionIds.forEach((id) => revisionsById.delete(id));
          selected.ordinaryIdempotencyKeys.forEach((key) =>
            idempotencyRecords.delete(key));
          selected.contentIdempotencyKeys.forEach((key) =>
            contentIdempotencyRecords.delete(key));
          for (const key of membershipMutationRecords.keys()) {
            if (key.split("\u0000")[1] === spaceId) {
              membershipMutationRecords.delete(key);
            }
          }
          selected.backgroundJobIds.forEach((id) => backgroundJobs.delete(id));
          selected.exportJobIds.forEach((id) => exportJobs.delete(id));
          selected.exportGrantKeys.forEach((key) =>
            exportDownloadGrants.delete(key));
          selected.indexKeys.forEach((key) => indexStates.delete(key));
          selected.outboxIds.forEach((id) => auditOutbox.delete(id));
          selected.auditIds.forEach((id) => auditEvents.delete(id));
          for (const [key, state] of authorizationStates) {
            if (state.space.spaceId === spaceId) authorizationStates.delete(key);
          }
          for (const [impactId, candidate] of deletionImpacts) {
            if (candidate.spaceId === spaceId) deletionImpacts.delete(impactId);
          }
          purgeMindBindingsForSpace(
            mindBindingOwners,
            spaceId,
            request.occurredAt,
          );
          this.#failOrdinaryMindIfRequested("delete_after_target_records");

          publicCatalogSpaceIds = derivePublicMindCatalogSpaceIds(
            knowledgeSpaces,
            personalBindings,
          );
          publicCatalogGeneration += 1;
          stagePublicCatalogSnapshot(
            publicCatalogGeneration,
            publicCatalogSpaceIds,
            publicCatalogSnapshots,
          );
          this.#failOrdinaryMindIfRequested("delete_after_catalog");
          deletionCleanup.set(cleanup.impactId, cleanup);
          this.#failOrdinaryMindIfRequested("delete_after_cleanup_work");
          this.#failOrdinaryMindIfRequested("delete_before_commit");
          return Object.freeze({
            kind: "deleted",
            cleanup,
            counts: Object.freeze({
              revisions: selected.revisionIds.length,
              memberships: selected.membershipIds.length,
              invitations: selected.invitationIds.length,
              backgroundJobs: selected.backgroundJobIds.length,
              exportJobs: selected.exportJobIds.length,
              exportDownloadGrants: selected.exportGrantKeys.length,
              indexStates: selected.indexKeys.length,
              auditEvents: selected.auditIds.length,
              auditOutboxMessages: selected.outboxIds.length,
              idempotencyRecords:
                selected.ordinaryIdempotencyKeys.length +
                selected.contentIdempotencyKeys.length,
            }),
          });
        },

        completeOrdinaryMindDeletionCleanup: async (
          request: Readonly<CompleteOrdinaryMindDeletionCleanupRequest>,
        ): Promise<CompleteOrdinaryMindDeletionCleanupResult> => {
          const parsed = parseCanonicalSpaceHandle(request.handle);
          if (
            parsed.kind !== "valid" ||
            parsed.canonicalHandle !== request.handle
          ) {
            return Object.freeze({ kind: "invalid_record" });
          }
          const pending = deletionCleanup.get(request.impactId);
          if (
            !pending ||
            pending.spaceId !== request.spaceId ||
            pending.host !== request.host ||
            pending.canonicalHandle !== parsed.canonicalHandle
          ) {
            return Object.freeze({ kind: "not_found" });
          }
          deletionCleanup.delete(request.impactId);
          this.#failOrdinaryMindIfRequested("delete_cleanup_before_commit");
          return Object.freeze({ kind: "completed" });
        },

        createAccountDeletionImpact: async (
          request: Readonly<CreateAccountDeletionImpactRequest>,
        ): Promise<CreateAccountDeletionImpactResult> => {
          const occurredAt = Date.parse(request.occurredAt);
          const expiresAt = Date.parse(request.expiresAt);
          if (
            !BOUNDED_OPAQUE_ID.test(request.impactId) ||
            !BOUNDED_OPAQUE_ID.test(request.deletedPrincipalId) ||
            !Number.isFinite(occurredAt) ||
            !Number.isFinite(expiresAt) ||
            expiresAt <= occurredAt ||
            !Number.isSafeInteger(request.activeTokenCount) ||
            request.activeTokenCount < 0 ||
            typeof request.tokenStateFingerprint !== "string" ||
            request.tokenStateFingerprint.length === 0
          ) {
            return Object.freeze({ kind: "invalid_record" });
          }
          for (const [impactId, candidate] of accountDeletionImpacts) {
            if (Date.parse(candidate.expiresAt) <= occurredAt) {
              accountDeletionImpacts.delete(impactId);
            }
          }
          if (
            accountDeletionImpacts.has(request.impactId) ||
            accountDeletionCleanup.has(request.impactId)
          ) {
            return Object.freeze({ kind: "impact_id_collision" });
          }
          const selected = accountDeletionSelection(
            request.principalId,
            request.host,
            accountState(),
          );
          const metadataStateFingerprint = accountDeletionFingerprint(
            request.principalId,
            request.host,
            accountState(),
          );
          if (!selected || metadataStateFingerprint === null) {
            return Object.freeze({ kind: "account_not_found" });
          }
          const impact = cloneAccountDeletionImpact({
            impactId: request.impactId,
            principalId: request.principalId,
            host: request.host,
            deletedPrincipalId: request.deletedPrincipalId,
            expiresAt: request.expiresAt,
            personalMind: Object.freeze({
              spaceId: selected.personalSpace.spaceId,
              name: selected.personalSpace.name,
              revisionCount: selected.personalRevisionCount,
            }),
            ownedMinds: selected.ownedMinds,
            foreignMembershipCount: selected.foreignActiveMembershipCount,
            pendingInvitationCount: selected.pendingInvitationCount,
            activeTokenCount: request.activeTokenCount,
            metadataStateFingerprint,
            tokenStateFingerprint: request.tokenStateFingerprint,
          });
          accountDeletionImpacts.set(impact.impactId, impact);
          this.#failAccountDeletionIfRequested("impact_after_record");
          this.#failAccountDeletionIfRequested("impact_before_commit");
          return Object.freeze({ kind: "created", impact });
        },

        deleteAccountCascade: async (
          request: Readonly<DeleteAccountCascadeRequest>,
        ): Promise<DeleteAccountCascadeResult> => {
          if (
            !BOUNDED_OPAQUE_ID.test(request.impactId) ||
            !BOUNDED_OPAQUE_ID.test(request.deletedPrincipalId) ||
            typeof request.tokenStateFingerprint !== "string" ||
            request.tokenStateFingerprint.length === 0 ||
            !Number.isFinite(Date.parse(request.occurredAt))
          ) {
            return Object.freeze({ kind: "invalid_record" });
          }
          const pending = accountDeletionCleanup.get(request.impactId);
          if (pending) {
            if (pending.principalId !== request.principalId) {
              return Object.freeze({ kind: "account_not_found" });
            }
            if (pending.idempotencyKey !== request.idempotencyKey) {
              return Object.freeze({ kind: "idempotency_conflict" });
            }
            if (
              pending.tokenStateFingerprint !== request.tokenStateFingerprint ||
              pending.deletedPrincipalId !== request.deletedPrincipalId
            ) {
              return Object.freeze({ kind: "deletion_impact_changed" });
            }
            return Object.freeze({
              kind: "cleanup_pending",
              cleanup: cloneAccountDeletionCleanup(pending),
            });
          }
          const impact = accountDeletionImpacts.get(request.impactId);
          if (!impact || impact.principalId !== request.principalId) {
            return Object.freeze({ kind: "account_not_found" });
          }
          if (Date.parse(request.occurredAt) >= Date.parse(impact.expiresAt)) {
            accountDeletionImpacts.delete(impact.impactId);
            return Object.freeze({ kind: "deletion_impact_expired" });
          }
          if (impact.tokenStateFingerprint !== request.tokenStateFingerprint) {
            accountDeletionImpacts.delete(impact.impactId);
            return Object.freeze({ kind: "deletion_impact_changed" });
          }
          const currentSelection = accountDeletionSelection(
            request.principalId,
            impact.host,
            accountState(),
          );
          const currentFingerprint = accountDeletionFingerprint(
            request.principalId,
            impact.host,
            accountState(),
          );
          if (
            !currentSelection ||
            currentFingerprint === null ||
            currentFingerprint !== impact.metadataStateFingerprint
          ) {
            accountDeletionImpacts.delete(impact.impactId);
            return Object.freeze({ kind: "deletion_impact_changed" });
          }
          if (
            currentSelection.ownedMinds.length !== impact.ownedMinds.length ||
            currentSelection.ownedMinds.some(
              (mind, index) =>
                mind.spaceId !== impact.ownedMinds[index]?.spaceId ||
                mind.host !== impact.ownedMinds[index]?.host ||
                mind.canonicalHandle !==
                  impact.ownedMinds[index]?.canonicalHandle,
            )
          ) {
            accountDeletionImpacts.delete(impact.impactId);
            return Object.freeze({ kind: "deletion_impact_changed" });
          }

          const targetSelections = new Map(
            currentSelection.deletedSpaceIds.map((spaceId) => [
              spaceId,
              targetRecordSelection(spaceId, deletionState()),
            ]),
          );
          const targetDigests = new Set<Digest>();
          for (const spaceId of currentSelection.deletedSpaceIds) {
            const state = revisionSpaces.get(spaceId);
            if (!state) return Object.freeze({ kind: "invalid_record" });
            for (const envelope of state.revisions.values()) {
              for (const entry of envelope.manifest.entries) {
                targetDigests.add(entry.sha256);
              }
            }
          }
          const remainingReachable = new Set<Digest>();
          for (const [spaceId, state] of revisionSpaces) {
            if (currentSelection.deletedSpaceIdSet.has(spaceId)) continue;
            for (const envelope of state.revisions.values()) {
              for (const entry of envelope.manifest.entries) {
                remainingReachable.add(entry.sha256);
              }
            }
          }
          const cleanup = cloneAccountDeletionCleanup({
            impactId: request.impactId,
            idempotencyKey: request.idempotencyKey,
            principalId: request.principalId,
            deletedPrincipalId: request.deletedPrincipalId,
            deletedSpaceIds: currentSelection.deletedSpaceIds,
            objectDigests: Object.freeze(
              [...targetDigests]
                .filter((digest) => !remainingReachable.has(digest))
                .sort(compareUnicodeScalarValues),
            ),
            foreignExportJobIds: currentSelection.foreignExportJobIds,
            tokenStateFingerprint: request.tokenStateFingerprint,
            deleteBefore: request.occurredAt,
          });

          for (const mind of currentSelection.ownedMinds) {
            const reservation = activeBySpace.get(mind.spaceId);
            if (
              !reservation ||
              reservation.host !== mind.host ||
              reservation.canonicalHandle !== mind.canonicalHandle
            ) {
              return Object.freeze({ kind: "deletion_impact_changed" });
            }
          }
          for (const mind of currentSelection.ownedMinds) {
            const retiredResult = retireHandleAgainst(
              {
                host: mind.host,
                handle: mind.canonicalHandle,
                spaceId: mind.spaceId,
              },
              { activeByHandle, activeBySpace, retired },
            );
            if (retiredResult.kind !== "retired") {
              throw new Error("account deletion handle retirement changed");
            }
          }
          this.#failAccountDeletionIfRequested("delete_after_handle_retirement");

          let revisionsDeleted = 0;
          let membershipsDeleted = 0;
          let invitationsDeleted = 0;
          for (const spaceId of currentSelection.deletedSpaceIds) {
            const records = targetSelections.get(spaceId)!;
            revisionsDeleted += records.revisionIds.length;
            membershipsDeleted += records.membershipIds.length;
            invitationsDeleted += records.invitationIds.length;
            knowledgeSpaces.delete(spaceId);
            revisionSpaces.delete(spaceId);
            records.revisionIds.forEach((id) => revisionsById.delete(id));
            records.membershipIds.forEach((id) => memberships.delete(id));
            records.invitationIds.forEach((id) => invitations.delete(id));
            records.ordinaryIdempotencyKeys.forEach((key) =>
              idempotencyRecords.delete(key),
            );
            records.contentIdempotencyKeys.forEach((key) =>
              contentIdempotencyRecords.delete(key),
            );
            for (const key of membershipMutationRecords.keys()) {
              if (key.split("\u0000")[1] === spaceId) {
                membershipMutationRecords.delete(key);
              }
            }
            records.backgroundJobIds.forEach((id) => backgroundJobs.delete(id));
            records.exportJobIds.forEach((id) => exportJobs.delete(id));
            records.exportGrantKeys.forEach((key) =>
              exportDownloadGrants.delete(key),
            );
            records.indexKeys.forEach((key) => indexStates.delete(key));
            records.outboxIds.forEach((id) => auditOutbox.delete(id));
            records.auditIds.forEach((id) => auditEvents.delete(id));
            for (const [impactId, candidate] of deletionImpacts) {
              if (candidate.spaceId === spaceId) deletionImpacts.delete(impactId);
            }
            purgeMindBindingsForSpace(
              mindBindingOwners,
              spaceId,
              request.occurredAt,
            );
          }
          this.#failAccountDeletionIfRequested("delete_after_target_records");

          let foreignRevisionAuthorsTombstoned = 0;
          for (const [spaceId, state] of revisionSpaces) {
            const revised = new Map<RevisionId, Envelope>();
            for (const [revisionId, envelope] of state.revisions) {
              let retained = envelope;
              if (
                envelope.revision.committedBy.kind === "principal" &&
                envelope.revision.committedBy.principalId === request.principalId
              ) {
                retained = cloneEnvelope({
                  ...envelope,
                  revision: Object.freeze({
                    ...envelope.revision,
                    committedBy: Object.freeze({
                      kind: "deleted-principal" as const,
                      tombstoneId: request.deletedPrincipalId,
                    }),
                  }),
                });
                foreignRevisionAuthorsTombstoned += 1;
              }
              revised.set(revisionId, retained);
              revisionsById.set(revisionId, retained);
            }
            revisionSpaces.set(spaceId, { head: state.head, revisions: revised });
          }
          let foreignAuditActorsTombstoned = 0;
          for (const [auditEventId, event] of auditEvents) {
            if (
              event.actor.kind !== "principal" ||
              event.actor.principalId !== request.principalId
            ) {
              continue;
            }
            auditEvents.set(
              auditEventId,
              cloneAuditEvent({
                ...event,
                actor: Object.freeze({
                  kind: "deleted-principal" as const,
                  opaqueId: request.deletedPrincipalId,
                }),
              }),
            );
            foreignAuditActorsTombstoned += 1;
          }
          this.#failAccountDeletionIfRequested(
            "delete_after_foreign_tombstones",
          );

          for (const membershipId of currentSelection.foreignMembershipIds) {
            if (memberships.delete(membershipId)) membershipsDeleted += 1;
          }
          const targetInvitationIdSet = new Set(
            currentSelection.targetInvitationIds,
          );
          for (const invitationId of targetInvitationIdSet) {
            if (invitations.delete(invitationId)) invitationsDeleted += 1;
          }
          for (const [jobId, job] of backgroundJobs) {
            if (
              job.target.kind === "expire_invitation" &&
              targetInvitationIdSet.has(job.target.invitationId)
            ) {
              backgroundJobs.delete(jobId);
            }
          }
          const foreignExportJobIdSet = new Set(
            currentSelection.foreignExportJobIds,
          );
          foreignExportJobIdSet.forEach((id) => exportJobs.delete(id));
          for (const [key, grant] of exportDownloadGrants) {
            if (
              grant.requestedByPrincipalId === request.principalId ||
              foreignExportJobIdSet.has(grant.jobId)
            ) {
              exportDownloadGrants.delete(key);
            }
          }
          for (const [key, record] of contentIdempotencyRecords) {
            if (record.principalId === request.principalId) {
              contentIdempotencyRecords.delete(key);
            }
          }
          for (const [key, record] of idempotencyRecords) {
            if (record.principalId === request.principalId) {
              idempotencyRecords.delete(key);
            }
          }
          for (const [key, record] of personalProfileIdempotencyRecords) {
            if (record.principalId === request.principalId) {
              personalProfileIdempotencyRecords.delete(key);
            }
          }
          for (const key of membershipMutationRecords.keys()) {
            if (key.split("\u0000")[0] === request.principalId) {
              membershipMutationRecords.delete(key);
            }
          }
          const externalBindingKeys = [...externalBindings]
            .filter(([, binding]) => binding.principalId === request.principalId)
            .map(([key]) => key);
          externalBindingKeys.forEach((key) => externalBindings.delete(key));
          personalBindings.delete(request.principalId);
          principals.delete(request.principalId);
          purgeMindBindingsForPrincipal(
            mindBindingOwners,
            request.principalId,
          );
          for (const [key, state] of authorizationStates) {
            if (
              state.principal.principalId === request.principalId ||
              currentSelection.deletedSpaceIdSet.has(state.space.spaceId)
            ) {
              authorizationStates.delete(key);
            }
          }
          this.#failAccountDeletionIfRequested("delete_after_identity");

          publicCatalogSpaceIds = derivePublicMindCatalogSpaceIds(
            knowledgeSpaces,
            personalBindings,
          );
          publicCatalogGeneration += 1;
          stagePublicCatalogSnapshot(
            publicCatalogGeneration,
            publicCatalogSpaceIds,
            publicCatalogSnapshots,
          );
          for (const [impactId, candidate] of accountDeletionImpacts) {
            if (candidate.principalId === request.principalId) {
              accountDeletionImpacts.delete(impactId);
            }
          }
          accountDeletionCleanup.set(cleanup.impactId, cleanup);
          this.#failAccountDeletionIfRequested("delete_after_cleanup_work");
          this.#failAccountDeletionIfRequested("delete_before_commit");
          return Object.freeze({
            kind: "deleted",
            cleanup,
            counts: Object.freeze({
              spaces: currentSelection.deletedSpaceIds.length,
              revisions: revisionsDeleted,
              memberships: membershipsDeleted,
              invitations: invitationsDeleted,
              externalBindings: externalBindingKeys.length,
              foreignRevisionAuthorsTombstoned,
              foreignAuditActorsTombstoned,
              foreignExportJobs: foreignExportJobIdSet.size,
            }),
          });
        },

        completeAccountDeletionCleanup: async (
          request: Readonly<CompleteAccountDeletionCleanupRequest>,
        ): Promise<CompleteAccountDeletionCleanupResult> => {
          const pending = accountDeletionCleanup.get(request.impactId);
          if (!pending || pending.principalId !== request.principalId) {
            return Object.freeze({ kind: "not_found" });
          }
          accountDeletionCleanup.delete(request.impactId);
          this.#failAccountDeletionIfRequested("cleanup_before_commit");
          return Object.freeze({ kind: "completed" });
        },
      });

      const result = await operation(transaction);
      this.#principals = principals;
      this.#externalBindings = externalBindings;
      this.#personalBindings = personalBindings;
      this.#knowledgeSpaces = knowledgeSpaces;
      this.#memberships = memberships;
      this.#invitations = invitations;
      this.#spaces = revisionSpaces;
      this.#revisionsById = revisionsById;
      this.#ordinaryMindIdempotencyRecords = idempotencyRecords;
      this.#membershipMutationRecords = membershipMutationRecords;
      this.#personalProfileIdempotencyRecords = personalProfileIdempotencyRecords;
      this.#activeHandlesByKey = activeByHandle;
      this.#activeHandlesBySpace = activeBySpace;
      this.#retiredHandles = retired;
      this.#publicMindCatalogGeneration = publicCatalogGeneration;
      this.#publicMindCatalogSpaceIds = publicCatalogSpaceIds;
      this.#publicMindCatalogSnapshots = publicCatalogSnapshots;
      this.#auditEvents = auditEvents;
      this.#auditOutbox = auditOutbox;
      this.#idempotencyRecords = contentIdempotencyRecords;
      this.#backgroundJobs = backgroundJobs;
      this.#exportJobs = exportJobs;
      this.#exportDownloadGrants = exportDownloadGrants;
      this.#indexStates = indexStates;
      this.#ordinaryMindDeletionImpacts = deletionImpacts;
      this.#ordinaryMindDeletionCleanup = deletionCleanup;
      this.#accountDeletionImpacts = accountDeletionImpacts;
      this.#accountDeletionCleanup = accountDeletionCleanup;
      this.#mindBindingOwners = mindBindingOwners;
      this.#authorizationStates.clear();
      authorizationStates.forEach((state, key) =>
        this.#authorizationStates.set(key, state));
      return result;
    });
  }

  async runPersonalMindTransaction<Result>(
    operation: (transaction: PersonalMindMetadataTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.#runExclusive(async () => {
      const principals = cloneRecordMap(this.#principals, freezePrincipal);
      const knowledgeSpaces = cloneRecordMap(
        this.#knowledgeSpaces,
        freezeKnowledgeSpace,
      );
      const idempotencyRecords = clonePersonalProfileIdempotencyRecords(
        this.#personalProfileIdempotencyRecords,
      );
      const transaction: PersonalMindMetadataTransaction = Object.freeze({
        renamePersonalProfile: async (
          request: RenamePersonalProfileRequest,
        ): Promise<RenamePersonalProfileResult> => {
          const idempotencyRecordKey = personalProfileIdempotencyKey(
            request.principalId,
            request.idempotencyKey,
          );
          let account: Readonly<PrincipalAccountSnapshot> | null;
          try {
            account = accountFromMaps(
              request.principalId,
              principals,
              this.#externalBindings,
              knowledgeSpaces,
              this.#personalBindings,
              this.#memberships,
            );
          } catch {
            return Object.freeze({ kind: "invalid_record" });
          }
          if (account === null) return Object.freeze({ kind: "not_found" });
          const previous = idempotencyRecords.get(idempotencyRecordKey);
          if (previous) {
            if (
              previous.profile.principalId !== account.principal.principalId ||
              previous.profile.personalMind.spaceId !==
                account.personalMind.space.spaceId
            ) {
              return Object.freeze({ kind: "invalid_record" });
            }
            if (previous.canonicalRequestHash !== request.canonicalRequestHash) {
              return Object.freeze({ kind: "idempotency_conflict" });
            }
            return Object.freeze({
              kind: "renamed",
              profile: freezePersonalMindProfile(previous.profile),
              replayed: true,
            });
          }
          const personalSpace = account.personalMind.space;
          if (
            account.principal.profileVersion !== request.expectedProfileVersion ||
            personalSpace.metadataVersion !== request.expectedPersonalMetadataVersion
          ) {
            return Object.freeze({
              kind: "profile_conflict",
              currentProfileVersion: account.principal.profileVersion,
              currentPersonalMetadataVersion: personalSpace.metadataVersion,
            });
          }

          const updatedPrincipal = freezePrincipal({
            ...account.principal,
            displayName: request.displayName,
            profileVersion: version(account.principal.profileVersion + 1),
            updatedAt: request.occurredAt,
          });
          const updatedSpace = freezeKnowledgeSpace({
            ...personalSpace,
            name: request.displayName,
            metadataVersion: version(personalSpace.metadataVersion + 1),
            updatedAt: request.occurredAt,
          });
          const candidatePrincipals = new Map(principals);
          candidatePrincipals.set(request.principalId, updatedPrincipal);
          const candidateSpaces = new Map(knowledgeSpaces);
          candidateSpaces.set(personalSpace.spaceId, updatedSpace);
          let updatedAccount: Readonly<PrincipalAccountSnapshot> | null;
          try {
            updatedAccount = accountFromMaps(
              request.principalId,
              candidatePrincipals,
              this.#externalBindings,
              candidateSpaces,
              this.#personalBindings,
              this.#memberships,
            );
          } catch {
            return Object.freeze({ kind: "invalid_record" });
          }
          if (updatedAccount === null) {
            return Object.freeze({ kind: "invalid_record" });
          }
          principals.set(request.principalId, updatedPrincipal);
          this.#failPersonalProfileIfRequested("after_principal");
          knowledgeSpaces.set(personalSpace.spaceId, updatedSpace);
          this.#failPersonalProfileIfRequested("after_space");
          const profile = personalMindProfileFromAccount(updatedAccount);
          idempotencyRecords.set(
            idempotencyRecordKey,
            Object.freeze({
              principalId: request.principalId,
              key: request.idempotencyKey,
              canonicalRequestHash: request.canonicalRequestHash,
              profile,
            }),
          );
          this.#failPersonalProfileIfRequested("before_commit");
          return Object.freeze({ kind: "renamed", profile, replayed: false });
        },
      });

      const result = await operation(transaction);
      this.#principals = principals;
      this.#knowledgeSpaces = knowledgeSpaces;
      this.#personalProfileIdempotencyRecords = idempotencyRecords;
      return result;
    });
  }

  async runAccountBootstrapTransaction<Result>(
    operation: (transaction: AccountBootstrapTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.#runExclusive(async () => {
      const principals = cloneRecordMap(this.#principals, freezePrincipal);
      const externalBindings = cloneRecordMap(
        this.#externalBindings,
        freezeExternalBinding,
      );
      const knowledgeSpaces = cloneRecordMap(
        this.#knowledgeSpaces,
        freezeKnowledgeSpace,
      );
      const personalBindings = cloneRecordMap(
        this.#personalBindings,
        freezePersonalBinding,
      );
      const memberships = cloneRecordMap(this.#memberships, freezeMembership);
      const revisionSpaces = cloneSpaces(this.#spaces);
      const revisionsById = new Map(this.#revisionsById);
      const transaction: AccountBootstrapTransaction = Object.freeze({
        readAccountByExternalBinding: async (
          lookup: Readonly<ExternalIdentityBindingLookup>,
        ) =>
          accountByBindingFromMaps(
            lookup,
            principals,
            externalBindings,
            knowledgeSpaces,
            personalBindings,
            memberships,
          ),
        createAccountBootstrap: async (
          records: Readonly<AccountBootstrapRecordSet>,
        ): Promise<CreateAccountBootstrapResult> => {
          const lookup = Object.freeze({
            provider: records.externalBinding.provider,
            normalizedBinding: records.externalBinding.normalizedBinding,
          });
          const exactExisting = accountByBindingFromMaps(
            lookup,
            principals,
            externalBindings,
            knowledgeSpaces,
            personalBindings,
            memberships,
          );
          if (exactExisting !== null) {
            return Object.freeze({
              kind: "exact_binding_exists",
              account: exactExisting,
            });
          }
          const validated = validateAccountBootstrapRecords(records);
          if (validated === null) {
            return Object.freeze({ kind: "invalid_record" });
          }
          const { principal, externalBinding, personalSpace, personalBinding } =
            records;
          const ownerMembership = records.ownerMembership;
          const hasCollision =
            principals.has(principal.principalId) ||
            [...externalBindings.values()].some(
              (binding) => binding.bindingId === externalBinding.bindingId,
            ) ||
            knowledgeSpaces.has(personalSpace.spaceId) ||
            [...knowledgeSpaces.values()].some(
              (space) => space.normalizedHandle === personalSpace.normalizedHandle,
            ) ||
            personalBindings.has(personalBinding.principalId) ||
            [...personalBindings.values()].some(
              (binding) => binding.spaceId === personalBinding.spaceId,
            ) ||
            memberships.has(ownerMembership.membershipId) ||
            revisionSpaces.has(personalSpace.spaceId) ||
            revisionsById.has(records.initialRevision.revision.revisionId);
          if (hasCollision) {
            return Object.freeze({ kind: "record_conflict" });
          }

          const revisionResult = await this.#commitRevisionAgainst(
            {
              expectedHeadRevisionId: null,
              envelope: records.initialRevision,
            },
            revisionSpaces,
            revisionsById,
          );
          if (
            revisionResult.kind !== "committed" ||
            revisionResult.replayed ||
            !revisionEnvelopesEqual(
              revisionResult.envelope,
              records.initialRevision,
            )
          ) {
            return Object.freeze({ kind: "record_conflict" });
          }
          this.#failAccountBootstrapIfRequested("after_revision");
          principals.set(principal.principalId, freezePrincipal(principal));
          this.#failAccountBootstrapIfRequested("after_principal");
          externalBindings.set(
            externalBindingKey(lookup),
            freezeExternalBinding(externalBinding),
          );
          this.#failAccountBootstrapIfRequested("after_binding");
          knowledgeSpaces.set(
            personalSpace.spaceId,
            freezeKnowledgeSpace(personalSpace),
          );
          this.#failAccountBootstrapIfRequested("after_space");
          personalBindings.set(
            personalBinding.principalId,
            freezePersonalBinding(personalBinding),
          );
          memberships.set(
            ownerMembership.membershipId,
            freezeMembership(ownerMembership),
          );
          this.#failAccountBootstrapIfRequested("after_membership");
          const account = accountFromMaps(
            principal.principalId,
            principals,
            externalBindings,
            knowledgeSpaces,
            personalBindings,
            memberships,
          );
          if (account === null) {
            throw new Error("account bootstrap aggregate could not be restored");
          }
          this.#failAccountBootstrapIfRequested("before_commit");
          return Object.freeze({ kind: "created", account });
        },
      });

      const result = await operation(transaction);
      this.#principals = principals;
      this.#externalBindings = externalBindings;
      this.#knowledgeSpaces = knowledgeSpaces;
      this.#personalBindings = personalBindings;
      this.#memberships = memberships;
      this.#spaces = revisionSpaces;
      this.#revisionsById = revisionsById;
      return result;
    });
  }

  async commitRevision(request: RevisionCommitRequest): Promise<RevisionCommitResult> {
    return this.runContentCommitTransaction((transaction) =>
      transaction.commitRevision(request),
    );
  }

  async runContentCommitTransaction<Result>(
    operation: (
      transaction: ContentCommitMetadataTransaction,
    ) => Promise<Result>,
  ): Promise<Result> {
    return this.#runExclusive(async () => {
      const spaces = cloneSpaces(this.#spaces);
      const revisionsById = new Map(this.#revisionsById);
      const knowledgeSpaces = cloneRecordMap(
        this.#knowledgeSpaces,
        freezeKnowledgeSpace,
      );
      const principals = this.#principals;
      const memberships = this.#memberships;
      const idempotencyRecords = cloneIdempotencyRecords(this.#idempotencyRecords);
      const auditEvents = new Map(
        [...this.#auditEvents].map(([id, event]) => [id, cloneAuditEvent(event)]),
      );
      const auditOutbox = new Map(
        [...this.#auditOutbox].map(([id, message]) => [id, cloneAuditOutbox(message)]),
      );
      const backgroundJobs = new Map(
        [...this.#backgroundJobs].map(([id, job]) => [id, cloneBackgroundJob(job)]),
      );
      const indexStates = new Map(
        [...this.#indexStates].map(([key, state]) => [key, cloneIndexState(state)]),
      );
      const authorizationStates = new Map(
        [...this.#authorizationStates].map(([key, state]) => [
          key,
          cloneAuthorizationState(state),
        ]),
      );
      const transaction: ContentCommitMetadataTransaction = Object.freeze({
        kind: "authorization-transaction" as const,
        readMindBindingSet: (
          bindingOwnerId: MindBindingOwnerId,
          principalId: PrincipalId,
          occurredAt: ApplyReadMindBindingRequest["occurredAt"],
        ) => this.readMindBindingSet(bindingOwnerId, principalId, occurredAt),
        readCurrentAuthorizationState: async (query: AuthorizationStateQuery) => {
          const current = currentSitesAuthorizationStateFromMaps(
            query,
            principals,
            knowledgeSpaces,
            memberships,
          );
          if (current !== null) return current;
          const state = authorizationStates.get(authorizationStateKey(query));
          return state ? cloneAuthorizationState(state) : null;
        },
        readHead: async (spaceId: SpaceId) => spaces.get(spaceId)?.head ?? null,
        readRevision: async (spaceId: SpaceId, revisionId: RevisionId) =>
          spaces.get(spaceId)?.revisions.get(revisionId) ?? null,
        checkIdempotency: async (request: CheckIdempotencyRequest) =>
          checkIdempotencyAgainst(request, idempotencyRecords),
        commitRevision: async (request: RevisionCommitRequest) => {
          const aggregate = knowledgeSpaces.get(request.envelope.revision.spaceId);
          const existing = revisionsById.get(request.envelope.revision.revisionId);
          const isExactReplay =
            existing !== undefined && envelopesEqual(existing, request.envelope);
          if (
            aggregate &&
            !isExactReplay &&
            aggregate.headRevisionId !== request.expectedHeadRevisionId
          ) {
            return Object.freeze({
              kind: "stale_head" as const,
              currentHeadRevisionId: aggregate.headRevisionId,
            });
          }

          const committed = await this.#commitRevisionAgainst(
            request,
            spaces,
            revisionsById,
          );
          const committedRevisionId = request.envelope.revision.revisionId;
          if (
            committed.kind === "committed" &&
            aggregate &&
            spaces.get(aggregate.spaceId)?.head === committedRevisionId &&
            aggregate.headRevisionId !== committedRevisionId
          ) {
            knowledgeSpaces.set(
              aggregate.spaceId,
              freezeKnowledgeSpace({
                ...aggregate,
                headRevisionId: committedRevisionId,
              }),
            );
          }
          return committed;
        },
        completeIdempotency: async (
          request: CompleteIdempotencyRequest,
        ) => completeIdempotencyAgainst(request, idempotencyRecords),
        stageContentCommitEffects: async (
          request: StageContentCommitEffectsRequest,
        ) =>
          stageContentCommitEffectsAgainst(
            request,
            auditEvents,
            auditOutbox,
            backgroundJobs,
            indexStates,
            revisionsById,
          ),
      });

      const result = await operation(transaction);
      this.#spaces = spaces;
      this.#revisionsById = revisionsById;
      this.#knowledgeSpaces = knowledgeSpaces;
      this.#idempotencyRecords = idempotencyRecords;
      this.#auditEvents = auditEvents;
      this.#auditOutbox = auditOutbox;
      this.#backgroundJobs = backgroundJobs;
      this.#indexStates = indexStates;
      return result;
    });
  }

  async runExportStartTransaction<Result>(
    operation: (transaction: ExportStartTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.#runExclusive(async () => {
      const spaces = cloneSpaces(this.#spaces);
      const revisionsById = new Map(this.#revisionsById);
      const principals = this.#principals;
      const knowledgeSpaces = this.#knowledgeSpaces;
      const memberships = this.#memberships;
      const idempotencyRecords = cloneIdempotencyRecords(this.#idempotencyRecords);
      const exportJobs = cloneExportJobs(this.#exportJobs);
      const authorizationStates = new Map(
        [...this.#authorizationStates].map(([key, state]) => [
          key,
          cloneAuthorizationState(state),
        ]),
      );
      const transaction: ExportStartTransaction = Object.freeze({
        kind: "authorization-transaction" as const,
        readMindBindingSet: (
          bindingOwnerId: MindBindingOwnerId,
          principalId: PrincipalId,
          occurredAt: ApplyReadMindBindingRequest["occurredAt"],
        ) => this.readMindBindingSet(bindingOwnerId, principalId, occurredAt),
        readCurrentAuthorizationState: async (query: AuthorizationStateQuery) => {
          const current = currentSitesAuthorizationStateFromMaps(
            query,
            principals,
            knowledgeSpaces,
            memberships,
          );
          if (current !== null) return current;
          const state = authorizationStates.get(authorizationStateKey(query));
          return state ? cloneAuthorizationState(state) : null;
        },
        readHead: async (spaceId: SpaceId) => spaces.get(spaceId)?.head ?? null,
        readRevision: async (spaceId: SpaceId, revisionId: RevisionId) =>
          spaces.get(spaceId)?.revisions.get(revisionId) ?? null,
        listRevisions: async (spaceId: SpaceId) => {
          const revisions = [...(spaces.get(spaceId)?.revisions.values() ?? [])]
            .sort((left, right) =>
              left.revision.revisionNumber - right.revision.revisionNumber,
            );
          return Object.freeze(revisions);
        },
        readExportJob: async (jobId: JobId) => {
          const job = exportJobs.get(jobId);
          return job ? cloneExportJob(job) : null;
        },
        checkIdempotency: async (request: CheckIdempotencyRequest) =>
          checkIdempotencyAgainst(request, idempotencyRecords),
        completeIdempotency: async (request: CompleteIdempotencyRequest) =>
          completeIdempotencyAgainst(request, idempotencyRecords),
        createExportJob: async (
          job: Readonly<ExportJob>,
        ): Promise<CreateExportJobResult> => {
          const existing = exportJobs.get(job.jobId);
          if (existing) {
            return Object.freeze({ kind: "job_id_collision" });
          }
          if (!validInitialExportJob(job, revisionsById)) {
            return Object.freeze({ kind: "invalid_job" });
          }
          const stored = cloneExportJob(job);
          exportJobs.set(job.jobId, stored);
          return Object.freeze({ kind: "created", job: stored });
        },
      });

      const result = await operation(transaction);
      this.#idempotencyRecords = idempotencyRecords;
      this.#exportJobs = exportJobs;
      return result;
    });
  }

  async runExportDownloadGrantTransaction<Result>(
    operation: (transaction: ExportDownloadGrantTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.#runExclusive(async () => {
      const exportJobs = cloneExportJobs(this.#exportJobs);
      const principals = this.#principals;
      const knowledgeSpaces = this.#knowledgeSpaces;
      const memberships = this.#memberships;
      const exportDownloadGrants = cloneExportDownloadGrants(
        this.#exportDownloadGrants,
      );
      const authorizationStates = new Map(
        [...this.#authorizationStates].map(([key, state]) => [
          key,
          cloneAuthorizationState(state),
        ]),
      );
      const transaction: ExportDownloadGrantTransaction = Object.freeze({
        kind: "authorization-transaction" as const,
        readMindBindingSet: (
          bindingOwnerId: MindBindingOwnerId,
          principalId: PrincipalId,
          occurredAt: ApplyReadMindBindingRequest["occurredAt"],
        ) => this.readMindBindingSet(bindingOwnerId, principalId, occurredAt),
        readCurrentAuthorizationState: async (query: AuthorizationStateQuery) => {
          const current = currentSitesAuthorizationStateFromMaps(
            query,
            principals,
            knowledgeSpaces,
            memberships,
          );
          if (current !== null) return current;
          const state = authorizationStates.get(authorizationStateKey(query));
          return state ? cloneAuthorizationState(state) : null;
        },
        readExportJob: async (jobId: JobId) => {
          const job = exportJobs.get(jobId);
          return job ? cloneExportJob(job) : null;
        },
        createExportDownloadGrant: async (
          grant: Readonly<ExportDownloadGrant>,
        ): Promise<CreateExportDownloadGrantResult> => {
          if (exportDownloadGrants.has(grant.secretVerifier)) {
            return Object.freeze({ kind: "secret_collision" });
          }
          if (!validExportDownloadGrant(grant, exportJobs.get(grant.jobId))) {
            return Object.freeze({ kind: "invalid_grant" });
          }
          const stored = cloneExportDownloadGrant(grant);
          exportDownloadGrants.set(grant.secretVerifier, stored);
          return Object.freeze({ kind: "created", grant: stored });
        },
      });

      const result = await operation(transaction);
      this.#exportDownloadGrants = exportDownloadGrants;
      return result;
    });
  }

  /** Test/local fixture inspection; application replay goes through authorization. */
  async listIdempotencyRecordsForTest(): Promise<
    readonly CompletedIdempotencyRecord[]
  > {
    return Object.freeze(
      [...this.#idempotencyRecords.values()]
        .map(cloneIdempotencyRecord)
        .sort((left, right) =>
          left.idempotencyRecordId < right.idempotencyRecordId ? -1 : 1,
        ),
    );
  }

  async #commitRevisionAgainst(
    request: RevisionCommitRequest,
    spaces: Map<SpaceId, SpaceState>,
    revisionsById: Map<RevisionId, Envelope>,
  ): Promise<RevisionCommitResult> {
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

    const existingGlobal = revisionsById.get(revision.revisionId);
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

    const state = spaces.get(revision.spaceId);
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
    spaces.set(revision.spaceId, nextState);
    revisionsById.set(revision.revisionId, stored);
    return Object.freeze({ kind: "committed", envelope: stored, replayed: false });
  }

  async listReachableObjectDigests(): Promise<readonly Digest[]> {
    const reachable = new Set<Digest>();
    for (const revision of this.#revisionsById.values()) {
      for (const entry of revision.manifest.entries) reachable.add(entry.sha256);
    }
    return Object.freeze([...reachable].sort());
  }

  async claimInvitationExpiryJob(
    jobId: JobId,
    now: SpaceInvitation["updatedAt"],
    claimExpiresAt: SpaceInvitation["updatedAt"],
  ): Promise<ClaimInvitationExpiryJobResult> {
    return this.#runExclusive(async () => {
      if (!validClaimLease(now, claimExpiresAt)) return Object.freeze({ kind: "not_available" });
      const current = this.#backgroundJobs.get(jobId);
      if (!current || current.target.kind !== "expire_invitation") return Object.freeze({ kind: "not_found" });
      if (current.state === "succeeded") return Object.freeze({ kind: "completed" });
      const expiredClaim = current.state === "running" && current.claimExpiresAt !== null && Date.parse(current.claimExpiresAt) <= Date.parse(now);
      if (
        (current.state === "running" && !expiredClaim) ||
        (current.state !== "queued" && current.state !== "failed" && !expiredClaim) ||
        (!expiredClaim && Date.parse(current.availableAt) > Date.parse(now))
      ) return Object.freeze({ kind: "not_available" });
      const claimed = cloneBackgroundJob({
        ...current,
        state: "running",
        attempts: current.attempts + 1,
        version: version(current.version + 1),
        claimExpiresAt,
        updatedAt: now,
      });
      this.#backgroundJobs.set(jobId, claimed);
      return Object.freeze({ kind: "claimed", job: claimed });
    });
  }

  async completeInvitationExpiryJob(
    jobId: JobId,
    expectedClaimVersion: BackgroundJob["version"],
    completedAt: SpaceInvitation["updatedAt"],
  ): Promise<CompleteInvitationExpiryJobResult> {
    return this.#runExclusive(async () => {
      const current = this.#backgroundJobs.get(jobId);
      if (!current || current.target.kind !== "expire_invitation") return Object.freeze({ kind: "not_found" });
      if (
        current.state !== "running" ||
        current.version !== expectedClaimVersion ||
        current.claimExpiresAt === null ||
        Date.parse(completedAt) >= Date.parse(current.claimExpiresAt)
      ) return Object.freeze({ kind: "not_available" });
      const invitation = this.#invitations.get(current.target.invitationId);
      if (!invitation) return Object.freeze({ kind: "not_found" });
      let result: "expired" | "already_terminal" = "already_terminal";
      const candidateSpaces = cloneRecordMap(this.#knowledgeSpaces, freezeKnowledgeSpace);
      const candidateInvitations = cloneRecordMap(this.#invitations, freezeInvitation);
      if (invitation.state === "pending") {
        if (Date.parse(invitation.expiresAt) > Date.parse(completedAt)) {
          return Object.freeze({ kind: "not_available" });
        }
        const space = this.#knowledgeSpaces.get(invitation.spaceId);
        if (!space || space.state !== "active") return Object.freeze({ kind: "not_found" });
        try {
          const updated = SpaceAggregate.restoreOrdinary({
            space,
            memberships: [...this.#memberships.values()].filter((item) => item.spaceId === space.spaceId),
            invitations: [...this.#invitations.values()].filter((item) => item.spaceId === space.spaceId),
          }).expireInvitation({
            invitationId: invitation.invitationId,
            expectedInvitationVersion: invitation.version,
            occurredAt: completedAt,
          }).snapshot();
          const expired = updated.invitations.find((item) => item.invitationId === invitation.invitationId);
          if (!expired) return Object.freeze({ kind: "not_found" });
          candidateSpaces.set(space.spaceId, freezeKnowledgeSpace(updated.space));
          candidateInvitations.set(expired.invitationId, freezeInvitation(expired));
          result = "expired";
        } catch {
          return Object.freeze({ kind: "not_available" });
        }
      }
      this.#failOrdinaryMindIfRequested("invitation_expiry_after_record");
      const candidateJobs = new Map(this.#backgroundJobs);
      candidateJobs.set(jobId, cloneBackgroundJob({
        ...current,
        state: "succeeded",
        version: version(current.version + 1),
        claimExpiresAt: null,
        updatedAt: completedAt,
      }));
      this.#failOrdinaryMindIfRequested("invitation_expiry_before_commit");
      this.#knowledgeSpaces = candidateSpaces;
      this.#invitations = candidateInvitations;
      this.#backgroundJobs = candidateJobs;
      return Object.freeze({ kind: result });
    });
  }

  async failInvitationExpiryJob(
    jobId: JobId,
    expectedClaimVersion: BackgroundJob["version"],
    failedAt: SpaceInvitation["updatedAt"],
    retryAt: SpaceInvitation["updatedAt"],
  ): Promise<boolean> {
    return this.#runExclusive(async () => {
      const current = this.#backgroundJobs.get(jobId);
      if (
        !current || current.target.kind !== "expire_invitation" ||
        current.state !== "running" || current.version !== expectedClaimVersion ||
        current.claimExpiresAt === null || Date.parse(failedAt) >= Date.parse(current.claimExpiresAt)
      ) return false;
      this.#backgroundJobs.set(jobId, cloneBackgroundJob({
        ...current,
        state: "failed",
        version: version(current.version + 1),
        availableAt: retryAt,
        claimExpiresAt: null,
        updatedAt: failedAt,
      }));
      return true;
    });
  }

  async claimIndexJob(
    jobId: JobId,
    now: RevisionIndexState["updatedAt"],
    claimExpiresAt: RevisionIndexState["updatedAt"],
  ): Promise<ClaimIndexJobResult> {
    return this.#runExclusive(async () => {
      if (!validClaimLease(now, claimExpiresAt)) {
        return Object.freeze({ kind: "not_available" });
      }
      const current = this.#backgroundJobs.get(jobId);
      if (!current || current.target.kind !== "revision_index") {
        return Object.freeze({ kind: "not_found" });
      }
      if (current.state === "succeeded") return Object.freeze({ kind: "completed" });
      const expiredRunningClaim =
        current.state === "running" &&
        current.claimExpiresAt !== null &&
        Date.parse(current.claimExpiresAt) <= Date.parse(now);
      if (
        (current.state === "running" && !expiredRunningClaim) ||
        (current.state !== "queued" &&
          current.state !== "failed" &&
          !expiredRunningClaim) ||
        (!expiredRunningClaim && Date.parse(current.availableAt) > Date.parse(now))
      ) {
        return Object.freeze({ kind: "not_available" });
      }
      const attempts = current.attempts + 1;
      const job = Object.freeze({
        ...current,
        state: "running" as const,
        attempts,
        version: version(current.version + 1),
        updatedAt: now,
        claimExpiresAt,
      });
      const key = indexStateKey(current.target.spaceId, current.target.revisionId);
      const currentState = this.#indexStates.get(key);
      if (!currentState) return Object.freeze({ kind: "not_found" });
      const indexState = Object.freeze({
        ...currentState,
        status: "queued" as const,
        attempts,
        updatedAt: now,
        readyAt: null,
        lastFailureCode: null,
      });
      this.#backgroundJobs.set(jobId, job);
      this.#indexStates.set(key, indexState);
      return Object.freeze({
        kind: "claimed",
        job: cloneBackgroundJob(job),
        indexState: cloneIndexState(indexState),
      });
    });
  }

  async completeIndexJob(
    jobId: JobId,
    expectedClaimVersion: BackgroundJob["version"],
    completedAt: RevisionIndexState["updatedAt"],
  ): Promise<boolean> {
    return this.#runExclusive(async () => {
      const current = this.#backgroundJobs.get(jobId);
      if (!current || current.target.kind !== "revision_index") return false;
      if (
        current.state !== "running" ||
        current.version !== expectedClaimVersion ||
        current.claimExpiresAt === null ||
        Date.parse(completedAt) >= Date.parse(current.claimExpiresAt)
      ) return false;
      const key = indexStateKey(current.target.spaceId, current.target.revisionId);
      const state = this.#indexStates.get(key);
      if (!state) return false;
      this.#backgroundJobs.set(
        jobId,
        Object.freeze({
          ...current,
          state: "succeeded",
          version: version(current.version + 1),
          updatedAt: completedAt,
          claimExpiresAt: null,
        }),
      );
      this.#indexStates.set(
        key,
        Object.freeze({
          ...state,
          status: "ready",
          updatedAt: completedAt,
          readyAt: completedAt,
          lastFailureCode: null,
        }),
      );
      return true;
    });
  }

  async failIndexJob(
    jobId: JobId,
    expectedClaimVersion: BackgroundJob["version"],
    failureCode: string,
    failedAt: RevisionIndexState["updatedAt"],
    retryAt: RevisionIndexState["updatedAt"],
  ): Promise<boolean> {
    return this.#runExclusive(async () => {
      const current = this.#backgroundJobs.get(jobId);
      if (
        !current ||
        current.target.kind !== "revision_index" ||
        current.state !== "running" ||
        current.version !== expectedClaimVersion ||
        current.claimExpiresAt === null ||
        Date.parse(failedAt) >= Date.parse(current.claimExpiresAt) ||
        typeof failureCode !== "string" ||
        !/^[a-z0-9_]{1,64}$/u.test(failureCode)
      ) {
        return false;
      }
      const key = indexStateKey(current.target.spaceId, current.target.revisionId);
      const state = this.#indexStates.get(key);
      if (!state) return false;
      this.#backgroundJobs.set(
        jobId,
        Object.freeze({
          ...current,
          state: "failed",
          availableAt: retryAt,
          version: version(current.version + 1),
          updatedAt: failedAt,
          claimExpiresAt: null,
        }),
      );
      this.#indexStates.set(
        key,
        Object.freeze({
          ...state,
          status: "failed",
          updatedAt: failedAt,
          readyAt: null,
          lastFailureCode: failureCode,
        }),
      );
      return true;
    });
  }

  async readRevisionIndexState(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<Readonly<RevisionIndexState> | null> {
    const state = this.#indexStates.get(indexStateKey(spaceId, revisionId));
    return state ? cloneIndexState(state) : null;
  }

  async claimAuditOutbox(
    outboxMessageId: OutboxMessageId,
    now: AuditOutboxMessage["updatedAt"],
    claimExpiresAt: AuditOutboxMessage["updatedAt"],
  ): Promise<ClaimAuditOutboxResult> {
    return this.#runExclusive(async () => {
      if (!validClaimLease(now, claimExpiresAt)) {
        return Object.freeze({ kind: "not_available" });
      }
      const current = this.#auditOutbox.get(outboxMessageId);
      if (!current) return Object.freeze({ kind: "not_found" });
      if (current.state === "delivered") return Object.freeze({ kind: "completed" });
      const expiredDeliveryClaim =
        current.state === "delivering" &&
        current.claimExpiresAt !== null &&
        Date.parse(current.claimExpiresAt) <= Date.parse(now);
      if (
        (current.state === "delivering" && !expiredDeliveryClaim) ||
        (current.state !== "pending" &&
          current.state !== "failed" &&
          !expiredDeliveryClaim) ||
        (!expiredDeliveryClaim && Date.parse(current.availableAt) > Date.parse(now))
      ) {
        return Object.freeze({ kind: "not_available" });
      }
      const event = this.#auditEvents.get(current.auditEventId);
      if (!event) return Object.freeze({ kind: "not_found" });
      const message = Object.freeze({
        ...current,
        state: "delivering" as const,
        attempts: current.attempts + 1,
        version: version(current.version + 1),
        updatedAt: now,
        claimExpiresAt,
      });
      this.#auditOutbox.set(outboxMessageId, message);
      return Object.freeze({
        kind: "claimed",
        message: cloneAuditOutbox(message),
        event: cloneAuditEvent(event),
      });
    });
  }

  async completeAuditOutbox(
    outboxMessageId: OutboxMessageId,
    expectedClaimVersion: AuditOutboxMessage["version"],
    completedAt: AuditOutboxMessage["updatedAt"],
  ): Promise<boolean> {
    return this.#runExclusive(async () => {
      const current = this.#auditOutbox.get(outboxMessageId);
      if (!current) return false;
      if (
        current.state !== "delivering" ||
        current.version !== expectedClaimVersion ||
        current.claimExpiresAt === null ||
        Date.parse(completedAt) >= Date.parse(current.claimExpiresAt)
      ) return false;
      this.#auditOutbox.set(
        outboxMessageId,
        Object.freeze({
          ...current,
          state: "delivered",
          version: version(current.version + 1),
          updatedAt: completedAt,
          claimExpiresAt: null,
        }),
      );
      return true;
    });
  }

  async failAuditOutbox(
    outboxMessageId: OutboxMessageId,
    expectedClaimVersion: AuditOutboxMessage["version"],
    failedAt: AuditOutboxMessage["updatedAt"],
    retryAt: AuditOutboxMessage["updatedAt"],
  ): Promise<boolean> {
    return this.#runExclusive(async () => {
      const current = this.#auditOutbox.get(outboxMessageId);
      if (
        !current ||
        current.state !== "delivering" ||
        current.version !== expectedClaimVersion ||
        current.claimExpiresAt === null ||
        Date.parse(failedAt) >= Date.parse(current.claimExpiresAt)
      ) return false;
      this.#auditOutbox.set(
        outboxMessageId,
        Object.freeze({
          ...current,
          state: "failed",
          availableAt: retryAt,
          version: version(current.version + 1),
          updatedAt: failedAt,
          claimExpiresAt: null,
        }),
      );
      return true;
    });
  }

  async readExportDownloadGrant(
    secretVerifier: ExportDownloadGrant["secretVerifier"],
    now: ExportDownloadGrant["createdAt"],
  ): Promise<ReadExportDownloadGrantResult> {
    return this.#runExclusive(async () => {
      if (
        !EXPORT_DOWNLOAD_VERIFIER_PATTERN.test(secretVerifier) ||
        !Number.isFinite(Date.parse(now))
      ) {
        return Object.freeze({ kind: "not_found" });
      }
      const current = this.#exportDownloadGrants.get(secretVerifier);
      if (!current) return Object.freeze({ kind: "not_found" });
      if (current.state === "revoked") return Object.freeze({ kind: "revoked" });
      if (current.state === "expired") return Object.freeze({ kind: "expired" });
      const job = this.#exportJobs.get(current.jobId);
      const expired =
        Date.parse(now) >= Date.parse(current.expiresAt) ||
        !job ||
        job.state !== "succeeded" ||
        job.archive === null ||
        job.archive.objectKey !== current.objectKey ||
        Date.parse(now) >= Date.parse(job.expiresAt);
      if (expired) {
        this.#exportDownloadGrants.set(
          secretVerifier,
          Object.freeze({ ...current, state: "expired" as const }),
        );
        return Object.freeze({ kind: "expired" });
      }
      return Object.freeze({
        kind: "active",
        grant: cloneExportDownloadGrant(current),
      });
    });
  }

  async revokeExportDownloadGrant(
    secretVerifier: ExportDownloadGrant["secretVerifier"],
    revokedAt: ExportDownloadGrant["createdAt"],
  ): Promise<boolean> {
    return this.#runExclusive(async () => {
      if (
        !EXPORT_DOWNLOAD_VERIFIER_PATTERN.test(secretVerifier) ||
        !Number.isFinite(Date.parse(revokedAt))
      ) {
        return false;
      }
      const current = this.#exportDownloadGrants.get(secretVerifier);
      if (!current || current.state === "expired") return false;
      if (current.state === "revoked") return true;
      this.#exportDownloadGrants.set(
        secretVerifier,
        Object.freeze({
          ...current,
          state: "revoked" as const,
          revokedAt,
        }),
      );
      return true;
    });
  }

  async readExportJob(jobId: JobId): Promise<Readonly<ExportJob> | null> {
    const job = this.#exportJobs.get(jobId);
    return job ? cloneExportJob(job) : null;
  }

  async claimExportJob(
    jobId: JobId,
    now: ExportJob["updatedAt"],
    claimExpiresAt: ExportJob["updatedAt"],
  ): Promise<ClaimExportJobResult> {
    return this.#runExclusive(async () => {
      if (!validClaimLease(now, claimExpiresAt)) {
        return Object.freeze({ kind: "not_available" });
      }
      const current = this.#exportJobs.get(jobId);
      if (!current) return Object.freeze({ kind: "not_found" });
      if (current.state === "succeeded") {
        return Object.freeze({ kind: "completed" });
      }
      if (current.state === "expired" || Date.parse(now) >= Date.parse(current.expiresAt)) {
        return Object.freeze({ kind: "expired" });
      }
      const expiredClaim =
        current.state === "running" &&
        current.claimExpiresAt !== null &&
        Date.parse(current.claimExpiresAt) <= Date.parse(now);
      if (
        (current.state === "running" && !expiredClaim) ||
        (current.state !== "queued" && current.state !== "failed" && !expiredClaim) ||
        (!expiredClaim && Date.parse(current.availableAt) > Date.parse(now))
      ) {
        return Object.freeze({ kind: "not_available" });
      }
      const claimed = Object.freeze({
        ...current,
        state: "running" as const,
        version: version(current.version + 1),
        attempts: current.attempts + 1,
        claimExpiresAt,
        updatedAt: now,
        lastFailureCode: null,
      });
      this.#exportJobs.set(jobId, claimed);
      return Object.freeze({ kind: "claimed", job: cloneExportJob(claimed) });
    });
  }

  async completeExportJob(
    jobId: JobId,
    expectedClaimVersion: ExportJob["version"],
    archive: Readonly<ExportArchiveRecord>,
    completedAt: ExportJob["updatedAt"],
  ): Promise<boolean> {
    return this.#runExclusive(async () => {
      const current = this.#exportJobs.get(jobId);
      if (
        !current ||
        current.state !== "running" ||
        current.version !== expectedClaimVersion ||
        current.claimExpiresAt === null ||
        Date.parse(completedAt) >= Date.parse(current.claimExpiresAt) ||
        Date.parse(completedAt) >= Date.parse(current.expiresAt) ||
        !validExportArchive(archive)
      ) {
        return false;
      }
      this.#exportJobs.set(
        jobId,
        Object.freeze({
          ...current,
          state: "succeeded",
          version: version(current.version + 1),
          updatedAt: completedAt,
          completedAt,
          claimExpiresAt: null,
          lastFailureCode: null,
          archive: Object.freeze({ ...archive }),
        }),
      );
      return true;
    });
  }

  async failExportJob(
    jobId: JobId,
    expectedClaimVersion: ExportJob["version"],
    failureCode: string,
    failedAt: ExportJob["updatedAt"],
    retryAt: ExportJob["updatedAt"],
  ): Promise<boolean> {
    return this.#runExclusive(async () => {
      const current = this.#exportJobs.get(jobId);
      if (
        !current ||
        current.state !== "running" ||
        current.version !== expectedClaimVersion ||
        current.claimExpiresAt === null ||
        Date.parse(failedAt) >= Date.parse(current.claimExpiresAt) ||
        Date.parse(failedAt) >= Date.parse(current.expiresAt) ||
        !/^[a-z0-9_]{1,64}$/u.test(failureCode) ||
        Date.parse(retryAt) <= Date.parse(failedAt)
      ) {
        return false;
      }
      this.#exportJobs.set(
        jobId,
        Object.freeze({
          ...current,
          state: "failed",
          version: version(current.version + 1),
          availableAt: retryAt,
          updatedAt: failedAt,
          claimExpiresAt: null,
          completedAt: null,
          lastFailureCode: failureCode,
          archive: null,
        }),
      );
      return true;
    });
  }

  async expireExportJob(
    jobId: JobId,
    now: ExportJob["updatedAt"],
  ): Promise<ExpireExportJobResult> {
    return this.#runExclusive(async () => {
      const current = this.#exportJobs.get(jobId);
      if (!current) return Object.freeze({ kind: "not_found" });
      if (current.state === "expired") {
        return Object.freeze({
          kind: "expired",
          job: cloneExportJob(current),
          replayed: true,
        });
      }
      if (Date.parse(now) < Date.parse(current.expiresAt)) {
        return Object.freeze({ kind: "not_due" });
      }
      const expired = Object.freeze({
        ...current,
        state: "expired" as const,
        version: version(current.version + 1),
        updatedAt: now,
        claimExpiresAt: null,
        lastFailureCode: current.lastFailureCode,
        archiveCleanedAt: null,
      });
      this.#exportJobs.set(jobId, expired);
      for (const [verifier, grant] of this.#exportDownloadGrants) {
        if (grant.jobId === jobId && grant.state === "active") {
          this.#exportDownloadGrants.set(
            verifier,
            Object.freeze({ ...grant, state: "expired" as const }),
          );
        }
      }
      return Object.freeze({
        kind: "expired",
        job: cloneExportJob(expired),
        replayed: false,
      });
    });
  }

  async completeExpiredExportCleanup(
    jobId: JobId,
    expectedVersion: ExportJob["version"],
    cleanedAt: ExportJob["updatedAt"],
  ): Promise<boolean> {
    return this.#runExclusive(async () => {
      const current = this.#exportJobs.get(jobId);
      if (
        !current ||
        current.state !== "expired" ||
        current.version !== expectedVersion ||
        current.archiveCleanedAt !== null ||
        !Number.isFinite(Date.parse(cleanedAt))
      ) {
        return false;
      }
      this.#exportJobs.set(
        jobId,
        Object.freeze({
          ...current,
          version: version(current.version + 1),
          updatedAt: cleanedAt,
          archive: null,
          archiveCleanedAt: cleanedAt,
        }),
      );
      return true;
    });
  }

  async purgeSpaceTargetRecords(spaceId: SpaceId): Promise<SpaceTargetPurgeResult> {
    return this.#runExclusive(async () => {
      const indexKeys = [...this.#indexStates]
        .filter(([, state]) => state.spaceId === spaceId)
        .map(([key]) => key);
      const auditIds = [...this.#auditEvents]
        .filter(([, event]) => event.spaceId === spaceId)
        .map(([id]) => id);
      const auditIdSet = new Set(auditIds);
      const outboxIds = [...this.#auditOutbox]
        .filter(([, message]) => auditIdSet.has(message.auditEventId))
        .map(([id]) => id);
      const outboxIdSet = new Set(outboxIds);
      const invitationIdSet = new Set(
        [...this.#invitations.values()]
          .filter((invitation) => invitation.spaceId === spaceId)
          .map((invitation) => invitation.invitationId),
      );
      const jobIds = [...this.#backgroundJobs]
        .filter(
          ([, job]) =>
            ("spaceId" in job.target && job.target.spaceId === spaceId) ||
            (job.target.kind === "audit_delivery" &&
              outboxIdSet.has(job.target.outboxMessageId)) ||
            (job.target.kind === "expire_invitation" &&
              invitationIdSet.has(job.target.invitationId)),
        )
        .map(([id]) => id);
      const idempotencyKeys = [...this.#idempotencyRecords]
        .filter(([, record]) => record.spaceId === spaceId)
        .map(([key]) => key);
      const exportJobIds = [...this.#exportJobs]
        .filter(([, job]) => job.spaceId === spaceId)
        .map(([id]) => id);
      const exportGrantVerifiers = [...this.#exportDownloadGrants]
        .filter(([, grant]) => grant.spaceId === spaceId)
        .map(([verifier]) => verifier);
      jobIds.forEach((id) => this.#backgroundJobs.delete(id));
      exportJobIds.forEach((id) => this.#exportJobs.delete(id));
      exportGrantVerifiers.forEach((verifier) =>
        this.#exportDownloadGrants.delete(verifier));
      indexKeys.forEach((key) => this.#indexStates.delete(key));
      outboxIds.forEach((id) => this.#auditOutbox.delete(id));
      auditIds.forEach((id) => this.#auditEvents.delete(id));
      idempotencyKeys.forEach((key) => this.#idempotencyRecords.delete(key));
      return Object.freeze({
        backgroundJobs: jobIds.length + exportJobIds.length,
        indexStates: indexKeys.length,
        auditEvents: auditIds.length,
        auditOutboxMessages: outboxIds.length,
        idempotencyRecords: idempotencyKeys.length,
      });
    });
  }

  async listAuditEventsForTest(): Promise<readonly Readonly<AuditEvent>[]> {
    return Object.freeze([...this.#auditEvents.values()].map(cloneAuditEvent));
  }

  async listAuditOutboxForTest(): Promise<readonly Readonly<AuditOutboxMessage>[]> {
    return Object.freeze([...this.#auditOutbox.values()].map(cloneAuditOutbox));
  }

  async listBackgroundJobsForTest(): Promise<readonly Readonly<BackgroundJob>[]> {
    return Object.freeze([...this.#backgroundJobs.values()].map(cloneBackgroundJob));
  }

  async listExportJobsForTest(): Promise<readonly Readonly<ExportJob>[]> {
    return Object.freeze([...this.#exportJobs.values()].map(cloneExportJob));
  }

  async listExportDownloadGrantsForTest(): Promise<
    readonly Readonly<ExportDownloadGrant>[]
  > {
    return Object.freeze(
      [...this.#exportDownloadGrants.values()].map(cloneExportDownloadGrant),
    );
  }

  failNextCommitForTest(
    error: Error = new Error("injected revision metadata transaction failure"),
  ): void {
    this.#nextCommitFailure = error;
  }

  failNextAccountBootstrapAtForTest(stage: AccountBootstrapFailureStage): void {
    this.#nextAccountBootstrapFailureStage = stage;
  }

  failNextPersonalProfileAtForTest(stage: PersonalProfileFailureStage): void {
    this.#nextPersonalProfileFailureStage = stage;
  }

  failNextOrdinaryMindAtForTest(stage: OrdinaryMindFailureStage): void {
    this.#nextOrdinaryMindFailureStage = stage;
  }

  failNextAccountDeletionAtForTest(stage: AccountDeletionFailureStage): void {
    this.#nextAccountDeletionFailureStage = stage;
  }

  async inspectPublicMindCatalogForTest(): Promise<Readonly<{
    generation: number;
    spaceIds: readonly SpaceId[];
    retainedSnapshots: number;
  }>> {
    return Object.freeze({
      generation: this.#publicMindCatalogGeneration,
      spaceIds: Object.freeze([...this.#publicMindCatalogSpaceIds]),
      retainedSnapshots: this.#publicMindCatalogSnapshots.size,
    });
  }

  async inspectDeletionCleanupForTest(): Promise<
    readonly Readonly<OrdinaryMindDeletionCleanupWorkItem>[]
  > {
    return Object.freeze(
      [...this.#ordinaryMindDeletionCleanup.values()]
        .map(cloneOrdinaryMindDeletionCleanup)
        .sort((left, right) => left.impactId.localeCompare(right.impactId)),
    );
  }

  async inspectDeletionImpactsForTest(): Promise<
    readonly Readonly<OrdinaryMindDeletionImpactSnapshot>[]
  > {
    return Object.freeze(
      [...this.#ordinaryMindDeletionImpacts.values()]
        .map(cloneOrdinaryMindDeletionImpact)
        .sort((left, right) => left.impactId.localeCompare(right.impactId)),
    );
  }

  async inspectAccountDeletionImpactsForTest(): Promise<
    readonly Readonly<AccountDeletionImpactSnapshot>[]
  > {
    return Object.freeze(
      [...this.#accountDeletionImpacts.values()]
        .map(cloneAccountDeletionImpact)
        .sort((left, right) => left.impactId.localeCompare(right.impactId)),
    );
  }

  async inspectAccountDeletionCleanupForTest(): Promise<
    readonly Readonly<AccountDeletionCleanupWorkItem>[]
  > {
    return Object.freeze(
      [...this.#accountDeletionCleanup.values()]
        .map(cloneAccountDeletionCleanup)
        .sort((left, right) => left.impactId.localeCompare(right.impactId)),
    );
  }

  async inspectRetiredHandlesForTest(): Promise<
    readonly Readonly<RetiredHandleMarker>[]
  > {
    return Object.freeze(
      [...this.#retiredHandles.values()]
        .map((marker) => Object.freeze({ ...marker }))
        .sort((left, right) =>
          `${left.host}\u0000${left.canonicalHandle}`.localeCompare(
            `${right.host}\u0000${right.canonicalHandle}`,
          ),
        ),
    );
  }

  /** Test-only derived projection corruption; canonical Mind state is untouched. */
  async corruptPublicMindCatalogForTest(
    candidateIds: readonly unknown[],
  ): Promise<void> {
    await this.#runExclusive(async () => {
      this.#publicMindCatalogGeneration += 1;
      this.#publicMindCatalogSpaceIds = new Set(
        candidateIds as readonly SpaceId[],
      );
      this.#publicMindCatalogSnapshots.set(
        this.#publicMindCatalogGeneration,
        Object.freeze([...candidateIds]) as readonly SpaceId[],
      );
      while (
        this.#publicMindCatalogSnapshots.size >
        PUBLIC_CATALOG_SNAPSHOT_RETENTION
      ) {
        const oldest = Math.min(...this.#publicMindCatalogSnapshots.keys());
        this.#publicMindCatalogSnapshots.delete(oldest);
      }
    });
  }

  /** Test-only concurrent metadata mutation; content HEAD/history are untouched. */
  async bumpPersonalMindMetadataVersionForTest(
    principalId: Principal["principalId"],
    occurredAt: KnowledgeSpace["updatedAt"],
  ): Promise<boolean> {
    return this.#runExclusive(async () => {
      const binding = this.#personalBindings.get(principalId);
      if (!binding) return false;
      const space = this.#knowledgeSpaces.get(binding.spaceId);
      if (!space) return false;
      this.#knowledgeSpaces.set(
        space.spaceId,
        freezeKnowledgeSpace({
          ...space,
          metadataVersion: version(space.metadataVersion + 1),
          updatedAt: occurredAt,
        }),
      );
      return true;
    });
  }

  /** Test-only concurrent ordinary metadata mutation; access and revisions stay fixed. */
  async bumpOrdinaryMindMetadataVersionForTest(
    spaceId: KnowledgeSpace["spaceId"],
    occurredAt: KnowledgeSpace["updatedAt"],
  ): Promise<boolean> {
    return this.#runExclusive(async () => {
      if (
        [...this.#personalBindings.values()].some(
          (binding) => binding.spaceId === spaceId,
        )
      ) {
        return false;
      }
      const space = this.#knowledgeSpaces.get(spaceId);
      if (!space) return false;
      this.#knowledgeSpaces.set(
        spaceId,
        freezeKnowledgeSpace({
          ...space,
          metadataVersion: version(space.metadataVersion + 1),
          updatedAt: occurredAt,
        }),
      );
      return true;
    });
  }

  /** Test-only account-deletion interleaving for current authorization reads. */
  async disablePrincipalForTest(
    principalId: Principal["principalId"],
    occurredAt: Principal["updatedAt"],
  ): Promise<boolean> {
    return this.#runExclusive(async () => {
      const principal = this.#principals.get(principalId);
      if (!principal || principal.state !== "active") return false;
      this.#principals.set(
        principalId,
        freezePrincipal({
          ...principal,
          state: "deleted",
          profileVersion: version(principal.profileVersion + 1),
          updatedAt: occurredAt,
        }),
      );
      return true;
    });
  }

  /** Test-only valid non-owner membership setup for current-state authorization races. */
  async grantOrdinaryMembershipForTest(
    membership: Readonly<SpaceMembership>,
    occurredAt: KnowledgeSpace["updatedAt"],
  ): Promise<boolean> {
    return this.#runExclusive(async () => {
      const space = this.#knowledgeSpaces.get(membership.spaceId);
      const principal = this.#principals.get(membership.principalId);
      if (
        !space ||
        space.state !== "active" ||
        !principal ||
        principal.state !== "active" ||
        membership.state !== "active" ||
        membership.role === "owner" ||
        this.#memberships.has(membership.membershipId) ||
        [...this.#personalBindings.values()].some(
          (binding) => binding.spaceId === membership.spaceId,
        ) ||
        [...this.#memberships.values()].some(
          (candidate) =>
            candidate.spaceId === membership.spaceId &&
            candidate.principalId === membership.principalId &&
            candidate.state === "active",
        )
      ) {
        return false;
      }
      const updatedSpace = freezeKnowledgeSpace({
        ...space,
        metadataVersion: version(space.metadataVersion + 1),
        accessVersion: version(space.accessVersion + 1),
        updatedAt: occurredAt,
      });
      const candidateMemberships = [
        ...this.#memberships.values(),
        freezeMembership(membership),
      ].filter((candidate) => candidate.spaceId === space.spaceId);
      try {
        SpaceAggregate.restoreOrdinary({
          space: updatedSpace,
          memberships: candidateMemberships,
        });
      } catch {
        return false;
      }
      this.#knowledgeSpaces.set(space.spaceId, updatedSpace);
      this.#memberships.set(
        membership.membershipId,
        freezeMembership(membership),
      );
      return true;
    });
  }

  /** Test-only access revocation while another active Owner preserves the aggregate. */
  async revokeOrdinaryMembershipForTest(
    spaceId: KnowledgeSpace["spaceId"],
    principalId: Principal["principalId"],
    occurredAt: KnowledgeSpace["updatedAt"],
  ): Promise<boolean> {
    return this.#runExclusive(async () => {
      const space = this.#knowledgeSpaces.get(spaceId);
      const current = [...this.#memberships.values()].find(
        (membership) =>
          membership.spaceId === spaceId &&
          membership.principalId === principalId &&
          membership.state === "active",
      );
      if (!space || !current || current.role === "owner") return false;
      const revoked = freezeMembership({
        ...current,
        state: "revoked",
        version: version(current.version + 1),
        updatedAt: occurredAt,
        updatedBy: principalId,
      });
      const updatedSpace = freezeKnowledgeSpace({
        ...space,
        metadataVersion: version(space.metadataVersion + 1),
        accessVersion: version(space.accessVersion + 1),
        updatedAt: occurredAt,
      });
      const candidateMemberships = [...this.#memberships.values()]
        .filter((membership) => membership.spaceId === spaceId)
        .map((membership) =>
          membership.membershipId === revoked.membershipId
            ? revoked
            : membership,
        );
      try {
        SpaceAggregate.restoreOrdinary({
          space: updatedSpace,
          memberships: candidateMemberships,
        });
      } catch {
        return false;
      }
      this.#knowledgeSpaces.set(spaceId, updatedSpace);
      this.#memberships.set(revoked.membershipId, revoked);
      return true;
    });
  }

  /** Test-only atomic ownership transfer using the real aggregate records. */
  async transferOrdinaryOwnershipForTest(
    spaceId: KnowledgeSpace["spaceId"],
    sourcePrincipalId: Principal["principalId"],
    targetPrincipalId: Principal["principalId"],
    occurredAt: KnowledgeSpace["updatedAt"],
  ): Promise<boolean> {
    return this.#runExclusive(async () => {
      const space = this.#knowledgeSpaces.get(spaceId);
      if (
        !space ||
        space.state !== "active" ||
        [...this.#personalBindings.values()].some(
          (binding) => binding.spaceId === spaceId,
        )
      ) {
        return false;
      }
      const aggregateMemberships = [...this.#memberships.values()].filter(
        (membership) => membership.spaceId === spaceId,
      );
      const source = aggregateMemberships.find(
        (membership) =>
          membership.principalId === sourcePrincipalId &&
          membership.state === "active",
      );
      const target = aggregateMemberships.find(
        (membership) =>
          membership.principalId === targetPrincipalId &&
          membership.state === "active",
      );
      if (!source || !target) return false;
      try {
        const transferred = SpaceAggregate.restoreOrdinary({
          space,
          memberships: aggregateMemberships,
        })
          .transferOwnership({
            sourcePrincipalId,
            targetPrincipalId,
            expectedMetadataVersion: space.metadataVersion,
            expectedSourceMembershipVersion: source.version,
            expectedTargetMembershipVersion: target.version,
            occurredAt,
          })
          .snapshot();
        this.#knowledgeSpaces.set(
          spaceId,
          freezeKnowledgeSpace(transferred.space),
        );
        for (const membership of transferred.memberships) {
          this.#memberships.set(
            membership.membershipId,
            freezeMembership(membership),
          );
        }
        return true;
      } catch {
        return false;
      }
    });
  }

  /** Test-only current visibility transition with the same access-epoch effect. */
  async changeOrdinaryVisibilityForTest(
    spaceId: KnowledgeSpace["spaceId"],
    visibility: KnowledgeSpace["visibility"],
    occurredAt: KnowledgeSpace["updatedAt"],
  ): Promise<boolean> {
    return this.#runExclusive(async () => {
      const space = this.#knowledgeSpaces.get(spaceId);
      if (
        !space ||
        space.state !== "active" ||
        !["private", "unlisted", "public"].includes(visibility) ||
        [...this.#personalBindings.values()].some(
          (binding) => binding.spaceId === spaceId,
        )
      ) {
        return false;
      }
      if (space.visibility === visibility) return true;
      this.#knowledgeSpaces.set(
        spaceId,
        freezeKnowledgeSpace({
          ...space,
          visibility,
          metadataVersion: version(space.metadataVersion + 1),
          accessVersion: version(space.accessVersion + 1),
          updatedAt: occurredAt,
        }),
      );
      this.#publicMindCatalogSpaceIds = derivePublicMindCatalogSpaceIds(
        this.#knowledgeSpaces,
        this.#personalBindings,
      );
      this.#publicMindCatalogGeneration += 1;
      stagePublicCatalogSnapshot(
        this.#publicMindCatalogGeneration,
        this.#publicMindCatalogSpaceIds,
        this.#publicMindCatalogSnapshots,
      );
      return true;
    });
  }

  /** Test-only corrupt aggregate fixture; the canonical registry is untouched. */
  async corruptOrdinaryHandleForTest(
    spaceId: KnowledgeSpace["spaceId"],
  ): Promise<boolean> {
    return this.#runExclusive(async () => {
      const space = this.#knowledgeSpaces.get(spaceId);
      if (
        !space ||
        [...this.#personalBindings.values()].some(
          (binding) => binding.spaceId === spaceId,
        )
      ) {
        return false;
      }
      this.#knowledgeSpaces.set(
        spaceId,
        freezeKnowledgeSpace({
          ...space,
          normalizedHandle: `${space.normalizedHandle}-corrupt` as KnowledgeSpace["normalizedHandle"],
        }),
      );
      return true;
    });
  }

  /** Test-only deletion-race state; the handle remains reserved until delete commits. */
  async markOrdinaryMindDeletingForTest(
    spaceId: KnowledgeSpace["spaceId"],
    occurredAt: KnowledgeSpace["updatedAt"],
  ): Promise<boolean> {
    return this.#runExclusive(async () => {
      const space = this.#knowledgeSpaces.get(spaceId);
      if (
        !space ||
        [...this.#personalBindings.values()].some(
          (binding) => binding.spaceId === spaceId,
        )
      ) {
        return false;
      }
      const deleting = freezeKnowledgeSpace({
        ...space,
        state: "deleting",
        metadataVersion: version(space.metadataVersion + 1),
        accessVersion: version(space.accessVersion + 1),
        updatedAt: occurredAt,
      });
      this.#knowledgeSpaces.set(spaceId, deleting);
      return true;
    });
  }

  async inspectOrdinaryMindStateForTest(
    spaceId: KnowledgeSpace["spaceId"],
  ): Promise<Readonly<{
    space: Readonly<KnowledgeSpace>;
    memberships: readonly Readonly<SpaceMembership>[];
    invitations: readonly Readonly<SpaceInvitation>[];
    revisions: readonly Envelope[];
    reservation: Readonly<HandleReservationSnapshot>;
  }> | null> {
    if (
      [...this.#personalBindings.values()].some(
        (binding) => binding.spaceId === spaceId,
      )
    ) {
      return null;
    }
    const space = this.#knowledgeSpaces.get(spaceId);
    const reservation = this.#activeHandlesBySpace.get(spaceId);
    if (!space || !reservation) return null;
    const memberships = [...this.#memberships.values()]
      .filter((membership) => membership.spaceId === spaceId)
      .map(freezeMembership);
    const invitations = [...this.#invitations.values()]
      .filter((invitation) => invitation.spaceId === spaceId)
      .map(freezeInvitation);
    const revisions = await this.listRevisions(spaceId);
    return Object.freeze({
      space: freezeKnowledgeSpace(space),
      memberships: Object.freeze(memberships),
      invitations: Object.freeze(invitations),
      revisions,
      reservation: freezeReservation(
        reservation.host,
        reservation.canonicalHandle,
        reservation.spaceId,
      ),
    });
  }

  async inspectOrdinaryMindTotalsForTest(): Promise<Readonly<{
    minds: number;
    reservations: number;
    memberships: number;
    revisions: number;
    idempotencyRecords: number;
  }>> {
    const personalSpaceIds = new Set(
      [...this.#personalBindings.values()].map((binding) => binding.spaceId),
    );
    const ordinarySpaceIds = new Set(
      [...this.#knowledgeSpaces.keys()].filter(
        (spaceId) => !personalSpaceIds.has(spaceId),
      ),
    );
    return Object.freeze({
      minds: ordinarySpaceIds.size,
      reservations: [...this.#activeHandlesBySpace.keys()].filter((spaceId) =>
        ordinarySpaceIds.has(spaceId),
      ).length,
      memberships: [...this.#memberships.values()].filter((membership) =>
        ordinarySpaceIds.has(membership.spaceId),
      ).length,
      revisions: [...this.#revisionsById.values()].filter((envelope) =>
        ordinarySpaceIds.has(envelope.revision.spaceId),
      ).length,
      idempotencyRecords: this.#ordinaryMindIdempotencyRecords.size,
    });
  }

  async inspectAccountBootstrapStateForTest(): Promise<Readonly<{
    principals: number;
    bindings: number;
    personalMinds: number;
    memberships: number;
    revisions: number;
  }>> {
    const personalSpaceIds = new Set(
      [...this.#personalBindings.values()].map((binding) => binding.spaceId),
    );
    return Object.freeze({
      principals: this.#principals.size,
      bindings: this.#externalBindings.size,
      personalMinds: this.#personalBindings.size,
      memberships: this.#memberships.size,
      revisions: [...this.#revisionsById.values()].filter((envelope) =>
        personalSpaceIds.has(envelope.revision.spaceId),
      ).length,
    });
  }

  /** Test/local fixture hook; production authorization mutations use metadata transactions. */
  setCurrentAuthorizationStateForTest(
    query: AuthorizationStateQuery,
    state: CurrentAuthorizationState | null,
  ): void {
    const key = authorizationStateKey(query);
    if (state === null) {
      this.#authorizationStates.delete(key);
      return;
    }
    this.#authorizationStates.set(key, cloneAuthorizationState(state));
  }

  async readCurrentAuthorizationState(
    query: AuthorizationStateQuery,
  ): Promise<AuthorizationState | null> {
    if (query.tokenId === null) {
      const current = this.#currentSitesAuthorizationState(query);
      if (current !== null) return current;
    }
    const state = this.#authorizationStates.get(authorizationStateKey(query));
    return state ? cloneAuthorizationState(state) : null;
  }

  async readCurrentRouteAuthorizationState(
    query: MindRouteAuthorizationQuery,
  ): Promise<AuthorizationState | null> {
    const parsed = parseCanonicalSpaceHandle(query.handle);
    const snapshot = this.#ordinaryMindRouteSnapshot(query.spaceId);
    if (
      parsed.kind !== "valid" ||
      isReservedTopLevelHandle(parsed.canonicalHandle) ||
      !snapshot ||
      snapshot.host !== query.host ||
      snapshot.canonicalHandle !== parsed.canonicalHandle
    ) {
      return null;
    }
    return this.#currentSitesAuthorizationState({
      principalId: query.principalId,
      spaceId: query.spaceId,
      tokenId: query.tokenId,
    });
  }

  #currentSitesAuthorizationState(
    query: AuthorizationStateQuery,
  ): AuthorizationState | null {
    return currentSitesAuthorizationStateFromMaps(
      query,
      this.#principals,
      this.#knowledgeSpaces,
      this.#memberships,
    );
  }

  async #runExclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    const previous = this.#transactionTail;
    let release!: () => void;
    this.#transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #failAccountBootstrapIfRequested(stage: AccountBootstrapFailureStage): void {
    if (this.#nextAccountBootstrapFailureStage !== stage) return;
    this.#nextAccountBootstrapFailureStage = null;
    throw new Error(`injected account bootstrap transaction failure at ${stage}`);
  }


  #failPersonalProfileIfRequested(stage: PersonalProfileFailureStage): void {
    if (this.#nextPersonalProfileFailureStage !== stage) return;
    this.#nextPersonalProfileFailureStage = null;
    throw new Error(`injected Personal Mind profile transaction failure at ${stage}`);
  }

  #failOrdinaryMindIfRequested(stage: OrdinaryMindFailureStage): void {
    if (this.#nextOrdinaryMindFailureStage !== stage) return;
    this.#nextOrdinaryMindFailureStage = null;
    throw new Error(`injected ordinary Mind transaction failure at ${stage}`);
  }

  #failAccountDeletionIfRequested(stage: AccountDeletionFailureStage): void {
    if (this.#nextAccountDeletionFailureStage !== stage) return;
    this.#nextAccountDeletionFailureStage = null;
    throw new Error(`injected account deletion transaction failure at ${stage}`);
  }
}
