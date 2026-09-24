import type { ExportJobProgressEvent } from "@mind-diary/application-background";

/** Project only bounded operational fields from an untrusted runtime value. */
export function serializeSafeExportProgress(event: unknown): string | null {
  if (typeof event !== "object" || event === null) return null;
  const progress = event as Partial<ExportJobProgressEvent>;
  if (
    typeof progress.jobId !== "string" ||
    !/^job-export_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(progress.jobId) ||
    ![
      "claimed", "authorized", "upload_opened", "inspect", "write",
      "archive_built", "archive_stored", "completed", "failed",
    ].includes(progress.stage as string) ||
    !Number.isSafeInteger(progress.claimVersion) ||
    (progress.claimVersion as number) < 1 ||
    !Number.isSafeInteger(progress.completedEntries) ||
    !Number.isSafeInteger(progress.totalEntries) ||
    (progress.completedEntries as number) < 0 ||
    (progress.completedEntries as number) > (progress.totalEntries as number) ||
    (progress.totalEntries as number) > 65_535
  ) return null;
  const diagnostic = progress.stage === "failed" &&
    ["type_error", "range_error", "object_error", "revision_error", "other_error"].includes(progress.failureKind as string) &&
    typeof progress.failureCode === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(progress.failureCode)
      ? { failureKind: progress.failureKind, failureCode: progress.failureCode }
      : {};
  return JSON.stringify({
    event: "mind-diary-export-progress",
    jobId: progress.jobId,
    claimVersion: progress.claimVersion,
    stage: progress.stage,
    completedEntries: progress.completedEntries,
    totalEntries: progress.totalEntries,
    ...diagnostic,
  });
}
