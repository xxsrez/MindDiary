import test from "node:test";
import assert from "node:assert/strict";
import { assertAcceptanceTarget, ACCEPTANCE_ORIGIN, ACCEPTANCE_PROJECT } from "../../apps/mind-diary-acceptance/runtime-target.mjs";

const environment = { MIND_DIARY_PUBLIC_ORIGIN: ACCEPTANCE_ORIGIN, MD_ACCEPTANCE_PROJECT_ID: ACCEPTANCE_PROJECT };
test("acceptance target cannot be routed to ordinary UAT by request or configuration", () => {
  assert.doesNotThrow(() => assertAcceptanceTarget(new Request(ACCEPTANCE_ORIGIN), environment));
  assert.throws(() => assertAcceptanceTarget(new Request("https://mind-diary.example.invalid"), environment));
  assert.throws(() => assertAcceptanceTarget(new Request(ACCEPTANCE_ORIGIN), { ...environment, MIND_DIARY_PUBLIC_ORIGIN: "https://mind-diary.example.invalid" }));
  assert.throws(() => assertAcceptanceTarget(new Request(ACCEPTANCE_ORIGIN), { ...environment, MD_ACCEPTANCE_PROJECT_ID: "another-project" }));
  assert.throws(() => assertAcceptanceTarget(new Request(ACCEPTANCE_ORIGIN), { ...environment, MIND_DIARY_SERVICE_OPERATOR_PRINCIPAL_IDS: "real-user" }));
});
