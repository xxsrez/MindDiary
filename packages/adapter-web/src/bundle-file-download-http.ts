export interface ProductBundleFileDownloadApplication {
  download(secret: string): Promise<
    | {
        readonly kind: "download";
        readonly headers: Readonly<Record<string, string>>;
        readonly body: ReadableStream<Uint8Array>;
      }
    | { readonly kind: "not_found" }
  >;
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

export function createProductBundleFileDownloadHttpHandler(
  application: ProductBundleFileDownloadApplication,
): (request: Request) => Promise<Response | null> {
  return async (request) => {
    const url = new URL(request.url);
    const match = /^\/api\/bundle-download\/([^/]+)$/u.exec(url.pathname);
    if (match === null) return null;
    if (request.method !== "GET" || request.headers.has("range")) return notFound();
    let secret: string;
    try {
      secret = decodeURIComponent(match[1]!);
    } catch {
      return notFound();
    }
    if (secret.length === 0 || secret.includes("/") || secret.includes("\\")) return notFound();
    try {
      const result = await application.download(secret);
      if (result.kind !== "download") return notFound();
      return new Response(result.body, {
        status: 200,
        headers: result.headers,
      });
    } catch {
      return notFound();
    }
  };
}
