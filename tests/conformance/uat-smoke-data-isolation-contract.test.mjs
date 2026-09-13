import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

const contract = JSON.parse(await readFile(
  new URL("tests/fixtures/uat-smoke-data-isolation/contract.v1.json", root),
  "utf8",
));
const profile = await readFile(
  new URL("docs/operations/ship-work-release-profile.md", root),
  "utf8",
);
const autonomousAcceptance = await readFile(
  new URL("docs/operations/autonomous-acceptance.md", root),
  "utf8",
);
const acceptanceClient = await readFile(
  new URL("scripts/lib/acceptance-client.mjs", root),
  "utf8",
);
const acceptanceFixture = await readFile(
  new URL("scripts/lib/acceptance-fixture.mjs", root),
  "utf8",
);
const acceptanceSuite = await readFile(
  new URL("scripts/run-acceptance-suite.mjs", root),
  "utf8",
);

test("UAT smoke target classes forbid writes to existing user Minds", () => {
  assert.equal(contract.$schema, "mind-diary/uat-smoke-data-isolation/v1");
  assert.equal(contract.version, 1);
  assert.deepEqual(Object.keys(contract.targetClasses), [
    "existing-user-mind",
    "run-owned-ordinary-mind",
    "run-owned-personal-mind",
  ]);
  assert.equal(contract.targetClasses["existing-user-mind"].mutation, "forbidden");
  assert.equal(contract.targetClasses["existing-user-mind"].cleanup, "forbidden");
  assert.equal(
    contract.targetClasses["run-owned-personal-mind"].principal,
    "disposable-isolated-test-principal",
  );
  assert.match(profile, /existing-user-mind[\s\S]*Запись, удаление[\s\S]*запрещены/u);
  assert.match(profile, /run-owned-ordinary-mind[\s\S]*фиксируется полная baseline inventory/u);
  assert.match(profile, /run-owned-personal-mind[\s\S]*Personal Mind существующего пользователя/u);
  assert.match(autonomousAcceptance, /existing-user-mind[\s\S]*read-only/u);
});

test("mutation receipts and the autonomous harness require exact baseline restoration", () => {
  assert.deepEqual(contract.publicMutationReceipt.requiredFields, [
    "run_id",
    "target_class",
    "baseline_inventory_sha256_before",
    "baseline_inventory_sha256_after",
    "cleanup_status",
  ]);
  assert.equal(contract.publicMutationReceipt.passingCleanupStatus, "baseline_restored");
  assert.equal(contract.publicMutationReceipt.requireEqualInventoryHashes, true);
  assert.equal(contract.publicMutationReceipt.contentBodies, "forbidden");
  assert.equal(contract.publicMutationReceipt.privateMindNames, "forbidden");

  assert.match(acceptanceClient, /x-md-acceptance-run/u);
  assert.match(acceptanceClient, /\/_acceptance\/runs\/\$\{this\.state\.run\.run_id\}\/cleanup/u);
  assert.match(acceptanceFixture, /create:shared/u);
  assert.match(acceptanceFixture, /writeSharedContent = true/u);
  assert.match(acceptanceFixture, /for \(const mind of writeSharedContent \? \["\/me", `\/\$\{handle\}`\] : \["\/me"\]\)/u);
  assert.match(acceptanceSuite, /assert\.deepEqual\(await lastClient\.control\("\/_acceptance\/inventory"\), baseline\)/u);
});
