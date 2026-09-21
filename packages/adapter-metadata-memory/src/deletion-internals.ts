import {
  type AuditEvent,
  type AuditOutboxMessage,
  type BackgroundJob,
  type BundleFileDownloadGrant,
  type ExportDownloadGrant,
  type ExportJob,
  type ExternalIdentityBinding,
  type HandleReservationSnapshot,
  type JobId,
  type KnowledgeSpace,
  type PersonalSpaceBinding,
  type Principal,
  type RevisionIndexState,
  type SpaceInvitation,
  type SpaceMembership,
  type VerifiedSpaceHost,
} from "@mind-diary/application-ports";
import { copyOnWriteMap, isCopyOnWriteMap } from "./copy-on-write.js";

import {
  compareUnicodeScalarValues,
  type SpaceId,
  type AuditEventId,
  type OutboxMessageId,
  type SpaceState,
  type CompletedIdempotencyRecord,
} from "./revision-internals.js";

import {
  ordinaryMindIdempotencySpaceId,
  type PersonalProfileIdempotencyRecord,
  type OrdinaryMindIdempotencyRecord,
} from "./control-internals.js";

export const PUBLIC_CATALOG_CURSOR_PREFIX = "mdc1_";
export const PUBLIC_CATALOG_CURSOR_QUERY = "public_minds";
export const PUBLIC_CATALOG_MAX_CURSOR_BYTES = 256;
export const PUBLIC_CATALOG_SNAPSHOT_RETENTION = 32;
export const PUBLIC_CATALOG_BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export interface PublicCatalogCursorPayload {
  readonly v: 1;
  readonly q: typeof PUBLIC_CATALOG_CURSOR_QUERY;
  readonly g: number;
  readonly o: number;
}

export function encodePublicCatalogCursor(generation: number, offset: number): string {
  const json = JSON.stringify({
    v: 1,
    q: PUBLIC_CATALOG_CURSOR_QUERY,
    g: generation,
    o: offset,
  });
  return `${PUBLIC_CATALOG_CURSOR_PREFIX}${btoa(json)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")}`;
}

export function decodePublicCatalogCursor(
  cursor: string,
): Readonly<PublicCatalogCursorPayload> | null {
  if (
    cursor.length === 0 ||
    new TextEncoder().encode(cursor).byteLength >
      PUBLIC_CATALOG_MAX_CURSOR_BYTES ||
    !cursor.startsWith(PUBLIC_CATALOG_CURSOR_PREFIX)
  ) {
    return null;
  }
  const encoded = cursor.slice(PUBLIC_CATALOG_CURSOR_PREFIX.length);
  if (
    encoded.length === 0 ||
    encoded.length % 4 === 1 ||
    !PUBLIC_CATALOG_BASE64URL_PATTERN.test(encoded)
  ) {
    return null;
  }
  try {
    const padded = `${encoded}${"=".repeat((4 - (encoded.length % 4)) % 4)}`;
    const json = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).length !== 4 ||
      record.v !== 1 ||
      record.q !== PUBLIC_CATALOG_CURSOR_QUERY ||
      typeof record.g !== "number" ||
      !Number.isSafeInteger(record.g) ||
      record.g < 0 ||
      typeof record.o !== "number" ||
      !Number.isSafeInteger(record.o) ||
      record.o < 0
    ) {
      return null;
    }
    const payload = Object.freeze({
      v: 1 as const,
      q: PUBLIC_CATALOG_CURSOR_QUERY,
      g: record.g,
      o: record.o,
    });
    return encodePublicCatalogCursor(payload.g, payload.o) === cursor
      ? payload
      : null;
  } catch {
    return null;
  }
}

export function clonePublicCatalogSnapshots(
  source: ReadonlyMap<number, readonly SpaceId[]>,
): Map<number, readonly SpaceId[]> {
  if (isCopyOnWriteMap(source)) {
    return copyOnWriteMap(source, (spaceIds) => Object.freeze([...spaceIds]));
  }
  return new Map(
    [...source].map(([generation, spaceIds]) => [
      generation,
      Object.freeze([...spaceIds]),
    ]),
  );
}

