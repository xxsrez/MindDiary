import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryMcpTokenStore } from "../../packages/adapter-metadata-memory/dist/index.js";
import { createWebCryptoTokenHasher } from "../../packages/adapter-security-webcrypto/dist/index.js";
import {
  MCP_TOKEN_DEFAULT_LIFETIME_DAYS,
  MCP_TOKEN_MAXIMUM_LIFETIME_DAYS,
  TokenLifecycleFailure,
  TokenLifecycleService,
} from "../../packages/application-control/dist/index.js";
import { CapabilityAuthorizer } from "../../packages/application-ports/dist/index.js";
import {
  CAPABILITIES,
  version,
} from "../../packages/domain/dist/index.js";

const START = "2026-08-06T12:00:00.000Z";
const TEST_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 17);

function sitesActor(principalId) {
  return {
    kind: "registered_principal",
    principalId,
    authentication: { kind: "sites_identity" },
    deploymentCapabilities: CAPABILITIES,
    requestId: `request_${principalId}`,
    occurredAtUtc: START,
  };
}

function mcpActor(principalId, tokenId, occurredAtUtc = START) {
  return {
    kind: "registered_principal",
    principalId,
    authentication: { kind: "mcp_token", tokenId },
    deploymentCapabilities: CAPABILITIES,
    requestId: `request_${principalId}`,
    occurredAtUtc,
  };
}

function mutableClock(initial = START) {
  let current = initial;
  return {
    now: () => current,
    set: (next) => {
      current = next;
    },
  };
}

function sequentialTokenIds(prefix = "token") {
  let next = 0;
  return {
    nextTokenId() {
      next += 1;
      return `${prefix}_${next}`;
    },
  };
}

function sequentialPersonalTokenRefs() {
  let next = 0;
  return {
    nextPersonalTokenRef() {
      next += 1;
      return `ptok_v1_${next.toString(16).padStart(32, "0")}`;
    },
  };
}

async function fixture(overrides = {}) {
  const clock = mutableClock();
  const tokens = new InMemoryMcpTokenStore();
  const tokenHasher = await createWebCryptoTokenHasher({ verifierKey: TEST_KEY });
  const service = new TokenLifecycleService({
    clock,
    tokens,
    tokenHasher,
    tokenIds: sequentialTokenIds(),
    ...overrides,
  });
  return { clock, service, tokenHasher, tokens };
}

async function expectLifecycleFailure(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof TokenLifecycleFailure, true);
    assert.equal(error.code, code);
    return true;
  });
}

test("issues principal-scoped metadata with normalized scopes and a consume-once secret", async () => {
  const { service, tokens } = await fixture();
  const actor = sitesActor("principal_alpha");
  const issued = await service.issueMcpToken(actor, {
    name: "  Codex on Mac  ",
    scopes: ["content:write"],
  });
  const expectedExpiry = new Date(
    Date.parse(START) + MCP_TOKEN_DEFAULT_LIFETIME_DAYS * 86_400_000,
  ).toISOString();

  assert.equal(MCP_TOKEN_DEFAULT_LIFETIME_DAYS, 90);
  assert.equal(MCP_TOKEN_MAXIMUM_LIFETIME_DAYS, 90);
  assert.equal(issued.token.name, "Codex on Mac");
  assert.deepEqual(issued.token.scopes, ["content:read", "content:write"]);
  assert.equal(issued.token.createdAt, START);
  assert.equal(issued.token.expiresAt, expectedExpiry);
  assert.equal(issued.token.state, "active");
  assert.equal(issued.token.version, 1);

  const safeBeforeConsumption = JSON.stringify(issued);
  assert.equal(safeBeforeConsumption.includes("hmac-sha256"), false);
  assert.equal(safeBeforeConsumption.includes("verifier"), false);
  const secret = issued.secret.consumeSecret();
  assert.equal(typeof secret, "string");
  assert.equal(/^mdp_v1_[A-Za-z0-9_-]{43}$/u.test(secret), true);
  assert.equal(issued.secret.consumeSecret(), null);
  assert.equal(JSON.stringify(issued).includes(secret), false);

  const listed = await service.listMcpTokens(actor);
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0], issued.token);
  assert.equal("secret" in listed[0], false);
  assert.equal("verifier" in listed[0], false);
  assert.equal("principalId" in listed[0], false);

  const hiddenMaterial = await tokens.listMcpTokenMetadata("principal_alpha");
  assert.equal("verifier" in hiddenMaterial[0], false);
  assert.equal(JSON.stringify(hiddenMaterial).includes(secret), false);
});

