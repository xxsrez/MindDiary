import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function failedAcceptanceStep(steps) {
  for (const step of steps ?? []) {
    const nested = failedAcceptanceStep(step.steps);
    if (nested !== null) return nested;
    if (step.error !== undefined && step.title.startsWith("route=")) return step.title;
  }
  return null;
}

export default class MindAdminBrowserReporter {
  constructor(options = {}) {
    this.outputFile = resolve(
      options.outputFile ?? process.env.MIND_DIARY_MD351_REPORT ??
        "build/md351-playwright-assertions.json",
    );
    this.tests = [];
  }

  onTestEnd(test, result) {
    const assertions = test.annotations
      .filter((annotation) => annotation.type === "mind-diary-assertion")
      .map((annotation) => annotation.description ?? null);
    for (const assertionId of assertions) {
      this.tests.push(Object.freeze({
        assertion_id: assertionId,
        title: test.title,
        status: result.status,
      }));
    }
    if (result.status !== "passed") {
      const coordinates = failedAcceptanceStep(result.steps) ??
        `route=fixture-setup actor=not-started assertion=${assertions[0] ?? "unregistered"}`;
      process.stderr.write(`MD-351 browser failure: ${coordinates}\n`);
    }
  }

  onEnd(result) {
    mkdirSync(dirname(this.outputFile), { recursive: true });
    writeFileSync(this.outputFile, `${JSON.stringify({
      status: result.status,
      tests: this.tests,
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}
