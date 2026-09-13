import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backupPolicy } from "./lib/backup-completeness-registry.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const failures = [];

function filesUnder(path, suffix) {
  return readdirSync(join(root, path), { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory()
      ? filesUnder(child, suffix)
      : entry.isFile() && child.endsWith(suffix) ? [child] : [];
  });
}

function compare(label, actual, expected) {
  const missing = [...actual].filter((item) => !expected.has(item)).sort();
  const stale = [...expected].filter((item) => !actual.has(item)).sort();
  if (missing.length || stale.length) {
    failures.push(`${label}: unclassified=${missing.join(",") || "none"}; stale=${stale.join(",") || "none"}`);
  }
}

function endOfBalanced(source, start) {
  let depth = 1;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    if (source[cursor] === "(") depth += 1;
    if (source[cursor] === ")") depth -= 1;
    if (depth === 0) return cursor;
  }
  throw new Error("Unclosed CREATE TABLE statement");
}

function tableColumns(source, start, end) {
  const body = source.slice(start, end);
  const columns = new Set();
  let depth = 0;
  let segment = "";
  for (const character of `${body},`) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      const match = segment.trim().match(/^([a-z_][a-z_0-9]*)\s+(?:INTEGER|TEXT|REAL|BLOB|NUMERIC)\b/iu);
      if (match) columns.add(match[1]);
      segment = "";
    } else {
      segment += character;
    }
  }
  return columns;
}

const sources = filesUnder("packages", ".ts")
  .filter((path) => /\/src\//u.test(path))
  .concat(filesUnder("apps/mind-diary-site/drizzle", ".sql"));
const actualTables = new Map();
for (const path of sources) {
  const source = read(path);
  for (const match of source.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_][a-z_0-9]*)\s*\(/giu)) {
    const start = match.index + match[0].length;
    const columns = tableColumns(source, start, endOfBalanced(source, start));
    if (!columns.size) failures.push(`${path}: ${match[1]} has no statically discoverable columns`);
    const known = actualTables.get(match[1]) ?? new Set();
    for (const column of columns) known.add(column);
    actualTables.set(match[1], known);
  }
  for (const match of source.matchAll(/ALTER TABLE\s+([a-z_][a-z_0-9]*)\s+ADD COLUMN\s+([a-z_][a-z_0-9]*)\b/giu)) {
    const known = actualTables.get(match[1]) ?? new Set();
    known.add(match[2]);
    actualTables.set(match[1], known);
  }
}
compare("D1 tables", new Set(actualTables.keys()), new Set(Object.keys(backupPolicy.d1)));
for (const [table, [, columnList]] of Object.entries(backupPolicy.d1)) {
  compare(`D1 ${table}`, actualTables.get(table) ?? new Set(), new Set(columnList.split(" ")));
}
const runtimeSchemaSource = read("packages/composition-root/src/system-backup-schema.ts");
const runtimeSchemaBlock = runtimeSchemaSource.match(/SYSTEM_BACKUP_D1_SCHEMA\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\s+as const\)/u);
if (runtimeSchemaBlock === null) {
  failures.push("system backup runtime D1 schema declaration changed");
} else {
  const runtimeTables = new Map([...runtimeSchemaBlock[1]
    .matchAll(/^\s+([a-z_][a-z_0-9]*):\s*"([^"]+)"/gmu)]
    .map((match) => [match[1], match[2]]));
  compare("system backup runtime D1 tables", new Set(runtimeTables.keys()),
    new Set(Object.keys(backupPolicy.d1)));
  for (const [table, [, columns]] of Object.entries(backupPolicy.d1)) {
    if (runtimeTables.get(table) !== columns) {
      failures.push(`system backup runtime D1 ${table}: columns differ from registry`);
    }
  }
}

