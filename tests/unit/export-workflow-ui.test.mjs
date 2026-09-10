import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { renderProductExportWorkflowPanel } from "../../packages/adapter-web/dist/export-workflow.js";

const client = await readFile(
  new URL("../../packages/adapter-web/assets/export-client.js", import.meta.url),
  "utf8",
);

test("exact-revision export panel keeps its target and profiles explicit", () => {
  const html = renderProductExportWorkflowPanel({
    mindRef: "research-notes",
    route: "/research-notes",
    name: `Research <img src=x onerror="pwned()">`,
    headRevisionId: "revision_head_7",
  });

  assert.match(html, /data-export-workflow/);
  assert.match(html, /data-export-mind-ref="research-notes"/);
  assert.match(html, /Target Mind:[\s\S]*Research &lt;img/);
  assert.match(html, /<code data-export-target-route>\/research-notes<\/code>/);
  assert.match(html, /Current HEAD <code>revision_head_7<\/code>/);
  assert.match(html, /Exact historical revision/);
  assert.match(html, /MD-BUNDLE-ZIP-1/);
  assert.match(html, /MD-OKF-ZIP-1/);
  assert.match(html, /separate from import/);
  assert.match(html, /does not change the Mind, restore content, or include the full revision history/);
  assert.doesNotMatch(html, /<img|onerror="pwned/);
  assert.doesNotMatch(html, /download_url|mdg_v1_|objectKey/);
});

test("panel fails closed when route and Mind reference disagree", () => {
  const html = renderProductExportWorkflowPanel({
    mindRef: "research-notes",
    route: "/another-mind",
    name: "Research Notes",
    headRevisionId: "revision_head_7",
  });
  assert.match(html, /data-export-unavailable/);
  assert.doesNotMatch(html, /data-export-form/);
});

test("browser workflow persists no receipt secret and verifies exact bytes before save", () => {
  assert.match(client, /sessionStorage/);
  assert.match(client, /mindRef,\s*selector,\s*profile,\s*idempotencyKey/);
  assert.doesNotMatch(client, /sessionStorage\.setItem\([^\n]+download/);
  assert.match(client, /crypto\.subtle\.digest\("SHA-256", bytes\)/);
  assert.match(client, /bytes\.byteLength !== expected\.size \|\| digest !== expected\.sha256/);
  assert.match(client, /redirect: "error"/);
  assert.match(client, /credentials: "same-origin"/);
  assert.match(client, /polling < 8/);
  assert.match(client, /export_profile_required/);
  assert.match(client, /revision_integrity_failure/);
  assert.match(client, /No archive was published/);
  assert.match(client, /error\.code\.startsWith\("capacity_"\)/);
  assert.match(client, /Recovered the existing export without creating a duplicate/);
  assert.match(client, /saved = \{ \.\.\.saved, jobId: null \}/);
  assert.match(client, /Submit Start export to retry this exact job/);
});
