import type { McpTokenActorContext } from "@mind-diary/application-contracts";
import { bundleFileMediaType, type SpaceId } from "@mind-diary/domain";
import type { BundleFileStagingService } from "./bundle-files.js";
import {
  GENERATED_ARTIFACT_LIMITS,
  GeneratedArtifactIngressService,
  type GeneratedArtifactIngressResult,
} from "./generated-artifacts.js";

export const SERVER_GENERATED_INGRESS_LIMITS = Object.freeze({
  maxBytes: GENERATED_ARTIFACT_LIMITS.maxServerGeneratedBytes,
  producerLeaseMilliseconds: 600_000,
});

export type TrustedServerGeneratedStream =
  | ReadableStream<unknown>
  | AsyncIterable<unknown>;

export interface TrustedServerGeneratedProducerContext {
  readonly signal: AbortSignal;
  readonly maxBytes: number;
}

/**
 * A constructor-installed backend producer. Provider/job/prompt identity is
 * deliberately held in the producer closure and cannot become file identity.
 */
export type TrustedServerGeneratedProducer = (
  context: Readonly<TrustedServerGeneratedProducerContext>,
) => TrustedServerGeneratedStream | Promise<TrustedServerGeneratedStream>;

export interface StageTrustedServerGeneratedRequest {
  readonly actor: McpTokenActorContext;
  readonly spaceId: SpaceId;
  readonly writeBindingId: unknown;
  readonly displayFilename: unknown;
  /** Exact safe canonical media receipt, not source authority. */
  readonly expectedMediaType: unknown;
  readonly idempotencyKey: unknown;
  readonly expectedSize: unknown;
  readonly expectedSha256: unknown;
  readonly producer: TrustedServerGeneratedProducer;
  readonly signal?: AbortSignal;
}

const ABORTED = Symbol("server-generated-producer-aborted");

type ProducerIterator = AsyncIterator<unknown> & {
  readonly return?: (value?: unknown) => Promise<IteratorResult<unknown>> | IteratorResult<unknown>;
};