function snapshotFields(path, indentation) {
  const source = read(path);
  const start = source.indexOf("exportDurableSnapshot(): unknown {");
  const end = source.indexOf("static fromDurableSnapshot", start);
  if (start < 0) throw new Error(`${path}: snapshot source changed`);
  const body = source.slice(start, end < 0 ? source.length : end);
  return new Set([...body.matchAll(new RegExp(`^ {${indentation}}([a-zA-Z][a-zA-Z0-9]*):`, "gm"))]
    .map((match) => match[1]).filter((field) => field !== "v"));
}
compare("metadata snapshot fields",
  snapshotFields("packages/adapter-metadata-memory/src/revision-metadata-snapshot-store.ts", 8),
  new Set(Object.keys(backupPolicy.metadataSnapshot)));
const backupFormatSource = read("packages/composition-root/src/system-backup-format.ts");
const exactFieldsBlock = backupFormatSource.match(/SYSTEM_BACKUP_EXACT_FIELDS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\s+as const\)/u);
if (exactFieldsBlock === null) {
  failures.push("system backup exact field declaration changed");
} else {
  compare("system backup runtime exact fields",
    new Set([...exactFieldsBlock[1].matchAll(/"([a-zA-Z][a-zA-Z0-9]*)"/gu)]
      .map((match) => match[1])),
    new Set(Object.entries(backupPolicy.metadataSnapshot)
      .filter(([, policy]) => policy === "exact")
      .map(([field]) => field)));
}
for (const [table, [policy]] of Object.entries(backupPolicy.d1)) {
  if (policy === "exact") failures.push(`D1 ${table}: exact table needs a backup feed`);
}
compare("token snapshot fields",
  snapshotFields("packages/adapter-metadata-memory/src/mcp-token-store.ts", 6),
  new Set(Object.keys(backupPolicy.tokenSnapshot)));

const metadataSource = read("packages/adapter-metadata-sites/src/index.ts");
const eventStart = metadataSource.indexOf("type DurableEvent =");
const eventEnd = metadataSource.indexOf("interface DurableEventRow", eventStart);
if (eventStart < 0 || eventEnd < 0) throw new Error("Durable event envelope source changed");
compare("metadata event fields",
  new Set([...metadataSource.slice(eventStart, eventEnd).matchAll(/readonly\s+([a-zA-Z][a-zA-Z0-9]*)\s*:/gu)]
    .map((match) => match[1])),
  new Set(Object.keys(backupPolicy.metadataEvent)));

const objectSource = read("packages/adapter-object-sites/src/index.ts");
const actualPrefixes = new Map([...objectSource.matchAll(/const\s+([A-Z_]+_PREFIX)\s*=\s*"([^"]+)"/gu)]
  .map((match) => [match[1], match[2]]));
compare("R2 prefixes", new Set(actualPrefixes.keys()), new Set(Object.keys(backupPolicy.r2Prefixes)));
for (const [name, [, prefix]] of Object.entries(backupPolicy.r2Prefixes)) {
  if (actualPrefixes.get(name) !== prefix) failures.push(`R2 ${name}: prefix changed`);
}

const policies = new Set(["exact", "rebuild", "reset", "revoke", "excluded"]);
for (const [table, [policy]] of Object.entries(backupPolicy.d1)) {
  if (!policies.has(policy)) failures.push(`D1 ${table}: invalid policy ${policy}`);
}
for (const [group, fields] of Object.entries({
  metadataSnapshot: backupPolicy.metadataSnapshot,
  tokenSnapshot: backupPolicy.tokenSnapshot,
  metadataEvent: backupPolicy.metadataEvent,
})) {
  for (const [field, policy] of Object.entries(fields)) {
    if (!policies.has(policy)) failures.push(`${group}.${field}: invalid policy ${policy}`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`backup completeness: ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`backup completeness: ${actualTables.size} D1 tables, ${Object.keys(backupPolicy.metadataSnapshot).length} metadata fields, ${Object.keys(backupPolicy.tokenSnapshot).length} token fields, ${actualPrefixes.size} R2 prefixes classified`);
}
