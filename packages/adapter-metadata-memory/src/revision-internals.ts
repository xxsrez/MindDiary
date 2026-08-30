import {
  serializeRevisionManifest,
  version,
  type AccountBootstrapRecordSet,
  type AuditEvent,
  type AuditOutboxMessage,
  type AuthorizationStateQuery,
  type BackgroundJob,
  type BundleFileDownloadGrant,
  type CanonicalRevisionEnvelope,
  type CheckIdempotencyRequest,
  type CheckIdempotencyResult,
  type CompleteIdempotencyRequest,
  type CompleteIdempotencyResult,
  type ConsumeBundleFileDownloadGrantResult,
  type ConsumeStagedBundleFilesRequest,
  type ConsumeStagedBundleFilesResult,
  type CreateStagedBundleFileResult,
  type CurrentAuthorizationState,
  type CurrentAuthorizationToken,
  type ExportArchiveRecord,
  type ExportDownloadGrant,
  type ExportJob,
  FILE_INGRESS_SOURCE_KINDS,
  type FileIngressSourceKind,
  type IdempotencyNamespace,
  type IdempotencyRecord,
  type JobId,
  type MarkdownImportPlan,
  type MarkdownImportSession,
  type MarkdownImportSessionFailure,
  type MarkdownImportStagedFile,
  type OrdinaryMindRecordSet,
  type PrincipalActivitySummary,
  type PrincipalId,
  type RevisionIndexState,
  type ServiceOperatorDirectoryQuery,
  type ServiceOperatorPrincipalProjection,
  type StageContentCommitEffectsRequest,
  type StageContentCommitEffectsResult,
  type StagedBundleFileId,
  type StagedBundleFileRecord,
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
      record.principalId !== request.principalId ||
      record.principalMindUsageGenerationId !==
        request.principalMindUsageGenerationId ||
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
export const STAGED_COMMIT_AUDIT_METADATA_KEYS = [
  ...COMMIT_AUDIT_METADATA_KEYS,
  "staged_source_receipts",
] as const;
export const SOURCE_REFERENCE_COMMIT_AUDIT_METADATA_KEYS = [
  ...COMMIT_AUDIT_METADATA_KEYS,
  "source_reference_count",
  "source_reference_digest",
] as const;
export const SOURCE_REFERENCE_STAGED_COMMIT_AUDIT_METADATA_KEYS = [
  ...SOURCE_REFERENCE_COMMIT_AUDIT_METADATA_KEYS,
  "staged_source_receipts",
] as const;
export const CAPTURE_STAGED_COMMIT_AUDIT_METADATA_KEYS = [
  ...CAPTURE_COMMIT_AUDIT_METADATA_KEYS,
  "staged_source_receipts",
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

type StagedSourceAuditReceipt = Readonly<{
  source_kind: FileIngressSourceKind;
  sha256: string;
}>;

export function validStagedSourceAuditReceipts(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 4_096) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 20) return false;
  const receipts: StagedSourceAuditReceipt[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const record = item as Readonly<Record<string, unknown>>;
    if (
      Object.keys(record).sort().join(",") !== "sha256,source_kind" ||
      typeof record.source_kind !== "string" ||
      !(FILE_INGRESS_SOURCE_KINDS as readonly string[]).includes(record.source_kind) ||
      typeof record.sha256 !== "string" ||
      !SHA256_PATTERN.test(record.sha256)
    ) return false;
    receipts.push({
      source_kind: record.source_kind as FileIngressSourceKind,
      sha256: record.sha256,
    });
  }
  const ordered = [...receipts].sort((left, right) =>
    left.source_kind < right.source_kind
      ? -1
      : left.source_kind > right.source_kind
        ? 1
        : left.sha256 < right.sha256
          ? -1
          : left.sha256 > right.sha256
            ? 1
            : 0
  );
  return JSON.stringify(receipts) === value &&
    JSON.stringify(ordered) === value;
}

export function validCommitAuditMetadata(
  metadata: Readonly<Record<string, unknown>>,
  envelope: Envelope,
): boolean {
  const keys = Object.keys(metadata).sort();
  const captureOnly = keys.length === CAPTURE_COMMIT_AUDIT_METADATA_KEYS.length &&
    keys.every((key, index) => key === CAPTURE_COMMIT_AUDIT_METADATA_KEYS[index]);
  const ordinaryOnly = keys.length === COMMIT_AUDIT_METADATA_KEYS.length &&
    keys.every((key, index) => key === COMMIT_AUDIT_METADATA_KEYS[index]);
  const stagedOnly = keys.length === STAGED_COMMIT_AUDIT_METADATA_KEYS.length &&
    keys.every((key, index) => key === STAGED_COMMIT_AUDIT_METADATA_KEYS[index]);
  const sourceReferenceOnly =
    keys.length === SOURCE_REFERENCE_COMMIT_AUDIT_METADATA_KEYS.length &&
    keys.every(
      (key, index) => key === SOURCE_REFERENCE_COMMIT_AUDIT_METADATA_KEYS[index],
    );
  const sourceReferenceStaged =
    keys.length === SOURCE_REFERENCE_STAGED_COMMIT_AUDIT_METADATA_KEYS.length &&
    keys.every(
      (key, index) =>
        key === SOURCE_REFERENCE_STAGED_COMMIT_AUDIT_METADATA_KEYS[index],
    );
  const captureStaged =
    keys.length === CAPTURE_STAGED_COMMIT_AUDIT_METADATA_KEYS.length &&
    keys.every(
      (key, index) => key === CAPTURE_STAGED_COMMIT_AUDIT_METADATA_KEYS[index],
    );
  const capture = captureOnly || captureStaged;
  const staged = stagedOnly || captureStaged || sourceReferenceStaged;
  const sourceReferenced = sourceReferenceOnly || sourceReferenceStaged;
  if (!ordinaryOnly && !capture && !stagedOnly && !sourceReferenced) {
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
    (!staged || validStagedSourceAuditReceipts(
      metadata.staged_source_receipts,
    )) &&
    (!sourceReferenced || (
      typeof metadata.source_reference_count === "number" &&
      Number.isSafeInteger(metadata.source_reference_count) &&
      metadata.source_reference_count >= 1 &&
      metadata.source_reference_count <= 8 &&
      typeof metadata.source_reference_digest === "string" &&
      SHA256_PATTERN.test(metadata.source_reference_digest)
    )) &&
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
