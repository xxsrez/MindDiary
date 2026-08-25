import type { ActorContext } from "@mind-diary/application-contracts";
import {
  CapabilityAuthorizer,
  ObjectStoreFailure,
  REVISION_MANIFEST_MEDIA_TYPE,
  type AuthorizationDecision,
  type Authorizer,
  type BundleFileObjectStore,
  type ObjectStore,
} from "@mind-diary/application-ports";
import {
  REVISION_MANIFEST_FORMAT_V3,
  REVISION_MANIFEST_FORMAT_V4,
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
}

export interface MindValidationIssue {
  readonly severity: "error" | "warning";
  readonly class: "conformance" | "quality";
  readonly code: string;
  readonly path: string;
  readonly line?: number;
  readonly field?: string;
  readonly message: string;
}

export interface MindValidationIssueCounts {
  readonly conformanceErrors: number;
  readonly qualityWarnings: number;
}

export interface MindValidationResult {
  readonly mind: Readonly<MindDiscoveryDescriptor>;
  readonly resolvedRevision: Readonly<MindDiscoveryRevisionDescriptor>;
  readonly revisionMode: RevisionMode;
  readonly readOnly: true;
  readonly valid: boolean;
  readonly conformanceErrors: readonly Readonly<MindValidationIssue>[];
  readonly qualityWarnings: readonly Readonly<MindValidationIssue>[];
  readonly issueCounts: Readonly<MindValidationIssueCounts>;
  readonly issuesTruncated: boolean;
  readonly validatedOkfVersion: OkfVersion;
}

export interface MindValidationDependencies {
  readonly store: MindDiscoveryStore;
  readonly objects: ObjectStore;
  readonly host: VerifiedSpaceHost;
  readonly authorizer?: Authorizer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeQuery(value: unknown): Readonly<ValidateMindQuery> {
  if (!isRecord(value) || !("mind" in value)) {
    throw new MindValidationFailure("invalid_request", "Validation request is invalid.");
  }
  const keys = Object.keys(value).sort();
  const expected = Object.hasOwn(value, "revisionSelector")
    ? ["mind", "revisionSelector"]
    : ["mind"];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new MindValidationFailure("invalid_request", "Validation request is invalid.");
  }
  return Object.freeze({
    mind: value.mind,
    ...(Object.hasOwn(value, "revisionSelector")
      ? { revisionSelector: value.revisionSelector }
      : {}),
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
  issueClass: "conformance" | "quality",
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
    code: sanitizeCode(issue.code),
    path: sanitizeText(issue.path, VALIDATION_PATH_CHARACTER_LIMIT, "<bundle>"),
    ...(line === undefined ? {} : { line }),
    ...(field === undefined ? {} : { field }),
    message: sanitizeText(
      issue.message,
      VALIDATION_MESSAGE_CHARACTER_LIMIT,
      issueClass === "conformance"
        ? "The bundle does not conform to the validation contract."
        : "The bundle has a quality warning.",
    ),
  });
}

function issueByteCost(issue: Readonly<MindValidationIssue>): number {
  return encoder.encode(JSON.stringify(issue)).byteLength;
}