test("rejects unsupported scopes and makes a write-only persisted shape impossible", async () => {
  const { service, tokenHasher, tokens } = await fixture();
  const actor = sitesActor("principal_scope");
  for (const scopes of [[], ["control:write"], ["content:read", "other"]]) {
    await expectLifecycleFailure(
      service.issueMcpToken(actor, { name: "invalid", scopes }),
      "invalid_token_scopes",
    );
  }

  const issuance = await tokenHasher.issueSecret();
  const persistence = issuance.persistence();
  const directWriteOnly = await tokens.createMcpToken({
    tokenId: "token_write_only",
    principalId: "principal_scope",
    name: "invalid persisted shape",
    verifier: persistence.verifier,
    displayPrefix: persistence.displayPrefix,
    scopes: ["content:write"],
    createdAt: START,
    expiresAt: "2026-08-07T12:00:00.000Z",
  });
  assert.deepEqual(directWriteOnly, { kind: "invalid_record" });
  assert.equal((await service.listMcpTokens(actor)).length, 0);
});

test("enforces future valid expiry at or below the explicit 90-day maximum", async () => {
  const { service } = await fixture();
  const actor = sitesActor("principal_expiry");
  const maximum = new Date(
    Date.parse(START) + MCP_TOKEN_MAXIMUM_LIFETIME_DAYS * 86_400_000,
  ).toISOString();

  for (const expiresAt of [
    "not-a-time",
    "2026-08-06T13:00:00+01:00",
    "2026-02-30T12:00:00Z",
  ]) {
    await expectLifecycleFailure(
      service.issueMcpToken(actor, {
        name: "invalid expiry",
        scopes: ["content:read"],
        expiresAt,
      }),
      "invalid_token_expiry",
    );
  }
  for (const expiresAt of [
    START,
    "2026-08-06T11:59:59.999Z",
    new Date(Date.parse(maximum) + 1).toISOString(),
  ]) {
    await expectLifecycleFailure(
      service.issueMcpToken(actor, {
        name: "out of range",
        scopes: ["content:read"],
        expiresAt,
      }),
      "token_expiry_out_of_range",
    );
  }

  const accepted = await service.issueMcpToken(actor, {
    name: "maximum",
    scopes: ["content:read"],
    expiresAt: maximum,
  });
  assert.equal(accepted.token.expiresAt, maximum);
  assert.deepEqual(accepted.token.scopes, ["content:read"]);
});

test("issuance retries create independent tokens and never recover an old secret", async () => {
  const { service } = await fixture();
  const actor = sitesActor("principal_retry");
  const command = { name: "retry", scopes: ["content:read"] };
  const first = await service.issueMcpToken(actor, command);
  const second = await service.issueMcpToken(actor, command);
  const firstSecret = first.secret.consumeSecret();
  const secondSecret = second.secret.consumeSecret();

  assert.equal(first.token.tokenId === second.token.tokenId, false);
  assert.equal(firstSecret === secondSecret, false);
  assert.equal(first.secret.consumeSecret(), null);
  assert.equal(second.secret.consumeSecret(), null);
  assert.equal((await service.listMcpTokens(actor)).length, 2);
});

