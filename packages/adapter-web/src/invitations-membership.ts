import {
  MIND_DIARY_UI_ASSETS,
  escapeUntrustedText,
} from "./ui-shell.js";

export type InvitationMembershipRole = "reader" | "editor" | "admin" | "owner";
export type InvitationProposedRole = Exclude<InvitationMembershipRole, "owner">;
export type InvitationDirection = "incoming" | "outgoing";
export type InvitationUiState =
  | "pending"
  | "expired"
  | "accepted"
  | "rejected"
  | "cancelled";

export interface InvitationMembershipMind {
  readonly mindId: string;
  readonly name: string;
  readonly route: string;
  readonly metadataVersion: number;
}

export interface InvitationMembershipActor {
  readonly memberId: string;
  readonly role: InvitationMembershipRole;
  readonly membershipVersion: number;
}

export interface InvitationMembershipMember {
  readonly memberId: string;
  readonly displayName: string;
  readonly role: InvitationMembershipRole;
  readonly state: "active" | "revoked";
  readonly membershipVersion: number;
  readonly isSelf: boolean;
}

export interface InvitationMembershipInvitation {
  readonly invitationId: string;
  readonly direction: InvitationDirection;
  readonly counterpartyDisplayName: string;
  readonly proposedRole: InvitationProposedRole;
  readonly state: InvitationUiState;
  readonly expiresAt: string;
  readonly invitationVersion: number;
}

export interface InvitationMembershipSnapshot {
  readonly mind: InvitationMembershipMind;
  readonly actor: InvitationMembershipActor;
  readonly members: readonly InvitationMembershipMember[];
  readonly invitations: readonly InvitationMembershipInvitation[];
}

export type InvitationMembershipLoadedState =
  | { readonly kind: "ready"; readonly snapshot: InvitationMembershipSnapshot }
  | { readonly kind: "unavailable"; readonly message: string };

export type InvitationMembershipCollectionState =
  | InvitationMembershipLoadedState
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string };

export interface InvitationMembershipPageModel {
  readonly displayName: string;
  readonly collection: InvitationMembershipCollectionState;
  readonly announcement?: string;
}

export interface InvitationLifecycleUiCommand {
  readonly invitationId: string;
  readonly expectedInvitationVersion: number;
  readonly idempotencyKey: string;
}

export interface InvitationsMembershipAdapter {
  loadPage(): Promise<InvitationMembershipLoadedState>;
  createInvitation(command: {
    readonly mindId: string;
    readonly targetVerifiedEmail: string;
    readonly role: InvitationProposedRole;
    readonly expectedMetadataVersion: number;
    readonly idempotencyKey: string;
  }): Promise<void>;
  acceptInvitation(command: InvitationLifecycleUiCommand): Promise<void>;
  rejectInvitation(command: InvitationLifecycleUiCommand): Promise<void>;
  cancelInvitation(command: InvitationLifecycleUiCommand): Promise<void>;
  reissueInvitation(command: InvitationLifecycleUiCommand): Promise<void>;
  changeMemberRole(command: {
    readonly mindId: string;
    readonly memberId: string;
    readonly role: InvitationProposedRole;
    readonly expectedMembershipVersion: number;
    readonly idempotencyKey: string;
  }): Promise<void>;
  revokeMember(command: {
    readonly mindId: string;
    readonly memberId: string;
    readonly expectedMembershipVersion: number;
    readonly idempotencyKey: string;
  }): Promise<void>;
  leaveMind(command: {
    readonly mindId: string;
    readonly expectedMembershipVersion: number;
    readonly idempotencyKey: string;
  }): Promise<void>;
  transferOwnership(command: {
    readonly mindId: string;
    readonly targetMemberId: string;
    readonly expectedMetadataVersion: number;
    readonly confirmation: "transfer-ownership";
    readonly idempotencyKey: string;
  }): Promise<void>;
}

export interface InvitationsMembershipInstallOptions {
  readonly createIdempotencyKey?: () => string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EXACT_EMAIL = /^[\u0021-\u007e]+@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,63}$/u;
const ROLES: readonly InvitationMembershipRole[] = [
  "reader",
  "editor",
  "admin",
  "owner",
];
const INVITATION_STATES: readonly InvitationUiState[] = [
  "pending",
  "expired",
  "accepted",
  "rejected",
  "cancelled",
];
let fallbackIdempotencySequence = 0;

