# BundleFile: versioned attachments в Mind

Статус: accepted, 2026-08-22. `normative_status: accepted`;
`implementation_status: read_export_implemented_local`: MD-247 реализует manifest
v1/v2, Space-scoped opaque objects, binding-pinned staging, mixed atomic commit,
Markdown-only indexing, exact historical bytes и bounded GC в memory/Sites
adapters. MD-248 добавляет deterministic `stage_bundle_file`, bounded
OpenAI-native HTTPS ingress, binding-owner idempotency и BundleFile operations
в MCP schema на обоих profiles. MD-249 реализует exact-revision list,
one-use reauthorized download, Markdown reference validation и deterministic
dual export в local candidate. Real-client exact-SHA UAT evidence остаётся
MD-250. Этот
producer-defined contract расширяет Mind Diary, но не изменяет Open Knowledge
Format 0.2 и не объявляет `BundleFile` нормативной OKF entity.

Release applicability: технический contract сохраняется, но
[ADR-0019](../decisions/0019-release-0-1-codex-first-small-data-boundary.md)
переносит весь BundleFile slice в post-MVP. MD-250 обязателен только перед
claim о hosted/native BundleFile support; его отсутствие не блокирует
Markdown-first Release 0.1.

MD-271 добавляет общий [file-ingress contract](file-ingress.md) и source
capability matrix для bytes, которые могут попасть в этот `BundleFile` slice.
В текущем candidate `session_attachment` подключён через OpenAI-native MCP
parameter, `bounded_in_memory` и `server_generated` используют локальный shared
staging/streaming pipeline, а MD-272 подключает repository-local companion для
`local_path` и `workspace/generated_artifact`. Native client UAT,
hosted upload-intent/producer evidence и `connector_object` adapter остаются
отдельными gates; это не разрешает silent base64, arbitrary
URL или local-path fallback.

## Контекст и граница решения

Проверенный внешний факт: OKF 0.2 задаёт переносимое дерево Markdown и ссылки
на resources, но не задаёт binary manifest, upload protocol, MIME policy,
revisions, ACL или export container для произвольных bytes. Требование этого
post-MVP slice: одна immutable `SpaceRevision` должна атомарно version-ить
Markdown и приложенные raster image, PDF или ZIP, а historical read/export —
сохранять их exact bytes.

Принятое решение: техническая service entity называется `BundleFile`, а в UI
используются attachment/asset. `BundleFile` остаётся opaque canonical file:
сервис не извлекает из него текст, не индексирует, не исполняет и не превращает
его содержимое в authority. Browser content editor/file manager, OCR,
transcription, archive import/extraction, granular file ACL и production release
в этот slice не входят.

Все source kinds проходят один adapter-to-application boundary. Adapter
заканчивает provider ID/temporary URL, absolute path или connector credential;
application получает exact bytes и безопасные canonical metadata, а staging
записывает safe `source_kind` рядом с digest/size/media type. Source kind не
является частью authorization identity или manifest path; нормативные детали
этой границы находятся в [file-ingress specification](file-ingress.md).

## Revision manifest v2

Каждая новая revision после включения feature записывает service manifest:

```json
{
  "format": "mind-diary-revision-manifest-v2",
  "entries": [
    {
      "path": "concepts/trip.md",
      "kind": "markdown",
      "sha256": "sha256:<64 lowercase hex>",
      "media_type": "text/markdown; charset=utf-8",
      "size": 1234
    },
    {
      "path": "attachments/map.png",
      "kind": "opaque",
      "sha256": "sha256:<64 lowercase hex>",
      "media_type": "image/png",
      "size": 4567
    }
  ]
}
```

- Manifest — service envelope outside OKF content. ACL, memberships, provider
  IDs, staging state, download grants, audit и indexes в него не входят.
- `kind` is exactly `markdown | opaque`. Markdown сохраняет existing media type
  and codec rules; opaque entry uses the detected canonical media type.
- Entries have unique canonical paths and deterministic Unicode-scalar ordering.
  Digest and size always describe exact immutable object bytes.
- Existing `mind-diary-revision-manifest-v1` remains readable forever and is
  normalized in memory as `kind: markdown`; committed v1 bytes/hash never
  переписываются. Следующая ordinary commit создаёт v2 без bulk migration.
- Search/index jobs consume only `kind: markdown`. Opaque files are not
  `KnowledgeEntry`, snippets or MCP text Resources.

Object keys and physical deduplication are scoped by `space_id`; a digest in
одном Mind не даёт lookup/existence signal о другом Mind. HEAD quota counts
logical manifest bytes; retained quota counts unique objects reachable from all
revisions of the same Space.

