import type { McpTokenActorContext } from "@mind-diary/application-contracts";
import type {
  Authorizer,
  MindBindingStore,
} from "@mind-diary/application-ports";
import {
  bindingVersion,
  canonicalMarkdownPath,
  type BindingVersion,
  type RevisionId,
  type SpaceId,
  type WriteMindBindingId,
} from "@mind-diary/domain";
import {
  type ChangesetCommitService,
  type CommitChangesetResult,
} from "./changeset-commit.js";
import type { HeadRevisionReader } from "./index.js";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });
const CAPTURE_KEY = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const SINGLE_LINE = /^[^\u0000-\u001f\u007f\u2028\u2029]+$/u;
const CAPTURE_KINDS = new Set(["fact", "decision", "source_note"]);
const MAX_TITLE_BYTES = 160;
const MAX_DESCRIPTION_BYTES = 320;
const MAX_BODY_BYTES = 8_192;
const MAX_SOURCE_REFS = 8;

export type AutomaticCaptureSourceRef =
  | { readonly kind: "user_statement" }
  | {
      readonly kind: "target_entry";
      readonly revisionId: RevisionId;
      readonly path: string;
    };

export interface AutomaticCaptureRequest {
  readonly actor: McpTokenActorContext;
  readonly spaceId: SpaceId;
  readonly writeBindingId: unknown;
  readonly expectedBindingVersion: unknown;
  readonly expectedRevisionId: unknown;
  readonly idempotencyKey: unknown;
  readonly classification: unknown;
  readonly captureKind: unknown;
  readonly captureKey: unknown;
  readonly title: unknown;
  readonly description: unknown;
  readonly body: unknown;
  readonly sources: unknown;
}

export type AutomaticCaptureResult =
  | {
      readonly kind: "captured";
      readonly path: string;
      readonly previousRevisionId: RevisionId | null;
      readonly revisionId: RevisionId;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "no_op";
      readonly path: string;
      readonly revisionId: RevisionId;
    }
  | {
      readonly kind:
        | "invalid_capture_request"
        | "capture_disabled"
        | "capture_binding_stale"
        | "capture_target_visibility_blocked"
        | "capture_confirmation_required"
        | "capture_conflict"
        | "capture_target_not_ready";
    }
  | Exclude<CommitChangesetResult, { readonly kind: "committed" }>;

interface ValidatedCapture {
  readonly writeBindingId: WriteMindBindingId;
  readonly expectedBindingVersion: BindingVersion;
  readonly expectedRevisionId: RevisionId;
  readonly idempotencyKey: string;
  readonly captureKind: "fact" | "decision" | "source_note";
  readonly captureKey: string;
  readonly title: string;
  readonly description: string;
  readonly body: string;
  readonly sources: readonly AutomaticCaptureSourceRef[];
  readonly path: string;
  readonly text: string;
}

function canonicalUtf8(value: unknown, maxBytes: number, singleLine = false): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (singleLine && !SINGLE_LINE.test(value)) return null;
  const encoded = ENCODER.encode(value);
  if (encoded.byteLength > maxBytes || DECODER.decode(encoded) !== value) return null;
  return value;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function validateSources(value: unknown): readonly AutomaticCaptureSourceRef[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SOURCE_REFS) {
    return null;
  }
  const sources: AutomaticCaptureSourceRef[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const record = item as Readonly<Record<string, unknown>>;
    if (record.kind === "user_statement") {
      if (Object.keys(record).length !== 1) return null;
      sources.push(Object.freeze({ kind: "user_statement" as const }));
      continue;
    }
    if (
      record.kind !== "target_entry" ||
      Object.keys(record).sort().join(",") !== "kind,path,revisionId" ||
      typeof record.revisionId !== "string" ||
      record.revisionId.length === 0 ||
      typeof record.path !== "string"
    ) return null;
    try {
      sources.push(Object.freeze({
        kind: "target_entry" as const,
        revisionId: record.revisionId as RevisionId,
        path: canonicalMarkdownPath(record.path),
      }));
    } catch {
      return null;
    }
  }
  return Object.freeze(sources);
}

