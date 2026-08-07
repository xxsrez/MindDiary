import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ACCOUNT_DELETION_CONFIRMATION as SERVER_ACCOUNT_DELETION_CONFIRMATION } from "../../packages/application-control/dist/index.js";
import {
  MIND_DIARY_ACCOUNT_DELETION_CONFIRMATION,
  createAccountDeletionController,
  normalizeAccountDeletionImpact,
  renderAccountDeletion,
  renderAccountDeletionDocument,
  renderAccountDeletionPanel,
} from "../../packages/adapter-web/dist/account-deletion.js";

const implementation = await readFile(
  new URL("../../packages/adapter-web/src/account-deletion.ts", import.meta.url),
  "utf8",
);

const NOW = "2026-08-07T14:00:00.000Z";
const EXPIRY = "2026-08-07T14:15:00.000Z";

test("UI exact confirmation stays identical to the server command contract", () => {
  assert.equal(
    MIND_DIARY_ACCOUNT_DELETION_CONFIRMATION,
    SERVER_ACCOUNT_DELETION_CONFIRMATION,
  );
});

function impact(overrides = {}) {
  return {
    impactId: "impact_account_delete_1",
    expiresAt: EXPIRY,
    personalMind: { route: "/me", name: "Andrey" },
    ownedMinds: [
      { route: "/research-notes", name: "Research Notes" },
      { route: "/family-library", name: "Family Library" },
    ],
    foreignMembershipCount: 2,
    pendingInvitationCount: 1,
    activeMcpTokenCount: 3,
    irreversible: true,
    recoveryAvailable: false,
    forensicReceiptRetained: false,
    confirmation: "delete-account",
    privateContent: "PRIVATE CONCEPT BODY MUST NEVER RENDER",
    verifiedEmail: "private@example.com",
    ...overrides,
  };
}

function deletionResult(overrides = {}) {
  return {
    replayed: false,
    spacesDeleted: 3,
    tokensRevoked: 3,
    canonicalObjectsDeleted: 7,
    canonicalObjectsRetained: 1,
    indexedRevisionsDeleted: 5,
    deliveredAuditEventsDeleted: 4,
    deliveredAuditActorsTombstoned: 2,
    exportArchivesDeleted: 1,
    ...overrides,
  };
}

