import {
  type BindingVersion,
  type BundleFileMediaType,
  type ExportArchiveRecord,
  type MarkdownMediaType,
  type MindBindingOwnerId,
  type PrincipalId,
  type PrincipalMindUsageGenerationId,
  type JobId,
  type Sha256Digest,
  type SpaceId,
  type StagedBundleFileId,
  type UtcInstant,
  type Version,
  type WriteMindBindingId,
} from "@mind-diary/domain";

import {
  type IdempotencyTransaction,
  type CapacityReservationTransaction,
  type CapacityLedgerStore,
} from "./revisions.js";

import {
  type AuthorizationTransaction,
} from "./authorization.js";
import type { PrincipalMindUsageReader } from "./principal-mind-usage.js";

export interface ImmutableObjectWriteRequest {
  readonly bytes: Uint8Array;
  readonly mediaType: MarkdownMediaType;
  /** Server-supplied UTC time used only for bounded unreachable-object GC. */
  readonly createdAt: UtcInstant;
}

export interface ImmutableObjectMetadata {
  readonly sha256: Sha256Digest;
  readonly mediaType: MarkdownMediaType;
  readonly size: number;
  readonly createdAt: UtcInstant;
  /** Mutable GC lease metadata; canonical bytes and digest remain immutable. */
  readonly protectedAt: UtcInstant;
}

export interface ImmutableObject extends ImmutableObjectMetadata {
  readonly bytes: Uint8Array;
}

export interface ImmutableObjectPutResult {
  readonly object: Readonly<ImmutableObjectMetadata>;
  readonly status: "stored" | "already_exists";
}

export interface ImmutableObjectListRequest {
  /** Only objects whose GC protection is strictly older are candidates. */
  readonly createdBefore: UtcInstant;
  /** Reachable digests are excluded before applying limit, preventing starvation. */
  readonly excludedDigests: readonly Sha256Digest[];
  readonly limit: number;
}

export interface ImmutableObjectDeleteRequest {
  readonly sha256: Sha256Digest;
  /** Candidate lease observed by list; a concurrent put changes it. */
  readonly expectedProtectedAt: UtcInstant;
  /** The delete is refused when current protection is at or after this boundary. */
  readonly createdBefore: UtcInstant;
}

export type ObjectStoreFailureCode =
  | "invalid_digest"
  | "invalid_media_type"
  | "invalid_utf8"
  | "invalid_timestamp"
  | "invalid_limit"
  | "invalid_range"
  | "digest_collision"
  | "object_tampered"
  | "range_unavailable"
  | "object_read_timeout";

/** Stable port-level failure used without coupling application code to an adapter. */
export class ObjectStoreFailure extends Error {
  readonly code: ObjectStoreFailureCode;

  constructor(code: ObjectStoreFailureCode, message: string) {
    super(message);
    this.name = "ObjectStoreFailure";
    this.code = code;
  }
}

export interface ObjectStore {
  readonly kind: "object-store";
  calculateSha256(bytes: Uint8Array): Promise<Sha256Digest>;
  putImmutable(request: ImmutableObjectWriteRequest): Promise<ImmutableObjectPutResult>;
  getImmutable(sha256: Sha256Digest): Promise<Readonly<ImmutableObject> | null>;
  listImmutableObjects(
    request: ImmutableObjectListRequest,
  ): Promise<readonly Readonly<ImmutableObjectMetadata>[]>;
  deleteImmutableObject(request: ImmutableObjectDeleteRequest): Promise<boolean>;
}

export const REVISION_MANIFEST_MEDIA_TYPE =
  "application/vnd.mind-diary.revision-manifest+json; charset=utf-8" as const;

export type SpaceCanonicalObjectKind = "markdown" | "revision_manifest";
export type SpaceCanonicalObjectMediaType =
  | MarkdownMediaType
  | typeof REVISION_MANIFEST_MEDIA_TYPE;

export interface SpaceCanonicalObjectWriteRequest {
  readonly kind: SpaceCanonicalObjectKind;
  readonly spaceId: SpaceId;
  readonly bytes: Uint8Array;
  readonly mediaType: SpaceCanonicalObjectMediaType;
  readonly createdAt: UtcInstant;
}

