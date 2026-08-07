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

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const UTC_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u;
const MARKDOWN_MEDIA_TYPE = "text/markdown; charset=utf-8";

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

export class InMemoryObjectStore implements ObjectStore, ExportArchiveStore {
  readonly kind = "object-store" as const;
  readonly #objects = new Map<string, StoredObject>();
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
      archiveFormat: "MD-OKF-ZIP-1" as const,
      mediaType: "application/zip" as const,
      filename: "mind-diary-okf-bundle.zip" as const,
      contentDisposition:
        'attachment; filename="mind-diary-okf-bundle.zip"' as const,
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

  #metadata(stored: StoredObject): Readonly<ImmutableObjectMetadata> {
    return Object.freeze({
      sha256: stored.sha256,
      mediaType: stored.mediaType,
      size: stored.size,
      createdAt: stored.createdAt,
      protectedAt: stored.protectedAt,
    });
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
