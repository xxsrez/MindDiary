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
const settingsImplementation = await Promise.all([
  "packages/adapter-web/src/ui-shell.ts",
  "packages/adapter-web/src/connections.ts",
].map((path) => readFile(new URL(path, root), "utf8"))).then((sources) => sources.join("\n"));

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function assertExactKeys(value, keys, label) {
  assert.deepEqual(sortedKeys(value), [...keys].sort(), label);
}

function assertUnique(values, label) {
  assert.equal(new Set(values).size, values.length, label);
}

function assertEffect(value, label) {
  assert.match(value, /^[a-z][a-z0-9-]+$/u, label);
}

function route(pattern) {
  return fixture.routes.find((candidate) => candidate.pattern === pattern);
}

test("compact admin IA fixture is a closed versioned contract", () => {
  assert.equal(fixture.$schema, "mind-diary/compact-admin-ia/v1");
  assert.equal(fixture.version, 1);
  assert.equal(fixture.source, "docs/specs/compact-admin-information-architecture.md");
  assertExactKeys(fixture, [
    "$schema",
    "source",
    "version",
    "breakpoints",
    "geometry",
    "viewports",
    "navigation",
    "settingsInformationArchitecture",
    "routes",
    "sessionStates",
    "accountStates",
    "routeSafetyStates",
    "privacy",
    "destructiveFlows",
    "disclosures",
    "accessibility",
    "preferences",
    "brand",
    "selectors",
    "acceptanceIds",
  ], "top-level contract keys drifted");
  assertUnique(fixture.acceptanceIds, "acceptance IDs must be unique");
  assert.equal(fixture.acceptanceIds.length, 17);
});

test("breakpoints, geometry, and every acceptance viewport have executable expectations", () => {
  assert.deepEqual(fixture.breakpoints, {
    compact: { minWidthPx: 320, maxWidthPx: 767 },
    medium: { minWidthPx: 768, maxWidthPx: 1023 },
    wide: { minWidthPx: 1024 },
  });
  assert.equal(fixture.breakpoints.compact.maxWidthPx + 1, fixture.breakpoints.medium.minWidthPx);
  assert.equal(fixture.breakpoints.medium.maxWidthPx + 1, fixture.breakpoints.wide.minWidthPx);
  assert.deepEqual(fixture.geometry.spacingScalePx, [4, 8, 12, 16, 24, 32, 48]);
  assert.deepEqual(
    {
      rail: fixture.geometry.railWidthPx,
      content: fixture.geometry.contentMaxWidthPx,
      hit: fixture.geometry.minimumHitTargetPx,
      overflow: fixture.geometry.pageOverflowTolerancePx,
      wideRows: [fixture.geometry.wideRowMinHeightPx, fixture.geometry.wideRowMaxHeightPx],
      compactRow: fixture.geometry.compactRowMinHeightPx,
    },
    { rail: 208, content: 1440, hit: 44, overflow: 1, wideRows: [44, 56], compactRow: 56 },
  );

  assert.deepEqual(
    fixture.viewports.map(({ id, width, height }) => `${id}:${width}x${height}`),
    [
      "minimum:320x568",
      "mobile:390x844",
      "medium:768x1024",
      "wide-minimum:1024x768",
      "wide:1440x900",
    ],
  );
  assertUnique(fixture.viewports.map(({ id }) => id), "viewport IDs must be unique");
  const stableSelectors = new Set(Object.values(fixture.selectors));
  for (const viewport of fixture.viewports) {
    assertExactKeys(viewport, [
      "id",
      "width",
      "height",
      "layoutMode",
      "maxOverflowPx",
      "railVisible",
      "drawerInitiallyOpen",
      "settingsVisibleWithoutOpeningDrawer",
      "requiredFirstVisibleSelectors",
      "completeOneOfSelectors",
      "firstRowStartsInViewport",
      "minimumCompleteRowsWhenReady",
    ], `${viewport.id}: viewport contract drifted`);
    assert.equal(viewport.maxOverflowPx, fixture.geometry.pageOverflowTolerancePx, viewport.id);
    assert.equal(viewport.drawerInitiallyOpen, false, viewport.id);
    assert.ok(viewport.requiredFirstVisibleSelectors.length >= 2, viewport.id);
    assert.ok(viewport.completeOneOfSelectors.length >= 1, viewport.id);
    for (const selector of [
      ...viewport.requiredFirstVisibleSelectors,
      ...viewport.completeOneOfSelectors,
    ]) assert.ok(stableSelectors.has(selector), `${viewport.id}:${selector}`);
    if (viewport.width >= fixture.breakpoints.wide.minWidthPx) {
      assert.equal(viewport.layoutMode, "wide", viewport.id);
      assert.equal(viewport.railVisible, true, viewport.id);
      assert.equal(viewport.settingsVisibleWithoutOpeningDrawer, true, viewport.id);
      assert.ok(viewport.requiredFirstVisibleSelectors.includes(fixture.selectors.rail), viewport.id);
      assert.ok(viewport.requiredFirstVisibleSelectors.includes(fixture.selectors.settingsItem), viewport.id);
    } else {
      assert.equal(viewport.railVisible, false, viewport.id);
      assert.equal(viewport.settingsVisibleWithoutOpeningDrawer, false, viewport.id);
    }
  }
  assert.equal(fixture.viewports.at(-1).minimumCompleteRowsWhenReady, 1);
  assert.equal(fixture.viewports.at(-1).firstRowStartsInViewport, true);
});