export interface SpaceCanonicalObjectMetadata {
  readonly kind: SpaceCanonicalObjectKind;
  readonly spaceId: SpaceId;
  readonly sha256: Sha256Digest;
  readonly mediaType: SpaceCanonicalObjectMediaType;
  readonly size: number;
  readonly createdAt: UtcInstant;
  readonly protectedAt: UtcInstant;
}

export interface SpaceCanonicalObject extends SpaceCanonicalObjectMetadata {
  readonly bytes: Uint8Array;
}

/** Streaming canonical read used when a bounded prefix does not require the tail. */
export interface OpenedSpaceCanonicalObject extends SpaceCanonicalObjectMetadata {
  readonly body: ReadableStream<Uint8Array>;
  /**
   * Range authentication returned by current object providers. Legacy
   * objects deliberately omit it so the application can take the verified
   * full-read fallback.
   */
  readonly integrityProof?: Readonly<ObjectIntegrityRangeProof>;
  /** The byte span actually carried by `body` (chunk aligned for ranges). */
  readonly range?: Readonly<ObjectByteRange>;
}

export interface ObjectByteRange {
  readonly offset: number;
  readonly length: number;
}

export const OBJECT_INTEGRITY_PROOF_SCHEMA = "md-object-integrity-v1" as const;
export const OBJECT_INTEGRITY_CHUNK_SIZE = 64 * 1024;

export type ObjectIntegrityKind = SpaceCanonicalObjectKind | "bundle_file";

export interface ObjectIntegrityChunkProof {
  readonly index: number;
  readonly offset: number;
  readonly length: number;
  readonly sha256: Sha256Digest;
  /** Merkle siblings, from the leaf level towards the trusted root. */
  readonly siblings: readonly Sha256Digest[];
}

/** A bounded proof for the requested range. */
export interface ObjectIntegrityRangeProof {
  readonly schema: typeof OBJECT_INTEGRITY_PROOF_SCHEMA;
  readonly spaceId: SpaceId;
  readonly kind: ObjectIntegrityKind;
  readonly size: number;
  readonly sha256: Sha256Digest;
  readonly chunkSize: number;
  readonly chunkCount: number;
  readonly root: Sha256Digest;
  readonly chunks: readonly ObjectIntegrityChunkProof[];
}

/** Full proof persisted by an object adapter before canonical visibility. */
export interface ObjectIntegrityManifest {
  readonly schema: typeof OBJECT_INTEGRITY_PROOF_SCHEMA;
  readonly spaceId: SpaceId;
  readonly kind: ObjectIntegrityKind;
  readonly size: number;
  readonly sha256: Sha256Digest;
  readonly chunkSize: number;
  readonly chunkCount: number;
  readonly root: Sha256Digest;
  readonly chunkDigests: readonly Sha256Digest[];
}

export function objectIntegrityLeafInput(
  proof: Pick<ObjectIntegrityManifest, "schema" | "spaceId" | "kind" | "size" | "sha256" | "chunkSize">,
  index: number,
  offset: number,
  length: number,
  sha256: Sha256Digest,
): string {
  return [
    proof.schema,
    proof.spaceId,
    proof.kind,
    String(proof.size),
    proof.sha256,
    String(proof.chunkSize),
    String(index),
    String(offset),
    String(length),
    sha256,
  ].join("\n") + "\n";
}

export function objectIntegrityNodeInput(left: Sha256Digest, right: Sha256Digest): string {
  return `${OBJECT_INTEGRITY_PROOF_SCHEMA}\nnode\n${left}\n${right}\n`;
}

export function serializeObjectIntegrityManifest(proof: Readonly<ObjectIntegrityManifest>): string {
  return JSON.stringify({
    schema: proof.schema,
    spaceId: proof.spaceId,
    kind: proof.kind,
    size: proof.size,
    sha256: proof.sha256,
    chunkSize: proof.chunkSize,
    chunkCount: proof.chunkCount,
    root: proof.root,
    chunkDigests: proof.chunkDigests,
  });
}

