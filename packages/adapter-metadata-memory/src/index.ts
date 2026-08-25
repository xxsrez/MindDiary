import type { MetadataStore } from "@mind-diary/application-ports";

export const METADATA_ADAPTER = "memory-revision-envelope" as const;
export type MetadataAdapterContract = MetadataStore;

export { InMemoryHandleRegistry } from "./handle-registry.js";
export type { InMemoryHandleRegistrySnapshot } from "./handle-registry.js";
export { InMemoryMcpTokenStore } from "./mcp-token-store.js";
export { InMemoryRevisionMetadataStore } from "./revision-metadata-store.js";
export { InMemoryLocalFileUploadIntentStore } from "./local-file-upload-intent-store.js";
export type {
  AccountBootstrapFailureStage,
  AccountDeletionFailureStage,
  OrdinaryMindFailureStage,
  PersonalProfileFailureStage,
} from "./metadata-store-internals.js";
