import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { findSyntheticProductAuthority } from "./lib/synthetic-product-negative.mjs";

const root = resolve(import.meta.dirname, "..");
const app = resolve(root, "apps/mind-diary-site");
const required = [
  ".openai/hosting.json", "package.json", "package-lock.json", "vite.config.ts",
  "worker/index.ts", "worker/runtime-config.ts", "tools/package-site.mjs", "tools/artifact-manifest.mjs", "drizzle/0000_product_site.sql",
  "drizzle/0001_oauth_connector.sql", "drizzle/0002_connection_presentation_refs.sql",
  "drizzle/0003_system_backup.sql", "drizzle/0004_canonical_key_gates.sql",
];
const errors = [];
for (const path of required) {
  try { await stat(resolve(app, path)); } catch { errors.push(`missing ${path}`); }
}
try { await stat(resolve(root, "scripts/check-product-site-artifact.mjs")); }
catch { errors.push("missing scripts/check-product-site-artifact.mjs"); }

const hosting = JSON.parse(await readFile(resolve(app, ".openai/hosting.json"), "utf8"));
if (hosting.d1 !== "DB" || hosting.r2 !== "MIND_DIARY_BUCKET") errors.push("hosting bindings differ from product contract");
if (typeof hosting.project_id !== "string" || !/^appgprj_[a-z0-9]+$/u.test(hosting.project_id)) errors.push("hosting metadata is missing the coordinator-owned Sites project identity");
const serializedHosting = JSON.stringify(hosting);
if (/SECRET|TOKEN|KEY|PASSWORD/iu.test(serializedHosting)) errors.push("hosting metadata contains secret-like configuration");

const worker = await readFile(resolve(app, "worker/index.ts"), "utf8");
const runtimeConfig = await readFile(resolve(app, "worker/runtime-config.ts"), "utf8");
const composition = await readFile(resolve(root, "packages/composition-root/src/product-site.ts"), "utf8");
const mcp = await readFile(resolve(root, "packages/adapter-mcp/src/tool-definitions.ts"), "utf8");
const tokenUi = await readFile(resolve(root, "packages/adapter-web/src/token-management.ts"), "utf8");
const sitesPackaging = await readFile(resolve(app, "tools/package-site.mjs"), "utf8");
const artifactCheck = await readFile(resolve(root, "scripts/check-product-site-artifact.mjs"), "utf8");
if (!worker.includes("createProductSiteRuntime")) errors.push("Worker does not use product composition");
if (!composition.includes("createSitesMetadataStore") || !composition.includes("createSitesObjectStore")) errors.push("composition does not select durable Sites adapters");
if (!composition.includes("createMcpHttpHandler") || !composition.includes("createProductWebHttpHandler")) errors.push("composition is missing web or MCP inbound boundary");
if (!mcp.includes('MCP_ENDPOINT = "/api/mcp"')) errors.push("MCP adapter does not expose the single Sites-safe endpoint");
if (!composition.includes("path === MCP_ENDPOINT") || composition.includes("MCP_LEGACY_CODEX_ENDPOINT")) errors.push("product dispatcher must route only the modern MCP endpoint");
if (tokenUi.includes("/api/mcp/2025-11-25") || !tokenUi.includes("/api/mcp")) errors.push("Codex token instructions must use the single MCP endpoint");
if (!sitesPackaging.includes("createSiteArtifactManifest")) errors.push("Product Site build does not emit the complete artifact manifest");
if (!artifactCheck.includes("verifySiteArtifactManifest") || !artifactCheck.includes("--porcelain")) errors.push("Product Site artifact check does not verify source, checkout cleanliness, and all packaged files");
if (/sites-probe|PROBE_BUCKET|@aws-sdk|AgentCore|DynamoDB|OpenSearch/iu.test(`${worker}\n${composition}`)) errors.push("product Site contains a probe or forbidden production fallback");
if (/identityBindingProvider|IDENTITY_BINDING_PROVIDER/u.test(`${worker}\n${runtimeConfig}`)) errors.push("product Worker/config overrides the fixed OpenAI Sites binding provider");
for (const finding of await findSyntheticProductAuthority(root)) {
  errors.push(`product packaging contains ${finding.label}: ${finding.path}`);
}

const manifest = JSON.parse(await readFile(resolve(app, "package.json"), "utf8"));
if (!manifest.scripts.build.includes("vinext build && node tools/package-site.mjs")) errors.push("Product Site manifest must be generated after the complete build");
const lock = JSON.parse(await readFile(resolve(app, "package-lock.json"), "utf8"));
if (manifest.name !== "mind-diary-product-site" || lock.name !== manifest.name || lock.packages?.[""]?.name !== manifest.name) errors.push("product package/lock identity mismatch");
if (JSON.stringify(manifest.dependencies) !== JSON.stringify(lock.packages?.[""]?.dependencies)) errors.push("product runtime dependency lock mismatch");
if (JSON.stringify(manifest.devDependencies) !== JSON.stringify(lock.packages?.[""]?.devDependencies)) errors.push("product build dependency lock mismatch");

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}
console.log("Product Site contract check passed.");
