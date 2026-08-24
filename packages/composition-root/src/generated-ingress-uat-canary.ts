import type {
  ProductSitesIdentityResolution,
  ProductWebCsrf,
} from "@mind-diary/adapter-web";
import {
  GENERATED_ARTIFACT_LIMITS,
  type CanonicalRevisionCoordinator,
  type ChangesetCommitService,
  type GeneratedArtifactProducerPort,
  type McpBearerAuthenticator,
  type MindBindingApplicationService,
  type MindDiscoveryService,
} from "@mind-diary/application-content";
import type {
  CanonicalRevisionEnvelope,
  PrincipalId,
  RevisionId,
  Sha256Digest,
  SpaceId,
  WriteMindBindingId,
} from "@mind-diary/domain";

export const GENERATED_INGRESS_UAT_CANARY_PATH =
  "/api/v1/internal/operators/generated-ingress-canary" as const;

export type ProductSiteDeploymentClass =
  | "unknown"
  | "dev"
  | "uat"
  | "production";

const FIXTURE_PROFILE = "md290-generated-producer-v1";
const ENCODER = new TextEncoder();
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
]);
const PDF = ENCODER.encode(
  "%PDF-1.7\n% Mind Diary MD-290 fixed generated producer fixture\n",
);
const MAX_BODY_BYTES = 4_096;
const SAFE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});
const SETUP_ASSERTIONS = Object.freeze([
  "target.synthetic_private_owner_mind",
  "binding.preexisting_current_generation",
  "negative.foreign_binding_no_head",
  "negative.expired_binding_no_head",
  "negative.mime_no_head",
  "negative.size_no_head",
  "negative.quota_no_head",
  "negative.cancel_no_head",
  "negative.replay_no_head",
  "negative.writer_failure_no_head",
  "stage.bounded_replay_exact",
  "stage.server_stream_exact",
  "commit.atomic_generated_files_and_markdown",
]);
const VERIFY_ASSERTIONS = Object.freeze([
  "persistence.reconstruction_after_redeploy",
  "history.head_and_historical_exact_bytes_sha",
  "binding.current_generation_after_redeploy",
]);

type RegisteredSitesActor = Extract<
  ProductSitesIdentityResolution,
  { readonly kind: "authenticated" }
>["actor"];

type CommitRequest = Parameters<ChangesetCommitService["commit"]>[0];
type CommitResult = Awaited<ReturnType<ChangesetCommitService["commit"]>>;

interface CanaryRevisionStore {
  readHead(spaceId: SpaceId): Promise<RevisionId | null>;
  listRevisions(
    spaceId: SpaceId,
  ): Promise<readonly Readonly<CanonicalRevisionEnvelope>[]>;
}

interface CanaryInput {
  readonly action: "setup" | "verify";
  readonly runNonce: string;
  readonly writeBindingId: string;
  readonly staleWriteBindingId: string | null;
}

interface AuthorizedCanaryTarget {
  readonly sitesActor: RegisteredSitesActor;
  readonly actor: Extract<
    Awaited<ReturnType<McpBearerAuthenticator["authenticate"]>>,
    { readonly kind: "authenticated" }
  >["actor"];
  readonly spaceId: SpaceId;
  readonly writeBindingId: WriteMindBindingId;
  readonly handle: string;
  readonly initialRevisionId: RevisionId;
}

export class GeneratedIngressUatCanaryFailure extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "forbidden"
      | "invalid_request"
      | "canary_target_not_ready"
      | "canary_assertion_failed"
      | "canary_unavailable",
    readonly status: 400 | 403 | 404 | 409 | 503,
  ) {
    super(code);
    this.name = "GeneratedIngressUatCanaryFailure";
  }
}

function fail(
  code: GeneratedIngressUatCanaryFailure["code"],
  status: GeneratedIngressUatCanaryFailure["status"],
): never {
  throw new GeneratedIngressUatCanaryFailure(code, status);
}

function json(status: number, body: Readonly<Record<string, unknown>>): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: SAFE_HEADERS,
  });
}

