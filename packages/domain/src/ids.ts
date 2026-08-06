declare const opaqueIdBrand: unique symbol;

export type OpaqueId<Kind extends string> = string & {
  readonly [opaqueIdBrand]: Kind;
};

export type PrincipalId = OpaqueId<"principal">;
export type DeletedPrincipalId = OpaqueId<"deleted-principal">;
export type ExternalBindingId = OpaqueId<"external-binding">;
export type SpaceId = OpaqueId<"space">;
export type MembershipId = OpaqueId<"membership">;
export type InvitationId = OpaqueId<"invitation">;
export type RevisionId = OpaqueId<"revision">;
export type TokenId = OpaqueId<"token">;
export type JobId = OpaqueId<"job">;
export type IdempotencyRecordId = OpaqueId<"idempotency-record">;
export type AuditEventId = OpaqueId<"audit-event">;
export type OutboxMessageId = OpaqueId<"outbox-message">;
export type RequestId = OpaqueId<"request">;
export type UtcInstant = string & { readonly [opaqueIdBrand]: "utc-instant" };
export type SensitiveExternalBinding = string & {
  readonly [opaqueIdBrand]: "sensitive-external-binding";
};
export type SecretVerifier = string & {
  readonly [opaqueIdBrand]: "secret-verifier";
};
export type Sha256Digest = string & { readonly [opaqueIdBrand]: "sha256" };
export type IdempotencyKey = string & {
  readonly [opaqueIdBrand]: "idempotency-key";
};

/**
 * Branding makes unrelated IDs non-interchangeable at compile time. It does
 * not authenticate or authorize an ID; callers still resolve it against
 * trusted server-side state.
 */
export function opaqueId<Kind extends string>(value: string): OpaqueId<Kind> {
  if (value.length === 0) {
    throw new TypeError("opaque IDs must not be empty");
  }
  return value as OpaqueId<Kind>;
}