export interface SpaceCanonicalObjectPutResult {
  readonly object: Readonly<SpaceCanonicalObjectMetadata>;
  readonly status: "stored" | "already_exists";
  /** Root derived while verifying the supplied bytes; safe to anchor in revision metadata. */
  readonly integrityRoot: Sha256Digest;
}

export interface SpaceCanonicalObjectListRequest {
  readonly createdBefore: UtcInstant;
  /** Optional exact Space scope for lifecycle cleanup without global listing. */
  readonly spaceId?: SpaceId;
  readonly excluded: readonly Readonly<{
    kind: SpaceCanonicalObjectKind;
    spaceId: SpaceId;
    sha256: Sha256Digest;
  }>[];
  readonly limit: number;
}

export interface SpaceCanonicalObjectDeleteRequest {
  readonly kind: SpaceCanonicalObjectKind;
  readonly spaceId: SpaceId;
  readonly sha256: Sha256Digest;
  readonly expectedProtectedAt: UtcInstant;
  readonly createdBefore: UtcInstant;
}

/** Space-isolated v3 Markdown and revision-manifest bytes. */
export interface SpaceCanonicalObjectStore {
  putSpaceCanonicalObject(
    request: Readonly<SpaceCanonicalObjectWriteRequest>,
  ): Promise<SpaceCanonicalObjectPutResult>;
  getSpaceCanonicalObject(
    kind: SpaceCanonicalObjectKind,
    spaceId: SpaceId,
    sha256: Sha256Digest,
  ): Promise<Readonly<SpaceCanonicalObject> | null>;
  openSpaceCanonicalObject?(
    kind: SpaceCanonicalObjectKind,
    spaceId: SpaceId,
    sha256: Sha256Digest,
  ): Promise<Readonly<OpenedSpaceCanonicalObject> | null>;
  /** Provider-bounded body read; metadata continues to describe the full immutable object. */
  openSpaceCanonicalObjectRange?(
    kind: SpaceCanonicalObjectKind,
    spaceId: SpaceId,
    sha256: Sha256Digest,
    range: Readonly<ObjectByteRange>,
  ): Promise<Readonly<OpenedSpaceCanonicalObject> | null>;
  listSpaceCanonicalObjects(
    request: Readonly<SpaceCanonicalObjectListRequest>,
  ): Promise<readonly Readonly<SpaceCanonicalObjectMetadata>[]>;
  deleteSpaceCanonicalObject(
    request: Readonly<SpaceCanonicalObjectDeleteRequest>,
  ): Promise<boolean>;
}

export interface BundleFileObjectWriteRequest {
  readonly spaceId: SpaceId;
  readonly bytes: Uint8Array;
  readonly mediaType: BundleFileMediaType;
  readonly createdAt: UtcInstant;
}

/**
 * Safe provenance labels for the portable file-ingress boundary.
 *
 * Provider file IDs, local paths, URLs and other transport details deliberately
 * do not have a type in this package.  A staged record may retain only one of
 * these bounded labels so that all source adapters share the same BundleFile
 * lifecycle without leaking their transport identity into the domain.
 */
export const FILE_INGRESS_SOURCE_KINDS = Object.freeze([
  "session_attachment",
  "local_path",
  "workspace/generated_artifact",
  "connector_object",
  "bounded_in_memory",
  "server_generated",
] as const);

export type FileIngressSourceKind = (typeof FILE_INGRESS_SOURCE_KINDS)[number];
export type GeneratedArtifactSourceKind = Extract<
  FileIngressSourceKind,
  "bounded_in_memory" | "server_generated"
>;

/**
 * Portable stream writer for source adapters that cannot buffer a generated
 * payload in application memory.  The object-store adapter owns the actual
 * out-of-band storage; application code supplies only bytes and verification
 * metadata.  Implementations must make abort idempotent and never publish a
 * staged object before `complete` succeeds.
 */
