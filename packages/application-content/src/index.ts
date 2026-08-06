import type { ActorContext } from "@mind-diary/application-contracts";
import type { ObjectStore, SearchIndex } from "@mind-diary/application-ports";
import type { SpaceId } from "@mind-diary/domain";
import type { OkfBundleFixture } from "@mind-diary/okf-codec";

export const CONTENT_QUERIES = [
  "list_minds",
  "resolve_mind",
  "get_mind_info",
  "browse_entries",
  "search_entries",
  "fetch_entry",
  "list_revisions",
  "get_revision",
  "validate_revision",
  "get_export_status",
] as const;

export const CONTENT_COMMANDS = ["commit_changeset", "start_export"] as const;

export interface ContentBoundaryMarker {
  readonly actor: ActorContext;
  readonly spaceId: SpaceId;
  readonly objectStore: ObjectStore;
  readonly searchIndex: SearchIndex;
  readonly fixtureOnlyBundle?: OkfBundleFixture;
}
