import {
  ObjectStoreFailure,
  type ObjectStoreFailureCode,
  type ImmutableObject,
  type ImmutableObjectDeleteRequest,
  type ImmutableObjectListRequest,
  type ImmutableObjectMetadata,
  type ImmutableObjectPutResult,
  type ImmutableObjectWriteRequest,
  type ObjectStore,
  REVISION_MANIFEST_MEDIA_TYPE,
  type SpaceCanonicalObject,
  type SpaceCanonicalObjectMetadata,
  type SpaceCanonicalObjectPutResult,
  type SpaceCanonicalObjectWriteRequest,
  type SpaceCanonicalObjectListRequest,
  type SpaceCanonicalObjectDeleteRequest,
  type BundleFileObject,
  type BundleFileObjectMetadata,
  type BundleFileObjectPutResult,
  type BundleFileObjectStore,
  type BundleFileObjectWriteRequest,
  type BundleFileObjectListRequest,
  type BundleFileObjectDeleteRequest,
  type StagedBundleFileObject,
  type StagedBundleFileObjectWriteRequest,
  type ExportArchivePutResult,
  type ExportArchiveStore,
  type ExportArchiveWriteRequest,
  type StoredExportArchive,
} from "@mind-diary/application-ports";

export const OBJECT_ADAPTER = "memory-revision-envelope" as const;
export type ObjectAdapterContract = ObjectStore;

export type ObjectStoreIntegrityErrorCode = ObjectStoreFailureCode;

export class ObjectStoreIntegrityError extends ObjectStoreFailure {
  constructor(code: ObjectStoreIntegrityErrorCode, message: string) {
    super(code, message);
    this.name = "ObjectStoreIntegrityError";
  }
}

type Digest = ImmutableObjectMetadata["sha256"];
type Utc = ImmutableObjectMetadata["createdAt"];
type DigestComputer = (bytes: Uint8Array) => string | Promise<string>;

interface StoredObject extends Omit<ImmutableObjectMetadata, "protectedAt"> {
  protectedAt: Utc;
  bytes: Uint8Array;
}

interface StoredArchive {
  readonly metadata: Readonly<StoredExportArchive>;
  readonly bytes: Uint8Array;
}

interface StoredBundleFile extends BundleFileObjectMetadata {
  protectedAt: Utc;
  bytes: Uint8Array;
}

interface StoredSpaceCanonicalObject extends SpaceCanonicalObjectMetadata {
  protectedAt: Utc;
  bytes: Uint8Array;
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const UTC_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u;
const MARKDOWN_MEDIA_TYPE = "text/markdown; charset=utf-8";
const BUNDLE_FILE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/zip",
]);

function assertDigest(value: string): asserts value is Digest {
  if (!SHA256_PATTERN.test(value)) {
    throw new ObjectStoreIntegrityError(
      "invalid_digest",
      "object digest must be normalized SHA-256",
    );
  }
}

function assertUtc(value: string): asserts value is Utc {
  const match = UTC_PATTERN.exec(value);
  if (!match || !isCalendarUtc(match)) {
    throw new ObjectStoreIntegrityError(
      "invalid_timestamp",
      "object timestamps must be valid UTC instants",
    );
  }
}

function isCalendarUtc(match: RegExpExecArray): boolean {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1]!;
}

function utcOrderKey(value: Utc): string {
  const match = UTC_PATTERN.exec(value);
  if (!match) {
    throw new ObjectStoreIntegrityError(
      "invalid_timestamp",
      "object timestamps must be valid UTC instants",
    );
  }
  const fraction = (match[7] ?? "").padEnd(9, "0");
  return `${match[1]}${match[2]}${match[3]}${match[4]}${match[5]}${match[6]}${fraction}`;
}

