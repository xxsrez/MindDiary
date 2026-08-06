import { parseFrontmatter, renderFrontmatter } from "./frontmatter.js";
import { okfFileKind, validateCanonicalOkfPath } from "./path.js";
import {
  OKF_AUDITED_SPEC_REVISION,
  OKF_VERSION,
  type BinaryOkfFile,
  type CanonicalOkfFile,
  type OkfBundleValidation,
  type OkfConceptUpdate,
  type OkfDiagnostic,
  type OkfFileParseResult,
  type OkfCodec,
  type OkfSourceFile,
  type ParsedOkfConcept,
  type ParsedOkfFile,
} from "./types.js";

const ZIP_SIGNATURES = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
] as const;

const FORBIDDEN_SERVICE_KEYS = new Set([
  "access_control",
  "access_control_list",
  "account_id",
  "acl",
  "audit_event",
  "audit_events",
  "committed_at",
  "committed_by",
  "expected_revision",
  "head_revision_id",
  "idempotency_key",
  "idempotency_record",
  "index_state",
  "index_status",
  "invitation_id",
  "job_id",
  "manifest_hash",
  "membership",
  "memberships",
  "metadata_version",
  "mind_id",
  "normalized_handle",
  "parent_revision_id",
  "principal_id",
  "request_id",
  "revision_id",
  "revision_number",
  "role",
  "space_handle",
  "space_id",
  "token_id",
  "token_scopes",
  "visibility",
]);

function diagnostic(
  severity: "error" | "warning",
  category: OkfDiagnostic["category"],
  source: OkfDiagnostic["source"],
  code: string,
  path: string,
  message: string,
  details: { readonly line?: number; readonly field?: string } = {},
): OkfDiagnostic {
  return { severity, category, source, code, path, message, ...details };
}

function conformanceError(
  path: string,
  code: string,
  message: string,
  details?: { readonly line?: number; readonly field?: string },
): OkfDiagnostic {
  return diagnostic(
    "error",
    "okf-conformance",
    "okf-0.2",
    code,
    path,
    message,
    details,
  );
}

function envelopeError(
  path: string,
  code: string,
  message: string,
  details?: { readonly line?: number; readonly field?: string },
): OkfDiagnostic {
  return diagnostic(
    "error",
    "mind-diary-envelope",
    "mind-diary-mvp",
    code,
    path,
    message,
    details,
  );
}

function qualityWarning(
  path: string,
  code: string,
  message: string,
  details?: { readonly line?: number; readonly field?: string },
): OkfDiagnostic {
  return diagnostic("warning", "quality", "okf-0.2", code, path, message, details);
}

function looksLikeZip(bytes: Uint8Array): boolean {
  return ZIP_SIGNATURES.some((signature) =>
    signature.every((byte, index) => bytes[index] === byte),
  );
}

function decodeSource(
  source: OkfSourceFile,
): { readonly text: string; readonly diagnostic: null } | {
  readonly text: null;
  readonly diagnostic: OkfDiagnostic;
} {
  if ("text" in source) return { text: source.text, diagnostic: null };
  if (looksLikeZip(source.bytes)) {
    return {
      text: null,
      diagnostic: envelopeError(
        source.path,
        "archive_transport_not_supported",
        "ZIP transport is outside the Mind Diary MVP.",
      ),
    };
  }
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(source.bytes),
      diagnostic: null,
    };
  } catch {
    return {
      text: null,
      diagnostic: envelopeError(
        source.path,
        "invalid_utf8",
        "Canonical Markdown content must be valid UTF-8.",
      ),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validActor(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^(?:human:\S+|process:\S+|[^\s/]+\/[^\s/]+)$/u.test(value)
  );
}

function validInstant(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/u.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function collectForbiddenMetadata(
  value: unknown,
  found: string[],
  path: readonly string[] = [],
  seen = new WeakSet<object>(),
): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectForbiddenMetadata(entry, found, [...path, String(index)], seen),
    );
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    const fieldPath = [...path, key];
    if (FORBIDDEN_SERVICE_KEYS.has(key)) found.push(fieldPath.join("."));
    collectForbiddenMetadata(nested, found, fieldPath, seen);
  }
}

