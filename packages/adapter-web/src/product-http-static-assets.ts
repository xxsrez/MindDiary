import {
  PRODUCT_COLLABORATION_CLIENT_JAVASCRIPT,
  PRODUCT_CONNECTIONS_CLIENT_JAVASCRIPT,
  PRODUCT_MARKDOWN_IMPORT_CLIENT_JAVASCRIPT,
  PRODUCT_ORDINARY_MINDS_CLIENT_JAVASCRIPT,
  PRODUCT_SHELL_INTERACTIONS_JAVASCRIPT,
  PRODUCT_UI_APPLE_TOUCH_ICON_PNG,
  PRODUCT_UI_CLIENT_JAVASCRIPT,
  PRODUCT_UI_FAVICON_ICO,
  PRODUCT_UI_FAVICON_PNG,
  PRODUCT_UI_FAVICON_SVG,
  PRODUCT_UI_LOCKUP_SVG,
  PRODUCT_UI_MARK_SVG,
  PRODUCT_UI_SHELL_CSS,
  PRODUCT_UI_TOKENS_CSS,
  PRODUCT_VISIBILITY_CATALOG_CLIENT_JAVASCRIPT,
} from "./product-ui-assets.js";

import {
  SAFE_HEADERS,
  STATIC_ASSET_CACHE_CONTROL,
  errorResponse,
} from "./product-http-request-helpers.js";

function staticAsset(pathname: string): { readonly body: BodyInit; readonly type: string } | null {
  if (pathname === "/favicon.ico") return { body: PRODUCT_UI_FAVICON_ICO, type: "image/x-icon" };
  if (pathname === "/favicon.svg") return { body: PRODUCT_UI_FAVICON_SVG, type: "image/svg+xml; charset=utf-8" };
  if (pathname === "/favicon-32x32.png") return { body: PRODUCT_UI_FAVICON_PNG, type: "image/png" };
  if (pathname === "/apple-touch-icon.png") return { body: PRODUCT_UI_APPLE_TOUCH_ICON_PNG, type: "image/png" };
  if (pathname === "/brand/mind-diary-tokens.css") return { body: PRODUCT_UI_TOKENS_CSS, type: "text/css; charset=utf-8" };
  if (pathname === "/ui/mind-diary-shell.css") return { body: PRODUCT_UI_SHELL_CSS, type: "text/css; charset=utf-8" };
  if (pathname === "/brand/mind-diary-lockup.svg") return { body: PRODUCT_UI_LOCKUP_SVG, type: "image/svg+xml; charset=utf-8" };
  if (pathname === "/brand/mind-diary-mark.svg") return { body: PRODUCT_UI_MARK_SVG, type: "image/svg+xml; charset=utf-8" };
  if (pathname === "/ui/mind-diary-onboarding-client.js") {
    return {
      body: `${PRODUCT_SHELL_INTERACTIONS_JAVASCRIPT}\n${PRODUCT_UI_CLIENT_JAVASCRIPT}\n${PRODUCT_MARKDOWN_IMPORT_CLIENT_JAVASCRIPT}`,
      type: "text/javascript; charset=utf-8",
    };
  }
  if (
    pathname === "/ui/mind-diary-shell-client.js" ||
    pathname === "/ui/mind-diary-token-client.js" ||
    pathname === "/ui/mind-diary-account-client.js"
  ) return { body: `${PRODUCT_SHELL_INTERACTIONS_JAVASCRIPT}\n${PRODUCT_UI_CLIENT_JAVASCRIPT}`, type: "text/javascript; charset=utf-8" };
  if (pathname === "/ui/mind-diary-ordinary-minds-client.js") {
    return {
      body: `${PRODUCT_SHELL_INTERACTIONS_JAVASCRIPT}\n${PRODUCT_ORDINARY_MINDS_CLIENT_JAVASCRIPT}\n${PRODUCT_MARKDOWN_IMPORT_CLIENT_JAVASCRIPT}\n${PRODUCT_COLLABORATION_CLIENT_JAVASCRIPT}`,
      type: "text/javascript; charset=utf-8",
    };
  }
  if (pathname === "/ui/mind-diary-collaboration-client.js") {
    return {
      body: `${PRODUCT_SHELL_INTERACTIONS_JAVASCRIPT}\n${PRODUCT_COLLABORATION_CLIENT_JAVASCRIPT}`,
      type: "text/javascript; charset=utf-8",
    };
  }
  if (pathname === "/ui/mind-diary-visibility-client.js") {
    return {
      body: `${PRODUCT_SHELL_INTERACTIONS_JAVASCRIPT}\n${PRODUCT_VISIBILITY_CATALOG_CLIENT_JAVASCRIPT}`,
      type: "text/javascript; charset=utf-8",
    };
  }
  if (pathname === "/ui/mind-diary-connections-client.js") {
    return {
      body: `${PRODUCT_SHELL_INTERACTIONS_JAVASCRIPT}\n${PRODUCT_UI_CLIENT_JAVASCRIPT}\n${PRODUCT_CONNECTIONS_CLIENT_JAVASCRIPT}`,
      type: "text/javascript; charset=utf-8",
    };
  }
  return null;
}

/** Serves compile-time product assets without requiring product runtime composition. */
export function createProductUiStaticAssetResponse(request: Request): Response | null {
  const asset = staticAsset(new URL(request.url).pathname);
  if (asset === null) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(405, "method_not_allowed", "asset_request");
  }
  return new Response(request.method === "HEAD" ? null : asset.body, {
    status: 200,
    headers: {
      ...SAFE_HEADERS,
      "cache-control": STATIC_ASSET_CACHE_CONTROL,
      "content-type": asset.type,
    },
  });
}