export interface StagedBundleFileUpload {
  write(chunk: Uint8Array): Promise<void>;
  complete(request: Readonly<{
    sha256: Sha256Digest;
    size: number;
  }>): Promise<Readonly<Omit<StagedBundleFileObject, "bytes">>>;
  abort(): Promise<void>;
}

export interface StagedBundleFileUploadRequest {
  readonly stagedFileId: StagedBundleFileId;
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly spaceId: SpaceId;
  readonly createdAt: UtcInstant;
  /** Adapter-enforced upper bound for one stream. */
  readonly maxBytes: number;
  /** Exact producer length when the authorized source supplies one. */
  readonly expectedSize?: number;
}

export interface BundleFileObjectMetadata {
  readonly spaceId: SpaceId;
  readonly sha256: Sha256Digest;
  /** Storage hint only; the exact revision manifest owns the served media type. */
  readonly mediaType: BundleFileMediaType;
  readonly size: number;
  readonly createdAt: UtcInstant;
  readonly protectedAt: UtcInstant;
}

export interface BundleFileObject extends BundleFileObjectMetadata {
  readonly bytes: Uint8Array;
}

/** Bounded canonical read. The caller owns and must consume or cancel `body`. */
export interface OpenedBundleFileObject extends BundleFileObjectMetadata {
  readonly body: ReadableStream<Uint8Array>;
  readonly integrityProof?: Readonly<ObjectIntegrityRangeProof>;
  readonly range?: Readonly<ObjectByteRange>;
}

export interface BundleFileObjectPutResult {
  readonly object: Readonly<BundleFileObjectMetadata>;
  readonly status: "stored" | "already_exists";
  /** Absent only when an existing canonical object was not re-derived from trusted bytes. */
  readonly integrityRoot?: Sha256Digest;
}

export interface BundleFileObjectListRequest {
  /** Limit enumeration to one deleted Space during its restartable erasure. */
  readonly spaceId?: SpaceId;
  readonly createdBefore: UtcInstant;
  readonly excluded: readonly Readonly<{
    spaceId: SpaceId;
    sha256: Sha256Digest;
  }>[];
  readonly limit: number;
}

export interface BundleFileObjectDeleteRequest {
  readonly spaceId: SpaceId;
  readonly sha256: Sha256Digest;
  readonly expectedProtectedAt: UtcInstant;
  readonly createdBefore: UtcInstant;
}

export interface StagedBundleFileObjectWriteRequest {
  readonly stagedFileId: StagedBundleFileId;
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly spaceId: SpaceId;
  readonly bytes: Uint8Array;
  readonly createdAt: UtcInstant;
}

export interface StagedBundleFileObject {
  readonly stagedFileId: StagedBundleFileId;
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly spaceId: SpaceId;
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly createdAt: UtcInstant;
}

/** Bounded quarantine read used for integrity verification before promotion. */
export interface OpenedStagedBundleFileObject
  extends Omit<StagedBundleFileObject, "bytes"> {
  readonly body: ReadableStream<Uint8Array>;
}

export interface PromoteStagedBundleFileRequest {
  readonly stagedFileId: StagedBundleFileId;
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly spaceId: SpaceId;
  readonly sha256: Sha256Digest;
  readonly size: number;
  readonly mediaType: BundleFileMediaType;
  readonly createdAt: UtcInstant;
}

