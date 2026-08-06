import type {
  Capability,
  OpaqueId,
  PrincipalId,
  TokenId,
  UtcInstant,
} from "@mind-diary/domain";

export type RequestId = OpaqueId<"request">;

export type ActorContext =
  | {
      readonly kind: "registered_principal";
      readonly principalId: PrincipalId;
      readonly authentication:
        | { readonly kind: "sites_identity" }
        | { readonly kind: "mcp_token"; readonly tokenId: TokenId };
      /** Trusted deployment configuration; it can only narrow authorization. */
      readonly deploymentCapabilities: readonly Capability[];
      readonly requestId: RequestId;
      readonly occurredAtUtc: UtcInstant;
    }
  | {
      readonly kind: "service";
      readonly serviceId: string;
      readonly deploymentCapabilities: readonly Capability[];
      readonly requestId: RequestId;
      readonly occurredAtUtc: UtcInstant;
    };

export interface ApplicationError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly requestId: RequestId;
}
