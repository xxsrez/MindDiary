import type {
  Capability,
  EffectiveTokenScopes,
  OpaqueId,
  PrincipalId,
  TokenId,
  UtcInstant,
} from "@mind-diary/domain";

export type RequestId = OpaqueId<"request">;

interface RegisteredPrincipalActorBase {
  readonly kind: "registered_principal";
  readonly principalId: PrincipalId;
  /** Trusted deployment configuration; it can only narrow authorization. */
  readonly deploymentCapabilities: readonly Capability[];
  readonly requestId: RequestId;
  readonly occurredAtUtc: UtcInstant;
}

export type RegisteredPrincipalActorContext =
  | (RegisteredPrincipalActorBase & {
      readonly authentication: { readonly kind: "sites_identity" };
    })
  | (RegisteredPrincipalActorBase & {
      readonly authentication: {
        readonly kind: "mcp_token";
        readonly tokenId: TokenId;
        /** Authenticated snapshot for transport filtering, never a role claim. */
        readonly effectiveScopes: EffectiveTokenScopes;
      };
    });

export type McpTokenActorContext = Extract<
  RegisteredPrincipalActorContext,
  { readonly authentication: { readonly kind: "mcp_token" } }
>;

export type ActorContext =
  | RegisteredPrincipalActorContext
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
