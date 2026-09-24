import {
  type AuditEvent,
  type AuditOutboxMessage,
  type BackgroundJob,
  type BundleFileDownloadGrant,
  type CanonicalRevisionEnvelope,
  type ExportArchiveRecord,
  type ExportDownloadGrant,
  type ExportDownloadSecretVerifier,
  type ExportJob,
  type MindBindingOwnerId,
  type IdempotencyKey,
  type IdempotencyOperation,
  type IdempotencyRecord,
  type IdempotencyResult,
  type PrincipalId,
  type JobId,
  type OutboxMessageId,
  type RevisionId,
  type RevisionIndexState,
  type Sha256Digest,
  type SpaceId,
  type StagedBundleFileId,
  type UtcInstant,
  type Version,
} from "@mind-diary/domain";

import {
  type MetadataStore,
} from "./runtime.js";
import type { NoteQueueTransaction } from "./note-queue.js";

import {
  type CanonicalObjectReachabilityReader,
} from "./control.js";

import {
  type StagedBundleFileRecord,
  type ConsumeStagedBundleFilesRequest,
  type ConsumeStagedBundleFilesResult,
  type BundleFileStagingStore,
} from "./objects.js";

import {
  type AuthorizationStateReader,
  type AuthorizationTransaction,
} from "./authorization.js";
import {
  type PrincipalMindUsageReader,
} from "./principal-mind-usage.js";

export const PRODUCER_VALIDATION_CERTIFICATE_SCHEMA =
  "mind-diary/producer-validation-certificate/v1" as const;

export interface ProducerValidationDependency {
  readonly path: string;
  readonly fragment?: string;
  readonly sourceKind: "link" | "source";
}

export interface ProducerValidationReverseDependency
  extends ProducerValidationDependency {
  /** Path of the Markdown file that points at this summary's path. */
  readonly sourcePath: string;
}

export interface ProducerValidationFileSummary {
  readonly path: string;
  readonly kind: "markdown" | "opaque";
  readonly mediaType: string;
  readonly sha256: Sha256Digest;
  readonly size: number;
  readonly anchors: readonly string[];
  readonly outgoingLinks: readonly Readonly<ProducerValidationDependency>[];
  readonly reverseDependencies: readonly Readonly<ProducerValidationReverseDependency>[];
  readonly rootReachable: boolean;
}

/**
 * Immutable producer proof attached to one committed revision's metadata.
 * It is an integrity fact only; authorization and HEAD CAS are always
 * rechecked by the caller that considers reusing it.
 */
export interface ProducerValidationCertificate {
  readonly schema: typeof PRODUCER_VALIDATION_CERTIFICATE_SCHEMA;
  readonly spaceId: SpaceId;
  readonly revisionId: RevisionId;
  readonly manifestFingerprint: Sha256Digest;
  readonly rulesVersion: string;
  readonly profileVersion: string;
  readonly dependencyFingerprint: Sha256Digest;
  readonly files: readonly Readonly<ProducerValidationFileSummary>[];
}

/**
 * Proof of a validated, uncommitted result. It belongs to the exact candidate,
 * not to the unchanged parent revision. Only one pending proof per Space needs
 * retention; a different candidate safely falls back to validation.
 */
export interface PreflightProducerProof {
  readonly spaceId: SpaceId;
  readonly baseRevisionId: RevisionId;
  readonly baseManifestHash: Sha256Digest;
  readonly candidateFingerprint: Sha256Digest;
  readonly certificate: Readonly<Omit<ProducerValidationCertificate, "revisionId">>;
}

export interface PreflightProducerProofStore {
  readPreflightProducerProof(spaceId: SpaceId): Promise<Readonly<PreflightProducerProof> | null>;
  storePreflightProducerProof(proof: Readonly<PreflightProducerProof>): Promise<boolean>;
}

export type RevisionWithProducerValidationCertificate =
  CanonicalRevisionEnvelope["revision"] & {
    readonly producerCertificate?: Readonly<ProducerValidationCertificate>;
  };

export type CanonicalRevisionEnvelopeWithProducerValidationCertificate = Omit<
  CanonicalRevisionEnvelope,
  "revision"
> & {
  readonly revision: Readonly<RevisionWithProducerValidationCertificate>;
};

/** Reads the optional durable proof without treating its presence as valid. */
export function readProducerValidationCertificate(
  revision: Readonly<CanonicalRevisionEnvelope["revision"]>,
): Readonly<ProducerValidationCertificate> | null {
  const candidate = (revision as Readonly<RevisionWithProducerValidationCertificate>)
    .producerCertificate;
  return candidate === undefined ? null : candidate;
}

export type RevisionCommitResult =
  | {
      readonly kind: "committed";
      readonly envelope: Readonly<CanonicalRevisionEnvelope>;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "stale_head";
      readonly currentHeadRevisionId: RevisionId | null;
    }
  | { readonly kind: "revision_id_collision" }
  | {
      readonly kind: "invalid_revision_chain";
      readonly reason:
        | "missing_parent"
        | "parent_mismatch"
        | "revision_number_mismatch"
        | "manifest_hash_mismatch";
    };

