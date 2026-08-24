#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  CONNECTOR_OBJECT_BRIDGE_LIMITS,
  ConnectorObjectCompanionUploader,
  connectorObjectReceipt,
  isSuccessfulConnectorObjectReceipt,
} from "./lib/connector-object-upload-bridge.mjs";

async function readPrivateState(input) {
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = chunk instanceof Uint8Array
      ? new Uint8Array(chunk)
      : new TextEncoder().encode(String(chunk));
    size += bytes.byteLength;
    if (size > CONNECTOR_OBJECT_BRIDGE_LIMITS.maxPrivateStateBytes) return null;
    chunks.push(bytes);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
  } catch {
    return null;
  }
}

/**
 * Private inputs (materialized path and capability URL) are stdin-only.
 * stdout is exactly one classification receipt; stderr never echoes state.
 */
export async function runConnectorObjectUploadBridge({
  input = process.stdin,
  output = process.stdout,
  argv = process.argv.slice(2),
  uploader,
  expectedOrigin = process.env.MIND_DIARY_CONNECTOR_UPLOAD_ORIGIN,
} = {}) {
  let receipt;
  let activeUploader = uploader;
  if (activeUploader === undefined) {
    try {
      activeUploader = new ConnectorObjectCompanionUploader({ expectedOrigin });
    } catch {
      activeUploader = null;
    }
  }
  if (argv.length !== 0 || activeUploader === null) {
    receipt = connectorObjectReceipt({ status: "invalid_private_state" });
  } else {
    const privateState = await readPrivateState(input);
    receipt = privateState === null
      ? connectorObjectReceipt({ status: "invalid_private_state" })
      : await activeUploader.upload(privateState);
  }
  output.write(`${JSON.stringify(receipt)}\n`);
  return Object.freeze({
    receipt,
    exitCode: isSuccessfulConnectorObjectReceipt(receipt) ? 0 : 2,
  });
}

const invokedPath = process.argv[1] === undefined
  ? null
  : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const result = await runConnectorObjectUploadBridge();
  process.exitCode = result.exitCode;
}
