import type { ActorContext } from "@mind-diary/application-contracts";
import type {
  Authorizer,
  BundleFileObjectStore,
  BundleFileStagingStore,
  Clock,
  StagedBundleFileRecord,
} from "@mind-diary/application-ports";
import {
  BUNDLE_FILE_MEDIA_TYPES,
  bundleFileMediaType,
  opaqueId,
  utcInstant,
  type BundleFileMediaType,
  type SpaceId,
  type StagedBundleFileId,
  type WriteMindBindingId,
} from "@mind-diary/domain";

export const BUNDLE_FILE_LIMITS = Object.freeze({
  maxFileBytes: 67_108_864,
  maxOutstandingStagedBytes: 268_435_456,
  stagedTtlMilliseconds: 60 * 60 * 1_000,
  gcSafetyMilliseconds: 24 * 60 * 60 * 1_000,
  gcMaxObjects: 100,
  gcMaxBytes: 268_435_456,
});

export interface StagedBundleFileIdGenerator {
  nextStagedBundleFileId(): StagedBundleFileId;
}

export interface StageBundleFileRequest {
  readonly actor: ActorContext;
  readonly spaceId: SpaceId;
  readonly writeBindingId: unknown;
  readonly displayFilename: unknown;
  readonly claimedMediaType: unknown;
  readonly bytes: unknown;
}

export type StageBundleFileResult =
  | { readonly kind: "staged"; readonly record: Readonly<StagedBundleFileRecord> }
  | { readonly kind: "denied"; readonly decision: unknown }
  | {
      readonly kind: "invalid";
      readonly code:
        | "mcp_token_required"
        | "invalid_write_binding_id"
        | "invalid_filename"
        | "file_size_limit_exceeded"
        | "media_type_not_allowed"
        | "file_signature_mismatch"
        | "file_extension_mismatch"
        | "binding_mismatch"
        | "outstanding_staged_byte_limit_exceeded";
    };

const ENCODER = new TextEncoder();
const CONTROL = /[\u0000-\u001f\u007f]/u;
const EXTENSIONS: Readonly<Record<BundleFileMediaType, readonly string[]>> = Object.freeze({
  "image/png": Object.freeze([".png"]),
  "image/jpeg": Object.freeze([".jpg", ".jpeg"]),
  "image/gif": Object.freeze([".gif"]),
  "image/webp": Object.freeze([".webp"]),
  "application/pdf": Object.freeze([".pdf"]),
  "application/zip": Object.freeze([".zip"]),
});

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

export function detectBundleFileMediaType(bytes: Uint8Array): BundleFileMediaType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) return "image/gif";
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "image/webp";
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) return "application/zip";
  return null;
}

function filename(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.normalize("NFC") ||
    value.includes("/") || value.includes("\\") ||
    value === "." || value === ".." ||
    CONTROL.test(value) ||
    ENCODER.encode(value).byteLength > 255
  ) return null;
  return value;
}

function extensionMatches(name: string, mediaType: BundleFileMediaType): boolean {
  const lower = name.toLocaleLowerCase("en-US");
  return EXTENSIONS[mediaType].some((extension) => lower.endsWith(extension));
}

function expiresAt(createdAt: string): StagedBundleFileRecord["expiresAt"] {
  return utcInstant(
    new Date(Date.parse(createdAt) + BUNDLE_FILE_LIMITS.stagedTtlMilliseconds).toISOString(),
  );
}

export class BundleFileStagingService {
  readonly #authorizer: Authorizer;
  readonly #metadata: BundleFileStagingStore;
  readonly #objects: BundleFileObjectStore;
  readonly #clock: Clock;
  readonly #ids: StagedBundleFileIdGenerator;

