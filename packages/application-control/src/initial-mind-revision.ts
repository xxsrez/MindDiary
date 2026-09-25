import type { BundleFileObjectStore } from "@mind-diary/application-ports";
import { REVISION_MANIFEST_MEDIA_TYPE } from "@mind-diary/application-ports";
import {
  MARKDOWN_MEDIA_TYPE,
  REVISION_MANIFEST_FORMAT_V3,
  createRevisionManifest,
  serializeRevisionManifest,
  type SpaceId,
  type UtcInstant,
} from "@mind-diary/domain";

const encoder = new TextEncoder();

/** Keep each new Space's first R2 writes pinned until its D1 creation result is known. */
export async function stageInitialMindRevision(
  objects: BundleFileObjectStore,
  spaceId: SpaceId,
  files: readonly Readonly<{ path: string; text: string }>[],
  createdAt: UtcInstant,
) {
  const materialized = await Promise.all(files.map(async (file) => {
    const bytes = encoder.encode(file.text);
    return Object.freeze({
      path: file.path,
      bytes,
      sha256: await objects.calculateSha256(bytes),
    });
  }));
  const manifest = createRevisionManifest(materialized.map((file) => ({
    kind: "markdown" as const,
    path: file.path,
    sha256: file.sha256,
    mediaType: MARKDOWN_MEDIA_TYPE,
    size: file.bytes.byteLength,
  })), REVISION_MANIFEST_FORMAT_V3);
  const manifestBytes = encoder.encode(serializeRevisionManifest(manifest));
  const manifestHash = await objects.calculateSha256(manifestBytes);
  const intentId = crypto.randomUUID();
  const intentObjects = new Map<string, Readonly<{
    kind: "markdown" | "revision_manifest";
    spaceId: SpaceId;
    sha256: typeof manifestHash;
  }>>();
  for (const file of materialized) {
    intentObjects.set(`markdown\u0000${file.sha256}`, {
      kind: "markdown", spaceId, sha256: file.sha256,
    });
  }
  intentObjects.set(`revision_manifest\u0000${manifestHash}`, {
    kind: "revision_manifest", spaceId, sha256: manifestHash,
  });
  await objects.beginSpaceCanonicalCreationIntent?.({
    intentId,
    createdAt,
    objects: [...intentObjects.values()],
  });
  // A failed or uncertain PUT leaves the durable intent for reconciliation.
  await Promise.all(materialized.map((file) => objects.putSpaceCanonicalObject({
    kind: "markdown",
    spaceId,
    bytes: file.bytes,
    mediaType: MARKDOWN_MEDIA_TYPE,
    createdAt,
  })));
  await objects.putSpaceCanonicalObject({
    kind: "revision_manifest",
    spaceId,
    bytes: manifestBytes,
    mediaType: REVISION_MANIFEST_MEDIA_TYPE,
    createdAt,
  });
  return Object.freeze({
    intentId,
    manifest,
    manifestHash,
    manifestSize: manifestBytes.byteLength,
    completeIntent: () => objects.completeSpaceCanonicalCreationIntent?.(intentId) ?? Promise.resolve(),
  });
}
