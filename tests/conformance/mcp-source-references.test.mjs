import assert from "node:assert/strict";
import test from "node:test";

import { CAPABILITIES } from "@mind-diary/domain";
import { ProductMcpContentApplication } from "../../packages/adapter-mcp/dist/index.js";

const actor = Object.freeze({
  kind: "registered_principal",
  principalId: "principal_source_reference",
  authentication: Object.freeze({
    kind: "mcp_token",
    tokenId: "token_source_reference",
    bindingOwnerId: "grant_source_reference",
    effectiveScopes: Object.freeze(["content:read", "content:write"]),
  }),
  deploymentCapabilities: CAPABILITIES,
  requestId: "request_source_reference",
  occurredAtUtc: "2026-08-30T20:00:00.000Z",
});

function info(mindId, revisionId, contentCapabilities = ["browse"]) {
  const revision = {
    revisionId,
    revisionNumber: 1,
    parentRevisionId: null,
    committedAt: actor.occurredAtUtc,
    committedBy: { kind: "principal", id: actor.principalId },
    summary: "Fixture",
    manifestHash: `sha256:${"a".repeat(64)}`,
    isHead: true,
  };
  return {
    mind: {
      mindId,
      route: `/${mindId}`,
      handle: mindId,
      name: mindId,
      description: "Fixture category",
      isPersonal: false,
      visibility: "private",
      discovery: "membership",
      access: {
        kind: "membership",
        role: "editor",
        capabilities: ["content:read", "content:write"],
      },
      metadataVersion: 1,
      head: revision,
    },
    resolvedRevision: revision,
    revisionMode: "head",
    contentCapabilities,
    indexStatus: {
      status: "ready",
      retryable: false,
      retryAfterMs: null,
      failureCode: null,
    },
  };
}

function argumentsValue(overrides = {}) {
  return {
    mind: "target",
    expected_revision: "revision_target",
    idempotency_key: "source-reference-key",
    summary: "Save discussed synthesis",
    operations: [{
      type: "create_file",
      path: "concepts/synthesis.md",
      text: "---\ntype: Reference\n---\n\nSynthesis.\n",
    }],
    source_references: [{
      mind: "source",
      revision: "revision_source",
      path: "concepts/source.md",
    }],
    ...overrides,
  };
}

function harness({ targetEnabled = true } = {}) {
  const calls = { discovery: [], commit: [], reconcile: [] };
  const application = new ProductMcpContentApplication({
    discovery: {
      async listMinds() { return { minds: [], nextCursor: null }; },
      async resolveMind() { return info("space_target", "revision_target").mind; },
      async getMindInfo(_actor, selector, revisionSelector) {
        calls.discovery.push({ selector, revisionSelector });
        if (selector === "target") {
          if (!targetEnabled) throw new Error("disabled target");
          return info("space_target", "revision_target", ["browse", "commit"]);
        }
        if (
          selector === "source" &&
          revisionSelector?.kind === "revision" &&
          revisionSelector.revisionId === "revision_source"
        ) {
          return info("space_source_internal", "revision_source", ["browse"]);
        }
        throw new Error("unavailable source");
      },
    },
    browse: {
      async browseEntries() { return {}; },
      async listBundleFiles() { return { files: [], diagnostics: [] }; },
      async fetch() { return {}; },
      async readResource() { throw new Error("unused"); },
    },
    search: { async searchEntries() { return {}; } },
    history: { async listRevisions() { return {}; }, async getRevision() { return {}; } },
    validation: { async validateMind() { return {}; } },
    commits: {
      async commit(request) {
        calls.commit.push(request);
        return { kind: "revision_conflict", currentRevisionId: "revision_target" };
      },
    },
    ingress: {
      capabilities() { return []; },
      async reconcileStage() { return { kind: "missing" }; },
      async reconcileCommit(request) {
        calls.reconcile.push(request);
        return { kind: "missing" };
      },
    },
    bundleFileDownloads: { async issue() { return {}; } },
  });
  return { application, calls };
}

test("disabled write target returns writable_mind_required without commit or fallback", async () => {
  const env = harness({ targetEnabled: false });
  const { source_references: _sourceReferences, ...argumentsWithoutSources } = argumentsValue();
  const result = await env.application.executeToolCall({
    actor,
    name: "commit_changeset",
    arguments: argumentsWithoutSources,
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "writable_mind_required");
  assert.equal(env.calls.commit.length, 0);
  assert.deepEqual(env.calls.discovery, [{
    selector: "target",
    revisionSelector: { kind: "head" },
  }]);
});

test("commit and reconciliation resolve exact enabled source references to internal authorization assertions", async () => {
  const env = harness();
  const commit = await env.application.executeToolCall({
    actor,
    name: "commit_changeset",
    arguments: argumentsValue(),
  });
  assert.equal(commit.isError, true);
  assert.deepEqual(env.calls.commit[0].sourceReferences, [{
    spaceId: "space_source_internal",
    revisionId: "revision_source",
    path: "concepts/source.md",
  }]);

  const reconcile = await env.application.executeToolCall({
    actor,
    name: "reconcile_changeset",
    arguments: argumentsValue(),
  });
  assert.equal(reconcile.isError, false);
  assert.deepEqual(env.calls.reconcile[0].sourceReferences, env.calls.commit[0].sourceReferences);
  assert.equal(JSON.stringify(commit).includes("space_source_internal"), false);
  assert.equal(JSON.stringify(reconcile).includes("space_source_internal"), false);
});

test("source references are strict, bounded, and fail closed before commit", async () => {
  const env = harness();
  for (const sourceReferences of [
    [{ mind: "source", revision: "revision_source", path: "concepts/source.md", extra: true }],
    Array.from({ length: 9 }, () => ({
      mind: "source",
      revision: "revision_source",
      path: "concepts/source.md",
    })),
  ]) {
    const result = await env.application.executeToolCall({
      actor,
      name: "commit_changeset",
      arguments: argumentsValue({ source_references: sourceReferences }),
    });
    assert.equal(result.structuredContent.error.code, "invalid_request");
  }
  assert.equal(env.calls.commit.length, 0);

  const unavailable = await env.application.executeToolCall({
    actor,
    name: "commit_changeset",
    arguments: argumentsValue({
      source_references: [{
        mind: "disabled-source",
        revision: "revision_source",
        path: "concepts/source.md",
      }],
    }),
  });
  assert.equal(unavailable.structuredContent.error.code, "mind_not_found");
  assert.equal(env.calls.commit.length, 0);
});
