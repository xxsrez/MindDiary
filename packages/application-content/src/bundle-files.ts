import type { ActorContext } from "@mind-diary/application-contracts";
import type {
  Authorizer,
  BundleFileObjectStore,
  BundleFileStagingStore,
  Clock,
  IdempotencyNamespace,
  StagedBundleFileRecord,
} from "@mind-diary/application-ports";
import {
  BUNDLE_FILE_MEDIA_TYPES,
  bundleFileMediaType,
  opaqueId,
  utcInstant,
  type BundleFileMediaType,
  type IdempotencyKey,
  type Sha256Digest,
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
  readonly idempotencyKey: unknown;
  readonly expectedSize?: unknown;
  readonly expectedSha256?: unknown;
}

export type StageBundleFileResult =
  | {
      readonly kind: "staged";
      readonly record: Readonly<StagedBundleFileRecord>;
      readonly replayed: boolean;
    }
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
        | "outstanding_staged_byte_limit_exceeded"
        | "invalid_idempotency_key"
        | "expected_size_mismatch"
        | "expected_sha256_mismatch"
        | "idempotency_conflict"
        | "invalid_idempotency_state"
        | "staged_file_expired"
        | "staged_file_consumed"
        | "staged_file_rejected"
        | "unsupported_bundle_file_type"
        | "bundle_file_media_mismatch";
    };

const ENCODER = new TextEncoder();
const CONTROL = /[\u0000-\u001f\u007f]/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
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
    if (
      typeof request.idempotencyKey !== "string" ||
      request.idempotencyKey.length === 0 ||
      CONTROL.test(request.idempotencyKey) ||
      ENCODER.encode(request.idempotencyKey).byteLength > 256
    ) return Object.freeze({ kind: "invalid", code: "invalid_idempotency_key" });
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
      request.expectedSize !== undefined &&
      (!Number.isSafeInteger(request.expectedSize) || (request.expectedSize as number) < 0)
    ) return Object.freeze({ kind: "invalid", code: "expected_size_mismatch" });
    if (
      request.expectedSha256 !== undefined &&
      (typeof request.expectedSha256 !== "string" || !SHA256.test(request.expectedSha256))
    ) return Object.freeze({ kind: "invalid", code: "expected_sha256_mismatch" });
    const detected = detectBundleFileMediaType(bytes);
    if (detected === null) {
      return Object.freeze({ kind: "invalid", code: "unsupported_bundle_file_type" });
    }
    if (
      request.claimedMediaType !== undefined &&
      (typeof request.claimedMediaType !== "string" ||
        !(BUNDLE_FILE_MEDIA_TYPES as readonly string[]).includes(request.claimedMediaType))
    ) return Object.freeze({ kind: "invalid", code: "media_type_not_allowed" });
    if (
      request.claimedMediaType !== undefined &&
      detected !== bundleFileMediaType(request.claimedMediaType as string)
    ) return Object.freeze({ kind: "invalid", code: "bundle_file_media_mismatch" });
    if (!extensionMatches(displayFilename, detected)) {
      return Object.freeze({ kind: "invalid", code: "bundle_file_media_mismatch" });
    }
    if (
      request.expectedSize !== undefined &&
      request.expectedSize !== bytes.byteLength
    ) return Object.freeze({ kind: "invalid", code: "expected_size_mismatch" });

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
    if (
      request.expectedSha256 !== undefined &&
      request.expectedSha256 !== sha256
    ) return Object.freeze({ kind: "invalid", code: "expected_sha256_mismatch" });
    const canonicalRequestHash = await this.#objects.calculateSha256(
      ENCODER.encode(`${JSON.stringify({
        format: "mind-diary-stage-bundle-file-request-v1",
        binding_owner_id: bindingOwnerId,
        write_binding_id: writeBindingId,
        display_filename: displayFilename,
        claimed_media_type: request.claimedMediaType ?? null,
        expected_size: request.expectedSize ?? null,
        expected_sha256: request.expectedSha256 ?? null,
        media_type: detected,
        sha256,
        size: bytes.byteLength,
      })}\n`),
    );
    const namespace: Readonly<
      IdempotencyNamespace & { readonly operation: "stage_bundle_file" }
    > = Object.freeze({
      principalId: actor.principalId,
      bindingOwnerId,
      spaceId: request.spaceId,
      operation: "stage_bundle_file",
      key: request.idempotencyKey as IdempotencyKey,
    });
    await this.#objects.putStagedBundleFile({
      stagedFileId,
      bindingOwnerId,
      spaceId: request.spaceId,
      bytes,
      createdAt,
    });

    let result: StageBundleFileResult;
    try {
      result = await this.#metadata.runBundleFileStagingTransaction(
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
          const idempotency = await transaction.checkIdempotency({
            namespace,
            canonicalRequestHash,
          });
          if (idempotency.kind === "conflict") {
            return Object.freeze({ kind: "invalid", code: "idempotency_conflict" } as const);
          }
          if (idempotency.kind === "replay") {
            if (
              idempotency.record.operation !== "stage_bundle_file" ||
              idempotency.record.result.kind !== "stage_bundle_file"
            ) {
              return Object.freeze({ kind: "invalid", code: "invalid_idempotency_state" } as const);
            }
            const replay = await transaction.readStagedBundleFile(
              idempotency.record.result.stagedFileId,
            );
            if (replay === null) {
              return Object.freeze({ kind: "invalid", code: "invalid_idempotency_state" } as const);
            }
            if (Date.parse(replay.expiresAt) <= Date.parse(createdAt)) {
              return Object.freeze({ kind: "invalid", code: "staged_file_expired" } as const);
            }
            if (replay.state === "consumed") {
              return Object.freeze({ kind: "invalid", code: "staged_file_consumed" } as const);
            }
            if (replay.state === "rejected") {
              return Object.freeze({ kind: "invalid", code: "staged_file_rejected" } as const);
            }
            return replay.state === "verified"
              ? Object.freeze({ kind: "staged", record: replay, replayed: true } as const)
              : Object.freeze({ kind: "invalid", code: "invalid_idempotency_state" } as const);
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
          ) {
            return Object.freeze({ kind: "invalid", code: "binding_mismatch" } as const);
          }
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
          if (created.kind !== "created") {
            return Object.freeze({
              kind: "invalid",
              code: created.kind === "outstanding_byte_limit_exceeded"
                ? "outstanding_staged_byte_limit_exceeded"
                : "binding_mismatch",
            } as const);
          }
          const completion = await transaction.completeIdempotency({
            namespace,
            canonicalRequestHash: canonicalRequestHash as Sha256Digest,
            result: Object.freeze({
              kind: "stage_bundle_file",
              stagedFileId: created.record.stagedFileId,
            }),
            completedAt: createdAt,
          });
          return completion.kind === "completed"
            ? Object.freeze({ kind: "staged", record: created.record, replayed: false } as const)
            : Object.freeze({ kind: "invalid", code: "invalid_idempotency_state" } as const);
        },
      );
    } catch (error) {
      await this.#objects.deleteStagedBundleFile(stagedFileId).catch(() => false);
      throw error;
    }
    if (result.kind !== "staged" || result.record.stagedFileId !== stagedFileId) {
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
