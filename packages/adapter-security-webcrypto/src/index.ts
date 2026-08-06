import type { TokenHasher } from "@mind-diary/application-ports";

export const SECURITY_ADAPTER = "webcrypto-contract-only" as const;
export type SecurityAdapterContract = TokenHasher;
