import type { ActorContext } from "@mind-diary/application-contracts";
import {
  ObjectStoreFailure,
  type ObjectStore,
  type RevisionMetadataStore,
  type SearchIndex,
} from "@mind-diary/application-ports";
import {
  MARKDOWN_MEDIA_TYPE,
  canonicalMarkdownPath,
  createCanonicalRevisionEnvelope,
  createRevisionManifest,
  serializeRevisionManifest,
  utcInstant,
  type CanonicalRevisionEnvelope,
  type MarkdownMediaType,
  type RevisionAuthorReference,
  type RevisionId,
  type Sha256Digest,
  type SpaceId,
  type UtcInstant,
} from "@mind-diary/domain";
import type { OkfBundleFixture } from "@mind-diary/okf-codec";

export const CONTENT_QUERIES = [
  "list_minds",
  "resolve_mind",
  "get_mind_info",
  "browse_entries",
  "search_entries",
  "fetch_entry",
  "list_revisions",
  "get_revision",
  "validate_revision",
  "get_export_status",
] as const;

export const CONTENT_COMMANDS = ["commit_changeset", "start_export"] as const;

export interface ContentBoundaryMarker {
  readonly actor: ActorContext;
  readonly spaceId: SpaceId;
  readonly objectStore: ObjectStore;
  readonly searchIndex: SearchIndex;
  readonly fixtureOnlyBundle?: OkfBundleFixture;
}

export interface CanonicalRevisionFileInput {
  readonly path: string;
  readonly mediaType: MarkdownMediaType;
  readonly bytes: Uint8Array;
}

export interface CommitCanonicalRevisionRequest {
  readonly spaceId: SpaceId;
  readonly expectedRevisionId: RevisionId | null;
  /** Stable server-issued ID makes an exact low-level retry idempotent. */
  readonly revisionId: RevisionId;
  readonly committedAt: UtcInstant | string;
  readonly committedBy: RevisionAuthorReference;
  readonly summary: string;
  readonly files: readonly CanonicalRevisionFileInput[];
}

export type CommitCanonicalRevisionResult =
  | {
      readonly kind: "committed";
      readonly envelope: Readonly<CanonicalRevisionEnvelope>;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "stale_head";
      readonly currentHeadRevisionId: RevisionId | null;
    };

export type CanonicalRevisionErrorCode =
  | "invalid_file"
  | "invalid_utf8"
  | "parent_not_found"
  | "revision_id_collision"
  | "invalid_revision_chain"
  | "revision_not_found"
  | "manifest_integrity_failure"
  | "object_not_found"
  | "object_integrity_failure"
  | "invalid_gc_limit";

export class CanonicalRevisionError extends Error {
  readonly code: CanonicalRevisionErrorCode;

  constructor(code: CanonicalRevisionErrorCode, message: string) {
    super(message);
    this.name = "CanonicalRevisionError";
    this.code = code;
  }
}

export interface MaterializedRevisionFile {
  readonly path: string;
  readonly mediaType: MarkdownMediaType;
  readonly sha256: Sha256Digest;
  readonly size: number;
  readonly bytes: Uint8Array;
  readonly text: string;
}

export interface MaterializedRevision {
  readonly envelope: Readonly<CanonicalRevisionEnvelope>;
  readonly files: readonly Readonly<MaterializedRevisionFile>[];
}

export interface UnreachableObjectCollectionResult {
  readonly scanned: number;
  readonly deleted: number;
  readonly deletedDigests: readonly Sha256Digest[];
}

interface ValidatedFile {
  readonly path: string;
  readonly mediaType: MarkdownMediaType;
  readonly bytes: Uint8Array;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CanonicalRevisionError(
      "invalid_utf8",
      "canonical revision files must contain valid UTF-8 bytes",
    );
  }
}

function validateFiles(
  files: readonly CanonicalRevisionFileInput[],
): readonly ValidatedFile[] {
  if (!Array.isArray(files)) {
    throw new CanonicalRevisionError("invalid_file", "revision files must be an array");
  }
  const seen = new Set<string>();
  return files.map((file) => {
    if (
      typeof file !== "object" ||
      file === null ||
      !(file.bytes instanceof Uint8Array)
    ) {
      throw new CanonicalRevisionError(
        "invalid_file",
        "each revision file must provide Uint8Array bytes",
      );
    }
    const path = canonicalMarkdownPath(file.path);
    if (seen.has(path)) {
      throw new CanonicalRevisionError(
        "invalid_file",
        `duplicate revision path ${JSON.stringify(path)}`,
      );
    }
    seen.add(path);
    if (file.mediaType !== MARKDOWN_MEDIA_TYPE) {
      throw new CanonicalRevisionError(
        "invalid_file",
        `canonical revision media type must be ${MARKDOWN_MEDIA_TYPE}`,
      );
    }
    const bytes = new Uint8Array(file.bytes);
    decodeUtf8(bytes);
    return Object.freeze({ path, mediaType: MARKDOWN_MEDIA_TYPE, bytes });
  });
}

export class CanonicalRevisionCoordinator {
  readonly #objects: ObjectStore;
  readonly #revisions: RevisionMetadataStore;

  constructor(dependencies: {
    readonly objects: ObjectStore;
    readonly revisions: RevisionMetadataStore;
  }) {
    this.#objects = dependencies.objects;
    this.#revisions = dependencies.revisions;
  }

