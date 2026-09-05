// Separate capability probe. Never imported by the ordinary Product Worker.
// This entrypoint does not claim product, identity, or acceptance coverage.
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (body, status = 200) => Response.json(body, { status, headers });

async function authorized(request, env) {
  const expected = env.MD_ACCEPTANCE_CONTROLLER_KEY;
  const actual = request.headers.get("x-md-acceptance-controller");
  if (typeof expected !== "string" || expected.length < 43 || !actual || actual.length > 256) return false;
  const hash = async (value) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([hash(actual), hash(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("<!doctype html><html lang=ru><meta charset=utf-8><title>Mind Diary — проверка среды</title><h1>Тестовая среда Mind Diary</h1><p>Проверка платформы. Приёмка продукта ещё не выполнена.</p></html>", {
        headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; frame-ancestors 'none'" },
      });
    }
    if (url.pathname !== "/api/probe" || request.method !== "POST") return json({ error: "not_found" }, 404);
    if (!(await authorized(request, env))) return json({ error: "unauthorized" }, 401);
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return json({ error: "origin_denied" }, 403);
    let value;
    try {
      const body = await request.text();
      if (body.length > 256) return json({ error: "invalid_request" }, 400);
      value = JSON.parse(body);
    } catch { return json({ error: "invalid_request" }, 400); }
    if (!value || Array.isArray(value) || !["reserve", "setup", "verify", "cleanup"].includes(value.phase)
      || Object.keys(value).some((key) => !["phase", "id"].includes(key))) return json({ error: "invalid_request" }, 400);
    if (value.phase === "reserve") {
      if (value.id !== undefined) return json({ error: "invalid_request" }, 400);
      // Controller persists this ID before any durable mutation, for recovery.
      return json({ id: `probe-${crypto.randomUUID()}`, status: "reserved" });
    }
    if (!/^probe-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id ?? "")) return json({ error: "invalid_request" }, 400);
    if (!env.DB || !env.MIND_DIARY_BUCKET) return json({ error: "bindings_unavailable" }, 503);
    try {
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS md_acceptance_probe (id TEXT PRIMARY KEY, marker TEXT NOT NULL)").run();
      const id = value.id;
      const key = `capability-probe/${id}`;
      if (value.phase === "setup") {
        await env.DB.prepare("INSERT OR IGNORE INTO md_acceptance_probe (id, marker) VALUES (?, ?)").bind(id, crypto.randomUUID()).run();
        const { marker } = await env.DB.prepare("SELECT marker FROM md_acceptance_probe WHERE id = ?").bind(id).first();
        await env.MIND_DIARY_BUCKET.put(key, marker);
        return json({ id, status: "prepared" });
      }
      if (value.phase === "cleanup") {
        await env.MIND_DIARY_BUCKET.delete(key);
        await env.DB.prepare("DELETE FROM md_acceptance_probe WHERE id = ?").bind(id).run();
      }
      const row = await env.DB.prepare("SELECT marker FROM md_acceptance_probe WHERE id = ?").bind(id).first();
      const object = await env.MIND_DIARY_BUCKET.get(key);
      if (value.phase === "cleanup") return json({ status: !row && !object ? "cleaned" : "failed" });
      return json({ status: row && object && row.marker === await object.text() ? "verified" : "failed" });
    } catch { return json({ error: "probe_failed" }, 503); }
  },
};
