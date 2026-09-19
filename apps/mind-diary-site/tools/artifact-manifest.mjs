import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export const SITE_ARTIFACT_SCHEMA = "mind-diary/site-artifact/v2";
const RECEIPT_PATH = ".openai/release.json";
const SHA = /^[0-9a-f]{40}$/u;

async function collectFiles(root, directory = "") {
  const files = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await collectFiles(root, path));
    } else if (entry.isFile()) {
      if (path === RECEIPT_PATH) continue;
      const bytes = await readFile(join(root, path));
      files.push({ path, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
    } else {
      throw new Error(`Site artifact contains a non-regular entry: ${path}`);
    }
  }
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export async function createSiteArtifactManifest(directory, candidateSha, candidateTreeSha) {
  assert(SHA.test(candidateSha), "artifact candidate must be a full Git SHA");
  assert(SHA.test(candidateTreeSha), "artifact tree must be a full Git SHA");
  assert((await lstat(directory)).isDirectory(), "artifact root must be a real directory");
  const files = await collectFiles(directory);
  const server = files.find(({ path }) => path === "server/index.js");
  assert(server, "artifact is missing server/index.js");
  assert(files.some(({ path }) => path === ".openai/hosting.json"), "artifact is missing hosting metadata");
  return {
    schema: SITE_ARTIFACT_SCHEMA,
    candidate_sha: candidateSha,
    candidate_tree_sha: candidateTreeSha,
    server_sha256: server.sha256,
    files,
  };
}

export async function verifySiteArtifactManifest(directory, manifest, candidateSha, candidateTreeSha) {
  const expected = await createSiteArtifactManifest(directory, candidateSha, candidateTreeSha);
  assert.deepEqual(manifest, expected, "Site artifact manifest differs from candidate or packaged files");
  return expected;
}