function errorResponse(
  status: GeneratedIngressUatCanaryFailure["status"],
  code: GeneratedIngressUatCanaryFailure["code"],
): Response {
  return json(status, Object.freeze({
    ok: false,
    error: Object.freeze({ code }),
  }));
}

function notFound(): Response {
  return errorResponse(404, "not_found");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function boundedId(value: unknown): string | null {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
    ? value
    : null;
}

function canaryHandle(runNonce: string): string {
  return `md290-generated-${runNonce}`;
}

function canaryName(runNonce: string): string {
  return `MD-290 Generated Canary ${runNonce}`;
}

function paths(runNonce: string) {
  return Object.freeze({
    bounded: `assets/md290-bounded-${runNonce}.png`,
    generated: `assets/md290-generated-${runNonce}.pdf`,
    markdown: `concepts/md290-generated-${runNonce}.md`,
  });
}

function setupSummary(runNonce: string): string {
  return `MD-290 generated ingress canary setup ${runNonce}`;
}

function advanceSummary(runNonce: string): string {
  return `MD-290 generated ingress canary history ${runNonce}`;
}

function initialMarkdown(runNonce: string): string {
  const fixturePaths = paths(runNonce);
  return [
    "---",
    "type: Reference",
    "title: MD-290 generated ingress canary",
    "---",
    "",
    "# MD-290 generated ingress canary",
    "",
    `![Fixed bounded fixture](../${fixturePaths.bounded})`,
    "",
    `[Fixed server fixture](../${fixturePaths.generated})`,
    "",
  ].join("\n");
}

function advancedMarkdown(runNonce: string): string {
  return `${initialMarkdown(runNonce)}Historical and HEAD materialization must retain exact bytes.\n`;
}

async function digest(bytes: Uint8Array): Promise<Sha256Digest> {
  const copy = Uint8Array.from(bytes);
  const result = new Uint8Array(
    await crypto.subtle.digest("SHA-256", copy.buffer),
  );
  return `sha256:${[...result].map((value) =>
    value.toString(16).padStart(2, "0")).join("")}` as Sha256Digest;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
    fail("invalid_request", 400);
  }
  const reader = request.body?.getReader();
  if (reader === undefined) fail("invalid_request", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      fail("invalid_request", 400);
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("invalid_request", 400);
  }
  if (!isRecord(parsed)) fail("invalid_request", 400);
  return parsed;
}

function parseInput(value: Record<string, unknown>): CanaryInput {
  if (value.action === "setup") {
    if (!exactKeys(value, [
      "action",
      "run_nonce",
      "write_binding_id",
      "stale_write_binding_id",
    ])) fail("invalid_request", 400);
  } else if (value.action === "verify") {
    if (!exactKeys(value, ["action", "run_nonce", "write_binding_id"])) {
      fail("invalid_request", 400);
    }
  } else {
    fail("invalid_request", 400);
  }
  if (typeof value.run_nonce !== "string" || !/^[0-9a-f]{16}$/u.test(value.run_nonce)) {
    fail("invalid_request", 400);
  }
  const writeBindingId = boundedId(value.write_binding_id);
  if (writeBindingId === null) fail("invalid_request", 400);
  const staleWriteBindingId = value.action === "setup"
    ? boundedId(value.stale_write_binding_id)
    : null;
  if (
    value.action === "setup" &&
    (staleWriteBindingId === null || staleWriteBindingId === writeBindingId)
  ) fail("invalid_request", 400);
  return Object.freeze({
    action: value.action,
    runNonce: value.run_nonce,
    writeBindingId,
    staleWriteBindingId,
  });
}

function mcpBearerSecret(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header === null ? null : /^Bearer ([^\s,]+)$/iu.exec(header);
  return match?.[1] ?? null;
}

async function assertNoHeadMutation(
  revisions: CanaryRevisionStore,
  spaceId: SpaceId,
  expected: RevisionId,
): Promise<void> {
  if (await revisions.readHead(spaceId) !== expected) {
    fail("canary_assertion_failed", 409);
  }
}

