import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const app = resolve(root, "apps/mind-diary-site");
const required = [
  ".openai/hosting.json", "package.json", "package-lock.json", "vite.config.ts",
  "worker/index.ts", "worker/runtime-config.ts", "drizzle/0000_product_site.sql",
];
const errors = [];
for (const path of required) {
  try { await stat(resolve(app, path)); } catch { errors.push(`missing ${path}`); }
}

const hosting = JSON.parse(await readFile(resolve(app, ".openai/hosting.json"), "utf8"));
if (hosting.d1 !== "DB" || hosting.r2 !== "MIND_DIARY_BUCKET") errors.push("hosting bindings differ from product contract");
if (typeof hosting.project_id !== "string" || !/^appgprj_[a-z0-9]+$/u.test(hosting.project_id)) errors.push("hosting metadata is missing the coordinator-owned Sites project identity");
const serializedHosting = JSON.stringify(hosting);
if (/SECRET|TOKEN|KEY|PASSWORD/iu.test(serializedHosting)) errors.push("hosting metadata contains secret-like configuration");

const worker = await readFile(resolve(app, "worker/index.ts"), "utf8");
const composition = await readFile(resolve(root, "packages/composition-root/src/product-site.ts"), "utf8");
if (!worker.includes("createProductSiteRuntime")) errors.push("Worker does not use product composition");
if (!composition.includes("createSitesMetadataStore") || !composition.includes("createSitesObjectStore")) errors.push("composition does not select durable Sites adapters");
if (!composition.includes("createMcpHttpHandler") || !composition.includes("createProductWebHttpHandler")) errors.push("composition is missing web or MCP inbound boundary");
if (/sites-probe|PROBE_BUCKET|@aws-sdk|AgentCore|DynamoDB|OpenSearch/iu.test(`${worker}\n${composition}`)) errors.push("product Site contains a probe or forbidden production fallback");

const manifest = JSON.parse(await readFile(resolve(app, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(resolve(app, "package-lock.json"), "utf8"));
if (manifest.name !== "mind-diary-product-site" || lock.name !== manifest.name || lock.packages?.[""]?.name !== manifest.name) errors.push("product package/lock identity mismatch");
if (JSON.stringify(manifest.dependencies) !== JSON.stringify(lock.packages?.[""]?.dependencies)) errors.push("product runtime dependency lock mismatch");
if (JSON.stringify(manifest.devDependencies) !== JSON.stringify(lock.packages?.[""]?.devDependencies)) errors.push("product build dependency lock mismatch");

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}
console.log("Product Site contract check passed.");
