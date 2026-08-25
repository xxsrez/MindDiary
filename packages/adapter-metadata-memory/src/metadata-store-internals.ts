import type {
  AccountBootstrapRecordSet,
  AccountDeletionCleanupWorkItem,
  AccountDeletionImpactSnapshot,
  ApplyAutomaticCapturePolicyRequest,
  ApplyMindBindingMutationResult,
  ApplyReadMindBindingRequest,
  ApplyWriteMindBindingRequest,
  AuditEvent,
  AuditOutboxMessage,
  AuthorizationStateQuery,
  BackgroundJob,
  BundleFileDownloadGrant,
  CanonicalRevisionEnvelope,
  CapacityAdmissionRequest,
  CapacityAmounts,
  CapacityReservation,
  CapacityUsageSnapshot,
  CapacityUtilizationState,
  ChangeOrdinaryMindVisibilityRequest,
  CheckIdempotencyRequest,
  CheckIdempotencyResult,
  CompleteIdempotencyRequest,
  CompleteIdempotencyResult,
  ConsumeBundleFileDownloadGrantResult,
  ConsumeStagedBundleFilesRequest,
  ConsumeStagedBundleFilesResult,
  CreateInvitationRequest,
  CreateStagedBundleFileResult,
  CurrentAuthorizationState,
  CurrentAuthorizationToken,
  ExportArchiveRecord,
  ExportDownloadGrant,
  ExportJob,
  ExternalIdentityBinding,
  ExternalIdentityBindingLookup,
  HandleReservationSnapshot,
  IdempotencyNamespace,
  IdempotencyRecord,
  InvitationLifecycleSnapshot,
  InvitationSnapshot,
  JobId,
  KnowledgeSpace,
  MarkdownImportPlan,
  MarkdownImportSession,
  MarkdownImportSessionFailure,
  MarkdownImportStagedFile,
  MembershipMutationReplayRequest,
  MembershipMutationReplayResult,
  MindBindingOwnerId,
  MindBindingSet,
  MindBindingSetSnapshot,
  ObjectCleanupCheckpoint,
  ObjectCleanupNamespace,
  OrdinaryMindDeletionCleanupWorkItem,
  OrdinaryMindDeletionImpactSnapshot,
  OrdinaryMindRecordSet,
  OrdinaryMindSnapshot,
  OwnershipTransferSnapshot,
  PersonalMindProfileSnapshot,
  PersonalSpaceBinding,
  Principal,
  PrincipalAccountSnapshot,
  PrincipalActivitySummary,
  PrincipalId,
  ReadMindBinding,
  ReadMindBindingId,
  RegisteredPrincipalSnapshot,
  ReissueInvitationRequest,
  RenameOrdinaryMindRequest,
  RenamePersonalProfileRequest,
  RevisionIndexState,
  RevokeMindBindingOwnerRequest,
  ServiceOperatorDirectoryQuery,
  ServiceOperatorPrincipalProjection,
  SpaceInvitation,
  SpaceMembership,
  StageContentCommitEffectsRequest,
  StageContentCommitEffectsResult,
  StagedBundleFileId,
  StagedBundleFileRecord,
  TransferOrdinaryMindOwnershipRequest,
  TransitionInvitationRequest,
  UtcInstant,
  VerifiedSpaceHost,
  WriteMindBinding,
  WriteMindBindingId,
} from "@mind-diary/application-ports";
import {
  OBJECT_CLEANUP_NAMESPACES,
  PrincipalAccount,
  SpaceAggregate,
  bindingVersion,
  isReservedTopLevelHandle,
  parseCanonicalSpaceHandle,
  roleHasCapability,
  serializeRevisionManifest,
  version,
} from "@mind-diary/application-ports";

export type Envelope = Readonly<CanonicalRevisionEnvelope>;
export type RevisionId = Envelope["revision"]["revisionId"];
export type SpaceId = Envelope["revision"]["spaceId"];
export type Digest = Envelope["revision"]["manifestHash"];

export type AuditEventId = AuditEvent["auditEventId"];
export type OutboxMessageId = AuditOutboxMessage["outboxMessageId"];

export interface SpaceState {
  head: RevisionId | null;
  revisions: Map<RevisionId, Envelope>;
}

export type AuthorizationState = Readonly<CurrentAuthorizationState>;
export type CompletedIdempotencyRecord = Readonly<
  Extract<IdempotencyRecord, { readonly state: "completed" }>
>;

export function freezeStagedBundleFile(
  record: Readonly<StagedBundleFileRecord>,
): Readonly<StagedBundleFileRecord> {
  return Object.freeze({ ...record });
}

export function freezeMarkdownImportPlan(
  plan: Readonly<MarkdownImportPlan>,
): Readonly<MarkdownImportPlan> {
  return Object.freeze({
    ...plan,
    files: Object.freeze(plan.files.map((file) => Object.freeze({ ...file }))),
  });
}

export function freezeMarkdownImportFailure(
  failure: Readonly<MarkdownImportSessionFailure>,
): Readonly<MarkdownImportSessionFailure> {
  return Object.freeze({ ...failure });
}

export function freezeMarkdownImportSession(
  session: Readonly<MarkdownImportSession>,
): Readonly<MarkdownImportSession> {
  return Object.freeze({
    ...session,
    failures: Object.freeze(session.failures.map(freezeMarkdownImportFailure)),
  });
}

export function freezeMarkdownImportStagedFile(
  file: Readonly<MarkdownImportStagedFile>,
): Readonly<MarkdownImportStagedFile> {
  return Object.freeze({ ...file });
}

export function markdownImportKey(
  principalId: PrincipalId,
  spaceId: SpaceId,
  key: MarkdownImportPlan["idempotencyKey"],
): string {
  return `${principalId}\u0000${spaceId}\u0000${key}`;
}

export function markdownImportBatchKey(importId: string, checkpoint: number): string {
  return `${importId}\u0000${checkpoint}`;
}

export function stagedBundleFileActive(
  record: Readonly<StagedBundleFileRecord>,
  occurredAt: StagedBundleFileRecord["createdAt"],
): boolean {
  return (
    (record.state === "quarantined" || record.state === "verified") &&
    Date.parse(record.expiresAt) > Date.parse(occurredAt)
  );
}

export function createStagedBundleFileAgainst(
  record: Readonly<StagedBundleFileRecord>,
  maxOutstandingBytes: number,
  occurredAt: StagedBundleFileRecord["createdAt"],
  records: Map<StagedBundleFileId, Readonly<StagedBundleFileRecord>>,
): CreateStagedBundleFileResult {
  const existing = records.get(record.stagedFileId);
  if (existing !== undefined) {
    return JSON.stringify(existing) === JSON.stringify(record)
      ? Object.freeze({ kind: "created", record: freezeStagedBundleFile(existing) })
      : Object.freeze({ kind: "id_collision" });
  }
  const outstanding = [...records.values()]
    .filter(
      (item) =>
        item.bindingOwnerId === record.bindingOwnerId &&
        stagedBundleFileActive(item, occurredAt),
    )
    .reduce((total, item) => total + item.size, 0);
  if (outstanding + record.size > maxOutstandingBytes) {
    return Object.freeze({ kind: "outstanding_byte_limit_exceeded" });
  }
  const frozen = freezeStagedBundleFile(record);
  records.set(record.stagedFileId, frozen);
  return Object.freeze({ kind: "created", record: frozen });
}

