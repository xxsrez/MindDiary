import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { SqliteD1 } from "../../scripts/lib/sqlite-d1.mjs";
import { FakeR2Bucket } from "../../scripts/lib/fake-sites-storage.mjs";
import { AcceptanceSessionStore } from "../../apps/mind-diary-acceptance/session-store.mjs";
import { ACCEPTANCE_ORIGIN } from "../../apps/mind-diary-acceptance/runtime-target.mjs";

test("ordinary Worker never interprets a valid acceptance cookie as product identity", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ordinary-cookie-isolation-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const compiled = await build({ absWorkingDir: resolve(import.meta.dirname, "../.."), entryPoints: ["apps/mind-diary-site/worker/index.ts"],
    bundle: true, platform: "browser", external: ["node:async_hooks"], format: "esm", write: false, metafile: true, logLevel: "silent",
    plugins: [{ name: "unused-ui-fallback", setup(plugin) {
      plugin.onResolve({ filter: /^vinext\/server\/app-router-entry$/ }, () => ({ path: "unused", namespace: "unused" }));
      plugin.onLoad({ filter: /.*/, namespace: "unused" }, () => ({ contents: 'export default { fetch(){throw new Error("Unexpected UI fallback")} };' }));
    } }],
  });
  assert.ok(Object.keys(compiled.metafile.inputs).every(path => !path.includes("mind-diary-acceptance")));
  await writeFile(join(directory, "worker.mjs"), compiled.outputFiles[0].contents);
  const worker = (await import(pathToFileURL(join(directory, "worker.mjs")).href)).default;
  const testDb = new SqliteD1(), ordinaryDb = new SqliteD1(); t.after(() => { testDb.close(); ordinaryDb.close(); });
  const store = new AcceptanceSessionStore(testDb), run = await store.create({}, "ordinary-cookie-test-0001");
  const code = (await store.mintExchange(run.id, run.actors[0].id)).code;
  const session = await store.exchange(code, ACCEPTANCE_ORIGIN);
  const origin = "https://mind-diary.example.invalid";
  const env = { DB: ordinaryDb, MIND_DIARY_BUCKET: new FakeR2Bucket(), MIND_DIARY_PUBLIC_ORIGIN: origin };
  for (const name of ["TOKEN_VERIFIER", "LOCATOR", "EXPORT_DOWNLOAD_VERIFIER", "CSRF"]) env[`MIND_DIARY_${name}_KEY`] = Buffer.alloc(32, 1).toString("base64url");
  const response = await worker.fetch(new Request(origin + "/api/v1/session", { headers: { cookie: session.cookie.split(";")[0], "x-md-acceptance-run": run.id } }), env, { waitUntil() {} });
  assert.equal(response.status, 401); assert.equal((await response.json()).error.code, "authentication_required");
});
