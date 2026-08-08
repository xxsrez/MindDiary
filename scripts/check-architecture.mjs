import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageRoot = resolve(root, "packages");

const expectedDependencies = new Map(
  Object.entries({
    "@mind-diary/domain": [],
    "@mind-diary/okf-codec": ["@mind-diary/domain"],
    "@mind-diary/application-contracts": ["@mind-diary/domain"],
    "@mind-diary/application-ports": [
      "@mind-diary/application-contracts",
      "@mind-diary/domain",
    ],
    "@mind-diary/application-control": [
      "@mind-diary/application-contracts",
      "@mind-diary/application-ports",
      "@mind-diary/domain",
    ],
    "@mind-diary/application-content": [
      "@mind-diary/application-contracts",
      "@mind-diary/application-ports",
      "@mind-diary/domain",
      "@mind-diary/okf-codec",
    ],
    "@mind-diary/application-background": [
      "@mind-diary/application-contracts",
      "@mind-diary/application-ports",
      "@mind-diary/domain",
      "@mind-diary/okf-codec",
    ],
    "@mind-diary/adapter-web": ["@mind-diary/application-control"],
    "@mind-diary/adapter-mcp": ["@mind-diary/application-content"],
    "@mind-diary/adapter-background": [
      "@mind-diary/application-background",
    ],
    "@mind-diary/adapter-metadata-memory": [
      "@mind-diary/application-ports",
    ],
    "@mind-diary/adapter-object-memory": [
      "@mind-diary/application-ports",
    ],
    "@mind-diary/adapter-search-memory": [
      "@mind-diary/application-ports",
    ],
    "@mind-diary/adapter-security-webcrypto": [
      "@mind-diary/application-ports",
    ],
    "@mind-diary/adapter-audit-memory": [
      "@mind-diary/application-ports",
    ],
    "@mind-diary/adapter-audit-sites": [
      "@mind-diary/application-ports",
    ],
    "@mind-diary/adapter-metadata-sites": [
      "@mind-diary/adapter-metadata-memory",
      "@mind-diary/application-ports",
    ],
    "@mind-diary/adapter-object-sites": [
      "@mind-diary/application-ports",
    ],
    "@mind-diary/adapter-search-sites": [
      "@mind-diary/application-ports",
    ],
    "@mind-diary/composition-root": [
      "@mind-diary/adapter-audit-memory",
      "@mind-diary/adapter-audit-sites",
      "@mind-diary/adapter-background",
      "@mind-diary/adapter-mcp",
      "@mind-diary/adapter-metadata-memory",
      "@mind-diary/adapter-metadata-sites",
      "@mind-diary/adapter-object-memory",
      "@mind-diary/adapter-object-sites",
      "@mind-diary/adapter-search-memory",
      "@mind-diary/adapter-search-sites",
      "@mind-diary/adapter-security-webcrypto",
      "@mind-diary/adapter-web",
      "@mind-diary/application-background",
      "@mind-diary/application-content",
      "@mind-diary/application-control",
      "@mind-diary/application-ports",
      "@mind-diary/domain",
    ],
    "@mind-diary/test-fixtures": [
      "@mind-diary/domain",
      "@mind-diary/okf-codec",
    ],
  }),
);

const errors = [];
const packageDirectories = (
  await readdir(packageRoot, { withFileTypes: true })
)
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const packages = new Map();

for (const directory of packageDirectories) {
  const manifestPath = resolve(packageRoot, directory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  packages.set(manifest.name, { directory, manifest });
}

const actualNames = [...packages.keys()].sort();
const expectedNames = [...expectedDependencies.keys()].sort();
if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
  errors.push(
    `workspace packages differ from the approved graph\nexpected: ${expectedNames.join(", ")}\nactual: ${actualNames.join(", ")}`,
  );
}

const importPattern =
  /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