## Canonical paths и Markdown references

Новый opaque path:

- relative to bundle root, no leading `/`, backslash, empty/`.`/`..` segment,
  control character, encoded slash/backslash or scheme/authority;
- already Unicode NFC; server rejects rather than silently rewrites non-NFC;
- at most 1024 UTF-8 bytes total and 255 UTF-8 bytes per segment;
- must not end in `.md` and must not begin with reserved `.mind-diary/`;
- compares for collision after NFC normalization across Markdown and opaque
  entries. Exact stored path and Unicode filename survive history/export.

Display filename is basename-only, NFC, 1–255 UTF-8 bytes, without separators,
controls or `.`/`..`. It is safe response metadata, not canonical identity;
canonical identity remains revision + path.

Markdown uses ordinary relative inline/reference links and image syntax. A
local destination resolves against the Markdown file directory after one
percent-decode per segment; fragment is ignored for target resolution, query,
scheme, authority and root escape are forbidden. External `https:` links are
not BundleFile references and remain ordinary untrusted links.

Full-revision validation emits deterministic producer diagnostics:

| Code | Class | Meaning |
|---|---|---|
| `bundle_file_reference_escape` | conformance error | Local target leaves the bundle or is ambiguous. |
| `bundle_file_reference_missing` | conformance error | Local file target is absent from the exact manifest. |
| `bundle_file_inline_disallowed` | conformance error | Markdown image syntax targets non-inline media. |
| `bundle_file_reference_media_mismatch` | quality warning | Link label/extension conflicts with detected manifest media type. |

Therefore replacing/deleting a referenced file must update the referring
Markdown in the same atomic changeset. Links resolve only inside the selected
revision and never follow HEAD implicitly.

## First-slice type and containment policy

Detected bytes, not filename or client/provider MIME, select the canonical media
type. Declared MIME and extension are hints that must agree with detection.

| Canonical media type | Accepted extensions | Detection | Serving |
|---|---|---|---|
| `image/png` | `.png` | PNG signature | inline or attachment |
| `image/jpeg` | `.jpg`, `.jpeg` | JPEG SOI signature | inline or attachment |
| `image/gif` | `.gif` | GIF87a/GIF89a | inline or attachment |
| `image/webp` | `.webp` | RIFF + WEBP signature | inline or attachment |
| `application/pdf` | `.pdf` | `%PDF-` signature | attachment only |
| `application/zip` | `.zip` | accepted ZIP signatures | attachment only; never extracted |

Everything else is deny-by-default with `unsupported_bundle_file_type`,
including unknown/octet-stream, SVG, HTML, JavaScript, WebAssembly, executables,
shell/script files, JAR/APK and macro-enabled Office formats. A ZIP-named file
is opaque even if it contains an otherwise forbidden type; Mind Diary does not
inspect, extract, preview or execute archive members.

### Application generated ingress

Backend and workspace producers use the same service-owned staging pipeline as
native attachments. The portable application boundary carries only a safe
`source_kind` label: `session_attachment`, `local_path`,
`workspace/generated_artifact`, `connector_object`, `bounded_in_memory` or
`server_generated`. Provider IDs, URLs, local paths, prompt text, secrets and
other transport provenance terminate in the source adapter and are never part
of a staged record or its idempotency payload.

`bounded_in_memory` is an explicit inline path capped at 4 MiB. A
`server_generated` producer may provide a bounded byte stream through the
storage upload port, subject to the 64 MiB per-BundleFile limit; the local
Sites object adapter sends that stream directly to quarantine storage rather
than assembling it in application memory. Both paths perform the same SHA-256,
size, magic-MIME, filename, quota, quarantine and binding-owner idempotency
checks. Generated previews or derived artifacts do not become canonical files
automatically: an authorized caller must reference the verified
`staged_file_ref` in an explicit atomic `commit_changeset`.

Staging state begins `quarantined`. The synchronous first-slice static gate
checks bounded streaming download, SHA-256, size, filename/path-independent
magic detection, declared MIME and extension agreement and the allowlist above;
success moves the record to `verified`, failure to `rejected`. This is a
containment policy, not an antivirus clean bill of health. Only a `verified`
record may be committed; staged bytes are never reader-visible. Committed
PDF/ZIP always download as attachment, raster inline responses remain
`nosniff`/sandboxed, and no canonical file is executed server-side.

## Exact limits and quotas

All numbers are binary bytes and fail closed before canonical HEAD mutation:

