import type { D1DatabaseLike } from "@mind-diary/adapter-metadata-sites";
import type { CanonicalMutationGate } from "@mind-diary/adapter-object-sites";

const encoder = new TextEncoder();
const MAX_WAIT_MS = 3_000;

async function keyDigest(key: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(key));
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** A failed or uncertain R2 operation keeps its D1 gate until operator reconciliation. */
export class SitesCanonicalKeyGate implements CanonicalMutationGate {
  readonly #database: D1DatabaseLike;

  constructor(database: D1DatabaseLike) {
    this.#database = database;
  }

  async beginCreationIntent(intentId: string, keys: readonly string[], createdAt: string): Promise<void> {
    if (keys.length === 0 || keys.length > 32 || new Set(keys).size !== keys.length) {
      throw new Error("invalid canonical creation intent keys");
    }
    const digests = await Promise.all(keys.map(keyDigest));
    await this.#database.batch(digests.map((digest) => this.#database.prepare(
      `/*md-canonical-creation-begin*/ INSERT INTO md_canonical_creation_intents
       (intent_id, key_digest, created_at) VALUES (?1, ?2, ?3)`,
    ).bind(intentId, digest, createdAt)));
  }

  async completeCreationIntent(intentId: string): Promise<void> {
    await this.#database.prepare(
      `/*md-canonical-creation-complete*/ DELETE FROM md_canonical_creation_intents
       WHERE intent_id = ?1`,
    ).bind(intentId).run();
  }

  async hasCreationIntent(key: string): Promise<boolean> {
    const digest = await keyDigest(key);
    const rows = await this.#database.prepare(
      `/*md-canonical-creation-check*/ SELECT 1 AS pending FROM md_canonical_creation_intents
       WHERE key_digest = ?1 LIMIT 1`,
    ).bind(digest).all();
    return (rows.results?.length ?? 0) > 0;
  }

  async run<Result>(
    key: string,
    operation: (markMutationStarted: () => () => void) => Promise<Result>,
  ): Promise<Result> {
    const digest = await keyDigest(key);
    const operationId = crypto.randomUUID();
    const deadline = Date.now() + MAX_WAIT_MS;
    while (true) {
      const acquired = await this.#database.prepare(
        `/*md-canonical-gate-acquire*/ INSERT OR IGNORE INTO md_canonical_key_gates
         (key_digest, operation_id, acquired_at) VALUES (?1, ?2, ?3)`,
      ).bind(digest, operationId, new Date().toISOString()).run();
      if (acquired.meta?.changes === 1) break;
      if (Date.now() >= deadline) throw new Error("canonical object key is busy or has an uncertain storage outcome");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // A provider call may still complete after an error. A confirmed failed
    // conditional PUT has no effect; every other attempted mutation retains
    // the gate on an error.
    let result: Result;
    let unresolvedOrAppliedMutations = 0;
    try {
      result = await operation(() => {
        unresolvedOrAppliedMutations += 1;
        let confirmedNoEffect = false;
        return () => {
          if (confirmedNoEffect) return;
          confirmedNoEffect = true;
          unresolvedOrAppliedMutations -= 1;
        };
      });
    } catch (error) {
      if (unresolvedOrAppliedMutations !== 0) throw error;
      const released = await this.#database.prepare(
        `/*md-canonical-gate-release*/ DELETE FROM md_canonical_key_gates
         WHERE key_digest = ?1 AND operation_id = ?2`,
      ).bind(digest, operationId).run();
      if (released.meta?.changes !== 1) {
        throw new Error("canonical object gate release was not confirmed");
      }
      throw error;
    }
    const released = await this.#database.prepare(
      `/*md-canonical-gate-release*/ DELETE FROM md_canonical_key_gates
       WHERE key_digest = ?1 AND operation_id = ?2`,
    ).bind(digest, operationId).run();
    if (released.meta?.changes !== 1) {
      throw new Error("canonical object gate release was not confirmed");
    }
    return result;
  }
}
