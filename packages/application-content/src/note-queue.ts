import type { McpTokenActorContext } from "@mind-diary/application-contracts";
import type { Authorizer, BundleFileObjectStore, Clock, ContentCommitMetadataStore, QueuedNote } from "@mind-diary/application-ports";
import { MARKDOWN_MEDIA_TYPE, principalMindUsageWriteGeneration, type SpaceId } from "@mind-diary/domain";
import type { ChangesetCommitService } from "./changeset-commit.js";
import { capacityExpiry, capacityReservationId, DEFAULT_CAPACITY_LIMITS } from "./capacity.js";

const encoder = new TextEncoder();

export class NoteQueueService {
  constructor(private readonly dependencies: {
    metadata: ContentCommitMetadataStore;
    objects: BundleFileObjectStore;
    authorizer: Authorizer;
    clock: Clock;
    commits: Pick<ChangesetCommitService, "commit" | "reconcile">;
    schedule: (receiptId: string) => void | Promise<void>;
  }) {}

  private receipt(note: Readonly<QueuedNote>) {
    return { receiptId: note.receiptId, state: note.state, path: note.path,
      revisionId: note.revisionId, failureCode: note.failureCode };
  }

  async enqueue(actor: McpTokenActorContext, spaceId: SpaceId, input: {
    idempotencyKey: unknown; title: unknown; text: unknown;
  }) {
    if (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(input.idempotencyKey) ||
        typeof input.title !== "string" || input.title.length < 1 || input.title.length > 200 ||
        typeof input.text !== "string" || input.text.length < 1 || encoder.encode(input.text).length > 65_536) {
      throw new Error("invalid_note");
    }
    const { metadata, objects, authorizer, clock } = this.dependencies;
    const query = { actor, spaceId, capability: "content:write" as const, revisionMode: "head" as const };
    const authorization = await authorizer.authorize(query);
    if (authorization.kind !== "allowed") throw new Error("note_access_denied");
    const writePin = principalMindUsageWriteGeneration(await metadata.readPrincipalMindUsage(actor.principalId), spaceId);
    if (writePin === null) throw new Error("writable_mind_required");
    const receiptId = `note_${String(await objects.calculateSha256(encoder.encode(JSON.stringify([
      actor.principalId, spaceId, input.idempotencyKey,
    ])))).replace(/^sha256:/u, "")}`;
    const bytes = encoder.encode(`---\ntype: Source\ntitle: ${JSON.stringify(input.title)}\n---\n\n${input.text}\n`);
    const payloadHash = await objects.calculateSha256(bytes);
    const reservationId = capacityReservationId("commit", spaceId, receiptId);
    const amounts = { physicalCanonicalBytes: bytes.length, temporaryBytes: 0, d1MetadataBytes: 2_048 };
    const prior = await metadata.runContentCommitTransaction(async (tx) => {
      if ((await authorizer.reauthorizeInTransaction(query, tx, authorization.stamp)).kind !== "allowed" ||
          !(await tx.validatePrincipalMindUsageWritePin(writePin))) throw new Error("note_access_denied");
      const existing = await tx.readQueuedNote(receiptId);
      if (existing !== null && existing.payloadHash !== payloadHash) throw new Error("idempotency_conflict");
      if (existing === null && (await tx.listQueuedNotes()).filter((item) =>
        item.spaceId === spaceId && item.state !== "committed").length >= 32) throw new Error("note_queue_full");
      if (existing === null) {
        const createdAt = clock.now();
        const admission = await tx.admitCapacityReservation({ reservationId, requestedByPrincipalId: actor.principalId,
          spaceId, operation: "commit", operationRef: receiptId, baseRevisionId: null,
          idempotencyKey: input.idempotencyKey as never, requested: amounts, bulk: false, heavy: false,
          createdAt, expiresAt: capacityExpiry("commit", createdAt) }, DEFAULT_CAPACITY_LIMITS);
        if (admission.kind !== "admitted") throw new Error("note_capacity_rejected");
      }
      return existing;
    });
    if (prior !== null) {
      if (prior.state !== "committed") await this.dependencies.schedule(receiptId);
      return this.receipt(prior);
    }
    // Bytes are durable before the atomic receipt. A rejected request leaves only
    // an unreferenced object subject to the ordinary GC grace period.
    await objects.putSpaceCanonicalObject({ kind: "markdown", spaceId, bytes, mediaType: MARKDOWN_MEDIA_TYPE, createdAt: clock.now() });
    const note = await metadata.runContentCommitTransaction(async (tx) => {
      const current = await authorizer.reauthorizeInTransaction(query, tx, authorization.stamp);
      if (current.kind !== "allowed" || !(await tx.validatePrincipalMindUsageWritePin(writePin))) throw new Error("note_access_denied");
      const existing = await tx.readQueuedNote(receiptId);
      if (existing !== null) {
        if (existing.payloadHash !== payloadHash) throw new Error("idempotency_conflict");
        return existing;
      }
      const pending = (await tx.listQueuedNotes()).filter((item) => item.spaceId === spaceId && item.state !== "committed");
      if (pending.length >= 32) throw new Error("note_queue_full");
      const created: QueuedNote = {
        receiptId, spaceId, actor, writePin, payloadHash, size: bytes.length,
        path: `raw/inbox/${receiptId}.md`, state: "queued", attempts: 0, leaseUntil: 0,
        expectedRevisionId: await tx.readHead(spaceId), revisionId: null, failureCode: null,
      };
      await tx.putQueuedNote(created);
      const consumed = await tx.consumeCapacityReservation({ reservationId, actual: amounts, consumedAt: clock.now() });
      if (consumed !== "consumed" && consumed !== "already_consumed") throw new Error("note_capacity_rejected");
      return created;
    });
    if (note.state !== "committed") await this.dependencies.schedule(receiptId);
    return this.receipt(note);
  }

