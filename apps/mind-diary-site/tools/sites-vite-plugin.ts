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

/** Packages hosting metadata and migrations; runtime secrets stay in Sites. */
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
      const hosting = process.env.MIND_DIARY_HOSTING_CONFIG ?? resolve(root, ".openai", "hosting.json");
      const drizzle = resolve(root, "drizzle");
      let manifest;
      try {
        manifest = JSON.parse(await readFile(hosting, "utf8"));
        if (!/^appgprj_[a-z0-9]+$/.test(manifest.project_id) || manifest.d1 !== "DB" ||
            manifest.r2 !== "MIND_DIARY_BUCKET" ||
            Object.keys(manifest).some((key) => !["project_id", "d1", "r2"].includes(key)) ||
            (process.env.MIND_DIARY_HOSTING_CONFIG && manifest.project_id.includes("example"))) throw new Error();
      } catch { throw new Error("Site hosting configuration is invalid; values withheld."); }
      await writeFile(resolve(output, "hosting.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      if (await exists(drizzle)) await cp(drizzle, resolve(output, "drizzle"), { recursive: true });
      if (await exists(server)) {
        await writeFile(resolve(output, "release.json"), `${JSON.stringify({
          schema: "mind-diary/site-artifact/v1",
          candidate_sha: await gitRevision(root, "HEAD"),
          candidate_tree_sha: await gitRevision(root, "HEAD^{tree}"),
          server_sha256: await sha256(server),
          hosting_sha256: await sha256(resolve(output, "hosting.json")),
        }, null, 2)}\n`);
      }
    },
  };
}
