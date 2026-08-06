import type { SearchIndex } from "@mind-diary/application-ports";

export const SEARCH_ADAPTER = "memory-fixture-only" as const;
export type SearchAdapterContract = SearchIndex;