function safeId(value: string): string | null {
  return SAFE_ID.test(value) ? value : null;
}

function safeRole(value: unknown): InvitationMembershipRole | null {
  return typeof value === "string" && ROLES.includes(value as InvitationMembershipRole)
    ? (value as InvitationMembershipRole)
    : null;
}

function safeProposedRole(value: unknown): InvitationProposedRole | null {
  const role = safeRole(value);
  return role === "reader" || role === "editor" || role === "admin" ? role : null;
}

function safeInvitationState(value: unknown): InvitationUiState {
  return typeof value === "string" && INVITATION_STATES.includes(value as InvitationUiState)
    ? (value as InvitationUiState)
    : "expired";
}

function roleLabel(role: InvitationMembershipRole): string {
  return `${role.slice(0, 1).toUpperCase()}${role.slice(1)}`;
}

function stateLabel(state: InvitationUiState): string {
  return `${state.slice(0, 1).toUpperCase()}${state.slice(1)}`;
}

function dateLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "Unavailable";
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function safeMindRoute(route: string): string {
  return /^\/(?:me|[a-z0-9]+(?:-[a-z0-9]+)*)$/u.test(route) ? route : "#";
}

function defaultIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  fallbackIdempotencySequence += 1;
  return `ui-${Date.now()}-${fallbackIdempotencySequence}`;
}

function invitationRoles(actorRole: InvitationMembershipRole): readonly InvitationProposedRole[] {
  if (actorRole === "owner") return ["reader", "editor", "admin"];
  if (actorRole === "admin") return ["reader", "editor"];
  return [];
}

function roleOptions(
  roles: readonly InvitationProposedRole[],
  selected?: InvitationMembershipRole,
): string {
  return roles
    .map((role) => `<option value="${role}"${selected === role ? " selected" : ""}>${roleLabel(role)}</option>`)
    .join("");
}

function renderInvitationAction(invitation: InvitationMembershipInvitation): string {
  const invitationId = safeId(invitation.invitationId);
  const state = safeInvitationState(invitation.state);
  if (invitationId === null) return `<span class="md-token-card__final-state">Unavailable</span>`;
  const attributes = `data-invitation-id="${escapeUntrustedText(invitationId)}" data-invitation-version="${invitation.invitationVersion}" data-control-action`;
  if (invitation.direction === "incoming" && state === "pending") {
    return `<div class="md-dialog__actions">
      <button class="md-button md-button--secondary" type="button" data-invitation-action="reject" ${attributes}>Reject</button>
      <button class="md-button md-button--primary" type="button" data-invitation-action="accept" ${attributes}>Accept</button>
    </div>`;
  }
  if (invitation.direction === "outgoing" && state === "pending") {
    return `<button class="md-button md-button--danger" type="button" data-invitation-action="cancel" ${attributes}>Cancel invitation</button>`;
  }
  if (
    invitation.direction === "outgoing" &&
    (state === "expired" || state === "cancelled")
  ) {
    return `<button class="md-button md-button--secondary" type="button" data-invitation-action="reissue" ${attributes}>Reissue for 7 days</button>`;
  }
  return `<span class="md-token-card__final-state">${stateLabel(state)}</span>`;
}

function renderInvitationCard(invitation: InvitationMembershipInvitation): string {
  const invitationId = safeId(invitation.invitationId);
  const state = safeInvitationState(invitation.state);
  const direction = invitation.direction === "incoming" ? "incoming" : "outgoing";
  const proposedRole = safeProposedRole(invitation.proposedRole) ?? "reader";
  const statusStyle = state === "pending" ? "active" : "expired";
  return `<article class="md-token-card" data-invitation-card="${escapeUntrustedText(invitationId ?? "invalid-invitation-id")}" data-invitation-direction="${direction}" data-invitation-state="${state}">
    <div class="md-token-card__heading">
      <div>
        <p class="md-eyebrow">${direction === "incoming" ? "From" : "To"}</p>
        <h3>${escapeUntrustedText(invitation.counterpartyDisplayName)}</h3>
      </div>
      <span class="md-token-state md-token-state--${statusStyle}">${stateLabel(state)}</span>
    </div>
    <dl class="md-token-card__metadata">
      <div><dt>Direction</dt><dd>${direction === "incoming" ? "Incoming" : "Outgoing"}</dd></div>
      <div><dt>Role</dt><dd>${roleLabel(proposedRole)}</dd></div>
      <div><dt>Expires</dt><dd>${dateLabel(invitation.expiresAt)}</dd></div>
    </dl>
    <div class="md-token-card__action">${renderInvitationAction(invitation)}</div>
  </article>`;
}

