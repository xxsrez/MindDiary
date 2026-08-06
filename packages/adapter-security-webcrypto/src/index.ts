import type {
  IssuedTokenSecret,
  PersistedTokenSecretMaterial,
  TokenHasher,
  TokenVerificationResult,
  TokenVerifier,
  TokenVerifierLookup,
} from "@mind-diary/application-ports";

/** Stable composition marker retained for the bootstrap package graph. */
export const SECURITY_ADAPTER = "webcrypto-contract-only" as const;
export const TOKEN_SECRET_POLICY = "webcrypto-token-secret-v1" as const;
export const TOKEN_SECRET_PREFIX = "mdp_v1_" as const;
export const TOKEN_SECRET_RANDOM_BYTES = 32 as const;
export const TOKEN_SECRET_BODY_LENGTH = 43 as const;
export const TOKEN_SECRET_LENGTH = 50 as const;
export const TOKEN_DISPLAY_RANDOM_CHARACTERS = 6 as const;
export const TOKEN_VERIFIER_PREFIX = "hmac-sha256:v1:" as const;
export const TOKEN_VERIFIER_HEX_LENGTH = 64 as const;
export const TOKEN_VERIFIER_KEY_MINIMUM_BYTES = 32 as const;

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const TOKEN_BODY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_VERIFIER_PATTERN = /^hmac-sha256:v1:[0-9a-f]{64}$/;
const HMAC_DOMAIN = new TextEncoder().encode("mind-diary:mcp-token:v1\0");
const DUMMY_VERIFIER_BYTES = new Uint8Array(32);
const INVALID_RESULT = Object.freeze({ kind: "invalid" } as const);

export type TokenSecurityFailureCode =
  | "invalid_configuration"
  | "security_unavailable"
  | "verification_unavailable";

/** Safe failure: messages and enumerable fields never include security inputs. */
export class TokenSecurityFailure extends Error {
  readonly code: TokenSecurityFailureCode;

  constructor(code: TokenSecurityFailureCode, message: string) {
    super(message);
    this.name = "TokenSecurityFailure";
    this.code = code;
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += BASE64URL_ALPHABET[first >>> 2]!;
    encoded += BASE64URL_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >>> 4)]!;
    if (second === undefined) continue;
    encoded += BASE64URL_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >>> 6)]!;
    if (third === undefined) continue;
    encoded += BASE64URL_ALPHABET[third & 0x3f]!;
  }
  return encoded;
}

function decodeBase64Url32(value: string): Uint8Array | null {
  if (
    value.length !== TOKEN_SECRET_BODY_LENGTH ||
    !TOKEN_BODY_PATTERN.test(value)
  ) {
    return null;
  }

  const decoded = new Uint8Array(TOKEN_SECRET_RANDOM_BYTES);
  let accumulator = 0;
  let accumulatedBits = 0;
  let outputIndex = 0;
  for (const character of value) {
    const digit = BASE64URL_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    accumulator = (accumulator << 6) | digit;
    accumulatedBits += 6;
    if (accumulatedBits < 8) continue;
    accumulatedBits -= 8;
    if (outputIndex >= decoded.length) return null;
    decoded[outputIndex] = (accumulator >>> accumulatedBits) & 0xff;
    outputIndex += 1;
    accumulator &= (1 << accumulatedBits) - 1;
  }

  if (
    outputIndex !== TOKEN_SECRET_RANDOM_BYTES ||
    accumulatedBits !== 2 ||
    accumulator !== 0 ||
    encodeBase64Url(decoded) !== value
  ) {
    decoded.fill(0);
    return null;
  }
  return decoded;
}

function parseCanonicalSecret(candidate: unknown): Uint8Array | null {
  if (
    typeof candidate !== "string" ||
    candidate.length !== TOKEN_SECRET_LENGTH ||
    !candidate.startsWith(TOKEN_SECRET_PREFIX)
  ) {
    return null;
  }
  return decodeBase64Url32(candidate.slice(TOKEN_SECRET_PREFIX.length));
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function verifierBytes(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !TOKEN_VERIFIER_PATTERN.test(value)) {
    return null;
  }
  const hex = value.slice(TOKEN_VERIFIER_PREFIX.length);
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    const parsed = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    if (!Number.isInteger(parsed)) return null;
    bytes[index] = parsed;
  }
  return bytes;
}

