import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { findings } from "./check-publication.mjs";

const scanner = resolve(import.meta.dirname, "check-publication.mjs");
const claim = "CLAIM_" + "TOKEN=" + ["12345678", "1234", "1234", "1234", "123456789abc"].join("-");
const email = ["private.person", "gmail.com"].join("@");
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_EMAIL: "test@example.invalid" };
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), "publication-test-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  const scan = (...args) => spawnSync(process.execPath, [scanner, ...args], { cwd: root, env, encoding: "utf8" });
  try { git("init", "-q"); return fn({ root, git, scan }); } finally { rmSync(root, { recursive: true, force: true }); }
}
test("findings detect private data without returning matched values", () => {
  assert.deepEqual(findings(Buffer.from(claim)), ["claim UUID"]);
  assert.deepEqual(findings(Buffer.from(email)), ["personal email", "non-public contact email"]);
  assert.deepEqual(findings(Buffer.from("author Test <work@company.test> 1 +0000\n\n"), "commit"), ["non-public author email"]);
  assert.deepEqual(findings(Buffer.from("author Test <123+test@users.noreply.github.com> 1 +0000\n\n"), "commit"), []);
});
test("staged scan reads index even when working tree is already clean", () => fixture(({ root, git, scan }) => {
  writeFileSync(join(root, "sample.md"), email); git("add", "sample.md");
  writeFileSync(join(root, "sample.md"), "clean");
  const result = scan("--staged");
  assert.equal(result.status, 1);
  assert.ok(!result.stderr.includes(email));
  git("add", "sample.md");
  assert.equal(scan("--staged").status, 0);
}));
test("history scan finds a secret removed from HEAD and commit messages", () => fixture(({ root, git, scan }) => {
  writeFileSync(join(root, "sample.md"), email); git("add", "sample.md"); git("commit", "-qm", claim);
  writeFileSync(join(root, "sample.md"), "clean"); git("add", "sample.md"); git("commit", "-qm", "remove");
  assert.equal(scan("--staged").status, 0);
  const result = scan("--history");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /claim UUID/);
  assert.match(result.stderr, /personal email/);
  assert.ok(!result.stderr.includes(email) && !result.stderr.includes(claim));
  const oid = git("rev-parse", "HEAD");
  const push = spawnSync(process.execPath, [scanner, "--pre-push"], { cwd: root, env, encoding: "utf8",
    input: `refs/heads/main ${oid} refs/heads/main ${"0".repeat(40)}\n` });
  assert.equal(push.status, 1);
}));
test("missing Git object and missing commit message fail closed", () => fixture(({ scan }) => {
  assert.equal(scan("--commit-message", "missing").status, 1);
}));

test("annotated tag messages and tracked environment files cannot bypass the scan", () => fixture(({ root, git, scan }) => {
  writeFileSync(join(root, "sample.md"), "safe");
  git("add", "sample.md"); git("commit", "-qm", "initial");
  git("tag", "-a", "release", "-m", claim);
  assert.equal(scan("--history").status, 1);
  writeFileSync(join(root, ".env"), "CONFIG=local");
  git("add", ".env");
  assert.equal(scan("--staged").status, 1);
}));
