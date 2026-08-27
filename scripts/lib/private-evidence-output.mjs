import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, open, realpath, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { fail, ProbeFailure } from "./multi-principal-probe-core.mjs";

const execFileAsync = promisify(execFile);
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const OPEN_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

function containsPath(parent, child) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
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

async function forbiddenRoots(repositoryRoot) {
  return repositoryWorktrees(await realpath(repositoryRoot));
}

async function validatePrivateParent(requested, repositoryRoot, errorCode) {
  const parent = await realpath(dirname(requested));
  const parentStat = await stat(parent);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!parentStat.isDirectory() || currentUid === null || parentStat.uid !== currentUid ||
      (parentStat.mode & 0o777) !== DIRECTORY_MODE) fail(errorCode);
  await access(parent, constants.W_OK | constants.X_OK);

  const tempRoots = await existingRealPaths([tmpdir(), "/tmp", "/private/tmp"]);
  if (!tempRoots.some((root) => parent !== root && containsPath(root, parent))) fail(errorCode);
  const forbidden = await forbiddenRoots(repositoryRoot);
  if (forbidden.some((root) => containsPath(root, parent))) fail(errorCode);
  return Object.freeze({ parent, parentStat, forbidden });
}

async function discardExactEmptyReservation(reservation) {
  let removed = false;
  try {
    const handleStat = await reservation.handle.stat();
    if (!handleStat.isFile() || handleStat.size !== 0) return false;
    const candidates = [...new Set([
      reservation.openedRealPath,
      reservation.requested,
    ].filter((value) => typeof value === "string"))];
    for (const candidate of candidates) {
      try {
        const resolved = await realpath(candidate);
        const pathStat = await lstat(resolved);
        if (pathStat.isFile() && pathStat.size === 0 && sameIdentity(pathStat, handleStat)) {
          await unlink(resolved);
          removed = true;
          break;
        }
      } catch (error) {
        if (error?.code !== "ENOENT") continue;
      }
    }
    return removed;
  } finally {
    await reservation.handle.close().catch(() => {});
  }
}

async function revalidateOpenReservation(reservation) {
  const { requested, repositoryRoot, errorCode, initial } = reservation;
  const parent = await realpath(dirname(requested));
  const parentStat = await stat(parent);
  if (parent !== initial.parent || !sameIdentity(parentStat, initial.parentStat) ||
      parentStat.uid !== initial.parentStat.uid || (parentStat.mode & 0o777) !== DIRECTORY_MODE) {
    fail(errorCode);
  }
  await access(parent, constants.W_OK | constants.X_OK);
  const forbidden = await forbiddenRoots(repositoryRoot);
  if (forbidden.some((root) => containsPath(root, parent))) fail(errorCode);

  const candidate = await realpath(requested);
  const expectedCandidate = join(parent, basename(requested));
  const candidateStat = await lstat(candidate);
  const handleStat = await reservation.handle.stat();
  if (candidate !== expectedCandidate || forbidden.some((root) => containsPath(root, candidate)) ||
      !candidateStat.isFile() || !handleStat.isFile() || !sameIdentity(candidateStat, handleStat) ||
      handleStat.uid !== initial.parentStat.uid || handleStat.size !== 0 ||
      (handleStat.mode & 0o777) !== FILE_MODE) fail(errorCode);
  reservation.openedRealPath = candidate;
}

class ReservedPrivateOutput {
  constructor(state) {
    Object.assign(this, state);
    this.closed = false;
  }

  async write(content) {
    if (this.closed) fail(this.errorCode);
    try {
      await revalidateOpenReservation(this);
      await this.handle.writeFile(content, { encoding: "utf8" });
      await this.handle.sync();
      await this.handle.close();
      this.closed = true;
    } catch (error) {
      await this.handle.truncate(0).catch(() => {});
      await discardExactEmptyReservation(this);
      this.closed = true;
      if (error instanceof ProbeFailure) throw error;
      fail(this.errorCode);
    }
  }

  async abort() {
    if (this.closed) return;
    await this.handle.truncate(0).catch(() => {});
    await discardExactEmptyReservation(this);
    this.closed = true;
  }
}

export async function reservePrivateTempOutput(requestedPath, {
  repositoryRoot,
  errorCode = "unsafe_private_temp_output",
  testHooks,
} = {}) {
  let handle;
  let reservation;
  try {
    if (typeof requestedPath !== "string" || !isAbsolute(requestedPath) ||
        typeof repositoryRoot !== "string") fail(errorCode);
    const requested = resolve(requestedPath);
    const initial = await validatePrivateParent(requested, repositoryRoot, errorCode);
    if (typeof testHooks?.afterInitialValidation === "function") {
      await testHooks.afterInitialValidation(Object.freeze({
        requested,
        parent: initial.parent,
        parentDev: initial.parentStat.dev,
        parentIno: initial.parentStat.ino,
      }));
    }
    handle = await open(requested, OPEN_FLAGS, FILE_MODE);
    reservation = new ReservedPrivateOutput({
      handle,
      requested,
      repositoryRoot,
      errorCode,
      initial,
      openedRealPath: null,
    });
    try {
      reservation.openedRealPath = await realpath(requested);
    } catch {}
    await revalidateOpenReservation(reservation);
    return reservation;
  } catch (error) {
    if (reservation !== undefined) await discardExactEmptyReservation(reservation);
    else if (handle !== undefined) await handle.close().catch(() => {});
    if (error instanceof ProbeFailure) throw error;
    fail(errorCode);
  }
}
