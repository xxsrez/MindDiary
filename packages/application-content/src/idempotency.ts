import { idempotencyKey, type IdempotencyKey } from "@mind-diary/domain";

export const DEFAULT_IDEMPOTENCY_KEY_MAX_BYTES = 256;

export type IdempotencyKeyValidationFailureReason =
  | "required"
  | "invalid_utf8"
  | "single_line_required"
  | "byte_limit_exceeded";

export type IdempotencyKeyValidationResult =
  | { readonly kind: "valid"; readonly key: IdempotencyKey }
  | {
      readonly kind: "invalid";
      readonly reason: IdempotencyKeyValidationFailureReason;
    };

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });
const SINGLE_LINE_FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}]/u;

export function normalizeIdempotencyKeyMaxBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      "idempotency key byte limit must be a positive safe integer",
    );
  }
  return value;
}

export function validateIdempotencyKey(
  value: unknown,
  maxBytes: number = DEFAULT_IDEMPOTENCY_KEY_MAX_BYTES,
): IdempotencyKeyValidationResult {
  const limit = normalizeIdempotencyKeyMaxBytes(maxBytes);
  if (typeof value !== "string" || value.length === 0) {
    return Object.freeze({ kind: "invalid", reason: "required" });
  }
  if (SINGLE_LINE_FORBIDDEN.test(value)) {
    return Object.freeze({
      kind: "invalid",
      reason: "single_line_required",
    });
  }
  const bytes = ENCODER.encode(value);
  try {
    if (DECODER.decode(bytes) !== value) {
      return Object.freeze({ kind: "invalid", reason: "invalid_utf8" });
    }
  } catch {
    return Object.freeze({ kind: "invalid", reason: "invalid_utf8" });
  }
  if (bytes.byteLength > limit) {
    return Object.freeze({
      kind: "invalid",
      reason: "byte_limit_exceeded",
    });
  }
  return Object.freeze({ kind: "valid", key: idempotencyKey(value) });
}
