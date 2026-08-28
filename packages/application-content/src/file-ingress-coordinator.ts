import {
  FILE_INGRESS_SOURCE_KINDS,
  type FileIngressSourceKind,
  type StagedBundleFileRecord,
} from "@mind-diary/application-ports";
import type {
  CommitChangesetRequest,
  CommitChangesetResult,
  ChangesetCommitService,
  ReconcileChangesetResult,
} from "./changeset-commit.js";
import type {
  BundleFileStagingService,
  ReconcileStageBundleFileRequest,
  ReconcileStageBundleFileResult,
} from "./bundle-files.js";

export type FileIngressCapabilityStatus =
  | "available_local"
  | "available_hosted"
  | "not_available";

export interface FileIngressCapability {
  readonly sourceKind: FileIngressSourceKind;
  readonly status: FileIngressCapabilityStatus;
  readonly transport:
    | "native_file_parameter"
    | "authorized_connector"
    | "local_companion"
    | "bounded_bytes"
    | "producer_stream";
  readonly maxBytes: number;
  readonly fallback: "none";
}

export type FileIngressCoordinatorStageResult =
  | {
      readonly kind: "staged";
      readonly record: Readonly<StagedBundleFileRecord>;
      readonly replayed: boolean;
    }
  | { readonly kind: "denied"; readonly decision: unknown }
  | { readonly kind: "invalid"; readonly code: string };

export interface FileIngressStageAdapter {
  /** Provider/local payload remains adapter-owned and never enters domain identity. */
  stage(payload: unknown): Promise<FileIngressCoordinatorStageResult>;
}

export interface FileIngressCoordinatorDependencies {
  readonly adapters?: Readonly<
    Partial<Record<FileIngressSourceKind, FileIngressStageAdapter>>
  >;
  readonly capabilityStatus?: Readonly<
    Partial<Record<FileIngressSourceKind, FileIngressCapabilityStatus>>
  >;
  readonly staging: Pick<BundleFileStagingService, "reconcile">;
  readonly commits: Pick<ChangesetCommitService, "commit" | "reconcile">;
}

const CAPABILITY_BASE: Readonly<
  Record<FileIngressSourceKind, Omit<FileIngressCapability, "sourceKind" | "status">>
> = Object.freeze({
  session_attachment: Object.freeze({
    transport: "native_file_parameter",
    maxBytes: 268_435_456,
    fallback: "none",
  }),
  local_path: Object.freeze({
    transport: "local_companion",
    maxBytes: 268_435_456,
    fallback: "none",
  }),
  "workspace/generated_artifact": Object.freeze({
    transport: "local_companion",
    maxBytes: 268_435_456,
    fallback: "none",
  }),
  connector_object: Object.freeze({
    transport: "authorized_connector",
    maxBytes: 268_435_456,
    fallback: "none",
  }),
  bounded_in_memory: Object.freeze({
    transport: "bounded_bytes",
    maxBytes: 4_194_304,
    fallback: "none",
  }),
  server_generated: Object.freeze({
    transport: "producer_stream",
    maxBytes: 268_435_456,
    fallback: "none",
  }),
});

function ingressSourceKind(value: unknown): FileIngressSourceKind | null {
  return typeof value === "string" &&
      (FILE_INGRESS_SOURCE_KINDS as readonly string[]).includes(value)
    ? value as FileIngressSourceKind
    : null;
}

/**
 * One application boundary for source dispatch, safe capability discovery,
 * exact stage/commit reconciliation and the existing atomic HEAD-CAS commit.
 */
export class FileIngressCoordinator {
  readonly #adapters: Readonly<
    Partial<Record<FileIngressSourceKind, FileIngressStageAdapter>>
  >;
  readonly #capabilityStatus: Readonly<
    Partial<Record<FileIngressSourceKind, FileIngressCapabilityStatus>>
  >;
  readonly #staging: Pick<BundleFileStagingService, "reconcile">;
  readonly #commits: Pick<ChangesetCommitService, "commit" | "reconcile">;

  constructor(dependencies: FileIngressCoordinatorDependencies) {
    this.#adapters = Object.freeze({ ...(dependencies.adapters ?? {}) });
    this.#capabilityStatus = Object.freeze({ ...(dependencies.capabilityStatus ?? {}) });
    this.#staging = dependencies.staging;
    this.#commits = dependencies.commits;
  }

  capabilities(): readonly Readonly<FileIngressCapability>[] {
    return Object.freeze(FILE_INGRESS_SOURCE_KINDS.map((sourceKind) => {
      const adapter = this.#adapters[sourceKind];
      const declared = this.#capabilityStatus[sourceKind];
      // Edge-owned routes (for example native-file and companion upload intents)
      // can register their deployed status without becoming coordinator stage
      // adapters. Undeclared in-process adapters stay local by default.
      const status = declared ?? (adapter === undefined
        ? "not_available"
        : "available_local");
      return Object.freeze({ sourceKind, status, ...CAPABILITY_BASE[sourceKind] });
    }));
  }

  async stage(request: Readonly<{
    sourceKind: unknown;
    payload: unknown;
  }>): Promise<FileIngressCoordinatorStageResult> {
    const sourceKind = ingressSourceKind(request.sourceKind);
    if (sourceKind === null) {
      return Object.freeze({ kind: "invalid", code: "invalid_source_kind" });
    }
    const adapter = this.#adapters[sourceKind];
    if (adapter === undefined) {
      return Object.freeze({
        kind: "invalid",
        code: "file_ingress_source_unsupported",
      });
    }
    let result: FileIngressCoordinatorStageResult;
    try {
      result = await adapter.stage(request.payload);
    } catch {
      return Object.freeze({
        kind: "invalid",
        code: "file_ingress_transport_unavailable",
      });
    }
    if (result.kind === "staged" && result.record.sourceKind !== sourceKind) {
      return Object.freeze({
        kind: "invalid",
        code: "file_ingress_source_mismatch",
      });
    }
    return result;
  }

  reconcileStage(
    request: ReconcileStageBundleFileRequest,
  ): Promise<ReconcileStageBundleFileResult> {
    return this.#staging.reconcile(request);
  }

  commit(request: CommitChangesetRequest): Promise<CommitChangesetResult> {
    return this.#commits.commit(request);
  }

  reconcileCommit(request: CommitChangesetRequest): Promise<ReconcileChangesetResult> {
    return this.#commits.reconcile(request);
  }
}
