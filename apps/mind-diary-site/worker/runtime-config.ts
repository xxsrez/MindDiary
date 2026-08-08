export interface ProductEnv {
  readonly ASSETS: Fetcher;
  readonly DB: D1Database;
  readonly MIND_DIARY_BUCKET: R2Bucket;
  readonly MIND_DIARY_PUBLIC_ORIGIN?: string;
  readonly MIND_DIARY_TOKEN_VERIFIER_KEY?: string;
  readonly MIND_DIARY_LOCATOR_KEY?: string;
  readonly MIND_DIARY_EXPORT_DOWNLOAD_VERIFIER_KEY?: string;
  readonly MIND_DIARY_CSRF_KEY?: string;
}

function decodeKey(value: string | undefined, name: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new Error(`${name} must be a 32-byte base64url deployment secret`);
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=";
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  if (bytes.byteLength !== 32) throw new Error(`${name} is invalid`);
  return bytes;
}

export function readRuntimeConfig(request: Request, env: ProductEnv) {
  const requestOrigin = new URL(request.url).origin;
  const publicOrigin = env.MIND_DIARY_PUBLIC_ORIGIN ?? requestOrigin;
  const parsed = new URL(publicOrigin);
  if (parsed.protocol !== "https:" || parsed.origin !== publicOrigin || parsed.pathname !== "/") {
    throw new Error("MIND_DIARY_PUBLIC_ORIGIN must be a canonical HTTPS origin");
  }
  if (requestOrigin !== publicOrigin) throw new Error("request origin does not match configured public origin");
  return Object.freeze({
    publicOrigin,
    tokenVerifierKey: decodeKey(env.MIND_DIARY_TOKEN_VERIFIER_KEY, "MIND_DIARY_TOKEN_VERIFIER_KEY"),
    locatorKey: decodeKey(env.MIND_DIARY_LOCATOR_KEY, "MIND_DIARY_LOCATOR_KEY"),
    exportDownloadVerifierKey: decodeKey(env.MIND_DIARY_EXPORT_DOWNLOAD_VERIFIER_KEY, "MIND_DIARY_EXPORT_DOWNLOAD_VERIFIER_KEY"),
    csrfKey: decodeKey(env.MIND_DIARY_CSRF_KEY, "MIND_DIARY_CSRF_KEY"),
  });
}
