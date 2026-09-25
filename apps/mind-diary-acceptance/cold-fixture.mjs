import { createSitesMetadataStore } from "../../packages/adapter-metadata-sites/dist/index.js";
import { createSitesObjectStore } from "../../packages/adapter-object-sites/dist/index.js";
import { REVISION_MANIFEST_MEDIA_TYPE } from "../../packages/application-ports/src/index.ts";
import {
  REVISION_MANIFEST_FORMAT_V3,
  createCanonicalRevisionEnvelope,
  createRevisionManifest,
  serializeRevisionManifest,
  verifiedSpaceHost,
} from "../../packages/domain/src/index.ts";
import { ACCEPTANCE_ORIGIN } from "./runtime-target.mjs";

const fail = (code) => { throw new Error(code); };

// Builds only the two missing opaque entries and a legacy parent envelope.
// The 160 Markdown files must already exist through ordinary MCP commits.
export async function seedColdFixture(store, runId, input, environment) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).join(",") !== "expected_revision" ||
      typeof input.expected_revision !== "string" ||
      !/^revision_[A-Za-z0-9_-]{1,120}$/u.test(input.expected_revision)) fail("invalid_request");
  const run = await store.run(runId);
  if (run.state !== "active" || run.expires_at <= Date.now() || run.profile !== "collaboration") fail("cold_fixture_run_inactive");
  const owner = await store.statement("SELECT principal_id FROM md_acceptance_actors WHERE run_id = ? AND ordinal = 0", runId).first();
  if (!owner?.principal_id) fail("cold_fixture_owner_missing");
  const metadata = await createSitesMetadataStore(environment.DB);
  const resolved = await metadata.resolveHandle({
    host: verifiedSpaceHost(new URL(ACCEPTANCE_ORIGIN).host), handle: `uat-${runId}`,
  });
  if (resolved.kind !== "resolved") fail("cold_fixture_mind_missing");
  const auth = await metadata.readCurrentAuthorizationState({
    principalId: owner.principal_id, spaceId: resolved.spaceId, tokenId: null,
  });
  if (auth?.membership?.role !== "owner" || auth.membership.state !== "active" ||
      auth.principal.state !== "active" || auth.space.state !== "active") fail("cold_fixture_owner_mismatch");
  const targetRevisionId = `revision_cold_${runId.replaceAll("-", "")}`;
  const head = await metadata.readHead(resolved.spaceId);
  if (head === targetRevisionId) return { revision_id: targetRevisionId, replayed: true, markdown_count: 160, opaque_count: 2 };
  if (head !== input.expected_revision) fail("cold_fixture_head_changed");
  const parent = await metadata.readRevision(resolved.spaceId, head);
  if (!parent) fail("cold_fixture_parent_missing");
  const existing = parent.manifest.entries;
  if (existing.length !== 160 || existing.some((entry) => entry.kind !== "markdown") ||
      !existing.some((entry) => entry.path === "concepts/cold-0000.md") ||
      !existing.some((entry) => entry.path === "index.md") ||
      !existing.some((entry) => entry.path === "log.md")) fail("cold_fixture_markdown_shape_mismatch");
  const objects = await createSitesObjectStore(environment.MIND_DIARY_BUCKET);
  const now = new Date().toISOString();
  const opaque = [];
  for (let index = 0; index < 2; index += 1) {
    const put = await objects.putBundleFile({
      spaceId: resolved.spaceId, bytes: new TextEncoder().encode(`ZIP fixture ${index}`),
      mediaType: "application/zip", createdAt: now,
    });
    opaque.push({ kind: "opaque", path: `assets/archive-${index}.zip`,
      sha256: put.object.sha256, mediaType: "application/zip", size: put.object.size });
  }
  const markdown = existing.map((entry) => ({ kind: "markdown", path: entry.path,
    sha256: entry.sha256, mediaType: entry.mediaType, size: entry.size }));
  const manifest = createRevisionManifest([...markdown, ...opaque], REVISION_MANIFEST_FORMAT_V3);
  const manifestObject = await objects.putSpaceCanonicalObject({
    kind: "revision_manifest", spaceId: resolved.spaceId,
    bytes: new TextEncoder().encode(serializeRevisionManifest(manifest)),
    mediaType: REVISION_MANIFEST_MEDIA_TYPE, createdAt: now,
  });
  const envelope = createCanonicalRevisionEnvelope({
    revisionId: targetRevisionId, spaceId: resolved.spaceId,
    revisionNumber: parent.revision.revisionNumber + 1, parentRevisionId: head,
    committedAt: now, committedBy: parent.revision.committedBy,
    manifest, manifestHash: manifestObject.object.sha256,
    manifestSize: manifestObject.object.size,
    summary: "Synthetic cold legacy fixture",
  });
  const committed = await metadata.commitRevision({ expectedHeadRevisionId: head, envelope });
  if (committed.kind !== "committed" || await metadata.readHead(resolved.spaceId) !== targetRevisionId) {
    fail("cold_fixture_commit_failed");
  }
  if (await metadata.readPreflightProducerProof(resolved.spaceId) !== null) fail("cold_fixture_unexpected_proof");
  return { revision_id: targetRevisionId, replayed: false, markdown_count: 160, opaque_count: 2 };
}
