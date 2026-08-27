import { execFile } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { fail, ProbeFailure } from "./multi-principal-probe-core.mjs";

const execFileAsync = promisify(execFile);

function containsPath(parent, child) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

async function existingRealPaths(paths) {
  const values = [];
  for (const path of paths) {
    try {
      values.push(await realpath(path));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return [...new Set(values)];
}

async function repositoryWorktrees(repositoryRoot) {
  const result = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const paths = result.stdout.split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  return existingRealPaths(paths);
}

export async function resolvePrivateTempOutputPath(requestedPath, {
  repositoryRoot,
  errorCode = "unsafe_private_temp_output",
} = {}) {
  try {
    if (typeof requestedPath !== "string" || !isAbsolute(requestedPath) ||
        typeof repositoryRoot !== "string") fail(errorCode);
    const requested = resolve(requestedPath);
    const parent = await realpath(dirname(requested));
    const parentStat = await stat(parent);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!parentStat.isDirectory() || currentUid === null || parentStat.uid !== currentUid ||
        (parentStat.mode & 0o077) !== 0) fail(errorCode);

    const tempRoots = await existingRealPaths([tmpdir(), "/tmp", "/private/tmp"]);
    if (!tempRoots.some((root) => parent !== root && containsPath(root, parent))) fail(errorCode);

    const worktrees = await repositoryWorktrees(await realpath(repositoryRoot));
    if (worktrees.some((worktree) => containsPath(worktree, parent))) fail(errorCode);

    const output = join(parent, basename(requested));
    try {
      await lstat(output);
      fail(errorCode);
    } catch (error) {
      if (error instanceof ProbeFailure) throw error;
      if (error?.code !== "ENOENT") fail(errorCode);
    }
    return output;
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    fail(errorCode);
  }
}
