import type {
  CanonicalRevisionEnvelope,
  CanonicalSpaceHandle,
  AccountBootstrapRecordSet,
  AccountBootstrapTransaction,
  CreateAccountBootstrapResult,
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
  JobId,
  McpTokenMetadata,
  McpTokenStore,
  MetadataStore,
  MindRouteAuthorizationQuery,
  MindRouteMetadataStore,
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
  OrdinaryMindMetadataTransaction,
  OrdinaryMindRecordSet,
  OrdinaryMindRouteSnapshot,
  OrdinaryMindSnapshot,
  OrdinaryMindStore,
  RenameOrdinaryMindRequest,
  RenameOrdinaryMindResult,
  SpaceTargetPurgeResult,
  StageContentCommitEffectsRequest,
  StageContentCommitEffectsResult,
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

function cloneRecordMap<Key, Value extends object>(
  source: ReadonlyMap<Key, Readonly<Value>>,
  clone: (value: Readonly<Value>) => Readonly<Value>,
): Map<Key, Readonly<Value>> {
  return new Map([...source].map(([key, value]) => [key, clone(value)]));
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
    };

function freezeOrdinaryMindSnapshot(
  snapshot: Readonly<OrdinaryMindSnapshot>,
): Readonly<OrdinaryMindSnapshot> {
  return Object.freeze({
    space: freezeKnowledgeSpace(snapshot.space),
    ownerMembership: freezeMembership(snapshot.ownerMembership),
  });
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

function cloneOrdinaryMindIdempotencyRecords(
  records: ReadonlyMap<string, Readonly<OrdinaryMindIdempotencyRecord>>,
): Map<string, Readonly<OrdinaryMindIdempotencyRecord>> {
  return new Map(
    [...records].map(([key, record]) => [
      key,
      Object.freeze({ ...record, mind: freezeOrdinaryMindSnapshot(record.mind) }),
    ]),
  );
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
  | "rename_before_commit";

export class InMemoryRevisionMetadataStore
  implements
    ContentCommitMetadataStore,
    ExportDownloadGrantStore,
    MindRouteMetadataStore,
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
  #personalProfileIdempotencyRecords = new Map<
    string,
    Readonly<PersonalProfileIdempotencyRecord>
  >();
  #ordinaryMindIdempotencyRecords = new Map<
    string,
    Readonly<OrdinaryMindIdempotencyRecord>
  >();
  #activeHandlesByKey: ActiveHandleByKeyMap = new Map();
  #activeHandlesBySpace: ActiveHandleBySpaceMap = new Map();
  #retiredHandles: RetiredHandleMap = new Map();
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
      let knowledgeSpaces = cloneRecordMap(
        this.#knowledgeSpaces,
        freezeKnowledgeSpace,
      );
      let memberships = cloneRecordMap(this.#memberships, freezeMembership);
      let revisionSpaces = cloneSpaces(this.#spaces);
      let revisionsById = new Map(this.#revisionsById);
      let idempotencyRecords = cloneOrdinaryMindIdempotencyRecords(
        this.#ordinaryMindIdempotencyRecords,
      );
      let activeByHandle = new Map(this.#activeHandlesByKey);
      let activeBySpace = new Map(this.#activeHandlesBySpace);
      let retired = new Map(this.#retiredHandles);

      const transaction: OrdinaryMindMetadataTransaction = Object.freeze({
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
      });

      const result = await operation(transaction);
      this.#knowledgeSpaces = knowledgeSpaces;
      this.#memberships = memberships;
      this.#spaces = revisionSpaces;
      this.#revisionsById = revisionsById;
      this.#ordinaryMindIdempotencyRecords = idempotencyRecords;
      this.#activeHandlesByKey = activeByHandle;
      this.#activeHandlesBySpace = activeBySpace;
      this.#retiredHandles = retired;
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
      const jobIds = [...this.#backgroundJobs]
        .filter(
          ([, job]) =>
            ("spaceId" in job.target && job.target.spaceId === spaceId) ||
            (job.target.kind === "audit_delivery" &&
              outboxIdSet.has(job.target.outboxMessageId)),
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
    const revisions = await this.listRevisions(spaceId);
    return Object.freeze({
      space: freezeKnowledgeSpace(space),
      memberships: Object.freeze(memberships),
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
    if (query.tokenId !== null) return null;
    const principal = this.#principals.get(query.principalId);
    const space = this.#knowledgeSpaces.get(query.spaceId);
    if (!principal || !space) return null;
    const matchingMemberships = [...this.#memberships.values()]
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
