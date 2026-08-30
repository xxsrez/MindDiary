import {
  type SitesIdentityBeforeRegistration,
} from "@mind-diary/application-control";

import {
  SITES_IDENTITY_PROVIDER,
  normalizeSitesVerifiedEmail,
  type SitesIdentityBindingReader,
  type SitesIdentityRequestContext,
  type TrustedSitesIdentitySnapshot,
} from "./sites-identity-binding.js";

import {
  type PersonalTokenItem,
} from "./connections.js";

import {
  type ProductWebActivityRecorder,
  type ProductWebRegisteredActor,
} from "./product-web-activity.js";

import {
  type ProductWebMindUsageApplication,
} from "./mind-usage.js";

export type RegisteredSitesActor = ProductWebRegisteredActor;
export type ProductWebActor = RegisteredSitesActor | SitesIdentityBeforeRegistration;

export interface ProductSitesSessionSnapshot {
  readonly principal: {
    readonly displayName: string;
    readonly profileVersion: number;
  };
  readonly personalMind: {
    readonly name: string;
    readonly description?: string | null;
    readonly metadataVersion?: number;
    readonly headRevisionId: string;
  };
}

export type ProductSitesIdentityResolution =
  | {
      readonly kind: "authenticated";
      readonly actor: RegisteredSitesActor;
      /** Safe projection captured by the same durable read that authenticated the request. */
      readonly session?: Readonly<ProductSitesSessionSnapshot>;
    }
  | { readonly kind: "registration_required"; readonly actor: SitesIdentityBeforeRegistration }
  | { readonly kind: "denied" }
  | { readonly kind: "unavailable" };

/**
 * Converts one server-owned Sites identity snapshot into application authority.
 * The normalized binding is returned only inside the bootstrap actor and is
 * never serialized by this adapter.
 */
export async function resolveProductSitesIdentity(input: {
  readonly snapshot: TrustedSitesIdentitySnapshot;
  readonly bindings: SitesIdentityBindingReader;
  readonly context: SitesIdentityRequestContext;
  readonly bindingProvider?: string;
}): Promise<Readonly<ProductSitesIdentityResolution>> {
  if (input.snapshot.kind !== "authenticated") {
    return Object.freeze({ kind: "denied" as const });
  }
  const normalizedBinding = normalizeSitesVerifiedEmail(
    input.snapshot.verifiedEmail,
  );
  if (normalizedBinding === null) {
    return Object.freeze({ kind: "denied" as const });
  }
  const bindingProvider = input.bindingProvider ?? SITES_IDENTITY_PROVIDER;
  if (
    typeof bindingProvider !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/u.test(bindingProvider)
  ) {
    return Object.freeze({ kind: "unavailable" as const });
  }
  const binding = await input.bindings.readActiveBinding({
    provider: bindingProvider,
    normalizedBinding,
  });
  if (binding.kind === "unavailable") {
    return Object.freeze({ kind: "unavailable" as const });
  }
  if (binding.kind === "bound") {
    if (
      binding.provider !== bindingProvider ||
      binding.normalizedBinding !== normalizedBinding ||
      typeof binding.principalId !== "string" ||
      binding.principalId.length === 0
    ) {
      return Object.freeze({ kind: "unavailable" as const });
    }
    return Object.freeze({
      kind: "authenticated" as const,
      actor: Object.freeze({
        kind: "registered_principal" as const,
        principalId: binding.principalId,
        authentication: Object.freeze({
          kind: "sites_identity" as const,
          verifiedByPlatform: true as const,
        }),
        requestId: input.context.requestId,
        occurredAtUtc: input.context.occurredAtUtc,
        deploymentCapabilities: Object.freeze([
          ...input.context.deploymentCapabilities,
        ]),
      }) as RegisteredSitesActor,
    });
  }
  if (binding.kind !== "unbound") {
    return Object.freeze({ kind: "unavailable" as const });
  }
  return Object.freeze({
    kind: "registration_required" as const,
    actor: Object.freeze({
      kind: "sites_identity_before_registration" as const,
      authentication: Object.freeze({
        kind: "sites_identity" as const,
        verifiedByPlatform: true as const,
      }),
      provider: bindingProvider,
      normalizedBinding:
        normalizedBinding as unknown as SitesIdentityBeforeRegistration["normalizedBinding"],
      ...(input.snapshot.verifiedFullName === undefined
        ? {}
        : { suggestedDisplayName: input.snapshot.verifiedFullName }),
      deploymentCapabilities: Object.freeze([
        ...input.context.deploymentCapabilities,
      ]),
      requestId: input.context.requestId,
      occurredAtUtc: input.context.occurredAtUtc,
    }),
  });
}

