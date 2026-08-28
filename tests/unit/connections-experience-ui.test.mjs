import assert from "node:assert/strict";
import test from "node:test";

import {
  renderAdvancedMcpPageDocument,
  renderConnectionDetailDocument,
  renderConnectionsPageDocument,
} from "../../packages/adapter-web/dist/index.js";
import { PRODUCT_CONNECTIONS_CLIENT_JAVASCRIPT } from "../../packages/adapter-web/dist/product-ui-assets.js";

const CONNECTION_REF = `conn_v1_${"a".repeat(32)}`;
const PERSONAL_TOKEN_REF = `ptok_v1_${"b".repeat(32)}`;
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
  assert.match(html, /Access follows current membership and visibility automatically/);
  assert.doesNotMatch(html, /<ul class="md-binding-list"/);
  assert.doesNotMatch(html, /read selector|attach|detach/iu);
  assert.match(html, /data-revoke-connection/);
});

test("hydrated ordinary Connections calls readable Minds available, never selected", () => {
  assert.match(
    PRODUCT_CONNECTIONS_CLIENT_JAVASCRIPT,
    /definition\("Can read", item\.can_read \? `\$\{item\.readable_mind_count\} available`/u,
  );
  assert.doesNotMatch(
    PRODUCT_CONNECTIONS_CLIENT_JAVASCRIPT,
    /readable_mind_count\} selected|read selector|attach_read|detach_read/iu,
  );
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

test("Advanced MCP alone exposes bounded token history and protocol details", () => {
  const active = renderAdvancedMcpPageDocument({
    displayName: "Product Owner",
    siteOrigin: "https://mind-diary.example",
    state: "active",
    collection: {
      kind: "ready",
      nextCursor: "safe_next_cursor",
      items: [Object.freeze({
        personalTokenRef: PERSONAL_TOKEN_REF,
        name: "Direct Codex token",
        displayPrefix: "mdp_v1_Safe…",
        scopes: Object.freeze(["content:read", "content:write"]),
        state: "active",
        createdAt: "2026-08-27T10:00:00.000Z",
        expiresAt: "2026-11-25T10:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null,
        access: Object.freeze({
          targetVersion: 0,
          readableMinds: MINDS,
          writableMind: null,
          writableTargetState: "not_selected",
          eligibleMinds: MINDS,
        }),
      })],
    },
  });

  assert.match(active, /Advanced MCP/);
  assert.match(active, /content:read, content:write/);
  assert.match(active, /Modern MCP 2026-07-28/);
  assert.match(active, /Compatibility MCP 2025-11-25/);
  assert.match(active, /Next tokens/);
  assert.match(active, /3 Minds are currently readable/);
  assert.match(active, /there is no read selector/);
  assert.match(active, /No Mind receives changes/);
  assert.match(active, /My Mind is never selected automatically/);
  assert.match(active, /data-access-action="select_write"/);
  assert.match(active, /data-revoke-personal-token/);
  assert.match(active, /data-secret-dialog/);
  assert.match(active, /shown once and cannot be recovered/i);
  assert.doesNotMatch(active, /token_id|binding_owner|target_generation|space_/u);
  assert.doesNotMatch(active, /data-personal-token-ref/u);
});

test("reissue and inactive token history never expose a stale target or mutation", () => {
  const reissue = renderAdvancedMcpPageDocument({
    displayName: "Product Owner",
    siteOrigin: "https://mind-diary.example",
    state: "active",
    collection: {
      kind: "ready",
      nextCursor: null,
      items: [Object.freeze({
        personalTokenRef: PERSONAL_TOKEN_REF,
        name: "Legacy direct token",
        displayPrefix: "mdp_v1_Legacy…",
        scopes: Object.freeze(["content:read", "content:write"]),
        state: "active",
        createdAt: "2026-08-01T10:00:00.000Z",
        expiresAt: "2026-10-30T10:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null,
        access: Object.freeze({
          targetVersion: 4,
          readableMinds: Object.freeze([]),
          writableMind: null,
          writableTargetState: "reissue_required",
          eligibleMinds: Object.freeze([]),
        }),
      })],
    },
  });
  assert.match(reissue, /Reissue required/);
  assert.match(reissue, /Legacy write access is not transferred/);
  assert.doesNotMatch(reissue, /name="mind_ref"|data-access-action="(?:select|clear)_write"/u);
  assert.doesNotMatch(reissue, /Shared research|\/shared-research/);

  for (const state of ["revoked", "expired"]) {
    const history = renderAdvancedMcpPageDocument({
      displayName: "Product Owner",
      siteOrigin: "https://mind-diary.example",
      state,
      collection: {
        kind: "ready",
        nextCursor: null,
        items: [Object.freeze({
          personalTokenRef: PERSONAL_TOKEN_REF,
          name: `${state} token`,
          displayPrefix: "mdp_v1_History…",
          scopes: Object.freeze(["content:read"]),
          state,
          createdAt: "2026-08-01T10:00:00.000Z",
          expiresAt: "2026-08-02T10:00:00.000Z",
          lastUsedAt: null,
          revokedAt: state === "revoked" ? "2026-08-02T09:00:00.000Z" : null,
        })],
      },
    });
    assert.match(history, new RegExp(`${state} token`, "u"));
    assert.doesNotMatch(history, /data-access-panel|data-revoke-personal-token/);
  }
});
