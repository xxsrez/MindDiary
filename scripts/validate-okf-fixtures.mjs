import { readFile, readdir } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { parseDocument } from "yaml";

const root = resolve(import.meta.dirname, "..");
const fixturesRoot = resolve(root, "tests", "fixtures", "okf");
const bundleDirectories = (await readdir(fixturesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => resolve(fixturesRoot, entry.name))
  .sort();
const errors = [];

async function collectFiles(directory, found = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(path, found);
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

function parseFrontmatter(text, path) {
  const match = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    errors.push(`${path}: concept requires YAML frontmatter`);
    return null;
  }
  const document = parseDocument(match[1], {
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    errors.push(`${path}: invalid YAML (${document.errors[0].message})`);
    return null;
  }
  const value = document.toJS({ maxAliasCount: 0 });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path}: frontmatter must be a mapping`);
    return null;
  }
  return value;
}

function validActor(value) {
  return (
    typeof value === "string" &&
    /^(?:human:\S+|process:\S+|[^\s/]+\/[^\s/]+)$/.test(value)
  );
}

function validateOptionalMetadata(metadata, path) {
  if (metadata.generated !== undefined) {
    if (
      !metadata.generated ||
      typeof metadata.generated !== "object" ||
      Array.isArray(metadata.generated) ||
      !validActor(metadata.generated.by) ||
      typeof metadata.generated.at !== "string" ||
      Number.isNaN(Date.parse(metadata.generated.at))
    ) {
      errors.push(`${path}: generated must contain a valid by actor and ISO instant`);
    }
  }
  if (metadata.sources !== undefined) {
    if (
      !Array.isArray(metadata.sources) ||
      metadata.sources.some(
        (source) =>
          !source ||
          typeof source !== "object" ||
          typeof source.resource !== "string" ||
          source.resource.trim() === "",
      )
    ) {
      errors.push(`${path}: every sources entry requires a non-empty resource`);
    }
  }
  if (metadata.verified !== undefined) {
    const verifiers = Array.isArray(metadata.verified)
      ? metadata.verified
      : [metadata.verified];
    if (
      verifiers.some(
        (verifier) =>
          !verifier ||
          typeof verifier !== "object" ||
          !validActor(verifier.by) ||
          (verifier.at !== undefined &&
            (typeof verifier.at !== "string" ||
              Number.isNaN(Date.parse(verifier.at)))),
      )
    ) {
      errors.push(`${path}: verified entries require a valid by actor and optional ISO instant`);
    }
  }
}

for (const bundleRoot of bundleDirectories) {
  const files = (await collectFiles(bundleRoot)).sort();
  if (files.length === 0) errors.push(`${bundleRoot}: empty bundle fixture`);
  for (const path of files) {
    const bundlePath = relative(bundleRoot, path).replaceAll("\\", "/");
    if (!bundlePath.endsWith(".md")) {
      errors.push(`${bundlePath}: MVP fixture permits UTF-8 Markdown only`);
      continue;
    }
    const bytes = await readFile(path);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const reserved = ["index.md", "log.md"].includes(basename(path));
    if (!reserved) {
      const metadata = parseFrontmatter(text, bundlePath);
      if (!metadata) continue;
      if (typeof metadata.type !== "string" || metadata.type.trim() === "") {
        errors.push(`${bundlePath}: non-empty type is required`);
      }
      if (
        metadata.status !== undefined &&
        !["draft", "stable", "deprecated"].includes(metadata.status)
      ) {
        errors.push(`${bundlePath}: invalid OKF 0.2 status`);
      }
      validateOptionalMetadata(metadata, bundlePath);
    } else if (basename(path) === "index.md") {
      if (bundlePath === "index.md") {
        const metadata = parseFrontmatter(text, bundlePath);
        if (metadata?.okf_version !== "0.2") {
          errors.push(`${bundlePath}: root okf_version must be \"0.2\"`);
        }
      } else if (text.startsWith("---\n")) {
        errors.push(`${bundlePath}: nested index.md cannot have frontmatter`);
      }
    } else {
      const dates = [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
      if (dates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
        errors.push(`${bundlePath}: log headings must be exact UTC dates`);
      }
      if (dates.some((date, index) => index > 0 && date > dates[index - 1])) {
        errors.push(`${bundlePath}: log date groups must be newest-first`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(
  `OKF fixture validation passed (${bundleDirectories.length} complete bundle fixture).`,
);
