import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm,
  stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BackupClientError } from "./system-backup-client.mjs";

const DIGEST = /^sha256:([0-9a-f]{64})$/u;
const FILES = Object.freeze([
  "scripts/system-backup-restore.mjs",
  "scripts/lib/system-backup-client.mjs",
  "scripts/lib/system-backup-restore.mjs",
  "scripts/lib/system-backup-kit.mjs",
  "scripts/lib/system-backup-viewer.mjs",
]);
const SOURCE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function fail(code) { throw new BackupClientError(code); }
function required(condition, code) { if (!condition) fail(code); }
function kitName(schemaDigest) {
  const match = DIGEST.exec(schemaDigest ?? "");
  required(match, "kit_invalid_schema_digest");
  return match[1];
}

export function recoveryKitPath(directory, schemaDigest) {
  return join(directory, "recovery-kits", kitName(schemaDigest));
}

async function fsyncPath(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function fileDigest(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk);
    bytes += chunk.byteLength;
  }
  return { sha256: `sha256:${hash.digest("hex")}`, bytes };
}

function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  required(result.status === 0, "kit_source_unavailable");
  return result.stdout.trim();
}

async function archiveSource(root, destination) {
  const output = createWriteStream(destination, { mode: 0o600 });
  const child = spawn("git", ["archive", "--format=tar", "HEAD"],
    { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
  child.stdout.pipe(output);
  const [exit, finished] = await Promise.all([
    new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    }),
    new Promise((resolve, reject) => {
      output.on("error", reject);
      output.on("finish", resolve);
    }),
  ]);
  required(exit === 0 && finished === undefined, "kit_archive_failed");
  await fsyncPath(destination);
}

export async function verifyRecoveryKit(directory, schemaDigest) {
  const kit = recoveryKitPath(directory, schemaDigest);
  const info = await lstat(kit);
  required(info.isDirectory() && !info.isSymbolicLink(), "kit_invalid_directory");
  let manifest;
  try { manifest = JSON.parse(await readFile(join(kit, "kit.json"), "utf8")); }
  catch { fail("kit_invalid_manifest"); }
  required(manifest?.format === "mind-diary-recovery-kit/v1" &&
    manifest.schema_digest === schemaDigest &&
    manifest.platform === process.platform && manifest.arch === process.arch &&
    /^v(?:2[2-9]|[3-9][0-9])\./u.test(manifest.node_version) &&
    /^[0-9a-f]{40}$/u.test(manifest.source_sha) &&
    manifest.files && typeof manifest.files === "object" &&
    Object.keys(manifest.files).length === FILES.length + 2,
  "kit_incompatible");
  const expected = ["runtime/node", "source.tar", ...FILES];
  for (const name of expected) {
    const descriptor = manifest.files[name];
    required(descriptor && DIGEST.test(descriptor.sha256) &&
      Number.isSafeInteger(descriptor.bytes) && descriptor.bytes > 0,
    "kit_invalid_manifest");
    const path = join(kit, name);
    const file = await lstat(path);
    required(file.isFile() && !file.isSymbolicLink(), "kit_invalid_file");
    const actual = await fileDigest(path);
    required(actual.sha256 === descriptor.sha256 &&
      actual.bytes === descriptor.bytes, "kit_file_corrupt");
  }
  return { path: kit, source_sha: manifest.source_sha,
    node_version: manifest.node_version, schema_digest: schemaDigest };
}

export async function createRecoveryKit({ directory, schemaDigest,
  sourceRoot = SOURCE_ROOT, allowDirty = false }) {
  const previousUmask = process.umask(0o077);
  let stage;
  try {
    const target = recoveryKitPath(directory, schemaDigest);
    try {
      await stat(target);
      return await verifyRecoveryKit(directory, schemaDigest);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const sourceSha = git(sourceRoot, "rev-parse", "HEAD");
    required(/^[0-9a-f]{40}$/u.test(sourceSha), "kit_invalid_source_sha");
    if (!allowDirty) {
      required(git(sourceRoot, "status", "--porcelain", "--untracked-files=all") === "",
        "kit_source_dirty");
    }
    await mkdir(join(directory, "recovery-kits"),
      { recursive: true, mode: 0o700 });
    stage = await mkdtemp(`${target}.staging-`);
    await mkdir(join(stage, "runtime"), { mode: 0o700 });
    const fileNames = ["runtime/node", "source.tar", ...FILES];
    const files = {};
    await copyFile(process.execPath, join(stage, "runtime/node"));
    await fsyncPath(join(stage, "runtime/node"));
    await archiveSource(sourceRoot, join(stage, "source.tar"));
    for (const name of FILES) {
      await mkdir(dirname(join(stage, name)),
        { recursive: true, mode: 0o700 });
      await copyFile(join(sourceRoot, name), join(stage, name));
      await fsyncPath(join(stage, name));
    }
    for (const name of fileNames) files[name] = await fileDigest(join(stage, name));
    const manifest = { format: "mind-diary-recovery-kit/v1",
      schema_digest: schemaDigest, source_sha: sourceSha,
      platform: process.platform, arch: process.arch,
      node_version: process.version, files };
    await writeFile(join(stage, "kit.json"), `${JSON.stringify(manifest)}\n`,
      { mode: 0o600 });
    await fsyncPath(join(stage, "kit.json"));
    await fsyncPath(join(stage, "scripts", "lib"));
    await fsyncPath(join(stage, "scripts"));
    await fsyncPath(join(stage, "runtime"));
    await fsyncPath(stage);
    await rename(stage, target);
    stage = undefined;
    await fsyncPath(join(directory, "recovery-kits"));
    return await verifyRecoveryKit(directory, schemaDigest);
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    process.umask(previousUmask);
  }
}
