declare const opaqueId: unique symbol;

export type OpaqueId<Kind extends string> = string & {
  readonly [opaqueId]: Kind;
};

export type PrincipalId = OpaqueId<"principal">;
export type SpaceId = OpaqueId<"space">;
export type RevisionId = OpaqueId<"revision">;
export type UtcInstant = string & { readonly [opaqueId]: "utc-instant" };

export const DOMAIN_MODULE = "domain" as const;
