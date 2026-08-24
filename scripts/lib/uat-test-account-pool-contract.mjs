import { createHash } from "node:crypto";

export const UAT_TEST_ACCOUNT_POOL_SCHEMA =
  "mind-diary/uat-test-account-pool-inventory/v1";
export const UAT_TEST_ACCOUNT_POOL_RECEIPT_SCHEMA =
  "mind-diary/uat-test-account-pool-readiness/v1";

export const REQUIRED_UAT_TEST_ACTOR_ALIASES = Object.freeze([
  "UAT-OPERATOR",
  "UAT-MIND-ROLE",
  "UAT-ORDINARY",
]);

export const OPTIONAL_UAT_TEST_ACTOR_ALIASES = Object.freeze([
  "UAT-DISPOSABLE",
]);

const ACTOR_PROFILES = Object.freeze({
  "UAT-OPERATOR": Object.freeze({
    lifecycle: "persistent-restricted-uat",
    intended_roles: Object.freeze({
      custom_audience: "member",
      service_operator: "allowed",
      ordinary_mind_baseline: "none",
      canary_mind_role: "none",
    }),
  }),
  "UAT-MIND-ROLE": Object.freeze({
    lifecycle: "persistent-restricted-uat",
    intended_roles: Object.freeze({
      custom_audience: "member",
      service_operator: "denied",
      ordinary_mind_baseline: "none",
      canary_mind_role: "editor-temporary",
    }),
  }),
  "UAT-ORDINARY": Object.freeze({
    lifecycle: "persistent-restricted-uat",
    intended_roles: Object.freeze({
      custom_audience: "member",
      service_operator: "denied",
      ordinary_mind_baseline: "none",
      canary_mind_role: "none",
    }),
  }),
  "UAT-DISPOSABLE": Object.freeze({
    lifecycle: "ephemeral-owner-approved",
    intended_roles: Object.freeze({
      custom_audience: "member-temporary",
      service_operator: "denied",
      ordinary_mind_baseline: "none",
      canary_mind_role: "account-lifecycle-only",
    }),
  }),
});

const AUTHORITY_KEYS = Object.freeze([
  "external_account_provisioning",
  "first_login_mfa",
  "custom_audience_mutation",
  "operator_allowlist_mutation",
]);

const AUTHORITY_PENDING = "pending-owner-action";
const AUTHORITY_READY = "owner-confirmed";
const PROVISIONING_PENDING = "pending-owner-action";
const PROVISIONING_READY = "owner-confirmed";
const SESSION_PENDING = "not-run";
const SESSION_READY = "verified";
const READBACK_PENDING = "not-run";
const BASELINE_PENDING = "not-run";
const BASELINE_READY = "verified-absent";
const RECOVERY_POLICY = Object.freeze({
  interrupted_run: "fail-closed-recovery-required",
  per_run_mcp_tokens: "revoke-and-deny-readback",
  temporary_mind_roles: "remove-and-readback-none",
  custom_audience: "owner-restore-exact",
  operator_allowlist: "owner-restore-exact",
});
const FINGERPRINT = /^actor-[a-z0-9]{16,64}$/u;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const FORBIDDEN_FIELD = /^(?:email|account_id|principal_id|session|session_ref|credential|secret|token|token_id|mfa_seed)$/iu;
const FORBIDDEN_VALUE = /(?:@|https?:\/\/|mdp_v1_|mdg_v1_|mdo_(?:code|access|refresh)_|oai-sites-authorization|hmac-sha256:|(?:principal|account|token|grant|session)_[a-z0-9])/iu;

export class UatTestAccountPoolContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "UatTestAccountPoolContractError";
    this.code = code;
  }
}

function fail(code) {
  throw new UatTestAccountPoolContractError(code);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value, keys, code) {
  if (!isRecord(value)) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])) fail(code);
}

function assertSafeDocument(value) {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (FORBIDDEN_VALUE.test(current)) fail("unsafe_pool_document");
      continue;
    }
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (!isRecord(current)) continue;
    for (const [key, fieldValue] of Object.entries(current)) {
      if (FORBIDDEN_FIELD.test(key)) fail("unsafe_pool_document");
      pending.push(fieldValue);
    }
  }
}

