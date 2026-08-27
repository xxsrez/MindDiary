import { createHash } from "node:crypto";

const encoder = new TextEncoder();

function fixture(value) {
  return Object.freeze({
    ...value,
    bytes: value.bytes instanceof Uint8Array
      ? value.bytes
      : encoder.encode(value.bytes),
  });
}

export const GOOGLE_DRIVE_FIXTURES = Object.freeze({
  binary: fixture({
    objectId: "drive_binary_object",
    name: "opaque-source.bin",
    mediaType: "application/octet-stream",
    version: "17",
    headRevisionId: "drive_binary_revision_17",
    bytes: Uint8Array.from([0x00, 0xff, 0x10, 0x20, 0x30, 0x40]),
  }),
  document: fixture({
    objectId: "drive_native_document",
    name: "Synthetic document",
    mediaType: "application/vnd.google-apps.document",
    version: "21",
    format: "google-drive/docx",
    exportMediaType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    displayFilename: "synthetic-document.docx",
    bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x44, 0x4f, 0x43, 0x58]),
  }),
  spreadsheet: fixture({
    objectId: "drive_native_spreadsheet",
    name: "Synthetic sheet",
    mediaType: "application/vnd.google-apps.spreadsheet",
    version: "22",
    format: "google-drive/xlsx",
    exportMediaType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    displayFilename: "synthetic-sheet.xlsx",
    bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x58, 0x4c, 0x53, 0x58]),
  }),
  presentation: fixture({
    objectId: "drive_native_presentation",
    name: "Synthetic slides",
    mediaType: "application/vnd.google-apps.presentation",
    version: "23",
    format: "google-drive/pptx",
    exportMediaType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    displayFilename: "synthetic-slides.pptx",
    bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x50, 0x50, 0x54, 0x58]),
  }),
});

export function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function driveMetadata(fixture, overrides = {}) {
  const binary = !fixture.mediaType.startsWith("application/vnd.google-apps.");
  return {
    id: fixture.objectId,
    name: fixture.name,
    mimeType: fixture.mediaType,
    ...(binary
      ? {
          size: String(fixture.bytes.byteLength),
          sha256Checksum: sha256(fixture.bytes).slice("sha256:".length),
          headRevisionId: fixture.headRevisionId,
        }
      : {}),
    trashed: false,
    capabilities: { canDownload: true },
    version: fixture.version,
    ownedByMe: true,
    owners: [{ permissionId: "drive_owner_permission" }],
    ...overrides,
  };
}
