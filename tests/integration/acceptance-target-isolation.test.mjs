import test from "node:test";
import assert from "node:assert/strict";
import { assertAcceptanceTarget, ACCEPTANCE_ORIGIN, ACCEPTANCE_PROJECT } from "../../apps/mind-diary-acceptance/runtime-target.mjs";
import { handleAcceptanceSession } from "../../apps/mind-diary-acceptance/session-http.mjs";

const environment = { MIND_DIARY_PUBLIC_ORIGIN: ACCEPTANCE_ORIGIN, MD_ACCEPTANCE_PROJECT_ID: ACCEPTANCE_PROJECT };
test("acceptance target cannot be routed to ordinary UAT by request or configuration", () => {
  assert.doesNotThrow(() => assertAcceptanceTarget(new Request(ACCEPTANCE_ORIGIN), environment));
  assert.throws(() => assertAcceptanceTarget(new Request("https://mind-diary.example.invalid"), environment));
  assert.throws(() => assertAcceptanceTarget(new Request(ACCEPTANCE_ORIGIN), { ...environment, MIND_DIARY_PUBLIC_ORIGIN: "https://mind-diary.example.invalid" }));
  assert.throws(() => assertAcceptanceTarget(new Request(ACCEPTANCE_ORIGIN), { ...environment, MD_ACCEPTANCE_PROJECT_ID: "another-project" }));
  assert.throws(() => assertAcceptanceTarget(new Request(ACCEPTANCE_ORIGIN), { ...environment, MIND_DIARY_SERVICE_OPERATOR_PRINCIPAL_IDS: "real-user" }));
});

test("object metadata inventory requires controller authority and only accepts an opaque cursor", async () => {
  const key = "a".repeat(43);
  const calls = [];
  const read = (url, authorization = `Bearer ${key}`) => handleAcceptanceSession(
    new Request(url, { headers: { authorization } }), {}, key,
    undefined, undefined, undefined, undefined,
    async (cursor) => { calls.push(cursor); return { objects: [], next_cursor: null, complete: true }; },
  );
  assert.equal((await read(`${ACCEPTANCE_ORIGIN}/_acceptance/object-inventory`, "Bearer " + "b".repeat(43))).status, 401);
  assert.equal((await read(`${ACCEPTANCE_ORIGIN}/_acceptance/object-inventory?cursor=`)).status, 400);
  assert.equal((await read(`${ACCEPTANCE_ORIGIN}/_acceptance/object-inventory?other=value`)).status, 400);
  assert.deepEqual(calls, []);
  const response = await read(`${ACCEPTANCE_ORIGIN}/_acceptance/object-inventory?cursor=next-page`);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["next-page"]);
  assert.deepEqual(await response.json(), { objects: [], next_cursor: null, complete: true });
});

test("run orphan recovery requires controller authority before invoking any recovery work", async () => {
  const key = "a".repeat(43);
  const calls = [];
  const path = `${ACCEPTANCE_ORIGIN}/_acceptance/runs/41d3bca2-40b3-4dc0-b8f5-d9fe7e97bbed/orphan-cleanup`;
  const invoke = (authorization) => handleAcceptanceSession(
    new Request(path, { method: "POST", headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ space_id: "space_test", import_id: "import_test", dry_run: true }) }),
    {}, key, undefined, undefined, undefined, undefined, undefined,
    async (runId, input) => { calls.push({ runId, input }); return { state: "cleaning" }; },
  );
  assert.equal((await invoke("Bearer " + "b".repeat(43))).status, 401);
  assert.deepEqual(calls, []);
  assert.equal((await invoke(`Bearer ${key}`)).status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.dry_run, true);
});
