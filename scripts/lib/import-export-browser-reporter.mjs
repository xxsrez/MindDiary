import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function failedAcceptanceStep(steps) {
  for (const step of steps ?? []) {
    const nested = failedAcceptanceStep(step.steps);
    if (nested !== null) return nested;
    if (step.error !== undefined && step.title.startsWith("matrix=")) return step.title;
  }
  return null;
}

export default class ImportExportBrowserReporter {
  constructor(options = {}) {
    this.outputFile = resolve(
      options.outputFile ?? process.env.MIND_DIARY_MD363_REPORT ??
        "build/md363-playwright-assertions.json",
    );
    this.tests = [];
  }

  onTestEnd(test, result) {
    const assertion = test.annotations.find(
      (annotation) => annotation.type === "mind-diary-assertion",
    );
    this.tests.push(Object.freeze({
      assertion_id: assertion?.description ?? null,
      title: test.title,
      status: result.status,
    }));
    if (result.status !== "passed") {
      const coordinates = failedAcceptanceStep(result.steps) ??
        `matrix=fixture-setup assertion=${assertion?.description ?? "unregistered"}`;
      process.stderr.write(`MD-363 browser failure: ${coordinates}\n`);
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