test("token ID conflict fails safely and preserves the existing final authorization state", async () => {
  const clock = mutableClock();
  const tokens = new InMemoryMcpTokenStore();
  const tokenHasher = await createWebCryptoTokenHasher({ verifierKey: TEST_KEY });
  const service = new TokenLifecycleService({
    clock,
    tokens,
    tokenHasher,
    tokenIds: { nextTokenId: () => "token_collision" },
  });
  const actor = sitesActor("principal_collision");
  const first = await service.issueMcpToken(actor, {
    name: "first",
    scopes: ["content:write"],
  });
  const firstSecret = first.secret.consumeSecret();
  const beforeList = await service.listMcpTokens(actor);
  const beforeAuthorization = await tokens.readMcpTokenForAuthorization(
    first.token.tokenId,
  );

  let conflict;
  try {
    await service.issueMcpToken(actor, {
      name: "conflicting retry",
      scopes: ["content:read"],
    });
    assert.fail("expected token issue conflict");
  } catch (error) {
    conflict = error;
  }

  assert.equal(conflict instanceof TokenLifecycleFailure, true);
  assert.equal(conflict.code, "token_issue_conflict");
  const serializedError = JSON.stringify(conflict);
  assert.equal(conflict.message.includes(firstSecret), false);
  assert.equal(serializedError.includes(firstSecret), false);
  assert.equal(serializedError.includes("hmac-sha256"), false);
  assert.equal(serializedError.includes("verifier"), false);

  const afterList = await service.listMcpTokens(actor);
  const afterAuthorization = await tokens.readMcpTokenForAuthorization(
    first.token.tokenId,
  );
  assert.deepEqual(afterList, beforeList);
  assert.deepEqual(afterAuthorization, beforeAuthorization);
  assert.equal(afterList.length, 1);
  assert.equal(afterList[0].state, "active");
  assert.equal(afterList[0].version, 1);
  const stillVerifies = await tokenHasher.verifySecret(firstSecret, tokens);
  assert.equal(stillVerifies.kind, "verified");
  assert.equal(
    stillVerifies.kind === "verified" &&
      stillVerifies.value.tokenId === first.token.tokenId,
    true,
  );
});

test("list and revoke stay principal-scoped; concurrent revokes converge idempotently", async () => {
  const { service, tokens } = await fixture();
  const alpha = sitesActor("principal_alpha");
  const beta = sitesActor("principal_beta");
  const alphaToken = await service.issueMcpToken(alpha, {
    name: "alpha",
    scopes: ["content:read"],
  });
  await service.issueMcpToken(beta, {
    name: "beta",
    scopes: ["content:read"],
  });

  assert.deepEqual(
    (await service.listMcpTokens(alpha)).map((token) => token.name),
    ["alpha"],
  );
  assert.deepEqual(
    (await service.listMcpTokens(beta)).map((token) => token.name),
    ["beta"],
  );
  await expectLifecycleFailure(
    service.revokeMcpToken(beta, alphaToken.token.tokenId),
    "token_not_found",
  );

  const concurrent = await Promise.all([
    service.revokeMcpToken(alpha, alphaToken.token.tokenId),
    service.revokeMcpToken(alpha, alphaToken.token.tokenId),
  ]);
  assert.deepEqual(
    concurrent.map((result) => result.replayed).sort(),
    [false, true],
  );
  const final = await service.listMcpTokens(alpha);
  assert.equal(final[0].state, "revoked");
  assert.equal(final[0].version, 2);
  assert.equal(final[0].revokedAt, START);
  assert.equal(
    (await tokens.readMcpTokenForAuthorization(alphaToken.token.tokenId)).state,
    "revoked",
  );
});

