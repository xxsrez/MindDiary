import assert from "node:assert/strict";
import test from "node:test";
import {
  OKF_0_2_CODEC,
  OKF_AUDITED_SPEC_REVISION,
  OKF_VERSION,
  encodeOkfFile,
  parseOkfFile,
  readVerifiedEntries,
  resolveOkfCodec,
  renderOkfFile,
  updateOkfConcept,
  validateCanonicalOkfPath,
  validateOkfBundle,
} from "@mind-diary/okf-codec";

function codes(result, category) {
  return result.diagnostics
    .filter((issue) => issue.category === category)
    .map((issue) => issue.code);
}

test("version boundary resolves only the audited OKF 0.2 codec", () => {
  assert.equal(OKF_VERSION, "0.2");
  assert.equal(
    OKF_AUDITED_SPEC_REVISION,
    "3fcbb9f828c2f23d109c855ee403c3a4c81f3a96",
  );
  assert.equal(resolveOkfCodec("0.2"), OKF_0_2_CODEC);
  assert.equal(resolveOkfCodec("0.1"), null);
  assert.equal(resolveOkfCodec("0.3"), null);
});

test("canonical MVP paths reject traversal, separators and non-Markdown transport", () => {
  assert.deepEqual(validateCanonicalOkfPath("concepts/valid.md"), []);
  for (const [path, code] of [
    ["/absolute.md", "absolute_path"],
    ["concepts/../escape.md", "dot_path_segment"],
    ["concepts\\windows.md", "backslash_path"],
    ["concepts//empty.md", "empty_path_segment"],
    ["concepts%2Fhidden.md", "encoded_separator"],
    ["bundle.zip", "archive_transport_not_supported"],
    ["asset.png", "non_markdown_transport_not_supported"],
  ]) {
    assert.ok(validateCanonicalOkfPath(path).some((issue) => issue.code === code));
  }
});

test("source bytes for concepts and reserved files render without incidental rewrites", () => {
  const sources = [
    {
      path: "concept.md",
      text: "---\r\ntype: Reference\r\n---\r\n\r\n# Concept\r\n",
    },
    {
      path: "index.md",
      text: "---\r\nokf_version: \"0.2\"\r\n---\r\n\r\n# Index\r\n",
    },
    {
      path: "nested/index.md",
      text: "# Nested index\r\n",
    },
    {
      path: "log.md",
      text: "# Log\r\n\r\n## 2026-08-06\r\n\r\n- Created.\r\n",
    },
  ];
  for (const source of sources) {
    const parsed = parseOkfFile({
      path: source.path,
      bytes: new TextEncoder().encode(source.text),
    });
    assert.equal(parsed.valid, true);
    assert.ok(parsed.file);
    assert.deepEqual(renderOkfFile(parsed.file), source);
    assert.deepEqual(
      [...encodeOkfFile(parsed.file).bytes],
      [...new TextEncoder().encode(source.text)],
    );
  }
});

test("unknown type and nested extension survive read-modify-write without reinterpretation", () => {
  const source = {
    path: "concepts/future.md",
    text: `---\ntype: Future Knowledge Type\nverified: { by: human:reviewer, at: 2026-08-06T12:00:00Z }\nproducer_extension:\n  nested: [one, { two: 2 }]\n---\n\n# Before\n`,
  };
  const parsed = parseOkfFile(source);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.file?.kind, "concept");
  assert.equal(parsed.file?.typeSemantics, "opaque");
  assert.deepEqual(readVerifiedEntries(parsed.file.frontmatter), [
    { by: "human:reviewer", at: "2026-08-06T12:00:00Z" },
  ]);

  const rendered = updateOkfConcept(parsed.file, {
    setFields: { title: "Changed without migration" },
  });
  const reparsed = parseOkfFile(rendered);
  assert.equal(reparsed.valid, true);
  assert.equal(reparsed.file?.kind, "concept");
  assert.equal(reparsed.file?.okfType, "Future Knowledge Type");
  assert.deepEqual(reparsed.file?.frontmatter.producer_extension, {
    nested: ["one", { two: 2n }],
  });
  assert.equal(reparsed.file?.frontmatter.title, "Changed without migration");
  assert.deepEqual(source, {
    path: "concepts/future.md",
    text: source.text,
  });
});

