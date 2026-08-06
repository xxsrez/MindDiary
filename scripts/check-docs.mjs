import { access, readFile, readdir } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const markdownFiles = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist"].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile() && extname(entry.name) === ".md") markdownFiles.push(path);
  }
}

markdownFiles.push(resolve(root, "README.md"), resolve(root, "AGENTS.md"));
await walk(resolve(root, "docs"));
const errors = [];
const markdownLink = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
const headingSlug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

for (const path of markdownFiles.sort()) {
  const text = await readFile(path, "utf8");
  const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
  const headings = new Set(
    text
      .split("\n")
      .map((line) => line.match(/^#{1,6}\s+(.+?)\s*$/)?.[1])
      .filter(Boolean)
      .map(headingSlug),
  );
  for (const match of prose.matchAll(markdownLink)) {
    const rawTarget = match[1];
    if (/^(?:https?:|mailto:|data:)/.test(rawTarget)) continue;
    const [filePart, fragment] = rawTarget.split("#", 2);
    const targetPath = filePart
      ? resolve(dirname(path), decodeURIComponent(filePart))
      : path;
    try {
      await access(targetPath);
    } catch {
      errors.push(`${relative(root, path)}: missing link target ${rawTarget}`);
      continue;
    }
    if (fragment && targetPath === path && !headings.has(decodeURIComponent(fragment))) {
      errors.push(`${relative(root, path)}: missing local anchor #${fragment}`);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(`Documentation check passed (${markdownFiles.length} Markdown files).`);
