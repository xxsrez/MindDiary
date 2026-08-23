import type { ActorContext } from "@mind-diary/application-contracts";
import type { SpaceId } from "@mind-diary/domain";
import {
  BUNDLE_FILE_LIMITS,
  type BundleFileStagingService,
  type StageBundleFileStreamResult,
} from "./bundle-files.js";

export interface AuthorizedConnectorObjectReader {
  /**
   * The adapter must prove current connector grant/object ownership before
   * returning ready. Provider IDs, URLs and credentials remain inside it.
   */
  read(request: Readonly<{
    actor: ActorContext;
    object: unknown;
    signal?: AbortSignal;
  }>): Promise<
    | Readonly<{
        kind: "ready";
        stream: AsyncIterable<unknown>;
        displayFilename: unknown;
        claimedMediaType?: unknown;
        expectedSize?: unknown;
        expectedSha256?: unknown;
      }>
    | Readonly<{ kind: "denied"; decision: unknown }>
    | Readonly<{ kind: "unavailable"; retryable: boolean }>
  >;
}

export interface StageAuthorizedConnectorObjectRequest {
  readonly actor: ActorContext;
  readonly spaceId: SpaceId;
  readonly writeBindingId: unknown;
  readonly object: unknown;
  readonly idempotencyKey: unknown;
  readonly displayFilename?: unknown;
  readonly expectedSize?: unknown;
  readonly expectedSha256?: unknown;
  readonly signal?: AbortSignal;
}

export type AuthorizedConnectorIngressResult =
  | StageBundleFileStreamResult
  | Readonly<{
      kind: "invalid";
      code: "file_ingress_source_unavailable";
      retryable: boolean;
    }>;

/**
 * Provider-neutral connector ingress. The connector adapter resolves and
 * authorizes its opaque object, while shared staging owns byte integrity,
 * binding, quota, expiry and idempotency.
 */
export class AuthorizedConnectorIngressService {
  readonly #reader: AuthorizedConnectorObjectReader;
  readonly #staging: Pick<BundleFileStagingService, "stageStream">;

  constructor(dependencies: {
    readonly reader: AuthorizedConnectorObjectReader;
    readonly staging: Pick<BundleFileStagingService, "stageStream">;
  }) {
    this.#reader = dependencies.reader;
    this.#staging = dependencies.staging;
  }

  async stage(
    request: StageAuthorizedConnectorObjectRequest,
  ): Promise<AuthorizedConnectorIngressResult> {
    let source: Awaited<ReturnType<AuthorizedConnectorObjectReader["read"]>>;
    try {
      source = await this.#reader.read({
        actor: request.actor,
        object: request.object,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch {
      return Object.freeze({
        kind: "invalid",
        code: "file_ingress_source_unavailable",
        retryable: true,
      });
    }
    if (source.kind === "denied") {
      return Object.freeze({ kind: "denied", decision: source.decision });
    }
    if (source.kind === "unavailable") {
      return Object.freeze({
        kind: "invalid",
        code: "file_ingress_source_unavailable",
        retryable: source.retryable,
      });
    }
    return this.#staging.stageStream({
      actor: request.actor,
      spaceId: request.spaceId,
      writeBindingId: request.writeBindingId,
      sourceKind: "connector_object",
      stream: source.stream,
      maxBytes: BUNDLE_FILE_LIMITS.maxFileBytes,
      displayFilename: request.displayFilename ?? source.displayFilename,
      claimedMediaType: source.claimedMediaType,
      idempotencyKey: request.idempotencyKey,
      expectedSize: request.expectedSize ?? source.expectedSize,
      expectedSha256: request.expectedSha256 ?? source.expectedSha256,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  }
}
