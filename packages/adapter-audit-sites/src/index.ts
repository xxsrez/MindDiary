import type {
  AuditEvent,
  AuditSink,
} from "@mind-diary/application-ports";

export const SITES_AUDIT_ADAPTER = "sites-d1-privacy-safe-audit" as const;

export interface D1ResultLike<Row = Record<string, unknown>> {
  readonly results?: readonly Row[];
  readonly meta?: { readonly changes?: number };
}

export interface D1PreparedStatementLike {
  bind(...values: readonly unknown[]): D1PreparedStatementLike;
  run<Row = Record<string, unknown>>(): Promise<D1ResultLike<Row>>;
  all<Row = Record<string, unknown>>(): Promise<D1ResultLike<Row>>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch(statements: readonly D1PreparedStatementLike[]): Promise<readonly D1ResultLike[]>;
}

export const SITES_AUDIT_MIGRATIONS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS md_audit_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS md_delivered_audit_events (
    audit_event_id TEXT PRIMARY KEY,
    space_id TEXT,
    actor_kind TEXT NOT NULL,
    principal_id TEXT,
    event_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS md_audit_space_idx
   ON md_delivered_audit_events(space_id)`,
  `CREATE INDEX IF NOT EXISTS md_audit_principal_idx
   ON md_delivered_audit_events(principal_id)`,
]);

interface AuditRow {
  readonly audit_event_id: string;
  readonly event_json: string;
}

function cloneEvent(event: Readonly<AuditEvent>): Readonly<AuditEvent> {
  return Object.freeze({
    ...event,
    actor: Object.freeze({ ...event.actor }),
    safeMetadata: Object.freeze({ ...event.safeMetadata }),
  });
}

function parseEvent(row: AuditRow): Readonly<AuditEvent> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.event_json);
  } catch {
    throw new Error("Sites audit event is corrupt");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("auditEventId" in parsed) ||
    (parsed as { auditEventId: unknown }).auditEventId !== row.audit_event_id
  ) {
    throw new Error("Sites audit event is corrupt");
  }
  return cloneEvent(parsed as AuditEvent);
}

/** D1 idempotent audit delivery; only the closed AuditEvent projection is stored. */
export class SitesAuditSink implements AuditSink {
  readonly kind = "audit-sink" as const;
  readonly #database: D1DatabaseLike;
  #initialized = false;

  constructor(database: D1DatabaseLike) {
    this.#database = database;
  }

  async ready(): Promise<this> {
    if (!this.#initialized) {
      const statements = SITES_AUDIT_MIGRATIONS.map((sql) => this.#database.prepare(sql));
      statements.push(
        this.#database
          .prepare(
            `/*md-audit-migration*/ INSERT OR IGNORE INTO md_audit_schema_migrations
             (version, name, applied_at) VALUES (1, 'privacy-safe-audit-v1', ?1)`,
          )
          .bind(new Date().toISOString()),
      );
      await this.#database.batch(statements);
      this.#initialized = true;
    }
    return this;
  }

  async deliver(event: Readonly<AuditEvent>): Promise<"delivered" | "duplicate"> {
    await this.ready();
    const safe = cloneEvent(event);
    const principalId = safe.actor.kind === "principal" ? safe.actor.principalId : null;
    const result = await this.#database
      .prepare(
        `/*md-audit-deliver*/ INSERT OR IGNORE INTO md_delivered_audit_events
         (audit_event_id, space_id, actor_kind, principal_id, event_json)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(
        safe.auditEventId,
        safe.spaceId,
        safe.actor.kind,
        principalId,
        JSON.stringify(safe),
      )
      .run();
    return Number(result.meta?.changes ?? 0) === 1 ? "delivered" : "duplicate";
  }

  async purgeSpace(spaceId: NonNullable<AuditEvent["spaceId"]>): Promise<number> {
    await this.ready();
    const result = await this.#database
      .prepare(`/*md-audit-purge*/ DELETE FROM md_delivered_audit_events WHERE space_id = ?1`)
      .bind(spaceId)
      .run();
    return Number(result.meta?.changes ?? 0);
  }

  async tombstonePrincipal(
    principalId: Extract<AuditEvent["actor"], { kind: "principal" }>["principalId"],
    deletedPrincipalId: Extract<
      AuditEvent["actor"],
      { kind: "deleted-principal" }
    >["opaqueId"],
  ): Promise<number> {
    await this.ready();
    const result = await this.#database
      .prepare(
        `/*md-audit-by-principal*/ SELECT audit_event_id, event_json
         FROM md_delivered_audit_events WHERE principal_id = ?1
         ORDER BY audit_event_id ASC`,
      )
      .bind(principalId)
      .all<AuditRow>();
    const statements = (result.results ?? []).map((row) => {
      const event = parseEvent(row);
      const tombstoned = cloneEvent({
        ...event,
        actor: Object.freeze({
          kind: "deleted-principal" as const,
          opaqueId: deletedPrincipalId,
        }),
      });
      return this.#database
        .prepare(
          `/*md-audit-tombstone*/ UPDATE md_delivered_audit_events
           SET actor_kind = 'deleted-principal', principal_id = NULL, event_json = ?1
           WHERE audit_event_id = ?2 AND principal_id = ?3`,
        )
        .bind(JSON.stringify(tombstoned), row.audit_event_id, principalId);
    });
    if (statements.length === 0) return 0;
    const updates = await this.#database.batch(statements);
    return updates.reduce((total, update) => total + Number(update.meta?.changes ?? 0), 0);
  }
}

export async function createSitesAuditSink(database: D1DatabaseLike): Promise<SitesAuditSink> {
  return new SitesAuditSink(database).ready();
}
