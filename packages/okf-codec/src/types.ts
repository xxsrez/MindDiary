import type { RevisionId } from "@mind-diary/domain";

export const OKF_VERSION = "0.2" as const;
export const OKF_AUDITED_SPEC_REVISION =
  "0b87c52c6ef999286c745e19998fdfcd03d5dbee" as const;
export const OKF_AUDITED_SPEC_SHA256 =
  "26aa5da029278939f914e578107242d9607d4f2dc5fe153272b82f9ed1030101" as const;

export type OkfVersion = typeof OKF_VERSION;
export type OkfDiagnosticCategory =
  | "okf-conformance"
  | "mind-diary-envelope"
  | "quality";
export type OkfDiagnosticSource = "okf-0.2" | "mind-diary-mvp";

export interface OkfDiagnostic {
  readonly severity: "error" | "warning";
  readonly category: OkfDiagnosticCategory;
  readonly source: OkfDiagnosticSource;
  readonly code: string;
  readonly path: string;
  readonly line?: number;
  readonly field?: string;
  readonly message: string;
}

export interface CanonicalOkfFile {
  readonly path: string;
  readonly text: string;
}

export interface BinaryOkfFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export type OkfSourceFile = CanonicalOkfFile | BinaryOkfFile;

export interface OkfBundleFixture {
  readonly revisionId: RevisionId;
  readonly files: readonly CanonicalOkfFile[];
}

interface ParsedOkfFileBase {
  readonly path: string;
  readonly version: OkfVersion;
  readonly sourceText: string;
  readonly newline: "\n" | "\r\n";
}

export interface ParsedOkfConcept extends ParsedOkfFileBase {
  readonly kind: "concept";
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly frontmatterSource: string;
  readonly headerSource: string;
  readonly body: string;
  readonly okfType: string | null;
  /** The codec preserves type-specific contracts but never executes them. */
  readonly typeSemantics: "opaque";
}

export interface ParsedOkfIndex extends ParsedOkfFileBase {
  readonly kind: "index";
  readonly frontmatter: Readonly<Record<string, unknown>> | null;
  readonly body: string;
  readonly isRoot: boolean;
}

export interface ParsedOkfLog extends ParsedOkfFileBase {
  readonly kind: "log";
}

export type ParsedOkfFile = ParsedOkfConcept | ParsedOkfIndex | ParsedOkfLog;

export interface OkfFileParseResult {
  readonly file: ParsedOkfFile | null;
  readonly diagnostics: readonly OkfDiagnostic[];
  readonly valid: boolean;
}

export interface OkfBundleValidation {
  readonly version: OkfVersion;
  /** True only when neither OKF conformance nor MVP-envelope errors exist. */
  readonly valid: boolean;
  /** True when the portable OKF 0.2 rules pass, independently of the MVP envelope. */
  readonly conforms: boolean;
  readonly files: readonly ParsedOkfFile[];
  readonly diagnostics: readonly OkfDiagnostic[];
  readonly conformanceErrors: readonly OkfDiagnostic[];
  readonly envelopeErrors: readonly OkfDiagnostic[];
  readonly qualityWarnings: readonly OkfDiagnostic[];
}

export interface OkfProducerBundleValidation extends OkfBundleValidation {
  /** Agent/service producers fail closed on advisory defects they introduced. */
  readonly producerValid: boolean;
}

export interface OkfConceptUpdate {
  /** Top-level fields to set. Unmentioned fields, including extensions, are retained. */
  readonly setFields?: Readonly<Record<string, unknown>>;
  /** Exact Markdown body bytes after the closing frontmatter delimiter line. */
  readonly body?: string;
}

export interface OkfCodec {
  readonly version: OkfVersion;
  readonly auditedSpecRevision: typeof OKF_AUDITED_SPEC_REVISION;
  readonly auditedSpecSha256: typeof OKF_AUDITED_SPEC_SHA256;
  parseFile(source: OkfSourceFile): OkfFileParseResult;
  renderFile(file: ParsedOkfFile): CanonicalOkfFile;
  encodeFile(file: ParsedOkfFile | CanonicalOkfFile): BinaryOkfFile;
  validateBundle(files: readonly OkfSourceFile[]): OkfBundleValidation;
  validateProducerBundle(
    files: readonly OkfSourceFile[],
  ): OkfProducerBundleValidation;
  updateConcept(
    concept: ParsedOkfConcept,
    update: OkfConceptUpdate,
  ): CanonicalOkfFile;
}
