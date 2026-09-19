import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { verifySiteArtifactManifest } from "../../apps/mind-diary-site/tools/artifact-manifest.mjs";

export async function packageProductSiteArchive(appDirectory, archivePath) {
  const app = resolve(appDirectory);
  const output = resolve(archivePath);
  const fromApp = relative(app, output);
  assert(isAbsolute(fromApp) || fromApp === ".." || fromApp.startsWith("../"), "archive must be outside the Site source directory");
  const manifest = JSON.parse(await readFile(resolve(app, "dist/.openai/release.json"), "utf8"));
  await verifySiteArtifactManifest(resolve(app, "dist"), manifest, manifest.candidate_sha, manifest.candidate_tree_sha);
  assert((await lstat(resolve(app, ".openai/hosting.json"))).isFile(), "hosting metadata must be a regular file");
  assert.deepEqual(await readFile(resolve(app, ".openai/hosting.json")), await readFile(resolve(app, "dist/.openai/hosting.json")), "source and packaged hosting metadata differ");
  await mkdir(dirname(output), { recursive: true });
  // Sites detects dist/server/index.js, not server/index.js at archive root.
  // Include only built bytes and the exact hosting descriptor, never source/secrets.
  execFileSync("tar", ["-czf", output, "-C", app, ".openai/hosting.json", "dist"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const bytes = await readFile(output);
  return { archive: output, candidate_sha: manifest.candidate_sha,
    sha256: createHash("sha256").update(bytes).digest("hex"), size_bytes: bytes.byteLength };
}
