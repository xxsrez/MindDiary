import assert from "node:assert/strict";
import test from "node:test";
import { expiredHeavyReservation } from "../../apps/mind-diary-acceptance/expired-heavy-reservation.mjs";

test("expired capacity probe refuses foreign Product principals before a ledger mutation", async () => {
  const now = Date.parse("2026-09-25T04:00:00.000Z");
  const runId = "41d3bca2-40b3-4dc0-b8f5-d9fe7e97bbed";
  const actor = { principal_id: "principal_run_owner" };
  const store = {
    run: async () => ({ profile: "operator", state: "active", created_at: now - 60_000,
      expires_at: now + 60_000, actors: [actor,
        { principal_id: null }, { principal_id: null }, { principal_id: null }] }),
    statement: () => ({ first: async () => ({ count: 0 }) }),
  };
  let mutations = 0;
  const metadata = {
    listServiceOperatorPrincipals: async () => ({ principals: [
      { principalId: actor.principal_id, ownedMindCount: 0, participatingMindCount: 0 },
      { principalId: "principal_foreign", ownedMindCount: 0, participatingMindCount: 0 },
    ], nextCursor: null }),
    resolvePersonalMind: async () => ({ spaceId: "space_run_owner" }),
    runCapacityTransaction: async () => { mutations += 1; },
  };
  await assert.rejects(expiredHeavyReservation(store, runId, { phase: "seed" }, { DB: {} }, {
    createMetadata: async () => metadata, now: () => now,
  }), /expired_heavy_product_not_isolated/u);
  assert.equal(mutations, 0);
});
