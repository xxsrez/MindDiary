import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { validateOkfBundle } from "@mind-diary/okf-codec";

const root = resolve(import.meta.dirname, "..");
const fixturesRoot = resolve(root, "tests", "fixtures", "okf");
const bundleDirectories = (await readdir(fixturesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => resolve(fixturesRoot, entry.name))
  .sort();
const harnessErrors = [];
const validationErrors = [];
const qualityWarnings = [];

async function collectFiles(directory, found = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(path, found);
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

for (const bundleRoot of bundleDirectories) {
  const fixtureName = relative(fixturesRoot, bundleRoot).replaceAll("\\", "/");
  const paths = (await collectFiles(bundleRoot)).sort();
  if (paths.length === 0) {
    harnessErrors.push(`${fixtureName}: fixture directory must not be empty`);
    continue;
  }
  const files = await Promise.all(
    paths.map(async (path) => ({
      path: relative(bundleRoot, path).replaceAll("\\", "/"),
      bytes: await readFile(path),
    })),
  );
  const result = validateOkfBundle(files);
  for (const issue of result.diagnostics) {
    const rendered = `${fixtureName}/${issue.path}: [${issue.category}/${issue.code}] ${issue.message}`;
    if (issue.severity === "error") validationErrors.push(rendered);
    else qualityWarnings.push(rendered);
  }
}

if (qualityWarnings.length > 0) {
  console.warn(qualityWarnings.map((warning) => `- warning: ${warning}`).join("\n"));
  process.exitCode = 1;
}
const errors = [...harnessErrors, ...validationErrors];
if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(
  `OKF fixture validation passed (${bundleDirectories.length} complete bundle fixtures, ${qualityWarnings.length} quality warnings).`,
);
