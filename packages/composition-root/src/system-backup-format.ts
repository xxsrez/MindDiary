import {
  MARKDOWN_MEDIA_TYPE,
  REVISION_MANIFEST_FORMAT_V1,
  REVISION_MANIFEST_FORMAT_V2,
  REVISION_MANIFEST_FORMAT_V3,
  REVISION_MANIFEST_FORMAT_V4,
} from "@mind-diary/domain";
import { REVISION_MANIFEST_MEDIA_TYPE } from "@mind-diary/application-ports";

export const SYSTEM_BACKUP_FORMAT = "MD-SYSTEM-BACKUP-1" as const;
export const SYSTEM_BACKUP_PAGE_BYTES = 128 * 1024;
export const SYSTEM_BACKUP_FRAGMENT_BYTES = 64 * 1024;

// Keep this exact list in sync with backup-completeness-registry.mjs. Other
// durable snapshot fields are deliberately rebuilt, reset or revoked.
export const SYSTEM_BACKUP_EXACT_FIELDS = Object.freeze([
  "spaces",
  "revisionsById",
  "auditEvents",
  "principals",
  "externalBindings",
  "knowledgeSpaces",
  "personalBindings",
  "memberships",
  "principalMindUsageOwners",
  "activeHandlesByKey",
  "activeHandlesBySpace",
  "retiredHandles",
] as const);

export interface SystemBackupRecord {
  readonly key: string;
  readonly payload: string;
  readonly sha256: string;
}

export interface SystemBackupObjectSeed {
  readonly namespace: "immutable" | "space_canonical" | "bundle_file";
  readonly key: string;
  readonly fallbackKey: string | null;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
}

export interface SystemBackupPage {
  readonly index: number;
  readonly payload: string;
  readonly sha256: string;
  readonly byteSize: number;
}

export interface SystemBackupDelta {
  readonly pages: readonly SystemBackupPage[];
  readonly recordDigests: ReadonlyMap<string, string>;
  readonly targetDigest: string;
}

export function systemBackupTargetDigest(
  digests: ReadonlyMap<string, string>,
): Promise<string> {
  return systemBackupSha256(JSON.stringify({
    format: SYSTEM_BACKUP_FORMAT,
    records: [...digests].sort(([left], [right]) => compareText(left, right)),
  }));
}

function canonicalValue(value: unknown): unknown {
  if (value === undefined) return { __md_backup_type: "undefined" };
  if (value instanceof Uint8Array) {
    return { __md_backup_type: "uint8array", bytes: [...value] };
  }
  if (value instanceof Map) {
    const entries = [...value.entries()].map(([key, item]) => [
      canonicalValue(key), canonicalValue(item),
    ] as const);
    entries.sort((left, right) =>
      compareText(JSON.stringify(left[0]), JSON.stringify(right[0])));
    return { __md_backup_type: "map", entries };
  }
  if (value instanceof Set) {
    const values = [...value.values()].map(canonicalValue);
    values.sort((left, right) =>
      compareText(JSON.stringify(left), JSON.stringify(right)));
    return { __md_backup_type: "set", values };
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    return { __md_backup_type: "object", entries: Object.keys(source).sort()
      .map((key) => [key, canonicalValue(source[key])]) };
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("system backup metadata contains a non-finite number");
  }
  if (typeof value === "bigint" || typeof value === "function" ||
    typeof value === "symbol") {
    throw new TypeError("system backup metadata contains an unsupported value");
  }
  return value;
}

/** Inverse of canonicalValue. Plain objects are tagged, so source metadata
 * cannot masquerade as a Map/Set/byte marker. */
export function decodeSystemBackupValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeSystemBackupValue);
  if (typeof value !== "object" || value === null) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("system backup contains a non-finite number");
    }
    return value;
  }
  const tagged = value as Record<string, unknown>;
  if (tagged.__md_backup_type === "undefined" &&
    Object.keys(tagged).length === 1) return undefined;
  if (tagged.__md_backup_type === "uint8array" &&
    Object.keys(tagged).length === 2 && Array.isArray(tagged.bytes) &&
    tagged.bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return new Uint8Array(tagged.bytes as number[]);
  }
  if (tagged.__md_backup_type === "set" &&
    Object.keys(tagged).length === 2 && Array.isArray(tagged.values)) {
    const values = tagged.values.map(decodeSystemBackupValue);
    if (new Set(values).size !== values.length) {
      throw new TypeError("system backup Set contains duplicate values");
    }
    return new Set(values);
  }
  if ((tagged.__md_backup_type === "map" ||
      tagged.__md_backup_type === "object") &&
    Object.keys(tagged).length === 2 && Array.isArray(tagged.entries)) {
    const entries = tagged.entries.map((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new TypeError("system backup entry is malformed");
      }
      return [decodeSystemBackupValue(entry[0]),
        decodeSystemBackupValue(entry[1])] as const;
    });
    if (tagged.__md_backup_type === "map") {
      const result = new Map(entries);
      if (result.size !== entries.length) {
        throw new TypeError("system backup Map contains duplicate keys");
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      if (typeof key !== "string" || Object.hasOwn(result, key)) {
        throw new TypeError("system backup object key is invalid or duplicate");
      }
      Object.defineProperty(result, key, {
        value: item, enumerable: true, writable: true, configurable: true,
      });
    }
    return result;
  }
  throw new TypeError("system backup tagged value is unsupported");
}

