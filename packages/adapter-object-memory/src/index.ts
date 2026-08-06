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

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const UTC_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/u;
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

export class InMemoryObjectStore implements ObjectStore {
  readonly kind = "object-store" as const;
  readonly #objects = new Map<string, StoredObject>();
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
      if (Date.parse(request.createdAt) > Date.parse(existing.protectedAt)) {
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
    const cutoff = Date.parse(request.createdBefore);
    const objects = [...this.#objects.values()]
      .filter(
        (object) =>
          !excluded.has(object.sha256) && Date.parse(object.protectedAt) < cutoff,
      )
      .sort(
        (left, right) =>
          Date.parse(left.protectedAt) - Date.parse(right.protectedAt) ||
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
      Date.parse(stored.protectedAt) >= Date.parse(request.createdBefore)
    ) {
      return false;
    }
    return this.#objects.delete(request.sha256);
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
