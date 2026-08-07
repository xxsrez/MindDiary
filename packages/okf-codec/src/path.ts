import type { OkfDiagnostic } from "./types.js";

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const ENCODED_SEPARATOR = /%(?:2f|5c)/iu;

function envelopeError(
  path: string,
  code: string,
  message: string,
): OkfDiagnostic {
  return {
    severity: "error",
    category: "mind-diary-envelope",
    source: "mind-diary-mvp",
    code,
    path,
    message,
  };
}

export function validateCanonicalOkfPath(path: string): readonly OkfDiagnostic[] {
  const diagnostics: OkfDiagnostic[] = [];

  if (path.length === 0) {
    return [envelopeError(path, "empty_path", "Content path must not be empty.")];
  }
  if (path.startsWith("/")) {
    diagnostics.push(
      envelopeError(path, "absolute_path", "Content path must be bundle-relative."),
    );
  }
  if (path.includes("\\")) {
    diagnostics.push(
      envelopeError(path, "backslash_path", "Content path must use '/' separators."),
    );
  }
  if (CONTROL_CHARACTER.test(path)) {
    diagnostics.push(
      envelopeError(
        path,
        "control_character_in_path",
        "Content path must not contain control characters.",
      ),
    );
  }
  if (ENCODED_SEPARATOR.test(path)) {
    diagnostics.push(
      envelopeError(
        path,
        "encoded_separator",
        "Content path must not contain percent-encoded separators.",
      ),
    );
  }

  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    diagnostics.push(
      envelopeError(path, "empty_path_segment", "Content path has an empty segment."),
    );
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    diagnostics.push(
      envelopeError(
        path,
        "dot_path_segment",
        "Content path must not contain '.' or '..' segments.",
      ),
    );
  }
  if (!path.endsWith(".md")) {
    diagnostics.push(
      envelopeError(
        path,
        path.toLowerCase().endsWith(".zip")
          ? "archive_transport_not_supported"
          : "non_markdown_transport_not_supported",
        path.toLowerCase().endsWith(".zip")
          ? "ZIP transport is outside the Mind Diary MVP."
          : "The Mind Diary MVP accepts canonical '.md' files only.",
      ),
    );
  }

  return diagnostics;
}

export function okfFileKind(path: string): "concept" | "index" | "log" {
  const name = path.split("/").at(-1);
  if (name === "index.md") return "index";
  if (name === "log.md") return "log";
  return "concept";
}