function renderCaptureText(input: {
  readonly captureKind: ValidatedCapture["captureKind"];
  readonly captureKey: string;
  readonly title: string;
  readonly description: string;
  readonly body: string;
  readonly sources: readonly AutomaticCaptureSourceRef[];
}): string {
  const sourceLines = input.sources.flatMap((source) => source.kind === "user_statement"
    ? ["    - kind: user_statement"]
    : [
        "    - kind: target_entry",
        `      revision_id: ${yamlString(source.revisionId)}`,
        `      path: ${yamlString(source.path)}`,
      ]);
  return [
    "---",
    "type: Reference",
    `title: ${yamlString(input.title)}`,
    `description: ${yamlString(input.description)}`,
    "status: draft",
    "capture:",
    "  policy: routine_non_sensitive_v1",
    `  kind: ${input.captureKind}`,
    `  key: ${yamlString(input.captureKey)}`,
    "  sources:",
    ...sourceLines,
    "---",
    "",
    `# ${input.title}`,
    "",
    input.body,
    "",
  ].join("\n");
}

function validateCapture(request: Readonly<AutomaticCaptureRequest>): ValidatedCapture | null {
  if (
    request.classification !== "routine_non_sensitive" ||
    typeof request.writeBindingId !== "string" || request.writeBindingId.length === 0 ||
    !Number.isSafeInteger(request.expectedBindingVersion) ||
    (request.expectedBindingVersion as number) < 0 ||
    typeof request.expectedRevisionId !== "string" || request.expectedRevisionId.length === 0 ||
    typeof request.idempotencyKey !== "string" || request.idempotencyKey.length === 0 ||
    typeof request.captureKind !== "string" || !CAPTURE_KINDS.has(request.captureKind) ||
    typeof request.captureKey !== "string" || !CAPTURE_KEY.test(request.captureKey)
  ) return null;
  const title = canonicalUtf8(request.title, MAX_TITLE_BYTES, true);
  const description = canonicalUtf8(request.description, MAX_DESCRIPTION_BYTES, true);
  const body = canonicalUtf8(request.body, MAX_BODY_BYTES);
  const sources = validateSources(request.sources);
  if (title === null || description === null || body === null || sources === null) return null;
  const path = `concepts/captured/${request.captureKey}.md`;
  const captureKind = request.captureKind as ValidatedCapture["captureKind"];
  return Object.freeze({
    writeBindingId: request.writeBindingId as WriteMindBindingId,
    expectedBindingVersion: bindingVersion(request.expectedBindingVersion as number),
    expectedRevisionId: request.expectedRevisionId as RevisionId,
    idempotencyKey: request.idempotencyKey,
    captureKind,
    captureKey: request.captureKey,
    title,
    description,
    body,
    sources,
    path,
    text: renderCaptureText({
      captureKind,
      captureKey: request.captureKey,
      title,
      description,
      body,
      sources,
    }),
  });
}

/** Enforced additive-only automatic capture behind the MCP adapter. */
export class AutomaticCaptureService {
  readonly #authorizer: Authorizer;
  readonly #bindings: MindBindingStore;
  readonly #revisions: HeadRevisionReader;
  readonly #commits: Pick<ChangesetCommitService, "commit">;

  constructor(dependencies: {
    readonly authorizer: Authorizer;
    readonly bindings: MindBindingStore;
    readonly revisions: HeadRevisionReader;
    readonly commits: Pick<ChangesetCommitService, "commit">;
  }) {
    this.#authorizer = dependencies.authorizer;
    this.#bindings = dependencies.bindings;
    this.#revisions = dependencies.revisions;
    this.#commits = dependencies.commits;
  }

