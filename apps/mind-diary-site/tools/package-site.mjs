import { execFileSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createSiteArtifactManifest } from "./artifact-manifest.mjs";

// Run after vinext has finalized every environment and generated its manifests.
// A per-environment closeBundle hook runs before those final files exist.
const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist/.openai");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(resolve(root, ".openai/hosting.json"), resolve(output, "hosting.json"));
await cp(resolve(root, "drizzle"), resolve(output, "drizzle"), { recursive: true });
const git = (revision) => execFileSync("git", ["rev-parse", revision], { cwd: root, encoding: "utf8" }).trim();
const manifest = await createSiteArtifactManifest(resolve(root, "dist"), git("HEAD"), git("HEAD^{tree}"));
await writeFile(resolve(output, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Packaged ${manifest.files.length} files for ${manifest.candidate_sha}.`);
