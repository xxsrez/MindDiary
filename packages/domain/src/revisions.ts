import type {
  RevisionId,
  Sha256Digest,
  SpaceId,
  UtcInstant,
} from "./ids.js";
import {
  revisionNumber,
  type RevisionAuthorReference,
  type RevisionNumber,
  type SpaceRevision,
} from "./records.js";

export const MARKDOWN_MEDIA_TYPE = "text/markdown; charset=utf-8" as const;
export const REVISION_MANIFEST_FORMAT_V1 = "mind-diary-revision-manifest-v1" as const;
export const REVISION_MANIFEST_FORMAT_V2 = "mind-diary-revision-manifest-v2" as const;
export const REVISION_MANIFEST_FORMAT_V3 = "mind-diary-revision-manifest-v3" as const;
export const REVISION_MANIFEST_FORMAT_V4 = "mind-diary-revision-manifest-v4" as const;
/** Delta-aware commits use v4; legacy builders may still explicitly retain v1/v2/v3. */
export const REVISION_MANIFEST_FORMAT = REVISION_MANIFEST_FORMAT_V4;

export const BUNDLE_FILE_MEDIA_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/zip",
] as const);

export type MarkdownMediaType = typeof MARKDOWN_MEDIA_TYPE;
/**
 * Canonical advisory media essence for an opaque BundleFile. Manifest v4 is
 * intentionally open-world; the frozen list above remains the legacy v2/v3
 * compatibility allowlist, not the current type universe.
 */
export type BundleFileMediaType = string;
export type CanonicalObjectMediaType = MarkdownMediaType | BundleFileMediaType;
export type RevisionManifestFormat =
  | typeof REVISION_MANIFEST_FORMAT_V1
  | typeof REVISION_MANIFEST_FORMAT_V2
  | typeof REVISION_MANIFEST_FORMAT_V3
  | typeof REVISION_MANIFEST_FORMAT_V4;

interface RevisionManifestEntryBase {
  readonly path: string;
  readonly sha256: Sha256Digest;
  readonly size: number;
}

export interface MarkdownRevisionManifestEntry extends RevisionManifestEntryBase {
  readonly kind: "markdown";
  readonly mediaType: MarkdownMediaType;
}

export interface OpaqueRevisionManifestEntry extends RevisionManifestEntryBase {
  readonly kind: "opaque";
  readonly mediaType: BundleFileMediaType;
}

export type RevisionManifestEntry =
  | MarkdownRevisionManifestEntry
  | OpaqueRevisionManifestEntry;

export type RevisionManifestEntryInput =
  | Omit<MarkdownRevisionManifestEntry, "kind"> & { readonly kind?: "markdown" }
  | OpaqueRevisionManifestEntry;

export interface RevisionManifest {
  readonly format: RevisionManifestFormat;
  readonly entries: readonly Readonly<RevisionManifestEntry>[];
}

export interface CanonicalRevisionEnvelope {
  readonly revision: Readonly<SpaceRevision>;
  readonly manifest: Readonly<RevisionManifest>;
}

export type RevisionEnvelopeErrorCode =
  | "invalid_digest"
  | "invalid_path"
  | "invalid_media_type"
  | "invalid_size"
  | "duplicate_path"
  | "invalid_utc_instant"
  | "invalid_revision_id"
  | "invalid_space_id"
  | "invalid_parent"
  | "invalid_summary";

export class RevisionEnvelopeError extends TypeError {
  readonly code: RevisionEnvelopeErrorCode;

