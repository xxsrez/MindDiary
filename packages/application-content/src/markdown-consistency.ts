export const MARKDOWN_CONSISTENCY_RULES_VERSION = "2026-09-18" as const;

export interface MarkdownConsistencyDocument {
  readonly path: string;
  readonly text: string;
  readonly sourceReferences?: readonly string[];
}

export interface MarkdownConsistencyDiagnostic {
  readonly severity: "error" | "warning";
  readonly class: "consistency" | "advisory";
  readonly blocksCommit: boolean;
  readonly code: string;
  readonly path: string;
  readonly line?: number;
  readonly field?: string;
  readonly target?: string;
  readonly message: string;
  readonly reason: string;
  readonly recommendation: string;
}

export interface MarkdownConsistencyAnalysis {
  readonly diagnostics: readonly Readonly<MarkdownConsistencyDiagnostic>[];
  readonly consistencyErrors: readonly Readonly<MarkdownConsistencyDiagnostic>[];
  readonly advisories: readonly Readonly<MarkdownConsistencyDiagnostic>[];
}

interface LocatedReference {
  readonly destination: string;
  readonly line: number;
  readonly field?: "sources";
}

interface ParsedDocument {
  readonly path: string;
  readonly headings: ReadonlySet<string>;
  readonly links: readonly LocatedReference[];
  readonly duplicateHeadings: readonly Readonly<{ anchor: string; line: number }>[];
  readonly unresolvedReferences: readonly Readonly<{ label: string; line: number }>[];
  readonly sourceReferences: readonly string[];
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const MARKDOWN_ESCAPE = /\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/gu;

function unescapeMarkdown(value: string): string {
  return value.replace(MARKDOWN_ESCAPE, "$1");
}

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function normalizeReferenceLabel(value: string): string {
  return unescapeMarkdown(value).trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function stripInlineCode(value: string): string {
  let output = "";
  let index = 0;
  while (index < value.length) {
    if (value[index] !== "`" || isEscaped(value, index)) {
      output += value[index];
      index += 1;
      continue;
    }
    let width = 1;
    while (value[index + width] === "`") width += 1;
    const marker = "`".repeat(width);
    const end = value.indexOf(marker, index + width);
    if (end === -1) {
      output += value.slice(index);
      break;
    }
    output += " ".repeat(end + width - index);
    index = end + width;
  }
  return output;
}

function frontmatterEnd(lines: readonly string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") return index + 1;
  }
  return 0;
}

function visibleLines(text: string): readonly Readonly<{ text: string; line: number }>[] {
  const lines = text.split(/\r?\n/u);
  const start = frontmatterEnd(lines);
  const visible: { text: string; line: number }[] = [];
  let fence: Readonly<{ marker: "`" | "~"; width: number }> | null = null;
  for (let index = start; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const opener = /^\s{0,3}(`{3,}|~{3,})/u.exec(raw);
    if (opener !== null) {
      const marker = opener[1]![0] as "`" | "~";
      const width = opener[1]!.length;
      if (fence === null) fence = Object.freeze({ marker, width });
      else if (fence.marker === marker && width >= fence.width) fence = null;
      continue;
    }
    if (fence !== null || /^(?: {4}|\t)/u.test(raw)) continue;
    visible.push(Object.freeze({ text: stripInlineCode(raw), line: index + 1 }));
  }
  return Object.freeze(visible);
}

function headingSlug(value: string): string {
  return unescapeMarkdown(value)
    .replace(/<[^>]*>/gu, "")
    .replace(/!?(?:\[([^\]]*)\])(?:\([^)]*\)|\[[^\]]*\])/gu, "$1")
    .replace(/[*_~]/gu, "")
    .normalize("NFC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s+/gu, "-");
}

