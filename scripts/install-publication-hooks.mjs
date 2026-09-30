import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { resolve } from "node:path";
const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const root = git(["rev-parse", "--show-toplevel"]);
const hooks = resolve(root, ".githooks");
let existing;
try { existing = git(["config", "--get", "core.hooksPath"]); } catch {}
if (existing && resolve(root, existing) !== hooks) {
  throw new Error("Existing hooksPath must be reviewed before installing publication hooks.");
}
for (const name of ["pre-commit", "commit-msg", "pre-push"]) chmodSync(resolve(hooks, name), 0o755);
git(["config", "--local", "core.hooksPath", hooks]);
console.log("Publication hooks installed for this Git repository and its linked worktrees.");

