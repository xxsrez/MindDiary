import {
  NativeFileParameterRoute,
  type NativeFileParameterRouteOptions,
  type OpenAiFileParameterRouteOptions,
} from "@mind-diary/adapter-mcp";

export type ProductSiteVerifiedNativeFileParameterRouteOptions =
  NativeFileParameterRouteOptions;

/** Fail-closed constructor input owned by the host composition, never MCP input. */
export function createVerifiedNativeFileParameterComposition(
  options: ProductSiteVerifiedNativeFileParameterRouteOptions | undefined,
): Readonly<{
  route?: NativeFileParameterRoute;
}> {
  if (options === undefined) return Object.freeze({});
  return Object.freeze({ route: NativeFileParameterRoute.create(options) });
}

/** Standard modern OpenAI fileParams profile for the ordinary MCP route. */
export function createOpenAiFileParameterComposition(
  options: OpenAiFileParameterRouteOptions = {},
): Readonly<{ route: NativeFileParameterRoute }> {
  return Object.freeze({
    route: NativeFileParameterRoute.createOpenAiFileParameter(options),
  });
}