test("navigation order, Settings pinning, and legacy MCP behavior are session-correct", () => {
  assert.deepEqual(fixture.navigation, {
    primaryOrder: ["my-mind", "minds", "public", "invitations"],
    utilityOrder: ["help-optional", "settings"],
    personalMindFirst: true,
    settingsPinnedToBottom: true,
    settingsIsLastUtilityItem: true,
    helpOptional: true,
    helpPositionWhenPresent: "immediately-before-settings",
    helpAbsencePreservesSettingsPin: true,
    drawerRepeatsDesktopOrder: true,
  });
  assert.equal(fixture.navigation.primaryOrder[0], "my-mind");
  assert.equal(fixture.navigation.utilityOrder.at(-1), "settings");
  assertUnique(fixture.routes.map(({ pattern }) => pattern), "route patterns must be unique");

  for (const pattern of [
    "/settings/account",
    "/settings/connections",
    "/settings/connections/{connection_ref}",
    "/settings/developer/mcp",
  ]) assert.equal(route(pattern)?.shellCurrent, "settings", pattern);
  assert.equal(route("/help/codex")?.shellCurrent, "help-optional");

  const legacy = route("/settings/mcp");
  assertExactKeys(legacy.behaviorBySession, ["signed_out", "registered"], "legacy session matrix drifted");
  assert.deepEqual(legacy.behaviorBySession.signed_out, {
    kind: "safe_sign_in_shell",
    status: 200,
    routeAgnostic: true,
    targetMetadataAllowed: false,
  });
  assert.deepEqual(legacy.behaviorBySession.registered, {
    kind: "redirect",
    status: 308,
    location: "/settings/developer/mcp",
  });
});

