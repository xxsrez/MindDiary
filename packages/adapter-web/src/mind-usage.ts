import type { PrincipalMindUsageApplicationService } from "@mind-diary/application-control";

import type {
  ProductWebControlApplication,
  RegisteredSitesActor,
} from "./product-http-contracts.js";

import {
  record,
  requiredString,
} from "./product-http-request-helpers.js";

export type MindUsageUiMode = "disabled" | "read" | "read_write";

export interface ProductWebMindUsageApplication
  extends Pick<PrincipalMindUsageApplicationService, "read" | "mutate"> {}

export interface MindUsageUiItem {
  readonly mindRef: string;
  readonly name: string;
  readonly description?: string | null;
  readonly isPersonal: boolean;
  readonly routingProfile: "personal_default" | "description_based";
  readonly visibility: "private" | "unlisted" | "public";
  readonly role: "reader" | "editor" | "admin" | "owner";
  readonly usageMode: MindUsageUiMode;
  readonly effective: {
    readonly canRead: boolean;
    readonly canWrite: boolean;
  };
  readonly eligibility: {
    readonly canRead: true;
    readonly canWrite: boolean;
    readonly descriptionRequired: boolean;
  };
}

export interface MindUsageUiProjection {
  readonly contractVersion: "principal-mind-usage/v2";
  readonly usageVersion: number;
  readonly items: readonly Readonly<MindUsageUiItem>[];
}

interface SafeMindDescriptor {
  readonly mindId: string;
  readonly mindRef: string;
  readonly name: string;
  readonly description: string | null;
  readonly isPersonal: boolean;
  readonly visibility: "private" | "unlisted" | "public";
  readonly role: "reader" | "editor" | "admin" | "owner";
}

function safeDescription(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === "string" ? value : undefined;
}

function safeMindDescriptor(value: unknown): SafeMindDescriptor | null {
  const source = record(value);
  const access = record(source?.access);
  const mindId = requiredString(source?.mindId);
  const route = requiredString(source?.route);
  const name = requiredString(source?.name);
  const isPersonal = source?.isPersonal === true;
  const description = safeDescription(source?.description);
  const visibility = source?.visibility;
  const rawRole = access?.role;
  const role = rawRole === null && access?.kind === "visibility"
    ? "reader"
    : rawRole;
  if (
    mindId === null || route === null || name === null ||
    !/^\/(?:me|[a-z0-9]+(?:-[a-z0-9]+)*)$/u.test(route) ||
    (isPersonal && route !== "/me") ||
    (!isPersonal && route === "/me") ||
    !(visibility === "private" || visibility === "unlisted" || visibility === "public") ||
    !(role === "reader" || role === "editor" || role === "admin" || role === "owner") ||
    description === undefined
  ) return null;
  return Object.freeze({
    mindId,
    mindRef: route,
    name,
    description: description ?? null,
    isPersonal,
    visibility,
    role,
  });
}

function safeUsageState(value: unknown, principalId: string): Readonly<{
  usageVersion: number;
  modes: ReadonlyMap<string, Exclude<MindUsageUiMode, "disabled">>;
}> {
  if (value === null) {
    return Object.freeze({ usageVersion: 0, modes: new Map() });
  }
  const source = record(value);
  if (
    source?.principalId !== principalId ||
    source.contractVersion !== "principal-mind-usage/v2" ||
    !Number.isSafeInteger(source.usageVersion) ||
    Number(source.usageVersion) < 0 ||
    !Array.isArray(source.entries)
  ) throw new TypeError("safe Mind usage state is unavailable");
  const modes = new Map<string, Exclude<MindUsageUiMode, "disabled">>();
  for (const valueEntry of source.entries) {
    const entry = record(valueEntry);
    const spaceId = requiredString(entry?.spaceId);
    const mode = entry?.usageMode;
    if (
      spaceId === null || modes.has(spaceId) ||
      !(mode === "read" || mode === "read_write")
    ) throw new TypeError("safe Mind usage state is unavailable");
    modes.set(spaceId, mode);
  }
  if ([...modes.values()].filter((mode) => mode === "read_write").length > 2) {
    throw new TypeError("safe Mind usage state is unavailable");
  }
  return Object.freeze({ usageVersion: Number(source.usageVersion), modes });
}

function writerRole(role: SafeMindDescriptor["role"]): boolean {
  return role === "editor" || role === "admin" || role === "owner";
}