  constructor(code: RevisionEnvelopeErrorCode, message: string) {
    super(message);
    this.name = "RevisionEnvelopeError";
    this.code = code;
  }
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const UTC_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const ENCODED_SEPARATOR = /%(?:2f|5c)/iu;
const UTF8_ENCODER = new TextEncoder();
const RESERVED_BUNDLE_ROOT = ".mind-diary";

export function sha256Digest(value: string): Sha256Digest {
  if (!SHA256_PATTERN.test(value)) {
    throw new RevisionEnvelopeError(
      "invalid_digest",
      "SHA-256 digests must use 'sha256:' plus 64 lowercase hexadecimal characters",
    );
  }
  return value as Sha256Digest;
}

export function utcInstant(value: string): UtcInstant {
  const match = UTC_INSTANT_PATTERN.exec(value);
  if (!match || !isCalendarUtc(match)) {
    throw new RevisionEnvelopeError(
      "invalid_utc_instant",
      "commit timestamps must be valid RFC 3339 UTC instants ending in Z",
    );
  }
  return value as UtcInstant;
}

function isCalendarUtc(match: RegExpExecArray): boolean {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1]!;
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function canonicalMarkdownPath(value: string): string {
  const segments = value.split("/");
  const invalid =
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    CONTROL_CHARACTER.test(value) ||
    ENCODED_SEPARATOR.test(value) ||
    containsUnpairedSurrogate(value) ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    ) ||
    !value.endsWith(".md");
  if (invalid) {
    throw new RevisionEnvelopeError(
      "invalid_path",
      `canonical revision path is invalid: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Canonical path for a versioned opaque file inside one Mind revision. */
export function canonicalBundleFilePath(value: string): string {
  const segments = value.split("/");
  const invalid =
    value.length === 0 ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    CONTROL_CHARACTER.test(value) ||
    ENCODED_SEPARATOR.test(value) ||
    containsUnpairedSurrogate(value) ||
    UTF8_ENCODER.encode(value).byteLength > 1_024 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        UTF8_ENCODER.encode(segment).byteLength > 255,
    ) ||
    segments[0] === RESERVED_BUNDLE_ROOT ||
    value.endsWith(".md");
  if (invalid) {
    throw new RevisionEnvelopeError(
      "invalid_path",
      `canonical BundleFile path is invalid: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function bundleFileMediaType(value: string): BundleFileMediaType {
  if (/[^\u0020-\u007e]/u.test(value)) return "application/octet-stream";
  const essence = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const token = "[!#$%&'*+.^_`|~0-9a-z-]+";
  const valid = essence.length <= 127 && new RegExp(`^${token}/${token}$`, "u").test(essence);
  return (valid ? essence : "application/octet-stream") as BundleFileMediaType;
}

function legacyBundleFileMediaType(value: string): BundleFileMediaType {
  if (!(BUNDLE_FILE_MEDIA_TYPES as readonly string[]).includes(value)) {
    throw new RevisionEnvelopeError(
      "invalid_media_type",
      `legacy BundleFile media type is not allowed: ${JSON.stringify(value)}`,
    );
  }
  return value as BundleFileMediaType;
}

export function compareUnicodeScalarValues(left: string, right: string): number {
  const leftPoints = [...left].map((value) => value.codePointAt(0)!);
  const rightPoints = [...right].map((value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

export function createRevisionManifest(
  entries: readonly RevisionManifestEntryInput[],
  format: RevisionManifestFormat = REVISION_MANIFEST_FORMAT_V2,
): Readonly<RevisionManifest> {
  if (
    format !== REVISION_MANIFEST_FORMAT_V1 &&
    format !== REVISION_MANIFEST_FORMAT_V2 &&
    format !== REVISION_MANIFEST_FORMAT_V3 &&
    format !== REVISION_MANIFEST_FORMAT_V4
  ) {
    throw new RevisionEnvelopeError("invalid_media_type", "revision manifest format is invalid");
  }
  const seen = new Set<string>();
  const normalized = entries.map((entry) => {
    const kind = entry.kind ?? "markdown";
    if (format === REVISION_MANIFEST_FORMAT_V1 && kind !== "markdown") {
      throw new RevisionEnvelopeError(
        "invalid_media_type",
        "revision manifest v1 supports Markdown entries only",
      );
    }
    const path = kind === "markdown"
      ? canonicalMarkdownPath(entry.path)
      : canonicalBundleFilePath(entry.path);
    if (seen.has(path)) {
      throw new RevisionEnvelopeError(
        "duplicate_path",
        `revision manifest contains duplicate path ${JSON.stringify(path)}`,
      );
    }
    seen.add(path);
    const digest = sha256Digest(entry.sha256);
    const mediaType = kind === "markdown"
      ? entry.mediaType === MARKDOWN_MEDIA_TYPE
        ? MARKDOWN_MEDIA_TYPE
        : (() => {
            throw new RevisionEnvelopeError(
              "invalid_media_type",
              `Markdown revision objects must use ${MARKDOWN_MEDIA_TYPE}`,
            );
          })()
      : format === REVISION_MANIFEST_FORMAT_V4
        ? bundleFileMediaType(entry.mediaType)
        : legacyBundleFileMediaType(entry.mediaType);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new RevisionEnvelopeError(
        "invalid_size",
        "revision object size must be a non-negative safe integer",
      );
    }
    return Object.freeze({
      kind,
      path,
      sha256: digest,
      mediaType,
      size: entry.size,
    }) as Readonly<RevisionManifestEntry>;
  });
  normalized.sort((left, right) =>
    compareUnicodeScalarValues(left.path, right.path),
  );
  return Object.freeze({ format, entries: Object.freeze(normalized) });
}

export function serializeRevisionManifest(manifest: RevisionManifest): string {
  const format = manifest.format ?? REVISION_MANIFEST_FORMAT_V1;
  const canonical = createRevisionManifest(manifest.entries, format);
  return `${JSON.stringify({
    format,
    entries: canonical.entries.map((entry) => ({
      path: entry.path,
      ...(format !== REVISION_MANIFEST_FORMAT_V1 ? { kind: entry.kind } : {}),
      sha256: entry.sha256,
      media_type: entry.mediaType,
      size: entry.size,
    })),
  })}\n`;
}

/** Strictly parses canonical v1/v2/v3/v4 manifest bytes and rejects non-canonical JSON. */
export function parseRevisionManifest(source: string): Readonly<RevisionManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new RevisionEnvelopeError("invalid_media_type", "revision manifest JSON is invalid");
  }
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
    !Object.hasOwn(parsed, "format") || !Object.hasOwn(parsed, "entries") ||
    Object.keys(parsed).length !== 2
  ) {
    throw new RevisionEnvelopeError("invalid_media_type", "revision manifest shape is invalid");
  }
  const value = parsed as { readonly format: unknown; readonly entries: unknown };
  if (
    value.format !== REVISION_MANIFEST_FORMAT_V1 &&
    value.format !== REVISION_MANIFEST_FORMAT_V2 &&
    value.format !== REVISION_MANIFEST_FORMAT_V3 &&
    value.format !== REVISION_MANIFEST_FORMAT_V4
  ) {
    throw new RevisionEnvelopeError("invalid_media_type", "revision manifest format is invalid");
  }
  if (!Array.isArray(value.entries)) {
    throw new RevisionEnvelopeError("invalid_media_type", "revision manifest entries are invalid");
  }
  const entries = value.entries.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new RevisionEnvelopeError("invalid_media_type", "revision manifest entry is invalid");
    }
    const entry = candidate as Record<string, unknown>;
    const expectedKeys = value.format === REVISION_MANIFEST_FORMAT_V1
      ? ["path", "sha256", "media_type", "size"]
      : ["path", "kind", "sha256", "media_type", "size"];
    if (
      Object.keys(entry).length !== expectedKeys.length ||
      !expectedKeys.every((key) => Object.hasOwn(entry, key)) ||
      typeof entry.path !== "string" || typeof entry.sha256 !== "string" ||
      typeof entry.media_type !== "string" || typeof entry.size !== "number" ||
      (value.format !== REVISION_MANIFEST_FORMAT_V1 &&
        entry.kind !== "markdown" && entry.kind !== "opaque")
    ) {
      throw new RevisionEnvelopeError("invalid_media_type", "revision manifest entry is invalid");
    }
    return {
      path: entry.path,
      kind: value.format === REVISION_MANIFEST_FORMAT_V1 ? "markdown" as const : entry.kind,
      sha256: entry.sha256,
      mediaType: entry.media_type,
      size: entry.size,
    } as RevisionManifestEntryInput;
  });
  const manifest = createRevisionManifest(entries, value.format);
  if (serializeRevisionManifest(manifest) !== source) {
    throw new RevisionEnvelopeError("invalid_media_type", "revision manifest is not canonical");
  }
  return manifest;
}

