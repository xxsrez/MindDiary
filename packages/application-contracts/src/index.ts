import type { OpaqueId, PrincipalId, UtcInstant } from "@mind-diary/domain";

export type RequestId = OpaqueId<"request">;

export type ActorContext =
  | {
      readonly kind: "registered_principal";
      readonly principalId: PrincipalId;
      readonly authentication: "sites_identity" | "mcp_token";
      readonly requestId: RequestId;
      readonly occurredAtUtc: UtcInstant;
    }
  | {
      readonly kind: "service";
      readonly serviceId: string;
      readonly requestId: RequestId;
      readonly occurredAtUtc: UtcInstant;
    };

export interface ApplicationError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly requestId: RequestId;
}