function compareUtc(left: Utc, right: Utc): number {
  const leftKey = utcOrderKey(left);
  const rightKey = utcOrderKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function assertMarkdown(bytes: Uint8Array, mediaType: string): void {
  if (mediaType !== MARKDOWN_MEDIA_TYPE) {
    throw new ObjectStoreIntegrityError(
      "invalid_media_type",
      `canonical objects must use ${MARKDOWN_MEDIA_TYPE}`,
    );
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ObjectStoreIntegrityError(
      "invalid_utf8",
      "canonical Markdown object bytes must be valid UTF-8",
    );
  }
}

function assertBundleFileMediaType(mediaType: string): void {
  if (!BUNDLE_FILE_MEDIA_TYPES.has(mediaType)) {
    throw new ObjectStoreIntegrityError(
      "invalid_media_type",
      "opaque canonical object media type is not allowed",
    );
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function webCryptoSha256(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  input.set(bytes);
  const result = await crypto.subtle.digest("SHA-256", input.buffer);
  return `sha256:${[...new Uint8Array(result)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

export class InMemoryObjectStore implements BundleFileObjectStore, ExportArchiveStore {
  readonly kind = "object-store" as const;
  readonly #objects = new Map<string, StoredObject>();
  readonly #bundleFiles = new Map<string, StoredBundleFile>();
  readonly #spaceCanonicalObjects = new Map<string, StoredSpaceCanonicalObject>();
  readonly #stagedBundleFiles = new Map<string, StagedBundleFileObject>();
  readonly #exportArchives = new Map<string, StoredArchive>();
  readonly #digestComputer: DigestComputer;

  constructor(options: { readonly digestComputer?: DigestComputer } = {}) {
    this.#digestComputer = options.digestComputer ?? webCryptoSha256;
  }

  async calculateSha256(bytes: Uint8Array): Promise<Digest> {
    const digest = await this.#digestComputer(new Uint8Array(bytes));
    assertDigest(digest);
    return digest;
  }

  async putImmutable(
    request: ImmutableObjectWriteRequest,
  ): Promise<ImmutableObjectPutResult> {
    assertUtc(request.createdAt);
    assertMarkdown(request.bytes, request.mediaType);
    const bytes = new Uint8Array(request.bytes);
    const digest = await this.calculateSha256(bytes);
    const existing = this.#objects.get(digest);
    if (existing) {
      await this.#assertStoredIntegrity(existing);
      if (
        existing.mediaType !== request.mediaType ||
        !bytesEqual(existing.bytes, bytes)
      ) {
        throw new ObjectStoreIntegrityError(
          "digest_collision",
          "different immutable object bytes resolved to the same SHA-256 digest",
        );
      }
      if (compareUtc(request.createdAt, existing.protectedAt) > 0) {
        existing.protectedAt = request.createdAt;
      }
      return Object.freeze({
        object: this.#metadata(existing),
        status: "already_exists",
      });
    }

    const stored: StoredObject = {
      sha256: digest,
      mediaType: request.mediaType,
      size: bytes.byteLength,
      createdAt: request.createdAt,
      protectedAt: request.createdAt,
      bytes,
    };
    this.#objects.set(digest, stored);
    return Object.freeze({ object: this.#metadata(stored), status: "stored" });
  }

  async getImmutable(digest: Digest): Promise<Readonly<ImmutableObject> | null> {
    assertDigest(digest);
    const stored = this.#objects.get(digest);
    if (!stored) return null;
    await this.#assertStoredIntegrity(stored);
    return Object.freeze({ ...this.#metadata(stored), bytes: new Uint8Array(stored.bytes) });
  }

  async putSpaceCanonicalObject(
    request: SpaceCanonicalObjectWriteRequest,
  ): Promise<SpaceCanonicalObjectPutResult> {
    assertUtc(request.createdAt);
    if (typeof request.spaceId !== "string" || request.spaceId.length === 0) {
      throw new TypeError("canonical object Space ID is required");
    }
    if (request.kind === "markdown") {
      assertMarkdown(request.bytes, request.mediaType);
    } else if (request.mediaType !== REVISION_MANIFEST_MEDIA_TYPE) {
      throw new ObjectStoreIntegrityError(
        "invalid_media_type",
        "revision manifest object media type is invalid",
      );
    }
    const bytes = new Uint8Array(request.bytes);
    if (request.kind === "revision_manifest") {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new ObjectStoreIntegrityError("invalid_utf8", "revision manifest is not UTF-8");
      }
    }
    const digest = await this.calculateSha256(bytes);
    const key = `${request.kind}:${request.spaceId}:${digest}`;
    const existing = this.#spaceCanonicalObjects.get(key);
    if (existing) {
      await this.#assertSpaceCanonicalIntegrity(existing);
      if (existing.mediaType !== request.mediaType || !bytesEqual(existing.bytes, bytes)) {
        throw new ObjectStoreIntegrityError(
          "digest_collision",
          "different Space-scoped canonical bytes resolved to one digest",
        );
      }
      if (compareUtc(request.createdAt, existing.protectedAt) > 0) {
        existing.protectedAt = request.createdAt;
      }
      return Object.freeze({ object: this.#spaceCanonicalMetadata(existing), status: "already_exists" });
    }
    const stored: StoredSpaceCanonicalObject = {
      kind: request.kind,
      spaceId: request.spaceId,
      sha256: digest,
      mediaType: request.mediaType,
      size: bytes.byteLength,
      createdAt: request.createdAt,
      protectedAt: request.createdAt,
      bytes,
    };
    this.#spaceCanonicalObjects.set(key, stored);
    return Object.freeze({ object: this.#spaceCanonicalMetadata(stored), status: "stored" });
  }

  async getSpaceCanonicalObject(
    kind: SpaceCanonicalObjectMetadata["kind"],
    spaceId: SpaceCanonicalObjectMetadata["spaceId"],
    digest: Digest,
  ): Promise<Readonly<SpaceCanonicalObject> | null> {
    assertDigest(digest);
    const stored = this.#spaceCanonicalObjects.get(`${kind}:${spaceId}:${digest}`);
    if (!stored) return null;
    await this.#assertSpaceCanonicalIntegrity(stored);
    return Object.freeze({
      ...this.#spaceCanonicalMetadata(stored),
      bytes: new Uint8Array(stored.bytes),
    });
  }

  async listSpaceCanonicalObjects(
    request: SpaceCanonicalObjectListRequest,
  ): Promise<readonly Readonly<SpaceCanonicalObjectMetadata>[]> {
    assertUtc(request.createdBefore);
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
      throw new ObjectStoreIntegrityError("invalid_limit", "canonical object list limit is invalid");
    }
    const excluded = new Set(request.excluded.map(
      (item) => `${item.kind}:${item.spaceId}:${item.sha256}`,
    ));
    return Object.freeze([...this.#spaceCanonicalObjects.entries()]
      .filter(([key, item]) =>
        (request.spaceId === undefined || item.spaceId === request.spaceId) &&
        !excluded.has(key) && compareUtc(item.protectedAt, request.createdBefore) < 0)
      .sort(([, left], [, right]) =>
        compareUtc(left.protectedAt, right.protectedAt) ||
        left.kind.localeCompare(right.kind) ||
        left.spaceId.localeCompare(right.spaceId) ||
        left.sha256.localeCompare(right.sha256))
      .slice(0, request.limit)
      .map(([, item]) => this.#spaceCanonicalMetadata(item)));
  }

  async deleteSpaceCanonicalObject(
    request: SpaceCanonicalObjectDeleteRequest,
  ): Promise<boolean> {
    assertDigest(request.sha256);
    assertUtc(request.createdBefore);
    assertUtc(request.expectedProtectedAt);
    const key = `${request.kind}:${request.spaceId}:${request.sha256}`;
    const stored = this.#spaceCanonicalObjects.get(key);
    if (
      !stored || stored.protectedAt !== request.expectedProtectedAt ||
      compareUtc(stored.protectedAt, request.createdBefore) >= 0
    ) return false;
    return this.#spaceCanonicalObjects.delete(key);
  }

  async putBundleFile(
    request: BundleFileObjectWriteRequest,
  ): Promise<BundleFileObjectPutResult> {
    assertUtc(request.createdAt);
    assertBundleFileMediaType(request.mediaType);
    if (typeof request.spaceId !== "string" || request.spaceId.length === 0) {
      throw new TypeError("BundleFile Space ID is required");
    }
    const bytes = new Uint8Array(request.bytes);
    const digest = await this.calculateSha256(bytes);
    const key = `${request.spaceId}:${digest}`;
    const existing = this.#bundleFiles.get(key);
    if (existing) {
      if (
        existing.mediaType !== request.mediaType ||
        !bytesEqual(existing.bytes, bytes)
      ) {
        throw new ObjectStoreIntegrityError(
          "digest_collision",
          "different Space-scoped BundleFile bytes resolved to one digest",
        );
      }
      if (compareUtc(request.createdAt, existing.protectedAt) > 0) {
        existing.protectedAt = request.createdAt;
      }
      return Object.freeze({
        object: this.#bundleMetadata(existing),
        status: "already_exists",
      });
    }
    const stored: StoredBundleFile = {
      spaceId: request.spaceId,
      sha256: digest,
      mediaType: request.mediaType,
      size: bytes.byteLength,
      createdAt: request.createdAt,
      protectedAt: request.createdAt,
      bytes,
    };
    this.#bundleFiles.set(key, stored);
    return Object.freeze({ object: this.#bundleMetadata(stored), status: "stored" });
  }

  async getBundleFile(
    spaceId: BundleFileObjectMetadata["spaceId"],
    digest: Digest,
  ): Promise<Readonly<BundleFileObject> | null> {
    assertDigest(digest);
    const stored = this.#bundleFiles.get(`${spaceId}:${digest}`);
    if (!stored) return null;
    const actual = await this.calculateSha256(stored.bytes);
    if (actual !== digest || stored.size !== stored.bytes.byteLength) {
      throw new ObjectStoreIntegrityError("object_tampered", "BundleFile bytes are invalid");
    }
    return Object.freeze({
      ...this.#bundleMetadata(stored),
      bytes: new Uint8Array(stored.bytes),
    });
  }

  async listBundleFileObjects(
    request: BundleFileObjectListRequest,
  ): Promise<readonly Readonly<BundleFileObjectMetadata>[]> {
    assertUtc(request.createdBefore);
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
      throw new ObjectStoreIntegrityError("invalid_limit", "BundleFile list limit is invalid");
    }
    const excluded = new Set(
      request.excluded.map((item) => `${item.spaceId}:${item.sha256}`),
    );
    return Object.freeze([...this.#bundleFiles.entries()]
      .filter(([, item]) =>
        !excluded.has(`${item.spaceId}:${item.sha256}`) &&
        compareUtc(item.protectedAt, request.createdBefore) < 0)
      .sort(([, left], [, right]) =>
        compareUtc(left.protectedAt, right.protectedAt) ||
        left.spaceId.localeCompare(right.spaceId) ||
        left.sha256.localeCompare(right.sha256))
      .slice(0, request.limit)
      .map(([, item]) => this.#bundleMetadata(item)));
  }

  async deleteBundleFileObject(
    request: BundleFileObjectDeleteRequest,
  ): Promise<boolean> {
    assertDigest(request.sha256);
    assertUtc(request.createdBefore);
    assertUtc(request.expectedProtectedAt);
    const key = `${request.spaceId}:${request.sha256}`;
    const stored = this.#bundleFiles.get(key);
    if (
      !stored || stored.protectedAt !== request.expectedProtectedAt ||
      compareUtc(stored.protectedAt, request.createdBefore) >= 0
    ) return false;
    return this.#bundleFiles.delete(key);
  }

  async putStagedBundleFile(
    request: StagedBundleFileObjectWriteRequest,
  ): Promise<Readonly<StagedBundleFileObject>> {
    assertUtc(request.createdAt);
    if (
      typeof request.stagedFileId !== "string" || request.stagedFileId.length === 0 ||
      typeof request.bindingOwnerId !== "string" || request.bindingOwnerId.length === 0 ||
      typeof request.spaceId !== "string" || request.spaceId.length === 0
    ) throw new TypeError("staged BundleFile identity is invalid");
    const existing = this.#stagedBundleFiles.get(request.stagedFileId);
    const candidate = Object.freeze({
      stagedFileId: request.stagedFileId,
      bindingOwnerId: request.bindingOwnerId,
      spaceId: request.spaceId,
      bytes: new Uint8Array(request.bytes),
      size: request.bytes.byteLength,
      createdAt: request.createdAt,
    });
    if (existing) {
      if (
        existing.bindingOwnerId !== candidate.bindingOwnerId ||
        existing.spaceId !== candidate.spaceId ||
        !bytesEqual(existing.bytes, candidate.bytes)
      ) throw new ObjectStoreIntegrityError("digest_collision", "staged BundleFile ID collision");
      return Object.freeze({ ...existing, bytes: new Uint8Array(existing.bytes) });
    }
    this.#stagedBundleFiles.set(request.stagedFileId, candidate);
    return candidate;
  }

  async getStagedBundleFile(
    stagedFileId: string,
  ): Promise<Readonly<StagedBundleFileObject> | null> {
    const stored = this.#stagedBundleFiles.get(stagedFileId);
    return stored === undefined
      ? null
      : Object.freeze({ ...stored, bytes: new Uint8Array(stored.bytes) });
  }

  async deleteStagedBundleFile(stagedFileId: string): Promise<boolean> {
    return this.#stagedBundleFiles.delete(stagedFileId);
  }

  async listImmutableObjects(
    request: ImmutableObjectListRequest,
  ): Promise<readonly Readonly<ImmutableObjectMetadata>[]> {
    assertUtc(request.createdBefore);
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
      throw new ObjectStoreIntegrityError(
        "invalid_limit",
        "object list limit must be a positive safe integer",
      );
    }
    const excluded = new Set<string>();
    for (const digest of request.excludedDigests) {
      assertDigest(digest);
      excluded.add(digest);
    }
    const objects = [...this.#objects.values()]
      .filter(
        (object) =>
          !excluded.has(object.sha256) &&
          compareUtc(object.protectedAt, request.createdBefore) < 0,
      )
      .sort(
        (left, right) =>
          compareUtc(left.protectedAt, right.protectedAt) ||
          left.sha256.localeCompare(right.sha256),
      )
      .slice(0, request.limit)
      .map((object) => this.#metadata(object));
    return Object.freeze(objects);
  }

  async deleteImmutableObject(
    request: ImmutableObjectDeleteRequest,
  ): Promise<boolean> {
    assertDigest(request.sha256);
    assertUtc(request.createdBefore);
    assertUtc(request.expectedProtectedAt);
    const stored = this.#objects.get(request.sha256);
    if (!stored) return false;
    if (
      stored.protectedAt !== request.expectedProtectedAt ||
      compareUtc(stored.protectedAt, request.createdBefore) >= 0
    ) {
      return false;
    }
    return this.#objects.delete(request.sha256);
  }

  async putExportArchive(
    request: ExportArchiveWriteRequest,
  ): Promise<ExportArchivePutResult> {
    assertUtc(request.createdAt);
    if (
      typeof request.jobId !== "string" ||
      request.jobId.length === 0 ||
      request.jobId.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(request.jobId) ||
      typeof request.spaceId !== "string" ||
      request.spaceId.length === 0 ||
      request.spaceId.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(request.spaceId) ||
      !Number.isSafeInteger(request.claimVersion) ||
      request.claimVersion < 1
    ) {
      return Object.freeze({ kind: "object_key_collision" });
    }
    assertDigest(request.sha256);
    const bytes = new Uint8Array(request.bytes);
    const bundleProfile = request.archiveFormat === "MD-BUNDLE-ZIP-1";
    const archiveFormat = bundleProfile ? "MD-BUNDLE-ZIP-1" : "MD-OKF-ZIP-1";
    const filename = bundleProfile ? "mind-diary-bundle.zip" : "mind-diary-okf-bundle.zip";
    const contentDisposition = bundleProfile
      ? 'attachment; filename="mind-diary-bundle.zip"'
      : 'attachment; filename="mind-diary-okf-bundle.zip"';
    if (
      (request.archiveFormat !== undefined && request.archiveFormat !== archiveFormat) ||
      (request.filename !== undefined && request.filename !== filename) ||
      (request.contentDisposition !== undefined && request.contentDisposition !== contentDisposition)
    ) return Object.freeze({ kind: "object_key_collision" });
    const actual = await this.calculateSha256(bytes);
    if (actual !== request.sha256) {
      return Object.freeze({ kind: "digest_mismatch" });
    }
    const objectKey = `exports/${encodeURIComponent(request.spaceId)}/${encodeURIComponent(
      request.jobId,
    )}/claim-${request.claimVersion}`;
    const existing = this.#exportArchives.get(objectKey);
    if (existing) {
      const same =
        existing.metadata.sha256 === actual &&
        existing.metadata.size === bytes.byteLength &&
        existing.metadata.archiveFormat === archiveFormat &&
        existing.metadata.filename === filename &&
        bytesEqual(existing.bytes, bytes);
      return same
        ? Object.freeze({
            kind: "already_exists",
            archive: Object.freeze({ ...existing.metadata }),
          })
        : Object.freeze({ kind: "object_key_collision" });
    }
    const metadata = Object.freeze({
      objectKey,
      jobId: request.jobId,
      spaceId: request.spaceId,
      claimVersion: request.claimVersion,
      archiveFormat,
      mediaType: "application/zip" as const,
      filename,
      contentDisposition,
      sha256: actual,
      size: bytes.byteLength,
      createdAt: request.createdAt,
    });
    this.#exportArchives.set(objectKey, { metadata, bytes });
    return Object.freeze({ kind: "stored", archive: metadata });
  }

  async readExportArchive(objectKey: string): Promise<Uint8Array | null> {
    const stored = this.#exportArchives.get(objectKey);
    if (!stored) return null;
    const actual = await this.calculateSha256(stored.bytes);
    if (
      actual !== stored.metadata.sha256 ||
      stored.bytes.byteLength !== stored.metadata.size
    ) {
      throw new ObjectStoreIntegrityError(
        "object_tampered",
        "stored export archive no longer matches its digest and size",
      );
    }
    return new Uint8Array(stored.bytes);
  }

  async deleteExportArchive(objectKey: string): Promise<boolean> {
    return this.#exportArchives.delete(objectKey);
  }

  async deleteExportArchivesForJob(
    jobId: ExportArchiveWriteRequest["jobId"],
  ): Promise<number> {
    const keys = [...this.#exportArchives]
      .filter(([, archive]) => archive.metadata.jobId === jobId)
      .map(([key]) => key);
    keys.forEach((key) => this.#exportArchives.delete(key));
    return keys.length;
  }

  async deleteExportArchivesForSpace(
    spaceId: ExportArchiveWriteRequest["spaceId"],
  ): Promise<number> {
    const keys = [...this.#exportArchives]
      .filter(([, archive]) => archive.metadata.spaceId === spaceId)
      .map(([key]) => key);
    keys.forEach((key) => this.#exportArchives.delete(key));
    return keys.length;
  }

  async listExportArchivesForTest(): Promise<readonly Readonly<StoredExportArchive>[]> {
    return Object.freeze(
      [...this.#exportArchives.values()].map((archive) =>
        Object.freeze({ ...archive.metadata }),
      ),
    );
  }

  /** Deliberate corruption hook for integrity tests of this in-memory adapter. */
  corruptBytesForTest(digest: Digest, bytes: Uint8Array): void {
    assertDigest(digest);
    const stored = this.#objects.get(digest);
    if (!stored) throw new Error("cannot corrupt a missing fixture object");
    stored.bytes = new Uint8Array(bytes);
  }

  /** Deliberate v3 corruption hook for exact-manifest/object integrity tests. */
  corruptSpaceCanonicalBytesForTest(
    kind: SpaceCanonicalObjectMetadata["kind"],
    spaceId: SpaceCanonicalObjectMetadata["spaceId"],
    digest: Digest,
    bytes: Uint8Array,
  ): void {
    assertDigest(digest);
    const stored = this.#spaceCanonicalObjects.get(`${kind}:${spaceId}:${digest}`);
    if (!stored) throw new Error("cannot corrupt a missing Space canonical fixture object");
    stored.bytes = new Uint8Array(bytes);
  }

  #metadata(stored: StoredObject): Readonly<ImmutableObjectMetadata> {
    return Object.freeze({
      sha256: stored.sha256,
      mediaType: stored.mediaType,
      size: stored.size,
      createdAt: stored.createdAt,
      protectedAt: stored.protectedAt,
    });
  }

  #bundleMetadata(
    stored: StoredBundleFile,
  ): Readonly<BundleFileObjectMetadata> {
    return Object.freeze({
      spaceId: stored.spaceId,
      sha256: stored.sha256,
      mediaType: stored.mediaType,
      size: stored.size,
      createdAt: stored.createdAt,
      protectedAt: stored.protectedAt,
    });
  }

  #spaceCanonicalMetadata(
    stored: StoredSpaceCanonicalObject,
  ): Readonly<SpaceCanonicalObjectMetadata> {
    return Object.freeze({
      kind: stored.kind,
      spaceId: stored.spaceId,
      sha256: stored.sha256,
      mediaType: stored.mediaType,
      size: stored.size,
      createdAt: stored.createdAt,
      protectedAt: stored.protectedAt,
    });
  }

  async #assertSpaceCanonicalIntegrity(stored: StoredSpaceCanonicalObject): Promise<void> {
    try {
      if (stored.kind === "markdown") assertMarkdown(stored.bytes, stored.mediaType);
      else if (stored.mediaType !== REVISION_MANIFEST_MEDIA_TYPE) throw new Error("media");
    } catch {
      throw new ObjectStoreIntegrityError("object_tampered", "Space canonical object is invalid");
    }
    const actual = await this.calculateSha256(stored.bytes);
    if (actual !== stored.sha256 || stored.bytes.byteLength !== stored.size) {
      throw new ObjectStoreIntegrityError("object_tampered", "Space canonical bytes are invalid");
    }
  }

  async #assertStoredIntegrity(stored: StoredObject): Promise<void> {
    try {
      assertMarkdown(stored.bytes, stored.mediaType);
    } catch {
      throw new ObjectStoreIntegrityError(
        "object_tampered",
        "stored immutable object media or bytes are invalid",
      );
    }
    const actual = await this.calculateSha256(stored.bytes);
    if (actual !== stored.sha256 || stored.bytes.byteLength !== stored.size) {
      throw new ObjectStoreIntegrityError(
        "object_tampered",
        "stored immutable object no longer matches its digest and size",
      );
    }
  }
}
