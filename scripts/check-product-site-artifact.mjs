import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifySiteArtifactManifest } from "../apps/mind-diary-site/tools/artifact-manifest.mjs";

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

const metadata = JSON.parse(await readFile(resolve(app, "dist/.openai/release.json"), "utf8"));
const head = git("rev-parse", "HEAD");
const tree = git("rev-parse", "HEAD^{tree}");
const status = git("status", "--porcelain", "--untracked-files=all");

await verifySiteArtifactManifest(resolve(app, "dist"), metadata, head, tree);
assert(status === "", `release checkout is not clean:\n${status}`);
if (expectedCandidate !== null) {
  assert(/^[0-9a-f]{40}$/u.test(expectedCandidate), "--candidate-sha must be a full 40-hex Git SHA");
  assert(expectedCandidate === head, `requested candidate ${expectedCandidate} differs from HEAD ${head}`);
}

console.log(`Product Site artifact matches exact candidate ${head}.`);
