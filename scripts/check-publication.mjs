import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const rules = [
  ["claim UUID", /CLAIM_TOKEN\s*[:=]\s*["']?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i],
  ["personal home path", /\/Users\/[A-Za-z0-9_.-]+\//],
  ["personal email", /[A-Za-z0-9_.+-]+@(?:gmail\.com|icloud\.com|outlook\.com)\b/i],
  ["private Sites host", /(?:[A-Za-z0-9-]+\.)+chatgpt\.site\b/i],
  ["private deployment identifier", /\bappg(?:prj|dep|ver)_[0-9a-f]{24,}\b/i],
  ["private plugin identifier", /\basdk_app_[0-9a-f]{24,}\b/i],
  ["private conversation URL", /https:\/\/chatgpt\.com\/c\/[0-9a-f-]{20,}/i],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", /\bgh[opusr]_[A-Za-z0-9]{30,}\b/],
  ["API token", /\bsk-[A-Za-z0-9_-]{24,}\b/],
];
export function findings(bytes, kind = "blob") {
  const text = bytes.toString("utf8");
  const result = rules.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
  for (const match of text.matchAll(/\b[A-Za-z0-9_.+-]+@([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,})\b/g)) {
    if (!/(?:^|\.)(?:invalid|example|test|local)$|^example\.(?:com|org|net)$|^users\.noreply\.github\.com$/i.test(match[1])) {
      result.push("non-public contact email");
    }
  }
  if (kind === "commit" || kind === "tag") {
    const headers = text.split("\n\n", 1)[0];
    for (const match of headers.matchAll(/^(?:author|committer|tagger) .*<([^<>]+)>/gm)) {
      if (!/^[^\s<>@]+@(?:[A-Za-z0-9.-]+\.(?:invalid|example)|example\.(?:com|org|net)|users\.noreply\.github\.com)$/.test(match[1])) {
        result.push("non-public author email");
      }
    }
  }
  return [...new Set(result)];
}
const git = (args) => execFileSync("git", args, { maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
export async function scanObjects(ids, inspect) {
  const child = spawn("git", ["cat-file", "--batch"], { stdio: ["pipe", "pipe", "pipe"] });
  let pending = Buffer.alloc(0), header, seen = 0;
  child.stderr.resume();
  const finished = new Promise((accept, reject) => {
    child.on("error", reject);
    child.stdout.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      try {
        while (true) {
          if (!header) {
            const end = pending.indexOf(10);
            if (end < 0) break;
            header = pending.subarray(0, end).toString().split(" ");
            pending = pending.subarray(end + 1);
            if (header.length !== 3 || !/^\d+$/.test(header[2])) throw new Error("Git object unavailable");
          }
          const size = Number(header[2]);
          if (pending.length < size + 1) break;
          inspect(header[0], header[1], pending.subarray(0, size));
          seen++;
          pending = pending.subarray(size + 1);
          header = undefined;
        }
      } catch (error) { child.kill(); reject(error); }
    });
    child.on("close", (code) => code === 0 && seen === ids.length && !header && pending.length === 0
      ? accept(seen) : reject(new Error("Incomplete Git object scan")));
  });
  child.stdin.on("error", () => {});
  child.stdin.end(ids.join("\n") + (ids.length ? "\n" : ""));
  return finished;
}
export async function main(args) {
  const failures = [];
  let count = 0;
  const inspect = (id, kind, bytes) => {
    if (!["blob", "tree", "commit", "tag", "ref", "path"].includes(kind)) return;
    for (const label of findings(bytes, kind)) failures.push(`${kind} ${id.slice(0, 12)}: ${label}`);
  };
  if (args[0] === "--history" || args[0] === "--pre-push") {
    if (git(["rev-parse", "--is-shallow-repository"]).toString().trim() === "true") throw new Error("Full history is required");
    let revisions = ["--all"];
    if (args[0] === "--pre-push") {
      const updates = readFileSync(0, "utf8").trim().split("\n").filter(Boolean).map((line) => line.split(/\s+/));
      for (const [localRef, , remoteRef] of updates) inspect("push-ref", "ref", Buffer.from(localRef + "\n" + remoteRef));
      revisions = updates.map((fields) => fields[1]).filter((oid) => !/^0+$/.test(oid));
      if (revisions.some((oid) => !/^[0-9a-f]{40,64}$/.test(oid))) throw new Error("Invalid push input");
      if (!revisions.length) {
        if (failures.length) throw new Error("Unsafe push ref");
        console.log("Publication scan: no objects to push."); return;
      }
    }
    if (args[0] === "--history") inspect("all-refs", "ref", git(["for-each-ref", "--format=%(refname)"]));
    const lines = git(["rev-list", "--objects", "--no-object-names", ...revisions]).toString().trim();
    const ids = [...new Set(lines ? lines.split("\n") : [])];
    count = await scanObjects(ids, inspect);
  } else if (args[0] === "--staged") {
    const entries = git(["ls-files", "--stage", "-z"]).toString().split("\0").filter(Boolean);
    const ids = [];
    for (const entry of entries) {
      const [meta, path] = entry.split("\t");
      inspect("index-path", "path", Buffer.from(path));
      const [mode, oid, stage] = meta.split(" ");
      if (stage !== "0") throw new Error("Resolve index conflicts before publication scan");
      if (/(^|\/)\.env(?:\..*)?$/.test(path) && !path.endsWith(".env.example")) failures.push("index: private environment file");
      if (mode !== "160000") ids.push(oid);
    }
    count = await scanObjects([...new Set(ids)], inspect);
  } else if (args[0] === "--commit-message" && args[1]) {
    inspect("message", "blob", readFileSync(args[1]));
    for (const role of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
      const value = git(["var", role]).toString();
      inspect("identity", "commit", Buffer.from("author " + value));
    }
    count = 3;
  } else {
    throw new Error("Use --history, --staged, --pre-push, or --commit-message FILE");
  }
  if (failures.length) {
    console.error(`Publication scan blocked: ${failures.length} findings. Values are withheld.\n` + failures.slice(0, 40).join("\n"));
    process.exitCode = 1;
  } else console.log(`Publication scan passed (${count} Git objects inspected).`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { console.error("Publication scan failed; no content was printed."); process.exitCode = 1; });
}