function compareText(left: string, right: string): number {
  // SQLite BINARY ordering uses UTF-8 bytes. Match it so a local catalog can
  // verify the root digest as a stream without loading all record keys.
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export async function systemBackupSha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256", new Uint8Array(bytes).buffer,
  ));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function snapshotMaps(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("system backup metadata snapshot is invalid");
  }
  const snapshot = value as Record<string, unknown>;
  if (snapshot.v !== 5 || SYSTEM_BACKUP_EXACT_FIELDS.some((field) =>
    !(snapshot[field] instanceof Map))) {
    throw new TypeError("system backup metadata snapshot version or fields are unsupported");
  }
  return snapshot;
}

export async function systemBackupRecords(value: unknown): Promise<readonly SystemBackupRecord[]> {
  const snapshot = snapshotMaps(value);
  const records: SystemBackupRecord[] = [];
  for (const field of SYSTEM_BACKUP_EXACT_FIELDS) {
    for (const [id, item] of snapshot[field] as Map<unknown, unknown>) {
      if (typeof id !== "string") {
        throw new TypeError(`system backup ${field} record identifier is invalid (${typeof id})`);
      }
      // The in-memory spaces map duplicates every envelope already held in
      // revisionsById. Transfer only the exact HEAD; offline restore rebuilds
      // its per-Space revision map from the individual immutable envelopes.
      const projected = field === "spaces"
        ? (() => {
            if (typeof item !== "object" || item === null ||
              !("revisions" in item) ||
              !((item as { revisions: unknown }).revisions instanceof Map) ||
              !("head" in item)) {
              throw new TypeError("system backup Space revision state is invalid");
            }
            return { head: (item as { head: unknown }).head };
          })()
        : item;
      const payload = canonicalJson(projected);
      records.push(Object.freeze({
        // A JSON tuple is unambiguous and survives SQLite clients that
        // truncate TEXT at NUL on read (including Node 22's node:sqlite).
        key: JSON.stringify([field, id]),
        payload,
        sha256: await systemBackupSha256(payload),
      }));
    }
  }
  records.sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  return Object.freeze(records);
}