export interface CreateCanonicalRevisionEnvelopeInput {
  readonly revisionId: RevisionId;
  readonly spaceId: SpaceId;
  readonly revisionNumber: number | RevisionNumber;
  readonly parentRevisionId: RevisionId | null;
  readonly committedAt: UtcInstant | string;
  readonly committedBy: RevisionAuthorReference;
  readonly manifest: RevisionManifest;
  readonly manifestHash: Sha256Digest | string;
  readonly manifestSize?: number;
  readonly summary: string;
}

export function createCanonicalRevisionEnvelope(
  input: CreateCanonicalRevisionEnvelopeInput,
): Readonly<CanonicalRevisionEnvelope> {
  if (typeof input.revisionId !== "string" || input.revisionId.length === 0) {
    throw new RevisionEnvelopeError("invalid_revision_id", "revision ID is required");
  }
  if (typeof input.spaceId !== "string" || input.spaceId.length === 0) {
    throw new RevisionEnvelopeError("invalid_space_id", "space ID is required");
  }
  if (
    input.parentRevisionId !== null &&
    (typeof input.parentRevisionId !== "string" || input.parentRevisionId.length === 0)
  ) {
    throw new RevisionEnvelopeError("invalid_parent", "parent revision ID is invalid");
  }
  if (typeof input.summary !== "string") {
    throw new RevisionEnvelopeError("invalid_summary", "revision summary must be a string");
  }
  const manifest = createRevisionManifest(
    input.manifest.entries,
    input.manifest.format ?? REVISION_MANIFEST_FORMAT_V1,
  );
  const canonicalManifestSize = new TextEncoder().encode(
    serializeRevisionManifest(manifest),
  ).byteLength;
  if (
    (manifest.format === REVISION_MANIFEST_FORMAT_V3 ||
      manifest.format === REVISION_MANIFEST_FORMAT_V4) &&
    input.manifestSize !== canonicalManifestSize
  ) {
    throw new RevisionEnvelopeError(
      "invalid_size",
      "revision manifest v3/v4 requires its exact canonical byte size",
    );
  }
  const revision: SpaceRevision = Object.freeze({
    revisionId: input.revisionId,
    spaceId: input.spaceId,
    revisionNumber: revisionNumber(input.revisionNumber),
    parentRevisionId: input.parentRevisionId,
    committedAt: utcInstant(input.committedAt),
    committedBy: Object.freeze({ ...input.committedBy }),
    manifestHash: sha256Digest(input.manifestHash),
    ...(input.manifestSize === undefined
      ? {}
      : Number.isSafeInteger(input.manifestSize) && input.manifestSize >= 0
        ? { manifestSize: input.manifestSize }
        : (() => {
            throw new RevisionEnvelopeError("invalid_size", "revision manifest size is invalid");
          })()),
    summary: input.summary,
  });
  return Object.freeze({ revision, manifest });
}

export function revisionEnvelopesEqual(
  left: CanonicalRevisionEnvelope,
  right: CanonicalRevisionEnvelope,
): boolean {
  return (
    JSON.stringify(left.revision) === JSON.stringify(right.revision) &&
    serializeRevisionManifest(left.manifest) ===
      serializeRevisionManifest(right.manifest)
  );
}
