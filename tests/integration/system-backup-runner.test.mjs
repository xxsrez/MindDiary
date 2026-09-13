import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from
  "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BackupClientError } from
  "../../scripts/lib/system-backup-client.mjs";
import { runScheduledBackup, scheduledBackupStatus } from
  "../../scripts/lib/system-backup-runner.mjs";
import { installScheduledBackup, installedBackupStatus,
  uninstallScheduledBackup } from
  "../../scripts/lib/system-backup-scheduler.mjs";

const KEY = `mdb_v1_${Buffer.alloc(32, 7).toString("base64url")}`;
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ORIGIN = "https://mind-diary.test";

async function temporaryConfig(start = "2026-09-13T00:00:00.000Z") {
  const home = await mkdtemp(join(tmpdir(), "mind-diary-backup-runner-"));
  const privateRoot = join(home, "private");
  await mkdir(privateRoot, { mode: 0o700 });
  const configFile = join(privateRoot, "config.json");
  await writeFile(configFile, JSON.stringify({
    format: "mind-diary-backup-runner/v1", origin: ORIGIN,
    directory: join(home, "backup"), source_root: ROOT,
    keychain_service: "com.xxsrez.mind-diary-backup.uat",
    keychain_account: String(process.getuid()),
    stale_hours: 48, installed_at: start,
    source_sha: "0".repeat(40), hour: 3, minute: 0,
  }), { mode: 0o600 });
  return { home, configFile,
    async close() { await rm(home, { recursive: true, force: true }); } };
}

test("scheduled runner retries transient failure, records a safe attempt and never logs a credential", async () => {
  const f = await temporaryConfig();
  try {
    let calls = 0;
    let kits = 0;
    let slept = 0;
    const result = await runScheduledBackup({ configFile: f.configFile,
      keyProvider: async () => KEY,
      runImpl: async ({ onStage }) => {
        calls += 1;
        if (calls === 1) throw new BackupClientError("transport_unavailable");
        await onStage("after_receipt_before_catalog",
          { schemaDigest: `sha256:${"a".repeat(64)}` });
        return { downloaded_objects: 2 };
      },
      kitCreator: async () => { kits += 1; },
      sleep: async (ms) => { slept += ms; },
      now: () => new Date("2026-09-13T01:00:00.000Z"),
    });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.equal(calls, 2);
    assert.equal(kits, 1);
    assert.equal(slept, 5_000);
    const status = await scheduledBackupStatus({ configFile: f.configFile,
      now: () => new Date("2026-09-13T01:00:00.000Z") });
    assert.equal(status.last_success, null);
    assert.equal(status.last_attempt.state, "succeeded");
    const attempt = await readFile(join(dirname(f.configFile),
      "attempt.json"), "utf8");
    assert.equal(attempt.includes(KEY), false);
    assert.equal(attempt.includes(ORIGIN), false);
    assert.equal(attempt.includes(f.home), false);
  } finally { await f.close(); }
});

test("a stale failed run alerts once while last success remains separately reported", async () => {
  const f = await temporaryConfig();
  try {
    let notifications = 0;
    const options = { configFile: f.configFile,
      keyProvider: async () => { throw new BackupClientError(
        "operator_key_unavailable"); },
      notifier: () => { notifications += 1; return true; },
      now: () => new Date("2026-09-15T01:00:00.000Z") };
    const first = await runScheduledBackup(options);
    assert.equal(first.ok, false);
    assert.equal(first.error, "operator_key_unavailable");
    assert.equal(first.last_success, null);
    assert.equal(first.stale, true);
    assert.equal(notifications, 1);
    const second = await runScheduledBackup(options);
    assert.equal(second.ok, false);
    assert.equal(notifications, 1);
    const status = await scheduledBackupStatus(options);
    assert.equal(status.last_attempt.state, "failed");
    assert.equal(status.last_attempt.error, "operator_key_unavailable");
    assert.equal(status.last_success, null);
  } finally { await f.close(); }
});

test("macOS install creates a private independent source and launch agent; uninstall preserves backup data", {
  skip: process.platform !== "darwin",
}, async () => {
  const home = await mkdtemp(join(tmpdir(), "mind-diary-backup-install-"));
  const backup = join(home, "backup-data");
  const called = [];
  const execute = (program, args) => {
    if (program === "/bin/launchctl") {
      called.push(args[0]);
      return "";
    }
    const result = spawnSync(program, args, { encoding: "utf8",
      timeout: 120_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    const installed = await installScheduledBackup({ directory: backup,
      origin: ORIGIN, home, sourceRoot: ROOT, execute,
      keyProvider: async () => KEY,
      now: () => new Date("2026-09-13T00:00:00.000Z") });
    assert.equal(installed.installed, true);
    const appRoot = join(home, "Library", "Application Support",
      "MindDiaryBackup");
    const agentPath = join(home, "Library", "LaunchAgents",
      "com.xxsrez.mind-diary-backup.uat.plist");
    const configFile = join(appRoot, "config.json");
    assert.equal((await stat(configFile)).mode & 0o077, 0);
    const xml = await readFile(agentPath, "utf8");
    assert.match(xml, /StartCalendarInterval/u);
    assert.match(xml, /RunAtLoad/u);
    assert.equal(xml.includes(KEY), false);
    assert.equal((await stat(join(appRoot, "runtime", "node"))).isFile(),
      true);
    const copiedRuntime = spawnSync(join(appRoot, "runtime", "node"),
      ["--version"], { encoding: "utf8" });
    assert.equal(copiedRuntime.status, 0, copiedRuntime.stderr);
    assert.equal((await stat(join(appRoot, "source", "package-lock.json")))
      .isFile(), true);
    const status = await installedBackupStatus({ home, execute,
      now: () => new Date("2026-09-13T00:01:00.000Z") });
    assert.equal(status.scheduler_loaded, true);
    assert.equal(status.last_success, null);
    await writeFile(join(backup, "sentinel"), "keep");
    const removed = await uninstallScheduledBackup({ home, execute });
    assert.equal(removed.installed, false);
    assert.equal(removed.backup_preserved, true);
    assert.equal(await readFile(join(backup, "sentinel"), "utf8"), "keep");
    assert.deepEqual(called, ["bootstrap", "print", "bootout"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});
