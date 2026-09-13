#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BackupClientError,
  backupStatus,
  checkBackupIntegrity,
  collectBackupGarbage,
  openBackupCatalog,
  runBackup,
} from "./lib/system-backup-client.mjs";
import { createRecoveryKit, verifyRecoveryKit } from "./lib/system-backup-kit.mjs";

function argumentsFrom(argv) {
  const [command, flag, directory] = argv;
  if (!["run", "status", "integrity", "gc"].includes(command) ||
    flag !== "--directory" || !directory || !isAbsolute(directory) ||
    argv.length !== 3) {
    throw new BackupClientError("usage: system-backup.mjs run|status|integrity|gc --directory /absolute/private/path");
  }
  return { command, directory };
}

async function main() {
  const { command, directory } = argumentsFrom(process.argv.slice(2));
  if (process.env.MD_BACKUP_LOCKED !== "1") {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const commandPath = fileURLToPath(import.meta.url);
    const lockPath = join(directory, ".writer.lock");
    const lock = process.platform === "darwin" ? "/usr/bin/lockf" : "flock";
    const lockArgs = process.platform === "darwin"
      ? ["-t", "0", lockPath] : ["-n", lockPath];
    const child = spawnSync(lock, [...lockArgs, process.execPath, commandPath,
      ...process.argv.slice(2)], {
      env: { ...process.env, MD_BACKUP_LOCKED: "1" },
      stdio: "inherit",
    });
    if (child.error) throw new BackupClientError("lock_unavailable");
    process.exitCode = child.status ?? 1;
    return;
  }
  let result;
  if (command === "run") {
    result = await runBackup({ directory,
      origin: process.env.MIND_DIARY_BACKUP_ORIGIN,
      key: process.env.MIND_DIARY_BACKUP_OPERATOR_KEY,
      onStage: async (stage, details) => {
        if (stage === "after_receipt_before_catalog") {
          await createRecoveryKit({ directory,
            schemaDigest: details.schemaDigest });
        }
      } });
  } else if (command === "integrity") {
    result = await checkBackupIntegrity({ directory });
    const catalog = await openBackupCatalog(directory);
    try {
      const state = catalog.db.prepare(`SELECT checkpoint_json FROM backup_state
        WHERE singleton=1`).get();
      await verifyRecoveryKit(directory,
        JSON.parse(state.checkpoint_json).schema_digest);
      result.kit = "verified";
    } finally { catalog.close(); }
  } else if (command === "gc") {
    result = await collectBackupGarbage({ directory });
  } else {
    const catalog = await openBackupCatalog(directory);
    try { result = backupStatus(catalog.db); }
    finally { catalog.close(); }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  const code = error instanceof BackupClientError ? error.code : "local_failure";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