export interface RevisionCommitRequest {
  readonly expectedHeadRevisionId: RevisionId | null;
  readonly envelope: Readonly<CanonicalRevisionEnvelope>;
}

export interface IdempotencyNamespace {
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly operation: IdempotencyOperation;
  readonly key: IdempotencyKey;
  /** Required by binding-owner-scoped operations such as native file staging. */
  readonly bindingOwnerId?: MindBindingOwnerId;
}

export interface CheckIdempotencyRequest {
  readonly namespace: Readonly<IdempotencyNamespace>;
  readonly canonicalRequestHash: Sha256Digest;
}

type CompletedIdempotencyRecord = Extract<
  IdempotencyRecord,
  { readonly state: "completed" }
>;

export type CheckIdempotencyResult =
  | { readonly kind: "missing" }
  | {
      readonly kind: "replay";
      readonly record: Readonly<CompletedIdempotencyRecord>;
    }
  | { readonly kind: "conflict" };

export type CompleteIdempotencyRequest = {
  [Operation in IdempotencyOperation]: {
    readonly namespace: Readonly<
      IdempotencyNamespace & { readonly operation: Operation }
    >;
    readonly canonicalRequestHash: Sha256Digest;
    readonly result: Readonly<Extract<IdempotencyResult, { kind: Operation }>>;
    readonly completedAt: UtcInstant;
  };
}[IdempotencyOperation];

export type CompleteIdempotencyResult =
  | {
      readonly kind: "completed";
      readonly record: Readonly<CompletedIdempotencyRecord>;
    }
  | { readonly kind: "already_exists" }
  | { readonly kind: "operation_result_mismatch" };

/** Common transaction slice shared by every namespaced idempotent operation. */
export interface IdempotencyTransaction {
  /**
   * Resolves the actor/Space/operation/key namespace inside this transaction.
   * Implementations must serialize this check with canonical effect staging
   * and completion so concurrent retries expose one canonical effect.
   */
  checkIdempotency(
    request: CheckIdempotencyRequest,
  ): Promise<CheckIdempotencyResult>;
  /** Completes only a namespace observed as missing in this same transaction. */
  completeIdempotency(
    request: CompleteIdempotencyRequest,
  ): Promise<CompleteIdempotencyResult>;
}

export type CreateExportJobResult =
  | { readonly kind: "created"; readonly job: Readonly<ExportJob> }
  | { readonly kind: "job_id_collision" | "invalid_job" };

