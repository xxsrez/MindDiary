import {
  type AuditEventId,
  type ExternalBindingId,
  type ExportDownloadSecretVerifier,
  type MembershipId,
  type PrincipalId,
  type JobId,
  type OutboxMessageId,
  type RevisionId,
  type SpaceId,
  type UtcInstant,
} from "@mind-diary/domain";

export interface Clock {
  now(): UtcInstant;
}

/** Server-side source of opaque immutable revision identities. */
export interface RevisionIdGenerator {
  nextRevisionId(): RevisionId;
}

/** Server-owned identifiers and hidden handle for one isolated account. */
export interface AccountBootstrapIdGenerator {
  nextPrincipalId(): PrincipalId;
  nextExternalBindingId(): ExternalBindingId;
  nextSpaceId(): SpaceId;
  nextMembershipId(): MembershipId;
  nextRevisionId(): RevisionId;
  /** Optional only for legacy test generators; production must provide it. */
  nextIndexJobId?(): JobId;
  nextPersonalSpaceHandle(): string;
}

/** Server-owned IDs for effects staged with one successful content commit. */
export interface CommitEffectIdGenerator {
  nextAuditEventId(): AuditEventId;
  nextOutboxMessageId(): OutboxMessageId;
  nextIndexJobId(): JobId;
}

/** Server-side source of opaque export job locators. */
export interface ExportJobIdGenerator {
  nextExportJobId(): JobId;
}

/** Secret-bearing issuance result; the raw bearer can be consumed exactly once. */
export interface IssuedExportDownloadSecret {
  consumeSecret(): string | null;
  verifier(): ExportDownloadSecretVerifier;
}

export type ExportDownloadVerifierLookupResult<Value> =
  | {
      readonly kind: "found";
      readonly verifier: ExportDownloadSecretVerifier;
      readonly value: Value;
    }
  | { readonly kind: "not_found" };

export interface ExportDownloadVerifierLookup<Value> {
  findByVerifier(
    verifier: ExportDownloadSecretVerifier,
  ): Promise<ExportDownloadVerifierLookupResult<Value>>;
}

export type ExportDownloadSecretVerificationResult<Value> =
  | { readonly kind: "verified"; readonly value: Value }
  | { readonly kind: "invalid" };

/** Dedicated crypto boundary for canonical export-download bearer secrets. */
export interface ExportDownloadSecretCrypto {
  readonly kind: "export-download-secret-crypto";
  issueSecret(): Promise<IssuedExportDownloadSecret>;
  verifySecret<Value>(
    candidate: unknown,
    lookup: ExportDownloadVerifierLookup<Value>,
  ): Promise<ExportDownloadSecretVerificationResult<Value>>;
}

export interface MetadataStore {
  readonly kind: "metadata-store";
}

/** Server-owned immutable IDs for Mind binding generations. */
