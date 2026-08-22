import {
  ObjectStoreFailure,
  type ExportArchivePutResult,
  type ExportArchiveStore,
  type ExportArchiveWriteRequest,
  type ImmutableObject,
  type ImmutableObjectDeleteRequest,
  type ImmutableObjectListRequest,
  type ImmutableObjectMetadata,
  type ImmutableObjectPutResult,
  type ImmutableObjectWriteRequest,
  type ObjectStore,
  type BundleFileObject,
  type BundleFileObjectMetadata,
  type BundleFileObjectPutResult,
  type BundleFileObjectStore,
  type BundleFileObjectWriteRequest,
  type BundleFileObjectListRequest,
  type BundleFileObjectDeleteRequest,
  type StagedBundleFileObject,
  type StagedBundleFileObjectWriteRequest,
  type StoredExportArchive,
} from "@mind-diary/application-ports";

export const SITES_OBJECT_ADAPTER = "sites-r2-immutable-envelope" as const;

export interface R2ObjectBodyLike {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly customMetadata?: Readonly<Record<string, string>>;
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
    value: ArrayBuffer | Uint8Array,
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
const DELETE_STATE = "deleting";
const ACTIVE_STATE = "active";
const MAX_R2_CAS_ATTEMPTS = 16;
const BUNDLE_FILE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/zip",
]);

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
  if (!BUNDLE_FILE_MEDIA_TYPES.has(mediaType)) {
    throw new ObjectStoreFailure("invalid_media_type", "BundleFile media type is not allowed");
  }
}

function canonicalKey(digest: Digest): string {
  return `${CANONICAL_PREFIX}${digest.slice("sha256:".length)}`;
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

async function bodyBytes(object: R2ObjectBodyLike): Promise<Uint8Array> {
  return new Uint8Array(await object.arrayBuffer());
}

/** R2-backed canonical and export object namespaces with conditional GC lease claims. */
export class SitesObjectStore implements BundleFileObjectStore, ExportArchiveStore {
  readonly kind = "object-store" as const;
  readonly #bucket: R2BucketLike;

  constructor(bucket: R2BucketLike) {
    this.#bucket = bucket;
  }

  async ready(): Promise<this> {
    return this;
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
      const existing = await this.#bucket.get(key);
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
    const object = await this.#bucket.get(canonicalKey(digest));
    if (!object) return null;
    const metadata = metadataFromR2(object);
    const bytes = await bodyBytes(object);
    assertMarkdown(bytes, metadata.mediaType);
    if ((await this.calculateSha256(bytes)) !== digest || bytes.byteLength !== metadata.size) {
      throw new ObjectStoreFailure("object_tampered", "R2 immutable bytes are invalid");
    }
    return Object.freeze({ ...metadata, bytes });
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
      const existing = await this.#bucket.get(key);
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
    const object = await this.#bucket.get(key);
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
      const current = await this.#bucket.get(key);
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
      const existing = await this.#bucket.get(key);
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
      const body = await this.#bucket.get(key);
      if (!body) continue;
      return this.#stagedBundleFile(body);
    }
    throw new Error("R2 staged BundleFile CAS retry budget exhausted");
  }

  async getStagedBundleFile(
    stagedFileId: string,
  ): Promise<Readonly<StagedBundleFileObject> | null> {
    const object = await this.#bucket.get(
      `${STAGED_BUNDLE_PREFIX}${encodeURIComponent(stagedFileId)}`,
    );
    return object === null ? null : this.#stagedBundleFile(object);
  }

  async deleteStagedBundleFile(stagedFileId: string): Promise<boolean> {
    const key = `${STAGED_BUNDLE_PREFIX}${encodeURIComponent(stagedFileId)}`;
    if (!(await this.#bucket.get(key))) return false;
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
      const current = await this.#bucket.get(key);
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
    const existing = await this.#bucket.get(key);
    if (!existing) return Object.freeze({ kind: "object_key_collision" });
    const existingBytes = await bodyBytes(existing);
    const same =
      existingBytes.byteLength === bytes.byteLength &&
      bytesEqual(existingBytes, bytes) &&
      (await this.calculateSha256(existingBytes)) === request.sha256;
    return same
      ? Object.freeze({ kind: "already_exists", archive })
      : Object.freeze({ kind: "object_key_collision" });
  }

  async readExportArchive(objectKey: string): Promise<Uint8Array | null> {
    const object = await this.#bucket.get(objectKey);
    if (!object || !objectKey.startsWith(EXPORT_PREFIX)) return null;
    const bytes = await bodyBytes(object);
    const digest = object.customMetadata?.sha256 ?? "";
    assertDigest(digest);
    if ((await this.calculateSha256(bytes)) !== digest) {
      throw new ObjectStoreFailure("object_tampered", "R2 export bytes are invalid");
    }
    return bytes;
  }

  async deleteExportArchive(objectKey: string): Promise<boolean> {
    if (!objectKey.startsWith(EXPORT_PREFIX) || !(await this.#bucket.get(objectKey))) {
      return false;
    }
    await this.#bucket.delete(objectKey);
    return true;
  }

  async deleteExportArchivesForJob(jobId: ExportArchiveWriteRequest["jobId"]): Promise<number> {
    return this.#deleteArchives((object) => object.customMetadata?.jobId === jobId);
  }

  async deleteExportArchivesForSpace(
    spaceId: ExportArchiveWriteRequest["spaceId"],
  ): Promise<number> {
    return this.#deleteArchives((object) => object.customMetadata?.spaceId === spaceId);
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
      const page = await this.#bucket.list({
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
    const custom = object.customMetadata ?? {};
    const createdAt = custom.createdAt ?? "";
    assertUtc(createdAt);
    if (
      custom.schema !== "md-r2-staged-bundle-file-v1" ||
      typeof custom.stagedFileId !== "string" || custom.stagedFileId.length === 0 ||
      typeof custom.bindingOwnerId !== "string" || custom.bindingOwnerId.length === 0 ||
      typeof custom.spaceId !== "string" || custom.spaceId.length === 0 ||
      Number(custom.size) !== object.size
    ) throw new ObjectStoreFailure("object_tampered", "staged BundleFile metadata is invalid");
    const bytes = await bodyBytes(object);
    return Object.freeze({
      stagedFileId: custom.stagedFileId as StagedBundleFileObject["stagedFileId"],
      bindingOwnerId: custom.bindingOwnerId as StagedBundleFileObject["bindingOwnerId"],
      spaceId: custom.spaceId as StagedBundleFileObject["spaceId"],
      bytes,
      size: bytes.byteLength,
      createdAt,
    });
  }

  #archiveMetadata(
    objectKey: string,
    request: ExportArchiveWriteRequest,
    size: number,
  ): Readonly<StoredExportArchive> {
    return Object.freeze({
      objectKey,
      jobId: request.jobId,
      spaceId: request.spaceId,
      claimVersion: request.claimVersion,
      archiveFormat: "MD-OKF-ZIP-1",
      mediaType: "application/zip",
      filename: "mind-diary-okf-bundle.zip",
      contentDisposition: 'attachment; filename="mind-diary-okf-bundle.zip"',
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
      createdAt: archive.createdAt,
    });
  }
}

export async function createSitesObjectStore(bucket: R2BucketLike): Promise<SitesObjectStore> {
  return new SitesObjectStore(bucket).ready();
}
