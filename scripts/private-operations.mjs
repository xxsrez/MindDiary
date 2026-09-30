import { spawn, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, lstat, unlink, chmod, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { loadPrivateOperations, privateEnvironment, privateAcceptanceDirectory } from "./lib/private-operations.mjs";

const root = resolve(import.meta.dirname, "..");
async function checkPrivateTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Private data cannot use symlinks.");
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await checkPrivateTree(path);
    else if (!entry.isFile()) throw new Error("Unexpected private file type.");
  }
}
async function materialize(path, contents) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) await unlink(path);
    else if (!info.isFile()) throw new Error("Unexpected configuration file type.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const settings = loadPrivateOperations();
  if (command === "check") {
    execFileSync("git", ["check-ignore", "-q", ".private/config/operations.json"], { cwd: root });
    const tracked = execFileSync("git", ["ls-files", "--", ".private", "apps/mind-diary-site/.dev.vars"], { cwd: root, encoding: "utf8" });
    if (tracked.trim()) throw new Error("Private files must not be tracked.");
    await checkPrivateTree(resolve(root, ".private"));
    privateAcceptanceDirectory();
    const dev = resolve(root, "apps/mind-diary-site/.dev.vars");
    if (!(await lstat(dev)).isFile() || !(await readFile(dev)).equals(await readFile(settings.development))) throw new Error("Run private:setup to refresh local development configuration.");
    const hooks = execFileSync("git", ["config", "--get", "core.hooksPath"], { cwd: root, encoding: "utf8" }).trim();
    if (resolve(root, hooks) !== resolve(root, ".githooks")) throw new Error("Publication hooks are not installed.");
    console.log(JSON.stringify({ configured: true, targets: Object.keys(settings.manifests).length, local_dev_keys: 4, inside_workspace: true, ignored_by_git: true, private_symlinks: 0, publication_hooks: true }));
  } else if (command === "setup") {
    const local = resolve(root, ".private");
    await mkdir(local, { recursive: true, mode: 0o700 });
    let profile = await readFile(resolve(root, "docs/operations/ship-work-release-profile.md"), "utf8");
    profile = profile.replaceAll("https://mind-diary.example.invalid", settings.config.uat_origin)
      .replaceAll("document: apps/mind-diary-site/.openai/hosting.json", "document: .private/config/hosting.product.json")
      .replaceAll("argv: [npm, --prefix, apps/mind-diary-site, run, build]", "argv: [npm, run, site:build:uat]")
      .replaceAll("`apps/mind-diary-site/.openai/hosting.json#/project_id`", "`.private/config/hosting.product.json#/project_id`");
    await materialize(resolve(local, "release-profile.md"), profile);
    await materialize(resolve(root, "apps/mind-diary-site/.dev.vars"), await readFile(settings.development));
    execFileSync(process.execPath, [resolve(root, "scripts/install-publication-hooks.mjs")], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    console.log("Workspace-local private configuration prepared; no external links created.");
  } else if (command === "run" && args[0] === "--" && args.length > 1) {
    const child = spawn(args[1], args.slice(2), { cwd: root, env: privateEnvironment(settings), stdio: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
    child.once("error", () => { console.error("Private command could not start; values withheld."); process.exitCode = 1; });
    child.once("exit", (code) => { process.exitCode = code ?? 1; });
  } else throw new Error("Use check, setup, or run -- COMMAND [ARGS].");
}
main().catch(() => { console.error("Private configuration unavailable or command invalid; values withheld."); process.exitCode = 1; });