export function derivePublicMindCatalogSpaceIds(
  knowledgeSpaces: ReadonlyMap<SpaceId, Readonly<KnowledgeSpace>>,
  personalBindings: ReadonlyMap<
    PersonalSpaceBinding["principalId"],
    Readonly<PersonalSpaceBinding>
  >,
): Set<SpaceId> {
  const personalSpaceIds = new Set(
    [...personalBindings.values()].map((binding) => binding.spaceId),
  );
  return new Set(
    [...knowledgeSpaces.values()]
      .filter(
        (space) =>
          typeof space.spaceId === "string" &&
          space.spaceId.length > 0 &&
          space.state === "active" &&
          space.visibility === "public" &&
          !personalSpaceIds.has(space.spaceId),
      )
      .map((space) => space.spaceId),
  );
}

export function stagePublicCatalogSnapshot(
  generation: number,
  spaceIds: ReadonlySet<SpaceId>,
  snapshots: Map<number, readonly SpaceId[]>,
): void {
  snapshots.set(
    generation,
    Object.freeze([...spaceIds].sort(compareUnicodeScalarValues)),
  );
  while (snapshots.size > PUBLIC_CATALOG_SNAPSHOT_RETENTION) {
    const oldest = Math.min(...snapshots.keys());
    snapshots.delete(oldest);
  }
}

export interface OrdinaryMindDeletionState {
  readonly knowledgeSpaces: ReadonlyMap<SpaceId, Readonly<KnowledgeSpace>>;
  readonly memberships: ReadonlyMap<
    SpaceMembership["membershipId"],
    Readonly<SpaceMembership>
  >;
  readonly invitations: ReadonlyMap<
    SpaceInvitation["invitationId"],
    Readonly<SpaceInvitation>
  >;
  readonly revisionSpaces: ReadonlyMap<SpaceId, SpaceState>;
  readonly ordinaryIdempotency: ReadonlyMap<
    string,
    Readonly<OrdinaryMindIdempotencyRecord>
  >;
  readonly contentIdempotency: ReadonlyMap<string, CompletedIdempotencyRecord>;
  readonly auditEvents: ReadonlyMap<AuditEventId, Readonly<AuditEvent>>;
  readonly auditOutbox: ReadonlyMap<OutboxMessageId, Readonly<AuditOutboxMessage>>;
  readonly backgroundJobs: ReadonlyMap<JobId, Readonly<BackgroundJob>>;
  readonly exportJobs: ReadonlyMap<JobId, Readonly<ExportJob>>;
  readonly exportDownloadGrants: ReadonlyMap<
    string,
    Readonly<ExportDownloadGrant>
  >;
  readonly bundleFileDownloadGrants: ReadonlyMap<
    string,
    Readonly<BundleFileDownloadGrant>
  >;
  readonly indexStates: ReadonlyMap<string, Readonly<RevisionIndexState>>;
  readonly activeBySpace: ReadonlyMap<
    SpaceId,
    Readonly<HandleReservationSnapshot>
  >;
}

export function targetRecordSelection(
  spaceId: SpaceId,
  state: OrdinaryMindDeletionState,
) {
  const auditIds = [...state.auditEvents]
    .filter(([, event]) => event.spaceId === spaceId)
    .map(([id]) => id)
    .sort();
  const auditIdSet = new Set(auditIds);
  const outboxIds = [...state.auditOutbox]
    .filter(([, message]) => auditIdSet.has(message.auditEventId))
    .map(([id]) => id)
    .sort();
  const outboxIdSet = new Set(outboxIds);
  const invitationIds = [...state.invitations]
    .filter(([, invitation]) => invitation.spaceId === spaceId)
    .map(([id]) => id)
    .sort();
  const invitationIdSet = new Set(invitationIds);
  const backgroundJobIds = [...state.backgroundJobs]
    .filter(
      ([, job]) =>
        ("spaceId" in job.target && job.target.spaceId === spaceId) ||
        (job.target.kind === "audit_delivery" &&
          outboxIdSet.has(job.target.outboxMessageId)) ||
        (job.target.kind === "expire_invitation" &&
          invitationIdSet.has(job.target.invitationId)),
    )
    .map(([id]) => id)
    .sort();
  const exportJobIds = [...state.exportJobs]
    .filter(([, job]) => job.spaceId === spaceId)
    .map(([id]) => id)
    .sort();
  const exportGrantKeys = [...state.exportDownloadGrants]
    .filter(([, grant]) => grant.spaceId === spaceId)
    .map(([key]) => key)
    .sort();
  const bundleFileDownloadGrantKeys = [...state.bundleFileDownloadGrants]
    .filter(([, grant]) => grant.spaceId === spaceId)
    .map(([key]) => key)
    .sort();
  const indexKeys = [...state.indexStates]
    .filter(([, indexState]) => indexState.spaceId === spaceId)
    .map(([key]) => key)
    .sort();
  const contentIdempotencyKeys = [...state.contentIdempotency]
    .filter(([, record]) => record.spaceId === spaceId)
    .map(([key]) => key)
    .sort();
  const ordinaryIdempotencyKeys = [...state.ordinaryIdempotency]
    .filter(([, record]) => ordinaryMindIdempotencySpaceId(record) === spaceId)
    .map(([key]) => key)
    .sort();
  const membershipIds = [...state.memberships]
    .filter(([, membership]) => membership.spaceId === spaceId)
    .map(([id]) => id)
    .sort();
  const revisionIds = [...(state.revisionSpaces.get(spaceId)?.revisions.keys() ?? [])]
    .sort();
  return Object.freeze({
    auditIds: Object.freeze(auditIds),
    outboxIds: Object.freeze(outboxIds),
    backgroundJobIds: Object.freeze(backgroundJobIds),
    exportJobIds: Object.freeze(exportJobIds),
    exportGrantKeys: Object.freeze(exportGrantKeys),
    bundleFileDownloadGrantKeys: Object.freeze(bundleFileDownloadGrantKeys),
    indexKeys: Object.freeze(indexKeys),
    contentIdempotencyKeys: Object.freeze(contentIdempotencyKeys),
    ordinaryIdempotencyKeys: Object.freeze(ordinaryIdempotencyKeys),
    membershipIds: Object.freeze(membershipIds),
    revisionIds: Object.freeze(revisionIds),
    invitationIds: Object.freeze(invitationIds),
  });
}

