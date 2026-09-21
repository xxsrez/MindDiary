import { RE2JS } from "re2js";

import {
  ObjectStoreFailure,
  OBJECT_INTEGRITY_CHUNK_SIZE,
  OBJECT_INTEGRITY_PROOF_SCHEMA,
  objectIntegrityLeafInput,
  objectIntegrityNodeInput,
  type BundleFileObjectStore,
  type ObjectStore,
  type ObjectIntegrityRangeProof,
  type OpenedBundleFileObject,
  type OpenedSpaceCanonicalObject,
  type SpaceCanonicalObjectStore,
} from "@mind-diary/application-ports";

import {
  REVISION_MANIFEST_FORMAT_V3,
  REVISION_MANIFEST_FORMAT_V4,
  type CanonicalRevisionEnvelope,
  type RevisionId,
  type RevisionManifestEntry,
  type Sha256Digest,
  type SpaceId,
} from "@mind-diary/domain";

import type {
  MindDiscoveryDescriptor,
  MindDiscoveryRevisionDescriptor,
} from "./mind-discovery.js";
import { MindBrowseFailure } from "./mind-browse-failure.js";

export const DEFAULT_FILE_OPERATION_LIMIT = 20;
export const MAX_FILE_OPERATION_LIMIT = 100;
export const DEFAULT_FILE_OUTPUT_BYTE_BUDGET = 64 * 1024;
export const MAX_FILE_OUTPUT_BYTE_BUDGET = 1024 * 1024;
export const MAX_TEXT_BUNDLE_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_GREP_SCAN_BYTES = 32 * 1024 * 1024;
export const MAX_METADATA_SCAN_BYTES = 4 * 1024 * 1024;
export const MAX_FILE_SELECTOR_PATHS = 100;
export const MAX_READ_FILE_REQUESTS = 32;
export const FILE_OPERATION_WALL_CLOCK_BUDGET_MS = 15_000;

const MIN_OUTPUT_BYTE_BUDGET = 4;
const MAX_CURSOR_CHARACTERS = 8 * 1024;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const ENCODED_SEPARATOR = /%(?:2f|5c)/iu;

export type FileMetadataStatus =
  | "not_requested"
  | "available"
  | "unsupported"
  | "invalid";

export interface MindFileDescriptor {
  readonly path: string;
  readonly kind: "markdown" | "opaque";
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: Sha256Digest;
  readonly revisionId: RevisionId;
  readonly revisionCommittedAt: string;
  readonly metadataStatus: FileMetadataStatus;
  readonly metadata: Readonly<Record<string, unknown>> | null;
}

export interface ListFilesResult {
  readonly mind: Readonly<MindDiscoveryDescriptor>;
  readonly resolvedRevision: Readonly<MindDiscoveryRevisionDescriptor>;
  readonly files: readonly Readonly<MindFileDescriptor>[];
  readonly aggregate: Readonly<
    | { readonly kind: "none" }
    | { readonly kind: "count"; readonly count: number }
    | { readonly kind: "distinct"; readonly field: string; readonly values: readonly unknown[] }
  >;
  readonly scanned: Readonly<{ readonly files: number; readonly bytes: number }>;
  readonly returnedBytes: number;
  readonly incomplete: boolean;
  readonly incompleteReason: "page_limit" | "scan_budget" | "response_budget" | "time_budget" | null;
  readonly nextCursor: string | null;
}

export interface GrepMatchSpan {
  readonly patternIndex: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly startByte: number;
  readonly endByte: number;
}

export interface GrepLineMatch {
  readonly lineNumber: number;
  readonly startByte: number;
  readonly endByte: number;
  readonly text: string;
  readonly spans: readonly Readonly<GrepMatchSpan>[];
  readonly beforeContext: readonly string[];
  readonly afterContext: readonly string[];
}

export interface GrepFileResult {
  readonly path: string;
  readonly kind: "markdown" | "opaque";
  readonly mediaType: string;
  readonly sha256: Sha256Digest;
  readonly revisionId: RevisionId;
  readonly matchingLines: number;
  readonly occurrences: number;
  readonly count: number;
  readonly matches: readonly Readonly<GrepLineMatch>[];
}

export interface FileOperationItemError {
  readonly code:
    | "file_not_found"
    | "file_not_text"
    | "unsupported_text_encoding"
    | "file_scan_limit_exceeded"
    | "range_out_of_bounds"
    | "utf8_boundary_required";
  readonly retryable: false;
}

export interface GrepFilesResult {
  readonly mind: Readonly<MindDiscoveryDescriptor>;
  readonly resolvedRevision: Readonly<MindDiscoveryRevisionDescriptor>;
  readonly output: "matches" | "files_with_matches" | "files_without_match" | "count";
  readonly countUnit: "matching_lines" | "occurrences";
  readonly files: readonly Readonly<GrepFileResult>[];
  readonly errors: readonly Readonly<{ readonly path: string; readonly error: FileOperationItemError }>[];
  readonly scanned: Readonly<{ readonly files: number; readonly bytes: number }>;
  readonly returned: Readonly<{ readonly rows: number; readonly bytes: number }>;
  readonly incomplete: boolean;
  readonly incompleteReason: "page_limit" | "scan_budget" | "response_budget" | "time_budget" | null;
  readonly nextCursor: string | null;
}

export interface ReadFileResultItem {
  readonly path: string;
  readonly kind: "markdown" | "opaque";
  readonly mediaType: string;
  readonly sha256: Sha256Digest;
  readonly revisionId: RevisionId;
  readonly text: string;
  readonly byteRange: Readonly<{ readonly start: number; readonly end: number; readonly total: number }>;
  readonly lineRange: Readonly<{ readonly start: number; readonly end: number; readonly total: number | null }> | null;
  readonly truncated: boolean;
  readonly nextRange: Readonly<{ readonly startByte: number; readonly endByte: number }> | null;
}

export interface ReadFilesResult {
  readonly mind: Readonly<MindDiscoveryDescriptor>;
  readonly resolvedRevision: Readonly<MindDiscoveryRevisionDescriptor>;
  readonly items: readonly Readonly<
    | { readonly kind: "file"; readonly file: Readonly<ReadFileResultItem> }
    | { readonly kind: "error"; readonly path: string; readonly error: FileOperationItemError }
  >[];
  readonly returnedBytes: number;
  readonly incomplete: boolean;
  readonly incompleteReason: "response_budget" | "time_budget" | null;
  readonly nextCursor: string | null;
}

type FileKind = "markdown" | "opaque";

export interface NormalizedFileSelector {
  readonly paths: readonly string[] | null;
  readonly prefix: string;
  readonly recursive: boolean;
  readonly includeGlobs: readonly string[];
  readonly excludeGlobs: readonly string[];
  readonly kinds: readonly FileKind[];
  readonly mediaTypes: readonly string[];
}

export interface NormalizedListFilesRequest {
  readonly mind: unknown;
  readonly revisionSelector: unknown;
  readonly hasRevisionSelector: boolean;
  readonly selector: Readonly<NormalizedFileSelector>;
  readonly where: unknown;
  readonly selectMetadataFields: readonly string[];
  readonly sort: readonly Readonly<{ readonly field: string; readonly direction: "asc" | "desc" }>[];
  readonly aggregate: Readonly<
    | { readonly kind: "none" }
    | { readonly kind: "count" }
    | { readonly kind: "distinct"; readonly field: string }
  >;
  readonly cursor: string | null;
  readonly limit: number;
  readonly maxOutputBytes: number;
}

