#!/usr/bin/env node

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { MCP_TOOL_DEFINITIONS } from "../packages/adapter-mcp/dist/index.js";
import { canonical } from "./lib/multi-principal-probe-core.mjs";

// This is the expected local candidate, not an observation of a deployment.
// Keep historical hosted/direct evidence untouched.
const SOURCE = "mind-diary-candidate-mcp-tools-list";
const SCHEMA = "mind-diary/candidate-tool-inventory/v1";

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

const candidate = inventory(MCP_TOOL_DEFINITIONS);
await writeFile(
  new URL("../tests/fixtures/file-ingress-evidence/candidate-tool-inventory.json", import.meta.url),
  `${JSON.stringify(candidate, null, 2)}\n`,
);