test("Settings IA keeps stable children, optional Help, and state-free direct routes", () => {
  const settings = fixture.settingsInformationArchitecture;
  assertExactKeys(settings, [
    "entryRoute",
    "contextOrder",
    "children",
    "codexHelp",
    "directNavigation",
    "legacyMcp",
    "forbiddenState",
  ], "Settings IA contract drifted");
  assert.equal(settings.entryRoute, "/settings/account");
  assert.deepEqual(settings.contextOrder, ["account", "connections", "advanced-mcp"]);
  assert.deepEqual(
    settings.contextOrder.map((id) => settings.children[id].route),
    ["/settings/account", "/settings/connections", "/settings/developer/mcp"],
  );
  assert.deepEqual(
    settings.contextOrder.map((id) => settings.children[id].label),
    ["Account", "Connections", "Advanced MCP"],
  );
  assert.equal(settings.codexHelp.route, "/help/codex");
  assert.equal(settings.codexHelp.placement, "utility-before-settings");
  assert.equal(settings.codexHelp.settingsChild, false);
  assert.equal(
    settings.codexHelp.availability,
    "registered-shell-independent-of-connection-state",
  );
  assert.deepEqual(
    settings.codexHelp.connectionStates,
    ["loading", "empty", "ready", "error", "revoked", "reconnected"],
  );
  assert.deepEqual(settings.directNavigation.canonicalRoutes, [
    "/settings/account",
    "/settings/connections",
    "/settings/developer/mcp",
    "/help/codex",
  ]);
  assert.equal(settings.directNavigation.forcedWizard, false);
  assert.equal(settings.directNavigation.requiresCodexConnection, false);
  assert.equal(settings.directNavigation.browserBackPreservesPreviousRoute, true);
  assert.deepEqual(settings.legacyMcp, {
    route: "/settings/mcp",
    registeredStatus: 308,
    registeredLocation: "/settings/developer/mcp",
    signedOutBehavior: "route-agnostic-sign-in-shell",
    duplicateNavigation: false,
  });
  assert.deepEqual(
    settings.forbiddenState,
    ["setup-complete", "checklist-progress", "dismissed-help", "nag-count"],
  );
  assert.doesNotMatch(
    settingsImplementation,
    /(?:localStorage|sessionStorage|setup[_-]complete|onboarding[_-](?:state|progress)|nag[_-](?:count|state)|dismissed[_-]help)/u,
  );
});

test("session and account state matrices are closed and fail safe", () => {
  assertExactKeys(fixture.sessionStates, [
    "signed_out",
    "registration_required",
    "bootstrapping",
    "bootstrap_error",
    "registered",
  ], "session state matrix drifted");
  for (const [id, state] of Object.entries(fixture.sessionStates)) {
    assertExactKeys(state, [
      "shell",
      "applicationNavigation",
      "ariaBusy",
      "primaryAction",
      "targetMetadataAllowed",
      "requiredRegions",
      "forbiddenRegions",
      "expectedEffect",
    ], `${id}: session contract drifted`);
    assertEffect(state.expectedEffect, id);
    assert.ok(state.requiredRegions.length >= 4, id);
    assert.ok(state.forbiddenRegions.length >= 3, id);
  }
  assert.equal(fixture.sessionStates.signed_out.applicationNavigation, false);
  assert.equal(fixture.sessionStates.signed_out.targetMetadataAllowed, false);
  assert.equal(fixture.sessionStates.registration_required.primaryAction, "create-isolated-account");
  assert.equal(fixture.sessionStates.bootstrapping.ariaBusy, true);
  assert.ok(fixture.sessionStates.bootstrap_error.forbiddenRegions.includes("new-bootstrap-attempt"));
  assert.equal(fixture.sessionStates.registered.applicationNavigation, true);

  assertExactKeys(fixture.accountStates, [
    "profile_idle",
    "profile_saving",
    "profile_saved",
    "profile_error",
    "profile_conflict",
    "deletion_impact_loading",
    "deletion_impact_ready",
    "deletion_impact_changed_or_expired",
    "deleting",
  ], "account state matrix drifted");
  for (const [id, state] of Object.entries(fixture.accountStates)) {
    assertExactKeys(state, [
      "allowedActions",
      "forbiddenActions",
      "ariaBusy",
      "expectedEffect",
    ], `${id}: account contract drifted`);
    assertEffect(state.expectedEffect, id);
    assertUnique(state.allowedActions, `${id}:allowed actions`);
    assertUnique(state.forbiddenActions, `${id}:forbidden actions`);
  }
  assert.deepEqual(fixture.accountStates.profile_conflict.allowedActions, ["reload-authoritative-profile"]);
  assert.ok(fixture.accountStates.profile_conflict.forbiddenActions.includes("replay-stale-command"));
  assert.deepEqual(fixture.accountStates.deletion_impact_loading.allowedActions, []);
  assert.ok(fixture.accountStates.deletion_impact_ready.forbiddenActions.includes("delete-without-exact-confirmation"));
  assert.deepEqual(fixture.accountStates.deleting.allowedActions, []);
  assert.equal(fixture.accountStates.deleting.ariaBusy, true);
});

