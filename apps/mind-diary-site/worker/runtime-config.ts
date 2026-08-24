export interface ProductEnv {
  readonly ASSETS: Fetcher;
  readonly DB: D1Database;
  readonly MIND_DIARY_BUCKET: R2Bucket;
  readonly MIND_DIARY_PUBLIC_ORIGIN?: string;
  readonly MIND_DIARY_TOKEN_VERIFIER_KEY?: string;
  readonly MIND_DIARY_LOCATOR_KEY?: string;
  readonly MIND_DIARY_EXPORT_DOWNLOAD_VERIFIER_KEY?: string;
  readonly MIND_DIARY_CSRF_KEY?: string;
  readonly MIND_DIARY_SERVICE_OPERATOR_PRINCIPAL_IDS?: string;
  readonly MIND_DIARY_DEPLOYMENT_CLASS?: string;
  readonly MIND_DIARY_DEPLOYMENT_POSTURE?: string;
  readonly MIND_DIARY_CAPACITY_PROFILE?: string;
  readonly MIND_DIARY_RELEASE_CANDIDATE_SHA?: string;
  readonly MIND_DIARY_CAPACITY_FENCE_NONCE?: string;
  readonly MIND_DIARY_PERFORMANCE_CORRELATION_KEY?: string;
}

function deploymentClass(
  value: string | undefined,
): "unknown" | "dev" | "uat" | "production" {
  if (value === undefined || value.trim() === "") return "unknown";
  if (value === "dev" || value === "uat" || value === "production") return value;
  throw new Error(
    "MIND_DIARY_DEPLOYMENT_CLASS must be exactly dev, uat, or production",
  );
}

function serviceOperatorPrincipalIds(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") return Object.freeze([]);
  const ids = value.split(",").map((candidate) => candidate.trim());
  if (
    ids.length > 32 ||
    ids.some((candidate) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(candidate)) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error("MIND_DIARY_SERVICE_OPERATOR_PRINCIPAL_IDS must be a bounded unique opaque-ID list");
  }
  return Object.freeze(ids);
}

function decodeKey(value: string | undefined, name: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new Error(`${name} must be a 32-byte base64url deployment secret`);
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=";
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  if (bytes.byteLength !== 32) throw new Error(`${name} is invalid`);
  return bytes;
}

function capacityConfiguration(
  deploymentPostureValue: string | undefined,
  capacityProfileValue: string | undefined,
  releaseCandidateShaValue: string | undefined,
  capacityFenceNonceValue: string | undefined,
  operatorPrincipalIds: readonly string[],
): Readonly<{
  deploymentPosture?: "production" | "restricted-uat";
  capacityProfileId?: "default-v1" | "restricted-uat-v1";
  releaseCandidateSha?: string;
  capacityFenceNonce?: string;
}> {
  const deploymentPosture = deploymentPostureValue === undefined ||
      deploymentPostureValue === ""
    ? undefined
    : deploymentPostureValue;
  if (
    deploymentPosture !== undefined &&
    deploymentPosture !== "production" &&
    deploymentPosture !== "restricted-uat"
  ) {
    throw new Error("MIND_DIARY_DEPLOYMENT_POSTURE must be production or restricted-uat");
  }
  const capacityProfile = capacityProfileValue === undefined ||
      capacityProfileValue === ""
    ? undefined
    : capacityProfileValue;
  const releaseCandidateSha = releaseCandidateShaValue === undefined ||
      releaseCandidateShaValue === ""
    ? undefined
    : releaseCandidateShaValue;
  const capacityFenceNonce = capacityFenceNonceValue === undefined ||
      capacityFenceNonceValue === ""
    ? undefined
    : capacityFenceNonceValue;
  if (deploymentPosture !== "restricted-uat") {
    if (
      capacityProfile !== undefined ||
      releaseCandidateSha !== undefined ||
      capacityFenceNonce !== undefined
    ) {
      throw new Error("capacity profile and configuration fence require restricted-uat posture");
    }
    return Object.freeze({
      ...(deploymentPosture === undefined ? {} : { deploymentPosture }),
    });
  }
  if (
    capacityProfile !== undefined &&
    capacityProfile !== "restricted-uat-v1"
  ) {
    throw new Error("MIND_DIARY_CAPACITY_PROFILE must be restricted-uat-v1");
  }
  if (operatorPrincipalIds.length < 1) {
    throw new Error("restricted UAT capacity diagnostics require a non-empty service operator allowlist");
  }
  if (releaseCandidateSha === undefined || !/^[0-9a-f]{40}$/u.test(releaseCandidateSha)) {
    throw new Error("MIND_DIARY_RELEASE_CANDIDATE_SHA must be an exact lowercase Git SHA");
  }
  if (
    capacityFenceNonce === undefined ||
    !/^[A-Za-z0-9_-]{22,64}$/u.test(capacityFenceNonce)
  ) {
    throw new Error("MIND_DIARY_CAPACITY_FENCE_NONCE must be a bounded non-secret random nonce");
  }
  return Object.freeze({
    deploymentPosture,
    capacityProfileId: capacityProfile ?? "default-v1",
    releaseCandidateSha,
    capacityFenceNonce,
  });
}

