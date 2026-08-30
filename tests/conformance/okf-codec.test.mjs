import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import test from "node:test";
import {
  validateOkfBundle,
  validateOkfProducerBundle,
} from "@mind-diary/okf-codec";

const root = resolve(import.meta.dirname, "../..");

async function collectFiles(directory, found = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(path, found);
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

async function loadBundle(name) {
  const bundleRoot = resolve(root, "tests", "fixtures", "okf", name);
  const paths = (await collectFiles(bundleRoot)).sort();
  return Promise.all(
    paths.map(async (path) => ({
      path: relative(bundleRoot, path).replaceAll("\\", "/"),
      bytes: await readFile(path),
    })),
  );
}

test("checked-in strict fixtures validate as complete bundles", async () => {
  for (const name of ["basic", "round-trip"]) {
    const result = validateOkfBundle(await loadBundle(name));
    assert.equal(result.valid, true, `${name}: ${JSON.stringify(result.diagnostics)}`);
    assert.equal(result.conforms, true);
    assert.equal(result.qualityWarnings.length, 0);
    assert.equal(
      validateOkfProducerBundle(await loadBundle(name)).producerValid,
      true,
    );
    assert.ok(result.files.some((file) => file.path === "index.md"));
    assert.ok(result.files.some((file) => file.path === "log.md"));
  }
});

test("generated producer bundle rejects advisory temporal defects without rejecting consumer round-trip", () => {
  const files = [{
    path: "generated.md",
    text: `---
type: Generated Knowledge
generated: { by: process:mind-diary, at: 2026-08-30T21:00:00 }
---

# Generated
`,
  }];
  const consumer = validateOkfBundle(files);
  const producer = validateOkfProducerBundle(files);
  assert.equal(consumer.valid, true);
  assert.equal(consumer.conforms, true);
  assert.equal(producer.producerValid, false);
  assert.deepEqual(
    producer.qualityWarnings.map((issue) => issue.code),
    ["invalid_generated_signal"],
  );
});

test("full-bundle validation catches invalid content outside a wiki subtree", () => {
  const result = validateOkfBundle([
    { path: "wiki/good.md", text: "---\ntype: Reference\n---\n\n# Good\n" },
    { path: "raw/outside-wiki.md", text: "# Missing frontmatter\n" },
  ]);
  assert.equal(result.valid, false);
  assert.deepEqual(
    result.conformanceErrors.map((issue) => [issue.path, issue.code]),
    [["raw/outside-wiki.md", "missing_frontmatter"]],
  );
});

test("OKF conformance is permissive for unknown types, fields and a missing root index", () => {
  const result = validateOkfBundle([
    {
      path: "future.md",
      text: "---\ntype: Type Added After This Codec\nunknown_family: { shape: future }\n---\n",
    },
  ]);
  assert.equal(result.valid, true);
  assert.equal(result.conformanceErrors.length, 0);
  assert.equal(result.qualityWarnings.length, 0);
  assert.equal(result.files[0]?.kind, "concept");
  assert.equal(result.files[0]?.typeSemantics, "opaque");
});

test("concept and reserved-file structure failures stay OKF conformance diagnostics", () => {
  const result = validateOkfBundle([
    { path: "missing-type.md", text: "---\ntitle: Missing type\n---\n" },
    {
      path: "nested/index.md",
      text: "---\nokf_version: \"0.2\"\n---\n\n# Invalid nested index\n",
    },
    {
      path: "log.md",
      text: "# Log\n\n## 2026-02-30\n\n- Invalid date.\n",
    },
  ]);
  assert.equal(result.valid, false);
  assert.equal(result.envelopeErrors.length, 0);
  assert.deepEqual(
    result.conformanceErrors.map((issue) => issue.code).sort(),
    ["invalid_log_date_heading", "missing_type", "nested_index_frontmatter"],
  );
});

test("unsupported declared version is an MVP envelope failure, not semantic reinterpretation", () => {
  const result = validateOkfBundle([
    {
      path: "index.md",
      text: "---\nokf_version: \"0.1\"\n---\n\n# Legacy declaration\n",
    },
    { path: "concept.md", text: "---\ntype: Reference\n---\n" },
  ]);
  assert.equal(result.conforms, true);
  assert.equal(result.valid, false);
  assert.deepEqual(result.envelopeErrors.map((issue) => issue.code), [
    "unsupported_okf_version",
  ]);
  assert.equal(result.files.find((file) => file.path === "index.md")?.sourceText.includes("0.1"), true);
});