  async capture(request: Readonly<AutomaticCaptureRequest>): Promise<AutomaticCaptureResult> {
    const validated = validateCapture(request);
    if (validated === null) return Object.freeze({ kind: "invalid_capture_request" });
    const snapshot = await this.#bindings.readMindBindingSet(
      request.actor.authentication.bindingOwnerId,
      request.actor.principalId,
      request.actor.occurredAtUtc,
    );
    if (
      snapshot === null ||
      snapshot.bindingSet.automaticCaptureMode !== "routine_non_sensitive"
    ) return Object.freeze({ kind: "capture_disabled" });
    const write = snapshot.writeBinding;
    if (
      snapshot.bindingSet.bindingVersion !== validated.expectedBindingVersion ||
      write === null || write.spaceId !== request.spaceId ||
      write.writeBindingId !== validated.writeBindingId ||
      snapshot.bindingSet.captureWriteBindingId !== validated.writeBindingId
    ) return Object.freeze({ kind: "capture_binding_stale" });

    const state = await this.#bindings.readCurrentAuthorizationState({
      principalId: request.actor.principalId,
      spaceId: request.spaceId,
      tokenId: request.actor.authentication.tokenId,
    });
    if (state?.space.visibility !== "private") {
      return Object.freeze({ kind: "capture_target_visibility_blocked" });
    }
    const authorization = await this.#authorizer.authorize({
      actor: request.actor,
      spaceId: request.spaceId,
      capability: "content:write",
      revisionMode: "head",
      bindingRequirement: Object.freeze({
        kind: "automatic_capture",
        writeBindingId: validated.writeBindingId,
        expectedBindingVersion: validated.expectedBindingVersion,
      }),
    });
    if (authorization.kind === "denied") {
      return Object.freeze({ kind: "denied", decision: authorization });
    }

    const head = await this.#revisions.readHeadRevision(request.spaceId);
    if (head === null || !head.files.some((file) => file.path === "log.md")) {
      return Object.freeze({ kind: "capture_target_not_ready" });
    }
    const existing = head.files.find((file) => file.path === validated.path);
    if (existing?.text === validated.text) {
      return Object.freeze({
        kind: "no_op",
        path: validated.path,
        revisionId: head.envelope.revision.revisionId,
      });
    }
    if (existing !== undefined) return Object.freeze({ kind: "capture_conflict" });
    if (head.envelope.revision.revisionId !== validated.expectedRevisionId) {
      return Object.freeze({
        kind: "revision_conflict",
        currentRevisionId: head.envelope.revision.revisionId,
      });
    }
    for (const source of validated.sources) {
      if (
        source.kind === "target_entry" &&
        (source.revisionId !== validated.expectedRevisionId ||
          !head.files.some((file) => file.path === source.path))
      ) return Object.freeze({ kind: "capture_confirmation_required" });
    }

    const committed = await this.#commits.commit({
      actor: request.actor,
      spaceId: request.spaceId,
      writeBindingId: validated.writeBindingId,
      expectedRevisionId: validated.expectedRevisionId,
      idempotencyKey: validated.idempotencyKey,
      summary: `Automatic capture ${validated.captureKey}`,
      automaticCapture: Object.freeze({
        expectedBindingVersion: validated.expectedBindingVersion,
        captureKey: validated.captureKey,
        path: validated.path,
        sourceRefs: validated.sources,
      }),
      operations: Object.freeze([
        Object.freeze({
          type: "create_file" as const,
          path: validated.path,
          text: validated.text,
        }),
        Object.freeze({
          type: "add_log_entry" as const,
          path: "log.md",
          category: "Capture",
          message: `Captured routine Memory at ${validated.path}.`,
        }),
      ]),
    });
    return committed.kind === "committed"
      ? Object.freeze({
          kind: "captured",
          path: validated.path,
          previousRevisionId: committed.previousRevisionId,
          revisionId: committed.envelope.revision.revisionId,
          replayed: committed.replayed,
        })
      : committed;
  }
}
