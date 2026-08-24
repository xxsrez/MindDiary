export const CONNECTOR_OBJECT_BRIDGE_FIXTURES = Object.freeze({
  png: Object.freeze({
    filename: "drive-object.png",
    mediaType: "image/png",
    bytes: Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x01, 0x02, 0x03,
    ]),
  }),
  pdf: Object.freeze({
    filename: "drive-object.pdf",
    mediaType: "application/pdf",
    bytes: new TextEncoder().encode("%PDF-1.7\nsynthetic connector object\n"),
  }),
  zip: Object.freeze({
    filename: "drive-object.zip",
    mediaType: "application/zip",
    // Opaque ZIP fixture. The companion never enumerates or extracts members.
    bytes: Uint8Array.from([
      0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x6f, 0x70, 0x61, 0x71, 0x75, 0x65,
    ]),
  }),
});