export interface NormalizedGrepFilesRequest {
  readonly mind: unknown;
  readonly revisionSelector: unknown;
  readonly hasRevisionSelector: boolean;
  readonly selector: Readonly<NormalizedFileSelector>;
  readonly patterns: readonly string[];
  readonly syntax: "literal" | "regex";
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly wholeLine: boolean;
  readonly output: "matches" | "files_with_matches" | "files_without_match" | "count";
  readonly countUnit: "matching_lines" | "occurrences";
  readonly beforeContext: number;
  readonly afterContext: number;
  readonly cursor: string | null;
  readonly limit: number;
  readonly maxOutputBytes: number;
}

export type NormalizedReadSelection = Readonly<
  | { readonly path: string; readonly mode: "whole" }
  | { readonly path: string; readonly mode: "head" | "tail"; readonly count: number }
  | { readonly path: string; readonly mode: "lines"; readonly startLine: number; readonly endLine: number }
  | { readonly path: string; readonly mode: "bytes"; readonly startByte: number; readonly endByte: number }
>;

export interface NormalizedReadFilesRequest {
  readonly mind: unknown;
  readonly revisionSelector: unknown;
  readonly hasRevisionSelector: boolean;
  readonly requests: readonly NormalizedReadSelection[];
  readonly cursor: string | null;
  readonly maxOutputBytes: number;
}

export interface ExactTextFile {
  readonly entry: Readonly<RevisionManifestEntry>;
  readonly bytes: Uint8Array;
  readonly text: string;
}

export interface TextLine {
  readonly text: string;
  readonly terminator: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly endWithTerminatorByte: number;
}

export class FileOperationBudgetExceeded extends Error {
  readonly reason: "aborted" | "deadline";

  constructor(reason: "aborted" | "deadline") {
    super(reason === "aborted" ? "File operation was aborted." : "File operation deadline was reached.");
    this.name = "FileOperationBudgetExceeded";
    this.reason = reason;
  }
}

export function fileOperationBudgetState(
  signal: AbortSignal | undefined,
  deadlineAt: number,
): "aborted" | "deadline" | null {
  if (signal?.aborted === true) return "aborted";
  return Date.now() >= deadlineAt ? "deadline" : null;
}

export function requireFileOperationBudget(signal: AbortSignal | undefined, deadlineAt: number): void {
  const state = fileOperationBudgetState(signal, deadlineAt);
  if (state !== null) throw new FileOperationBudgetExceeded(state);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

export function scalarCompare(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const compared = leftPoints[index]! - rightPoints[index]!;
    if (compared !== 0) return compared;
  }
  return leftPoints.length - rightPoints.length;
}

function normalizePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1_024 || CONTROL_CHARACTER.test(value) || ENCODED_SEPARATOR.test(value)) return null;
  let normalized = value.normalize("NFC");
  if (normalized === "/") return "";
  if (normalized.startsWith("/")) normalized = normalized.slice(1);
  if (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  if (normalized === "") return "";
  const segments = normalized.split("/");
  return segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ? null
    : normalized;
}

function validCanonicalFilePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024 &&
    value === value.normalize("NFC") && !value.startsWith("/") && !value.endsWith("/") &&
    !value.includes("\\") && !CONTROL_CHARACTER.test(value) && !ENCODED_SEPARATOR.test(value) &&
    !value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..");
}

function normalizeStringArray(
  value: unknown,
  options: { readonly maxItems: number; readonly maxCharacters: number; readonly path?: boolean },
): readonly string[] | null {
  if (!Array.isArray(value) || value.length > options.maxItems) return null;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > options.maxCharacters ||
      (options.path === true && !validCanonicalFilePath(item))) return null;
    if (!result.includes(item)) result.push(item);
  }
  return Object.freeze(result.sort(scalarCompare));
}

function globRegExp(glob: string): RegExp {
  if (glob.length === 0 || glob.length > 256 || glob !== glob.normalize("NFC") ||
    glob.includes("\\") || CONTROL_CHARACTER.test(glob) || /[\[\]{}]/u.test(glob)) {
    throw new MindBrowseFailure("invalid_glob", "File glob is invalid.");
  }
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]!;
    if (character === "*") {
      if (glob[index + 1] === "*") {
        if (glob[index + 2] === "/") { source += "(?:.*/)?"; index += 2; }
        else { source += ".*"; index += 1; }
      } else source += "[^/]*";
    } else if (character === "?") source += "[^/]";
    else source += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`${source}$`, "u");
}

function selectorKeys(): readonly string[] {
  return ["paths", "prefix", "recursive", "includeGlobs", "excludeGlobs", "kinds", "mediaTypes"];
}

function normalizeFileSelector(value: Readonly<Record<string, unknown>>): Readonly<NormalizedFileSelector> {
  if (value.recursive !== undefined && typeof value.recursive !== "boolean") {
    throw new MindBrowseFailure("invalid_file_operation", "File recursion flag is invalid.");
  }
  const paths = value.paths === undefined ? null : normalizeStringArray(value.paths, {
    maxItems: MAX_FILE_SELECTOR_PATHS, maxCharacters: 1_024, path: true,
  });
  if (value.paths !== undefined && (paths === null || paths.length === 0)) {
    throw new MindBrowseFailure("invalid_file_operation", "Exact file paths are invalid.");
  }
  const prefixValue = value.prefix ?? "";
  const prefix = prefixValue === "" ? "" : normalizePath(prefixValue);
  if (prefix === null) throw new MindBrowseFailure("invalid_file_operation", "File prefix is invalid.");
  const includeGlobs = value.includeGlobs === undefined ? [] : normalizeStringArray(value.includeGlobs, { maxItems: 32, maxCharacters: 256 });
  const excludeGlobs = value.excludeGlobs === undefined ? [] : normalizeStringArray(value.excludeGlobs, { maxItems: 32, maxCharacters: 256 });
  if (includeGlobs === null || excludeGlobs === null) throw new MindBrowseFailure("invalid_glob", "File glob list is invalid.");
  includeGlobs.forEach(globRegExp);
  excludeGlobs.forEach(globRegExp);
  const kindValues = value.kinds ?? ["markdown", "opaque"];
  if (!Array.isArray(kindValues) || kindValues.length === 0 || kindValues.length > 2 ||
    kindValues.some((kind) => kind !== "markdown" && kind !== "opaque")) {
    throw new MindBrowseFailure("invalid_file_operation", "File kinds are invalid.");
  }
  const mediaTypes = value.mediaTypes === undefined ? [] : normalizeStringArray(value.mediaTypes, { maxItems: 32, maxCharacters: 127 });
  if (mediaTypes === null) throw new MindBrowseFailure("invalid_file_operation", "File media types are invalid.");
  return Object.freeze({ paths, prefix, recursive: value.recursive === undefined || value.recursive === true,
    includeGlobs: Object.freeze(includeGlobs), excludeGlobs: Object.freeze(excludeGlobs),
    kinds: Object.freeze([...new Set(kindValues as FileKind[])]), mediaTypes: Object.freeze(mediaTypes) });
}