/** Opaque bytes use Space-scoped canonical keys and a separate staging namespace. */
export interface BundleFileObjectStore extends ObjectStore, SpaceCanonicalObjectStore {
  putBundleFile(
    request: Readonly<BundleFileObjectWriteRequest>,
  ): Promise<BundleFileObjectPutResult>;
  getBundleFile(
    spaceId: SpaceId,
    sha256: Sha256Digest,
  ): Promise<Readonly<BundleFileObject> | null>;
  openBundleFile(
    spaceId: SpaceId,
    sha256: Sha256Digest,
  ): Promise<Readonly<OpenedBundleFileObject> | null>;
  openBundleFileRange?(
    spaceId: SpaceId,
    sha256: Sha256Digest,
    range: Readonly<ObjectByteRange>,
  ): Promise<Readonly<OpenedBundleFileObject> | null>;
  listBundleFileObjects(
    request: Readonly<BundleFileObjectListRequest>,
  ): Promise<readonly Readonly<BundleFileObjectMetadata>[]>;
  deleteBundleFileObject(
    request: Readonly<BundleFileObjectDeleteRequest>,
  ): Promise<boolean>;
  putStagedBundleFile(
    request: Readonly<StagedBundleFileObjectWriteRequest>,
  ): Promise<Readonly<StagedBundleFileObject>>;
  /**
   * Optional streaming ingress.  Legacy/local adapters may omit it and use
   * bounded bytes instead; a provider adapter that implements it must enforce
   * `maxBytes` before durable publication.
   */
  beginStagedBundleFileUpload?(
    request: Readonly<StagedBundleFileUploadRequest>,
  ): Promise<StagedBundleFileUpload>;
  getStagedBundleFile(
    stagedFileId: StagedBundleFileId,
  ): Promise<Readonly<StagedBundleFileObject> | null>;
  openStagedBundleFile(
    stagedFileId: StagedBundleFileId,
  ): Promise<Readonly<OpenedStagedBundleFileObject> | null>;
  promoteStagedBundleFile(
    request: Readonly<PromoteStagedBundleFileRequest>,
  ): Promise<BundleFileObjectPutResult>;
  deleteStagedBundleFile(stagedFileId: StagedBundleFileId): Promise<boolean>;
}

export type StagedBundleFileState =
  | "quarantined"
  | "verified"
  | "consumed"
  | "expired"
  | "rejected";

export interface StagedBundleFileRecord {
  readonly stagedFileId: StagedBundleFileId;
  readonly bindingOwnerId: MindBindingOwnerId;
  /** Safe source provenance; transport identifiers never cross this boundary. */
  readonly sourceKind: FileIngressSourceKind;
  /**
   * Principal-owned destination fence for current producers. Legacy records
   * omit these fields and are never consumable by the principal-mounted
   * commit path.
   */
  readonly principalId?: PrincipalId;
  readonly principalMindUsageGenerationId?: PrincipalMindUsageGenerationId;
  /** @deprecated Retained only to deserialize pre-usage-mode staged records. */
  readonly writeBindingId?: WriteMindBindingId;
  /** @deprecated Retained only to deserialize pre-usage-mode staged records. */
  readonly writeBindingGeneration?: BindingVersion;
  readonly spaceId: SpaceId;
  readonly displayFilename: string;
  readonly mediaType: BundleFileMediaType;
  readonly sha256: Sha256Digest;
  readonly size: number;
  readonly state: StagedBundleFileState;
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly consumedAt: UtcInstant | null;
  readonly rejectionCode: string | null;
  /** Durable capacity linkage; absent only on legacy staged records. */
  readonly capacityReservationId?: string;
}

export type CreateStagedBundleFileResult =
  | { readonly kind: "created"; readonly record: Readonly<StagedBundleFileRecord> }
  | { readonly kind: "id_collision" | "outstanding_byte_limit_exceeded" };

export interface BundleFileStagingTransaction
  extends AuthorizationTransaction,
    PrincipalMindUsageReader,
    IdempotencyTransaction,
    CapacityReservationTransaction {
  readStagedBundleFile(
    stagedFileId: StagedBundleFileId,
  ): Promise<Readonly<StagedBundleFileRecord> | null>;
  createStagedBundleFile(
    record: Readonly<StagedBundleFileRecord>,
    maxOutstandingBytes: number,
    occurredAt: UtcInstant,
  ): Promise<CreateStagedBundleFileResult>;
}

export interface ConsumeStagedBundleFilesRequest {
  readonly stagedFileIds: readonly StagedBundleFileId[];
  readonly principalId: PrincipalId;
  readonly principalMindUsageGenerationId: PrincipalMindUsageGenerationId;
  readonly spaceId: SpaceId;
  readonly consumedAt: UtcInstant;
}

