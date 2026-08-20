import type { ControlBoundaryMarker } from "@mind-diary/application-control";

type WebActorContext = ControlBoundaryMarker["actor"];
type SitesActorContext = Extract<
  WebActorContext,
  { readonly kind: "registered_principal" }
>;
type PrincipalId = SitesActorContext["principalId"];

export const SITES_IDENTITY_PROVIDER = "openai-sites" as const;

export const SITES_UNKNOWN_IDENTITY_ACTIONS = Object.freeze([
  "create_isolated_account",
  "manual_recovery",
] as const);

/**
 * A server-owned identity source. The resolver deliberately supplies no HTTP
 * Request, headers, body or query from which identity authority could be
 * reconstructed.
 */
export interface TrustedSitesIdentityProvider {
  readVerifiedIdentity():
    | TrustedSitesIdentitySnapshot
    | Promise<TrustedSitesIdentitySnapshot>;
}

export type TrustedSitesIdentitySnapshot =
  | { readonly kind: "unauthenticated" }
  | {
      readonly kind: "authenticated";
      readonly verifiedEmail: string;
      readonly verifiedFullName?: string;
    };

/** Sensitive lookup material: never include this value in logs or responses. */
export type SitesNormalizedBinding = string & {
  readonly __sitesNormalizedBinding: unique symbol;
};

export interface SitesIdentityBindingLookup {
  readonly provider: string;
  readonly normalizedBinding: SitesNormalizedBinding;
}

export type SitesIdentityBindingLookupResult =
  | {
      readonly kind: "bound";
      readonly provider: string;
      readonly normalizedBinding: SitesNormalizedBinding;
      readonly principalId: PrincipalId;
    }
  | { readonly kind: "unbound" }
  | { readonly kind: "unavailable" };

/** Exact, active external-binding lookup owned by trusted server persistence. */
export interface SitesIdentityBindingReader {
  readActiveBinding(
    lookup: Readonly<SitesIdentityBindingLookup>,
  ):
    | SitesIdentityBindingLookupResult
    | Promise<SitesIdentityBindingLookupResult>;
}

export interface SitesIdentityRequestContext {
  readonly requestId: SitesActorContext["requestId"];
  readonly occurredAtUtc: SitesActorContext["occurredAtUtc"];
  /** Trusted deployment configuration; it can only narrow authorization. */
  readonly deploymentCapabilities: SitesActorContext["deploymentCapabilities"];
}

export type SitesIdentitySafeEventName =
  | "sites_identity_authenticated"
  | "sites_identity_registration_required"
  | "sites_identity_denied"
  | "sites_identity_unavailable";

export interface SitesIdentitySafeEvent {
  readonly event: SitesIdentitySafeEventName;
  readonly requestId: SitesIdentityRequestContext["requestId"];
}

export interface SitesIdentitySafeLogger {
  record(event: Readonly<SitesIdentitySafeEvent>): void | Promise<void>;
}

export type SitesIdentityResolution =
  | {
      readonly kind: "authenticated";
      readonly actor: SitesActorContext;
    }
  | {
      readonly kind: "registration_required";
      readonly actions: typeof SITES_UNKNOWN_IDENTITY_ACTIONS;
    }
  | {
      readonly kind: "denied";
      readonly code: "authentication_required";
      readonly retryable: false;
    }
  | {
      readonly kind: "unavailable";
      readonly code: "identity_binding_unavailable";
      readonly retryable: true;
    };

export interface SitesIdentityResolverDependencies {
  readonly identity: TrustedSitesIdentityProvider;
  readonly bindings: SitesIdentityBindingReader;
  readonly logger?: SitesIdentitySafeLogger;
}

const DENIED = Object.freeze({
  kind: "denied",
  code: "authentication_required",
  retryable: false,
} as const);

const UNAVAILABLE = Object.freeze({
  kind: "unavailable",
  code: "identity_binding_unavailable",
  retryable: true,
} as const);

const REGISTRATION_REQUIRED = Object.freeze({
  kind: "registration_required",
  actions: SITES_UNKNOWN_IDENTITY_ACTIONS,
} as const);

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ASCII_PATTERN = /^[\u0020-\u007e]+$/u;
const LOCAL_PART_PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/u;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const RFC3339_UTC_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u;

function isCanonicalUtcInstant(
  value: unknown,
): value is SitesActorContext["occurredAtUtc"] {
  if (typeof value !== "string") return false;
  const match = RFC3339_UTC_PATTERN.exec(value);
  if (!match) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const date = new Date(parsed);
  const fraction = Number((match[7] ?? "").padEnd(3, "0"));
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3]) &&
    date.getUTCHours() === Number(match[4]) &&
    date.getUTCMinutes() === Number(match[5]) &&
    date.getUTCSeconds() === Number(match[6]) &&
    date.getUTCMilliseconds() === fraction
  );
}

function isValidRequestContext(
  context: SitesIdentityRequestContext,
): boolean {
  return (
    typeof context?.requestId === "string" &&
    REQUEST_ID_PATTERN.test(context.requestId) &&
    isCanonicalUtcInstant(context.occurredAtUtc) &&
    Array.isArray(context.deploymentCapabilities) &&
    context.deploymentCapabilities.every(
      (capability) => typeof capability === "string" && capability.length > 0,
    )
  );
}

