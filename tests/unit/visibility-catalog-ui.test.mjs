import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createVisibilityChangeCommand,
  publicMindsForCatalog,
  renderVisibilityCatalogDocument,
  renderVisibilityCatalogUi,
  visibilityChangeDisclosure,
} from "../../packages/adapter-web/dist/visibility-catalog.js";

const implementation = await readFile(
  new URL("../../packages/adapter-web/src/visibility-catalog.ts", import.meta.url),
  "utf8",
);

function mind(overrides = {}) {
  return {
    mindId: "mind_research",
    route: "/research-notes",
    name: "Research Notes",
    summary: "Sources, decisions, and open questions.",
    visibility: "private",
    isPersonal: false,
    discovery: "membership",
    accessKind: "membership",
    role: "owner",
    metadataVersion: 7,
    ...overrides,
  };
}

function mindPage(overrides = {}) {
  return {
    kind: "mind",
    displayName: "Andrey",
    mind: mind(overrides),
  };
}

function catalogItem(overrides = {}) {
  return {
    mindId: "mind_public",
    route: "/public-research",
    name: "Public Research",
    summary: "A public research library.",
    visibility: "public",
    isPersonal: false,
    discovery: "public_catalog",
    ...overrides,
  };
}

test("Owner controls expose all three modes and require explicit live HEAD plus history acknowledgement", () => {
  const html = renderVisibilityCatalogUi(mindPage());

  assert.match(html, /data-visibility-control-route/);
  assert.match(html, /<option value="private" selected>/);
  assert.match(html, /<option value="unlisted">/);
  assert.match(html, /<option value="public">/);
  assert.match(html, /live HEAD and the entire immutable history/i);
  assert.match(html, /New successful commits become visible immediately/);
  assert.match(html, /data-exposure-acknowledgement disabled/);
  assert.match(html, /data-save-visibility disabled/);
  assert.match(html, /The exact URL is not a secret/);

  const disclosure = visibilityChangeDisclosure("private", "unlisted");
  assert.deepEqual(disclosure, {
    kind: "exposure",
    requiresAcknowledgement: true,
    message:
      "This opens the live HEAD and the entire immutable history to any signed-in person. New successful commits become visible immediately.",
  });
});

test("command construction is fail-closed for acknowledgement, invalid, Personal, and non-owner mutations", () => {
  assert.throws(
    () => createVisibilityChangeCommand(mind(), "public", false, "visibility-request-0001"),
    /Acknowledge exposure/,
  );

  assert.deepEqual(
    createVisibilityChangeCommand(mind(), "unlisted", true, "visibility-request-0001"),
    {
      mindId: "mind_research",
      visibility: "unlisted",
      acknowledgeLiveHeadAndHistoryExposure: true,
      expectedMetadataVersion: 7,
      idempotencyKey: "visibility-request-0001",
    },
  );

  for (const candidate of [
    mind({ role: "admin" }),
    mind({ accessKind: "visibility", role: null }),
    mind({ isPersonal: true, route: "/me" }),
    mind({ mindId: `bad" onmouseover="globalThis.pwned=1` }),
    mind({ metadataVersion: 0 }),
  ]) {
    assert.throws(
      () => createVisibilityChangeCommand(candidate, "public", true, "visibility-request-0001"),
      /Owner visibility access/,
    );
  }

  assert.throws(
    () => createVisibilityChangeCommand(mind(), "public", true, "short"),
    /request identity is invalid/,
  );
});

test("returning to private warns that future access stops without undoing past disclosure", () => {
  const disclosure = visibilityChangeDisclosure("public", "private");
  assert.deepEqual(disclosure, {
    kind: "return_private",
    requiresAcknowledgement: false,
    message:
      "Returning to private stops future access for non-members. It does not undo copies or disclosure that already happened.",
  });

  const html = renderVisibilityCatalogUi(mindPage({ visibility: "public" }));
  assert.match(html, /Private stops future access only/);
  assert.match(html, /does not undo copies or disclosure that already happened/);
  assert.match(html, /data-private-warning hidden/);
});

test("non-owner and Personal routes contain no enabled or hidden visibility mutation", () => {
  for (const candidate of [
    mind({ role: "reader" }),
    mind({ role: "editor" }),
    mind({ role: "admin" }),
    mind({ accessKind: "visibility", role: null, visibility: "public", discovery: "public_catalog" }),
    mind({
      mindId: "mind_personal",
      route: "/me",
      name: "Andrey",
      visibility: "private",
      isPersonal: true,
      discovery: "personal",
      role: "owner",
    }),
  ]) {
    const html = renderVisibilityCatalogUi({
      kind: "mind",
      displayName: "Andrey",
      mind: candidate,
    });
    assert.match(html, /data-visibility-readonly/);
    assert.doesNotMatch(html, /data-visibility-form|data-save-visibility|data-visibility-selector/);
  }
});

