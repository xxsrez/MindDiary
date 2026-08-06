import type {
  ImmutableObject,
  ImmutableObjectDeleteRequest,
  ImmutableObjectListRequest,
  ImmutableObjectMetadata,
  ImmutableObjectPutResult,
  ImmutableObjectWriteRequest,
  ObjectStore,
} from "@mind-diary/application-ports";

export const OBJECT_ADAPTER = "memory-revision-envelope" as const;
export type ObjectAdapterContract = ObjectStore;

export type ObjectStoreIntegrityErrorCode =
  | "invalid_digest"
  | "invalid_media_type"
  | "invalid_utf8"
  | "invalid_timestamp"
  | "invalid_limit"
  | "digest_collision"
  | "object_tampered";

export class ObjectStoreIntegrityError extends Error {
  readonly code: ObjectStoreIntegrityErrorCode;

  constructor(code: ObjectStoreIntegrityErrorCode, message: string) {
    super(message);
    this.name = "ObjectStoreIntegrityError";
    this.code = code;
  }
}

type Digest = ImmutableObjectMetadata["sha256"];
type Utc = ImmutableObjectMetadata["createdAt"];
type DigestComputer = (bytes: Uint8Array) => string | Promise<string>;

interface StoredObject extends ImmutableObjectMetadata {
  bytes: Uint8Array;
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
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
  if (!UTC_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new ObjectStoreIntegrityError(
      "invalid_timestamp",
      "object timestamps must be valid UTC instants",
    );
  }
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
    const cutoff = Date.parse(request.createdBefore);
    const objects = [...this.#objects.values()]
      .filter((object) => Date.parse(object.createdAt) < cutoff)
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
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
    const stored = this.#objects.get(request.sha256);
    if (!stored) return false;
    if (Date.parse(stored.createdAt) >= Date.parse(request.createdBefore)) {
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
    });
  }

  async #assertStoredIntegrity(stored: StoredObject): Promise<void> {
    assertMarkdown(stored.bytes, stored.mediaType);
    const actual = await this.calculateSha256(stored.bytes);
    if (actual !== stored.sha256 || stored.bytes.byteLength !== stored.size) {
      throw new ObjectStoreIntegrityError(
        "object_tampered",
        "stored immutable object no longer matches its digest and size",
      );
    }
  }
}