export function selectEntries(
  entries: readonly Readonly<RevisionManifestEntry>[], selector: Readonly<NormalizedFileSelector>,
): readonly Readonly<RevisionManifestEntry>[] {
  const exact = selector.paths === null ? null : new Set(selector.paths);
  const includes = selector.includeGlobs.map(globRegExp);
  const excludes = selector.excludeGlobs.map(globRegExp);
  const kinds = new Set(selector.kinds);
  const mediaTypes = new Set(selector.mediaTypes);
  const prefixWithSlash = selector.prefix === "" ? "" : `${selector.prefix}/`;
  return Object.freeze(entries.filter((entry) => {
    if (exact !== null && !exact.has(entry.path)) return false;
    if (!kinds.has(entry.kind) || (mediaTypes.size > 0 && !mediaTypes.has(entry.mediaType))) return false;
    if (selector.prefix !== "") {
      if (entry.path !== selector.prefix && !entry.path.startsWith(prefixWithSlash)) return false;
      if (!selector.recursive && (entry.path === selector.prefix ? "" : entry.path.slice(prefixWithSlash.length)).includes("/")) return false;
    } else if (!selector.recursive && entry.path.includes("/")) return false;
    return (includes.length === 0 || includes.some((pattern) => pattern.test(entry.path))) &&
      !excludes.some((pattern) => pattern.test(entry.path));
  }).sort((left, right) => scalarCompare(left.path, right.path)));
}

function normalizePageLimit(value: unknown): number {
  const limit = value ?? DEFAULT_FILE_OPERATION_LIMIT;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_FILE_OPERATION_LIMIT) {
    throw new MindBrowseFailure("invalid_limit", "File operation limit is invalid.");
  }
  return limit as number;
}

function normalizeOutputBudget(value: unknown): number {
  const budget = value ?? DEFAULT_FILE_OUTPUT_BYTE_BUDGET;
  if (!Number.isSafeInteger(budget) || (budget as number) < MIN_OUTPUT_BYTE_BUDGET ||
    (budget as number) > MAX_FILE_OUTPUT_BYTE_BUDGET) {
    throw new MindBrowseFailure("invalid_fetch_budget", "File output byte budget is invalid.");
  }
  return budget as number;
}

function normalizeCursor(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CURSOR_CHARACTERS) {
    throw new MindBrowseFailure("file_operation_cursor_invalid", "File operation cursor is invalid.");
  }
  return value;
}

function validMetadataField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u.test(value);
}

function validateMetadataFilter(value: unknown, depth = 0, leaves = { count: 0 }): void {
  if (!isRecord(value) || depth > 4) throw new MindBrowseFailure("invalid_metadata_filter", "Metadata filter is invalid.");
  if (Object.hasOwn(value, "all") || Object.hasOwn(value, "any")) {
    const key = Object.hasOwn(value, "all") ? "all" : "any";
    if (!hasExactKeys(value, [key]) || !Array.isArray(value[key]) || value[key].length === 0) {
      throw new MindBrowseFailure("invalid_metadata_filter", "Metadata filter is invalid.");
    }
    for (const item of value[key]) validateMetadataFilter(item, depth + 1, leaves);
    return;
  }
  const allowed = new Set(["field", "op", "value"]);
  if (!Object.keys(value).every((key) => allowed.has(key)) || !validMetadataField(value.field) ||
    !["exists", "eq", "in", "lt", "lte", "gt", "gte"].includes(String(value.op)) ||
    (value.op === "exists" ? Object.hasOwn(value, "value") : !Object.hasOwn(value, "value")) ||
    (value.op === "in" && (!Array.isArray(value.value) || value.value.length > 32))) {
    throw new MindBrowseFailure("invalid_metadata_filter", "Metadata filter is invalid.");
  }
  leaves.count += 1;
  if (leaves.count > 16) throw new MindBrowseFailure("invalid_metadata_filter", "Metadata filter is too complex.");
}

export function normalizeListFilesRequest(value: unknown): Readonly<NormalizedListFilesRequest> {
  if (!isRecord(value) || !Object.hasOwn(value, "mind")) throw new MindBrowseFailure("invalid_file_operation", "List files request is invalid.");
  const allowed = new Set(["mind", "revisionSelector", ...selectorKeys(), "where", "selectMetadataFields", "sort", "aggregate", "cursor", "limit", "maxOutputBytes"]);
  if (!Object.keys(value).every((key) => allowed.has(key))) throw new MindBrowseFailure("invalid_file_operation", "List files request is invalid.");
  if (value.where !== undefined) validateMetadataFilter(value.where);
  const selectMetadataFields = value.selectMetadataFields === undefined ? [] : normalizeStringArray(value.selectMetadataFields, { maxItems: 32, maxCharacters: 256 });
  if (selectMetadataFields === null || selectMetadataFields.some((field) => !validMetadataField(field))) throw new MindBrowseFailure("invalid_metadata_filter", "Metadata projection is invalid.");
  const sortValue = value.sort ?? [{ field: "path", direction: "asc" }];
  if (!Array.isArray(sortValue) || sortValue.length === 0 || sortValue.length > 3 || sortValue.some((item) =>
    !isRecord(item) || !hasExactKeys(item, ["field", "direction"]) || !validMetadataField(item.field) ||
    (item.direction !== "asc" && item.direction !== "desc"))) throw new MindBrowseFailure("invalid_sort", "File sort is invalid.");
  let aggregate: NormalizedListFilesRequest["aggregate"] = Object.freeze({ kind: "none" });
  if (value.aggregate !== undefined) {
    if (!isRecord(value.aggregate)) throw new MindBrowseFailure("invalid_file_operation", "File aggregate is invalid.");
    if (value.aggregate.kind === "count" && hasExactKeys(value.aggregate, ["kind"])) aggregate = Object.freeze({ kind: "count" });
    else if (value.aggregate.kind === "distinct" && hasExactKeys(value.aggregate, ["kind", "field"]) && validMetadataField(value.aggregate.field)) aggregate = Object.freeze({ kind: "distinct", field: value.aggregate.field });
    else throw new MindBrowseFailure("invalid_file_operation", "File aggregate is invalid.");
  }
  return Object.freeze({ mind: value.mind, revisionSelector: value.revisionSelector,
    hasRevisionSelector: Object.hasOwn(value, "revisionSelector"), selector: normalizeFileSelector(value),
    where: value.where, selectMetadataFields: Object.freeze(selectMetadataFields),
    sort: Object.freeze((sortValue as ReadonlyArray<Record<string, unknown>>).map((item) => Object.freeze({ field: item.field as string, direction: item.direction as "asc" | "desc" }))),
    aggregate, cursor: normalizeCursor(value.cursor), limit: normalizePageLimit(value.limit),
    maxOutputBytes: normalizeOutputBudget(value.maxOutputBytes) });
}