test("exact unlisted opening remains readable by URL but is explicitly absent from catalog discovery", () => {
  const unlisted = catalogItem({
    mindId: "mind_unlisted",
    route: "/quiet-link",
    name: "Quiet Link",
    visibility: "unlisted",
    discovery: "exact_handle",
  });
  const direct = renderVisibilityCatalogUi({
    kind: "mind",
    displayName: "Signed-in reader",
    mind: mind({
      ...unlisted,
      accessKind: "visibility",
      role: null,
      metadataVersion: 4,
    }),
  });
  assert.match(direct, /data-exact-unlisted-opening/);
  assert.match(direct, /href="\/quiet-link"/);
  assert.match(direct, /This URL is not a secret/);
  assert.match(direct, /absent from Public Minds/);
  assert.doesNotMatch(direct, /data-visibility-form/);

  assert.deepEqual(publicMindsForCatalog([unlisted]), []);
});

test("catalog fail-closes against private, unlisted, Personal, exact-handle, malformed, and duplicate descriptors", () => {
  const publicMind = catalogItem();
  const privateMind = catalogItem({ mindId: "mind_private", route: "/private", visibility: "private", discovery: "membership" });
  const unlistedMind = catalogItem({ mindId: "mind_unlisted", route: "/unlisted", visibility: "unlisted", discovery: "exact_handle" });
  const personalMind = catalogItem({ mindId: "mind_personal", route: "/me", isPersonal: true });
  const exactPublic = catalogItem({ mindId: "mind_exact", route: "/exact-public", discovery: "exact_handle" });
  const malformed = catalogItem({ mindId: `bad" onclick="globalThis.pwned=1`, route: "javascript:globalThis.pwned=2" });

  assert.deepEqual(
    publicMindsForCatalog([
      privateMind,
      unlistedMind,
      personalMind,
      exactPublic,
      malformed,
      publicMind,
      publicMind,
    ]),
    [publicMind],
  );

  const html = renderVisibilityCatalogUi({
    kind: "catalog",
    displayName: "Andrey",
    authenticated: true,
    collection: {
      kind: "ready",
      minds: [privateMind, unlistedMind, personalMind, exactPublic, malformed, publicMind, publicMind],
    },
  });
  assert.match(html, /data-public-mind-card="mind_public"/);
  assert.match(html, /Public Research/);
  assert.doesNotMatch(html, /Quiet Link|mind_private|mind_unlisted|mind_personal|mind_exact/);
  assert.equal((html.match(/data-public-mind-card=/g) ?? []).length, 1);
  assert.doesNotMatch(html, /javascript:|onclick|globalThis\.pwned/);
});

test("catalog is authenticated-only and has explicit loading, empty, and retryable error states", () => {
  const unauthenticated = renderVisibilityCatalogUi({
    kind: "catalog",
    displayName: "Guest",
    authenticated: false,
    collection: { kind: "ready", minds: [catalogItem()] },
  });
  assert.match(unauthenticated, /data-authentication-required/);
  assert.match(unauthenticated, /Anonymous access is not available/);
  assert.doesNotMatch(unauthenticated, /data-public-mind-card/);

  const base = { kind: "catalog", displayName: "Andrey", authenticated: true };
  assert.match(
    renderVisibilityCatalogUi({ ...base, collection: { kind: "loading" } }),
    /aria-busy="true"/,
  );
  assert.match(
    renderVisibilityCatalogUi({ ...base, collection: { kind: "empty" } }),
    /Private, unlisted, and Personal Minds never appear here/,
  );
  assert.match(
    renderVisibilityCatalogUi({
      ...base,
      collection: { kind: "error", message: "Catalog temporarily unavailable." },
    }),
    /data-public-catalog-retry/,
  );
});

test("all untrusted page, Mind, catalog, and error text is escaped", () => {
  const malicious = `<img src=x onerror="globalThis.pwned=1">`;
  const mindHtml = renderVisibilityCatalogUi({
    kind: "mind",
    displayName: malicious,
    announcement: malicious,
    mind: mind({ name: malicious, summary: `<svg onload="globalThis.pwned=2">` }),
  });
  const catalogHtml = renderVisibilityCatalogUi({
    kind: "catalog",
    displayName: malicious,
    authenticated: true,
    collection: { kind: "error", message: `<script>globalThis.pwned=3</script>` },
  });

  for (const html of [mindHtml, catalogHtml]) {
    assert.doesNotMatch(html, /<(?:img|script|svg)\b[^>]*(?:onerror|onload|pwned)/i);
    assert.doesNotMatch(html, /\son(?:click|error|load)\s*=\s*["']/i);
  }
  assert.match(mindHtml, /&lt;svg onload=&quot;globalThis\.pwned=2&quot;&gt;/);
  assert.match(catalogHtml, /&lt;script&gt;globalThis\.pwned=3&lt;\/script&gt;/);
});

test("document reuses local brand shell assets and accepts only a safe local fixture client", () => {
  const safe = renderVisibilityCatalogDocument(
    mindPage(),
    "/fixture/visibility-catalog-client.mjs",
  );
  const unsafe = renderVisibilityCatalogDocument(
    mindPage(),
    `javascript:globalThis.pwned=1`,
  );

  assert.match(safe, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(safe, /\/brand\/mind-diary-tokens\.css/);
  assert.match(safe, /\/ui\/mind-diary-shell\.css/);
  assert.match(safe, /src="\/fixture\/visibility-catalog-client\.mjs"/);
  assert.doesNotMatch(unsafe, /javascript:|globalThis\.pwned/);
  assert.doesNotMatch(
    implementation,
    /console\.|analytics\.|dataLayer|localStorage|sessionStorage|sendBeacon/i,
  );
});
