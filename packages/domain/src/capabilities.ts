import type {
  Capability,
  EffectiveTokenScopes,
  RevisionMode,
  Role,
  TokenScope,
  Visibility,
} from "./records.js";

const reader = [
  "content:browse",
  "content:search",
  "content:fetch",
  "content:history",
  "content:validate",
  "content:export",
] as const satisfies readonly Capability[];

const editor = [...reader, "content:write"] as const satisfies readonly Capability[];
const admin = [
  ...editor,
  "members:manage-basic",
  "settings:configure",
] as const satisfies readonly Capability[];
const owner = [
  ...admin,
  "members:manage-admin",
  "visibility:change",
  "ownership:transfer",
  "space:delete",
] as const satisfies readonly Capability[];

const byRole: Readonly<Record<Role, readonly Capability[]>> = Object.freeze({
  reader: Object.freeze(reader),
  editor: Object.freeze(editor),
  admin: Object.freeze(admin),
  owner: Object.freeze(owner),
});

/** Pure role policy only; effective authorization also requires trusted state. */
export function capabilitiesForRole(role: Role): readonly Capability[] {
  return byRole[role];
}

export function roleHasCapability(role: Role, capability: Capability): boolean {
  return byRole[role].includes(capability);
}

export function capabilitiesForVisibilityGrant(
  visibility: Visibility,
): readonly Capability[] {
  return visibility === "private" ? Object.freeze([]) : byRole.reader;
}

export function tokenScopesAllowCapability(
  scopes: EffectiveTokenScopes,
  capability: Capability,
): boolean {
  if (capability === "content:write") {
    return scopes.some((scope) => scope === "content:write");
  }
  return (
    capability.startsWith("content:") &&
    scopes.some(
      (scope) => scope === "content:read" || scope === "content:write",
    )
  );
}

export function revisionModeAllowsCapability(
  mode: RevisionMode,
  capability: Capability,
): boolean {
  return mode === "head" || byRole.reader.includes(capability);
}

export function normalizeTokenScopes(scopes: readonly TokenScope[]): EffectiveTokenScopes {
  if (scopes.includes("content:write")) {
    return Object.freeze(["content:read", "content:write"] as const);
  }
  if (scopes.includes("content:read")) {
    return Object.freeze(["content:read"] as const);
  }
  throw new TypeError("token scopes must include content:read or content:write");
}