function renderInvitationGroup(
  invitations: readonly InvitationMembershipInvitation[],
  direction: InvitationDirection,
): string {
  const selected = invitations.filter((invitation) => invitation.direction === direction);
  const heading = direction === "incoming" ? "Incoming invitations" : "Sent invitations";
  const empty = direction === "incoming"
    ? "No incoming invitations."
    : "No sent invitations for this Mind.";
  return `<section aria-labelledby="${direction}-invitations-heading">
    <div class="md-section-heading"><div><p class="md-eyebrow">${direction === "incoming" ? "Your decisions" : "Invitation lifecycle"}</p><h2 id="${direction}-invitations-heading">${heading}</h2></div></div>
    ${selected.length === 0 ? `<p>${empty}</p>` : `<div class="md-token-grid">${selected.map(renderInvitationCard).join("")}</div>`}
  </section>`;
}

function canManageMember(
  actorRole: InvitationMembershipRole,
  member: InvitationMembershipMember,
): boolean {
  if (member.state !== "active" || member.isSelf || member.role === "owner") return false;
  if (actorRole === "owner") return true;
  return actorRole === "admin" && (member.role === "reader" || member.role === "editor");
}

function memberDisabledReason(
  actorRole: InvitationMembershipRole,
  member: InvitationMembershipMember,
): string {
  if (member.state !== "active") return "This membership is no longer active.";
  if (member.role === "owner") return "Ownership changes only through ownership transfer.";
  if (actorRole === "admin" && member.role === "admin") {
    return "Admins cannot manage another Admin.";
  }
  if (member.isSelf) return "Use the leave action for your own membership.";
  return "You do not have permission to manage this participant.";
}

function renderMemberCard(
  member: InvitationMembershipMember,
  actorRole: InvitationMembershipRole,
): string {
  const memberId = safeId(member.memberId);
  const role = safeRole(member.role) ?? "reader";
  const manageable = memberId !== null && canManageMember(actorRole, member);
  const availableRoles = actorRole === "owner"
    ? (["reader", "editor", "admin"] as const)
    : (["reader", "editor"] as const);
  const controls = manageable
    ? `<form class="md-token-form" data-member-role-form data-member-id="${escapeUntrustedText(memberId)}" data-membership-version="${member.membershipVersion}">
        <div class="md-field">
          <label for="member-role-${escapeUntrustedText(memberId)}">Role</label>
          <select id="member-role-${escapeUntrustedText(memberId)}" name="role">${roleOptions(availableRoles, role)}</select>
        </div>
        <div class="md-dialog__actions">
          <button class="md-button md-button--danger" type="button" data-revoke-member data-member-id="${escapeUntrustedText(memberId)}" data-membership-version="${member.membershipVersion}" data-control-action>Revoke access</button>
          <button class="md-button md-button--secondary" type="submit" data-control-action>Update role</button>
        </div>
      </form>`
    : `<div data-member-controls-disabled>
        <p class="md-caveat">${memberDisabledReason(actorRole, member)}</p>
        <button class="md-button md-button--secondary" type="button" disabled aria-disabled="true">Role controls unavailable</button>
      </div>`;
  return `<article class="md-token-card" data-member-card="${escapeUntrustedText(memberId ?? "invalid-member-id")}" data-member-role="${role}" data-member-state="${member.state === "active" ? "active" : "revoked"}">
    <div class="md-token-card__heading">
      <div><h3>${escapeUntrustedText(member.displayName)}${member.isSelf ? " (you)" : ""}</h3></div>
      <span class="md-token-state md-token-state--${member.state === "active" ? "active" : "revoked"}">${member.state === "active" ? roleLabel(role) : "Revoked"}</span>
    </div>
    ${controls}
  </article>`;
}