export type ConsumeStagedBundleFilesResult =
  | {
      readonly kind: "consumed";
      readonly records: readonly Readonly<StagedBundleFileRecord>[];
    }
  | {
      readonly kind:
        | "not_found"
        | "not_verified"
        | "expired"
        | "binding_mismatch"
        | "duplicate_reference";
      readonly stagedFileId: StagedBundleFileId | null;
    };

export interface BundleFileStagingStore extends CapacityLedgerStore {
  runBundleFileStagingTransaction<Result>(
    operation: (transaction: BundleFileStagingTransaction) => Promise<Result>,
  ): Promise<Result>;
  readStagedBundleFile(
    stagedFileId: StagedBundleFileId,
  ): Promise<Readonly<StagedBundleFileRecord> | null>;
  collectStagedBundleFilesForGc(request: Readonly<{
    createdBefore: UtcInstant;
    limit: number;
  }>): Promise<readonly Readonly<StagedBundleFileRecord>[]>;
  deleteExpiredStagedBundleFileRecord(
    stagedFileId: StagedBundleFileId,
  ): Promise<boolean>;
}

export interface ExportArchiveWriteRequest {
  readonly jobId: JobId;
  readonly spaceId: SpaceId;
  readonly claimVersion: Version;
  readonly bytes: Uint8Array;
  readonly sha256: Sha256Digest;
  readonly archiveFormat?: "MD-OKF-ZIP-1" | "MD-BUNDLE-ZIP-1";
  readonly filename?: "mind-diary-okf-bundle.zip" | "mind-diary-bundle.zip";
  readonly contentDisposition?:
    | 'attachment; filename="mind-diary-okf-bundle.zip"'
    | 'attachment; filename="mind-diary-bundle.zip"';
  readonly createdAt: UtcInstant;
}

export interface StoredExportArchive extends ExportArchiveRecord {
  readonly jobId: JobId;
  readonly spaceId: SpaceId;
  readonly claimVersion: Version;
  readonly createdAt: UtcInstant;
}

export type ExportArchivePutResult =
  | {
      readonly kind: "stored" | "already_exists";
      readonly archive: Readonly<StoredExportArchive>;
    }
  | { readonly kind: "digest_mismatch" | "object_key_collision" };

export interface ExportArchiveUploadRequest {
  readonly jobId: JobId;
  readonly spaceId: SpaceId;
  readonly claimVersion: Version;
  readonly archiveFormat: "MD-OKF-ZIP-1" | "MD-BUNDLE-ZIP-1";
  readonly filename: "mind-diary-okf-bundle.zip" | "mind-diary-bundle.zip";
  readonly contentDisposition:
    | 'attachment; filename="mind-diary-okf-bundle.zip"'
    | 'attachment; filename="mind-diary-bundle.zip"';
  readonly createdAt: UtcInstant;
}

/** Bounded writer; Sites persists deterministic parts instead of buffering one archive. */
export interface ExportArchiveUpload {
  write(chunk: Uint8Array): Promise<void>;
  complete(request: Readonly<{
    sha256: Sha256Digest;
    size: number;
  }>): Promise<ExportArchivePutResult>;
  abort(): Promise<void>;
}

export interface OpenedExportArchive {
  readonly sha256: Sha256Digest;
  readonly size: number;
  readonly body: Uint8Array | ReadableStream<Uint8Array>;
}

/** Binary export namespace; it is intentionally separate from canonical Markdown. */
export interface ExportArchiveStore {
  readonly kind: "object-store";
  putExportArchive(
    request: ExportArchiveWriteRequest,
  ): Promise<ExportArchivePutResult>;
  beginExportArchiveUpload(
    request: Readonly<ExportArchiveUploadRequest>,
  ): Promise<ExportArchiveUpload>;
  openExportArchive(objectKey: string): Promise<Readonly<OpenedExportArchive> | null>;
  readExportArchive(objectKey: string): Promise<Uint8Array | null>;
  deleteExportArchive(objectKey: string): Promise<boolean>;
  /** One bounded prefix lookup; never scans the global export namespace. */
  hasExportArchivesForJob(jobId: JobId, spaceId: SpaceId): Promise<boolean>;
  /** Idempotent cleanup of completed and orphaned claim-scoped archives. */
  deleteExportArchivesForJob(jobId: JobId): Promise<number>;
  deleteExportArchivesForSpace(spaceId: SpaceId): Promise<number>;
}

