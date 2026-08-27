import { resolve } from "node:path";

import { defineConfig } from "@playwright/test";

const diagnostics = resolve(
  process.env.MIND_DIARY_MD363_DIAGNOSTICS ?? "test-results/md363-import-export",
);
const report = resolve(
  process.env.MIND_DIARY_MD363_REPORT ?? "build/md363-playwright-assertions.json",
);
const executablePath = process.env.MIND_DIARY_MD363_CHROMIUM_EXECUTABLE;
if (typeof executablePath !== "string" || executablePath.length === 0) {
  throw new Error("MD-363 requires the gate-verified Chromium executable");
}
if (typeof process.env.MIND_DIARY_MD363_FIXTURE_ROOT !== "string") {
  throw new Error("MD-363 requires generated fixture bytes");
}

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "import-export-uat/import-export.spec.mjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  outputDir: diagnostics,
  reporter: [
    ["line"],
    [resolve("scripts/lib/import-export-browser-reporter.mjs"), { outputFile: report }],
  ],
  use: {
    browserName: "chromium",
    headless: true,
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    colorScheme: "light",
    serviceWorkers: "block",
    launchOptions: { executablePath },
    screenshot: "only-on-failure",
    trace: "off",
    video: "off",
  },
});
