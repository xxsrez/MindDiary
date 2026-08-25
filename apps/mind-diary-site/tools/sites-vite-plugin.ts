import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { Plugin } from "vite";

const execFileAsync = promisify(execFile);

async function gitRevision(root: string, revision: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", revision], { cwd: root });
  return stdout.trim();
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Packages only public hosting metadata and D1 migrations. */
export function sites(): Plugin {
  let root = process.cwd();
  return {
    name: "mind-diary-sites-package",
    apply: "build",
    configResolved(config) { root = config.root; },
    async closeBundle() {
      const output = resolve(root, "dist", ".openai");
      const server = resolve(root, "dist", "server", "index.js");
      await rm(output, { recursive: true, force: true });
      await mkdir(output, { recursive: true });
      const hosting = resolve(root, ".openai", "hosting.json");
      const drizzle = resolve(root, "drizzle");
      if (await exists(hosting)) await cp(hosting, resolve(output, "hosting.json"));
      if (await exists(drizzle)) await cp(drizzle, resolve(output, "drizzle"), { recursive: true });
      if (await exists(server)) {
        await writeFile(resolve(output, "release.json"), `${JSON.stringify({
          schema: "mind-diary/site-artifact/v1",
          candidate_sha: await gitRevision(root, "HEAD"),
          candidate_tree_sha: await gitRevision(root, "HEAD^{tree}"),
          server_sha256: await sha256(server),
        }, null, 2)}\n`);
      }
    },
  };
}
