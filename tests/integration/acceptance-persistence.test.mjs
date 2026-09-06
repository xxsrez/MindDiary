import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { AcceptanceClient } from "../../scripts/lib/acceptance-client.mjs";
import { createCollaborationFixture } from "../../scripts/lib/acceptance-fixture.mjs";
import { snapshotAcceptanceFixture, verifyAcceptanceSnapshot } from "../../scripts/lib/acceptance-persistence.mjs";
import { acceptanceRuntime } from "../helpers/acceptance-runtime.mjs";
test("persistence snapshots bind exact historical contents and reject altered read-back", async t => {
  const runtime = await acceptanceRuntime(t);
  const client = await new AcceptanceClient({ directory: join(runtime.directory, "persistence"), platformToken: "test-platform", controllerKey: runtime.controllerKey, fetch: runtime.fetch }).open();
  try {
    const fixture = await createCollaborationFixture(client);
    const token = client.state.operations["token:owner"].result.data.secret;
    const snapshots = await snapshotAcceptanceFixture(client, fixture, token);
    await verifyAcceptanceSnapshot(client, token, snapshots);
    const original = client.mcp.bind(client);
    client.mcp = async (...args) => {
      const result = await original(...args);
      return args[1] === "fetch" ? { ...result, text: "corrupted read-back" } : result;
    };
    await assert.rejects(verifyAcceptanceSnapshot(client, token, snapshots));
  } finally { await client.cleanup(); }
});
