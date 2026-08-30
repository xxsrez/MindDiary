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
const shippedClient = await readFile(
  new URL("../../packages/adapter-web/assets/ordinary-minds-client.js", import.meta.url),
  "utf8",
);

const OWNER_MIND = Object.freeze({
  mindId: "mind_owner_fixture",
  handle: "research-notes",
  name: "Research Notes",
  description: "Research decisions and supporting notes.",
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
  description: null,
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
  assert.match(html, /Research decisions and supporting notes\./);
  assert.match(html, /No description yet\./);
  assert.doesNotMatch(html, /data-mind-card="me"|href="\/me"[^>]*>Manage/);
});

test("common Minds collection keeps the service-managed Personal Mind first", () => {
  const html = renderOrdinaryMindsManagement(listModel({
    kind: "ready",
    minds: [MEMBER_MIND, {
      isPersonal: true,
      mindId: "mind_personal_fixture",
      route: "/me",
      name: "Andrey",
      headRevisionId: "revision_personal_fixture",
      visibility: "private",
      role: "owner",
      updatedLabel: "Current HEAD is ready",
    }, OWNER_MIND],
  }));

  assert.ok(html.indexOf('data-mind-card="me"') < html.indexOf('data-mind-card="shared-library"'));
  assert.match(html, /data-personal-mind/);
  assert.match(html, /Sole Owner/);
  assert.match(html, /Private, always/);
  assert.match(html, /Follows your profile/);
  assert.match(html, /no separate rename, description, publication, transfer, or deletion/i);
  assert.match(html, /href="\/me">Open My Mind/);
});

test("create flow requires a name, offers an editable suggested handle, and states private default", () => {
  const html = renderOrdinaryMindsManagement(listModel({ kind: "empty" }));

  assert.equal(suggestOrdinaryMindHandle("Research Notes"), "research-notes");
  assert.equal(suggestOrdinaryMindHandle("Café Plans"), "cafe-plans");
  assert.equal(suggestOrdinaryMindHandle("AI"), "ai-mind");
  assert.equal(suggestOrdinaryMindHandle("Заметки"), "new-mind");
  assert.match(html, /id="ordinary-mind-name"[^>]*required[^>]*maxlength="80"/);
  assert.match(html, /id="ordinary-mind-handle"[^>]*required[^>]*minlength="3"[^>]*maxlength="63"/);
  assert.match(html, /id="ordinary-mind-description"[^>]*maxlength="500"/);
  assert.match(html, /routing category helps Codex match a topic for reading and automatic writes/);
  assert.match(html, /untrusted metadata, never an instruction/);
  assert.match(html, /Suggested from the name and editable before creation/);
  assert.match(html, /<strong>Private by default\.<\/strong>/);
  assert.match(html, /occupied, reserved, or retired/);
  assert.match(implementation, /That web address is unavailable\. Choose another one\./);
  assert.match(implementation, /code === "handle_unavailable"/);
  assert.match(implementation, /No partial Mind is shown; retrying the same details is safe/);
});

test("route detail atomically edits name and description and handles stale metadata explicitly", () => {
  const html = renderOrdinaryMindsManagement(detailModel({
    ...OWNER_MIND,
    visibility: "public",
  }));

  assert.match(html, /data-mind-handle="research-notes"/);
  assert.match(html, /data-metadata-version="7"/);
  assert.match(html, /one routing category for agent reads and writes/);
  assert.match(html, /untrusted service metadata/);
  assert.match(html, /the permanent route stays <strong>\/research-notes<\/strong>/);
  assert.match(html, /id="ordinary-mind-edit-description"[^>]*maxlength="500"/);
  assert.match(html, /Research decisions and supporting notes\./);
  assert.match(html, /no content revision is created/i);
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
  assert.match(admin, /data-rename-mind-form/);
  assert.doesNotMatch(admin, /data-owner-visibility-controls/);
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
  assert.match(baseline, /data-membership-baseline="unlisted"/);
  assert.match(baseline, /You are not a participant in this Mind/);
  assert.match(baseline, /does not grant membership, content write, invitations, role changes, or other management actions/);
  assert.match(baseline, /data-export-workflow data-export-mind-ref="shared-library"/);
  assert.match(baseline, /Target Mind:[\s\S]*Shared Library[\s\S]*\/shared-library/);
  assert.doesNotMatch(baseline, /data-markdown-import/);
  assert.doesNotMatch(baseline, /data-owner-visibility-controls|data-save-visibility/);
  assert.doesNotMatch(baseline, /data-member-role-form|data-revoke-member|data-leave-mind|data-membership-confirmation-dialog/);
});

