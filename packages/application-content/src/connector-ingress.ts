import type { McpTokenActorContext } from "@mind-diary/application-contracts";
import type { CredentialWriteTargetStore } from "@mind-diary/application-ports";
import type {
  CredentialWriteTargetGenerationId,
  Sha256Digest,
  SpaceId,
} from "@mind-diary/domain";
import {
  BUNDLE_FILE_LIMITS,
  type BundleFileStagingService,
  type StageBundleFileStreamResult,
} from "./bundle-files.js";

export const CONNECTOR_OBJECT_LIMITS = Object.freeze({
  maxBytes: BUNDLE_FILE_LIMITS.maxFileBytes,
  fetchTimeoutMilliseconds: 30_000,
  maxRedirects: 4,
});

export interface ConnectorObjectReadLimits {
  readonly maxBytes: number;
  readonly fetchTimeoutMilliseconds: number;
  readonly maxRedirects: number;
}

export type ConnectorObjectRepresentation =
  | Readonly<{ kind: "binary" }>
  | Readonly<{
      kind: "export_snapshot";
      /** Provider-native export format selected explicitly by the caller. */
      format: string;
      displayFilename: string;
      mediaType: string;
    }>;

/**
 * The only connector payload allowed to cross into portable application code.
 *
 * The object-bound adapter computes the exact snapshot receipt while keeping
 * provider locator, account, grant, object revision, credentials and URLs in
 * its private state. The shared stage recomputes size, SHA-256 and advisory
 * media from the stream before it can publish a verified staged ref.
 *
 * The stream must perform its final ownership, grant, revision and export
 * snapshot check before returning `done`. A failed final check must throw so
 * shared staging aborts and removes its partial quarantine upload.
 */
export interface VerifiedFileInput {
  readonly sourceKind: "connector_object";
  readonly representation: ConnectorObjectRepresentation;
  readonly stream: AsyncIterable<unknown>;
  readonly displayFilename: string;
  readonly advisoryMediaType: string;
  readonly size: number;
  readonly sha256: Sha256Digest;
}

/**
 * Safe adapter-to-ingress classification for a failure discovered while the
 * verified stream is being consumed. It carries no provider reason, locator or
 * credential. Source failures intentionally collapse revoke, ownership drift,
 * object mutation and export-snapshot drift into one terminal outcome.
 */
export class ConnectorObjectStreamFailure extends Error {
  readonly name = "ConnectorObjectStreamFailure";

  private constructor(
    readonly failure: "source_unavailable" | "transport_unavailable",
    readonly retryable: boolean,
  ) {
    super("Connector object snapshot is unavailable");
  }

  static sourceUnavailable(): ConnectorObjectStreamFailure {
    return new ConnectorObjectStreamFailure("source_unavailable", false);
  }

  static transportUnavailable(retryable = true): ConnectorObjectStreamFailure {
    return new ConnectorObjectStreamFailure("transport_unavailable", retryable);
  }
}

export type ConnectorObjectReadResult =
  | Readonly<{ kind: "ready"; input: Readonly<VerifiedFileInput> }>
  | Readonly<{
      kind: "unavailable";
      /**
       * Source failures collapse missing object, revoked grant, wrong owner and
       * snapshot drift so callers cannot distinguish provider existence.
       */
      failure: "source_unavailable";
    }>
  | Readonly<{
      kind: "unavailable";
      failure: "transport_unavailable";
      retryable: boolean;
    }>;

/**
 * One capability bound inside a connector adapter to one provider object.
 * There is deliberately no locator, provider name, account, grant, revision,
 * URL or generic fetch method on this portable interface.
 */
export interface AuthorizedConnectorObjectSource {
  readVerifiedSnapshot(request: Readonly<{
    actor: McpTokenActorContext;
    representation: ConnectorObjectRepresentation;
    limits: Readonly<ConnectorObjectReadLimits>;
    signal?: AbortSignal;
  }>): Promise<ConnectorObjectReadResult>;
}

