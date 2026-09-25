import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeMd485ObjectReachability,
  createMd485ObjectReachability,
  MD485_OBJECT_REACHABILITY_PATH,
} from "../../packages/composition-root/dist/md485-object-reachability.js";

const mind = "space_synthetic_md485";
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);
const created = "2026-09-20T15:02:59.165Z";
const expires = "2026-09-20T15:17:59.165Z";

function fixture() {
  const calls = { list: 0, get: 0, put: 0, delete: 0, metadata: 0 };
  const root = `spaces/${mind}/`;
  const rows = new Map([
    [`${root}objects/sha256/${hashA}`, { size: 20, customMetadata: {
      spaceId: mind, kind: "markdown", sha256: `sha256:${hashA}`, createdAt: created,
    } }],
    [`${root}objects/sha256/${hashB}`, { size: 30, customMetadata: {
      spaceId: mind, kind: "markdown", sha256: `sha256:${hashB}`,
      createdAt: "2026-09-19T00:00:00.000Z",
    } }],
    [`${root}manifests/sha256/${hashC}`, { size: 10, customMetadata: {
      spaceId: mind, kind: "revision_manifest", sha256: `sha256:${hashC}`,
      createdAt: "2026-09-20T15:03:00.000Z",
    } }],
    [`${root}integrity/sidecar`, { size: 4, customMetadata: {} }],
  ]);
  const bucket = {
    async list({ prefix }) {
      calls.list++;
      return { objects: [...rows].filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, ...value })), truncated: false };
    },
    async get() { calls.get++; throw new Error("content read forbidden"); },
    async put() { calls.put++; throw new Error("write forbidden"); },
    async delete() { calls.delete++; throw new Error("delete forbidden"); },
  };
  const handler = createMd485ObjectReachability({
    bucket,
    authorizedMindId: async (request) => request.headers.get("x-test-owner") === "yes" ? mind : null,
    readSequence: async () => 10,
    readMetadata: async () => {
      calls.metadata++;
      return { reservations: [{
        reservationId: "<script>alert(1)</script>", spaceId: mind,
        operation: "commit", state: "cleanup_pending", createdAt: created,
        expiresAt: expires, writerClosedAt: null,
        requested: { physicalCanonicalBytes: 6_961_159,
          temporaryBytes: 0, d1MetadataBytes: 27_968 }, actual: null,
      }], reachable: [{ spaceId: mind, kind: "markdown", sha256: `sha256:${hashB}` }] };
    },
  });
  return { handler, calls, rows };
}

test("MD-485 authorization requires Sites operator identity and current ordinary Owner role", async () => {
  const request = new Request("https://mind-diary.example.invalid/");
  const actor = { principalId: "owner", authentication: { kind: "sites_identity" } };
  let access = { isPersonal: false, mindId: mind,
    access: { kind: "membership", role: "owner" } };
  let identity = { kind: "authenticated", actor };
  const authorize = authorizeMd485ObjectReachability({
    resolveIdentity: async () => identity,
    operatorPrincipalIds: new Set(["owner"]),
    resolveTargetMind: async () => access,
  });
  assert.equal(await authorize(request), mind);
  access = { ...access, access: { kind: "membership", role: "admin" } };
  assert.equal(await authorize(request), null);
  access = { ...access, isPersonal: true,
    access: { kind: "membership", role: "owner" } };
  assert.equal(await authorize(request), null);
  access = { ...access, isPersonal: false };
  identity = { ...identity, actor: { ...actor, principalId: "other" } };
  assert.equal(await authorize(request), null);
  identity = { ...identity, actor: { ...actor,
    authentication: { kind: "personal_token" } } };
  assert.equal(await authorize(request), null);
});

test("MD-485 projection requires owner and returns bounded object metadata without content access", async () => {
  const f = fixture();
  const url = `https://mind-diary.example.invalid${MD485_OBJECT_REACHABILITY_PATH}`;
  assert.equal((await f.handler(new Request(url))).status, 404);
  assert.equal(f.calls.metadata, 0);
  assert.equal((await f.handler(new Request(`${url}?space=other`, {
    headers: { "x-test-owner": "yes" },
  }))).status, 404);
  const response = await f.handler(new Request(url, { headers: { "x-test-owner": "yes" } }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.objects, {
    canonical_count: 3, canonical_bytes: 60,
    reachable_count: 1, reachable_bytes: 30,
    unreachable_count: 2, unreachable_bytes: 30,
    window_count: 2, window_bytes: 30,
    window_unreachable_count: 2, window_unreachable_bytes: 30,
    invalid_metadata_count: 0,
    integrity_sidecar_count: 1, integrity_sidecar_bytes: 4,
  });
  assert.equal(body.data.reservation.actual, null);
  assert.equal(JSON.stringify(body).includes(hashA), false);
  const htmlResponse = await f.handler(new Request(url, {
    headers: { "x-test-owner": "yes", accept: "text/html" },
  }));
  assert.equal(htmlResponse.headers.get("content-type"), "text/html; charset=utf-8");
  const html = await htmlResponse.text();
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.equal(html.includes("<script>"), false);
  assert.deepEqual([f.calls.get, f.calls.put, f.calls.delete], [0, 0, 0]);
  f.rows.set(`spaces/${mind}/objects/sha256/${"d".repeat(64)}`,
    { size: 1, customMetadata: { spaceId: "other" } });
  const corrupted = await f.handler(new Request(url, { headers: { "x-test-owner": "yes" } }));
  assert.equal(corrupted.status, 200);
  assert.equal((await corrupted.json()).data.objects.invalid_metadata_count, 1);
});

test("MD-485 projection fails closed when ownership or metadata sequence changes during listing", async () => {
  const url = `https://mind-diary.example.invalid${MD485_OBJECT_REACHABILITY_PATH}`;
  const request = new Request(url);
  let owner = true;
  let sequence = 10;
  const base = {
    bucket: { async list() {
      owner = false;
      return { objects: [], truncated: false };
    } },
    readSequence: async () => sequence,
    readMetadata: async () => ({
      reservations: [{ reservationId: "synthetic", spaceId: mind,
        operation: "commit", state: "cleanup_pending", createdAt: created,
        expiresAt: expires, requested: { physicalCanonicalBytes: 6_961_159,
          temporaryBytes: 0, d1MetadataBytes: 27_968 }, actual: null }],
      reachable: [],
    }),
    authorizedMindId: async () => owner ? mind : null,
  };
  const revoked = await createMd485ObjectReachability(base)(request);
  assert.equal(revoked.status, 503);
  assert.deepEqual(await revoked.json(), { ok: false, error: "diagnostic_unavailable" });
  owner = true;
  const raced = await createMd485ObjectReachability({ ...base,
    bucket: { async list() { sequence = 11; return { objects: [], truncated: false }; } },
  })(request);
  assert.equal(raced.status, 503);
  assert.deepEqual(await raced.json(), { ok: false, error: "diagnostic_unavailable" });
});
