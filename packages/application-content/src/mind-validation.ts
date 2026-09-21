import type { ActorContext } from "@mind-diary/application-contracts";
import {
  CapabilityAuthorizer,
  ObjectStoreFailure,
  REVISION_MANIFEST_MEDIA_TYPE,
  type AuthorizationDecision,
  type Authorizer,
  type CredentialContentAccessAuthorizer,
  type BundleFileObjectStore,
  type ObjectStore,
} from "@mind-diary/application-ports";
import {
  REVISION_MANIFEST_FORMAT_V3,
  REVISION_MANIFEST_FORMAT_V4,
  REVISION_MANIFEST_FORMAT_V5,
  parseRevisionManifest,
  revisionEnvelopesEqual,
  serializeRevisionManifest,
  type BundleFileMediaType,
  type RevisionMode,
  type SpaceId,
  type VerifiedSpaceHost,
} from "@mind-diary/domain";
import {
  validateOkfBundle,
  type OkfDiagnostic,
  type OkfVersion,
} from "@mind-diary/okf-codec";

import {
  MindDiscoveryFailure,
  MindDiscoveryService,
  type MindDiscoveryDescriptor,
  type MindDiscoveryFailureCode,
  type MindDiscoveryRevisionDescriptor,
  type MindDiscoveryStore,
} from "./mind-discovery.js";
import { analyzeBundleFileReferences } from "./bundle-file-references.js";
import { IncrementalSha256 } from "./incremental-sha256.js";
import {
  MARKDOWN_CONSISTENCY_RULES_VERSION,
  analyzeMarkdownConsistency,
  type MarkdownConsistencyDiagnostic,
} from "./markdown-consistency.js";

export const VALIDATION_ISSUE_LIMIT = 100;
export const VALIDATION_RESPONSE_BYTE_BUDGET = 64 * 1024;
export const VALIDATION_MESSAGE_CHARACTER_LIMIT = 320;
export const VALIDATION_PATH_CHARACTER_LIMIT = 512;

const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;
const encoder = new TextEncoder();

async function verifyOpaqueBody(
  body: ReadableStream<Uint8Array>,
  expectedSize: number,
  expectedSha256: string,
): Promise<boolean> {
  const reader = body.getReader();
  const digest = new IncrementalSha256();
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || size + part.value.byteLength > expectedSize) {
        await reader.cancel().catch(() => undefined);
        return false;
      }
      size += part.value.byteLength;
      digest.update(part.value);
    }
    return size === expectedSize && digest.digest() === expectedSha256;
  } finally {
    reader.releaseLock();
  }
}

const MAX_VALIDATION_OBJECT_CONCURRENCY = 8;

type MaterializedValidationEntry =
  | {
      readonly kind: "markdown";
      readonly source: Readonly<{ path: string; bytes: Uint8Array }>;
      readonly referenceMarkdown: Readonly<{ path: string; text: string }> | null;
    }
  | {
      readonly kind: "opaque";
      readonly bundleFile: Readonly<{ path: string; mediaType: BundleFileMediaType }>;
    };

/** Load one exact revision in stable manifest order with a fixed worker cap. */
async function mapBounded<Input, Output>(
  values: readonly Input[],
  operation: (value: Input, index: number) => Promise<Output>,
): Promise<readonly Output[]> {
  const results: Array<PromiseSettledResult<Output> | undefined> =
    new Array(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(MAX_VALIDATION_OBJECT_CONCURRENCY, values.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= values.length) return;
        try {
          results[index] = {
            status: "fulfilled",
            value: await operation(values[index]!, index),
          };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    },
  );
  await Promise.all(workers);
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result?.status === "rejected",
  );
  if (rejected !== undefined) throw rejected.reason;
  return Object.freeze(results.map((result) => {
    if (result?.status !== "fulfilled") {
      throw new MindValidationFailure(
        "revision_integrity_failure",
        "The exact revision failed integrity verification.",
      );
    }
    return result.value;
  }));
}

type AllowedAuthorization = Extract<
  AuthorizationDecision,
  { readonly kind: "allowed" }
>;

