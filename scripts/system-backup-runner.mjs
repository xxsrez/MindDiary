#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BackupClientError } from "./lib/system-backup-client.mjs";
import { readRunnerConfig, runScheduledBackup } from
  "./lib/system-backup-runner.mjs";
import { installScheduledBackup, installedBackupStatus,
  uninstallScheduledBackup } from "./lib/system-backup-scheduler.mjs";

function options(argv) {
  const [command, ...rest] = argv;
  if (!["install", "run", "status", "uninstall"].includes(command) ||
    rest.length % 2 !== 0) {
    throw new BackupClientError("runner_usage");
  }
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!flag.startsWith("--") || flag in values) {
      throw new BackupClientError("runner_usage");
    }
    values[flag] = rest[index + 1];
  }
  if (command === "run" && Object.keys(values).length === 1 &&
    isAbsolute(values["--config"] ?? "")) {
    return { command, configFile: values["--config"] };
  }
  if (command === "install" &&
    Object.keys(values).every((flag) => ["--directory", "--origin",
      "--hour", "--minute", "--stale-hours"].includes(flag)) &&
    isAbsolute(values["--directory"] ?? "") &&
    typeof values["--origin"] === "string") {
    return { command, directory: values["--directory"],
      origin: values["--origin"],
      hour: values["--hour"] === undefined ? 3 : Number(values["--hour"]),
      minute: values["--minute"] === undefined ? 0 : Number(values["--minute"]),
      staleHours: values["--stale-hours"] === undefined ? 48
        : Number(values["--stale-hours"]) };
  }
  if (["status", "uninstall"].includes(command) &&
    Object.keys(values).length === 0) return { command };
  throw new BackupClientError("runner_usage");
}

async function main() {
  const input = options(process.argv.slice(2));
  let result;
  if (input.command === "install") {
    result = await installScheduledBackup({ ...input,
      sourceRoot: fileURLToPath(new URL("../", import.meta.url)) });
  } else if (input.command === "uninstall") {
    result = await uninstallScheduledBackup({});
  } else if (input.command === "status") {
    result = await installedBackupStatus({});
  } else {
    const config = await readRunnerConfig(input.configFile);
    if (process.env.MD_BACKUP_LOCKED !== "1") {
      const lock = process.platform === "darwin" ? "/usr/bin/lockf" : "flock";
      const lockPath = join(config.directory, ".writer.lock");
      const lockArgs = process.platform === "darwin"
        ? ["-t", "0", lockPath] : ["-n", lockPath];
      const child = spawnSync(lock, [...lockArgs, process.execPath,
        fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
          env: { ...process.env, MD_BACKUP_LOCKED: "1" },
          stdio: "inherit" });
      if (child.error) throw new BackupClientError("lock_unavailable");
      process.exitCode = child.status ?? 1;
      return;
    }
    result = await runScheduledBackup({ configFile: input.configFile });
    if (!result.ok) process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  const code = error instanceof BackupClientError ? error.code : "local_failure";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
