import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  renderOrdinaryMindsManagement,
  renderOrdinaryMindsManagementDocument,
  suggestOrdinaryMindHandle,
} from "../../packages/adapter-web/dist/ordinary-minds-management.js";

const implementation = await readFile(
  new URL("../../packages/adapter-web/src/ordinary-minds-management.ts", import.meta.url),
  "utf8",
);

const OWNER_MIND = Object.freeze({
  mindId: "mind_owner_fixture",
  handle: "research-notes",
  name: "Research Notes",
  visibility: "private",
  role: "owner",
  metadataVersion: 7,
  headRevisionId: "revision_owner_fixture",
  updatedLabel: "Updated today",
});

const MEMBER_MIND = Object.freeze({
  mindId: "mind_member_fixture",
  handle: "shared-library",
  name: "Shared Library",
  visibility: "unlisted",
  role: "editor",
  metadataVersion: 4,
  headRevisionId: "revision_member_fixture",
  updatedLabel: "Updated yesterday",
});

function listModel(collection) {
  return {
    displayName: "Andrey",
    view: { kind: "list", collection },
  };
}

function detailModel(mind, ownership) {
  return {
    displayName: "Andrey",
    view: { kind: "detail", mind, ...(ownership === undefined ? {} : { ownership }) },
  };
}

test("list view distinguishes owned and member Minds with canonical route management", () => {
  const html = renderOrdinaryMindsManagement(listModel({
    kind: "ready",
    minds: [OWNER_MIND, MEMBER_MIND],
  }));

  assert.match(html, /data-mind-card="research-notes" data-mind-role="owner"/);
  assert.match(html, /Owned by you/);
  assert.match(html, /href="\/research-notes"[^>]*>Manage/);
  assert.match(html, /data-mind-card="shared-library" data-mind-role="editor"/);
  assert.match(html, /Editor member/);
  assert.match(html, /Unlisted/);
  assert.doesNotMatch(html, /data-mind-card="me"|href="\/me"[^>]*>Manage/);
});

test("create flow requires a name, offers an editable suggested handle, and states private default", () => {
  const html = renderOrdinaryMindsManagement(listModel({ kind: "empty" }));

  assert.equal(suggestOrdinaryMindHandle("Research Notes"), "research-notes");
  assert.equal(suggestOrdinaryMindHandle("Café Plans"), "cafe-plans");
  assert.equal(suggestOrdinaryMindHandle("AI"), "ai-mind");
  assert.equal(suggestOrdinaryMindHandle("Заметки"), "new-mind");
  assert.match(html, /id="ordinary-mind-name"[^>]*required[^>]*maxlength="80"/);
  assert.match(html, /id="ordinary-mind-handle"[^>]*required[^>]*minlength="3"[^>]*maxlength="63"/);
  assert.match(html, /Suggested from the name and editable before creation/);
  assert.match(html, /<strong>Private by default\.<\/strong>/);
  assert.match(html, /occupied, reserved, or retired/);
  assert.match(implementation, /That web address is unavailable\. Choose another one\./);
  assert.match(implementation, /code === "handle_unavailable"/);
  assert.match(implementation, /No partial Mind is shown; retrying the same details is safe/);
});

test("route detail renames only the display name and handles stale metadata explicitly", () => {
  const html = renderOrdinaryMindsManagement(detailModel({
    ...OWNER_MIND,
    visibility: "public",
  }));

  assert.match(html, /data-mind-handle="research-notes"/);
  assert.match(html, /data-metadata-version="7"/);
  assert.match(html, /Only the display name changes/);
  assert.match(html, /The permanent route remains <strong>\/research-notes<\/strong>/);
  assert.match(html, /Renaming never changes this route/);
  assert.match(implementation, /failureCode\(error\) === "metadata_conflict"/);
  assert.match(implementation, /reload current settings before trying again/i);
  assert.match(implementation, /renamed\.handle !== routeHandle/);
  assert.match(implementation, /renamed\.mindId !== routeMindId/);
});

test("delete preview and strong confirmation are rendered only for Owner", () => {
  const owner = renderOrdinaryMindsManagement(detailModel(OWNER_MIND));
  const admin = renderOrdinaryMindsManagement(detailModel({
    ...OWNER_MIND,
    role: "admin",
  }));
  const editor = renderOrdinaryMindsManagement(detailModel(MEMBER_MIND));

  assert.match(owner, /data-owner-delete-controls/);
  assert.match(owner, /data-open-delete-mind/);
  assert.match(owner, /data-delete-mind-dialog/);
  assert.match(owner, /data-delete-confirmation/);
  assert.match(owner, /data-delete-understand/);
  assert.match(owner, /data-impact-jobs/);
  assert.match(owner, /data-impact-exports/);
  assert.match(owner, /Delete Mind permanently/);
  assert.match(owner, /there is no recovery and no forensic deletion receipt/i);
  assert.doesNotMatch(admin, /data-owner-delete-controls|data-delete-mind-dialog/);
  assert.doesNotMatch(editor, /data-owner-delete-controls|data-delete-mind-dialog|data-rename-mind-form/);
  assert.match(editor, /Settings are read-only/);
  assert.match(implementation, /Loading the current deletion impact/);
  assert.match(implementation, /Deleting this Mind, its history, and related records/);
  assert.match(implementation, /deletion_impact_changed/);
  assert.match(implementation, /deletion_impact_expired/);
  assert.match(implementation, /impact\.confirmation === `delete-mind:\$\{handle\}`/);
});

