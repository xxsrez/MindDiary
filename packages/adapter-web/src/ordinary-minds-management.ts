import {
  MIND_DIARY_FAVICON_LINKS,
  MIND_DIARY_UI_ASSETS,
  escapeUntrustedText,
  renderMindDiaryAuthenticatedFooter,
  renderMindDiaryAuthenticatedHeader,
} from "./ui-shell.js";
import {
  renderInvitationsMembershipPanel,
  type InvitationMembershipSnapshot,
} from "./invitations-membership.js";
import { renderProductExportWorkflowPanel } from "./export-workflow.js";
import {
  renderMindUsageCollection,
  renderMindUsagePanel,
} from "./mind-usage.js";

export type OrdinaryMindUiRole = "reader" | "editor" | "admin" | "owner";
export type OrdinaryMindUiVisibility = "private" | "unlisted" | "public";

/** Control-plane metadata only. Canonical files never enter this UI model. */
export interface OrdinaryMindUiMind {
  readonly isPersonal?: false;
  readonly mindId: string;
  readonly handle: string;
  readonly name: string;
  readonly description: string | null;
  readonly headRevisionId: string;
  readonly visibility: OrdinaryMindUiVisibility;
  readonly role: OrdinaryMindUiRole;
  readonly metadataVersion: number;
  readonly agentUsage?: { readonly mode: "disabled" | "read" | "read_write"; readonly canRead: boolean; readonly canWrite: boolean };
  readonly updatedLabel: string;
  readonly accessKind?: "membership" | "visibility";
  readonly discovery?: "membership" | "exact_handle" | "public_catalog";
}

export interface PersonalMindUiMind {
  readonly isPersonal: true;
  readonly mindId: string;
  readonly route: "/me";
  readonly name: string;
  readonly headRevisionId: string;
  readonly visibility: "private";
  readonly role: "owner";
  readonly agentUsage?: { readonly mode: "disabled" | "read" | "read_write"; readonly canRead: boolean; readonly canWrite: boolean };
  readonly updatedLabel: string;
}

export type MindListUiMind = OrdinaryMindUiMind | PersonalMindUiMind;

export interface OrdinaryMindUiMember {
  readonly memberId: string;
  readonly displayName: string;
  readonly role: OrdinaryMindUiRole;
  readonly membershipVersion: number;
  readonly isSelf: boolean;
}

export type OrdinaryMindOwnershipCandidates =
  | { readonly kind: "ready"; readonly members: readonly OrdinaryMindUiMember[] }
  | { readonly kind: "error" };

export type OrdinaryMindCollaboration =
  | { readonly kind: "ready"; readonly snapshot: InvitationMembershipSnapshot }
  | { readonly kind: "error" };

export interface OrdinaryMindCapacityUsage {
  readonly logicalHeadBytes: number;
  readonly logicalRetainedBytes: number;
  readonly physicalCanonicalBytes: number;
  readonly temporaryBytes: number;
  readonly d1MetadataBytes: number;
  readonly reservedBytes: number;
  readonly principalPhysicalCanonicalBytes: number;
  readonly mindCanonicalHeadroomBytes: number;
  readonly principalCanonicalHeadroomBytes: number;
  readonly storageAmplification: number;
  readonly utilization: "normal" | "warning" | "soft_limit" | "hard_limit";
}

export type OrdinaryMindCapacity =
  | { readonly kind: "ready"; readonly usage: OrdinaryMindCapacityUsage }
  | { readonly kind: "error" };

export type OrdinaryMindsUiCollectionState =
  | { readonly kind: "ready"; readonly minds: readonly MindListUiMind[] }
  | { readonly kind: "loading" }
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly message: string };

export type OrdinaryMindsManagementView =
  | {
      readonly kind: "list";
      readonly collection: OrdinaryMindsUiCollectionState;
    }
  | {
      readonly kind: "detail";
      readonly mind: OrdinaryMindUiMind;
      readonly ownership?: OrdinaryMindOwnershipCandidates;
      readonly collaboration?: OrdinaryMindCollaboration;
      readonly capacity?: OrdinaryMindCapacity;
    }
  | { readonly kind: "route_loading"; readonly handle: string }
  | { readonly kind: "route_error"; readonly handle: string; readonly message: string };

export interface OrdinaryMindsManagementModel {
  readonly displayName: string;
  readonly view: OrdinaryMindsManagementView;
  readonly announcement?: string;
}

export interface CreateOrdinaryMindUiCommand {
  readonly name: string;
  readonly handle: string;
  readonly description?: string | null;
  readonly idempotencyKey: string;
}

export interface RenameOrdinaryMindUiCommand {
  readonly handle: string;
  readonly name: string;
  readonly description: string | null;
  readonly expectedMetadataVersion: number;
  readonly idempotencyKey: string;
}

export interface OrdinaryMindDeletionImpactUi {
  readonly impactId: string;
  readonly expiresAt: string;
  readonly mind: Readonly<{ readonly route: string; readonly name: string }>;
  readonly revisionCount: number;
  readonly membershipCount: number;
  readonly pendingInvitationCount: number;
  readonly backgroundJobCount: number;
  readonly exportJobCount: number;
  readonly irreversible: true;
  readonly recoveryAvailable: false;
  readonly forensicReceiptRetained: false;
  readonly confirmation: string;
}

export interface DeleteOrdinaryMindUiCommand {
  readonly handle: string;
  readonly impactId: string;
  readonly confirmation: string;
  readonly idempotencyKey: string;
}

export interface OrdinaryMindDeletionUiResult {
  readonly replayed: boolean;
}

/**
 * Browser-facing use cases are deliberately limited to ordinary-Mind metadata.
 * No browse, fetch, file, or changeset method is available on this adapter.
 */
export interface OrdinaryMindsManagementAdapter {
  listMinds(): Promise<readonly MindListUiMind[]>;
  createMind(command: CreateOrdinaryMindUiCommand): Promise<OrdinaryMindUiMind>;
  renameMind(command: RenameOrdinaryMindUiCommand): Promise<OrdinaryMindUiMind>;
  getDeletionImpact(handle: string): Promise<OrdinaryMindDeletionImpactUi>;
  deleteMind(command: DeleteOrdinaryMindUiCommand): Promise<OrdinaryMindDeletionUiResult>;
}

export interface OrdinaryMindsManagementInstallOptions {
  readonly idempotencyKey?: () => string;
}

const HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_CLIENT_PATH = /^\/[A-Za-z0-9][A-Za-z0-9/_-]*\.(?:js|mjs)$/u;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

function safeHandle(value: unknown): string | null {
  return typeof value === "string" &&
      value.length >= 3 &&
      value.length <= 63 &&
      HANDLE_PATTERN.test(value)
    ? value
    : null;
}

function safeRole(value: unknown): OrdinaryMindUiRole {
  return value === "reader" || value === "editor" || value === "admin" || value === "owner"
    ? value
    : "reader";
}

function safeVisibility(value: unknown): OrdinaryMindUiVisibility {
  return value === "private" || value === "unlisted" || value === "public"
    ? value
    : "private";
}