export function ordinaryMindDeletionFingerprint(
  spaceId: SpaceId,
  state: OrdinaryMindDeletionState,
): string | null {
  const space = state.knowledgeSpaces.get(spaceId);
  const reservation = state.activeBySpace.get(spaceId);
  const revisionState = state.revisionSpaces.get(spaceId);
  if (!space || !reservation || !revisionState) return null;
  const records = targetRecordSelection(spaceId, state);
  return JSON.stringify({
    format: "mind-diary-ordinary-mind-deletion-impact-v1",
    space: {
      space_id: space.spaceId,
      state: space.state,
      visibility: space.visibility,
      metadata_version: space.metadataVersion,
      access_version: space.accessVersion,
      head_revision_id: space.headRevisionId,
      updated_at: space.updatedAt,
    },
    handle: {
      host: reservation.host,
      canonical_handle: reservation.canonicalHandle,
    },
    memberships: records.membershipIds.map((id) => {
      const membership = state.memberships.get(id)!;
      return [
        id,
        membership.principalId,
        membership.role,
        membership.state,
        membership.version,
      ];
    }),
    revisions: records.revisionIds.map((id) => {
      const envelope = revisionState.revisions.get(id)!;
      return [
        id,
        envelope.revision.revisionNumber,
        envelope.revision.parentRevisionId,
        envelope.revision.manifestHash,
      ];
    }),
    service_records: {
      invitation_ids: records.invitationIds,
      background_job_ids: records.backgroundJobIds,
      export_job_ids: records.exportJobIds,
      export_grants: records.exportGrantKeys.map((key) => {
        const grant = state.exportDownloadGrants.get(key)!;
        return [
          grant.jobId,
          grant.requestedByPrincipalId,
          grant.state,
          grant.expiresAt,
        ];
      }),
      bundle_file_download_grants: records.bundleFileDownloadGrantKeys.map((key) => {
        const grant = state.bundleFileDownloadGrants.get(key)!;
        return [
          grant.requestedByPrincipalId,
          grant.tokenId,
          grant.revisionId,
          grant.path,
          grant.state,
          grant.expiresAt,
        ];
      }),
      index_keys: records.indexKeys,
      audit_ids: records.auditIds,
      outbox_ids: records.outboxIds,
      content_idempotency_keys: records.contentIdempotencyKeys,
      ordinary_idempotency_keys: records.ordinaryIdempotencyKeys,
    },
  });
}

export interface AccountDeletionState extends OrdinaryMindDeletionState {
  readonly principals: ReadonlyMap<Principal["principalId"], Readonly<Principal>>;
  readonly externalBindings: ReadonlyMap<
    string,
    Readonly<ExternalIdentityBinding>
  >;
  readonly personalBindings: ReadonlyMap<
    PersonalSpaceBinding["principalId"],
    Readonly<PersonalSpaceBinding>
  >;
  readonly personalProfileIdempotency: ReadonlyMap<
    string,
    Readonly<PersonalProfileIdempotencyRecord>
  >;
}