  async commit(
    request: CommitCanonicalRevisionRequest,
  ): Promise<CommitCanonicalRevisionResult> {
    const committedAt = utcInstant(request.committedAt);
    const files = validateFiles(request.files);
    let nextRevisionNumber = 1;
    if (request.expectedRevisionId !== null) {
      const parent = await this.#revisions.readRevision(
        request.spaceId,
        request.expectedRevisionId,
      );
      if (!parent) {
        throw new CanonicalRevisionError(
          "parent_not_found",
          "the expected parent revision does not exist in this Mind",
        );
      }
      nextRevisionNumber = parent.revision.revisionNumber + 1;
    }

    const entries = [];
    for (const file of files) {
      const put = await this.#objects.putImmutable({
        bytes: file.bytes,
        mediaType: file.mediaType,
        createdAt: committedAt,
      });
      entries.push({
        path: file.path,
        sha256: put.object.sha256,
        mediaType: put.object.mediaType,
        size: put.object.size,
      });
    }
    const manifest = createRevisionManifest(entries);
    const manifestHash = await this.#objects.calculateSha256(
      new TextEncoder().encode(serializeRevisionManifest(manifest)),
    );
    const envelope = createCanonicalRevisionEnvelope({
      revisionId: request.revisionId,
      spaceId: request.spaceId,
      revisionNumber: nextRevisionNumber,
      parentRevisionId: request.expectedRevisionId,
      committedAt,
      committedBy: request.committedBy,
      manifest,
      manifestHash,
      summary: request.summary,
    });
    const result = await this.#revisions.commitRevision({
      expectedHeadRevisionId: request.expectedRevisionId,
      envelope,
    });
    if (result.kind === "committed") {
      return Object.freeze({
        kind: "committed",
        envelope: result.envelope,
        replayed: result.replayed,
      });
    }
    if (result.kind === "stale_head") return result;
    if (result.kind === "revision_id_collision") {
      throw new CanonicalRevisionError(
        "revision_id_collision",
        "revision ID is already bound to different immutable metadata",
      );
    }
    throw new CanonicalRevisionError(
      "invalid_revision_chain",
      `revision metadata rejected the canonical envelope: ${result.reason}`,
    );
  }

  async materialize(
    spaceId: SpaceId,
    revisionId: RevisionId,
  ): Promise<Readonly<MaterializedRevision>> {
    const envelope = await this.#revisions.readRevision(spaceId, revisionId);
    if (!envelope) {
      throw new CanonicalRevisionError(
        "revision_not_found",
        "exact revision does not exist in this Mind",
      );
    }
    const actualManifestHash = await this.#objects.calculateSha256(
      new TextEncoder().encode(serializeRevisionManifest(envelope.manifest)),
    );
    if (actualManifestHash !== envelope.revision.manifestHash) {
      throw new CanonicalRevisionError(
        "manifest_integrity_failure",
        "committed manifest no longer matches its immutable hash",
      );
    }

    const files: MaterializedRevisionFile[] = [];
    for (const entry of envelope.manifest.entries) {
      let object;
      try {
        object = await this.#objects.getImmutable(entry.sha256);
      } catch (error) {
        if (error instanceof ObjectStoreFailure && error.code === "object_tampered") {
          throw new CanonicalRevisionError(
            "object_integrity_failure",
            `committed object failed integrity verification for ${JSON.stringify(entry.path)}`,
          );
        }
        throw error;
      }
      if (!object) {
        throw new CanonicalRevisionError(
          "object_not_found",
          `committed object is missing for ${JSON.stringify(entry.path)}`,
        );
      }
      if (
        object.sha256 !== entry.sha256 ||
        object.mediaType !== entry.mediaType ||
        object.size !== entry.size ||
        object.bytes.byteLength !== entry.size
      ) {
        throw new CanonicalRevisionError(
          "object_integrity_failure",
          `committed object metadata differs for ${JSON.stringify(entry.path)}`,
        );
      }
      const bytes = new Uint8Array(object.bytes);
      files.push(
        Object.freeze({
          path: entry.path,
          mediaType: entry.mediaType,
          sha256: entry.sha256,
          size: entry.size,
          bytes,
          text: decodeUtf8(bytes),
        }),
      );
    }
    return Object.freeze({ envelope, files: Object.freeze(files) });
  }

  async collectUnreachableObjects(request: {
    readonly createdBefore: UtcInstant | string;
    readonly limit: number;
  }): Promise<Readonly<UnreachableObjectCollectionResult>> {
    const createdBefore = utcInstant(request.createdBefore);
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
      throw new CanonicalRevisionError(
        "invalid_gc_limit",
        "garbage collection limit must be a positive safe integer",
      );
    }
    const reachable = new Set(await this.#revisions.listReachableObjectDigests());
    const candidates = await this.#objects.listImmutableObjects({
      createdBefore,
      excludedDigests: [...reachable],
      limit: request.limit,
    });
    const deletedDigests: Sha256Digest[] = [];
    for (const candidate of candidates) {
      if (reachable.has(candidate.sha256)) continue;
      const deleted = await this.#objects.deleteImmutableObject({
        sha256: candidate.sha256,
        expectedProtectedAt: candidate.protectedAt,
        createdBefore,
      });
      if (deleted) deletedDigests.push(candidate.sha256);
    }
    return Object.freeze({
      scanned: candidates.length,
      deleted: deletedDigests.length,
      deletedDigests: Object.freeze(deletedDigests),
    });
  }
}