function stagingCode(result: Awaited<
  ReturnType<GeneratedArtifactProducerPort["stageBoundedInMemory"]>
>): string | null {
  if (result.kind === "invalid") return result.code;
  if (
    result.kind === "denied" &&
    isRecord(result.decision) &&
    typeof result.decision.code === "string"
  ) return result.decision.code;
  return null;
}

export class GeneratedIngressUatCanaryService {
  readonly #operators: ReadonlySet<PrincipalId>;
  readonly #authenticator: McpBearerAuthenticator;
  readonly #bindings: Pick<MindBindingApplicationService, "read">;
  readonly #discovery: Pick<MindDiscoveryService, "getMindInfo">;
  readonly #ingress: GeneratedArtifactProducerPort;
  readonly #commit: (request: CommitRequest) => Promise<CommitResult>;
  readonly #revisions: Pick<CanonicalRevisionCoordinator, "materialize">;
  readonly #revisionStore: CanaryRevisionStore;

  constructor(dependencies: {
    readonly operatorPrincipalIds: ReadonlySet<PrincipalId>;
    readonly authenticator: McpBearerAuthenticator;
    readonly bindings: Pick<MindBindingApplicationService, "read">;
    readonly discovery: Pick<MindDiscoveryService, "getMindInfo">;
    readonly ingress: GeneratedArtifactProducerPort;
    readonly commit: (request: CommitRequest) => Promise<CommitResult>;
    readonly revisions: Pick<CanonicalRevisionCoordinator, "materialize">;
    readonly revisionStore: CanaryRevisionStore;
  }) {
    this.#operators = dependencies.operatorPrincipalIds;
    this.#authenticator = dependencies.authenticator;
    this.#bindings = dependencies.bindings;
    this.#discovery = dependencies.discovery;
    this.#ingress = dependencies.ingress;
    this.#commit = dependencies.commit;
    this.#revisions = dependencies.revisions;
    this.#revisionStore = dependencies.revisionStore;
  }

  allowsSitesActor(actor: RegisteredSitesActor): boolean {
    return this.#operators.has(actor.principalId);
  }