export interface ProductWebCsrf {
  issue(actor: ProductWebActor): string | Promise<string>;
  verify(actor: ProductWebActor, token: string): boolean | Promise<boolean>;
}

export interface ProductWebControlApplication {
  execute(request: {
    readonly operation: string;
    readonly actor: ProductWebActor;
    readonly input: Readonly<Record<string, unknown>>;
  }): unknown | Promise<unknown>;
  /**
   * Runs a bounded read-only page projection against one consistent snapshot
   * when the backing store supports it. Test doubles and small adapters may
   * omit this optional optimization and use the regular execute path.
   */
  withConsistentRead?<Result>(
    operation: (control: ProductWebControlApplication) => Promise<Result>,
  ): Promise<Result>;
}

export interface ProductWebOAuthConnections {
  listPage(principalId: string, query: Readonly<{
    readonly limit?: number;
    readonly cursor?: string | null;
  }>): Promise<Readonly<{
    readonly items: readonly {
      readonly connectionRef: string;
      readonly clientName: string;
      readonly scopes: readonly ("content:read" | "content:write")[];
      readonly createdAt: string;
      readonly lastUsedAt: string | null;
    }[];
    readonly nextCursor: string | null;
  }>>;
  read(principalId: string, connectionRef: string): Promise<Readonly<{
    readonly connectionRef: string;
    readonly clientName: string;
    readonly scopes: readonly ("content:read" | "content:write")[];
    readonly createdAt: string;
    readonly lastUsedAt: string | null;
  }> | null>;
  revoke(principalId: string, connectionRef: string): Promise<boolean>;
}

export interface ProductWebPersonalTokenRecord extends PersonalTokenItem {}

export interface ProductWebPersonalTokens {
  listPage(
    actor: RegisteredSitesActor,
    query: Readonly<{
      readonly state?: "active" | "revoked" | "expired";
      readonly limit?: number;
      readonly cursor?: string | null;
    }>,
  ): Promise<Readonly<{
    readonly items: readonly ProductWebPersonalTokenRecord[];
    readonly nextCursor: string | null;
  }>>;
  read(
    actor: RegisteredSitesActor,
    personalTokenRef: string,
  ): Promise<Readonly<ProductWebPersonalTokenRecord> | null>;
}

export type ProductWebPerformanceOperation =
  | "home"
  | "stage_authentication"
  | "stage_application"
  | "stage_total";

export interface ProductWebPerformanceRecorder {
  record(event: {
    readonly requestId: string;
    readonly benchmarkCorrelationId: string | null;
    readonly operation: ProductWebPerformanceOperation;
    readonly durationMs: number;
    readonly outcome: "success" | "failure";
  }): void | Promise<void>;
}

export interface ProductWebHttpHandlerDependencies {
  readonly applicationOrigin: string;
  readonly resolveIdentity: (
    request: Request,
  ) => ProductSitesIdentityResolution | Promise<ProductSitesIdentityResolution>;
  readonly csrf: ProductWebCsrf;
  readonly control: ProductWebControlApplication;
  readonly oauthConnections?: ProductWebOAuthConnections;
  readonly personalTokens?: ProductWebPersonalTokens;
  readonly mindUsage?: ProductWebMindUsageApplication;
  readonly activity?: ProductWebActivityRecorder;
  readonly performance?: ProductWebPerformanceRecorder;
  /** Optional hosted-only coalescing window; defaults to zero to protect navigation latency. */
  readonly activityCoalesceWindowMs?: number;
}
