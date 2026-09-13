import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { BackupClientError, backupStatus, openBackupCatalog, runBackup } from
  "./system-backup-client.mjs";
import { createRecoveryKit } from "./system-backup-kit.mjs";

const RETRYABLE = new Set(["transport_unavailable", "source_unavailable",
  "backup_unavailable"]);

function fail(code) { throw new BackupClientError(code); }
function required(condition, code) { if (!condition) fail(code); }
function time(value) { return typeof value === "string" &&
  Number.isFinite(Date.parse(value)); }

async function fsyncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, path);
  await fsyncDirectory(dirname(path));
}

export async function readRunnerConfig(configFile) {
  required(isAbsolute(configFile), "runner_config_not_absolute");
  const info = await lstat(configFile);
  required(info.isFile() && !info.isSymbolicLink() &&
    (info.mode & 0o077) === 0 &&
    (typeof process.getuid !== "function" || info.uid === process.getuid()),
  "runner_config_insecure");
  let config;
  try { config = JSON.parse(await readFile(configFile, "utf8")); }
  catch { fail("runner_config_invalid"); }
  let origin;
  try { origin = new URL(config.origin); }
  catch { fail("runner_config_invalid"); }
  required(config.format === "mind-diary-backup-runner/v1" &&
    origin.protocol === "https:" && origin.pathname === "/" &&
    !origin.username && !origin.password && !origin.search && !origin.hash &&
    isAbsolute(config.directory ?? "") &&
    isAbsolute(config.source_root ?? "") &&
    typeof config.keychain_service === "string" &&
    /^com\.xxsrez\.mind-diary-backup\.[a-z0-9-]+$/u.test(
      config.keychain_service) &&
    typeof config.keychain_account === "string" &&
    /^[0-9]+$/u.test(config.keychain_account) &&
    Number.isSafeInteger(config.stale_hours) &&
    config.stale_hours >= 1 && config.stale_hours <= 720 &&
    time(config.installed_at) &&
    /^[0-9a-f]{40}$/u.test(config.source_sha) &&
    Number.isSafeInteger(config.hour) && config.hour >= 0 &&
    config.hour <= 23 && Number.isSafeInteger(config.minute) &&
    config.minute >= 0 && config.minute <= 59,
  "runner_config_invalid");
  return config;
}

export function readOperatorKey(config) {
  if (process.platform !== "darwin") fail("keychain_requires_macos");
  const result = spawnSync("/usr/bin/security",
    ["find-generic-password", "-w", "-s", config.keychain_service,
      "-a", config.keychain_account],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 4096 });
  if (result.status !== 0) fail("operator_key_unavailable");
  const key = result.stdout.trimEnd();
  required(/^mdb_v1_[A-Za-z0-9_-]{43}$/u.test(key),
    "operator_key_invalid");
  return key;
}

async function recordedAttempt(configFile) {
  try {
    const value = JSON.parse(await readFile(join(dirname(configFile),
      "attempt.json"), "utf8"));
    return value?.format === "mind-diary-backup-attempt/v1" ? value : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("runner_attempt_corrupt");
  }
}

async function currentStatus(directory) {
  try { await stat(join(directory, "catalog.sqlite")); }
  catch (error) {
    if (error?.code === "ENOENT") return { last_success: null,
      pending: null, integrity: "no_backup" };
    throw error;
  }
  const catalog = await openBackupCatalog(directory);
  try { return backupStatus(catalog.db); }
  finally { catalog.close(); }
}

function ageHours(config, backup, now) {
  const start = backup.last_success?.completed_at ?? config.installed_at;
  return Math.max(0, (Date.parse(now) - Date.parse(start)) / 3_600_000);
}

export async function scheduledBackupStatus({ configFile,
  now = () => new Date() }) {
  const config = await readRunnerConfig(configFile);
  const backup = await currentStatus(config.directory);
  const attempt = await recordedAttempt(configFile);
  const age = ageHours(config, backup, now().toISOString());
  return { installed: true, last_success: backup.last_success,
    pending: backup.pending, integrity: backup.integrity,
    last_attempt: attempt ? { state: attempt.state,
      started_at: attempt.started_at, finished_at: attempt.finished_at ?? null,
      error: attempt.error ?? null, attempts: attempt.attempts } : null,
    stale: age >= config.stale_hours,
    stale_hours: config.stale_hours };
}

export function showBackupNotification() {
  if (process.platform !== "darwin") return false;
  const script = `display notification "No successful backup within the configured window. Check Mind Diary backup status." with title "Mind Diary backup"`;
  const result = spawnSync("/usr/bin/osascript", ["-e", script],
    { encoding: "utf8", timeout: 10_000 });
  return result.status === 0;
}

export async function runScheduledBackup({ configFile,
  keyProvider = readOperatorKey,
  runImpl = runBackup,
  kitCreator = createRecoveryKit,
  notifier = showBackupNotification,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => new Date() }) {
  const config = await readRunnerConfig(configFile);
  await mkdir(config.directory, { recursive: true, mode: 0o700 });
  const attemptFile = join(dirname(configFile), "attempt.json");
  const previous = await recordedAttempt(configFile);
  const startedAt = now().toISOString();
  const writeAttempt = (state, attempts, error = null, finishedAt = null,
    alerted = false) => atomicJson(attemptFile, {
      format: "mind-diary-backup-attempt/v1", state,
      started_at: startedAt, finished_at: finishedAt,
      attempts, error, alerted,
    });
  await writeAttempt("running", 0);
  let result;
  let failure = null;
  let attempts = 0;
  try {
    const key = await keyProvider(config);
    required(/^mdb_v1_[A-Za-z0-9_-]{43}$/u.test(key),
      "operator_key_invalid");
    for (attempts = 1; attempts <= 3; attempts += 1) {
      try {
        result = await runImpl({ directory: config.directory,
          origin: config.origin, key,
          signal: AbortSignal.timeout(4 * 60 * 60 * 1000),
          onStage: async (stage, details) => {
            if (stage === "after_receipt_before_catalog") {
              await kitCreator({ directory: config.directory,
                schemaDigest: details.schemaDigest,
                sourceRoot: config.source_root });
            }
          } });
        failure = null;
        break;
      } catch (error) {
        failure = error instanceof BackupClientError ? error.code
          : "local_failure";
        if (!RETRYABLE.has(failure) || attempts === 3) break;
        await writeAttempt("retrying", attempts, failure);
        await sleep(attempts === 1 ? 5_000 : 20_000);
      }
    }
  } catch (error) {
    failure = error instanceof BackupClientError ? error.code
      : "local_failure";
  }
  const finishedAt = now().toISOString();
  const backup = await currentStatus(config.directory);
  const stale = ageHours(config, backup, finishedAt) >= config.stale_hours;
  const alerted = Boolean(failure && stale && !previous?.alerted &&
    notifier());
  await writeAttempt(failure ? "failed" : "succeeded",
    Math.min(attempts, 3), failure, finishedAt, alerted);
  return { ok: failure === null, error: failure,
    last_success: backup.last_success, pending: backup.pending,
    attempts: Math.min(attempts, 3), stale,
    downloaded_objects: result?.downloaded_objects ?? null };
}
