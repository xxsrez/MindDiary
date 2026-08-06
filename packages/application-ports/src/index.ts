import type { ActorContext } from "@mind-diary/application-contracts";
import type { SpaceId, UtcInstant } from "@mind-diary/domain";

export interface Clock {
  now(): UtcInstant;
}

export interface MetadataStore {
  readonly kind: "metadata-store";
}

export interface ObjectStore {
  readonly kind: "object-store";
}

export interface SearchIndex {
  readonly kind: "search-index";
}

export interface Authorizer {
  authorize(actor: ActorContext, spaceId: SpaceId): Promise<"allowed" | "denied">;
}

export interface TokenHasher {
  readonly kind: "token-hasher";
}

export interface AuditSink {
  readonly kind: "audit-sink";
}