  constructor(dependencies: {
    readonly authorizer: Authorizer;
    readonly metadata: BundleFileStagingStore;
    readonly objects: BundleFileObjectStore;
    readonly clock: Clock;
    readonly ids?: StagedBundleFileIdGenerator;
  }) {
    this.#authorizer = dependencies.authorizer;
    this.#metadata = dependencies.metadata;
    this.#objects = dependencies.objects;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids ?? {
      nextStagedBundleFileId: () =>
        opaqueId<"staged-bundle-file">(`staged_${crypto.randomUUID()}`),
    };
  }

  async stage(request: StageBundleFileRequest): Promise<StageBundleFileResult> {
    const actor = request.actor;
    if (
      actor.kind !== "registered_principal" ||
      actor.authentication.kind !== "mcp_token"
    ) return Object.freeze({ kind: "invalid", code: "mcp_token_required" });
    if (typeof request.writeBindingId !== "string" || request.writeBindingId.length === 0) {
      return Object.freeze({ kind: "invalid", code: "invalid_write_binding_id" });
    }
    const displayFilename = filename(request.displayFilename);
    if (displayFilename === null) {
      return Object.freeze({ kind: "invalid", code: "invalid_filename" });
    }
    if (!(request.bytes instanceof Uint8Array)) {
      return Object.freeze({ kind: "invalid", code: "file_signature_mismatch" });
    }
    const bytes = new Uint8Array(request.bytes);
    if (bytes.byteLength > BUNDLE_FILE_LIMITS.maxFileBytes) {
      return Object.freeze({ kind: "invalid", code: "file_size_limit_exceeded" });
    }
    if (
      typeof request.claimedMediaType !== "string" ||
      !(BUNDLE_FILE_MEDIA_TYPES as readonly string[]).includes(request.claimedMediaType)
    ) return Object.freeze({ kind: "invalid", code: "media_type_not_allowed" });
    const claimedMediaType = bundleFileMediaType(request.claimedMediaType);
    const detected = detectBundleFileMediaType(bytes);
    if (detected === null || detected !== claimedMediaType) {
      return Object.freeze({ kind: "invalid", code: "file_signature_mismatch" });
    }
    if (!extensionMatches(displayFilename, detected)) {
      return Object.freeze({ kind: "invalid", code: "file_extension_mismatch" });
    }

    const writeBindingId = request.writeBindingId as WriteMindBindingId;
    const bindingOwnerId = actor.authentication.bindingOwnerId;
    const initial = await this.#authorizer.authorize({
      actor,
      spaceId: request.spaceId,
      capability: "content:write",
      revisionMode: "head",
      bindingRequirement: Object.freeze({ kind: "write", writeBindingId }),
    });
    if (initial.kind === "denied") {
      return Object.freeze({ kind: "denied", decision: initial });
    }

    const createdAt = this.#clock.now();
    const stagedFileId = this.#ids.nextStagedBundleFileId();
    const sha256 = await this.#objects.calculateSha256(bytes);
    await this.#objects.putStagedBundleFile({
      stagedFileId,
      bindingOwnerId,
      spaceId: request.spaceId,
      bytes,
      createdAt,
    });

    const result = await this.#metadata.runBundleFileStagingTransaction(
      async (transaction) => {
        const authorization = await this.#authorizer.reauthorizeInTransaction(
          {
            actor,
            spaceId: request.spaceId,
            capability: "content:write",
            revisionMode: "head",
            bindingRequirement: Object.freeze({ kind: "write", writeBindingId }),
          },
          transaction,
          initial.stamp,
        );
        if (authorization.kind === "denied") {
          return Object.freeze({ kind: "denied", decision: authorization } as const);
        }
        const bindings = await transaction.readMindBindingSet?.(
          bindingOwnerId,
          actor.principalId,
          createdAt,
        );
        const write = bindings?.writeBinding;
        if (
          write === null || write === undefined ||
          write.state !== "active" ||
          write.writeBindingId !== writeBindingId ||
          write.spaceId !== request.spaceId
        ) return Object.freeze({ kind: "invalid", code: "binding_mismatch" } as const);
        const record: Readonly<StagedBundleFileRecord> = Object.freeze({
          stagedFileId,
          bindingOwnerId,
          writeBindingId,
          writeBindingGeneration: write.generation,
          spaceId: request.spaceId,
          displayFilename,
          mediaType: detected,
          sha256,
          size: bytes.byteLength,
          state: "verified",
          createdAt,
          expiresAt: expiresAt(createdAt),
          consumedAt: null,
          rejectionCode: null,
        });
        const created = await transaction.createStagedBundleFile(
          record,
          BUNDLE_FILE_LIMITS.maxOutstandingStagedBytes,
          createdAt,
        );
        return created.kind === "created"
          ? Object.freeze({ kind: "staged", record: created.record } as const)
          : Object.freeze({
              kind: "invalid",
              code: created.kind === "outstanding_byte_limit_exceeded"
                ? "outstanding_staged_byte_limit_exceeded"
                : "binding_mismatch",
            } as const);
      },
    );
    if (result.kind !== "staged") {
      await this.#objects.deleteStagedBundleFile(stagedFileId);
    }
    return result;
  }

  async collectExpired(): Promise<Readonly<{ scanned: number; deleted: number; bytes: number }>> {
    const now = this.#clock.now();
    const createdBefore = utcInstant(
      new Date(Date.parse(now) - BUNDLE_FILE_LIMITS.gcSafetyMilliseconds).toISOString(),
    );
    const candidates = await this.#metadata.collectStagedBundleFilesForGc({
      createdBefore,
      limit: BUNDLE_FILE_LIMITS.gcMaxObjects,
    });
    let deleted = 0;
    let bytes = 0;
    for (const candidate of candidates) {
      if (bytes + candidate.size > BUNDLE_FILE_LIMITS.gcMaxBytes) break;
      if (await this.#objects.deleteStagedBundleFile(candidate.stagedFileId)) {
        if (await this.#metadata.deleteExpiredStagedBundleFileRecord(candidate.stagedFileId)) {
          deleted += 1;
          bytes += candidate.size;
        }
      }
    }
    return Object.freeze({ scanned: candidates.length, deleted, bytes });
  }
}