/** Both inputs are always 32 bytes; the loop has no data-dependent exit. */
function constantTimeEqual32(left: Uint8Array, right: Uint8Array): boolean {
  let difference = 0;
  for (let index = 0; index < 32; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

class ConsumeOnceTokenSecret implements IssuedTokenSecret {
  #secret: string | null;
  readonly #persistence: Readonly<PersistedTokenSecretMaterial>;

  constructor(secret: string, persistence: PersistedTokenSecretMaterial) {
    this.#secret = secret;
    this.#persistence = new TokenSecretPersistenceRecord(persistence);
  }

  get displayPrefix(): string {
    return this.#persistence.displayPrefix;
  }

  consumeSecret(): string | null {
    const secret = this.#secret;
    this.#secret = null;
    return secret;
  }

  persistence(): Readonly<PersistedTokenSecretMaterial> {
    return this.#persistence;
  }

  toJSON(): { readonly display_prefix: string } {
    return Object.freeze({ display_prefix: this.displayPrefix });
  }
}

/** Persistable by explicit field access, but safe under incidental serialization. */
class TokenSecretPersistenceRecord implements PersistedTokenSecretMaterial {
  readonly #material: PersistedTokenSecretMaterial;

  constructor(material: PersistedTokenSecretMaterial) {
    this.#material = Object.freeze({ ...material });
    Object.freeze(this);
  }

  get format(): "mdp_v1" {
    return this.#material.format;
  }

  get algorithm(): "hmac-sha256" {
    return this.#material.algorithm;
  }

  get verifierVersion(): "v1" {
    return this.#material.verifierVersion;
  }

  get verifier(): TokenVerifier {
    return this.#material.verifier;
  }

  get displayPrefix(): string {
    return this.#material.displayPrefix;
  }

  toJSON(): { readonly display_prefix: string } {
    return Object.freeze({ display_prefix: this.displayPrefix });
  }
}

export interface WebCryptoTokenHasherOptions {
  /** Deployment secret; copied for import and never retained as raw bytes. */
  readonly verifierKey: Uint8Array;
  /** Injectable only for compatible runtimes/tests; defaults to global Web Crypto. */
  readonly crypto?: Crypto;
}

export class WebCryptoTokenHasher implements TokenHasher {
  readonly kind = "token-hasher" as const;
  readonly #crypto: Crypto;
  readonly #key: CryptoKey;

  constructor(crypto: Crypto, key: CryptoKey) {
    this.#crypto = crypto;
    this.#key = key;
  }

  async issueSecret(): Promise<IssuedTokenSecret> {
    const randomBytes = new Uint8Array(TOKEN_SECRET_RANDOM_BYTES);
    let secret = "";
    try {
      this.#crypto.getRandomValues(randomBytes);
      const body = encodeBase64Url(randomBytes);
      secret = `${TOKEN_SECRET_PREFIX}${body}`;
      const verifier = await this.#deriveVerifier(secret);
      return new ConsumeOnceTokenSecret(secret, {
        format: "mdp_v1",
        algorithm: "hmac-sha256",
        verifierVersion: "v1",
        verifier,
        displayPrefix: `${TOKEN_SECRET_PREFIX}${body.slice(0, TOKEN_DISPLAY_RANDOM_CHARACTERS)}…`,
      });
    } catch {
      secret = "";
      throw new TokenSecurityFailure(
        "security_unavailable",
        "Token security operation is unavailable.",
      );
    } finally {
      randomBytes.fill(0);
    }
  }

  async verifySecret<Value>(
    candidate: unknown,
    lookup: TokenVerifierLookup<Value>,
  ): Promise<TokenVerificationResult<Value>> {
    const randomBytes = parseCanonicalSecret(candidate);
    if (randomBytes === null) return INVALID_RESULT;
    randomBytes.fill(0);

    let verifier: TokenVerifier;
    let calculatedBytes: Uint8Array;
    try {
      verifier = await this.#deriveVerifier(candidate as string);
      calculatedBytes = verifierBytes(verifier)!;
    } catch {
      throw new TokenSecurityFailure(
        "security_unavailable",
        "Token security operation is unavailable.",
      );
    }

    let lookupResult;
    try {
      lookupResult = await lookup.findByVerifier(verifier);
    } catch {
      calculatedBytes.fill(0);
      throw new TokenSecurityFailure(
        "verification_unavailable",
        "Token verification is unavailable.",
      );
    }

    const persistedBytes =
      lookupResult.kind === "found"
        ? verifierBytes(lookupResult.verifier)
        : null;
    const matches = constantTimeEqual32(
      calculatedBytes,
      persistedBytes ?? DUMMY_VERIFIER_BYTES,
    );
    calculatedBytes.fill(0);
    persistedBytes?.fill(0);

    if (lookupResult.kind !== "found" || !matches) return INVALID_RESULT;
    return Object.freeze({ kind: "verified", value: lookupResult.value });
  }

  async #deriveVerifier(secret: string): Promise<TokenVerifier> {
    const secretBytes = new TextEncoder().encode(secret);
    const message = new Uint8Array(HMAC_DOMAIN.length + secretBytes.length);
    message.set(HMAC_DOMAIN);
    message.set(secretBytes, HMAC_DOMAIN.length);
    try {
      const signature = await this.#crypto.subtle.sign("HMAC", this.#key, message);
      return `${TOKEN_VERIFIER_PREFIX}${bytesToHex(new Uint8Array(signature))}` as TokenVerifier;
    } finally {
      secretBytes.fill(0);
      message.fill(0);
    }
  }
}

export async function createWebCryptoTokenHasher(
  options: WebCryptoTokenHasherOptions,
): Promise<WebCryptoTokenHasher> {
  if (
    !(options.verifierKey instanceof Uint8Array) ||
    options.verifierKey.byteLength < TOKEN_VERIFIER_KEY_MINIMUM_BYTES
  ) {
    throw new TokenSecurityFailure(
      "invalid_configuration",
      "Token verifier key must contain at least 256 bits.",
    );
  }
  const crypto = options.crypto ?? globalThis.crypto;
  if (crypto?.subtle === undefined || typeof crypto.getRandomValues !== "function") {
    throw new TokenSecurityFailure(
      "invalid_configuration",
      "Web Crypto is required for token security.",
    );
  }

  const keyBytes = new Uint8Array(options.verifierKey);
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return new WebCryptoTokenHasher(crypto, key);
  } catch {
    throw new TokenSecurityFailure(
      "invalid_configuration",
      "Token verifier key could not be initialized.",
    );
  } finally {
    keyBytes.fill(0);
  }
}

export type SecurityAdapterContract = TokenHasher;
