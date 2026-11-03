import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("./select-manual-checks.mjs", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
const select = (...args) => {
  const r = run(...args, "--json");
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(r.stdout);
  assert.equal(p.execution, "not-run");
  assert.equal(new Set(p.cases.map(c => c.id)).size, p.count);
  return p.cases.map(c => c.id);
};
test("import resume stays narrow and includes baseline once", () => {
  assert.deepEqual(select("--topics", "import_resume").sort(),
    ["IMPORT-03", "IMPORT-04", "IMPORT-08", "OPS-01", "UAT-01", "UAT-02", "UAT-03"].sort());
});
test("layout does not select credentials or files", () => {
  assert.deepEqual(select("--topics", "ui_layout").sort(),
    ["OPS-01", "UAT-01", "UAT-02", "UAT-03", "UAT-05"].sort());
});
test("ChatGPT OAuth retains common checks but excludes Codex and file tests", () => {
  const ids = select("--topics", "oauth", "--clients", "chatgpt");
  for (const id of ["CONNECT-01", "CONNECT-02", "CHATGPT-01", "CHATGPT-03"]) assert(ids.includes(id));
  assert(!ids.some(id => /^(FILE|CODEX)-/.test(id)));
  assert(!ids.includes("CHATGPT-02"));
});
test("explicit incident and Russian search reach same incident", () => {
  assert(select("--ids", "REG-01").includes("REG-01"));
  assert(select("--search", "автобусы").includes("REG-01"));
});
test("full deep contains every card and code review", () => {
  const all = select("--mode", "deep");
  const v = JSON.parse(run("--validate").stdout);
  assert.equal(all.length, v.cases);
  assert(all.includes("REVIEW-01") && all.includes("OPS-04"));
});
test("bad topics IDs clients and no-match cannot yield reassuring baseline", () => {
  for (const args of [
    [], ["--topics", "typo"], ["--ids", "MISSING-99"],
    ["--clients", "typo", "--topics", "oauth"],
    ["--ids", "CODEX-01", "--clients", "chatgpt"],
    ["--search", "nothing-matches-unique-12345"], ["--mode", "typo"],
  ]) assert.notEqual(run(...args).status, 0, JSON.stringify(args));
});
test("selection works from another cwd", () => {
  const r = spawnSync(process.execPath, [script, "--topics", "import_resume", "--json"],
    { encoding: "utf8", cwd: "/" });
  assert.equal(r.status, 0, r.stderr);
  assert(JSON.parse(r.stdout).cases.some(c => c.id === "IMPORT-03"));
});
