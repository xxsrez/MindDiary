import type { McpTokenActorContext } from "@mind-diary/application-contracts";
import type { PrincipalMindUsageWritePin } from "./principal-mind-usage.js";
import type { RevisionId, Sha256Digest, SpaceId } from "@mind-diary/domain";

/** No note bytes or bearer secrets are stored in metadata. */
export interface QueuedNote {
  readonly receiptId: string;
  readonly spaceId: SpaceId;
  readonly actor: McpTokenActorContext;
  readonly writePin: PrincipalMindUsageWritePin;
  readonly payloadHash: Sha256Digest;
  readonly size: number;
  readonly path: string;
  readonly state: "queued" | "running" | "committed" | "failed";
  readonly attempts: number;
  readonly leaseUntil: number;
  readonly revisionId: RevisionId | null;
  readonly expectedRevisionId: RevisionId | null;
  readonly failureCode: string | null;
}

export interface NoteQueueTransaction {
  listQueuedNotes(): Promise<readonly Readonly<QueuedNote>[]>;
  readQueuedNote(receiptId: string): Promise<Readonly<QueuedNote> | null>;
  putQueuedNote(note: Readonly<QueuedNote>): Promise<void>;
}

export function isQueuedNote(value: unknown): value is Readonly<QueuedNote> {
  if (value === null || typeof value !== "object") return false;
  const note = value as QueuedNote;
  return typeof note.receiptId === "string" && /^note_[a-f0-9]{64}$/u.test(note.receiptId) &&
    typeof note.spaceId === "string" && note.spaceId.length > 0 &&
    note.actor?.kind === "registered_principal" && note.actor.authentication?.kind === "mcp_token" &&
    typeof note.actor.principalId === "string" && typeof note.actor.authentication.tokenId === "string" &&
    Array.isArray(note.actor.authentication.effectiveScopes) && Array.isArray(note.actor.deploymentCapabilities) &&
    note.writePin?.principalId === note.actor.principalId && note.writePin.spaceId === note.spaceId &&
    typeof note.writePin.generationId === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(note.payloadHash) &&
    Number.isSafeInteger(note.size) && note.size > 0 && note.size <= 70_000 &&
    note.path === `raw/inbox/${note.receiptId}.md` &&
    ["queued", "running", "committed", "failed"].includes(note.state) &&
    Number.isSafeInteger(note.attempts) && note.attempts >= 0 && note.attempts <= 5 &&
    Number.isSafeInteger(note.leaseUntil) && note.leaseUntil >= 0 &&
    (note.expectedRevisionId === null || typeof note.expectedRevisionId === "string") &&
    (note.revisionId === null || typeof note.revisionId === "string") &&
    (note.failureCode === null || /^[a-z_]{1,64}$/u.test(note.failureCode));
}
