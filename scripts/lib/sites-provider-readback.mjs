import { createHash } from "node:crypto";

import { fail, isRecord } from "./multi-principal-probe-core.mjs";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const PROVIDER_VERSION = /^(?:appgver_[a-z0-9]+|appgprj_[a-z0-9]+~appgver_[a-z0-9]+)$/u;

export function isProviderVersionId(value) {
  return typeof value === "string" && PROVIDER_VERSION.test(value);
}

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizedSha256(value, code) {
  if (typeof value !== "string") fail(code);
  const normalized = value.startsWith("sha256:") ? value : `sha256:${value}`;
  if (!SHA256.test(normalized)) fail(code);
  return normalized;
}

export function providerTimestamp(value, code) {
  if (typeof value !== "string" || !RFC3339.test(value) || Number.isNaN(Date.parse(value))) {
    fail(code);
  }
  return new Date(value).toISOString();
}

export function providerVersionId(value, code) {
  if (!isProviderVersionId(value)) fail(code);
  return value;
}

export function providerArchiveBinding({
  archiveBytes,
  storages,
  invalidCode,
}) {
  if (!Buffer.isBuffer(archiveBytes) || archiveBytes.byteLength < 1 ||
      !Array.isArray(storages) || storages.length < 1) fail(invalidCode);
  const normalized = storages.map((storage) => {
    if (!isRecord(storage) || !["tar", "tar.gz"].includes(storage.archive_format) ||
        !Number.isSafeInteger(storage.size_bytes) || storage.size_bytes < 1 ||
        (storage.file_count !== undefined && storage.file_count !== null &&
          (!Number.isSafeInteger(storage.file_count) || storage.file_count < 1))) {
      fail(invalidCode);
    }
    return Object.freeze({
      sha256: normalizedSha256(storage.content_hash, invalidCode),
      sizeBytes: storage.size_bytes,
      fileCount: storage.file_count ?? null,
      format: storage.archive_format,
    });
  });
  const provider = normalized[0];
  if (normalized.some((storage) =>
    storage.sha256 !== provider.sha256 || storage.sizeBytes !== provider.sizeBytes ||
    storage.fileCount !== provider.fileCount || storage.format !== provider.format)) {
    fail(invalidCode);
  }
  return Object.freeze({
    uploadArchiveSha256: sha256Bytes(archiveBytes),
    uploadArchiveSizeBytes: archiveBytes.byteLength,
    providerArchiveSha256: provider.sha256,
    providerArchiveSizeBytes: provider.sizeBytes,
    providerArchiveFileCount: provider.fileCount,
    providerArchiveFormat: provider.format,
  });
}
