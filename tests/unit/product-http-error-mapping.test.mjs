import assert from "node:assert/strict";
import test from "node:test";

import {
  applicationErrorRetryable,
  applicationErrorStatus,
} from "../../packages/adapter-web/dist/product-http-routing.js";
import { createProductWebHttpHandler } from "../../packages/adapter-web/dist/index.js";

test("product HTTP capacity taxonomy maps status and retryability independently", () => {
  const expected = [
    ["capacity_fairness_limit", 429, true],
    ["capacity_soft_limit", 429, true],
    ["capacity_hard_limit", 413, false],
    ["capacity_accounting_untrusted", 503, true],
  ];
  for (const [code, status, retryable] of expected) {
    assert.equal(applicationErrorStatus(code), status, code);
    assert.equal(applicationErrorRetryable(code), retryable, code);
  }
});

test("product HTTP retryability preserves existing transient metadata errors", () => {
  for (const code of ["metadata_queue_timeout", "metadata_d1_timeout", "recovery_deadline_exceeded"]) {
    assert.equal(applicationErrorStatus(code), 503, code);
    assert.equal(applicationErrorRetryable(code), true, code);
  }
  assert.equal(applicationErrorRetryable("capacity_hard_limit"), false);
  assert.equal(applicationErrorRetryable("operation_failed"), false);
});

test("product HTTP handler emits the capacity taxonomy without private admission details", async () => {
  const origin = "https://mind-diary.example";
  const actor = Object.freeze({
    kind: "registered_principal",
    principalId: "principal_capacity_test",
    authentication: Object.freeze({ kind: "sites_identity", verifiedByPlatform: true }),
    requestId: "request_capacity_test",
    occurredAtUtc: "2026-09-21T00:00:00.000Z",
    deploymentCapabilities: Object.freeze([]),
  });
  const cases = [
    ["capacity_fairness_limit", 429, true],
    ["capacity_soft_limit", 429, true],
    ["capacity_hard_limit", 413, false],
    ["capacity_accounting_untrusted", 503, true],
  ];
  for (const [code, status, retryable] of cases) {
    const handler = createProductWebHttpHandler({
      applicationOrigin: origin,
      resolveIdentity: () => ({ kind: "authenticated", actor }),
      csrf: { issue: () => "csrf-capacity", verify: () => true },
      control: { execute() { throw Object.assign(new Error("private capacity diagnostic"), { code }); } },
    });
    const response = await handler(new Request(`${origin}/api/v1/minds/research-notes/exports`, {
      method: "POST",
      headers: {
        origin,
        "x-csrf-token": "csrf-capacity",
        "content-type": "application/json",
        "idempotency-key": "export:capacity-test",
      },
      body: JSON.stringify({
        revision_selector: { kind: "head" },
        profile: "MD-OKF-ZIP-1",
      }),
    }));
    assert.equal(response.status, status, code);
    const body = await response.json();
    assert.equal(body.error.code, code);
    assert.equal(body.error.retryable, retryable);
    assert.doesNotMatch(JSON.stringify(body), /private capacity diagnostic|reservation|object[_ -]?key/iu);
  }
});
