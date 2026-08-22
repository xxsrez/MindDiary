import {
  InMemoryMcpTokenStore,
  InMemoryRevisionMetadataStore,
} from "@mind-diary/adapter-metadata-memory";
import type {
  AuthorizationStateQuery,
  CurrentAuthorizationState,
  MindRouteAuthorizationQuery,
} from "@mind-diary/application-ports";

export const SITES_METADATA_ADAPTER = "sites-d1-fenced-event-log" as const;

export interface D1ResultLike<Row = Record<string, unknown>> {
  readonly success?: boolean;
  readonly results?: readonly Row[];
  readonly meta?: { readonly changes?: number };
}

export interface D1PreparedStatementLike {
  bind(...values: readonly unknown[]): D1PreparedStatementLike;
  run<Row = Record<string, unknown>>(): Promise<D1ResultLike<Row>>;
  all<Row = Record<string, unknown>>(): Promise<D1ResultLike<Row>>;
  first?<Row = Record<string, unknown>>(): Promise<Row | null>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch(
    statements: readonly D1PreparedStatementLike[],
  ): Promise<readonly D1ResultLike[]>;
}

export const SITES_METADATA_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: "fenced-metadata-event-log",
    statements: Object.freeze([
      `CREATE TABLE IF NOT EXISTS md_metadata_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS md_metadata_events (
        sequence INTEGER PRIMARY KEY,
        target TEXT NOT NULL CHECK (target IN ('metadata', 'tokens')),
        operation TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        committed_at TEXT NOT NULL
      )`,
    ]),
  }),
  Object.freeze({
    version: 2,
    name: "materialized-snapshot-tail",
    statements: Object.freeze([
      `CREATE TABLE IF NOT EXISTS md_metadata_snapshots (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        sequence INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ]),
  }),
]);

type DurableTarget = "metadata" | "tokens";

interface DurableCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

type DurableEvent =
  | {
      readonly v: 1;
      readonly kind: "direct";
      readonly target: DurableTarget;
      readonly method: string;
      readonly args: readonly unknown[];
    }
  | {
      readonly v: 1;
      readonly kind: "transaction";
      readonly target: "metadata";
      readonly method: string;
      readonly calls: readonly DurableCall[];
    };

interface DurableEventRow {
  readonly sequence: number;
  readonly target: DurableTarget;
  readonly operation: string;
  readonly payload_json: string;
}

interface DurableSnapshotRow {
  readonly sequence: number;
  readonly payload_json: string;
}

interface DurableSnapshot {
  readonly v: 1;
  readonly metadata: unknown;
  readonly tokens: unknown;
}

const TRANSACTION_METHODS = new Set([
  "runAccountBootstrapTransaction",
  "runPersonalMindTransaction",
  "runOrdinaryMindTransaction",
  "runMembershipControlTransaction",
  "runAccountDeletionTransaction",
  "runContentCommitTransaction",
  "runMarkdownImportTransaction",
  "runExportStartTransaction",
  "runExportDownloadGrantTransaction",
  "runBundleFileDownloadGrantTransaction",
  "runMindBindingTransaction",
  "runBundleFileStagingTransaction",
  "runCapacityTransaction",
]);

const METADATA_MUTATIONS = new Set([
  "recordPrincipalActivity",
  "stageServiceOperatorDirectoryAudit",
  "reserveHandle",
  "retireHandle",
  "commitRevision",
  "claimInvitationExpiryJob",
  "completeInvitationExpiryJob",
  "failInvitationExpiryJob",
  "claimIndexJob",
  "ensureRevisionIndexQueued",
  "completeIndexJob",
  "failIndexJob",
  "claimAuditOutbox",
  "completeAuditOutbox",
  "failAuditOutbox",
  "revokeExportDownloadGrant",
  "claimExportJob",
  "completeExportJob",
  "failExportJob",
  "expireExportJob",
  "completeExpiredExportCleanup",
  "purgeSpaceTargetRecords",
  "corruptPublicMindCatalogForTest",
  "bumpPersonalMindMetadataVersionForTest",
  "bumpOrdinaryMindMetadataVersionForTest",
  "disablePrincipalForTest",
  "grantOrdinaryMembershipForTest",
  "revokeOrdinaryMembershipForTest",
  "transferOrdinaryOwnershipForTest",
  "changeOrdinaryVisibilityForTest",
  "corruptOrdinaryHandleForTest",
  "markOrdinaryMindDeletingForTest",
  "setCurrentAuthorizationStateForTest",
  "revokeMindBindingOwner",
  "collectStagedBundleFilesForGc",
  "deleteExpiredStagedBundleFileRecord",
  "reconcileCapacityUsage",
  "collectExpiredCapacityReservations",
  "releaseCapacityReservation",
  "claimObjectCleanup",
  "completeObjectCleanupBatch",
  "failObjectCleanupBatch",
]);

const TOKEN_MUTATIONS = new Set([
  "createMcpToken",
  "revokeMcpToken",
  "revokePrincipalTokensForAccountDeletion",
  "beginPrincipalTokenDeletion",
  "completePrincipalTokenDeletion",
  "cancelPrincipalTokenDeletion",
]);

const MAX_CAS_ATTEMPTS = 16;

function encode(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === undefined) return { __md_sites_type: "undefined" };
    if (item instanceof Uint8Array) {
      return { __md_sites_type: "uint8array", bytes: [...item] };
    }
    if (item instanceof Map) {
      return { __md_sites_type: "map", entries: [...item.entries()] };
    }
    if (item instanceof Set) {
      return { __md_sites_type: "set", values: [...item.values()] };
    }
    return item;
  });
}

function decode<Value>(value: string): Value {
  return JSON.parse(value, (_key, item: unknown) => {
    if (
      typeof item === "object" &&
      item !== null &&
      "__md_sites_type" in item
    ) {
      const tagged = item as {
        readonly __md_sites_type: unknown;
        readonly bytes?: unknown;
        readonly entries?: unknown;
        readonly values?: unknown;
      };
      if (tagged.__md_sites_type === "undefined") return undefined;
      if (
        tagged.__md_sites_type === "uint8array" &&
        Array.isArray(tagged.bytes)
      ) {
        return Uint8Array.from(tagged.bytes as number[]);
      }
      if (tagged.__md_sites_type === "map" && Array.isArray(tagged.entries)) {
        return new Map(tagged.entries as readonly (readonly [unknown, unknown])[]);
      }
      if (tagged.__md_sites_type === "set" && Array.isArray(tagged.values)) {
        return new Set(tagged.values);
      }
    }
    return item;
  }) as Value;
}

function changes(result: D1ResultLike): number {
  return Number(result.meta?.changes ?? 0);
}

function methodOf(target: object, property: string): (...args: unknown[]) => unknown {
  const candidate = Reflect.get(target, property) as unknown;
  if (typeof candidate !== "function") {
    throw new TypeError(`Sites metadata method ${property} is unavailable`);
  }
  return candidate.bind(target) as (...args: unknown[]) => unknown;
}

interface LoadedState {
  readonly metadata: InMemoryRevisionMetadataStore;
  readonly tokens: InMemoryMcpTokenStore;
  readonly sequence: number;
}

async function currentAuthorizationStateWithToken(
  metadata: Pick<InMemoryRevisionMetadataStore, "readCurrentAuthorizationState">,
  tokens: Pick<InMemoryMcpTokenStore, "readMcpTokenForAuthorization">,
  query: AuthorizationStateQuery,
): Promise<Readonly<CurrentAuthorizationState> | null> {
  const metadataState = await metadata.readCurrentAuthorizationState({
    principalId: query.principalId,
    spaceId: query.spaceId,
    tokenId: null,
  });
  if (metadataState === null || query.tokenId === null) return metadataState;
  const token = await tokens.readMcpTokenForAuthorization(query.tokenId);
  return Object.freeze({ ...metadataState, token });
}

async function currentRouteAuthorizationStateWithToken(
  metadata: Pick<InMemoryRevisionMetadataStore, "readCurrentRouteAuthorizationState">,
  tokens: Pick<InMemoryMcpTokenStore, "readMcpTokenForAuthorization">,
  query: MindRouteAuthorizationQuery,
): Promise<Readonly<CurrentAuthorizationState> | null> {
  const metadataState = await metadata.readCurrentRouteAuthorizationState({
    principalId: query.principalId,
    spaceId: query.spaceId,
    tokenId: null,
    host: query.host,
    handle: query.handle,
  });
  if (metadataState === null || query.tokenId === null) return metadataState;
  const token = await tokens.readMcpTokenForAuthorization(query.tokenId);
  return Object.freeze({ ...metadataState, token });
}

/**
 * D1-backed adapter that reuses the already contract-tested deterministic
 * transition engine while making every committed transition durable. Each
 * operation is recomputed from the latest ordered log and appended with an
 * expected-sequence CAS, so separate isolates cannot both win a stale view.
 */
export class SitesMetadataStore {
  readonly kind = "metadata-store" as const;
  readonly #database: D1DatabaseLike;
  #metadata = new InMemoryRevisionMetadataStore();
  #tokens = new InMemoryMcpTokenStore();
  #sequence = 0;
  #initialized = false;
  #loaded = false;
  #tail: Promise<void> = Promise.resolve();
  #proxy: this;

  constructor(database: D1DatabaseLike) {
    this.#database = database;
    const proxy = new Proxy(this, {
      get: (target, property, receiver) => {
        if (typeof property !== "string") return Reflect.get(target, property, receiver);
        if (Reflect.has(target, property)) {
          const own = Reflect.get(target, property, target) as unknown;
          return typeof own === "function" ? own.bind(target) : own;
        }
        const selected = target.#select(property);
        if (!selected) return undefined;
        if (TRANSACTION_METHODS.has(property)) {
          return (operation: (transaction: unknown) => Promise<unknown>) =>
            target.#exclusive(() => target.#runTransaction(property, operation));
        }
        const mutations = selected.target === "metadata" ? METADATA_MUTATIONS : TOKEN_MUTATIONS;
        if (mutations.has(property)) {
          return (...args: unknown[]) =>
            target.#exclusive(() =>
              target.#runDirect(selected.target, property, args),
            );
        }
        return (...args: unknown[]) =>
          target.#exclusive(async () => {
            await target.#refresh();
            const current = selected.target === "metadata" ? target.#metadata : target.#tokens;
            return methodOf(current, property)(...args);
          });
      },
    });
    this.#proxy = proxy;
    return proxy;
  }

  async ready(): Promise<this> {
    await this.#exclusive(async () => {
      await this.#migrate();
      await this.#refresh();
    });
    return this.#proxy;
  }

  async readCurrentAuthorizationState(
    query: AuthorizationStateQuery,
  ): Promise<Readonly<CurrentAuthorizationState> | null> {
    return this.#exclusive(async () => {
      await this.#refresh();
      return currentAuthorizationStateWithToken(this.#metadata, this.#tokens, query);
    });
  }

  async readCurrentRouteAuthorizationState(
    query: MindRouteAuthorizationQuery,
  ): Promise<Readonly<CurrentAuthorizationState> | null> {
    return this.#exclusive(async () => {
      await this.#refresh();
      return currentRouteAuthorizationStateWithToken(
        this.#metadata,
        this.#tokens,
        query,
      );
    });
  }

  /** One refreshed in-isolate view for a closed read workflow such as list_minds. */
  async withConsistentRead<Result>(
    operation: (store: this) => Promise<Result>,
  ): Promise<Result> {
    if (typeof operation !== "function") {
      throw new TypeError("Sites metadata read-session callback is required");
    }
    return this.#exclusive(async () => {
      await this.#refresh();
      const view = new Proxy(Object.create(null) as this, {
        get: (_target, property) => {
          if (property === "readCurrentAuthorizationState") {
            return (query: AuthorizationStateQuery) =>
              currentAuthorizationStateWithToken(this.#metadata, this.#tokens, query);
          }
          if (property === "readCurrentRouteAuthorizationState") {
            return (query: MindRouteAuthorizationQuery) =>
              currentRouteAuthorizationStateWithToken(
                this.#metadata,
                this.#tokens,
                query,
              );
          }
          if (typeof property !== "string") return undefined;
          const selected = this.#select(property);
          if (selected === null) return undefined;
          const mutations = selected.target === "metadata"
            ? METADATA_MUTATIONS
            : TOKEN_MUTATIONS;
          if (TRANSACTION_METHODS.has(property) || mutations.has(property)) {
            return () => {
              throw new TypeError("Sites metadata consistent read-session is read-only");
            };
          }
          const current =
            selected.target === "metadata" ? this.#metadata : this.#tokens;
          return methodOf(current, property);
        },
      });
      return operation(view);
    });
  }

  async #migrate(): Promise<void> {
    if (this.#initialized) return;
    for (const migration of SITES_METADATA_MIGRATIONS) {
      const statements = migration.statements.map((sql) => this.#database.prepare(sql));
      statements.push(
        this.#database
          .prepare(
            `/*md-metadata-migration*/ INSERT OR IGNORE INTO md_metadata_schema_migrations
             (version, name, applied_at) VALUES (?1, ?2, ?3)`,
          )
          .bind(migration.version, migration.name, new Date().toISOString()),
      );
      await this.#database.batch(statements);
    }
    this.#initialized = true;
  }

  #select(property: string): { readonly target: DurableTarget } | null {
    if (property in this.#metadata) return { target: "metadata" };
    if (property in this.#tokens) return { target: "tokens" };
    return null;
  }

  async #refresh(): Promise<void> {
    await this.#migrate();
    if (!this.#loaded) {
      const loaded = await this.#load();
      this.#metadata = loaded.metadata;
      this.#tokens = loaded.tokens;
      this.#sequence = loaded.sequence;
      this.#loaded = true;
      return;
    }
    this.#sequence = await this.#replayTail(
      this.#metadata,
      this.#tokens,
      this.#sequence,
    );
  }

  async #load(): Promise<LoadedState> {
    const snapshots = await this.#database
      .prepare(
        `/*md-metadata-snapshot-read*/ SELECT sequence, payload_json
         FROM md_metadata_snapshots WHERE singleton_id = 1`,
      )
      .all<DurableSnapshotRow>();
    const snapshotRow = snapshots.results?.[0];
    if (snapshotRow !== undefined) {
      if (!Number.isSafeInteger(snapshotRow.sequence) || snapshotRow.sequence < 0) {
        throw new Error("Sites metadata snapshot sequence is invalid");
      }
      const snapshot = decode<DurableSnapshot>(snapshotRow.payload_json);
      if (snapshot.v !== 1) throw new Error("Sites metadata snapshot is invalid");
      const metadata = InMemoryRevisionMetadataStore.fromDurableSnapshot(
        snapshot.metadata,
      );
      const tokens = InMemoryMcpTokenStore.fromDurableSnapshot(snapshot.tokens);
      const sequence = await this.#replayTail(
        metadata,
        tokens,
        snapshotRow.sequence,
      );
      if (sequence > snapshotRow.sequence) {
        await this.#persistSnapshot(sequence, metadata, tokens);
      }
      return { metadata, tokens, sequence };
    }

    const result = await this.#database
      .prepare(
        `/*md-metadata-events-migration*/ SELECT sequence, target, operation, payload_json
         FROM md_metadata_events ORDER BY sequence ASC`,
      )
      .all<DurableEventRow>();
    const rows = [...(result.results ?? [])];
    const metadata = new InMemoryRevisionMetadataStore();
    const tokens = new InMemoryMcpTokenStore();
    let expected = 0;
    for (const row of rows) {
      if (!Number.isSafeInteger(row.sequence) || row.sequence !== expected + 1) {
        throw new Error("Sites metadata event sequence is not contiguous");
      }
      const event = decode<DurableEvent>(row.payload_json);
      if (
        event.v !== 1 ||
        event.target !== row.target ||
        event.method !== row.operation
      ) {
        throw new Error("Sites metadata event envelope is invalid");
      }
      await this.#replay(metadata, tokens, event);
      expected = row.sequence;
    }
    await this.#persistSnapshot(expected, metadata, tokens);
    return { metadata, tokens, sequence: expected };
  }

  async #replayTail(
    metadata: InMemoryRevisionMetadataStore,
    tokens: InMemoryMcpTokenStore,
    afterSequence: number,
  ): Promise<number> {
    const result = await this.#database
      .prepare(
        `/*md-metadata-events-tail*/ SELECT sequence, target, operation, payload_json
         FROM md_metadata_events WHERE sequence > ?1 ORDER BY sequence ASC`,
      )
      .bind(afterSequence)
      .all<DurableEventRow>();
    let expected = afterSequence;
    for (const row of result.results ?? []) {
      if (!Number.isSafeInteger(row.sequence) || row.sequence !== expected + 1) {
        throw new Error("Sites metadata event sequence is not contiguous");
      }
      const event = decode<DurableEvent>(row.payload_json);
      if (
        event.v !== 1 ||
        event.target !== row.target ||
        event.method !== row.operation
      ) {
        throw new Error("Sites metadata event envelope is invalid");
      }
      await this.#replay(metadata, tokens, event);
      expected = row.sequence;
    }
    return expected;
  }

  async #replay(
    metadata: InMemoryRevisionMetadataStore,
    tokens: InMemoryMcpTokenStore,
    event: DurableEvent,
  ): Promise<void> {
    if (event.kind === "direct") {
      const target = event.target === "metadata" ? metadata : tokens;
      await methodOf(target, event.method)(...event.args);
      return;
    }
    await methodOf(metadata, event.method)(async (transaction: object) => {
      let result: unknown;
      for (const call of event.calls) {
        result = await methodOf(transaction, call.method)(...call.args);
      }
      return result;
    });
  }

  async #runDirect(
    targetName: DurableTarget,
    method: string,
    args: readonly unknown[],
  ): Promise<unknown> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const loaded = await this.#load();
      const target = targetName === "metadata" ? loaded.metadata : loaded.tokens;
      const result = await methodOf(target, method)(...args);
      const event: DurableEvent = { v: 1, kind: "direct", target: targetName, method, args };
      if (await this.#append(loaded.sequence, event, loaded.metadata, loaded.tokens)) {
        this.#metadata = loaded.metadata;
        this.#tokens = loaded.tokens;
        this.#sequence = loaded.sequence + 1;
        this.#loaded = true;
        return result;
      }
    }
    throw new Error("Sites metadata CAS retry budget exhausted");
  }

  async #runTransaction(
    method: string,
    operation: (transaction: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    if (typeof operation !== "function") {
      throw new TypeError("Sites metadata transaction callback is required");
    }
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const loaded = await this.#load();
      const calls: DurableCall[] = [];
      const result = await methodOf(loaded.metadata, method)(
        async (transaction: object) =>
          operation(this.#captureTransaction(transaction, loaded.tokens, calls)),
      );
      const event: DurableEvent = {
        v: 1,
        kind: "transaction",
        target: "metadata",
        method,
        calls,
      };
      if (await this.#append(loaded.sequence, event, loaded.metadata, loaded.tokens)) {
        this.#metadata = loaded.metadata;
        this.#tokens = loaded.tokens;
        this.#sequence = loaded.sequence + 1;
        this.#loaded = true;
        return result;
      }
    }
    throw new Error("Sites metadata transaction CAS retry budget exhausted");
  }

  #captureTransaction(
    transaction: object,
    tokens: InMemoryMcpTokenStore,
    calls: DurableCall[],
  ): Readonly<Record<string, unknown>> {
    const wrapper: Record<string, unknown> = {};
    for (const property of Object.keys(transaction)) {
      const value = Reflect.get(transaction, property) as unknown;
      if (typeof value !== "function") {
        wrapper[property] = value;
        continue;
      }
      wrapper[property] = async (...args: unknown[]) => {
        let callResult: unknown;
        if (property === "readCurrentAuthorizationState") {
          const query = args[0] as AuthorizationStateQuery;
          callResult = await currentAuthorizationStateWithToken(
            transaction as Pick<
              InMemoryRevisionMetadataStore,
              "readCurrentAuthorizationState"
            >,
            tokens,
            query,
          );
        } else {
          callResult = await methodOf(transaction, property)(...args);
        }
        calls.push({ method: property, args });
        return callResult;
      };
    }
    return Object.freeze(wrapper);
  }

  async #append(
    expectedSequence: number,
    event: DurableEvent,
    metadata: InMemoryRevisionMetadataStore,
    tokens: InMemoryMcpTokenStore,
  ): Promise<boolean> {
    const sequence = expectedSequence + 1;
    const result = await this.#database
      .prepare(
        `/*md-metadata-append*/ INSERT INTO md_metadata_events
         (sequence, target, operation, payload_json, committed_at)
         SELECT ?1, ?2, ?3, ?4, ?5
         WHERE COALESCE((SELECT MAX(sequence) FROM md_metadata_events), 0) = ?6`,
      )
      .bind(
        sequence,
        event.target,
        event.method,
        encode(event),
        new Date().toISOString(),
        expectedSequence,
      )
      .run();
    if (changes(result) !== 1) return false;
    try {
      await this.#persistSnapshot(sequence, metadata, tokens);
    } catch {
      // The fenced event append above is the canonical commit. A stale or
      // absent materialized snapshot is repaired by contiguous tail replay on
      // the next read/restart; surfacing failure here would report an
      // ambiguous mutation result and invite an unnecessary retry.
    }
    return true;
  }

  async #persistSnapshot(
    sequence: number,
    metadata: InMemoryRevisionMetadataStore,
    tokens: InMemoryMcpTokenStore,
  ): Promise<void> {
    const payload: DurableSnapshot = Object.freeze({
      v: 1,
      metadata: metadata.exportDurableSnapshot(),
      tokens: tokens.exportDurableSnapshot(),
    });
    await this.#database
      .prepare(
        `/*md-metadata-snapshot-write*/ INSERT INTO md_metadata_snapshots
         (singleton_id, sequence, payload_json, updated_at)
         VALUES (1, ?1, ?2, ?3)
         ON CONFLICT(singleton_id) DO UPDATE SET
           sequence = excluded.sequence,
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at
         WHERE md_metadata_snapshots.sequence < excluded.sequence`,
      )
      .bind(sequence, encode(payload), new Date().toISOString())
      .run();
  }

  async #exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    const previous = this.#tail;
    let release: () => void = () => undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

// Runtime methods are supplied by the guarded proxy; declaration merging keeps
// the complete application-port surface visible to TypeScript consumers.
export interface SitesMetadataStore
  extends InMemoryRevisionMetadataStore,
    InMemoryMcpTokenStore {}

export async function createSitesMetadataStore(
  database: D1DatabaseLike,
): Promise<SitesMetadataStore> {
  return new SitesMetadataStore(database).ready();
}
