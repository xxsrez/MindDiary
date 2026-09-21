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
  type OpenedSpaceCanonicalObject,
  OBJECT_INTEGRITY_CHUNK_SIZE,
  OBJECT_INTEGRITY_PROOF_SCHEMA,
  objectIntegrityLeafInput,
  objectIntegrityNodeInput,
  type SpaceCanonicalObjectMetadata,
  type SpaceCanonicalObjectPutResult,
  type SpaceCanonicalObjectWriteRequest,
  type SpaceCanonicalObjectListRequest,
  type SpaceCanonicalObjectDeleteRequest,
  type BundleFileObject,
  type OpenedBundleFileObject,
  type ObjectIntegrityManifest,
  type ObjectIntegrityRangeProof,
  type ObjectIntegrityKind,
  type BundleFileObjectMetadata,
  type BundleFileObjectPutResult,
  type BundleFileObjectStore,
  type BundleFileObjectWriteRequest,
  type BundleFileObjectListRequest,
  type BundleFileObjectDeleteRequest,
  type StagedBundleFileObject,
  type OpenedStagedBundleFileObject,
  type PromoteStagedBundleFileRequest,
  type StagedBundleFileObjectWriteRequest,
  type StagedBundleFileUpload,
  type StagedBundleFileUploadRequest,
  type ExportArchivePutResult,
  type ExportArchiveStore,
  type ExportArchiveUpload,
  type ExportArchiveUploadRequest,
  type ExportArchiveWriteRequest,
  type OpenedExportArchive,
  type StoredExportArchive,
  type BoundedObjectCleanupStore,
  type ObjectCleanupCandidate,
  type ObjectCleanupNamespace,
  type ObjectCleanupPage,
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
  integrityManifest: Readonly<ObjectIntegrityManifest>;
}

