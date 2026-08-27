import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const fixture = JSON.parse(await readFile(
  new URL("tests/fixtures/compact-admin-ia/contract.v1.json", root),
  "utf8",
));
const specification = await readFile(
  new URL("docs/specs/compact-admin-information-architecture.md", root),
  "utf8",
);

test("compact admin IA fixture pins measurable geometry and acceptance viewports", () => {
  assert.equal(fixture.$schema, "mind-diary/compact-admin-ia/v1");
  assert.equal(fixture.source, "docs/specs/compact-admin-information-architecture.md");
  assert.deepEqual(fixture.breakpoints, {
    compact: { minWidthPx: 320, maxWidthPx: 767 },
    medium: { minWidthPx: 768, maxWidthPx: 1023 },
    wide: { minWidthPx: 1024 },
  });
  assert.deepEqual(fixture.geometry.spacingScalePx, [4, 8, 12, 16, 24, 32, 48]);
  assert.equal(fixture.geometry.railWidthPx, 240);
  assert.equal(fixture.geometry.contentMaxWidthPx, 1120);
  assert.equal(fixture.geometry.minimumHitTargetPx, 44);
  assert.equal(fixture.geometry.pageOverflowTolerancePx, 1);
  assert.deepEqual(
    fixture.viewports.map(({ width, height }) => `${width}x${height}`),
    ["320x568", "390x844", "768x1024", "1024x768", "1440x900"],
  );
});

test("compact admin IA route map keeps Personal first and Settings in utility navigation", () => {
  assert.deepEqual(fixture.primaryOrder, ["my-mind", "minds", "public", "invitations"]);
  assert.deepEqual(fixture.utilityOrder, ["help-optional", "settings"]);

  const route = (pattern) => fixture.routes.find((candidate) => candidate.pattern === pattern);
  assert.deepEqual(route("/me"), {
    pattern: "/me",
    shellCurrent: "my-mind",
    contextCurrent: null,
  });
  for (const pattern of [
    "/settings/account",
    "/settings/connections",
    "/settings/connections/{connection_ref}",
    "/settings/developer/mcp",
  ]) {
    assert.equal(route(pattern)?.shellCurrent, "settings", pattern);
  }
  assert.equal(route("/help/codex")?.shellCurrent, "help-optional");
  assert.deepEqual(route("/settings/mcp"), {
    pattern: "/settings/mcp",
    shellCurrent: null,
    contextCurrent: null,
    redirectTo: "/settings/developer/mcp",
    status: 308,
  });
});

test("specification exposes every stable selector and acceptance mapping for MD-347", () => {
  for (const selector of Object.values(fixture.selectors)) {
    const hook = selector.match(/\[([^=\]]+)/u)?.[1];
    assert.ok(hook, selector);
    assert.ok(specification.includes(hook), hook);
  }
  for (const acceptanceId of fixture.acceptanceIds) {
    assert.ok(specification.includes(`| \`${acceptanceId}\` |`), acceptanceId);
  }
  assert.match(specification, /Task Manager[^\n]+ориентир/u);
  assert.match(specification, /не добавляет corpus viewer\/editor, website AI/u);
  assert.match(specification, /Raw[\s\S]+content[^\n]+не рендерится/u);
});
