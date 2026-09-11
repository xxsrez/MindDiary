import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { SqliteD1 } from "../../scripts/lib/sqlite-d1.mjs";
import { FakeR2Bucket } from "../../scripts/lib/fake-sites-storage.mjs";
import { ACCEPTANCE_ORIGIN, ACCEPTANCE_PROJECT } from "../../apps/mind-diary-acceptance/runtime-target.mjs";

export async function acceptanceRuntime(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "acceptance-harness-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const compiled = await build({ absWorkingDir: resolve(import.meta.dirname, "../.."), entryPoints: ["apps/mind-diary-acceptance/entry.mjs"], bundle: true, platform: "browser", external: ["node:async_hooks"], format: "esm", write: false, logLevel: "silent", define: { __MD_ACCEPTANCE_BUILD__: JSON.stringify(options.buildIdentity ?? null) } });
  await writeFile(join(directory, "worker.mjs"), compiled.outputFiles[0].contents);
  const module = await import(pathToFileURL(join(directory, "worker.mjs")).href);
  const worker = options.createRuntime ? module.createAcceptanceWorker({ createRuntime: options.createRuntime }) : module.default;
  const db = new SqliteD1(), bucket = new FakeR2Bucket(), pending = [];
  t.after(async () => { await Promise.allSettled(pending); db.close(); });
  const env = { DB: db, MIND_DIARY_BUCKET: bucket, MIND_DIARY_PUBLIC_ORIGIN: ACCEPTANCE_ORIGIN, MD_ACCEPTANCE_PROJECT_ID: ACCEPTANCE_PROJECT, MD_ACCEPTANCE_CONTROLLER_KEY: "a".repeat(43) };
  for (const [i, name] of ["TOKEN_VERIFIER", "LOCATOR", "EXPORT_DOWNLOAD_VERIFIER", "CSRF"].entries()) env[`MIND_DIARY_${name}_KEY`] = Buffer.alloc(32, i + 1).toString("base64url");
  if (options.performanceCorrelationKey) env.MIND_DIARY_PERFORMANCE_CORRELATION_KEY = options.performanceCorrelationKey.toString("base64url");
  return { db, bucket, directory, controllerKey: env.MD_ACCEPTANCE_CONTROLLER_KEY,
    fetch: (url, options) => worker.fetch(new Request(url, options), env, { waitUntil(promise) { pending.push(promise); } }),
    drain: () => Promise.allSettled(pending) };
}