function renderInvitationForm(snapshot: InvitationMembershipSnapshot): string {
  const roles = invitationRoles(snapshot.actor.role);
  const mindId = safeId(snapshot.mind.mindId);
  if (roles.length === 0 || mindId === null) {
    return `<section class="md-setup-card" aria-labelledby="invite-heading">
      <div><p class="md-eyebrow">Exact account only</p><h2 id="invite-heading">Invite a participant</h2><p>You do not currently have permission to invite participants.</p></div>
      <button class="md-button md-button--secondary" type="button" disabled aria-disabled="true">Invitation controls unavailable</button>
    </section>`;
  }
  return `<section class="md-setup-card" aria-labelledby="invite-heading">
    <div>
      <p class="md-eyebrow">Exact registered account</p>
      <h2 id="invite-heading">Invite a participant</h2>
      <p>Enter the exact verified email for an existing Mind Diary account. There are no people-search suggestions, invite emails, or invitations for unregistered addresses.</p>
    </div>
    <form class="md-token-form" data-invitation-form data-mind-id="${escapeUntrustedText(mindId)}" data-metadata-version="${snapshot.mind.metadataVersion}">
      <div class="md-field">
        <label for="invitation-email">Exact verified email</label>
        <input id="invitation-email" name="target_verified_email" type="email" required maxlength="254" autocomplete="email" spellcheck="false" aria-describedby="invitation-email-help">
        <p id="invitation-email-help">The address must already belong to a registered principal.</p>
      </div>
      <div class="md-field">
        <label for="invitation-role">Role after acceptance</label>
        <select id="invitation-role" name="role" required>${roleOptions(roles)}</select>
      </div>
      <p class="md-form__status" role="status" aria-live="polite" data-invitation-form-status></p>
      <button class="md-button md-button--primary" type="submit" data-control-action>Send in-app invitation</button>
    </form>
  </section>`;
}

function renderTransfer(snapshot: InvitationMembershipSnapshot): string {
  const mindId = safeId(snapshot.mind.mindId);
  const candidates = snapshot.members.filter(
    (member) =>
      member.state === "active" &&
      member.role !== "owner" &&
      !member.isSelf &&
      safeId(member.memberId) !== null,
  );
  if (snapshot.actor.role !== "owner" || mindId === null) {
    return `<section class="md-setup-card" aria-labelledby="transfer-heading">
      <div><p class="md-eyebrow">Single Owner</p><h2 id="transfer-heading">Transfer ownership</h2><p>Only the current Owner can transfer ownership to an active participant.</p></div>
      <button class="md-button md-button--secondary" type="button" disabled aria-disabled="true">Ownership transfer unavailable</button>
    </section>`;
  }
  const candidateOptions = candidates
    .map((member) => `<option value="${escapeUntrustedText(member.memberId)}">${escapeUntrustedText(member.displayName)} — ${roleLabel(member.role)}</option>`)
    .join("");
  return `<section class="md-setup-card" aria-labelledby="transfer-heading">
    <div>
      <p class="md-eyebrow">Single Owner</p>
      <h2 id="transfer-heading">Transfer ownership</h2>
      <p>Only existing active participants appear here. Pending invitations cannot receive ownership.</p>
    </div>
    <form class="md-token-form" data-transfer-form data-mind-id="${escapeUntrustedText(mindId)}" data-metadata-version="${snapshot.mind.metadataVersion}">
      <div class="md-field">
        <label for="ownership-target">New Owner</label>
        <select id="ownership-target" name="target_member_id" required${candidates.length === 0 ? " disabled" : ""}>
          ${candidates.length === 0 ? '<option value="">No eligible active participant</option>' : candidateOptions}
        </select>
      </div>
      <div class="md-field">
        <label><input name="confirm_source_admin" type="checkbox" required> I understand that I will become an Admin immediately after transfer.</label>
      </div>
      <p class="md-form__status" role="status" aria-live="polite" data-transfer-status></p>
      <button class="md-button md-button--danger" type="submit" data-control-action${candidates.length === 0 ? " disabled" : ""}>Transfer ownership</button>
    </form>
  </section>`;
}

