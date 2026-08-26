import {
  constants,
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

const READ_CHUNK_BYTES = 1024 * 1024;

/**
 * Node/macOS stable-handle adapter for LocalFileCompanion. The selected path
 * is used only while opening the descriptor and never appears in its result or
 * in an error. Every stream reads the same descriptor from position zero.
 */
export function createNodeLocalCompanionFileSystem(options = {}) {
  const localRoots = resolveRoots(options.localRoots ?? [], false);
  const workspaceRoots = resolveRoots(options.workspaceRoots ?? [], true);
  // Root authority belongs to connector configuration, not to a later file
  // operation. Resolve it once so a mutable root symlink cannot redefine the
  // consent boundary between descriptor open and authorization.
  const canonicalAuthorityRoots = Promise.all([
    canonicalRoots(localRoots),
    canonicalRoots(workspaceRoots),
  ]);
  const beforeAuthorityCheck = options.beforeAuthorityCheck;
  if (beforeAuthorityCheck !== undefined &&
    typeof beforeAuthorityCheck !== "function") {
    throw new TypeError("local companion authority hook is invalid");
  }

  return Object.freeze({
    async open(inputPath) {
      if (typeof inputPath !== "string" || !isAbsolute(inputPath)) {
        return invalid("invalid_path");
      }
      let lexical;
      try {
        lexical = await lstat(inputPath, { bigint: true });
      } catch {
        return invalid("file_ingress_source_unavailable");
      }
      if (lexical.isSymbolicLink() || lexical.isDirectory() || !lexical.isFile()) {
        return invalid("file_ingress_source_unsupported");
      }

      let handle;
      try {
        handle = await open(
          inputPath,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
      } catch {
        return invalid("file_ingress_source_unavailable");
      }
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() ||
          opened.dev !== lexical.dev || opened.ino !== lexical.ino) {
          await handle.close();
          return invalid("file_ingress_source_unsupported");
        }
        // Tests use this hook to deterministically exercise a parent-symlink
        // swap after open. It cannot supply or alter authority evidence.
        await beforeAuthorityCheck?.();
        const canonicalPath = await realpath(inputPath);
        const [canonicalEntry, [canonicalLocalRoots, canonicalWorkspaceRoots]] =
          await Promise.all([
            lstat(canonicalPath, { bigint: true }),
            canonicalAuthorityRoots,
          ]);
        // Authority is derived only after the resolved path is proven to name
        // the exact dev/inode held by the already-open descriptor. A parent
        // symlink swap therefore fails rather than authorizing another path.
        if (!canonicalEntry.isFile() || canonicalEntry.isSymbolicLink() ||
          canonicalEntry.dev !== opened.dev || canonicalEntry.ino !== opened.ino) {
          await handle.close();
          return invalid("file_ingress_source_unsupported");
        }
        const authority = authorityFor(
          canonicalPath,
          canonicalLocalRoots,
          canonicalWorkspaceRoots,
        );
        if (authority === "none") {
          await handle.close();
          return invalid("file_ingress_source_unsupported");
        }
        const displayFilename = basename(canonicalPath);
        const initial = inspection(opened, displayFilename, authority);
        let closed = false;
        let active = false;
        return Object.freeze({
          kind: "opened",
          file: Object.freeze({
            inspection: initial,
            async inspect() {
              if (closed) throw safeError();
              try {
                return inspection(
                  await handle.stat({ bigint: true }),
                  displayFilename,
                  authority,
                );
              } catch {
                throw safeError();
              }
            },
            stream({ maxBytes, signal } = {}) {
              if (closed || active ||
                !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
                return failingStream();
              }
              active = true;
              return (async function* () {
                let position = 0;
                try {
                  while (true) {
                    if (signal?.aborted) throw abortError();
                    const buffer = new Uint8Array(
                      Math.min(READ_CHUNK_BYTES, Math.max(1, maxBytes + 1 - position)),
                    );
                    let result;
                    try {
                      result = await handle.read(
                        buffer,
                        0,
                        buffer.byteLength,
                        position,
                      );
                    } catch {
                      throw safeError();
                    }
                    if (result.bytesRead === 0) return;
                    position += result.bytesRead;
                    if (position > maxBytes) throw oversizeError();
                    yield buffer.subarray(0, result.bytesRead);
                  }
                } finally {
                  active = false;
                }
              })();
            },
            async close() {
              if (closed) return;
              closed = true;
              try {
                await handle.close();
              } catch {
                // Closing a private descriptor is best-effort and path-free.
              }
            },
          }),
        });
      } catch {
        try {
          await handle.close();
        } catch {
          // Preserve the typed, path-free boundary.
        }
        return invalid("file_ingress_source_unavailable");
      }
    },
  });
}

function resolveRoots(roots, allowEmpty) {
  if (!Array.isArray(roots) || (!allowEmpty && roots.length === 0)) {
    throw new TypeError("local companion requires at least one explicit root");
  }
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
  return suffix === "" ||
    (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function inspection(entry, displayFilename, authority) {
  const size = Number(entry.size);
  return Object.freeze({
    displayFilename,
    kind: entry.isFile() ? "regular" : entry.isDirectory() ? "directory" : "special",
    snapshotId: [
      entry.dev,
      entry.ino,
      entry.size,
      entry.mtimeNs,
      entry.ctimeNs,
    ].map(String).join(":"),
    size,
    authority,
    canonical: entry.isFile() && Number.isSafeInteger(size) && size >= 0,
  });
}

function invalid(code) {
  return Object.freeze({ kind: "invalid", code });
}

function safeError() {
  return new Error("local companion file access failed");
}

function oversizeError() {
  return new RangeError("local companion file exceeds limit");
}

function abortError() {
  return Object.assign(new Error("local companion read cancelled"), {
    name: "AbortError",
  });
}

async function* failingStream() {
  throw safeError();
}