function parseDestination(value: string, start: number): Readonly<{
  destination: string;
  end: number;
}> | null {
  let index = start;
  while (/\s/u.test(value[index] ?? "")) index += 1;
  if (value[index] === "<") {
    let end = index + 1;
    while (end < value.length && (value[end] !== ">" || isEscaped(value, end))) end += 1;
    if (end >= value.length) return null;
    const close = value.indexOf(")", end + 1);
    if (close === -1) return null;
    return Object.freeze({
      destination: unescapeMarkdown(value.slice(index + 1, end)),
      end: close + 1,
    });
  }
  let destination = "";
  let depth = 0;
  while (index < value.length) {
    const character = value[index]!;
    if (character === "\\" && index + 1 < value.length) {
      destination += value[index + 1]!;
      index += 2;
      continue;
    }
    if (character === "(") {
      depth += 1;
      destination += character;
      index += 1;
      continue;
    }
    if (character === ")") {
      if (depth === 0) return Object.freeze({ destination, end: index + 1 });
      depth -= 1;
      destination += character;
      index += 1;
      continue;
    }
    if (/\s/u.test(character) && depth === 0) {
      const close = value.indexOf(")", index + 1);
      return close === -1 ? null : Object.freeze({ destination, end: close + 1 });
    }
    destination += character;
    index += 1;
  }
  return null;
}

function findClosingBracket(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === "]" && !isEscaped(value, index)) return index;
  }
  return -1;
}

function parseDocument(document: Readonly<MarkdownConsistencyDocument>): ParsedDocument {
  const lines = visibleLines(document.text);
  const definitions = new Map<string, string>();
  for (const located of lines) {
    const match = /^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/u.exec(located.text);
    if (match !== null) {
      definitions.set(normalizeReferenceLabel(match[1]!), unescapeMarkdown(match[2] ?? match[3]!));
    }
  }

  const headings = new Set<string>();
  const headingCounts = new Map<string, number>();
  const duplicateHeadings: { anchor: string; line: number }[] = [];
  const unresolvedReferences: { label: string; line: number }[] = [];
  const links: LocatedReference[] = [];
  const recordHeading = (text: string, line: number) => {
    const base = headingSlug(text);
    if (base.length === 0) return;
    const occurrence = headingCounts.get(base) ?? 0;
    const anchor = occurrence === 0 ? base : `${base}-${occurrence}`;
    headings.add(anchor);
    headingCounts.set(base, occurrence + 1);
    if (occurrence > 0) duplicateHeadings.push({ anchor, line });
  };
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const located = lines[lineIndex]!;
    const atx = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(located.text);
    if (atx !== null) {
      recordHeading(atx[1]!, located.line);
    } else {
      const next = lines[lineIndex + 1];
      if (
        next !== undefined &&
        next.line === located.line + 1 &&
        /^\s{0,3}(?:=+|-+)\s*$/u.test(next.text) &&
        located.text.trim().length > 0
      ) recordHeading(located.text, located.line);
    }
    if (/^\s{0,3}\[[^\]]+\]:/u.test(located.text)) continue;
    const value = located.text;
    for (let index = 0; index < value.length; index += 1) {
      const bracket = value[index] === "!" ? index + 1 : index;
      if (value[bracket] !== "[" || isEscaped(value, bracket)) continue;
      const close = findClosingBracket(value, bracket + 1);
      if (close === -1) continue;
      const label = value.slice(bracket + 1, close);
      let destination: string | undefined;
      let end = close + 1;
      if (value[end] === "(") {
        const parsed = parseDestination(value, end + 1);
        if (parsed !== null) {
          destination = parsed.destination;
          end = parsed.end;
        }
      } else if (value[end] === "[") {
        const referenceClose = findClosingBracket(value, end + 1);
        if (referenceClose !== -1) {
          const referenceLabel = value.slice(end + 1, referenceClose) || label;
          const normalizedLabel = normalizeReferenceLabel(referenceLabel);
          destination = definitions.get(normalizedLabel);
          if (destination === undefined) {
            unresolvedReferences.push({ label: normalizedLabel, line: located.line });
          }
          end = referenceClose + 1;
        }
      } else {
        const normalizedLabel = normalizeReferenceLabel(label);
        destination = definitions.get(normalizedLabel);
        if (destination === undefined && definitions.size > 0) {
          unresolvedReferences.push({ label: normalizedLabel, line: located.line });
        }
      }
      if (destination !== undefined) {
        links.push(Object.freeze({ destination, line: located.line }));
      }
      index = Math.max(index, end - 1);
    }
  }
  return Object.freeze({
    path: document.path,
    headings,
    links: Object.freeze(links),
    duplicateHeadings: Object.freeze(duplicateHeadings),
    unresolvedReferences: Object.freeze(unresolvedReferences),
    sourceReferences: Object.freeze([...(document.sourceReferences ?? [])]),
  });
}

