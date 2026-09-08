#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const version = execFileSync("rg", ["--version"], { encoding: "utf8" }).split("\n", 1)[0];
if (version !== "ripgrep 15.2.0") {
  throw new Error(`file-operation oracle requires ripgrep 15.2.0, received ${version}`);
}

execFileSync(
  process.execPath,
  [
    "--test",
    "--test-name-pattern=file operations compose",
    "tests/integration/mind-browse.test.mjs",
  ],
  { cwd: new URL("..", import.meta.url), stdio: "inherit" },
);
