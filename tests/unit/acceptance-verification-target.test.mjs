import test from "node:test";
import assert from "node:assert/strict";
import { assertAcceptanceVerificationTarget as verify } from "../../scripts/lib/acceptance-verification-target.mjs";

test("release verification rejects the synthetic target", () => {
  assert.throws(() => verify("appgprj_example8ca2ca9e5243cfd6", "https://mind-diary-acceptance.example.invalid", []));
  assert.throws(() => verify("appgprj_real", "https://mind-diary-acceptance.example.invalid", []));
  assert.doesNotThrow(() => verify("appgprj_real", "https://acceptance.invalid", []));
});

test("synthetic verification accepts only the exact example target and option", () => {
  const project = "appgprj_example8ca2ca9e5243cfd6";
  const origin = "https://mind-diary-acceptance.example.invalid";
  assert.doesNotThrow(() => verify(project, origin, ["--synthetic-ci"]));
  assert.throws(() => verify("appgprj_real", origin, ["--synthetic-ci"]));
  assert.throws(() => verify(project, "https://acceptance.invalid", ["--synthetic-ci"]));
  assert.throws(() => verify(project, origin, ["--unknown"]));
});
