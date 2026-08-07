import { arch, cpus, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import process from "node:process";

import { createWebCryptoTokenHasher } from "../packages/adapter-security-webcrypto/dist/index.js";

const HMAC_ITERATIONS = 1_000;
const HMAC_WARMUP = 100;
const PBKDF2_ITERATIONS = [100_000, 310_000];
const PBKDF2_SAMPLES = 12;
const PBKDF2_WARMUP = 2;

function percentile(sorted, fraction) {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index];
}

async function measure(name, warmup, iterations, operation) {
  for (let index = 0; index < warmup; index += 1) await operation();
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    await operation();
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  return {
    name,
    samples: iterations,
    p50_ms: Number(percentile(samples, 0.5).toFixed(3)),
    p95_ms: Number(percentile(samples, 0.95).toFixed(3)),
    mean_ms: Number(
      (samples.reduce((total, sample) => total + sample, 0) / samples.length).toFixed(3),
    ),
  };
}

const verifierKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const hasher = await createWebCryptoTokenHasher({ verifierKey });
const issuance = await hasher.issueSecret();
const secret = issuance.consumeSecret();
const persisted = issuance.persistence();
const foundLookup = Object.freeze({
  async findByVerifier(verifier) {
    if (verifier !== persisted.verifier) return { kind: "not_found" };
    return { kind: "found", verifier: persisted.verifier, value: true };
  },
});
const missingLookup = Object.freeze({
  async findByVerifier() {
    return { kind: "not_found" };
  },
});

const pbkdf2Input = await crypto.subtle.importKey(
  "raw",
  Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
  "PBKDF2",
  false,
  ["deriveBits"],
);
const salt = new TextEncoder().encode("mind-diary-token-benchmark-v1");

const results = [];
results.push(
  await measure("hmac-sha256-valid-exact-lookup", HMAC_WARMUP, HMAC_ITERATIONS, async () => {
    await hasher.verifySecret(secret, foundLookup);
  }),
);
results.push(
  await measure("hmac-sha256-unknown-exact-lookup", HMAC_WARMUP, HMAC_ITERATIONS, async () => {
    await hasher.verifySecret(secret, missingLookup);
  }),
);
for (const iterations of PBKDF2_ITERATIONS) {
  results.push(
    await measure(
      `pbkdf2-sha256-${iterations}`,
      PBKDF2_WARMUP,
      PBKDF2_SAMPLES,
      async () => {
        await crypto.subtle.deriveBits(
          { name: "PBKDF2", hash: "SHA-256", salt, iterations },
          pbkdf2Input,
          256,
        );
      },
    ),
  );
}

console.log(
  JSON.stringify(
    {
      benchmark: "mind-diary-token-verifier-v1",
      node: process.version,
      os: `${platform()} ${release()}`,
      arch: arch(),
      cpu: cpus()[0]?.model ?? "unknown",
      parameters: {
        hmac_samples: HMAC_ITERATIONS,
        pbkdf2_samples: PBKDF2_SAMPLES,
        pbkdf2_iterations: PBKDF2_ITERATIONS,
      },
      results,
      note: "Synthetic local crypto latency; storage/network latency is excluded.",
    },
    null,
    2,
  ),
);
