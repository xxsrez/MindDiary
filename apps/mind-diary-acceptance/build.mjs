import { mkdir, copyFile } from "node:fs/promises";
await mkdir(new URL("dist/server/", import.meta.url), { recursive: true });
await mkdir(new URL("dist/.openai/", import.meta.url), { recursive: true });
await copyFile(new URL("worker.mjs", import.meta.url), new URL("dist/server/index.js", import.meta.url));
await copyFile(new URL(".openai/hosting.json", import.meta.url), new URL("dist/.openai/hosting.json", import.meta.url));
