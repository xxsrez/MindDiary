import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const packagesRoot = resolve(repositoryRoot, "packages");

for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  await rm(resolve(packagesRoot, entry.name, "dist"), {
    recursive: true,
    force: true,
  });
}
