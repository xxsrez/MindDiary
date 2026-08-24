import type { McpTokenActorContext } from "@mind-diary/application-contracts";
import type {
  GeneratedArtifactSourceKind,
} from "@mind-diary/application-ports";
import type { Sha256Digest, SpaceId, StagedBundleFileId } from "@mind-diary/domain";
import {
  BUNDLE_FILE_LIMITS,
  BundleFileStageTransportError,
  BundleFileStagingService,
  type StageBundleFileRequest,
  type StageBundleFileStreamResult,
  type StageBundleFileResult,
} from "./bundle-files.js";

/**
 * Generated ingress limits are deliberately stricter for the inline path.
 * A server-generated stream may use the same 64 MiB BundleFile ceiling, while
 * adapters with an out-of-band writer can avoid retaining the whole payload.
 */
export const GENERATED_ARTIFACT_LIMITS = Object.freeze({
  maxBoundedInMemoryBytes: 4_194_304,
  maxServerGeneratedBytes: BUNDLE_FILE_LIMITS.maxFileBytes,
});

export type GeneratedArtifactInput =
  | Readonly<{ bytes: unknown; stream?: never }>
  | Readonly<{ stream: unknown; bytes?: never }>;

type GeneratedArtifactRequestFields = Readonly<{
  readonly actor: McpTokenActorContext;
  readonly spaceId: SpaceId;
  readonly writeBindingId: unknown;
  readonly sourceKind: unknown;
  readonly displayFilename: unknown;
  readonly claimedMediaType: unknown;
  readonly idempotencyKey: unknown;
  readonly expectedSize?: unknown;
  readonly expectedSha256?: unknown;
  readonly signal?: AbortSignal;
}>;

export type StageGeneratedArtifactRequest = GeneratedArtifactInput & GeneratedArtifactRequestFields;
export type StageBoundedInMemoryArtifactRequest = Readonly<{
  readonly bytes: unknown;
  readonly stream?: never;
}> & Omit<GeneratedArtifactRequestFields, "sourceKind">;
export type StageServerGeneratedArtifactRequest = Readonly<{
  readonly stream: unknown;
  readonly bytes?: never;
}> & Omit<GeneratedArtifactRequestFields, "sourceKind">;

export type GeneratedArtifactInvalidCode =
  | "invalid_source_kind"
  | "generated_artifact_input_required"
  | "generated_artifact_input_conflict"
  | "generated_artifact_invalid_chunk"
  | "generated_artifact_size_limit_exceeded"
  | "generated_artifact_cancelled"
  | "generated_artifact_storage_unavailable"
  | "generated_artifact_streaming_unavailable";

export type GeneratedArtifactIngressResult = StageBundleFileResult | {
  readonly kind: "invalid";
  readonly code: GeneratedArtifactInvalidCode;
};

export interface PreparedGeneratedArtifact {
  readonly stagedFileId: StagedBundleFileId;
  readonly sourceKind: GeneratedArtifactSourceKind;
  readonly sha256: Sha256Digest;
  readonly size: number;
}

/**
 * Trusted inbound port for backend producers in a hosted composition.
 *
 * The two methods fix the safe provenance label at the application boundary;
 * callers can supply bytes or a producer stream, but cannot supply a local
 * path, provider object identifier, URL or arbitrary source kind.
 */
export interface GeneratedArtifactProducerPort {
  stageBoundedInMemory(
    request: StageBoundedInMemoryArtifactRequest,
  ): Promise<GeneratedArtifactIngressResult>;
  stageServerGenerated(
    request: StageServerGeneratedArtifactRequest,
  ): Promise<GeneratedArtifactIngressResult>;
}

function generatedSourceKind(value: unknown): GeneratedArtifactSourceKind | null {
  return value === "bounded_in_memory" || value === "server_generated"
    ? value
    : null;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null &&
    Symbol.asyncIterator in value;
}

function isReadableStream(value: unknown): value is ReadableStream<unknown> {
  return typeof value === "object" && value !== null &&
    typeof (value as { getReader?: unknown }).getReader === "function";
}

function cancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function* readableStreamChunks(
  stream: ReadableStream<unknown>,
): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  let finished = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        finished = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function generatedStream(value: unknown): AsyncIterable<unknown> | null {
  if (isReadableStream(value)) return readableStreamChunks(value);
  return isAsyncIterable(value) ? value : null;
}

function mapStreamResult(result: StageBundleFileStreamResult): GeneratedArtifactIngressResult {
  if (result.kind !== "stream_invalid") return result;
  const code = result.code === "stream_cancelled"
    ? "generated_artifact_cancelled"
    : result.code === "stream_size_limit_exceeded"
      ? "generated_artifact_size_limit_exceeded"
      : result.code === "stream_transport_unavailable"
        ? "generated_artifact_streaming_unavailable"
        : "generated_artifact_invalid_chunk";
  return Object.freeze({ kind: "invalid", code });
}

/**
 * Application ingress for trusted backend-generated artifacts.  It deliberately
 * delegates authorization, MIME sniffing, quarantine, quota and stage
 * idempotency to the existing BundleFile staging service; only the source
 * adapter and byte transport differ.
 */
export class GeneratedArtifactIngressService implements GeneratedArtifactProducerPort {
  readonly #staging: Pick<BundleFileStagingService, "stage" | "stageStream">;

  constructor(dependencies: {
    readonly staging: Pick<BundleFileStagingService, "stage" | "stageStream">;
  }) {
    this.#staging = dependencies.staging;
  }

