import { resolve } from "node:path";

import { defineConfig } from "@playwright/test";

const diagnostics = resolve(
  process.env.MIND_DIARY_MD347_DIAGNOSTICS ?? "test-results/md347-admin-shell",
);
const report = resolve(
  process.env.MIND_DIARY_MD347_REPORT ?? "build/md347-playwright-assertions.json",
);

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "ui-shell/compact-admin-shell.spec.mjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  outputDir: diagnostics,
  reporter: [
    ["line"],
    [resolve("scripts/lib/admin-shell-browser-reporter.mjs"), { outputFile: report }],
  ],
  use: {
    browserName: "chromium",
    headless: true,
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    colorScheme: "light",
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    trace: "off",
    video: "off",
  },
});