export type MindValidationFailureCode =
  | MindDiscoveryFailureCode
  | "invalid_request"
  | "forbidden"
  | "revision_integrity_failure"
  | "read_conflict"
  | "mind_binding_required"
  | "binding_owner_revoked"
  | "binding_state_unavailable";

/** Safe validation failure that never embeds canonical content or private metadata. */
export class MindValidationFailure extends Error {
  readonly code: MindValidationFailureCode;
  readonly retryable: boolean;

  constructor(code: MindValidationFailureCode, message: string, retryable = false) {
    super(message);
    this.name = "MindValidationFailure";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface ValidateMindQuery {
  readonly mind: unknown;
  readonly revisionSelector?: unknown;
  readonly cursor?: unknown;
}

export interface MindValidationIssue {
  readonly severity: "error" | "warning";
  readonly class: "conformance" | "consistency" | "advisory";
  readonly blocksCommit: boolean;
  readonly code: string;
  readonly path: string;
  readonly line?: number;
  readonly field?: string;
  readonly target?: string;
  readonly message: string;
  readonly reason: string;
  readonly recommendation: string;
}

export interface MindValidationIssueCounts {
  readonly conformanceErrors: number;
  readonly consistencyErrors: number;
  readonly qualityWarnings: number;
  readonly advisories: number;
}

export interface MindValidationResult {
  readonly mind: Readonly<MindDiscoveryDescriptor>;
  readonly resolvedRevision: Readonly<MindDiscoveryRevisionDescriptor>;
  readonly revisionMode: RevisionMode;
  readonly readOnly: true;
  readonly valid: boolean;
  readonly commitReady: boolean;
  readonly conformanceErrors: readonly Readonly<MindValidationIssue>[];
  readonly consistencyErrors: readonly Readonly<MindValidationIssue>[];
  readonly qualityWarnings: readonly Readonly<MindValidationIssue>[];
  readonly advisories: readonly Readonly<MindValidationIssue>[];
  readonly issueCounts: Readonly<MindValidationIssueCounts>;
  readonly issuesTruncated: boolean;
  readonly nextCursor: string | null;
  readonly validationComplete: true;
  readonly validationRulesVersion: typeof MARKDOWN_CONSISTENCY_RULES_VERSION;
  readonly validatedOkfVersion: OkfVersion;
}

export interface MindValidationDependencies {
  readonly store: MindDiscoveryStore;
  readonly objects: ObjectStore;
  readonly host: VerifiedSpaceHost;
  readonly authorizer?: Authorizer;
  readonly credentialAccess?: CredentialContentAccessAuthorizer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeQuery(value: unknown): Readonly<ValidateMindQuery> {
  if (!isRecord(value) || !("mind" in value)) {
    throw new MindValidationFailure("invalid_request", "Validation request is invalid.");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !["mind", "revisionSelector", "cursor"].includes(key))) {
    throw new MindValidationFailure("invalid_request", "Validation request is invalid.");
  }
  if (Object.hasOwn(value, "cursor") && typeof value.cursor !== "string") {
    throw new MindValidationFailure("invalid_request", "Validation cursor is invalid.");
  }
  return Object.freeze({
    mind: value.mind,
    ...(Object.hasOwn(value, "revisionSelector")
      ? { revisionSelector: value.revisionSelector }
      : {}),
    ...(Object.hasOwn(value, "cursor") ? { cursor: value.cursor } : {}),
  });
}

function sameAuthorization(
  left: AllowedAuthorization,
  right: AllowedAuthorization,
): boolean {
  const sameGrant =
    left.grant.kind === "membership" && right.grant.kind === "membership"
      ? left.grant.role === right.grant.role
      : left.grant.kind === "baseline_visibility" &&
          right.grant.kind === "baseline_visibility"
        ? left.grant.visibility === right.grant.visibility
        : false;
  return (
    sameGrant &&
    left.stamp.accessVersion === right.stamp.accessVersion &&
    left.stamp.membershipVersion === right.stamp.membershipVersion &&
    left.stamp.tokenVersion === right.stamp.tokenVersion
  );
}

function sanitizeText(value: string, limit: number, fallback: string): string {
  const sanitized = value
    .replace(CONTROL_OR_BIDI, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (sanitized.length === 0) return fallback;
  if (sanitized.length <= limit) return sanitized;
  return `${sanitized.slice(0, Math.max(0, limit - 1))}…`;
}

function sanitizeCode(value: string): string {
  return /^[a-z0-9_:-]{1,80}$/u.test(value) ? value : "validation_issue";
}

function projectIssue(
  issue: Readonly<OkfDiagnostic>,
  issueClass: "conformance" | "advisory",
): Readonly<MindValidationIssue> {
  const line =
    Number.isSafeInteger(issue.line) && (issue.line as number) > 0
      ? (issue.line as number)
      : undefined;
  const field =
    issue.field === undefined
      ? undefined
      : sanitizeText(issue.field, 80, "field");
  return Object.freeze({
    severity: issueClass === "conformance" ? "error" : "warning",
    class: issueClass,
    blocksCommit: true,
    code: sanitizeCode(issue.code),
    path: sanitizeText(issue.path, VALIDATION_PATH_CHARACTER_LIMIT, "<bundle>"),
    ...(line === undefined ? {} : { line }),
    ...(field === undefined ? {} : { field }),
    message: sanitizeText(
      issue.message,
      VALIDATION_MESSAGE_CHARACTER_LIMIT,
      issueClass === "conformance"
        ? "The bundle does not conform to the validation contract."
        : "The bundle has a producer-profile warning.",
    ),
    reason: issueClass === "conformance"
      ? "The exact revision violates the OKF or Mind Diary envelope contract."
      : "The existing strict producer profile treats this quality warning as blocking.",
    recommendation: "Correct the reported file or field, then validate the complete exact revision again.",
  });
}

function projectConsistencyIssue(
  issue: Readonly<MarkdownConsistencyDiagnostic>,
): Readonly<MindValidationIssue> {
  return Object.freeze({
    severity: issue.severity,
    class: issue.class,
    blocksCommit: issue.blocksCommit,
    code: sanitizeCode(issue.code),
    path: sanitizeText(issue.path, VALIDATION_PATH_CHARACTER_LIMIT, "<bundle>"),
    ...(issue.line === undefined ? {} : { line: issue.line }),
    ...(issue.field === undefined
      ? {}
      : { field: sanitizeText(issue.field, 80, "field") }),
    ...(issue.target === undefined
      ? {}
      : { target: sanitizeText(issue.target, VALIDATION_PATH_CHARACTER_LIMIT, "<target>") }),
    message: sanitizeText(issue.message, VALIDATION_MESSAGE_CHARACTER_LIMIT, "Revision consistency issue."),
    reason: sanitizeText(issue.reason, VALIDATION_MESSAGE_CHARACTER_LIMIT, "The exact revision is inconsistent."),
    recommendation: sanitizeText(
      issue.recommendation,
      VALIDATION_MESSAGE_CHARACTER_LIMIT,
      "Correct the issue and validate the exact revision again.",
    ),
  });
}

function issueByteCost(issue: Readonly<MindValidationIssue>): number {
  return encoder.encode(JSON.stringify(issue)).byteLength;
}

function issueCursor(input: Readonly<{
  revisionId: string;
  offset: number;
}>): string {
  const encoded = encoder.encode(JSON.stringify({
    revisionId: input.revisionId,
    rulesVersion: MARKDOWN_CONSISTENCY_RULES_VERSION,
    offset: input.offset,
  }));
  let binary = "";
  for (const byte of encoded) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function cursorOffset(cursor: unknown, revisionId: string, issueCount: number): number {
  if (cursor === undefined) return 0;
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 2048) {
    throw new MindValidationFailure("invalid_request", "Validation cursor is invalid.");
  }
  try {
    const base64 = cursor.replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (
      !isRecord(value) ||
      value.revisionId !== revisionId ||
      value.rulesVersion !== MARKDOWN_CONSISTENCY_RULES_VERSION ||
      !Number.isSafeInteger(value.offset) ||
      (value.offset as number) <= 0 ||
      (value.offset as number) >= issueCount
    ) throw new Error("cursor mismatch");
    return value.offset as number;
  } catch {
    throw new MindValidationFailure("invalid_request", "Validation cursor is invalid.");
  }
}

function boundedIssues(
  issues: readonly Readonly<MindValidationIssue>[],
  offset: number,
  revisionId: string,
): Readonly<{
  conformanceErrors: readonly Readonly<MindValidationIssue>[];
  consistencyErrors: readonly Readonly<MindValidationIssue>[];
  qualityWarnings: readonly Readonly<MindValidationIssue>[];
  advisories: readonly Readonly<MindValidationIssue>[];
  issuesTruncated: boolean;
  nextCursor: string | null;
}> {
  const conformanceErrors: Readonly<MindValidationIssue>[] = [];
  const consistencyErrors: Readonly<MindValidationIssue>[] = [];
  const qualityWarnings: Readonly<MindValidationIssue>[] = [];
  const advisories: Readonly<MindValidationIssue>[] = [];
  let count = 0;
  let bytes = 0;
  for (let index = offset; index < issues.length; index += 1) {
    const issue = issues[index]!;
    const cost = issueByteCost(issue) * (
      issue.class === "advisory" && issue.blocksCommit ? 2 : 1
    );
    if (count >= VALIDATION_ISSUE_LIMIT || bytes + cost > VALIDATION_RESPONSE_BYTE_BUDGET) break;
    if (issue.class === "conformance") conformanceErrors.push(issue);
    else if (issue.class === "consistency") consistencyErrors.push(issue);
    else {
      advisories.push(issue);
      if (issue.blocksCommit) qualityWarnings.push(issue);
    }
    count += 1;
    bytes += cost;
  }
  const nextOffset = offset + count;
  const nextCursor = nextOffset < issues.length
    ? issueCursor({ revisionId, offset: nextOffset })
    : null;
  return Object.freeze({
    conformanceErrors: Object.freeze(conformanceErrors),
    consistencyErrors: Object.freeze(consistencyErrors),
    qualityWarnings: Object.freeze(qualityWarnings),
    advisories: Object.freeze(advisories),
    issuesTruncated: nextCursor !== null,
    nextCursor,
  });
}

function localSourceReferences(frontmatter: Readonly<Record<string, unknown>> | null): readonly string[] {
  if (frontmatter === null || !Array.isArray(frontmatter.sources)) return Object.freeze([]);
  return Object.freeze(frontmatter.sources.flatMap((source) => {
    if (typeof source === "string") return [source];
    if (isRecord(source) && typeof source.resource === "string") return [source.resource];
    return [];
  }));
}

function mapDiscoveryFailure(error: unknown): never {
  if (error instanceof MindDiscoveryFailure) {
    throw new MindValidationFailure(error.code, error.message);
  }
  throw error;
}

/** Read-only strict validation of one authorized exact immutable Mind revision. */
export class MindValidationService {
  readonly #store: MindDiscoveryStore;
  readonly #objects: ObjectStore;
  readonly #discovery: MindDiscoveryService;
  readonly #authorizer: Authorizer;

  constructor(dependencies: MindValidationDependencies) {
    this.#store = dependencies.store;
    this.#objects = dependencies.objects;
    this.#discovery = new MindDiscoveryService({
      store: dependencies.store,
      host: dependencies.host,
      ...(dependencies.credentialAccess === undefined
        ? {}
        : { credentialAccess: dependencies.credentialAccess }),
    });
    this.#authorizer =
      dependencies.authorizer ?? new CapabilityAuthorizer(dependencies.store);
  }

  async validateMind(
    actor: ActorContext,
    queryValue: unknown,
  ): Promise<Readonly<MindValidationResult>> {
    const query = normalizeQuery(queryValue);
    let info;
    try {
      info = await this.#discovery.getMindInfo(
        actor,
        query.mind,
        query.revisionSelector,
      );
    } catch (error) {
      mapDiscoveryFailure(error);
    }

    const spaceId = info.mind.mindId;
    const initialAuthorization = await this.#requireValidationAuthorization(
      actor,
      spaceId,
      info.revisionMode,
      false,
    );
    const envelope = await this.#store.readRevision(
      spaceId,
      info.resolvedRevision.revisionId,
    );
    if (
      envelope === null ||
      envelope.revision.spaceId !== spaceId ||
      envelope.revision.revisionId !== info.resolvedRevision.revisionId ||
      envelope.revision.manifestHash !== info.resolvedRevision.manifestHash
    ) {
      await this.#requireSameValidationAuthorization(
        actor,
        spaceId,
        info.revisionMode,
        initialAuthorization,
      );
      throw new MindValidationFailure(
        "revision_integrity_failure",
        "The exact revision failed integrity verification.",
      );
    }
    let manifest = envelope.manifest;
    try {
      if (
        manifest.format === REVISION_MANIFEST_FORMAT_V3 ||
        manifest.format === REVISION_MANIFEST_FORMAT_V4 ||
        manifest.format === REVISION_MANIFEST_FORMAT_V5
      ) {
        const stored = "getSpaceCanonicalObject" in this.#objects
          ? await (this.#objects as BundleFileObjectStore).getSpaceCanonicalObject(
              "revision_manifest",
              spaceId,
              envelope.revision.manifestHash,
            )
          : null;
        if (
          stored === null || stored.mediaType !== REVISION_MANIFEST_MEDIA_TYPE ||
          (envelope.revision.manifestSize !== undefined &&
            stored.size !== envelope.revision.manifestSize)
        ) throw new Error("missing manifest");
        manifest = parseRevisionManifest(
          new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes),
        );
        if (!revisionEnvelopesEqual({ revision: envelope.revision, manifest }, envelope)) {
          throw new Error("manifest projection mismatch");
        }
      } else {
        const manifestHash = await this.#objects.calculateSha256(
          encoder.encode(serializeRevisionManifest(manifest)),
        );
        if (manifestHash !== envelope.revision.manifestHash) throw new Error("manifest hash");
      }
    } catch {
      await this.#requireSameValidationAuthorization(
        actor,
        spaceId,
        info.revisionMode,
        initialAuthorization,
      );
      throw new MindValidationFailure(
        "revision_integrity_failure",
        "The exact revision failed integrity verification.",
      );
    }

    const materializedEntries: MaterializedValidationEntry[] = [];
    for (let offset = 0; offset < manifest.entries.length; offset += MAX_VALIDATION_OBJECT_CONCURRENCY) {
      const batch = manifest.entries.slice(
        offset,
        offset + MAX_VALIDATION_OBJECT_CONCURRENCY,
      );
      const materializedBatch = await mapBounded(
        batch,
        async (entry): Promise<MaterializedValidationEntry> => {
          if (entry.kind === "opaque") {
            let opened;
            try {
              opened = "openBundleFile" in this.#objects
                ? await (this.#objects as BundleFileObjectStore).openBundleFile(
                    spaceId,
                    entry.sha256,
                  )
                : null;
              if (
                opened === null || opened.sha256 !== entry.sha256 ||
                opened.size !== entry.size ||
                !(await verifyOpaqueBody(opened.body, entry.size, entry.sha256))
              ) throw new MindValidationFailure(
                "revision_integrity_failure",
                "The exact revision failed integrity verification.",
              );
            } catch (error) {
              if (error instanceof MindValidationFailure) throw error;
              if (error instanceof ObjectStoreFailure) {
                throw new MindValidationFailure(
                  "revision_integrity_failure",
                  "The exact revision failed integrity verification.",
                );
              }
              throw error;
            }
            return Object.freeze({
              kind: "opaque" as const,
              bundleFile: Object.freeze({
                path: entry.path,
                mediaType: entry.mediaType,
              }),
            });
          }
          let object;
          try {
            object = (manifest.format === REVISION_MANIFEST_FORMAT_V3 ||
                manifest.format === REVISION_MANIFEST_FORMAT_V4 ||
                manifest.format === REVISION_MANIFEST_FORMAT_V5) &&
                "getSpaceCanonicalObject" in this.#objects
              ? await (this.#objects as BundleFileObjectStore).getSpaceCanonicalObject(
                  "markdown",
                  spaceId,
                  entry.sha256,
                ) ?? await this.#objects.getImmutable(entry.sha256)
              : await this.#objects.getImmutable(entry.sha256);
          } catch (error) {
            if (error instanceof ObjectStoreFailure) {
              throw new MindValidationFailure(
                "revision_integrity_failure",
                "The exact revision failed integrity verification.",
              );
            }
            throw error;
          }
          if (
            object === null ||
            object.sha256 !== entry.sha256 ||
            object.mediaType !== entry.mediaType ||
            object.size !== entry.size ||
            object.bytes.byteLength !== entry.size
          ) {
            throw new MindValidationFailure(
              "revision_integrity_failure",
              "The exact revision failed integrity verification.",
            );
          }
          let bytes: Uint8Array;
          try {
            bytes = new Uint8Array(object.bytes);
            if ((await this.#objects.calculateSha256(bytes)) !== entry.sha256) {
              throw new MindValidationFailure(
                "revision_integrity_failure",
                "The exact revision failed integrity verification.",
              );
            }
          } catch (error) {
            if (error instanceof MindValidationFailure) throw error;
            if (error instanceof ObjectStoreFailure) {
              throw new MindValidationFailure(
                "revision_integrity_failure",
                "The exact revision failed integrity verification.",
              );
            }
            throw error;
          }
          let referenceMarkdown: Readonly<{ path: string; text: string }> | null = null;
          try {
            referenceMarkdown = Object.freeze({
              path: entry.path,
              text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            });
          } catch {
            // The OKF validator reports invalid UTF-8 through its normal envelope.
          }
          return Object.freeze({
            kind: "markdown" as const,
            source: Object.freeze({ path: entry.path, bytes }),
            referenceMarkdown,
          });
        },
      );
      materializedEntries.push(...materializedBatch);
      if (offset + batch.length < manifest.entries.length) {
        await this.#requireSameValidationAuthorization(
          actor,
          spaceId,
          info.revisionMode,
          initialAuthorization,
        );
      }
    }
    await this.#requireSameValidationAuthorization(
      actor,
      spaceId,
      info.revisionMode,
      initialAuthorization,
    );

    const sources: { readonly path: string; readonly bytes: Uint8Array }[] = [];
    const referenceMarkdown: { readonly path: string; readonly text: string }[] = [];
    const bundleFiles: { readonly path: string; readonly mediaType: BundleFileMediaType }[] = [];
    for (const materialized of materializedEntries) {
      if (materialized.kind === "opaque") {
        bundleFiles.push(materialized.bundleFile);
      } else {
        sources.push(materialized.source);
        if (materialized.referenceMarkdown !== null) {
          referenceMarkdown.push(materialized.referenceMarkdown);
        }
      }
    }

    const okfValidation = validateOkfBundle(sources);
    const referenceAnalysis = analyzeBundleFileReferences({
      markdown: referenceMarkdown,
      bundleFiles,
    });
    const parsedByPath = new Map(okfValidation.files.map((file) => [file.path, file] as const));
    const consistency = analyzeMarkdownConsistency({
      markdown: referenceMarkdown.map((document) => {
        const parsed = parsedByPath.get(document.path);
        return Object.freeze({
          ...document,
          sourceReferences: parsed?.kind === "concept"
            ? localSourceReferences(parsed.frontmatter)
            : Object.freeze([]),
        });
      }),
      availablePaths: manifest.entries.map((entry) => entry.path),
      currentSpaceId: spaceId,
      currentRevisionId: info.resolvedRevision.revisionId,
    });
    const referenceErrors = referenceAnalysis.diagnostics.filter(
      (diagnostic) => diagnostic.severity === "error",
    );
    const referenceWarnings = referenceAnalysis.diagnostics.filter(
      (diagnostic) => diagnostic.severity === "warning",
    );
    const allErrors = Object.freeze([
      ...okfValidation.conformanceErrors,
      ...okfValidation.envelopeErrors,
      ...referenceErrors,
    ]);
    const legacyWarnings = Object.freeze([
      ...okfValidation.qualityWarnings.filter((warning) => warning.code !== "broken_cross_link"),
      ...referenceWarnings,
    ]);
    const projected = Object.freeze([
      ...allErrors.map((issue) => projectIssue(issue, "conformance")),
      ...consistency.consistencyErrors.map(projectConsistencyIssue),
      ...legacyWarnings.map((issue) => projectIssue(issue, "advisory")),
      ...consistency.advisories.map(projectConsistencyIssue),
    ].sort((left, right) =>
      Number(right.blocksCommit) - Number(left.blocksCommit) ||
      left.class.localeCompare(right.class) ||
      left.path.localeCompare(right.path) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      left.code.localeCompare(right.code) ||
      (left.target ?? "").localeCompare(right.target ?? "")));
    const offset = cursorOffset(
      query.cursor,
      info.resolvedRevision.revisionId,
      projected.length,
    );
    const bounded = boundedIssues(projected, offset, info.resolvedRevision.revisionId);
    const commitReady = projected.every((issue) => !issue.blocksCommit);
    return Object.freeze({
      mind: info.mind,
      resolvedRevision: info.resolvedRevision,
      revisionMode: info.revisionMode,
      readOnly: true,
      valid:
        okfValidation.valid &&
        referenceErrors.length === 0 &&
        consistency.consistencyErrors.length === 0,
      commitReady,
      conformanceErrors: bounded.conformanceErrors,
      consistencyErrors: bounded.consistencyErrors,
      qualityWarnings: bounded.qualityWarnings,
      advisories: bounded.advisories,
      issueCounts: Object.freeze({
        conformanceErrors: allErrors.length,
        consistencyErrors: consistency.consistencyErrors.length,
        qualityWarnings: legacyWarnings.length,
        advisories: legacyWarnings.length + consistency.advisories.length,
      }),
      issuesTruncated: bounded.issuesTruncated,
      nextCursor: bounded.nextCursor,
      validationComplete: true,
      validationRulesVersion: MARKDOWN_CONSISTENCY_RULES_VERSION,
      validatedOkfVersion: okfValidation.version,
    });
  }

  async #requireValidationAuthorization(
    actor: ActorContext,
    spaceId: SpaceId,
    revisionMode: RevisionMode,
    concealCapabilityDenial: boolean,
  ): Promise<AllowedAuthorization> {
    try {
      await this.#discovery.requireEnabledMindUsage(actor, spaceId);
    } catch (error) {
      if (error instanceof MindDiscoveryFailure) {
        throw new MindValidationFailure("mind_not_found", "Mind was not found.");
      }
      throw error;
    }
    const decision = await this.#authorizer.authorize({
      actor,
      spaceId,
      capability: "content:validate",
      revisionMode,
    });
    if (decision.kind === "allowed") return decision;
    if (
      decision.code === "mind_binding_required" ||
      decision.code === "binding_owner_revoked" ||
      decision.code === "binding_state_unavailable"
    ) {
      throw new MindValidationFailure(
        decision.code,
        "The current MCP credential cannot use this Mind binding.",
        decision.retryable,
      );
    }
    if (decision.code === "authorization_state_changed") {
      throw new MindValidationFailure(
        "read_conflict",
        "Mind binding changed during validation; retry from a fresh descriptor.",
        true,
      );
    }
    if (
      !concealCapabilityDenial &&
      (decision.code === "capability_denied" ||
        decision.code === "insufficient_scope" ||
        decision.code === "deployment_capability_disabled")
    ) {
      throw new MindValidationFailure(
        "forbidden",
        "Mind validation is not allowed.",
      );
    }
    throw new MindValidationFailure("mind_not_found", "Mind was not found.");
  }

  async #requireSameValidationAuthorization(
    actor: ActorContext,
    spaceId: SpaceId,
    revisionMode: RevisionMode,
    expected: AllowedAuthorization,
  ): Promise<void> {
    const current = await this.#requireValidationAuthorization(
      actor,
      spaceId,
      revisionMode,
      true,
    );
    if (!sameAuthorization(expected, current)) {
      throw new MindValidationFailure(
        "read_conflict",
        "Mind access changed during validation; retry from a fresh descriptor.",
        true,
      );
    }
  }
}