function renderLeave(snapshot: InvitationMembershipSnapshot): string {
  const mindId = safeId(snapshot.mind.mindId);
  if (snapshot.actor.role === "owner" || mindId === null) {
    return `<section class="md-setup-card" aria-labelledby="leave-heading">
      <div><p class="md-eyebrow">Your membership</p><h2 id="leave-heading">Leave this Mind</h2><p>The Owner must transfer ownership or delete the Mind before leaving.</p></div>
      <button class="md-button md-button--danger" type="button" disabled aria-disabled="true">Owner cannot leave</button>
    </section>`;
  }
  return `<section class="md-setup-card" aria-labelledby="leave-heading">
    <div><p class="md-eyebrow">Your membership</p><h2 id="leave-heading">Leave this Mind</h2><p>Your current membership ends immediately. Re-entry requires a new accepted invitation.</p></div>
    <button class="md-button md-button--danger" type="button" data-leave-mind data-mind-id="${escapeUntrustedText(mindId)}" data-membership-version="${snapshot.actor.membershipVersion}" data-control-action>Leave this Mind</button>
  </section>`;
}

function renderReady(snapshot: InvitationMembershipSnapshot): string {
  const actorRole = safeRole(snapshot.actor.role) ?? "reader";
  return `<div class="md-token-layout" data-invitations-membership-ready>
    <section aria-labelledby="people-mind-heading">
      <div class="md-section-heading">
        <div><p class="md-eyebrow">Trusted Sites control plane</p><h2 id="people-mind-heading"><a href="${safeMindRoute(snapshot.mind.route)}">${escapeUntrustedText(snapshot.mind.name)}</a></h2></div>
        <span class="md-token-state md-token-state--active">You are ${roleLabel(actorRole)}</span>
      </div>
    </section>
    ${renderInvitationGroup(snapshot.invitations, "incoming")}
    ${renderInvitationGroup(snapshot.invitations, "outgoing")}
    ${renderInvitationForm(snapshot)}
    <section aria-labelledby="members-heading">
      <div class="md-section-heading"><div><p class="md-eyebrow">Active access</p><h2 id="members-heading">Participants</h2></div></div>
      <div class="md-token-grid">${snapshot.members.map((member) => renderMemberCard(member, actorRole)).join("")}</div>
    </section>
    ${renderTransfer(snapshot)}
    ${renderLeave(snapshot)}
  </div>`;
}

function renderCollection(collection: InvitationMembershipCollectionState): string {
  switch (collection.kind) {
    case "loading":
      return `<section class="md-state md-state--loading" aria-labelledby="people-heading" aria-busy="true" data-people-collection>
        <div class="md-loading-mark" aria-hidden="true"><span></span><span></span><span></span></div>
        <h2 id="people-heading">Loading participants and invitations</h2>
        <p role="status" aria-live="polite">Checking current access…</p>
      </section>`;
    case "error":
      return `<section class="md-state md-state--error" aria-labelledby="people-heading" role="alert" data-people-collection>
        <span class="md-state__symbol" aria-hidden="true">!</span>
        <h2 id="people-heading">Current access could not be verified</h2>
        <p>${escapeUntrustedText(collection.message)}</p>
        <button class="md-button md-button--secondary" type="button" data-people-retry>Try again</button>
      </section>`;
    case "unavailable":
      return `<section class="md-state" aria-labelledby="people-heading" data-people-collection data-access-unavailable>
        <span class="md-state__symbol" aria-hidden="true">○</span>
        <h2 id="people-heading">Management access is no longer available</h2>
        <p>${escapeUntrustedText(collection.message)}</p>
        <a class="md-button md-button--secondary" href="/minds">Back to Minds</a>
      </section>`;
    case "ready":
      return `<section data-people-collection>${renderReady(collection.snapshot)}</section>`;
  }
}