function projectionItem(
  mind: SafeMindDescriptor,
  usageMode: MindUsageUiMode,
): Readonly<MindUsageUiItem> {
  const hasDescription = mind.description !== null && mind.description.trim().length > 0;
  const canWrite = writerRole(mind.role) && (mind.isPersonal || hasDescription);
  return Object.freeze({
    mindRef: mind.mindRef,
    name: mind.name,
    description: mind.description,
    isPersonal: mind.isPersonal,
    routingProfile: mind.isPersonal ? "personal_default" : "description_based",
    visibility: mind.visibility,
    role: mind.role,
    usageMode,
    effective: Object.freeze({
      canRead: usageMode === "read" || usageMode === "read_write",
      canWrite: usageMode === "read_write" && canWrite,
    }),
    eligibility: Object.freeze({
      canRead: true as const,
      canWrite,
      descriptionRequired: !mind.isPersonal && !hasDescription,
    }),
  });
}

async function allSafeMinds(
  control: ProductWebControlApplication,
  actor: RegisteredSitesActor,
): Promise<readonly SafeMindDescriptor[]> {
  const listed = await control.execute({
    operation: "list_minds",
    actor,
    input: Object.freeze({}),
  });
  return safeMindList(listed);
}

function safeMindList(listed: unknown): readonly SafeMindDescriptor[] {
  if (!Array.isArray(listed)) throw new TypeError("safe Mind list is unavailable");
  const parsed = listed.map(safeMindDescriptor);
  if (parsed.some((mind) => mind === null)) {
    throw new TypeError("safe Mind list is unavailable");
  }
  const minds = parsed.filter((mind): mind is SafeMindDescriptor => mind !== null);
  const personal = minds.find((mind) => mind?.isPersonal === true);
  if (personal === undefined) throw new TypeError("safe Personal Mind is unavailable");
  return Object.freeze(minds as SafeMindDescriptor[]);
}

async function exactSafeMind(
  control: ProductWebControlApplication,
  actor: RegisteredSitesActor,
  mindRef: string,
): Promise<SafeMindDescriptor> {
  const source = await control.execute({
    operation: "get_mind_info",
    actor,
    input: Object.freeze({ mind_ref: mindRef === "/me" ? "me" : mindRef.slice(1) }),
  });
  const mind = safeMindDescriptor(source);
  if (mind === null || mind.mindRef !== mindRef) {
    throw Object.assign(new Error("Mind was not found."), { code: "mind_not_found" });
  }
  return mind;
}

export async function readMindUsageProjection(input: {
  readonly actor: RegisteredSitesActor;
  readonly control: ProductWebControlApplication;
  readonly mindUsage: ProductWebMindUsageApplication;
  readonly mindRef?: string;
  readonly listedMinds?: unknown;
}): Promise<Readonly<MindUsageUiProjection>> {
  const minds = input.mindRef === undefined
    ? input.listedMinds === undefined
      ? await allSafeMinds(input.control, input.actor)
      : safeMindList(input.listedMinds)
    : Object.freeze([
        await exactSafeMind(input.control, input.actor, input.mindRef),
      ]);
  const usage = safeUsageState(await input.mindUsage.read(input.actor), input.actor.principalId);
  return Object.freeze({
    contractVersion: "principal-mind-usage/v2" as const,
    usageVersion: usage.usageVersion,
    items: Object.freeze(minds.map((mind) =>
      projectionItem(mind, usage.modes.get(mind.mindId) ?? "disabled"))),
  });
}

async function readMindUsageProjectionIncluding(
  input: {
    readonly actor: RegisteredSitesActor;
    readonly control: ProductWebControlApplication;
    readonly mindUsage: ProductWebMindUsageApplication;
  },
  mindRef: string,
): Promise<Readonly<MindUsageUiProjection>> {
  const listed = await allSafeMinds(input.control, input.actor);
  const minds = listed.some((mind) => mind.mindRef === mindRef)
    ? listed
    : Object.freeze([
        ...listed,
        await exactSafeMind(input.control, input.actor, mindRef),
      ]);
  const usage = safeUsageState(
    await input.mindUsage.read(input.actor),
    input.actor.principalId,
  );
  return Object.freeze({
    contractVersion: "principal-mind-usage/v2" as const,
    usageVersion: usage.usageVersion,
    items: Object.freeze(minds.map((listedMind) =>
      projectionItem(listedMind, usage.modes.get(listedMind.mindId) ?? "disabled"))),
  });
}

function mutationFailure(kind: string): never {
  const code = kind === "usage_version_conflict"
    ? "usage_conflict"
    : kind === "description_required"
      ? "description_required"
      : kind === "writer_access_required" || kind === "read_access_required"
        ? "usage_not_allowed"
        : kind === "mind_not_found" || kind === "principal_not_found"
          ? "mind_not_found"
          : kind === "idempotency_conflict"
            ? "idempotency_conflict"
            : "operation_failed";
  throw Object.assign(new Error("Mind usage mode was not changed."), { code });
}

