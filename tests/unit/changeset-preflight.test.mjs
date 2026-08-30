import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CanonicalRevisionCoordinator,
  ChangesetPreflightService,
  DEFAULT_CHANGESET_PREFLIGHT_LIMITS,
} from "../../packages/application-content/dist/index.js";
import { CapabilityAuthorizer } from "../../packages/application-ports/dist/index.js";
import { InMemoryRevisionMetadataStore } from "../../packages/adapter-metadata-memory/dist/index.js";
import { InMemoryObjectStore } from "../../packages/adapter-object-memory/dist/index.js";
import {
  CAPABILITIES,
  MARKDOWN_MEDIA_TYPE,
  version,
} from "../../packages/domain/dist/index.js";
import {
  FIXED_NOW,
  MINDS,
  PRINCIPALS,
  REVISION_AUTHORS,
  REVISIONS,
} from "@mind-diary/test-fixtures";

const FUTURE = "2026-11-03T12:00:00.000Z";
const TOKEN_ID = "token_changeset_preflight";
const ENCODER = new TextEncoder();

const BASE_FILES = Object.freeze([
  Object.freeze({
    path: "concepts/baseline.md",
    text: "---\ntype: Reference\ntitle: Baseline\n---\n\n# Baseline\n",
  }),
  Object.freeze({
    path: "concepts/delete.md",
    text: "---\ntype: Reference\ntitle: Delete me\n---\n\n# Delete me\n",
  }),
  Object.freeze({
    path: "concepts/replace.md",
    text: "---\ntype: Reference\ntitle: Replace me\n---\n\n# Replace me\n",
  }),
  Object.freeze({
    path: "index.md",
    text: "---\nokf_version: \"0.2\"\n---\n\n# Fixture Mind\n",
  }),
  Object.freeze({
    path: "log.md",
    text: "# Fixture Log\n\n## 2026-08-06\n\n- **Create**: Seeded fixture.\n",
  }),
]);

