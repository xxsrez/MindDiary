import type { MetadataStore } from "@mind-diary/application-ports";

export const METADATA_ADAPTER = "memory-fixture-only" as const;
export type MetadataAdapterContract = MetadataStore;