function unsupportedRegex(pattern: string): boolean {
  return pattern.length === 0 || pattern.length > 256 || CONTROL_CHARACTER.test(pattern) || /\\[1-9]|\(\?|\(\*|\\C/u.test(pattern);
}

export function normalizeGrepFilesRequest(value: unknown): Readonly<NormalizedGrepFilesRequest> {
  if (!isRecord(value) || !Object.hasOwn(value, "mind") || !Array.isArray(value.patterns)) throw new MindBrowseFailure("invalid_file_operation", "Grep files request is invalid.");
  const allowed = new Set(["mind", "revisionSelector", ...selectorKeys(), "patterns", "syntax", "caseSensitive", "wholeWord", "wholeLine", "output", "countUnit", "beforeContext", "afterContext", "cursor", "limit", "maxOutputBytes"]);
  if (!Object.keys(value).every((key) => allowed.has(key))) throw new MindBrowseFailure("invalid_file_operation", "Grep files request is invalid.");
  for (const key of ["caseSensitive", "wholeWord", "wholeLine"] as const) if (value[key] !== undefined && typeof value[key] !== "boolean") throw new MindBrowseFailure("invalid_file_operation", "Grep boolean option is invalid.");
  if (value.patterns.length < 1 || value.patterns.length > 8 || value.patterns.some((pattern) =>
    typeof pattern !== "string" || pattern.length === 0 || pattern.length > 256 || CONTROL_CHARACTER.test(pattern)
  )) throw new MindBrowseFailure("unsupported_pattern", "Grep pattern is unsupported.");
  const syntax = value.syntax ?? "literal";
  if (syntax !== "literal" && syntax !== "regex") throw new MindBrowseFailure("unsupported_pattern", "Grep syntax is unsupported.");
  if (syntax === "regex") for (const pattern of value.patterns as string[]) {
    if (unsupportedRegex(pattern)) throw new MindBrowseFailure("unsupported_pattern", "Grep pattern is unsupported.");
    try { RE2JS.compile(pattern); } catch { throw new MindBrowseFailure("unsupported_pattern", "Grep pattern is unsupported."); }
  }
  const output = value.output ?? "matches";
  if (!["matches", "files_with_matches", "files_without_match", "count"].includes(String(output))) throw new MindBrowseFailure("invalid_file_operation", "Grep output mode is invalid.");
  const countUnit = value.countUnit ?? "matching_lines";
  if (countUnit !== "matching_lines" && countUnit !== "occurrences") throw new MindBrowseFailure("invalid_file_operation", "Grep count unit is invalid.");
  const beforeContext = value.beforeContext ?? 0, afterContext = value.afterContext ?? 0;
  if (!Number.isSafeInteger(beforeContext) || !Number.isSafeInteger(afterContext) || (beforeContext as number) < 0 || (beforeContext as number) > 3 || (afterContext as number) < 0 || (afterContext as number) > 3) throw new MindBrowseFailure("invalid_file_operation", "Grep context is invalid.");
  return Object.freeze({ mind: value.mind, revisionSelector: value.revisionSelector,
    hasRevisionSelector: Object.hasOwn(value, "revisionSelector"), selector: normalizeFileSelector(value),
    patterns: Object.freeze([...(value.patterns as string[])]), syntax,
    caseSensitive: value.caseSensitive === undefined || value.caseSensitive === true,
    wholeWord: value.wholeWord === true, wholeLine: value.wholeLine === true,
    output: output as NormalizedGrepFilesRequest["output"], countUnit,
    beforeContext: beforeContext as number, afterContext: afterContext as number,
    cursor: normalizeCursor(value.cursor), limit: normalizePageLimit(value.limit),
    maxOutputBytes: normalizeOutputBudget(value.maxOutputBytes) });
}

function normalizeReadSelection(value: unknown): NormalizedReadSelection {
  if (!isRecord(value) || !validCanonicalFilePath(value.path) || typeof value.mode !== "string") throw new MindBrowseFailure("invalid_file_operation", "Read file selection is invalid.");
  if (value.mode === "whole" && hasExactKeys(value, ["path", "mode"])) return Object.freeze({ path: value.path, mode: "whole" });
  if ((value.mode === "head" || value.mode === "tail") && hasExactKeys(value, ["path", "mode", "count"]) && Number.isSafeInteger(value.count) && (value.count as number) >= 1 && (value.count as number) <= 100_000) return Object.freeze({ path: value.path, mode: value.mode, count: value.count as number });
  if (value.mode === "lines" && hasExactKeys(value, ["path", "mode", "startLine", "endLine"]) && Number.isSafeInteger(value.startLine) && Number.isSafeInteger(value.endLine) && (value.startLine as number) >= 1 && (value.endLine as number) >= (value.startLine as number)) return Object.freeze({ path: value.path, mode: "lines", startLine: value.startLine as number, endLine: value.endLine as number });
  if (value.mode === "bytes" && hasExactKeys(value, ["path", "mode", "startByte", "endByte"]) && Number.isSafeInteger(value.startByte) && Number.isSafeInteger(value.endByte) && (value.startByte as number) >= 0 && (value.endByte as number) > (value.startByte as number)) return Object.freeze({ path: value.path, mode: "bytes", startByte: value.startByte as number, endByte: value.endByte as number });
  throw new MindBrowseFailure("invalid_file_operation", "Read file selection is invalid.");
}

export function normalizeReadFilesRequest(value: unknown): Readonly<NormalizedReadFilesRequest> {
  if (!isRecord(value) || !Object.hasOwn(value, "mind") || !Array.isArray(value.requests) ||
    Object.keys(value).some((key) => !["mind", "revisionSelector", "requests", "cursor", "maxOutputBytes"].includes(key)) ||
    value.requests.length < 1 || value.requests.length > MAX_READ_FILE_REQUESTS) throw new MindBrowseFailure("invalid_file_operation", "Read files request is invalid.");
  const requests = Object.freeze(value.requests.map(normalizeReadSelection));
  const duplicate = new Set<string>();
  for (const request of requests) {
    const key = JSON.stringify(request);
    if (duplicate.has(key)) throw new MindBrowseFailure("invalid_file_operation", "Duplicate read selection is invalid.");
    duplicate.add(key);
  }
  return Object.freeze({ mind: value.mind, revisionSelector: value.revisionSelector,
    hasRevisionSelector: Object.hasOwn(value, "revisionSelector"), requests,
    cursor: normalizeCursor(value.cursor), maxOutputBytes: normalizeOutputBudget(value.maxOutputBytes) });
}

export function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith("text/") || mediaType === "application/json" || mediaType === "application/yaml" ||
    mediaType === "application/x-yaml" || mediaType === "application/x-ndjson" ||
    mediaType === "application/xml" || mediaType.endsWith("+json") || mediaType.endsWith("+xml");
}

export function splitTextLines(text: string): readonly Readonly<TextLine>[] {
  if (text.length === 0) return Object.freeze([]);
  const lines: TextLine[] = [];
  let characterStart = 0, byteStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character !== "\n" && character !== "\r") continue;
    const terminator = character === "\r" && text[index + 1] === "\n" ? "\r\n" : character;
    const body = text.slice(characterStart, index), bodyBytes = new TextEncoder().encode(body).byteLength;
    lines.push(Object.freeze({ text: body, terminator, startByte: byteStart, endByte: byteStart + bodyBytes, endWithTerminatorByte: byteStart + bodyBytes + terminator.length }));
    index += terminator.length - 1; characterStart = index + 1; byteStart += bodyBytes + terminator.length;
  }
  if (characterStart < text.length) {
    const body = text.slice(characterStart), bytes = new TextEncoder().encode(body).byteLength;
    lines.push(Object.freeze({ text: body, terminator: "", startByte: byteStart, endByte: byteStart + bytes, endWithTerminatorByte: byteStart + bytes }));
  }
  return Object.freeze(lines);
}

function joinedBytes(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const joined = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return joined;
}

export function headEndByte(bytes: Uint8Array, lineCount: number, complete: boolean): number | null {
  let lines = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 0x0a) {
      if (index > 0 && bytes[index - 1] === 0x0d) continue;
      if (++lines === lineCount) return index + 1;
    } else if (bytes[index] === 0x0d) {
      if (index + 1 === bytes.byteLength && !complete) return null;
      if (++lines === lineCount) return bytes[index + 1] === 0x0a ? index + 2 : index + 1;
    }
  }
  return complete ? bytes.byteLength : null;
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  deadlineAt: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  requireFileOperationBudget(signal, deadlineAt);
  const remaining = Math.max(1, deadlineAt - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const budget = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new FileOperationBudgetExceeded("deadline")), remaining);
    if (signal !== undefined) {
      abortListener = () => reject(new FileOperationBudgetExceeded("aborted"));
      signal.addEventListener("abort", abortListener, { once: true });
    }
  });
  try {
    return await Promise.race([reader.read(), budget]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal !== undefined && abortListener !== undefined) signal.removeEventListener("abort", abortListener);
  }
}