function validateOptionalFamilies(
  metadata: Readonly<Record<string, unknown>>,
  path: string,
): readonly OkfDiagnostic[] {
  const warnings: OkfDiagnostic[] = [];

  if (
    metadata.status !== undefined &&
    !["draft", "stable", "deprecated"].includes(String(metadata.status))
  ) {
    warnings.push(
      qualityWarning(
        path,
        "invalid_lifecycle_status",
        "OKF 0.2 status guidance uses draft, stable, or deprecated; the value was preserved.",
        { field: "status" },
      ),
    );
  }
  if (metadata.stale_after !== undefined && !validDate(metadata.stale_after)) {
    warnings.push(
      qualityWarning(
        path,
        "invalid_stale_after",
        "stale_after should be an ISO YYYY-MM-DD date; the value was preserved.",
        { field: "stale_after" },
      ),
    );
  }
  if (metadata.generated !== undefined) {
    const generated = metadata.generated;
    if (
      !isRecord(generated) ||
      !validActor(generated.by) ||
      (generated.at !== undefined && !validInstant(generated.at))
    ) {
      warnings.push(
        qualityWarning(
          path,
          "invalid_generated_signal",
          "generated should carry a conventional by actor and optional ISO datetime; the value was preserved.",
          { field: "generated" },
        ),
      );
    }
  }
  if (metadata.sources !== undefined) {
    const sources = metadata.sources;
    if (
      !Array.isArray(sources) ||
      sources.some(
        (source) =>
          !isRecord(source) ||
          typeof source.resource !== "string" ||
          source.resource.trim().length === 0,
      )
    ) {
      warnings.push(
        qualityWarning(
          path,
          "invalid_sources_signal",
          "Each sources entry should carry a non-empty resource; the value was preserved.",
          { field: "sources" },
        ),
      );
    }
  }
  if (metadata.verified !== undefined) {
    const entries = Array.isArray(metadata.verified)
      ? metadata.verified
      : [metadata.verified];
    if (
      entries.some(
        (entry) =>
          !isRecord(entry) ||
          !validActor(entry.by) ||
          (entry.at !== undefined && !validInstant(entry.at)),
      )
    ) {
      warnings.push(
        qualityWarning(
          path,
          "invalid_verified_signal",
          "verified entries should carry a conventional by actor and optional ISO datetime; the value was preserved.",
          { field: "verified" },
        ),
      );
    }
  }
  if (
    metadata.tags !== undefined &&
    (!Array.isArray(metadata.tags) ||
      metadata.tags.some((tag) => typeof tag !== "string"))
  ) {
    warnings.push(
      qualityWarning(
        path,
        "invalid_tags",
        "tags should be a list of strings; the value was preserved.",
        { field: "tags" },
      ),
    );
  }
  if (
    metadata.type === "Attested Computation" &&
    (typeof metadata.runtime !== "string" || metadata.runtime.trim().length === 0)
  ) {
    warnings.push(
      qualityWarning(
        path,
        "attested_computation_missing_runtime",
        "Attested Computation guidance requires runtime; the opaque concept was not executed.",
        { field: "runtime" },
      ),
    );
  }

  return warnings;
}

function parseConcept(
  path: string,
  text: string,
  diagnostics: OkfDiagnostic[],
): ParsedOkfConcept | null {
  const parsed = parseFrontmatter(text);
  if (parsed.kind === "absent") {
    diagnostics.push(
      conformanceError(
        path,
        "missing_frontmatter",
        "Every non-reserved OKF concept requires YAML frontmatter.",
        { line: 1 },
      ),
    );
    return null;
  }
  if (parsed.kind === "failure") {
    diagnostics.push(
      conformanceError(path, parsed.failure.code, parsed.failure.message, {
        ...(parsed.failure.line === undefined ? {} : { line: parsed.failure.line }),
      }),
    );
    return null;
  }

  const metadata = parsed.block.metadata;
  const okfType =
    typeof metadata.type === "string" && metadata.type.trim().length > 0
      ? metadata.type
      : null;
  if (okfType === null) {
    diagnostics.push(
      conformanceError(
        path,
        "missing_type",
        "Every OKF concept requires a non-empty type string.",
        { line: 2, field: "type" },
      ),
    );
  }

  const forbidden: string[] = [];
  collectForbiddenMetadata(metadata, forbidden);
  for (const field of forbidden) {
    diagnostics.push(
      envelopeError(
        path,
        "forbidden_service_metadata",
        `Service authority metadata '${field}' must remain outside OKF frontmatter.`,
        { field },
      ),
    );
  }
  diagnostics.push(...validateOptionalFamilies(metadata, path));

  return {
    kind: "concept",
    path,
    version: OKF_VERSION,
    sourceText: text,
    newline: parsed.block.newline,
    frontmatter: metadata,
    frontmatterSource: parsed.block.frontmatterSource,
    headerSource: parsed.block.headerSource,
    body: parsed.block.body,
    okfType,
    typeSemantics: "opaque",
  };
}