  async stage(request: StageGeneratedArtifactRequest): Promise<GeneratedArtifactIngressResult> {
    const sourceKind = generatedSourceKind(request.sourceKind);
    if (sourceKind === null) {
      return Object.freeze({ kind: "invalid", code: "invalid_source_kind" });
    }
    const maxBytes = sourceKind === "bounded_in_memory"
      ? GENERATED_ARTIFACT_LIMITS.maxBoundedInMemoryBytes
      : GENERATED_ARTIFACT_LIMITS.maxServerGeneratedBytes;
    if (cancelled(request.signal)) {
      return Object.freeze({ kind: "invalid", code: "generated_artifact_cancelled" });
    }
    const hasBytes = request.bytes !== undefined;
    const hasStream = request.stream !== undefined;
    if (!hasBytes && !hasStream) {
      return Object.freeze({ kind: "invalid", code: "generated_artifact_input_required" });
    }
    if (hasBytes && hasStream) {
      return Object.freeze({ kind: "invalid", code: "generated_artifact_input_conflict" });
    }

    if (hasStream) {
      const stream = generatedStream(request.stream);
      if (stream === null) {
        return Object.freeze({ kind: "invalid", code: "generated_artifact_invalid_chunk" });
      }
      return mapStreamResult(await this.#staging.stageStream({
        actor: request.actor,
        spaceId: request.spaceId,
        writeBindingId: request.writeBindingId,
        displayFilename: request.displayFilename,
        claimedMediaType: request.claimedMediaType,
        idempotencyKey: request.idempotencyKey,
        sourceKind,
        stream,
        maxBytes,
        ...(request.expectedSize === undefined ? {} : { expectedSize: request.expectedSize }),
        ...(request.expectedSha256 === undefined ? {} : { expectedSha256: request.expectedSha256 }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }));
    }

    if (!(request.bytes instanceof Uint8Array)) {
      return Object.freeze({ kind: "invalid", code: "generated_artifact_invalid_chunk" });
    }
    if (request.bytes.byteLength > maxBytes) {
      return Object.freeze({
        kind: "invalid",
        code: "generated_artifact_size_limit_exceeded",
      });
    }

    const stageRequest: StageBundleFileRequest = {
      actor: request.actor,
      spaceId: request.spaceId,
      writeBindingId: request.writeBindingId,
      displayFilename: request.displayFilename,
      claimedMediaType: request.claimedMediaType,
      bytes: request.bytes,
      idempotencyKey: request.idempotencyKey,
      sourceKind,
      ...(request.expectedSize === undefined ? {} : { expectedSize: request.expectedSize }),
      ...(request.expectedSha256 === undefined ? {} : { expectedSha256: request.expectedSha256 }),
    };
    try {
      return await this.#staging.stage(stageRequest);
    } catch (error) {
      if (
        !(error instanceof BundleFileStageTransportError) ||
        error.code !== "storage_unavailable"
      ) throw error;
      return Object.freeze({
        kind: "invalid",
        code: "generated_artifact_storage_unavailable",
      });
    }
  }

  stageBoundedInMemory(
    request: StageBoundedInMemoryArtifactRequest,
  ): Promise<GeneratedArtifactIngressResult> {
    return this.stage({
      actor: request.actor,
      spaceId: request.spaceId,
      writeBindingId: request.writeBindingId,
      sourceKind: "bounded_in_memory",
      displayFilename: request.displayFilename,
      claimedMediaType: request.claimedMediaType,
      idempotencyKey: request.idempotencyKey,
      bytes: request.bytes,
      ...(request.expectedSize === undefined ? {} : { expectedSize: request.expectedSize }),
      ...(request.expectedSha256 === undefined ? {} : { expectedSha256: request.expectedSha256 }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  }

  stageServerGenerated(
    request: StageServerGeneratedArtifactRequest,
  ): Promise<GeneratedArtifactIngressResult> {
    return this.stage({
      actor: request.actor,
      spaceId: request.spaceId,
      writeBindingId: request.writeBindingId,
      sourceKind: "server_generated",
      displayFilename: request.displayFilename,
      claimedMediaType: request.claimedMediaType,
      idempotencyKey: request.idempotencyKey,
      stream: request.stream,
      ...(request.expectedSize === undefined ? {} : { expectedSize: request.expectedSize }),
      ...(request.expectedSha256 === undefined ? {} : { expectedSha256: request.expectedSha256 }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  }

  /**
   * Prepares several refs without committing any revision.  Callers must pass
   * the returned refs to the existing atomic changeset commit; a failed
   * preparation therefore cannot publish a partial HEAD.
   */
  async stageMany(
    requests: readonly StageGeneratedArtifactRequest[],
  ): Promise<Readonly<{
    kind: "prepared";
    artifacts: readonly PreparedGeneratedArtifact[];
  }> | Readonly<{ kind: "invalid"; index: number; result: GeneratedArtifactIngressResult }>> {
    const artifacts: PreparedGeneratedArtifact[] = [];
    for (const [index, request] of requests.entries()) {
      const result = await this.stage(request);
      if (result.kind !== "staged") {
        return Object.freeze({ kind: "invalid", index, result });
      }
      artifacts.push(Object.freeze({
        stagedFileId: result.record.stagedFileId,
        sourceKind: result.record.sourceKind === "bounded_in_memory" ||
            result.record.sourceKind === "server_generated"
          ? result.record.sourceKind
          : request.sourceKind as GeneratedArtifactSourceKind,
        sha256: result.record.sha256,
        size: result.record.size,
      }));
    }
    return Object.freeze({ kind: "prepared", artifacts: Object.freeze(artifacts) });
  }
}
