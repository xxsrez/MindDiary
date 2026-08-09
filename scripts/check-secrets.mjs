import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const listed = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root },
)
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
const errors = [];
const existing = [];
for (const relativePath of listed) {
  try {
    if ((await stat(resolve(root, relativePath))).isFile()) existing.push(relativePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
const forbiddenTrackedConfig = /(^|\/)\.env(?:\..+)?$/;
const textExtensions = new Set([
  "",
  ".css",
  ".env",
  ".example",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".py",
  ".ts",
  ".txt",
  ".yaml",
  ".yml",
]);
const secretPatterns = [
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bgh[opusr]_[A-Za-z0-9]{30,}\b/, "GitHub token"],
  [/\bsk-[A-Za-z0-9_-]{24,}\b/, "API token"],
  [/Authorization\s*:\s*Bearer\s+(?!\$\{|<)[A-Za-z0-9._~-]{20,}/i, "bearer token"],
  [/(?:api[_-]?key|password|secret|token)\s*[:=]\s*["']?[A-Za-z0-9+/=_]{24,}["']?/i, "credential-like assignment"],
];

for (const relativePath of existing) {
  if (
    forbiddenTrackedConfig.test(relativePath) &&
    relativePath !== ".env.example" &&
    !relativePath.endsWith("/.env.example")
  ) {
    errors.push(`${relativePath}: local environment file must not be tracked`);
  }
  if (!textExtensions.has(extname(relativePath))) continue;
  const bytes = await readFile(resolve(root, relativePath));
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  for (const [pattern, label] of secretPatterns) {
    if (pattern.test(text)) errors.push(`${relativePath}: possible ${label}`);
  }
}

for (const relativePath of existing.filter(
  (path) => path === ".env.example" || path.endsWith("/.env.example"),
)) {
  const envExample = await readFile(resolve(root, relativePath), "utf8");
  for (const line of envExample.split("\n")) {
    const match = line.match(/^([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Z0-9_]*)=(.*)$/);
    if (match && match[2].trim() !== "") {
      errors.push(`${relativePath}: ${match[1]} must be empty or a documented placeholder`);
    }
  }
}

const gitignore = await readFile(resolve(root, ".gitignore"), "utf8");
for (const requiredPattern of [
  "node_modules/",
  "packages/*/dist/",
  ".env",
  ".env.*",
  "!.env.example",
  ".local/",
]) {
  if (!gitignore.split("\n").includes(requiredPattern)) {
    errors.push(`.gitignore: required pattern ${requiredPattern} is missing`);
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(`Secret/config hygiene check passed (${existing.length} files inspected).`);
