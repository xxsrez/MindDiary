import { createServer } from "node:http";

import { createProductSiteRuntime } from "../../packages/composition-root/dist/index.js";
import { FakeD1Database, FakeR2Bucket, deterministicKey } from "./fake-sites-storage.mjs";

/**
 * Logical origin used by the Product Site runtime. The HTTP listeners below
 * are deliberately ephemeral loopback listeners; requests are rewritten to
 * this origin before entering the real Product Site handler.
 */
export const SYNTHETIC_BROWSER_ORIGIN = "https://synthetic-browser-gate.invalid";
export const SYNTHETIC_BROWSER_BINDING_NAMESPACE = "synthetic-test";

const MAX_BODY_BYTES = 16 * 1024 * 1024;

function headerRecord(headers) {
  const result = {};
  for (const [name, value] of headers.entries()) {
    if (name === "host" || name === "content-length") continue;
    result[name] = value;
  }
  return result;
}

async function readIncomingBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new Error("browser fixture request body is too large");
    chunks.push(value);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

async function writeResponse(source, target) {
  target.statusCode = source.status;
  source.headers.forEach((value, name) => target.setHeader(name, value));
  target.end(Buffer.from(await source.arrayBuffer()));
}

function parseCsrf(html) {
  const match = /<meta name="mind-diary-csrf-token" content="([^"]+)">/u.exec(html);
  if (match === null) throw new Error("Product Site page did not expose a CSRF token");
  return match[1];
}

async function jsonBody(response) {
  if (response.body !== null) return Object.freeze(response);
  if (!response.text) return Object.freeze(response);
  return Object.freeze({ ...response, body: JSON.parse(response.text) });
}

/**
 * Test-only server-bound Product Site composition.
 *
 * A context gets its own loopback listener. That listener closes over one
 * trusted identity snapshot and injects it at the harness/runtime boundary;
 * the Product Site request itself contains no actor selector. Consequently a
 * query, body, cookie, or client header cannot switch a context to another
 * principal. All account/membership/ACL/index state still comes from normal
 * Product Site commands and shared durable adapters.
 */
