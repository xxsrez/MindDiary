#!/usr/bin/env node

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { MCP_TOOL_DEFINITIONS } from "../packages/adapter-mcp/dist/index.js";
import { canonical } from "./lib/multi-principal-probe-core.mjs";

const SOURCE = "mind-diary-hosted-mcp-tools-list";
const SCHEMA = "mind-diary/file-ingress-hosted-tool-inventory/v1";

function hash(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function inventory(definitions) {
  return {
    schema: SCHEMA,
    source: SOURCE,
    entries: definitions.map((definition) => ({
      name: definition.name,
      source: SOURCE,
      input_schema_sha256: hash(definition.inputSchema),
      output_schema_sha256: hash(definition.outputSchema),
    })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  };
}

const hosted = inventory(MCP_TOOL_DEFINITIONS);
const direct = inventory(MCP_TOOL_DEFINITIONS.filter(({ name }) =>
  name !== "open_bundle_file_picker" && name !== "stage_bundle_file"));

await Promise.all([
  writeFile(
    new URL("../tests/fixtures/file-ingress-evidence/hosted-tool-inventory.json", import.meta.url),
    `${JSON.stringify(hosted, null, 2)}\n`,
  ),
  writeFile(
    new URL("../tests/fixtures/file-ingress-evidence/direct-tool-inventory.json", import.meta.url),
    `${JSON.stringify(direct, null, 2)}\n`,
  ),
]);