function safeMetadataVersion(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function isSafeMind(value: unknown): value is OrdinaryMindUiMind {
  if (typeof value !== "object" || value === null) return false;
  const mind = value as Partial<OrdinaryMindUiMind>;
  return typeof mind.mindId === "string" && mind.mindId.length > 0 &&
    safeHandle(mind.handle) !== null &&
    typeof mind.name === "string" && mind.name.trim().length > 0 && mind.name.length <= 80 &&
    (mind.description === null ||
      (typeof mind.description === "string" && [...mind.description].length <= 500)) &&
    typeof mind.headRevisionId === "string" && mind.headRevisionId.length > 0 &&
    safeRole(mind.role) === mind.role &&
    safeVisibility(mind.visibility) === mind.visibility &&
    safeMetadataVersion(mind.metadataVersion) !== null &&
    typeof mind.updatedLabel === "string";
}

function isSafePersonalMind(value: unknown): value is PersonalMindUiMind {
  if (typeof value !== "object" || value === null) return false;
  const mind = value as Partial<PersonalMindUiMind>;
  return mind.isPersonal === true &&
    typeof mind.mindId === "string" && mind.mindId.length > 0 &&
    mind.route === "/me" &&
    typeof mind.name === "string" && mind.name.trim().length > 0 && mind.name.length <= 80 &&
    typeof mind.headRevisionId === "string" && mind.headRevisionId.length > 0 &&
    mind.visibility === "private" &&
    mind.role === "owner" &&
    typeof mind.updatedLabel === "string";
}

function isSafeListMind(value: unknown): value is MindListUiMind {
  return isSafePersonalMind(value) || isSafeMind(value);
}

function personalFirst(minds: readonly MindListUiMind[]): MindListUiMind[] {
  return [...minds].sort((left, right) => Number(right.isPersonal === true) - Number(left.isPersonal === true));
}

function hasExactlyOnePersonalMind(minds: readonly MindListUiMind[]): boolean {
  return minds.filter((mind) => mind.isPersonal === true).length === 1;
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

export function suggestOrdinaryMindHandle(name: string): string {
  const normalized = name
    .normalize("NFKC")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 63)
    .replace(/-+$/gu, "");
  if (normalized.length >= 3) return normalized;
  if (normalized.length > 0) return `${normalized}-mind`.slice(0, 63);
  return "new-mind";
}

function visibilityLabel(value: OrdinaryMindUiVisibility): string {
  switch (value) {
    case "private":
      return "Private";
    case "unlisted":
      return "Unlisted";
    case "public":
      return "Public";
  }
}

const MIND_STATUS_SPRITE = `<svg class="md-mind-icon-sprite" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><symbol id="md-mind-icon-owner" viewBox="0 0 24 24"><path d="m3 6 4 4 5-6 5 6 4-4-2 13H5Z"/></symbol><symbol id="md-mind-icon-admin" viewBox="0 0 24 24"><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z"/><path d="m8 12 3 3 5-6"/></symbol><symbol id="md-mind-icon-editor" viewBox="0 0 24 24"><path d="m15 4 5 5M4 20l5-1L20 8a3.5 3.5 0 0 0-5-5L4 14Z"/></symbol><symbol id="md-mind-icon-reader" viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></symbol><symbol id="md-mind-icon-private" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></symbol><symbol id="md-mind-icon-unlisted" viewBox="0 0 24 24"><path d="m10 13 4-4m-5 6-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/></symbol><symbol id="md-mind-icon-public" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></symbol><symbol id="md-mind-icon-ready" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/></symbol><symbol id="md-mind-icon-disabled" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/></symbol><symbol id="md-mind-icon-read" viewBox="0 0 24 24"><path d="M12 6C9 3 5 3 2 4v15c4-1 7-1 10 2 3-3 6-3 10-2V4c-3-1-7-1-10 2Zm0 0v15"/></symbol><symbol id="md-mind-icon-read_write" viewBox="0 0 24 24"><path d="M10 6C7 3 4 3 2 4v15c3-1 5-1 8 1V6Zm4 0 3-2m-5 17 4-1 7-10-3-2-7 10Z"/></symbol><symbol id="md-mind-icon-unknown" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 5 2c-2 1-2 2-2 3m0 3h.01"/></symbol><symbol id="md-mind-icon-warning" viewBox="0 0 24 24"><path d="m12 3 10 18H2Zm0 6v5m0 3h.01"/></symbol></svg>`;

function renderStatusIcon(icon: string, label: string): string {
  const safeLabel = escapeUntrustedText(label);
  return `<button type="button" class="md-mind-status" aria-label="${safeLabel}"><svg class="md-mind-status__icon" aria-hidden="true"><use href="#md-mind-icon-${icon}" /></svg></button>`;
}

function renderMindStatuses(mind: MindListUiMind): string {
  const personal = mind.isPersonal === true;
  const role = safeRole(mind.role);
  const visibility = safeVisibility(mind.visibility);
  const route = personal ? "/me" : `/${safeHandle(mind.handle) ?? "unavailable"}`;
  const access = personal ? "Sole Owner" : role === "owner" ? "Owned by you" : mind.accessKind === "visibility" ? "Reader by visibility" : `${titleCase(role)} member`;
  const candidate = mind.agentUsage?.mode;
  const mode = candidate === "disabled" || candidate === "read" || candidate === "read_write" ? candidate : "unknown";
  const label = { disabled: "None", read: "Read", read_write: "Read + write", unknown: "Unknown" }[mode];
  const limited = mode === "read_write" && !mind.agentUsage?.canWrite;
  const explanation = `Codex: ${label}${limited ? ". Writing is currently unavailable; check access and description." : personal && mode !== "disabled" && mode !== "unknown" ? ". Personal Mind is used only on your direct request." : "."} Open Mind settings.`;
  return `<div class="md-mind-statuses" role="group" aria-label="Mind status">${renderStatusIcon(role, `Access: ${access}`)}${renderStatusIcon(visibility, `Visibility: ${personal ? "Private, always" : visibilityLabel(visibility)}`)}${personal ? "" : renderStatusIcon("ready", mind.updatedLabel)}<a class="md-mind-mode" href="${route}#mind-usage-heading" data-agent-mode="${mode}" aria-label="${escapeUntrustedText(explanation)}" title="${escapeUntrustedText(explanation)}"><svg class="md-mind-status__icon" aria-hidden="true"><use href="#md-mind-icon-${limited ? "warning" : mode}" /></svg><span>${label}</span></a></div>`;
}

function renderMindCard(mind: OrdinaryMindUiMind): string {
  const handle = safeHandle(mind.handle);
  const role = safeRole(mind.role);
  const route = handle === null ? "#" : `/${handle}`;
  const action = handle === null
    ? '<span class="md-token-card__final-state">Unavailable</span>'
    : `<a class="md-button md-button--secondary" href="${route}" data-manage-mind>${mind.accessKind === "visibility" ? "Open read-only" : "Manage"}</a>`;
  return `<article class="md-token-card md-entity-row md-mind-row" tabindex="-1" data-mind-card="${escapeUntrustedText(handle ?? "invalid-handle")}" data-mind-role="${role}" data-ia-row>
    <div class="md-token-card__heading">
      <div>
        <h3><a href="${route}">${escapeUntrustedText(mind.name)}</a></h3>
        <code>/${escapeUntrustedText(handle ?? "unavailable")}</code>
      </div>
      <span class="md-token-state md-token-state--active"><span aria-hidden="true">●</span> ${mind.accessKind === "visibility" ? "Signed-in reader" : role === "owner" ? "Owner" : "Member"}</span>
    </div>
    ${mind.description === null
      ? '<p class="md-card__description">No description yet.</p>'
      : `<p class="md-card__description">${escapeUntrustedText(mind.description)}</p>`}
    ${renderMindStatuses(mind)}
    <div class="md-token-card__action">${action}</div>
  </article>`;
}

function renderPersonalMindCard(mind: PersonalMindUiMind): string {
  return `<article class="md-token-card md-entity-row md-mind-row" tabindex="-1" data-mind-card="me" data-mind-role="owner" data-personal-mind data-ia-row data-ia-disclosure>
    <div class="md-token-card__heading">
      <div><h3><a href="/me">My Mind</a></h3><code>/me</code></div>
      <span class="md-token-state md-token-state--active"><span aria-hidden="true">●</span> Personal</span>
    </div>
    <p class="md-card__description">Private to you. Follows ${escapeUntrustedText(mind.name)}’s profile; no separate rename, description, publication, transfer, or deletion.</p>
    ${renderMindStatuses(mind)}
    <div class="md-token-card__action"><a class="md-button md-button--secondary" href="/me">Open My Mind</a></div>
  </article>`;
}

function renderListMindCard(mind: MindListUiMind): string {
  return mind.isPersonal === true ? renderPersonalMindCard(mind) : renderMindCard(mind);
}

function renderCollection(collection: OrdinaryMindsUiCollectionState): string {
  switch (collection.kind) {
    case "loading":
      return `<section class="md-state md-state--loading" aria-labelledby="ordinary-minds-heading" aria-busy="true" data-minds-collection data-ia-route-state="loading">
        <div class="md-loading-mark" aria-hidden="true"><span></span><span></span><span></span></div>
        <h2 id="ordinary-minds-heading">Loading your Minds</h2>
        <p role="status" aria-live="polite">Checking owned and member Minds…</p>
      </section>`;
    case "empty":
      return `<section class="md-state md-state--empty" aria-labelledby="ordinary-minds-heading" data-minds-collection data-ia-route-state="empty">
        <span class="md-state__symbol" aria-hidden="true">+</span>
        <h2 id="ordinary-minds-heading">No shared Minds yet</h2>
        <p>Create an ordinary Mind when you want a separate knowledge space or a place to collaborate.</p>
        <button class="md-button md-button--primary" type="button" data-open-create-mind>Create a Mind</button>
      </section>`;
    case "error":
      return `<section class="md-state md-state--error" aria-labelledby="ordinary-minds-heading" role="alert" data-minds-collection data-ia-route-state="error">
        <span class="md-state__symbol" aria-hidden="true">!</span>
        <h2 id="ordinary-minds-heading">We couldn’t load your Minds</h2>
        <p>${escapeUntrustedText(collection.message)}</p>
        <button class="md-button md-button--secondary" type="button" data-retry-minds>Try again</button>
      </section>`;
    case "ready":
      if (collection.minds.length === 0) return renderCollection({ kind: "empty" });
      return `<section aria-labelledby="ordinary-minds-heading" data-minds-collection data-ia-collection>
        <div class="md-section-heading">
          <div>

            <h2 id="ordinary-minds-heading">Your Minds</h2>
          </div>
          <button class="md-button md-button--primary" type="button" data-open-create-mind>Create a Mind</button>
        </div>
        <div class="md-token-grid" data-minds-list>${personalFirst(collection.minds).map(renderListMindCard).join("")}</div>
      </section>`;
  }
}

function renderAnnouncement(message: string | undefined): string {
  return message
    ? `<p class="md-announcement" role="status" aria-live="polite" data-page-announcement><span aria-hidden="true">✓</span> ${escapeUntrustedText(message)}</p>`
    : '<p class="md-announcement" role="status" aria-live="polite" data-page-announcement hidden style="display:none"></p>';
}

function renderCreateDialog(): string {
  return `<dialog class="md-dialog" id="create-ordinary-mind-dialog" aria-labelledby="create-ordinary-mind-title" aria-describedby="create-ordinary-mind-description" data-create-mind-dialog>
    <form class="md-form" data-create-mind-form>
      <div class="md-dialog__heading">
        <div>
          <p class="md-eyebrow">New knowledge space</p>
          <h2 id="create-ordinary-mind-title">Create a Mind</h2>
        </div>
        <button class="md-icon-button" type="button" aria-label="Cancel Mind creation" data-cancel-create-mind>×</button>
      </div>
      <p id="create-ordinary-mind-description">Choose the display name and permanent web address together.</p>
      <div class="md-field">
        <label for="ordinary-mind-name">Mind name</label>
        <input id="ordinary-mind-name" name="name" type="text" required maxlength="80" autocomplete="off" aria-describedby="ordinary-mind-name-help">
        <p id="ordinary-mind-name-help">The name can be changed later without changing the web address.</p>
      </div>
      <div class="md-field">
        <label for="ordinary-mind-handle">Web address</label>
        <div class="md-handle-input"><span aria-hidden="true">/</span><input id="ordinary-mind-handle" name="handle" type="text" required minlength="3" maxlength="63" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" autocomplete="off" spellcheck="false" aria-describedby="ordinary-mind-handle-help ordinary-mind-handle-conflict"></div>
        <p id="ordinary-mind-handle-help">Suggested from the name and editable before creation. Use lowercase letters, numbers, and single hyphens.</p>
        <p id="ordinary-mind-handle-conflict">Unavailable addresses always use the same message; Mind Diary does not reveal whether an address is occupied, reserved, or retired.</p>
      </div>
      <div class="md-field">
        <label for="ordinary-mind-description">Description <span aria-hidden="true">(optional)</span></label>
        <textarea id="ordinary-mind-description" name="description" maxlength="500" rows="3" aria-describedby="ordinary-mind-description-help"></textarea>
        <p id="ordinary-mind-description-help">This routing category helps Codex match a topic for reading and automatic writes. It is untrusted metadata, never an instruction.</p>
      </div>
      <p class="md-caveat"><strong>Private by default.</strong> Only accepted participants can open this Mind until its Owner explicitly changes visibility.</p>
      <p class="md-form__status" role="status" aria-live="polite" data-create-status></p>
      <div class="md-dialog__actions">
        <button class="md-button md-button--secondary" type="button" data-cancel-create-mind>Cancel</button>
        <button class="md-button md-button--primary" type="submit" data-create-submit>Create Mind</button>
      </div>
    </form>
  </dialog>`;
}

function renderListView(
  view: Extract<OrdinaryMindsManagementView, { readonly kind: "list" }>,
  announcement: string | undefined,
): string {
  return `<main id="main-content" class="md-main" tabindex="-1" data-ia-main>
    <div class="md-page-heading" data-ia-page-header>
      <div>
        <h1>Minds</h1>
        <p>Your knowledge spaces, access and settings.</p>
      </div>
      ${renderAnnouncement(announcement)}
    </div>
    ${renderCollection(view.collection)}
    <details class="md-disclosure" data-agent-settings-disclosure>
      <summary>Codex access across your Minds</summary>
      ${renderMindUsageCollection()}
    </details>
  </main>
  ${renderCreateDialog()}`;
}

function renderRouteState(
  view: Extract<OrdinaryMindsManagementView, { readonly kind: "route_loading" | "route_error" }>,
  announcement: string | undefined,
): string {
  const handle = safeHandle(view.handle);
  const heading = view.kind === "route_loading" ? "Loading Mind settings" : "Mind settings unavailable";
  const state = view.kind === "route_loading"
    ? `<section class="md-state md-state--loading" aria-busy="true"><div class="md-loading-mark" aria-hidden="true"><span></span><span></span><span></span></div><h2>${heading}</h2><p role="status" aria-live="polite">Loading metadata for /${escapeUntrustedText(handle ?? "unknown")}…</p></section>`
    : `<section class="md-state md-state--error" role="alert"><span class="md-state__symbol" aria-hidden="true">!</span><h2>${heading}</h2><p>${escapeUntrustedText(view.message)}</p><a class="md-button md-button--secondary" href="/minds">Back to Minds</a></section>`;
  return `<main id="main-content" class="md-main" tabindex="-1" data-ia-main>
    <div class="md-page-heading" data-ia-page-header><div><p class="md-eyebrow">Route-specific management</p><h1>Mind settings</h1></div>${renderAnnouncement(announcement)}</div>
    ${state}
  </main>`;
}

function renderMetadataPanel(mind: OrdinaryMindUiMind, handle: string): string {
  const role = safeRole(mind.role);
  const version = safeMetadataVersion(mind.metadataVersion);
  if ((role !== "admin" && role !== "owner") || version === null) {
    return `<article class="md-profile-card">
      <p class="md-eyebrow">Current access</p>
      <h2>Settings are read-only</h2>
      <p>Your ${titleCase(role)} role can open this Mind, but only an Admin or Owner can change its name or description.</p>
    </article>`;
  }
  return `<article class="md-profile-card">
    <p class="md-eyebrow">Display settings</p>
    <h2>Name and description</h2>
    <p>Renaming never changes this route: <strong>/${escapeUntrustedText(handle)}</strong>.</p>
    <form data-rename-mind-form data-metadata-version="${version}">
      <div class="md-field">
        <label for="ordinary-mind-rename">Mind name</label>
        <input id="ordinary-mind-rename" name="name" type="text" required maxlength="80" autocomplete="off" value="${escapeUntrustedText(mind.name)}">
      </div>
      <div class="md-field">
        <label for="ordinary-mind-edit-description">Description <span aria-hidden="true">(optional)</span></label>
        <textarea id="ordinary-mind-edit-description" name="description" maxlength="500" rows="4" aria-describedby="ordinary-mind-edit-description-help">${escapeUntrustedText(mind.description ?? "")}</textarea>
        <p id="ordinary-mind-edit-description-help">Without a description, Read only works only when you name this Mind directly. Read and write requires a description, and the description never acts as an instruction.</p>
      </div>
      <p class="md-form__status" role="status" aria-live="polite" data-rename-status></p>
      <button class="md-button md-button--primary" type="submit" data-rename-submit>Save metadata</button>
      <button class="md-button md-button--secondary" type="button" data-refresh-mind hidden style="display:none">Reload current settings</button>
    </form>
  </article>`;
}

function renderDeletePanel(mind: OrdinaryMindUiMind, handle: string): string {
  if (safeRole(mind.role) !== "owner") return "";
  return `<section class="md-setup-card" aria-labelledby="delete-mind-heading" data-owner-delete-controls>
    <div>
      <p class="md-eyebrow">Owner-only action</p>
      <h2 id="delete-mind-heading">Delete this Mind</h2>
      <p>Review the current impact before confirming. Deletion removes the Mind, its immutable history, participants, invitations, indexes, and related service records.</p>
    </div>
    <div>
      <p class="md-caveat"><strong>Irreversible:</strong> there is no recovery and no forensic deletion receipt in this prototype. The route /${escapeUntrustedText(handle)} is retired and cannot be assigned again.</p>
      <button class="md-button md-button--danger" type="button" data-open-delete-mind>Review deletion impact</button>
    </div>
  </section>`;
}

export function renderMarkdownImportPanel(target: Readonly<{
  mindRef: string;
  headRevisionId: string;
}>): string {
  return `<section class="md-setup-card md-import-panel" aria-labelledby="markdown-import-heading" data-markdown-import data-head-revision="${escapeUntrustedText(target.headRevisionId)}" data-import-handle="${escapeUntrustedText(target.mindRef)}">
    <div>
      <p class="md-eyebrow">Markdown snapshot</p>
      <h2 id="markdown-import-heading">Import a folder</h2>
      <p>Select UTF-8 Markdown files, review the exact change plan, then publish the whole snapshot as one immutable revision.</p>
      <dl class="md-import-target" aria-label="Import target">
        <div><dt>Target Mind</dt><dd><code data-import-target>/${escapeUntrustedText(target.mindRef)}</code></dd></div>
        <div><dt>Current revision</dt><dd><code data-import-base-revision>${escapeUntrustedText(target.headRevisionId)}</code></dd></div>
      </dl>
    </div>
    <form data-markdown-import-form>
      <div class="md-field">
        <label for="markdown-import-files">Markdown folder or files</label>
        <input id="markdown-import-files" name="files" type="file" accept=".md,text/markdown" multiple webkitdirectory directory data-import-files aria-describedby="markdown-import-help">
        <p id="markdown-import-help">Up to 10,000 files, 1 MiB each and 64 MiB total. ZIP and non-Markdown files are not accepted.</p>
      </div>
      <button class="md-button md-button--secondary" type="button" data-plan-markdown-import>Review exact changes</button>
      <section class="md-import-review" data-import-plan hidden style="display:none" aria-labelledby="markdown-import-review-heading">
        <h3 id="markdown-import-review-heading">Exact change plan</h3>
        <dl class="md-import-counts">
          <div><dt>Add</dt><dd data-import-additions>0</dd></div>
          <div><dt>Replace</dt><dd data-import-replacements>0</dd></div>
          <div><dt>Delete</dt><dd data-import-deletions>0</dd></div>
          <div><dt>Unchanged</dt><dd data-import-unchanged>0</dd></div>
        </dl>
        <ul class="md-import-checks" aria-label="Import checks">
          <li data-import-path-check data-check-state="pending">Paths: waiting for review.</li>
          <li data-import-format-check data-check-state="pending">Format: waiting for review.</li>
          <li data-import-capacity-check data-check-state="pending">Capacity: waiting for server plan.</li>
        </ul>
        <div class="md-caveat md-import-warning">
          <p><strong>Snapshot replacement:</strong> every current Markdown file omitted from this selection will be deleted from the new HEAD. Existing opaque files remain, and immutable history is not erased.</p>
          <label><input type="checkbox" data-import-confirm> I understand this replacement plan and want to create one new revision.</label>
        </div>
      </section>
      <section class="md-import-progress" data-import-progress-region hidden style="display:none" aria-labelledby="markdown-import-progress-label">
        <div><strong id="markdown-import-progress-label" data-import-phase>Preparing import</strong><output data-import-progress-text>0%</output></div>
        <progress data-import-progress max="100" value="0">0%</progress>
      </section>
      <p class="md-form__status" role="status" aria-live="polite" data-import-status></p>
      <div class="md-import-actions">
        <button class="md-button md-button--primary" type="submit" data-start-markdown-import disabled>Start or resume import</button>
        <button class="md-button md-button--secondary" type="button" data-cancel-markdown-import hidden style="display:none">Cancel staged import</button>
        <button class="md-button md-button--secondary" type="button" data-retry-markdown-import-status hidden style="display:none">Retry recovery</button>
        <button class="md-button md-button--secondary" type="button" data-replan-markdown-import hidden style="display:none">Reload and make a new plan</button>
      </div>
      <section class="md-import-receipt" data-import-receipt hidden style="display:none" aria-labelledby="markdown-import-receipt-heading">
        <h3 id="markdown-import-receipt-heading">Revision created</h3>
        <dl>
          <div><dt>Target Mind</dt><dd><code data-import-receipt-target></code></dd></div>
          <div><dt>Planned from</dt><dd><code data-import-receipt-base></code></dd></div>
          <div><dt>Committed revision</dt><dd><code data-import-receipt-revision></code></dd></div>
        </dl>
        <p>The new snapshot became visible atomically; no partial HEAD was published.</p>
      </section>
    </form>
  </section>`;
}

function renderVisibilityPanel(mind: OrdinaryMindUiMind, handle: string): string {
  const visibility = safeVisibility(mind.visibility);
  const role = safeRole(mind.role);
  if (role !== "owner" || mind.accessKind === "visibility") {
    const baseline = mind.accessKind === "visibility"
      ? "This signed-in baseline access is read-only and does not create membership."
      : "Only the current Owner can change visibility.";
    return `<section class="md-setup-card" aria-labelledby="visibility-heading" data-visibility-readonly>
      <div><p class="md-eyebrow">Visibility</p><h2 id="visibility-heading">${visibilityLabel(visibility)}</h2><p>${baseline}</p></div>
      ${visibility === "unlisted" ? '<p class="md-caveat"><strong>The exact URL is not a secret.</strong> Signed-in non-members who learn it can read live HEAD and the entire immutable history.</p>' : ""}
      ${visibility === "public" ? '<p class="md-caveat"><strong>Authenticated readers only.</strong> Public does not mean anonymous access or membership.</p>' : ""}
    </section>`;
  }
  return `<section class="md-setup-card" aria-labelledby="visibility-heading" data-owner-visibility-controls>
    <div>
      <p class="md-eyebrow">Owner control</p>
      <h2 id="visibility-heading">Choose who can find and read this Mind</h2>
      <p>Visibility never creates membership or write access. Public and unlisted both require a signed-in account.</p>
    </div>
    <form data-visibility-form data-current-visibility="${visibility}" data-metadata-version="${mind.metadataVersion}">
      <div class="md-field">
        <label for="ordinary-mind-visibility">Visibility</label>
        <select id="ordinary-mind-visibility" name="visibility" data-visibility-selector>
          <option value="private"${visibility === "private" ? " selected" : ""}>Private — participants only</option>
          <option value="unlisted"${visibility === "unlisted" ? " selected" : ""}>Unlisted — exact URL, not catalogued</option>
          <option value="public"${visibility === "public" ? " selected" : ""}>Public — listed for signed-in people</option>
        </select>
      </div>
      <section class="md-caveat" data-visibility-exposure hidden style="display:none">
        <h3>Live HEAD and all immutable history become readable</h3>
        <p>New successful commits become visible immediately. Unlisted removes catalog discovery, but /${escapeUntrustedText(handle)} is not a secret.</p>
        <label><input type="checkbox" data-visibility-ack disabled> I understand that signed-in non-members will be able to read live HEAD and the entire history.</label>
      </section>
      <section class="md-caveat" data-visibility-private hidden style="display:none">
        <h3>Private stops future access only</h3>
        <p>Returning to private immediately revokes baseline Web, MCP, and history access, but cannot undo disclosure that already happened.</p>
      </section>
      <p class="md-form__status" role="status" aria-live="polite" data-visibility-status></p>
      <button class="md-button md-button--primary" type="submit" data-save-visibility disabled>Save visibility</button>
    </form>
  </section>`;
}

function renderOwnershipPanel(
  mind: OrdinaryMindUiMind,
  ownership: OrdinaryMindOwnershipCandidates | undefined,
): string {
  if (safeRole(mind.role) !== "owner") return "";
  if (ownership?.kind !== "ready") {
    return `<section class="md-setup-card" aria-labelledby="ownership-heading" data-ownership-unavailable>
      <div><p class="md-eyebrow">Single Owner</p><h2 id="ownership-heading">Transfer ownership</h2><p>Current participants are unavailable. Nothing can be transferred until this page is reloaded.</p></div>
    </section>`;
  }
  const source = ownership.members.find((member) => member.isSelf && member.role === "owner");
  if (source === undefined || !Number.isSafeInteger(source.membershipVersion) || source.membershipVersion < 1) {
    return `<section class="md-setup-card" aria-labelledby="ownership-heading" data-ownership-unavailable>
      <div><p class="md-eyebrow">Single Owner</p><h2 id="ownership-heading">Transfer ownership</h2><p>Current Owner state is unavailable. Nothing can be transferred until this page is reloaded.</p></div>
    </section>`;
  }
  const candidates = ownership.members.filter((member) =>
    !member.isSelf && member.role !== "owner" &&
    Number.isSafeInteger(member.membershipVersion) && member.membershipVersion >= 1
  );
  const options = candidates.map((member) =>
    `<option value="${escapeUntrustedText(member.memberId)}" data-membership-version="${member.membershipVersion}" data-display-name="${escapeUntrustedText(member.displayName)}">${escapeUntrustedText(member.displayName)} — ${titleCase(member.role)}</option>`,
  ).join("");
  return `<section class="md-setup-card" aria-labelledby="ownership-heading" data-owner-transfer-controls>
    <div>
      <p class="md-eyebrow">Single Owner</p>
      <h2 id="ownership-heading">Transfer ownership</h2>
      <p>Only active participants appear here. Pending invitations cannot receive ownership. After transfer, you become Admin and exactly one Owner remains.</p>
    </div>
    <form data-ownership-transfer-form data-metadata-version="${mind.metadataVersion}" data-source-membership-version="${source.membershipVersion}">
      <div class="md-field">
        <label for="ordinary-mind-ownership-target">New Owner</label>
        <select id="ordinary-mind-ownership-target" name="target_member_id" required${candidates.length === 0 ? " disabled" : ""}>
          <option value="">${candidates.length === 0 ? "No eligible participants" : "Choose an active participant"}</option>${options}
        </select>
      </div>
      <section class="md-caveat" data-ownership-consequences>
        <h3>Review the exact transfer</h3>
        <p><strong data-ownership-target-name>No participant selected</strong> will become the sole Owner immediately. You will become Admin. Both changes happen together or neither happens.</p>
      </section>
      <p><label><input type="checkbox" required data-ownership-confirmation${candidates.length === 0 ? " disabled" : ""}> I separately confirm the selected participant becomes sole Owner and I become Admin immediately.</label></p>
      <p class="md-form__status" role="status" aria-live="assertive" data-ownership-status></p>
      <button class="md-button md-button--danger" type="submit" data-transfer-ownership disabled>Transfer ownership</button>
    </form>
  </section>`;
}

function renderCollaborationPanel(
  mind: OrdinaryMindUiMind,
  collaboration: OrdinaryMindCollaboration | undefined,
): string {
  if (mind.accessKind === "visibility") {
    const visibility = safeVisibility(mind.visibility);
    const discovery = visibility === "public"
      ? "through the signed-in public catalog or this exact route"
      : "only through this exact route";
    return `<section class="md-setup-card" aria-labelledby="membership-baseline-heading" data-membership-baseline="${visibility}">
      <div><p class="md-eyebrow">People and access</p><h2 id="membership-baseline-heading">Read access by visibility</h2><p>You are not a participant in this Mind. ${titleCase(visibility)} visibility lets a signed-in person read the live HEAD and immutable history ${discovery}, but it does not grant membership, content write, invitations, role changes, or other management actions.</p></div>
      <a class="md-button md-button--secondary" href="/minds">Back to Minds</a>
    </section>`;
  }
  if (collaboration?.kind === "ready") {
    return renderInvitationsMembershipPanel(collaboration.snapshot);
  }
  return `<section class="md-setup-card" aria-labelledby="collaboration-unavailable-heading" data-collaboration-unavailable>
    <div><p class="md-eyebrow">People and access</p><h2 id="collaboration-unavailable-heading">Participants and invitations unavailable</h2><p>No access controls are shown until current participant and invitation state can be read together.</p></div>
    <a class="md-button md-button--secondary" href="/invitations">Open global invitations</a>
  </section>`;
}

function renderMembershipConfirmationDialog(
  collaboration: OrdinaryMindCollaboration | undefined,
): string {
  if (collaboration?.kind !== "ready") return "";
  return `<dialog class="md-dialog" aria-labelledby="membership-confirmation-title" aria-describedby="membership-confirmation-impact" data-membership-confirmation-dialog>
    <form class="md-form" data-membership-confirmation-form>
      <div class="md-dialog__heading">
        <div><p class="md-eyebrow">Current membership</p><h2 id="membership-confirmation-title" data-membership-confirmation-title>Confirm access change</h2></div>
        <button class="md-icon-button" type="button" aria-label="Cancel access change" data-membership-confirmation-cancel>×</button>
      </div>
      <p data-membership-confirmation-summary></p>
      <p class="md-caveat" id="membership-confirmation-impact" data-membership-confirmation-impact></p>
      <p><label><input type="checkbox" required data-membership-confirmation-check> I reviewed the current participant, role, and access consequences and want to apply this change.</label></p>
      <p class="md-form__status" role="status" aria-live="assertive" data-membership-confirmation-status></p>
      <div class="md-dialog__actions">
        <button class="md-button md-button--secondary" type="button" data-membership-confirmation-cancel>Keep current access</button>
        <button class="md-button md-button--danger" type="submit" data-membership-confirmation-submit disabled>Confirm access change</button>
      </div>
    </form>
  </dialog>`;
}

function formatBytes(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return "Unavailable";
  if (value < 1_024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB"] as const;
  let amount = value / 1_024;
  let unit = 0;
  while (amount >= 1_024 && unit < units.length - 1) {
    amount /= 1_024;
    unit += 1;
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}

function renderCapacityPanel(
  mind: OrdinaryMindUiMind,
  capacity: OrdinaryMindCapacity | undefined,
): string {
  if (safeRole(mind.role) !== "owner") return "";
  if (capacity?.kind !== "ready") {
    return `<section class="md-setup-card" aria-labelledby="capacity-heading" data-capacity-unavailable>
      <div><p class="md-eyebrow">Owner capacity</p><h2 id="capacity-heading">Storage usage unavailable</h2><p>No content was read. Net-growing operations fail closed when trusted accounting is unavailable.</p></div>
    </section>`;
  }
  const usage = capacity.usage;
  const state = usage.utilization === "soft_limit"
    ? "Soft limit"
    : usage.utilization === "hard_limit"
      ? "Hard limit"
      : usage.utilization === "warning"
        ? "Warning"
        : "Normal";
  return `<section class="md-setup-card" aria-labelledby="capacity-heading" data-capacity-state="${usage.utilization}">
    <div><p class="md-eyebrow">Owner capacity</p><h2 id="capacity-heading">Storage and headroom</h2><p>Counts come from immutable manifest and job metadata. File paths and private content are never read for this view.</p></div>
    <dl class="md-personal-summary">
      <div><dt>State</dt><dd>${state}</dd></div>
      <div><dt>Live HEAD</dt><dd>${formatBytes(usage.logicalHeadBytes)}</dd></div>
      <div><dt>Retained history</dt><dd>${formatBytes(usage.logicalRetainedBytes)}</dd></div>
      <div><dt>Canonical storage</dt><dd>${formatBytes(usage.physicalCanonicalBytes)}</dd></div>
      <div><dt>Mind headroom</dt><dd>${formatBytes(usage.mindCanonicalHeadroomBytes)}</dd></div>
      <div><dt>Owner aggregate</dt><dd>${formatBytes(usage.principalPhysicalCanonicalBytes)}</dd></div>
      <div><dt>Owner headroom</dt><dd>${formatBytes(usage.principalCanonicalHeadroomBytes)}</dd></div>
      <div><dt>Temporary</dt><dd>${formatBytes(usage.temporaryBytes)}</dd></div>
      <div><dt>Reserved</dt><dd>${formatBytes(usage.reservedBytes)}</dd></div>
      <div><dt>Storage amplification</dt><dd>${Number.isFinite(usage.storageAmplification) ? usage.storageAmplification.toFixed(2) : "Unavailable"}×</dd></div>
    </dl>
  </section>`;
}

function renderDeleteDialog(mind: OrdinaryMindUiMind): string {
  if (safeRole(mind.role) !== "owner") return "";
  return `<dialog class="md-dialog" id="delete-ordinary-mind-dialog" aria-labelledby="delete-ordinary-mind-title" aria-describedby="delete-ordinary-mind-description" data-delete-mind-dialog>
    <form class="md-form" data-delete-mind-form>
      <div class="md-dialog__heading">
        <div><p class="md-eyebrow">Owner-only action</p><h2 id="delete-ordinary-mind-title">Delete this Mind?</h2></div>
        <button class="md-icon-button" type="button" aria-label="Cancel Mind deletion" data-cancel-delete-mind>×</button>
      </div>
      <p id="delete-ordinary-mind-description">Mind Diary first loads a short-lived preview of the exact current impact.</p>
      <p class="md-form__status" role="status" aria-live="assertive" data-delete-status></p>
      <button class="md-button md-button--secondary" type="button" data-refresh-delete-impact hidden style="display:none">Load a new preview</button>
      <section data-delete-impact hidden>
        <p class="md-caveat"><strong>Everything below is deleted immediately.</strong> Returning later cannot restore this Mind or its history.</p>
        <dl class="md-personal-summary">
          <div><dt>Revisions</dt><dd data-impact-revisions>0</dd></div>
          <div><dt>Participants</dt><dd data-impact-members>0</dd></div>
          <div><dt>Invitations</dt><dd data-impact-invitations>0</dd></div>
          <div><dt>Background jobs</dt><dd data-impact-jobs>0</dd></div>
          <div><dt>Export jobs</dt><dd data-impact-exports>0</dd></div>
        </dl>
        <p>Type <strong data-delete-phrase-text></strong> exactly:</p>
        <div class="md-field">
          <label for="ordinary-mind-delete-confirmation">Confirmation phrase</label>
          <input id="ordinary-mind-delete-confirmation" name="confirmation" type="text" required autocomplete="off" spellcheck="false" data-delete-confirmation>
        </div>
        <p><label><input name="understand" type="checkbox" required data-delete-understand> I understand that this deletes the complete Mind and that recovery is unavailable.</label></p>
        <div class="md-dialog__actions">
          <button class="md-button md-button--secondary" type="button" data-cancel-delete-mind>Keep Mind</button>
          <button class="md-button md-button--danger" type="submit" data-delete-submit disabled>Delete Mind permanently</button>
        </div>
      </section>
    </form>
  </dialog>`;
}

function renderDetailView(
  mind: OrdinaryMindUiMind,
  ownership: OrdinaryMindOwnershipCandidates | undefined,
  collaboration: OrdinaryMindCollaboration | undefined,
  capacity: OrdinaryMindCapacity | undefined,
  announcement: string | undefined,
): string {
  const handle = safeHandle(mind.handle);
  if (handle === null) {
    return renderRouteState(
      { kind: "route_error", handle: "unknown", message: "Mind settings could not be resolved safely." },
      announcement,
    );
  }
  const role = safeRole(mind.role);
  const visibility = safeVisibility(mind.visibility);
  return `<main id="main-content" class="md-main" tabindex="-1" data-ia-main data-mind-route data-mind-handle="${handle}" data-mind-id="${escapeUntrustedText(mind.mindId)}" data-mind-visibility="${visibility}">
    <div class="md-page-heading" data-ia-page-header>
      <div>
        <a class="md-breadcrumb" href="/minds">Minds /</a>
          <h1 data-route-mind-name>${escapeUntrustedText(mind.name)}</h1>
        <p>/${escapeUntrustedText(handle)} · ${titleCase(role)} · ${visibilityLabel(visibility)}</p>
      </div>
      ${renderAnnouncement(announcement)}
    </div>
    <div class="md-token-layout">
      <div class="md-my-mind-layout">
        <article class="md-personal-card">
          <span class="md-card__personal">Ordinary Mind</span>
          <h2 data-route-summary-name>${escapeUntrustedText(mind.name)}</h2>
          <p data-route-description>${mind.description === null ? "No description yet." : escapeUntrustedText(mind.description)}</p>

          <dl class="md-personal-summary">
            <div><dt>Route</dt><dd><a href="/${handle}">/${handle}</a></dd></div>
            <div><dt>Access</dt><dd data-route-role>${titleCase(role)}</dd></div>
            <div><dt>Visibility</dt><dd data-route-visibility>${visibilityLabel(visibility)}</dd></div>
          </dl>
        </article>
        ${renderMetadataPanel(mind, handle)}
      </div>
      ${renderMindUsagePanel(`/${handle}`)}
      ${renderVisibilityPanel(mind, handle)}
      <details class="md-disclosure"><summary>Export this Mind</summary>
      ${renderProductExportWorkflowPanel({
        mindRef: handle,
        route: `/${handle}`,
        name: mind.name,
        headRevisionId: mind.headRevisionId,
      })}</details>
      ${role === "reader" || mind.accessKind === "visibility"
        ? ""
        : `<details class="md-disclosure"><summary>Import Markdown</summary>${renderMarkdownImportPanel({ mindRef: handle, headRevisionId: mind.headRevisionId })}</details>`}
      ${role === "owner" ? `<details class="md-disclosure"><summary>Storage details</summary>${renderCapacityPanel(mind, capacity)}</details>` : ""}
      ${renderCollaborationPanel(mind, collaboration)}
      ${role === "owner" ? `<details class="md-disclosure"><summary>Transfer ownership</summary>${renderOwnershipPanel(mind, ownership)}</details>` : ""}
      ${renderDeletePanel(mind, handle)}
    </div>
  </main>
  ${renderMembershipConfirmationDialog(collaboration)}
  ${renderDeleteDialog(mind)}`;
}

export function renderOrdinaryMindsManagement(model: OrdinaryMindsManagementModel): string {
  const body = model.view.kind === "list"
    ? renderListView(model.view, model.announcement)
    : model.view.kind === "detail"
      ? renderDetailView(
          model.view.mind,
          model.view.ownership,
          model.view.collaboration,
          model.view.capacity,
          model.announcement,
        )
      : renderRouteState(model.view, model.announcement);
  return `<div class="md-shell" data-mind-diary-shell data-ia-shell data-ordinary-minds-management data-nav-open="false" data-management-view="${model.view.kind}">
    <a class="md-skip-link" href="#main-content" data-ia-skip-link>Skip to main content</a>
    ${renderMindDiaryAuthenticatedHeader(model.displayName, "minds")}
    ${model.view.kind === "list" ? MIND_STATUS_SPRITE : ""}
    ${body}
    ${renderMindDiaryAuthenticatedFooter("minds")}
  </div>`;
}

export function renderOrdinaryMindsManagementDocument(
  model: OrdinaryMindsManagementModel,
  clientScript?: string,
): string {
  const safeClient = typeof clientScript === "string" && SAFE_CLIENT_PATH.test(clientScript)
    ? clientScript
    : null;
  const title = model.view.kind === "detail" ? `${model.view.mind.name} settings` : "Minds";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  ${MIND_DIARY_FAVICON_LINKS}
  <title>${escapeUntrustedText(title)} — Mind Diary</title>
  <link rel="stylesheet" href="${MIND_DIARY_UI_ASSETS.tokens}">
  <link rel="stylesheet" href="${MIND_DIARY_UI_ASSETS.shellStyles}">
</head>
<body>
  ${renderOrdinaryMindsManagement(model)}${safeClient ? `\n  <script type="module" src="${escapeUntrustedText(safeClient)}"></script>` : ""}
</body>
</html>`;
}

function showDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === "function") dialog.close();
  else {
    dialog.removeAttribute("open");
    dialog.dispatchEvent(new Event("close"));
  }
}

function failureCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function collectionFromMinds(minds: readonly MindListUiMind[]): OrdinaryMindsUiCollectionState {
  return minds.length === 0 ? { kind: "empty" } : { kind: "ready", minds };
}

function replaceCollection(shell: HTMLElement, collection: OrdinaryMindsUiCollectionState): void {
  const current = shell.querySelector<HTMLElement>("[data-minds-collection]");
  if (!current) return;
  const template = shell.ownerDocument.createElement("template");
  template.innerHTML = renderCollection(collection);
  const next = template.content.firstElementChild;
  if (next) current.replaceWith(next);
}

function prependMindCard(shell: HTMLElement, mind: OrdinaryMindUiMind): boolean {
  const list = shell.querySelector<HTMLElement>("[data-minds-list]");
  if (!list) return false;
  const template = shell.ownerDocument.createElement("template");
  template.innerHTML = renderListMindCard(mind);
  const card = template.content.firstElementChild;
  if (!card) return false;
  const duplicate = Array.from(list.querySelectorAll<HTMLElement>("[data-mind-card]"))
    .find((candidate) => candidate.dataset.mindCard === mind.handle);
  duplicate?.remove();
  const personal = list.querySelector<HTMLElement>("[data-personal-mind]");
  if (personal) personal.insertAdjacentElement("afterend", card);
  else list.prepend(card);
  return true;
}

function setAnnouncement(shell: HTMLElement, message: string): void {
  const announcement = shell.querySelector<HTMLElement>("[data-page-announcement]");
  if (!announcement) return;
  announcement.hidden = false;
  announcement.style.removeProperty("display");
  announcement.textContent = message;
}

function setElementHidden(element: HTMLElement | null, hidden: boolean): void {
  if (!element) return;
  element.hidden = hidden;
  if (hidden) element.style.display = "none";
  else element.style.removeProperty("display");
}

function defaultIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("A secure browser idempotency key generator is unavailable.");
  }
  return `mind-ui-${globalThis.crypto.randomUUID()}`;
}

function createIdempotencyKey(factory: () => string): string | null {
  try {
    const key = factory();
    return SAFE_IDEMPOTENCY_KEY.test(key) ? key : null;
  } catch {
    return null;
  }
}

function updateRouteMind(shell: HTMLElement, mind: OrdinaryMindUiMind): void {
  const name = shell.querySelector<HTMLInputElement>("#ordinary-mind-rename");
  const description = shell.querySelector<HTMLTextAreaElement>("#ordinary-mind-edit-description");
  const form = shell.querySelector<HTMLFormElement>("[data-rename-mind-form]");
  if (name) name.value = mind.name;
  if (description) description.value = mind.description ?? "";
  if (form) form.dataset.metadataVersion = String(mind.metadataVersion);
  for (const node of Array.from(shell.querySelectorAll<HTMLElement>("[data-route-mind-name], [data-route-summary-name]"))) {
    node.textContent = mind.name;
  }
  const role = shell.querySelector<HTMLElement>("[data-route-role]");
  const visibility = shell.querySelector<HTMLElement>("[data-route-visibility]");
  if (role) role.textContent = titleCase(mind.role);
  if (visibility) visibility.textContent = visibilityLabel(mind.visibility);
  const routeDescription = shell.querySelector<HTMLElement>("[data-route-description]");
  if (routeDescription) routeDescription.textContent = mind.description ?? "No description yet.";
}

function setDeleteImpactText(shell: HTMLElement, selector: string, value: number): void {
  const target = shell.querySelector<HTMLElement>(selector);
  if (target) target.textContent = String(value);
}

function validDeletionImpact(
  impact: OrdinaryMindDeletionImpactUi,
  handle: string,
): boolean {
  const counts = [
    impact.revisionCount,
    impact.membershipCount,
    impact.pendingInvitationCount,
    impact.backgroundJobCount,
    impact.exportJobCount,
  ];
  return typeof impact.impactId === "string" && impact.impactId.length > 0 &&
    impact.confirmation === `delete-mind:${handle}` &&
    impact.mind.route === `/${handle}` &&
    impact.irreversible === true &&
    impact.recoveryAvailable === false &&
    impact.forensicReceiptRetained === false &&
    counts.every((value) => Number.isSafeInteger(value) && value >= 0);
}

export function installOrdinaryMindsManagement(
  adapter: OrdinaryMindsManagementAdapter,
  root: Document | HTMLElement = document,
  options: OrdinaryMindsManagementInstallOptions = {},
): () => void {
  const shell = root.querySelector<HTMLElement>("[data-ordinary-minds-management]");
  if (!shell) return () => undefined;

  const cleanups: Array<() => void> = [];
  const on = <EventType extends Event>(
    target: EventTarget,
    type: string,
    listener: (event: EventType) => void,
  ) => {
    const genericListener = listener as EventListener;
    target.addEventListener(type, genericListener);
    cleanups.push(() => target.removeEventListener(type, genericListener));
  };
  let disposed = false;
  const idempotencyKey = options.idempotencyKey ?? defaultIdempotencyKey;

  const menuButton = shell.querySelector<HTMLButtonElement>("[data-menu-button]");
  const navigation = shell.querySelector<HTMLElement>("[data-navigation]");
  const closeNavigation = () => {
    shell.dataset.navOpen = "false";
    menuButton?.setAttribute("aria-expanded", "false");
  };
  if (menuButton && navigation) {
    on<MouseEvent>(menuButton, "click", () => {
      const open = shell.dataset.navOpen !== "true";
      shell.dataset.navOpen = String(open);
      menuButton.setAttribute("aria-expanded", String(open));
      if (open) navigation.querySelector<HTMLAnchorElement>("a")?.focus();
    });
  }

  let listMinds: MindListUiMind[] | null = null;

  const createDialog = shell.querySelector<HTMLDialogElement>("[data-create-mind-dialog]");
  const createForm = shell.querySelector<HTMLFormElement>("[data-create-mind-form]");
  const createName = shell.querySelector<HTMLInputElement>("#ordinary-mind-name");
  const createHandle = shell.querySelector<HTMLInputElement>("#ordinary-mind-handle");
  const createDescription = shell.querySelector<HTMLTextAreaElement>("#ordinary-mind-description");
  const createStatus = shell.querySelector<HTMLElement>("[data-create-status]");
  const createSubmit = shell.querySelector<HTMLButtonElement>("[data-create-submit]");
  let createInvoker: HTMLElement | null = null;
  let createPending = false;
  let handleEdited = false;
  let createAttempt: { readonly name: string; readonly handle: string; readonly description: string | null; readonly key: string } | null = null;

  const resetCreateAttempt = () => {
    createAttempt = null;
    createHandle?.setCustomValidity("");
  };
  const closeCreate = () => {
    if (createPending || !createDialog || (!createDialog.open && !createDialog.hasAttribute("open"))) return;
    closeDialog(createDialog);
  };
  if (createName && createHandle) {
    on<InputEvent>(createName, "input", () => {
      resetCreateAttempt();
      if (!handleEdited) createHandle.value = suggestOrdinaryMindHandle(createName.value);
    });
    on<InputEvent>(createHandle, "input", () => {
      handleEdited = true;
      resetCreateAttempt();
    });
  }
  if (createDialog) {
    for (const button of Array.from(createDialog.querySelectorAll<HTMLElement>("[data-cancel-create-mind]"))) {
      on<MouseEvent>(button, "click", closeCreate);
    }
    on(createDialog, "close", () => {
      createInvoker?.focus();
      createInvoker = null;
    });
    on<MouseEvent>(createDialog, "click", (event) => {
      if (event.target === createDialog) closeCreate();
    });
  }

  if (createForm && createName && createHandle && createStatus && createSubmit && createDialog) {
    on<SubmitEvent>(createForm, "submit", async (event) => {
      event.preventDefault();
      if (createPending || !createForm.reportValidity()) return;
      const name = createName.value.trim();
      const handle = createHandle.value.trim();
      const description = createDescription?.value.trim() || null;
      const key = createAttempt?.name === name && createAttempt.handle === handle &&
          createAttempt.description === description
        ? createAttempt.key
        : createIdempotencyKey(idempotencyKey);
      if (key === null) {
        createStatus.textContent = "A safe retry key could not be created. Refresh this page and try again.";
        return;
      }
      createAttempt = { name, handle, description, key };
      createPending = true;
      createSubmit.disabled = true;
      createDialog.setAttribute("aria-busy", "true");
      createStatus.textContent = "Creating one private Mind and its Owner membership…";
      try {
        const created = await adapter.createMind({ name, handle, description, idempotencyKey: key });
        if (!isSafeMind(created) || created.handle !== handle || created.role !== "owner" || created.visibility !== "private") {
          throw new Error("Invalid create result");
        }
        if (disposed) return;
        if (listMinds !== null) {
          const personal = listMinds.filter((mind) => mind.isPersonal === true);
          const ordinary = listMinds.filter((mind) =>
            mind.isPersonal !== true && mind.handle !== created.handle);
          listMinds = [...personal, created, ...ordinary];
          replaceCollection(shell, collectionFromMinds(listMinds));
        } else if (!prependMindCard(shell, created)) {
          replaceCollection(shell, collectionFromMinds([created]));
        }
        setAnnouncement(shell, `${created.name} was created as a private Mind.`);
        createForm.reset();
        handleEdited = false;
        resetCreateAttempt();
        createStatus.textContent = "Mind created. No partial state was presented.";
        createPending = false;
        createSubmit.disabled = false;
        createDialog.removeAttribute("aria-busy");
        closeDialog(createDialog);
        const card = Array.from(shell.querySelectorAll<HTMLElement>("[data-mind-card]"))
          .find((candidate) => candidate.dataset.mindCard === created.handle);
        card?.focus();
      } catch (error) {
        if (disposed) return;
        const code = failureCode(error);
        if (code === "handle_unavailable") {
          const message = "That web address is unavailable. Choose another one.";
          createHandle.setCustomValidity(message);
          createStatus.textContent = message;
          createHandle.focus();
        } else {
          createStatus.textContent = "The Mind was not created. No partial Mind is shown; retrying the same details is safe.";
        }
      } finally {
        if (!disposed && createPending) {
          createPending = false;
          createSubmit.disabled = false;
          createDialog.removeAttribute("aria-busy");
        }
      }
    });
  }

  let listPending = false;
  const refreshList = async () => {
    if (listPending) return;
    listPending = true;
    replaceCollection(shell, { kind: "loading" });
    try {
      const minds = await adapter.listMinds();
      if (!Array.isArray(minds) || !minds.every(isSafeListMind) || !hasExactlyOnePersonalMind(minds)) {
        throw new Error("Invalid list result");
      }
      if (disposed) return;
      listMinds = personalFirst(minds);
      replaceCollection(shell, collectionFromMinds(listMinds));
    } catch {
      if (!disposed) replaceCollection(shell, { kind: "error", message: "Mind metadata is unavailable. No knowledge files were requested." });
    } finally {
      listPending = false;
    }
  };

  const routeContainer = shell.querySelector<HTMLElement>("[data-mind-route]");
  const routeHandle = safeHandle(routeContainer?.dataset.mindHandle);
  const routeMindId = routeContainer?.dataset.mindId ?? null;
  const renameForm = shell.querySelector<HTMLFormElement>("[data-rename-mind-form]");
  const renameInput = shell.querySelector<HTMLInputElement>("#ordinary-mind-rename");
  const renameDescription = shell.querySelector<HTMLTextAreaElement>("#ordinary-mind-edit-description");
  const renameStatus = shell.querySelector<HTMLElement>("[data-rename-status]");
  const renameSubmit = shell.querySelector<HTMLButtonElement>("[data-rename-submit]");
  const refreshMindButton = shell.querySelector<HTMLButtonElement>("[data-refresh-mind]");
  let renamePending = false;
  let renameAttempt: { readonly name: string; readonly description: string | null; readonly version: number; readonly key: string } | null = null;
  for (const field of [renameInput, renameDescription]) {
    if (!field) continue;
    on<InputEvent>(field, "input", () => {
      renameAttempt = null;
      if (renameStatus) renameStatus.textContent = "";
      setElementHidden(refreshMindButton, true);
    });
  }
  if (renameForm && renameInput && renameDescription && renameStatus && renameSubmit && routeHandle !== null) {
    on<SubmitEvent>(renameForm, "submit", async (event) => {
      event.preventDefault();
      if (renamePending || !renameForm.reportValidity()) return;
      const name = renameInput.value.trim();
      const description = renameDescription.value.trim() || null;
      const version = Number.parseInt(renameForm.dataset.metadataVersion ?? "", 10);
      if (safeMetadataVersion(version) === null) {
        renameStatus.textContent = "Reload current settings before renaming this Mind.";
        setElementHidden(refreshMindButton, false);
        return;
      }
      const key = renameAttempt?.name === name && renameAttempt.description === description &&
          renameAttempt.version === version
        ? renameAttempt.key
        : createIdempotencyKey(idempotencyKey);
      if (key === null) {
        renameStatus.textContent = "A safe retry key could not be created. Refresh this page and try again.";
        return;
      }
      renameAttempt = { name, description, version, key };
      renamePending = true;
      renameSubmit.disabled = true;
      renameStatus.textContent = "Saving the name and description…";
      try {
        const renamed = await adapter.renameMind({
          handle: routeHandle,
          name,
          description,
          expectedMetadataVersion: version,
          idempotencyKey: key,
        });
        if (!isSafeMind(renamed) || renamed.handle !== routeHandle ||
            routeMindId === null || renamed.mindId !== routeMindId) {
          throw new Error("Invalid rename result");
        }
        if (disposed) return;
        updateRouteMind(shell, renamed);
        renameAttempt = null;
        renameStatus.textContent = `Metadata saved. The route is still /${routeHandle}.`;
        setAnnouncement(shell, `${renamed.name} metadata was saved without changing content or route.`);
        setElementHidden(refreshMindButton, true);
      } catch (error) {
        if (disposed) return;
        if (failureCode(error) === "metadata_conflict") {
          renameStatus.textContent = "This Mind changed in another session. Reload current settings before trying again.";
          setElementHidden(refreshMindButton, false);
        } else {
          renameStatus.textContent = "Metadata was not changed. The existing name, description, and route remain in effect.";
        }
      } finally {
        renamePending = false;
        if (!disposed) renameSubmit.disabled = false;
      }
    });
  }

  const failClosedStaleRoute = () => {
    const ownerDocument = root.nodeType === 9 ? root as Document : root.ownerDocument;
    const routeMain = shell.querySelector<HTMLElement>("[data-mind-route]");
    const layout = routeMain?.querySelector<HTMLElement>(".md-token-layout");
    if (ownerDocument === null) {
      layout?.remove();
      shell.querySelector<HTMLDialogElement>("[data-delete-mind-dialog]")?.remove();
      return;
    }
    if (layout) {
      const state = ownerDocument.createElement("section");
      state.className = "md-state md-state--error";
      state.setAttribute("role", "alert");
      state.dataset.routeAuthorityStale = "";
      const heading = ownerDocument.createElement("h2");
      heading.textContent = "Current access must be reloaded";
      const explanation = ownerDocument.createElement("p");
      explanation.textContent = "All Mind controls are hidden because the page could not reload current server authority.";
      state.append(heading, explanation);
      layout.replaceWith(state);
    }
    shell.querySelector<HTMLDialogElement>("[data-delete-mind-dialog]")?.remove();
  };

  const refreshRouteMind = () => {
    if (routeHandle === null || !refreshMindButton || refreshMindButton.disabled) return;
    refreshMindButton.disabled = true;
    if (renameStatus) renameStatus.textContent = "Reloading all Mind settings and current permissions…";
    const ownerDocument = root.nodeType === 9 ? root as Document : root.ownerDocument;
    const view = ownerDocument?.defaultView ?? null;
    if (view === null) {
      failClosedStaleRoute();
      return;
    }
    view.location.reload();
  };

  const deleteDialog = shell.querySelector<HTMLDialogElement>("[data-delete-mind-dialog]");
  const deleteForm = shell.querySelector<HTMLFormElement>("[data-delete-mind-form]");
  const deleteStatus = shell.querySelector<HTMLElement>("[data-delete-status]");
  const deleteImpact = shell.querySelector<HTMLElement>("[data-delete-impact]");
  const deletePhrase = shell.querySelector<HTMLElement>("[data-delete-phrase-text]");
  const deleteConfirmation = shell.querySelector<HTMLInputElement>("[data-delete-confirmation]");
  const deleteUnderstand = shell.querySelector<HTMLInputElement>("[data-delete-understand]");
  const deleteSubmit = shell.querySelector<HTMLButtonElement>("[data-delete-submit]");
  const refreshImpact = shell.querySelector<HTMLButtonElement>("[data-refresh-delete-impact]");
  let deleteInvoker: HTMLElement | null = null;
  let deletionPreview: OrdinaryMindDeletionImpactUi | null = null;
  let deletionKey: string | null = null;
  let deletionPending = false;
  let impactPending = false;

  const updateDeleteSubmit = () => {
    if (!deleteSubmit || !deleteConfirmation || !deleteUnderstand || !deletionPreview) return;
    deleteSubmit.disabled = deletionPending ||
      deleteConfirmation.value !== deletionPreview.confirmation ||
      !deleteUnderstand.checked;
  };
  if (deleteConfirmation) on<InputEvent>(deleteConfirmation, "input", updateDeleteSubmit);
  if (deleteUnderstand) on<Event>(deleteUnderstand, "change", updateDeleteSubmit);

  const clearDeletionPreview = () => {
    deletionPreview = null;
    deletionKey = null;
    if (deleteImpact) deleteImpact.hidden = true;
    if (deleteConfirmation) deleteConfirmation.value = "";
    if (deleteUnderstand) deleteUnderstand.checked = false;
    if (deleteSubmit) deleteSubmit.disabled = true;
  };
  const closeDelete = () => {
    if (deletionPending || impactPending || !deleteDialog || (!deleteDialog.open && !deleteDialog.hasAttribute("open"))) return;
    closeDialog(deleteDialog);
  };
  if (deleteDialog) {
    for (const button of Array.from(deleteDialog.querySelectorAll<HTMLElement>("[data-cancel-delete-mind]"))) {
      on<MouseEvent>(button, "click", closeDelete);
    }
    on(deleteDialog, "close", () => {
      clearDeletionPreview();
      if (deleteStatus) deleteStatus.textContent = "";
      setElementHidden(refreshImpact, true);
      deleteInvoker?.focus();
      deleteInvoker = null;
    });
    on<MouseEvent>(deleteDialog, "click", (event) => {
      if (event.target === deleteDialog) closeDelete();
    });
  }

  const loadDeletionImpact = async () => {
    if (impactPending || deletionPending || routeHandle === null || !deleteDialog || !deleteStatus || !deleteImpact) return;
    impactPending = true;
    clearDeletionPreview();
    deleteDialog.setAttribute("aria-busy", "true");
    deleteStatus.textContent = "Loading the current deletion impact…";
    setElementHidden(refreshImpact, true);
    try {
      const impact = await adapter.getDeletionImpact(routeHandle);
      if (!validDeletionImpact(impact, routeHandle)) throw new Error("Invalid deletion impact");
      if (disposed) return;
      deletionPreview = impact;
      setDeleteImpactText(shell, "[data-impact-revisions]", impact.revisionCount);
      setDeleteImpactText(shell, "[data-impact-members]", impact.membershipCount);
      setDeleteImpactText(shell, "[data-impact-invitations]", impact.pendingInvitationCount);
      setDeleteImpactText(shell, "[data-impact-jobs]", impact.backgroundJobCount);
      setDeleteImpactText(shell, "[data-impact-exports]", impact.exportJobCount);
      if (deletePhrase) deletePhrase.textContent = impact.confirmation;
      deleteImpact.hidden = false;
      deleteStatus.textContent = "Review the exact impact and complete both confirmation steps.";
      updateDeleteSubmit();
      deleteConfirmation?.focus();
    } catch {
      if (!disposed) {
        deleteStatus.textContent = "The deletion impact could not be loaded. Nothing was deleted.";
        setElementHidden(refreshImpact, false);
      }
    } finally {
      impactPending = false;
      if (!disposed) deleteDialog.removeAttribute("aria-busy");
    }
  };

  if (deleteForm && deleteDialog && deleteStatus && deleteSubmit && routeHandle !== null) {
    on<SubmitEvent>(deleteForm, "submit", async (event) => {
      event.preventDefault();
      if (deletionPending || !deletionPreview || !deleteForm.reportValidity()) return;
      if (deleteConfirmation?.value !== deletionPreview.confirmation || !deleteUnderstand?.checked) {
        deleteStatus.textContent = "Type the exact phrase and confirm that recovery is unavailable.";
        updateDeleteSubmit();
        return;
      }
      deletionKey ??= createIdempotencyKey(idempotencyKey);
      if (deletionKey === null) {
        deleteStatus.textContent = "A safe retry key could not be created. Close this preview and try again.";
        return;
      }
      deletionPending = true;
      deleteDialog.setAttribute("aria-busy", "true");
      deleteSubmit.disabled = true;
      deleteStatus.textContent = "Deleting this Mind, its history, and related records…";
      try {
        await adapter.deleteMind({
          handle: routeHandle,
          impactId: deletionPreview.impactId,
          confirmation: deletionPreview.confirmation,
          idempotencyKey: deletionKey,
        });
        if (disposed) return;
        deletionPending = false;
        deleteDialog.removeAttribute("aria-busy");
        closeDialog(deleteDialog);
        const main = shell.querySelector<HTMLElement>("#main-content");
        if (main) {
          main.innerHTML = `<section class="md-state" aria-labelledby="deleted-mind-heading"><span class="md-state__symbol" aria-hidden="true">✓</span><h1 id="deleted-mind-heading">Mind deleted</h1><p>The Mind and its history are no longer available. The route /${escapeUntrustedText(routeHandle)} is permanently retired.</p><a class="md-button md-button--primary" href="/minds">Back to Minds</a></section>`;
          main.focus();
        }
      } catch (error) {
        if (disposed) return;
        const code = failureCode(error);
        if (code === "deletion_impact_changed" || code === "deletion_impact_expired") {
          clearDeletionPreview();
          deleteStatus.textContent = "The deletion preview changed or expired. Review a new preview before trying again.";
          setElementHidden(refreshImpact, false);
        } else {
          deleteStatus.textContent = "The Mind was not deleted. Its current state remains in effect; retrying this exact confirmation is safe.";
          updateDeleteSubmit();
        }
      } finally {
        if (!disposed && deletionPending) {
          deletionPending = false;
          deleteDialog.removeAttribute("aria-busy");
          updateDeleteSubmit();
        }
      }
    });
  }

  on<MouseEvent>(shell, "click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const openCreate = target.closest<HTMLElement>("[data-open-create-mind]");
    if (openCreate && createDialog && !createPending) {
      createInvoker = openCreate;
      showDialog(createDialog);
      createName?.focus();
      return;
    }
    if (target.closest("[data-retry-minds]")) {
      void refreshList();
      return;
    }
    if (target.closest("[data-refresh-mind]")) {
      void refreshRouteMind();
      return;
    }
    const openDelete = target.closest<HTMLElement>("[data-open-delete-mind]");
    if (openDelete && deleteDialog && !deletionPending) {
      deleteInvoker = openDelete;
      showDialog(deleteDialog);
      void loadDeletionImpact();
      return;
    }
    if (target.closest("[data-refresh-delete-impact]")) void loadDeletionImpact();
  });

  on<KeyboardEvent>(shell, "keydown", (event) => {
    if (event.key !== "Escape") return;
    if (createDialog?.open || createDialog?.hasAttribute("open")) {
      event.preventDefault();
      closeCreate();
      return;
    }
    if (deleteDialog?.open || deleteDialog?.hasAttribute("open")) {
      event.preventDefault();
      closeDelete();
      return;
    }
    if (shell.dataset.navOpen === "true") {
      closeNavigation();
      menuButton?.focus();
    }
  });

  return () => {
    disposed = true;
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}
