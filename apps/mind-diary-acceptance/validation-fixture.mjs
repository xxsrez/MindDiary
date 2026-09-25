import { createSitesMetadataStore } from "../../packages/adapter-metadata-sites/dist/index.js";
import { createSitesObjectStore } from "../../packages/adapter-object-sites/dist/index.js";
import { REVISION_MANIFEST_MEDIA_TYPE } from "../../packages/application-ports/src/index.ts";
import {
  MARKDOWN_MEDIA_TYPE,
  REVISION_MANIFEST_FORMAT_V3,
  createCanonicalRevisionEnvelope,
  createRevisionManifest,
  serializeRevisionManifest,
  verifiedSpaceHost,
} from "../../packages/domain/src/index.ts";
import { ACCEPTANCE_ORIGIN } from "./runtime-target.mjs";

const fail = (code) => { throw new Error(code); };
const revisionId = (runId, stage) => `revision_validation_${runId.replaceAll("-", "")}_${stage}`;

// Test-only legacy fixture. Every durable write is scoped to the current
// run's own ordinary Mind; the Product Site has no route to this helper.
export async function seedValidationFixture(store, runId, input, environment) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== "expected_revision,stage" ||
      !["invalid", "fresh"].includes(input.stage) ||
      typeof input.expected_revision !== "string" || !/^revision_[A-Za-z0-9_-]{1,120}$/u.test(input.expected_revision)) {
    fail("invalid_request");
  }
  const run = await store.run(runId);
  if (run.state !== "active" || run.expires_at <= Date.now() || run.profile !== "collaboration") fail("validation_fixture_run_inactive");
  const owner = await store.statement("SELECT principal_id FROM md_acceptance_actors WHERE run_id = ? AND ordinal = 0", runId).first();
  if (!owner?.principal_id) fail("validation_fixture_owner_missing");
  const metadata = await createSitesMetadataStore(environment.DB);
  const resolved = await metadata.resolveHandle({
    host: verifiedSpaceHost(new URL(ACCEPTANCE_ORIGIN).host),
    handle: `uat-${runId}`,
  });
  if (resolved.kind !== "resolved") fail("validation_fixture_mind_missing");
  const auth = await metadata.readCurrentAuthorizationState({
    principalId: owner.principal_id, spaceId: resolved.spaceId, tokenId: null,
  });
  if (auth?.membership?.role !== "owner" || auth.membership.state !== "active" ||
      auth.principal.state !== "active" || auth.space.state !== "active") fail("validation_fixture_owner_mismatch");
  const targetRevisionId = revisionId(runId, input.stage);
  const head = await metadata.readHead(resolved.spaceId);
  if (head === targetRevisionId) return { stage: input.stage, revision_id: targetRevisionId, replayed: true };
  if (head !== input.expected_revision) fail("validation_fixture_head_changed");
  const parent = await metadata.readRevision(resolved.spaceId, head);
  if (!parent) fail("validation_fixture_parent_missing");
  const text = input.stage === "invalid"
    ? `---\nokf_version: "0.2"\n---\n\n# Validation pagination\n\n${Array.from({ length: 105 }, (_, index) => `- [Missing ${index}](missing-${index}.md)`).join("\n")}\n`
    : "---\nokf_version: \"0.2\"\n---\n\n# Fresh HEAD\n";
  const objects = await createSitesObjectStore(environment.MIND_DIARY_BUCKET);
  const put = await objects.putSpaceCanonicalObject({
    kind: "markdown", spaceId: resolved.spaceId, bytes: new TextEncoder().encode(text),
    mediaType: MARKDOWN_MEDIA_TYPE, createdAt: new Date().toISOString(),
  });
  const manifest = createRevisionManifest([{
    kind: "markdown", path: "index.md", sha256: put.object.sha256,
    mediaType: MARKDOWN_MEDIA_TYPE, size: put.object.size,
  }], REVISION_MANIFEST_FORMAT_V3);
  const manifestObject = await objects.putSpaceCanonicalObject({
    kind: "revision_manifest", spaceId: resolved.spaceId,
    bytes: new TextEncoder().encode(serializeRevisionManifest(manifest)),
    mediaType: REVISION_MANIFEST_MEDIA_TYPE, createdAt: new Date().toISOString(),
  });
  const envelope = createCanonicalRevisionEnvelope({
    revisionId: targetRevisionId, spaceId: resolved.spaceId,
    revisionNumber: parent.revision.revisionNumber + 1, parentRevisionId: head,
    committedAt: new Date().toISOString(), committedBy: parent.revision.committedBy,
    manifest, manifestHash: manifestObject.object.sha256,
    manifestSize: manifestObject.object.size,
    summary: `Synthetic ${input.stage} validation fixture`,
  });
  const committed = await metadata.commitRevision({ expectedHeadRevisionId: head, envelope });
  if (committed.kind !== "committed") fail("validation_fixture_commit_failed");
  const readBack = await metadata.readHead(resolved.spaceId);
  if (readBack !== targetRevisionId) fail("validation_fixture_readback_failed");
  return { stage: input.stage, revision_id: targetRevisionId, replayed: false };
}
