import assert from "node:assert/strict";
import test from "node:test";

import {
  TOKEN_SECRET_BODY_LENGTH,
  TOKEN_SECRET_LENGTH,
  TOKEN_SECRET_PREFIX,
  TOKEN_VERIFIER_PREFIX,
  TokenSecurityFailure,
  createWebCryptoTokenHasher,
} from "../../packages/adapter-security-webcrypto/dist/index.js";

const TEST_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

async function createHasher() {
  return createWebCryptoTokenHasher({ verifierKey: TEST_KEY });
}

test("issues a 256-bit canonical secret and verifies it by exact HMAC lookup", async () => {
  const hasher = await createHasher();
  const issuance = await hasher.issueSecret();
  const persisted = issuance.persistence();
  const secret = issuance.consumeSecret();

  assert.equal(typeof secret, "string");
  assert.equal(secret.length, TOKEN_SECRET_LENGTH);
  assert.ok(secret.startsWith(TOKEN_SECRET_PREFIX));
  const body = secret.slice(TOKEN_SECRET_PREFIX.length);
  assert.equal(body.length, TOKEN_SECRET_BODY_LENGTH);
  assert.equal(Buffer.from(body, "base64url").length, 32);
  assert.equal(issuance.consumeSecret(), null);
  assert.match(persisted.verifier, /^hmac-sha256:v1:[0-9a-f]{64}$/);
  assert.ok(persisted.displayPrefix.endsWith("…"));

  let lookups = 0;
  const result = await hasher.verifySecret(secret, {
    async findByVerifier(verifier) {
      lookups += 1;
      assert.equal(verifier, persisted.verifier);
      return {
        kind: "found",
        verifier: persisted.verifier,
        value: Object.freeze({ tokenId: "tok_positive" }),
      };
    },
  });

  assert.deepEqual(result, {
    kind: "verified",
    value: { tokenId: "tok_positive" },
  });
  assert.equal(lookups, 1);
});

test("rejects invalid or oversized formats before lookup and unknown canonical tokens generically", async () => {
  const hasher = await createHasher();
  let lookups = 0;
  const lookup = {
    async findByVerifier() {
      lookups += 1;
      return { kind: "not_found" };
    },
  };

  for (const candidate of [
    null,
    "",
    "mdp_v2_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    `${TOKEN_SECRET_PREFIX}${"A".repeat(42)}=`,
    `${TOKEN_SECRET_PREFIX}${"A".repeat(2_000)}`,
  ]) {
    assert.deepEqual(await hasher.verifySecret(candidate, lookup), {
      kind: "invalid",
    });
  }
  assert.equal(lookups, 0);

  const issuance = await hasher.issueSecret();
  const secret = issuance.consumeSecret();
  const bodyStart = TOKEN_SECRET_PREFIX.length;
  const firstBodyCharacter = secret[bodyStart];
  const changed = `${secret.slice(0, bodyStart)}${firstBodyCharacter === "A" ? "B" : "A"}${secret.slice(bodyStart + 1)}`;
  assert.deepEqual(await hasher.verifySecret(changed, lookup), {
    kind: "invalid",
  });
  assert.equal(lookups, 1);
});

test("maps a denied exact lookup to the same non-leaking invalid result", async () => {
  const hasher = await createHasher();
  const issuance = await hasher.issueSecret();
  const secret = issuance.consumeSecret();
  const result = await hasher.verifySecret(secret, {
    async findByVerifier() {
      return { kind: "denied" };
    },
  });

  assert.deepEqual(result, { kind: "invalid" });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(TOKEN_VERIFIER_PREFIX), false);
});

test("retry issuance never recovers the old secret and creates independent material", async () => {
  const hasher = await createHasher();
  const first = await hasher.issueSecret();
  const firstSecret = first.consumeSecret();
  const firstPersistence = first.persistence();
  const retry = await hasher.issueSecret();
  const retrySecret = retry.consumeSecret();
  const retryPersistence = retry.persistence();

  assert.equal(first.consumeSecret(), null);
  assert.notEqual(retrySecret, firstSecret);
  assert.notEqual(retryPersistence.verifier, firstPersistence.verifier);
});

test("concurrent issuance has no shared mutable secret or verifier state", async () => {
  const hasher = await createHasher();
  const issuances = await Promise.all(
    Array.from({ length: 128 }, () => hasher.issueSecret()),
  );
  const secrets = issuances.map((issuance) => issuance.consumeSecret());
  const verifiers = issuances.map(
    (issuance) => issuance.persistence().verifier,
  );

  assert.equal(new Set(secrets).size, issuances.length);
  assert.equal(new Set(verifiers).size, issuances.length);
  assert.ok(issuances.every((issuance) => issuance.consumeSecret() === null));
});

test("serialization and failures do not leak secret or verifier material", async () => {
  const hasher = await createHasher();
  const issuance = await hasher.issueSecret();
  const persisted = issuance.persistence();
  const secret = issuance.consumeSecret();
  const serializedIssuance = JSON.stringify(issuance);

  assert.equal(serializedIssuance.includes(secret), false);
  assert.equal(serializedIssuance.includes(persisted.verifier), false);
  assert.equal(serializedIssuance.includes(persisted.displayPrefix), true);
  assert.deepEqual(Object.keys(persisted), []);
  assert.equal(JSON.stringify(persisted).includes(secret), false);
  assert.equal(JSON.stringify(persisted).includes(persisted.verifier), false);

  await assert.rejects(
    hasher.verifySecret(secret, {
      async findByVerifier() {
        throw new Error(`unsafe storage detail ${secret} ${persisted.verifier}`);
      },
    }),
    (error) => {
      assert.ok(error instanceof TokenSecurityFailure);
      assert.equal(error.code, "verification_unavailable");
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes(persisted.verifier), false);
      const serializedError = JSON.stringify(error);
      assert.equal(serializedError.includes(secret), false);
      assert.equal(serializedError.includes(persisted.verifier), false);
      return true;
    },
  );
});

test("rejects verifier keys shorter than 256 bits without exposing key material", async () => {
  const shortKey = Uint8Array.from({ length: 31 }, () => 0xab);
  await assert.rejects(
    createWebCryptoTokenHasher({ verifierKey: shortKey }),
    (error) => {
      assert.ok(error instanceof TokenSecurityFailure);
      assert.equal(error.code, "invalid_configuration");
      assert.equal(error.message.includes("ab"), false);
      return true;
    },
  );
});
