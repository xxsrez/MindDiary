import type { UtcInstant } from "@mind-diary/domain";
import {
  parseOkfFile,
  type OkfDiagnostic,
} from "@mind-diary/okf-codec";

export interface LogEntryMaterializationRequest {
  readonly path: string;
  readonly text: string;
  readonly category: string;
  readonly message: string;
  readonly serverAssignedAt: UtcInstant;
}

export type LogEntryMaterializationResult =
  | { readonly kind: "materialized"; readonly text: string }
  | {
      readonly kind: "invalid_log";
      readonly diagnostics: readonly OkfDiagnostic[];
    };

interface LogDateHeading {
  readonly date: string;
  readonly start: number;
  readonly afterLine: number;
  readonly hasLineEnding: boolean;
}

const LOG_DATE_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/u;

function logDateHeadings(text: string): readonly LogDateHeading[] {
  const headings: LogDateHeading[] = [];
  let start = 0;
  while (start < text.length) {
    const nextLineFeed = text.indexOf("\n", start);
    const afterLine = nextLineFeed === -1 ? text.length : nextLineFeed + 1;
    const contentEnd =
      nextLineFeed === -1
        ? text.length
        : nextLineFeed > start && text[nextLineFeed - 1] === "\r"
          ? nextLineFeed - 1
          : nextLineFeed;
    const match = LOG_DATE_HEADING.exec(text.slice(start, contentEnd));
    if (match?.[1] !== undefined) {
      headings.push(
        Object.freeze({
          date: match[1],
          start,
          afterLine,
          hasLineEnding: nextLineFeed !== -1,
        }),
      );
    }
    start = afterLine;
  }
  return Object.freeze(headings);
}

function leadingBlankLinesLength(text: string): number {
  let offset = 0;
  while (offset < text.length) {
    const nextLineFeed = text.indexOf("\n", offset);
    if (nextLineFeed === -1) return offset;
    const contentEnd =
      nextLineFeed > offset && text[nextLineFeed - 1] === "\r"
        ? nextLineFeed - 1
        : nextLineFeed;
    if (!/^[\t ]*$/u.test(text.slice(offset, contentEnd))) return offset;
    offset = nextLineFeed + 1;
  }
  return offset;
}

function withBlankLineBefore(text: string, newline: "\n" | "\r\n"): string {
  if (text.length === 0 || /(?:\r\n|\n)[\t ]*(?:\r\n|\n)$/u.test(text)) {
    return text;
  }
  if (/(?:\r\n|\n)$/u.test(text)) return `${text}${newline}`;
  return `${text}${newline}${newline}`;
}

function renderLogEntry(category: string, message: string): string {
  return `- **${category}**: ${message}`;
}

/**
 * Materializes Mind Diary's service-level semantic log operation. This is not
 * an OKF operation: the codec only establishes that the input/output are
 * canonical OKF log files.
 */
export function materializeLogEntry(
  request: Readonly<LogEntryMaterializationRequest>,
): LogEntryMaterializationResult {
  const parsed = parseOkfFile({ path: request.path, text: request.text });
  if (!parsed.valid || parsed.file?.kind !== "log") {
    return Object.freeze({
      kind: "invalid_log",
      diagnostics: Object.freeze([...parsed.diagnostics]),
    });
  }

  const headings = logDateHeadings(parsed.file.sourceText);
  if (headings.length === 0) {
    return Object.freeze({
      kind: "invalid_log",
      diagnostics: Object.freeze([...parsed.diagnostics]),
    });
  }

  const date = request.serverAssignedAt.slice(0, 10);
  const entry = renderLogEntry(request.category, request.message);
  const existingGroup = headings.find((heading) => heading.date === date);
  let text: string;

  if (existingGroup !== undefined) {
    const suffix = parsed.file.sourceText.slice(existingGroup.afterLine);
    const blankLinesLength = leadingBlankLinesLength(suffix);
    const separator =
      blankLinesLength > 0
        ? suffix.slice(0, blankLinesLength)
        : existingGroup.hasLineEnding
          ? parsed.file.newline
          : `${parsed.file.newline}${parsed.file.newline}`;
    text = `${parsed.file.sourceText.slice(0, existingGroup.afterLine)}${separator}${entry}${parsed.file.newline}${suffix.slice(blankLinesLength)}`;
  } else {
    const nextOlderGroup = headings.find((heading) => heading.date < date);
    const insertionPoint = nextOlderGroup?.start ?? parsed.file.sourceText.length;
    const prefix = withBlankLineBefore(
      parsed.file.sourceText.slice(0, insertionPoint),
      parsed.file.newline,
    );
    const suffix = parsed.file.sourceText.slice(insertionPoint);
    const group = `## ${date}${parsed.file.newline}${parsed.file.newline}${entry}${parsed.file.newline}${suffix.length === 0 ? "" : parsed.file.newline}`;
    text = `${prefix}${group}${suffix}`;
  }

  const materialized = parseOkfFile({ path: request.path, text });
  if (!materialized.valid || materialized.file?.kind !== "log") {
    return Object.freeze({
      kind: "invalid_log",
      diagnostics: Object.freeze([...materialized.diagnostics]),
    });
  }
  return Object.freeze({ kind: "materialized", text });
}