type ResolvedTarget =
  | Readonly<{ kind: "external"; target: string }>
  | Readonly<{ kind: "unsupported"; target: string }>
  | Readonly<{ kind: "invalid"; target: string }>
  | Readonly<{ kind: "local"; path: string; fragment?: string; target: string }>;

export interface MarkdownLocalTarget {
  readonly path: string;
  readonly fragment?: string;
}

function decodedFragment(value: string): string | null {
  try {
    return decodeURIComponent(value).normalize("NFC");
  } catch {
    return null;
  }
}

function resolveRelative(sourcePath: string, rawTarget: string): ResolvedTarget {
  const target = rawTarget.trim();
  if (target.length === 0) return Object.freeze({ kind: "invalid", target });
  if (/^https?:/iu.test(target)) return Object.freeze({ kind: "external", target });
  if (target.startsWith("//") || SCHEME.test(target)) {
    return Object.freeze({ kind: "unsupported", target });
  }
  const hash = target.indexOf("#");
  const query = target.indexOf("?");
  const pathEnd = Math.min(
    hash === -1 ? target.length : hash,
    query === -1 ? target.length : query,
  );
  const encodedPath = target.slice(0, pathEnd);
  const encodedFragment = hash === -1 ? undefined : target.slice(hash + 1);
  const fragment = encodedFragment === undefined ? undefined : decodedFragment(encodedFragment);
  if (fragment === null) return Object.freeze({ kind: "invalid", target });
  const segments = encodedPath.startsWith("/")
    ? []
    : sourcePath.split("/").slice(0, -1);
  for (const encoded of encodedPath.replace(/^\//u, "").split("/")) {
    if (encoded === "" || encoded === ".") continue;
    let segment: string;
    try {
      segment = decodeURIComponent(encoded).normalize("NFC");
    } catch {
      return Object.freeze({ kind: "invalid", target });
    }
    if (segment.includes("/") || segment.includes("\\") || segment.includes("\0")) {
      return Object.freeze({ kind: "invalid", target });
    }
    if (segment === "..") {
      if (segments.length === 0) return Object.freeze({ kind: "invalid", target });
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  const path = encodedPath.length === 0 ? sourcePath : segments.join("/");
  return Object.freeze({
    kind: "local",
    path,
    ...(fragment === undefined || fragment.length === 0 ? {} : { fragment }),
    target,
  });
}

/**
 * Returns the deterministic local-link projection without requiring target
 * bodies. Callers use it to decide whether a delta validation can prove the
 * same graph invariants or must fall back to a full revision scan.
 */
export function collectMarkdownLocalTargets(
  document: Readonly<MarkdownConsistencyDocument>,
): readonly Readonly<MarkdownLocalTarget>[] {
  const parsed = parseDocument(document);
  const targets = new Map<string, Readonly<MarkdownLocalTarget>>();
  for (const reference of parsed.links) {
    const resolved = resolveRelative(parsed.path, reference.destination);
    if (resolved.kind !== "local") continue;
    const key = `${resolved.path}\u0000${resolved.fragment ?? ""}`;
    targets.set(key, Object.freeze({
      path: resolved.path,
      ...(resolved.fragment === undefined ? {} : { fragment: resolved.fragment }),
    }));
  }
  return Object.freeze([...targets.values()].sort((left, right) =>
    left.path.localeCompare(right.path) ||
    (left.fragment ?? "").localeCompare(right.fragment ?? "")
  ));
}

function resolveSource(
  sourcePath: string,
  rawTarget: string,
  currentSpaceId: string | undefined,
  currentRevisionId: string | undefined,
): ResolvedTarget {
  const target = rawTarget.trim();
  const match = /^okf:\/\/spaces\/([^/]+)\/revisions\/([^/]+)\/(?:entries\/)?(.+)$/iu.exec(target);
  if (match === null) return resolveRelative(sourcePath, target);
  let space: string;
  let revision: string;
  try {
    space = decodeURIComponent(match[1]!);
    revision = decodeURIComponent(match[2]!);
  } catch {
    return Object.freeze({ kind: "invalid", target });
  }
  if (space !== currentSpaceId || revision !== currentRevisionId) {
    return Object.freeze({ kind: "unsupported", target });
  }
  return resolveRelative("index.md", `/${match[3]!}`);
}

function diagnostic(input: Omit<MarkdownConsistencyDiagnostic, "severity" | "blocksCommit"> & {
  readonly class: "consistency" | "advisory";
}): Readonly<MarkdownConsistencyDiagnostic> {
  return Object.freeze({
    ...input,
    severity: input.class === "consistency" ? "error" : "warning",
    blocksCommit: input.class === "consistency",
  });
}

function inspectReference(input: Readonly<{
  source: ParsedDocument;
  reference: LocatedReference;
  documents: ReadonlyMap<string, ParsedDocument>;
  availablePaths: ReadonlySet<string>;
  currentSpaceId?: string;
  currentRevisionId?: string;
}>): Readonly<MarkdownConsistencyDiagnostic> | null {
  const resolved = input.reference.field === "sources"
    ? resolveSource(
        input.source.path,
        input.reference.destination,
        input.currentSpaceId,
        input.currentRevisionId,
      )
    : resolveRelative(input.source.path, input.reference.destination);
  const common = {
    path: input.source.path,
    ...(input.reference.line > 0 ? { line: input.reference.line } : {}),
    ...(input.reference.field === undefined ? {} : { field: input.reference.field }),
    target: resolved.target,
  };
  if (resolved.kind === "external" || resolved.kind === "unsupported") {
    return diagnostic({
      ...common,
      class: "advisory",
      code: input.reference.field === "sources" ? "source_check_unsupported" : "external_link_unchecked",
      message: input.reference.field === "sources"
        ? "A source reference cannot be checked inside this exact revision."
        : "An external link was not fetched during revision validation.",
      reason: resolved.kind === "external"
        ? "External network content is outside deterministic revision validation."
        : "The reference form or target revision is outside the local validation profile.",
      recommendation: "Check the external target separately when its availability or content matters.",
    });
  }
  if (resolved.kind === "invalid") {
    return diagnostic({
      ...common,
      class: "consistency",
      code: "markdown_target_invalid",
      message: "A local Markdown target is malformed or escapes the revision namespace.",
      reason: "The target cannot be resolved to one canonical path in this revision.",
      recommendation: "Use a valid relative or root-relative canonical bundle path.",
    });
  }
  if (!input.availablePaths.has(resolved.path)) {
    return diagnostic({
      ...common,
      class: "consistency",
      code: input.reference.field === "sources" ? "local_source_missing" : "markdown_file_missing",
      message: input.reference.field === "sources"
        ? "A local source is absent from this exact revision."
        : "A linked file is absent from this exact revision.",
      reason: "The resolved canonical path is not present in the validated manifest.",
      recommendation: "Add the target file or update the reference to an existing path.",
    });
  }
  if (resolved.fragment !== undefined) {
    const targetDocument = input.documents.get(resolved.path);
    if (targetDocument === undefined) {
      return diagnostic({
        ...common,
        class: "advisory",
        code: "section_check_unsupported",
        message: "A section target belongs to a non-Markdown file and was not checked.",
        reason: "Only Markdown headings have deterministic section anchors in this profile.",
        recommendation: "Reference the file without a section or use a Markdown source.",
      });
    }
    if (!targetDocument.headings.has(resolved.fragment.toLocaleLowerCase("en-US"))) {
      return diagnostic({
        ...common,
        class: "consistency",
        code: "markdown_section_missing",
        message: "A linked Markdown section is absent from the target file.",
        reason: "The normalized fragment does not match any generated heading anchor.",
        recommendation: "Update the fragment to an existing heading anchor or add the heading.",
      });
    }
  }
  return null;
}

export function analyzeMarkdownConsistency(input: Readonly<{
  readonly markdown: readonly Readonly<MarkdownConsistencyDocument>[];
  readonly availablePaths?: readonly string[];
  readonly currentSpaceId?: string;
  readonly currentRevisionId?: string;
}>): Readonly<MarkdownConsistencyAnalysis> {
  const documents = new Map(
    [...input.markdown]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((document) => {
        const parsed = parseDocument(document);
        return [parsed.path, parsed] as const;
      }),
  );
  const availablePaths = new Set(input.availablePaths ?? [...documents.keys()]);
  const diagnostics: Readonly<MarkdownConsistencyDiagnostic>[] = [];
  const edges = new Map<string, Set<string>>();
  for (const source of documents.values()) {
    edges.set(source.path, new Set());
    for (const duplicate of source.duplicateHeadings) {
      diagnostics.push(diagnostic({
        class: "advisory",
        code: "duplicate_heading",
        path: source.path,
        line: duplicate.line,
        target: `#${duplicate.anchor}`,
        message: "A repeated heading receives a generated numeric anchor suffix.",
        reason: "Duplicate heading text makes section links easier to misread or break during edits.",
        recommendation: "Prefer distinct heading text when stable section links matter.",
      }));
    }
    for (const unresolved of source.unresolvedReferences) {
      diagnostics.push(diagnostic({
        class: "consistency",
        code: "markdown_reference_definition_missing",
        path: source.path,
        line: unresolved.line,
        target: unresolved.label,
        message: "A Markdown reference label has no definition in this file.",
        reason: "The structural parser could not resolve the normalized reference label.",
        recommendation: "Add the reference definition or use an inline destination.",
      }));
    }
    const references = [
      ...source.links,
      ...source.sourceReferences.map((destination) => Object.freeze({
        destination,
        line: 0,
        field: "sources" as const,
      })),
    ];
    for (const reference of references) {
      const resolved = reference.field === "sources"
        ? resolveSource(source.path, reference.destination, input.currentSpaceId, input.currentRevisionId)
        : resolveRelative(source.path, reference.destination);
      if (resolved.kind === "local" && documents.has(resolved.path)) {
        edges.get(source.path)!.add(resolved.path);
      }
      const issue = inspectReference({
        source,
        reference,
        documents,
        availablePaths,
        ...(input.currentSpaceId === undefined ? {} : { currentSpaceId: input.currentSpaceId }),
        ...(input.currentRevisionId === undefined ? {} : { currentRevisionId: input.currentRevisionId }),
      });
      if (issue !== null) diagnostics.push(issue);
    }
  }

  if (documents.has("index.md")) {
    const reachable = new Set<string>();
    const pending = ["index.md"];
    while (pending.length > 0) {
      const path = pending.pop()!;
      if (reachable.has(path)) continue;
      reachable.add(path);
      for (const target of edges.get(path) ?? []) pending.push(target);
    }
    for (const path of [...documents.keys()].sort()) {
      if (
        reachable.has(path) ||
        path === "log.md" ||
        path.startsWith("raw/") ||
        path.startsWith("output/")
      ) continue;
      diagnostics.push(diagnostic({
        class: "advisory",
        code: "markdown_unreachable_from_root",
        path,
        target: path,
        message: "A Markdown file is not reachable from the root index navigation graph.",
        reason: "No chain of local Markdown links from index.md reaches this file.",
        recommendation: "Link the file from the intended navigation page or keep it intentionally unlisted.",
      }));
    }
  }

  diagnostics.sort((left, right) =>
    Number(right.blocksCommit) - Number(left.blocksCommit) ||
    left.path.localeCompare(right.path) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    left.code.localeCompare(right.code) ||
    (left.target ?? "").localeCompare(right.target ?? ""));
  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    consistencyErrors: Object.freeze(diagnostics.filter((entry) => entry.class === "consistency")),
    advisories: Object.freeze(diagnostics.filter((entry) => entry.class === "advisory")),
  });
}
