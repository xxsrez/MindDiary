import {
  NativeFileParameterRoute,
  type NativeFileParameterRouteOptions,
  type OpenAiMcpAppsNativeFileParameterRouteOptions,
} from "@mind-diary/adapter-mcp";

export type ProductSiteMcpProfile = "modern" | "compatibility";

export type ProductSiteVerifiedNativeFileParameterRouteOptions =
  NativeFileParameterRouteOptions & Readonly<{
    readonly mcpProfiles: readonly ProductSiteMcpProfile[];
  }>;

/** Fail-closed constructor input owned by the host composition, never MCP input. */
export function createVerifiedNativeFileParameterComposition(
  options: ProductSiteVerifiedNativeFileParameterRouteOptions | undefined,
): Readonly<{
  route?: NativeFileParameterRoute;
  mcpProfiles: readonly ProductSiteMcpProfile[];
}> {
  if (options === undefined) return Object.freeze({ mcpProfiles: Object.freeze([]) });
  const { mcpProfiles, ...routeOptions } = options;
  if (
    !Array.isArray(mcpProfiles) || mcpProfiles.length < 1 || mcpProfiles.length > 2 ||
    mcpProfiles.some((profile) => profile !== "modern" && profile !== "compatibility") ||
    new Set(mcpProfiles).size !== mcpProfiles.length
  ) throw new TypeError("native file route requires exact unique MCP profiles");
  return Object.freeze({
    route: NativeFileParameterRoute.create(routeOptions),
    mcpProfiles: Object.freeze([...mcpProfiles]),
  });
}

/** Exact compile-time profile owned solely by `/api/mcp/apps`. */
export function createOpenAiMcpAppsNativeFileParameterComposition(
  options: OpenAiMcpAppsNativeFileParameterRouteOptions = {},
): Readonly<{ route: NativeFileParameterRoute }> {
  return Object.freeze({
    route: NativeFileParameterRoute.createOpenAiMcpApps(options),
  });
}