test("unknown, reserved, unauthorized, and signed-out routes cannot leak target data", () => {
  assertExactKeys(fixture.routeSafetyStates, ["unknown", "reserved", "unauthorized"], "safe route states drifted");
  const expectedForbidden = ["target-name", "target-summary", "membership", "visibility", "existence-signal"];
  for (const [id, state] of Object.entries(fixture.routeSafetyStates)) {
    assertExactKeys(state, [
      "session",
      "httpStatus",
      "renderedState",
      "shellCurrent",
      "targetMetadataAllowed",
      "forbiddenFields",
      "expectedEffect",
    ], `${id}: route safety contract drifted`);
    assert.equal(state.session, "registered", id);
    assert.equal(state.httpStatus, 404, id);
    assert.equal(state.renderedState, "not_found_or_forbidden", id);
    assert.equal(state.shellCurrent, null, id);
    assert.equal(state.targetMetadataAllowed, false, id);
    assert.deepEqual(state.forbiddenFields, expectedForbidden, id);
    assertEffect(state.expectedEffect, id);
  }
  assert.deepEqual(fixture.privacy.safeRouteStateIds, ["unknown", "reserved", "unauthorized"]);
  assert.ok(fixture.privacy.forbiddenInApplicationShell.includes("principal_id"));
  assert.ok(fixture.privacy.forbiddenInApplicationShell.includes("memory_body"));
  assert.ok(fixture.privacy.signedOutForbiddenSelectors.includes(fixture.selectors.shell));
  assert.ok(fixture.privacy.signedOutForbiddenSelectors.includes("[data-ia-target-metadata]"));
  assert.deepEqual(fixture.privacy.untrustedText, {
    htmlEscaped: true,
    maySelectRouteAuthority: false,
    maySelectCssClass: false,
    mustNotExecute: true,
  });
});

