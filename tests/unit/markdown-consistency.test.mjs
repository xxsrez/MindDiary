import assert from "node:assert/strict";
import test from "node:test";

import { analyzeMarkdownConsistency } from "@mind-diary/application-content";

test("Markdown consistency resolves structural inline, reference and Unicode section targets", () => {
  const result = analyzeMarkdownConsistency({
    markdown: [
      {
        path: "index.md",
        text: [
          "---",
          'okf_version: "0.2"',
          "---",
          "",
          "# Главная",
          "",
          "[Раздел](docs/guide.md#привет-мир)",
          "[Повтор][duplicate]",
          "[Скобки](docs/scan\\(1\\).md)",
          "`[Не ссылка](missing-inline-code.md)`",
          "```md",
          "[Не ссылка](missing-fence.md)",
          "```",
          "",
          "[duplicate]: docs/guide.md#привет-мир-1",
        ].join("\n"),
      },
      {
        path: "docs/guide.md",
        text: "---\ntype: Reference\n---\n\n# Привет, мир!\n\n# Привет, мир!\n",
      },
      {
        path: "docs/scan(1).md",
        text: "---\ntype: Reference\n---\n\n# Scan\n",
      },
    ],
  });

  assert.deepEqual(
    result.diagnostics.map(({ code, path, line, target, blocksCommit }) => ({
      code, path, line, target, blocksCommit,
    })),
    [{
      code: "duplicate_heading",
      path: "docs/guide.md",
      line: 7,
      target: "#привет-мир-1",
      blocksCommit: false,
    }],
  );
});

test("Markdown consistency separates missing files, missing sections and unchecked targets", () => {
  const result = analyzeMarkdownConsistency({
    currentSpaceId: "space-1",
    currentRevisionId: "revision-1",
    availablePaths: ["index.md", "docs/existing.md", "assets/evidence.pdf"],
    markdown: [
      {
        path: "index.md",
        text: [
          "# Index",
          "[Missing](docs/missing.md)",
          "[Section](docs/existing.md#absent)",
          "[External](https://example.invalid/evidence)",
          "[Escape](../outside.md)",
        ].join("\n"),
        sourceReferences: [
          "docs/existing.md#evidence",
          "okf://spaces/space-2/revisions/revision-9/entries/docs/remote.md",
          "https://example.invalid/source",
        ],
      },
      {
        path: "docs/existing.md",
        text: "---\ntype: Reference\n---\n\n# Evidence\n",
      },
    ],
  });

  assert.deepEqual(
    result.consistencyErrors.map(({ code, line }) => [code, line]),
    [
      ["markdown_file_missing", 2],
      ["markdown_section_missing", 3],
      ["markdown_target_invalid", 5],
    ],
  );
  assert.deepEqual(
    result.advisories.map(({ code, field }) => [code, field]),
    [
      ["source_check_unsupported", "sources"],
      ["source_check_unsupported", "sources"],
      ["external_link_unchecked", undefined],
    ],
  );
  assert.equal(result.advisories.every((issue) => issue.blocksCommit === false), true);
});

test("navigation reachability follows cycles without treating them as errors", () => {
  const result = analyzeMarkdownConsistency({
    markdown: [
      { path: "index.md", text: "# Index\n\n[A](a.md)\n" },
      { path: "a.md", text: "---\ntype: Reference\n---\n\n# A\n\n[B](b.md)\n" },
      { path: "b.md", text: "---\ntype: Reference\n---\n\n# B\n\n[A](a.md)\n" },
      { path: "orphan.md", text: "---\ntype: Reference\n---\n\n# Orphan\n" },
      { path: "raw/source.md", text: "# Raw\n" },
    ],
  });

  assert.deepEqual(
    result.diagnostics.map(({ code, path }) => [code, path]),
    [["markdown_unreachable_from_root", "orphan.md"]],
  );
});

test("setext headings and missing reference definitions are checked structurally", () => {
  const result = analyzeMarkdownConsistency({
    markdown: [
      {
        path: "index.md",
        text: "Root\n====\n\n[Setext](guide.md#section-name)\n[Broken][missing-label]\n",
      },
      {
        path: "guide.md",
        text: "---\ntype: Reference\n---\n\nSection name\n------------\n",
      },
    ],
  });
  assert.deepEqual(
    result.diagnostics.map(({ code, line, target }) => [code, line, target]),
    [["markdown_reference_definition_missing", 5, "missing-label"]],
  );
});
