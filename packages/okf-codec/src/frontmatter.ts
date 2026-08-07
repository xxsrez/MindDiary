import { parseDocument, stringify } from "yaml";

export interface ParsedFrontmatterBlock {
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly frontmatterSource: string;
  readonly headerSource: string;
  readonly body: string;
  readonly newline: "\n" | "\r\n";
}

export interface FrontmatterFailure {
  readonly code: "missing_frontmatter" | "unclosed_frontmatter" | "invalid_yaml";
  readonly message: string;
  readonly line?: number;
}

export type FrontmatterResult =
  | { readonly kind: "absent"; readonly newline: "\n" | "\r\n" }
  | { readonly kind: "failure"; readonly failure: FrontmatterFailure }
  | { readonly kind: "parsed"; readonly block: ParsedFrontmatterBlock };

function detectNewline(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseFrontmatter(text: string): FrontmatterResult {
  const newline = detectNewline(text);
  const opening = text.match(/^---(\r?\n)/u);
  if (!opening) return { kind: "absent", newline };

  const contentStart = opening[0].length;
  const closingPattern = /^---\r?$/gmu;
  closingPattern.lastIndex = contentStart;
  const closing = closingPattern.exec(text);
  if (!closing) {
    return {
      kind: "failure",
      failure: {
        code: "unclosed_frontmatter",
        message: "YAML frontmatter requires a closing '---' delimiter line.",
      },
    };
  }

  const frontmatterSource = text.slice(contentStart, closing.index);
  let bodyOffset = closing.index + closing[0].length;
  if (text[bodyOffset] === "\n") bodyOffset += 1;
  const headerSource = text.slice(0, bodyOffset);

  try {
    const document = parseDocument(frontmatterSource, {
      intAsBigInt: true,
      strict: true,
      uniqueKeys: true,
      version: "1.2",
    });
    if (document.errors.length > 0) {
      const first = document.errors[0];
      return {
        kind: "failure",
        failure: {
          code: "invalid_yaml",
          message: first?.message ?? "YAML frontmatter is invalid.",
          ...(first?.linePos?.[0]?.line === undefined
            ? {}
            : { line: first.linePos[0].line + 1 }),
        },
      };
    }
    const value: unknown = document.toJS({ maxAliasCount: 100 });
    if (!isMapping(value)) {
      return {
        kind: "failure",
        failure: {
          code: "invalid_yaml",
          message: "YAML frontmatter must contain a mapping.",
          line: 2,
        },
      };
    }
    return {
      kind: "parsed",
      block: {
        metadata: value,
        frontmatterSource,
        headerSource,
        body: text.slice(bodyOffset),
        newline,
      },
    };
  } catch (error) {
    return {
      kind: "failure",
      failure: {
        code: "invalid_yaml",
        message: error instanceof Error ? error.message : "YAML frontmatter is invalid.",
      },
    };
  }
}

export function renderFrontmatter(
  metadata: Readonly<Record<string, unknown>>,
  newline: "\n" | "\r\n",
): string {
  const yaml = stringify(metadata, { lineWidth: 0 }).trimEnd().replaceAll("\n", newline);
  return `---${newline}${yaml}${newline}---${newline}`;
}
