import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const app = resolve(root, "apps/mind-diary-site");
const candidateArgument = process.argv.indexOf("--candidate-sha");
const expectedCandidate = candidateArgument >= 0 ? process.argv[candidateArgument + 1] : null;

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const metadata = JSON.parse(await readFile(resolve(app, "dist/.openai/release.json"), "utf8"));
const server = await readFile(resolve(app, "dist/server/index.js"));
const hostingBytes = await readFile(resolve(app, "dist/.openai/hosting.json"));
const hosting = JSON.parse(hostingBytes);
const head = git("rev-parse", "HEAD");
const tree = git("rev-parse", "HEAD^{tree}");
const status = git("status", "--porcelain", "--untracked-files=all");

assert(metadata.schema === "mind-diary/site-artifact/v1", "unexpected product Site artifact schema");
assert(metadata.candidate_sha === head, `artifact candidate ${metadata.candidate_sha} differs from HEAD ${head}`);
assert(metadata.candidate_tree_sha === tree, `artifact tree ${metadata.candidate_tree_sha} differs from HEAD tree ${tree}`);
assert(metadata.server_sha256 === sha256(server), "artifact server hash differs from dist/server/index.js");
assert(metadata.hosting_sha256 === sha256(hostingBytes), "artifact hosting hash mismatch");
if (process.env.MIND_DIARY_HOSTING_CONFIG) {
  const target = JSON.parse(await readFile(process.env.MIND_DIARY_HOSTING_CONFIG, "utf8"));
  assert(JSON.stringify(hosting) === JSON.stringify(target), "artifact hosting target mismatch");
}
assert(status === "", `release checkout is not clean:\n${status}`);
if (expectedCandidate !== null) {
  assert(typeof hosting.project_id === "string" && !hosting.project_id.includes("example"), "release requires a real private hosting target");
  assert(/^[0-9a-f]{40}$/u.test(expectedCandidate), "--candidate-sha must be a full 40-hex Git SHA");
  assert(expectedCandidate === head, `requested candidate ${expectedCandidate} differs from HEAD ${head}`);
}

console.log(`Product Site artifact matches exact candidate ${head}.`);
