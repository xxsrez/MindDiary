import { readFile, readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";

const FORBIDDEN = Object.freeze([
  ["synthetic identity variant", /synthetic_test_identity/iu],
  ["synthetic binding namespace", /synthetic-test/iu],
  ["synthetic principal provider", /SyntheticPrincipal/iu],
  ["synthetic runtime flag", /MIND_DIARY_(?:ENABLE_)?SYNTHETIC/iu],
  ["synthetic identity header", /x-mind-diary-synthetic/iu],
  ["test login route", /(?:\/test-login|\/synthetic-login)/iu],
]);

const TEXT_EXTENSIONS = new Set([
  ".json", ".jsonc", ".mjs", ".js", ".ts", ".tsx", ".css", ".html", ".sql", ".toml", ".yaml", ".yml",
]);

function isTextConfig(name) {
  return name === ".env" || name === ".dev.vars" || name.startsWith(".env.");
}

async function collect(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      if (!new Set(["dist", "node_modules", "build"]).has(entry.name)) {
        result.push(...await collect(path));
      }
    } else if (
      entry.isFile() &&
      (TEXT_EXTENSIONS.has(extname(entry.name)) || isTextConfig(entry.name))
    ) {
      result.push(path);
    }
  }
  return result;
}

export async function findSyntheticProductAuthority(root) {
  const productRoots = [
    resolve(root, "apps/mind-diary-site"),
    resolve(root, "packages"),
  ];
  const findings = [];
  for (const productRoot of productRoots) {
    for (const path of await collect(productRoot)) {
      const source = await readFile(path, "utf8");
      for (const [label, pattern] of FORBIDDEN) {
        if (pattern.test(source)) findings.push({ label, path });
      }
    }
  }
  return Object.freeze(findings.map((finding) => Object.freeze(finding)));
}

export async function assertNoSyntheticProductAuthority(root) {
  const findings = await findSyntheticProductAuthority(root);
  if (findings.length > 0) {
    const error = new Error("Synthetic test authority is present in product packaging.");
    error.code = "synthetic_product_authority_detected";
    error.findings = findings;
    throw error;
  }
  return true;
}