export async function readHeadBytes(
  body: ReadableStream<Uint8Array>,
  expectedSize: number,
  lineCount: number,
  signal?: AbortSignal,
  deadlineAt = Date.now() + FILE_OPERATION_WALL_CLOCK_BUDGET_MS,
): Promise<Readonly<{ bytes: Uint8Array; complete: boolean }>> {
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await readStreamChunk(reader, signal, deadlineAt);
      if (next.done) {
        if (size !== expectedSize) throw new Error("stream size mismatch");
        const bytes = joinedBytes(chunks, size);
        return Object.freeze({ bytes: bytes.slice(0, headEndByte(bytes, lineCount, true)!), complete: true });
      }
      if (!(next.value instanceof Uint8Array)) throw new Error("invalid stream chunk");
      chunks.push(new Uint8Array(next.value)); size += next.value.byteLength;
      if (size > expectedSize) throw new Error("stream size mismatch");
      const bytes = joinedBytes(chunks, size), end = headEndByte(bytes, lineCount, size === expectedSize);
      if (end !== null) {
        if (size !== expectedSize) await reader.cancel("bounded head complete");
        return Object.freeze({ bytes: bytes.slice(0, end), complete: end === expectedSize });
      }
    }
  } catch (error) {
    await reader.cancel("file operation interrupted").catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}