export function consumeStagedBundleFilesAgainst(
  request: Readonly<ConsumeStagedBundleFilesRequest>,
  records: Map<StagedBundleFileId, Readonly<StagedBundleFileRecord>>,
): ConsumeStagedBundleFilesResult {
  const seen = new Set<StagedBundleFileId>();
  const selected: Readonly<StagedBundleFileRecord>[] = [];
  for (const stagedFileId of request.stagedFileIds) {
    if (seen.has(stagedFileId)) {
      return Object.freeze({ kind: "duplicate_reference", stagedFileId });
    }
    seen.add(stagedFileId);
    const record = records.get(stagedFileId);
    if (!record) return Object.freeze({ kind: "not_found", stagedFileId });
    if (Date.parse(record.expiresAt) <= Date.parse(request.consumedAt)) {
      return Object.freeze({ kind: "expired", stagedFileId });
    }
    if (record.state !== "verified") {
      return Object.freeze({ kind: "not_verified", stagedFileId });
    }
    if (
      record.bindingOwnerId !== request.bindingOwnerId ||
      record.writeBindingId !== request.writeBindingId ||
      record.writeBindingGeneration !== request.writeBindingGeneration ||
      record.spaceId !== request.spaceId
    ) return Object.freeze({ kind: "binding_mismatch", stagedFileId });
    selected.push(record);
  }
  const consumed = selected.map((record) => {
    const updated = freezeStagedBundleFile({
      ...record,
      state: "consumed",
      consumedAt: request.consumedAt,
    });
    records.set(record.stagedFileId, updated);
    return updated;
  });
  return Object.freeze({ kind: "consumed", records: Object.freeze(consumed) });
}

export function bundleFileRetainedQuotaAllows(
  request: Readonly<{
    spaceId: SpaceId;
    candidateEntries: readonly Readonly<{ sha256: Digest; size: number }>[];
    maxRetainedBytes: number;
  }>,
  spaces: ReadonlyMap<SpaceId, SpaceState>,
): boolean {
  if (!Number.isSafeInteger(request.maxRetainedBytes) || request.maxRetainedBytes < 1) {
    return false;
  }
  const unique = new Map<Digest, number>();
  for (const revision of spaces.get(request.spaceId)?.revisions.values() ?? []) {
    for (const entry of revision.manifest.entries) {
      if (entry.kind === "opaque") unique.set(entry.sha256, entry.size);
    }
  }
  for (const entry of request.candidateEntries) {
    const existingSize = unique.get(entry.sha256);
    if (
      !SHA256_PATTERN.test(entry.sha256) ||
      !Number.isSafeInteger(entry.size) || entry.size < 0 ||
      (existingSize !== undefined && existingSize !== entry.size)
    ) return false;
    unique.set(entry.sha256, entry.size);
  }
  let total = 0;
  for (const size of unique.values()) {
    total += size;
    if (!Number.isSafeInteger(total) || total > request.maxRetainedBytes) return false;
  }
  return true;
}

export const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
export const EXPORT_DOWNLOAD_VERIFIER_PATTERN =
  /^hmac-sha256:export-download:v1:[0-9a-f]{64}$/u;
export const MARKDOWN_MEDIA_TYPE = "text/markdown; charset=utf-8";