function renderHeader(displayName: string): string {
  const safeName = escapeUntrustedText(displayName);
  return `<header class="md-header">
    <a class="md-brand" href="/" aria-label="Mind Diary home"><img src="${MIND_DIARY_UI_ASSETS.lockup}" alt="Mind Diary" width="204" height="48"></a>
    <button class="md-menu-button" type="button" aria-expanded="false" aria-controls="primary-navigation" data-menu-button><span aria-hidden="true">Menu</span><span>Navigation</span></button>
    <nav id="primary-navigation" class="md-navigation" aria-label="Primary" data-navigation>
      <a href="/me"><span aria-hidden="true">●</span> My Mind</a>
      <a href="/minds"><span aria-hidden="true">▤</span> Minds</a>
      <a href="/invitations" aria-current="page"><span aria-hidden="true">✉</span> Invitations</a>
      <a href="/settings/mcp"><span aria-hidden="true">⌁</span> MCP setup</a>
    </nav>
    <button class="md-profile" type="button" aria-label="Open account menu for ${safeName}"><span class="md-profile__initial" aria-hidden="true">${escapeUntrustedText(displayName.slice(0, 1).toUpperCase())}</span><span>${safeName}</span></button>
  </header>`;
}

export function renderInvitationsMembership(
  model: InvitationMembershipPageModel,
): string {
  const announcement = model.announcement
    ? `<p class="md-announcement" role="status" aria-live="polite" data-page-announcement>${escapeUntrustedText(model.announcement)}</p>`
    : `<p class="md-announcement" role="status" aria-live="polite" data-page-announcement hidden></p>`;
  return `<div class="md-shell" data-invitations-membership-shell data-nav-open="false">
    <a class="md-skip-link" href="#main-content">Skip to main content</a>
    ${renderHeader(model.displayName)}
    <main id="main-content" class="md-main" tabindex="-1">
      <div class="md-page-heading"><div><p class="md-eyebrow">People and access</p><h1>Invitations and participants</h1><p>Invite registered people, respond to invitations, and manage current access without exposing Mind content.</p></div>${announcement}</div>
      ${renderCollection(model.collection)}
    </main>
    <footer class="md-footer"><p><strong>Mind Diary</strong> applies every access change to current server state.</p><a href="/help">Help and accessibility</a></footer>
  </div>`;
}

export function renderInvitationsMembershipDocument(
  model: InvitationMembershipPageModel,
  clientScript?: string,
): string {
  const safeClientScript =
    typeof clientScript === "string" &&
    /^\/[A-Za-z0-9][A-Za-z0-9/_-]*\.(?:js|mjs)$/u.test(clientScript)
      ? clientScript
      : null;
  const script = safeClientScript
    ? `\n  <script type="module" src="${escapeUntrustedText(safeClientScript)}"></script>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Invitations and participants — Mind Diary</title>
  <link rel="stylesheet" href="${MIND_DIARY_UI_ASSETS.tokens}">
  <link rel="stylesheet" href="${MIND_DIARY_UI_ASSETS.shellStyles}">
</head>
<body>
  ${renderInvitationsMembership(model)}${script}
</body>
</html>`;
}

function replaceCollection(
  shell: HTMLElement,
  collection: InvitationMembershipCollectionState,
): void {
  const current = shell.querySelector<HTMLElement>("[data-people-collection]");
  if (!current) return;
  const template = shell.ownerDocument.createElement("template");
  template.innerHTML = renderCollection(collection);
  const next = template.content.firstElementChild;
  if (next) current.replaceWith(next);
}

function setAnnouncement(shell: HTMLElement, message: string): void {
  const announcement = shell.querySelector<HTMLElement>("[data-page-announcement]");
  if (!announcement) return;
  announcement.hidden = false;
  announcement.textContent = message;
}

function setBusy(shell: HTMLElement, busy: boolean): void {
  shell.setAttribute("aria-busy", String(busy));
  if (busy) {
    for (const control of Array.from(
      shell.querySelectorAll<HTMLButtonElement>("[data-control-action]:not(:disabled)"),
    )) {
      control.dataset.busyDisabled = "true";
      control.disabled = true;
    }
    return;
  }
  for (const control of Array.from(
    shell.querySelectorAll<HTMLButtonElement>("[data-busy-disabled='true']"),
  )) {
    control.disabled = false;
    delete control.dataset.busyDisabled;
  }
}

function failureCode(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return null;
}

