import assert from "node:assert/strict";
import test from "node:test";

import { AutomaticCaptureService } from "@mind-diary/application-content";

test("retired capture compatibility path is side-effect-free", async () => {
  let writes = 0;
  const capture = new AutomaticCaptureService({
    commits: {
      async commit() {
        writes += 1;
        throw new Error("retired capture must not reach commit_changeset");
      },
    },
  });
  const result = await capture.capture({
    actor: {
      kind: "registered_principal",
      principalId: "principal_retired_capture",
      authentication: {
        kind: "mcp_token",
        tokenId: "token_retired_capture",
        effectiveScopes: ["content:read", "content:write"],
      },
      deploymentCapabilities: ["content:read", "content:write"],
      requestId: "request_retired_capture",
      occurredAtUtc: "2026-08-30T21:00:00.000Z",
    },
    spaceId: "space_retired_capture",
    writeBindingId: "legacy_binding",
    expectedBindingVersion: 1,
    expectedRevisionId: "revision_legacy",
    idempotencyKey: "legacy-capture",
    classification: "routine_non_sensitive",
    captureKind: "fact",
    captureKey: "legacy",
    title: "Legacy",
    description: "Legacy cached call",
    body: "Must not be persisted.",
    sources: [{ kind: "user_statement" }],
  });
  assert.deepEqual(result, { kind: "capture_disabled" });
  assert.equal(writes, 0);
});
