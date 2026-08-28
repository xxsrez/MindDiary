#!/usr/bin/env node

import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  Release03AccessAdminEvidenceError,
  createRelease03AccessAdminUatJoin,
} from "./lib/release-0.3-access-admin-evidence.mjs";
import { reservePrivateTempOutput } from "./lib/private-evidence-output.mjs";

const ROOT = resolve(import.meta.dirname, "..");

function fail(code) {
  throw new Release03AccessAdminEvidenceError(code);
}

function contains(parent, child) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

async function privateRoots() {
  const roots = [];
  for (const path of [tmpdir(), "/tmp", "/private/tmp"]) {
    try {
      roots.push(await realpath(path));
    } catch {}
  }
  return [...new Set(roots)];
}

export async function readPrivateReceipt(path, code = "unsafe_private_receipt") {
  let handle;
  try {
    if (typeof path !== "string" || !isAbsolute(path)) fail(code);
    const parent = await realpath(dirname(path));
    const parentStat = await stat(parent);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!parentStat.isDirectory() || uid === null || parentStat.uid !== uid ||
        (parentStat.mode & 0o777) !== 0o700 ||
        !(await privateRoots()).some((root) => parent !== root && contains(root, parent))) fail(code);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const [pathStat, handleStat] = await Promise.all([lstat(path), handle.stat()]);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || !handleStat.isFile() ||
        pathStat.dev !== handleStat.dev || pathStat.ino !== handleStat.ino ||
        handleStat.uid !== uid || (handleStat.mode & 0o777) !== 0o600) fail(code);
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof Release03AccessAdminEvidenceError) throw error;
    fail(code);
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (!argument.startsWith("--")) fail("invalid_cli_argument");
    const key = argument.slice(2).replaceAll("-", "_");
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) fail("missing_cli_value");
    if (Object.hasOwn(options, key)) fail("duplicate_cli_argument");
    options[key] = value;
    index += 1;
  }
  const allowed = new Set(["local_evidence", "pool_evidence", "hosted_observation", "output"]);
  if (Object.keys(options).some((key) => !allowed.has(key))) fail("unsupported_cli_argument");
  if ([...allowed].some((key) => typeof options[key] !== "string")) fail("missing_cli_value");
  return options;
}

export async function run(options) {
  const output = await reservePrivateTempOutput(resolve(options.output), {
    repositoryRoot: ROOT,
    errorCode: "unsafe_access_admin_join_output",
  });
  try {
    const evidence = createRelease03AccessAdminUatJoin({
      localEvidence: await readPrivateReceipt(options.local_evidence),
      poolEvidence: await readPrivateReceipt(options.pool_evidence),
      hostedObservation: await readPrivateReceipt(options.hosted_observation),
    });
    await output.write(`${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
  } catch (error) {
    await output.abort();
    throw error;
  }
}

function help() {
  return [
    "Usage: npm run join:release-0.3-access-admin --",
    "  --local-evidence <private-local-receipt>",
    "  --pool-evidence <private-pool-readiness-receipt>",
    "  --hosted-observation <private-same-run-hosted-observation>",
    "  --output <new-private-temp-path>",
  ].join(" ");
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) process.stdout.write(`${help()}\n`);
    else {
      const evidence = await run(options);
      process.stdout.write(`${JSON.stringify({
        status: evidence.status,
        hosted_evidence: evidence.hosted_evidence,
        candidate_sha: evidence.candidate_sha,
        deployment_id: evidence.deployment_id,
        artifact_sha256: evidence.artifact_sha256,
      })}\n`);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: "failed",
      code: error instanceof Release03AccessAdminEvidenceError
        ? error.code
        : "access_admin_join_failed",
    })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
