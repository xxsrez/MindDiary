import { createHash } from "node:crypto";
import { access, cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

interface DevBindings {
  readonly d1: string;
  readonly r2: string;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Emits the exact machine-readable readiness event required by the release profile. */
export function devReady(bindings: DevBindings): Plugin {
  let emitted = false;
  return {
    name: "mind-diary-dev-ready",
    apply: "serve",
    configureServer(server) {
      const emit = () => {
        if (emitted) return;
        const address = server.httpServer?.address();
        if (!address || typeof address === "string") return;
        const configuredHost = server.config.server.host;
        const host = typeof configuredHost === "string"
          && configuredHost !== "0.0.0.0"
          && configuredHost !== "::"
          ? configuredHost
          : "localhost";
        const configurationFingerprint = createHash("sha256")
          .update(JSON.stringify({ runtime: "mind-diary-product-site", mode: server.config.mode, bindings }))
          .digest("hex");
        process.stdout.write(`${JSON.stringify({
          schema: "ship-work-release/dev-ready/v1",
          ready: true,
          url: `http://${host}:${address.port}/`,
          configuration_fingerprint: `sha256:${configurationFingerprint}`,
        })}\n`);
        emitted = true;
      };
      if (server.httpServer?.listening) queueMicrotask(emit);
      else server.httpServer?.once("listening", emit);
    },
  };
}

/** Packages only public hosting metadata and D1 migrations. */
export function sites(): Plugin {
  let root = process.cwd();
  return {
    name: "mind-diary-sites-package",
    apply: "build",
    configResolved(config) { root = config.root; },
    async closeBundle() {
      const output = resolve(root, "dist", ".openai");
      await rm(output, { recursive: true, force: true });
      await mkdir(output, { recursive: true });
      const hosting = resolve(root, ".openai", "hosting.json");
      const drizzle = resolve(root, "drizzle");
      if (await exists(hosting)) await cp(hosting, resolve(output, "hosting.json"));
      if (await exists(drizzle)) await cp(drizzle, resolve(output, "drizzle"), { recursive: true });
    },
  };
}