function digest(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function actor() {
  return {
    kind: "registered_principal",
    principalId: PRINCIPALS.editor.principalId,
    authentication: { kind: "mcp_token", tokenId: TOKEN_ID },
    deploymentCapabilities: CAPABILITIES,
    requestId: "request_changeset_preflight",
    occurredAtUtc: FIXED_NOW,
  };
}

function currentAuthorizationState({
  role = "editor",
  visibility = "private",
  membership = true,
  scopes = ["content:read", "content:write"],
} = {}) {
  return {
    principal: {
      principalId: PRINCIPALS.editor.principalId,
      state: "active",
    },
    space: {
      spaceId: MINDS.ordinary.spaceId,
      state: "active",
      visibility,
      accessVersion: version(1),
    },
    membership: membership
      ? {
          principalId: PRINCIPALS.editor.principalId,
          spaceId: MINDS.ordinary.spaceId,
          role,
          state: "active",
          version: version(1),
        }
      : null,
    token: {
      tokenId: TOKEN_ID,
      principalId: PRINCIPALS.editor.principalId,
      state: "active",
      scopes,
      version: version(1),
      expiresAt: FUTURE,
    },
  };
}

async function fixture(options = {}) {
  const events = [];
  const objects = new InMemoryObjectStore();
  const metadata = new InMemoryRevisionMetadataStore();
  const coordinator = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  const seeded = await coordinator.commit({
    spaceId: MINDS.ordinary.spaceId,
    expectedRevisionId: null,
    revisionId: REVISIONS.initial.revisionId,
    committedAt: REVISIONS.initial.committedAt,
    committedBy: REVISION_AUTHORS.active,
    summary: "Seed changeset preflight fixture",
    files: (options.baseFiles ?? BASE_FILES).map((file) => ({
      path: file.path,
      mediaType: MARKDOWN_MEDIA_TYPE,
      bytes: ENCODER.encode(file.text),
    })),
  });
  assert.equal(seeded.kind, "committed");

  const authorizationState = currentAuthorizationState(options.authorization);
  const authorizer = new CapabilityAuthorizer({
    async readCurrentAuthorizationState() {
      events.push("authorize");
      return structuredClone(authorizationState);
    },
  });
  const revisions = {
    async readHeadRevision(spaceId) {
      events.push("content:read");
      return coordinator.readHeadRevision(spaceId);
    },
  };
  const service = new ChangesetPreflightService({
    authorizer,
    revisions,
    clock: { now: () => options.now ?? FIXED_NOW },
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  const request = (operations, overrides = {}) => ({
    actor: actor(),
    spaceId: MINDS.ordinary.spaceId,
    revisionMode: "head",
    expectedRevisionId: REVISIONS.initial.revisionId,
    operations,
    ...overrides,
  });
  const snapshot = async () => {
    const materialized = await coordinator.materialize(
      MINDS.ordinary.spaceId,
      REVISIONS.initial.revisionId,
    );
    return {
      head: await metadata.readHead(MINDS.ordinary.spaceId),
      revisions: (await metadata.listRevisions(MINDS.ordinary.spaceId)).length,
      files: materialized.files.map((file) => [file.path, file.text]),
    };
  };
  return { service, request, events, snapshot };
}

function validCreate(path = "concepts/new.md") {
  return {
    type: "create_file",
    path,
    text: "---\ntype: Reference\ntitle: New\n---\n\n# New\n",
  };
}

test("literal tagged operations produce a fully conformant candidate without writes", async () => {
  const env = await fixture();
  const before = await env.snapshot();
  const replacement =
    "---\ntype: Reference\ntitle: Replaced\n---\n\n# Replaced\n";
  const index =
    "---\nokf_version: \"0.2\"\n---\n\n# Fixture Mind\n\n- [New](concepts/new.md)\n";
  const result = await env.service.preflight(
    env.request([
      validCreate(),
      {
        type: "replace_file",
        path: "concepts/replace.md",
        text: replacement,
        expected_sha256: digest(BASE_FILES[2].text),
      },
      {
        type: "delete_file",
        path: "concepts/delete.md",
        expected_sha256: digest(BASE_FILES[1].text),
      },
      {
        type: "replace_index",
        path: "index.md",
        text: index,
        expected_sha256: digest(BASE_FILES[3].text),
      },
    ]),
  );

  assert.equal(result.kind, "ready");
  assert.equal(result.validation.valid, true);
  assert.equal(result.validation.conforms, true);
  assert.deepEqual(
    result.candidateFiles.map((file) => file.path),
    ["concepts/baseline.md", "concepts/new.md", "concepts/replace.md", "index.md", "log.md"],
  );
  assert.equal(
    result.candidateFiles.find((file) => file.path === "concepts/replace.md").text,
    replacement,
  );
  assert.equal(result.candidateFiles.some((file) => file.path === "concepts/delete.md"), false);
  assert.deepEqual(env.events, ["authorize", "content:read"]);
  assert.deepEqual(await env.snapshot(), before);
});

test("add_log_entry semantically inserts newest-first in the server UTC date group", async () => {
  const env = await fixture();
  const before = await env.snapshot();
  const result = await env.service.preflight(
    env.request([
      {
        type: "add_log_entry",
        path: "log.md",
        category: "Update",
        message: "Added the [new concept](concepts/new.md).",
      },
    ]),
  );

  assert.equal(result.kind, "ready");
  assert.equal(result.operations[0].type, "add_log_entry");
  assert.equal(result.validation.valid, true);
  assert.equal(
    result.candidateFiles.find((file) => file.path === "log.md").text,
    "# Fixture Log\n\n## 2026-08-06\n\n- **Update**: Added the [new concept](concepts/new.md).\n- **Create**: Seeded fixture.\n",
  );
  assert.deepEqual(await env.snapshot(), before);
});

test("add_log_entry creates a server-dated group in descending date order", async () => {
  const env = await fixture({ now: "2026-08-07T00:00:00.000Z" });
  const result = await env.service.preflight(
    env.request([
      {
        type: "add_log_entry",
        path: "log.md",
        category: "Update",
        message: "Started the next UTC day.",
      },
    ]),
  );

  assert.equal(result.kind, "ready");
  assert.equal(result.validation.valid, true);
  assert.equal(
    result.candidateFiles.find((file) => file.path === "log.md").text,
    "# Fixture Log\n\n## 2026-08-07\n\n- **Update**: Started the next UTC day.\n\n## 2026-08-06\n\n- **Create**: Seeded fixture.\n",
  );
});

test("add_log_entry rejects a non-canonical existing log without exposing a candidate", async () => {
  const malformedFiles = BASE_FILES.map((file) =>
    file.path === "log.md"
      ? { ...file, text: "# Fixture Log\n\n## not-a-date\n\n- Broken.\n" }
      : file,
  );
  const env = await fixture({ baseFiles: malformedFiles });
  const before = await env.snapshot();
  const result = await env.service.preflight(
    env.request([
      {
        type: "add_log_entry",
        path: "log.md",
        category: "Update",
        message: "Must not repair invalid input implicitly.",
      },
    ]),
  );

  assert.equal(result.kind, "invalid");
  assert.equal(result.error.code, "okf_validation_failed");
  assert.equal("candidateFiles" in result, false);
  assert.deepEqual(await env.snapshot(), before);
});

test("Reader, baseline Reader and read-only token are denied before target content is read", async () => {
  const cases = [
    { authorization: { role: "reader" }, code: "capability_denied" },
    {
      authorization: { visibility: "public", membership: false },
      code: "capability_denied",
    },
    {
      authorization: { role: "owner", scopes: ["content:read"] },
      code: "insufficient_scope",
    },
  ];

  for (const item of cases) {
    const env = await fixture({ authorization: item.authorization });
    let operationsRead = false;
    const request = env.request(null);
    Object.defineProperty(request, "operations", {
      enumerable: true,
      get() {
        operationsRead = true;
        throw new Error("denied input must not be inspected");
      },
    });
    const result = await env.service.preflight(request);
    assert.equal(result.kind, "denied");
    assert.equal(result.decision.code, item.code);
    assert.equal(operationsRead, false);
    assert.deepEqual(env.events, ["authorize"]);
  }
});

test("active Editor, Admin and Owner with effective write scope can preflight", async () => {
  for (const role of ["editor", "admin", "owner"]) {
    const env = await fixture({ authorization: { role } });
    const result = await env.service.preflight(env.request([validCreate()]));
    assert.equal(result.kind, "ready", role);
    assert.deepEqual(env.events, ["authorize", "content:read"], role);
  }
});

test("historical write target is denied before operation validation or content read", async () => {
  const env = await fixture({ authorization: { role: "owner" } });
  let operationsRead = false;
  const request = env.request(null, { revisionMode: "historical" });
  Object.defineProperty(request, "operations", {
    enumerable: true,
    get() {
      operationsRead = true;
      throw new Error("historical input must not be inspected");
    },
  });

  const result = await env.service.preflight(request);
  assert.equal(result.kind, "denied");
  assert.equal(result.decision.code, "historical_read_only");
  assert.equal(operationsRead, false);
  assert.deepEqual(env.events, ["authorize"]);
});

test("intrinsic invalid operations fail after authorization but before reading content", async () => {
  const cases = [
    [[], "operations_required"],
    [
      [validCreate("concepts/same.md"), validCreate("concepts/same.md")],
      "duplicate_operation_path",
    ],
    [
      [{ type: "replace_file", path: "index.md", text: "# Wrong operation\n" }],
      "reserved_path_requires_special_operation",
    ],
    [
      [{ type: "delete_file", path: "nested/log.md" }],
      "reserved_path_requires_special_operation",
    ],
    [[{ type: "create_file", path: "bundle.zip", text: "bytes" }], "invalid_path"],
    [[{ type: "create_file", path: "asset.png", text: "bytes" }], "invalid_path"],
    [
      [{ type: "upload_asset", path: "concepts/file.md", bytes: [1, 2, 3] }],
      "invalid_operation",
    ],
    [
      [{ type: "create_file", path: "concepts/bad.md", text: "\ud800" }],
      "invalid_utf8",
    ],
    [
      [
        {
          type: "replace_file",
          path: "concepts/replace.md",
          text: BASE_FILES[2].text,
          expected_sha256: "sha256:not-a-digest",
        },
      ],
      "invalid_operation",
    ],
    [
      [
        {
          type: "add_log_entry",
          path: "log.md",
          date: "2000-01-01",
          category: "Update",
          message: "Client dates are forbidden.",
        },
      ],
      "invalid_operation",
    ],
    [
      [
        {
          type: "add_log_entry",
          path: "log.md",
          category: "Update",
          message: "Literal append payloads are forbidden.",
          text: "## 2000-01-01",
        },
      ],
      "invalid_operation",
    ],
    [
      [
        {
          type: "add_log_entry",
          path: "log.md",
          category: "Update\n## 2000-01-01",
          message: "Injected heading",
        },
      ],
      "invalid_operation",
    ],
    [
      [
        {
          type: "add_log_entry",
          path: "log.md",
          category: "Update\u2028Injected",
          message: "No literal newline",
        },
      ],
      "invalid_operation",
    ],
    [
      [
        {
          type: "add_log_entry",
          path: "log.md",
          category: "Update",
          message: "Paragraph\u2029Injected",
        },
      ],
      "invalid_operation",
    ],
  ];

  for (const [operations, code] of cases) {
    const env = await fixture();
    const before = await env.snapshot();
    const result = await env.service.preflight(env.request(operations));
    assert.equal(result.kind, "invalid", code);
    assert.equal(result.error.code, code);
    assert.deepEqual(env.events, ["authorize"]);
    assert.deepEqual(await env.snapshot(), before);
  }
});

test("operation, path, file, changeset and resulting bundle limits are enforced", async () => {
  const tiny = (overrides) => ({
    ...DEFAULT_CHANGESET_PREFLIGHT_LIMITS,
    ...overrides,
  });
  const cases = [
    {
      limits: tiny({ maxOperations: 1 }),
      operations: [validCreate("concepts/one.md"), validCreate("concepts/two.md")],
      code: "operation_limit_exceeded",
      reads: false,
    },
    {
      limits: tiny({ maxPathBytes: 8 }),
      operations: [validCreate("concepts/long.md")],
      code: "path_size_limit_exceeded",
      reads: false,
    },
    {
      limits: tiny({ maxFileBytes: 4 }),
      operations: [validCreate()],
      code: "file_size_limit_exceeded",
      reads: false,
    },
    {
      limits: tiny({ maxChangesetBytes: 16 }),
      operations: [validCreate()],
      code: "changeset_size_limit_exceeded",
      reads: false,
    },
    {
      limits: tiny({ maxLogCategoryBytes: 3 }),
      operations: [
        {
          type: "add_log_entry",
          path: "log.md",
          category: "Four",
          message: "Bounded message",
        },
      ],
      code: "log_category_size_limit_exceeded",
      reads: false,
    },
    {
      limits: tiny({ maxLogMessageBytes: 4 }),
      operations: [
        {
          type: "add_log_entry",
          path: "log.md",
          category: "Ok",
          message: "Large",
        },
      ],
      code: "log_message_size_limit_exceeded",
      reads: false,
    },
    {
      limits: tiny({ maxResultingFiles: BASE_FILES.length }),
      operations: [validCreate()],
      code: "resulting_file_limit_exceeded",
      reads: true,
    },
    {
      limits: tiny({ maxResultingBundleBytes: 10 }),
      operations: [
        {
          type: "delete_file",
          path: "concepts/delete.md",
        },
      ],
      code: "resulting_bundle_size_limit_exceeded",
      reads: true,
    },
  ];

  for (const item of cases) {
    const env = await fixture({ limits: item.limits });
    const result = await env.service.preflight(env.request(item.operations));
    assert.equal(result.kind, "invalid");
    assert.equal(result.error.code, item.code);
    assert.deepEqual(
      env.events,
      item.reads ? ["authorize", "content:read"] : ["authorize"],
    );
  }
});

test("file existence and expected digest checks use the authorized exact HEAD", async () => {
  const cases = [
    [validCreate("concepts/baseline.md"), "file_exists"],
    [
      {
        type: "replace_file",
        path: "concepts/missing.md",
        text: validCreate().text,
      },
      "file_not_found",
    ],
    [{ type: "delete_file", path: "concepts/missing.md" }, "file_not_found"],
    [
      {
        type: "delete_file",
        path: "concepts/delete.md",
        expected_sha256: `sha256:${"0".repeat(64)}`,
      },
      "file_digest_mismatch",
    ],
    [
      {
        type: "replace_index",
        path: "index.md",
        text: BASE_FILES[3].text,
        expected_sha256: `sha256:${"0".repeat(64)}`,
      },
      "file_digest_mismatch",
    ],
  ];

  for (const [operation, code] of cases) {
    const env = await fixture();
    const before = await env.snapshot();
    const result = await env.service.preflight(env.request([operation]));
    assert.equal(result.kind, "invalid");
    assert.equal(result.error.code, code);
    assert.deepEqual(env.events, ["authorize", "content:read"]);
    assert.deepEqual(await env.snapshot(), before);
  }
});

test("stale expected revision returns conflict without validating or publishing a candidate", async () => {
  const env = await fixture();
  const before = await env.snapshot();
  const result = await env.service.preflight(
    env.request([validCreate()], { expectedRevisionId: REVISIONS.next.revisionId }),
  );

  assert.deepEqual(result, {
    kind: "revision_conflict",
    currentRevisionId: REVISIONS.initial.revisionId,
  });
  assert.deepEqual(env.events, ["authorize", "content:read"]);
  assert.deepEqual(await env.snapshot(), before);
});

test("invalid resulting OKF rejects the full candidate and preserves visible state", async () => {
  const env = await fixture();
  const before = await env.snapshot();
  const result = await env.service.preflight(
    env.request([
      {
        type: "replace_file",
        path: "concepts/baseline.md",
        text: "# Missing required frontmatter\n",
      },
    ]),
  );

  assert.equal(result.kind, "invalid");
  assert.equal(result.error.code, "okf_validation_failed");
  assert.ok(result.error.diagnostics.some((issue) => issue.code === "missing_frontmatter"));
  assert.deepEqual(env.events, ["authorize", "content:read"]);
  assert.deepEqual(await env.snapshot(), before);
});

test("producer profile rejects preserved quality warnings while consumer preflight stays permissive", async () => {
  const warningBearing = {
    type: "create_file",
    path: "concepts/generated-warning.md",
    text: "---\ntype: Generated Knowledge\nstatus: reviewed\n---\n\n# Generated warning\n",
  };
  const consumer = await fixture();
  const consumerResult = await consumer.service.preflight(
    consumer.request([warningBearing]),
  );
  assert.equal(consumerResult.kind, "ready");
  assert.deepEqual(
    consumerResult.validation.qualityWarnings.map((issue) => issue.code),
    ["invalid_lifecycle_status"],
  );

  const producer = await fixture();
  const before = await producer.snapshot();
  const producerResult = await producer.service.preflight(
    producer.request([warningBearing], { producerProfile: true }),
  );
  assert.equal(producerResult.kind, "invalid");
  assert.equal(producerResult.error.code, "okf_validation_failed");
  assert.deepEqual(
    producerResult.error.diagnostics.map((issue) => issue.code),
    ["invalid_lifecycle_status"],
  );
  assert.deepEqual(await producer.snapshot(), before);
});
