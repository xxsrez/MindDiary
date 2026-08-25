import {
  canonicalBundleFilePath,
  type BundleFileMediaType,
} from "@mind-diary/domain";
import type { OkfDiagnostic } from "@mind-diary/okf-codec";

export interface BundleFileReferenceMarkdown {
  readonly path: string;
  readonly text: string;
}

export interface BundleFileReferenceTarget {
  readonly path: string;
  readonly mediaType: BundleFileMediaType;
  /** Fresh serving-time verification; omitted for pure contract analysis. */
  readonly inlineEligible?: boolean;
}

export type BundleFileReferenceStatus =
  | "referenced"
  | "unreferenced"
  | "invalid_reference";

export interface BundleFileReferenceAnalysis {
  readonly diagnostics: readonly Readonly<OkfDiagnostic>[];
  readonly statusByPath: ReadonlyMap<string, BundleFileReferenceStatus>;
}

interface LocatedReference {
  readonly image: boolean;
  readonly destination: string;
  readonly line: number;
}

const RASTER_TYPES = new Set<BundleFileMediaType>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const EXPECTED_EXTENSIONS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "image/png": Object.freeze([".png"]),
    "image/jpeg": Object.freeze([".jpg", ".jpeg"]),
    "image/gif": Object.freeze([".gif"]),
    "image/webp": Object.freeze([".webp"]),
    "application/pdf": Object.freeze([".pdf"]),
    "application/zip": Object.freeze([".zip"]),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": Object.freeze([".docx"]),
    "image/heic": Object.freeze([".heic", ".heif"]),
    "application/epub+zip": Object.freeze([".epub"]),
    "audio/ogg": Object.freeze([".ogg", ".opus"]),
    "audio/opus": Object.freeze([".opus"]),
    "text/html": Object.freeze([".html", ".htm"]),
    "text/csv": Object.freeze([".csv"]),
    "application/json": Object.freeze([".json"]),
    "application/x-ipynb+json": Object.freeze([".ipynb"]),
  });
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;

function directoryOf(path: string): string[] {
  const segments = path.split("/");
  segments.pop();
  return segments;
}

function stripInlineCode(line: string): string {
  let output = "";
  let index = 0;
  while (index < line.length) {
    if (line[index] !== "`") {
      output += line[index];
      index += 1;
      continue;
    }
    let ticks = 1;
    while (line[index + ticks] === "`") ticks += 1;
    const marker = "`".repeat(ticks);
    const end = line.indexOf(marker, index + ticks);
    if (end === -1) {
      output += line.slice(index);
      break;
    }
    output += " ".repeat(end + ticks - index);
    index = end + ticks;
  }
  return output;
}

function inlineDestination(line: string, start: number): string | null {
  let index = start;
  while (/\s/u.test(line[index] ?? "")) index += 1;
  if (line[index] === "<") {
    const end = line.indexOf(">", index + 1);
    if (end === -1 || line.indexOf(")", end + 1) === -1) return null;
    return line.slice(index + 1, end);
  }
  let destination = "";
  let parenthesisDepth = 0;
  while (index < line.length) {
    const character = line[index]!;
    if (character === "\\" && index + 1 < line.length) {
      const escaped = line[index + 1]!;
      if (escaped === "(" || escaped === ")" || escaped === "\\") {
        destination += escaped;
        index += 2;
        continue;
      }
    }
    if (character === "(") {
      parenthesisDepth += 1;
      destination += character;
      index += 1;
      continue;
    }
    if (character === ")") {
      if (parenthesisDepth === 0) return destination;
      parenthesisDepth -= 1;
      destination += character;
      index += 1;
      continue;
    }
    if (/\s/u.test(character) && parenthesisDepth === 0) {
      return line.indexOf(")", index + 1) === -1 ? null : destination;
    }
    destination += character;
    index += 1;
  }
  return null;
}

function markdownReferences(text: string): readonly LocatedReference[] {
  const lines = text.split(/\r?\n/u);
  const definitions = new Map<string, string>();
  let fenced = false;
  for (const rawLine of lines) {
    if (/^\s{0,3}(?:```|~~~)/u.test(rawLine)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const definition = /^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/u.exec(rawLine);
    if (definition !== null) {
      definitions.set(definition[1]!.trim().toLocaleLowerCase("en-US"), definition[2] ?? definition[3]!);
    }
  }

  const found: LocatedReference[] = [];
  fenced = false;
  lines.forEach((rawLine, lineIndex) => {
    if (/^\s{0,3}(?:```|~~~)/u.test(rawLine)) {
      fenced = !fenced;
      return;
    }
    if (fenced || /^\s{0,3}\[[^\]]+\]:/u.test(rawLine)) return;
    const line = stripInlineCode(rawLine);
    const inline = /(!?)\[[^\]]*\]\(/gu;
    for (const match of line.matchAll(inline)) {
      const destination = inlineDestination(line, match.index + match[0].length);
      if (destination !== null) {
        found.push(Object.freeze({
          image: match[1] === "!",
          destination,
          line: lineIndex + 1,
        }));
      }
    }
    const referenced = /(!?)\[([^\]]+)\]\[([^\]]*)\]/gu;
    for (const match of line.matchAll(referenced)) {
      const label = (match[3]!.length === 0 ? match[2]! : match[3]!)
        .trim()
        .toLocaleLowerCase("en-US");
      const destination = definitions.get(label);
      if (destination !== undefined) {
        found.push(Object.freeze({
          image: match[1] === "!",
          destination,
          line: lineIndex + 1,
        }));
      }
    }
    const shortcut = /(?<!\])(!?)\[([^\]]+)\](?![\[(])/gu;
    for (const match of line.matchAll(shortcut)) {
      const destination = definitions.get(
        match[2]!.trim().toLocaleLowerCase("en-US"),
      );
      if (destination !== undefined) {
        found.push(Object.freeze({
          image: match[1] === "!",
          destination,
          line: lineIndex + 1,
        }));
      }
    }
  });
  return Object.freeze(found);
}