export async function createSyntheticBrowserComposition({
  now = () => new Date(),
  origin = SYNTHETIC_BROWSER_ORIGIN,
} = {}) {
  const database = new FakeD1Database();
  const bucket = new FakeR2Bucket();
  const scheduled = [];
  const requestIdentities = new WeakMap();
  const contexts = new Set();
  const baseOptions = Object.freeze({
    database,
    bucket,
    publicOrigin: origin,
    identity: Object.freeze({
      readVerifiedIdentity(request) {
        return requestIdentities.get(request) ?? { kind: "unauthenticated" };
      },
    }),
    identityBindingProvider: SYNTHETIC_BROWSER_BINDING_NAMESPACE,
    tokenVerifierKey: deterministicKey(17),
    locatorKey: deterministicKey(37),
    exportDownloadVerifierKey: deterministicKey(67),
    csrfKey: deterministicKey(97),
    observabilityWriter: Object.freeze({ write() {} }),
    now,
    schedule(work) {
      scheduled.push(Object.freeze({ ...work }));
    },
  });

  let runtime = await createProductSiteRuntime(baseOptions);
  let closed = false;

  async function restart({ serviceOperatorPrincipalIds = [] } = {}) {
    if (closed) throw new Error("browser composition is closed");
    runtime = await createProductSiteRuntime({
      ...baseOptions,
      serviceOperatorPrincipalIds: Object.freeze([...serviceOperatorPrincipalIds]),
    });
    return runtime;
  }

  async function drain({ max = 256 } = {}) {
    let count = 0;
    while (scheduled.length > 0) {
      if (count >= max) throw new Error("synthetic browser background queue did not quiesce");
      const work = scheduled.shift();
      const result = await runtime.dispatchBackground(
        work.kind === "audit_outbox"
          ? { kind: work.kind, messageId: work.id }
          : { kind: work.kind, jobId: work.id },
      );
      if (result?.kind === "failed") {
        throw new Error(`synthetic browser background work failed: ${work.kind}`);
      }
      count += 1;
    }
    return count;
  }

  function createContext({ name, identity }) {
    if (closed) throw new Error("browser composition is closed");
    if (
      typeof name !== "string" || !/^[a-z][a-z0-9-]{1,31}$/u.test(name) ||
      identity?.kind !== "authenticated" ||
      typeof identity.verifiedEmail !== "string" ||
      typeof identity.verifiedFullName !== "string"
    ) throw new TypeError("a bounded trusted browser identity is required");

    const trustedIdentity = Object.freeze({
      kind: "authenticated",
      verifiedEmail: identity.verifiedEmail,
      verifiedFullName: identity.verifiedFullName,
    });
    let server;
    let baseUrl;
    const ready = new Promise((resolve, reject) => {
      server = createServer(async (incoming, outgoing) => {
        try {
          const body = await readIncomingBody(incoming);
          const sourceUrl = new URL(incoming.url ?? "/", origin);
          const headers = headerRecord(new Headers(incoming.headers));
          // The browser-facing listener is not the Product Site origin. Keep
          // only protocol headers and canonicalize the request URL before the
          // trusted identity reader sees it.
          const request = new Request(sourceUrl, {
            method: incoming.method ?? "GET",
            headers,
            ...(body === undefined ? {} : { body, duplex: "half" }),
          });
          requestIdentities.set(request, trustedIdentity);
          const response = await runtime.fetch(request);
          await writeResponse(response ?? new Response("Not found", { status: 404 }), outgoing);
        } catch (error) {
          outgoing.statusCode = error?.message?.includes("too large") ? 413 : 500;
          outgoing.setHeader("content-type", "application/json; charset=utf-8");
          outgoing.end(JSON.stringify({ ok: false, error: { code: "browser_fixture_failure" } }));
        }
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (typeof address !== "object" || address === null) {
          reject(new Error("browser context did not acquire a loopback port"));
          return;
        }
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });

    const context = {
      name,
      async ready() {
        await ready;
        return context;
      },
      async request(path, options = {}) {
        await ready;
        const url = new URL(path, `${baseUrl}/`);
        const headers = new Headers(options.headers ?? {});
        if (options.method !== undefined && options.method !== "GET" && options.method !== "HEAD") {
          headers.set("origin", origin);
        }
        const response = await fetch(url, {
          ...options,
          headers,
        });
        const text = await response.text();
        let body = null;
        if ((response.headers.get("content-type") ?? "").includes("json") && text.length > 0) {
          body = JSON.parse(text);
        }
        return Object.freeze({ response, status: response.status, headers: response.headers, text, body });
      },
      async page(path = "/") {
        const result = await context.request(path, { method: "GET" });
        if (result.status !== 200) throw new Error(`${name} UI request failed: ${result.status}`);
        return result.text;
      },
      async csrf(path = "/") {
        return parseCsrf(await context.page(path));
      },
      async api(path, {
        method = "GET",
        body,
        idempotencyKey,
        expectedStatus,
        csrfPath = "/",
        headers: extraHeaders,
      } = {}) {
        const headers = new Headers(extraHeaders ?? {});
        headers.set("accept", "application/json");
        if (method !== "GET" && method !== "HEAD") {
          headers.set("content-type", "application/json");
          headers.set("x-csrf-token", await context.csrf(csrfPath));
          if (idempotencyKey !== undefined) headers.set("idempotency-key", idempotencyKey);
        }
        const result = await context.request(path, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (expectedStatus !== undefined && result.status !== expectedStatus) {
          throw new Error(`${name} API expected ${expectedStatus}, got ${result.status}`);
        }
        return result;
      },
      async json(path, options = {}) {
        return jsonBody(await context.api(path, options));
      },
      async bootstrap(idempotencyKey) {
        const page = await context.page("/");
        const registration = await context.json("/api/v1/account", {
          method: "POST",
          body: { action: "create_isolated_account" },
          idempotencyKey,
          csrfPath: "/",
        });
        if (registration.response.status !== 200) {
          throw new Error(`${name} account bootstrap failed`);
        }
        // Keep this explicit read so the browser gate proves a page-first
        // session/CSRF flow rather than a direct command invocation.
        if (!page.includes("data-session-state=\"registration_required\"")) {
          throw new Error(`${name} did not observe the registration UI state`);
        }
        return registration.body.data;
      },
      async close() {
        await ready;
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        contexts.delete(context);
      },
    };
    contexts.add(context);
    return context;
  }

  async function close() {
    if (closed) return;
    closed = true;
    await Promise.all([...contexts].map((context) => context.close()));
    database.destroy();
    bucket.destroy();
  }

  return Object.freeze({
    database,
    bucket,
    scheduled,
    createContext,
    drain,
    restart,
    get runtime() { return runtime; },
    close,
  });
}
