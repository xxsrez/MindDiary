import {
  ObjectStoreFailure,
  type ExportArchivePutResult,
  type ExportArchiveStore,
  type ExportArchiveUpload,
  type ExportArchiveUploadRequest,
  type ExportArchiveWriteRequest,
  type OpenedExportArchive,
  type ImmutableObject,
  type ImmutableObjectDeleteRequest,
  type ImmutableObjectListRequest,
  type ImmutableObjectMetadata,
  type ImmutableObjectPutResult,
  type ImmutableObjectWriteRequest,
  REVISION_MANIFEST_MEDIA_TYPE,
  type SpaceCanonicalObject,
  type SpaceCanonicalObjectMetadata,
  type SpaceCanonicalObjectPutResult,
  type SpaceCanonicalObjectWriteRequest,
  type SpaceCanonicalObjectListRequest,
  type SpaceCanonicalObjectDeleteRequest,
  type BundleFileObject,
  type OpenedBundleFileObject,
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
  type StoredExportArchive,
  type BoundedObjectCleanupStore,
  type ObjectCleanupCandidate,
  type ObjectCleanupNamespace,
  type ObjectCleanupPage,
} from "@mind-diary/application-ports";
import { IncrementalSha256 } from "./incremental-sha256.js";

export const SITES_OBJECT_ADAPTER = "sites-r2-immutable-envelope" as const;

export interface R2ObjectBodyLike {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly customMetadata?: Readonly<Record<string, string>>;
  readonly body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2ListedObjectLike {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly customMetadata?: Readonly<Record<string, string>>;
}

export interface R2ListResultLike {
  readonly objects: readonly R2ListedObjectLike[];
  readonly truncated: boolean;
  readonly cursor?: string;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>,
    options?: Readonly<{
      customMetadata?: Readonly<Record<string, string>>;
      httpMetadata?: Readonly<{ contentType?: string }>;
      onlyIf?: Readonly<{
        etagMatches?: string;
        etagDoesNotMatch?: string;
      }>;
    }>,
  ): Promise<R2ListedObjectLike | null>;
  delete(key: string | readonly string[]): Promise<void>;
  list(options?: Readonly<{
    prefix?: string;
    cursor?: string;
    limit?: number;
    include?: readonly ("customMetadata" | "httpMetadata")[];
  }>): Promise<R2ListResultLike>;
}

type Digest = ImmutableObjectMetadata["sha256"];
type Utc = ImmutableObjectMetadata["createdAt"];

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const MARKDOWN = "text/markdown; charset=utf-8";
const CANONICAL_PREFIX = "canonical/sha256/";
const EXPORT_PREFIX = "exports/";
const BUNDLE_PREFIX = "bundle-files/";
const STAGED_BUNDLE_PREFIX = "staged-bundle-files/";
const SPACE_CANONICAL_PREFIX = "spaces/";
const DELETE_STATE = "deleting";
const ACTIVE_STATE = "active";
const MAX_R2_CAS_ATTEMPTS = 16;
const R2_READ_TIMEOUT_MS = 5_000;
const EXPORT_STREAM_PART_BYTES = 4_194_304;
const SAFE_MEDIA_TYPE = /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/u;
const CLEANUP_NAMESPACES = new Set<ObjectCleanupNamespace>([
  "immutable",
  "bundle_file",
  "space_canonical",
  "staged_bundle",
  "export",
]);

function validCleanupNamespace(value: unknown): value is ObjectCleanupNamespace {
  return typeof value === "string" && CLEANUP_NAMESPACES.has(value as ObjectCleanupNamespace);
}

function assertDigest(value: string): asserts value is Digest {
  if (!SHA256.test(value)) {
    throw new ObjectStoreFailure("invalid_digest", "object digest is invalid");
  }
}

function assertUtc(value: string): asserts value is Utc {
  if (!UTC.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new ObjectStoreFailure("invalid_timestamp", "object timestamp is invalid");
  }
}

function compareUtc(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return leftMs < rightMs ? -1 : leftMs > rightMs ? 1 : 0;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function assertMarkdown(bytes: Uint8Array, mediaType: string): void {
  if (mediaType !== MARKDOWN) {
    throw new ObjectStoreFailure(
      "invalid_media_type",
      "canonical objects require UTF-8 Markdown media type",
    );
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ObjectStoreFailure("invalid_utf8", "canonical object is not UTF-8");
  }
}

function assertBundleMediaType(mediaType: string): void {
  if (mediaType.length > 127 || !SAFE_MEDIA_TYPE.test(mediaType)) {
    throw new ObjectStoreFailure("invalid_media_type", "BundleFile media type is not allowed");
  }
}

function canonicalKey(digest: Digest): string {
  return `${CANONICAL_PREFIX}${digest.slice("sha256:".length)}`;
}

function spaceCanonicalKey(
  kind: SpaceCanonicalObjectMetadata["kind"],
  spaceId: SpaceCanonicalObjectMetadata["spaceId"],
  digest: Digest,
): string {
  const namespace = kind === "markdown" ? "objects" : "manifests";
  return `${SPACE_CANONICAL_PREFIX}${encodeURIComponent(spaceId)}/${namespace}/sha256/${digest.slice(7)}`;
}

function isSpaceCanonicalKey(key: string): boolean {
  return /\/(?:objects|manifests)\/sha256\/[0-9a-f]{64}$/u.test(key);
}

function spaceCanonicalMetadataSource(
  metadata: Readonly<SpaceCanonicalObjectMetadata>,
  state = ACTIVE_STATE,
  deleteBoundary = "",
): Readonly<Record<string, string>> {
  return Object.freeze({
    schema: "md-r2-space-canonical-v1",
    state,
    kind: metadata.kind,
    spaceId: metadata.spaceId,
    sha256: metadata.sha256,
    mediaType: metadata.mediaType,
    size: String(metadata.size),
    createdAt: metadata.createdAt,
    protectedAt: metadata.protectedAt,
    deleteBoundary,
  });
}

function spaceCanonicalMetadataFromR2(
  object: R2ListedObjectLike,
): Readonly<SpaceCanonicalObjectMetadata> {
  const custom = object.customMetadata ?? {};
  const digest = custom.sha256 ?? "";
  const createdAt = custom.createdAt ?? "";
  const protectedAt = custom.protectedAt ?? "";
  assertDigest(digest);
  assertUtc(createdAt);
  assertUtc(protectedAt);
  const kind = custom.kind;
  const mediaType = custom.mediaType;
  if (
    custom.schema !== "md-r2-space-canonical-v1" ||
    (kind !== "markdown" && kind !== "revision_manifest") ||
    typeof custom.spaceId !== "string" || custom.spaceId.length === 0 ||
    Number(custom.size) !== object.size ||
    (kind === "markdown" ? mediaType !== MARKDOWN : mediaType !== REVISION_MANIFEST_MEDIA_TYPE)
  ) throw new ObjectStoreFailure("object_tampered", "Space canonical metadata is invalid");
  return Object.freeze({
    kind,
    spaceId: custom.spaceId as SpaceCanonicalObjectMetadata["spaceId"],
    sha256: digest,
    mediaType: kind === "markdown" ? MARKDOWN : REVISION_MANIFEST_MEDIA_TYPE,
    size: object.size,
    createdAt,
    protectedAt,
  });
}

function canonicalMetadata(
  digest: Digest,
  mediaType: string,
  size: number,
  createdAt: Utc,
  protectedAt: Utc,
  state = ACTIVE_STATE,
  deleteBoundary = "",
): Readonly<Record<string, string>> {
  return Object.freeze({
    schema: "md-r2-object-v1",
    state,
    sha256: digest,
    mediaType,
    size: String(size),
    createdAt,
    protectedAt,
    deleteBoundary,
  });
}

function metadataFromR2(object: R2ListedObjectLike): Readonly<ImmutableObjectMetadata> {
  const custom = object.customMetadata ?? {};
  const digest = custom.sha256 ?? "";
  const createdAt = custom.createdAt ?? "";
  const protectedAt = custom.protectedAt ?? "";
  assertDigest(digest);
  assertUtc(createdAt);
  assertUtc(protectedAt);
  if (
    custom.schema !== "md-r2-object-v1" ||
    custom.mediaType !== MARKDOWN ||
    Number(custom.size) !== object.size
  ) {
    throw new ObjectStoreFailure("object_tampered", "R2 object metadata is invalid");
  }
  return Object.freeze({
    sha256: digest,
    mediaType: MARKDOWN,
    size: object.size,
    createdAt,
    protectedAt,
  });
}

async function withR2ReadTimeout<Result>(
  operation: Promise<Result>,
  description: string,
): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ObjectStoreFailure("object_read_timeout", `R2 ${description} timed out`));
    }, R2_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function bodyBytes(object: R2ObjectBodyLike): Promise<Uint8Array> {
  return new Uint8Array(await withR2ReadTimeout(object.arrayBuffer(), "object body read"));
}

