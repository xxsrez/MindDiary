import type {
  CanonicalRevisionEnvelope,
  CanonicalSpaceHandle,
  AccountBootstrapRecordSet,
  AccountBootstrapTransaction,
  CreateAccountBootstrapResult,
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
  RevokePrincipalTokensForAccountDeletionRequest,
  RevokePrincipalTokensForAccountDeletionResult,
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
} from "@mind-diary/application-ports";
import {
  DomainInvariantError,
  PrincipalAccount,
  SpaceAggregate,
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
const BOUNDED_OPAQUE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const MAX_CLAIM_LEASE_MS = 5 * 60 * 1_000;

function validCommitAuditMetadata(
  metadata: Readonly<Record<string, unknown>>,
  envelope: Envelope,
): boolean {
  const keys = Object.keys(metadata).sort();
  if (
    keys.length !== COMMIT_AUDIT_METADATA_KEYS.length ||
    keys.some((key, index) => key !== COMMIT_AUDIT_METADATA_KEYS[index])
  ) {
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
    metadata.manifest_hash === revision.manifestHash
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

export class InMemoryRevisionMetadataStore
  implements
    ContentCommitMetadataStore,
    ExportDownloadGrantStore,
    PublicMindCatalogStore,
    PersonalMindStore,
    OrdinaryMindStore {
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
  #ordinaryMindDeletionImpacts: OrdinaryMindDeletionImpactMap = new Map();
  #ordinaryMindDeletionCleanup: OrdinaryMindDeletionCleanupMap = new Map();
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

  async runOrdinaryMindTransaction<Result>(
    operation: (transaction: OrdinaryMindMetadataTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.#runExclusive(async () => {
      const principals = cloneRecordMap(this.#principals, freezePrincipal);
      const externalBindings = cloneRecordMap(
        this.#externalBindings,
        freezeExternalBinding,
      );
      const personalBindings = cloneRecordMap(
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
      let authorizationStates = new Map(
        [...this.#authorizationStates].map(([key, state]) => [
          key,
          cloneAuthorizationState(state),
        ]),
      );

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

      const transaction: OrdinaryMindMetadataTransaction = Object.freeze({
        kind: "authorization-transaction" as const,
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
            spaceId: space.spaceId,
            host: request.host,
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
      });

      const result = await operation(transaction);
      this.#knowledgeSpaces = knowledgeSpaces;
      this.#memberships = memberships;
      this.#invitations = invitations;
      this.#spaces = revisionSpaces;
      this.#revisionsById = revisionsById;
      this.#ordinaryMindIdempotencyRecords = idempotencyRecords;
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
        readCurrentAuthorizationState: async (query: AuthorizationStateQuery) => {
          const state = authorizationStates.get(authorizationStateKey(query));
          return state ? cloneAuthorizationState(state) : null;
        },
        readHead: async (spaceId: SpaceId) => spaces.get(spaceId)?.head ?? null,
        readRevision: async (spaceId: SpaceId, revisionId: RevisionId) =>
          spaces.get(spaceId)?.revisions.get(revisionId) ?? null,
        checkIdempotency: async (request: CheckIdempotencyRequest) =>
          checkIdempotencyAgainst(request, idempotencyRecords),
        commitRevision: async (request: RevisionCommitRequest) =>
          this.#commitRevisionAgainst(request, spaces, revisionsById),
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
        readCurrentAuthorizationState: async (query: AuthorizationStateQuery) => {
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
        readCurrentAuthorizationState: async (query: AuthorizationStateQuery) => {
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
}
