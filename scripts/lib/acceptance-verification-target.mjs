import assert from "node:assert/strict";

export function assertAcceptanceVerificationTarget(project, origin, args) {
  assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--synthetic-ci"), "unknown verification option");
  if (args.length) {
    assert.equal(project, "appgprj_example8ca2ca9e5243cfd6", "synthetic check requires the example project");
    assert.equal(origin, "https://mind-diary-acceptance.example.invalid", "synthetic check requires the example origin");
    return;
  }
  assert.ok(!project.includes("example") && !origin.includes(".example.invalid"), "release requires a configured private acceptance target");
}