async function readExactStreamBytes(
  body: ReadableStream<Uint8Array>,
  expectedSize: number,
  signal: AbortSignal | undefined,
  deadlineAt: number,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await readStreamChunk(reader, signal, deadlineAt);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new Error("invalid stream chunk");
      size += next.value.byteLength;
      if (size > expectedSize) throw new Error("stream size mismatch");
      chunks.push(new Uint8Array(next.value));
    }
    if (size !== expectedSize) throw new Error("stream size mismatch");
    return joinedBytes(chunks, size);
  } catch (error) {
    await reader.cancel("file operation interrupted").catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

const OBJECT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function revisionIntegrityFailure(): MindBrowseFailure {
  return new MindBrowseFailure(
    "revision_integrity_failure",
    "The exact revision file failed integrity verification.",
  );
}

function integrityProofKind(entry: Readonly<RevisionManifestEntry>): "markdown" | "bundle_file" {
  return entry.kind === "markdown" ? "markdown" : "bundle_file";
}

async function verifyObjectIntegrityRange(
  objects: ObjectStore,
  proof: Readonly<ObjectIntegrityRangeProof>,
  body: Uint8Array,
  openedRange: Readonly<{ readonly offset: number; readonly length: number }> | undefined,
  spaceId: SpaceId,
  entry: Readonly<RevisionManifestEntry>,
  requested: Readonly<{ readonly offset: number; readonly length: number }>,
): Promise<void> {
  const fail = (): never => { throw revisionIntegrityFailure(); };
  if (
    proof.schema !== OBJECT_INTEGRITY_PROOF_SCHEMA ||
    proof.spaceId !== spaceId ||
    proof.kind !== integrityProofKind(entry) ||
    proof.size !== entry.size ||
    proof.sha256 !== entry.sha256 ||
    proof.chunkSize !== OBJECT_INTEGRITY_CHUNK_SIZE ||
    !Number.isSafeInteger(proof.chunkCount) ||
    proof.chunkCount !== Math.ceil(entry.size / OBJECT_INTEGRITY_CHUNK_SIZE) ||
    !OBJECT_DIGEST_PATTERN.test(proof.root) ||
    proof.chunks.length === 0
  ) fail();
  if (
    openedRange === undefined ||
    !Number.isSafeInteger(openedRange.offset) ||
    !Number.isSafeInteger(openedRange.length) ||
    openedRange.offset < 0 ||
    openedRange.length < 1 ||
    openedRange.offset % proof.chunkSize !== 0 ||
    openedRange.offset > requested.offset ||
    openedRange.offset + openedRange.length < requested.offset + requested.length ||
    openedRange.offset + openedRange.length > proof.size ||
    openedRange.length !== body.byteLength
  ) fail();
  const range = openedRange!;
  const expectedRangeOffset = Math.floor(requested.offset / proof.chunkSize) * proof.chunkSize;
  const expectedRangeEnd = Math.min(
    proof.size,
    Math.ceil((requested.offset + requested.length) / proof.chunkSize) * proof.chunkSize,
  );
  if (range.offset !== expectedRangeOffset || range.length !== expectedRangeEnd - expectedRangeOffset) fail();
  const first = Math.floor(requested.offset / proof.chunkSize);
  const last = Math.floor((requested.offset + requested.length - 1) / proof.chunkSize);
  const expectedChunkCount = last - first + 1;
  if (proof.chunks.length !== expectedChunkCount) fail();
  const encoder = new TextEncoder();
  const proofBase = {
    schema: proof.schema,
    spaceId: proof.spaceId,
    kind: proof.kind,
    size: proof.size,
    sha256: proof.sha256,
    chunkSize: proof.chunkSize,
  } as const;
  for (let ordinal = 0; ordinal < proof.chunks.length; ordinal += 1) {
    const chunk = proof.chunks[ordinal]!;
    const index = first + ordinal;
    const offset = index * proof.chunkSize;
    const length = Math.min(proof.chunkSize, proof.size - offset);
    if (
      chunk.index !== index ||
      chunk.offset !== offset ||
      chunk.length !== length ||
      !OBJECT_DIGEST_PATTERN.test(chunk.sha256) ||
      chunk.offset < range.offset ||
      chunk.offset + chunk.length > range.offset + range.length
    ) fail();
    const chunkBytes = body.slice(chunk.offset - range.offset, chunk.offset - range.offset + chunk.length);
    if (chunkBytes.byteLength !== chunk.length || await objects.calculateSha256(chunkBytes) !== chunk.sha256) fail();
    let derived = await objects.calculateSha256(encoder.encode(objectIntegrityLeafInput(
      proofBase,
      chunk.index,
      chunk.offset,
      chunk.length,
      chunk.sha256,
    )));
    let position = chunk.index;
    let levelCount = proof.chunkCount;
    let siblingOffset = 0;
    while (levelCount > 1) {
      const sibling = chunk.siblings[siblingOffset];
      if (sibling === undefined || !OBJECT_DIGEST_PATTERN.test(sibling)) fail();
      const siblingDigest = sibling as Sha256Digest;
      derived = await objects.calculateSha256(encoder.encode(
        position % 2 === 0
          ? objectIntegrityNodeInput(derived, siblingDigest)
          : objectIntegrityNodeInput(siblingDigest, derived),
      ));
      position = Math.floor(position / 2);
      levelCount = Math.ceil(levelCount / 2);
      siblingOffset += 1;
    }
    if (siblingOffset !== chunk.siblings.length || derived !== proof.root) fail();
  }
}

type LoadedTextFile = Readonly<
  | { readonly kind: "file"; readonly file: Readonly<ExactTextFile> }
  | { readonly kind: "error"; readonly error: FileOperationItemError }
>;

type LoadedRange = Readonly<LoadedTextFile & {
  readonly legacy: boolean;
  readonly verifiedFull?: LoadedTextFile;
}>;

async function verifyFullTextFile(
  objects: ObjectStore,
  entry: Readonly<RevisionManifestEntry>,
  loaded: LoadedTextFile,
): Promise<LoadedTextFile> {
  if (loaded.kind === "error") return loaded;
  const bytes = loaded.file.bytes;
  if (bytes.byteLength !== entry.size || await objects.calculateSha256(bytes) !== entry.sha256) {
    throw revisionIntegrityFailure();
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw revisionIntegrityFailure();
  }
  return Object.freeze({
    kind: "file",
    file: Object.freeze({ entry, bytes: new Uint8Array(bytes), text }),
  });
}

async function loadTextFileRangeInternal(
  objects: ObjectStore,
  spaceId: SpaceId,
  manifestFormat: CanonicalRevisionEnvelope["manifest"]["format"],
  entry: Readonly<RevisionManifestEntry>,
  start: number,
  end: number,
  signal: AbortSignal | undefined,
  deadlineAt: number,
  loadFull: () => Promise<LoadedTextFile>,
): Promise<LoadedRange> {
  if (
    !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
    start < 0 || end <= start || end > entry.size
  ) throw new TypeError("text file range is invalid");
  if (entry.kind === "opaque" && !isTextMediaType(entry.mediaType)) {
    return Object.freeze({ kind: "error", error: Object.freeze({ code: "file_not_text", retryable: false }), legacy: false });
  }
  if (entry.kind === "opaque" && entry.size > MAX_TEXT_BUNDLE_FILE_BYTES) {
    return Object.freeze({ kind: "error", error: Object.freeze({ code: "file_scan_limit_exceeded", retryable: false }), legacy: false });
  }
  const length = end - start;
  let opened: Readonly<OpenedBundleFileObject | OpenedSpaceCanonicalObject> | null = null;
  try {
    if (
      entry.kind === "markdown" &&
      (manifestFormat === REVISION_MANIFEST_FORMAT_V3 || manifestFormat === REVISION_MANIFEST_FORMAT_V4) &&
      "openSpaceCanonicalObjectRange" in objects &&
      typeof (objects as unknown as SpaceCanonicalObjectStore).openSpaceCanonicalObjectRange === "function"
    ) {
      opened = await (objects as unknown as SpaceCanonicalObjectStore).openSpaceCanonicalObjectRange!(
        "markdown", spaceId, entry.sha256, { offset: start, length },
      );
    } else if (
      entry.kind === "opaque" &&
      "openBundleFileRange" in objects &&
      typeof (objects as BundleFileObjectStore).openBundleFileRange === "function"
    ) {
      opened = await (objects as BundleFileObjectStore).openBundleFileRange!(
        spaceId, entry.sha256, { offset: start, length },
      );
    }
  } catch (error) {
    if (error instanceof ObjectStoreFailure && error.code === "range_unavailable") {
      opened = null;
    } else if (error instanceof ObjectStoreFailure) {
      throw revisionIntegrityFailure();
    } else {
      throw error;
    }
  }
  if (opened === null || opened.integrityProof === undefined) {
    if (opened !== null) await opened.body.cancel("legacy full-read fallback").catch(() => undefined);
    const loaded = await verifyFullTextFile(objects, entry, await loadFull());
    if (loaded.kind === "error") return Object.freeze({ ...loaded, legacy: true, verifiedFull: loaded });
    const bytes = loaded.file.bytes.slice(start, end);
    return Object.freeze({
      kind: "file",
      file: Object.freeze({ entry, bytes, text: new TextDecoder("utf-8").decode(bytes) }),
      legacy: true,
      verifiedFull: loaded,
    });
  }
  if (
    opened.sha256 !== entry.sha256 || opened.size !== entry.size ||
    opened.mediaType !== entry.mediaType || opened.range === undefined
  ) {
    await opened.body.cancel("metadata mismatch").catch(() => undefined);
    throw revisionIntegrityFailure();
  }
  try {
    const bodyLength = opened.range.length;
    const body = await readExactStreamBytes(opened.body, bodyLength, signal, deadlineAt);
    await verifyObjectIntegrityRange(objects, opened.integrityProof, body, opened.range, spaceId, entry, { offset: start, length });
    const bytes = body.slice(start - opened.range.offset, start - opened.range.offset + length);
    return Object.freeze({
      kind: "file",
      file: Object.freeze({ entry, bytes, text: new TextDecoder("utf-8").decode(bytes) }),
      legacy: false,
    });
  } catch (error) {
    if (error instanceof FileOperationBudgetExceeded) {
      throw new MindBrowseFailure(
        "file_operation_budget_exhausted",
        error.reason === "aborted" ? "File operation was aborted." : "File operation deadline was reached.",
        true,
      );
    }
    if (error instanceof MindBrowseFailure) throw error;
    throw revisionIntegrityFailure();
  }
}

export async function loadTextFileRange(
  objects: ObjectStore,
  spaceId: SpaceId,
  manifestFormat: CanonicalRevisionEnvelope["manifest"]["format"],
  entry: Readonly<RevisionManifestEntry>,
  start: number,
  end: number,
  signal: AbortSignal | undefined,
  deadlineAt: number,
  loadFull: () => Promise<Readonly<
    | { readonly kind: "file"; readonly file: Readonly<ExactTextFile> }
    | { readonly kind: "error"; readonly error: FileOperationItemError }
  >>,
): Promise<Readonly<
  | { readonly kind: "file"; readonly file: Readonly<ExactTextFile> }
  | { readonly kind: "error"; readonly error: FileOperationItemError }
>> {
  const loaded = await loadTextFileRangeInternal(
    objects, spaceId, manifestFormat, entry, start, end, signal, deadlineAt, loadFull,
  );
  if (loaded.kind === "error") return Object.freeze({ kind: "error", error: loaded.error });
  return Object.freeze({ kind: "file", file: loaded.file });
}

export async function loadTextFileHead(
  objects: ObjectStore,
  spaceId: SpaceId,
  manifestFormat: CanonicalRevisionEnvelope["manifest"]["format"],
  entry: Readonly<RevisionManifestEntry>,
  lineCount: number,
  signal: AbortSignal | undefined,
  deadlineAt: number,
  loadFull: () => Promise<Readonly<
    | { readonly kind: "file"; readonly file: Readonly<ExactTextFile> }
    | { readonly kind: "error"; readonly error: FileOperationItemError }
  >>,
): Promise<Readonly<
  | { readonly kind: "file"; readonly file: Readonly<ExactTextFile>; readonly complete: boolean }
  | { readonly kind: "error"; readonly error: FileOperationItemError }
>> {
  if (entry.kind === "opaque" && !isTextMediaType(entry.mediaType)) {
    return Object.freeze({ kind: "error", error: Object.freeze({ code: "file_not_text", retryable: false }) });
  }
  if (entry.size > MAX_TEXT_BUNDLE_FILE_BYTES) {
    return Object.freeze({ kind: "error", error: Object.freeze({ code: "file_scan_limit_exceeded", retryable: false }) });
  }
  const selectedHead = (verifiedBytes: Uint8Array, end: number) => {
    const bytes = end === verifiedBytes.byteLength
      ? verifiedBytes
      : verifiedBytes.slice(0, end);
    return Object.freeze({
      kind: "file" as const,
      file: Object.freeze({
        entry,
        bytes,
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      }),
      complete: end === entry.size,
    });
  };
  const selectVerifiedHead = (loaded: LoadedTextFile) => {
    if (loaded.kind === "error") return loaded;
    const end = headEndByte(loaded.file.bytes, lineCount, true)!;
    return selectedHead(loaded.file.bytes, end);
  };
  const loadVerifiedFull = async (): Promise<LoadedTextFile> => {
    let opened: Readonly<OpenedBundleFileObject | OpenedSpaceCanonicalObject> | null = null;
    try {
      if (
        entry.kind === "markdown" &&
        (manifestFormat === REVISION_MANIFEST_FORMAT_V3 || manifestFormat === REVISION_MANIFEST_FORMAT_V4) &&
        "openSpaceCanonicalObject" in objects &&
        typeof (objects as unknown as SpaceCanonicalObjectStore).openSpaceCanonicalObject === "function"
      ) {
        opened = await (objects as unknown as SpaceCanonicalObjectStore).openSpaceCanonicalObject!(
          "markdown", spaceId, entry.sha256,
        );
      } else if (
        entry.kind === "opaque" &&
        "openBundleFile" in objects &&
        typeof (objects as BundleFileObjectStore).openBundleFile === "function"
      ) {
        opened = await (objects as BundleFileObjectStore).openBundleFile(spaceId, entry.sha256);
      }
    } catch (error) {
      if (error instanceof ObjectStoreFailure) throw revisionIntegrityFailure();
      throw error;
    }
    if (opened === null) {
      return verifyFullTextFile(objects, entry, await loadFull());
    }
    if (
      opened.sha256 !== entry.sha256 || opened.mediaType !== entry.mediaType ||
      opened.size !== entry.size
    ) {
      await opened.body.cancel("metadata mismatch").catch(() => undefined);
      throw revisionIntegrityFailure();
    }
    try {
      const bytes = await readExactStreamBytes(opened.body, entry.size, signal, deadlineAt);
      return verifyFullTextFile(objects, entry, Object.freeze({
        kind: "file",
        file: Object.freeze({ entry, bytes, text: "" }),
      }));
    } catch (error) {
      if (error instanceof FileOperationBudgetExceeded) {
        throw new MindBrowseFailure(
          "file_operation_budget_exhausted",
          error.reason === "aborted" ? "File operation was aborted." : "File operation deadline was reached.",
          true,
        );
      }
      if (error instanceof MindBrowseFailure) throw error;
      throw revisionIntegrityFailure();
    }
  };
  if (entry.size === 0) {
    return selectVerifiedHead(await loadVerifiedFull());
  }

  const hasAuthenticatedRange = entry.kind === "markdown"
    ? (manifestFormat === REVISION_MANIFEST_FORMAT_V3 || manifestFormat === REVISION_MANIFEST_FORMAT_V4) &&
      "openSpaceCanonicalObjectRange" in objects &&
      typeof (objects as unknown as SpaceCanonicalObjectStore).openSpaceCanonicalObjectRange === "function"
    : "openBundleFileRange" in objects &&
      typeof (objects as BundleFileObjectStore).openBundleFileRange === "function";
  if (!hasAuthenticatedRange) return selectVerifiedHead(await loadVerifiedFull());

  // A bounded head must authenticate every byte it returns. Read forward in
  // proof-sized ranges instead of trusting a prefix of the full-object stream;
  // a legacy store falls back to one full digest verification.
  const chunks: Uint8Array[] = [];
  let accumulated = 0;
  let lines = 0;
  let previousWasCarriageReturn = false;
  let pendingCarriageReturnEnd: number | null = null;
  for (let start = 0; start < entry.size; start += OBJECT_INTEGRITY_CHUNK_SIZE) {
    const end = Math.min(entry.size, start + OBJECT_INTEGRITY_CHUNK_SIZE);
    const loaded = await loadTextFileRangeInternal(
      objects, spaceId, manifestFormat, entry, start, end, signal, deadlineAt, loadVerifiedFull,
    );
    if (loaded.kind === "error") return Object.freeze({ kind: "error", error: loaded.error });
    if (loaded.legacy) {
      return selectVerifiedHead(loaded.verifiedFull ?? await loadVerifiedFull());
    }
    const bytes = loaded.file.bytes;
    if (bytes.byteLength !== end - start) throw revisionIntegrityFailure();
    chunks.push(bytes);
    accumulated += bytes.byteLength;

    if (pendingCarriageReturnEnd !== null) {
      const selectedEnd = pendingCarriageReturnEnd + (bytes[0] === 0x0a ? 1 : 0);
      return selectedHead(joinedBytes(chunks, accumulated), selectedEnd);
    }

    for (let index = 0; index < bytes.byteLength; index += 1) {
      const byte = bytes[index]!;
      if (byte === 0x0a) {
        if (!previousWasCarriageReturn && ++lines === lineCount) {
          const selectedEnd = start + index + 1;
          return selectedHead(joinedBytes(chunks, accumulated), selectedEnd);
        }
        previousWasCarriageReturn = false;
        continue;
      }
      if (byte === 0x0d) {
        lines += 1;
        previousWasCarriageReturn = true;
        if (lines === lineCount) {
          if (index + 1 < bytes.byteLength) {
            const selectedEnd = start + index + (bytes[index + 1] === 0x0a ? 2 : 1);
            return selectedHead(joinedBytes(chunks, accumulated), selectedEnd);
          }
          if (end === entry.size) {
            return selectedHead(joinedBytes(chunks, accumulated), accumulated);
          }
          pendingCarriageReturnEnd = start + index + 1;
          break;
        }
        continue;
      }
      previousWasCarriageReturn = false;
    }
  }
  const bytes = joinedBytes(chunks, accumulated);
  return selectedHead(bytes, bytes.byteLength);
}

export async function loadTextFileTail(
  objects: ObjectStore,
  spaceId: SpaceId,
  manifestFormat: CanonicalRevisionEnvelope["manifest"]["format"],
  entry: Readonly<RevisionManifestEntry>,
  lineCount: number,
  signal: AbortSignal | undefined,
  deadlineAt: number,
  loadFull: () => Promise<LoadedTextFile>,
  maxBytes = MAX_FILE_OUTPUT_BYTE_BUDGET,
): Promise<Readonly<
  | {
      readonly kind: "file";
      readonly file: Readonly<ExactTextFile>;
      readonly complete: boolean;
      readonly lineStart: number;
      readonly totalLines: number | null;
      readonly byteStart: number;
    }
  | { readonly kind: "error"; readonly error: FileOperationItemError }
>> {
  if (entry.kind === "opaque" && !isTextMediaType(entry.mediaType)) {
    return Object.freeze({ kind: "error", error: Object.freeze({ code: "file_not_text", retryable: false }) });
  }
  if (entry.size > MAX_TEXT_BUNDLE_FILE_BYTES) {
    return Object.freeze({ kind: "error", error: Object.freeze({ code: "file_scan_limit_exceeded", retryable: false }) });
  }
  let full: LoadedTextFile | undefined;
  const loadFullOnce = async (): Promise<LoadedTextFile> => {
    full ??= await verifyFullTextFile(objects, entry, await loadFull());
    return full;
  };
  const selectFromFull = (loaded: LoadedTextFile): Readonly<
    | {
        readonly kind: "file";
        readonly file: Readonly<ExactTextFile>;
        readonly complete: true;
        readonly lineStart: number;
        readonly totalLines: number;
        readonly byteStart: number;
      }
    | { readonly kind: "error"; readonly error: FileOperationItemError }
  > => {
    if (loaded.kind === "error") return loaded;
    const lines = splitTextLines(loaded.file.text);
    const count = Math.min(lineCount, lines.length);
    const first = Math.max(0, lines.length - count);
    const start = count === 0 ? 0 : lines[first]!.startByte;
    const bytes = loaded.file.bytes.slice(start);
    return Object.freeze({
      kind: "file",
      file: Object.freeze({
        entry,
        bytes,
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      }),
      complete: true,
      lineStart: count === 0 ? 0 : first + 1,
      totalLines: lines.length,
      byteStart: start,
    });
  };
  if (entry.size === 0) return selectFromFull(await loadFullOnce());

  const chunks: Uint8Array[] = [];
  let startOffset = entry.size;
  let selectedLines: readonly Readonly<TextLine>[] | null = null;
  while (startOffset > 0) {
    const windowStart = Math.max(0, startOffset - OBJECT_INTEGRITY_CHUNK_SIZE);
    const ranged = await loadTextFileRangeInternal(
      objects,
      spaceId,
      manifestFormat,
      entry,
      windowStart,
      startOffset,
      signal,
      deadlineAt,
      loadFullOnce,
    );
    if (ranged.kind === "error") return Object.freeze({ kind: "error", error: ranged.error });
    if (ranged.legacy) {
      const loaded = full ?? await loadFullOnce();
      return selectFromFull(loaded);
    }
    chunks.unshift(ranged.file.bytes);
    startOffset = windowStart;
    const bytes = joinedBytes(chunks, chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      if (startOffset === 0) throw revisionIntegrityFailure();
      continue;
    }
    // A suffix may begin with the second byte of a CRLF pair when the
    // backward window starts exactly at the LF chunk boundary. Fetch the
    // preceding chunk once so line counting never turns that terminator into
    // a spurious empty line.
    if (startOffset > 0 && bytes[0] === 0x0a) continue;
    const lines = splitTextLines(text);
    if (startOffset === 0 || lines.length > lineCount || bytes.byteLength >= Math.max(1, maxBytes)) {
      selectedLines = lines;
      break;
    }
  }
  if (selectedLines === null) throw revisionIntegrityFailure();
  const count = Math.min(lineCount, selectedLines.length);
  const first = Math.max(0, selectedLines.length - count);
  const selectedStart = count === 0 ? 0 : selectedLines[first]!.startByte;
  const allBytes = joinedBytes(chunks, chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  const bytes = allBytes.slice(selectedStart);
  const complete = startOffset === 0;
  return Object.freeze({
    kind: "file",
    file: Object.freeze({
      entry,
      bytes,
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    }),
    complete,
    lineStart: complete ? (count === 0 ? 0 : first + 1) : 1,
    totalLines: complete ? selectedLines.length : null,
    byteStart: startOffset + selectedStart,
  });
}

export function jsonValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= 8) return null;
  if (Array.isArray(value)) return Object.freeze(value.slice(0, 100).map((item) => jsonValue(item, depth + 1)));
  if (!isRecord(value)) return null;
  return Object.freeze(Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, jsonValue(item, depth + 1)])));
}

