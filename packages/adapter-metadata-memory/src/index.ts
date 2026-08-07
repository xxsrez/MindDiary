import type {
  CanonicalRevisionEnvelope,
  CanonicalSpaceHandle,
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
  CreateMcpTokenRequest,
  CreateMcpTokenResult,
  CurrentAuthorizationToken,
  CreateExportJobResult,
  ExpireExportJobResult,
  ExportArchiveRecord,
  ExportJob,
  ExportJobStore,
  ExportStartTransaction,
  RevokeMcpTokenRequest,
  RevokeMcpTokenResult,
  RevokePrincipalTokensForAccountDeletionRequest,
  RevokePrincipalTokensForAccountDeletionResult,
  RetiredHandleMarker,
  RevisionIndexState,
  RevisionCommitRequest,
  RevisionCommitResult,
  SpaceTargetPurgeResult,
  StageContentCommitEffectsRequest,
  StageContentCommitEffectsResult,
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

export class InMemoryRevisionMetadataStore
  implements ContentCommitMetadataStore, ExportJobStore {
  readonly kind = "metadata-store" as const;
  #spaces = new Map<SpaceId, SpaceState>();
  #revisionsById = new Map<RevisionId, Envelope>();
  #idempotencyRecords = new Map<string, CompletedIdempotencyRecord>();
  #auditEvents = new Map<AuditEventId, Readonly<AuditEvent>>();
  #auditOutbox = new Map<OutboxMessageId, Readonly<AuditOutboxMessage>>();
  #backgroundJobs = new Map<JobId, Readonly<BackgroundJob>>();
  #exportJobs = new Map<JobId, Readonly<ExportJob>>();
  #indexStates = new Map<string, Readonly<RevisionIndexState>>();
  readonly #authorizationStates = new Map<string, AuthorizationState>();
  #transactionTail: Promise<void> = Promise.resolve();
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
      jobIds.forEach((id) => this.#backgroundJobs.delete(id));
      exportJobIds.forEach((id) => this.#exportJobs.delete(id));
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

  failNextCommitForTest(
    error: Error = new Error("injected revision metadata transaction failure"),
  ): void {
    this.#nextCommitFailure = error;
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
    const state = this.#authorizationStates.get(authorizationStateKey(query));
    return state ? cloneAuthorizationState(state) : null;
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
}
