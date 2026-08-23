import type { ActorContext } from "@mind-diary/application-contracts";
import type {
  GeneratedArtifactSourceKind,
} from "@mind-diary/application-ports";
import type { Sha256Digest, SpaceId, StagedBundleFileId } from "@mind-diary/domain";
import {
  BUNDLE_FILE_LIMITS,
  BundleFileStagingService,
  type StageBundleFileRequest,
  type StageBundleFileResult,
} from "./bundle-files.js";
import { IncrementalSha256 } from "./incremental-sha256.js";

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
  readonly actor: ActorContext;
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
export type StageGeneratedArtifactWithoutSource = GeneratedArtifactInput &
  Omit<GeneratedArtifactRequestFields, "sourceKind">;

export type GeneratedArtifactInvalidCode =
  | "invalid_source_kind"
  | "generated_artifact_input_required"
  | "generated_artifact_input_conflict"
  | "generated_artifact_invalid_chunk"
  | "generated_artifact_size_limit_exceeded"
  | "generated_artifact_cancelled";

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

async function readGeneratedInput(
  request: StageGeneratedArtifactRequest,
  maxBytes: number,
): Promise<
  | Readonly<{ kind: "bytes"; bytes: Uint8Array; sha256: Sha256Digest; size: number }>
  | Readonly<{ kind: "invalid"; code: GeneratedArtifactInvalidCode }>
> {
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

  const chunks: Uint8Array[] = [];
  const digest = new IncrementalSha256();
  let size = 0;
  const append = (chunk: unknown): GeneratedArtifactInvalidCode | null => {
    if (!(chunk instanceof Uint8Array)) return "generated_artifact_invalid_chunk";
    const copy = new Uint8Array(chunk);
    size += copy.byteLength;
    if (size > maxBytes) return "generated_artifact_size_limit_exceeded";
    digest.update(copy);
    chunks.push(copy);
    return null;
  };

  if (hasBytes) {
    const error = append(request.bytes);
    if (error !== null) return Object.freeze({ kind: "invalid", code: error });
  } else if (isReadableStream(request.stream)) {
    const reader = request.stream.getReader();
    try {
      while (true) {
        if (cancelled(request.signal)) {
          await reader.cancel();
          return Object.freeze({ kind: "invalid", code: "generated_artifact_cancelled" });
        }
        const next = await reader.read();
        if (next.done) break;
        const error = append(next.value);
        if (error !== null) {
          await reader.cancel();
          return Object.freeze({ kind: "invalid", code: error });
        }
      }
    } catch {
      await reader.cancel().catch(() => undefined);
      return Object.freeze({ kind: "invalid", code: "generated_artifact_invalid_chunk" });
    } finally {
      reader.releaseLock();
    }
  } else if (isAsyncIterable(request.stream)) {
    const iterator = request.stream[Symbol.asyncIterator]();
    try {
      while (true) {
        if (cancelled(request.signal)) {
          await iterator.return?.();
          return Object.freeze({ kind: "invalid", code: "generated_artifact_cancelled" });
        }
        const next = await iterator.next();
        if (next.done) break;
        const error = append(next.value);
        if (error !== null) {
          await iterator.return?.();
          return Object.freeze({ kind: "invalid", code: error });
        }
      }
    } catch {
      try {
        await iterator.return?.();
      } catch {
        // The source is already failing; preserve the stable typed ingress error.
      }
      return Object.freeze({ kind: "invalid", code: "generated_artifact_invalid_chunk" });
    }
  } else {
    return Object.freeze({ kind: "invalid", code: "generated_artifact_invalid_chunk" });
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Object.freeze({ kind: "bytes", bytes, sha256: digest.digest(), size });
}

/**
 * Application ingress for trusted backend-generated artifacts.  It deliberately
 * delegates authorization, MIME sniffing, quarantine, quota and stage
 * idempotency to the existing BundleFile staging service; only the source
 * adapter and byte transport differ.
 */
export class GeneratedArtifactIngressService {
  readonly #staging: Pick<BundleFileStagingService, "stage">;

  constructor(dependencies: {
    readonly staging: Pick<BundleFileStagingService, "stage">;
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
    const input = await readGeneratedInput(request, maxBytes);
    if (input.kind === "invalid") return input;

    const stageRequest: StageBundleFileRequest = {
      actor: request.actor,
      spaceId: request.spaceId,
      writeBindingId: request.writeBindingId,
      displayFilename: request.displayFilename,
      claimedMediaType: request.claimedMediaType,
      bytes: input.bytes,
      idempotencyKey: request.idempotencyKey,
      sourceKind,
      ...(request.expectedSize === undefined ? {} : { expectedSize: request.expectedSize }),
      ...(request.expectedSha256 === undefined ? {} : { expectedSha256: request.expectedSha256 }),
    };
    return this.#staging.stage(stageRequest);
  }

  stageBoundedInMemory(
    request: StageGeneratedArtifactWithoutSource,
  ): Promise<GeneratedArtifactIngressResult> {
    return this.stage({ ...request, sourceKind: "bounded_in_memory" });
  }

  stageServerGenerated(
    request: StageGeneratedArtifactWithoutSource,
  ): Promise<GeneratedArtifactIngressResult> {
    return this.stage({ ...request, sourceKind: "server_generated" });
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
