import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siteRoot = resolve(repositoryRoot, "apps/mind-diary-site");
const readinessTimeoutMs = 120_000;

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}

export function extractDevUrl(value) {
  const match = /(?:^|\s)Local:\s+(https?:\/\/[^\s]+)/u.exec(stripAnsi(value));
  if (!match) return null;
  const url = new URL(match[1]);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("dev launcher returned a non-loopback URL");
  }
  return url.href;
}

export function configurationFingerprint(hostingSource, environmentExampleSource) {
  const hosting = JSON.parse(hostingSource);
  const environmentKeys = environmentExampleSource
    .split(/\r?\n/gu)
    .map((line) => /^([A-Z][A-Z0-9_]*)=/u.exec(line)?.[1] ?? null)
    .filter((key) => key !== null)
    .sort();
  const publicConfiguration = JSON.stringify({
    hosting: {
      project_id: hosting.project_id ?? null,
      d1: hosting.d1 ?? null,
      r2: hosting.r2 ?? null,
    },
    environment_keys: environmentKeys,
    source: "apps/mind-diary-site",
  });
  return `sha256:${createHash("sha256").update(publicConfiguration).digest("hex")}`;
}

async function waitUntilReachable(url, deadline) {
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
      if (response.status >= 200 && response.status < 500) return;
      lastError = new Error(`local server returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error("local server did not become reachable", { cause: lastError });
}

function terminateProcessGroup(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export async function runDev() {
  const [hostingSource, environmentExampleSource] = await Promise.all([
    readFile(resolve(siteRoot, ".openai/hosting.json"), "utf8"),
    readFile(resolve(siteRoot, ".env.example"), "utf8"),
  ]);
  const fingerprint = configurationFingerprint(hostingSource, environmentExampleSource);
  const child = spawn("npm", ["run", "dev"], {
    cwd: siteRoot,
    detached: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let observed = "";
  let readinessStarted = false;
  let ready = false;
  let stopping = false;
  let failed = false;

  const stop = (signal, failure = false) => {
    failed ||= failure;
    if (stopping) return;
    stopping = true;
    terminateProcessGroup(child, signal);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  const deadline = Date.now() + readinessTimeoutMs;
  const observe = (chunk, destination) => {
    destination.write(chunk);
    observed = `${observed}${chunk.toString("utf8")}`.slice(-16_384);
    if (readinessStarted) return;
    let url;
    try {
      url = extractDevUrl(observed);
    } catch (error) {
      readinessStarted = true;
      process.stderr.write(`Mind Diary dev launch failed: ${error.message}\n`);
      stop("SIGTERM", true);
      return;
    }
    if (!url) return;
    readinessStarted = true;
    void waitUntilReachable(url, deadline).then(() => {
      if (stopping) return;
      ready = true;
      process.stdout.write(`${JSON.stringify({
        schema: "ship-work-release/dev-ready/v1",
        ready: true,
        url,
        configuration_fingerprint: fingerprint,
      })}\n`);
    }).catch((error) => {
      process.stderr.write(`Mind Diary dev launch failed: ${error.message}\n`);
      stop("SIGTERM", true);
    });
  };

  child.stdout.on("data", (chunk) => observe(chunk, process.stdout));
  child.stderr.on("data", (chunk) => observe(chunk, process.stderr));
  const timeout = setTimeout(() => {
    if (ready || stopping) return;
    process.stderr.write("Mind Diary dev launch failed: readiness timed out\n");
    stop("SIGTERM", true);
  }, readinessTimeoutMs);
  timeout.unref();

  return await new Promise((resolvePromise) => {
    child.once("error", (error) => {
      clearTimeout(timeout);
      process.stderr.write(`Mind Diary dev launch failed: ${error.message}\n`);
      resolvePromise(1);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (!ready && !stopping) {
        process.stderr.write(`Mind Diary dev launch exited before readiness (${signal ?? code ?? "unknown"})\n`);
      }
      resolvePromise(failed ? 1 : stopping ? 0 : (code ?? 1));
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runDev();
}
