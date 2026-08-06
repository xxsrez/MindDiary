import type { ObjectStore } from "@mind-diary/application-ports";

export const OBJECT_ADAPTER = "memory-fixture-only" as const;
export type ObjectAdapterContract = ObjectStore;
