import {
  InMemoryMcpTokenStore,
  InMemoryRevisionMetadataStore,
} from "@mind-diary/adapter-metadata-memory";
import type {
  AuthorizationStateQuery,
  CurrentAuthorizationState,
  MindRouteAuthorizationQuery,
  PrincipalActivityKind,
  PrincipalActivitySummary,
  PrincipalActivitySurface,
  PrincipalId,
  RecordPrincipalActivityRequest,
  ServiceOperatorDirectoryPage,
  ServiceOperatorDirectoryQuery,
  UtcInstant,
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
  Object.freeze({
    version: 3,
    name: "chunked-materialized-snapshot",
    statements: Object.freeze([
      `CREATE TABLE IF NOT EXISTS md_metadata_snapshot_heads (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        sequence INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        payload_chars INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS md_metadata_snapshot_chunks (
        sequence INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (sequence, chunk_index)
      )`,
    ]),
  }),
  Object.freeze({
    version: 4,
    name: "principal-activity-projection",
    statements: Object.freeze([
      `CREATE TABLE IF NOT EXISTS md_principal_activity (
        principal_id TEXT PRIMARY KEY,
        last_web_seen_at TEXT,
        last_mcp_seen_at TEXT,
        last_activity_at TEXT NOT NULL,
        last_activity_surface TEXT NOT NULL CHECK (last_activity_surface IN ('web', 'mcp')),
        last_activity_kind TEXT NOT NULL CHECK (
          last_activity_kind IN (
            'page', 'control_read', 'control_write',
            'discovery', 'content_read', 'content_write'
          )
        )
      )`,
    ]),
  }),
  Object.freeze({
    version: 5,
    name: "system-backup-control",
    statements: Object.freeze([
      `CREATE TABLE IF NOT EXISTS md_backup_control (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        origin_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        backup_sequence INTEGER NOT NULL CHECK (backup_sequence >= 0),
        invalidation_epoch INTEGER NOT NULL CHECK (invalidation_epoch >= 0)
      )`,
      `INSERT OR IGNORE INTO md_backup_control
       (singleton_id, origin_id, generation, backup_sequence, invalidation_epoch)
       VALUES (1, lower(hex(randomblob(16))), 1,
         COALESCE((SELECT MAX(sequence) FROM md_metadata_events), 0), 0)`,
      `CREATE TABLE IF NOT EXISTS md_backup_sessions (
        session_id TEXT PRIMARY KEY,
        origin_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        base_sequence INTEGER,
        base_digest TEXT,
        base_session_id TEXT,
        base_captured_at TEXT,
        base_schema_digest TEXT,
        mode TEXT NOT NULL CHECK (mode IN ('baseline', 'incremental', 'rebaseline')),
        target_sequence INTEGER NOT NULL,
        target_digest TEXT NOT NULL,
        invalidation_epoch INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN
          ('building', 'ready', 'invalidated', 'completed', 'released')),
        created_at TEXT NOT NULL,
        completed_at TEXT,
        expires_at TEXT NOT NULL,
        page_count INTEGER NOT NULL,
        record_count INTEGER NOT NULL,
        object_count INTEGER NOT NULL,
        manifest_digest TEXT NOT NULL,
        schema_digest TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS md_backup_pages (
        session_id TEXT NOT NULL,
        page_index INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        PRIMARY KEY (session_id, page_index)
      )`,
      `CREATE TABLE IF NOT EXISTS md_backup_record_digests (
        session_id TEXT NOT NULL,
        record_key TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        PRIMARY KEY (session_id, record_key)
      )`,
      `CREATE TABLE IF NOT EXISTS md_backup_inventory (
        session_id TEXT NOT NULL,
        object_index INTEGER NOT NULL,
        namespace TEXT NOT NULL,
        object_key TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        PRIMARY KEY (session_id, object_index)
      )`,
      `CREATE TABLE IF NOT EXISTS md_backup_cleanup_ops (
        operation_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL
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
  readonly backup_sequence?: number;
}

interface DurableColdLoadRow {
  readonly row_kind: number;
  readonly sequence: number;
  readonly chunk_count: number | null;
  readonly payload_chars: number | null;
  readonly chunk_index: number | null;
  readonly target: DurableTarget | null;
  readonly operation: string | null;
  readonly payload_json: string;
  readonly schema_version: number;
}

interface DurableSnapshot {
  readonly v: 1;
  readonly metadata: unknown;
  readonly tokens: unknown;
}

interface PrincipalActivityRow {
  readonly principal_id: string;
  readonly last_web_seen_at: string | null;
  readonly last_mcp_seen_at: string | null;
  readonly last_activity_at: string;
  readonly last_activity_surface: string;
  readonly last_activity_kind: string;
}

function accountDeletionPrincipalId(
  event: DurableEvent,
  result: unknown,
): PrincipalId | null {
  if (
    event.kind !== "transaction" ||
    event.method !== "runAccountDeletionTransaction" ||
    typeof result !== "object" ||
    result === null ||
    !("kind" in result) ||
    (result.kind !== "deleted" && result.kind !== "cleanup_pending")
  ) return null;
  const deletion = event.calls.find((call) => call.method === "deleteAccountCascade");
  const request = deletion?.args[0];
  if (
    typeof request !== "object" ||
    request === null ||
    !("principalId" in request) ||
    typeof request.principalId !== "string"
  ) return null;
  return request.principalId as PrincipalId;
}

function invalidatesSystemBackup(event: DurableEvent, result: unknown): boolean {
  if (event.kind !== "transaction" ||
    typeof result !== "object" || result === null ||
    !("kind" in result) ||
    (result.kind !== "deleted" && result.kind !== "cleanup_pending")) return false;
  return event.calls.some((call) =>
    call.method === "deleteOrdinaryMind" ||
    call.method === "deleteAccountCascade");
}

function isExactDurableEvent(
  row: DurableEventRow,
  sequence: number,
  event: DurableEvent,
  payloadJson: string,
): boolean {
  return row.sequence === sequence &&
    (row.backup_sequence ?? -1) >= sequence &&
    row.target === event.target &&
    row.operation === event.method &&
    row.payload_json === payloadJson;
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
  "runCredentialWriteTargetTransaction",
  "runPrincipalMindUsageTransaction",
  "runBundleFileStagingTransaction",
  "runCapacityTransaction",
]);

const METADATA_MUTATIONS = new Set([
  "stageServiceOperatorDirectoryAudit",
  "reserveHandle",
  "retireHandle",
  "commitRevision",
  "claimInvitationExpiryJob",
  "completeInvitationExpiryJob",
  "failInvitationExpiryJob",
  "claimIndexJob",
  "ensureRevisionIndexQueued",
  "listActiveRevisionIndexRecoveryCandidates",
  "repairRevisionIndexQueued",
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
  "corruptRevisionIndexMetadataForTest",
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
  "revokeCredentialWriteTargetOwner",
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
  "revokeMcpTokens",
  "revokePrincipalTokensForAccountDeletion",
  "beginPrincipalTokenDeletion",
  "completePrincipalTokenDeletion",
  "cancelPrincipalTokenDeletion",
  "assignPersonalTokenRefs",
]);

const MAX_CAS_ATTEMPTS = 16;
const SNAPSHOT_CHUNK_CODE_UNITS = 256 * 1_024;
const SITES_METADATA_SCHEMA_VERSION = SITES_METADATA_MIGRATIONS.at(-1)?.version ?? 0;
export const SITES_METADATA_D1_TIMEOUT_MS = 2_500;
const TOKEN_SNAPSHOT_CADENCE = 16;
const MIND_BINDING_SNAPSHOT_CADENCE = 16;
const CONTENT_SNAPSHOT_CADENCE = 16;
const OBJECT_CLEANUP_SNAPSHOT_CADENCE = 16;
const REQUEST_RECOVERY_SNAPSHOT_CADENCE = 16;
const OBJECT_CLEANUP_CHECKPOINT_METHODS = new Set([
  "claimObjectCleanup",
  "completeObjectCleanupBatch",
  "failObjectCleanupBatch",
]);
const REQUEST_RECOVERY_CHECKPOINT_METHODS = new Set([
  "listActiveRevisionIndexRecoveryCandidates",
]);

function splitSnapshotPayload(payload: string): readonly string[] {
  const chunks: string[] = [];
  for (let start = 0; start < payload.length;) {
    let end = Math.min(payload.length, start + SNAPSHOT_CHUNK_CODE_UNITS);
    if (
      end < payload.length &&
      end > start &&
      payload.charCodeAt(end - 1) >= 0xd800 &&
      payload.charCodeAt(end - 1) <= 0xdbff &&
      payload.charCodeAt(end) >= 0xdc00 &&
      payload.charCodeAt(end) <= 0xdfff
    ) {
      end -= 1;
    }
    chunks.push(payload.slice(start, end));
    start = end;
  }
  return Object.freeze(chunks.length === 0 ? [""] : chunks);
}

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

async function withD1Timeout<Result>(
  operation: Promise<Result>,
  timeoutMs: number,
  description: string,
): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(
        new Error(`D1 ${description} timed out`),
        { code: "metadata_d1_timeout" },
      ));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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

interface TailReplayResult {
  readonly sequence: number;
  readonly shouldCheckpoint: boolean;
}

function shouldCheckpointEvent(event: DurableEvent, sequence: number): boolean {
  if (TOKEN_MUTATIONS.has(event.method)) {
    // The fenced token event is already canonical durability. OAuth refresh is
    // latency-sensitive, so do not make every rollover wait for a rewrite of
    // the complete metadata snapshot while keeping cold tail replay bounded.
    return sequence % TOKEN_SNAPSHOT_CADENCE === 0;
  }
  if (event.method === "runMindBindingTransaction") {
    // The fenced event is already canonical durability. Binding selection is
    // latency-sensitive UI/MCP setup, so avoid rewriting the full materialized
    // snapshot for every attach or rebind while keeping restart replay bounded.
    return sequence % MIND_BINDING_SNAPSHOT_CADENCE === 0;
  }
  if (event.method === "runCredentialWriteTargetTransaction") {
    return sequence % MIND_BINDING_SNAPSHOT_CADENCE === 0;
  }
  if (event.method === "runPrincipalMindUsageTransaction") {
    return sequence % MIND_BINDING_SNAPSHOT_CADENCE === 0;
  }
  if (
    event.method === "runContentCommitTransaction" ||
    event.method === "runCapacityTransaction"
  ) {
    return sequence % CONTENT_SNAPSHOT_CADENCE === 0;
  }
  if (OBJECT_CLEANUP_CHECKPOINT_METHODS.has(event.method)) {
    // Claim/completion events are already fenced durability. Request-triggered
    // maintenance may emit both around one empty bounded scan; rewriting the
    // complete account/Mind snapshot for each checkpoint would contend with
    // the next foreground navigation. Keep restart replay bounded instead.
    return sequence % OBJECT_CLEANUP_SNAPSHOT_CADENCE === 0;
  }
  if (REQUEST_RECOVERY_CHECKPOINT_METHODS.has(event.method)) {
    // The rotating recovery cursor is durable, but rewriting the complete
    // metadata snapshot for every quiet-window scan makes an otherwise empty
    // maintenance pass contend with the next foreground navigation.
    return sequence % REQUEST_RECOVERY_SNAPSHOT_CADENCE === 0;
  }
  return true;
}

function isEmptyRecoveryDirectCall(method: string, result: unknown): boolean {
  return method === "collectStagedBundleFilesForGc" &&
    Array.isArray(result) && result.length === 0;
}

function isEmptyRecoveryTransaction(
  method: string,
  calls: readonly DurableCall[],
  callResults: readonly unknown[],
): boolean {
  if (
    method === "runOrdinaryMindTransaction" &&
    calls.length === 1 &&
    callResults.length === 1 &&
    calls[0]?.method === "reconcileInvitationExpiries" &&
    typeof callResults[0] === "object" &&
    callResults[0] !== null &&
    "expiredCount" in callResults[0] &&
    callResults[0].expiredCount === 0
  ) return true;
  if (
    method !== "runMarkdownImportTransaction" ||
    calls.length !== 1 ||
    callResults.length !== 1
  ) return false;
  return (
    calls[0]?.method === "claimMarkdownImportCleanup" &&
    Array.isArray(callResults[0]) && callResults[0].length === 0
  ) || (
    calls[0]?.method === "deleteExpiredMarkdownImportPlans" &&
    callResults[0] === 0
  );
}

function transactionContainsMutation(calls: readonly DurableCall[]): boolean {
  return calls.some((call) =>
    METADATA_MUTATIONS.has(call.method) ||
    !/^(?:check|classify|find|inspect|is|list|read|resolve|validate)/u.test(call.method)
  );
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
export interface SitesMetadataDiagnostics {
  observe<Result>(stage: "operation" | "queue" | "d1" | "recovery", operation: string, work: () => Promise<Result>,
    blockedBy?: Readonly<{ traceId: string; spanId: string }> | undefined): Promise<Result>;
  current?(): Readonly<{ traceId: string; spanId: string }> | undefined;
}

export interface SitesMetadataStoreOptions {
  readonly d1TimeoutMs?: number;
  readonly queueTimeoutMs?: number;
  readonly onQueueTimeout?: () => void;
  readonly diagnostics?: SitesMetadataDiagnostics;
}

export class SitesMetadataStore {
  readonly kind = "metadata-store" as const;
  readonly #database: D1DatabaseLike;
  readonly #d1TimeoutMs: number;
  readonly #queueTimeoutMs: number;
  readonly #onQueueTimeout: (() => void) | undefined;
  readonly #diagnostics: SitesMetadataDiagnostics | undefined;
  #tailOwner: Readonly<{ traceId: string; spanId: string }> | undefined;
  #metadata = new InMemoryRevisionMetadataStore();
  #tokens = new InMemoryMcpTokenStore();
  #sequence = 0;
  #initialized = false;
  #loaded = false;
  #tail: Promise<void> = Promise.resolve();
  #activityTail: Promise<void> = Promise.resolve();
  #proxy: this;

  constructor(
    database: D1DatabaseLike,
    options: Readonly<SitesMetadataStoreOptions> = {},
  ) {
    this.#database = database;
    this.#d1TimeoutMs = options.d1TimeoutMs ?? SITES_METADATA_D1_TIMEOUT_MS;
    this.#queueTimeoutMs = options.queueTimeoutMs ?? SITES_METADATA_D1_TIMEOUT_MS;
    this.#onQueueTimeout = options.onQueueTimeout;
    this.#diagnostics = options.diagnostics;
    if (!Number.isSafeInteger(this.#queueTimeoutMs) || this.#queueTimeoutMs < 1) {
      throw new TypeError("metadata queue timeout must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#d1TimeoutMs) || this.#d1TimeoutMs < 1) {
      throw new TypeError("metadata D1 timeout must be a positive integer");
    }
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
            target.#exclusive(() => target.#runTransaction(property, operation), "transaction");
        }
        const mutations = selected.target === "metadata" ? METADATA_MUTATIONS : TOKEN_MUTATIONS;
        if (mutations.has(property)) {
          return (...args: unknown[]) =>
            target.#exclusive(() =>
              target.#runDirect(selected.target, property, args),
              "mutation",
            );
        }
        return (...args: unknown[]) =>
          target.#exclusive(async () => {
            await target.#refresh();
            const current = selected.target === "metadata" ? target.#metadata : target.#tokens;
            return methodOf(current, property)(...args);
          }, "read");
      },
    });
    this.#proxy = proxy;
    return proxy;
  }

  async ready(): Promise<this> {
    await this.#exclusive(async () => {
      await this.#refresh();
    });
    return this.#proxy;
  }

  /** Internal backup capture. The caller must publish with a D1 sequence CAS. */
  async captureSystemBackupState(): Promise<Readonly<{
    eventSequence: number;
    snapshot: unknown;
  }>> {
    return this.#exclusive(async () => {
      await this.#refresh();
      return Object.freeze({
        eventSequence: this.#sequence,
        snapshot: this.#metadata.exportDurableSnapshot(),
      });
    }, "read_session");
  }

  /**
   * Activity is an observational last-seen projection, not canonical product
   * state. Keep it out of the fenced metadata event log so a page view never
   * replays or rewrites the full account/Mind snapshot.
   */
  async recordPrincipalActivity(
    request: Readonly<RecordPrincipalActivityRequest>,
  ): Promise<void> {
    // The store is fully loaded by ready(), and every successful product actor
    // has already crossed a current metadata read before this best-effort
    // observation is scheduled. Validate against an immutable in-process view,
    // then serialize only the independent activity projection write. Keeping
    // D1 I/O off #tail prevents a deferred page observation from head-of-line
    // blocking the next authenticated navigation.
    const expectedSequence = this.#sequence;
    const view = this.#cloneMetadata(this.#metadata);
    await view.recordPrincipalActivity(request);
    const summary = await view.readPrincipalActivity(request.principalId);
    if (summary === null) return;
    await this.#activityExclusive(() =>
      this.#upsertPrincipalActivity(summary, expectedSequence));
  }

  async readPrincipalActivity(
    principalId: PrincipalId,
  ): Promise<Readonly<PrincipalActivitySummary> | null> {
    return this.#exclusive(async () => {
      await this.#refresh();
      const view = this.#cloneMetadata(this.#metadata);
      const rows = await this.#readPrincipalActivityRows(principalId);
      await this.#hydratePrincipalActivity(view, rows);
      const summary = await view.readPrincipalActivity(principalId);
      if (summary === null && rows.length > 0) {
        await this.#deletePrincipalActivity(principalId);
      }
      return summary;
    });
  }

  async listServiceOperatorPrincipals(
    query: Readonly<ServiceOperatorDirectoryQuery>,
  ): Promise<Readonly<ServiceOperatorDirectoryPage>> {
    return this.#exclusive(async () => {
      await this.#refresh();
      const view = this.#cloneMetadata(this.#metadata);
      const rows = await this.#readPrincipalActivityRows();
      await this.#hydratePrincipalActivity(view, rows);
      return view.listServiceOperatorPrincipals(query);
    });
  }

  async readCurrentAuthorizationState(
    query: AuthorizationStateQuery,
  ): Promise<Readonly<CurrentAuthorizationState> | null> {
    return this.#exclusive(async () => {
      await this.#refresh();
      return currentAuthorizationStateWithToken(this.#metadata, this.#tokens, query);
    });
  }

  async readCurrentAuthorizationStates(
    queries: readonly AuthorizationStateQuery[],
  ): Promise<readonly (Readonly<CurrentAuthorizationState> | null)[]> {
    return this.#exclusive(async () => {
      await this.#refresh();
      return Object.freeze(
        await Promise.all(
          queries.map((query) =>
            currentAuthorizationStateWithToken(this.#metadata, this.#tokens, query),
          ),
        ),
      );
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
    return this.withDetachedConsistentRead(operation);
  }

  /**
   * One detached immutable view for a read that must perform a separate live
   * authorization recheck before returning. The metadata lock is released
   * after the snapshot is cloned, so the final current-state read cannot
   * self-block behind the materialization callback.
   */
  async withDetachedConsistentRead<Result>(
    operation: (store: this) => Promise<Result>,
  ): Promise<Result> {
    if (typeof operation !== "function") {
      throw new TypeError("Sites metadata detached read-session callback is required");
    }
    const snapshot = await this.#exclusive(async () => {
      await this.#refresh();
      return Object.freeze({
        metadata: this.#cloneMetadata(this.#metadata),
        tokens: InMemoryMcpTokenStore.fromDurableSnapshot(
          this.#tokens.exportDurableSnapshot(),
        ),
      });
    });
    return operation(this.#consistentReadView(snapshot.metadata, snapshot.tokens));
  }

  #consistentReadView(
    metadata: InMemoryRevisionMetadataStore,
    tokens: InMemoryMcpTokenStore,
  ): this {
    return new Proxy(Object.create(null) as this, {
      get: (_target, property) => {
        if (property === "readCurrentAuthorizationState") {
          return (query: AuthorizationStateQuery) =>
            currentAuthorizationStateWithToken(metadata, tokens, query);
        }
        if (property === "readCurrentAuthorizationStates") {
          return (queries: readonly AuthorizationStateQuery[]) =>
            Promise.all(
              queries.map((query) =>
                currentAuthorizationStateWithToken(metadata, tokens, query),
              ),
            );
        }
        if (property === "readCurrentRouteAuthorizationState") {
          return (query: MindRouteAuthorizationQuery) =>
            currentRouteAuthorizationStateWithToken(metadata, tokens, query);
        }
        if (typeof property !== "string") return undefined;
        const target = property in metadata
          ? "metadata"
          : property in tokens
            ? "tokens"
            : null;
        if (target === null) return undefined;
        const mutations = target === "metadata" ? METADATA_MUTATIONS : TOKEN_MUTATIONS;
        if (TRANSACTION_METHODS.has(property) || mutations.has(property)) {
          return () => {
            throw new TypeError("Sites metadata consistent read-session is read-only");
          };
        }
        return methodOf(target === "metadata" ? metadata : tokens, property);
      },
    });
  }

  async #migrate(): Promise<void> {
    if (this.#initialized) return;
    const appliedAt = new Date().toISOString();
    const statements: D1PreparedStatementLike[] = [];
    for (const migration of SITES_METADATA_MIGRATIONS) {
      statements.push(
        ...migration.statements.map((sql) => this.#database.prepare(sql)),
        this.#database
          .prepare(
            `/*md-metadata-migration*/ INSERT OR IGNORE INTO md_metadata_schema_migrations
             (version, name, applied_at) VALUES (?1, ?2, ?3)`,
          )
          .bind(migration.version, migration.name, appliedAt),
      );
    }
    await this.#boundedD1(
      this.#database.batch(statements),
      "metadata schema migration",
    );
    this.#initialized = true;
  }

  #select(property: string): { readonly target: DurableTarget } | null {
    if (property in this.#metadata) return { target: "metadata" };
    if (property in this.#tokens) return { target: "tokens" };
    return null;
  }

  #boundedD1<Result>(operation: Promise<Result>, description: string): Promise<Result> {
    return withD1Timeout(this.#observe("d1", "bounded", () => operation), this.#d1TimeoutMs, description);
  }

  #observe<Result>(stage: "operation" | "queue" | "d1", kind: string, operation: () => Promise<Result>,
    blockedBy?: Readonly<{ traceId: string; spanId: string }>): Promise<Result> {
    return this.#diagnostics === undefined ? operation() : this.#diagnostics.observe(stage, kind, operation, blockedBy);
  }

  async #refresh(): Promise<void> {
    if (!this.#loaded) {
      let loaded: LoadedState;
      if (this.#initialized) {
        loaded = await this.#load();
      } else {
        try {
          loaded = await this.#load();
          this.#initialized = true;
        } catch {
          // A fresh or older database may not yet have every table referenced
          // by the fast cold-load query. Apply the idempotent schema batch once
          // and retry; current deployments avoid a separate migration round-trip.
          await this.#migrate();
          loaded = await this.#load();
        }
      }
      this.#metadata = loaded.metadata;
      this.#tokens = loaded.tokens;
      this.#sequence = loaded.sequence;
      this.#loaded = true;
      return;
    }
    this.#sequence = (await this.#replayTail(
      this.#metadata,
      this.#tokens,
      this.#sequence,
    )).sequence;
  }

  async #load(): Promise<LoadedState> {
    const result = await this.#boundedD1(
      this.#database
        .prepare(
        `/*md-metadata-cold-load*/ WITH
         schema_guard AS (
           SELECT
             COALESCE(MAX(version), 0) AS schema_version,
             (SELECT COUNT(*) FROM md_principal_activity WHERE 0) AS activity_guard
             ,(SELECT COUNT(*) FROM md_backup_control WHERE 0) AS backup_guard
           FROM md_metadata_schema_migrations
         ),
         current_head AS (
           SELECT sequence, chunk_count, payload_chars
           FROM md_metadata_snapshot_heads WHERE singleton_id = 1
         ),
         base_sequence AS (
           SELECT COALESCE(
             (SELECT sequence FROM current_head),
             (SELECT sequence FROM md_metadata_snapshots WHERE singleton_id = 1),
             0
           ) AS sequence
         )
         SELECT
           0 AS row_kind,
           head.sequence,
           head.chunk_count,
           head.payload_chars,
           chunk.chunk_index,
           NULL AS target,
           NULL AS operation,
           chunk.payload_json,
           guard.schema_version
         FROM schema_guard AS guard
         JOIN current_head AS head
         JOIN md_metadata_snapshot_chunks AS chunk
           ON chunk.sequence = head.sequence
         UNION ALL
         SELECT
           1 AS row_kind,
           snapshot.sequence,
           1 AS chunk_count,
           LENGTH(snapshot.payload_json) AS payload_chars,
           0 AS chunk_index,
           NULL AS target,
           NULL AS operation,
           snapshot.payload_json,
           guard.schema_version
         FROM schema_guard AS guard
         JOIN md_metadata_snapshots AS snapshot ON snapshot.singleton_id = 1
         WHERE NOT EXISTS (SELECT 1 FROM current_head)
         UNION ALL
         SELECT
           2 AS row_kind,
           event.sequence,
           NULL AS chunk_count,
           NULL AS payload_chars,
           NULL AS chunk_index,
           event.target,
           event.operation,
           event.payload_json,
           guard.schema_version
         FROM schema_guard AS guard
         JOIN base_sequence AS base
         JOIN md_metadata_events AS event ON event.sequence > base.sequence
         UNION ALL
         SELECT
           3 AS row_kind,
           0 AS sequence,
           NULL AS chunk_count,
           NULL AS payload_chars,
           NULL AS chunk_index,
           NULL AS target,
           NULL AS operation,
           '' AS payload_json,
           guard.schema_version
         FROM schema_guard AS guard
         WHERE NOT EXISTS (SELECT 1 FROM current_head)
           AND NOT EXISTS (
             SELECT 1 FROM md_metadata_snapshots WHERE singleton_id = 1
           )
           AND NOT EXISTS (SELECT 1 FROM md_metadata_events)
         ORDER BY row_kind ASC, sequence ASC, chunk_index ASC`,
        )
        .all<DurableColdLoadRow>(),
      "metadata cold load",
    );
    const rows = [...(result.results ?? [])];
    if (
      rows.length === 0 ||
      rows.some((row) => row.schema_version !== SITES_METADATA_SCHEMA_VERSION)
    ) {
      const observed = rows.length === 0
        ? "no rows"
        : [...new Set(rows.map((row) => String(row.schema_version)))].join(",");
      throw new Error(
        `Sites metadata schema upgrade is required (expected ${SITES_METADATA_SCHEMA_VERSION}; observed ${observed})`,
      );
    }
    const eventRows = rows
      .filter((row) => row.row_kind === 2)
      .map((row) => ({
        sequence: row.sequence,
        target: row.target as DurableTarget,
        operation: row.operation as string,
        payload_json: row.payload_json,
      }));
    const snapshotRows = rows.filter((row) => row.row_kind === 0 || row.row_kind === 1);
    if (snapshotRows.length > 0) {
      const first = snapshotRows[0]!;
      const chunkCount = first.chunk_count;
      const payloadChars = first.payload_chars;
      if (
        !Number.isSafeInteger(first.sequence) || first.sequence < 0 ||
        typeof chunkCount !== "number" ||
        !Number.isSafeInteger(chunkCount) || chunkCount < 1 ||
        typeof payloadChars !== "number" ||
        !Number.isSafeInteger(payloadChars) || payloadChars < 1 ||
        snapshotRows.length !== chunkCount
      ) {
        throw new Error("Sites metadata snapshot is invalid");
      }
      const chunks: string[] = [];
      for (const row of snapshotRows) {
        if (
          row.sequence !== first.sequence ||
          row.chunk_count !== chunkCount ||
          row.payload_chars !== payloadChars ||
          row.chunk_index !== chunks.length ||
          typeof row.payload_json !== "string"
        ) {
          throw new Error("Sites metadata snapshot chunks are invalid");
        }
        chunks.push(row.payload_json);
      }
      const payloadJson = chunks.join("");
      if (payloadJson.length !== payloadChars) {
        throw new Error("Sites metadata snapshot payload length is invalid");
      }
      return this.#loadSnapshot(first.sequence, payloadJson, eventRows);
    }

    const metadata = new InMemoryRevisionMetadataStore();
    const tokens = new InMemoryMcpTokenStore();
    const replayed = await this.#replayRows(metadata, tokens, 0, eventRows);
    await this.#persistSnapshot(replayed.sequence, metadata, tokens);
    return { metadata, tokens, sequence: replayed.sequence };
  }

  async #loadSnapshot(
    sequenceAtSnapshot: number,
    payloadJson: string,
    tailRows?: readonly DurableEventRow[],
  ): Promise<LoadedState> {
    const snapshot = decode<DurableSnapshot>(payloadJson);
    if (snapshot.v !== 1) throw new Error("Sites metadata snapshot is invalid");
    const metadata = InMemoryRevisionMetadataStore.fromDurableSnapshot(
      snapshot.metadata,
    );
    const tokens = InMemoryMcpTokenStore.fromDurableSnapshot(snapshot.tokens);
    const replayed = tailRows === undefined
      ? await this.#replayTail(metadata, tokens, sequenceAtSnapshot)
      : await this.#replayRows(metadata, tokens, sequenceAtSnapshot, tailRows);
    if (replayed.shouldCheckpoint) {
      await this.#persistSnapshot(replayed.sequence, metadata, tokens);
    }
    return { metadata, tokens, sequence: replayed.sequence };
  }

  async #replayTail(
    metadata: InMemoryRevisionMetadataStore,
    tokens: InMemoryMcpTokenStore,
    afterSequence: number,
  ): Promise<TailReplayResult> {
    const result = await this.#boundedD1(
      this.#database
        .prepare(
        `/*md-metadata-events-tail*/ SELECT sequence, target, operation, payload_json
         FROM md_metadata_events WHERE sequence > ?1 ORDER BY sequence ASC`,
        )
        .bind(afterSequence)
        .all<DurableEventRow>(),
      "metadata tail read",
    );
    return this.#replayRows(metadata, tokens, afterSequence, result.results ?? []);
  }

  async #replayRows(
    metadata: InMemoryRevisionMetadataStore,
    tokens: InMemoryMcpTokenStore,
    afterSequence: number,
    rows: readonly DurableEventRow[],
  ): Promise<TailReplayResult> {
    let expected = afterSequence;
    let shouldCheckpoint = false;
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
      shouldCheckpoint ||= shouldCheckpointEvent(event, expected);
    }
    // Historical read/write-binding tail events are replayed only to recover a
    // bounded migration candidate. They are then discarded before serving any
    // request, so replay cannot revive removed read authority or stale IDs.
    await metadata.decommissionLegacyMindBindingsForMigration();
    return Object.freeze({ sequence: expected, shouldCheckpoint });
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
      const loaded = await this.#createMutationBase();
      const target = targetName === "metadata" ? loaded.metadata : loaded.tokens;
      const result = await methodOf(target, method)(...args);
      if (isEmptyRecoveryDirectCall(method, result)) return result;
      const event: DurableEvent = { v: 1, kind: "direct", target: targetName, method, args };
      if (await this.#append(
        loaded.sequence,
        event,
        loaded.metadata,
        loaded.tokens,
        result,
      )) {
        this.#metadata = loaded.metadata;
        this.#tokens = loaded.tokens;
        this.#sequence = loaded.sequence + 1;
        this.#loaded = true;
        return result;
      }
    }
    throw new Error("Sites metadata CAS retry budget exhausted");
  }

  async #createMutationBase(): Promise<LoadedState> {
    // Warm mutations need a detached state for safe CAS retry, not another
    // remote read and parse of the complete materialized snapshot. Refresh the
    // canonical cache from the small event tail, then clone it in-process.
    await this.#refresh();
    return Object.freeze({
      metadata: this.#cloneMetadata(this.#metadata),
      tokens: InMemoryMcpTokenStore.fromDurableSnapshot(
        this.#tokens.exportDurableSnapshot(),
      ),
      sequence: this.#sequence,
    });
  }

  #cloneMetadata(
    metadata: InMemoryRevisionMetadataStore,
  ): InMemoryRevisionMetadataStore {
    return InMemoryRevisionMetadataStore.fromDurableSnapshot(
      metadata.exportDurableSnapshot(),
    );
  }

  async #runTransaction(
    method: string,
    operation: (transaction: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    if (typeof operation !== "function") {
      throw new TypeError("Sites metadata transaction callback is required");
    }
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const loaded = await this.#createMutationBase();
      const calls: DurableCall[] = [];
      const callResults: unknown[] = [];
      const result = await methodOf(loaded.metadata, method)(
        async (transaction: object) =>
          operation(this.#captureTransaction(
            transaction,
            loaded.tokens,
            calls,
            callResults,
          )),
      );
      if (isEmptyRecoveryTransaction(method, calls, callResults)) return result;
      if (!transactionContainsMutation(calls)) {
        // A read-only transaction must not create a durable no-op event, but it
        // still participates in the optimistic read fence. If another writer
        // advanced the canonical sequence while the callback was running,
        // retry against a fresh detached snapshot so authorization and other
        // read decisions cannot escape from a stale transaction view.
        if (await this.#readCanonicalEvent(loaded.sequence + 1) === null) {
          return result;
        }
        await this.#refresh();
        continue;
      }
      const event: DurableEvent = {
        v: 1,
        kind: "transaction",
        target: "metadata",
        method,
        calls,
      };
      if (await this.#append(
        loaded.sequence,
        event,
        loaded.metadata,
        loaded.tokens,
        result,
      )) {
        this.#metadata = loaded.metadata;
        this.#tokens = loaded.tokens;
        this.#sequence = loaded.sequence + 1;
        this.#loaded = true;
        await this.#cleanupPrincipalActivityAfterTransaction(method, calls, result);
        return result;
      }
    }
    throw new Error("Sites metadata transaction CAS retry budget exhausted");
  }

  #captureTransaction(
    transaction: object,
    tokens: InMemoryMcpTokenStore,
    calls: DurableCall[],
    callResults: unknown[],
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
        if (property === "updatePersonalMindDescription") {
          const request = args[0] as { principalId: string; occurredAt: string; configurationCredential?: { tokenId: Parameters<InMemoryMcpTokenStore["readMcpTokenForAuthorization"]>[0] } };
          if (request.configurationCredential !== undefined) {
            const token = await tokens.readMcpTokenForAuthorization(request.configurationCredential.tokenId);
            if (token === null || token.principalId !== request.principalId || token.state !== "active"
              || Date.parse(token.expiresAt) <= Date.parse(request.occurredAt)
              || !token.scopes.some((scope) => scope === "personal:configure")) {
              // A rejected call is never journalled as an executable mutation.
              return Object.freeze({ kind: "configuration_forbidden" });
            }
          }
        }
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
        callResults.push(callResult);
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
    mutationResult: unknown,
  ): Promise<boolean> {
    const sequence = expectedSequence + 1;
    const payloadJson = encode(event);
    const append = this.#database
      .prepare(
        `/*md-metadata-append*/ INSERT INTO md_metadata_events
         (sequence, target, operation, payload_json, committed_at)
         SELECT ?1, ?2, ?3, ?4, ?5
         WHERE COALESCE((SELECT MAX(sequence) FROM md_metadata_events), 0) = ?6
           AND (SELECT backup_sequence FROM md_backup_control WHERE singleton_id = 1) = ?6`,
      )
      .bind(
        sequence,
        event.target,
        event.method,
        payloadJson,
        new Date().toISOString(),
        expectedSequence,
      );
    const deletedPrincipalId = accountDeletionPrincipalId(event, mutationResult);
    const invalidatesBackup = invalidatesSystemBackup(event, mutationResult);
    const advance = this.#database
      .prepare(
        `/*md-backup-sequence-advance*/ UPDATE md_backup_control
         SET backup_sequence = ?1,
             invalidation_epoch = invalidation_epoch + ?2
         WHERE singleton_id = 1 AND backup_sequence = ?3
           AND EXISTS (
             SELECT 1 FROM md_metadata_events
             WHERE sequence = ?1 AND target = ?4 AND operation = ?5
               AND payload_json = ?6
           )`,
      )
      .bind(sequence, invalidatesBackup ? 1 : 0, expectedSequence,
        event.target, event.method, payloadJson);
    const statements = [append, advance];
    if (invalidatesBackup) {
      statements.push(this.#database.prepare(
        `/*md-backup-invalidate-deleted-state*/ UPDATE md_backup_sessions
         SET status = 'invalidated'
         WHERE status IN ('building', 'ready')
           AND EXISTS (
             SELECT 1 FROM md_metadata_events
             WHERE sequence = ?1 AND target = ?2 AND operation = ?3
               AND payload_json = ?4
           )`,
      ).bind(sequence, event.target, event.method, payloadJson));
    }
    if (deletedPrincipalId !== null) {
      statements.push(this.#database
        .prepare(
          `/*md-principal-activity-delete-committed*/ DELETE FROM md_principal_activity
           WHERE principal_id = ?1
             AND EXISTS (
               SELECT 1 FROM md_metadata_events
               WHERE sequence = ?2 AND target = ?3 AND operation = ?4
                 AND payload_json = ?5
             )`,
        )
        .bind(deletedPrincipalId, sequence, event.target, event.method, payloadJson));
    }
    // D1 promises do not expose cancellation. Timing out this canonical write
    // would let the caller observe failure while the same INSERT can still
    // commit, making an automatic retry ambiguous. Reads and derived writes
    // remain bounded, but the fenced event append must reach its exact result.
    let appendOutcome: D1ResultLike;
    try {
      const [appendResult, advanceResult] = await this.#observe("d1", "append", () =>
        this.#database.batch(statements));
      appendOutcome = appendResult ?? { success: false, meta: { changes: 0 } };
      if (changes(appendOutcome) === 1 && changes(advanceResult ?? {}) !== 1) {
        throw new Error("Sites metadata backup sequence did not advance with commit");
      }
    } catch (error) {
      // A rejected provider promise does not prove that the INSERT failed: the
      // D1 transaction may already have committed. Resolve the exact sequence
      // without a local timeout before either reporting failure or retrying.
      const committed = await this.#readCanonicalEvent(sequence);
      if (committed === null) throw error;
      if (!isExactDurableEvent(committed, sequence, event, payloadJson)) {
        return false;
      }
      appendOutcome = { success: true, meta: { changes: 1 } };
    }
    if (changes(appendOutcome) !== 1) return false;
    if (shouldCheckpointEvent(event, sequence)) {
      try {
        await this.#persistSnapshot(sequence, metadata, tokens);
      } catch {
        // The fenced event append above is the canonical commit. A stale or
        // absent materialized snapshot is repaired by contiguous tail replay on
        // the next read/restart; surfacing failure here would report an
        // ambiguous mutation result and invite an unnecessary retry.
      }
    }
    return true;
  }

  async #readCanonicalEvent(sequence: number): Promise<DurableEventRow | null> {
    const result = await this.#observe("d1", "readback", () => this.#database
      .prepare(
        `/*md-metadata-append-readback*/ SELECT sequence, target, operation, payload_json,
           (SELECT backup_sequence FROM md_backup_control WHERE singleton_id = 1)
             AS backup_sequence
         FROM md_metadata_events WHERE sequence = ?1`,
      )
      .bind(sequence)
      .all<DurableEventRow>());
    const rows = result.results ?? [];
    if (rows.length > 1) {
      throw new Error("Sites metadata append readback is not unique");
    }
    return rows[0] ?? null;
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
    const encoded = encode(payload);
    const chunks = splitSnapshotPayload(encoded);
    const statements = chunks.map((chunk, chunkIndex) =>
      this.#database
        .prepare(
          `/*md-metadata-snapshot-chunk-write*/ INSERT OR REPLACE INTO md_metadata_snapshot_chunks
           (sequence, chunk_index, payload_json) VALUES (?1, ?2, ?3)`,
        )
        .bind(sequence, chunkIndex, chunk),
    );
    statements.push(
      this.#database
        .prepare(
          `/*md-metadata-snapshot-write*/ INSERT INTO md_metadata_snapshot_heads
           (singleton_id, sequence, chunk_count, payload_chars, updated_at)
           VALUES (1, ?1, ?2, ?3, ?4)
           ON CONFLICT(singleton_id) DO UPDATE SET
             sequence = excluded.sequence,
             chunk_count = excluded.chunk_count,
             payload_chars = excluded.payload_chars,
             updated_at = excluded.updated_at
           WHERE md_metadata_snapshot_heads.sequence < excluded.sequence`,
        )
        .bind(sequence, chunks.length, encoded.length, new Date().toISOString()),
      this.#database.prepare(
        `/*md-metadata-snapshot-cleanup*/ DELETE FROM md_metadata_snapshot_chunks
         WHERE sequence < COALESCE(
           (SELECT sequence FROM md_metadata_snapshot_heads WHERE singleton_id = 1),
           0
         )`,
      ),
    );
    await this.#boundedD1(
      this.#database.batch(statements),
      "metadata snapshot write",
    );
  }

  async #upsertPrincipalActivity(
    summary: Readonly<PrincipalActivitySummary>,
    expectedSequence: number,
  ): Promise<void> {
    await this.#boundedD1(
      this.#database
        .prepare(
        `/*md-principal-activity-upsert*/ INSERT INTO md_principal_activity
         (principal_id, last_web_seen_at, last_mcp_seen_at, last_activity_at,
          last_activity_surface, last_activity_kind)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
         WHERE COALESCE((SELECT MAX(sequence) FROM md_metadata_events), 0) = ?7
         ON CONFLICT(principal_id) DO UPDATE SET
           last_web_seen_at = CASE
             WHEN excluded.last_web_seen_at IS NOT NULL AND
               (md_principal_activity.last_web_seen_at IS NULL OR
                excluded.last_web_seen_at > md_principal_activity.last_web_seen_at)
             THEN excluded.last_web_seen_at
             ELSE md_principal_activity.last_web_seen_at
           END,
           last_mcp_seen_at = CASE
             WHEN excluded.last_mcp_seen_at IS NOT NULL AND
               (md_principal_activity.last_mcp_seen_at IS NULL OR
                excluded.last_mcp_seen_at > md_principal_activity.last_mcp_seen_at)
             THEN excluded.last_mcp_seen_at
             ELSE md_principal_activity.last_mcp_seen_at
           END,
           last_activity_at = CASE
             WHEN excluded.last_activity_at > md_principal_activity.last_activity_at
             THEN excluded.last_activity_at
             ELSE md_principal_activity.last_activity_at
           END,
           last_activity_surface = CASE
             WHEN excluded.last_activity_at > md_principal_activity.last_activity_at
             THEN excluded.last_activity_surface
             ELSE md_principal_activity.last_activity_surface
           END,
           last_activity_kind = CASE
             WHEN excluded.last_activity_at > md_principal_activity.last_activity_at
             THEN excluded.last_activity_kind
             ELSE md_principal_activity.last_activity_kind
           END`,
        )
        .bind(
          summary.principalId,
          summary.lastWebSeenAt,
          summary.lastMcpSeenAt,
          summary.lastActivityAt,
          summary.lastActivitySurface,
          summary.lastActivityKind,
          expectedSequence,
        )
        .run(),
      "principal activity write",
    );
  }

  async #readPrincipalActivityRows(
    principalId?: PrincipalId,
  ): Promise<readonly PrincipalActivityRow[]> {
    const statement = principalId === undefined
      ? this.#database.prepare(
          `/*md-principal-activity-read-all*/ SELECT principal_id, last_web_seen_at,
           last_mcp_seen_at, last_activity_at, last_activity_surface, last_activity_kind
           FROM md_principal_activity`,
        )
      : this.#database
          .prepare(
            `/*md-principal-activity-read-one*/ SELECT principal_id, last_web_seen_at,
             last_mcp_seen_at, last_activity_at, last_activity_surface, last_activity_kind
             FROM md_principal_activity WHERE principal_id = ?1`,
          )
          .bind(principalId);
    const result = await this.#boundedD1(
      statement.all<PrincipalActivityRow>(),
      "principal activity read",
    );
    return Object.freeze([...(result.results ?? [])]);
  }

  async #hydratePrincipalActivity(
    metadata: InMemoryRevisionMetadataStore,
    rows: readonly PrincipalActivityRow[],
  ): Promise<void> {
    for (const row of rows) {
      const principalId = row.principal_id as PrincipalId;
      const overallSurface = row.last_activity_surface as PrincipalActivitySurface;
      const overallKind = row.last_activity_kind as PrincipalActivityKind;
      const overallAt = row.last_activity_at as UtcInstant;
      const observations: Array<Readonly<RecordPrincipalActivityRequest> & {
        readonly overall: boolean;
      }> = [];
      if (row.last_web_seen_at !== null) {
        observations.push(Object.freeze({
          principalId,
          surface: "web",
          kind: overallSurface === "web" && row.last_web_seen_at === overallAt
            ? overallKind
            : "page",
          observedAt: row.last_web_seen_at as UtcInstant,
          overall: overallSurface === "web" && row.last_web_seen_at === overallAt,
        }));
      }
      if (row.last_mcp_seen_at !== null) {
        observations.push(Object.freeze({
          principalId,
          surface: "mcp",
          kind: overallSurface === "mcp" && row.last_mcp_seen_at === overallAt
            ? overallKind
            : "discovery",
          observedAt: row.last_mcp_seen_at as UtcInstant,
          overall: overallSurface === "mcp" && row.last_mcp_seen_at === overallAt,
        }));
      }
      observations.sort((left, right) => {
        const chronological = Date.parse(left.observedAt) - Date.parse(right.observedAt);
        if (chronological !== 0) return chronological;
        return Number(left.overall) - Number(right.overall);
      });
      for (const { overall: _overall, ...observation } of observations) {
        await metadata.recordPrincipalActivity(observation);
      }
    }
  }

  async #deletePrincipalActivity(principalId: PrincipalId): Promise<void> {
    await this.#boundedD1(
      this.#database
        .prepare(
        `/*md-principal-activity-delete*/ DELETE FROM md_principal_activity
         WHERE principal_id = ?1`,
        )
        .bind(principalId)
        .run(),
      "principal activity delete",
    );
  }

  async #cleanupPrincipalActivityAfterTransaction(
    method: string,
    calls: readonly DurableCall[],
    result: unknown,
  ): Promise<void> {
    if (method !== "runAccountDeletionTransaction") return;
    if (
      typeof result !== "object" ||
      result === null ||
      !("kind" in result) ||
      (result.kind !== "deleted" && result.kind !== "cleanup_pending")
    ) return;
    const deletion = calls.find((call) => call.method === "deleteAccountCascade");
    const request = deletion?.args[0];
    if (
      typeof request !== "object" ||
      request === null ||
      !("principalId" in request) ||
      typeof request.principalId !== "string"
    ) return;
    try {
      await this.#activityExclusive(() =>
        this.#deletePrincipalActivity(request.principalId as PrincipalId));
    } catch {
      // The account deletion event is canonical. A stale observational row is
      // invisible without its principal and is removed on an exact activity read.
    }
  }

  #exclusive<Result>(operation: () => Promise<Result>, kind = "metadata"): Promise<Result> {
    return this.#observe("operation", kind, () => this.#exclusiveObserved(operation, kind));
  }

  async #exclusiveObserved<Result>(operation: () => Promise<Result>, kind: string): Promise<Result> {
    const previous = this.#tail;
    const previousOwner = this.#tailOwner;
    const owner = this.#diagnostics?.current?.();
    this.#tailOwner = owner;
    let release: () => void = () => undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = () => {
        if (this.#tailOwner === owner) this.#tailOwner = undefined;
        resolve();
      };
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.#observe("queue", kind, () => Promise.race([
        previous,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Object.assign(
            new Error("Metadata queue admission timed out"),
            { code: "metadata_queue_timeout" },
          )), this.#queueTimeoutMs);
        }),
      ]), previousOwner);
    } catch (error) {
      // A canceled waiter must never release a still-running predecessor or
      // execute its operation later. Preserve the chain until that predecessor
      // settles; an unknown canonical append retains exclusive ownership.
      void previous.then(release, release);
      // Cache eviction is advisory: it cannot change the unsettled commit or
      // prevent the caller receiving the original admission failure.
      try { this.#onQueueTimeout?.(); } catch { /* no durable effect */ }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #activityExclusive<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.#activityTail;
    let release: () => void = () => undefined;
    this.#activityTail = new Promise<void>((resolve) => {
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
  options: Readonly<SitesMetadataStoreOptions> = {},
): Promise<SitesMetadataStore> {
  return new SitesMetadataStore(database, options).ready();
}

export * from "./local-file-upload-intent-store.js";