export function accountDeletionSelection(
  principalId: Principal["principalId"],
  host: VerifiedSpaceHost,
  state: AccountDeletionState,
) {
  const principal = state.principals.get(principalId);
  const personalBinding = state.personalBindings.get(principalId);
  const personalSpace = personalBinding
    ? state.knowledgeSpaces.get(personalBinding.spaceId)
    : undefined;
  const personalRevisionState = personalSpace
    ? state.revisionSpaces.get(personalSpace.spaceId)
    : undefined;
  if (
    !principal ||
    principal.state !== "active" ||
    !personalBinding ||
    !personalSpace ||
    personalSpace.state !== "active" ||
    !personalRevisionState
  ) {
    return null;
  }

  const personalSpaceIds = new Set(
    [...state.personalBindings.values()].map((binding) => binding.spaceId),
  );
  const ownedSpaceIds = [...state.memberships.values()]
    .filter(
      (membership) =>
        membership.principalId === principalId &&
        membership.role === "owner" &&
        membership.state === "active" &&
        !personalSpaceIds.has(membership.spaceId) &&
        state.knowledgeSpaces.get(membership.spaceId)?.state === "active",
    )
    .map((membership) => membership.spaceId)
    .sort(compareUnicodeScalarValues);
  const ownedMinds = ownedSpaceIds.map((spaceId) => {
    const space = state.knowledgeSpaces.get(spaceId)!;
    const reservation = state.activeBySpace.get(spaceId);
    const revisions = state.revisionSpaces.get(spaceId);
    if (!reservation || reservation.host !== host || !revisions) return null;
    return Object.freeze({
      spaceId,
      host: reservation.host,
      canonicalHandle: reservation.canonicalHandle,
      name: space.name,
      revisionCount: revisions.revisions.size,
    });
  });
  if (ownedMinds.some((mind) => mind === null)) return null;

  const deletedSpaceIds = Object.freeze([
    personalSpace.spaceId,
    ...ownedSpaceIds,
  ]);
  const deletedSpaceIdSet = new Set(deletedSpaceIds);
  const foreignMembershipIds = [...state.memberships]
    .filter(
      ([, membership]) =>
        membership.principalId === principalId &&
        !deletedSpaceIdSet.has(membership.spaceId),
    )
    .map(([id]) => id)
    .sort(compareUnicodeScalarValues);
  const foreignActiveMembershipCount = foreignMembershipIds.filter(
    (id) => state.memberships.get(id)?.state === "active",
  ).length;
  const targetInvitationIds = [...state.invitations]
    .filter(
      ([, invitation]) =>
        invitation.targetPrincipalId === principalId &&
        !deletedSpaceIdSet.has(invitation.spaceId),
    )
    .map(([id]) => id)
    .sort(compareUnicodeScalarValues);
  const pendingInvitationCount = targetInvitationIds.filter(
    (id) => state.invitations.get(id)?.state === "pending",
  ).length;
  const foreignExportJobIds = [...state.exportJobs]
    .filter(
      ([, job]) =>
        job.requestedByPrincipalId === principalId &&
        !deletedSpaceIdSet.has(job.spaceId),
    )
    .map(([id]) => id)
    .sort(compareUnicodeScalarValues);
  return Object.freeze({
    principal,
    personalBinding,
    personalSpace,
    personalRevisionCount: personalRevisionState.revisions.size,
    ownedMinds: Object.freeze(
      ownedMinds as readonly NonNullable<(typeof ownedMinds)[number]>[],
    ),
    deletedSpaceIds,
    deletedSpaceIdSet,
    foreignMembershipIds: Object.freeze(foreignMembershipIds),
    foreignActiveMembershipCount,
    targetInvitationIds: Object.freeze(targetInvitationIds),
    pendingInvitationCount,
    foreignExportJobIds: Object.freeze(foreignExportJobIds),
  });
}

