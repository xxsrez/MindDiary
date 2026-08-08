export type ProductExportDownloadResult =
  | {
      readonly kind: "download";
      readonly response: Readonly<{
        readonly headers: Readonly<Record<string, string>>;
        readonly bytes: Uint8Array;
      }>;
    }
  | { readonly kind: "not_found" };

export interface ProductExportDownloadApplication {
  /** Verifies the opaque grant and current server-side access before returning bytes. */
  download(secret: string):
    | ProductExportDownloadResult
    | Promise<ProductExportDownloadResult>;
}

const NOT_FOUND_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

function notFound(): Response {
  return new Response(
    '{"ok":false,"error":{"code":"not_found","message":"The resource was not found.","retryable":false}}\n',
    { status: 404, headers: NOT_FOUND_HEADERS },
  );
}

/**
 * Serves short-lived export grants without treating browser identity, Bearer
 * auth, or the URL payload as authority. The application reauthorizes the
 * principal captured in the durable grant and returns a generic miss on any
 * invalid, expired, revoked, deleted, or unauthorized state.
 */
export function createProductExportDownloadHttpHandler(
  application: ProductExportDownloadApplication,
): (request: Request) => Promise<Response | null> {
  return async (request) => {
    const url = new URL(request.url);
    const match = /^\/api\/v1\/exports\/([^/]+)$/u.exec(url.pathname);
    if (match === null) return null;
    if (request.method !== "GET") return notFound();
    let secret: string;
    try {
      secret = decodeURIComponent(match[1]!);
    } catch {
      return notFound();
    }
    if (secret.length === 0 || secret.includes("/") || secret.includes("\\")) {
      return notFound();
    }
    let result: ProductExportDownloadResult;
    try {
      result = await application.download(secret);
    } catch {
      return notFound();
    }
    if (result.kind !== "download") return notFound();
    const body = Uint8Array.from(result.response.bytes).buffer;
    return new Response(body, {
      status: 200,
      headers: result.response.headers,
    });
  };
}
