import {
  WebCryptoMindLocatorCodec,
  type MindLocatorCodec,
  type MindLocatorPayload,
} from "@mind-diary/application-content";

export const SITES_LOCATOR_ADAPTER = "sites-d1-compact-locator-v2" as const;
export const SITES_LOCATOR_MAX_CHARACTERS = 128 as const;
export const SITES_LOCATOR_DEFAULT_TTL_MS = 60 * 60 * 1_000;

export interface LocatorD1ResultLike<Row = Record<string, unknown>> {
  readonly success?: boolean;
  readonly results?: readonly Row[];
  readonly meta?: { readonly changes?: number };
}

export interface LocatorD1PreparedStatementLike {
  bind(...values: readonly unknown[]): LocatorD1PreparedStatementLike;
  run<Row = Record<string, unknown>>(): Promise<LocatorD1ResultLike<Row>>;
  all<Row = Record<string, unknown>>(): Promise<LocatorD1ResultLike<Row>>;
}

export interface LocatorD1DatabaseLike {
  prepare(sql: string): LocatorD1PreparedStatementLike;
  batch(
    statements: readonly LocatorD1PreparedStatementLike[],
  ): Promise<readonly LocatorD1ResultLike[]>;
}

export const SITES_LOCATOR_MIGRATIONS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS md_mind_locator_handles (
    verifier TEXT PRIMARY KEY,
    encrypted_payload TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS md_mind_locator_expiry
    ON md_mind_locator_handles(expires_at)`,
]);

interface LocatorRow {
  readonly encrypted_payload: string;
  readonly expires_at: string;
}

interface SchemaObjectRow {
  readonly name?: string;
}

const PREFIX = "mdl2_";
const TOKEN_BYTES = 24;
const TOKEN_PATTERN = /^mdl2_[A-Za-z0-9_-]{32}$/u;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function changes(result: LocatorD1ResultLike): number {
  return Number(result.meta?.changes ?? 0);
}

/**
 * New locators are fixed-size random handles. Private locator payloads remain
 * encrypted at rest by the legacy AES-GCM codec; only a keyed verifier is
 * indexed in D1. Existing mdl1 locators remain readable during migration.
 */
export class SitesMindLocatorCodec implements MindLocatorCodec {
  readonly #database: LocatorD1DatabaseLike;
  readonly #crypto: Crypto;
  readonly #legacy: WebCryptoMindLocatorCodec;
  readonly #verifierKey: Promise<CryptoKey>;
  readonly #now: () => Date;
  readonly #ttlMs: number;
  #ready: Promise<void> | null = null;

  constructor(options: {
    readonly database: LocatorD1DatabaseLike;
    readonly secret: Uint8Array;
    readonly crypto?: Crypto;
    readonly now?: () => Date;
    readonly ttlMs?: number;
  }) {
    if (!(options.secret instanceof Uint8Array) || options.secret.byteLength !== 32) {
      throw new TypeError("Mind locator secret must contain exactly 32 bytes.");
    }
    this.#database = options.database;
    this.#crypto = options.crypto ?? globalThis.crypto;
    if (this.#crypto?.subtle === undefined) throw new TypeError("Web Crypto is required.");
    this.#legacy = new WebCryptoMindLocatorCodec(options.secret, this.#crypto);
    this.#verifierKey = this.#crypto.subtle.importKey(
      "raw",
      new Uint8Array(options.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = options.ttlMs ?? SITES_LOCATOR_DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1_000 || this.#ttlMs > 24 * 60 * 60 * 1_000) {
      throw new TypeError("Mind locator TTL is outside the supported range.");
    }
  }

  async encode(payload: Readonly<MindLocatorPayload>): Promise<string> {
    await this.#ensureReady();
    const encryptedPayload = await this.#legacy.encode(payload);
    const token = base64Url(this.#crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
    const handle = `${PREFIX}${token}`;
    const verifier = await this.#verifier(handle);
    const createdAt = this.#now();
    const expiresAt = new Date(createdAt.getTime() + this.#ttlMs);
    await this.#database
      .prepare(
        `/*md-locator-create*/ INSERT INTO md_mind_locator_handles
         (verifier, encrypted_payload, expires_at, created_at)
         VALUES (?1, ?2, ?3, ?4)`,
      )
      .bind(verifier, encryptedPayload, expiresAt.toISOString(), createdAt.toISOString())
      .run();
    await this.#database
      .prepare(
        `/*md-locator-cleanup*/ DELETE FROM md_mind_locator_handles
         WHERE verifier IN (
           SELECT verifier FROM md_mind_locator_handles
           WHERE expires_at <= ?1 ORDER BY expires_at ASC LIMIT 64
         )`,
      )
      .bind(createdAt.toISOString())
      .run();
    if (handle.length > SITES_LOCATOR_MAX_CHARACTERS) {
      throw new Error("Compact Mind locator exceeded its fixed budget.");
    }
    return handle;
  }

  async decode(candidate: unknown): Promise<Readonly<MindLocatorPayload> | null> {
    if (typeof candidate !== "string") return null;
    if (candidate.startsWith("mdl1_")) return this.#legacy.decode(candidate);
    if (candidate.length > SITES_LOCATOR_MAX_CHARACTERS || !TOKEN_PATTERN.test(candidate)) {
      return null;
    }
    await this.#ensureReady();
    const verifier = await this.#verifier(candidate);
    const result = await this.#database
      .prepare(
        `/*md-locator-read*/ SELECT encrypted_payload, expires_at
         FROM md_mind_locator_handles WHERE verifier = ?1 LIMIT 1`,
      )
      .bind(verifier)
      .all<LocatorRow>();
    const row = result.results?.[0];
    if (!row) return null;
    const expiresAt = Date.parse(row.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.#now().getTime()) {
      const removed = await this.#database
        .prepare(
          `/*md-locator-delete*/ DELETE FROM md_mind_locator_handles
           WHERE verifier = ?1`,
        )
        .bind(verifier)
        .run();
      void changes(removed);
      return null;
    }
    return this.#legacy.decode(row.encrypted_payload);
  }

  async #ensureReady(): Promise<void> {
    this.#ready ??= this.#migrate().catch((error) => {
      this.#ready = null;
      throw error;
    });
    await this.#ready;
  }

  async #migrate(): Promise<void> {
    try {
      const result = await this.#database
        .prepare(
          `/*md-locator-schema-probe*/ SELECT name FROM sqlite_master
           WHERE type IN ('table', 'index')
             AND name IN ('md_mind_locator_handles', 'md_mind_locator_expiry')`,
        )
        .all<SchemaObjectRow>();
      const names = new Set((result.results ?? []).map((row) => row.name));
      if (names.has("md_mind_locator_handles") && names.has("md_mind_locator_expiry")) {
        return;
      }
    } catch {
      // The schema is absent or an older D1 adapter does not expose sqlite_master.
      // Fall through to the idempotent schema batch below.
    }
    await this.#database.batch(
      SITES_LOCATOR_MIGRATIONS.map((sql) => this.#database.prepare(sql)),
    );
  }

  async #verifier(handle: string): Promise<string> {
    const signature = await this.#crypto.subtle.sign(
      "HMAC",
      await this.#verifierKey,
      new TextEncoder().encode(handle),
    );
    return base64Url(new Uint8Array(signature));
  }
}
