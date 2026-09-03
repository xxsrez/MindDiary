import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const TITLE_TO_ASSERTION = Object.freeze({
  "real DOM exposes four canonical routes for the 0-item fixture": "SC-NAV-01",
  "real DOM exposes four canonical routes for the 1-item fixture": "SC-OAUTH-01",
  "real DOM exposes four canonical routes for the 21-item fixture": "SC-OAUTH-01",
  "mobile viewport keeps every route bounded and opens primary navigation by keyboard": "SC-NAV-01",
  "ordinary Connections and Help never load personal-token history or diagnostics": "SC-PRIVACY-01",
  "Codex guide switches Desktop and CLI paths by keyboard and copies exact current inputs": "SC-NAV-01",
  "keyboard-only connection journey exposes progress, revoke, and reconnect states": "SC-OAUTH-02",
  "Advanced MCP shows credential scope without a token target and keeps revoke history": "SC-TOKEN-01",
  "Advanced MCP dialog receives and restores focus without exposing raw identifiers": "SC-TOKEN-02",
  "deterministic error fixtures keep actions unavailable on both credential surfaces": "SC-FAIL-CLOSED-01",
});

export default class SettingsConnectionsBrowserReporter {
  constructor(options = {}) {
    this.outputFile = resolve(
      options.outputFile ?? process.env.MIND_DIARY_MD358_REPORT ??
        "build/md358-playwright-assertions.json",
    );
    this.tests = [];
  }

  onTestEnd(test, result) {
    const assertionId = TITLE_TO_ASSERTION[test.title] ?? null;
    this.tests.push(Object.freeze({
      assertion_id: assertionId,
      title: test.title,
      status: result.status,
    }));
    if (result.status !== "passed") {
      process.stderr.write(
        `MD-358 browser failure: assertion=${assertionId ?? "unregistered"} title=${test.title}\n`,
      );
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
