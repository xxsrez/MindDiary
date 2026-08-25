import type { ActorContext, McpTokenActorContext } from "@mind-diary/application-contracts";
import {
  REVISION_MANIFEST_MEDIA_TYPE,
  type Authorizer,
  type BundleFileDownloadGrantStore,
  type BundleFileObjectStore,
  type Clock,
  type ExportDownloadSecretCrypto,
} from "@mind-diary/application-ports";
import {
  REVISION_MANIFEST_FORMAT_V3,
  REVISION_MANIFEST_FORMAT_V4,
  canonicalBundleFilePath,
  parseRevisionManifest,
  revisionEnvelopesEqual,
  serializeRevisionManifest,
  type BundleFileDownloadGrant,
  type BundleFileMediaType,
  type EffectiveTokenScopes,
  type RevisionId,
  type RevisionMode,
  type Sha256Digest,
  type SpaceId,
  type UtcInstant,
} from "@mind-diary/domain";
import {
  MindDiscoveryFailure,
  MindDiscoveryService,
  type MindDiscoveryDescriptor,
  type MindDiscoveryRevisionDescriptor,
  type MindDiscoveryStore,
} from "./mind-discovery.js";
import { IncrementalSha256 } from "./incremental-sha256.js";

export const DEFAULT_BUNDLE_FILE_DOWNLOAD_GRANT_TTL_MS = 5 * 60 * 1_000;
export const MAX_BUNDLE_FILE_DOWNLOAD_GRANT_TTL_MS = 10 * 60 * 1_000;

export class BundleFileDownloadFailure extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "mind_not_found"
      | "revision_not_found"
      | "bundle_file_not_found"
      | "revision_integrity_failure"
      | "mind_binding_required"
      | "binding_owner_revoked"
      | "binding_state_unavailable",
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "BundleFileDownloadFailure";
  }
}

export interface BundleFileDownloadDescriptor {
  readonly path: string;
  readonly kind: "opaque";
  readonly mediaType: BundleFileMediaType;
  readonly size: number;
  readonly sha256: Sha256Digest;
  readonly revisionId: RevisionId;
  readonly inlineEligible: boolean;
}

export interface BundleFileDownloadGrantResult {
  readonly file: Readonly<BundleFileDownloadDescriptor>;
  readonly mind: Readonly<MindDiscoveryDescriptor>;
  readonly resolvedRevision: Readonly<MindDiscoveryRevisionDescriptor>;
  readonly downloadUrl: string;
  readonly downloadExpiresAt: UtcInstant;
  readonly disposition: "inline" | "attachment";
}

export type BundleFileDownloadResponse =
  | {
      readonly kind: "download";
      readonly headers: Readonly<Record<string, string>>;
      readonly body: ReadableStream<Uint8Array>;
    }
  | { readonly kind: "not_found" };

type DownloadStore = MindDiscoveryStore & BundleFileDownloadGrantStore;
type AllowedAuthorization = Extract<
  Awaited<ReturnType<Authorizer["authorize"]>>,
  { readonly kind: "allowed" }
>;

const RASTER_TYPES = new Set<BundleFileMediaType>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const CONTROL = /[\u0000-\u001f\u007f]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedBase(value: string): string {
  const url = new URL(value);
  const loopback = url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (
    (url.protocol !== "https:" && !loopback) ||
    url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== ""
  ) throw new TypeError("BundleFile download URL base is invalid.");
  return url.toString().replace(/\/$/u, "");
}

function addMilliseconds(now: UtcInstant, duration: number): UtcInstant {
  return new Date(Date.parse(now) + duration).toISOString() as UtcInstant;
}

function filename(path: string): string {
  return path.split("/").at(-1) ?? "download";
}

function asciiFallback(value: string): string {
  const safe = value.normalize("NFKD")
    .replace(/[^\x20-\x7e]/gu, "_")
    .replace(/["\\/;]/gu, "_")
    .trim();
  return safe.length === 0 ? "download" : safe.slice(0, 150);
}

function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function descriptor(
  entry: Readonly<{ path: string; mediaType: BundleFileMediaType; size: number; sha256: Sha256Digest }>,
  revisionId: RevisionId,
): Readonly<BundleFileDownloadDescriptor> {
  return Object.freeze({
    path: entry.path,
    kind: "opaque",
    mediaType: entry.mediaType,
    size: entry.size,
    sha256: entry.sha256,
    revisionId,
    inlineEligible: RASTER_TYPES.has(entry.mediaType),
  });
}

async function verifyBody(
  body: ReadableStream<Uint8Array>,
  expectedSize: number,
  expectedSha256: Sha256Digest,
): Promise<boolean> {
  const reader = body.getReader();
  const digest = new IncrementalSha256();
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || size + part.value.byteLength > expectedSize) {
        await reader.cancel().catch(() => undefined);
        return false;
      }
      size += part.value.byteLength;
      digest.update(part.value);
    }
    return size === expectedSize && digest.digest() === expectedSha256;
  } finally {
    reader.releaseLock();
  }
}

