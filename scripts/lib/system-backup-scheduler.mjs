import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm,
  stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { BackupClientError } from "./system-backup-client.mjs";
import { readOperatorKey, readRunnerConfig, scheduledBackupStatus } from
  "./system-backup-runner.mjs";
import { copyPortableNode } from "./system-backup-kit.mjs";

const LABEL = "com.xxsrez.mind-diary-backup.uat";
const SERVICE = "com.xxsrez.mind-diary-backup.uat";

function fail(code) { throw new BackupClientError(code); }
function required(condition, code) { if (!condition) fail(code); }
function inside(path, parent) { return path === parent ||
  path.startsWith(`${parent}${sep}`); }
function xml(value) { return String(value).replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: "utf8",
    timeout: 120_000, maxBuffer: 8192, ...options });
  required(result.status === 0, "scheduler_command_failed");
  return result.stdout.trim();
}

function sourceSha(sourceRoot) {
  const sha = command("git", ["-C", sourceRoot, "rev-parse", "HEAD"]);
  required(/^[0-9a-f]{40}$/u.test(sha) &&
    command("git", ["-C", sourceRoot, "status", "--porcelain",
      "--untracked-files=all"]) === "", "scheduler_source_dirty");
  return sha;
}

function location(home) {
  required(isAbsolute(home), "scheduler_home_not_absolute");
  return {
    appRoot: join(home, "Library", "Application Support", "MindDiaryBackup"),
    agentPath: join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
  };
}

function plist({ runtime, script, configFile, hour, minute }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(runtime)}</string>
    <string>${xml(script)}</string>
    <string>run</string><string>--config</string>
    <string>${xml(configFile)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartCalendarInterval</key><dict>
    <key>Hour</key><integer>${hour}</integer>
    <key>Minute</key><integer>${minute}</integer>
  </dict>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`;
}

async function fsyncPath(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function installScheduledBackup({ directory, origin,
  hour = 3, minute = 0, staleHours = 48,
  home = homedir(), sourceRoot,
  runtimeNode = process.env.MIND_DIARY_BACKUP_RUNTIME_NODE || process.execPath,
  keyProvider = readOperatorKey,
  execute = command,
  now = () => new Date() }) {
  required(process.platform === "darwin", "scheduler_requires_macos");
  const { appRoot, agentPath } = location(home);
  const backupDirectory = resolve(directory ?? "");
  required(isAbsolute(directory ?? "") &&
    !inside(backupDirectory, appRoot) &&
    !inside(backupDirectory, join(home, "Library", "CloudStorage")) &&
    !backupDirectory.includes(`${sep}Google Drive${sep}`) &&
    Number.isSafeInteger(hour) && hour >= 0 && hour <= 23 &&
    Number.isSafeInteger(minute) && minute >= 0 && minute <= 59 &&
    Number.isSafeInteger(staleHours) && staleHours >= 1 &&
    staleHours <= 720 && isAbsolute(sourceRoot ?? ""),
  "scheduler_invalid_configuration");
  let url;
  try { url = new URL(origin); }
  catch { fail("scheduler_invalid_origin"); }
  required(url.protocol === "https:" && url.pathname === "/" &&
    !url.username && !url.password && !url.search && !url.hash,
  "scheduler_invalid_origin");
  try { await lstat(appRoot); fail("scheduler_already_installed"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  try { await lstat(agentPath); fail("scheduler_already_installed"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const sha = sourceSha(sourceRoot);
  const config = { format: "mind-diary-backup-runner/v1", origin,
    directory: backupDirectory, source_root: join(appRoot, "source"),
    keychain_service: SERVICE,
    keychain_account: String(process.getuid()),
    stale_hours: staleHours, installed_at: now().toISOString(),
    source_sha: sha, hour, minute };
  await keyProvider(config);
  await mkdir(dirname(appRoot), { recursive: true, mode: 0o700 });
  await mkdir(dirname(agentPath), { recursive: true, mode: 0o700 });
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const backupInfo = await lstat(backupDirectory);
  required(backupInfo.isDirectory() && !backupInfo.isSymbolicLink() &&
    (backupInfo.mode & 0o077) === 0 &&
    backupInfo.uid === process.getuid(), "insecure_directory");
  let stage;
  let committed = false;
  try {
    stage = await mkdtemp(`${appRoot}.staging-`);
    await mkdir(join(stage, "runtime"), { mode: 0o700 });
    await copyPortableNode(runtimeNode, join(stage, "runtime", "node"));
    execute("git", ["clone", "--quiet", "--no-hardlinks",
      "--no-checkout", sourceRoot, join(stage, "source")]);
    execute("git", ["-C", join(stage, "source"), "checkout", "--quiet",
      "--detach", sha]);
    required(execute("git", ["-C", join(stage, "source"),
      "status", "--porcelain", "--untracked-files=all"]) === "",
    "scheduler_clone_dirty");
    await writeFile(join(stage, "config.json"),
      `${JSON.stringify(config)}\n`, { mode: 0o600 });
    await fsyncPath(join(stage, "config.json"));
    await fsyncPath(join(stage, "runtime", "node"));
    await fsyncPath(join(stage, "runtime"));
    await fsyncPath(stage);
    await rename(stage, appRoot);
    stage = undefined;
    await fsyncPath(dirname(appRoot));
    const xmlSource = plist({ runtime: join(appRoot, "runtime", "node"),
      script: join(appRoot, "source", "scripts", "system-backup-runner.mjs"),
      configFile: join(appRoot, "config.json"), hour, minute });
    await writeFile(agentPath, xmlSource, { mode: 0o600, flag: "wx" });
    await fsyncPath(agentPath);
    execute("/usr/bin/plutil", ["-lint", agentPath]);
    execute("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`,
      agentPath]);
    committed = true;
    return { installed: true, source_sha: sha,
      schedule: { hour, minute, run_at_load: true },
      stale_hours: staleHours };
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    if (!committed) {
      await rm(agentPath, { force: true });
      await rm(appRoot, { recursive: true, force: true });
    }
  }
}

export async function installedBackupStatus({ home = homedir(),
  execute = command, now = () => new Date() }) {
  const { appRoot, agentPath } = location(home);
  const configFile = join(appRoot, "config.json");
  const config = await readRunnerConfig(configFile);
  let loaded = false;
  try {
    execute("/bin/launchctl", ["print", `gui/${process.getuid()}/${LABEL}`]);
    loaded = true;
  } catch { /* Missing or unloaded agent is a status, not success. */ }
  const agent = await lstat(agentPath);
  required(agent.isFile() && !agent.isSymbolicLink() &&
    (agent.mode & 0o077) === 0, "scheduler_agent_insecure");
  return { ...(await scheduledBackupStatus({ configFile, now })),
    scheduler_loaded: loaded,
    source_sha: config.source_sha,
    schedule: { hour: config.hour, minute: config.minute,
      run_at_load: true } };
}

export async function uninstallScheduledBackup({ home = homedir(),
  execute = command }) {
  const { appRoot, agentPath } = location(home);
  let directory = null;
  try {
    const config = await readRunnerConfig(join(appRoot, "config.json"));
    directory = config.directory;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try { execute("/bin/launchctl", ["bootout", `gui/${process.getuid()}`,
    agentPath]); }
  catch { /* A previously unloaded agent is already stopped. */ }
  await rm(agentPath, { force: true });
  await rm(appRoot, { recursive: true, force: true });
  return { installed: false, backup_preserved: directory !== null,
    keychain_item_preserved: true };
}
