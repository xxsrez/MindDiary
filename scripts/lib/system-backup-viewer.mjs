import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BackupClientError, backupObjectPath } from "./system-backup-client.mjs";
import { inspectRestoredTarget } from "./system-backup-restore.mjs";

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(value));
}

function authorized(request, key) {
  const token = request.headers.authorization;
  if (typeof token !== "string" || !token.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(token.slice(7), "utf8");
  const expected = Buffer.from(key, "utf8");
  return candidate.byteLength === expected.byteLength &&
    timingSafeEqual(candidate, expected);
}

function route(path) {
  const pieces = path.split("/").filter(Boolean);
  try { return pieces.map((piece) => decodeURIComponent(piece)); }
  catch { return []; }
}

export async function startRestoredViewer({ target, port = 0 }) {
  const state = await inspectRestoredTarget(target);
  const keyFile = join(target, "operator-key");
  const keyStat = await stat(keyFile);
  if (!keyStat.isFile() || (keyStat.mode & 0o077) !== 0) {
    throw new BackupClientError("restore_operator_key_insecure");
  }
  const key = await readFile(keyFile, "utf8");
  if (!/^mdr_v1_[A-Za-z0-9_-]{43}$/u.test(key)) {
    throw new BackupClientError("restore_operator_key_invalid");
  }
  const db = new DatabaseSync(join(target, "restored.sqlite"),
    { readOnly: true });
  const server = createServer((request, response) => {
    void (async () => {
      if (!request.socket.localAddress ||
        !["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.localAddress) ||
        !["127.0.0.1", "localhost"].includes(request.headers.host?.split(":")[0])) {
        json(response, 403, { error: "loopback_only" });
        return;
      }
      if (!authorized(request, key)) {
        response.writeHead(401, { "www-authenticate": "Bearer",
          "cache-control": "no-store" });
        response.end();
        return;
      }
      if (request.method !== "GET") {
        json(response, 405, { error: "read_only" });
        return;
      }
      const url = new URL(request.url, "http://localhost");
      const pieces = route(url.pathname);
      if (pieces.length === 1 && pieces[0] === "health") {
        json(response, 200, { ok: true, sequence: state.checkpoint.sequence,
          minds: state.mind_count, revisions: state.revision_count });
        return;
      }
      if (pieces.length === 1 && pieces[0] === "minds") {
        const rows = db.prepare(`SELECT space_id, name, handle, visibility,
          head_revision_id, personal_owner_id FROM restore_minds
          ORDER BY handle`).all();
        json(response, 200, { minds: rows });
        return;
      }
      if (pieces.length === 3 && pieces[0] === "minds" &&
        pieces[2] === "revisions") {
        const mind = db.prepare("SELECT 1 FROM restore_minds WHERE space_id=?")
          .get(pieces[1]);
        if (!mind) { json(response, 404, { error: "not_found" }); return; }
        const revisions = db.prepare(`SELECT revision_id, revision_number,
          parent_revision_id, committed_at, manifest_sha256, summary
          FROM restore_revisions WHERE space_id=? ORDER BY revision_number`)
          .all(pieces[1]);
        json(response, 200, { revisions });
        return;
      }
      if (pieces.length === 5 && pieces[0] === "minds" &&
        pieces[2] === "revisions" && pieces[4] === "files") {
        const revision = db.prepare(`SELECT 1 FROM restore_revisions
          WHERE revision_id=? AND space_id=?`).get(pieces[3], pieces[1]);
        if (!revision) { json(response, 404, { error: "not_found" }); return; }
        const files = db.prepare(`SELECT file_index, path, kind, sha256,
          byte_size, media_type FROM restore_files WHERE revision_id=?
          ORDER BY file_index`).all(pieces[3]);
        json(response, 200, { files });
        return;
      }
      if (pieces.length === 6 && pieces[0] === "minds" &&
        pieces[2] === "revisions" && pieces[4] === "files" &&
        /^(?:0|[1-9][0-9]*)$/u.test(pieces[5])) {
        const file = db.prepare(`SELECT f.* FROM restore_files f
          JOIN restore_revisions r ON r.revision_id=f.revision_id
          WHERE r.space_id=? AND f.revision_id=? AND f.file_index=?`)
          .get(pieces[1], pieces[3], Number(pieces[5]));
        if (!file) { json(response, 404, { error: "not_found" }); return; }
        response.writeHead(200, { "content-type": file.media_type,
          "content-length": file.byte_size, "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-disposition": "attachment" });
        createReadStream(backupObjectPath(target, file.sha256))
          .on("error", () => response.destroy()).pipe(response);
        return;
      }
      if (pieces.length === 1 && pieces[0] === "search") {
        const query = url.searchParams.get("q") ?? "";
        if (query.length < 1 || query.length > 256) {
          json(response, 400, { error: "invalid_query" }); return;
        }
        const simple = /^[\p{L}\p{N}]{1,128}$/u.test(query);
        const matches = simple
          ? db.prepare(`SELECT s.space_id, s.revision_id, s.file_index,
              f.path FROM restore_terms t JOIN restore_search s
              ON s.revision_id=t.revision_id AND s.file_index=t.file_index
              JOIN restore_files f ON f.revision_id=s.revision_id AND
              f.file_index=s.file_index WHERE t.token=? LIMIT 100`)
            .all(query.toLowerCase())
          : db.prepare(`SELECT s.space_id, s.revision_id, s.file_index,
              f.path FROM restore_search s JOIN restore_files f
              ON f.revision_id=s.revision_id AND f.file_index=s.file_index
              WHERE instr(lower(s.content), lower(?)) > 0 LIMIT 100`)
            .all(query);
        json(response, 200, { matches });
        return;
      }
      json(response, 404, { error: "not_found" });
    })().catch(() => json(response, 500, { error: "local_failure" }));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) { db.close(); throw error; }
  return { url: `http://127.0.0.1:${server.address().port}`,
    close: async () => { await new Promise((resolve) => server.close(resolve));
      db.close(); } };
}