export function systemBackupObjectSeeds(value: unknown): readonly SystemBackupObjectSeed[] {
  const snapshot = snapshotMaps(value);
  const revisions = snapshot.revisionsById as Map<string, unknown>;
  const seeds = new Map<string, SystemBackupObjectSeed>();
  const add = (seed: SystemBackupObjectSeed) => {
    const existing = seeds.get(seed.key);
    if (existing !== undefined &&
      (existing.sha256 !== seed.sha256 || existing.size !== seed.size ||
        existing.mediaType !== seed.mediaType ||
        existing.namespace !== seed.namespace ||
        existing.fallbackKey !== seed.fallbackKey)) {
      throw new TypeError("system backup object identity is inconsistent");
    }
    seeds.set(seed.key, Object.freeze(seed));
  };
  for (const envelopeValue of revisions.values()) {
    if (typeof envelopeValue !== "object" || envelopeValue === null) {
      throw new TypeError("system backup revision envelope is invalid");
    }
    const envelope = envelopeValue as {
      revision?: { spaceId?: unknown; manifestHash?: unknown; manifestSize?: unknown };
      manifest?: { format?: unknown; entries?: unknown };
    };
    const spaceId = envelope.revision?.spaceId;
    const manifestHash = envelope.revision?.manifestHash;
    const format = envelope.manifest?.format;
    const entries = envelope.manifest?.entries;
    if (typeof spaceId !== "string" || typeof manifestHash !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(manifestHash) || !Array.isArray(entries)) {
      throw new TypeError("system backup revision envelope is invalid");
    }
    const modern = format === REVISION_MANIFEST_FORMAT_V3 ||
      format === REVISION_MANIFEST_FORMAT_V4;
    if (!modern && format !== REVISION_MANIFEST_FORMAT_V1 &&
      format !== REVISION_MANIFEST_FORMAT_V2) {
      throw new TypeError("system backup revision manifest format is unsupported");
    }
    if (modern) {
      const key = `spaces/${encodeURIComponent(spaceId)}/manifests/sha256/${manifestHash.slice(7)}`;
      add({
        namespace: "space_canonical", key, fallbackKey: null,
        sha256: manifestHash,
        size: typeof envelope.revision?.manifestSize === "number"
          ? envelope.revision.manifestSize : -1,
        mediaType: REVISION_MANIFEST_MEDIA_TYPE,
      });
    }
    for (const entryValue of entries) {
      if (typeof entryValue !== "object" || entryValue === null) {
        throw new TypeError("system backup manifest entry is invalid");
      }
      const entry = entryValue as Record<string, unknown>;
      if (typeof entry.sha256 !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(entry.sha256) ||
        typeof entry.size !== "number" || entry.size < 0 ||
        !Number.isSafeInteger(entry.size)) {
        throw new TypeError("system backup manifest entry is invalid");
      }
      let key: string;
      let fallbackKey: string | null = null;
      let namespace: SystemBackupObjectSeed["namespace"];
      let mediaType: string;
      if (entry.kind === "opaque") {
        key = `bundle-files/${encodeURIComponent(spaceId)}/sha256/${entry.sha256.slice(7)}`;
        namespace = "bundle_file";
        mediaType = String(entry.mediaType);
      } else if (entry.kind === "markdown" && modern) {
        key = `spaces/${encodeURIComponent(spaceId)}/objects/sha256/${entry.sha256.slice(7)}`;
        fallbackKey = `canonical/sha256/${entry.sha256.slice(7)}`;
        namespace = "space_canonical";
        mediaType = MARKDOWN_MEDIA_TYPE;
      } else if (entry.kind === "markdown") {
        key = `canonical/sha256/${entry.sha256.slice(7)}`;
        namespace = "immutable";
        mediaType = MARKDOWN_MEDIA_TYPE;
      } else {
        throw new TypeError("system backup manifest entry kind is invalid");
      }
      add({
        namespace, key, fallbackKey,
        sha256: entry.sha256,
        size: entry.size,
        mediaType,
      });
    }
  }
  return Object.freeze([...seeds.values()].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8_192));
  }
  return btoa(binary);
}

export async function systemBackupDelta(
  records: readonly SystemBackupRecord[],
  base: ReadonlyMap<string, string>,
): Promise<SystemBackupDelta> {
  const target = new Map(records.map((record) => [record.key, record.sha256]));
  const changes: unknown[] = [];
  for (const record of records) {
    if (base.get(record.key) === record.sha256) continue;
    const bytes = new TextEncoder().encode(record.payload);
    const count = Math.max(1, Math.ceil(bytes.byteLength / SYSTEM_BACKUP_FRAGMENT_BYTES));
    for (let index = 0; index < count; index += 1) {
      changes.push({
        kind: "upsert", key: record.key, sha256: record.sha256,
        part_index: index, part_count: count,
        data_base64: base64(bytes.subarray(
          index * SYSTEM_BACKUP_FRAGMENT_BYTES,
          Math.min(bytes.byteLength, (index + 1) * SYSTEM_BACKUP_FRAGMENT_BYTES),
        )),
      });
    }
  }
  for (const key of [...base.keys()].sort()) {
    if (!target.has(key)) changes.push({ kind: "delete", key });
  }
  const pages: SystemBackupPage[] = [];
  let current: unknown[] = [];
  let currentBytes = 2;
  const flush = async () => {
    const payload = JSON.stringify(current);
    pages.push(Object.freeze({
      index: pages.length, payload,
      sha256: await systemBackupSha256(payload),
      byteSize: new TextEncoder().encode(payload).byteLength,
    }));
    current = [];
    currentBytes = 2;
  };
  for (const change of changes) {
    const size = new TextEncoder().encode(JSON.stringify(change)).byteLength + 1;
    if (size + 2 > SYSTEM_BACKUP_PAGE_BYTES) {
      throw new TypeError("system backup record fragment exceeds page bound");
    }
    if (current.length > 0 && currentBytes + size > SYSTEM_BACKUP_PAGE_BYTES) {
      await flush();
    }
    current.push(change);
    currentBytes += size;
  }
  await flush();
  const targetDigest = await systemBackupTargetDigest(target);
  return Object.freeze({
    pages: Object.freeze(pages),
    recordDigests: target,
    targetDigest,
  });
}