function bodyStream(object: R2ObjectBodyLike): ReadableStream<Uint8Array> {
  return object.body;
}

async function verifyBodyStream(
  body: ReadableStream<Uint8Array>,
  expectedSize: number,
  expectedSha256: Digest,
): Promise<boolean> {
  const reader = body.getReader();
  const digest = new IncrementalSha256();
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || size + part.value.byteLength > expectedSize) {
        await reader.cancel().catch(() => undefined);
        return false;
      }
      size += part.value.byteLength;
      digest.update(part.value);
    }
    return size === expectedSize && digest.digest() === expectedSha256;
  } finally {
    reader.releaseLock();
  }
}


/** R2-backed canonical and export object namespaces with conditional GC lease claims. */
export class SitesObjectStore implements BundleFileObjectStore, ExportArchiveStore, BoundedObjectCleanupStore {
  readonly kind = "object-store" as const;
  readonly #bucket: R2BucketLike;

  constructor(bucket: R2BucketLike) {
    this.#bucket = bucket;
  }

  async ready(): Promise<this> {
    return this;
  }

  async #get(key: string): Promise<R2ObjectBodyLike | null> {
    return withR2ReadTimeout(this.#bucket.get(key), "object lookup");
  }

  async #list(options: Parameters<R2BucketLike["list"]>[0]): Promise<R2ListResultLike> {
    return withR2ReadTimeout(this.#bucket.list(options), "object listing");
  }

  async calculateSha256(bytes: Uint8Array): Promise<Digest> {
    const copy = new Uint8Array(bytes);
    const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
    return `sha256:${[...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")}` as Digest;
  }