export async function mutateMindUsage(input: {
  readonly actor: RegisteredSitesActor;
  readonly control: ProductWebControlApplication;
  readonly mindUsage: ProductWebMindUsageApplication;
  readonly request: Readonly<Record<string, unknown>>;
}): Promise<Readonly<{
  readonly changed: boolean;
  readonly replayed: boolean;
  readonly projection: Readonly<MindUsageUiProjection>;
}>> {
  const allowed = new Set([
    "mind_ref",
    "usageMode",
    "expectedUsageVersion",
    "idempotencyKey",
  ]);
  if (Object.keys(input.request).some((key) => !allowed.has(key))) {
    throw Object.assign(new Error("Invalid Mind usage request."), { code: "invalid_request" });
  }
  const rawRef = input.request.mind_ref;
  const mindRef = typeof rawRef === "string"
    ? rawRef === "me" ? "/me" : `/${rawRef}`
    : null;
  const usageMode = input.request.usageMode;
  const expectedUsageVersion = input.request.expectedUsageVersion;
  const key = requiredString(input.request.idempotencyKey);
  if (
    mindRef === null || !/^\/(?:me|[a-z0-9]+(?:-[a-z0-9]+)*)$/u.test(mindRef) ||
    !(usageMode === "disabled" || usageMode === "read" || usageMode === "read_write") ||
    !Number.isSafeInteger(expectedUsageVersion) || Number(expectedUsageVersion) < 0 ||
    key === null
  ) throw Object.assign(new Error("Invalid Mind usage request."), { code: "invalid_request" });

  const mind = await exactSafeMind(input.control, input.actor, mindRef);
  const result = await input.mindUsage.mutate({
    actor: input.actor,
    spaceId: mind.mindId as never,
    usageMode,
    expectedUsageVersion: Number(expectedUsageVersion),
    idempotencyKey: key,
  });
  if (result.kind !== "applied") mutationFailure(result.kind);
  const projection = await readMindUsageProjectionIncluding({
    actor: input.actor,
    control: input.control,
    mindUsage: input.mindUsage,
  }, mindRef);
  return Object.freeze({
    changed: result.changed,
    replayed: result.replayed,
    projection,
  });
}

export function renderMindUsageCollection(): string {
  return `<section class="md-usage-section" aria-labelledby="mind-usage-heading" data-mind-usage-collection>
    <div class="md-section-heading">
      <div>
        <p class="md-eyebrow">Agent intent</p>
        <h2 id="mind-usage-heading">How Codex uses your Minds</h2>
      </div>
    </div>
    <p>Choose what Codex may do with each Mind. Descriptions define when to use it. My Mind without a description is used only when you ask; with one, it can use matching topics automatically. If both Minds match, Codex can use both independently.</p>
    <p class="md-caveat"><strong>Credentials can only narrow access.</strong> A Connection or token still needs its own read or write scope, and current Mind rights are checked on every call.</p>
    <section class="md-state md-state--loading" aria-busy="true" data-mind-usage-state>
      <div class="md-loading-mark" aria-hidden="true"><span></span><span></span><span></span></div>
      <h3>Loading current agent intent</h3>
      <p role="status" aria-live="polite">Reading the account-wide settings…</p>
    </section>
  </section>`;
}

export function renderMindUsagePanel(mindRef: string): string {
  const safeRef = /^\/(?:me|[a-z0-9]+(?:-[a-z0-9]+)*)$/u.test(mindRef)
    ? mindRef
    : "";
  const policyCopy = safeRef === "/me"
    ? "My Mind without a description is used only when you ask. With a description, Codex reads matching topics and, when writing is allowed, saves discussed lasting knowledge. Ask Codex to configure your topics and exclusions."
    : "For an ordinary Mind, Read and write permits automatic saving only for explicitly discussed durable knowledge that matches the Mind description; My Mind is controlled independently.";
  return `<section class="md-usage-section" aria-labelledby="mind-usage-heading" data-mind-usage-panel data-mind-ref="${safeRef}">
    <div>
      <p class="md-eyebrow">Agent intent</p>
      <h2 id="mind-usage-heading">How Codex uses this Mind</h2>
      <p>This account-wide setting is the same for every Connection and personal token. ${policyCopy}</p>
    </div>
    <section class="md-state md-state--loading" aria-busy="true" data-mind-usage-state>
      <div class="md-loading-mark" aria-hidden="true"><span></span><span></span><span></span></div>
      <h3>Loading current agent intent</h3>
      <p role="status" aria-live="polite">Reading the current mode and availability…</p>
    </section>
  </section>`;
}
