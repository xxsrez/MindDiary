import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeDiagnostics } from "../../apps/mind-diary-site/worker/runtime-diagnostics.js";
import { withForegroundDeadline } from "../../apps/mind-diary-site/worker/foreground-deadline.js";

test("cancellation from outside async context retains the original trace", async () => {
  const events = [];
  const diagnostics = new RuntimeDiagnostics({ write: (line) => events.push(JSON.parse(line)) });
  const controller = new AbortController();
  const request = new Request("https://example.com", { signal: controller.signal });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const result = diagnostics.runRequest(request, () => withForegroundDeadline(request, 1_000, () => {
    entered();
    return new Promise(() => {});
  }, diagnostics.expirationHandler()));
  await started;
  controller.abort();
  const response = await result;
  const cancellation = events.find((event) => event.phase === "canceled");
  assert.ok(cancellation);
  assert.equal(cancellation.trace_id, response.headers.get("x-mind-diary-wait-trace-id"));
});

test("diagnostic fields are closed, bounded, and never serialize caller content", async () => {
  const events = [];
  const diagnostics = new RuntimeDiagnostics({ write: (line) => events.push(JSON.parse(line)) });
  await diagnostics.runRequest(new Request("https://example.com/private-locator?secret=credential"), async () => {
    const observer = diagnostics.forRuntime("private-email@example.com");
    for (let index = 0; index < 100; index += 1) {
      await observer.observe("private SQL", "bearer-private-token", async () => 42);
    }
    return new Response("ok");
  });
  assert.equal(events.length, 97);
  assert.equal(events.filter((event) => event.phase === "suppressed").length, 1);
  assert.doesNotMatch(JSON.stringify(events), /credential|private|bearer|SQL|example\.com/);
  assert.ok(events.every((event) => event.runtime_generation === null));
});

test("diagnostic writer failure or recursion cannot change or duplicate work", async () => {
  let executions = 0;
  let diagnostics;
  diagnostics = new RuntimeDiagnostics({ write() {
    diagnostics.expire("request_timeout");
    throw new Error("sink failed");
  } });
  const result = await diagnostics.runRequest(new Request("https://example.com"), async () => {
    executions += 1;
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(executions, 1);
});

test("concurrent request traces remain distinct and recovery errors expose no private message", async () => {
  const events = [];
  const diagnostics = new RuntimeDiagnostics({ write: (line) => events.push(JSON.parse(line)) });
  await Promise.all([0, 1].map(() => diagnostics.runRequest(new Request("https://example.com"), async () => {
    await assert.rejects(diagnostics.observe("recovery", "request", async () => {
      await Promise.resolve();
      throw new Error("private provider message");
    }));
    return new Response("ok");
  })));
  const failures = events.filter((event) => event.stage === "recovery" && event.phase === "failed");
  assert.equal(failures.length, 2);
  assert.notEqual(failures[0].trace_id, failures[1].trace_id);
  assert.doesNotMatch(JSON.stringify(events), /private provider message/);
});