function failureMessage(error: unknown): string {
  const code = failureCode(error);
  if (code === "invitation_expired") {
    return "The invitation expired before the action completed. The latest state is shown.";
  }
  if (
    code === "metadata_conflict" ||
    code === "membership_version_conflict" ||
    code === "membership_state_changed" ||
    code === "invitation_conflict" ||
    code === "ownership_state_changed" ||
    code === "idempotency_conflict"
  ) {
    return "Access changed while the action was running. The latest state is shown; review it before retrying.";
  }
  if (
    code === "forbidden" ||
    code === "membership_not_found" ||
    code === "owner_membership_protected" ||
    code === "ownership_target_invalid"
  ) {
    return "The action is no longer authorized. Current state was reloaded and unavailable controls are disabled.";
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return `${error.message.trim().slice(0, 220)} Current state was reloaded.`;
  }
  return "The action was not applied. Current state was reloaded.";
}

function numberAttribute(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/u.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

export function installInvitationsMembership(
  adapter: InvitationsMembershipAdapter,
  root: Document | HTMLElement = document,
  options: InvitationsMembershipInstallOptions = {},
): () => void {
  const shell = root.querySelector<HTMLElement>("[data-invitations-membership-shell]");
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
  const createKey = options.createIdempotencyKey ?? defaultIdempotencyKey;
  let mutationPending = false;
  let refreshPending = false;

  const loadAuthoritativeState = async (): Promise<boolean> => {
    try {
      const loaded = await adapter.loadPage();
      if (loaded.kind !== "ready" && loaded.kind !== "unavailable") {
        throw new Error("Authoritative state is unavailable.");
      }
      replaceCollection(shell, loaded);
      return true;
    } catch {
      replaceCollection(shell, {
        kind: "error",
        message: "No access controls are shown until current server state can be loaded.",
      });
      return false;
    }
  };

  const runMutation = async (
    operation: () => Promise<void>,
    successMessage: string,
  ): Promise<void> => {
    if (mutationPending) return;
    mutationPending = true;
    setBusy(shell, true);
    setAnnouncement(shell, "Applying the action and checking current state…");
    let failure: unknown = null;
    try {
      await operation();
    } catch (error) {
      failure = error;
    }
    const refreshed = await loadAuthoritativeState();
    if (!refreshed) {
      setAnnouncement(
        shell,
        failure === null
          ? "The action may have completed, but current access could not be verified. Controls are hidden."
          : "The action failed and current access could not be verified. Controls are hidden.",
      );
    } else {
      setAnnouncement(shell, failure === null ? successMessage : failureMessage(failure));
    }
    setBusy(shell, false);
    mutationPending = false;
  };

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

  on<SubmitEvent>(shell, "submit", (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form) return;
    if (form.matches("[data-invitation-form]")) {
      event.preventDefault();
      if (mutationPending || !form.reportValidity()) return;
      const data = new FormData(form);
      const email = String(data.get("target_verified_email") ?? "").trim();
      const role = safeProposedRole(data.get("role"));
      const mindId = safeId(form.dataset.mindId ?? "");
      const metadataVersion = numberAttribute(form.dataset.metadataVersion);
      const status = form.querySelector<HTMLElement>("[data-invitation-form-status]");
      if (!EXACT_EMAIL.test(email) || role === null || mindId === null || metadataVersion === null) {
        if (status) status.textContent = "Enter one exact registered email and choose an allowed role.";
        return;
      }
      void runMutation(
        () => adapter.createInvitation({
          mindId,
          targetVerifiedEmail: email,
          role,
          expectedMetadataVersion: metadataVersion,
          idempotencyKey: createKey(),
        }),
        "Invitation created. It grants no access until the registered person accepts it.",
      );
      return;
    }
    if (form.matches("[data-member-role-form]")) {
      event.preventDefault();
      if (mutationPending || !form.reportValidity()) return;
      const data = new FormData(form);
      const role = safeProposedRole(data.get("role"));
      const memberId = safeId(form.dataset.memberId ?? "");
      const membershipVersion = numberAttribute(form.dataset.membershipVersion);
      const mindId = safeId(
        shell.querySelector<HTMLFormElement>("[data-invitation-form]")?.dataset.mindId ??
          shell.querySelector<HTMLFormElement>("[data-transfer-form]")?.dataset.mindId ??
          "",
      );
      if (role === null || memberId === null || membershipVersion === null || mindId === null) return;
      void runMutation(
        () => adapter.changeMemberRole({
          mindId,
          memberId,
          role,
          expectedMembershipVersion: membershipVersion,
          idempotencyKey: createKey(),
        }),
        "Participant role updated from current server state.",
      );
      return;
    }
    if (form.matches("[data-transfer-form]")) {
      event.preventDefault();
      if (mutationPending || !form.reportValidity()) return;
      const data = new FormData(form);
      const targetMemberId = safeId(String(data.get("target_member_id") ?? ""));
      const confirmed = data.get("confirm_source_admin") === "on";
      const mindId = safeId(form.dataset.mindId ?? "");
      const metadataVersion = numberAttribute(form.dataset.metadataVersion);
      const status = form.querySelector<HTMLElement>("[data-transfer-status]");
      if (!confirmed || targetMemberId === null || mindId === null || metadataVersion === null) {
        if (status) status.textContent = "Choose an active participant and confirm that you become Admin.";
        return;
      }
      void runMutation(
        () => adapter.transferOwnership({
          mindId,
          targetMemberId,
          expectedMetadataVersion: metadataVersion,
          confirmation: "transfer-ownership",
          idempotencyKey: createKey(),
        }),
        "Ownership transferred. Your current role is now Admin.",
      );
    }
  });

  on<MouseEvent>(shell, "click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const retry = target.closest<HTMLButtonElement>("[data-people-retry]");
    if (retry) {
      if (refreshPending || mutationPending) return;
      refreshPending = true;
      replaceCollection(shell, { kind: "loading" });
      void loadAuthoritativeState().then((loaded) => {
        setAnnouncement(
          shell,
          loaded ? "Current access state loaded." : "Current access state is still unavailable.",
        );
        refreshPending = false;
      });
      return;
    }

    const invitationAction = target.closest<HTMLButtonElement>("[data-invitation-action]");
    if (invitationAction) {
      const invitationId = safeId(invitationAction.dataset.invitationId ?? "");
      const expectedInvitationVersion = numberAttribute(invitationAction.dataset.invitationVersion);
      if (mutationPending || invitationId === null || expectedInvitationVersion === null) return;
      const command = {
        invitationId,
        expectedInvitationVersion,
        idempotencyKey: createKey(),
      };
      const action = invitationAction.dataset.invitationAction;
      if (action === "accept") {
        void runMutation(() => adapter.acceptInvitation(command), "Invitation accepted. Current participant access is shown.");
      } else if (action === "reject") {
        void runMutation(() => adapter.rejectInvitation(command), "Invitation rejected.");
      } else if (action === "cancel") {
        void runMutation(() => adapter.cancelInvitation(command), "Invitation cancelled before acceptance.");
      } else if (action === "reissue") {
        void runMutation(() => adapter.reissueInvitation(command), "Invitation reissued for a new 7-day period.");
      }
      return;
    }

    const revoke = target.closest<HTMLButtonElement>("[data-revoke-member]");
    if (revoke) {
      const memberId = safeId(revoke.dataset.memberId ?? "");
      const expectedMembershipVersion = numberAttribute(revoke.dataset.membershipVersion);
      const mindId = safeId(
        shell.querySelector<HTMLFormElement>("[data-invitation-form]")?.dataset.mindId ??
          shell.querySelector<HTMLFormElement>("[data-transfer-form]")?.dataset.mindId ??
          "",
      );
      if (mutationPending || memberId === null || expectedMembershipVersion === null || mindId === null) return;
      void runMutation(
        () => adapter.revokeMember({
          mindId,
          memberId,
          expectedMembershipVersion,
          idempotencyKey: createKey(),
        }),
        "Participant access revoked. The refreshed participant list is shown.",
      );
      return;
    }

    const leave = target.closest<HTMLButtonElement>("[data-leave-mind]");
    if (leave) {
      const mindId = safeId(leave.dataset.mindId ?? "");
      const expectedMembershipVersion = numberAttribute(leave.dataset.membershipVersion);
      if (mutationPending || mindId === null || expectedMembershipVersion === null) return;
      void runMutation(
        () => adapter.leaveMind({ mindId, expectedMembershipVersion, idempotencyKey: createKey() }),
        "You left this Mind. Current access is no longer available.",
      );
    }
  });

  on<KeyboardEvent>(shell, "keydown", (event) => {
    if (event.key === "Escape" && shell.dataset.navOpen === "true") {
      closeNavigation();
      menuButton?.focus();
    }
  });

  return () => {
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}