export function compareUnicodeScalarValues(left: string, right: string): number {
  const leftPoints = [...left].map((value) => value.codePointAt(0)!);
  const rightPoints = [...right].map((value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

export function canonicalManifestSource(envelope: Envelope): string | null {
  try {
    return serializeRevisionManifest(envelope.manifest);
  } catch {
    return null;
  }
}

export async function sha256(source: string): Promise<string> {
  const bytes = new TextEncoder().encode(source);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function envelopesEqual(left: Envelope, right: Envelope): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function cloneEnvelope(envelope: Envelope): Envelope {
  const entries = envelope.manifest.entries.map((entry) =>
    entry.kind === "opaque"
      ? Object.freeze({ ...entry, kind: "opaque" as const })
      : Object.freeze({
          ...entry,
          kind: "markdown" as const,
          mediaType: MARKDOWN_MEDIA_TYPE,
        }));
  return Object.freeze({
    revision: Object.freeze({
      ...envelope.revision,
      committedBy: Object.freeze({ ...envelope.revision.committedBy }),
    }),
    manifest: Object.freeze({
      format: envelope.manifest.format ?? "mind-diary-revision-manifest-v1",
      entries: Object.freeze(entries),
    }),
  });
}

export function cloneSpaces(source: ReadonlyMap<SpaceId, SpaceState>): Map<SpaceId, SpaceState> {
  return new Map(
    [...source].map(([spaceId, state]) => [
      spaceId,
      { head: state.head, revisions: new Map(state.revisions) },
    ]),
  );
}

export function authorizationStateKey(query: AuthorizationStateQuery): string {
  return `${query.principalId}\u0000${query.spaceId}\u0000${query.tokenId ?? ""}`;
}

export function cloneAuthorizationState(state: AuthorizationState): AuthorizationState {
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

export function idempotencyNamespaceKey(
  namespace: Readonly<IdempotencyNamespace>,
): string {
  if (namespace.operation === "stage_bundle_file") {
    return JSON.stringify([
      namespace.bindingOwnerId ?? null,
      namespace.principalId,
      namespace.spaceId,
      namespace.operation,
      namespace.key,
    ]);
  }
  return JSON.stringify([
    namespace.principalId,
    namespace.spaceId,
    namespace.operation,
    namespace.key,
  ]);
}

export function cloneIdempotencyRecord(
  record: CompletedIdempotencyRecord,
): CompletedIdempotencyRecord {
  if (record.operation === "commit_changeset") {
    return Object.freeze({
      ...record,
      operation: "commit_changeset",
      result: Object.freeze({ ...record.result }),
    });
  }
  if (record.operation === "stage_bundle_file") {
    return Object.freeze({
      ...record,
      operation: "stage_bundle_file",
      result: Object.freeze({ ...record.result }),
    });
  }
  return Object.freeze({
    ...record,
    operation: "start_export",
    result: Object.freeze({ ...record.result }),
  });
}

export function cloneIdempotencyRecords(
  source: ReadonlyMap<string, CompletedIdempotencyRecord>,
): Map<string, CompletedIdempotencyRecord> {
  return new Map(
    [...source].map(([key, record]) => [key, cloneIdempotencyRecord(record)]),
  );
}

export function cloneAuditEvent(event: Readonly<AuditEvent>): Readonly<AuditEvent> {
  return Object.freeze({
    ...event,
    actor: Object.freeze({ ...event.actor }),
    safeMetadata: Object.freeze({ ...event.safeMetadata }),
  });
}

export function cloneAuditOutbox(
  message: Readonly<AuditOutboxMessage>,
): Readonly<AuditOutboxMessage> {
  return Object.freeze({ ...message });
}

export function clonePrincipalActivity(
  summary: Readonly<PrincipalActivitySummary>,
): Readonly<PrincipalActivitySummary> {
  return Object.freeze({ ...summary });
}

export const SERVICE_OPERATOR_CURSOR_PREFIX = "md_operator_cursor_v1.";

export function encodeServiceOperatorCursor(offset: number): string {
  const json = JSON.stringify({ v: 1, o: offset });
  return `${SERVICE_OPERATOR_CURSOR_PREFIX}${btoa(json)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")}`;
}

export function decodeServiceOperatorCursor(cursor: string | undefined): number | null {
  if (cursor === undefined) return 0;
  if (!cursor.startsWith(SERVICE_OPERATOR_CURSOR_PREFIX)) return null;
  try {
    const encoded = cursor.slice(SERVICE_OPERATOR_CURSOR_PREFIX.length);
    const padded = `${encoded}${"=".repeat((4 - (encoded.length % 4)) % 4)}`;
    const parsed = JSON.parse(
      atob(padded.replaceAll("-", "+").replaceAll("_", "/")),
    ) as Record<string, unknown>;
    if (
      parsed.v !== 1 ||
      !Number.isSafeInteger(parsed.o) ||
      (parsed.o as number) < 0
    ) return null;
    const offset = parsed.o as number;
    return encodeServiceOperatorCursor(offset) === cursor ? offset : null;
  } catch {
    return null;
  }
}

export function normalizeDirectorySearch(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export function compareDirectoryRows(
  left: Readonly<ServiceOperatorPrincipalProjection>,
  right: Readonly<ServiceOperatorPrincipalProjection>,
  query: Readonly<ServiceOperatorDirectoryQuery>,
): number {
  let compared = 0;
  if (query.sort === "registered_at") {
    compared = left.registeredAt.localeCompare(right.registeredAt);
  } else if (query.sort === "last_activity_at") {
    const leftValue = left.activity?.lastActivityAt ?? "";
    const rightValue = right.activity?.lastActivityAt ?? "";
    compared = leftValue.localeCompare(rightValue);
  } else {
    compared = normalizeDirectorySearch(left.displayName).localeCompare(
      normalizeDirectorySearch(right.displayName),
      "en-US",
    );
  }
  if (compared === 0) {
    compared = compareUnicodeScalarValues(left.principalId, right.principalId);
  }
  return query.direction === "asc" ? compared : -compared;
}

export function cloneBackgroundJob(job: Readonly<BackgroundJob>): Readonly<BackgroundJob> {
  return Object.freeze({ ...job, target: Object.freeze({ ...job.target }) });
}

export function cloneExportJob(job: Readonly<ExportJob>): Readonly<ExportJob> {
  return Object.freeze({
    ...job,
    archive: job.archive === null ? null : Object.freeze({ ...job.archive }),
  });
}

export function cloneExportJobs(
  source: ReadonlyMap<JobId, Readonly<ExportJob>>,
): Map<JobId, Readonly<ExportJob>> {
  return new Map([...source].map(([id, job]) => [id, cloneExportJob(job)]));
}

export function cloneExportDownloadGrant(
  grant: Readonly<ExportDownloadGrant>,
): Readonly<ExportDownloadGrant> {
  return Object.freeze({ ...grant });
}

export function cloneExportDownloadGrants(
  source: ReadonlyMap<string, Readonly<ExportDownloadGrant>>,
): Map<string, Readonly<ExportDownloadGrant>> {
  return new Map(
    [...source].map(([verifier, grant]) => [verifier, cloneExportDownloadGrant(grant)]),
  );
}

export function cloneBundleFileDownloadGrant(
  grant: Readonly<BundleFileDownloadGrant>,
): Readonly<BundleFileDownloadGrant> {
  return Object.freeze({ ...grant });
}

export function cloneBundleFileDownloadGrants(
  source: ReadonlyMap<string, Readonly<BundleFileDownloadGrant>>,
): Map<string, Readonly<BundleFileDownloadGrant>> {
  return new Map(
    [...source].map(([verifier, grant]) => [verifier, cloneBundleFileDownloadGrant(grant)]),
  );
}

export function validBundleFileDownloadGrant(
  grant: Readonly<BundleFileDownloadGrant>,
  revision: Readonly<CanonicalRevisionEnvelope> | undefined,
): boolean {
  const createdAt = Date.parse(grant.createdAt);
  const expiresAt = Date.parse(grant.expiresAt);
  const entry = revision?.manifest.entries.find((candidate) => candidate.path === grant.path);
  return (
    EXPORT_DOWNLOAD_VERIFIER_PATTERN.test(grant.secretVerifier) &&
    typeof grant.requestedByPrincipalId === "string" && grant.requestedByPrincipalId.length > 0 &&
    typeof grant.tokenId === "string" && grant.tokenId.length > 0 &&
    typeof grant.bindingOwnerId === "string" && grant.bindingOwnerId.length > 0 &&
    revision?.revision.spaceId === grant.spaceId &&
    revision.revision.revisionId === grant.revisionId &&
    entry?.kind === "opaque" &&
    entry.mediaType === grant.mediaType &&
    entry.sha256 === grant.sha256 &&
    entry.size === grant.size &&
    grant.state === "active" &&
    grant.consumedAt === null &&
    Number.isFinite(createdAt) &&
    Number.isFinite(expiresAt) &&
    expiresAt > createdAt
  );
}

export function readBundleFileDownloadGrantAgainst(
  secretVerifier: BundleFileDownloadGrant["secretVerifier"],
  now: BundleFileDownloadGrant["createdAt"],
  grants: Map<string, Readonly<BundleFileDownloadGrant>>,
): ConsumeBundleFileDownloadGrantResult | {
  readonly kind: "active";
  readonly grant: Readonly<BundleFileDownloadGrant>;
} {
  if (!EXPORT_DOWNLOAD_VERIFIER_PATTERN.test(secretVerifier) || !Number.isFinite(Date.parse(now))) {
    return Object.freeze({ kind: "not_found" });
  }
  const current = grants.get(secretVerifier);
  if (current === undefined) return Object.freeze({ kind: "not_found" });
  if (current.state === "consumed") return Object.freeze({ kind: "consumed" });
  if (current.state === "expired" || Date.parse(now) >= Date.parse(current.expiresAt)) {
    if (current.state !== "expired") {
      grants.set(secretVerifier, Object.freeze({ ...current, state: "expired" as const }));
    }
    return Object.freeze({ kind: "expired" });
  }
  return Object.freeze({ kind: "active", grant: cloneBundleFileDownloadGrant(current) });
}

export function cloneIndexState(
  state: Readonly<RevisionIndexState>,
): Readonly<RevisionIndexState> {
  return Object.freeze({ ...state });
}

export function indexStateKey(spaceId: SpaceId, revisionId: RevisionId): string {
  return `${spaceId}\u0000${revisionId}`;
}

export function revisionIndexJobsForTarget(
  jobs: ReadonlyMap<JobId, Readonly<BackgroundJob>>,
  spaceId: SpaceId,
  revisionId: RevisionId,
): readonly Readonly<BackgroundJob>[] {
  return [...jobs.values()].filter((job) =>
    job.target.kind === "revision_index" &&
    job.target.spaceId === spaceId &&
    job.target.revisionId === revisionId
  );
}

export function revisionIndexMetadataConsistent(
  state: Readonly<RevisionIndexState> | undefined,
  jobs: readonly Readonly<BackgroundJob>[],
): boolean {
  if (state === undefined || jobs.length !== 1) return false;
  const job = jobs[0]!;
  if (
    job.target.kind !== "revision_index" ||
    job.target.spaceId !== state.spaceId ||
    job.target.revisionId !== state.revisionId ||
    job.attempts !== state.attempts
  ) return false;
  if (job.state === "succeeded") {
    return state.status === "ready" && state.readyAt !== null &&
      state.lastFailureCode === null && job.claimExpiresAt === null;
  }
  if (job.state === "running") {
    return state.status === "queued" && state.readyAt === null &&
      state.lastFailureCode === null && job.claimExpiresAt !== null;
  }
  if (job.state === "queued") {
    return state.status === "queued" && state.readyAt === null &&
      state.lastFailureCode === null && job.claimExpiresAt === null;
  }
  if (job.state === "failed") {
    return state.status === "failed" && state.readyAt === null &&
      state.lastFailureCode !== null && job.claimExpiresAt === null;
  }
  return false;
}

export const COMMIT_AUDIT_METADATA_KEYS = [
  "manifest_hash",
  "previous_revision_id",
  "revision_id",
  "revision_number",
] as const;
export const CAPTURE_COMMIT_AUDIT_METADATA_KEYS = [
  "capture_key",
  "capture_mode",
  "capture_path",
  "capture_source_refs",
  ...COMMIT_AUDIT_METADATA_KEYS,
] as const;
export const BOUNDED_OPAQUE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
export const CAPTURE_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
export const CAPTURE_SOURCE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)(?:[^\u0000-\u001f\u007f\\]+\/)*[^\u0000-\u001f\u007f\\]+\.md$/u;
export const MAX_CLAIM_LEASE_MS = 5 * 60 * 1_000;

export function validCaptureAuditSourceRefs(value: unknown): boolean {
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

export function validCommitAuditMetadata(
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

export function validClaimLease(now: string, claimExpiresAt: string): boolean {
  const start = Date.parse(now);
  const end = Date.parse(claimExpiresAt);
  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end > start &&
    end - start <= MAX_CLAIM_LEASE_MS
  );
}

export function validExportArchive(archive: Readonly<ExportArchiveRecord>): boolean {
  const bundleProfile = archive.archiveFormat === "MD-BUNDLE-ZIP-1";
  return (
    typeof archive.objectKey === "string" &&
    archive.objectKey.length > 0 &&
    archive.objectKey.length <= 512 &&
    (archive.archiveFormat === "MD-OKF-ZIP-1" || bundleProfile) &&
    archive.mediaType === "application/zip" &&
    archive.filename === (bundleProfile ? "mind-diary-bundle.zip" : "mind-diary-okf-bundle.zip") &&
    archive.contentDisposition === (bundleProfile
      ? 'attachment; filename="mind-diary-bundle.zip"'
      : 'attachment; filename="mind-diary-okf-bundle.zip"') &&
    SHA256_PATTERN.test(archive.sha256) &&
    Number.isSafeInteger(archive.size) &&
    archive.size >= 0
  );
}

export function validExportDownloadGrant(
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

export function validInitialExportJob(
  job: Readonly<ExportJob>,
  revisionsById: ReadonlyMap<RevisionId, Envelope>,
): boolean {
  const createdAt = Date.parse(job.createdAt);
  const expiresAt = Date.parse(job.expiresAt);
  const revision = revisionsById.get(job.revisionId);
  const profile = job.profile ?? "MD-OKF-ZIP-1";
  return (
    typeof job.jobId === "string" &&
    job.jobId.length > 0 &&
    typeof job.requestedByPrincipalId === "string" &&
    job.requestedByPrincipalId.length > 0 &&
    typeof job.idempotencyKey === "string" &&
    job.idempotencyKey.length > 0 &&
    revision?.revision.spaceId === job.spaceId &&
    (profile === "MD-OKF-ZIP-1" || profile === "MD-BUNDLE-ZIP-1") &&
    (profile === "MD-BUNDLE-ZIP-1" ||
      revision?.manifest.entries.every((entry) => entry.kind === "markdown")) &&
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

export function stageContentCommitEffectsAgainst(
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

export function stageInitialRevisionIndexAgainst(
  records: Pick<
    AccountBootstrapRecordSet | OrdinaryMindRecordSet,
    "initialRevision" | "initialIndexJob" | "initialIndexState"
  >,
  backgroundJobs: Map<JobId, Readonly<BackgroundJob>>,
  indexStates: Map<string, Readonly<RevisionIndexState>>,
  mode: "initial" | "recovery" = "initial",
): "staged" | "legacy_missing" | "invalid" {
  const revision = records.initialRevision.revision;
  const job = records.initialIndexJob;
  const state = records.initialIndexState;
  if (job === undefined || state === undefined) return "legacy_missing";
  const target = job.target;
  if (
    target.kind !== "revision_index" ||
    target.spaceId !== revision.spaceId ||
    target.revisionId !== revision.revisionId ||
    state.spaceId !== revision.spaceId ||
    state.revisionId !== revision.revisionId ||
    job.state !== "queued" ||
    job.version !== 1 ||
    job.attempts !== 0 ||
    job.claimExpiresAt !== null ||
    (mode === "initial" && job.availableAt !== revision.committedAt) ||
    (mode === "initial" && job.createdAt !== revision.committedAt) ||
    (mode === "initial" && job.updatedAt !== revision.committedAt) ||
    (mode === "recovery" && job.availableAt !== job.createdAt) ||
    (mode === "recovery" && job.updatedAt !== job.createdAt) ||
    (mode === "recovery" && Date.parse(job.createdAt) < Date.parse(revision.committedAt)) ||
    state.status !== "queued" ||
    state.attempts !== 0 ||
    (mode === "initial" && state.queuedAt !== revision.committedAt) ||
    (mode === "initial" && state.updatedAt !== revision.committedAt) ||
    (mode === "recovery" && state.queuedAt !== job.createdAt) ||
    (mode === "recovery" && state.updatedAt !== job.createdAt) ||
    state.readyAt !== null ||
    state.lastFailureCode !== null ||
    backgroundJobs.has(job.jobId) ||
    indexStates.has(indexStateKey(state.spaceId, state.revisionId)) ||
    [...backgroundJobs.values()].some(
      (candidate) =>
        candidate.target.kind === "revision_index" &&
        candidate.target.spaceId === target.spaceId &&
        candidate.target.revisionId === target.revisionId,
    )
  ) {
    return "invalid";
  }
  backgroundJobs.set(job.jobId, cloneBackgroundJob(job));
  indexStates.set(
    indexStateKey(state.spaceId, state.revisionId),
    cloneIndexState(state),
  );
  return "staged";
}

export function checkIdempotencyAgainst(
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

export function completeIdempotencyAgainst(
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
      : request.result.kind === "stage_bundle_file"
        ? Object.freeze({
            ...base,
            operation: "stage_bundle_file",
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

export type PrincipalMap = Map<Principal["principalId"], Readonly<Principal>>;
export type ExternalBindingMap = Map<string, Readonly<ExternalIdentityBinding>>;
export type KnowledgeSpaceMap = Map<KnowledgeSpace["spaceId"], Readonly<KnowledgeSpace>>;
export type PersonalBindingMap = Map<
  PersonalSpaceBinding["principalId"],
  Readonly<PersonalSpaceBinding>
>;
export type MembershipMap = Map<
  SpaceMembership["membershipId"],
  Readonly<SpaceMembership>
>;
export type InvitationMap = Map<
  SpaceInvitation["invitationId"],
  Readonly<SpaceInvitation>
>;

export interface PersonalProfileIdempotencyRecord {
  readonly principalId: Principal["principalId"];
  readonly key: RenamePersonalProfileRequest["idempotencyKey"];
  readonly canonicalRequestHash: RenamePersonalProfileRequest["canonicalRequestHash"];
  readonly profile: Readonly<PersonalMindProfileSnapshot>;
}

export function externalBindingKey(
  lookup: Readonly<ExternalIdentityBindingLookup>,
): string {
  return `${lookup.provider}\u0000${lookup.normalizedBinding}`;
}

export function freezePrincipal(record: Readonly<Principal>): Readonly<Principal> {
  return Object.freeze({ ...record });
}

export function freezeExternalBinding(
  record: Readonly<ExternalIdentityBinding>,
): Readonly<ExternalIdentityBinding> {
  return Object.freeze({ ...record });
}

export function freezeKnowledgeSpace(
  record: Readonly<KnowledgeSpace>,
): Readonly<KnowledgeSpace> {
  return Object.freeze({ ...record });
}

export function freezePersonalBinding(
  record: Readonly<PersonalSpaceBinding>,
): Readonly<PersonalSpaceBinding> {
  return Object.freeze({ ...record });
}

export function freezeMembership(
  record: Readonly<SpaceMembership>,
): Readonly<SpaceMembership> {
  return Object.freeze({ ...record });
}

export function freezeInvitation(
  record: Readonly<SpaceInvitation>,
): Readonly<SpaceInvitation> {
  return Object.freeze({ ...record });
}

export function freezeRegisteredPrincipalSnapshot(
  principal: Readonly<RegisteredPrincipalSnapshot>,
): Readonly<RegisteredPrincipalSnapshot> {
  return Object.freeze({ ...principal });
}

export function freezeInvitationSnapshot(
  snapshot: Readonly<InvitationSnapshot>,
): Readonly<InvitationSnapshot> {
  return Object.freeze({
    invitation: freezeInvitation(snapshot.invitation),
    target: freezeRegisteredPrincipalSnapshot(snapshot.target),
  });
}

export function freezeInvitationLifecycleSnapshot(
  snapshot: Readonly<InvitationLifecycleSnapshot>,
): Readonly<InvitationLifecycleSnapshot> {
  return Object.freeze({
    invitation: freezeInvitationSnapshot(snapshot.invitation),
    membership: snapshot.membership === null ? null : freezeMembership(snapshot.membership),
  });
}

export function cloneRecordMap<Key, Value extends object>(
  source: ReadonlyMap<Key, Readonly<Value>>,
  clone: (value: Readonly<Value>) => Readonly<Value>,
): Map<Key, Readonly<Value>> {
  return new Map([...source].map(([key, value]) => [key, clone(value)]));
}

export function currentSitesAuthorizationStateFromMaps(
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

export function accountFromMaps(
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

export function accountByBindingFromMaps(
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

export function freezePersonalMindProfile(
  profile: Readonly<PersonalMindProfileSnapshot>,
): Readonly<PersonalMindProfileSnapshot> {
  return Object.freeze({
    principalId: profile.principalId,
    displayName: profile.displayName,
    profileVersion: profile.profileVersion,
    personalMind: Object.freeze({ ...profile.personalMind }),
  });
}

export function personalMindProfileFromAccount(
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

export function personalProfileIdempotencyKey(
  principalId: Principal["principalId"],
  key: RenamePersonalProfileRequest["idempotencyKey"],
): string {
  return `${principalId}\u0000rename_account\u0000${key}`;
}

export function clonePersonalProfileIdempotencyRecords(
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

export function validateAccountBootstrapRecords(
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

export type OrdinaryMindIdempotencyRecord =
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

export type OrdinaryMindDeletionImpactMap = Map<
  OrdinaryMindDeletionImpactSnapshot["impactId"],
  Readonly<OrdinaryMindDeletionImpactSnapshot>
>;

export type OrdinaryMindDeletionCleanupMap = Map<
  OrdinaryMindDeletionCleanupWorkItem["impactId"],
  Readonly<OrdinaryMindDeletionCleanupWorkItem>
>;

export type AccountDeletionImpactMap = Map<
  AccountDeletionImpactSnapshot["impactId"],
  Readonly<AccountDeletionImpactSnapshot>
>;

export type AccountDeletionCleanupMap = Map<
  AccountDeletionCleanupWorkItem["impactId"],
  Readonly<AccountDeletionCleanupWorkItem>
>;

export function cloneAccountDeletionImpact(
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

export function cloneAccountDeletionImpacts(
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

export function cloneAccountDeletionCleanup(
  work: Readonly<AccountDeletionCleanupWorkItem>,
): Readonly<AccountDeletionCleanupWorkItem> {
  return Object.freeze({
    ...work,
    deletedSpaceIds: Object.freeze([...work.deletedSpaceIds]),
    objectDigests: Object.freeze([...work.objectDigests]),
    foreignExportJobIds: Object.freeze([...work.foreignExportJobIds]),
  });
}

export function cloneAccountDeletionCleanups(
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

export function cloneOrdinaryMindDeletionImpact(
  impact: Readonly<OrdinaryMindDeletionImpactSnapshot>,
): Readonly<OrdinaryMindDeletionImpactSnapshot> {
  return Object.freeze({ ...impact });
}

export function cloneOrdinaryMindDeletionImpacts(
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

export function cloneOrdinaryMindDeletionCleanup(
  work: Readonly<OrdinaryMindDeletionCleanupWorkItem>,
): Readonly<OrdinaryMindDeletionCleanupWorkItem> {
  return Object.freeze({ ...work, objectDigests: Object.freeze([...work.objectDigests]) });
}

export function cloneOrdinaryMindDeletionCleanups(
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

export function freezeOrdinaryMindSnapshot(
  snapshot: Readonly<OrdinaryMindSnapshot>,
): Readonly<OrdinaryMindSnapshot> {
  return Object.freeze({
    space: freezeKnowledgeSpace(snapshot.space),
    ownerMembership: freezeMembership(snapshot.ownerMembership),
  });
}

export function freezeOwnershipTransferSnapshot(
  snapshot: Readonly<OwnershipTransferSnapshot>,
): Readonly<OwnershipTransferSnapshot> {
  return Object.freeze({
    mind: freezeOrdinaryMindSnapshot(snapshot.mind),
    sourceMembership: freezeMembership(snapshot.sourceMembership),
    targetMembership: freezeMembership(snapshot.targetMembership),
  });
}

export function sameKnowledgeSpaceRecord(
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

export function sameMembershipRecord(
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

export function sameOwnershipTransferSnapshot(
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

export function ordinaryMindSnapshotFromMaps(
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

export function ownershipTransferSnapshotFromMaps(
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

export function ordinaryMindCreateIdempotencyKey(
  principalId: Principal["principalId"],
  key: OrdinaryMindRecordSet["idempotencyKey"],
): string {
  return `${principalId}\u0000create_space_with_owner\u0000${key}`;
}

export function ordinaryMindRenameIdempotencyKey(
  principalId: Principal["principalId"],
  spaceId: KnowledgeSpace["spaceId"],
  key: RenameOrdinaryMindRequest["idempotencyKey"],
): string {
  return `${principalId}\u0000${spaceId}\u0000rename_space\u0000${key}`;
}

export function ordinaryMindVisibilityIdempotencyKey(
  principalId: Principal["principalId"],
  spaceId: KnowledgeSpace["spaceId"],
  key: ChangeOrdinaryMindVisibilityRequest["idempotencyKey"],
): string {
  return `${principalId}\u0000${spaceId}\u0000change_visibility\u0000${key}`;
}

export function ownershipTransferIdempotencyKey(
  principalId: Principal["principalId"],
  spaceId: KnowledgeSpace["spaceId"],
  key: TransferOrdinaryMindOwnershipRequest["idempotencyKey"],
): string {
  return `${principalId}\u0000${spaceId}\u0000transfer_ownership\u0000${key}`;
}

export function invitationIdempotencyRecordKey(
  principalId: Principal["principalId"],
  spaceId: KnowledgeSpace["spaceId"],
  key: CreateInvitationRequest["idempotencyKey"],
): string {
  return `${principalId}\u0000${spaceId}\u0000create_invitation\u0000${key}`;
}

export function invitationLifecycleIdempotencyRecordKey(
  principalId: Principal["principalId"],
  spaceId: KnowledgeSpace["spaceId"],
  operation: "accept_invitation" | "reject_invitation" | "cancel_invitation" | "reissue_invitation",
  key: TransitionInvitationRequest["idempotencyKey"],
): string {
  return `${principalId}\u0000${spaceId}\u0000${operation}\u0000${key}`;
}

export function invitationLifecycleActorIsCurrentlyAuthorized(
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

export function ordinaryMindIdempotencySpaceId(
  record: Readonly<OrdinaryMindIdempotencyRecord>,
): KnowledgeSpace["spaceId"] {
  return record.operation === "create_space_with_owner"
    ? record.mind.space.spaceId
    : record.spaceId;
}

export function cloneOrdinaryMindIdempotencyRecords(
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

export type MembershipMutationRecord = Readonly<{
  canonicalRequestHash: MembershipMutationReplayRequest["canonicalRequestHash"];
  membership: Readonly<SpaceMembership>;
  changed: boolean;
  requiredCapability: Extract<
    MembershipMutationReplayResult,
    { readonly kind: "replayed" }
  >["requiredCapability"];
}>;

export function membershipMutationKey(
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

export function cloneMembershipMutationRecords(
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

export function readMembershipReplay(
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

export const VISIBILITY_AUDIT_METADATA_KEYS = [
  "access_version",
  "from_visibility",
  "metadata_version",
  "to_visibility",
] as const;

export function visibilityAuditEffects(
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

export function validVisibilityAuditEffects(
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

export function stageVisibilityAuditEffects(
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

export const OWNERSHIP_TRANSFER_AUDIT_METADATA_KEYS = [
  "access_version",
  "metadata_version",
  "source_member_id",
  "source_membership_version",
  "target_member_id",
  "target_membership_version",
] as const;

export function ownershipTransferAuditEffects(
  request: Readonly<TransferOrdinaryMindOwnershipRequest>,
  currentSpace: Readonly<KnowledgeSpace>,
  currentSource: Readonly<SpaceMembership>,
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

export function validOwnershipTransferAuditEffects(
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

export function stageOwnershipTransferAuditEffects(
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
    currentSpace,
    currentSource,
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

export function validateOrdinaryMindRecords(
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

export const PUBLIC_CATALOG_CURSOR_PREFIX = "mdc1_";
export const PUBLIC_CATALOG_CURSOR_QUERY = "public_minds";
export const PUBLIC_CATALOG_MAX_CURSOR_BYTES = 256;
export const PUBLIC_CATALOG_SNAPSHOT_RETENTION = 32;
export const PUBLIC_CATALOG_BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export interface PublicCatalogCursorPayload {
  readonly v: 1;
  readonly q: typeof PUBLIC_CATALOG_CURSOR_QUERY;
  readonly g: number;
  readonly o: number;
}

export function encodePublicCatalogCursor(generation: number, offset: number): string {
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

export function decodePublicCatalogCursor(
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

export function clonePublicCatalogSnapshots(
  source: ReadonlyMap<number, readonly SpaceId[]>,
): Map<number, readonly SpaceId[]> {
  return new Map(
    [...source].map(([generation, spaceIds]) => [
      generation,
      Object.freeze([...spaceIds]),
    ]),
  );
}

export function derivePublicMindCatalogSpaceIds(
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

export function stagePublicCatalogSnapshot(
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

export interface OrdinaryMindDeletionState {
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
  readonly bundleFileDownloadGrants: ReadonlyMap<
    string,
    Readonly<BundleFileDownloadGrant>
  >;
  readonly indexStates: ReadonlyMap<string, Readonly<RevisionIndexState>>;
  readonly activeBySpace: ReadonlyMap<
    SpaceId,
    Readonly<HandleReservationSnapshot>
  >;
}

export function targetRecordSelection(
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
  const bundleFileDownloadGrantKeys = [...state.bundleFileDownloadGrants]
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
    bundleFileDownloadGrantKeys: Object.freeze(bundleFileDownloadGrantKeys),
    indexKeys: Object.freeze(indexKeys),
    contentIdempotencyKeys: Object.freeze(contentIdempotencyKeys),
    ordinaryIdempotencyKeys: Object.freeze(ordinaryIdempotencyKeys),
    membershipIds: Object.freeze(membershipIds),
    revisionIds: Object.freeze(revisionIds),
    invitationIds: Object.freeze(invitationIds),
  });
}

export function ordinaryMindDeletionFingerprint(
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
      bundle_file_download_grants: records.bundleFileDownloadGrantKeys.map((key) => {
        const grant = state.bundleFileDownloadGrants.get(key)!;
        return [
          grant.requestedByPrincipalId,
          grant.tokenId,
          grant.revisionId,
          grant.path,
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

export interface AccountDeletionState extends OrdinaryMindDeletionState {
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

export function accountDeletionSelection(
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

export function accountDeletionFingerprint(
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

export type AppliedMindBindingMutation = Readonly<
  Extract<ApplyMindBindingMutationResult, { readonly kind: "applied" }>
>;

export type MindBindingMutationRequest =
  | ApplyReadMindBindingRequest
  | ApplyWriteMindBindingRequest
  | ApplyAutomaticCapturePolicyRequest;

export interface StoredMindBindingMutation {
  readonly canonicalRequestHash: ApplyReadMindBindingRequest["canonicalRequestHash"];
  readonly spaceId: SpaceId | null;
  readonly result: AppliedMindBindingMutation;
}

export interface MutableMindBindingOwnerState {
  bindingSet: Readonly<MindBindingSet>;
  readBindingsById: Map<ReadMindBindingId, Readonly<ReadMindBinding>>;
  activeReadBindingBySpace: Map<SpaceId, ReadMindBindingId>;
  writeBindingsById: Map<WriteMindBindingId, Readonly<WriteMindBinding>>;
  activeWriteBindingId: WriteMindBindingId | null;
  idempotency: Map<string, StoredMindBindingMutation>;
}

export function cloneReadMindBinding(binding: Readonly<ReadMindBinding>): Readonly<ReadMindBinding> {
  return Object.freeze({ ...binding });
}

export function cloneWriteMindBinding(binding: Readonly<WriteMindBinding>): Readonly<WriteMindBinding> {
  return Object.freeze({ ...binding });
}

export function cloneMindBindingSnapshot(
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

export function cloneAppliedMindBindingMutation(
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

export function cloneMindBindingOwnerState(
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

export function cloneMindBindingOwners(
  owners: ReadonlyMap<MindBindingOwnerId, MutableMindBindingOwnerState>,
): Map<MindBindingOwnerId, MutableMindBindingOwnerState> {
  return new Map(
    [...owners].map(([ownerId, state]) => [
      ownerId,
      cloneMindBindingOwnerState(state),
    ]),
  );
}

export function emptyMindBindingOwnerState(
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

export function mindBindingSnapshot(
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

export function validMindBindingMutationBase(
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

export function mindBindingIdempotencyKey(
  operation: "read" | "write" | "capture",
  request: Readonly<MindBindingMutationRequest>,
): string {
  return `${operation}\u0000${request.idempotencyKey}`;
}

export function replayMindBindingMutation(
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

export function recordMindBindingMutation(
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

export function mindBindingEffectsAvailable(
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

export function stageMindBindingAudit(
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

export function stageMindBindingRevokeAudit(
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

export function purgeMindBindingsForSpace(
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

export function purgeMindBindingsForPrincipal(
  owners: Map<MindBindingOwnerId, MutableMindBindingOwnerState>,
  principalId: PrincipalId,
): void {
  for (const [ownerId, state] of owners) {
    if (state.bindingSet.principalId === principalId) owners.delete(ownerId);
  }
}

export const ZERO_CAPACITY_AMOUNTS: Readonly<CapacityAmounts> = Object.freeze({
  physicalCanonicalBytes: 0,
  temporaryBytes: 0,
  d1MetadataBytes: 0,
});

export function validCapacityAmounts(value: Readonly<CapacityAmounts>): boolean {
  return [
    value.physicalCanonicalBytes,
    value.temporaryBytes,
    value.d1MetadataBytes,
  ].every((amount) => Number.isSafeInteger(amount) && amount >= 0);
}

export function addCapacityAmounts(
  left: Readonly<CapacityAmounts>,
  right: Readonly<CapacityAmounts>,
): Readonly<CapacityAmounts> {
  return Object.freeze({
    physicalCanonicalBytes:
      left.physicalCanonicalBytes + right.physicalCanonicalBytes,
    temporaryBytes: left.temporaryBytes + right.temporaryBytes,
    d1MetadataBytes: left.d1MetadataBytes + right.d1MetadataBytes,
  });
}

export function cloneCapacityReservation(
  reservation: Readonly<CapacityReservation>,
): Readonly<CapacityReservation> {
  return Object.freeze({
    ...reservation,
    requested: Object.freeze({ ...reservation.requested }),
    actual: reservation.actual === null
      ? null
      : Object.freeze({ ...reservation.actual }),
  });
}

export function cloneCapacityReservations(
  source: ReadonlyMap<string, Readonly<CapacityReservation>>,
): Map<string, Readonly<CapacityReservation>> {
  return new Map(
    [...source].map(([id, reservation]) => [id, cloneCapacityReservation(reservation)]),
  );
}

export function capacityOwnerForSpace(
  spaceId: SpaceId,
  knowledgeSpaces: ReadonlyMap<SpaceId, Readonly<KnowledgeSpace>>,
  memberships: ReadonlyMap<SpaceMembership["membershipId"], Readonly<SpaceMembership>>,
  fallbackPrincipalId: PrincipalId,
): PrincipalId | null {
  const owners = [...memberships.values()].filter(
    (membership) =>
      membership.spaceId === spaceId &&
      membership.state === "active" &&
      membership.role === "owner",
  );
  if (owners.length === 1) return owners[0]!.principalId;
  // Legacy isolated stores used by conformance fixtures predate control-plane
  // aggregates. Production Spaces always have exactly one canonical Owner.
  return knowledgeSpaces.has(spaceId) ? null : fallbackPrincipalId;
}

export function ownedCapacitySpaceIds(
  principalId: PrincipalId,
  spaces: ReadonlyMap<SpaceId, SpaceState>,
  knowledgeSpaces: ReadonlyMap<SpaceId, Readonly<KnowledgeSpace>>,
  memberships: ReadonlyMap<SpaceMembership["membershipId"], Readonly<SpaceMembership>>,
): ReadonlySet<SpaceId> {
  const owned = new Set<SpaceId>();
  for (const membership of memberships.values()) {
    if (
      membership.principalId === principalId &&
      membership.state === "active" &&
      membership.role === "owner"
    ) owned.add(membership.spaceId);
  }
  if (owned.size === 0 && knowledgeSpaces.size === 0) {
    for (const spaceId of spaces.keys()) owned.add(spaceId);
  }
  return owned;
}

export function capacityUsageFromCanonicalState(input: Readonly<{
  spaceIds: ReadonlySet<SpaceId>;
  spaces: ReadonlyMap<SpaceId, SpaceState>;
  stagedBundleFiles: ReadonlyMap<StagedBundleFileId, Readonly<StagedBundleFileRecord>>;
  exportJobs: ReadonlyMap<JobId, Readonly<ExportJob>>;
  markdownImportPlans?: ReadonlyMap<string, Readonly<MarkdownImportPlan>>;
  markdownImportSessions?: ReadonlyMap<string, Readonly<MarkdownImportSession>>;
  markdownImportStagedFiles?: ReadonlyMap<StagedBundleFileId, Readonly<MarkdownImportStagedFile>>;
  reservations: ReadonlyMap<string, Readonly<CapacityReservation>>;
  reconciledAt: ReadonlyMap<SpaceId, UtcInstant>;
}>): Readonly<CapacityUsageSnapshot> {
  let logicalHeadBytes = 0;
  let logicalRetainedBytes = 0;
  let physicalCanonicalBytes = 0;
  let temporaryBytes = 0;
  let d1MetadataBytes = 0;
  let reservedBytes = 0;
  let latestReconciledAt: UtcInstant | null = null;
  const uniqueCanonical = new Set<string>();

  for (const spaceId of input.spaceIds) {
    const state = input.spaces.get(spaceId);
    if (!state) continue;
    d1MetadataBytes += 1_024;
    const head = state.head === null ? null : state.revisions.get(state.head) ?? null;
    if (head !== null) {
      logicalHeadBytes += head.manifest.entries.reduce(
        (total, entry) => total + entry.size,
        0,
      );
    }
    for (const envelope of state.revisions.values()) {
      d1MetadataBytes += 512 + envelope.manifest.entries.length * 160;
      logicalRetainedBytes += envelope.manifest.entries.reduce(
        (total, entry) => total + entry.size,
        0,
      );
      const manifestKey = `${spaceId}\u0000manifest\u0000${envelope.revision.manifestHash}`;
      if (!uniqueCanonical.has(manifestKey)) {
        uniqueCanonical.add(manifestKey);
        physicalCanonicalBytes += envelope.revision.manifestSize ?? 0;
      }
      for (const entry of envelope.manifest.entries) {
        const key = `${spaceId}\u0000${entry.kind}\u0000${entry.sha256}`;
        if (uniqueCanonical.has(key)) continue;
        uniqueCanonical.add(key);
        physicalCanonicalBytes += entry.size;
      }
    }
    const reconciled = input.reconciledAt.get(spaceId) ?? null;
    if (
      reconciled !== null &&
      (latestReconciledAt === null || Date.parse(reconciled) > Date.parse(latestReconciledAt))
    ) latestReconciledAt = reconciled;
  }

  for (const record of input.stagedBundleFiles.values()) {
    if (!input.spaceIds.has(record.spaceId)) continue;
    temporaryBytes += record.size;
    d1MetadataBytes += 512;
  }
  for (const job of input.exportJobs.values()) {
    if (!input.spaceIds.has(job.spaceId)) continue;
    d1MetadataBytes += 768;
    if (job.archive !== null && job.archiveCleanedAt === null) {
      temporaryBytes += job.archive.size;
    }
  }
  for (const plan of input.markdownImportPlans?.values() ?? []) {
    if (!input.spaceIds.has(plan.spaceId)) continue;
    d1MetadataBytes += 512 + plan.files.length * 160;
  }
  for (const session of input.markdownImportSessions?.values() ?? []) {
    if (!input.spaceIds.has(session.spaceId)) continue;
    d1MetadataBytes += 768 + session.failures.length * 128;
  }
  for (const file of input.markdownImportStagedFiles?.values() ?? []) {
    const session = input.markdownImportSessions?.get(file.importId);
    if (session !== undefined && input.spaceIds.has(session.spaceId)) {
      d1MetadataBytes += 384;
    }
  }
  for (const reservation of input.reservations.values()) {
    if (!input.spaceIds.has(reservation.spaceId)) continue;
    d1MetadataBytes += 512;
    if (reservation.state === "active") {
      reservedBytes += reservation.requested.physicalCanonicalBytes +
        reservation.requested.temporaryBytes +
        reservation.requested.d1MetadataBytes;
    }
    if (reservation.state === "cleanup_pending") {
      temporaryBytes += reservation.requested.temporaryBytes +
        reservation.requested.physicalCanonicalBytes;
    }
  }
  const storageAmplification = logicalHeadBytes === 0
    ? 1
    : physicalCanonicalBytes / logicalHeadBytes;
  return Object.freeze({
    logicalHeadBytes,
    logicalRetainedBytes,
    physicalCanonicalBytes,
    temporaryBytes,
    d1MetadataBytes,
    reservedBytes,
    storageAmplification,
    trustworthy: true,
    reconciledAt: latestReconciledAt,
  });
}

export function capacityReservationMatches(
  reservation: Readonly<CapacityReservation>,
  request: Readonly<CapacityAdmissionRequest>,
): boolean {
  return reservation.requestedByPrincipalId === request.requestedByPrincipalId &&
    reservation.spaceId === request.spaceId &&
    reservation.operation === request.operation &&
    reservation.operationRef === request.operationRef &&
    reservation.baseRevisionId === request.baseRevisionId &&
    reservation.idempotencyKey === request.idempotencyKey &&
    reservation.bulk === request.bulk &&
    reservation.heavy === request.heavy &&
    JSON.stringify(reservation.requested) === JSON.stringify(request.requested);
}

export function utilizationState(ratio: number): CapacityUtilizationState {
  if (ratio >= 1) return "hard_limit";
  if (ratio >= 0.85) return "soft_limit";
  if (ratio >= 0.7) return "warning";
  return "normal";
}

export function maxUtilizationState(ratios: readonly number[]) {
  return utilizationState(Math.max(0, ...ratios));
}

export function activeReservationAmounts(
  reservations: ReadonlyMap<string, Readonly<CapacityReservation>>,
  predicate: (reservation: Readonly<CapacityReservation>) => boolean,
): Readonly<CapacityAmounts> {
  let total = ZERO_CAPACITY_AMOUNTS;
  for (const reservation of reservations.values()) {
    if (reservation.state === "active" && predicate(reservation)) {
      total = addCapacityAmounts(total, reservation.requested);
    }
  }
  return total;
}

export function validCapacityAdmissionRequest(request: Readonly<CapacityAdmissionRequest>): boolean {
  return request.reservationId.length > 0 &&
    request.operationRef.length > 0 &&
    request.idempotencyKey.length > 0 &&
    validCapacityAmounts(request.requested) &&
    Number.isFinite(Date.parse(request.createdAt)) &&
    Number.isFinite(Date.parse(request.expiresAt)) &&
    Date.parse(request.expiresAt) > Date.parse(request.createdAt);
}

export interface ObjectReachabilityCounts {
  readonly immutable: ReadonlyMap<Digest, number>;
  readonly bundle: ReadonlyMap<string, number>;
  readonly spaceCanonical: ReadonlyMap<string, number>;
}

export function cloneObjectReachabilityCounts(value: unknown): Readonly<ObjectReachabilityCounts> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("object reachability counts are invalid");
  }
  const source = value as Record<string, unknown>;
  if (
    !(source.immutable instanceof Map) || !(source.bundle instanceof Map) ||
    !(source.spaceCanonical instanceof Map)
  ) throw new TypeError("object reachability counts are invalid");
  const clone = (input: Map<unknown, unknown>) => {
    const output = new Map<string, number>();
    for (const [key, count] of input) {
      if (
        typeof key !== "string" || !Number.isSafeInteger(count) ||
        (count as number) < 1
      ) throw new TypeError("object reachability counts are invalid");
      output.set(key, count as number);
    }
    return output;
  };
  const immutable = new Map<Digest, number>();
  for (const [key, count] of clone(source.immutable)) {
    if (!/^sha256:[0-9a-f]{64}$/.test(key)) {
      throw new TypeError("object reachability counts are invalid");
    }
    immutable.set(key as unknown as Digest, count);
  }
  return Object.freeze({
    immutable,
    bundle: clone(source.bundle),
    spaceCanonical: clone(source.spaceCanonical),
  });
}

export function cloneObjectCleanupCheckpoint(value: unknown): Readonly<ObjectCleanupCheckpoint> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("object cleanup checkpoint is invalid");
  }
  const source = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(source.version) || (source.version as number) < 0 ||
    typeof source.namespace !== "string" ||
    !(OBJECT_CLEANUP_NAMESPACES as readonly string[]).includes(source.namespace) ||
    (source.cursor !== null && typeof source.cursor !== "string") ||
    typeof source.cycleStartedAt !== "string" || !Number.isFinite(Date.parse(source.cycleStartedAt)) ||
    typeof source.updatedAt !== "string" || !Number.isFinite(Date.parse(source.updatedAt)) ||
    (source.leaseExpiresAt !== null &&
      (typeof source.leaseExpiresAt !== "string" || !Number.isFinite(Date.parse(source.leaseExpiresAt)))) ||
    !Number.isSafeInteger(source.retries) || (source.retries as number) < 0 ||
    !Number.isSafeInteger(source.failures) || (source.failures as number) < 0
  ) throw new TypeError("object cleanup checkpoint is invalid");
  return Object.freeze({
    version: source.version as ObjectCleanupCheckpoint["version"],
    namespace: source.namespace as ObjectCleanupNamespace,
    cursor: source.cursor as string | null,
    cycleStartedAt: source.cycleStartedAt as UtcInstant,
    updatedAt: source.updatedAt as UtcInstant,
    leaseExpiresAt: source.leaseExpiresAt as UtcInstant | null,
    retries: source.retries as number,
    failures: source.failures as number,
  });
}
