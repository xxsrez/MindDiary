import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, relative } from "node:path";
import { build } from "esbuild";
const root = resolve(import.meta.dirname, "../..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const candidate = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain") !== "";
const options = {
  absWorkingDir: root,
  entryPoints: ["apps/mind-diary-acceptance/entry.mjs"],
  bundle: true, format: "esm", platform: "browser", target: "es2022",
  external: ["node:async_hooks"],
  metafile: true, write: false, logLevel: "silent",
};
const initial = await build({ ...options, define: { __MD_ACCEPTANCE_BUILD__: "null" } });
const inputs = await Promise.all(Object.keys(initial.metafile.inputs).sort().map(async (name) => ({
  path: relative(root, resolve(root, name)).replaceAll("\\", "/"),
  sha256: hash(await readFile(resolve(root, name))),
})));
const group = (predicate) => hash(JSON.stringify(inputs.filter(({ path }) => predicate(path))));
const identity = {
  schema: "mind-diary/acceptance-build/v1",
  candidate_sha: candidate,
  dirty,
  common_modules_sha256: group((p) => p.startsWith("packages/") || p.startsWith("apps/mind-diary-site/worker/")),
  backup_foreground_sha256: group((p) => p === "apps/mind-diary-site/worker/foreground-deadline.js" ||
    p === "apps/mind-diary-site/worker/request-recovery.js"),
  backup_transport_sha256: hash(await readFile(resolve(root, "packages/composition-root/src/system-backup-sites.ts"))),
  backup_client_sha256: hash(await readFile(resolve(root, "scripts/lib/system-backup-client.mjs"))),
  test_adapter_sha256: group((p) => p.startsWith("apps/mind-diary-acceptance/")),
  dependencies_sha256: group((p) => p.includes("node_modules/")),
  lock_sha256: hash(await readFile(resolve(root, "package-lock.json"))),
};
const result = await build({ ...options, define: { __MD_ACCEPTANCE_BUILD__: JSON.stringify(identity) } });
const output = result.outputFiles[0].contents;
await mkdir(new URL("dist/server/", import.meta.url), { recursive: true });
await mkdir(new URL("dist/.openai/", import.meta.url), { recursive: true });
await writeFile(new URL("dist/server/index.js", import.meta.url), output);
await copyFile(new URL(".openai/hosting.json", import.meta.url), new URL("dist/.openai/hosting.json", import.meta.url));
await writeFile(new URL("dist/.openai/acceptance-build.json", import.meta.url), JSON.stringify({ ...identity, server_sha256: hash(output), inputs }, null, 2) + "\n");
console.log(JSON.stringify({ ...identity, bytes: output.byteLength }));