for (const [name, expected] of expectedDependencies) {
  const workspacePackage = packages.get(name);
  if (!workspacePackage) continue;

  const declared = Object.keys(workspacePackage.manifest.dependencies ?? {}).sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(declared) !== JSON.stringify(sortedExpected)) {
    errors.push(
      `${name}: manifest dependencies must be exactly [${sortedExpected.join(", ")}], got [${declared.join(", ")}]`,
    );
  }
  if (Object.keys(workspacePackage.manifest.devDependencies ?? {}).length > 0) {
    errors.push(`${name}: package-local devDependencies can hide graph edges`);
  }

  const sourceRoot = resolve(packageRoot, workspacePackage.directory, "src");
  const sourceFiles = (await readdir(sourceRoot))
    .filter((file) => file.endsWith(".ts"))
    .sort();
  const importedWorkspacePackages = new Set();
  for (const file of sourceFiles) {
    const path = resolve(sourceRoot, file);
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2];
      if (specifier?.startsWith("@mind-diary/")) {
        importedWorkspacePackages.add(specifier);
        if (!expected.includes(specifier)) {
          errors.push(`${name}: forbidden source import ${specifier} in ${file}`);
        }
      }
    }
    if (["@mind-diary/domain", "@mind-diary/okf-codec"].includes(name)) {
      const forbiddenLeafRuntime = [
        [/\bnode:/, "Node built-in"],
        [/\bprocess\s*\./, "process state"],
        [/\b(?:Deno|Bun)\s*\./, "runtime global"],
        [/\bfetch\s*\(/, "network fetch"],
        [/\b(?:WebSocket|XMLHttpRequest)\b/, "network client"],
      ];
      for (const [pattern, label] of forbiddenLeafRuntime) {
        if (pattern.test(source)) {
          errors.push(`${name}: ${label} is forbidden in leaf source ${file}`);
        }
      }
    }
  }
  for (const imported of importedWorkspacePackages) {
    if (!declared.includes(imported)) {
      errors.push(`${name}: source import ${imported} is undeclared`);
    }
  }

  const tsconfig = JSON.parse(
    await readFile(resolve(packageRoot, workspacePackage.directory, "tsconfig.json"), "utf8"),
  );
  const references = (tsconfig.references ?? [])
    .map(({ path }) => {
      const dependencyDirectory = path.replace(/^\.\.\//, "");
      return [...packages.entries()].find(
        ([, value]) => value.directory === dependencyDirectory,
      )?.[0];
    })
    .filter(Boolean)
    .sort();
  if (JSON.stringify(references) !== JSON.stringify(sortedExpected)) {
    errors.push(
      `${name}: TypeScript references do not match manifest dependencies`,
    );
  }
}

const visiting = new Set();
const visited = new Set();
function visit(name, path = []) {
  if (visiting.has(name)) {
    errors.push(`dependency cycle: ${[...path, name].join(" -> ")}`);
    return;
  }
  if (visited.has(name)) return;
  visiting.add(name);
  for (const dependency of expectedDependencies.get(name) ?? []) {
    visit(dependency, [...path, name]);
  }
  visiting.delete(name);
  visited.add(name);
}
for (const name of expectedDependencies.keys()) visit(name);

for (const leaf of ["@mind-diary/domain", "@mind-diary/okf-codec"]) {
  const closure = new Set();
  const queue = [leaf];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || closure.has(current)) continue;
    closure.add(current);
    queue.push(...(expectedDependencies.get(current) ?? []));
  }
  const forbidden = [...closure].filter(
    (name) => !["@mind-diary/domain", "@mind-diary/okf-codec"].includes(name),
  );
  if (forbidden.length > 0) {
    errors.push(`${leaf}: forbidden transitive dependencies ${forbidden.join(", ")}`);
  }
}

try {
  await readFile(resolve(root, ".openai", "hosting.json"), "utf8");
  errors.push(".openai/hosting.json is forbidden until an actual Sites project exists");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(`Architecture check passed (${packages.size} workspace packages).`);