function boundedIssues(
  errors: readonly Readonly<OkfDiagnostic>[],
  warnings: readonly Readonly<OkfDiagnostic>[],
): Readonly<{
  conformanceErrors: readonly Readonly<MindValidationIssue>[];
  qualityWarnings: readonly Readonly<MindValidationIssue>[];
  issuesTruncated: boolean;
}> {
  const conformanceErrors: Readonly<MindValidationIssue>[] = [];
  const qualityWarnings: Readonly<MindValidationIssue>[] = [];
  let count = 0;
  let bytes = 0;

  const append = (
    source: readonly Readonly<OkfDiagnostic>[],
    issueClass: "conformance" | "quality",
    target: Readonly<MindValidationIssue>[],
  ) => {
    for (const diagnostic of source) {
      const projected = projectIssue(diagnostic, issueClass);
      const cost = issueByteCost(projected);
      if (
        count >= VALIDATION_ISSUE_LIMIT ||
        bytes + cost > VALIDATION_RESPONSE_BYTE_BUDGET
      ) {
        break;
      }
      target.push(projected);
      count += 1;
      bytes += cost;
    }
  };

  append(errors, "conformance", conformanceErrors);
  append(warnings, "quality", qualityWarnings);
  return Object.freeze({
    conformanceErrors: Object.freeze(conformanceErrors),
    qualityWarnings: Object.freeze(qualityWarnings),
    issuesTruncated:
      conformanceErrors.length < errors.length ||
      qualityWarnings.length < warnings.length,
  });
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
        manifest.format === REVISION_MANIFEST_FORMAT_V4
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

    const sources: { readonly path: string; readonly bytes: Uint8Array }[] = [];
    const referenceMarkdown: { readonly path: string; readonly text: string }[] = [];
    const bundleFiles: { readonly path: string; readonly mediaType: BundleFileMediaType }[] = [];
    for (const entry of manifest.entries) {
      await this.#requireSameValidationAuthorization(
        actor,
        spaceId,
        info.revisionMode,
        initialAuthorization,
      );
      if (entry.kind === "opaque") {
        let opened;
        try {
          opened = "openBundleFile" in this.#objects
            ? await (this.#objects as BundleFileObjectStore).openBundleFile(
                spaceId,
                entry.sha256,
              )
            : null;
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
          opened === null || opened.sha256 !== entry.sha256 ||
          opened.mediaType !== entry.mediaType || opened.size !== entry.size ||
          !(await verifyOpaqueBody(opened.body, entry.size, entry.sha256))
        ) throw new MindValidationFailure(
          "revision_integrity_failure",
          "The exact revision failed integrity verification.",
        );
        bundleFiles.push(Object.freeze({
          path: entry.path,
          mediaType: entry.mediaType,
        }));
        continue;
      }
      let object;
      try {
        object = (manifest.format === REVISION_MANIFEST_FORMAT_V3 ||
            manifest.format === REVISION_MANIFEST_FORMAT_V4) &&
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
      const bytes = new Uint8Array(object.bytes);
      if ((await this.#objects.calculateSha256(bytes)) !== entry.sha256) {
        throw new MindValidationFailure(
          "revision_integrity_failure",
          "The exact revision failed integrity verification.",
        );
      }
      sources.push(Object.freeze({ path: entry.path, bytes }));
      try {
        referenceMarkdown.push(Object.freeze({
          path: entry.path,
          text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        }));
      } catch {
        // The OKF validator reports invalid UTF-8 through its normal envelope.
      }
    }
    await this.#requireSameValidationAuthorization(
      actor,
      spaceId,
      info.revisionMode,
      initialAuthorization,
    );

    const okfValidation = validateOkfBundle(sources);
    const referenceAnalysis = analyzeBundleFileReferences({
      markdown: referenceMarkdown,
      bundleFiles,
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
    const allWarnings = Object.freeze([
      ...okfValidation.qualityWarnings,
      ...referenceWarnings,
    ]);
    const bounded = boundedIssues(allErrors, allWarnings);
    return Object.freeze({
      mind: info.mind,
      resolvedRevision: info.resolvedRevision,
      revisionMode: info.revisionMode,
      readOnly: true,
      valid: okfValidation.valid && referenceErrors.length === 0,
      conformanceErrors: bounded.conformanceErrors,
      qualityWarnings: bounded.qualityWarnings,
      issueCounts: Object.freeze({
        conformanceErrors: allErrors.length,
        qualityWarnings: allWarnings.length,
      }),
      issuesTruncated: bounded.issuesTruncated,
      validatedOkfVersion: okfValidation.version,
    });
  }

  async #requireValidationAuthorization(
    actor: ActorContext,
    spaceId: SpaceId,
    revisionMode: RevisionMode,
    concealCapabilityDenial: boolean,
  ): Promise<AllowedAuthorization> {
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