test("presentation-ref token pages are actor-bound, stable, bounded, and omit storage IDs", async () => {
  const { service } = await fixture({ personalTokenRefs: sequentialPersonalTokenRefs() });
  const alpha = sitesActor("principal_page_alpha");
  const beta = sitesActor("principal_page_beta");
  const issued = [];
  for (let index = 1; index <= 5; index += 1) {
    issued.push(await service.issueMcpToken(alpha, {
      name: `alpha ${index}`,
      scopes: ["content:read"],
    }));
  }
  await service.issueMcpToken(beta, { name: "beta", scopes: ["content:read"] });

  const first = await service.listPersonalTokenPage(alpha, { state: "active", limit: 2 });
  assert.deepEqual(first.items.map((token) => token.name), ["alpha 5", "alpha 4"]);
  assert.equal(first.nextCursor !== null, true);
  assert.equal(first.items.every((token) => !("tokenId" in token)), true);
  assert.equal(JSON.stringify(first).includes("token_"), false);

  await service.issueMcpToken(alpha, { name: "newer after page one", scopes: ["content:read"] });
  const second = await service.listPersonalTokenPage(alpha, { cursor: first.nextCursor });
  const third = await service.listPersonalTokenPage(alpha, { cursor: second.nextCursor });
  assert.deepEqual(second.items.map((token) => token.name), ["alpha 3", "alpha 2"]);
  assert.deepEqual(third.items.map((token) => token.name), ["alpha 1"]);
  assert.equal(third.nextCursor, null);
  assert.equal(
    new Set([...first.items, ...second.items, ...third.items].map((token) => token.personalTokenRef)).size,
    5,
  );

  await expectLifecycleFailure(
    service.listPersonalTokenPage(beta, { cursor: first.nextCursor }),
    "invalid_token_page",
  );
  await expectLifecycleFailure(
    service.listPersonalTokenPage(alpha, { state: "revoked", cursor: first.nextCursor }),
    "invalid_token_page",
  );
  await expectLifecycleFailure(
    service.listPersonalTokenPage(alpha, { limit: 3, cursor: first.nextCursor }),
    "invalid_token_page",
  );

  const targetRef = issued[0].token.personalTokenRef;
  assert.equal(typeof targetRef, "string");
  await expectLifecycleFailure(service.readPersonalToken(beta, targetRef), "token_not_found");
  await expectLifecycleFailure(service.revokePersonalToken(beta, targetRef), "token_not_found");
  const revoked = await service.revokePersonalToken(alpha, targetRef);
  assert.equal(revoked.token.personalTokenRef, targetRef);
  assert.equal(revoked.token.state, "revoked");
  assert.equal("tokenId" in revoked.token, false);
  assert.deepEqual(
    (await service.listPersonalTokenPage(alpha, { state: "revoked", limit: 20 })).items
      .map((token) => token.personalTokenRef),
    [targetRef],
  );
});

test("token issue creates an empty write-target owner and revoke fences it idempotently", async () => {
  const registrations = [];
  const revocations = [];
  let auditId = 0;
  let outboxId = 0;
  const { service } = await fixture({
    writeTargets: {
      async runCredentialWriteTargetTransaction(operation) {
        return operation({
          async registerCredentialWriteTargetOwner(request) {
            registrations.push(request);
            return {
              kind: "registered",
              state: {
                bindingOwnerId: request.bindingOwnerId,
                principalId: request.principalId,
                credentialKind: request.credentialKind,
                contractVersion: "credential-write-target/v1",
                lifecycleState: "active",
                targetVersion: 0,
                activeGeneration: null,
                automaticCaptureMode: "disabled",
                captureGenerationId: null,
                createdAt: request.occurredAt,
                upgradedAt: null,
                updatedAt: request.occurredAt,
                revokedAt: null,
              },
              replayed: false,
            };
          },
        });
      },
      async revokeCredentialWriteTargetOwner(request) {
        revocations.push(request);
        return {
          kind: "revoked",
          changed: revocations.length === 1,
          replayed: revocations.length !== 1,
        };
      },
    },
    writeTargetIds: {
      nextCredentialWriteTargetAuditEventId: () => `audit_token_target_${++auditId}`,
      nextCredentialWriteTargetOutboxMessageId: () => `outbox_token_target_${++outboxId}`,
    },
  });
  const actor = sitesActor("principal_binding_revoke");
  const issued = await service.issueMcpToken(actor, {
    name: "binding owner",
    scopes: ["content:write"],
  });
  assert.deepEqual(registrations, [{
    bindingOwnerId: issued.token.tokenId,
    principalId: actor.principalId,
    credentialKind: "personal_token",
    occurredAt: START,
  }]);

  const first = await service.revokeMcpToken(actor, issued.token.tokenId);
  const retry = await service.revokeMcpToken(actor, issued.token.tokenId);

  assert.equal(first.replayed, false);
  assert.equal(retry.replayed, true);
  assert.equal(revocations.length, 2);
  assert.deepEqual(
    revocations.map(({ bindingOwnerId, principalId, requestId, occurredAt }) => ({
      bindingOwnerId,
      principalId,
      requestId,
      occurredAt,
    })),
    [0, 1].map(() => ({
      bindingOwnerId: issued.token.tokenId,
      principalId: actor.principalId,
      requestId: actor.requestId,
      occurredAt: START,
    })),
  );
  assert.equal(new Set(revocations.map((request) => request.auditEventId)).size, 2);
  assert.equal(
    new Set(revocations.map((request) => request.auditOutboxMessageId)).size,
    2,
  );
});