export interface StageAuthorizedConnectorObjectRequest {
  readonly actor: McpTokenActorContext;
  readonly spaceId: SpaceId;
  readonly source: AuthorizedConnectorObjectSource;
  readonly representation: ConnectorObjectRepresentation;
  readonly idempotencyKey: unknown;
  readonly signal?: AbortSignal;
}

export type AuthorizedConnectorIngressResult =
  | StageBundleFileStreamResult
  | Readonly<{
      kind: "invalid";
      code:
        | "file_ingress_source_unavailable"
        | "file_ingress_transport_unavailable"
        | "writable_target_required"
        | "writable_target_mismatch"
        | "writable_target_unavailable";
      retryable?: boolean;
    }>;

const SHA256 = /^sha256:[0-9a-f]{64}$/u;

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function explicitRepresentation(value: unknown): value is ConnectorObjectRepresentation {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  if (value.kind === "binary") return hasExactKeys(value, ["kind"]);
  if (value.kind !== "export_snapshot") return false;
  const candidate = value as Partial<Extract<
    ConnectorObjectRepresentation,
    { readonly kind: "export_snapshot" }
  >>;
  return hasExactKeys(value, ["kind", "format", "displayFilename", "mediaType"]) &&
    typeof candidate.format === "string" && candidate.format.length > 0 &&
    candidate.format.length <= 256 &&
    typeof candidate.displayFilename === "string" && candidate.displayFilename.length > 0 &&
    typeof candidate.mediaType === "string" && candidate.mediaType.length > 0;
}

function representationsEqual(
  left: ConnectorObjectRepresentation,
  right: ConnectorObjectRepresentation,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "binary") return true;
  return right.kind === "export_snapshot" &&
    left.format === right.format &&
    left.displayFilename === right.displayFilename &&
    left.mediaType === right.mediaType;
}

function verifiedInput(
  value: unknown,
  requestedRepresentation: ConnectorObjectRepresentation,
): value is Readonly<VerifiedFileInput> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<VerifiedFileInput>;
  const representationMatchesMetadata = candidate.representation?.kind !== "export_snapshot" ||
    (candidate.displayFilename === candidate.representation.displayFilename &&
      candidate.advisoryMediaType === candidate.representation.mediaType);
  return hasExactKeys(value, [
    "sourceKind", "representation", "stream", "displayFilename",
    "advisoryMediaType", "size", "sha256",
  ]) &&
    candidate.sourceKind === "connector_object" &&
    explicitRepresentation(candidate.representation) &&
    representationsEqual(candidate.representation, requestedRepresentation) &&
    representationMatchesMetadata &&
    typeof candidate.stream === "object" && candidate.stream !== null &&
    typeof candidate.stream[Symbol.asyncIterator] === "function" &&
    typeof candidate.displayFilename === "string" &&
    typeof candidate.advisoryMediaType === "string" &&
    Number.isSafeInteger(candidate.size) && candidate.size! >= 0 &&
    candidate.size! <= CONNECTOR_OBJECT_LIMITS.maxBytes &&
    typeof candidate.sha256 === "string" && SHA256.test(candidate.sha256);
}

function unavailable(
  code: "file_ingress_source_unavailable" | "file_ingress_transport_unavailable",
  retryable: boolean,
): AuthorizedConnectorIngressResult {
  return Object.freeze({ kind: "invalid", code, retryable });
}

type ResolvedWritableTarget = Readonly<{
  kind: "ready";
  generationId: CredentialWriteTargetGenerationId;
}>;

type WritableTargetFailure = Readonly<{
  kind: "invalid";
  code:
    | "writable_target_required"
    | "writable_target_mismatch"
    | "writable_target_unavailable";
}>;

function writableTargetFailure(code: WritableTargetFailure["code"]): WritableTargetFailure {
  return Object.freeze({ kind: "invalid", code });
}

function mapCurrentTargetFailure<Result extends StageBundleFileStreamResult>(
  result: Result,
): Result | WritableTargetFailure {
  if (result.kind === "denied") {
    const decision = result.decision as Readonly<{ readonly code?: unknown }>;
    if (decision.code === "write_binding_required") {
      return writableTargetFailure("writable_target_required");
    }
    if (
      decision.code === "write_binding_stale" ||
      decision.code === "binding_state_unavailable" ||
      decision.code === "binding_owner_revoked" ||
      decision.code === "authorization_state_changed"
    ) return writableTargetFailure("writable_target_unavailable");
  }
  if (result.kind === "invalid" && result.code === "binding_mismatch") {
    return writableTargetFailure("writable_target_unavailable");
  }
  return result;
}