function decodeOptionalKey(value: string | undefined, name: string): Uint8Array | undefined {
  return value === undefined || value === "" ? undefined : decodeKey(value, name);
}

function isCanonicalOrigin(value: string, protocol: "http:" | "https:"): boolean {
  const parsed = new URL(value);
  return parsed.protocol === protocol && parsed.origin === value && parsed.pathname === "/";
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function resolveRuntimePublicOrigin(
  requestOrigin: string,
  configuredOrigin: string | undefined,
): string {
  if (isCanonicalOrigin(requestOrigin, "https:")) {
    const publicOrigin = configuredOrigin ?? requestOrigin;
    if (!isCanonicalOrigin(publicOrigin, "https:")) {
      throw new Error("MIND_DIARY_PUBLIC_ORIGIN must be a canonical HTTPS origin");
    }
    if (requestOrigin !== publicOrigin) throw new Error("request origin does not match configured public origin");
    return publicOrigin;
  }

  const request = new URL(requestOrigin);
  if (!isCanonicalOrigin(requestOrigin, "http:") || !isLoopbackHostname(request.hostname)) {
    throw new Error("MIND_DIARY_PUBLIC_ORIGIN must be a canonical HTTPS origin");
  }
  if (configuredOrigin !== undefined) {
    const configured = new URL(configuredOrigin);
    const localPlaceholder = isCanonicalOrigin(configuredOrigin, "https:") &&
      isLoopbackHostname(configured.hostname) &&
      configured.hostname === request.hostname;
    if (configuredOrigin !== requestOrigin && !localPlaceholder) {
      throw new Error("request origin does not match configured public origin");
    }
  }
  return requestOrigin;
}

export function readRuntimeConfig(request: Request, env: ProductEnv) {
  const requestOrigin = new URL(request.url).origin;
  const publicOrigin = resolveRuntimePublicOrigin(requestOrigin, env.MIND_DIARY_PUBLIC_ORIGIN);
  const operatorPrincipalIds = serviceOperatorPrincipalIds(
    env.MIND_DIARY_SERVICE_OPERATOR_PRINCIPAL_IDS,
  );
  const capacity = capacityConfiguration(
    env.MIND_DIARY_DEPLOYMENT_POSTURE,
    env.MIND_DIARY_CAPACITY_PROFILE,
    env.MIND_DIARY_RELEASE_CANDIDATE_SHA,
    env.MIND_DIARY_CAPACITY_FENCE_NONCE,
    operatorPrincipalIds,
  );
  const performanceCorrelationKey = decodeOptionalKey(
    env.MIND_DIARY_PERFORMANCE_CORRELATION_KEY,
    "MIND_DIARY_PERFORMANCE_CORRELATION_KEY",
  );
  return Object.freeze({
    publicOrigin,
    tokenVerifierKey: decodeKey(env.MIND_DIARY_TOKEN_VERIFIER_KEY, "MIND_DIARY_TOKEN_VERIFIER_KEY"),
    locatorKey: decodeKey(env.MIND_DIARY_LOCATOR_KEY, "MIND_DIARY_LOCATOR_KEY"),
    exportDownloadVerifierKey: decodeKey(env.MIND_DIARY_EXPORT_DOWNLOAD_VERIFIER_KEY, "MIND_DIARY_EXPORT_DOWNLOAD_VERIFIER_KEY"),
    csrfKey: decodeKey(env.MIND_DIARY_CSRF_KEY, "MIND_DIARY_CSRF_KEY"),
    ...(performanceCorrelationKey === undefined ? {} : { performanceCorrelationKey }),
    serviceOperatorPrincipalIds: operatorPrincipalIds,
    deploymentClass: deploymentClass(env.MIND_DIARY_DEPLOYMENT_CLASS),
    ...capacity,
  });
}