export function metadataAt(value: unknown, path: string): { readonly exists: boolean; readonly value: unknown } {
  let current = value;
  for (const part of path.split(".")) {
    if (!isRecord(current) || !Object.hasOwn(current, part)) return { exists: false, value: undefined };
    current = current[part];
  }
  return { exists: true, value: current };
}

export function exactJsonEqual(left: unknown, right: unknown): boolean { return JSON.stringify(jsonValue(left)) === JSON.stringify(jsonValue(right)); }
function comparable(left: unknown, right: unknown): number | null {
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "string" && typeof right === "string") return scalarCompare(left, right);
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  return null;
}

export function evaluateMetadataFilter(value: unknown, fields: Readonly<Record<string, unknown>>): boolean {
  const filter = value as Readonly<Record<string, unknown>>;
  if (Array.isArray(filter.all)) return filter.all.every((item) => evaluateMetadataFilter(item, fields));
  if (Array.isArray(filter.any)) return filter.any.some((item) => evaluateMetadataFilter(item, fields));
  const selected = metadataAt(fields, filter.field as string);
  if (filter.op === "exists") return selected.exists;
  if (!selected.exists) return false;
  if (filter.op === "eq") return exactJsonEqual(selected.value, filter.value);
  if (filter.op === "in") return (filter.value as unknown[]).some((item) => exactJsonEqual(selected.value, item));
  const order = comparable(selected.value, filter.value);
  return order !== null && (filter.op === "lt" ? order < 0 : filter.op === "lte" ? order <= 0 : filter.op === "gt" ? order > 0 : order >= 0);
}

