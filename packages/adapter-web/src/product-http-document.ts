import {
  renderAuthenticatedOnboardingDocument,
  type AuthenticatedOnboardingModel,
} from "./onboarding.js";

import {
  renderAccountDeletionDocument,
} from "./account-deletion.js";

import {
  renderMindDiaryUiShellDocument,
  renderMindDiaryRoutePageDocument,
  type MindDiaryUiShellModel,
  type UiMindCard,
} from "./ui-shell.js";

import {
  renderOrdinaryMindsManagementDocument,
  type OrdinaryMindOwnershipCandidates,
  type OrdinaryMindCapacity,
  type OrdinaryMindUiMember,
  type OrdinaryMindsManagementModel,
} from "./ordinary-minds-management.js";

import {
  renderVisibilityCatalogDocument,
} from "./visibility-catalog.js";

import {
  renderInvitationsMembershipDocument,
  type InvitationMembershipGlobalInvitation,
  type InvitationMembershipMember,
} from "./invitations-membership.js";

import {
  renderServiceOperatorDirectoryDocument,
} from "./operator-directory.js";

import {
  renderAdvancedMcpPageDocument,
  renderCodexHelpPageDocument,
  renderConnectionDetailDocument,
  renderConnectionsPageDocument,
  type AdvancedMcpPageModel,
  type SafeCredentialAccess,
} from "./connections.js";

import {
  type ProductSitesIdentityResolution,
  type ProductWebControlApplication,
  type ProductWebOAuthConnections,
  type ProductWebPersonalTokens,
  type ProductWebCredentialWriteTargets,
} from "./product-http-contracts.js";

import {
  RESERVED_UI_HANDLES,
  withCsrfMeta,
  record,
  pilotRoutePage,
  uiSession,
  uiMind,
  ordinaryUiMind,
  ordinaryMindCapacity,
  ordinaryUiMember,
  invitationUi,
  perMindInvitation,
  safeConnectionDetail,
  safeWritableTargetAccessByOwner,
  type ProductUiSession,
} from "./product-http-request-helpers.js";

