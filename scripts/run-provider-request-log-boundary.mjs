#!/usr/bin/env node

import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ProviderRequestLogBoundaryError,
  createProviderRequestLogBoundaryReceipt,
  verifyProviderRequestLogBoundaryReceipt,
} from "./lib/provider-request-log-boundary.mjs";

function fail(code) {
  throw new ProviderRequestLogBoundaryError(code);
}

export function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (!argument.startsWith("--")) fail("invalid_cli_argument");
    const key = argument.slice(2).replaceAll("-", "_");
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      fail("missing_cli_value");
    }
    if (Object.hasOwn(options, key)) fail("duplicate_cli_argument");
    options[key] = value;
    index += 1;
  }
  const required = ["input", "evidence_out"];
  if (
    Object.keys(options).some((key) => !required.includes(key)) ||
    required.some((key) => typeof options[key] !== "string")
  ) fail("invalid_cli_arguments");
  if (resolve(options.input) === resolve(options.evidence_out)) {
    fail("input_output_path_collision");
  }
  return options;
}

async function readPrivateInput(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    fail("input_file_unavailable");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    fail("input_file_not_private_regular");
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail("invalid_input_file");
  }
}

export async function run(options) {
  if (resolve(options.input) === resolve(options.evidence_out)) {
    fail("input_output_path_collision");
  }
  const input = await readPrivateInput(options.input);
  const evidence = verifyProviderRequestLogBoundaryReceipt(
    createProviderRequestLogBoundaryReceipt(input),
  );
  try {
    await writeFile(options.evidence_out, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code === "EEXIST") fail("evidence_output_exists");
    fail("evidence_write_failed");
  }
  return Object.freeze({
    status: evidence.status,
    artifact_sha256: evidence.artifact_sha256,
  });
}

function help() {
  return "Usage: node scripts/run-provider-request-log-boundary.mjs --input <private-classification.json> --evidence-out <new-private-path>";
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) process.stdout.write(`${help()}\n`);
    else process.stdout.write(`${JSON.stringify(await run(options))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: "failed",
      code: error instanceof ProviderRequestLogBoundaryError
        ? error.code
        : "provider_request_log_boundary_failed",
    })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