export function accountDeletionFingerprint(
  principalId: Principal["principalId"],
  host: VerifiedSpaceHost,
  state: AccountDeletionState,
): string | null {
  const selected = accountDeletionSelection(principalId, host, state);
  if (!selected) return null;
  const targetSpaces = selected.deletedSpaceIds.map((spaceId) => {
    const space = state.knowledgeSpaces.get(spaceId)!;
    const records = targetRecordSelection(spaceId, state);
    return {
      space: [
        space.spaceId,
        space.state,
        space.visibility,
        space.metadataVersion,
        space.accessVersion,
        space.headRevisionId,
        space.updatedAt,
      ],
      handle: state.activeBySpace.has(spaceId)
        ? [
            state.activeBySpace.get(spaceId)!.host,
            state.activeBySpace.get(spaceId)!.canonicalHandle,
          ]
        : null,
      memberships: records.membershipIds.map((id) => {
        const membership = state.memberships.get(id)!;
        return [
          id,
          membership.principalId,
          membership.role,
          membership.state,
          membership.version,
        ];
      }),
      revisions: records.revisionIds.map((id) => {
        const revision = state.revisionSpaces.get(spaceId)!.revisions.get(id)!;
        return [
          id,
          revision.revision.revisionNumber,
          revision.revision.manifestHash,
          revision.revision.committedBy,
        ];
      }),
      records: {
        invitations: records.invitationIds,
        background_jobs: records.backgroundJobIds,
        export_jobs: records.exportJobIds,
        export_grants: records.exportGrantKeys,
        indexes: records.indexKeys,
        audit: records.auditIds,
        outbox: records.outboxIds,
        content_idempotency: records.contentIdempotencyKeys,
        ordinary_idempotency: records.ordinaryIdempotencyKeys,
      },
    };
  });
  const foreignRevisionAuthors = [...state.revisionSpaces]
    .filter(([spaceId]) => !selected.deletedSpaceIdSet.has(spaceId))
    .flatMap(([spaceId, revisionState]) =>
      [...revisionState.revisions.values()]
        .filter(
          (envelope) =>
            envelope.revision.committedBy.kind === "principal" &&
            envelope.revision.committedBy.principalId === principalId,
        )
        .map((envelope) => [
          spaceId,
          envelope.revision.revisionId,
          envelope.revision.manifestHash,
        ]),
    )
    .sort((left, right) =>
      compareUnicodeScalarValues(String(left[1]), String(right[1])),
    );
  return JSON.stringify({
    format: "mind-diary-account-deletion-impact-v1",
    principal: [
      selected.principal.principalId,
      selected.principal.state,
      selected.principal.profileVersion,
      selected.principal.updatedAt,
    ],
    bindings: [...state.externalBindings.values()]
      .filter((binding) => binding.principalId === principalId)
      .sort((left, right) =>
        compareUnicodeScalarValues(left.bindingId, right.bindingId),
      )
      .map((binding) => [
        binding.bindingId,
        binding.provider,
        binding.state,
        binding.version,
        binding.updatedAt,
      ]),
    personal_binding: [
      selected.personalBinding.spaceId,
      selected.personalBinding.version,
    ],
    target_spaces: targetSpaces,
    foreign_memberships: selected.foreignMembershipIds.map((id) => {
      const membership = state.memberships.get(id)!;
      return [id, membership.spaceId, membership.role, membership.state, membership.version];
    }),
    target_invitations: selected.targetInvitationIds.map((id) => {
      const invitation = state.invitations.get(id)!;
      return [id, invitation.spaceId, invitation.state, invitation.version];
    }),
    foreign_revision_authors: foreignRevisionAuthors,
    foreign_audit_actor_ids: [...state.auditEvents]
      .filter(
        ([, event]) =>
          event.actor.kind === "principal" &&
          event.actor.principalId === principalId &&
          (event.spaceId === null || !selected.deletedSpaceIdSet.has(event.spaceId)),
      )
      .map(([id]) => id)
      .sort(compareUnicodeScalarValues),
    foreign_export_job_ids: selected.foreignExportJobIds,
    content_idempotency: [...state.contentIdempotency]
      .filter(([, record]) => record.principalId === principalId)
      .map(([key]) => key)
      .sort(compareUnicodeScalarValues),
    ordinary_idempotency: [...state.ordinaryIdempotency]
      .filter(([, record]) => record.principalId === principalId)
      .map(([key]) => key)
      .sort(compareUnicodeScalarValues),
    personal_profile_idempotency: [...state.personalProfileIdempotency]
      .filter(([, record]) => record.principalId === principalId)
      .map(([key]) => key)
      .sort(compareUnicodeScalarValues),
  });
}
