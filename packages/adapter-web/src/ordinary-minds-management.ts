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

export type OrdinaryMindUiRole = "reader" | "editor" | "admin" | "owner";
export type OrdinaryMindUiVisibility = "private" | "unlisted" | "public";

/** Control-plane metadata only. Canonical files never enter this UI model. */
export interface OrdinaryMindUiMind {
  readonly mindId: string;
  readonly handle: string;
  readonly name: string;
  readonly visibility: OrdinaryMindUiVisibility;
  readonly role: OrdinaryMindUiRole;
  readonly metadataVersion: number;
  readonly updatedLabel: string;
  readonly accessKind?: "membership" | "visibility";
  readonly discovery?: "membership" | "exact_handle" | "public_catalog";
}

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

export type OrdinaryMindsUiCollectionState =
  | { readonly kind: "ready"; readonly minds: readonly OrdinaryMindUiMind[] }
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
  readonly idempotencyKey: string;
}

export interface RenameOrdinaryMindUiCommand {
  readonly handle: string;
  readonly name: string;
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
  listMinds(): Promise<readonly OrdinaryMindUiMind[]>;
  getMind(handle: string): Promise<OrdinaryMindUiMind>;
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
    safeRole(mind.role) === mind.role &&
    safeVisibility(mind.visibility) === mind.visibility &&
    safeMetadataVersion(mind.metadataVersion) !== null &&
    typeof mind.updatedLabel === "string";
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

function renderMindCard(mind: OrdinaryMindUiMind): string {
  const handle = safeHandle(mind.handle);
  const role = safeRole(mind.role);
  const visibility = safeVisibility(mind.visibility);
  const route = handle === null ? "#" : `/${handle}`;
  const relationship = role === "owner" ? "Owned by you" : `${titleCase(role)} member`;
  const action = handle === null
    ? '<span class="md-token-card__final-state">Unavailable</span>'
    : `<a class="md-button md-button--secondary" href="${route}" data-manage-mind>Manage</a>`;
  return `<article class="md-token-card" tabindex="-1" data-mind-card="${escapeUntrustedText(handle ?? "invalid-handle")}" data-mind-role="${role}">
    <div class="md-token-card__heading">
      <div>
        <h3><a href="${route}">${escapeUntrustedText(mind.name)}</a></h3>
        <code>/${escapeUntrustedText(handle ?? "unavailable")}</code>
      </div>
      <span class="md-token-state md-token-state--active"><span aria-hidden="true">●</span> ${role === "owner" ? "Owner" : "Member"}</span>
    </div>
    <dl class="md-token-card__metadata">
      <div><dt>Access</dt><dd>${relationship}</dd></div>
      <div><dt>Visibility</dt><dd>${visibilityLabel(visibility)}</dd></div>
      <div><dt>Activity</dt><dd>${escapeUntrustedText(mind.updatedLabel)}</dd></div>
    </dl>
    <div class="md-token-card__action">${action}</div>
  </article>`;
}

function renderCollection(collection: OrdinaryMindsUiCollectionState): string {
  switch (collection.kind) {
    case "loading":
      return `<section class="md-state md-state--loading" aria-labelledby="ordinary-minds-heading" aria-busy="true" data-minds-collection>
        <div class="md-loading-mark" aria-hidden="true"><span></span><span></span><span></span></div>
        <h2 id="ordinary-minds-heading">Loading your Minds</h2>
        <p role="status" aria-live="polite">Checking owned and member Minds…</p>
      </section>`;
    case "empty":
      return `<section class="md-state md-state--empty" aria-labelledby="ordinary-minds-heading" data-minds-collection>
        <span class="md-state__symbol" aria-hidden="true">+</span>
        <h2 id="ordinary-minds-heading">No shared Minds yet</h2>
        <p>Create an ordinary Mind when you want a separate knowledge space or a place to collaborate.</p>
        <button class="md-button md-button--primary" type="button" data-open-create-mind>Create a Mind</button>
      </section>`;
    case "error":
      return `<section class="md-state md-state--error" aria-labelledby="ordinary-minds-heading" role="alert" data-minds-collection>
        <span class="md-state__symbol" aria-hidden="true">!</span>
        <h2 id="ordinary-minds-heading">We couldn’t load your Minds</h2>
        <p>${escapeUntrustedText(collection.message)}</p>
        <button class="md-button md-button--secondary" type="button" data-retry-minds>Try again</button>
      </section>`;
    case "ready":
      if (collection.minds.length === 0) return renderCollection({ kind: "empty" });
      return `<section aria-labelledby="ordinary-minds-heading" data-minds-collection>
        <div class="md-section-heading">
          <div>
            <p class="md-eyebrow">Owned and joined</p>
            <h2 id="ordinary-minds-heading">Your Minds</h2>
          </div>
          <button class="md-button md-button--primary" type="button" data-open-create-mind>Create a Mind</button>
        </div>
        <div class="md-token-grid" data-minds-list>${collection.minds.map(renderMindCard).join("")}</div>
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
  return `<main id="main-content" class="md-main" tabindex="-1">
    <div class="md-page-heading">
      <div>
        <p class="md-eyebrow">Build a Mind from Memories</p>
        <h1>Minds</h1>
        <p>Manage ordinary Minds you own or have joined. My Mind stays separate at <a href="/me">/me</a>.</p>
      </div>
      ${renderAnnouncement(announcement)}
    </div>
    ${renderCollection(view.collection)}
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
  return `<main id="main-content" class="md-main" tabindex="-1">
    <div class="md-page-heading"><div><p class="md-eyebrow">Route-specific management</p><h1>Mind settings</h1></div>${renderAnnouncement(announcement)}</div>
    ${state}
  </main>`;
}

function renderRenamePanel(mind: OrdinaryMindUiMind, handle: string): string {
  const role = safeRole(mind.role);
  const version = safeMetadataVersion(mind.metadataVersion);
  if ((role !== "admin" && role !== "owner") || version === null) {
    return `<article class="md-profile-card">
      <p class="md-eyebrow">Current access</p>
      <h2>Settings are read-only</h2>
      <p>Your ${titleCase(role)} role can open this Mind, but only an Admin or Owner can rename it.</p>
    </article>`;
  }
  return `<article class="md-profile-card">
    <p class="md-eyebrow">Display settings</p>
    <h2>Rename this Mind</h2>
    <p>Only the display name changes. The permanent route remains <strong>/${escapeUntrustedText(handle)}</strong>.</p>
    <form data-rename-mind-form data-metadata-version="${version}">
      <div class="md-field">
        <label for="ordinary-mind-rename">Mind name</label>
        <input id="ordinary-mind-rename" name="name" type="text" required maxlength="80" autocomplete="off" value="${escapeUntrustedText(mind.name)}">
      </div>
      <p class="md-form__status" role="status" aria-live="polite" data-rename-status></p>
      <button class="md-button md-button--primary" type="submit" data-rename-submit>Save name</button>
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
  const candidates = ownership.members.filter((member) => !member.isSelf && member.role !== "owner");
  const options = candidates.map((member) =>
    `<option value="${escapeUntrustedText(member.memberId)}">${escapeUntrustedText(member.displayName)} — ${titleCase(member.role)}</option>`,
  ).join("");
  return `<section class="md-setup-card" aria-labelledby="ownership-heading" data-owner-transfer-controls>
    <div>
      <p class="md-eyebrow">Single Owner</p>
      <h2 id="ownership-heading">Transfer ownership</h2>
      <p>Only active participants appear here. Pending invitations cannot receive ownership. After transfer, you become Admin and exactly one Owner remains.</p>
    </div>
    <form data-ownership-transfer-form data-metadata-version="${mind.metadataVersion}">
      <div class="md-field">
        <label for="ordinary-mind-ownership-target">New Owner</label>
        <select id="ordinary-mind-ownership-target" name="target_member_id" required${candidates.length === 0 ? " disabled" : ""}>
          <option value="">${candidates.length === 0 ? "No eligible participants" : "Choose an active participant"}</option>${options}
        </select>
      </div>
      <p><label><input type="checkbox" required data-ownership-confirmation${candidates.length === 0 ? " disabled" : ""}> I understand that I will become Admin and the selected participant will become the sole Owner.</label></p>
      <p class="md-form__status" role="status" aria-live="assertive" data-ownership-status></p>
      <button class="md-button md-button--danger" type="submit" data-transfer-ownership disabled>Transfer ownership</button>
    </form>
  </section>`;
}

function renderCollaborationPanel(
  collaboration: OrdinaryMindCollaboration | undefined,
): string {
  if (collaboration?.kind === "ready") {
    return renderInvitationsMembershipPanel(collaboration.snapshot);
  }
  return `<section class="md-setup-card" aria-labelledby="collaboration-unavailable-heading" data-collaboration-unavailable>
    <div><p class="md-eyebrow">People and access</p><h2 id="collaboration-unavailable-heading">Participants and invitations unavailable</h2><p>No access controls are shown until current participant and invitation state can be read together.</p></div>
    <a class="md-button md-button--secondary" href="/invitations">Open global invitations</a>
  </section>`;
}

function renderDeleteDialog(mind: OrdinaryMindUiMind, handle: string): string {
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
  return `<main id="main-content" class="md-main" tabindex="-1" data-mind-route data-mind-handle="${handle}" data-mind-id="${escapeUntrustedText(mind.mindId)}">
    <div class="md-page-heading">
      <div>
        <p class="md-eyebrow">Route-specific management</p>
        <h1 data-route-mind-name>${escapeUntrustedText(mind.name)}</h1>
        <p>Manage metadata for /${escapeUntrustedText(handle)}. Canonical knowledge files are available through the content MCP, not this browser page.</p>
      </div>
      ${renderAnnouncement(announcement)}
    </div>
    <div class="md-token-layout">
      <div class="md-my-mind-layout">
        <article class="md-personal-card">
          <span class="md-card__personal">Ordinary Mind</span>
          <h2 data-route-summary-name>${escapeUntrustedText(mind.name)}</h2>
          <p>The handle is immutable in this prototype. Renaming never changes this route.</p>
          <dl class="md-personal-summary">
            <div><dt>Route</dt><dd><a href="/${handle}">/${handle}</a></dd></div>
            <div><dt>Access</dt><dd data-route-role>${titleCase(role)}</dd></div>
            <div><dt>Visibility</dt><dd data-route-visibility>${visibilityLabel(visibility)}</dd></div>
          </dl>
        </article>
        ${renderRenamePanel(mind, handle)}
      </div>
      ${renderVisibilityPanel(mind, handle)}
      ${renderCollaborationPanel(collaboration)}
      ${renderOwnershipPanel(mind, ownership)}
      ${renderDeletePanel(mind, handle)}
    </div>
  </main>
  ${renderDeleteDialog(mind, handle)}`;
}

export function renderOrdinaryMindsManagement(model: OrdinaryMindsManagementModel): string {
  const body = model.view.kind === "list"
    ? renderListView(model.view, model.announcement)
    : model.view.kind === "detail"
      ? renderDetailView(
          model.view.mind,
          model.view.ownership,
          model.view.collaboration,
          model.announcement,
        )
      : renderRouteState(model.view, model.announcement);
  return `<div class="md-shell" data-mind-diary-shell data-ordinary-minds-management data-nav-open="false" data-management-view="${model.view.kind}">
    <a class="md-skip-link" href="#main-content">Skip to main content</a>
    ${renderMindDiaryAuthenticatedHeader(model.displayName, "minds")}
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

function collectionFromMinds(minds: readonly OrdinaryMindUiMind[]): OrdinaryMindsUiCollectionState {
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
  template.innerHTML = renderMindCard(mind);
  const card = template.content.firstElementChild;
  if (!card) return false;
  const duplicate = Array.from(list.querySelectorAll<HTMLElement>("[data-mind-card]"))
    .find((candidate) => candidate.dataset.mindCard === mind.handle);
  duplicate?.remove();
  list.prepend(card);
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
  const form = shell.querySelector<HTMLFormElement>("[data-rename-mind-form]");
  if (name) name.value = mind.name;
  if (form) form.dataset.metadataVersion = String(mind.metadataVersion);
  for (const node of Array.from(shell.querySelectorAll<HTMLElement>("[data-route-mind-name], [data-route-summary-name]"))) {
    node.textContent = mind.name;
  }
  const role = shell.querySelector<HTMLElement>("[data-route-role]");
  const visibility = shell.querySelector<HTMLElement>("[data-route-visibility]");
  if (role) role.textContent = titleCase(mind.role);
  if (visibility) visibility.textContent = visibilityLabel(mind.visibility);
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

  let listMinds: OrdinaryMindUiMind[] | null = null;

  const createDialog = shell.querySelector<HTMLDialogElement>("[data-create-mind-dialog]");
  const createForm = shell.querySelector<HTMLFormElement>("[data-create-mind-form]");
  const createName = shell.querySelector<HTMLInputElement>("#ordinary-mind-name");
  const createHandle = shell.querySelector<HTMLInputElement>("#ordinary-mind-handle");
  const createStatus = shell.querySelector<HTMLElement>("[data-create-status]");
  const createSubmit = shell.querySelector<HTMLButtonElement>("[data-create-submit]");
  let createInvoker: HTMLElement | null = null;
  let createPending = false;
  let handleEdited = false;
  let createAttempt: { readonly name: string; readonly handle: string; readonly key: string } | null = null;

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
      const key = createAttempt?.name === name && createAttempt.handle === handle
        ? createAttempt.key
        : createIdempotencyKey(idempotencyKey);
      if (key === null) {
        createStatus.textContent = "A safe retry key could not be created. Refresh this page and try again.";
        return;
      }
      createAttempt = { name, handle, key };
      createPending = true;
      createSubmit.disabled = true;
      createDialog.setAttribute("aria-busy", "true");
      createStatus.textContent = "Creating one private Mind and its Owner membership…";
      try {
        const created = await adapter.createMind({ name, handle, idempotencyKey: key });
        if (!isSafeMind(created) || created.handle !== handle || created.role !== "owner" || created.visibility !== "private") {
          throw new Error("Invalid create result");
        }
        if (disposed) return;
        if (listMinds !== null) {
          listMinds = [created, ...listMinds.filter((mind) => mind.handle !== created.handle)];
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
      if (!Array.isArray(minds) || !minds.every(isSafeMind)) throw new Error("Invalid list result");
      if (disposed) return;
      listMinds = [...minds];
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
  const renameStatus = shell.querySelector<HTMLElement>("[data-rename-status]");
  const renameSubmit = shell.querySelector<HTMLButtonElement>("[data-rename-submit]");
  const refreshMindButton = shell.querySelector<HTMLButtonElement>("[data-refresh-mind]");
  let renamePending = false;
  let renameAttempt: { readonly name: string; readonly version: number; readonly key: string } | null = null;
  if (renameInput) {
    on<InputEvent>(renameInput, "input", () => {
      renameAttempt = null;
      if (renameStatus) renameStatus.textContent = "";
      setElementHidden(refreshMindButton, true);
    });
  }
  if (renameForm && renameInput && renameStatus && renameSubmit && routeHandle !== null) {
    on<SubmitEvent>(renameForm, "submit", async (event) => {
      event.preventDefault();
      if (renamePending || !renameForm.reportValidity()) return;
      const name = renameInput.value.trim();
      const version = Number.parseInt(renameForm.dataset.metadataVersion ?? "", 10);
      if (safeMetadataVersion(version) === null) {
        renameStatus.textContent = "Reload current settings before renaming this Mind.";
        setElementHidden(refreshMindButton, false);
        return;
      }
      const key = renameAttempt?.name === name && renameAttempt.version === version
        ? renameAttempt.key
        : createIdempotencyKey(idempotencyKey);
      if (key === null) {
        renameStatus.textContent = "A safe retry key could not be created. Refresh this page and try again.";
        return;
      }
      renameAttempt = { name, version, key };
      renamePending = true;
      renameSubmit.disabled = true;
      renameStatus.textContent = "Saving the display name…";
      try {
        const renamed = await adapter.renameMind({
          handle: routeHandle,
          name,
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
        renameStatus.textContent = `Name saved. The route is still /${routeHandle}.`;
        setAnnouncement(shell, `${renamed.name} was renamed without changing its route.`);
        setElementHidden(refreshMindButton, true);
      } catch (error) {
        if (disposed) return;
        if (failureCode(error) === "metadata_conflict") {
          renameStatus.textContent = "This Mind changed in another session. Reload current settings before trying again.";
          setElementHidden(refreshMindButton, false);
        } else {
          renameStatus.textContent = "The name was not changed. The existing name and route remain in effect.";
        }
      } finally {
        renamePending = false;
        if (!disposed) renameSubmit.disabled = false;
      }
    });
  }

  let refreshMindPending = false;
  const refreshRouteMind = async () => {
    if (refreshMindPending || routeHandle === null || !refreshMindButton) return;
    refreshMindPending = true;
    refreshMindButton.disabled = true;
    if (renameStatus) renameStatus.textContent = "Reloading current settings…";
    try {
      const current = await adapter.getMind(routeHandle);
      if (!isSafeMind(current) || current.handle !== routeHandle ||
          routeMindId === null || current.mindId !== routeMindId) {
        throw new Error("Invalid Mind result");
      }
      if (disposed) return;
      updateRouteMind(shell, current);
      renameAttempt = null;
      setElementHidden(refreshMindButton, true);
      if (renameStatus) renameStatus.textContent = "Current settings loaded. Review the name before saving again.";
      renameInput?.focus();
    } catch {
      if (!disposed && renameStatus) renameStatus.textContent = "Current settings could not be reloaded. The name was not changed.";
    } finally {
      refreshMindPending = false;
      if (!disposed) refreshMindButton.disabled = false;
    }
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
