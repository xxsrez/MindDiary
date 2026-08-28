import { resolve } from "node:path";

import { defineConfig } from "@playwright/test";

const executablePath = process.env.MIND_DIARY_MD358_CHROMIUM_EXECUTABLE;
if (typeof executablePath !== "string" || executablePath.length === 0) {
  throw new Error("MD-358 requires the gate-verified Chromium executable");
}

const report = resolve(
  process.env.MIND_DIARY_MD358_REPORT ?? "build/md358-playwright-assertions.json",
);

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "connections/connections.spec.mjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  outputDir: resolve(process.env.MIND_DIARY_MD358_DIAGNOSTICS ?? "test-results/md358-connections"),
  reporter: [
    ["line"],
    [resolve("scripts/lib/settings-connections-browser-reporter.mjs"), { outputFile: report }],
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
    video: "off"
  }
});
