import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { AcceptanceClient } from "../../scripts/lib/acceptance-client.mjs";
import { createCollaborationFixture } from "../../scripts/lib/acceptance-fixture.mjs";
import { verifyProductMatrix } from "../../scripts/lib/acceptance-product-matrix.mjs";
import { acceptanceRuntime } from "../helpers/acceptance-runtime.mjs";

test("real composition verifies nine Personal description/mode cells and stale commits", async t => {
  const runtime = await acceptanceRuntime(t);
  const client = await new AcceptanceClient({ directory: join(runtime.directory, "matrix"), platformToken: "synthetic", controllerKey: runtime.controllerKey, fetch: runtime.fetch }).open();
  try {
    const fixture = await createCollaborationFixture(client);
    const result = await verifyProductMatrix(client, fixture);
    assert.equal(result.personal_mode_description_cells.length, 9);
  } finally { assert.equal((await client.cleanup()).state, "cleaned"); }
});
