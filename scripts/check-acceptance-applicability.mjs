import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { deriveAcceptanceApplicability } from "./lib/acceptance-applicability.mjs";
const [inputPath, outputPath] = process.argv.slice(2);
try {
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const base = execFileSync("git", ["rev-parse", "--verify", input.base_sha + "^{commit}"], { encoding: "utf8" }).trim();
  const candidate = execFileSync("git", ["rev-parse", "--verify", input.candidate_sha + "^{commit}"], { encoding: "utf8" }).trim();
  if (base !== input.base_sha || candidate !== input.candidate_sha) throw Error("exact_commits_required");
  const paths = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", base, candidate], { encoding: "utf8" }).split("\0").filter(Boolean);
  const result = deriveAcceptanceApplicability({ ...input, changed_paths: paths });
  await writeFile(outputPath, JSON.stringify(result), { mode: 0o600 });
  console.log(JSON.stringify({ schema: result.schema, policy: result.policy, required: result.required, artifact_sha256: result.artifact_sha256 }));
} catch { console.error("acceptance_applicability_rejected"); process.exitCode = 1; }
