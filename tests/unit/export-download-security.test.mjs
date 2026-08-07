import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPORT_DOWNLOAD_SECRET_LENGTH,
  EXPORT_DOWNLOAD_SECRET_PREFIX,
  EXPORT_DOWNLOAD_VERIFIER_PREFIX,
  ExportDownloadSecurityFailure,
  createWebCryptoExportDownloadSecretCrypto,
} from "../../packages/adapter-security-webcrypto/dist/index.js";

const TEST_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 91);

class InspectingCrypto {
  randomBuffers = [];
  messageBuffers = [];

  subtle = {
    importKey: (...arguments_) => globalThis.crypto.subtle.importKey(...arguments_),
    sign: async (...arguments_) => {
      this.messageBuffers.push(arguments_[2]);
      return globalThis.crypto.subtle.sign(...arguments_);
    },
  };

  getRandomValues(target) {
    this.randomBuffers.push(target);
    return globalThis.crypto.getRandomValues(target);
  }
}

test("dedicated export crypto issues a consume-once 256-bit secret and verifies by exact HMAC lookup", async () => {
  const crypto = new InspectingCrypto();
  const secretCrypto = await createWebCryptoExportDownloadSecretCrypto({
    verifierKey: TEST_KEY,
    crypto,
  });
  const issuance = await secretCrypto.issueSecret();
  const verifier = issuance.verifier();
  const secret = issuance.consumeSecret();

  assert.equal(typeof secret, "string");
  assert.equal(secret.length, EXPORT_DOWNLOAD_SECRET_LENGTH);
  assert.ok(secret.startsWith(EXPORT_DOWNLOAD_SECRET_PREFIX));
  assert.equal(
    Buffer.from(secret.slice(EXPORT_DOWNLOAD_SECRET_PREFIX.length), "base64url")
      .length,
    32,
  );
  assert.equal(issuance.consumeSecret(), null);
  assert.match(
    verifier,
    /^hmac-sha256:export-download:v1:[0-9a-f]{64}$/u,
  );

  let lookups = 0;
  const result = await secretCrypto.verifySecret(secret, {
    async findByVerifier(candidateVerifier) {
      lookups += 1;
      assert.equal(candidateVerifier, verifier);
      return {
        kind: "found",
        verifier,
        value: Object.freeze({ jobId: "export-security-job" }),
      };
    },
  });
  assert.deepEqual(result, {
    kind: "verified",
    value: { jobId: "export-security-job" },
  });
  assert.equal(lookups, 1);
  assert.ok(crypto.randomBuffers.every((bytes) => bytes.every((byte) => byte === 0)));
  assert.ok(crypto.messageBuffers.every((bytes) => bytes.every((byte) => byte === 0)));
});

test("invalid formats do not reach metadata and unknown canonical grants stay non-leaking", async () => {
  const secretCrypto = await createWebCryptoExportDownloadSecretCrypto({
    verifierKey: TEST_KEY,
  });
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
    "mdg_v1_short",
    `mdg_v2_${"A".repeat(43)}`,
    `${EXPORT_DOWNLOAD_SECRET_PREFIX}${"A".repeat(42)}=`,
    `${EXPORT_DOWNLOAD_SECRET_PREFIX}${"A".repeat(2_000)}`,
  ]) {
    assert.deepEqual(await secretCrypto.verifySecret(candidate, lookup), {
      kind: "invalid",
    });
  }
  assert.equal(lookups, 0);

  const issuance = await secretCrypto.issueSecret();
  const secret = issuance.consumeSecret();
  assert.deepEqual(await secretCrypto.verifySecret(secret, lookup), {
    kind: "invalid",
  });
  assert.equal(lookups, 1);
});

test("issuance serialization and configuration failures never expose bearer or verifier material", async () => {
  const secretCrypto = await createWebCryptoExportDownloadSecretCrypto({
    verifierKey: TEST_KEY,
  });
  const issuance = await secretCrypto.issueSecret();
  const verifier = issuance.verifier();
  const secret = issuance.consumeSecret();
  const serialized = JSON.stringify(issuance);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(verifier), false);
  assert.equal(serialized.includes(EXPORT_DOWNLOAD_VERIFIER_PREFIX), false);

  const shortKey = Uint8Array.from({ length: 31 }, () => 0xab);
  await assert.rejects(
    createWebCryptoExportDownloadSecretCrypto({ verifierKey: shortKey }),
    (error) => {
      assert.ok(error instanceof ExportDownloadSecurityFailure);
      assert.equal(error.code, "invalid_configuration");
      assert.equal(error.message.includes("ab"), false);
      return true;
    },
  );
});