export function regexEscape(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
export function wordScalar(value: string | undefined): boolean { return value !== undefined && /[\p{L}\p{N}\p{M}\p{Pc}]/u.test(value); }
export function scalarBefore(value: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  let start = index - 1;
  const unit = value.charCodeAt(start);
  if (unit >= 0xdc00 && unit <= 0xdfff && start > 0) start -= 1;
  const point = value.codePointAt(start);
  return point === undefined ? undefined : String.fromCodePoint(point);
}
export function scalarAfter(value: string, index: number): string | undefined {
  const point = value.codePointAt(index);
  return point === undefined ? undefined : String.fromCodePoint(point);
}

export function textPositionIndex(value: string): Readonly<{
  readonly byteOffsets: Uint32Array;
  readonly scalarColumns: Uint32Array;
}> {
  const byteOffsets = new Uint32Array(value.length + 1);
  const scalarColumns = new Uint32Array(value.length + 1);
  let bytes = 0;
  let column = 1;
  for (let index = 0; index < value.length;) {
    const point = value.codePointAt(index)!;
    const scalar = String.fromCodePoint(point);
    const width = scalar.length;
    for (let unit = 0; unit < width; unit += 1) {
      byteOffsets[index + unit] = bytes;
      scalarColumns[index + unit] = column;
    }
    bytes += new TextEncoder().encode(scalar).byteLength;
    index += width;
    column += 1;
  }
  byteOffsets[value.length] = bytes;
  scalarColumns[value.length] = column;
  return Object.freeze({ byteOffsets, scalarColumns });
}

export function fileOperationRequestValue(operation: "list" | "grep" | "read", request: Readonly<NormalizedListFilesRequest | NormalizedGrepFilesRequest | NormalizedReadFilesRequest>): unknown {
  if (operation === "list") {
    const value = request as Readonly<NormalizedListFilesRequest>;
    return { operation, selector: value.selector, where: value.where ?? null, selectMetadataFields: value.selectMetadataFields, sort: value.sort, aggregate: value.aggregate, limit: value.limit, maxOutputBytes: value.maxOutputBytes };
  }
  if (operation === "grep") {
    const value = request as Readonly<NormalizedGrepFilesRequest>;
    return { operation, selector: value.selector, patterns: value.patterns, syntax: value.syntax,
      caseSensitive: value.caseSensitive, wholeWord: value.wholeWord, wholeLine: value.wholeLine,
      output: value.output, countUnit: value.countUnit, beforeContext: value.beforeContext,
      afterContext: value.afterContext, limit: value.limit, maxOutputBytes: value.maxOutputBytes };
  }
  const value = request as Readonly<NormalizedReadFilesRequest>;
  return { operation, requests: value.requests, maxOutputBytes: value.maxOutputBytes };
}

export function fileFields(entry: Readonly<RevisionManifestEntry>, metadataStatus: FileMetadataStatus,
  metadata: Readonly<Record<string, unknown>> | null, revisionId: RevisionId,
  revisionCommittedAt: string): Readonly<Record<string, unknown>> {
  return Object.freeze({ path: entry.path, kind: entry.kind, mediaType: entry.mediaType, size: entry.size,
    sha256: entry.sha256, revisionId, revisionCommittedAt, metadataStatus, metadata });
}

export function compareUnknown(left: unknown, right: unknown): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return comparable(left, right) ?? scalarCompare(JSON.stringify(jsonValue(left)), JSON.stringify(jsonValue(right)));
}

export function byteOffsetAt(value: string, utf16Index: number): number { return new TextEncoder().encode(value.slice(0, utf16Index)).byteLength; }
export function isUtf8Boundary(bytes: Uint8Array, offset: number): boolean { return offset === 0 || offset === bytes.byteLength || (bytes[offset]! & 0xc0) !== 0x80; }
