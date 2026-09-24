import { ObjectStoreFailure, type ExportArchiveUploadRequest } from "@mind-diary/application-ports";
import type { R2ObjectBodyLike } from "./index.js";

export function exportStreamPartMetadata(
  request: Readonly<ExportArchiveUploadRequest>,
  partIndex: number,
  sha256: string,
  size: number,
): Readonly<Record<string, string>> {
  return Object.freeze({
    schema: "md-r2-export-stream-part-v1",
    jobId: String(request.jobId),
    spaceId: String(request.spaceId),
    partIndex: String(partIndex),
    sha256,
    size: String(size),
    createdAt: request.createdAt,
  });
}

export async function assertMatchingExportPart(
  existing: R2ObjectBodyLike | null,
  bytes: Uint8Array,
  sha256: string,
  readBody: (object: R2ObjectBodyLike) => Promise<Uint8Array>,
): Promise<void> {
  if (existing === null || existing.size !== bytes.byteLength || existing.customMetadata?.sha256 !== sha256) {
    throw new ObjectStoreFailure("digest_collision", "streamed export part key collision");
  }
  const actual = await readBody(existing);
  if (actual.byteLength !== bytes.byteLength || actual.some((byte, index) => byte !== bytes[index])) {
    throw new ObjectStoreFailure("digest_collision", "streamed export part key collision");
  }
}