function controllerOptions(overrides = {}) {
  return {
    now: () => new Date(NOW),
    createIdempotencyKey: () => "account-delete-attempt-0001",
    setTimer: () => 1,
    clearTimer: () => undefined,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("preview renders the exact safe cascade and no private content", () => {
  const normalized = normalizeAccountDeletionImpact(impact());
  assert.ok(normalized);
  assert.equal("privateContent" in normalized, false);
  assert.equal("verifiedEmail" in normalized, false);
  assert.equal(normalized.confirmation, MIND_DIARY_ACCOUNT_DELETION_CONFIRMATION);

  const html = renderAccountDeletion({
    displayName: "Andrey",
    state: {
      kind: "preview",
      impact: normalized,
      idempotencyKey: "account-delete-attempt-0001",
    },
  });

  assert.match(html, /Exact, expiring preview/);
  assert.match(html, /datetime="2026-08-07T14:15:00\.000Z"/);
  assert.match(html, /<strong>Andrey<\/strong> <code>\/me<\/code>/);
  assert.match(html, /Owned Minds \(2\)/);
  assert.match(html, /Research Notes/);
  assert.match(html, /<code>\/family-library<\/code>/);
  assert.match(html, /Memberships[\s\S]*<h3>2<\/h3>/);
  assert.match(html, /Pending invitations[\s\S]*<h3>1<\/h3>/);
  assert.match(html, /Active MCP tokens[\s\S]*<h3>3<\/h3>/);
  assert.match(html, /deleted with its full history even when other participants use it/i);
  assert.match(html, /opaque, non-PII <code>deleted-principal<\/code> marker/);
  assert.match(html, /no soft delete or recovery/i);
  assert.match(html, /retains no forensic deletion receipt/i);
  assert.match(html, /Type <code>delete-account<\/code> exactly/);
  assert.match(html, /pattern="delete-account"/);
  assert.match(html, /data-confirm-account-deletion disabled/);
  assert.doesNotMatch(html, /PRIVATE CONCEPT BODY|private@example\.com/);
  assert.doesNotMatch(html, /soft delete (?:is|will be) available|recover this account|download (?:a )?deletion receipt/i);
});

test("preview validation fails closed for command, lifecycle, count, and route drift", () => {
  for (const invalid of [
    impact({ confirmation: "DELETE ACCOUNT" }),
    impact({ irreversible: false }),
    impact({ recoveryAvailable: true }),
    impact({ forensicReceiptRetained: true }),
    impact({ activeMcpTokenCount: -1 }),
    impact({ personalMind: { route: "/hidden-personal-handle", name: "Andrey" } }),
    impact({ ownedMinds: [{ route: "javascript:alert(1)", name: "Unsafe" }] }),
    impact({ impactId: "bad id" }),
  ]) {
    assert.equal(normalizeAccountDeletionImpact(invalid), null);
  }

  const html = renderAccountDeletionPanel({
    kind: "preview",
    impact: impact({ confirmation: "wrong" }),
    idempotencyKey: "account-delete-attempt-0001",
  });
  assert.match(html, /could not verify the deletion preview contract/i);
  assert.doesNotMatch(html, /data-account-deletion-form/);
});

test("all names are escaped and the document loads only a safe local client", () => {
  const malicious = `<img src=x onerror="globalThis.pwned=1">`;
  const normalized = normalizeAccountDeletionImpact(impact({
    personalMind: { route: "/me", name: malicious },
    ownedMinds: [{ route: "/safe-route", name: `<svg onload="globalThis.pwned=2">` }],
  }));
  assert.ok(normalized);

  const model = {
    displayName: malicious,
    state: {
      kind: "preview",
      impact: normalized,
      idempotencyKey: "account-delete-attempt-0001",
    },
  };
  const safe = renderAccountDeletionDocument(
    model,
    "/fixture/account-deletion-client.mjs",
  );
  const unsafe = renderAccountDeletionDocument(
    model,
    "javascript:globalThis.pwned=3",
  );

  assert.doesNotMatch(safe, /<(?:img|svg)[^>]+(?:onerror|onload|pwned)/i);
  assert.doesNotMatch(safe, /\son(?:error|load|mouseover)\s*=\s*["']/i);
  assert.match(safe, /&lt;img src=x onerror=&quot;globalThis\.pwned=1&quot;&gt;/);
  assert.match(safe, /&lt;svg onload=&quot;globalThis\.pwned=2&quot;&gt;/);
  assert.match(safe, /src="\/fixture\/account-deletion-client\.mjs"/);
  assert.doesNotMatch(unsafe, /javascript:|globalThis\.pwned=3/);
  assert.match(safe, /<main id="main-content"[^>]+tabindex="-1"/);
  assert.match(safe, /role="status" aria-live="polite"/);
  assert.match(safe, /<label for="account-deletion-confirmation">/);
  assert.match(implementation, /event\.key === "Enter"/);
  assert.match(implementation, /controller\.submitConfirmation\(input\.value\)/);
  assert.doesNotMatch(
    implementation,
    /console\.|analytics\.|dataLayer|localStorage|sessionStorage|sendBeacon/i,
  );
});

test("strong exact confirmation sends the server-bound command and ends the session only after success", async () => {
  const calls = [];
  const commands = [];
  const adapter = {
    async getAccountDeletionImpact() {
      calls.push("preview");
      return impact();
    },
    async deleteAccount(command) {
      calls.push("delete");
      commands.push(command);
      return deletionResult();
    },
    async endSessionAfterDeletion() {
      calls.push("session");
    },
  };
  const controller = createAccountDeletionController(adapter, controllerOptions());

  await controller.loadPreview();
  assert.equal(controller.getState().kind, "preview");
  await controller.submitConfirmation("Delete-Account");
  assert.equal(controller.getState().kind, "preview");
  assert.equal(controller.getState().feedback, "invalid_confirmation");
  assert.deepEqual(commands, []);
  assert.deepEqual(calls, ["preview"]);

  await controller.submitConfirmation("delete-account");
  assert.deepEqual(commands, [{
    impactId: "impact_account_delete_1",
    confirmation: "delete-account",
    idempotencyKey: "account-delete-attempt-0001",
  }]);
  assert.deepEqual(calls, ["preview", "delete", "session"]);
  assert.equal(controller.getState().kind, "deleted");
  controller.dispose();
});

test("invalid, denied, expired, and changed previews never end the session", async () => {
  let sessionEnds = 0;
  let deletes = 0;
  const invalid = createAccountDeletionController({
    async getAccountDeletionImpact() {
      return impact({ confirmation: "wrong" });
    },
    async deleteAccount() {
      deletes += 1;
      return deletionResult();
    },
    endSessionAfterDeletion() {
      sessionEnds += 1;
    },
  }, controllerOptions());
  await invalid.loadPreview();
  assert.deepEqual(invalid.getState(), { kind: "load_error", reason: "invalid" });
  assert.equal(deletes, 0);

  const denied = createAccountDeletionController({
    async getAccountDeletionImpact() {
      throw Object.assign(new Error("do not render this"), { code: "authentication_required" });
    },
    async deleteAccount() {
      deletes += 1;
      return deletionResult();
    },
    endSessionAfterDeletion() {
      sessionEnds += 1;
    },
  }, controllerOptions());
  await denied.loadPreview();
  assert.deepEqual(denied.getState(), { kind: "load_error", reason: "denied" });

  const expired = createAccountDeletionController({
    async getAccountDeletionImpact() {
      return impact({ expiresAt: "2026-08-07T13:59:59.000Z" });
    },
    async deleteAccount() {
      deletes += 1;
      return deletionResult();
    },
    endSessionAfterDeletion() {
      sessionEnds += 1;
    },
  }, controllerOptions());
  await expired.loadPreview();
  assert.deepEqual(expired.getState(), { kind: "stale", reason: "expired" });

  const changed = createAccountDeletionController({
    async getAccountDeletionImpact() {
      return impact();
    },
    async deleteAccount() {
      deletes += 1;
      throw Object.assign(new Error("stale"), { code: "deletion_impact_changed" });
    },
    endSessionAfterDeletion() {
      sessionEnds += 1;
    },
  }, controllerOptions());
  await changed.loadPreview();
  await changed.submitConfirmation("delete-account");
  assert.deepEqual(changed.getState(), { kind: "stale", reason: "changed" });
  assert.equal(deletes, 1);
  assert.equal(sessionEnds, 0);

  for (const controller of [invalid, denied, expired, changed]) controller.dispose();
});

test("a preview that expires before the first submit never sends deletion", async () => {
  let currentNow = NOW;
  let deletes = 0;
  let sessionEnds = 0;
  const controller = createAccountDeletionController({
    async getAccountDeletionImpact() {
      return impact();
    },
    async deleteAccount() {
      deletes += 1;
      return deletionResult();
    },
    endSessionAfterDeletion() {
      sessionEnds += 1;
    },
  }, controllerOptions({ now: () => new Date(currentNow) }));

  await controller.loadPreview();
  assert.equal(controller.getState().kind, "preview");
  currentNow = EXPIRY;
  await controller.submitConfirmation("delete-account");

  assert.deepEqual(controller.getState(), { kind: "stale", reason: "expired" });
  assert.equal(deletes, 0);
  assert.equal(sessionEnds, 0);
  controller.dispose();
});

test("an ambiguous retry after preview expiry lets the server reject a new start", async () => {
  let currentNow = NOW;
  let deletes = 0;
  let sessionEnds = 0;
  const controller = createAccountDeletionController({
    async getAccountDeletionImpact() {
      return impact();
    },
    async deleteAccount() {
      deletes += 1;
      if (deletes === 1) throw new Error("synthetic lost response");
      throw Object.assign(new Error("expired before commit"), {
        code: "deletion_impact_expired",
      });
    },
    endSessionAfterDeletion() {
      sessionEnds += 1;
    },
  }, controllerOptions({ now: () => new Date(currentNow) }));

  await controller.loadPreview();
  await controller.submitConfirmation("delete-account");
  assert.equal(controller.getState().kind, "retryable_failure");
  currentNow = EXPIRY;
  await controller.retryDeletion();

  assert.deepEqual(controller.getState(), { kind: "stale", reason: "expired" });
  assert.equal(deletes, 2);
  assert.equal(sessionEnds, 0);
  controller.dispose();
});

test("cleanup failure retries the exact command and reaches one final state", async () => {
  let currentNow = NOW;
  const commands = [];
  let sessionEnds = 0;
  const adapter = {
    async getAccountDeletionImpact() {
      return impact();
    },
    async deleteAccount(command) {
      commands.push({ ...command });
      if (commands.length === 1) {
        throw Object.assign(new Error("cleanup is incomplete"), {
          code: "deletion_cleanup_incomplete",
        });
      }
      return deletionResult({ replayed: true });
    },
    endSessionAfterDeletion() {
      sessionEnds += 1;
    },
  };
  const controller = createAccountDeletionController(
    adapter,
    controllerOptions({ now: () => new Date(currentNow) }),
  );

  await controller.loadPreview();
  await controller.submitConfirmation("delete-account");
  assert.equal(controller.getState().kind, "retryable_failure");
  assert.equal(controller.getState().cleanupIncomplete, true);
  assert.equal(sessionEnds, 0);
  currentNow = EXPIRY;
  await controller.retryDeletion();

  assert.equal(controller.getState().kind, "deleted");
  assert.equal(sessionEnds, 1);
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[1], commands[0]);
  controller.dispose();
});

test("concurrent submit attempts collapse to one deletion and session transition", async () => {
  const deletion = deferred();
  let deletes = 0;
  let sessionEnds = 0;
  const controller = createAccountDeletionController({
    async getAccountDeletionImpact() {
      return impact();
    },
    async deleteAccount() {
      deletes += 1;
      return deletion.promise;
    },
    endSessionAfterDeletion() {
      sessionEnds += 1;
    },
  }, controllerOptions());

  await controller.loadPreview();
  const first = controller.submitConfirmation("delete-account");
  const second = controller.submitConfirmation("delete-account");
  assert.equal(controller.getState().kind, "deleting");
  assert.equal(deletes, 1);
  assert.equal(sessionEnds, 0);

  deletion.resolve(deletionResult());
  await Promise.all([first, second]);
  assert.equal(controller.getState().kind, "deleted");
  assert.equal(deletes, 1);
  assert.equal(sessionEnds, 1);
  controller.dispose();
});

test("only the newest overlapping preview response can become authoritative", async () => {
  const first = deferred();
  const second = deferred();
  const previews = [first, second];
  let call = 0;
  const controller = createAccountDeletionController({
    getAccountDeletionImpact() {
      const current = previews[call];
      call += 1;
      return current.promise;
    },
    async deleteAccount() {
      return deletionResult();
    },
    endSessionAfterDeletion() {},
  }, controllerOptions());

  const olderLoad = controller.loadPreview();
  const newerLoad = controller.loadPreview();
  second.resolve(impact({
    impactId: "impact_account_delete_new",
    ownedMinds: [{ route: "/new-preview", name: "New Preview" }],
  }));
  await newerLoad;
  assert.equal(controller.getState().impact.impactId, "impact_account_delete_new");

  first.resolve(impact({
    impactId: "impact_account_delete_old",
    ownedMinds: [{ route: "/old-preview", name: "Old Preview" }],
  }));
  await olderLoad;
  assert.equal(controller.getState().impact.impactId, "impact_account_delete_new");
  controller.dispose();
});

test("session-end failure never repeats deletion and can retry sign-out", async () => {
  let deletes = 0;
  let sessionEnds = 0;
  const controller = createAccountDeletionController({
    async getAccountDeletionImpact() {
      return impact();
    },
    async deleteAccount() {
      deletes += 1;
      return deletionResult();
    },
    async endSessionAfterDeletion() {
      sessionEnds += 1;
      if (sessionEnds === 1) throw new Error("synthetic sign-out failure");
    },
  }, controllerOptions());

  await controller.loadPreview();
  await controller.submitConfirmation("delete-account");
  assert.equal(controller.getState().kind, "session_end_error");
  assert.equal(deletes, 1);
  await controller.retrySessionEnd();
  assert.equal(controller.getState().kind, "deleted");
  assert.equal(deletes, 1);
  assert.equal(sessionEnds, 2);
  controller.dispose();
});

test("malformed success is not treated as final and does not end the session", async () => {
  let sessionEnds = 0;
  const controller = createAccountDeletionController({
    async getAccountDeletionImpact() {
      return impact();
    },
    async deleteAccount() {
      return { replayed: false, spacesDeleted: 3 };
    },
    endSessionAfterDeletion() {
      sessionEnds += 1;
    },
  }, controllerOptions());

  await controller.loadPreview();
  await controller.submitConfirmation("delete-account");
  assert.equal(controller.getState().kind, "retryable_failure");
  assert.equal(sessionEnds, 0);
  controller.dispose();
});
