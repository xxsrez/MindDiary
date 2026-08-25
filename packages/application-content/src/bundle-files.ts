import type {
  ActorContext,
  McpTokenActorContext,
} from "@mind-diary/application-contracts";
import { FILE_INGRESS_SOURCE_KINDS } from "@mind-diary/application-ports";
import type {
  Authorizer,
  BundleFileObjectStore,
  BundleFileStagingStore,
  CapacityLimits,
  Clock,
  FileIngressSourceKind,
  IdempotencyNamespace,
  StagedBundleFileRecord,
  StagedBundleFileUpload,
} from "@mind-diary/application-ports";
import {
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
import {
  CapacityAdmissionService,
  capacityReservationId,
} from "./capacity.js";
import { IncrementalSha256 } from "./incremental-sha256.js";

export const BUNDLE_FILE_LIMITS = Object.freeze({
  maxFileBytes: 268_435_456,
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
  /** Safe source provenance only; transport identifiers stay in adapters. */
  readonly sourceKind?: unknown;
  readonly expectedSize?: unknown;
  readonly expectedSha256?: unknown;
}

/** Exact safe receipt used to resolve an unknown staging outcome without bytes. */
export interface ReconcileStageBundleFileRequest
  extends Omit<StageBundleFileRequest, "bytes"> {
  readonly mediaType: unknown;
  readonly sha256: unknown;
  readonly size: unknown;
}

/**
 * Streaming counterpart to `StageBundleFileRequest`.  The source adapter owns
 * the producer and the object-store writer owns the temporary bytes; the
 * application only observes bounded chunks while calculating integrity data.
 */
export interface StageBundleFileStreamRequest
  extends Omit<StageBundleFileRequest, "bytes"> {
  readonly stream: AsyncIterable<unknown>;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

export type StageBundleFileStreamResult = StageBundleFileResult | {
  readonly kind: "stream_invalid";
  readonly code:
    | "stream_cancelled"
    | "stream_invalid_chunk"
    | "stream_size_limit_exceeded"
    | "stream_transport_unavailable";
};

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
        | "invalid_source_kind"
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
        | "bundle_file_media_mismatch"
        | "capacity_accounting_untrusted"
        | "capacity_soft_limit"
        | "capacity_hard_limit"
        | "capacity_fairness_limit"
        | "file_ingress_source_unsupported";
    };

export type ReconcileStageBundleFileResult =
  | StageBundleFileResult
  | { readonly kind: "missing" };

const ENCODER = new TextEncoder();
const CONTROL = /[\u0000-\u001f\u007f]/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const EXTENSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "image/png": Object.freeze([".png"]),
  "image/jpeg": Object.freeze([".jpg", ".jpeg"]),
  "image/gif": Object.freeze([".gif"]),
  "image/webp": Object.freeze([".webp"]),
  "application/pdf": Object.freeze([".pdf"]),
  "application/zip": Object.freeze([".zip"]),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": Object.freeze([".docx"]),
  "image/heic": Object.freeze([".heic", ".heif"]),
  "application/epub+zip": Object.freeze([".epub"]),
  "audio/ogg": Object.freeze([".ogg", ".opus"]),
  "audio/opus": Object.freeze([".opus"]),
  "text/html": Object.freeze([".html", ".htm"]),
  "application/x-ipynb+json": Object.freeze([".ipynb"]),
});
const ZIP_CONTAINER_MEDIA_TYPES = new Set<BundleFileMediaType>([
  "application/zip",
  "application/epub+zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const EXTENSION_ADVISORY_MEDIA_TYPES = new Set<BundleFileMediaType>([
  "text/html",
  "application/x-ipynb+json",
]);

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function sourceKind(value: unknown): FileIngressSourceKind | null {
  return value === undefined
    ? "session_attachment"
    : typeof value === "string" &&
        (FILE_INGRESS_SOURCE_KINDS as readonly string[]).includes(value)
      ? value as FileIngressSourceKind
      : null;
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
    bytes.byteLength >= 12 &&
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70 &&
    ((bytes[8] === 0x68 && bytes[9] === 0x65 && bytes[10] === 0x69) ||
      (bytes[8] === 0x6d && bytes[9] === 0x69 && bytes[10] === 0x66))
  ) return "image/heic";
  if (
    startsWith(bytes, [0x4f, 0x67, 0x67, 0x53]) &&
    new TextDecoder("ascii").decode(bytes.subarray(0, Math.min(bytes.byteLength, 512)))
      .includes("OpusHead")
  ) return "audio/ogg";
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
  return EXTENSIONS[mediaType]?.some((extension) => lower.endsWith(extension)) ?? false;
}

