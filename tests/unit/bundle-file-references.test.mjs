import assert from "node:assert/strict";
import test from "node:test";

import { analyzeBundleFileReferences } from "@mind-diary/application-content";

test("BundleFile references resolve exact relative paths and emit deterministic diagnostics", () => {
  const result = analyzeBundleFileReferences({
    markdown: [{
      path: "docs/readme.md",
      text: [
        "![Map](../assets/map.png#detail)",
        "[Archive][archive]",
        "![Manual](../assets/manual.pdf)",
        "[Missing](../assets/missing.zip)",
        "[Escape](../../outside.zip)",
        "[Query](../assets/map.png?raw=1)",
        "[External](https://example.test/map.png)",
        "`![Ignored](../assets/manual.pdf)`",
        "",
        "[archive]: ../assets/archive.zip",
      ].join("\n"),
    }],
    bundleFiles: [
      { path: "assets/map.png", mediaType: "image/png" },
      { path: "assets/manual.pdf", mediaType: "application/pdf" },
      { path: "assets/archive.zip", mediaType: "application/zip" },
    ],
  });

  assert.deepEqual(
    result.diagnostics.map(({ code, line }) => [code, line]),
    [
      ["bundle_file_inline_disallowed", 3],
      ["bundle_file_reference_missing", 4],
      ["bundle_file_reference_escape", 5],
      ["bundle_file_reference_escape", 6],
    ],
  );
  assert.equal(result.statusByPath.get("assets/map.png"), "referenced");
  assert.equal(result.statusByPath.get("assets/manual.pdf"), "invalid_reference");
  assert.equal(result.statusByPath.get("assets/archive.zip"), "referenced");
});

test("BundleFile reference definitions decode each segment once and media warnings stay non-blocking", () => {
  const result = analyzeBundleFileReferences({
    markdown: [{
      path: "index.md",
      text: "[download][asset]\n\n[asset]: assets/report%20final.bin",
    }],
    bundleFiles: [{ path: "assets/report final.bin", mediaType: "application/pdf" }],
  });
  assert.equal(result.statusByPath.get("assets/report final.bin"), "referenced");
  assert.deepEqual(result.diagnostics.map(({ severity, code }) => [severity, code]), [
    ["warning", "bundle_file_reference_media_mismatch"],
  ]);
});

test("shortcut references are resolved and external HTTPS scheme matching is case-insensitive", () => {
  const result = analyzeBundleFileReferences({
    markdown: [{
      path: "concepts/example.md",
      text: [
        "[diagram]: ../assets/diagram.png",
        "[external]: HTTPS://example.com/image.png",
        "",
        "![diagram]",
        "[external]",
      ].join("\n"),
    }],
    bundleFiles: [{ path: "assets/diagram.png", mediaType: "image/png" }],
  });
  assert.equal(result.statusByPath.get("assets/diagram.png"), "referenced");
  assert.deepEqual(result.diagnostics, []);
});

test("inline destinations preserve balanced or escaped parentheses in canonical paths", () => {
  const result = analyzeBundleFileReferences({
    markdown: [{
      path: "concepts/example.md",
      text: [
        "![Balanced](../assets/scan(1).png)",
        "![Escaped](../assets/scan\\(2\\).png)",
      ].join("\n"),
    }],
    bundleFiles: [
      { path: "assets/scan(1).png", mediaType: "image/png" },
      { path: "assets/scan(2).png", mediaType: "image/png" },
    ],
  });
  assert.equal(result.statusByPath.get("assets/scan(1).png"), "referenced");
  assert.equal(result.statusByPath.get("assets/scan(2).png"), "referenced");
  assert.deepEqual(result.diagnostics, []);
});

test("Markdown image syntax falls back when a raster advisory type fails fresh preview verification", () => {
  const result = analyzeBundleFileReferences({
    markdown: [{
      path: "concepts/example.md",
      text: "![Spoofed](../assets/spoofed.png)",
    }],
    bundleFiles: [{
      path: "assets/spoofed.png",
      mediaType: "image/png",
      inlineEligible: false,
    }],
  });
  assert.equal(result.statusByPath.get("assets/spoofed.png"), "invalid_reference");
  assert.deepEqual(result.diagnostics.map(({ code }) => code), [
    "bundle_file_inline_disallowed",
  ]);
});

test("format-neutral advisory extensions produce deterministic mismatch warnings", () => {
  const result = analyzeBundleFileReferences({
    markdown: [{
      path: "index.md",
      text: [
        "[Document](assets/document.bin)",
        "[Notebook](assets/notebook.json)",
        "[Data](assets/data.txt)",
      ].join("\n"),
    }],
    bundleFiles: [
      {
        path: "assets/document.bin",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      { path: "assets/notebook.json", mediaType: "application/x-ipynb+json" },
      { path: "assets/data.txt", mediaType: "text/csv" },
    ],
  });
  assert.deepEqual(result.diagnostics.map(({ code, path }) => [code, path]), [
    ["bundle_file_reference_media_mismatch", "index.md"],
    ["bundle_file_reference_media_mismatch", "index.md"],
    ["bundle_file_reference_media_mismatch", "index.md"],
  ]);
});