test("one token follows current access across Minds and revocation or expiry stops authorization", async () => {
  const { service, tokenHasher, tokens } = await fixture();
  const principalId = "principal_authorized";
  const controlActor = sitesActor(principalId);
  const issued = await service.issueMcpToken(controlActor, {
    name: "multi mind",
    scopes: ["content:write"],
  });
  const secret = issued.secret.consumeSecret();
  const verified = await tokenHasher.verifySecret(secret, tokens);
  assert.equal(verified.kind, "verified");
  assert.equal(verified.kind === "verified" && verified.value.tokenId === issued.token.tokenId, true);
  await expectLifecycleFailure(
    service.listMcpTokens(mcpActor(principalId, issued.token.tokenId)),
    "authentication_required",
  );

  const stateReader = {
    async readCurrentAuthorizationState(query) {
      const token = await tokens.readMcpTokenForAuthorization(query.tokenId);
      const hasMembership = query.spaceId !== "space_denied";
      return {
        principal: { principalId, state: "active" },
        space: {
          spaceId: query.spaceId,
          state: "active",
          visibility: "private",
          accessVersion: version(1),
        },
        membership: hasMembership
          ? {
              principalId,
              spaceId: query.spaceId,
              role: "owner",
              state: "active",
              version: version(1),
            }
          : null,
        token,
      };
    },
  };
  const authorizer = new CapabilityAuthorizer(stateReader);
  const authorize = (spaceId, capability, tokenId = issued.token.tokenId, occurredAtUtc = START) =>
    authorizer.authorize({
      actor: mcpActor(principalId, tokenId, occurredAtUtc),
      spaceId,
      capability,
      revisionMode: "head",
    });

  assert.equal((await authorize("space_one", "content:write")).kind, "allowed");
  assert.equal((await authorize("space_two", "content:fetch")).kind, "allowed");
  assert.equal((await authorize("space_denied", "content:fetch")).code, "access_denied");
  assert.equal((await authorize("space_one", "visibility:change")).code, "insufficient_scope");

  await service.revokeMcpToken(controlActor, issued.token.tokenId);
  assert.equal((await authorize("space_one", "content:fetch")).code, "token_inactive");

  const shortLived = await service.issueMcpToken(controlActor, {
    name: "short lived",
    scopes: ["content:read"],
    expiresAt: "2026-08-06T12:00:01.000Z",
  });
  assert.equal(
    (
      await authorize(
        "space_two",
        "content:fetch",
        shortLived.token.tokenId,
        shortLived.token.expiresAt,
      )
    ).code,
    "token_inactive",
  );
});

test("account deletion atomically revokes tokens and blocks racing or later issuance", async () => {
  const { service } = await fixture();
  const alpha = sitesActor("principal_delete");
  const beta = sitesActor("principal_other");
  await service.issueMcpToken(alpha, {
    name: "existing",
    scopes: ["content:read"],
  });
  await service.issueMcpToken(beta, {
    name: "other principal",
    scopes: ["content:read"],
  });

  const [racingIssue, deletion] = await Promise.allSettled([
    service.issueMcpToken(alpha, {
      name: "racing issue",
      scopes: ["content:write"],
    }),
    service.revokeTokensForAccountDeletion(alpha.principalId),
  ]);
  assert.equal(deletion.status, "fulfilled");
  assert.equal(racingIssue.status, "rejected");
  assert.equal(
    racingIssue.status === "rejected" &&
      racingIssue.reason instanceof TokenLifecycleFailure &&
      racingIssue.reason.code === "principal_tokens_disabled",
    true,
  );

  const alphaFinal = await service.listMcpTokens(alpha);
  assert.equal(alphaFinal.length, 1);
  assert.equal(alphaFinal.every((token) => token.state === "revoked"), true);
  assert.equal((await service.listMcpTokens(beta))[0].state, "active");
  await expectLifecycleFailure(
    service.issueMcpToken(alpha, {
      name: "after deletion",
      scopes: ["content:read"],
    }),
    "principal_tokens_disabled",
  );
  assert.deepEqual(await service.revokeTokensForAccountDeletion(alpha.principalId), {
    revokedCount: 0,
    replayed: true,
  });
});