function deepFreeze(value) {
  if (!isRecord(value) && !Array.isArray(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function pendingActor(alias) {
  const profile = ACTOR_PROFILES[alias];
  return {
    alias,
    actor_fingerprint: null,
    lifecycle: profile.lifecycle,
    intended_roles: { ...profile.intended_roles },
    provisioning: {
      external_account: PROVISIONING_PENDING,
      first_login_mfa: PROVISIONING_PENDING,
      independent_session: SESSION_PENDING,
    },
  };
}

export function createPendingUatTestAccountPoolInventory({
  includeDisposable = false,
} = {}) {
  const aliases = [
    ...REQUIRED_UAT_TEST_ACTOR_ALIASES,
    ...(includeDisposable ? OPTIONAL_UAT_TEST_ACTOR_ALIASES : []),
  ];
  return deepFreeze({
    schema: UAT_TEST_ACCOUNT_POOL_SCHEMA,
    environment: "uat",
    target_class: "restricted-custom-audience",
    owner_authority: Object.fromEntries(
      AUTHORITY_KEYS.map((key) => [key, AUTHORITY_PENDING]),
    ),
    actors: aliases.map(pendingActor),
    readback: {
      custom_audience: READBACK_PENDING,
      operator_allowlist: READBACK_PENDING,
      distinct_principals: READBACK_PENDING,
    },
    baseline: {
      temporary_mind_roles: BASELINE_PENDING,
      per_run_mcp_tokens: BASELINE_PENDING,
    },
    recovery_policy: { ...RECOVERY_POLICY },
  });
}

function validateActor(actor, expectedAlias, fingerprints) {
  assertExactKeys(actor, [
    "alias",
    "actor_fingerprint",
    "lifecycle",
    "intended_roles",
    "provisioning",
  ], "invalid_actor_shape");
  if (actor.alias !== expectedAlias) fail("invalid_actor_order_or_alias");
  const profile = ACTOR_PROFILES[expectedAlias];
  if (actor.lifecycle !== profile.lifecycle) fail("invalid_actor_profile");
  assertExactKeys(actor.intended_roles, [
    "custom_audience",
    "service_operator",
    "ordinary_mind_baseline",
    "canary_mind_role",
  ], "invalid_actor_profile");
  for (const [key, expected] of Object.entries(profile.intended_roles)) {
    if (actor.intended_roles[key] !== expected) fail("invalid_actor_profile");
  }
  if (actor.actor_fingerprint !== null) {
    if (!FINGERPRINT.test(actor.actor_fingerprint)) fail("invalid_actor_fingerprint");
    if (fingerprints.has(actor.actor_fingerprint)) fail("duplicate_actor_fingerprint");
    fingerprints.add(actor.actor_fingerprint);
  }
  assertExactKeys(actor.provisioning, [
    "external_account",
    "first_login_mfa",
    "independent_session",
  ], "invalid_actor_provisioning");
  if (![PROVISIONING_PENDING, PROVISIONING_READY].includes(
    actor.provisioning.external_account,
  )) fail("invalid_actor_provisioning");
  if (![PROVISIONING_PENDING, PROVISIONING_READY].includes(
    actor.provisioning.first_login_mfa,
  )) fail("invalid_actor_provisioning");
  if (![SESSION_PENDING, SESSION_READY].includes(
    actor.provisioning.independent_session,
  )) fail("invalid_actor_provisioning");
}

export function validateUatTestAccountPoolInventory(value) {
  assertSafeDocument(value);
  assertExactKeys(value, [
    "schema",
    "environment",
    "target_class",
    "owner_authority",
    "actors",
    "readback",
    "baseline",
    "recovery_policy",
  ], "invalid_pool_inventory_shape");
  if (value.schema !== UAT_TEST_ACCOUNT_POOL_SCHEMA ||
    value.environment !== "uat" ||
    value.target_class !== "restricted-custom-audience") {
    fail("invalid_pool_inventory_header");
  }
  assertExactKeys(value.owner_authority, AUTHORITY_KEYS, "invalid_owner_authority");
  for (const key of AUTHORITY_KEYS) {
    if (![AUTHORITY_PENDING, AUTHORITY_READY].includes(value.owner_authority[key])) {
      fail("invalid_owner_authority");
    }
  }
  if (!Array.isArray(value.actors)) fail("invalid_actor_registry");
  const aliases = value.actors.map((actor) => actor?.alias);
  const requiredPrefix = [...REQUIRED_UAT_TEST_ACTOR_ALIASES];
  const allowed = [
    requiredPrefix,
    [...requiredPrefix, ...OPTIONAL_UAT_TEST_ACTOR_ALIASES],
  ];
  if (!allowed.some((expected) =>
    expected.length === aliases.length &&
    expected.every((alias, index) => alias === aliases[index]))) {
    fail("invalid_actor_registry");
  }
  const fingerprints = new Set();
  value.actors.forEach((actor, index) => validateActor(actor, aliases[index], fingerprints));
  assertExactKeys(value.readback, [
    "custom_audience",
    "operator_allowlist",
    "distinct_principals",
  ], "invalid_pool_readback");
  if (![READBACK_PENDING, "exact", "mismatch"].includes(value.readback.custom_audience) ||
    ![READBACK_PENDING, "exact", "mismatch"].includes(value.readback.operator_allowlist) ||
    ![READBACK_PENDING, "verified", "mismatch"].includes(value.readback.distinct_principals)) {
    fail("invalid_pool_readback");
  }
  assertExactKeys(value.baseline, [
    "temporary_mind_roles",
    "per_run_mcp_tokens",
  ], "invalid_pool_baseline");
  for (const state of Object.values(value.baseline)) {
    if (![BASELINE_PENDING, BASELINE_READY, "mismatch"].includes(state)) {
      fail("invalid_pool_baseline");
    }
  }
  assertExactKeys(value.recovery_policy, Object.keys(RECOVERY_POLICY),
    "invalid_recovery_policy");
  for (const [key, expected] of Object.entries(RECOVERY_POLICY)) {
    if (value.recovery_policy[key] !== expected) fail("invalid_recovery_policy");
  }
  return deepFreeze(structuredClone(value));
}

export function assessUatTestAccountPoolReadiness(value) {
  const inventory = validateUatTestAccountPoolInventory(value);
  const blockers = [];
  for (const key of AUTHORITY_KEYS) {
    if (inventory.owner_authority[key] !== AUTHORITY_READY) {
      blockers.push(`owner_authority.${key}`);
    }
  }
  for (const actor of inventory.actors) {
    if (actor.actor_fingerprint === null) {
      blockers.push(`actors.${actor.alias}.actor_fingerprint`);
    }
    if (actor.provisioning.external_account !== PROVISIONING_READY) {
      blockers.push(`actors.${actor.alias}.external_account`);
    }
    if (actor.provisioning.first_login_mfa !== PROVISIONING_READY) {
      blockers.push(`actors.${actor.alias}.first_login_mfa`);
    }
    if (actor.provisioning.independent_session !== SESSION_READY) {
      blockers.push(`actors.${actor.alias}.independent_session`);
    }
  }
  if (inventory.readback.custom_audience !== "exact") {
    blockers.push("readback.custom_audience");
  }
  if (inventory.readback.operator_allowlist !== "exact") {
    blockers.push("readback.operator_allowlist");
  }
  if (inventory.readback.distinct_principals !== "verified") {
    blockers.push("readback.distinct_principals");
  }
  for (const key of ["temporary_mind_roles", "per_run_mcp_tokens"]) {
    if (inventory.baseline[key] !== BASELINE_READY) blockers.push(`baseline.${key}`);
  }
  return deepFreeze({
    status: blockers.length === 0 ? "ready" : "blocked",
    blockers,
  });
}

export function createUatTestAccountPoolReadinessReceipt(value, { observedAtUtc }) {
  const inventory = validateUatTestAccountPoolInventory(value);
  const assessment = assessUatTestAccountPoolReadiness(inventory);
  if (assessment.status !== "ready") fail("pool_not_ready");
  if (typeof observedAtUtc !== "string" || !UTC_INSTANT.test(observedAtUtc) ||
    Number.isNaN(Date.parse(observedAtUtc))) fail("invalid_observed_at");

  const unsigned = {
    schema: UAT_TEST_ACCOUNT_POOL_RECEIPT_SCHEMA,
    status: "ready",
    environment: inventory.environment,
    target_class: inventory.target_class,
    observed_at: observedAtUtc,
    actors: inventory.actors.map((actor) => ({
      alias: actor.alias,
      actor_fingerprint: actor.actor_fingerprint,
      lifecycle: actor.lifecycle,
    })),
    owner_authority: "confirmed-by-owner",
    readback: {
      custom_audience: "exact",
      custom_audience_actor_count: inventory.actors.length,
      operator_allowlist: "exact",
      operator_actor_count: 1,
      distinct_principals: "verified",
    },
    baseline: {
      temporary_mind_roles: BASELINE_READY,
      per_run_mcp_tokens: BASELINE_READY,
    },
    recovery_policy: { ...RECOVERY_POLICY },
    assertions: [
      "authority.owner-confirmed",
      "actors.independent-login-mfa",
      "actors.distinct-principals",
      "sites.custom-audience-exact",
      "operator.allowlist-exact",
      "baseline.no-temporary-role-or-token",
    ].map((id) => ({ id, status: "passed" })),
  };
  const receipt = {
    ...unsigned,
    artifact_sha256: digest(canonical(unsigned)),
  };
  assertSafeDocument(receipt);
  return deepFreeze(receipt);
}