function canonicalDetectedMedia(
  detected: BundleFileMediaType | null,
  claimed: string | undefined,
  displayFilename: string,
): BundleFileMediaType {
  const fallback = "application/octet-stream";
  const advisory = claimed === undefined ? null : bundleFileMediaType(claimed);
  const advisoryKnown = advisory !== null && advisory !== fallback &&
    extensionMatches(displayFilename, advisory);
  if (detected === null) {
    return advisoryKnown && EXTENSION_ADVISORY_MEDIA_TYPES.has(advisory)
      ? advisory
      : fallback;
  }
  if (detected === "application/zip") {
    if (advisoryKnown && ZIP_CONTAINER_MEDIA_TYPES.has(advisory)) return advisory;
    return advisory === null && extensionMatches(displayFilename, detected)
      ? detected
      : fallback;
  }
  if (!extensionMatches(displayFilename, detected)) return fallback;
  if (advisory !== null && advisory !== detected) return fallback;
  return detected;
}

type StageInvalid = Extract<StageBundleFileResult, { readonly kind: "invalid" }>;

type ValidatedStageRequest = Readonly<{
  kind: "validated";
  actor: McpTokenActorContext;
  writeBindingId: WriteMindBindingId;
  displayFilename: string;
  claimedMediaType: string | undefined;
  idempotencyKey: IdempotencyKey;
  sourceKind: FileIngressSourceKind;
  expectedSize: number | undefined;
  expectedSha256: Sha256Digest | undefined;
}>;

function invalid(code: StageInvalid["code"]): StageInvalid {
  return Object.freeze({ kind: "invalid", code });
}

function validateStageRequest(
  request: Readonly<Pick<StageBundleFileRequest,
    "actor" | "writeBindingId" | "displayFilename" | "claimedMediaType" |
    "idempotencyKey" | "sourceKind" | "expectedSize" | "expectedSha256">>,
): ValidatedStageRequest | StageInvalid {
  const actor = request.actor;
  if (
    actor.kind !== "registered_principal" ||
    actor.authentication.kind !== "mcp_token"
  ) return invalid("mcp_token_required");
  const mcpActor = actor as McpTokenActorContext;
  if (typeof request.writeBindingId !== "string" || request.writeBindingId.length === 0) {
    return invalid("invalid_write_binding_id");
  }
  if (
    typeof request.idempotencyKey !== "string" ||
    request.idempotencyKey.length === 0 ||
    CONTROL.test(request.idempotencyKey) ||
    ENCODER.encode(request.idempotencyKey).byteLength > 256
  ) return invalid("invalid_idempotency_key");
  const ingressSourceKind = sourceKind(request.sourceKind);
  if (ingressSourceKind === null) return invalid("invalid_source_kind");
  const displayFilename = filename(request.displayFilename);
  if (displayFilename === null) return invalid("invalid_filename");
  const claimedMediaType = request.claimedMediaType === undefined
    ? undefined
    : typeof request.claimedMediaType === "string"
      ? bundleFileMediaType(request.claimedMediaType)
      : null;
  if (claimedMediaType === null) return invalid("media_type_not_allowed");
  const expectedSize = request.expectedSize;
  if (
    expectedSize !== undefined &&
    (typeof expectedSize !== "number" || !Number.isSafeInteger(expectedSize) || expectedSize < 0)
  ) return invalid("expected_size_mismatch");
  const expectedSha256 = request.expectedSha256;
  if (
    expectedSha256 !== undefined &&
    (typeof expectedSha256 !== "string" || !SHA256.test(expectedSha256))
  ) return invalid("expected_sha256_mismatch");
  return Object.freeze({
    kind: "validated" as const,
    actor: mcpActor,
    writeBindingId: request.writeBindingId as WriteMindBindingId,
    displayFilename,
    claimedMediaType,
    idempotencyKey: request.idempotencyKey as IdempotencyKey,
    sourceKind: ingressSourceKind,
    expectedSize: expectedSize as number | undefined,
    expectedSha256: expectedSha256 as Sha256Digest | undefined,
  });
}