  async #authorize(
    sitesActor: RegisteredSitesActor,
    secret: string | null,
    input: CanaryInput,
  ): Promise<AuthorizedCanaryTarget> {
    if (!this.#operators.has(sitesActor.principalId)) fail("not_found", 404);
    if (secret === null) fail("not_found", 404);
    const authentication = await this.#authenticator.authenticate(
      secret,
      `request_md290_${crypto.randomUUID()}` as never,
    );
    if (
      authentication.kind !== "authenticated" ||
      authentication.actor.principalId !== sitesActor.principalId ||
      !(authentication.actor.authentication.effectiveScopes as readonly string[])
        .includes("content:write")
    ) fail("not_found", 404);
    const actor = authentication.actor;
    const current = await this.#bindings.read({ actor });
    if (
      current.kind !== "ready" ||
      current.bindings.bindingSet.state !== "active" ||
      current.bindings.writeBinding === null ||
      current.bindings.writeBinding.state !== "active" ||
      current.bindings.writeBinding.writeBindingId !== input.writeBindingId
    ) fail("canary_target_not_ready", 409);
    const handle = canaryHandle(input.runNonce);
    const info = await this.#discovery.getMindInfo(actor, `/${handle}`, {
      kind: "head",
    });
    if (
      info.mind.mindId !== current.bindings.writeBinding.spaceId ||
      info.mind.handle !== handle ||
      info.mind.route !== `/${handle}` ||
      info.mind.name !== canaryName(input.runNonce) ||
      info.mind.isPersonal ||
      info.mind.visibility !== "private" ||
      info.mind.access.kind !== "membership" ||
      info.mind.access.role !== "owner" ||
      !info.contentCapabilities.includes("commit")
    ) fail("canary_target_not_ready", 409);
    return Object.freeze({
      sitesActor,
      actor,
      spaceId: info.mind.mindId,
      writeBindingId: input.writeBindingId as WriteMindBindingId,
      handle,
      initialRevisionId: info.mind.head.revisionId,
    });
  }

  async #matchingRevisions(target: AuthorizedCanaryTarget, runNonce: string) {
    const revisions = await this.#revisionStore.listRevisions(target.spaceId);
    const setup = revisions.filter(({ revision }) =>
      revision.summary === setupSummary(runNonce));
    const advanced = revisions.filter(({ revision }) =>
      revision.summary === advanceSummary(runNonce));
    if (setup.length > 1 || advanced.length > 1 || (advanced.length > 0 && setup.length === 0)) {
      fail("canary_assertion_failed", 409);
    }
    return Object.freeze({
      all: revisions,
      setup: setup[0] ?? null,
      advanced: advanced[0] ?? null,
    });
  }

  async #assertMaterialized(
    target: AuthorizedCanaryTarget,
    revisionId: RevisionId,
    markdown: string,
    expectedDigests: Readonly<{ png: Sha256Digest; pdf: Sha256Digest }>,
  ): Promise<void> {
    const fixturePaths = paths(target.handle.slice("md290-generated-".length));
    const revision = await this.#revisions.materialize(target.spaceId, revisionId);
    const bounded = revision.files.find(({ path }) => path === fixturePaths.bounded);
    const generated = revision.files.find(({ path }) => path === fixturePaths.generated);
    const marker = revision.files.find(({ path }) => path === fixturePaths.markdown);
    if (
      bounded?.kind !== "opaque" ||
      bounded.sha256 !== expectedDigests.png ||
      bounded.size !== PNG.byteLength ||
      !equalBytes(bounded.bytes, PNG) ||
      generated?.kind !== "opaque" ||
      generated.sha256 !== expectedDigests.pdf ||
      generated.size !== PDF.byteLength ||
      !equalBytes(generated.bytes, PDF) ||
      marker?.kind !== "markdown" ||
      marker.text !== markdown
    ) fail("canary_assertion_failed", 409);
  }

  async #verifyPrepared(
    target: AuthorizedCanaryTarget,
    runNonce: string,
  ): Promise<Readonly<{ png: Sha256Digest; pdf: Sha256Digest }>> {
    const matching = await this.#matchingRevisions(target, runNonce);
    if (matching.setup === null || matching.advanced === null) {
      fail("canary_target_not_ready", 409);
    }
    const head = await this.#revisionStore.readHead(target.spaceId);
    if (
      head !== matching.advanced.revision.revisionId ||
      matching.advanced.revision.parentRevisionId !==
        matching.setup.revision.revisionId
    ) fail("canary_assertion_failed", 409);
    const expectedDigests = Object.freeze({
      png: await digest(PNG),
      pdf: await digest(PDF),
    });
    await this.#assertMaterialized(
      target,
      matching.setup.revision.revisionId,
      initialMarkdown(runNonce),
      expectedDigests,
    );
    await this.#assertMaterialized(
      target,
      matching.advanced.revision.revisionId,
      advancedMarkdown(runNonce),
      expectedDigests,
    );
    const current = await this.#bindings.read({ actor: target.actor });
    if (
      current.kind !== "ready" ||
      current.bindings.writeBinding?.writeBindingId !== target.writeBindingId ||
      current.bindings.writeBinding.spaceId !== target.spaceId
    ) fail("canary_target_not_ready", 409);
    return expectedDigests;
  }

  async #advanceHistory(
    target: AuthorizedCanaryTarget,
    runNonce: string,
    setupRevisionId: RevisionId,
  ): Promise<void> {
    const fixturePaths = paths(runNonce);
    const result = await this.#commit({
      actor: target.actor,
      spaceId: target.spaceId,
      writeBindingId: target.writeBindingId,
      expectedRevisionId: setupRevisionId,
      idempotencyKey: `md290:${runNonce}:commit:history` as never,
      summary: advanceSummary(runNonce) as never,
      operations: Object.freeze([Object.freeze({
        type: "replace_file" as const,
        path: fixturePaths.markdown,
        text: advancedMarkdown(runNonce),
        expected_sha256: await digest(ENCODER.encode(initialMarkdown(runNonce))),
      })]),
    });
    if (result.kind !== "committed") fail("canary_assertion_failed", 409);
  }

  async #runSetup(
    target: AuthorizedCanaryTarget,
    input: CanaryInput,
  ): Promise<Readonly<Record<string, unknown>>> {
    const existing = await this.#matchingRevisions(target, input.runNonce);
    if (existing.advanced !== null) {
      const digests = await this.#verifyPrepared(target, input.runNonce);
      return Object.freeze({
        status: "awaiting_redeploy",
        fixture_profile: FIXTURE_PROFILE,
        replayed: true,
        fixture_sha256: Object.freeze([digests.png, digests.pdf]),
        assertions: SETUP_ASSERTIONS,
      });
    }
    if (existing.setup !== null) {
      await this.#advanceHistory(
        target,
        input.runNonce,
        existing.setup.revision.revisionId,
      );
      const digests = await this.#verifyPrepared(target, input.runNonce);
      return Object.freeze({
        status: "awaiting_redeploy",
        fixture_profile: FIXTURE_PROFILE,
        replayed: true,
        fixture_sha256: Object.freeze([digests.png, digests.pdf]),
        assertions: SETUP_ASSERTIONS,
      });
    }
    if (existing.all.length !== 1) fail("canary_target_not_ready", 409);
    const initialHead = await this.#revisionStore.readHead(target.spaceId);
    if (initialHead === null || initialHead !== target.initialRevisionId) {
      fail("canary_target_not_ready", 409);
    }
    const common = Object.freeze({
      actor: target.actor,
      spaceId: target.spaceId,
    });
    const foreign = await this.#ingress.stageBoundedInMemory({
      ...common,
      writeBindingId: `foreign-md290-${input.runNonce}`,
      displayFilename: "foreign.png",
      claimedMediaType: "image/png",
      idempotencyKey: `md290:${input.runNonce}:negative:foreign`,
      bytes: PNG,
    });
    if (stagingCode(foreign) !== "write_binding_stale") {
      fail("canary_assertion_failed", 409);
    }
    await assertNoHeadMutation(this.#revisionStore, target.spaceId, initialHead);

    const stale = await this.#ingress.stageBoundedInMemory({
      ...common,
      writeBindingId: input.staleWriteBindingId,
      displayFilename: "stale.png",
      claimedMediaType: "image/png",
      idempotencyKey: `md290:${input.runNonce}:negative:stale`,
      bytes: PNG,
    });
    if (stagingCode(stale) !== "write_binding_stale") {
      fail("canary_assertion_failed", 409);
    }
    await assertNoHeadMutation(this.#revisionStore, target.spaceId, initialHead);

    const mime = await this.#ingress.stageBoundedInMemory({
      ...common,
      writeBindingId: target.writeBindingId,
      displayFilename: "mime.pdf",
      claimedMediaType: "application/pdf",
      idempotencyKey: `md290:${input.runNonce}:negative:mime`,
      bytes: PNG,
    });
    if (stagingCode(mime) !== "bundle_file_media_mismatch") {
      fail("canary_assertion_failed", 409);
    }
    await assertNoHeadMutation(this.#revisionStore, target.spaceId, initialHead);

    const size = await this.#ingress.stageBoundedInMemory({
      ...common,
      writeBindingId: target.writeBindingId,
      displayFilename: "oversized.png",
      claimedMediaType: "image/png",
      idempotencyKey: `md290:${input.runNonce}:negative:size`,
      bytes: new Uint8Array(GENERATED_ARTIFACT_LIMITS.maxBoundedInMemoryBytes + 1),
    });
    if (stagingCode(size) !== "generated_artifact_size_limit_exceeded") {
      fail("canary_assertion_failed", 409);
    }
    await assertNoHeadMutation(this.#revisionStore, target.spaceId, initialHead);

    const cancelledController = new AbortController();
    const cancelled = await this.#ingress.stageServerGenerated({
      ...common,
      writeBindingId: target.writeBindingId,
      displayFilename: "cancelled.pdf",
      claimedMediaType: "application/pdf",
      idempotencyKey: `md290:${input.runNonce}:negative:cancel`,
      signal: cancelledController.signal,
      stream: (async function* () {
        yield PDF.subarray(0, 8);
        cancelledController.abort();
        yield PDF.subarray(8);
      })(),
    });
    if (stagingCode(cancelled) !== "generated_artifact_cancelled") {
      fail("canary_assertion_failed", 409);
    }
    await assertNoHeadMutation(this.#revisionStore, target.spaceId, initialHead);

    const writerFailure = await this.#ingress.stageServerGenerated({
      ...common,
      writeBindingId: target.writeBindingId,
      displayFilename: "writer-failure.pdf",
      claimedMediaType: "application/pdf",
      idempotencyKey: `md290:${input.runNonce}:negative:writer`,
      stream: (async function* () {
        yield PDF.subarray(0, 8);
        throw new Error("fixed-md290-writer-failure");
      })(),
    });
    if (stagingCode(writerFailure) !== "generated_artifact_streaming_unavailable") {
      fail("canary_assertion_failed", 409);
    }
    await assertNoHeadMutation(this.#revisionStore, target.spaceId, initialHead);

    const quota = await this.#commit({
      actor: target.actor,
      spaceId: target.spaceId,
      writeBindingId: target.writeBindingId,
      expectedRevisionId: initialHead,
      idempotencyKey: `md290:${input.runNonce}:commit:quota` as never,
      summary: "MD-290 fixed quota negative" as never,
      operations: Object.freeze(Array.from({ length: 21 }, (_, index) =>
        Object.freeze({
          type: "delete_bundle_file" as const,
          path: `assets/md290-quota-${String(index).padStart(2, "0")}.png`,
        }))),
    });
    if (
      quota.kind !== "invalid" ||
      quota.error.code !== "bundle_file_operation_limit_exceeded"
    ) fail("canary_assertion_failed", 409);
    await assertNoHeadMutation(this.#revisionStore, target.spaceId, initialHead);

    const fixturePaths = paths(input.runNonce);
    const pngDigest = await digest(PNG);
    const pdfDigest = await digest(PDF);
    const boundedRequest = Object.freeze({
      ...common,
      writeBindingId: target.writeBindingId,
      displayFilename: "md290-bounded.png",
      claimedMediaType: "image/png",
      idempotencyKey: `md290:${input.runNonce}:stage:bounded`,
      expectedSize: PNG.byteLength,
      expectedSha256: pngDigest,
      bytes: PNG,
    });
    const bounded = await this.#ingress.stageBoundedInMemory(boundedRequest);
    const replay = await this.#ingress.stageBoundedInMemory(boundedRequest);
    if (
      bounded.kind !== "staged" ||
      replay.kind !== "staged" || !replay.replayed ||
      replay.record.stagedFileId !== bounded.record.stagedFileId ||
      bounded.record.sha256 !== pngDigest
    ) fail("canary_assertion_failed", 409);
    await assertNoHeadMutation(this.#revisionStore, target.spaceId, initialHead);

    const generated = await this.#ingress.stageServerGenerated({
      ...common,
      writeBindingId: target.writeBindingId,
      displayFilename: "md290-generated.pdf",
      claimedMediaType: "application/pdf",
      idempotencyKey: `md290:${input.runNonce}:stage:generated`,
      expectedSize: PDF.byteLength,
      expectedSha256: pdfDigest,
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(PDF.subarray(0, 8));
          controller.enqueue(PDF.subarray(8));
          controller.close();
        },
      }),
    });
    if (generated.kind !== "staged" || generated.record.sha256 !== pdfDigest) {
      fail("canary_assertion_failed", 409);
    }
    await assertNoHeadMutation(this.#revisionStore, target.spaceId, initialHead);
    const committed = await this.#commit({
      actor: target.actor,
      spaceId: target.spaceId,
      writeBindingId: target.writeBindingId,
      expectedRevisionId: initialHead,
      idempotencyKey: `md290:${input.runNonce}:commit:setup` as never,
      summary: setupSummary(input.runNonce) as never,
      operations: Object.freeze([
        Object.freeze({
          type: "create_bundle_file" as const,
          path: fixturePaths.bounded,
          staged_file_id: bounded.record.stagedFileId,
        }),
        Object.freeze({
          type: "create_bundle_file" as const,
          path: fixturePaths.generated,
          staged_file_id: generated.record.stagedFileId,
        }),
        Object.freeze({
          type: "create_file" as const,
          path: fixturePaths.markdown,
          text: initialMarkdown(input.runNonce),
        }),
      ]),
    });
    if (committed.kind !== "committed") fail("canary_assertion_failed", 409);
    await this.#assertMaterialized(
      target,
      committed.envelope.revision.revisionId,
      initialMarkdown(input.runNonce),
      Object.freeze({ png: pngDigest, pdf: pdfDigest }),
    );
    await this.#advanceHistory(
      target,
      input.runNonce,
      committed.envelope.revision.revisionId,
    );
    const digests = await this.#verifyPrepared(target, input.runNonce);
    return Object.freeze({
      status: "awaiting_redeploy",
      fixture_profile: FIXTURE_PROFILE,
      replayed: bounded.replayed || generated.replayed,
      fixture_sha256: Object.freeze([digests.png, digests.pdf]),
      assertions: SETUP_ASSERTIONS,
    });
  }

  async execute(
    sitesActor: RegisteredSitesActor,
    secret: string | null,
    input: CanaryInput,
  ): Promise<Readonly<Record<string, unknown>>> {
    const target = await this.#authorize(sitesActor, secret, input);
    if (input.action === "setup") return this.#runSetup(target, input);
    const digests = await this.#verifyPrepared(target, input.runNonce);
    return Object.freeze({
      status: "verified",
      fixture_profile: FIXTURE_PROFILE,
      fixture_sha256: Object.freeze([digests.png, digests.pdf]),
      assertions: VERIFY_ASSERTIONS,
    });
  }
}