| Limit | Value |
|---|---:|
| One BundleFile | 67,108,864 bytes (64 MiB) |
| BundleFile operations in one changeset | 20 |
| Sum of staged bytes referenced by one changeset | 134,217,728 bytes (128 MiB) |
| Outstanding verified staged bytes per binding owner | 268,435,456 bytes (256 MiB) |
| All entries in one resulting revision | 10,000 |
| Markdown subtotal in one resulting revision | existing 67,108,864 bytes (64 MiB) |
| Markdown + BundleFile bytes in one resulting revision | 1,073,741,824 bytes (1 GiB) |
| Unique canonical objects retained by one Space history | 2,147,483,648 bytes (2 GiB) |
| Verified staged-ref TTL | 60 minutes |
| Expired/rejected orphan safety window before physical GC | 24 hours |
| One bounded GC run | at most 100 objects and 268,435,456 bytes |

Existing Markdown limits remain 1 MiB/file, 4 MiB changed Markdown bytes and
100 total changeset operations. Stage reserves the binding-owner staging quota;
commit transaction reserves resulting-HEAD and retained-Space quotas before
HEAD CAS. Failed/stale commit does not consume the staged ref or quota twice.
No client field can raise a limit. MD-260 capacity/accounting semantics are now
accepted in the
[Sites storage/capacity/import contract](sites-storage-capacity-import.md): the
lower applicable BundleFile/Mind/principal/Site limit wins. Implementation and
capacity UAT remain separate; this slice does not infer larger values.

## Upload and commit lifecycle

`stage_bundle_file` is one-Mind content operation and requires `content:write`,
an active exact `write_binding_id`, current write ACL and:

```text
mind + write_binding_id + native file + idempotency_key
+ optional expected_size/expected_sha256/display_filename
```

For the OpenAI-hosted adapter, tool metadata declares
`_meta["openai/fileParams"] = ["file"]`. Current transport supplies a bounded
native object with `file_id`, temporary `download_url`, optional `file_name`
and `mime_type`. These values terminate at the MCP adapter: only verified bytes,
canonical metadata and trusted binding context cross the application port.
Local paths, base64 and arbitrary remote URLs are invalid; the adapter accepts
HTTPS download/redirect hosts only from its explicit OpenAI allowlist, omits
credentials and aborts the stream at the byte limit. Each client/profile tuple
must prove this extension in UAT; lack of support is
`native_file_input_unsupported`, never a hidden fallback.

A verified record is pinned to
`binding_owner_id + space_id + write_binding_id`, stores only opaque
`staged_file_ref`, source kind, object key, digest, size, media type, safe
filename, state and timestamps, and expires after 60 minutes. Provider file
ID/URL, local path and connector credential are not persisted.
Foreign/not-found refs are externally indistinguishable
`staged_file_unavailable`; owner-visible expired, consumed, rejected or stale-
binding state has its specific code.

Stage idempotency is namespaced by binding owner + operation + key and binds the
exact bytes digest plus canonical metadata. Same key/payload returns the same
ref and expiry; changed bytes/metadata returns `idempotency_conflict`.

`commit_changeset` adds:

```json
{ "type": "create_bundle_file", "path": "attachments/map.png", "staged_file_ref": "staged_opaque" }
```

```json
{ "type": "replace_bundle_file", "path": "attachments/map.png", "staged_file_ref": "staged_opaque", "expected_sha256": "sha256:..." }
```

```json
{ "type": "delete_bundle_file", "path": "attachments/map.png", "expected_sha256": "sha256:..." }
```

The same authorization, exact binding generation, full-bundle validation,
idempotency and HEAD CAS fence Markdown and opaque operations. Success creates
one v2 revision and marks every referenced staged ref `consumed` in the same
transaction. Failure publishes no reachable partial revision and leaves refs
reusable until expiry. After an unknown outcome the client repeats the exact
commit key/payload; it never restages or changes the key until reconciliation.

## Read and download lifecycle

`list_bundle_files` requires `content:read`, exact read/write binding and one
Mind/revision. It returns bounded path, detected media type, size, SHA-256,
revision ID, inline eligibility and deterministic reference diagnostics; no
bytes, provider ID or URL.

`get_bundle_file_download` selects exact revision + path, reauthorizes current
token/scope/ACL/visibility and returns a new opaque one-use grant. Default TTL is
5 minutes, server maximum 10 minutes and never beyond credential/revision/job
lifecycle. Download reauthorizes again immediately before reading bytes;
membership revoke, public/unlisted → private, token revoke/expiry, whole-Mind
delete, grant expiry or integrity mismatch fails closed.

