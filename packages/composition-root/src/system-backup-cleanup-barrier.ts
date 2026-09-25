import type { D1DatabaseLike } from "@mind-diary/adapter-metadata-sites";

function changed(result: Readonly<{ meta?: Readonly<{ changes?: number }> }>): boolean {
  return result.meta?.changes === 1;
}

/** Registers a physical canonical delete before its first R2 operation. */
export class SystemBackupCleanupBarrier {
  readonly #database: D1DatabaseLike;
  readonly #now: () => Date;

  constructor(database: D1DatabaseLike, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async run(operation: () => Promise<boolean>): Promise<boolean> {
    const id = crypto.randomUUID();
    const now = this.#now().toISOString();
    const admitted = await this.#database.prepare(
      `/*md-backup-cleanup-admit*/ INSERT INTO md_backup_cleanup_ops
       (operation_id, started_at)
       SELECT ?1, ?2
       WHERE NOT EXISTS (
         SELECT 1 FROM md_backup_sessions
         WHERE status IN ('building', 'ready') AND expires_at > ?2
       )`,
    ).bind(id, now).run();
    if (!changed(admitted)) return false;
    let phase = "operation";
    try {
      const outcome = await operation();
      // A rejected completion write leaves the operation registered. New
      // sessions fail closed until an operator reconciles that uncertain R2
      // outcome; no automatic lease timeout can prove it finished.
      phase = "finish";
      await this.#database.prepare(
        `/*md-backup-cleanup-finish*/ DELETE FROM md_backup_cleanup_ops
         WHERE operation_id = ?1`,
      ).bind(id).run();
      return outcome;
    } catch (error) {
      // A physical R2 mutation may have reached the provider. Preserve the
      // admission record rather than letting a new session pin stale bytes.
      console.error(JSON.stringify({ event: "md-backup-cleanup-failure", phase,
        error_code: error instanceof Error ? error.name : "unknown" }));
      throw error;
    }
  }
}