export interface ExportStartTransaction
  extends AuthorizationTransaction,
    IdempotencyTransaction,
    CapacityReservationTransaction {
  readHead(spaceId: SpaceId): Promise<RevisionId | null>;
  readRevision(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<Readonly<CanonicalRevisionEnvelope> | null>;
  listRevisions(
    spaceId: SpaceId,
  ): Promise<readonly Readonly<CanonicalRevisionEnvelope>[]>;
  /** Optional compact UTC selector; callers load only the selected manifest. */
  resolveRevisionAsOf?(
    spaceId: SpaceId,
    asOf: UtcInstant,
  ): Promise<Readonly<RevisionCatalogEntry> | null>;
  findActiveOrRecoverableExportJob(request: Readonly<{
    requestedByPrincipalId: PrincipalId;
    spaceId: SpaceId;
    revisionId: RevisionId;
    profile: "MD-OKF-ZIP-1" | "MD-BUNDLE-ZIP-1";
    now: UtcInstant;
  }>): Promise<Readonly<ExportJob> | null>;
  readExportJob(jobId: JobId): Promise<Readonly<ExportJob> | null>;
  createExportJob(job: Readonly<ExportJob>): Promise<CreateExportJobResult>;
}

export type ClaimExportJobResult =
  | { readonly kind: "claimed"; readonly job: Readonly<ExportJob> }
  | { readonly kind: "not_found" | "not_available" | "completed" | "expired" };

export type ExpireExportJobResult =
  | {
      readonly kind: "expired";
      readonly job: Readonly<ExportJob>;
      readonly replayed: boolean;
    }
  | { readonly kind: "not_found" | "not_due" };

/** Durable export jobs and their lease/version-fenced state transitions. */
export interface ExportJobStore extends MetadataStore, AuthorizationStateReader {
  runExportStartTransaction<Result>(
    operation: (transaction: ExportStartTransaction) => Promise<Result>,
  ): Promise<Result>;
  readExportJob(jobId: JobId): Promise<Readonly<ExportJob> | null>;
  listRecoverableExportJobs(
    now: UtcInstant,
    limit: number,
  ): Promise<readonly Readonly<ExportJob>[]>;
  listExpiredExportJobs(
    now: UtcInstant,
    limit: number,
  ): Promise<readonly Readonly<ExportJob>[]>;
  claimExportJob(
    jobId: JobId,
    now: UtcInstant,
    claimExpiresAt: UtcInstant,
  ): Promise<ClaimExportJobResult>;
  completeExportJob(
    jobId: JobId,
    expectedClaimVersion: Version,
    archive: Readonly<ExportArchiveRecord>,
    completedAt: UtcInstant,
  ): Promise<boolean>;
  failExportJob(
    jobId: JobId,
    expectedClaimVersion: Version,
    failureCode: string,
    failedAt: UtcInstant,
    retryAt: UtcInstant,
  ): Promise<boolean>;
  expireExportJob(jobId: JobId, now: UtcInstant): Promise<ExpireExportJobResult>;
  completeExpiredExportCleanup(
    jobId: JobId,
    expectedVersion: Version,
    cleanedAt: UtcInstant,
  ): Promise<boolean>;
}

export type CreateExportDownloadGrantResult =
  | {
      readonly kind: "created";
      readonly grant: Readonly<ExportDownloadGrant>;
    }
  | { readonly kind: "secret_collision" | "invalid_grant" };

export interface ExportDownloadGrantTransaction extends AuthorizationTransaction {
  readExportJob(jobId: JobId): Promise<Readonly<ExportJob> | null>;
  createExportDownloadGrant(
    grant: Readonly<ExportDownloadGrant>,
  ): Promise<CreateExportDownloadGrantResult>;
}

export type ReadExportDownloadGrantResult =
  | { readonly kind: "active"; readonly grant: Readonly<ExportDownloadGrant> }
  | { readonly kind: "not_found" | "expired" | "revoked" };

/** Temporary download capabilities remain separate from durable export jobs. */
export interface ExportDownloadGrantStore extends ExportJobStore {
  runExportDownloadGrantTransaction<Result>(
    operation: (transaction: ExportDownloadGrantTransaction) => Promise<Result>,
  ): Promise<Result>;
  readExportDownloadGrant(
    secretVerifier: ExportDownloadSecretVerifier,
    now: UtcInstant,
  ): Promise<ReadExportDownloadGrantResult>;
  revokeExportDownloadGrant(
    secretVerifier: ExportDownloadSecretVerifier,
    revokedAt: UtcInstant,
  ): Promise<boolean>;
}

export type CreateBundleFileDownloadGrantResult =
  | { readonly kind: "created"; readonly grant: Readonly<BundleFileDownloadGrant> }
  | { readonly kind: "secret_collision" | "invalid_grant" };

export type ConsumeBundleFileDownloadGrantResult =
  | { readonly kind: "consumed"; readonly grant: Readonly<BundleFileDownloadGrant> }
  | { readonly kind: "not_found" | "expired" | "consumed" };

export interface BundleFileDownloadGrantTransaction extends AuthorizationTransaction {
  readRevision(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<Readonly<CanonicalRevisionEnvelope> | null>;
  readBundleFileDownloadGrant(
    secretVerifier: ExportDownloadSecretVerifier,
    now: UtcInstant,
  ): Promise<ConsumeBundleFileDownloadGrantResult | { readonly kind: "active"; readonly grant: Readonly<BundleFileDownloadGrant> }>;
  createBundleFileDownloadGrant(
    grant: Readonly<BundleFileDownloadGrant>,
  ): Promise<CreateBundleFileDownloadGrantResult>;
  consumeBundleFileDownloadGrant(
    secretVerifier: ExportDownloadSecretVerifier,
    consumedAt: UtcInstant,
  ): Promise<ConsumeBundleFileDownloadGrantResult>;
}

export interface BundleFileDownloadGrantStore
  extends MetadataStore,
    AuthorizationStateReader {
  runBundleFileDownloadGrantTransaction<Result>(
    operation: (transaction: BundleFileDownloadGrantTransaction) => Promise<Result>,
  ): Promise<Result>;
  readRevision(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<Readonly<CanonicalRevisionEnvelope> | null>;
  readBundleFileDownloadGrant(
    secretVerifier: ExportDownloadSecretVerifier,
    now: UtcInstant,
  ): Promise<ConsumeBundleFileDownloadGrantResult | { readonly kind: "active"; readonly grant: Readonly<BundleFileDownloadGrant> }>;
}

/** Transactional revision metadata and HEAD; object bytes remain in ObjectStore. */
export interface RevisionMetadataStore
  extends MetadataStore,
    CanonicalObjectReachabilityReader {
  readHead(spaceId: SpaceId): Promise<RevisionId | null>;
  readRevision(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<Readonly<CanonicalRevisionEnvelope> | null>;
  listRevisions(
    spaceId: SpaceId,
  ): Promise<readonly Readonly<CanonicalRevisionEnvelope>[]>;
  /** Optional compact history projection; it never returns manifest entries. */
  listRevisionCatalog?(spaceId: SpaceId, query: Readonly<{
    readonly beforeRevisionId: RevisionId | null;
    readonly limit: number;
  }>): Promise<Readonly<{
    readonly entries: readonly Readonly<RevisionCatalogEntry>[];
    readonly hasMore: boolean;
    readonly boundaryFound: boolean;
  }>>;
  /** Optional compact UTC selector over immutable revision metadata. */
  resolveRevisionAsOf?(
    spaceId: SpaceId,
    asOf: UtcInstant,
  ): Promise<Readonly<RevisionCatalogEntry> | null>;
  commitRevision(request: RevisionCommitRequest): Promise<RevisionCommitResult>;
}

/** Fail-closed signal for a compact revision projection that disagrees with canonical metadata. */
export class RevisionProjectionIntegrityFailure extends Error {
  constructor(message = "Revision projection failed integrity verification.") {
    super(message);
    this.name = "RevisionProjectionIntegrityFailure";
  }
}

export interface RevisionCatalogEntry {
  readonly revision: Readonly<CanonicalRevisionEnvelope["revision"]>;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export type MarkdownImportSessionState =
  | "active"
  | "validating"
  | "validated"
  | "validation_failed"
  | "finalizing"
  | "committed"
  | "canceled"
  | "expired";

export interface MarkdownImportPlanFile {
  readonly path: string;
  readonly sha256: Sha256Digest;
  readonly size: number;
}

export interface MarkdownImportPlan {
  readonly planId: string;
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly expectedRevisionId: RevisionId;
  readonly idempotencyKey: IdempotencyKey;
  readonly canonicalRequestHash: Sha256Digest;
  readonly descriptorHash: Sha256Digest;
  readonly files: readonly Readonly<MarkdownImportPlanFile>[];
  readonly logicalBytes: number;
  readonly additions: number;
  readonly replacements: number;
  readonly deletions: number;
  readonly unchanged: number;
  readonly projectedUtilization: CapacityUtilizationState;
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

export interface MarkdownImportStagedFile {
  readonly stagedFileId: StagedBundleFileId;
  readonly importId: string;
  readonly checkpoint: number;
  readonly path: string;
  readonly sha256: Sha256Digest;
  readonly size: number;
  readonly createdAt: UtcInstant;
}

export interface MarkdownImportSessionFailure {
  readonly path: string;
  readonly code: string;
}

export interface MarkdownImportSession {
  readonly importId: string;
  readonly planId: string;
  readonly principalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly expectedRevisionId: RevisionId;
  readonly idempotencyKey: IdempotencyKey;
  readonly canonicalRequestHash: Sha256Digest;
  readonly reservationId: string;
  readonly state: MarkdownImportSessionState;
  readonly version: Version;
  readonly checkpoint: number;
  readonly stagedFileCount: number;
  readonly stagedBytes: number;
  readonly validationCheckpoint: number;
  readonly validatedBytes: number;
  readonly promotionCheckpoint: number;
  readonly promotedBytes: number;
  readonly failures: readonly Readonly<MarkdownImportSessionFailure>[];
  readonly revisionId: RevisionId | null;
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly cleanupCompletedAt: UtcInstant | null;
}

export type CreateMarkdownImportPlanResult =
  | { readonly kind: "created"; readonly plan: Readonly<MarkdownImportPlan>; readonly replayed: boolean }
  | { readonly kind: "idempotency_conflict" | "id_collision" | "capacity_rejected" };

export type CreateMarkdownImportSessionResult =
  | { readonly kind: "created"; readonly session: Readonly<MarkdownImportSession>; readonly replayed: boolean }
  | {
      readonly kind:
        | "plan_not_found"
        | "plan_expired"
        | "head_conflict"
        | "idempotency_conflict"
        | "id_collision";
    };

export type StageMarkdownImportBatchResult =
  | { readonly kind: "staged"; readonly session: Readonly<MarkdownImportSession>; readonly replayed: boolean }
  | {
      readonly kind:
        | "not_found"
        | "state_conflict"
        | "checkpoint_conflict"
        | "idempotency_conflict"
        | "file_conflict";
    };

export type TransitionMarkdownImportSessionResult =
  | { readonly kind: "updated"; readonly session: Readonly<MarkdownImportSession> }
  | { readonly kind: "not_found" | "state_conflict" | "version_conflict" };

export interface MarkdownImportMetadataTransaction
  extends ContentCommitMetadataTransaction {
  readMarkdownImportPlan(planId: string): Promise<Readonly<MarkdownImportPlan> | null>;
  createMarkdownImportPlan(
    plan: Readonly<MarkdownImportPlan>,
    siteD1MetadataLimit: number,
  ): Promise<CreateMarkdownImportPlanResult>;
  readMarkdownImportSession(importId: string): Promise<Readonly<MarkdownImportSession> | null>;
  readMarkdownImportSessionForPlan(
    planId: string,
  ): Promise<Readonly<MarkdownImportSession> | null>;
  createMarkdownImportSession(
    session: Readonly<MarkdownImportSession>,
  ): Promise<CreateMarkdownImportSessionResult>;
  listMarkdownImportStagedFiles(
    importId: string,
  ): Promise<readonly Readonly<MarkdownImportStagedFile>[]>;
  stageMarkdownImportBatch(request: Readonly<{
    importId: string;
    expectedVersion: Version;
    checkpoint: number;
    canonicalRequestHash: Sha256Digest;
    files: readonly Readonly<MarkdownImportStagedFile>[];
    failures: readonly Readonly<MarkdownImportSessionFailure>[];
    stagedAt: UtcInstant;
  }>): Promise<StageMarkdownImportBatchResult>;
  transitionMarkdownImportSession(request: Readonly<{
    importId: string;
    expectedVersion: Version;
    from: readonly MarkdownImportSessionState[];
    to: MarkdownImportSessionState;
    updatedAt: UtcInstant;
    failures?: readonly Readonly<MarkdownImportSessionFailure>[];
    validationCheckpoint?: number;
    validatedBytes?: number;
    promotionCheckpoint?: number;
    promotedBytes?: number;
    revisionId?: RevisionId | null;
  }>): Promise<TransitionMarkdownImportSessionResult>;
  claimMarkdownImportCleanup(request: Readonly<{
    now: UtcInstant;
    limit: number;
  }>): Promise<readonly Readonly<{
    session: Readonly<MarkdownImportSession>;
    files: readonly Readonly<MarkdownImportStagedFile>[];
  }>[]>;
  deleteMarkdownImportStagedFile(stagedFileId: StagedBundleFileId): Promise<boolean>;
  completeMarkdownImportCleanup(request: Readonly<{
    importId: string;
    expectedVersion: Version;
    completedAt: UtcInstant;
  }>): Promise<boolean>;
  deleteExpiredMarkdownImportPlans(request: Readonly<{
    now: UtcInstant;
    limit: number;
  }>): Promise<number>;
}

export interface MarkdownImportMetadataStore extends ContentCommitMetadataStore {
  runMarkdownImportTransaction<Result>(
    operation: (transaction: MarkdownImportMetadataTransaction) => Promise<Result>,
  ): Promise<Result>;
  readMarkdownImportPlan(planId: string): Promise<Readonly<MarkdownImportPlan> | null>;
  readMarkdownImportSession(importId: string): Promise<Readonly<MarkdownImportSession> | null>;
  listMarkdownImportStagedFiles(
    importId: string,
  ): Promise<readonly Readonly<MarkdownImportStagedFile>[]>;
}

export type CapacityOperation = "commit" | "stage" | "export" | "import";
export type CapacityUtilizationState = "normal" | "warning" | "soft_limit" | "hard_limit";
export type CapacityReservationState =
  | "active"
  | "consumed"
  | "cleanup_pending"
  | "released";

export interface CapacityAmounts {
  readonly physicalCanonicalBytes: number;
  readonly temporaryBytes: number;
  readonly d1MetadataBytes: number;
}

export interface CapacityUsageSnapshot extends CapacityAmounts {
  readonly logicalHeadBytes: number;
  readonly logicalRetainedBytes: number;
  readonly reservedBytes: number;
  readonly storageAmplification: number;
  readonly trustworthy: boolean;
  readonly reconciledAt: UtcInstant | null;
}

export interface CapacityReservation {
  readonly reservationId: string;
  readonly requestedByPrincipalId: PrincipalId;
  readonly ownerPrincipalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly operation: CapacityOperation;
  readonly operationRef: string;
  readonly baseRevisionId: RevisionId | null;
  readonly idempotencyKey: IdempotencyKey;
  readonly requested: Readonly<CapacityAmounts>;
  readonly actual: Readonly<CapacityAmounts> | null;
  readonly bulk: boolean;
  readonly heavy: boolean;
  readonly state: CapacityReservationState;
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

export interface CapacityLimits {
  readonly mindPhysicalCanonicalBytes: number;
  readonly principalPhysicalCanonicalBytes: number;
  readonly sitePhysicalCanonicalBytes: number;
  readonly siteTemporaryBytes: number;
  readonly siteD1MetadataBytes: number;
  readonly ordinaryCommitSoftGrowthBytes: number;
  readonly activeHeavyPerMind: number;
  readonly activeHeavyPerPrincipal: number;
  readonly activeHeavyPerSite: number;
}

export interface CapacityAdmissionRequest {
  readonly reservationId: string;
  readonly requestedByPrincipalId: PrincipalId;
  readonly spaceId: SpaceId;
  readonly operation: CapacityOperation;
  readonly operationRef: string;
  readonly baseRevisionId: RevisionId | null;
  readonly idempotencyKey: IdempotencyKey;
  readonly requested: Readonly<CapacityAmounts>;
  readonly bulk: boolean;
  readonly heavy: boolean;
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

export type CapacityAdmissionResult =
  | {
      readonly kind: "admitted";
      readonly reservation: Readonly<CapacityReservation>;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "rejected";
      readonly reason:
        | "invalid_request"
        | "owner_not_found"
        | "accounting_untrusted"
        | "soft_limit"
        | "hard_limit"
        | "fairness_limit"
        | "idempotency_conflict";
      readonly utilization: CapacityUtilizationState;
    };

export interface CapacityReservationTransaction {
  readCapacityReservation(
    reservationId: string,
  ): Promise<Readonly<CapacityReservation> | null>;
  admitCapacityReservation(
    request: Readonly<CapacityAdmissionRequest>,
    limits: Readonly<CapacityLimits>,
  ): Promise<CapacityAdmissionResult>;
  consumeCapacityReservation(request: Readonly<{
    reservationId: string;
    actual: Readonly<CapacityAmounts>;
    consumedAt: UtcInstant;
  }>): Promise<"consumed" | "already_consumed" | "not_found" | "state_conflict">;
  cancelCapacityReservation(request: Readonly<{
    reservationId: string;
    canceledAt: UtcInstant;
  }>): Promise<"cleanup_pending" | "already_final" | "not_found">;
}

export interface CapacityReconcileResult {
  readonly spaceId: SpaceId | null;
  readonly scannedSpaces: number;
  readonly driftDetected: boolean;
  readonly usage: Readonly<CapacityUsageSnapshot>;
}

export interface CapacityTelemetrySnapshot {
  readonly canonicalHeadroomBytes: number;
  readonly temporaryHeadroomBytes: number;
  readonly d1HeadroomBytes: number;
  readonly storageAmplification: number;
  readonly quotaRejects: number;
  readonly staleReservations: number;
  readonly utilization: CapacityUtilizationState;
}

/**
 * Privacy-safe capacity authority. Implementations derive committed usage from
 * immutable revision metadata and temporary job/staging records; ledger events
 * and reservations are acceleration/protection state, never the sole source.
 */
export interface CapacityLedgerStore extends MetadataStore {
  runCapacityTransaction<Result>(
    operation: (transaction: CapacityReservationTransaction) => Promise<Result>,
  ): Promise<Result>;
  readMindCapacityUsage(spaceId: SpaceId): Promise<Readonly<CapacityUsageSnapshot> | null>;
  readPrincipalCapacityUsage(
    principalId: PrincipalId,
  ): Promise<Readonly<CapacityUsageSnapshot>>;
  readSiteCapacityUsage(): Promise<Readonly<CapacityUsageSnapshot>>;
  readCapacityTelemetry(
    limits: Readonly<CapacityLimits>,
    now: UtcInstant,
  ): Promise<Readonly<CapacityTelemetrySnapshot>>;
  reconcileCapacityUsage(request: Readonly<{
    spaceId?: SpaceId;
    reconciledAt: UtcInstant;
  }>): Promise<Readonly<CapacityReconcileResult>>;
  collectExpiredCapacityReservations(request: Readonly<{
    now: UtcInstant;
    limit: number;
  }>): Promise<readonly Readonly<CapacityReservation>[]>;
  releaseCapacityReservation(request: Readonly<{
    reservationId: string;
    releasedAt: UtcInstant;
  }>): Promise<boolean>;
}

/**
 * Race-sensitive content commit view over one rollback-on-error metadata
 * transaction. This boundary intentionally has no provisional audit/outbox
 * hook; AND-66 can add explicit durable stage methods to the same transaction.
 */
export interface ContentCommitMetadataTransaction
  extends AuthorizationTransaction,
    NoteQueueTransaction,
    PrincipalMindUsageReader,
    IdempotencyTransaction,
    CapacityReservationTransaction {
  readHead(spaceId: SpaceId): Promise<RevisionId | null>;
  readRevision(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<Readonly<CanonicalRevisionEnvelope> | null>;
  commitRevision(request: RevisionCommitRequest): Promise<RevisionCommitResult>;
  stageContentCommitEffects(
    request: StageContentCommitEffectsRequest,
  ): Promise<StageContentCommitEffectsResult>;
  readStagedBundleFile(
    stagedFileId: StagedBundleFileId,
  ): Promise<Readonly<StagedBundleFileRecord> | null>;
  consumeStagedBundleFiles(
    request: Readonly<ConsumeStagedBundleFilesRequest>,
  ): Promise<ConsumeStagedBundleFilesResult>;
  checkBundleFileRetainedQuota(request: Readonly<{
    spaceId: SpaceId;
    candidateEntries: readonly Readonly<{
      sha256: Sha256Digest;
      size: number;
    }>[];
    maxRetainedBytes: number;
  }>): Promise<boolean>;
}

/** Atomic metadata boundary for one application-level content commit. */
export interface ContentCommitMetadataStore
  extends RevisionMetadataStore,
    PreflightProducerProofStore,
    PrincipalMindUsageReader,
    BackgroundWorkStore,
    BundleFileStagingStore,
    CapacityLedgerStore,
    SpaceTargetRecordPurger {
  runContentCommitTransaction<Result>(
    operation: (
      transaction: ContentCommitMetadataTransaction,
    ) => Promise<Result>,
  ): Promise<Result>;
}

export interface ExactRevisionIndexDocument {
  readonly path: string;
  /** Derived searchable text. Implementations must never log it. */
  readonly text: string;
  /** Canonical manifest digest; required by incremental index builds. */
  readonly sha256?: Sha256Digest;
  /** True only when the title was derived from the current manifest path. */
  readonly titleDerivedFromPath?: boolean;
  /** Parsed field projection used by bounded storage-side ranking. */
  readonly fields?: Readonly<{
    readonly title: readonly string[];
    readonly description: readonly string[];
    readonly tags: readonly string[];
    readonly headings: readonly string[];
    readonly body: readonly string[];
  }>;
}

export interface ExactRevisionIndexEntry {
  readonly path: string;
  readonly sha256: Sha256Digest;
}

export interface ReplaceExactRevisionIndexRequest {
  readonly spaceId: SpaceId;
  readonly revisionId: RevisionId;
  /** Complete ordered Markdown membership projection for this revision. */
  readonly entries?: readonly Readonly<ExactRevisionIndexEntry>[];
  /** Bodies absent from the Space-scoped content store, or all bodies for legacy callers. */
  readonly documents: readonly Readonly<ExactRevisionIndexDocument>[];
}

export type ReadExactRevisionIndexResult =
  | {
      readonly kind: "ready";
      readonly spaceId: SpaceId;
      readonly revisionId: RevisionId;
      readonly documents: readonly Readonly<ExactRevisionIndexDocument>[];
    }
  | { readonly kind: "unavailable" };

export type QueryExactRevisionIndexResult =
  | {
      readonly kind: "ready";
      readonly spaceId: SpaceId;
      readonly revisionId: RevisionId;
      /** Joined membership/document count for completeness verification. */
      readonly totalDocuments: number;
      /** Query-specific candidates only; application ranking remains authoritative. */
      readonly documents: readonly Readonly<ExactRevisionIndexDocument>[];
      /** Exact number of documents matching all terms before page slicing. */
      readonly totalMatches?: number;
      /** True only when the adapter already applied the requested page. */
      readonly pageApplied?: boolean;
    }
  | { readonly kind: "unavailable" };

export type InspectExactRevisionIndexResult =
  | {
      readonly kind: "ready";
      readonly spaceId: SpaceId;
      readonly revisionId: RevisionId;
    }
  | { readonly kind: "unavailable" };

/** Revision-keyed derived index. There is deliberately no implicit HEAD API. */
export interface SearchIndex {
  readonly kind: "search-index";
  findMissingDigests?(
    spaceId: SpaceId,
    digests: readonly Sha256Digest[],
  ): Promise<readonly Sha256Digest[]>;
  replaceExactRevision(
    request: ReplaceExactRevisionIndexRequest,
  ): Promise<void>;
  readExactRevision(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<ReadExactRevisionIndexResult>;
  /** Metadata-only physical projection probe; it must not load document text. */
  inspectExactRevision?(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<InspectExactRevisionIndexResult>;
  queryExactRevision?(
    spaceId: SpaceId,
    revisionId: RevisionId,
    normalizedTerms: readonly string[],
    page?: Readonly<{ readonly offset: number; readonly limit: number }>,
  ): Promise<QueryExactRevisionIndexResult>;
  purgeSpace(spaceId: SpaceId): Promise<number>;
}

export interface StageContentCommitEffectsRequest {
  readonly auditEvent: Readonly<AuditEvent>;
  readonly auditOutbox: Readonly<AuditOutboxMessage>;
  readonly indexJob: Readonly<BackgroundJob>;
  readonly indexState: Readonly<RevisionIndexState>;
}

export type StageContentCommitEffectsResult =
  | { readonly kind: "staged" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "effect_id_collision" }
  | { readonly kind: "invalid_effects" };

export type ClaimIndexJobResult =
  | {
      readonly kind: "claimed";
      readonly job: Readonly<BackgroundJob>;
      readonly indexState: Readonly<RevisionIndexState>;
    }
  | { readonly kind: "not_found" | "not_available" | "completed" };

export type ClaimAuditOutboxResult =
  | {
      readonly kind: "claimed";
      readonly message: Readonly<AuditOutboxMessage>;
      readonly event: Readonly<AuditEvent>;
    }
  | { readonly kind: "not_found" | "not_available" | "completed" };

export interface RevisionIndexRecoveryGap {
  readonly spaceId: SpaceId;
  readonly revisionId: RevisionId;
}

export type RevisionIndexRecoveryCandidate =
  | Readonly<{
      readonly spaceId: SpaceId;
      readonly revisionId: RevisionId;
      readonly reason: "metadata_missing";
    }>
  | Readonly<{
      readonly spaceId: SpaceId;
      readonly revisionId: RevisionId;
      readonly reason: "metadata_inconsistent";
    }>
  | Readonly<{
      readonly spaceId: SpaceId;
      readonly revisionId: RevisionId;
      readonly reason: "verify_ready_projection";
      readonly observedJobId: JobId;
      readonly observedJobVersion: Version;
    }>;

export type RepairRevisionIndexReason =
  | Readonly<{ readonly kind: "metadata_inconsistent" }>
  | Readonly<{
      readonly kind: "physical_index_missing";
      readonly expectedReadyJobId: JobId;
      readonly expectedReadyJobVersion: Version;
    }>;

export type EnsureRevisionIndexQueuedResult =
  | { readonly kind: "queued"; readonly job: Readonly<BackgroundJob> }
  | { readonly kind: "already_present"; readonly job: Readonly<BackgroundJob> }
  | { readonly kind: "revision_not_found" | "not_current_head" | "invalid_effects" };

export type RepairRevisionIndexQueuedResult =
  | { readonly kind: "queued"; readonly job: Readonly<BackgroundJob> }
  | { readonly kind: "already_present"; readonly job: Readonly<BackgroundJob> }
  | { readonly kind: "revision_not_found" | "not_current_head" | "invalid_effects" };

export interface BackgroundWorkStore extends MetadataStore {
  listRecoverableIndexJobs(
    now: UtcInstant,
    limit: number,
  ): Promise<readonly Readonly<BackgroundJob>[]>;
  listActiveRevisionIndexGaps(
    limit: number,
  ): Promise<readonly Readonly<RevisionIndexRecoveryGap>[]>;
  /**
   * Bounded internal reconciliation scan. Ready candidates require a physical
   * SearchIndex read before repair; no caller-controlled public endpoint uses it.
   */
  listActiveRevisionIndexRecoveryCandidates(
    limit: number,
  ): Promise<readonly RevisionIndexRecoveryCandidate[]>;
  ensureRevisionIndexQueued(
    job: Readonly<BackgroundJob>,
    state: Readonly<RevisionIndexState>,
  ): Promise<EnsureRevisionIndexQueuedResult>;
  repairRevisionIndexQueued(
    job: Readonly<BackgroundJob>,
    state: Readonly<RevisionIndexState>,
    reason: RepairRevisionIndexReason,
  ): Promise<RepairRevisionIndexQueuedResult>;
  claimIndexJob(
    jobId: JobId,
    now: UtcInstant,
    claimExpiresAt: UtcInstant,
  ): Promise<ClaimIndexJobResult>;
  completeIndexJob(
    jobId: JobId,
    expectedClaimVersion: Version,
    completedAt: UtcInstant,
  ): Promise<boolean>;
  failIndexJob(
    jobId: JobId,
    expectedClaimVersion: Version,
    failureCode: string,
    failedAt: UtcInstant,
    retryAt: UtcInstant,
  ): Promise<boolean>;
  readRevisionIndexState(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<Readonly<RevisionIndexState> | null>;
  claimAuditOutbox(
    outboxMessageId: OutboxMessageId,
    now: UtcInstant,
    claimExpiresAt: UtcInstant,
  ): Promise<ClaimAuditOutboxResult>;
  completeAuditOutbox(
    outboxMessageId: OutboxMessageId,
    expectedClaimVersion: Version,
    completedAt: UtcInstant,
  ): Promise<boolean>;
  failAuditOutbox(
    outboxMessageId: OutboxMessageId,
    expectedClaimVersion: Version,
    failedAt: UtcInstant,
    retryAt: UtcInstant,
  ): Promise<boolean>;
}

export type ClaimInvitationExpiryJobResult =
  | { readonly kind: "claimed"; readonly job: Readonly<BackgroundJob> }
  | { readonly kind: "not_found" | "not_available" | "completed" };

export type CompleteInvitationExpiryJobResult =
  | { readonly kind: "expired" | "already_terminal" }
  | { readonly kind: "not_found" | "not_available" };

/** Durable invitation expiry jobs carry only an invitation ID, never authority. */
export interface InvitationExpiryJobStore extends MetadataStore {
  listRecoverableInvitationExpiryJobs(
    now: UtcInstant,
    limit: number,
  ): Promise<readonly Readonly<BackgroundJob>[]>;
  claimInvitationExpiryJob(
    jobId: JobId,
    now: UtcInstant,
    claimExpiresAt: UtcInstant,
  ): Promise<ClaimInvitationExpiryJobResult>;
  completeInvitationExpiryJob(
    jobId: JobId,
    expectedClaimVersion: Version,
    completedAt: UtcInstant,
  ): Promise<CompleteInvitationExpiryJobResult>;
  failInvitationExpiryJob(
    jobId: JobId,
    expectedClaimVersion: Version,
    failedAt: UtcInstant,
    retryAt: UtcInstant,
  ): Promise<boolean>;
}

export interface SpaceTargetPurgeResult {
  readonly backgroundJobs: number;
  readonly indexStates: number;
  readonly auditEvents: number;
  readonly auditOutboxMessages: number;
  readonly idempotencyRecords: number;
}

/** Explicit delete-all hook for target-linked durable service records. */
export interface SpaceTargetRecordPurger {
  purgeSpaceTargetRecords(spaceId: SpaceId): Promise<SpaceTargetPurgeResult>;
}