export function normalizeSitesVerifiedEmail(
  input: unknown,
): SitesNormalizedBinding | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 320) {
    return null;
  }

  // MVP binding is deliberately conservative: trim ASCII surrounding space
  // and lowercase an otherwise ASCII address. Compatibility/Unicode folding
  // could collapse distinct external identities and is therefore rejected.
  const trimmed = input.trim();
  if (!ASCII_PATTERN.test(trimmed)) return null;
  const normalized = trimmed.toLowerCase();
  if (normalized.length === 0 || normalized.length > 254) return null;
  if (/\s|[\u0000-\u001f\u007f]/u.test(normalized)) return null;

  const parts = normalized.split("@");
  if (parts.length !== 2) return null;
  const local = parts[0];
  const domain = parts[1];
  if (local === undefined || domain === undefined) return null;
  if (
    local.length === 0 ||
    local.length > 64 ||
    domain.length === 0 ||
    domain.length > 253 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !LOCAL_PART_PATTERN.test(local)
  ) {
    return null;
  }

  const labels = domain.split(".");
  if (
    labels.length < 2 ||
    labels.some((label) => !DOMAIN_LABEL_PATTERN.test(label))
  ) {
    return null;
  }

  return normalized as SitesNormalizedBinding;
}

function isExactBoundResult(
  result: unknown,
  lookup: Readonly<SitesIdentityBindingLookup>,
): result is Extract<SitesIdentityBindingLookupResult, { kind: "bound" }> {
  return (
    typeof result === "object" &&
    result !== null &&
    "kind" in result &&
    result.kind === "bound" &&
    "provider" in result &&
    result.provider === lookup.provider &&
    "normalizedBinding" in result &&
    result.normalizedBinding === lookup.normalizedBinding &&
    "principalId" in result &&
    typeof result.principalId === "string" &&
    // Exact runtime invariant enforced by domain opaqueId() without adding a
    // forbidden adapter-web -> domain package dependency.
    result.principalId.length > 0
  );
}

function isResultKind(
  result: unknown,
  kind: "unbound" | "unavailable",
): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "kind" in result &&
    result.kind === kind
  );
}

function safeRequestId(
  value: unknown,
): SitesIdentityRequestContext["requestId"] {
  return (
    typeof value === "string" && REQUEST_ID_PATTERN.test(value)
      ? value
      : "request_invalid"
  ) as SitesIdentityRequestContext["requestId"];
}

function safeRecord(
  logger: SitesIdentitySafeLogger | undefined,
  event: SitesIdentitySafeEventName,
  requestId: SitesIdentityRequestContext["requestId"],
): void {
  if (!logger) return;
  try {
    const pending = logger.record(Object.freeze({ event, requestId }));
    if (
      typeof pending === "object" &&
      pending !== null &&
      "catch" in pending &&
      typeof pending.catch === "function"
    ) {
      void pending.catch(() => undefined);
    }
  } catch {
    // Observability must not affect identity authorization.
  }
}

export class SitesIdentityResolver {
  readonly #identity: TrustedSitesIdentityProvider;
  readonly #bindings: SitesIdentityBindingReader;
  readonly #logger: SitesIdentitySafeLogger | undefined;

  constructor(dependencies: SitesIdentityResolverDependencies) {
    this.#identity = dependencies.identity;
    this.#bindings = dependencies.bindings;
    this.#logger = dependencies.logger;
  }

  async resolve(
    context: SitesIdentityRequestContext,
  ): Promise<SitesIdentityResolution> {
    const requestId = safeRequestId(context?.requestId);
    if (!isValidRequestContext(context)) {
      safeRecord(this.#logger, "sites_identity_denied", requestId);
      return DENIED;
    }

    let snapshot: TrustedSitesIdentitySnapshot;
    try {
      snapshot = await this.#identity.readVerifiedIdentity();
    } catch {
      safeRecord(this.#logger, "sites_identity_unavailable", requestId);
      return UNAVAILABLE;
    }

    if (snapshot?.kind !== "authenticated") {
      safeRecord(this.#logger, "sites_identity_denied", requestId);
      return DENIED;
    }

    let normalizedBinding: SitesNormalizedBinding | null;
    try {
      normalizedBinding = normalizeSitesVerifiedEmail(snapshot.verifiedEmail);
    } catch {
      normalizedBinding = null;
    }
    if (normalizedBinding === null) {
      safeRecord(this.#logger, "sites_identity_denied", requestId);
      return DENIED;
    }

    const lookup = Object.freeze({
      provider: SITES_IDENTITY_PROVIDER,
      normalizedBinding,
    });

    let result: unknown;
    try {
      result = await this.#bindings.readActiveBinding(lookup);
    } catch {
      safeRecord(this.#logger, "sites_identity_unavailable", requestId);
      return UNAVAILABLE;
    }

    if (isResultKind(result, "unbound")) {
      safeRecord(
        this.#logger,
        "sites_identity_registration_required",
        requestId,
      );
      return REGISTRATION_REQUIRED;
    }
    if (!isExactBoundResult(result, lookup)) {
      safeRecord(this.#logger, "sites_identity_unavailable", requestId);
      return UNAVAILABLE;
    }

    const actor = Object.freeze({
      kind: "registered_principal",
      principalId: result.principalId,
      authentication: Object.freeze({ kind: "sites_identity" }),
      deploymentCapabilities: Object.freeze([
        ...context.deploymentCapabilities,
      ]),
      requestId,
      occurredAtUtc: context.occurredAtUtc,
    }) satisfies SitesActorContext;

    safeRecord(this.#logger, "sites_identity_authenticated", requestId);
    return Object.freeze({ kind: "authenticated", actor });
  }
}