type StageReceipt = Readonly<{
  mediaType: BundleFileMediaType;
  sha256: Sha256Digest;
  size: number;
}>;

function validateStageReceipt(
  request: ReconcileStageBundleFileRequest,
  validated: ValidatedStageRequest,
): StageReceipt | StageInvalid {
  if (
    typeof request.mediaType !== "string"
  ) return invalid("media_type_not_allowed");
  const mediaType = bundleFileMediaType(request.mediaType);
  if (
    typeof request.sha256 !== "string" || !SHA256.test(request.sha256)
  ) return invalid("expected_sha256_mismatch");
  if (
    typeof request.size !== "number" || !Number.isSafeInteger(request.size) ||
    request.size < 0 || request.size > BUNDLE_FILE_LIMITS.maxFileBytes
  ) return invalid("file_size_limit_exceeded");
  if (
    validated.expectedSize !== undefined &&
    validated.expectedSize !== request.size
  ) return invalid("expected_size_mismatch");
  if (
    validated.expectedSha256 !== undefined &&
    validated.expectedSha256 !== request.sha256
  ) return invalid("expected_sha256_mismatch");
  return Object.freeze({
    mediaType,
    sha256: request.sha256 as Sha256Digest,
    size: request.size,
  });
}

function canonicalStageRequestSource(
  bindingOwnerId: string,
  validated: ValidatedStageRequest,
  receipt: StageReceipt,
): string {
  return `${JSON.stringify({
    format: "mind-diary-stage-bundle-file-request-v1",
    binding_owner_id: bindingOwnerId,
    write_binding_id: validated.writeBindingId,
    display_filename: validated.displayFilename,
    claimed_media_type: validated.claimedMediaType ?? null,
    expected_size: validated.expectedSize ?? null,
    expected_sha256: validated.expectedSha256 ?? null,
    source_kind: validated.sourceKind,
    media_type: receipt.mediaType,
    sha256: receipt.sha256,
    size: receipt.size,
  })}\n`;
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
  readonly #capacity: CapacityAdmissionService;

  constructor(dependencies: {
    readonly authorizer: Authorizer;
    readonly metadata: BundleFileStagingStore;
    readonly objects: BundleFileObjectStore;
    readonly clock: Clock;
    readonly ids?: StagedBundleFileIdGenerator;
    readonly capacityLimits?: Readonly<CapacityLimits>;
  }) {
    this.#authorizer = dependencies.authorizer;
    this.#metadata = dependencies.metadata;
    this.#objects = dependencies.objects;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids ?? {
      nextStagedBundleFileId: () =>
        opaqueId<"staged-bundle-file">(`staged_${crypto.randomUUID()}`),
    };
    this.#capacity = new CapacityAdmissionService({
      metadata: dependencies.metadata,
      authorizer: dependencies.authorizer,
      clock: dependencies.clock,
      ...(dependencies.capacityLimits === undefined
        ? {}
        : { limits: dependencies.capacityLimits }),
    });
  }

  /**
   * Resolves one exact stage namespace from its safe source receipt. Missing
   * means no completed stage exists; this method never uploads or reserves.
   */
  async reconcile(
    request: ReconcileStageBundleFileRequest,
  ): Promise<ReconcileStageBundleFileResult> {
    const validation = validateStageRequest(request);
    if (validation.kind === "invalid") return validation;
    const receipt = validateStageReceipt(request, validation);
    if ("kind" in receipt) return receipt;
    const { actor, writeBindingId, idempotencyKey } = validation;
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
    const canonicalRequestHash = await this.#objects.calculateSha256(
      ENCODER.encode(canonicalStageRequestSource(bindingOwnerId, validation, receipt)),
    );
    const namespace: Readonly<
      IdempotencyNamespace & { readonly operation: "stage_bundle_file" }
    > = Object.freeze({
      principalId: actor.principalId,
      bindingOwnerId,
      spaceId: request.spaceId,
      operation: "stage_bundle_file",
      key: idempotencyKey,
    });
    const reconciledAt = this.#clock.now();
    return this.#metadata.runBundleFileStagingTransaction(async (transaction) => {
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
      if (idempotency.kind === "missing") return Object.freeze({ kind: "missing" } as const);
      if (idempotency.kind === "conflict") return invalid("idempotency_conflict");
      if (
        idempotency.record.operation !== "stage_bundle_file" ||
        idempotency.record.result.kind !== "stage_bundle_file"
      ) return invalid("invalid_idempotency_state");
      const record = await transaction.readStagedBundleFile(
        idempotency.record.result.stagedFileId,
      );
      if (
        record === null || record.sourceKind !== validation.sourceKind ||
        record.displayFilename !== validation.displayFilename ||
        record.mediaType !== receipt.mediaType || record.sha256 !== receipt.sha256 ||
        record.size !== receipt.size
      ) return invalid("invalid_idempotency_state");
      if (Date.parse(record.expiresAt) <= Date.parse(reconciledAt)) {
        return invalid("staged_file_expired");
      }
      if (record.state === "consumed") return invalid("staged_file_consumed");
      if (record.state === "rejected") return invalid("staged_file_rejected");
      return record.state === "verified"
        ? Object.freeze({ kind: "staged", record, replayed: true } as const)
        : invalid("invalid_idempotency_state");
    });
  }

  async stage(request: StageBundleFileRequest): Promise<StageBundleFileResult> {
    const validation = validateStageRequest(request);
    if (validation.kind === "invalid") return validation;
    const {
      actor,
      writeBindingId,
      displayFilename,
      claimedMediaType,
      idempotencyKey,
      sourceKind: ingressSourceKind,
      expectedSize,
      expectedSha256,
    } = validation;
    if (!(request.bytes instanceof Uint8Array)) {
      return Object.freeze({ kind: "invalid", code: "file_signature_mismatch" });
    }
    const bytes = new Uint8Array(request.bytes);
    if (bytes.byteLength > BUNDLE_FILE_LIMITS.maxFileBytes) {
      return Object.freeze({ kind: "invalid", code: "file_size_limit_exceeded" });
    }
    const detected = canonicalDetectedMedia(
      detectBundleFileMediaType(bytes),
      claimedMediaType,
      displayFilename,
    );
    if (
      expectedSize !== undefined &&
      expectedSize !== bytes.byteLength
    ) return Object.freeze({ kind: "invalid", code: "expected_size_mismatch" });

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
      expectedSha256 !== undefined &&
      expectedSha256 !== sha256
    ) return Object.freeze({ kind: "invalid", code: "expected_sha256_mismatch" });
    const canonicalRequestHash = await this.#objects.calculateSha256(
      ENCODER.encode(canonicalStageRequestSource(bindingOwnerId, validation, {
        mediaType: detected,
        sha256,
        size: bytes.byteLength,
      })),
    );
    const namespace: Readonly<
      IdempotencyNamespace & { readonly operation: "stage_bundle_file" }
    > = Object.freeze({
      principalId: actor.principalId,
      bindingOwnerId,
      spaceId: request.spaceId,
      operation: "stage_bundle_file",
      key: idempotencyKey,
    });
    const reservationOperationRef = String(canonicalRequestHash);
    const reservationId = capacityReservationId(
      "stage",
      request.spaceId,
      reservationOperationRef,
    );
    const admission = await this.#capacity.reserve({
      actor,
      spaceId: request.spaceId,
      operation: "stage",
      operationRef: reservationOperationRef,
      baseRevisionId: null,
      idempotencyKey: namespace.key,
      requested: Object.freeze({
        physicalCanonicalBytes: 0,
        temporaryBytes: bytes.byteLength,
        d1MetadataBytes: 512,
      }),
      bulk: true,
      heavy: bytes.byteLength > 4_194_304,
      createdAt,
    });
    if (admission.kind === "rejected") {
      const code = admission.reason === "hard_limit"
        ? "capacity_hard_limit"
        : admission.reason === "soft_limit"
          ? "capacity_soft_limit"
          : admission.reason === "fairness_limit"
            ? "capacity_fairness_limit"
            : "capacity_accounting_untrusted";
      return Object.freeze({ kind: "invalid", code });
    }
    let result: StageBundleFileResult;
    try {
      await this.#objects.putStagedBundleFile({
        stagedFileId,
        bindingOwnerId,
        spaceId: request.spaceId,
        bytes,
        createdAt,
      });
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
            sourceKind: ingressSourceKind,
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
            capacityReservationId: reservationId,
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
          if (completion.kind !== "completed") {
            throw new Error("staging idempotency did not complete atomically");
          }
          const consumed = await transaction.consumeCapacityReservation({
            reservationId,
            actual: Object.freeze({
              physicalCanonicalBytes: 0,
              temporaryBytes: bytes.byteLength,
              d1MetadataBytes: 512,
            }),
            consumedAt: createdAt,
          });
          if (consumed !== "consumed" && consumed !== "already_consumed") {
            throw new Error("staging capacity reservation was not consumed atomically");
          }
          return Object.freeze({
            kind: "staged",
            record: created.record,
            replayed: false,
          } as const);
        },
      );
    } catch (error) {
      await this.#cleanupFailedStage(stagedFileId, reservationId);
      throw error;
    }
    if (result.kind !== "staged") {
      await this.#cleanupFailedStage(stagedFileId, reservationId);
    } else if (result.record.stagedFileId !== stagedFileId) {
      await this.#objects.deleteStagedBundleFile(stagedFileId);
    }
    return result;
  }

  /**
   * Stages a generated source without assembling its chunks in application
   * memory.  The object-store adapter receives chunks as they arrive and only
   * exposes the quarantined object after `complete` succeeds.
   */
  async stageStream(
    request: StageBundleFileStreamRequest,
  ): Promise<StageBundleFileStreamResult> {
    const validation = validateStageRequest(request);
    if (validation.kind === "invalid") return validation;
    if (
      !Number.isSafeInteger(request.maxBytes) ||
      request.maxBytes < 0 ||
      request.maxBytes > BUNDLE_FILE_LIMITS.maxFileBytes
    ) return Object.freeze({
      kind: "stream_invalid",
      code: "stream_size_limit_exceeded",
    });
    if (request.signal?.aborted) {
      return Object.freeze({ kind: "stream_invalid", code: "stream_cancelled" });
    }
    if (
      typeof request.stream !== "object" || request.stream === null ||
      typeof request.stream[Symbol.asyncIterator] !== "function"
    ) return Object.freeze({
      kind: "stream_invalid",
      code: "stream_invalid_chunk",
    });

    const {
      actor,
      writeBindingId,
      displayFilename,
      claimedMediaType,
      idempotencyKey,
      sourceKind: ingressSourceKind,
      expectedSize,
      expectedSha256,
    } = validation;
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
    // The reservation is conservative because the final digest/size are only
    // known after the source has been consumed. It is reduced atomically when
    // the verified staged record is created.
    const reservationOperationRef = `stream:${stagedFileId}`;
    const reservationId = capacityReservationId(
      "stage",
      request.spaceId,
      reservationOperationRef,
    );
    const admission = await this.#capacity.reserve({
      actor,
      spaceId: request.spaceId,
      operation: "stage",
      operationRef: reservationOperationRef,
      baseRevisionId: null,
      idempotencyKey,
      requested: Object.freeze({
        physicalCanonicalBytes: 0,
        temporaryBytes: request.maxBytes,
        d1MetadataBytes: 512,
      }),
      bulk: true,
      heavy: request.maxBytes > 4_194_304,
      createdAt,
    });
    if (admission.kind === "rejected") {
      const code = admission.reason === "hard_limit"
        ? "capacity_hard_limit"
        : admission.reason === "soft_limit"
          ? "capacity_soft_limit"
          : admission.reason === "fairness_limit"
            ? "capacity_fairness_limit"
            : "capacity_accounting_untrusted";
      return Object.freeze({ kind: "invalid", code });
    }

    const begin = this.#objects.beginStagedBundleFileUpload;
    if (begin === undefined) {
      await this.#capacity.cancel(reservationId).catch(() => undefined);
      return Object.freeze({
        kind: "invalid",
        code: "file_ingress_source_unsupported",
      });
    }

    let upload: StagedBundleFileUpload;
    let temporaryObjectOwned = false;
    try {
      upload = await begin.call(this.#objects, {
        stagedFileId,
        bindingOwnerId,
        spaceId: request.spaceId,
        createdAt,
        maxBytes: request.maxBytes,
      });
    } catch {
      await this.#cleanupFailedStage(stagedFileId, reservationId, false);
      return Object.freeze({
        kind: "stream_invalid",
        code: "stream_transport_unavailable",
      });
    }

    const streamFailure = async (
      failure: StageBundleFileStreamResult,
    ): Promise<StageBundleFileStreamResult> => {
      await upload.abort().catch(() => undefined);
      await this.#cleanupFailedStage(
        stagedFileId,
        reservationId,
        temporaryObjectOwned,
      );
      return failure;
    };

    try {
      const digest = new IncrementalSha256();
      const signature = new Uint8Array(12);
      let signatureSize = 0;
      let size = 0;
      let failure: StageBundleFileStreamResult | null = null;
      for await (const chunk of request.stream) {
        if (request.signal?.aborted) {
          failure = Object.freeze({ kind: "stream_invalid", code: "stream_cancelled" });
          break;
        }
        if (!(chunk instanceof Uint8Array)) {
          failure = Object.freeze({
            kind: "stream_invalid",
            code: "stream_invalid_chunk",
          });
          break;
        }
        if (size + chunk.byteLength > request.maxBytes) {
          failure = Object.freeze({
            kind: "stream_invalid",
            code: "stream_size_limit_exceeded",
          });
          break;
        }
        if (signatureSize < signature.byteLength) {
          const copied = Math.min(signature.byteLength - signatureSize, chunk.byteLength);
          signature.set(chunk.subarray(0, copied), signatureSize);
          signatureSize += copied;
        }
        size += chunk.byteLength;
        digest.update(chunk);
        await upload.write(chunk);
      }
      if (failure !== null) return await streamFailure(failure);
      if (request.signal?.aborted) {
        return await streamFailure(Object.freeze({
          kind: "stream_invalid",
          code: "stream_cancelled",
        }));
      }

      const sha256 = digest.digest();
      if (expectedSize !== undefined && expectedSize !== size) {
        return await streamFailure(Object.freeze({
          kind: "invalid",
          code: "expected_size_mismatch",
        }));
      }
      if (expectedSha256 !== undefined && expectedSha256 !== sha256) {
        return await streamFailure(Object.freeze({
          kind: "invalid",
          code: "expected_sha256_mismatch",
        }));
      }
      const detected = canonicalDetectedMedia(
        detectBundleFileMediaType(signature.subarray(0, signatureSize)),
        claimedMediaType,
        displayFilename,
      );

      await upload.complete({ sha256, size });
      temporaryObjectOwned = true;
      const canonicalRequestHash = await this.#objects.calculateSha256(
        ENCODER.encode(canonicalStageRequestSource(bindingOwnerId, validation, {
          mediaType: detected,
          sha256,
          size,
        })),
      );
      const namespace: Readonly<
        IdempotencyNamespace & { readonly operation: "stage_bundle_file" }
      > = Object.freeze({
        principalId: actor.principalId,
        bindingOwnerId,
        spaceId: request.spaceId,
        operation: "stage_bundle_file",
        key: idempotencyKey,
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
            ) return Object.freeze({ kind: "invalid", code: "invalid_idempotency_state" } as const);
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
          ) return Object.freeze({ kind: "invalid", code: "binding_mismatch" } as const);
          const record: Readonly<StagedBundleFileRecord> = Object.freeze({
            stagedFileId,
            bindingOwnerId,
            sourceKind: ingressSourceKind,
            writeBindingId,
            writeBindingGeneration: write.generation,
            spaceId: request.spaceId,
            displayFilename,
            mediaType: detected,
            sha256,
            size,
            state: "verified",
            createdAt,
            expiresAt: expiresAt(createdAt),
            consumedAt: null,
            rejectionCode: null,
            capacityReservationId: reservationId,
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
          if (completion.kind !== "completed") {
            throw new Error("staging idempotency did not complete atomically");
          }
          const consumed = await transaction.consumeCapacityReservation({
            reservationId,
            actual: Object.freeze({
              physicalCanonicalBytes: 0,
              temporaryBytes: size,
              d1MetadataBytes: 512,
            }),
            consumedAt: createdAt,
          });
          if (consumed !== "consumed" && consumed !== "already_consumed") {
            throw new Error("staging capacity reservation was not consumed atomically");
          }
          return Object.freeze({
            kind: "staged",
            record: created.record,
            replayed: false,
          } as const);
        },
      );
      if (result.kind !== "staged") {
        return await streamFailure(result);
      }
      if (result.record.stagedFileId !== stagedFileId) {
        await this.#cleanupFailedStage(stagedFileId, reservationId);
      }
      return result;
    } catch {
      return await streamFailure(Object.freeze({
        kind: "stream_invalid",
        code: "stream_transport_unavailable",
      }));
    }
  }

  async #cleanupFailedStage(
    stagedFileId: StagedBundleFileId,
    reservationId: string,
    temporaryObjectOwned = true,
  ): Promise<void> {
    let temporaryObjectAbsent = !temporaryObjectOwned;
    if (temporaryObjectOwned) {
      try {
        await this.#objects.deleteStagedBundleFile(stagedFileId);
        temporaryObjectAbsent = true;
      } catch {
        // The durable cleanup-pending reservation keeps worst-case usage charged.
      }
    }
    await this.#capacity.cancel(reservationId).catch(() => undefined);
    if (temporaryObjectAbsent) {
      await this.#metadata.releaseCapacityReservation({
        reservationId,
        releasedAt: this.#clock.now(),
      }).catch(() => false);
    }
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
      try {
        await this.#objects.deleteStagedBundleFile(candidate.stagedFileId);
      } catch {
        continue;
      }
      if (await this.#metadata.deleteExpiredStagedBundleFileRecord(candidate.stagedFileId)) {
        if (candidate.capacityReservationId !== undefined) {
          await this.#metadata.releaseCapacityReservation({
            reservationId: candidate.capacityReservationId,
            releasedAt: now,
          });
        }
        deleted += 1;
        bytes += candidate.size;
      }
    }
    return Object.freeze({ scanned: candidates.length, deleted, bytes });
  }
}
