import { resolve } from "node:path";

import { defineConfig } from "@playwright/test";

const diagnostics = resolve(
  process.env.MIND_DIARY_MD351_DIAGNOSTICS ?? "test-results/md351-mind-admin",
);
const report = resolve(
  process.env.MIND_DIARY_MD351_REPORT ?? "build/md351-playwright-assertions.json",
);
const executablePath = process.env.MIND_DIARY_MD351_CHROMIUM_EXECUTABLE;
if (typeof executablePath !== "string" || executablePath.length === 0) {
  throw new Error("MD-351 requires the gate-verified Chromium executable");
}

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "mind-admin-journey/mind-admin-journey.spec.mjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 8_000 },
  outputDir: diagnostics,
  reporter: [
    ["line"],
    [resolve("scripts/lib/mind-admin-browser-reporter.mjs"), { outputFile: report }],
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