  async putImmutable(request: ImmutableObjectWriteRequest): Promise<ImmutableObjectPutResult> {
    assertUtc(request.createdAt);
    assertMarkdown(request.bytes, request.mediaType);
    const bytes = new Uint8Array(request.bytes);
    const digest = await this.calculateSha256(bytes);
    const key = canonicalKey(digest);
    for (let attempt = 0; attempt < MAX_R2_CAS_ATTEMPTS; attempt += 1) {
      const existing = await this.#get(key);
      if (!existing) {
        const stored = await this.#bucket.put(key, bytes, {
          httpMetadata: { contentType: MARKDOWN },
          customMetadata: canonicalMetadata(
            digest,
            MARKDOWN,
            bytes.byteLength,
            request.createdAt,
            request.createdAt,
          ),
          onlyIf: { etagDoesNotMatch: "*" },
        });
        if (!stored) continue;
        return Object.freeze({
          object: metadataFromR2(stored),
          status: "stored",
        });
      }
      const metadata = metadataFromR2(existing);
      const existingBytes = await bodyBytes(existing);
      const actual = await this.calculateSha256(existingBytes);
      if (
        actual !== digest ||
        !bytesEqual(existingBytes, bytes) ||
        metadata.size !== bytes.byteLength
      ) {
        throw new ObjectStoreFailure(
          actual === digest ? "digest_collision" : "object_tampered",
          "R2 immutable object does not match its digest",
        );
      }
      const state = existing.customMetadata?.state ?? ACTIVE_STATE;
      if (state === DELETE_STATE) continue;
      const protectedAt =
        compareUtc(request.createdAt, metadata.protectedAt) > 0
          ? request.createdAt
          : metadata.protectedAt;
      if (protectedAt !== metadata.protectedAt) {
        const updated = await this.#bucket.put(key, existingBytes, {
          httpMetadata: { contentType: MARKDOWN },
          customMetadata: canonicalMetadata(
            digest,
            MARKDOWN,
            existingBytes.byteLength,
            metadata.createdAt,
            protectedAt,
          ),
          onlyIf: { etagMatches: existing.etag },
        });
        if (!updated) continue;
        return Object.freeze({
          object: metadataFromR2(updated),
          status: "already_exists",
        });
      }
      return Object.freeze({ object: metadata, status: "already_exists" });
    }
    throw new Error("R2 immutable-object CAS retry budget exhausted");
  }

  async getImmutable(digest: Digest): Promise<Readonly<ImmutableObject> | null> {
    assertDigest(digest);
    const object = await this.#get(canonicalKey(digest));
    if (!object) return null;
    const metadata = metadataFromR2(object);
    const bytes = await bodyBytes(object);
    assertMarkdown(bytes, metadata.mediaType);
    if ((await this.calculateSha256(bytes)) !== digest || bytes.byteLength !== metadata.size) {
      throw new ObjectStoreFailure("object_tampered", "R2 immutable bytes are invalid");
    }
    return Object.freeze({ ...metadata, bytes });
  }

  async putSpaceCanonicalObject(
    request: SpaceCanonicalObjectWriteRequest,
  ): Promise<SpaceCanonicalObjectPutResult> {
    assertUtc(request.createdAt);
    if (typeof request.spaceId !== "string" || request.spaceId.length === 0) {
      throw new TypeError("canonical object Space ID is required");
    }
    if (request.kind === "markdown") assertMarkdown(request.bytes, request.mediaType);
    else if (request.mediaType !== REVISION_MANIFEST_MEDIA_TYPE) {
      throw new ObjectStoreFailure("invalid_media_type", "revision manifest media type is invalid");
    }
    const bytes = new Uint8Array(request.bytes);
    if (request.kind === "revision_manifest") {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new ObjectStoreFailure("invalid_utf8", "revision manifest is not UTF-8");
      }
    }
    const digest = await this.calculateSha256(bytes);
    const key = spaceCanonicalKey(request.kind, request.spaceId, digest);
    const mediaType = request.mediaType;
    for (let attempt = 0; attempt < MAX_R2_CAS_ATTEMPTS; attempt += 1) {
      const existing = await this.#get(key);
      if (!existing) {
        const metadata: Readonly<SpaceCanonicalObjectMetadata> = Object.freeze({
          kind: request.kind,
          spaceId: request.spaceId,
          sha256: digest,
          mediaType,
          size: bytes.byteLength,
          createdAt: request.createdAt,
          protectedAt: request.createdAt,
        });
        const stored = await this.#bucket.put(key, bytes, {
          httpMetadata: { contentType: mediaType },
          customMetadata: spaceCanonicalMetadataSource(metadata),
          onlyIf: { etagDoesNotMatch: "*" },
        });
        if (!stored) continue;
        return Object.freeze({ object: spaceCanonicalMetadataFromR2(stored), status: "stored" });
      }
      const metadata = spaceCanonicalMetadataFromR2(existing);
      const existingBytes = await bodyBytes(existing);
      const actual = await this.calculateSha256(existingBytes);
      if (
        metadata.kind !== request.kind || metadata.spaceId !== request.spaceId ||
        metadata.mediaType !== mediaType || actual !== digest ||
        !bytesEqual(existingBytes, bytes)
      ) throw new ObjectStoreFailure(
        actual === digest ? "digest_collision" : "object_tampered",
        "Space canonical object does not match its digest",
      );
      if ((existing.customMetadata?.state ?? ACTIVE_STATE) === DELETE_STATE) continue;
      const protectedAt = compareUtc(request.createdAt, metadata.protectedAt) > 0
        ? request.createdAt
        : metadata.protectedAt;
      if (protectedAt !== metadata.protectedAt) {
        const updated = await this.#bucket.put(key, existingBytes, {
          httpMetadata: { contentType: mediaType },
          customMetadata: spaceCanonicalMetadataSource({ ...metadata, protectedAt }),
          onlyIf: { etagMatches: existing.etag },
        });
        if (!updated) continue;
        return Object.freeze({
          object: spaceCanonicalMetadataFromR2(updated),
          status: "already_exists",
        });
      }
      return Object.freeze({ object: metadata, status: "already_exists" });
    }
    throw new Error("R2 Space canonical CAS retry budget exhausted");
  }

  async getSpaceCanonicalObject(
    kind: SpaceCanonicalObjectMetadata["kind"],
    spaceId: SpaceCanonicalObjectMetadata["spaceId"],
    digest: Digest,
  ): Promise<Readonly<SpaceCanonicalObject> | null> {
    assertDigest(digest);
    const object = await this.#get(spaceCanonicalKey(kind, spaceId, digest));
    if (!object) return null;
    const metadata = spaceCanonicalMetadataFromR2(object);
    const bytes = await bodyBytes(object);
    if (
      metadata.kind !== kind || metadata.spaceId !== spaceId || metadata.sha256 !== digest ||
      bytes.byteLength !== metadata.size || (await this.calculateSha256(bytes)) !== digest
    ) throw new ObjectStoreFailure("object_tampered", "Space canonical bytes are invalid");
    if (kind === "markdown") assertMarkdown(bytes, metadata.mediaType);
    return Object.freeze({ ...metadata, bytes });
  }

  async listSpaceCanonicalObjects(
    request: SpaceCanonicalObjectListRequest,
  ): Promise<readonly Readonly<SpaceCanonicalObjectMetadata>[]> {
    assertUtc(request.createdBefore);
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
      throw new ObjectStoreFailure("invalid_limit", "Space canonical list limit is invalid");
    }
    const excluded = new Set(request.excluded.map(
      (item) => `${item.kind}\u0000${item.spaceId}\u0000${item.sha256}`,
    ));
    const prefix = request.spaceId === undefined
      ? SPACE_CANONICAL_PREFIX
      : `${SPACE_CANONICAL_PREFIX}${encodeURIComponent(request.spaceId)}/`;
    return Object.freeze((await this.#listAll(prefix))
      // Derived indexes share the top-level Space prefix but have a separate
      // lifecycle and must never be interpreted as canonical objects.
      .filter((object) => isSpaceCanonicalKey(object.key))
      // A process may stop after the delete-marker CAS but before physical
      // deletion. Keep claimed objects enumerable so a later bounded pass can
      // finish the deletion.
      .filter((object) => {
        const state = object.customMetadata?.state ?? ACTIVE_STATE;
        return state === ACTIVE_STATE || state === DELETE_STATE;
      })
      .map(spaceCanonicalMetadataFromR2)
      .filter((item) =>
        !excluded.has(`${item.kind}\u0000${item.spaceId}\u0000${item.sha256}`) &&
        compareUtc(item.protectedAt, request.createdBefore) < 0)
      .sort((left, right) =>
        compareUtc(left.protectedAt, right.protectedAt) ||
        left.kind.localeCompare(right.kind) || left.spaceId.localeCompare(right.spaceId) ||
        left.sha256.localeCompare(right.sha256))
      .slice(0, request.limit));
  }

  async deleteSpaceCanonicalObject(
    request: SpaceCanonicalObjectDeleteRequest,
  ): Promise<boolean> {
    assertDigest(request.sha256);
    assertUtc(request.createdBefore);
    assertUtc(request.expectedProtectedAt);
    const key = spaceCanonicalKey(request.kind, request.spaceId, request.sha256);
    for (let attempt = 0; attempt < MAX_R2_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.#get(key);
      if (!current) return false;
      const metadata = spaceCanonicalMetadataFromR2(current);
      if (
        metadata.protectedAt !== request.expectedProtectedAt ||
        compareUtc(metadata.protectedAt, request.createdBefore) >= 0
      ) return false;
      if ((current.customMetadata?.state ?? ACTIVE_STATE) === DELETE_STATE) {
        const deleteBoundary = current.customMetadata?.deleteBoundary ?? "";
        try {
          assertUtc(deleteBoundary);
        } catch {
          throw new ObjectStoreFailure(
            "object_tampered",
            "Space canonical delete marker is invalid",
          );
        }
        // A later cutoff may safely resume an older claim. Puts remain fenced
        // by DELETE_STATE, while the caller re-applies current reachability
        // before selecting this candidate.
        if (compareUtc(deleteBoundary, request.createdBefore) > 0) return false;
        await this.#bucket.delete(key);
        return true;
      }
      const bytes = await bodyBytes(current);
      const claimed = await this.#bucket.put(key, bytes, {
        httpMetadata: { contentType: metadata.mediaType },
        customMetadata: spaceCanonicalMetadataSource(
          metadata,
          DELETE_STATE,
          request.createdBefore,
        ),
        onlyIf: { etagMatches: current.etag },
      });
      if (!claimed) continue;
      await this.#bucket.delete(key);
      return true;
    }
    throw new Error("R2 Space canonical delete CAS retry budget exhausted");
  }

  async putBundleFile(
    request: BundleFileObjectWriteRequest,
  ): Promise<BundleFileObjectPutResult> {
    assertUtc(request.createdAt);
    assertBundleMediaType(request.mediaType);
    const bytes = new Uint8Array(request.bytes);
    const digest = await this.calculateSha256(bytes);
    const key = `${BUNDLE_PREFIX}${encodeURIComponent(request.spaceId)}/sha256/${digest.slice(7)}`;
    for (let attempt = 0; attempt < MAX_R2_CAS_ATTEMPTS; attempt += 1) {
      const existing = await this.#get(key);
      if (!existing) {
        const stored = await this.#bucket.put(key, bytes, {
          httpMetadata: { contentType: request.mediaType },
          customMetadata: this.#bundleCustomMetadata({
            spaceId: request.spaceId,
            sha256: digest,
            mediaType: request.mediaType,
            size: bytes.byteLength,
            createdAt: request.createdAt,
            protectedAt: request.createdAt,
          }),
          onlyIf: { etagDoesNotMatch: "*" },
        });
        if (!stored) continue;
        return Object.freeze({ object: this.#bundleMetadata(stored), status: "stored" });
      }
      const metadata = this.#bundleMetadata(existing);
      const existingBytes = await bodyBytes(existing);
      if (
        metadata.sha256 !== digest ||
        metadata.mediaType !== request.mediaType ||
        !bytesEqual(existingBytes, bytes)
      ) throw new ObjectStoreFailure("digest_collision", "BundleFile object collision");
      if ((existing.customMetadata?.state ?? ACTIVE_STATE) === DELETE_STATE) continue;
      const protectedAt = compareUtc(request.createdAt, metadata.protectedAt) > 0
        ? request.createdAt
        : metadata.protectedAt;
      if (protectedAt !== metadata.protectedAt) {
        const updated = await this.#bucket.put(key, existingBytes, {
          httpMetadata: { contentType: request.mediaType },
          customMetadata: this.#bundleCustomMetadata({ ...metadata, protectedAt }),
          onlyIf: { etagMatches: existing.etag },
        });
        if (!updated) continue;
        return Object.freeze({
          object: this.#bundleMetadata(updated),
          status: "already_exists",
        });
      }
      return Object.freeze({ object: metadata, status: "already_exists" });
    }
    throw new Error("R2 BundleFile CAS retry budget exhausted");
  }

  async getBundleFile(
    spaceId: BundleFileObjectMetadata["spaceId"],
    digest: Digest,
  ): Promise<Readonly<BundleFileObject> | null> {
    assertDigest(digest);
    const key = `${BUNDLE_PREFIX}${encodeURIComponent(spaceId)}/sha256/${digest.slice(7)}`;
    const object = await this.#get(key);
    if (!object) return null;
    const metadata = this.#bundleMetadata(object);
    const bytes = await bodyBytes(object);
    if (
      metadata.spaceId !== spaceId ||
      metadata.sha256 !== digest ||
      bytes.byteLength !== metadata.size ||
      (await this.calculateSha256(bytes)) !== digest
    ) throw new ObjectStoreFailure("object_tampered", "BundleFile bytes are invalid");
    return Object.freeze({ ...metadata, bytes });
  }

  async openBundleFile(
    spaceId: BundleFileObjectMetadata["spaceId"],
    digest: Digest,
  ): Promise<Readonly<OpenedBundleFileObject> | null> {
    assertDigest(digest);
    const key = `${BUNDLE_PREFIX}${encodeURIComponent(spaceId)}/sha256/${digest.slice(7)}`;
    const object = await this.#get(key);
    if (!object) return null;
    const metadata = this.#bundleMetadata(object);
    if (metadata.spaceId !== spaceId || metadata.sha256 !== digest) {
      throw new ObjectStoreFailure("object_tampered", "BundleFile metadata is invalid");
    }
    return Object.freeze({ ...metadata, body: bodyStream(object) });
  }

  async listBundleFileObjects(
    request: BundleFileObjectListRequest,
  ): Promise<readonly Readonly<BundleFileObjectMetadata>[]> {
    assertUtc(request.createdBefore);
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
      throw new ObjectStoreFailure("invalid_limit", "BundleFile list limit is invalid");
    }
    const excluded = new Set(
      request.excluded.map((item) => `${item.spaceId}\u0000${item.sha256}`),
    );
    return Object.freeze((await this.#listAll(BUNDLE_PREFIX))
      .filter((object) => (object.customMetadata?.state ?? ACTIVE_STATE) === ACTIVE_STATE)
      .map((object) => this.#bundleMetadata(object))
      .filter((item) =>
        !excluded.has(`${item.spaceId}\u0000${item.sha256}`) &&
        compareUtc(item.protectedAt, request.createdBefore) < 0)
      .sort((left, right) =>
        compareUtc(left.protectedAt, right.protectedAt) ||
        left.spaceId.localeCompare(right.spaceId) ||
        left.sha256.localeCompare(right.sha256))
      .slice(0, request.limit));
  }

  async deleteBundleFileObject(
    request: BundleFileObjectDeleteRequest,
  ): Promise<boolean> {
    assertDigest(request.sha256);
    assertUtc(request.createdBefore);
    assertUtc(request.expectedProtectedAt);
    const key = `${BUNDLE_PREFIX}${encodeURIComponent(request.spaceId)}/sha256/${request.sha256.slice(7)}`;
    for (let attempt = 0; attempt < MAX_R2_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.#get(key);
      if (!current) return false;
      const metadata = this.#bundleMetadata(current);
      if (
        metadata.protectedAt !== request.expectedProtectedAt ||
        compareUtc(metadata.protectedAt, request.createdBefore) >= 0
      ) return false;
      const state = current.customMetadata?.state ?? ACTIVE_STATE;
      if (state === DELETE_STATE) {
        if (current.customMetadata?.deleteBoundary !== request.createdBefore) return false;
        await this.#bucket.delete(key);
        return true;
      }
      const bytes = await bodyBytes(current);
      const claimed = await this.#bucket.put(key, bytes, {
        httpMetadata: { contentType: metadata.mediaType },
        customMetadata: this.#bundleCustomMetadata(
          metadata,
          DELETE_STATE,
          request.createdBefore,
        ),
        onlyIf: { etagMatches: current.etag },
      });
      if (!claimed) continue;
      await this.#bucket.delete(key);
      return true;
    }
    throw new Error("R2 BundleFile delete CAS retry budget exhausted");
  }

  async putStagedBundleFile(
    request: StagedBundleFileObjectWriteRequest,
  ): Promise<Readonly<StagedBundleFileObject>> {
    assertUtc(request.createdAt);
    const key = `${STAGED_BUNDLE_PREFIX}${encodeURIComponent(request.stagedFileId)}`;
    const bytes = new Uint8Array(request.bytes);
    for (let attempt = 0; attempt < MAX_R2_CAS_ATTEMPTS; attempt += 1) {
      const existing = await this.#get(key);
      if (existing) {
        const restored = await this.#stagedBundleFile(existing);
        if (
          restored.bindingOwnerId !== request.bindingOwnerId ||
          restored.spaceId !== request.spaceId ||
          !bytesEqual(restored.bytes, bytes)
        ) throw new ObjectStoreFailure("digest_collision", "staged BundleFile ID collision");
        return restored;
      }
      const stored = await this.#bucket.put(key, bytes, {
        customMetadata: Object.freeze({
          schema: "md-r2-staged-bundle-file-v1",
          stagedFileId: request.stagedFileId,
          bindingOwnerId: request.bindingOwnerId,
          spaceId: request.spaceId,
          size: String(bytes.byteLength),
          createdAt: request.createdAt,
        }),
        onlyIf: { etagDoesNotMatch: "*" },
      });
      if (!stored) continue;
      const body = await this.#get(key);
      if (!body) continue;
      return this.#stagedBundleFile(body);
    }
    throw new Error("R2 staged BundleFile CAS retry budget exhausted");
  }

  /**
   * Streams generated ingress directly into the R2 staging namespace.  The
   * object remains quarantined under an opaque staged key until `complete`
   * closes the body; abort cancels the body and removes any partial object.
   */
  async beginStagedBundleFileUpload(
    request: Readonly<StagedBundleFileUploadRequest>,
  ): Promise<StagedBundleFileUpload> {
    assertUtc(request.createdAt);
    if (
      typeof request.stagedFileId !== "string" || request.stagedFileId.length === 0 ||
      typeof request.bindingOwnerId !== "string" || request.bindingOwnerId.length === 0 ||
      typeof request.spaceId !== "string" || request.spaceId.length === 0 ||
      !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 0
    ) throw new ObjectStoreFailure("invalid_limit", "staged upload request is invalid");

    const key = `${STAGED_BUNDLE_PREFIX}${encodeURIComponent(request.stagedFileId)}`;
    if (await this.#get(key)) {
      throw new ObjectStoreFailure("digest_collision", "staged BundleFile ID collision");
    }
    const transform = new TransformStream<Uint8Array, Uint8Array>();
    const writer = transform.writable.getWriter();
    type PutOutcome =
      | Readonly<{ kind: "stored"; object: R2ListedObjectLike }>
      | Readonly<{ kind: "collision" }>
      | Readonly<{ kind: "failed"; error: unknown }>;
    const putOutcomePromise: Promise<PutOutcome> = this.#bucket.put(key, transform.readable, {
      customMetadata: Object.freeze({
        schema: "md-r2-staged-bundle-file-stream-v1",
        stagedFileId: request.stagedFileId,
        bindingOwnerId: request.bindingOwnerId,
        spaceId: request.spaceId,
        createdAt: request.createdAt,
        maxBytes: String(request.maxBytes),
      }),
      onlyIf: { etagDoesNotMatch: "*" },
    }).then(
      (stored) => stored === null
        ? Object.freeze({ kind: "collision" } as const)
        : Object.freeze({ kind: "stored", object: stored } as const),
      (error: unknown) => Object.freeze({ kind: "failed", error } as const),
    );
    let size = 0;
    let closed = false;
    let completed = false;
    let abortPromise: Promise<void> | null = null;

    const putFailure = (outcome: Exclude<PutOutcome, { kind: "stored" }>): unknown =>
      outcome.kind === "collision"
        ? new ObjectStoreFailure("digest_collision", "staged BundleFile ID collision")
        : outcome.error;

    const abort = (): Promise<void> => {
      if (abortPromise !== null) return abortPromise;
      closed = true;
      abortPromise = (async () => {
        await Promise.allSettled([
          writer.abort(),
          transform.readable.cancel(),
        ]);
        const outcome = await putOutcomePromise;
        if (completed || outcome.kind !== "stored") return;

        // A conditional-put collision belongs to another upload.  Even after
        // our own put succeeds, only remove the exact etag that it returned.
        const current = await this.#get(key).catch(() => null);
        if (current?.etag === outcome.object.etag) {
          await this.#bucket.delete(key).catch(() => undefined);
        }
      })();
      return abortPromise;
    };

    const writeWithPutObservation = async (chunk: Uint8Array): Promise<void> => {
      const result = await Promise.race([
        writer.write(chunk).then(() => Object.freeze({ kind: "written" } as const)),
        putOutcomePromise,
      ]);
      if (result.kind === "written") return;
      if (result.kind === "stored") {
        throw new ObjectStoreFailure(
          "object_tampered",
          "R2 staged upload completed before the stream was closed",
        );
      }
      throw putFailure(result);
    };

    return Object.freeze({
      write: async (chunk: Uint8Array): Promise<void> => {
        if (closed) throw new Error("staged upload is closed");
        if (!(chunk instanceof Uint8Array)) {
          await abort();
          throw new TypeError("staged chunk must be bytes");
        }
        if (size + chunk.byteLength > request.maxBytes) {
          await abort();
          throw new ObjectStoreFailure(
            "invalid_limit",
            "staged upload exceeds its configured byte limit",
          );
        }
        try {
          await writeWithPutObservation(new Uint8Array(chunk));
          size += chunk.byteLength;
        } catch (error) {
          await abort();
          throw error;
        }
      },
      complete: async ({ sha256, size: expectedSize }: { readonly sha256: Digest; readonly size: number }) => {
        if (closed) throw new Error("staged upload is closed");
        assertDigest(sha256);
        if (expectedSize !== size) {
          await abort();
          throw new ObjectStoreFailure("object_tampered", "staged upload size mismatch");
        }
        try {
          closed = true;
          const closePromise = writer.close();
          const first = await Promise.race([
            closePromise.then(() => Object.freeze({ kind: "closed" } as const)),
            putOutcomePromise,
          ]);
          if (first.kind === "collision" || first.kind === "failed") {
            throw putFailure(first);
          }
          await closePromise;
          const outcome = first.kind === "stored" ? first : await putOutcomePromise;
          if (outcome.kind === "collision" || outcome.kind === "failed") {
            throw putFailure(outcome);
          }
          if (outcome.object.size !== expectedSize) {
            throw new ObjectStoreFailure("object_tampered", "staged upload size mismatch");
          }
          const persisted = await this.#get(key);
          if (
            persisted === null || persisted.etag !== outcome.object.etag ||
            this.#stagedBundleMetadata(persisted).size !== expectedSize ||
            !(await verifyBodyStream(persisted.body, expectedSize, sha256))
          ) throw new ObjectStoreFailure(
            "object_tampered",
            "persisted staged upload failed digest verification",
          );
          completed = true;
          return Object.freeze({
            stagedFileId: request.stagedFileId,
            bindingOwnerId: request.bindingOwnerId,
            spaceId: request.spaceId,
            size: expectedSize,
            createdAt: request.createdAt,
          });
        } catch (error) {
          await abort();
          throw error;
        }
      },
      abort,
    });
  }

  async getStagedBundleFile(
    stagedFileId: string,
  ): Promise<Readonly<StagedBundleFileObject> | null> {
    const object = await this.#get(
      `${STAGED_BUNDLE_PREFIX}${encodeURIComponent(stagedFileId)}`,
    );
    return object === null ? null : this.#stagedBundleFile(object);
  }

  async openStagedBundleFile(
    stagedFileId: string,
  ): Promise<Readonly<OpenedStagedBundleFileObject> | null> {
    const object = await this.#get(
      `${STAGED_BUNDLE_PREFIX}${encodeURIComponent(stagedFileId)}`,
    );
    if (object === null) return null;
    return Object.freeze({ ...this.#stagedBundleMetadata(object), body: bodyStream(object) });
  }

  async promoteStagedBundleFile(
    request: Readonly<PromoteStagedBundleFileRequest>,
  ): Promise<BundleFileObjectPutResult> {
    assertUtc(request.createdAt);
    assertDigest(request.sha256);
    assertBundleMediaType(request.mediaType);
    const stagedKey = `${STAGED_BUNDLE_PREFIX}${encodeURIComponent(request.stagedFileId)}`;
    const canonicalKey = `${BUNDLE_PREFIX}${encodeURIComponent(request.spaceId)}/sha256/${request.sha256.slice(7)}`;
    for (let attempt = 0; attempt < MAX_R2_CAS_ATTEMPTS; attempt += 1) {
      const staged = await this.#get(stagedKey);
      if (staged === null) throw new ObjectStoreFailure("object_tampered", "staged BundleFile is missing");
      const stagedMetadata = this.#stagedBundleMetadata(staged);
      if (
        stagedMetadata.bindingOwnerId !== request.bindingOwnerId ||
        stagedMetadata.spaceId !== request.spaceId || stagedMetadata.size !== request.size
      ) throw new ObjectStoreFailure("object_tampered", "staged BundleFile metadata mismatch");
      const existing = await this.#get(canonicalKey);
      if (existing !== null) {
        const metadata = this.#bundleMetadata(existing);
        if (
          metadata.spaceId !== request.spaceId || metadata.sha256 !== request.sha256 ||
          metadata.mediaType !== request.mediaType || metadata.size !== request.size
        ) throw new ObjectStoreFailure("digest_collision", "BundleFile object collision");
        if (compareUtc(request.createdAt, metadata.protectedAt) <= 0) {
          return Object.freeze({ object: metadata, status: "already_exists" });
        }
        const updated = await this.#bucket.put(canonicalKey, bodyStream(existing), {
          httpMetadata: { contentType: request.mediaType },
          customMetadata: this.#bundleCustomMetadata({
            ...metadata,
            protectedAt: request.createdAt,
          }),
          onlyIf: { etagMatches: existing.etag },
        });
        if (updated === null) continue;
        return Object.freeze({ object: this.#bundleMetadata(updated), status: "already_exists" });
      }
      const stored = await this.#bucket.put(canonicalKey, bodyStream(staged), {
        httpMetadata: { contentType: request.mediaType },
        customMetadata: this.#bundleCustomMetadata({
          spaceId: request.spaceId,
          sha256: request.sha256,
          mediaType: request.mediaType,
          size: request.size,
          createdAt: request.createdAt,
          protectedAt: request.createdAt,
        }),
        onlyIf: { etagDoesNotMatch: "*" },
      });
      if (stored === null) continue;
      const metadata = this.#bundleMetadata(stored);
      if (metadata.size !== request.size) {
        await this.#bucket.delete(canonicalKey).catch(() => undefined);
        throw new ObjectStoreFailure("object_tampered", "promoted BundleFile size mismatch");
      }
      return Object.freeze({ object: metadata, status: "stored" });
    }
    throw new Error("R2 BundleFile promotion CAS retry budget exhausted");
  }

  async deleteStagedBundleFile(stagedFileId: string): Promise<boolean> {
    const key = `${STAGED_BUNDLE_PREFIX}${encodeURIComponent(stagedFileId)}`;
    if (!(await this.#get(key))) return false;
    await this.#bucket.delete(key);
    return true;
  }

  async listImmutableObjects(
    request: ImmutableObjectListRequest,
  ): Promise<readonly Readonly<ImmutableObjectMetadata>[]> {
    assertUtc(request.createdBefore);
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
      throw new ObjectStoreFailure("invalid_limit", "object list limit is invalid");
    }
    const excluded = new Set(request.excludedDigests);
    for (const digest of excluded) assertDigest(digest);
    const listed = await this.#listAll(CANONICAL_PREFIX);
    const candidates = listed
      .map(metadataFromR2)
      .filter(
        (metadata) =>
          !excluded.has(metadata.sha256) &&
          compareUtc(metadata.protectedAt, request.createdBefore) < 0,
      )
      .sort(
        (left, right) =>
          compareUtc(left.protectedAt, right.protectedAt) ||
          left.sha256.localeCompare(right.sha256),
      )
      .slice(0, request.limit);
    return Object.freeze(candidates);
  }

  async deleteImmutableObject(request: ImmutableObjectDeleteRequest): Promise<boolean> {
    assertDigest(request.sha256);
    assertUtc(request.createdBefore);
    assertUtc(request.expectedProtectedAt);
    const key = canonicalKey(request.sha256);
    for (let attempt = 0; attempt < MAX_R2_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.#get(key);
      if (!current) return false;
      const metadata = metadataFromR2(current);
      if (
        metadata.protectedAt !== request.expectedProtectedAt ||
        compareUtc(metadata.protectedAt, request.createdBefore) >= 0
      ) {
        return false;
      }
      if (
        current.customMetadata?.state === DELETE_STATE &&
        current.customMetadata.deleteBoundary === request.createdBefore
      ) {
        await this.#bucket.delete(key);
        return true;
      }
      const bytes = await bodyBytes(current);
      const claimed = await this.#bucket.put(key, bytes, {
        httpMetadata: { contentType: MARKDOWN },
        customMetadata: canonicalMetadata(
          request.sha256,
          metadata.mediaType,
          metadata.size,
          metadata.createdAt,
          metadata.protectedAt,
          DELETE_STATE,
          request.createdBefore,
        ),
        onlyIf: { etagMatches: current.etag },
      });
      if (!claimed) continue;
      await this.#bucket.delete(key);
      return true;
    }
    return false;
  }

  async putExportArchive(request: ExportArchiveWriteRequest): Promise<ExportArchivePutResult> {
    assertUtc(request.createdAt);
    assertDigest(request.sha256);
    const bytes = new Uint8Array(request.bytes);
    if ((await this.calculateSha256(bytes)) !== request.sha256) {
      return Object.freeze({ kind: "digest_mismatch" });
    }
    if (
      !request.jobId ||
      !request.spaceId ||
      !Number.isSafeInteger(request.claimVersion) ||
      request.claimVersion < 1
    ) {
      return Object.freeze({ kind: "object_key_collision" });
    }
    const key = `${EXPORT_PREFIX}${encodeURIComponent(request.spaceId)}/${encodeURIComponent(
      request.jobId,
    )}/claim-${request.claimVersion}`;
    const archive = this.#archiveMetadata(key, request, bytes.byteLength);
    const stored = await this.#bucket.put(key, bytes, {
      httpMetadata: { contentType: "application/zip" },
      customMetadata: this.#archiveCustomMetadata(archive),
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (stored) return Object.freeze({ kind: "stored", archive });
    const existing = await this.#get(key);
    if (!existing) return Object.freeze({ kind: "object_key_collision" });
    const existingBytes = await bodyBytes(existing);
    const same =
      existingBytes.byteLength === bytes.byteLength &&
      bytesEqual(existingBytes, bytes) &&
      (await this.calculateSha256(existingBytes)) === request.sha256 &&
      (existing.customMetadata?.archiveFormat ?? "MD-OKF-ZIP-1") === archive.archiveFormat &&
      (existing.customMetadata?.filename ?? "mind-diary-okf-bundle.zip") === archive.filename;
    return same
      ? Object.freeze({ kind: "already_exists", archive })
      : Object.freeze({ kind: "object_key_collision" });
  }

  async beginExportArchiveUpload(
    request: Readonly<ExportArchiveUploadRequest>,
  ): Promise<ExportArchiveUpload> {
    assertUtc(request.createdAt);
    const base = `${EXPORT_PREFIX}${encodeURIComponent(request.spaceId)}/${encodeURIComponent(
      request.jobId,
    )}/stream/`;
    const pending = new Uint8Array(EXPORT_STREAM_PART_BYTES);
    const parts: Array<Readonly<{ key: string; sha256: Digest; size: number }>> = [];
    let pendingLength = 0;
    let totalSize = 0;
    let closed = false;
    const flush = async () => {
      if (pendingLength === 0) return;
      const bytes = pending.slice(0, pendingLength);
      const sha256 = await this.calculateSha256(bytes);
      const partIndex = parts.length;
      const key = `${base}parts/${String(partIndex).padStart(8, "0")}-${sha256.slice(7)}`;
      const customMetadata = Object.freeze({
        schema: "md-r2-export-stream-part-v1",
        jobId: String(request.jobId),
        spaceId: String(request.spaceId),
        partIndex: String(partIndex),
        sha256,
        size: String(bytes.byteLength),
        createdAt: request.createdAt,
      });
      const stored = await this.#bucket.put(key, bytes, {
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata,
        onlyIf: { etagDoesNotMatch: "*" },
      });
      if (!stored) {
        const existing = await this.#get(key);
        if (
          !existing || existing.size !== bytes.byteLength ||
          existing.customMetadata?.sha256 !== sha256 ||
          !bytesEqual(await bodyBytes(existing), bytes)
        ) throw new ObjectStoreFailure(
          "digest_collision",
          "streamed export part key collision",
        );
      }
      parts.push(Object.freeze({ key, sha256, size: bytes.byteLength }));
      pendingLength = 0;
    };
    return Object.freeze({
      write: async (chunk: Uint8Array) => {
        if (closed) throw new Error("export upload is closed");
        if (!(chunk instanceof Uint8Array)) throw new TypeError("export chunk must be bytes");
        let offset = 0;
        while (offset < chunk.byteLength) {
          const copied = Math.min(
            EXPORT_STREAM_PART_BYTES - pendingLength,
            chunk.byteLength - offset,
          );
          pending.set(chunk.subarray(offset, offset + copied), pendingLength);
          pendingLength += copied;
          totalSize += copied;
          offset += copied;
          if (pendingLength === EXPORT_STREAM_PART_BYTES) await flush();
        }
      },
      complete: async (completion: Parameters<ExportArchiveUpload["complete"]>[0]) => {
        if (closed) throw new Error("export upload is closed");
        closed = true;
        await flush();
        if (completion.size !== totalSize || !Number.isSafeInteger(totalSize)) {
          return Object.freeze({ kind: "digest_mismatch" as const });
        }
        assertDigest(completion.sha256);
        const key = `${base}claim-${request.claimVersion}-manifest`;
        const archive = this.#archiveMetadata(
          key,
          { ...request, ...completion, bytes: new Uint8Array(0) },
          totalSize,
        );
        const manifestBytes = new TextEncoder().encode(`${JSON.stringify({
          schema: "md-r2-export-stream-manifest-v1",
          sha256: completion.sha256,
          size: totalSize,
          parts,
        })}\n`);
        const customMetadata = Object.freeze({
          ...this.#archiveCustomMetadata(archive),
          schema: "md-r2-export-stream-manifest-v1",
          partCount: String(parts.length),
        });
        const stored = await this.#bucket.put(key, manifestBytes, {
          httpMetadata: { contentType: "application/json" },
          customMetadata,
          onlyIf: { etagDoesNotMatch: "*" },
        });
        if (!stored) {
          const existing = await this.#get(key);
          if (!existing || !bytesEqual(await bodyBytes(existing), manifestBytes)) {
            return Object.freeze({ kind: "object_key_collision" as const });
          }
          return Object.freeze({ kind: "already_exists" as const, archive });
        }
        return Object.freeze({ kind: "stored" as const, archive });
      },
      // Persisted deterministic parts intentionally survive an interrupted
      // claim and are reused by its fenced retry. Job expiry owns final cleanup.
      abort: async () => {
        closed = true;
        pendingLength = 0;
      },
    });
  }

  async openExportArchive(
    objectKey: string,
  ): Promise<Readonly<OpenedExportArchive> | null> {
    const object = await this.#get(objectKey);
    if (!object || !objectKey.startsWith(EXPORT_PREFIX)) return null;
    const custom = object.customMetadata ?? {};
    const sha256 = custom.sha256 ?? "";
    assertDigest(sha256);
    const size = Number(custom.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new ObjectStoreFailure("object_tampered", "R2 export size is invalid");
    }
    if (custom.schema !== "md-r2-export-stream-manifest-v1") {
      const bytes = await bodyBytes(object);
      if (bytes.byteLength !== size || await this.calculateSha256(bytes) !== sha256) {
        throw new ObjectStoreFailure("object_tampered", "R2 export bytes are invalid");
      }
      return Object.freeze({ sha256, size, body: bytes });
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
        await bodyBytes(object),
      ));
    } catch {
      throw new ObjectStoreFailure("object_tampered", "R2 export stream manifest is invalid");
    }
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      throw new ObjectStoreFailure("object_tampered", "R2 export stream manifest is invalid");
    }
    const source = decoded as Record<string, unknown>;
    if (
      source.schema !== "md-r2-export-stream-manifest-v1" ||
      source.sha256 !== sha256 || source.size !== size || !Array.isArray(source.parts) ||
      source.parts.length !== Number(custom.partCount) || source.parts.length > 65_535
    ) throw new ObjectStoreFailure("object_tampered", "R2 export stream manifest differs");
    const parts = source.parts.map((value, index) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ObjectStoreFailure("object_tampered", "R2 export stream part is invalid");
      }
      const part = value as Record<string, unknown>;
      if (
        typeof part.key !== "string" ||
        !part.key.startsWith(`${objectKey.slice(0, objectKey.lastIndexOf("/") + 1)}parts/`) ||
        typeof part.sha256 !== "string" || !SHA256.test(part.sha256) ||
        !Number.isSafeInteger(part.size) || (part.size as number) < 0 ||
        !part.key.startsWith(`${EXPORT_PREFIX}`) ||
        !part.key.includes(`${String(index).padStart(8, "0")}-`)
      ) throw new ObjectStoreFailure("object_tampered", "R2 export stream part is invalid");
      return Object.freeze({
        key: part.key,
        sha256: part.sha256 as Digest,
        size: part.size as number,
      });
    });
    const bucket = this.#bucket;
    const calculateSha256 = (bytes: Uint8Array) => this.calculateSha256(bytes);
    let nextPart = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (nextPart >= parts.length) {
          controller.close();
          return;
        }
        const part = parts[nextPart]!;
        const stored = await bucket.get(part.key);
        if (!stored) {
          controller.error(new ObjectStoreFailure("object_tampered", "R2 export part is missing"));
          return;
        }
        const bytes = await bodyBytes(stored);
        if (bytes.byteLength !== part.size || await calculateSha256(bytes) !== part.sha256) {
          controller.error(new ObjectStoreFailure("object_tampered", "R2 export part is invalid"));
          return;
        }
        nextPart += 1;
        controller.enqueue(bytes);
      },
    });
    return Object.freeze({ sha256, size, body });
  }

  async readExportArchive(objectKey: string): Promise<Uint8Array | null> {
    const opened = await this.openExportArchive(objectKey);
    if (opened === null) return null;
    if (opened.body instanceof Uint8Array) return new Uint8Array(opened.body);
    const reader = opened.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      size += next.value.byteLength;
    }
    if (size !== opened.size) {
      throw new ObjectStoreFailure("object_tampered", "R2 export stream size differs");
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (await this.calculateSha256(bytes) !== opened.sha256) {
      throw new ObjectStoreFailure("object_tampered", "R2 export stream digest differs");
    }
    return bytes;
  }

  async deleteExportArchive(objectKey: string): Promise<boolean> {
    if (!objectKey.startsWith(EXPORT_PREFIX) || !(await this.#get(objectKey))) {
      return false;
    }
    await this.#bucket.delete(objectKey);
    return true;
  }

  async hasExportArchivesForJob(
    jobId: ExportArchiveWriteRequest["jobId"],
    spaceId: ExportArchiveWriteRequest["spaceId"],
  ): Promise<boolean> {
    const prefix = `${EXPORT_PREFIX}${encodeURIComponent(spaceId)}/${encodeURIComponent(jobId)}/`;
    const page = await this.#list({ prefix, limit: 1 });
    return page.objects.length > 0;
  }

  async deleteExportArchivesForJob(jobId: ExportArchiveWriteRequest["jobId"]): Promise<number> {
    return this.#deleteArchives((object) => object.customMetadata?.jobId === jobId);
  }

  async deleteExportArchivesForSpace(
    spaceId: ExportArchiveWriteRequest["spaceId"],
  ): Promise<number> {
    return this.#deleteArchives((object) => object.customMetadata?.spaceId === spaceId);
  }

  async listObjectCleanupPage(request: Readonly<{
    namespace: ObjectCleanupNamespace;
    cursor: string | null;
    limit: number;
  }>): Promise<Readonly<ObjectCleanupPage>> {
    if (!validCleanupNamespace(request.namespace)) {
      throw new TypeError("object cleanup namespace is invalid");
    }
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1_000) {
      throw new ObjectStoreFailure("invalid_limit", "object cleanup page limit is invalid");
    }
    if (request.cursor !== null && (request.cursor.length === 0 || request.cursor.length > 4096)) {
      throw new TypeError("object cleanup cursor is invalid");
    }
    const prefix = request.namespace === "immutable"
      ? CANONICAL_PREFIX
      : request.namespace === "bundle_file"
        ? BUNDLE_PREFIX
        : request.namespace === "space_canonical"
          ? SPACE_CANONICAL_PREFIX
          : request.namespace === "staged_bundle"
            ? STAGED_BUNDLE_PREFIX
            : EXPORT_PREFIX;
    const page = await this.#list({
      prefix,
      ...(request.cursor === null ? {} : { cursor: request.cursor }),
      limit: request.limit,
      include: ["customMetadata"],
    });
    if (page.truncated && !page.cursor) {
      throw new Error("R2 pagination cursor is missing");
    }
    const candidates: ObjectCleanupCandidate[] = [];
    for (const object of page.objects) {
      if (request.namespace === "immutable") {
        const metadata = metadataFromR2(object);
        candidates.push(Object.freeze({
          namespace: "immutable",
          objectKey: object.key,
          fence: object.etag,
          sha256: metadata.sha256,
          size: object.size,
          createdAt: metadata.createdAt,
          protectedAt: metadata.protectedAt,
        }));
      } else if (request.namespace === "bundle_file") {
        const metadata = this.#bundleMetadata(object);
        candidates.push(Object.freeze({
          namespace: "bundle_file",
          objectKey: object.key,
          fence: object.etag,
          spaceId: metadata.spaceId,
          sha256: metadata.sha256,
          size: object.size,
          createdAt: metadata.createdAt,
          protectedAt: metadata.protectedAt,
        }));
      } else if (request.namespace === "space_canonical") {
        if (!isSpaceCanonicalKey(object.key)) continue;
        const metadata = spaceCanonicalMetadataFromR2(object);
        candidates.push(Object.freeze({
          namespace: "space_canonical",
          objectKey: object.key,
          fence: object.etag,
          kind: metadata.kind,
          spaceId: metadata.spaceId,
          sha256: metadata.sha256,
          size: object.size,
          createdAt: metadata.createdAt,
          protectedAt: metadata.protectedAt,
        }));
      } else if (request.namespace === "staged_bundle") {
        const custom = object.customMetadata ?? {};
        const createdAt = custom.createdAt ?? "";
        assertUtc(createdAt);
        const streamed = custom.schema === "md-r2-staged-bundle-file-stream-v1";
        if (
          (!streamed && custom.schema !== "md-r2-staged-bundle-file-v1") ||
          typeof custom.stagedFileId !== "string" || custom.stagedFileId.length === 0 ||
          typeof custom.spaceId !== "string" || custom.spaceId.length === 0 ||
          (streamed
            ? !Number.isSafeInteger(Number(custom.maxBytes)) || Number(custom.maxBytes) < object.size
            : Number(custom.size) !== object.size)
        ) throw new ObjectStoreFailure("object_tampered", "staged cleanup metadata is invalid");
        candidates.push(Object.freeze({
          namespace: "staged_bundle",
          objectKey: object.key,
          fence: object.etag,
          stagedFileId: custom.stagedFileId as StagedBundleFileObject["stagedFileId"],
          spaceId: custom.spaceId as StagedBundleFileObject["spaceId"],
          size: object.size,
          createdAt,
        }));
      } else {
        const custom = object.customMetadata ?? {};
        const createdAt = custom.createdAt ?? "";
        assertUtc(createdAt);
        if (
          ![
            "md-r2-export-v1",
            "md-r2-export-stream-part-v1",
            "md-r2-export-stream-manifest-v1",
          ].includes(custom.schema ?? "") ||
          typeof custom.jobId !== "string" || custom.jobId.length === 0 ||
          typeof custom.spaceId !== "string" || custom.spaceId.length === 0
        ) throw new ObjectStoreFailure("object_tampered", "export cleanup metadata is invalid");
        candidates.push(Object.freeze({
          namespace: "export",
          objectKey: object.key,
          fence: object.etag,
          jobId: custom.jobId as ExportArchiveWriteRequest["jobId"],
          spaceId: custom.spaceId as ExportArchiveWriteRequest["spaceId"],
          size: object.size,
          createdAt,
        }));
      }
    }
    return Object.freeze({
      candidates: Object.freeze(candidates),
      listed: page.objects.length,
      nextCursor: page.truncated ? page.cursor! : null,
    });
  }

  async deleteObjectCleanupCandidate(request: Readonly<{
    candidate: Readonly<ObjectCleanupCandidate>;
    createdBefore: Utc;
  }>): Promise<boolean> {
    assertUtc(request.createdBefore);
    const candidate = request.candidate;
    const current = await this.#get(candidate.objectKey);
    if (!current || current.etag !== candidate.fence) return false;
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
    await this.#bucket.delete(candidate.objectKey);
    return true;
  }

  async #deleteArchives(predicate: (object: R2ListedObjectLike) => boolean): Promise<number> {
    const keys = (await this.#listAll(EXPORT_PREFIX)).filter(predicate).map((item) => item.key);
    if (keys.length > 0) await this.#bucket.delete(keys);
    return keys.length;
  }

  async #listAll(prefix: string): Promise<readonly R2ListedObjectLike[]> {
    const objects: R2ListedObjectLike[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#list({
        prefix,
        ...(cursor ? { cursor } : {}),
        limit: 1000,
        include: ["customMetadata"],
      });
      objects.push(...page.objects);
      cursor = page.truncated ? page.cursor : undefined;
      if (page.truncated && !cursor) throw new Error("R2 pagination cursor is missing");
    } while (cursor);
    return objects;
  }

  #bundleMetadata(
    object: R2ListedObjectLike,
  ): Readonly<BundleFileObjectMetadata> {
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
      Number(custom.size) !== object.size
    ) throw new ObjectStoreFailure("object_tampered", "R2 BundleFile metadata is invalid");
    return Object.freeze({
      spaceId: custom.spaceId as BundleFileObjectMetadata["spaceId"],
      sha256: digest,
      mediaType: mediaType as BundleFileObjectMetadata["mediaType"],
      size: object.size,
      createdAt,
      protectedAt,
    });
  }

  #bundleCustomMetadata(
    metadata: Readonly<BundleFileObjectMetadata>,
    state = ACTIVE_STATE,
    deleteBoundary = "",
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
    });
  }

  async #stagedBundleFile(
    object: R2ObjectBodyLike,
  ): Promise<Readonly<StagedBundleFileObject>> {
    const metadata = this.#stagedBundleMetadata(object);
    const bytes = await bodyBytes(object);
    return Object.freeze({ ...metadata, bytes, size: bytes.byteLength });
  }

  #stagedBundleMetadata(
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

  #archiveMetadata(
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

  #archiveCustomMetadata(archive: Readonly<StoredExportArchive>): Readonly<Record<string, string>> {
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
}

export async function createSitesObjectStore(bucket: R2BucketLike): Promise<SitesObjectStore> {
  return new SitesObjectStore(bucket).ready();
}