export function createGeneratedIngressUatCanaryHttpHandler(dependencies: {
  readonly applicationOrigin: string;
  readonly deploymentClass: ProductSiteDeploymentClass;
  readonly resolveIdentity: (
    request: Request,
  ) => ProductSitesIdentityResolution | Promise<ProductSitesIdentityResolution>;
  readonly csrf: ProductWebCsrf;
  readonly service: GeneratedIngressUatCanaryService;
}): (request: Request) => Promise<Response | null> {
  const origin = new URL(dependencies.applicationOrigin).origin;
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== GENERATED_INGRESS_UAT_CANARY_PATH) return null;
    if (url.search !== "") return notFound();
    if (dependencies.deploymentClass !== "uat") return notFound();
    let identity: ProductSitesIdentityResolution;
    try {
      identity = await dependencies.resolveIdentity(request);
    } catch {
      return errorResponse(503, "canary_unavailable");
    }
    if (identity.kind === "unavailable") {
      return errorResponse(503, "canary_unavailable");
    }
    if (identity.kind !== "authenticated") return notFound();
    if (!dependencies.service.allowsSitesActor(identity.actor)) return notFound();
    if (request.method !== "POST") return notFound();
    if (
      url.origin !== origin ||
      request.headers.get("origin") !== origin
    ) return errorResponse(403, "forbidden");
    const csrf = request.headers.get("x-csrf-token");
    if (
      csrf === null || csrf.length === 0 || csrf.length > 512 ||
      !(await dependencies.csrf.verify(identity.actor, csrf))
    ) return errorResponse(403, "forbidden");
    try {
      const input = parseInput(await readJson(request));
      const data = await dependencies.service.execute(
        identity.actor,
        mcpBearerSecret(request),
        input,
      );
      return json(200, Object.freeze({ ok: true, data }));
    } catch (error) {
      if (error instanceof GeneratedIngressUatCanaryFailure) {
        return errorResponse(error.status, error.code);
      }
      return errorResponse(503, "canary_unavailable");
    }
  };
}