function parseIndex(
  path: string,
  text: string,
  diagnostics: OkfDiagnostic[],
): ParsedOkfFile | null {
  const isRoot = path === "index.md";
  const parsed = parseFrontmatter(text);

  if (!isRoot) {
    if (parsed.kind !== "absent") {
      diagnostics.push(
        conformanceError(
          path,
          "nested_index_frontmatter",
          "Nested index.md files must not contain frontmatter.",
          { line: 1 },
        ),
      );
    }
    return {
      kind: "index",
      path,
      version: OKF_VERSION,
      sourceText: text,
      newline: parsed.kind === "parsed" ? parsed.block.newline : "\n",
      frontmatter: null,
      body: text,
      isRoot,
    };
  }

  if (parsed.kind === "failure") {
    diagnostics.push(
      conformanceError(path, parsed.failure.code, parsed.failure.message, {
        ...(parsed.failure.line === undefined ? {} : { line: parsed.failure.line }),
      }),
    );
    return null;
  }
  if (parsed.kind === "absent") {
    return {
      kind: "index",
      path,
      version: OKF_VERSION,
      sourceText: text,
      newline: parsed.newline,
      frontmatter: null,
      body: text,
      isRoot,
    };
  }

  const keys = Object.keys(parsed.block.metadata);
  if (keys.length !== 1 || keys[0] !== "okf_version") {
    diagnostics.push(
      conformanceError(
        path,
        "invalid_root_index_frontmatter",
        "Root index.md frontmatter may contain only okf_version.",
        { line: 2 },
      ),
    );
  }
  if (parsed.block.metadata.okf_version !== OKF_VERSION) {
    diagnostics.push(
      envelopeError(
        path,
        "unsupported_okf_version",
        `Mind Diary writes only OKF ${OKF_VERSION}; the declared version was not reinterpreted.`,
        { field: "okf_version" },
      ),
    );
  }

  return {
    kind: "index",
    path,
    version: OKF_VERSION,
    sourceText: text,
    newline: parsed.block.newline,
    frontmatter: parsed.block.metadata,
    body: parsed.block.body,
    isRoot,
  };
}

