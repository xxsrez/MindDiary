import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { canonical } from "./multi-principal-probe-core.mjs";

const INVENTORY_PATH = new URL(
  "../../tests/fixtures/file-ingress-evidence/hosted-tool-inventory.json",
  import.meta.url,
);
const EXPECTED_SCHEMA = "mind-diary/file-ingress-hosted-tool-inventory/v1";
const EXPECTED_SOURCE = "mind-diary-hosted-mcp-tools-list";
const EXPECTED_TOOL_COUNT = 25;

function schemaHash(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function loadExpectedInventory() {
  const value = JSON.parse(readFileSync(INVENTORY_PATH, "utf8"));
  if (
    value?.schema !== EXPECTED_SCHEMA ||
    value?.source !== EXPECTED_SOURCE ||
    !Array.isArray(value.entries) ||
    value.entries.length !== EXPECTED_TOOL_COUNT
  ) {
    throw new TypeError("Exact MCP tool inventory fixture is invalid.");
  }
  const entries = value.entries.map((entry) => Object.freeze({ ...entry }));
  const names = entries.map(({ name }) => name);
  if (
    new Set(names).size !== EXPECTED_TOOL_COUNT ||
    names.some((name) => typeof name !== "string") ||
    names.some((name, index) => index > 0 && name <= names[index - 1])
  ) {
    throw new TypeError("Exact MCP tool inventory fixture is not closed and sorted.");
  }
  return Object.freeze(entries);
}

export const EXPECTED_MCP_TOOL_INVENTORY = loadExpectedInventory();
export const EXPECTED_MCP_TOOL_NAMES = Object.freeze(
  EXPECTED_MCP_TOOL_INVENTORY.map(({ name }) => name),
);
export const EXPECTED_DEFAULT_MCP_TOOL_NAMES = Object.freeze(
  EXPECTED_MCP_TOOL_NAMES.filter((name) => name !== "stage_bundle_file"),
);
export const EXPECTED_VERIFIED_NATIVE_MCP_TOOL_NAMES = Object.freeze(
  EXPECTED_MCP_TOOL_NAMES,
);

function matchesInventory(tools, expected) {
  if (!Array.isArray(tools) || tools.length !== expected.length) {
    return false;
  }
  const entries = [];
  for (const tool of tools) {
    if (
      tool === null ||
      typeof tool !== "object" ||
      typeof tool.name !== "string" ||
      tool.inputSchema === null ||
      typeof tool.inputSchema !== "object" ||
      Array.isArray(tool.inputSchema) ||
      tool.outputSchema === null ||
      typeof tool.outputSchema !== "object" ||
      Array.isArray(tool.outputSchema)
    ) {
      return false;
    }
    entries.push(Object.freeze({
      name: tool.name,
      source: EXPECTED_SOURCE,
      input_schema_sha256: schemaHash(tool.inputSchema),
      output_schema_sha256: schemaHash(tool.outputSchema),
    }));
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return canonical(entries) === canonical(expected);
}

export function matchesExactMcpToolInventory(tools) {
  return matchesInventory(tools, EXPECTED_MCP_TOOL_INVENTORY);
}

export function matchesExactVerifiedNativeMcpToolInventory(tools) {
  return matchesInventory(tools, EXPECTED_MCP_TOOL_INVENTORY);
}

// Compatibility clients keep the upload intent but omit the modern fileParams
// tool until that client/profile is tested separately.
export function matchesExactDefaultMcpToolInventory(tools) {
  return matchesInventory(
    tools,
    EXPECTED_MCP_TOOL_INVENTORY.filter(({ name }) =>
      name !== "stage_bundle_file"),
  );
}

export function matchesExactReadOnlyMcpToolInventory(tools) {
  return matchesInventory(
    tools,
    EXPECTED_MCP_TOOL_INVENTORY.filter(({ name }) =>
      name !== "create_file_upload_intent" &&
      name !== "stage_bundle_file"),
  );
}