test("destructive and disclosure contracts pin adjacency, confirmation, and effects", () => {
  assertExactKeys(fixture.destructiveFlows, ["account-delete", "mind-delete", "connection-revoke"], "destructive flows drifted");
  for (const [id, flow] of Object.entries(fixture.destructiveFlows)) {
    assertExactKeys(flow, [
      "routePattern",
      "samePanel",
      "orderedSelectors",
      "actionGate",
      "expectedEffect",
    ], `${id}: destructive contract drifted`);
    assert.equal(flow.samePanel, true, id);
    assert.ok([
      "fresh-impact-and-exact-confirmation",
      "explicit-confirmation",
    ].includes(flow.actionGate), id);
    assert.equal(flow.orderedSelectors.length, 4, id);
    assert.match(flow.orderedSelectors.at(-1), /\[data-ia-destructive-action=/u, id);
    assert.ok(flow.orderedSelectors.some((selector) => selector.includes("data-ia-confirmation")), id);
    assertUnique(flow.orderedSelectors, id);
    assertEffect(flow.expectedEffect, id);
  }
  assert.match(fixture.destructiveFlows["account-delete"].orderedSelectors[0], /account-delete/u);
  assert.equal(fixture.destructiveFlows["account-delete"].actionGate, "fresh-impact-and-exact-confirmation");
  assert.equal(fixture.destructiveFlows["mind-delete"].actionGate, "fresh-impact-and-exact-confirmation");
  assert.match(fixture.destructiveFlows["connection-revoke"].orderedSelectors[0], /access-summary/u);
  assert.equal(fixture.destructiveFlows["connection-revoke"].actionGate, "explicit-confirmation");

  assertExactKeys(fixture.disclosures, ["uat", "personal-mind", "visibility", "advanced-mcp"], "disclosure matrix drifted");
  for (const [id, disclosure] of Object.entries(fixture.disclosures)) {
    assert.match(disclosure.selector, /^\[data-ia-/u, id);
    assertEffect(disclosure.expectedEffect, id);
  }
  assert.equal(fixture.disclosures["personal-mind"].adjacentTo, fixture.selectors.pageHeader);
  assert.equal(fixture.disclosures.visibility.mustPrecede, "[data-ia-visibility-action]");
  assert.ok(fixture.disclosures["advanced-mcp"].mustNotAppearIn.includes("primary-navigation"));
});

test("focus, landmarks, headings, forced colors, and reduced motion stay explicit", () => {
  assertExactKeys(fixture.accessibility.landmarks, [
    "main",
    "primaryNavigation",
    "utilityNavigation",
    "settingsNavigation",
  ], "landmark matrix drifted");
  assert.deepEqual(fixture.accessibility.headings, {
    h1Count: 1,
    majorPanelLevel: 2,
    maximumRowHeadingLevel: 3,
    skippedLevelsAllowed: false,
  });
  assert.equal(fixture.accessibility.landmarks.primaryNavigation.accessibleName, "Primary");
  assert.equal(fixture.accessibility.landmarks.utilityNavigation.accessibleName, "Utility");
  assert.equal(fixture.accessibility.landmarks.settingsNavigation.accessibleName, "Settings sections");
  assert.equal(fixture.accessibility.focus.firstTabSelector, fixture.selectors.skipLink);
  assert.equal(fixture.accessibility.focus.skipTargetSelector, fixture.selectors.main);
  assert.equal(fixture.accessibility.focus.minimumIndicatorPx, 3);
  assert.equal(fixture.accessibility.focus.drawerClosedLinksTabbable, false);
  assert.equal(fixture.accessibility.focus.drawerTrapsFocus, true);
  assert.equal(fixture.accessibility.focus.escapeReturnsToSelector, fixture.selectors.mobileTrigger);
  assert.equal(fixture.accessibility.focus.escapeSubmitsDestructiveAction, false);

  assert.deepEqual(fixture.preferences.forcedColors.requiredVisibleStates, [
    "focus",
    "current-item",
    "row-boundary",
    "dialog-boundary",
    "disclosure-boundary",
  ]);
  assert.equal(fixture.preferences.forcedColors.emulation, "active");
  assert.equal(fixture.preferences.forcedColors.useSystemColors, true);
  assert.equal(fixture.preferences.forcedColors.meaningSurvivesBackgroundRemoval, true);
  assert.deepEqual(fixture.preferences.reducedMotion, {
    emulation: "reduce",
    spatialMotionAllowed: false,
    stateChangeRemainsImmediate: true,
    focusOrderUnchanged: true,
    loopingMotionAllowed: false,
  });
});

test("brand contract closes canonical tokens and forbidden visual flags", () => {
  assert.deepEqual(fixture.brand.canonicalTokens, [
    "ink",
    "paper",
    "memory-plum",
    "living-coral",
    "quiet-brass",
    "quiet-sage",
    "white",
  ]);
  assert.deepEqual(fixture.brand.canonicalAssets, [
    "/brand/mind-diary-lockup.svg",
    "/brand/mind-diary-mark.svg",
  ]);
  assert.equal(fixture.brand.externalFontRequestsAllowed, false);
  assert.equal(fixture.brand.minimumBaseTextPx, 16);
  assert.deepEqual(fixture.brand.smallTextForegroundTokensForbidden, [
    "living-coral",
    "quiet-brass",
    "quiet-sage",
  ]);
  assertUnique(fixture.brand.forbiddenVisualFlags, "forbidden visual flags must be unique");
  for (const flag of ["anatomical-brain", "neon-ai-gradient", "recognizable-franchise-symbol", "looping-glow"]) {
    assert.ok(fixture.brand.forbiddenVisualFlags.includes(flag), flag);
  }
});

test("human specification points to the complete machine contract without widening scope", () => {
  for (const selector of Object.values(fixture.selectors)) {
    const hook = selector.match(/\[([^=\]]+)/u)?.[1];
    assert.ok(hook, selector);
    assert.ok(specification.includes(hook), hook);
  }
  for (const acceptanceId of fixture.acceptanceIds) {
    assert.ok(specification.includes(`| \`${acceptanceId}\` |`), acceptanceId);
  }
  assert.match(specification, /signed-out request[^\n]+route-agnostic sign-in shell/u);
  assert.match(specification, /Task Manager[^\n]+ориентир/u);
  assert.match(specification, /не добавляет corpus viewer\/editor, website AI/u);
  assert.match(specification, /Raw[\s\S]+content[^\n]+не рендерится/u);
});
