import { RE2JS } from "re2js";

import type {
  RevisionId,
  RevisionManifestEntry,
  Sha256Digest,
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
export const MAX_TEXT_BUNDLE_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_GREP_SCAN_BYTES = 16 * 1024 * 1024;
export const MAX_METADATA_SCAN_BYTES = 4 * 1024 * 1024;
export const MAX_FILE_SELECTOR_PATHS = 100;
export const MAX_READ_FILE_REQUESTS = 32;

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
  readonly incomplete: boolean;
  readonly incompleteReason: "page_limit" | "scan_budget" | null;
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
  readonly incompleteReason: "page_limit" | "scan_budget" | "response_budget" | null;
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
  readonly incompleteReason: "response_budget" | null;
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
  const allowed = new Set(["mind", "revisionSelector", ...selectorKeys(), "where", "selectMetadataFields", "sort", "aggregate", "cursor", "limit"]);
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
    aggregate, cursor: normalizeCursor(value.cursor), limit: normalizePageLimit(value.limit) });
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
    mediaType === "application/x-yaml" || mediaType === "application/xml" || mediaType.endsWith("+json") || mediaType.endsWith("+xml");
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

export async function readHeadBytes(body: ReadableStream<Uint8Array>, expectedSize: number, lineCount: number): Promise<Readonly<{ bytes: Uint8Array; complete: boolean }>> {
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read();
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
  } finally { reader.releaseLock(); }
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
export function scalarBefore(value: string, index: number): string | undefined { return index <= 0 ? undefined : Array.from(value.slice(0, index)).at(-1); }
export function scalarAfter(value: string, index: number): string | undefined { return Array.from(value.slice(index))[0]; }

export function fileOperationRequestValue(operation: "list" | "grep" | "read", request: Readonly<NormalizedListFilesRequest | NormalizedGrepFilesRequest | NormalizedReadFilesRequest>): unknown {
  if (operation === "list") {
    const value = request as Readonly<NormalizedListFilesRequest>;
    return { operation, selector: value.selector, where: value.where ?? null, selectMetadataFields: value.selectMetadataFields, sort: value.sort, aggregate: value.aggregate, limit: value.limit };
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