type ResolvedDestination =
  | { readonly kind: "ignored" }
  | { readonly kind: "invalid" }
  | { readonly kind: "path"; readonly path: string };

function resolveDestination(markdownPath: string, input: string): ResolvedDestination {
  let destination = input.trim();
  if (destination.length === 0) return Object.freeze({ kind: "invalid" });
  if (/^https:/iu.test(destination)) return Object.freeze({ kind: "ignored" });
  if (
    destination.startsWith("//") ||
    destination.startsWith("/") ||
    destination.includes("\\") ||
    destination.includes("?") ||
    SCHEME.test(destination)
  ) return Object.freeze({ kind: "invalid" });
  const fragment = destination.indexOf("#");
  if (fragment !== -1) destination = destination.slice(0, fragment);
  if (destination.length === 0) return Object.freeze({ kind: "ignored" });

  const resolved = directoryOf(markdownPath);
  for (const encoded of destination.split("/")) {
    if (encoded.length === 0) return Object.freeze({ kind: "invalid" });
    let segment: string;
    try {
      segment = decodeURIComponent(encoded);
    } catch {
      return Object.freeze({ kind: "invalid" });
    }
    if (segment.includes("/") || segment.includes("\\") || segment.includes("\0")) {
      return Object.freeze({ kind: "invalid" });
    }
    if (segment === ".") continue;
    if (segment === "..") {
      if (resolved.length === 0) return Object.freeze({ kind: "invalid" });
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  const path = resolved.join("/").normalize("NFC");
  if (path.endsWith(".md")) return Object.freeze({ kind: "ignored" });
  try {
    canonicalBundleFilePath(path);
  } catch {
    return Object.freeze({ kind: "invalid" });
  }
  return Object.freeze({ kind: "path", path });
}

function diagnostic(
  severity: "error" | "warning",
  code: string,
  path: string,
  line: number,
  message: string,
): Readonly<OkfDiagnostic> {
  return Object.freeze({
    severity,
    category: severity === "warning" ? "quality" : "mind-diary-envelope",
    source: "mind-diary-mvp",
    code,
    path,
    line,
    message,
  });
}

function extensionMatches(path: string, mediaType: BundleFileMediaType): boolean {
  const lower = path.toLocaleLowerCase("en-US");
  const expected = EXPECTED_EXTENSIONS[mediaType];
  return expected === undefined || expected.some((extension) => lower.endsWith(extension));
}

export function analyzeBundleFileReferences(input: Readonly<{
  readonly markdown: readonly Readonly<BundleFileReferenceMarkdown>[];
  readonly bundleFiles: readonly Readonly<BundleFileReferenceTarget>[];
}>): Readonly<BundleFileReferenceAnalysis> {
  const targets = new Map(
    input.bundleFiles.map((target) => {
      return [canonicalBundleFilePath(target.path), target] as const;
    }),
  );
  const valid = new Set<string>();
  const invalid = new Set<string>();
  const diagnostics: Readonly<OkfDiagnostic>[] = [];
  const markdown = [...input.markdown].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

  for (const source of markdown) {
    for (const reference of markdownReferences(source.text)) {
      const resolved = resolveDestination(source.path, reference.destination);
      if (resolved.kind === "ignored") continue;
      if (resolved.kind === "invalid") {
        diagnostics.push(diagnostic(
          "error",
          "bundle_file_reference_escape",
          source.path,
          reference.line,
          "BundleFile reference escapes the exact revision namespace.",
        ));
        continue;
      }
      const target = targets.get(resolved.path);
      if (target === undefined) {
        diagnostics.push(diagnostic(
          "error",
          "bundle_file_reference_missing",
          source.path,
          reference.line,
          "BundleFile reference does not resolve in this exact revision.",
        ));
        continue;
      }
      if (
        reference.image &&
        (target.inlineEligible === false ||
          (target.inlineEligible === undefined && !RASTER_TYPES.has(target.mediaType)))
      ) {
        invalid.add(target.path);
        diagnostics.push(diagnostic(
          "error",
          "bundle_file_inline_disallowed",
          source.path,
          reference.line,
          "Only freshly verified safe raster BundleFiles may use Markdown image syntax.",
        ));
      } else {
        valid.add(target.path);
      }
      if (!extensionMatches(target.path, target.mediaType)) {
        diagnostics.push(diagnostic(
          "warning",
          "bundle_file_reference_media_mismatch",
          source.path,
          reference.line,
          "BundleFile path extension does not match its detected media type.",
        ));
      }
    }
  }

  diagnostics.sort((left, right) =>
    (left.path < right.path ? -1 : left.path > right.path ? 1 : 0) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    (left.code < right.code ? -1 : left.code > right.code ? 1 : 0));
  const statusByPath = new Map<string, BundleFileReferenceStatus>();
  [...targets.keys()].sort().forEach((path) => {
    statusByPath.set(path, invalid.has(path) ? "invalid_reference" : valid.has(path) ? "referenced" : "unreferenced");
  });
  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    statusByPath,
  });
}
