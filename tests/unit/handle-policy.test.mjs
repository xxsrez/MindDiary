import assert from "node:assert/strict";
import test from "node:test";
import {
  RESERVED_TOP_LEVEL_HANDLES,
  isReservedTopLevelHandle,
  isReservedTopLevelRoute,
  normalizeSpaceHandle,
  parseCanonicalSpaceHandle,
  verifiedSpaceHost,
} from "@mind-diary/domain";

test("canonical handle grammar accepts lowercase ASCII segments from 3 to 63 characters", () => {
  for (const handle of ["abc", "a0b", "research-notes", "a".repeat(63)]) {
    const result = parseCanonicalSpaceHandle(handle);
    assert.equal(result.kind, "valid");
    assert.equal(result.canonicalHandle, handle);
    assert.ok(Object.isFrozen(result));
  }
});

test("one percent decode plus NFKC identifies equivalent but non-canonical input", () => {
  const canonical = normalizeSpaceHandle("abc");
  const fullwidth = normalizeSpaceHandle("ａｂｃ");
  const percentEncoded = normalizeSpaceHandle("%61bc");
  const encodedFullwidth = normalizeSpaceHandle("%EF%BD%81%EF%BD%82%EF%BD%83");

  for (const result of [canonical, fullwidth, percentEncoded, encodedFullwidth]) {
    assert.equal(result.kind, "valid");
    assert.equal(result.canonicalHandle, "abc");
  }
  assert.equal(canonical.isCanonical, true);
  assert.equal(fullwidth.isCanonical, false);
  assert.equal(percentEncoded.isCanonical, false);
  assert.equal(encodedFullwidth.isCanonical, false);
  assert.deepEqual(parseCanonicalSpaceHandle("ａｂｃ"), {
    kind: "invalid",
    reason: "non_canonical",
  });
  assert.deepEqual(parseCanonicalSpaceHandle("%61bc"), {
    kind: "invalid",
    reason: "non_canonical",
  });
});

test("invalid grammar, separators, dot segments and controls are rejected", () => {
  const cases = new Map([
    ["ab", "invalid_grammar"],
    ["a".repeat(64), "invalid_grammar"],
    ["Abc", "invalid_grammar"],
    ["-abc", "invalid_grammar"],
    ["abc-", "invalid_grammar"],
    ["a--bc", "invalid_grammar"],
    ["café", "invalid_grammar"],
    ["a/b", "separator"],
    ["a\\b", "separator"],
    [".", "dot_segment"],
    ["..", "dot_segment"],
    ["a\u0000b", "control_character"],
    ["a\u0085b", "control_character"],
    ["a%00b", "control_character"],
    ["a%C2%85b", "control_character"],
    ["%2e%2e", "dot_segment"],
    ["a%2Fb", "encoded_separator"],
    ["a%5cb", "encoded_separator"],
    ["a%ZZb", "malformed_percent_encoding"],
  ]);
  for (const [input, reason] of cases) {
    assert.deepEqual(parseCanonicalSpaceHandle(input), { kind: "invalid", reason });
  }
  assert.deepEqual(parseCanonicalSpaceHandle(null), {
    kind: "invalid",
    reason: "invalid_type",
  });
});

test("double-encoded input is not decoded a second time", () => {
  assert.deepEqual(normalizeSpaceHandle("%2561bc"), {
    kind: "invalid",
    reason: "invalid_grammar",
  });
  assert.equal(normalizeSpaceHandle("%61bc").kind, "valid");
  assert.deepEqual(parseCanonicalSpaceHandle("%252fabc"), {
    kind: "invalid",
    reason: "invalid_grammar",
  });
});

test("reserved top-level routes and verified host namespaces are canonical", () => {
  assert.deepEqual(RESERVED_TOP_LEVEL_HANDLES, [
    "me",
    "mcp",
    "api",
    "admin",
    "settings",
    "public",
    "assets",
    "www",
  ]);
  for (const route of RESERVED_TOP_LEVEL_HANDLES) {
    assert.equal(isReservedTopLevelRoute(route), true);
    const parsed = parseCanonicalSpaceHandle(route);
    if (route === "me") {
      assert.deepEqual(parsed, { kind: "invalid", reason: "invalid_grammar" });
    } else {
      assert.equal(parsed.kind, "valid");
      assert.equal(isReservedTopLevelHandle(parsed.canonicalHandle), true);
    }
  }
  assert.equal(verifiedSpaceHost("mind.example"), "mind.example");
  for (const invalid of ["HTTPS://mind.example", "Mind.example", "mind.example/path", "-bad.example"]) {
    assert.throws(() => verifiedSpaceHost(invalid), TypeError);
  }
});
