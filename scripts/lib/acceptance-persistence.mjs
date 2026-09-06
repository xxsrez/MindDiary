import assert from "node:assert/strict";
import { acceptanceDigest } from "./acceptance-evidence.mjs";
export async function snapshotAcceptanceFixture(client, fixture, token) {
  const snapshots = [];
  for (const mind of ["/me", `/${fixture.handle}`]) {
    const revisionId = fixture.revisions[mind][1];
    const revision = await client.mcp(token, "get_revision", { mind, revision_id: revisionId });
    const entries = await client.mcp(token, "browse_entries", { mind, revision_selector: { kind: "revision", revision_id: revisionId } });
    assert.ok(entries.entries.length > 0);
    assert.ok(!entries.next_cursor, "fixture_snapshot_requires_complete_page");
    const contents = [];
    for (const entry of entries.entries) contents.push({ id: entry.entry_id, digest: acceptanceDigest(await client.mcp(token, "fetch", { id: entry.entry_id })) });
    snapshots.push({ mind, revision_id: revisionId, revision_digest: acceptanceDigest(revision), contents });
  }
  return snapshots;
}
export async function verifyAcceptanceSnapshot(client, token, snapshots) {
  assert.equal(snapshots.length, 2);
  for (const snapshot of snapshots) {
    assert.equal(acceptanceDigest(await client.mcp(token, "get_revision", { mind: snapshot.mind, revision_id: snapshot.revision_id })), snapshot.revision_digest);
    for (const entry of snapshot.contents) assert.equal(acceptanceDigest(await client.mcp(token, "fetch", { id: entry.id })), entry.digest);
  }
}