test("arbitrary-size extension integers survive read-modify-write exactly", () => {
  const exactInteger = "900719925474099312345";
  const parsed = parseOkfFile({
    path: "concepts/exact-integer.md",
    text: `---\ntype: Numeric Extension\nstatus: stable\nbig: ${exactInteger}\n---\n\n# Exact integer\n`,
  });
  assert.equal(parsed.valid, true);
  assert.equal(parsed.diagnostics.length, 0);
  assert.equal(parsed.file?.kind, "concept");
  assert.equal(parsed.file?.frontmatter.big, BigInt(exactInteger));

  const rendered = updateOkfConcept(parsed.file, {
    setFields: { title: "Changed without numeric coercion" },
  });
  assert.match(rendered.text, new RegExp(`^big: ${exactInteger}$`, "m"));

  const reparsed = parseOkfFile(rendered);
  assert.equal(reparsed.valid, true);
  assert.equal(reparsed.file?.kind, "concept");
  assert.equal(reparsed.file?.frontmatter.big, BigInt(exactInteger));
});

test("Attested Computation remains an opaque document contract", () => {
  const parsed = parseOkfFile({
    path: "computations/value.md",
    text: `---\ntype: Attested Computation\nruntime: future-runtime\nexecutor:\n  resource: https://invalid.example/must-not-run\nattester:\n  resource: scripts/must-not-run.py\nunknown_contract: keep-me\n---\n\n# Computation\n\n\`\`\`text\nvalue()\n\`\`\`\n`,
  });
  assert.equal(parsed.valid, true);
  assert.equal(parsed.file?.kind, "concept");
  assert.equal(parsed.file?.typeSemantics, "opaque");
  assert.equal(parsed.file?.sourceText.includes("must-not-run"), true);
  assert.equal(parsed.file?.frontmatter.unknown_contract, "keep-me");
});

test("optional-family defects and broken links are quality warnings, not conformance errors", () => {
  const result = validateOkfBundle([
    {
      path: "concepts/advisory.md",
      text: `---\ntype: Advisory\nstatus: reviewed\ngenerated: malformed\nsources: malformed\nverified: malformed\n---\n\nSee [missing](missing.md).\n`,
    },
  ]);
  assert.equal(result.valid, true);
  assert.equal(result.conforms, true);
  assert.equal(result.conformanceErrors.length, 0);
  assert.equal(result.envelopeErrors.length, 0);
  assert.deepEqual(
    result.qualityWarnings.map((issue) => issue.code).sort(),
    [
      "broken_cross_link",
      "invalid_generated_signal",
      "invalid_lifecycle_status",
      "invalid_sources_signal",
      "invalid_verified_signal",
    ],
  );
});

test("invalid UTF-8 and ZIP bytes are envelope failures with no parsed final state", () => {
  const invalidUtf8 = parseOkfFile({
    path: "concepts/invalid.md",
    bytes: Uint8Array.from([0xc3, 0x28]),
  });
  assert.equal(invalidUtf8.file, null);
  assert.deepEqual(codes(invalidUtf8, "mind-diary-envelope"), ["invalid_utf8"]);

  const zip = parseOkfFile({
    path: "concealed.md",
    bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00]),
  });
  assert.equal(zip.file, null);
  assert.deepEqual(codes(zip, "mind-diary-envelope"), [
    "archive_transport_not_supported",
  ]);
});

test("only top-level service metadata is denied; nested extension keys stay opaque", () => {
  const deniedSource = {
    path: "concepts/denied.md",
    text: `---\ntype: Reference\nacl: [reader]\nrevision_id: revision-secret\n---\n\n# Denied\n`,
  };
  const before = structuredClone(deniedSource);
  const denied = validateOkfBundle([deniedSource]);
  assert.equal(denied.valid, false);
  assert.equal(denied.conforms, true);
  assert.equal(denied.envelopeErrors.length, 2);
  assert.deepEqual(
    denied.envelopeErrors.map((issue) => issue.field).sort(),
    ["acl", "revision_id"],
  );
  assert.deepEqual(deniedSource, before);

  const nested = parseOkfFile({
    path: "concepts/domain-schema.md",
    text: `---\ntype: Domain Schema\nproducer_extension:\n  role: narrator\n  visibility: public\n  acl: [reader]\n---\n\n# Domain schema\n`,
  });
  assert.equal(nested.valid, true);
  assert.equal(nested.file?.kind, "concept");
  const rendered = updateOkfConcept(nested.file, {
    setFields: { title: "Opaque domain schema" },
  });
  const reparsed = parseOkfFile(rendered);
  assert.equal(reparsed.valid, true);
  assert.equal(reparsed.file?.kind, "concept");
  assert.deepEqual(reparsed.file?.frontmatter.producer_extension, {
    role: "narrator",
    visibility: "public",
    acl: ["reader"],
  });
});
