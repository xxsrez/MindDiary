declare const canonicalSpaceHandleBrand: unique symbol;
declare const verifiedSpaceHostBrand: unique symbol;

export type CanonicalSpaceHandle = string & {
  readonly [canonicalSpaceHandleBrand]: "canonical-space-handle";
};

/** Trusted deployment host namespace, without scheme, path, query, or port. */
export type VerifiedSpaceHost = string & {
  readonly [verifiedSpaceHostBrand]: "verified-space-host";
};

export const RESERVED_TOP_LEVEL_HANDLES = Object.freeze([
  "me",
  "mcp",
  "api",
  "admin",
  "settings",
  "public",
  "assets",
  "www",
] as const);

export type HandlePolicyFailureReason =
  | "invalid_type"
  | "malformed_percent_encoding"
  | "encoded_separator"
  | "separator"
  | "dot_segment"
  | "control_character"
  | "invalid_grammar"
  | "non_canonical";

export type SpaceHandleNormalizationResult =
  | {
      readonly kind: "valid";
      readonly canonicalHandle: CanonicalSpaceHandle;
      readonly isCanonical: boolean;
    }
  | {
      readonly kind: "invalid";
      readonly reason: Exclude<HandlePolicyFailureReason, "non_canonical">;
    };

export type CanonicalSpaceHandleResult =
  | {
      readonly kind: "valid";
      readonly canonicalHandle: CanonicalSpaceHandle;
    }
  | {
      readonly kind: "invalid";
      readonly reason: HandlePolicyFailureReason;
    };

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const ENCODED_SEPARATOR = /%(?:2f|5c)/iu;
const CANONICAL_HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const VERIFIED_HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u;
const RESERVED = new Set<string>(RESERVED_TOP_LEVEL_HANDLES);

function invalidNormalization(
  reason: Exclude<HandlePolicyFailureReason, "non_canonical">,
): SpaceHandleNormalizationResult {
  return Object.freeze({ kind: "invalid", reason });
}

/**
 * Produces the canonical comparison candidate after exactly one percent decode
 * and Unicode NFKC normalization. It never lowercases or transliterates input.
 */
export function normalizeSpaceHandle(
  input: unknown,
): SpaceHandleNormalizationResult {
  if (typeof input !== "string") return invalidNormalization("invalid_type");
  if (CONTROL_CHARACTER.test(input)) {
    return invalidNormalization("control_character");
  }
  if (ENCODED_SEPARATOR.test(input)) {
    return invalidNormalization("encoded_separator");
  }
  if (input.includes("/") || input.includes("\\")) {
    return invalidNormalization("separator");
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    return invalidNormalization("malformed_percent_encoding");
  }

  const normalized = decoded.normalize("NFKC");
  if (CONTROL_CHARACTER.test(normalized)) {
    return invalidNormalization("control_character");
  }
  if (normalized.includes("/") || normalized.includes("\\")) {
    return invalidNormalization("separator");
  }
  if (normalized === "." || normalized === "..") {
    return invalidNormalization("dot_segment");
  }
  if (
    normalized.length < 3 ||
    normalized.length > 63 ||
    !CANONICAL_HANDLE.test(normalized)
  ) {
    return invalidNormalization("invalid_grammar");
  }

  return Object.freeze({
    kind: "valid",
    canonicalHandle: normalized as CanonicalSpaceHandle,
    isCanonical: input === normalized,
  });
}

/** Accepts only the exact lowercase ASCII URL representation stored by MVP 0.1. */
export function parseCanonicalSpaceHandle(
  input: unknown,
): CanonicalSpaceHandleResult {
  const normalized = normalizeSpaceHandle(input);
  if (normalized.kind === "invalid") return normalized;
  if (!normalized.isCanonical) {
    return Object.freeze({ kind: "invalid", reason: "non_canonical" });
  }
  return Object.freeze({
    kind: "valid",
    canonicalHandle: normalized.canonicalHandle,
  });
}

export function isReservedTopLevelHandle(
  handle: CanonicalSpaceHandle,
): boolean {
  return RESERVED.has(handle);
}

/** Exact route check used before handle grammar (notably for the two-char `/me`). */
export function isReservedTopLevelRoute(input: unknown): boolean {
  return typeof input === "string" && RESERVED.has(input);
}

export function verifiedSpaceHost(input: unknown): VerifiedSpaceHost {
  if (
    typeof input !== "string" ||
    input !== input.normalize("NFKC") ||
    input !== input.toLowerCase() ||
    CONTROL_CHARACTER.test(input) ||
    !VERIFIED_HOST.test(input)
  ) {
    throw new TypeError("verified Space host must be a canonical lowercase hostname");
  }
  return input as VerifiedSpaceHost;
}
