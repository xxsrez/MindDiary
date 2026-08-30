import {
  GENERATED_ARTIFACT_LIMITS,
  type GeneratedArtifactIngressResult,
  type GeneratedArtifactIngressService,
} from "@mind-diary/application-content";
import type {
  IdempotencyKey,
  Sha256Digest,
  SpaceId,
} from "@mind-diary/domain";

type GeneratedArtifactActorContext = Parameters<
  GeneratedArtifactIngressService["stageBoundedInMemory"]
>[0]["actor"];
type TrustedBoundedInMemoryActorContext = Extract<
  GeneratedArtifactActorContext,
  Readonly<{
    kind: "registered_principal";
    authentication: Readonly<{ kind: "mcp_token" }>;
  }>
>;

export interface BoundedInMemoryIngressRequest {
  readonly actor: TrustedBoundedInMemoryActorContext;
  readonly spaceId: SpaceId;
  readonly displayFilename: string;
  readonly claimedMediaType?: string;
  readonly bytes: Uint8Array;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedSize?: number;
  readonly expectedSha256?: Sha256Digest;
}

/**
 * Constructor-owned ingress exposed only to trusted hosted producers.
 *
 * It deliberately has no Request/Response, JSON, URL, file locator or generic
 * source-kind surface. The application service remains authoritative for the
 * filename, digest, size, media, ACL, target, quota and stage lifecycle.
 */
export interface BoundedInMemoryIngressPort {
  stage(
    request: Readonly<BoundedInMemoryIngressRequest>,
  ): Promise<GeneratedArtifactIngressResult>;
}

export function createBoundedInMemoryIngressAdapter(dependencies: {
  readonly application: Pick<GeneratedArtifactIngressService, "stageBoundedInMemory">;
}): BoundedInMemoryIngressPort {
  return Object.freeze({
    async stage(
      request: Readonly<BoundedInMemoryIngressRequest>,
    ): Promise<GeneratedArtifactIngressResult> {
      if (!(request.bytes instanceof Uint8Array)) {
        return Object.freeze({
          kind: "invalid" as const,
          code: "generated_artifact_invalid_chunk" as const,
        });
      }
      if (
        request.bytes.byteLength >
          GENERATED_ARTIFACT_LIMITS.maxBoundedInMemoryBytes
      ) {
        return Object.freeze({
          kind: "invalid" as const,
          code: "generated_artifact_size_limit_exceeded" as const,
        });
      }
      return dependencies.application.stageBoundedInMemory({
        actor: request.actor,
        spaceId: request.spaceId,
        displayFilename: request.displayFilename,
        claimedMediaType: request.claimedMediaType,
        bytes: request.bytes,
        idempotencyKey: request.idempotencyKey,
        ...(request.expectedSize === undefined
          ? {}
          : { expectedSize: request.expectedSize }),
        ...(request.expectedSha256 === undefined
          ? {}
          : { expectedSha256: request.expectedSha256 }),
      });
    },
  });
}