test("Owner visibility controls disclose live HEAD and history while baseline readers stay read-only", () => {
  const owner = renderOrdinaryMindsManagement(detailModel(OWNER_MIND));
  const baseline = renderOrdinaryMindsManagement(detailModel({
    ...MEMBER_MIND,
    role: "reader",
    accessKind: "visibility",
    discovery: "exact_handle",
  }));

  assert.match(owner, /data-owner-visibility-controls/);
  assert.match(owner, /value="private" selected/);
  assert.match(owner, /value="unlisted"/);
  assert.match(owner, /value="public"/);
  assert.match(owner, /data-visibility-ack/);
  assert.match(owner, /live HEAD and the entire history/i);
  assert.match(owner, /cannot undo disclosure that already happened/i);
  assert.match(baseline, /data-visibility-readonly/);
  assert.match(baseline, /baseline access is read-only and does not create membership/i);
  assert.match(baseline, /exact URL is not a secret/i);
  assert.doesNotMatch(baseline, /data-owner-visibility-controls|data-save-visibility/);
});

test("ownership transfer lists active non-owner participants and states the single-Owner result", () => {
  const html = renderOrdinaryMindsManagement(detailModel(OWNER_MIND, {
    kind: "ready",
    members: [
      { memberId: "membership_owner", displayName: "Andrey", role: "owner", membershipVersion: 3, isSelf: true },
      { memberId: "membership_editor", displayName: "Editor Person", role: "editor", membershipVersion: 2, isSelf: false },
    ],
  }));

  assert.match(html, /data-owner-transfer-controls/);
  assert.match(html, /value="membership_editor">Editor Person — Editor/);
  assert.doesNotMatch(html, /value="membership_owner"/);
  assert.match(html, /Pending invitations cannot receive ownership/);
  assert.match(html, /become Admin and exactly one Owner remains/);
  assert.match(html, /data-ownership-confirmation/);
  assert.match(html, /data-transfer-ownership disabled/);
});

test("browser management stays metadata-only while import uses its bounded dedicated ingress", () => {
  assert.match(implementation, /interface OrdinaryMindsManagementAdapter/);
  assert.match(implementation, /listMinds\(\)/);
  assert.match(implementation, /getMind\(handle: string\)/);
  assert.match(implementation, /createMind\(command:/);
  assert.match(implementation, /renameMind\(command:/);
  assert.match(implementation, /getDeletionImpact\(handle: string\)/);
  assert.match(implementation, /deleteMind\(command:/);
  assert.doesNotMatch(
    implementation,
    /\b(?:browseEntries|fetchEntry|commitChangeset|rawMarkdown|markdownText|fileBody)\b/,
  );

  const html = renderOrdinaryMindsManagement(detailModel(OWNER_MIND));
  assert.match(html, /Import a folder/);
  assert.match(html, /data-markdown-import[^>]+data-head-revision="revision_owner_fixture"/);
  assert.match(html, /type="file"[^>]+accept="\.md,text\/markdown"/);
  assert.doesNotMatch(html, /<textarea|name="(?:text|markdown|path)"/i);
});

test("all supplied names, labels, announcements, and route errors are escaped", () => {
  const malicious = `<img src=x onerror="globalThis.pwned=1">`;
  const html = renderOrdinaryMindsManagement({
    displayName: malicious,
    announcement: malicious,
    view: {
      kind: "list",
      collection: {
        kind: "ready",
        minds: [{
          ...OWNER_MIND,
          name: `<svg onload="globalThis.pwned=2">`,
          updatedLabel: `<script>globalThis.pwned=3</script>`,
        }],
      },
    },
  });

  assert.doesNotMatch(html, /<(?:script|svg|img)\b[^>]*(?:onerror|onload|pwned)/i);
  assert.doesNotMatch(html, /\son(?:error|load)\s*=\s*["']/i);
  assert.match(html, /&lt;svg onload=&quot;globalThis\.pwned=2&quot;&gt;/);

  const routeError = renderOrdinaryMindsManagement({
    displayName: "Andrey",
    view: { kind: "route_error", handle: `bad\" onclick=\"pwned`, message: malicious },
  });
  assert.doesNotMatch(routeError, /onclick=|<img src=x/i);
});

test("document accepts only a local fixture script and keeps brand shell assets", () => {
  const safe = renderOrdinaryMindsManagementDocument(
    listModel({ kind: "loading" }),
    "/fixture/ordinary-minds-client.mjs",
  );
  const unsafe = renderOrdinaryMindsManagementDocument(
    listModel({ kind: "loading" }),
    `javascript:globalThis.pwned=1`,
  );

  assert.match(safe, /src="\/fixture\/ordinary-minds-client\.mjs"/);
  assert.match(safe, /href="\/brand\/mind-diary-tokens\.css"/);
  assert.match(safe, /href="\/ui\/mind-diary-shell\.css"/);
  assert.doesNotMatch(unsafe, /javascript:|globalThis\.pwned/);
});