interface StoredSpaceCanonicalObject extends SpaceCanonicalObjectMetadata {
  protectedAt: Utc;
  bytes: Uint8Array;
  integrityManifest: Readonly<ObjectIntegrityManifest>;
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const UTC_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u;
const MARKDOWN_MEDIA_TYPE = "text/markdown; charset=utf-8";
const SAFE_MEDIA_TYPE = /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/u;

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
  if (mediaType.length > 127 || !SAFE_MEDIA_TYPE.test(mediaType)) {
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

const integrityEncoder = new TextEncoder();

async function merkleRoot(
  calculate: (bytes: Uint8Array) => Promise<Digest>,
  proof: Pick<ObjectIntegrityManifest, "schema" | "spaceId" | "kind" | "size" | "sha256" | "chunkSize">,
  chunkDigests: readonly Digest[],
): Promise<Digest> {
  if (chunkDigests.length === 0) {
    return calculate(integrityEncoder.encode([
      OBJECT_INTEGRITY_PROOF_SCHEMA,
      "empty",
      proof.spaceId,
      proof.kind,
      String(proof.size),
      proof.sha256,
      String(proof.chunkSize),
    ].join("\n") + "\n"));
  }
  let level = await Promise.all(chunkDigests.map((digest, index) => calculate(
    integrityEncoder.encode(objectIntegrityLeafInput(
      proof,
      index,
      index * proof.chunkSize,
      Math.min(proof.chunkSize, proof.size - index * proof.chunkSize),
      digest,
    )),
  )));
  while (level.length > 1) {
    const next: Digest[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]!;
      const right = level[index + 1] ?? left;
      next.push(await calculate(integrityEncoder.encode(objectIntegrityNodeInput(left, right))));
    }
    level = next;
  }
  return level[0]!;
}

async function buildIntegrityManifest(
  calculate: (bytes: Uint8Array) => Promise<Digest>,
  spaceId: string,
  kind: ObjectIntegrityKind,
  bytes: Uint8Array,
  sha256: Digest,
): Promise<Readonly<ObjectIntegrityManifest>> {
  const chunkDigests: Digest[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += OBJECT_INTEGRITY_CHUNK_SIZE) {
    chunkDigests.push(await calculate(bytes.slice(offset, offset + OBJECT_INTEGRITY_CHUNK_SIZE)));
  }
  const base = {
    schema: OBJECT_INTEGRITY_PROOF_SCHEMA,
    spaceId: spaceId as ObjectIntegrityManifest["spaceId"],
    kind,
    size: bytes.byteLength,
    sha256,
    chunkSize: OBJECT_INTEGRITY_CHUNK_SIZE,
    chunkCount: chunkDigests.length,
  } as const;
  return Object.freeze({
    ...base,
    root: await merkleRoot(calculate, base, chunkDigests),
    chunkDigests: Object.freeze(chunkDigests),
  });
}

function alignedRange(
  manifest: Readonly<ObjectIntegrityManifest>,
  requested: Readonly<{ offset: number; length: number }>,
): Readonly<{ offset: number; length: number }> {
  const start = Math.floor(requested.offset / manifest.chunkSize) * manifest.chunkSize;
  const end = Math.min(
    manifest.size,
    Math.ceil((requested.offset + requested.length) / manifest.chunkSize) * manifest.chunkSize,
  );
  return Object.freeze({ offset: start, length: end - start });
}

async function rangeProof(
  calculate: (bytes: Uint8Array) => Promise<Digest>,
  manifest: Readonly<ObjectIntegrityManifest>,
  requested: Readonly<{ offset: number; length: number }>,
): Promise<Readonly<ObjectIntegrityRangeProof>> {
  const first = Math.floor(requested.offset / manifest.chunkSize);
  const last = Math.floor((requested.offset + requested.length - 1) / manifest.chunkSize);
  let level = await Promise.all(manifest.chunkDigests.map((digest, index) => calculate(
    integrityEncoder.encode(objectIntegrityLeafInput(
      manifest,
      index,
      index * manifest.chunkSize,
      Math.min(manifest.chunkSize, manifest.size - index * manifest.chunkSize),
      digest,
    )),
  )));
  const levels: Digest[][] = [level];
  while (level.length > 1) {
    const next: Digest[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]!;
      const right = level[index + 1] ?? left;
      next.push(await calculate(integrityEncoder.encode(objectIntegrityNodeInput(left, right))));
    }
    levels.push(next);
    level = next;
  }
  const paths = new Map<number, Digest[]>();
  for (let index = first; index <= last; index += 1) {
    const siblings: Digest[] = [];
    let position = index;
    for (let levelIndex = 0; levelIndex < levels.length - 1; levelIndex += 1) {
      const current = levels[levelIndex]!;
      const sibling = position % 2 === 0 ? position + 1 : position - 1;
      siblings.push(current[sibling] ?? current[position]!);
      position = Math.floor(position / 2);
    }
    paths.set(index, siblings);
  }
  return Object.freeze({
    schema: manifest.schema,
    spaceId: manifest.spaceId,
    kind: manifest.kind,
    size: manifest.size,
    sha256: manifest.sha256,
    chunkSize: manifest.chunkSize,
    chunkCount: manifest.chunkCount,
    root: manifest.root,
    chunks: Object.freeze(Array.from(paths, ([index, siblings]) => Object.freeze({
      index,
      offset: index * manifest.chunkSize,
      length: Math.min(manifest.chunkSize, manifest.size - index * manifest.chunkSize),
      sha256: manifest.chunkDigests[index]!,
      siblings: Object.freeze(siblings),
    }))),
  });
}

export class InMemoryObjectStore implements BundleFileObjectStore, ExportArchiveStore, BoundedObjectCleanupStore {
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
      integrityManifest: await buildIntegrityManifest(
        (candidate) => this.calculateSha256(candidate),
        request.spaceId,
        request.kind,
        bytes,
        digest,
      ),
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