Successful bytes use exact `Content-Type`, `Content-Length`, `ETag` from SHA-256,
`Cache-Control: no-store`, `Pragma: no-cache`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and
`Cross-Origin-Resource-Policy: same-origin`. `Content-Disposition` uses a safe
ASCII fallback plus RFC 5987 UTF-8 filename. Only allowlisted raster may be
`inline`; PDF/ZIP are always `attachment`. Grant secret/URL is consume-on-
response material and never appears in durable status, audit, logs, telemetry,
Task Manager evidence or model content.

Existing `fetch` and MCP Resources remain Markdown/text-only. No binary/base64
enters JSON-RPC `structuredContent` or model context automatically.

## Deterministic export compatibility

`MD-OKF-ZIP-1` remains byte-for-byte unchanged and Markdown-only. Existing v1
revisions and v2 Markdown-only revisions can request it. A mixed revision never
silently drops opaque files: absent/legacy profile returns
`export_profile_required`.

New explicit profile `MD-BUNDLE-ZIP-1` uses `application/zip`, filename
`mind-diary-bundle.zip`, stored entries, UTF-8 flag, fixed DOS timestamp
`1980-01-01T00:00:00`, mode `0644`, no directory/extra/comment fields, no ZIP64
and unsigned UTF-8 byte path ordering. It contains exact Markdown and opaque
objects at canonical paths plus one reserved producer manifest:

```text
.mind-diary/manifest.json
```

The manifest is canonical one-line UTF-8 JSON with final newline:

```json
{"format":"mind-diary-bundle-export-manifest-v1","okf_version":"0.2","files":[{"path":"...","kind":"markdown|opaque","media_type":"...","sha256":"sha256:...","size":0}]}
```

Files are sorted with the same deterministic path order; manifest does not
contain `space_id`, `revision_id`, principal, ACL, audit, jobs, staging or
download data. It is producer integrity metadata, not OKF frontmatter and not
an import contract. Archive SHA-256/size describe exact final ZIP. Classic-ZIP
overflow returns `archive_limit_exceeded`; no profile switch or ZIP64 fallback.

## Stable errors and tool annotations

New application codes:

```text
native_file_input_unsupported
bundle_file_size_limit_exceeded
bundle_file_operation_limit_exceeded
bundle_file_changeset_size_limit_exceeded
bundle_file_quota_exceeded
staging_quota_exceeded
unsupported_bundle_file_type
bundle_file_media_mismatch
invalid_bundle_file_name
staged_file_unavailable
staged_file_expired
staged_file_consumed
staged_file_rejected
staged_file_binding_stale
bundle_file_exists
bundle_file_not_found
bundle_file_digest_mismatch
bundle_file_integrity_failure
bundle_file_download_expired
export_profile_required
```

`stage_bundle_file` is write-scoped, non-destructive and open-world because the
adapter downloads host-provided bytes. `list_bundle_files` is read-only and
closed-world. `get_bundle_file_download` creates a grant, so it is non-read-only,
non-destructive and open-world. `commit_changeset` remains destructive. Tool
catalog semantics are identical on modern and compatibility profiles only when
the pinned client passes the native-file capability gate.

## Проверяемые post-MVP acceptance rows

Local evidence must cover manifest v1 compatibility/v2 canonicalization,
streaming limits/MIME spoof/denylist, mixed atomic commit and stale/idempotent
failure, exact historical bytes, same-Space retained quota/GC, current-access
downloads, Markdown references, deterministic dual export and absence of bytes,
URLs, provider IDs and local paths from logs/errors/audit.

Dev and UAT promotion этого slice must use image + PDF + ZIP exact fixtures.
UAT evidence joins exact
Git SHA, Sites version/deployment, hosted tool inventory/schema, pinned Codex
client/plugin tuple, stage → commit → list → download SHA read-back, historical
replace/delete, access revoke and persistence after redeploy. Unsupported native
file input keeps MD-250 and the post-MVP epic nonterminal; repository tests or
local paths cannot substitute this row. Это не меняет terminal status Release
0.1.

## Гипотезы и открытые решения

- Hypothesis: 64 MiB/file, 1 GiB live revision and 2 GiB retained Space are
  sufficient for the post-MVP mixed-file pilot; MD-260 capacity evidence may
  reject these values.
- Open: production antivirus/content-disarm policy, larger/paid quotas,
  resumable upload, previews/OCR/transcription, office/audio/video formats,
  bundle import and cross-provider native-file transports.
- Open: public production/download CDN and retention/legal erasure model.

Markdown-only resumable import is accepted by ADR-0016 but is not a BundleFile
transport, does not extract ZIP and remains unavailable until its implementation
and UAT rows pass.

Ни одна гипотеза/open item не ослабляет accepted first-slice deny-by-default,
authorization, exact revision, quota or export rules.