export async function productUiDocument(input: {
  readonly pathname: string;
  readonly siteOrigin: string;
  readonly identity: Exclude<ProductSitesIdentityResolution, { readonly kind: "denied" | "unavailable" }>;
  readonly csrfToken: string;
  readonly control: ProductWebControlApplication;
  readonly oauthConnections?: ProductWebOAuthConnections;
  readonly personalTokens?: ProductWebPersonalTokens;
  readonly writableTargets?: ProductWebCredentialWriteTargets;
  readonly query: Readonly<Record<string, string>>;
  readonly listQuery?: Readonly<{
    readonly state?: "active" | "revoked" | "expired";
    readonly limit?: number;
    readonly cursor?: string;
  }>;
}): Promise<string> {
  if (input.identity.kind === "registration_required") {
    const model: AuthenticatedOnboardingModel = {
      kind: "registration_required",
      ...(input.identity.actor.suggestedDisplayName === undefined
        ? {}
        : { suggestedDisplayName: input.identity.actor.suggestedDisplayName }),
      bootstrapIdempotencyKey: `bootstrap:${crypto.randomUUID()}`,
      manualRecoveryStatus: "available",
    };
    return withCsrfMeta(renderAuthenticatedOnboardingDocument(model), input.csrfToken);
  }
  const authenticatedIdentity = input.identity;
  const readSession = async (): Promise<ProductUiSession> => {
    const captured = uiSession(authenticatedIdentity.session);
    if (captured !== null) return captured;
    const current = uiSession(await input.control.execute({
      operation: "get_session",
      actor: authenticatedIdentity.actor,
      input: Object.freeze({}),
    }));
    if (current === null) throw new TypeError("safe session projection is unavailable");
    return current;
  };
  if (input.pathname === "/minds") {
    const session = await readSession();
    return withCsrfMeta(renderOrdinaryMindsManagementDocument({
      displayName: session.displayName,
      view: {
        kind: "list",
        collection: { kind: "loading" },
      },
    }, "/ui/mind-diary-ordinary-minds-list-client.js"), input.csrfToken);
  }
  if (input.pathname === "/") {
    const session = await readSession();
    return withCsrfMeta(renderMindDiaryUiShellDocument({
      displayName: session.displayName,
      activeNavigation: "home",
      collection: { kind: "loading" },
    }), input.csrfToken);
  }
  const session = await readSession();

  if (input.pathname === "/help/codex") {
    return withCsrfMeta(renderCodexHelpPageDocument(session.displayName), input.csrfToken);
  }

  if (input.pathname === "/settings/connections") {
    if (input.oauthConnections === undefined || input.writableTargets === undefined) {
      throw new TypeError("Connections projection is unavailable");
    }
    return withCsrfMeta(renderConnectionsPageDocument({
      displayName: session.displayName,
      collection: { kind: "loading" },
    }), input.csrfToken);
  }

  const connectionDetailMatch = /^\/settings\/connections\/([^/]+)$/u.exec(input.pathname);
  if (connectionDetailMatch !== null) {
    if (input.oauthConnections === undefined || input.writableTargets === undefined) {
      throw Object.assign(new Error("Connection was not found."), { code: "connection_not_found" });
    }
    const connectionRef = connectionDetailMatch[1]!;
    const connection = await input.oauthConnections.read(
      input.identity.actor.principalId,
      connectionRef,
    );
    if (connection === null) {
      throw Object.assign(new Error("Connection was not found."), { code: "connection_not_found" });
    }
    const accessByOwner = await safeWritableTargetAccessByOwner(
      input.control,
      input.writableTargets,
      input.identity.actor,
      [Object.freeze({
        ownerId: connection.bindingOwnerId,
        credentialKind: "oauth_grant" as const,
        scopes: connection.scopes,
        state: "active" as const,
      })],
    );
    const access = accessByOwner.get(connection.bindingOwnerId);
    if (access === undefined) throw new TypeError("safe connection access is unavailable");
    const detail = safeConnectionDetail(connection, access);
    if (detail === null) {
      throw Object.assign(new Error("Connection was not found."), { code: "connection_not_found" });
    }
    return withCsrfMeta(renderConnectionDetailDocument({
      displayName: session.displayName,
      connection: detail,
    }), input.csrfToken);
  }

  if (input.pathname === "/settings/developer/mcp") {
    if (input.personalTokens === undefined || input.writableTargets === undefined) {
      throw new TypeError("Personal token projection is unavailable");
    }
    const state = input.listQuery?.state ?? "active";
    let collection: AdvancedMcpPageModel["collection"];
    try {
      const page = await input.personalTokens.listPage(input.identity.actor, {
        ...input.listQuery,
        state,
      });
      if (page.items.length === 0) {
        collection = { kind: "empty" };
      } else {
        let access = new Map<string, SafeCredentialAccess>();
        if (state === "active") {
          access = new Map(await safeWritableTargetAccessByOwner(
            input.control,
            input.writableTargets,
            input.identity.actor,
            page.items.map((token) => Object.freeze({
              ownerId: token.bindingOwnerId,
              credentialKind: "personal_token" as const,
              scopes: token.scopes,
              state: "active" as const,
            })),
          ));
        }
        collection = {
          kind: "ready",
          items: Object.freeze(page.items.map(({ bindingOwnerId, ...token }) => {
            const tokenAccess = access.get(bindingOwnerId);
            return Object.freeze({
              ...token,
              ...(state === "active" && tokenAccess !== undefined ? { access: tokenAccess } : {}),
            });
          })),
          nextCursor: page.nextCursor,
        };
      }
    } catch {
      collection = { kind: "error", message: "Reload before using a personal token." };
    }
    return withCsrfMeta(renderAdvancedMcpPageDocument({
      displayName: session.displayName,
      siteOrigin: input.siteOrigin,
      state,
      collection,
    }), input.csrfToken);
  }

  if (input.pathname === "/internal/operators/users") {
    const page = await input.control.execute({
      operation: "list_service_operator_principals",
      actor: input.identity.actor,
      input: input.query,
    });
    return withCsrfMeta(renderServiceOperatorDirectoryDocument({
      displayName: session.displayName,
      page,
      query: input.query,
    }), input.csrfToken);
  }

  if (input.pathname === "/public") {
    return withCsrfMeta(renderVisibilityCatalogDocument({
      kind: "catalog",
      displayName: session.displayName,
      authenticated: true,
      collection: { kind: "loading" },
    }, "/ui/mind-diary-visibility-client.js"), input.csrfToken);
  }

  if (input.pathname === "/invitations") {
    return withCsrfMeta(renderInvitationsMembershipDocument({
      displayName: session.displayName,
      collection: { kind: "loading" },
    }, "/ui/mind-diary-collaboration-client.js"), input.csrfToken);
  }

  if (input.pathname === "/settings/account") {
    return withCsrfMeta(renderAccountDeletionDocument({
      displayName: session.displayName,
      profile: {
        profileVersion: session.profileVersion,
        personalMindName: session.personalMindName,
        idempotencyKey: `profile:${crypto.randomUUID()}`,
      },
      state: { kind: "loading" },
    }, "/ui/mind-diary-account-client.js"), input.csrfToken);
  }

  const routePage = pilotRoutePage(input.pathname, session.displayName);
  if (routePage !== null) {
    return withCsrfMeta(renderMindDiaryRoutePageDocument(routePage), input.csrfToken);
  }

  if (input.pathname === "/me") {
    return withCsrfMeta(renderAuthenticatedOnboardingDocument({
      kind: "authenticated",
      displayName: session.displayName,
      profileVersion: session.profileVersion,
      personalMind: {
        route: "/me",
        name: session.personalMindName,
        headRevisionId: session.personalMindHeadRevisionId,
        updatedLabel: "Current HEAD is ready",
      },
      profileUpdate: { kind: "idle", idempotencyKey: `profile:${crypto.randomUUID()}` },
    }), input.csrfToken);
  }

  const routeMatch = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(input.pathname);
  const reservedUiRoute = routeMatch === null || RESERVED_UI_HANDLES.has(routeMatch[1]!);
  if (!reservedUiRoute && routeMatch !== null) {
    const handle = routeMatch[1]!;
    let view: OrdinaryMindsManagementModel["view"];
    try {
      const resolved = ordinaryUiMind(await input.control.execute({
        operation: "get_mind_info",
        actor: input.identity.actor,
        input: Object.freeze({ mind_ref: handle }),
      }));
      if (resolved === null) {
        view = { kind: "route_error", handle, message: "Mind settings are unavailable." };
      } else {
        let ownership: OrdinaryMindOwnershipCandidates | undefined;
        let capacity: OrdinaryMindCapacity | undefined;
        let collaboration: Extract<
          OrdinaryMindsManagementModel["view"],
          { readonly kind: "detail" }
        >["collaboration"];
        if (resolved.accessKind !== "visibility") {
          try {
            const [memberResult, invitationResult] = await Promise.all([
              input.control.execute({
                operation: "list_members",
                actor: input.identity.actor,
                input: Object.freeze({ mind_ref: handle }),
              }),
              input.control.execute({
                operation: "list_invitations",
                actor: input.identity.actor,
                input: Object.freeze({}),
              }),
            ]);
            const memberRecord = record(memberResult);
            const members = Array.isArray(memberRecord?.members)
              ? memberRecord.members
                .map(ordinaryUiMember)
                .filter((member): member is OrdinaryMindUiMember => member !== null)
              : [];
            const self = members.find((member) => member.isSelf);
            if (self === undefined || self.role !== resolved.role) {
              throw new TypeError("current membership projection is unavailable");
            }
            const mindMap = new Map([[resolved.mindId, resolved] as const]);
            const invitationRecord = record(invitationResult);
            const invitations = Array.isArray(invitationRecord?.invitations)
              ? invitationRecord.invitations
                .map((invitation) => invitationUi(invitation, mindMap))
                .filter((invitation): invitation is InvitationMembershipGlobalInvitation =>
                  invitation !== null && invitation.mindId === resolved.mindId)
                .map(perMindInvitation)
              : [];
            const collaborationMembers: readonly InvitationMembershipMember[] = Object.freeze(
              members.map((member) => Object.freeze({
                ...member,
                state: "active" as const,
              })),
            );
            collaboration = {
              kind: "ready",
              snapshot: Object.freeze({
                mind: Object.freeze({
                  mindId: resolved.mindId,
                  name: resolved.name,
                  route: `/${resolved.handle}`,
                  visibility: resolved.visibility,
                  metadataVersion: resolved.metadataVersion,
                }),
                actor: Object.freeze({
                  memberId: self.memberId,
                  role: self.role,
                  membershipVersion: self.membershipVersion,
                }),
                members: collaborationMembers,
                invitations: Object.freeze(invitations),
              }),
            };
            if (resolved.role === "owner") {
              ownership = { kind: "ready", members: Object.freeze(members) };
            }
          } catch {
            collaboration = { kind: "error" };
            if (resolved.role === "owner") ownership = { kind: "error" };
          }
        }
        if (resolved.role === "owner") {
          try {
            capacity = ordinaryMindCapacity(await input.control.execute({
              operation: "get_capacity_usage",
              actor: input.identity.actor,
              input: Object.freeze({ mind_ref: handle }),
            })) ?? { kind: "error" };
          } catch {
            capacity = { kind: "error" };
          }
        }
        view = {
          kind: "detail",
          mind: resolved,
          ...(ownership === undefined ? {} : { ownership }),
          ...(collaboration === undefined ? {} : { collaboration }),
          ...(capacity === undefined ? {} : { capacity }),
        };
      }
    } catch {
      view = { kind: "route_error", handle, message: "Mind settings are unavailable." };
    }
    return withCsrfMeta(renderOrdinaryMindsManagementDocument({
      displayName: session.displayName,
      view,
    }, "/ui/mind-diary-ordinary-minds-client.js"), input.csrfToken);
  }

  let collection: MindDiaryUiShellModel["collection"];
  try {
    const listed = await input.control.execute({
      operation: "list_minds",
      actor: input.identity.actor,
      input: Object.freeze({}),
    });
    const minds = Array.isArray(listed)
      ? listed.map(uiMind).filter((mind): mind is UiMindCard => mind !== null)
      : [];
    collection = minds.length === 0
      ? { kind: "empty" }
      : { kind: "ready", minds: Object.freeze(minds) };
  } catch {
    collection = { kind: "error", message: "Mind summaries are unavailable. Try again." };
  }
  return withCsrfMeta(renderMindDiaryUiShellDocument({
    displayName: session.displayName,
    activeNavigation: "home",
    collection,
  }), input.csrfToken);
}
