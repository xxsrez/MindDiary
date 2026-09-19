#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { MCP_TOOL_DEFINITIONS } from "../packages/adapter-mcp/dist/index.js";
import { canonical } from "./lib/multi-principal-probe-core.mjs";

const SOURCE = "mind-diary-hosted-mcp-tools-list";
const SCHEMA = "mind-diary/mcp-tool-inventory/v2";
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--check")) throw new Error("Only --check is supported.");

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
      descriptor_sha256: hash(definition),
    })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  };
}

const target = new URL("../tests/fixtures/file-ingress-evidence/hosted-tool-inventory.json", import.meta.url);
const expected = `${JSON.stringify(inventory(MCP_TOOL_DEFINITIONS), null, 2)}\n`;
if (args.includes("--check")) {
  if (await readFile(target, "utf8") !== expected) {
    throw new Error("MCP descriptor inventory is stale. Run npm run generate:mcp-tool-inventories.");
  }
} else {
  await writeFile(target, expected);
}