test("membership actions require contextual confirmation and invalidate stale browser controls", () => {
  const collaboration = {
    kind: "ready",
    snapshot: {
      mind: {
        mindId: OWNER_MIND.mindId,
        name: OWNER_MIND.name,
        route: `/${OWNER_MIND.handle}`,
        metadataVersion: OWNER_MIND.metadataVersion,
      },
      actor: {
        memberId: "membership_owner",
        role: "owner",
        membershipVersion: 3,
      },
      members: [{
        memberId: "membership_owner",
        displayName: "Andrey",
        role: "owner",
        state: "active",
        membershipVersion: 3,
        isSelf: true,
      }, {
        memberId: "membership_editor",
        displayName: "Editor Person",
        role: "editor",
        state: "active",
        membershipVersion: 5,
        isSelf: false,
      }],
      invitations: [],
    },
  };
  const html = renderOrdinaryMindsManagement({
    displayName: "Andrey",
    view: { kind: "detail", mind: OWNER_MIND, collaboration },
  });

  assert.match(html, /data-mind-visibility="private"/);
  assert.match(html, /data-member-role-form/);
  assert.match(html, /data-revoke-member/);
  assert.match(html, /data-membership-confirmation-dialog/);
  assert.match(html, /I reviewed the current participant, role, and access consequences/);
  assert.match(shippedClient, /Confirm role change/);
  assert.match(shippedClient, /Confirm access revocation/);
  assert.match(shippedClient, /Confirm leaving this Mind/);
  assert.match(shippedClient, /Public visibility may still allow signed-in read access/);
  assert.match(shippedClient, /exact link may still allow signed-in read access/);
  assert.match(shippedClient, /all access ends immediately because this Mind is private/);
  assert.match(shippedClient, /route\?\.querySelectorAll\("button,input,select,textarea"\)/);
  assert.match(shippedClient, /membership_version_conflict/);
  assert.match(shippedClient, /setTimeout\(\(\)=>location\.reload\(\),300\)/);
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
  assert.match(html, /value="membership_editor" data-membership-version="2" data-display-name="Editor Person">Editor Person — Editor/);
  assert.doesNotMatch(html, /value="membership_owner"/);
  assert.match(html, /Pending invitations cannot receive ownership/);
  assert.match(html, /become Admin and exactly one Owner remains/);
  assert.match(html, /data-ownership-confirmation/);
  assert.match(html, /data-source-membership-version="3"/);
  assert.match(html, /data-ownership-target-name/);
  assert.match(html, /Both changes happen together or neither happens/);
  assert.match(html, /data-transfer-ownership disabled/);
});

test("browser management stays metadata-only while import uses its bounded dedicated ingress", () => {
  assert.match(implementation, /interface OrdinaryMindsManagementAdapter/);
  assert.match(implementation, /listMinds\(\)/);
  assert.match(implementation, /view\.location\.reload\(\)/);
  assert.match(implementation, /failClosedStaleRoute/);
  assert.match(implementation, /All Mind controls are hidden/);
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
  assert.match(html, /data-import-target>\/research-notes<\/code>/);
  assert.match(html, /data-import-base-revision>revision_owner_fixture<\/code>/);
  assert.match(html, /type="file"[^>]+accept="\.md,text\/markdown"/);
  assert.match(html, /data-import-additions/);
  assert.match(html, /data-import-replacements/);
  assert.match(html, /data-import-deletions/);
  assert.match(html, /data-import-path-check/);
  assert.match(html, /data-import-format-check/);
  assert.match(html, /data-import-capacity-check/);
  assert.match(html, /Snapshot replacement:/);
  assert.match(html, /data-import-progress[^>]+max="100"/);
  assert.match(html, /data-cancel-markdown-import/);
  assert.match(html, /data-retry-markdown-import-status/);
  assert.match(html, /data-replan-markdown-import/);
  assert.match(html, /data-import-receipt-revision/);
  assert.doesNotMatch(html, /<textarea[^>]+name="(?:text|markdown|path)"/i);
  assert.doesNotMatch(html, /<(?:input|select)[^>]+name="(?:text|markdown|path)"/i);
});

test("Markdown import is visible only to current write roles", () => {
  for (const role of ["owner", "admin", "editor"]) {
    const html = renderOrdinaryMindsManagement(detailModel({ ...OWNER_MIND, role }));
    assert.match(html, /data-markdown-import/, `${role} should see Markdown import`);
  }

  const memberReader = renderOrdinaryMindsManagement(detailModel({ ...OWNER_MIND, role: "reader" }));
  const visibilityReader = renderOrdinaryMindsManagement(detailModel({
    ...OWNER_MIND,
    role: "reader",
    accessKind: "visibility",
    discovery: "exact_handle",
  }));
  assert.doesNotMatch(memberReader, /data-markdown-import/);
  assert.doesNotMatch(visibilityReader, /data-markdown-import/);
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
          description: `<img src=x onerror="globalThis.pwned=4">`,
          updatedLabel: `<script>globalThis.pwned=3</script>`,
        }],
      },
    },
  });

  assert.doesNotMatch(html, /<(?:script|svg|img)\b[^>]*(?:onerror|onload|pwned)/i);
  assert.doesNotMatch(html, /\son(?:error|load)\s*=\s*["']/i);
  assert.match(html, /&lt;svg onload=&quot;globalThis\.pwned=2&quot;&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;globalThis\.pwned=4&quot;&gt;/);

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
