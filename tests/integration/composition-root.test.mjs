import assert from "node:assert/strict";
import test from "node:test";
import { COMPOSITION_SELECTION } from "@mind-diary/composition-root";

test("composition root selects one boundary and local in-memory adapters", () => {
  assert.equal(COMPOSITION_SELECTION.deployableServiceImplemented, false);
  assert.equal(COMPOSITION_SELECTION.outbound.metadata, "memory-revision-envelope");
  assert.equal(COMPOSITION_SELECTION.outbound.objects, "memory-revision-envelope");
  assert.equal(COMPOSITION_SELECTION.outbound.search, "memory-exact-revision");
  assert.equal(COMPOSITION_SELECTION.outbound.audit, "memory-idempotent-delivery");
  assert.equal(COMPOSITION_SELECTION.outbound.security, "webcrypto-contract-only");
  assert.deepEqual(
    COMPOSITION_SELECTION.inbound.web.commands,
    COMPOSITION_SELECTION.applications.control.commands,
  );
  assert.deepEqual(
    COMPOSITION_SELECTION.inbound.mcp.commands,
    COMPOSITION_SELECTION.applications.content.commands,
  );
  assert.deepEqual(
    COMPOSITION_SELECTION.inbound.background.handlers,
    COMPOSITION_SELECTION.applications.background.handlers,
  );
});
