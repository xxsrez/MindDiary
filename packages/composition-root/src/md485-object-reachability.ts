import type { R2BucketLike } from "@mind-diary/adapter-object-sites";
import { createSitesMetadataStore, type D1DatabaseLike } from "@mind-diary/adapter-metadata-sites";
import type { ProductSitesIdentityResolution, ProductWebActor } from "@mind-diary/adapter-web";

/** Temporary read-only UAT projection for the user-authorized MD-485 diagnosis. */
export const MD485_OBJECT_REACHABILITY_PATH =
  "/md485-diagnostic";

const RESERVATION_CREATED = "2026-09-20T15:02:59.165Z";
const RESERVATION_EXPIRES = "2026-09-20T15:17:59.165Z";
const MAX_OBJECTS = 4096;
const HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

function respond(status: number, data: unknown, html = false): Response {
  if (html && status === 200) {
    const escaped = JSON.stringify(data, null, 2).replace(/[&<>"']/gu, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char] ?? char);
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>MD-485 UAT diagnostic</title></head><body><pre>${escaped}</pre></body></html>`, {
      status, headers: { ...HEADERS, "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" },
    });
  }
  return new Response(`${JSON.stringify(data)}\n`, { status, headers: HEADERS });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function safeAmounts(value: unknown): Record<string, number> | null {
  const source = record(value);
  if (source === null) return null;
  const names = ["physicalCanonicalBytes", "temporaryBytes", "d1MetadataBytes"];
  if (!names.every((name) => Number.isSafeInteger(source[name]) && (source[name] as number) >= 0)) return null;
  return Object.fromEntries(names.map((name) => [name, source[name] as number]));
}

function safeUtc(value: unknown): value is string {
  return typeof value === "string" &&
    /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

async function listPrefix(bucket: R2BucketLike, prefix: string) {
  const rows: Array<{ key: string; size: number; customMetadata?: Readonly<Record<string, string>> }> = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const page = await bucket.list({ prefix, ...(cursor === undefined ? {} : { cursor }),
      limit: 1000, include: ["customMetadata"] });
    if (page.objects.length > 1000 || rows.length + page.objects.length > MAX_OBJECTS ||
        page.objects.some((item) => !item.key.startsWith(prefix) ||
          !Number.isSafeInteger(item.size) || item.size < 0)) {
      throw new Error("object inventory outside diagnostic bound");
    }
    rows.push(...page.objects);
    if (!page.truncated) return rows;
    if (!page.cursor || cursors.has(page.cursor)) throw new Error("object inventory incomplete");
    cursor = page.cursor;
    cursors.add(cursor);
  } while (rows.length < MAX_OBJECTS);
  throw new Error("object inventory too large");
}

export function authorizeMd485ObjectReachability(input: {
  readonly resolveIdentity: (request: Request) => Promise<ProductSitesIdentityResolution>;
  readonly operatorPrincipalIds: ReadonlySet<string>;
  readonly resolveTargetMind: (actor: ProductWebActor) => Promise<{
    readonly isPersonal: boolean;
    readonly mindId: string;
    readonly access: { readonly kind: string; readonly role: string | null };
  }>;
}): (request: Request) => Promise<string | null> {
  return async (request) => {
    const identity = await input.resolveIdentity(request);
    if (identity.kind !== "authenticated" ||
        identity.actor.authentication.kind !== "sites_identity" ||
        !input.operatorPrincipalIds.has(identity.actor.principalId)) return null;
    try {
      const mind = await input.resolveTargetMind(identity.actor);
      return !mind.isPersonal && mind.access.kind === "membership" &&
        mind.access.role === "owner" ? mind.mindId : null;
    } catch { return null; }
  };
}

export function createMd485ProductObjectReachability(input: {
  readonly bucket: R2BucketLike;
  readonly database: D1DatabaseLike;
  readonly metadata: Awaited<ReturnType<typeof createSitesMetadataStore>>;
  readonly resolveIdentity: (request: Request) => Promise<ProductSitesIdentityResolution>;
  readonly operatorPrincipalIds: ReadonlySet<string>;
  readonly resolveTargetMind: (actor: ProductWebActor) => Promise<{
    readonly isPersonal: boolean;
    readonly mindId: string;
    readonly access: { readonly kind: string; readonly role: string | null };
  }>;
}): (request: Request) => Promise<Response> {
  return createMd485ObjectReachability({
    bucket: input.bucket,
    readSequence: async () => {
      const rows = await input.database.prepare(
        "SELECT backup_sequence AS sequence FROM md_backup_control WHERE singleton_id = 1",
      ).all<{ sequence: number }>();
      const row = rows.results?.[0];
      if (!Number.isSafeInteger(row?.sequence)) throw new Error("metadata sequence unavailable");
      return row!.sequence;
    },
    readMetadata: (mindId) => input.metadata.withConsistentRead(async (store) => ({
      reservations: await store.listCapacityReservationsForSpace(mindId as never),
      reachable: await store.listReachableSpaceCanonicalObjectsForSpace(mindId as never),
    })),
    authorizedMindId: authorizeMd485ObjectReachability(input),
  });
}

export function createMd485ObjectReachability(input: {
  readonly bucket: R2BucketLike;
  readonly readSequence: () => Promise<number>;
  readonly readMetadata: (mindId: string) => Promise<Readonly<{
    reservations: readonly unknown[];
    reachable: readonly Readonly<{
      kind: "markdown" | "revision_manifest"; spaceId: string; sha256: string;
    }>[];
  }>>;
  readonly authorizedMindId: (request: Request) => Promise<string | null>;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "GET" || new URL(request.url).search !== "") {
      return respond(404, { ok: false, error: "not_found" });
    }
    const mindId = await input.authorizedMindId(request).catch(() => null);
    if (mindId === null || !/^[A-Za-z0-9_-]{1,128}$/u.test(mindId)) {
      return respond(404, { ok: false, error: "not_found" });
    }
    try {
      const beforeSequence = await input.readSequence();
      const metadata = await input.readMetadata(mindId);
      const matches = metadata.reservations.filter((value) => {
        const item = record(value);
        return item?.spaceId === mindId && item.operation === "commit" &&
          item.createdAt === RESERVATION_CREATED && item.expiresAt === RESERVATION_EXPIRES;
      });
      if (matches.length !== 1) throw new Error("target reservation ambiguous");
      const reservation = record(matches[0]);
      const requested = safeAmounts(reservation?.requested);
      if (reservation === null || requested === null ||
          requested.physicalCanonicalBytes !== 6_961_159 ||
          typeof reservation.reservationId !== "string") {
        throw new Error("target reservation mismatch");
      }
      const root = `spaces/${encodeURIComponent(mindId)}/`;
      const [markdown, manifests, sidecars] = await Promise.all([
        listPrefix(input.bucket, `${root}objects/sha256/`),
        listPrefix(input.bucket, `${root}manifests/sha256/`),
        listPrefix(input.bucket, `${root}integrity/`),
      ]);
      const reachableKeys = new Set(metadata.reachable.filter((item) => item.spaceId === mindId)
        .map((item) => `${item.kind}\u0000${item.sha256}`));
      const summary = {
        canonical_count: 0, canonical_bytes: 0,
        reachable_count: 0, reachable_bytes: 0,
        unreachable_count: 0, unreachable_bytes: 0,
        window_count: 0, window_bytes: 0,
        window_unreachable_count: 0, window_unreachable_bytes: 0,
        invalid_metadata_count: 0,
      };
      for (const [kind, objects] of [["markdown", markdown], ["revision_manifest", manifests]] as const) {
        for (const item of objects) {
          const digest = item.key.slice(item.key.lastIndexOf("/") + 1);
          if (!/^[0-9a-f]{64}$/u.test(digest)) throw new Error("canonical key invalid");
          const metadata = item.customMetadata;
          const valid = metadata?.spaceId === mindId && metadata.kind === kind &&
            metadata.sha256 === `sha256:${digest}` && safeUtc(metadata.createdAt);
          const created = valid ? metadata.createdAt : undefined;
          const inWindow = created !== undefined && created >= RESERVATION_CREATED &&
            created <= RESERVATION_EXPIRES;
          const isReachable = reachableKeys.has(`${kind}\u0000sha256:${digest}`);
          summary.canonical_count += 1;
          summary.canonical_bytes += item.size;
          if (!valid) summary.invalid_metadata_count += 1;
          if (isReachable) {
            summary.reachable_count += 1;
            summary.reachable_bytes += item.size;
          } else {
            summary.unreachable_count += 1;
            summary.unreachable_bytes += item.size;
          }
          if (inWindow) {
            summary.window_count += 1;
            summary.window_bytes += item.size;
            if (!isReachable) {
              summary.window_unreachable_count += 1;
              summary.window_unreachable_bytes += item.size;
            }
          }
        }
      }
      const afterSequence = await input.readSequence();
      const stillAuthorized = await input.authorizedMindId(request).catch(() => null);
      if (afterSequence !== beforeSequence || stillAuthorized !== mindId) {
        throw new Error("metadata changed during diagnostic read");
      }
      return respond(200, { ok: true, data: {
        incident: "MD-485/UAT191", metadata_sequence: beforeSequence,
        reservation: {
          reservation_id: reservation.reservationId,
          operation: reservation.operation, state: reservation.state,
          created_at: reservation.createdAt, expires_at: reservation.expiresAt,
          writer_closed_at: reservation.writerClosedAt ?? null,
          requested, actual: safeAmounts(reservation.actual),
        },
        objects: { ...summary,
          integrity_sidecar_count: sidecars.length,
          integrity_sidecar_bytes: sidecars.reduce((sum, item) => sum + item.size, 0),
        },
        limitation: "Creation time is only a candidate association. R2 and D1 are not one atomic snapshot; an unsettled writer may change R2 later. No contents were read or changed.",
      } }, request.headers.get("accept")?.includes("text/html") ?? false);
    } catch {
      return respond(503, { ok: false, error: "diagnostic_unavailable" });
    }
  };
}
