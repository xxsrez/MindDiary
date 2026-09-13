#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BackupClientError, openBackupCatalog } from
  "./lib/system-backup-client.mjs";
import { verifyRecoveryKit } from "./lib/system-backup-kit.mjs";
import { restoreBackup } from "./lib/system-backup-restore.mjs";
import { startRestoredViewer } from "./lib/system-backup-viewer.mjs";

function argumentsFrom(args) {
  if (args[0] === "restore" && args[1] === "--directory" &&
    isAbsolute(args[2] ?? "") && args[3] === "--target" &&
    isAbsolute(args[4] ?? "") && args.length === 5) {
    return { command: "restore", directory: args[2], target: args[4] };
  }
  if (args[0] === "serve" && args[1] === "--target" &&
    isAbsolute(args[2] ?? "") && args.length === 3) {
    return { command: "serve", target: args[2] };
  }
  throw new BackupClientError("usage: system-backup-restore.mjs restore --directory /absolute/backup --target /absolute/empty | serve --target /absolute/restored");
}

async function main() {
  const { command, directory, target } = argumentsFrom(process.argv.slice(2));
  if (command === "restore" && process.env.MD_BACKUP_LOCKED !== "1") {
    const lock = process.platform === "darwin" ? "/usr/bin/lockf" : "flock";
    const lockArgs = process.platform === "darwin"
      ? ["-t", "0", join(directory, ".writer.lock")]
      : ["-n", join(directory, ".writer.lock")];
    const child = spawnSync(lock, [...lockArgs, process.execPath,
      fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: "inherit", env: { ...process.env, MD_BACKUP_LOCKED: "1" },
    });
    if (child.error) throw new BackupClientError("lock_unavailable");
    process.exitCode = child.status ?? 1;
    return;
  }
  if (command === "restore") {
    const result = await restoreBackup({ directory, target,
      verifyKit: async () => {
        const catalog = await openBackupCatalog(directory);
        try {
          const row = catalog.db.prepare(`SELECT checkpoint_json FROM backup_state
            WHERE singleton=1`).get();
          if (!row) throw new BackupClientError("no_successful_backup");
          const checkpoint = JSON.parse(row.checkpoint_json);
          await verifyRecoveryKit(directory, checkpoint.schema_digest);
        } finally { catalog.close(); }
      } });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const viewer = await startRestoredViewer({ target });
    process.stdout.write(`${viewer.url}\n`);
  }
}

main().catch((error) => {
  const code = error instanceof BackupClientError ? error.code : "local_failure";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
