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
export const REVISION_MANIFEST_FORMAT = "mind-diary-revision-manifest-v1" as const;

export type MarkdownMediaType = typeof MARKDOWN_MEDIA_TYPE;

export interface RevisionManifestEntry {
  readonly path: string;
  readonly sha256: Sha256Digest;
  readonly mediaType: MarkdownMediaType;
  readonly size: number;
}

export interface RevisionManifest {
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

function compareUnicodeScalarValues(left: string, right: string): number {
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
  entries: readonly RevisionManifestEntry[],
): Readonly<RevisionManifest> {
  const seen = new Set<string>();
  const normalized = entries.map((entry) => {
    const path = canonicalMarkdownPath(entry.path);
    if (seen.has(path)) {
      throw new RevisionEnvelopeError(
        "duplicate_path",
        `revision manifest contains duplicate path ${JSON.stringify(path)}`,
      );
    }
    seen.add(path);
    const digest = sha256Digest(entry.sha256);
    if (entry.mediaType !== MARKDOWN_MEDIA_TYPE) {
      throw new RevisionEnvelopeError(
        "invalid_media_type",
        `revision objects must use ${MARKDOWN_MEDIA_TYPE}`,
      );
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new RevisionEnvelopeError(
        "invalid_size",
        "revision object size must be a non-negative safe integer",
      );
    }
    return Object.freeze({
      path,
      sha256: digest,
      mediaType: MARKDOWN_MEDIA_TYPE,
      size: entry.size,
    });
  });
  normalized.sort((left, right) =>
    compareUnicodeScalarValues(left.path, right.path),
  );
  return Object.freeze({ entries: Object.freeze(normalized) });
}

export function serializeRevisionManifest(manifest: RevisionManifest): string {
  const canonical = createRevisionManifest(manifest.entries);
  return `${JSON.stringify({
    format: REVISION_MANIFEST_FORMAT,
    entries: canonical.entries.map((entry) => ({
      path: entry.path,
      sha256: entry.sha256,
      media_type: entry.mediaType,
      size: entry.size,
    })),
  })}\n`;
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
  const manifest = createRevisionManifest(input.manifest.entries);
  const revision: SpaceRevision = Object.freeze({
    revisionId: input.revisionId,
    spaceId: input.spaceId,
    revisionNumber: revisionNumber(input.revisionNumber),
    parentRevisionId: input.parentRevisionId,
    committedAt: utcInstant(input.committedAt),
    committedBy: Object.freeze({ ...input.committedBy }),
    manifestHash: sha256Digest(input.manifestHash),
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