function parseLog(
  path: string,
  text: string,
  diagnostics: OkfDiagnostic[],
): ParsedOkfFile {
  const frontmatter = parseFrontmatter(text);
  if (frontmatter.kind !== "absent") {
    diagnostics.push(
      conformanceError(
        path,
        "log_frontmatter",
        "Reserved log.md uses date-grouped Markdown without frontmatter.",
        { line: 1 },
      ),
    );
  }

  const headings = [...text.matchAll(/^##\s+(.+?)\s*$/gmu)];
  if (headings.length === 0) {
    diagnostics.push(
      conformanceError(
        path,
        "missing_log_date_group",
        "log.md requires at least one ISO date group when present.",
      ),
    );
  }
  const dates: string[] = [];
  for (const heading of headings) {
    const value = heading[1] ?? "";
    if (!validDate(value)) {
      diagnostics.push(
        conformanceError(
          path,
          "invalid_log_date_heading",
          "log.md level-two headings must be valid ISO YYYY-MM-DD dates.",
        ),
      );
      continue;
    }
    dates.push(value);
  }
  for (let index = 1; index < dates.length; index += 1) {
    const previous = dates[index - 1];
    const current = dates[index];
    if (previous !== undefined && current !== undefined && current >= previous) {
      diagnostics.push(
        conformanceError(
          path,
          "log_not_newest_first",
          "log.md date groups must be unique and newest-first.",
        ),
      );
      break;
    }
  }

  return {
    kind: "log",
    path,
    version: OKF_VERSION,
    sourceText: text,
    newline: text.includes("\r\n") ? "\r\n" : "\n",
  };
}

export function parseOkfFile(source: OkfSourceFile): OkfFileParseResult {
  const diagnostics = [...validateCanonicalOkfPath(source.path)];
  if (diagnostics.some((entry) => entry.severity === "error")) {
    return { file: null, diagnostics, valid: false };
  }

  const decoded = decodeSource(source);
  if (decoded.diagnostic) {
    diagnostics.push(decoded.diagnostic);
    return { file: null, diagnostics, valid: false };
  }
  const text = decoded.text;
  const kind = okfFileKind(source.path);
  const file =
    kind === "concept"
      ? parseConcept(source.path, text, diagnostics)
      : kind === "index"
        ? parseIndex(source.path, text, diagnostics)
        : parseLog(source.path, text, diagnostics);

  return {
    file,
    diagnostics,
    valid: diagnostics.every((entry) => entry.severity !== "error"),
  };
}

function normalizeLink(sourcePath: string, target: string): string | null {
  const unwrapped = target.startsWith("<") && target.endsWith(">")
    ? target.slice(1, -1)
    : target;
  if (
    unwrapped.length === 0 ||
    unwrapped.startsWith("#") ||
    unwrapped.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(unwrapped)
  ) {
    return null;
  }
  const withoutFragment = unwrapped.split(/[?#]/u, 1)[0] ?? "";
  if (!withoutFragment.endsWith(".md")) return null;
  const base = withoutFragment.startsWith("/")
    ? []
    : sourcePath.split("/").slice(0, -1);
  const output = [...base];
  for (const segment of withoutFragment.replace(/^\//u, "").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (output.length === 0) return null;
      output.pop();
    } else {
      output.push(segment);
    }
  }
  return output.join("/");
}

function collectBrokenLinkWarnings(
  files: readonly ParsedOkfFile[],
): readonly OkfDiagnostic[] {
  const available = new Set(files.map((file) => file.path));
  const warnings: OkfDiagnostic[] = [];
  const linkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/gu;
  for (const file of files) {
    for (const match of file.sourceText.matchAll(linkPattern)) {
      const target = match[1];
      if (target === undefined) continue;
      const resolved = normalizeLink(file.path, target);
      if (resolved !== null && !available.has(resolved)) {
        warnings.push(
          qualityWarning(
            file.path,
            "broken_cross_link",
            `Markdown link target '${resolved}' is not present in this bundle.`,
          ),
        );
      }
    }
  }
  return warnings;
}

export function validateOkfBundle(
  sources: readonly OkfSourceFile[],
): OkfBundleValidation {
  const diagnostics: OkfDiagnostic[] = [];
  const files: ParsedOkfFile[] = [];
  const seenPaths = new Set<string>();

  for (const source of sources) {
    if (seenPaths.has(source.path)) {
      diagnostics.push(
        envelopeError(
          source.path,
          "duplicate_path",
          "A complete bundle must contain each canonical path at most once.",
        ),
      );
      continue;
    }
    seenPaths.add(source.path);
    const result = parseOkfFile(source);
    diagnostics.push(...result.diagnostics);
    if (result.file) files.push(result.file);
  }
  diagnostics.push(...collectBrokenLinkWarnings(files));

  const conformanceErrors = diagnostics.filter(
    (entry) => entry.category === "okf-conformance",
  );
  const envelopeErrors = diagnostics.filter(
    (entry) => entry.category === "mind-diary-envelope",
  );
  const qualityWarnings = diagnostics.filter((entry) => entry.category === "quality");

  return {
    version: OKF_VERSION,
    valid: conformanceErrors.length === 0 && envelopeErrors.length === 0,
    conforms: conformanceErrors.length === 0,
    files,
    diagnostics,
    conformanceErrors,
    envelopeErrors,
    qualityWarnings,
  };
}

export function renderOkfFile(file: ParsedOkfFile): CanonicalOkfFile {
  return { path: file.path, text: file.sourceText };
}

export function encodeOkfFile(
  file: ParsedOkfFile | CanonicalOkfFile,
): BinaryOkfFile {
  return {
    path: file.path,
    bytes: new TextEncoder().encode(
      "sourceText" in file ? file.sourceText : file.text,
    ),
  };
}

export function updateOkfConcept(
  concept: ParsedOkfConcept,
  update: OkfConceptUpdate,
): CanonicalOkfFile {
  const nextBody = update.body ?? concept.body;
  if (update.setFields === undefined) {
    return {
      path: concept.path,
      text: `${concept.headerSource}${nextBody}`,
    };
  }
  const metadata = { ...concept.frontmatter, ...update.setFields };
  return {
    path: concept.path,
    text: `${renderFrontmatter(metadata, concept.newline)}${nextBody}`,
  };
}

export function readVerifiedEntries(
  metadata: Readonly<Record<string, unknown>>,
): readonly Readonly<Record<string, unknown>>[] {
  if (isRecord(metadata.verified)) return [metadata.verified];
  if (!Array.isArray(metadata.verified)) return [];
  return metadata.verified.filter(isRecord);
}

export const OKF_0_2_CODEC = Object.freeze({
  version: OKF_VERSION,
  auditedSpecRevision: OKF_AUDITED_SPEC_REVISION,
  parseFile: parseOkfFile,
  renderFile: renderOkfFile,
  encodeFile: encodeOkfFile,
  validateBundle: validateOkfBundle,
  updateConcept: updateOkfConcept,
} satisfies OkfCodec);

export function resolveOkfCodec(version: string) {
  return version === OKF_VERSION ? OKF_0_2_CODEC : null;
}
