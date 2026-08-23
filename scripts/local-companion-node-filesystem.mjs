import {
  constants,
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Node/macOS filesystem adapter for the portable LocalFileCompanion port.
 * Paths stop at this adapter.  It returns only an opaque snapshot and safe
 * basename to the application boundary; callers must still keep the returned
 * path out of logs and remote requests.
 */
export function createNodeLocalCompanionFileSystem(options = {}) {
  const localRoots = resolveRoots(options.localRoots ?? []);
  const workspaceRoots = resolveRoots(options.workspaceRoots ?? []);

  return Object.freeze({
    async inspect(inputPath) {
      if (typeof inputPath !== "string" || !isAbsolute(inputPath)) {
        return missingInspection(inputPath);
      }
      let entry;
      let canonicalPath;
      try {
        [entry, canonicalPath] = await Promise.all([
          lstat(inputPath),
          realpath(inputPath),
        ]);
      } catch {
        return missingInspection(inputPath);
      }
      const kind = entry.isSymbolicLink()
        ? "symlink"
        : entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "regular"
            : "special";
      const [canonicalLocalRoots, canonicalWorkspaceRoots] = await Promise.all([
        canonicalRoots(localRoots),
        canonicalRoots(workspaceRoots),
      ]);
      const authority = authorityFor(
        canonicalPath,
        [...localRoots, ...canonicalLocalRoots],
        [...workspaceRoots, ...canonicalWorkspaceRoots],
      );
      const snapshotId = [
        String(entry.dev),
        String(entry.ino),
        String(entry.size),
        String(entry.mtimeMs),
        String(entry.ctimeMs),
      ].join(":");
      return Object.freeze({
        canonicalPath,
        displayFilename: basename(canonicalPath),
        kind,
        snapshotId,
        size: entry.size,
        authority,
        // The resolved root check rejects path traversal and links escaping a
        // consented root. Final-component symlinks are rejected by `kind`.
        canonical: authority !== "none" && !entry.isSymbolicLink(),
      });
    },

    async read(inputPath, { maxBytes, signal } = {}) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new TypeError("local companion read limit is invalid");
      }
      if (signal?.aborted) throw abortError();
      const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
      const handle = await open(inputPath, flags);
      const chunks = [];
      let total = 0;
      try {
        const bufferSize = Math.min(1024 * 1024, Math.max(1, maxBytes || 1));
        while (true) {
          if (signal?.aborted) throw abortError();
          const buffer = new Uint8Array(bufferSize);
          const result = await handle.read(buffer, 0, buffer.byteLength, null);
          if (result.bytesRead === 0) break;
          const chunk = buffer.subarray(0, result.bytesRead);
          total += chunk.byteLength;
          if (total > maxBytes) throw new RangeError("local companion file exceeds limit");
          chunks.push(new Uint8Array(chunk));
        }
        return Object.freeze(chunks);
      } finally {
        await handle.close();
      }
    },
  });
}

function resolveRoots(roots) {
  if (!Array.isArray(roots)) throw new TypeError("local companion roots must be an array");
  return Object.freeze(roots.map((root) => {
    if (typeof root !== "string" || !isAbsolute(root)) {
      throw new TypeError("local companion roots must be absolute paths");
    }
    return resolve(root);
  }));
}

function authorityFor(canonicalPath, localRoots, workspaceRoots) {
  if (workspaceRoots.some((root) => within(canonicalPath, root))) return "workspace";
  if (localRoots.some((root) => within(canonicalPath, root))) return "local";
  return "none";
}

async function canonicalRoots(roots) {
  return Promise.all(roots.map(async (root) => {
    try {
      return await realpath(root);
    } catch {
      return root;
    }
  }));
}

function within(candidate, root) {
  const suffix = relative(root, candidate);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function missingInspection(inputPath) {
  return Object.freeze({
    canonicalPath: typeof inputPath === "string" ? inputPath : "",
    displayFilename: "",
    kind: "missing",
    snapshotId: "",
    size: 0,
    authority: "none",
    canonical: false,
  });
}

function abortError() {
  return Object.assign(new Error("local companion read cancelled"), { name: "AbortError" });
}