  async openSpaceCanonicalObject(
    kind: SpaceCanonicalObjectMetadata["kind"],
    spaceId: SpaceCanonicalObjectMetadata["spaceId"],
    digest: Digest,
  ): Promise<Readonly<OpenedSpaceCanonicalObject> | null> {
    const object = await this.getSpaceCanonicalObject(kind, spaceId, digest);
    if (object === null) return null;
    const bytes = new Uint8Array(object.bytes);
    return Object.freeze({
      ...this.#spaceCanonicalMetadata(object as StoredSpaceCanonicalObject),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    });
  }

  async openSpaceCanonicalObjectRange(
    kind: SpaceCanonicalObjectMetadata["kind"],
    spaceId: SpaceCanonicalObjectMetadata["spaceId"],
    digest: Digest,
    range: Readonly<{ offset: number; length: number }>,
  ): Promise<Readonly<OpenedSpaceCanonicalObject> | null> {
    if (
      !Number.isSafeInteger(range.offset) || range.offset < 0 ||
      !Number.isSafeInteger(range.length) || range.length < 1
    ) throw new ObjectStoreIntegrityError("invalid_range", "canonical object range is invalid");
    const stored = this.#spaceCanonicalObjects.get(`${kind}:${spaceId}:${digest}`);
    if (stored === undefined) return null;
    await this.#assertIntegrityManifest(stored.integrityManifest, {
      spaceId: stored.spaceId,
      kind: stored.kind,
      sha256: stored.sha256,
      size: stored.size,
    });
    if (range.offset + range.length > stored.size) {
      throw new ObjectStoreIntegrityError("invalid_range", "canonical object range is invalid");
    }
    const aligned = alignedRange(stored.integrityManifest, range);
    const proof = await rangeProof(
      (candidate) => this.calculateSha256(candidate),
      stored.integrityManifest,
      range,
    );
    for (const chunk of proof.chunks) {
      const actual = await this.calculateSha256(
        stored.bytes.slice(chunk.offset, chunk.offset + chunk.length),
      );
      if (actual !== chunk.sha256) {
        throw new ObjectStoreIntegrityError("object_tampered", "canonical object chunk is invalid");
      }
    }
    const bytes = stored.bytes.slice(aligned.offset, aligned.offset + aligned.length);
    return Object.freeze({
      ...this.#spaceCanonicalMetadata(stored),
      integrityProof: proof,
      range: aligned,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
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
      await this.#assertBundleFileIntegrity(existing);
      if (!bytesEqual(existing.bytes, bytes)) {
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
      integrityManifest: await buildIntegrityManifest(
        (candidate) => this.calculateSha256(candidate),
        request.spaceId,
        "bundle_file",
        bytes,
        digest,
      ),
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
    await this.#assertBundleFileIntegrity(stored);
    const actual = await this.calculateSha256(stored.bytes);
    if (actual !== digest || stored.size !== stored.bytes.byteLength) {
      throw new ObjectStoreIntegrityError("object_tampered", "BundleFile bytes are invalid");
    }
    return Object.freeze({
      ...this.#bundleMetadata(stored),
      bytes: new Uint8Array(stored.bytes),
    });
  }

  async openBundleFile(
    spaceId: BundleFileObjectMetadata["spaceId"],
    digest: Digest,
  ): Promise<Readonly<OpenedBundleFileObject> | null> {
    const object = await this.getBundleFile(spaceId, digest);
    if (object === null) return null;
    const bytes = new Uint8Array(object.bytes);
    return Object.freeze({
      ...this.#bundleMetadata(object as StoredBundleFile),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    });
  }

  async openBundleFileRange(
    spaceId: BundleFileObjectMetadata["spaceId"],
    digest: Digest,
    range: Readonly<{ offset: number; length: number }>,
  ): Promise<Readonly<OpenedBundleFileObject> | null> {
    if (
      !Number.isSafeInteger(range.offset) || range.offset < 0 ||
      !Number.isSafeInteger(range.length) || range.length < 1
    ) throw new ObjectStoreIntegrityError("invalid_range", "BundleFile range is invalid");
    const stored = this.#bundleFiles.get(`${spaceId}:${digest}`);
    if (stored === undefined) return null;
    await this.#assertIntegrityManifest(stored.integrityManifest, {
      spaceId: stored.spaceId,
      kind: "bundle_file",
      sha256: stored.sha256,
      size: stored.size,
    });
    if (range.offset + range.length > stored.size) {
      throw new ObjectStoreIntegrityError("invalid_range", "BundleFile range is invalid");
    }
    const aligned = alignedRange(stored.integrityManifest, range);
    const proof = await rangeProof(
      (candidate) => this.calculateSha256(candidate),
      stored.integrityManifest,
      range,
    );
    for (const chunk of proof.chunks) {
      const actual = await this.calculateSha256(
        stored.bytes.slice(chunk.offset, chunk.offset + chunk.length),
      );
      if (actual !== chunk.sha256) {
        throw new ObjectStoreIntegrityError("object_tampered", "BundleFile chunk is invalid");
      }
    }
    const bytes = stored.bytes.slice(aligned.offset, aligned.offset + aligned.length);
    return Object.freeze({
      ...this.#bundleMetadata(stored),
      integrityProof: proof,
      range: aligned,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
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

  async beginStagedBundleFileUpload(
    request: Readonly<StagedBundleFileUploadRequest>,
  ): Promise<StagedBundleFileUpload> {
    assertUtc(request.createdAt);
    if (
      typeof request.stagedFileId !== "string" || request.stagedFileId.length === 0 ||
      typeof request.bindingOwnerId !== "string" || request.bindingOwnerId.length === 0 ||
      typeof request.spaceId !== "string" || request.spaceId.length === 0 ||
      !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 0
    ) throw new ObjectStoreIntegrityError("invalid_limit", "staged upload request is invalid");
    const chunks: Uint8Array[] = [];
    let size = 0;
    let closed = false;
    const close = (): void => {
      closed = true;
      chunks.length = 0;
    };
    return Object.freeze({
      write: async (chunk: Uint8Array) => {
        if (closed) throw new Error("staged upload is closed");
        if (!(chunk instanceof Uint8Array)) throw new TypeError("staged chunk must be bytes");
        if (size + chunk.byteLength > request.maxBytes) {
          close();
          throw new ObjectStoreIntegrityError(
            "invalid_limit",
            "staged upload exceeds its configured byte limit",
          );
        }
        size += chunk.byteLength;
        chunks.push(new Uint8Array(chunk));
      },
      complete: async (
        completion: Parameters<StagedBundleFileUpload["complete"]>[0],
      ) => {
        if (closed) throw new Error("staged upload is closed");
        if (!Number.isSafeInteger(completion.size) || completion.size !== size) {
          close();
          throw new ObjectStoreIntegrityError("object_tampered", "staged upload size mismatch");
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const actual = await this.calculateSha256(bytes);
        if (actual !== completion.sha256) {
          close();
          throw new ObjectStoreIntegrityError("object_tampered", "staged upload digest mismatch");
        }
        closed = true;
        chunks.length = 0;
        return this.putStagedBundleFile({
          stagedFileId: request.stagedFileId,
          bindingOwnerId: request.bindingOwnerId,
          spaceId: request.spaceId,
          bytes,
          createdAt: request.createdAt,
        });
      },
      abort: async () => {
        close();
      },
    });
  }

  async getStagedBundleFile(
    stagedFileId: string,
  ): Promise<Readonly<StagedBundleFileObject> | null> {
    const stored = this.#stagedBundleFiles.get(stagedFileId);
    return stored === undefined
      ? null
      : Object.freeze({ ...stored, bytes: new Uint8Array(stored.bytes) });
  }

  async openStagedBundleFile(
    stagedFileId: string,
  ): Promise<Readonly<OpenedStagedBundleFileObject> | null> {
    const stored = this.#stagedBundleFiles.get(stagedFileId);
    if (stored === undefined) return null;
    const bytes = new Uint8Array(stored.bytes);
    return Object.freeze({
      stagedFileId: stored.stagedFileId,
      bindingOwnerId: stored.bindingOwnerId,
      spaceId: stored.spaceId,
      size: stored.size,
      createdAt: stored.createdAt,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    });
  }

  async promoteStagedBundleFile(
    request: Readonly<PromoteStagedBundleFileRequest>,
  ): Promise<BundleFileObjectPutResult> {
    const staged = this.#stagedBundleFiles.get(request.stagedFileId);
    if (
      staged === undefined || staged.bindingOwnerId !== request.bindingOwnerId ||
      staged.spaceId !== request.spaceId || staged.size !== request.size
    ) throw new ObjectStoreIntegrityError("object_tampered", "staged BundleFile metadata mismatch");
    const actual = await this.calculateSha256(staged.bytes);
    if (actual !== request.sha256) {
      throw new ObjectStoreIntegrityError("object_tampered", "staged BundleFile digest mismatch");
    }
    return this.putBundleFile({
      spaceId: request.spaceId,
      bytes: staged.bytes,
      mediaType: request.mediaType,
      createdAt: request.createdAt,
    });
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

  async beginExportArchiveUpload(
    request: Readonly<ExportArchiveUploadRequest>,
  ): Promise<ExportArchiveUpload> {
    const chunks: Uint8Array[] = [];
    let closed = false;
    return Object.freeze({
      write: async (chunk: Uint8Array) => {
        if (closed) throw new Error("export upload is closed");
        if (!(chunk instanceof Uint8Array)) throw new TypeError("export chunk must be bytes");
        chunks.push(new Uint8Array(chunk));
      },
      complete: async (completion: Parameters<ExportArchiveUpload["complete"]>[0]) => {
        if (closed) throw new Error("export upload is closed");
        closed = true;
        const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
        if (size !== completion.size) return Object.freeze({ kind: "digest_mismatch" as const });
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return this.putExportArchive({ ...request, ...completion, bytes });
      },
      abort: async () => {
        closed = true;
        chunks.length = 0;
      },
    });
  }

  async openExportArchive(
    objectKey: string,
  ): Promise<Readonly<OpenedExportArchive> | null> {
    const stored = this.#exportArchives.get(objectKey);
    if (!stored) return null;
    const bytes = await this.readExportArchive(objectKey);
    return bytes === null
      ? null
      : Object.freeze({
          sha256: stored.metadata.sha256,
          size: stored.metadata.size,
          body: bytes,
        });
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

  async hasExportArchivesForJob(
    jobId: ExportArchiveWriteRequest["jobId"],
    spaceId: ExportArchiveWriteRequest["spaceId"],
  ): Promise<boolean> {
    return [...this.#exportArchives.values()].some((archive) =>
      archive.metadata.jobId === jobId && archive.metadata.spaceId === spaceId);
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

  async listObjectCleanupPage(request: Readonly<{
    namespace: ObjectCleanupNamespace;
    cursor: string | null;
    limit: number;
  }>): Promise<Readonly<ObjectCleanupPage>> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
      throw new ObjectStoreIntegrityError("invalid_limit", "cleanup page limit is invalid");
    }
    const candidates: ObjectCleanupCandidate[] = [];
    if (request.namespace === "immutable") {
      for (const item of this.#objects.values()) candidates.push(Object.freeze({
        namespace: "immutable",
        objectKey: `canonical/${item.sha256}`,
        fence: item.protectedAt,
        sha256: item.sha256,
        size: item.size,
        createdAt: item.createdAt,
        protectedAt: item.protectedAt,
      }));
    } else if (request.namespace === "bundle_file") {
      for (const item of this.#bundleFiles.values()) candidates.push(Object.freeze({
        namespace: "bundle_file",
        objectKey: `bundle/${item.spaceId}/${item.sha256}`,
        fence: item.protectedAt,
        spaceId: item.spaceId,
        sha256: item.sha256,
        size: item.size,
        createdAt: item.createdAt,
        protectedAt: item.protectedAt,
      }));
    } else if (request.namespace === "space_canonical") {
      for (const item of this.#spaceCanonicalObjects.values()) candidates.push(Object.freeze({
        namespace: "space_canonical",
        objectKey: `space/${item.spaceId}/${item.kind}/${item.sha256}`,
        fence: item.protectedAt,
        kind: item.kind,
        spaceId: item.spaceId,
        sha256: item.sha256,
        size: item.size,
        createdAt: item.createdAt,
        protectedAt: item.protectedAt,
      }));
    } else if (request.namespace === "staged_bundle") {
      for (const item of this.#stagedBundleFiles.values()) candidates.push(Object.freeze({
        namespace: "staged_bundle",
        objectKey: `staged/${item.stagedFileId}`,
        fence: item.createdAt,
        stagedFileId: item.stagedFileId,
        spaceId: item.spaceId,
        size: item.size,
        createdAt: item.createdAt,
      }));
    } else {
      for (const [objectKey, item] of this.#exportArchives) candidates.push(Object.freeze({
        namespace: "export",
        objectKey,
        fence: `${item.metadata.createdAt}:${item.metadata.sha256}`,
        jobId: item.metadata.jobId,
        spaceId: item.metadata.spaceId,
        size: item.metadata.size,
        createdAt: item.metadata.createdAt,
      }));
    }
    const remaining = candidates
      .filter((candidate) => request.cursor === null || candidate.objectKey > request.cursor)
      .sort((left, right) => left.objectKey.localeCompare(right.objectKey));
    const page = remaining.slice(0, request.limit);
    return Object.freeze({
      candidates: Object.freeze(page),
      listed: page.length,
      nextCursor: remaining.length > page.length ? page.at(-1)!.objectKey : null,
    });
  }

  async deleteObjectCleanupCandidate(request: Readonly<{
    candidate: Readonly<ObjectCleanupCandidate>;
    createdBefore: Utc;
  }>): Promise<boolean> {
    assertUtc(request.createdBefore);
    const candidate = request.candidate;
    if (candidate.namespace === "immutable") return this.deleteImmutableObject({
      sha256: candidate.sha256,
      expectedProtectedAt: candidate.protectedAt,
      createdBefore: request.createdBefore,
    });
    if (candidate.namespace === "bundle_file") return this.deleteBundleFileObject({
      spaceId: candidate.spaceId,
      sha256: candidate.sha256,
      expectedProtectedAt: candidate.protectedAt,
      createdBefore: request.createdBefore,
    });
    if (candidate.namespace === "space_canonical") return this.deleteSpaceCanonicalObject({
      kind: candidate.kind,
      spaceId: candidate.spaceId,
      sha256: candidate.sha256,
      expectedProtectedAt: candidate.protectedAt,
      createdBefore: request.createdBefore,
    });
    if (compareUtc(candidate.createdAt, request.createdBefore) >= 0) return false;
    if (candidate.namespace === "staged_bundle") {
      const current = this.#stagedBundleFiles.get(candidate.stagedFileId);
      if (!current || current.createdAt !== candidate.fence) return false;
      return this.#stagedBundleFiles.delete(candidate.stagedFileId);
    }
    const current = this.#exportArchives.get(candidate.objectKey);
    if (!current || `${current.metadata.createdAt}:${current.metadata.sha256}` !== candidate.fence) {
      return false;
    }
    return this.#exportArchives.delete(candidate.objectKey);
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
    await this.#assertIntegrityManifest(stored.integrityManifest, {
      spaceId: stored.spaceId,
      kind: stored.kind,
      sha256: stored.sha256,
      size: stored.size,
    });
  }

  async #assertBundleFileIntegrity(stored: StoredBundleFile): Promise<void> {
    const actual = await this.calculateSha256(stored.bytes);
    if (actual !== stored.sha256 || stored.bytes.byteLength !== stored.size) {
      throw new ObjectStoreIntegrityError("object_tampered", "BundleFile bytes are invalid");
    }
    await this.#assertIntegrityManifest(stored.integrityManifest, {
      spaceId: stored.spaceId,
      kind: "bundle_file",
      sha256: stored.sha256,
      size: stored.size,
    });
  }

  async #assertIntegrityManifest(
    manifest: Readonly<ObjectIntegrityManifest>,
    expected: Readonly<{ spaceId: string; kind: ObjectIntegrityKind; sha256: Digest; size: number }>,
  ): Promise<void> {
    if (
      manifest.schema !== OBJECT_INTEGRITY_PROOF_SCHEMA ||
      manifest.spaceId !== expected.spaceId ||
      manifest.kind !== expected.kind ||
      manifest.sha256 !== expected.sha256 ||
      manifest.size !== expected.size ||
      manifest.chunkSize !== OBJECT_INTEGRITY_CHUNK_SIZE ||
      manifest.chunkCount !== manifest.chunkDigests.length ||
      manifest.chunkCount !== Math.ceil(manifest.size / manifest.chunkSize)
    ) throw new ObjectStoreIntegrityError("object_tampered", "object integrity proof metadata is invalid");
    try {
      assertDigest(manifest.root);
      for (const digest of manifest.chunkDigests) assertDigest(digest);
    } catch {
      throw new ObjectStoreIntegrityError("object_tampered", "object integrity proof digest is invalid");
    }
    const root = await merkleRoot(
      (candidate) => this.calculateSha256(candidate),
      manifest,
      manifest.chunkDigests,
    );
    if (root !== manifest.root) {
      throw new ObjectStoreIntegrityError("object_tampered", "object integrity proof root is invalid");
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
