import { readFile, writeFile } from "node:fs/promises";
import { joinAcceptanceSuite } from "./lib/acceptance-evidence.mjs";
const [manifestPath, outputPath, ...componentPaths] = process.argv.slice(2);
try {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const components = await Promise.all(componentPaths.map(async path => JSON.parse(await readFile(path, "utf8"))));
  const report = joinAcceptanceSuite(manifest, components.filter(c => c.schema === "mind-diary/acceptance-component/v1"), components.filter(c => c.schema !== "mind-diary/acceptance-component/v1"));
  await writeFile(outputPath, JSON.stringify(report), { mode: 0o600 });
  console.log(JSON.stringify({ schema: report.schema, status: report.status, artifact_sha256: report.artifact_sha256 }));
} catch {
  console.error("acceptance_suite_rejected"); process.exitCode = 1;
}
