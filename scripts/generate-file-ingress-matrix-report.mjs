#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  joinFileIngressEvidence,
  loadFileIngressEvidenceConfig,
  resolveCandidateSha,
  stableJson,
} from "./lib/file-ingress-evidence.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(argv) {
  const options = { hostedReceipts: [], requireComplete: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--require-complete") {
      options.requireComplete = true;
      continue;
    }
    const value = argv[index + 1];
    assert(value !== undefined, `missing value for ${argument}`);
    index += 1;
    if (argument === "--sha") options.candidate = value;
    else if (argument === "--output") options.output = value;
    else if (argument === "--local-receipt") options.localReceipt = resolve(value);
    else if (argument === "--hosted-receipt") {
      const separator = value.indexOf("=");
      assert(separator > 0 && separator < value.length - 1, "--hosted-receipt must be profile_id=path");
      options.hostedReceipts.push({
        profileId: value.slice(0, separator),
        path: resolve(value.slice(separator + 1)),
      });
    } else throw new Error(`unknown argument ${argument}`);
  }
  assert(options.candidate, "--sha is required");
  assert(options.output, "--output is required");
  return options;
}

async function readJson(path, profileId = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return profileId === null ? {} : { client_profile_id: profileId };
  }
}

async function writeReport(repositoryRoot, output, report) {
  const outputPath = resolve(repositoryRoot, output);
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = resolve(dirname(outputPath), `.${basename(outputPath)}.${process.pid}.tmp`);
  await writeFile(temporaryPath, stableJson(report), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, outputPath);
  return outputPath;
}

export async function generateFileIngressMatrixReport({
  repositoryRoot,
  candidate,
  output,
  localReceiptPath = null,
  hostedReceiptPaths = [],
}) {
  const config = await loadFileIngressEvidenceConfig(repositoryRoot);
  const candidateSha = resolveCandidateSha(repositoryRoot, candidate);
  const localReceipt = localReceiptPath === null ? null : await readJson(localReceiptPath);
  const hostedReceipts = [];
  for (const { profileId, path } of hostedReceiptPaths) {
    const document = await readJson(path, profileId);
    hostedReceipts.push(
      document.client_profile_id === profileId
        ? document
        : { client_profile_id: profileId },
    );
  }
  const report = joinFileIngressEvidence({
    ...config,
    candidateSha,
    localReceipt,
    hostedReceipts,
  });
  const outputPath = await writeReport(repositoryRoot, output, report);
  return Object.freeze({ report, outputPath });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const { report, outputPath } = await generateFileIngressMatrixReport({
    repositoryRoot,
    candidate: options.candidate,
    output: options.output,
    localReceiptPath: options.localReceipt ?? null,
    hostedReceiptPaths: options.hostedReceipts,
  });
  console.log(
    `File-ingress matrix ${report.status} for ${report.candidate_sha}: ${relative(repositoryRoot, outputPath)}`,
  );
  if (report.status === "failed") process.exitCode = 1;
  else if (options.requireComplete && report.status !== "passed") process.exitCode = 2;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`File-ingress matrix failed: ${error.message}`);
    process.exitCode = 1;
  });
}