  async status(actor: McpTokenActorContext, spaceId: SpaceId, receiptId: unknown) {
    if (typeof receiptId !== "string") throw new Error("invalid_note_receipt");
    const authorization = await this.dependencies.authorizer.authorize({ actor, spaceId, capability: "content:fetch", revisionMode: "head" });
    if (authorization.kind !== "allowed") throw new Error("note_access_denied");
    const note = await this.dependencies.metadata.runContentCommitTransaction((tx) => tx.readQueuedNote(receiptId));
    if (note === null || note.spaceId !== spaceId || note.actor.principalId !== actor.principalId) throw new Error("note_not_found");
    return this.receipt(note);
  }

  async process(receiptId: string): Promise<void> {
    const { metadata, objects, clock, commits } = this.dependencies;
    const now = Date.parse(clock.now());
    const note = await metadata.runContentCommitTransaction(async (tx) => {
      const current = await tx.readQueuedNote(receiptId);
      if (current === null || current.state === "committed" || current.leaseUntil > now || current.attempts >= 5) return null;
      const claimed: QueuedNote = { ...current, state: "running", attempts: current.attempts + 1, leaseUntil: now + 120_000 };
      await tx.putQueuedNote(claimed);
      return claimed;
    });
    if (note === null) return;
    const finish = async (patch: Partial<QueuedNote>) => metadata.runContentCommitTransaction(async (tx) => {
      const current = await tx.readQueuedNote(receiptId);
      if (current?.attempts === note.attempts && current.state === "running") {
        await tx.putQueuedNote({ ...current, ...patch, leaseUntil: 0 });
      }
    });
    try {
      if (!(await metadata.validatePrincipalMindUsageWritePin(note.writePin))) throw new Error("writable_mind_stale");
      const currentActor = { ...note.actor, occurredAtUtc: clock.now() };
      if ((await this.dependencies.authorizer.authorize({ actor: currentActor, spaceId: note.spaceId,
        capability: "content:write", revisionMode: "head" })).kind !== "allowed") throw new Error("denied");
      const payload = await objects.getSpaceCanonicalObject("markdown", note.spaceId, note.payloadHash);
      if (payload === null || payload.size !== note.size || await objects.calculateSha256(payload.bytes) !== note.payloadHash) throw new Error("note_payload_unavailable");
      let expectedRevisionId = note.expectedRevisionId;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const request = {
          actor: { ...note.actor, occurredAtUtc: clock.now() }, spaceId: note.spaceId,
          requiredWritePin: note.writePin, expectedRevisionId,
          idempotencyKey: `${note.receiptId}:${expectedRevisionId ?? "empty"}`,
          summary: "Save incoming note", producerProfile: true,
          operations: [{ type: "create_file", path: note.path, text: new TextDecoder("utf-8", { fatal: true }).decode(payload.bytes) }],
        };
        const reconciled = await commits.reconcile(request);
        const result = reconciled.kind === "missing" ? await commits.commit(request) : reconciled;
        if (result.kind === "committed") {
          await finish({ state: "committed", revisionId: result.envelope.revision.revisionId, failureCode: null });
          return;
        }
        if (result.kind !== "revision_conflict") throw new Error(result.kind);
        expectedRevisionId = await metadata.runContentCommitTransaction(async (tx) => {
          const head = await tx.readHead(note.spaceId);
          const current = await tx.readQueuedNote(receiptId);
          if (current?.attempts !== note.attempts) throw new Error("note_claim_lost");
          await tx.putQueuedNote({ ...current, expectedRevisionId: head });
          return head;
        });
      }
      throw new Error("revision_conflict");
    } catch (error) {
      const safeCodes = new Set(["writable_mind_stale", "note_payload_unavailable", "revision_conflict", "denied", "invalid", "idempotency_conflict"]);
      const code = error instanceof Error && safeCodes.has(error.message) ? error.message : "note_processing_failed";
      await finish({ state: "failed", failureCode: code });
      if ((code === "note_processing_failed" || code === "revision_conflict") && note.attempts < 3) {
        await this.process(receiptId);
      }
    }
  }

  async recover(limit = 4): Promise<void> {
    const pending = await this.dependencies.metadata.runContentCommitTransaction(async (tx) =>
      (await tx.listQueuedNotes()).filter((note) => note.state !== "committed" && note.attempts < 3 &&
        note.leaseUntil <= Date.parse(this.dependencies.clock.now())).slice(0, limit));
    for (const note of pending) await this.process(note.receiptId);
  }
}
