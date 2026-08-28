import assert from "node:assert/strict";
import test from "node:test";

import {
  renderConnectionDetailDocument,
  renderConnectionsPageDocument,
} from "../../packages/adapter-web/dist/index.js";

const CONNECTION_REF = `conn_v1_${"a".repeat(32)}`;
const MINDS = Object.freeze([
  Object.freeze({
    name: "My private notes",
    route: "/me",
    visibility: "private",
    canWrite: true,
  }),
  Object.freeze({
    name: "Shared research",
    route: "/shared-research",
    visibility: "unlisted",
    canWrite: true,
  }),
  Object.freeze({
    name: "Public reference",
    route: "/public-reference",
    visibility: "public",
    canWrite: false,
  }),
]);

function detail(overrides = {}) {
  return Object.freeze({
    connectionRef: CONNECTION_REF,
    clientName: "Codex Marketplace",
    createdAt: "2026-08-27T10:00:00.000Z",
    lastUsedAt: "2026-08-27T11:00:00.000Z",
    canRead: true,
    canWrite: true,
    readableMindCount: MINDS.length,
    writableMindSelected: false,
    access: Object.freeze({
      targetVersion: 0,
      readableMinds: MINDS,
      writableMind: null,
      writableTargetState: "not_selected",
      eligibleMinds: MINDS,
    }),
    ...overrides,
  });
}

test("ordinary Connections keeps status and capabilities human-readable and bounded", () => {
  const page = renderConnectionsPageDocument({
    displayName: "Product Owner",
    collection: {
      kind: "ready",
      items: [detail()],
      nextCursor: null,
    },
  });
  const html = renderConnectionDetailDocument({
    displayName: "Product Owner",
    connection: detail(),
  });

  for (const document of [page, html]) {
    assert.match(document, /Codex Marketplace/);
    assert.match(document, /Connected/);
    assert.match(document, /Can read/);
    assert.match(document, /Can add and change/);
    assert.doesNotMatch(document, /content:(?:read|write)|OAuth grant|binding_owner|target generation/u);
    assert.doesNotMatch(document, /attach_read|detach_read|read_binding|write_binding/u);
  }
  assert.match(html, /3 Minds are readable with your current access/);
  assert.match(html, /there is no read selector/);
  assert.doesNotMatch(html, /<ul class="md-binding-list"/);
  assert.match(html, /data-revoke-connection/);
});

test("write-capable Connection starts empty without a Personal Mind fallback", () => {
  const html = renderConnectionDetailDocument({
    displayName: "Product Owner",
    connection: detail(),
  });

  assert.match(html, /<strong>Not selected<\/strong>/);
  assert.match(html, /No Mind receives changes/);
  assert.match(html, /My Mind is never selected automatically/);
  assert.match(html, /data-target-version="0"/);
  assert.match(html, /data-access-action="select_write"/);
  assert.doesNotMatch(html, /selected[^<]*My private notes/iu);
});

test("selected, lost-access, and read-only states expose only safe reductions", () => {
  const selected = renderConnectionDetailDocument({
    displayName: "Product Owner",
    connection: detail({
      writableMindSelected: true,
      access: Object.freeze({
        targetVersion: 8,
        readableMinds: MINDS,
        writableMind: MINDS[1],
        writableTargetState: "selected",
        eligibleMinds: MINDS,
      }),
    }),
  });
  assert.match(selected, /Shared research[\s\S]*\/shared-research/);
  assert.match(selected, />Switch writable Mind</);
  assert.match(selected, /data-access-action="clear_write"/);

  const unavailable = renderConnectionDetailDocument({
    displayName: "Product Owner",
    connection: detail({
      writableMindSelected: true,
      access: Object.freeze({
        targetVersion: 9,
        readableMinds: Object.freeze([MINDS[0]]),
        writableMind: null,
        writableTargetState: "unavailable",
        eligibleMinds: Object.freeze([MINDS[0]]),
      }),
    }),
  });
  assert.match(unavailable, /former target is disabled/);
  assert.match(unavailable, /metadata stays hidden/);
  assert.doesNotMatch(unavailable, /Shared research|\/shared-research/);
  assert.match(unavailable, /data-access-action="clear_write"/);

  const readOnly = renderConnectionDetailDocument({
    displayName: "Product Owner",
    connection: detail({
      canWrite: false,
      readableMindCount: 1,
      access: Object.freeze({
        targetVersion: 2,
        readableMinds: Object.freeze([MINDS[2]]),
        writableMind: null,
        writableTargetState: "not_selected",
        eligibleMinds: Object.freeze([MINDS[2]]),
      }),
    }),
  });
  assert.match(readOnly, /Can add and change<\/h2><p>No\./);
  assert.doesNotMatch(readOnly, /data-access-action="select_write"|name="mind_ref"/);
});