function isReadableStream(value: unknown): value is ReadableStream<unknown> {
  return typeof value === "object" && value !== null &&
    typeof (value as { readonly getReader?: unknown }).getReader === "function";
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null &&
    typeof (value as { readonly [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] ===
      "function";
}

function readableIterator(stream: ReadableStream<unknown>): ProducerIterator {
  const reader = stream.getReader();
  let closed = false;
  const next = async (): Promise<ReadableStreamReadResult<unknown>> => {
    const result = await reader.read();
    if (result.done && !closed) {
      closed = true;
      reader.releaseLock();
    }
    return result;
  };
  const close = async (): Promise<IteratorResult<unknown>> => {
    if (!closed) {
      closed = true;
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    return Object.freeze({ done: true, value: undefined });
  };
  return Object.freeze({
    next,
    return: close,
  });
}

function producerIterator(source: unknown): ProducerIterator | null {
  if (isReadableStream(source)) return readableIterator(source);
  if (!isAsyncIterable(source)) return null;
  const iterator = source[Symbol.asyncIterator]();
  return typeof iterator === "object" && iterator !== null &&
      typeof iterator.next === "function"
    ? iterator
    : null;
}

function returnBestEffort(iterator: ProducerIterator): void {
  if (typeof iterator.return !== "function") return;
  try {
    void Promise.resolve(iterator.return()).catch(() => undefined);
  } catch {
    // Producer closure owns its internal diagnostics; ingress stays privacy-safe.
  }
}

function closeLateSource(source: unknown): void {
  const iterator = producerIterator(source);
  if (iterator !== null) returnBestEffort(iterator);
}

function abortableChunks(
  iterator: ProducerIterator,
  signal: AbortSignal,
  settled: () => void,
): Readonly<{ readonly stream: AsyncIterable<unknown>; readonly close: () => void }> {
  let finished = false;
  let closed = false;
  let stop: ((value: typeof ABORTED) => void) | undefined;
  const stopped = new Promise<typeof ABORTED>((resolve) => {
    stop = resolve;
  });
  const onAbort = () => {
    returnBestEffort(iterator);
    stop?.(ABORTED);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", onAbort);
    if (!finished) returnBestEffort(iterator);
    settled();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const stream = Object.freeze({
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          const next = await Promise.race([
            Promise.resolve().then(() => iterator.next()),
            stopped,
          ]);
          if (next === ABORTED) return;
          if (typeof next !== "object" || next === null || typeof next.done !== "boolean") {
            throw new TypeError("server-generated producer returned an invalid iterator result");
          }
          if (next.done) {
            finished = true;
            return;
          }
          yield next.value;
        }
      } finally {
        close();
      }
    },
  });
  return Object.freeze({ stream, close });
}

function unavailable(): GeneratedArtifactIngressResult {
  return Object.freeze({
    kind: "invalid",
    code: "generated_artifact_streaming_unavailable",
  });
}

function cancelled(): GeneratedArtifactIngressResult {
  return Object.freeze({
    kind: "invalid",
    code: "generated_artifact_cancelled",
  });
}

/**
 * Trusted hosted-composition boundary for one server-generated output.
 *
 * It only bounds producer acquisition/iteration. The shared generated ingress
 * remains the authority for incremental SHA/size, safe metadata, quotas,
 * idempotency, quarantine cleanup and the staged-ref lifecycle.
 */
export class TrustedServerGeneratedIngressService {
  readonly #ingress: Pick<GeneratedArtifactIngressService, "stageServerGenerated">;
  readonly #reconciliation: Pick<BundleFileStagingService, "reconcile">;
  readonly #producerLeaseMilliseconds: number;

  constructor(dependencies: {
    readonly ingress: Pick<GeneratedArtifactIngressService, "stageServerGenerated">;
    readonly reconciliation: Pick<BundleFileStagingService, "reconcile">;
    /** Tests/adapters may choose a stricter lease, never a wider one. */
    readonly producerLeaseMilliseconds?: number;
  }) {
    this.#ingress = dependencies.ingress;
    this.#reconciliation = dependencies.reconciliation;
    const lease = dependencies.producerLeaseMilliseconds ??
      SERVER_GENERATED_INGRESS_LIMITS.producerLeaseMilliseconds;
    if (
      !Number.isSafeInteger(lease) || lease <= 0 ||
      lease > SERVER_GENERATED_INGRESS_LIMITS.producerLeaseMilliseconds
    ) throw new RangeError("server-generated producer lease is outside the accepted bound");
    this.#producerLeaseMilliseconds = lease;
  }

  async stage(
    request: StageTrustedServerGeneratedRequest,
  ): Promise<GeneratedArtifactIngressResult> {
    if (request.signal?.aborted) return cancelled();
    if (typeof request.producer !== "function") return unavailable();
    if (typeof request.expectedMediaType !== "string") {
      return Object.freeze({ kind: "invalid", code: "media_type_not_allowed" });
    }
    const expectedMediaType = bundleFileMediaType(request.expectedMediaType);

    // The exact producer receipt makes an uncertain retry resolvable without
    // invoking the producer or touching object storage. Existing reconcile
    // owns validation, current target authorization, namespace isolation,
    // expiry/state checks and canonical request-hash conflict detection.
    try {
      const prior = await this.#reconciliation.reconcile({
        actor: request.actor,
        spaceId: request.spaceId,
        writeBindingId: request.writeBindingId,
        displayFilename: request.displayFilename,
        claimedMediaType: expectedMediaType,
        idempotencyKey: request.idempotencyKey,
        sourceKind: "server_generated",
        expectedSize: request.expectedSize,
        expectedSha256: request.expectedSha256,
        expectedMediaType,
        mediaType: expectedMediaType,
        size: request.expectedSize,
        sha256: request.expectedSha256,
      });
      if (prior.kind !== "missing") return prior;
    } catch {
      return unavailable();
    }

    const leaseController = new AbortController();
    const signal = request.signal === undefined
      ? leaseController.signal
      : AbortSignal.any([request.signal, leaseController.signal]);
    let producerSettled = false;
    const timeout = setTimeout(
      () => leaseController.abort(),
      this.#producerLeaseMilliseconds,
    );
    const settleProducer = () => {
      if (producerSettled) return;
      producerSettled = true;
      clearTimeout(timeout);
    };

    let stopOpening: (() => void) | undefined;
    const stopped = new Promise<typeof ABORTED>((resolve) => {
      stopOpening = () => resolve(ABORTED);
      signal.addEventListener("abort", stopOpening, { once: true });
    });
    let opened: Promise<TrustedServerGeneratedStream>;
    try {
      opened = Promise.resolve(request.producer(Object.freeze({
        signal,
        maxBytes: SERVER_GENERATED_INGRESS_LIMITS.maxBytes,
      })));
    } catch {
      settleProducer();
      return unavailable();
    }

    let guarded: ReturnType<typeof abortableChunks> | null = null;
    try {
      const source = await Promise.race([opened, stopped]);
      if (source === ABORTED) {
        void opened.then(closeLateSource).catch(() => undefined);
        return request.signal?.aborted ? cancelled() : unavailable();
      }
      const iterator = producerIterator(source);
      if (iterator === null) return unavailable();
      guarded = abortableChunks(iterator, signal, settleProducer);
      const result = await this.#ingress.stageServerGenerated({
        actor: request.actor,
        spaceId: request.spaceId,
        writeBindingId: request.writeBindingId,
        displayFilename: request.displayFilename,
        claimedMediaType: expectedMediaType,
        expectedMediaType,
        idempotencyKey: request.idempotencyKey,
        stream: guarded.stream,
        expectedSize: request.expectedSize,
        expectedSha256: request.expectedSha256,
        signal,
      });
      if (
        result.kind === "invalid" &&
        result.code === "generated_artifact_cancelled" &&
        request.signal?.aborted !== true && leaseController.signal.aborted
      ) return unavailable();
      return result;
    } catch {
      return request.signal?.aborted ? cancelled() : unavailable();
    } finally {
      guarded?.close();
      if (stopOpening !== undefined) signal.removeEventListener("abort", stopOpening);
      settleProducer();
    }
  }
}
