import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createSiteArtifactManifest,
  verifySiteArtifactManifest,
} from "../../apps/mind-diary-site/tools/artifact-manifest.mjs";

const candidate = "a".repeat(40);
const tree = "b".repeat(40);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mind-diary-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, bytes] of Object.entries({
    "server/index.js": "import './chunk.js';",
    "server/chunk.js": "export const value = 1;",
    "client/assets/app.css": "body { color: black; }",
    ".openai/hosting.json": '{"d1":"DB"}',
    ".openai/drizzle/0000_product_site.sql": "CREATE TABLE fixture (id TEXT);",
  })) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  return root;
}

test("release manifest covers every deployable file and excludes only its own receipt", async (t) => {
  const root = await fixture(t);
  const manifest = await createSiteArtifactManifest(root, candidate, tree);
  assert.equal(manifest.files.length, 5);
  await writeFile(join(root, ".openai/release.json"), JSON.stringify(manifest));
  assert.deepEqual(await verifySiteArtifactManifest(root, manifest, candidate, tree), manifest);
  for (const file of manifest.files) {
    const original = await readFile(join(root, file.path));
    await writeFile(join(root, file.path), "changed");
    await assert.rejects(verifySiteArtifactManifest(root, manifest, candidate, tree), /manifest differs/);
    await writeFile(join(root, file.path), original);
  }
  await assert.rejects(verifySiteArtifactManifest(root, manifest, "c".repeat(40), tree), /manifest differs/);
  await assert.rejects(verifySiteArtifactManifest(root, { ...manifest, schema: "mind-diary/site-artifact/v1" }, candidate, tree), /manifest differs/);
});

test("release verification rejects deleted, injected and symlinked files", async (t) => {
  const root = await fixture(t);
  const manifest = await createSiteArtifactManifest(root, candidate, tree);
  await writeFile(join(root, "server/injected.js"), "unexpected");
  await assert.rejects(verifySiteArtifactManifest(root, manifest, candidate, tree), /manifest differs/);
  await rm(join(root, "server/injected.js"));
  await symlink("index.js", join(root, "server/alias.js"));
  await assert.rejects(verifySiteArtifactManifest(root, manifest, candidate, tree), /non-regular entry/);
  await rm(join(root, "server/alias.js"));
  await rm(join(root, "client/assets/app.css"));
  await assert.rejects(verifySiteArtifactManifest(root, manifest, candidate, tree), /manifest differs/);
});
