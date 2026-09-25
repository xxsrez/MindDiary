import assert from "node:assert/strict";
import test from "node:test";
import { exportJobExpiry } from "../../apps/mind-diary-acceptance/export-job-expiry.mjs";

test("export expiry fixture refuses foreign Product principals before arming a hold", async () => {
  const instant = Date.parse("2026-09-25T04:00:00.000Z");
  const principalId = "principal_run_owner";
  let mutations = 0;
  const store = {
    run: async () => ({ profile: "operator", state: "active", expires_at: instant + 60_000,
      actors: [{ principal_id: principalId }, { principal_id: null },
        { principal_id: null }, { principal_id: null }] }),
    statement: () => ({ first: async () => ({ count: 0 }), run: async () => { mutations += 1; } }),
  };
  const metadata = {
    listServiceOperatorPrincipals: async () => ({ principals: [
      { principalId, ownedMindCount: 0, participatingMindCount: 0 },
      { principalId: "principal_foreign", ownedMindCount: 0, participatingMindCount: 0 },
    ], nextCursor: null }),
    resolvePersonalMind: async () => ({ spaceId: "space_run_owner" }),
  };
  await assert.rejects(exportJobExpiry(store,
    "41d3bca2-40b3-4dc0-b8f5-d9fe7e97bbed", { phase: "arm" }, { DB: {} },
    async () => { mutations += 1; },
    { createMetadata: async () => metadata, now: () => instant }),
  /export_expiry_product_not_isolated/u);
  assert.equal(mutations, 0);
});
