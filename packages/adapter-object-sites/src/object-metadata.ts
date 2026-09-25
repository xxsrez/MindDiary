import {
  ObjectStoreFailure,
  type BundleFileObjectMetadata,
  type ExportArchiveWriteRequest,
  type ImmutableObjectMetadata,
  type ObjectIntegrityManifest,
  type StagedBundleFileObject,
  type StoredExportArchive,
} from "@mind-diary/application-ports";
import type { R2ListedObjectLike } from "./index.js";

type Digest = ImmutableObjectMetadata["sha256"];
type Utc = ImmutableObjectMetadata["createdAt"];

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const SAFE_MEDIA_TYPE = /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/u;
export const DELETE_STATE = "deleting";
export const ACTIVE_STATE = "active";

export function assertDigest(value: string): asserts value is Digest {
  if (!SHA256.test(value)) {
    throw new ObjectStoreFailure("invalid_digest", "object digest is invalid");
  }
}

export function assertUtc(value: string): asserts value is Utc {
  if (!UTC.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new ObjectStoreFailure("invalid_timestamp", "object timestamp is invalid");
  }
}

export function assertBundleMediaType(mediaType: string): void {
  if (mediaType.length > 127 || !SAFE_MEDIA_TYPE.test(mediaType)) {
    throw new ObjectStoreFailure("invalid_media_type", "BundleFile media type is not allowed");
  }
}

export function bundleMetadata(object: R2ListedObjectLike): Readonly<BundleFileObjectMetadata> {
  const custom = object.customMetadata ?? {};
  const digest = custom.sha256 ?? "";
  const createdAt = custom.createdAt ?? "";
  const protectedAt = custom.protectedAt ?? "";
  const mediaType = custom.mediaType ?? "";
  assertDigest(digest);
  assertUtc(createdAt);
  assertUtc(protectedAt);
  assertBundleMediaType(mediaType);
  if (
    custom.schema !== "md-r2-bundle-file-v1" ||
    ![ACTIVE_STATE, DELETE_STATE].includes(custom.state ?? ACTIVE_STATE) ||
    typeof custom.spaceId !== "string" || custom.spaceId.length === 0 ||
    !Number.isSafeInteger(Number(custom.size)) || Number(custom.size) < 0
  ) throw new ObjectStoreFailure("object_tampered", "R2 BundleFile metadata is invalid");
  return Object.freeze({
    spaceId: custom.spaceId as BundleFileObjectMetadata["spaceId"],
    sha256: digest,
    mediaType: mediaType as BundleFileObjectMetadata["mediaType"],
    size: Number(custom.size),
    createdAt,
    protectedAt,
  });
}

export function bundleCustomMetadata(
  metadata: Readonly<BundleFileObjectMetadata>,
  state = ACTIVE_STATE,
  deleteBoundary = "",
  integrityManifest?: Readonly<ObjectIntegrityManifest>,
  integrityDigest?: Digest,
): Readonly<Record<string, string>> {
  return Object.freeze({
    schema: "md-r2-bundle-file-v1",
    state,
    spaceId: metadata.spaceId,
    sha256: metadata.sha256,
    mediaType: metadata.mediaType,
    size: String(metadata.size),
    createdAt: metadata.createdAt,
    protectedAt: metadata.protectedAt,
    deleteBoundary,
    ...(integrityManifest === undefined ? {} : {
      integrityProofDigest: integrityDigest ?? "",
      integrityProofRoot: integrityManifest.root,
    }),
  });
}

export function stagedBundleMetadata(
  object: R2ListedObjectLike,
): Readonly<Omit<StagedBundleFileObject, "bytes">> {
  const custom = object.customMetadata ?? {};
  const createdAt = custom.createdAt ?? "";
  assertUtc(createdAt);
  const streamed = custom.schema === "md-r2-staged-bundle-file-stream-v1";
  if (
    (!streamed && custom.schema !== "md-r2-staged-bundle-file-v1") ||
    typeof custom.stagedFileId !== "string" || custom.stagedFileId.length === 0 ||
    typeof custom.bindingOwnerId !== "string" || custom.bindingOwnerId.length === 0 ||
    typeof custom.spaceId !== "string" || custom.spaceId.length === 0 ||
    (streamed
      ? !Number.isSafeInteger(Number(custom.maxBytes)) || Number(custom.maxBytes) < object.size
      : Number(custom.size) !== object.size)
  ) throw new ObjectStoreFailure("object_tampered", "staged BundleFile metadata is invalid");
  return Object.freeze({
    stagedFileId: custom.stagedFileId as StagedBundleFileObject["stagedFileId"],
    bindingOwnerId: custom.bindingOwnerId as StagedBundleFileObject["bindingOwnerId"],
    spaceId: custom.spaceId as StagedBundleFileObject["spaceId"],
    size: object.size,
    createdAt,
  });
}

export function archiveMetadata(
  objectKey: string,
  request: ExportArchiveWriteRequest,
  size: number,
): Readonly<StoredExportArchive> {
  const bundleProfile = request.archiveFormat === "MD-BUNDLE-ZIP-1";
  const archiveFormat = bundleProfile ? "MD-BUNDLE-ZIP-1" : "MD-OKF-ZIP-1";
  const filename = bundleProfile ? "mind-diary-bundle.zip" : "mind-diary-okf-bundle.zip";
  const contentDisposition = bundleProfile
    ? 'attachment; filename="mind-diary-bundle.zip"'
    : 'attachment; filename="mind-diary-okf-bundle.zip"';
  if (
    request.archiveFormat !== undefined && request.archiveFormat !== archiveFormat ||
    request.filename !== undefined && request.filename !== filename ||
    request.contentDisposition !== undefined && request.contentDisposition !== contentDisposition
  ) throw new ObjectStoreFailure("invalid_media_type", "export profile metadata is invalid");
  return Object.freeze({
    objectKey,
    jobId: request.jobId,
    spaceId: request.spaceId,
    claimVersion: request.claimVersion,
    archiveFormat,
    mediaType: "application/zip",
    filename,
    contentDisposition,
    sha256: request.sha256,
    size,
    createdAt: request.createdAt,
  });
}

export function archiveCustomMetadata(archive: Readonly<StoredExportArchive>): Readonly<Record<string, string>> {
  return Object.freeze({
    schema: "md-r2-export-v1",
    jobId: archive.jobId,
    spaceId: archive.spaceId,
    claimVersion: String(archive.claimVersion),
    sha256: archive.sha256,
    size: String(archive.size),
    archiveFormat: archive.archiveFormat,
    filename: archive.filename,
    createdAt: archive.createdAt,
  });
}
