import type { RevisionId } from "@mind-diary/domain";

export const OKF_VERSION = "0.2" as const;

export interface CanonicalOkfFile {
  readonly path: string;
  readonly text: string;
}

export interface OkfBundleFixture {
  readonly revisionId: RevisionId;
  readonly files: readonly CanonicalOkfFile[];
}
