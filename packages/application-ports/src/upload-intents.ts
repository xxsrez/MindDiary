import type {
  IdempotencyKey,
  MindBindingOwnerId,
  PrincipalId,
  Sha256Digest,
  SpaceId,
  StagedBundleFileId,
  TokenId,
  UtcInstant,
  WriteMindBindingId,
} from "@mind-diary/domain";
import type { FileIngressSourceKind } from "./objects.js";

export type LocalFileUploadIntentSourceKind = Extract<
  FileIngressSourceKind,
  "local_path" | "workspace/generated_artifact"
>;

export type LocalFileUploadIntentState =
  | "active"
  | "consuming"
  | "consumed"
  | "rejected";

/**
 * Durable path-free state for one authenticated companion upload.
 * The capability secret, upload URL, bearer, paths and bytes never enter it.
 */
export interface LocalFileUploadIntentRecord {
  readonly formatVersion: 1;
  readonly intentId: string;
  readonly namespaceHash: Sha256Digest;
  readonly canonicalRequestHash: Sha256Digest;
  readonly principalId: PrincipalId;
  readonly tokenId: TokenId;
  readonly bindingOwnerId: MindBindingOwnerId;
  readonly spaceId: SpaceId;
  readonly writeBindingId: WriteMindBindingId;
  readonly sourceKind: LocalFileUploadIntentSourceKind;
  readonly displayFilename: string;
  readonly claimedMediaType: string;
  readonly expectedSize: number;
  readonly expectedSha256: Sha256Digest;
  readonly idempotencyKey: IdempotencyKey;
  readonly state: LocalFileUploadIntentState;
  readonly claimId: string | null;
  readonly leaseExpiresAt: UtcInstant | null;
  readonly stagedFileId: StagedBundleFileId | null;
  readonly stageReplayed: boolean | null;
  readonly rejectionCode: string | null;
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly consumedAt: UtcInstant | null;
}

export type CreateLocalFileUploadIntentResult =
  | {
      readonly kind: "created" | "replayed";
      readonly record: Readonly<LocalFileUploadIntentRecord>;
    }
  | { readonly kind: "conflict" };

export type ClaimLocalFileUploadIntentResult =
  | { readonly kind: "claimed"; readonly record: Readonly<LocalFileUploadIntentRecord> }
  | { readonly kind: "not_found" | "expired" | "consumed" | "rejected" | "busy" };

export interface LocalFileUploadIntentStore {
  readLocalFileUploadIntent(
    intentId: string,
  ): Promise<Readonly<LocalFileUploadIntentRecord> | null>;
  createLocalFileUploadIntent(
    record: Readonly<LocalFileUploadIntentRecord>,
  ): Promise<CreateLocalFileUploadIntentResult>;
  claimLocalFileUploadIntent(request: Readonly<{
    intentId: string;
    principalId: PrincipalId;
    bindingOwnerId: MindBindingOwnerId;
    claimId: string;
    occurredAt: UtcInstant;
    leaseExpiresAt: UtcInstant;
  }>): Promise<ClaimLocalFileUploadIntentResult>;
  renewLocalFileUploadIntent(request: Readonly<{
    intentId: string;
    claimId: string;
    occurredAt: UtcInstant;
    leaseExpiresAt: UtcInstant;
  }>): Promise<"renewed" | "claim_lost" | "expired" | "not_found">;
  completeLocalFileUploadIntent(request: Readonly<{
    intentId: string;
    claimId: string;
    stagedFileId: StagedBundleFileId;
    replayed: boolean;
    completedAt: UtcInstant;
  }>): Promise<"completed" | "claim_lost" | "expired" | "not_found">;
  rejectLocalFileUploadIntent(request: Readonly<{
    intentId: string;
    claimId: string;
    code: string;
    rejectedAt: UtcInstant;
  }>): Promise<"rejected" | "claim_lost" | "not_found">;
  releaseLocalFileUploadIntent(request: Readonly<{
    intentId: string;
    claimId: string;
  }>): Promise<"released" | "claim_lost" | "not_found">;
  collectExpiredLocalFileUploadIntents(request: Readonly<{
    expiredBefore: UtcInstant;
    limit: number;
  }>): Promise<readonly Readonly<LocalFileUploadIntentRecord>[]>;
  deleteExpiredLocalFileUploadIntent(request: Readonly<{
    intentId: string;
    expectedExpiresAt: UtcInstant;
    expiredBefore: UtcInstant;
  }>): Promise<boolean>;
}