/**
 * Provider-neutral connector ingress. The object-bound adapter owns source
 * authorization, representation selection and bounded transport. Existing
 * staging owns Mind authorization, exact-byte verification, quota,
 * idempotency, expiry and reconciliation; existing commit/history/download/
 * web-export services remain the only canonical lifecycle.
 */
export class AuthorizedConnectorIngressService {
  readonly #staging: Pick<
    BundleFileStagingService,
    "authorizeSourceRead" | "stageStream"
  >;
  readonly #targets: Pick<CredentialWriteTargetStore, "readCredentialWriteTarget">;
  readonly #fetchTimeoutMilliseconds: number;

  constructor(dependencies: {
    readonly staging: Pick<
      BundleFileStagingService,
      "authorizeSourceRead" | "stageStream"
    >;
    readonly targets: Pick<CredentialWriteTargetStore, "readCredentialWriteTarget">;
    /** A stricter bounded timeout is allowed for a specific adapter/test profile. */
    readonly fetchTimeoutMilliseconds?: number;
  }) {
    this.#staging = dependencies.staging;
    this.#targets = dependencies.targets;
    const timeout = dependencies.fetchTimeoutMilliseconds ??
      CONNECTOR_OBJECT_LIMITS.fetchTimeoutMilliseconds;
    if (
      !Number.isSafeInteger(timeout) || timeout <= 0 ||
      timeout > CONNECTOR_OBJECT_LIMITS.fetchTimeoutMilliseconds
    ) throw new RangeError("connector fetch timeout is outside the accepted bound");
    this.#fetchTimeoutMilliseconds = timeout;
  }