export class BundleFileDownloadService {
  readonly #store: DownloadStore;
  readonly #objects: BundleFileObjectStore;
  readonly #authorizer: Authorizer;
  readonly #discovery: MindDiscoveryService;
  readonly #clock: Clock;
  readonly #secrets: ExportDownloadSecretCrypto;
  readonly #downloadUrlBase: string;
  readonly #ttlMs: number;

  constructor(dependencies: {
    readonly store: DownloadStore;
    readonly objects: BundleFileObjectStore;
    readonly authorizer: Authorizer;
    readonly host: ConstructorParameters<typeof MindDiscoveryService>[0]["host"];
    readonly clock: Clock;
    readonly secrets: ExportDownloadSecretCrypto;
    readonly downloadUrlBase: string;
    readonly ttlMs?: number;
  }) {
    this.#store = dependencies.store;
    this.#objects = dependencies.objects;
    this.#authorizer = dependencies.authorizer;
    this.#discovery = new MindDiscoveryService({ store: dependencies.store, host: dependencies.host });
    this.#clock = dependencies.clock;
    this.#secrets = dependencies.secrets;
    this.#downloadUrlBase = normalizedBase(dependencies.downloadUrlBase);
    this.#ttlMs = dependencies.ttlMs ?? DEFAULT_BUNDLE_FILE_DOWNLOAD_GRANT_TTL_MS;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1 || this.#ttlMs > MAX_BUNDLE_FILE_DOWNLOAD_GRANT_TTL_MS) {
      throw new TypeError("BundleFile download grant TTL is invalid.");
    }
  }

  async issue(actor: ActorContext, input: unknown): Promise<Readonly<BundleFileDownloadGrantResult>> {
    if (
      actor.kind !== "registered_principal" ||
      actor.authentication.kind !== "mcp_token" ||
      !isRecord(input) || !("mind" in input) || !("path" in input) ||
      !Object.keys(input).every((key) => ["mind", "revisionSelector", "path"].includes(key)) ||
      typeof input.path !== "string" || input.path.length === 0 || CONTROL.test(input.path)
    ) throw new BundleFileDownloadFailure("invalid_request", "BundleFile download request is invalid.");
    const mcpActor = actor as McpTokenActorContext;
    let path: string;
    try {
      path = canonicalBundleFilePath(input.path);
    } catch {
      throw new BundleFileDownloadFailure("invalid_request", "BundleFile download request is invalid.");
    }
    let info;
    try {
      info = await this.#discovery.getMindInfo(mcpActor, input.mind, input.revisionSelector);
    } catch (error) {
      if (error instanceof MindDiscoveryFailure) {
        throw new BundleFileDownloadFailure(
          error.code === "revision_not_found" ? "revision_not_found" : "mind_not_found",
          "BundleFile was not found.",
        );
      }
      throw error;
    }
    const initial = await this.#authorize(mcpActor, info.mind.mindId, info.revisionMode);
    const envelope = await this.#store.readRevision(info.mind.mindId, info.resolvedRevision.revisionId);
    if (
      envelope === null ||
      envelope.revision.manifestHash !== info.resolvedRevision.manifestHash
    ) throw new BundleFileDownloadFailure("revision_integrity_failure", "Exact revision failed integrity verification.");
    let manifest = envelope.manifest;
    try {
      if (
        manifest.format === REVISION_MANIFEST_FORMAT_V3 ||
        manifest.format === REVISION_MANIFEST_FORMAT_V4
      ) {
        const stored = await this.#objects.getSpaceCanonicalObject(
          "revision_manifest",
          info.mind.mindId,
          envelope.revision.manifestHash,
        );
        if (
          stored === null || stored.mediaType !== REVISION_MANIFEST_MEDIA_TYPE ||
          (envelope.revision.manifestSize !== undefined &&
            stored.size !== envelope.revision.manifestSize)
        ) throw new Error("missing manifest");
        manifest = parseRevisionManifest(
          new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes),
        );
        if (!revisionEnvelopesEqual({ revision: envelope.revision, manifest }, envelope)) {
          throw new Error("manifest projection mismatch");
        }
      } else if (
        (await this.#objects.calculateSha256(
          new TextEncoder().encode(serializeRevisionManifest(manifest)),
        )) !== envelope.revision.manifestHash
      ) throw new Error("manifest hash");
    } catch {
      throw new BundleFileDownloadFailure(
        "revision_integrity_failure",
        "Exact revision failed integrity verification.",
      );
    }
    const entry = manifest.entries.find((candidate) => candidate.path === path);
    if (entry === undefined || entry.kind !== "opaque") {
      throw new BundleFileDownloadFailure("bundle_file_not_found", "BundleFile was not found.");
    }
    const file = descriptor({
      path: entry.path,
      mediaType: entry.mediaType as BundleFileMediaType,
      size: entry.size,
      sha256: entry.sha256,
    }, envelope.revision.revisionId);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const issued = await this.#secrets.issueSecret();
      const secretVerifier = issued.verifier();
      const createdAt = this.#clock.now();
      const requestedExpiresAt = addMilliseconds(createdAt, this.#ttlMs);
      const created = await this.#store.runBundleFileDownloadGrantTransaction(async (transaction) => {
        const current = await this.#authorizer.reauthorizeInTransaction(
          {
            actor: mcpActor,
            spaceId: info.mind.mindId,
            capability: "content:fetch",
            revisionMode: info.revisionMode,
          },
          transaction,
          initial.stamp,
        );
        if (current.kind === "denied") return Object.freeze({ kind: "not_found" as const });
        const credentialState = await transaction.readCurrentAuthorizationState({
          principalId: mcpActor.principalId,
          spaceId: info.mind.mindId,
          tokenId: mcpActor.authentication.tokenId,
        });
        const token = credentialState?.token;
        const tokenExpiry = token === null || token === undefined
          ? Number.NaN
          : Date.parse(token.expiresAt);
        const createdTime = Date.parse(createdAt);
        if (
          token?.tokenId !== mcpActor.authentication.tokenId ||
          token.principalId !== mcpActor.principalId ||
          token.state !== "active" ||
          !Number.isFinite(tokenExpiry) ||
          tokenExpiry <= createdTime
        ) return Object.freeze({ kind: "not_found" as const });
        const expiresAt = new Date(
          Math.min(Date.parse(requestedExpiresAt), tokenExpiry),
        ).toISOString() as UtcInstant;
        const exact = await transaction.readRevision(info.mind.mindId, info.resolvedRevision.revisionId);
        const exactEntry = exact?.manifest.entries.find((candidate) => candidate.path === path);
        if (
          exactEntry?.kind !== "opaque" ||
          exactEntry.sha256 !== entry.sha256 || exactEntry.size !== entry.size ||
          exactEntry.mediaType !== entry.mediaType
        ) return Object.freeze({ kind: "not_found" as const });
        const grant: Readonly<BundleFileDownloadGrant> = Object.freeze({
          secretVerifier,
          requestedByPrincipalId: mcpActor.principalId,
          tokenId: mcpActor.authentication.tokenId,
          bindingOwnerId: mcpActor.authentication.bindingOwnerId,
          spaceId: info.mind.mindId,
          revisionId: info.resolvedRevision.revisionId,
          path,
          mediaType: entry.mediaType as BundleFileMediaType,
          sha256: entry.sha256,
          size: entry.size,
          state: "active",
          createdAt,
          expiresAt,
          consumedAt: null,
        });
        return transaction.createBundleFileDownloadGrant(grant);
      });
      if (created.kind === "secret_collision") continue;
      if (created.kind !== "created") {
        throw new BundleFileDownloadFailure("bundle_file_not_found", "BundleFile was not found.");
      }
      const secret = issued.consumeSecret();
      if (secret === null) throw new Error("BundleFile download secret was unavailable.");
      return Object.freeze({
        file,
        mind: info.mind,
        resolvedRevision: info.resolvedRevision,
        downloadUrl: `${this.#downloadUrlBase}/${secret}`,
        downloadExpiresAt: created.grant.expiresAt,
        disposition: file.inlineEligible ? "inline" : "attachment",
      });
    }
    throw new Error("BundleFile download secret repeatedly collided.");
  }

  async download(serviceActor: ActorContext, secret: unknown): Promise<BundleFileDownloadResponse> {
    if (serviceActor.kind !== "service") return Object.freeze({ kind: "not_found" });
    const now = this.#clock.now();
    const verified = await this.#secrets.verifySecret(secret, {
      findByVerifier: async (verifier) => {
        const result = await this.#store.readBundleFileDownloadGrant(verifier, now);
        return result.kind === "active"
          ? Object.freeze({ kind: "found" as const, verifier, value: result.grant })
          : Object.freeze({ kind: "not_found" as const });
      },
    });
    if (verified.kind !== "verified") return Object.freeze({ kind: "not_found" });
    const grant = verified.value;
    const actor: McpTokenActorContext = Object.freeze({
      kind: "registered_principal",
      principalId: grant.requestedByPrincipalId,
      authentication: Object.freeze({
        kind: "mcp_token",
        tokenId: grant.tokenId,
        bindingOwnerId: grant.bindingOwnerId,
        effectiveScopes: Object.freeze(["content:read"]) as EffectiveTokenScopes,
      }),
      deploymentCapabilities: Object.freeze(["content:fetch"] as const),
      requestId: serviceActor.requestId,
      occurredAtUtc: now,
    });
    const initial = await this.#authorizer.authorize({
      actor,
      spaceId: grant.spaceId,
      capability: "content:fetch",
      revisionMode: "historical",
    });
    if (initial.kind === "denied") return Object.freeze({ kind: "not_found" });
    const envelope = await this.#store.readRevision(grant.spaceId, grant.revisionId);
    const entry = envelope?.manifest.entries.find((candidate) => candidate.path === grant.path);
    if (
      entry?.kind !== "opaque" || entry.sha256 !== grant.sha256 ||
      entry.mediaType !== grant.mediaType || entry.size !== grant.size
    ) return Object.freeze({ kind: "not_found" });
    let object;
    try {
      object = await this.#objects.openBundleFile(grant.spaceId, grant.sha256);
    } catch {
      return Object.freeze({ kind: "not_found" });
    }
    if (
      object === null || object.mediaType !== grant.mediaType || object.size !== grant.size ||
      !(await verifyBody(object.body, grant.size, grant.sha256))
    ) return Object.freeze({ kind: "not_found" });

    const responseObject = await this.#objects.openBundleFile(grant.spaceId, grant.sha256);
    if (
      responseObject === null || responseObject.mediaType !== grant.mediaType ||
      responseObject.size !== grant.size
    ) return Object.freeze({ kind: "not_found" });

    const consumed = await this.#store.runBundleFileDownloadGrantTransaction(async (transaction) => {
      const current = await this.#authorizer.reauthorizeInTransaction(
        {
          actor,
          spaceId: grant.spaceId,
          capability: "content:fetch",
          revisionMode: "historical",
        },
        transaction,
        initial.stamp,
      );
      if (current.kind === "denied") return Object.freeze({ kind: "not_found" as const });
      const active = await transaction.readBundleFileDownloadGrant(grant.secretVerifier, this.#clock.now());
      if (
        active.kind !== "active" || active.grant.spaceId !== grant.spaceId ||
        active.grant.revisionId !== grant.revisionId || active.grant.path !== grant.path ||
        active.grant.sha256 !== grant.sha256
      ) return Object.freeze({ kind: "not_found" as const });
      return transaction.consumeBundleFileDownloadGrant(grant.secretVerifier, this.#clock.now());
    });
    if (consumed.kind !== "consumed") return Object.freeze({ kind: "not_found" });

    const displayName = filename(grant.path);
    const disposition = RASTER_TYPES.has(grant.mediaType) ? "inline" : "attachment";
    return Object.freeze({
      kind: "download",
      headers: Object.freeze({
        "Content-Type": grant.mediaType,
        "Content-Length": String(grant.size),
        ETag: `"${grant.sha256}"`,
        "Content-Disposition": `${disposition}; filename="${asciiFallback(displayName)}"; filename*=UTF-8''${rfc5987(displayName)}`,
        "Cache-Control": "no-store",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cross-Origin-Resource-Policy": "same-origin",
        ...(disposition === "inline" ? { "Content-Security-Policy": "sandbox" } : {}),
      }),
      body: responseObject.body,
    });
  }

  async #authorize(
    actor: McpTokenActorContext,
    spaceId: SpaceId,
    revisionMode: RevisionMode,
  ): Promise<AllowedAuthorization> {
    const decision = await this.#authorizer.authorize({
      actor,
      spaceId,
      capability: "content:fetch",
      revisionMode,
    });
    if (decision.kind === "allowed") return decision;
    if (
      decision.code === "mind_binding_required" ||
      decision.code === "binding_owner_revoked" ||
      decision.code === "binding_state_unavailable"
    ) throw new BundleFileDownloadFailure(decision.code, "Mind binding is unavailable.", decision.retryable);
    throw new BundleFileDownloadFailure("bundle_file_not_found", "BundleFile was not found.");
  }
}
