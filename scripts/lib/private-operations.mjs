import { readFileSync, lstatSync, realpathSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const fail = () => { throw new Error("Private operations configuration is missing or invalid; values withheld."); };
export function loadPrivateOperations({ repositoryRoot = resolve(import.meta.dirname, "../.."), directory = process.env.MIND_DIARY_PRIVATE_DIR ?? resolve(repositoryRoot, ".private/config") } = {}) {
  try {
    const root = realpathSync(directory);
    const repo = realpathSync(repositoryRoot);
    // Private project data must travel with this workspace, never via an external link.
    if (root !== resolve(repo, ".private/config") || resolve(directory) !== root) fail();
    const secure = (path, directory = false) => {
      const info = lstatSync(path);
      if ((directory ? !info.isDirectory() : !info.isFile()) || (info.mode & 0o077) ||
          (process.getuid && info.uid !== process.getuid())) fail();
    };
    secure(resolve(repo, ".private"), true);
    secure(root, true);
    const read = (name) => { const path = resolve(root, name); secure(path); return readFileSync(path, "utf8"); };
    const config = JSON.parse(read("operations.json"));
    if (config.schema !== "mind-diary/private-operations/v1") fail();
    for (const origin of [config.uat_origin, config.acceptance_origin]) {
      const url = new URL(origin);
      if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) fail();
    }
    if (config.uat_origin === config.acceptance_origin) fail();
    const manifests = {};
    const paths = {};
    for (const name of ["product", "acceptance", "probe"]) {
      if (name === "probe" && !existsSync(resolve(root, "hosting.probe.json"))) continue;
      paths[name] = resolve(root, `hosting.${name}.json`);
      const value = JSON.parse(read(`hosting.${name}.json`));
      if (!/^appgprj_[a-z0-9]+$/u.test(value.project_id) || value.project_id.includes("example") ||
          Object.keys(value).some((key) => !["project_id", "d1", "r2"].includes(key)) ||
          typeof value.d1 !== "string" || typeof value.r2 !== "string") fail();
      manifests[name] = value;
    }
    if (new Set(Object.values(manifests).map((m) => m.project_id)).size !== Object.keys(manifests).length) fail();
    for (const name of ["product", "acceptance"]) {
      if (manifests[name].d1 !== "DB" || manifests[name].r2 !== "MIND_DIARY_BUCKET") fail();
    }
    const dev = read("development.vars");
    const entries = Object.fromEntries(dev.split(/\r?\n/u).filter((line) => /^[A-Z][A-Z0-9_]*=/u.test(line)).map((line) => {
      const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1).replace(/^['"]|['"]$/gu, "")];
    }));
    for (const name of ["TOKEN_VERIFIER", "LOCATOR", "EXPORT_DOWNLOAD_VERIFIER", "CSRF"]) {
      if (!/^[A-Za-z0-9_-]{43}$/u.test(entries[`MIND_DIARY_${name}_KEY`] ?? "")) fail();
    }
    const local = new URL(entries.MIND_DIARY_PUBLIC_ORIGIN);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(local.hostname)) fail();
    return { directory: root, config, manifests, paths, development: resolve(root, "development.vars") };
  } catch { return fail(); }
}

export function privateAcceptanceDirectory() {
  const repo = realpathSync(resolve(import.meta.dirname, "../.."));
  const directory = resolve(repo, ".private/acceptance");
  for (const path of [resolve(repo, ".private"), directory]) {
    const info = lstatSync(path);
    if (!info.isDirectory() || (info.mode & 0o077) || realpathSync(path) !== path) fail();
  }
  return directory;
}

export function privateEnvironment(settings, environment = process.env) {
  return { ...environment,
    MIND_DIARY_HOSTING_CONFIG: settings.paths.product,
    MIND_DIARY_ACCEPTANCE_HOSTING_CONFIG: settings.paths.acceptance,
    ...(settings.paths.probe ? { MIND_DIARY_PROBE_HOSTING_CONFIG: settings.paths.probe } : {}),
    MIND_DIARY_UAT_ORIGIN: settings.config.uat_origin,
    MIND_DIARY_ACCEPTANCE_ORIGIN: settings.config.acceptance_origin,
    MIND_DIARY_ACCEPTANCE_PROJECT: settings.manifests.acceptance.project_id,
  };
}
