import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { packageProductSiteArchive } from "./lib/product-site-archive.mjs";

const [output, candidate] = process.argv.slice(2);
if (!output || !/^[0-9a-f]{40}$/u.test(candidate ?? "") || process.argv.length !== 4) {
  throw new Error("Usage: node scripts/package-product-site.mjs <archive.tgz> <full-candidate-sha>");
}
const root = resolve(import.meta.dirname, "..");
execFileSync(process.execPath, [resolve(root, "scripts/check-product-site-artifact.mjs"), "--candidate-sha", candidate], { stdio: "inherit" });
console.log(JSON.stringify(await packageProductSiteArchive(resolve(root, "apps/mind-diary-site"), output)));
