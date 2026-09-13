import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, relative, isAbsolute } from "node:path";
import { ACCEPTANCE_PROJECT } from "../apps/mind-diary-acceptance/runtime-target.mjs";

const root = resolve(import.meta.dirname, "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const directory = resolve(root, "apps/mind-diary-acceptance/dist");
const manifest = JSON.parse(await readFile(resolve(directory, ".openai/acceptance-build.json"), "utf8"));
assert.equal(manifest.schema, "mind-diary/acceptance-build/v1");
assert.equal(manifest.candidate_sha, git("rev-parse", "HEAD"));
assert.equal(manifest.dirty, false, "release build must use a clean checkout");
assert.equal(git("status", "--porcelain"), "", "checkout changed after build");
assert.equal(manifest.server_sha256, hash(await readFile(resolve(directory, "server/index.js"))));
assert.equal(manifest.lock_sha256, hash(await readFile(resolve(root, "package-lock.json"))));
const hosting = JSON.parse(await readFile(resolve(directory, ".openai/hosting.json"), "utf8"));
assert.equal(hosting.project_id, ACCEPTANCE_PROJECT);
assert.equal(hosting.d1, "DB");
assert.equal(hosting.r2, "MIND_DIARY_BUCKET");
assert.ok(Array.isArray(manifest.inputs) && manifest.inputs.length > 0);
const paths = manifest.inputs.map((entry) => entry.path);
assert.equal(new Set(paths).size, paths.length);
assert.deepEqual(paths, [...paths].sort());
for (const input of manifest.inputs) {
  const filename = resolve(root, input.path);
  const rel = relative(root, filename);
  assert.ok(!rel.startsWith("..") && !isAbsolute(rel));
  assert.equal(hash(await readFile(filename)), input.sha256, `stale input: ${input.path}`);
}
const group = (predicate) => hash(JSON.stringify(manifest.inputs.filter(({ path }) => predicate(path))));
assert.equal(manifest.common_modules_sha256, group((p) => p.startsWith("packages/") || p.startsWith("apps/mind-diary-site/worker/")));
assert.equal(manifest.backup_foreground_sha256, group((p) => p === "apps/mind-diary-site/worker/foreground-deadline.js" ||
  p === "apps/mind-diary-site/worker/request-recovery.js"));
assert.equal(manifest.backup_transport_sha256, hash(await readFile(resolve(root, "packages/composition-root/src/system-backup-sites.ts"))));
assert.equal(manifest.backup_client_sha256, hash(await readFile(resolve(root, "scripts/lib/system-backup-client.mjs"))));
assert.equal(manifest.test_adapter_sha256, group((p) => p.startsWith("apps/mind-diary-acceptance/")));
assert.equal(manifest.dependencies_sha256, group((p) => p.includes("node_modules/")));
console.log(JSON.stringify({ status: "passed", candidate_sha: manifest.candidate_sha, server_sha256: manifest.server_sha256, checked_inputs: paths.length }));