export const OBJECT_CLEANUP_NAMESPACES = [
  "immutable",
  "bundle_file",
  "space_canonical",
  "staged_bundle",
  "export",
] as const;

export type ObjectCleanupNamespace = (typeof OBJECT_CLEANUP_NAMESPACES)[number];

interface ObjectCleanupCandidateBase {
  /** Adapter-owned locator. It is never emitted to telemetry or user surfaces. */
  readonly objectKey: string;
  /** CAS fence captured by the bounded listing operation. */
  readonly fence: string;
  readonly size: number;
  readonly createdAt: UtcInstant;
}

export type ObjectCleanupCandidate =
  | (ObjectCleanupCandidateBase & {
      readonly namespace: "immutable";
      readonly sha256: Sha256Digest;
      readonly protectedAt: UtcInstant;
    })
  | (ObjectCleanupCandidateBase & {
      readonly namespace: "bundle_file";
      readonly spaceId: SpaceId;
      readonly sha256: Sha256Digest;
      readonly protectedAt: UtcInstant;
    })
  | (ObjectCleanupCandidateBase & {
      readonly namespace: "space_canonical";
      readonly kind: SpaceCanonicalObjectKind;
      readonly spaceId: SpaceId;
      readonly sha256: Sha256Digest;
      readonly protectedAt: UtcInstant;
    })
  | (ObjectCleanupCandidateBase & {
      readonly namespace: "staged_bundle";
      readonly stagedFileId: StagedBundleFileId;
      readonly spaceId: SpaceId;
    })
  | (ObjectCleanupCandidateBase & {
      readonly namespace: "export";
      readonly jobId: JobId;
      readonly spaceId: SpaceId;
    });

export interface ObjectCleanupPage {
  readonly candidates: readonly Readonly<ObjectCleanupCandidate>[];
  /** Opaque durable adapter cursor, or null when the namespace page cycle ended. */
  readonly nextCursor: string | null;
  readonly listed: number;
}

export interface ObjectCleanupCheckpoint {
  readonly version: Version;
  readonly namespace: ObjectCleanupNamespace;
  readonly cursor: string | null;
  readonly cycleStartedAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly leaseExpiresAt: UtcInstant | null;
  readonly retries: number;
  readonly failures: number;
}

export type ClaimObjectCleanupResult =
  | {
      readonly kind: "claimed";
      readonly checkpoint: Readonly<ObjectCleanupCheckpoint>;
      readonly reclaimedLease: boolean;
    }
  | { readonly kind: "busy" };

/**
 * Durable, cursor-paged object maintenance boundary. Implementations must keep
 * each list bounded and fence deletes against writes after the selected safety
 * boundary.
 */
export interface BoundedObjectCleanupStore {
  listObjectCleanupPage(request: Readonly<{
    namespace: ObjectCleanupNamespace;
    cursor: string | null;
    limit: number;
  }>): Promise<Readonly<ObjectCleanupPage>>;
  deleteObjectCleanupCandidate(request: Readonly<{
    candidate: Readonly<ObjectCleanupCandidate>;
    createdBefore: UtcInstant;
  }>): Promise<boolean>;
}

/** D1 authority for the singleton bounded-cleanup cursor and worker lease. */
export interface ObjectCleanupCheckpointStore {
  claimObjectCleanup(request: Readonly<{
    now: UtcInstant;
    leaseExpiresAt: UtcInstant;
  }>): Promise<ClaimObjectCleanupResult>;
  completeObjectCleanupBatch(request: Readonly<{
    expectedVersion: Version;
    namespace: ObjectCleanupNamespace;
    cursor: string | null;
    cycleStartedAt: UtcInstant;
    completedAt: UtcInstant;
  }>): Promise<boolean>;
  failObjectCleanupBatch(request: Readonly<{
    expectedVersion: Version;
    failedAt: UtcInstant;
  }>): Promise<boolean>;
}