  async stage(
    request: StageAuthorizedConnectorObjectRequest,
  ): Promise<AuthorizedConnectorIngressResult> {
    if (!explicitRepresentation(request.representation)) {
      return unavailable("file_ingress_source_unavailable", false);
    }
    if (request.signal?.aborted) {
      return unavailable("file_ingress_transport_unavailable", true);
    }

    const target = await this.#resolveWritableTarget(request.actor, request.spaceId);
    if (target.kind === "invalid") return target;

    const authorization = await this.#staging.authorizeSourceRead({
      actor: request.actor,
      spaceId: request.spaceId,
      writeBindingId: target.generationId,
    });
    if (authorization.kind === "denied") {
      return mapCurrentTargetFailure(Object.freeze({
        kind: "denied",
        decision: authorization,
      }));
    }

    const timeoutController = new AbortController();
    const signal = request.signal === undefined
      ? timeoutController.signal
      : AbortSignal.any([request.signal, timeoutController.signal]);
    const limits = Object.freeze({
      ...CONNECTOR_OBJECT_LIMITS,
      fetchTimeoutMilliseconds: this.#fetchTimeoutMilliseconds,
    });
    const timeoutHandle = setTimeout(
      () => timeoutController.abort(),
      this.#fetchTimeoutMilliseconds,
    );
    try {
      const stopped = new Promise<ConnectorObjectReadResult>((resolve) => {
        signal.addEventListener("abort", () => resolve(Object.freeze({
          kind: "unavailable",
          failure: "transport_unavailable",
          retryable: true,
        })), { once: true });
      });
      let source: ConnectorObjectReadResult;
      if (
        typeof request.source !== "object" || request.source === null ||
        typeof request.source.readVerifiedSnapshot !== "function"
      ) return unavailable("file_ingress_transport_unavailable", true);
      try {
        source = await Promise.race([
          request.source.readVerifiedSnapshot({
            actor: request.actor,
            representation: request.representation,
            limits,
            signal,
          }),
          stopped,
        ]);
      } catch {
        return unavailable("file_ingress_transport_unavailable", true);
      }
      if (
        typeof source !== "object" || source === null || !("kind" in source) ||
        (source.kind !== "ready" && source.kind !== "unavailable")
      ) return unavailable("file_ingress_transport_unavailable", true);
      if (source.kind === "unavailable") {
        if (source.failure === "source_unavailable") {
          return unavailable("file_ingress_source_unavailable", false);
        }
        if (
          source.failure !== "transport_unavailable" ||
          typeof source.retryable !== "boolean"
        ) return unavailable("file_ingress_transport_unavailable", true);
        return unavailable("file_ingress_transport_unavailable", source.retryable);
      }
      let isVerified = false;
      try {
        isVerified = verifiedInput(source.input, request.representation);
      } catch {
        return unavailable("file_ingress_transport_unavailable", true);
      }
      if (!isVerified) {
        return unavailable("file_ingress_source_unavailable", false);
      }

      let result: StageBundleFileStreamResult;
      const lateFailure: { current: ConnectorObjectStreamFailure | null } = {
        current: null,
      };
      const classifiedStream = Object.freeze({
        async *[Symbol.asyncIterator]() {
          try {
            for await (const chunk of source.input.stream) yield chunk;
          } catch (error) {
            if (error instanceof ConnectorObjectStreamFailure) {
              lateFailure.current = error;
            }
            throw error;
          }
        },
      });
      try {
        result = await this.#staging.stageStream({
          actor: request.actor,
          spaceId: request.spaceId,
          writeBindingId: target.generationId,
          sourceKind: "connector_object",
          stream: classifiedStream,
          maxBytes: CONNECTOR_OBJECT_LIMITS.maxBytes,
          displayFilename: source.input.displayFilename,
          claimedMediaType: source.input.advisoryMediaType,
          idempotencyKey: request.idempotencyKey,
          expectedSize: source.input.size,
          expectedSha256: source.input.sha256,
          signal,
        });
      } catch {
        if (lateFailure.current !== null) {
          return lateFailure.current.failure === "source_unavailable"
            ? unavailable("file_ingress_source_unavailable", false)
            : unavailable(
                "file_ingress_transport_unavailable",
                lateFailure.current.retryable,
              );
        }
        return unavailable("file_ingress_transport_unavailable", true);
      }
      if (result.kind === "stream_invalid" && result.code === "stream_transport_unavailable") {
        if (lateFailure.current !== null) {
          return lateFailure.current.failure === "source_unavailable"
            ? unavailable("file_ingress_source_unavailable", false)
            : unavailable(
                "file_ingress_transport_unavailable",
                lateFailure.current.retryable,
              );
        }
        return unavailable("file_ingress_transport_unavailable", true);
      }
      if (
        result.kind === "invalid" &&
        (result.code === "expected_size_mismatch" || result.code === "expected_sha256_mismatch")
      ) {
        return unavailable("file_ingress_source_unavailable", false);
      }
      return mapCurrentTargetFailure(result);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async #resolveWritableTarget(
    actor: McpTokenActorContext,
    spaceId: SpaceId,
  ): Promise<ResolvedWritableTarget | WritableTargetFailure> {
    let snapshot;
    try {
      snapshot = await this.#targets.readCredentialWriteTarget(
        actor.authentication.bindingOwnerId,
        actor.principalId,
      );
    } catch {
      return writableTargetFailure("writable_target_unavailable");
    }
    if (snapshot?.kind === "pending_upgrade") {
      return writableTargetFailure("writable_target_required");
    }
    if (
      snapshot?.kind !== "current" ||
      snapshot.state.bindingOwnerId !== actor.authentication.bindingOwnerId ||
      snapshot.state.principalId !== actor.principalId ||
      snapshot.state.lifecycleState !== "active"
    ) return writableTargetFailure("writable_target_unavailable");
    const generation = snapshot.state.activeGeneration;
    if (generation === null) return writableTargetFailure("writable_target_required");
    if (
      generation.bindingOwnerId !== actor.authentication.bindingOwnerId ||
      generation.spaceId !== spaceId
    ) return writableTargetFailure("writable_target_mismatch");
    return Object.freeze({ kind: "ready", generationId: generation.generationId });
  }
}
