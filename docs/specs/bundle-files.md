# BundleFile: versioned attachments в Mind

Статус: accepted, 2026-08-22; format-neutral amendment принят 2026-08-25 в
[ADR-0021](../decisions/0021-format-neutral-bundle-files.md).
Release 0.3 principal-owned staging amendment принят 2026-08-30 в
[ADR-0024](../decisions/0024-principal-mind-usage-modes-and-automatic-save.md)
и [Mind usage contract](mind-usage-modes.md).
Release 0.4 UTF-8 text-ingress amendment принят 2026-09-10 ниже.
`normative_status: accepted`; `implementation_status: legacy_bounded_local`;
`principal_usage_staging_status: implemented_repository`.
Текущий repository baseline из MD-247/MD-248/MD-249 реализует manifest v1/v2/v3,
allowlist raster/PDF/ZIP и 64 MiB per-file limit. Это проверенный исторический
baseline, но не текущая product boundary Release 0.2. MD-303 принимает manifest
v4, open advisory media type и exact 256 MiB streaming invariant; их runtime
реализация и legacy/v4 conformance принадлежат MD-304. Этот producer-defined
contract расширяет Mind Diary, но не изменяет Open Knowledge Format 0.2 и не
объявляет `BundleFile` нормативной OKF entity.

Release applicability: технический contract сохранялся как post-MVP graph 0.1,
а Release 0.2 принимает format-neutral target. Для исторического 0.1
[ADR-0019](../decisions/0019-release-0-1-codex-first-small-data-boundary.md)
переносил весь BundleFile slice в post-MVP. Наличие legacy implementation не
разрешает claim о v4/arbitrary-file support до MD-304 и exact UAT evidence.

MD-271 добавляет общий [file-ingress contract](file-ingress.md) и source
capability matrix для bytes, которые могут попасть в этот `BundleFile` slice.
В текущем candidate `session_attachment` подключён через OpenAI-native MCP
parameter, `bounded_in_memory` и `server_generated` используют общий
staging/streaming pipeline, а Product Site composition устанавливает отдельный
constructor-owned `bounded_in_memory` port для trusted producer. MD-272
подключает repository-local companion для
`local_path` и `workspace/generated_artifact`. Native client UAT,
hosted upload-intent/producer evidence остаются отдельными gates. MD-284
реализует repository reference adapter `connector_object` для одного exact
Google Drive object; его exact-provider acceptance отдельно принадлежит
MD-319. MD-305 владеет только hosted one-use upload-intent service и
HTTP/MCP composition для local/workspace sources поверх MD-304 core; он не
меняет этот object/storage contract. Это не разрешает silent base64, arbitrary
URL или local-path fallback.

### Release 0.3 product authority

Format-neutral bytes, manifest, containment, exact-revision read/download and
atomic commit semantics ниже сохраняются. Bulk import/export orchestration
принадлежит Sites control plane; Content MCP не управляет этими workflows и не
меняет `usage_mode` или active writable mount. Ordinary per-file source
admission, stage и reconcile
могут оставаться подготовкой exact-target content commit в Codex content flow:
input остаётся explicit, adapter-owned и server-approved, а commit — fenced by
current ACL/scope/HEAD. Такая подготовка не создаёт control-plane authority или
второй bulk import surface.

Historical `stage_bundle_file`, reconcile, binding and export tool descriptions
below document 0.1/0.2 compatibility, not the Release 0.3 operation register.
Historical MD-339 target/binding contract remains evidence of that older
surface. ADR-0024 supersedes it for fresh Release 0.3 staging: runtime neither
advertises nor accepts client binding fields, while exact cached legacy calls
may only return a side-effect-free retired result.

### Release 0.3 principal-owned mount-generation amendment

Fresh BundleFile stage and commit do not derive destination from an OAuth grant,
personal token or caller-provided binding. Server resolves authenticated
`principal_id`, reads that principal's single active `read_write` Mind and pins
its opaque `principal_mind_usage_generation_id`. Credential state/scope and
current ACL/role remain mandatory authorization checks, but never select or
replace the Mind.

- An asserted `mind`/`space_id` must exactly equal the server-resolved mount;
  mismatch fails closed without Personal-Mind or previous-target fallback.
- Fresh MCP, upload-intent, connector and generated-source requests contain no
  `write_binding_id`, `binding_owner_id`, target version or client generation.
- New staged records bind
  `principal_id + space_id + principal_mind_usage_generation_id`; stage checks
  this pin before source/provider reads and again in the staging transaction.
  Commit consumes only records with the same exact pin and repeats mode,
  generation, role, scope, HEAD CAS, quota and idempotency checks atomically.
- Disable/switch, generation drift, credential revoke/expiry, role loss or
  corrupt usage state invalidates in-flight work. A legacy row without the new
  exact generation is non-consumable and is never remapped.
- An internal credential/grant partition may remain for temporary object
  containment, quota and revoke cleanup. It is not client authority, destination
  identity or an idempotency selector for fresh application requests.

## Контекст и граница решения

Проверенный внешний факт: OKF 0.2 задаёт переносимое дерево Markdown и ссылки
на resources, но не задаёт binary manifest, upload protocol, MIME policy,
revisions, ACL или export container для произвольных bytes. Требование Release
0.2: одна immutable `SpaceRevision` должна атомарно version-ить Markdown и любой
явно выбранный regular non-Markdown file, а historical read/export — сохранять
его exact path, bytes, size и SHA-256 независимо от расширения, MIME detection
или preview support.

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

## Revision manifest v4

После включения MD-304 каждая новая revision записывает service manifest v4:

```json
{
  "format": "mind-diary-revision-manifest-v4",
  "entries": [
    {
      "path": "concepts/trip.md",
      "kind": "markdown",
      "sha256": "sha256:<64 lowercase hex>",
      "media_type": "text/markdown; charset=utf-8",
      "size": 1234
    },
    {
      "path": "sources/interview.opus",
      "kind": "opaque",
      "sha256": "sha256:<64 lowercase hex>",
      "media_type": "audio/ogg",
      "size": 4567
    }
  ]
}
```

- Manifest — service envelope outside OKF content. ACL, memberships, provider
  IDs, staging state, download grants, audit и indexes в него не входят.
- `kind` is exactly `markdown | opaque`. Markdown сохраняет exact
  `text/markdown; charset=utf-8` и existing codec rules. У opaque entry
  `media_type` — открытая advisory string; она не является admission rule,
  renderer permission, index selector или authorization signal.
- Entries have unique canonical paths and deterministic Unicode-scalar ordering.
  Digest and size always describe exact immutable object bytes.
- V4 сохраняет v3 Space-scoped manifest-object layout, но меняет media policy
  явно. Он не выдаётся за compatible v3 bytes и не переписывает старые hashes.
- Search/index jobs consume only `kind: markdown`. Opaque files are not
  `KnowledgeEntry`, snippets or MCP text Resources.

Object keys and physical deduplication are scoped by `space_id`; a digest in
одном Mind не даёт lookup/existence signal о другом Mind. HEAD quota counts
logical manifest bytes; retained quota counts unique objects reachable from all
revisions of the same Space.

### Legacy compatibility без reinterpretation

| Manifest | Historical meaning | Read/next-write rule |
|---|---|---|
| v1 | Markdown-only; `kind` отсутствует | Reader projects every entry as `kind: markdown`; committed bytes/hash remain untouched. |
| v2 | Inline mixed manifest with closed raster/PDF/ZIP media baseline | Reader uses stored kind/media/path exactly; it does not re-sniff or broaden the historical admission decision. |
| v3 | Separately digested R2 manifest with v2 entry semantics | Reader verifies the stored manifest digest/size and preserves the exact historical projection. |
| v4 | Separately digested format-neutral manifest with open advisory media | New ordinary commits after MD-304 write v4. |

No bulk migration is required. The first ordinary change from v1/v2/v3 reads
the exact parent and creates a new v4 child; the parent remains independently
readable/exportable. Unknown manifest format fails closed without guessing its
kind/media semantics. Unknown OKF `type` and producer fields inside Markdown
remain source bytes and must survive read-modify-write/export; service manifest
metadata never reinterprets `recorded_by`, `applies_to`, `sources` or another
producer field as authority.

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

## Format-neutral media и containment policy

Admission и serving разделены. Любой explicitly selected regular file, который
проходит path, size, streaming integrity, quota, authorization и staging
lifecycle checks, может стать `kind: opaque`. Extension, declared MIME и
preview support не блокируют storage/history/export.

Opaque `media_type` хранит lowercase ASCII MIME essence `type/subtype`, где обе
части непусты и состоят только из letters, digits и RFC `tchar` punctuation;
ровно один `/`, общая длина не больше 127 ASCII bytes, whitespace, parameters,
controls и другая response-header syntax запрещены. Parameters входящего hint
не сохраняются: adapter разбирает только его essence перед normalization.
Server-owned confident detection может выбрать любой syntactically valid
registered либо producer-defined media type. Missing, unknown, syntactically
invalid или conflicting evidence нормализуется в exact
`application/octet-stream`; declared MIME и filename остаются hints и никогда
не становятся authority. `bundle_file_media_mismatch` может быть quality
diagnostic, но не storage failure.

Canonical bytes внутри одного Mind дедуплицируются по SHA-256 независимо от
`media_type`. Media type принадлежит entry конкретной immutable revision, а не
content-addressed object: новая revision может уточнить классификацию тех же
exact bytes, не меняя digest и не ломая прежнюю историю. Object-store content
type остаётся storage hint и не участвует в проверке revision; чтение, export и
serving берут media type из exact manifest и отдельно проверяют Space, digest,
size и bytes.

### Release 0.4 UTF-8 text ingress

CSV, JSON, JSON Lines, TXT, TSV, YAML, XML, HTML и Jupyter notebook остаются
`kind: opaque`: manifest, immutable history, digest и exact bytes не меняются.
При staging service может сохранить их canonical text media type, чтобы
`list_files`, `grep_files` и `read_files` применяли общий exact-revision text
workflow без отдельного parser или index.

Text classification требует одновременно:

- полного успешного UTF-8 decode с fatal error policy;
- отсутствия NUL, DEL и C0 controls, кроме TAB, LF и CR;
- text MIME hint либо известного text filename suffix. Для обычных browser/file
  ingress `application/octet-stream` считается отсутствием text MIME hint и
  допускает вывод по suffix только после проверки всех bytes.

Known suffix задаёт canonical media type: `.txt`/`.log` — `text/plain`,
`.csv` — `text/csv`, `.tsv` — `text/tab-separated-values`, `.json` —
`application/json`, `.jsonl`/`.ndjson` — `application/x-ndjson`,
`.yaml`/`.yml` — `application/yaml`, `.xml` — `application/xml`, `.html`/`.htm`
— `text/html`, `.ipynb` — `application/x-ipynb+json`. Если suffix отсутствует,
успешно проверенный canonical text MIME hint сохраняется как media type.
Conflicting binary signature имеет приоритет и даёт
`application/octet-stream`. Extension или declared MIME без проверки всего
content никогда не классифицируют arbitrary bytes как text. Обычный и
streaming staging применяют одинаковое правило; streaming decoder переносит
UTF-8 state между chunks и завершает fatal validation только на EOF.

| Example | Canonical/advisory media | Storage | Serving |
|---|---|---|---|
| DOCX | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` or fallback | opaque, exact bytes | download-only |
| HEIC | `image/heic` or fallback | opaque, exact bytes | download-only |
| EPUB | `application/epub+zip` or fallback | opaque, exact bytes | download-only; never extracted |
| OPUS | `audio/ogg`, `audio/opus` or fallback | opaque, exact bytes | download-only |
| CSV / TXT | content-validated text media or fallback | opaque, exact bytes | exact-revision text operations or download |
| JSON / JSON Lines | content-validated JSON media or fallback | opaque, exact bytes | exact-revision text operations or download |
| HTML | `text/html` or fallback | opaque, exact bytes | download-only; never rendered |
| Jupyter notebook | `application/x-ipynb+json` or fallback | opaque, exact bytes | download-only; never executed |
| ZIP | `application/zip` or fallback | opaque, exact bytes | download-only; never extracted |
| Unknown `.bin` | `application/octet-stream` | opaque, exact bytes | download-only |

Only the safe raster preview subset `image/png`, `image/jpeg`, `image/gif` and
`image/webp` may be inline-eligible after byte signature, bounded decoder and
response-policy checks succeed. Eligibility is a derived serving decision, not
manifest identity; failed/unsupported preview falls back to download without
changing canonical bytes. SVG, HTML, JavaScript, executables, archives, Office,
audio/video, HEIC and every octet-stream object are download-only, `nosniff`,
never executed or extracted. Production antivirus/CDR cleanliness is not
claimed.

### Application generated ingress

Backend and workspace producers use the same service-owned staging pipeline as
native attachments. The portable application boundary carries only a safe
`source_kind` label: `session_attachment`, `local_path`,
`workspace/generated_artifact`, `connector_object`, `bounded_in_memory` or
`server_generated`. Provider IDs, URLs, local paths, prompt text, secrets and
other transport provenance terminate in the source adapter and are never part
of a staged record or its idempotency payload.

`bounded_in_memory` is an explicit inline path capped at 4 MiB inclusive.
Release 0.3 Product Site candidate exposes it only as the constructor-owned
`ProductSiteRuntime.boundedInMemoryIngress.stage` port: no HTTP/MCP route,
base64, URL or path transport exists, and public capability discovery remains
`not_available` until exact late-UAT evidence. A
`server_generated` producer may provide a bounded byte stream through the
storage upload port, subject to the 256 MiB per-BundleFile limit; the local
Sites object adapter sends that stream directly to quarantine storage rather
than assembling it in application memory. Both paths perform the same SHA-256,
size, advisory-media, filename, quota, quarantine and
principal/mount-generation idempotency
checks. Generated previews or derived artifacts do not become canonical files
automatically: staging returns no model-facing `structuredContent`, and an
authorized caller must reference the verified
`staged_file_ref` in an explicit atomic `commit_changeset`.

Staging state begins `quarantined`. The synchronous gate checks bounded
streaming transfer, SHA-256, size, regular-file snapshot, safe filename,
advisory-media normalization, quota and binding. Success moves the record to
`verified`, failure to `rejected`. This is a
containment policy, not an antivirus clean bill of health. Only a `verified`
record may be committed; staged bytes are never reader-visible. Committed
non-preview files always download as attachment, safe-raster inline responses
remain `nosniff`/sandboxed, and no canonical file is executed server-side.

### Exact streaming invariant

The maximum accepted file is exactly 268,435,456 bytes (256 MiB), inclusive.
Byte 268,435,457 fails with `bundle_file_size_limit_exceeded`; a declared
`Content-Length` above the limit is rejected before body read, while absent or
untrusted length is enforced by the counting stream. Transport, SHA-256,
quarantine put, canonical promotion, historical download and mixed export must
process bounded chunks and must not call a full-file `arrayBuffer`, concatenate
all chunks or otherwise require resident memory proportional to file size.
Detection/preview may retain only a bounded prefix/decoder window. Cancellation,
timeout, digest mismatch or overflow leaves no reachable canonical object or
partial revision. MD-304 owns executable proof with a synthetic file larger
than 146,215,108 bytes and boundary fixtures at 256 MiB / 256 MiB + 1 byte.

## Exact limits and quotas

All numbers are binary bytes and fail closed before canonical HEAD mutation:

| Limit | Value |
|---|---:|
| One BundleFile | 268,435,456 bytes (256 MiB), inclusive |
| BundleFile operations in one changeset | 20 |
| Sum of staged bytes referenced by one changeset | 268,435,456 bytes (256 MiB) |
| Outstanding verified staged bytes per internal staging namespace | 268,435,456 bytes (256 MiB); namespace is accounting/revocation metadata, not destination authority |
| All entries in one resulting revision | 10,000 |
| Markdown subtotal in one resulting revision | existing 67,108,864 bytes (64 MiB) |
| Markdown + BundleFile bytes in one resulting revision | 1,073,741,824 bytes (1 GiB) |
| Unique canonical objects retained by one Space history | 2,147,483,648 bytes (2 GiB) |
| Verified staged-ref TTL | 60 minutes |
| Expired/rejected orphan safety window before physical GC | 24 hours |
| One bounded GC run | at most 100 objects and 268,435,456 bytes |

Existing Markdown limits remain 1 MiB/file, 4 MiB changed Markdown bytes and
100 total changeset operations. Stage reserves the internal staging quota;
that compatibility partition does not select the writable Mind. Commit
transaction reserves resulting-HEAD and retained-Space quotas before
HEAD CAS. Failed/stale commit does not consume the staged ref or quota twice.
No client field can raise a limit. MD-260 capacity/accounting semantics are now
accepted in the
[Sites storage/capacity/import contract](sites-storage-capacity-import.md): the
lower applicable BundleFile/Mind/principal/Site limit wins. Implementation and
capacity UAT remain separate; this slice does not infer larger values.

## Historical upload surface and stable commit lifecycle

Весь request shape и binding terminology этого раздела сохранены только как
историческое evidence Release 0.1/0.2. Их нельзя использовать для fresh
Release 0.3 calls или implementation; действующий request/authority contract
находится в principal-owned amendment выше.

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
credentials and aborts the counting stream after 268,435,456 bytes. Each
client/profile tuple
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
idempotency and HEAD CAS fence Markdown and opaque operations. After MD-304,
success creates one v4 revision and marks every referenced staged ref `consumed` in the same
transaction. Failure publishes no reachable partial revision and leaves refs
reusable until expiry. After an unknown outcome the client repeats the exact
commit key/payload; it never restages or changes the key until reconciliation.

## Read and download lifecycle

Historical Release 0.1/0.2 `list_bundle_files` requires `content:read`, exact
read/write binding and one Mind/revision. Target Release 0.3 keeps the exact
Mind/revision selector and current ACL/scope checks but removes binding as a
read prerequisite; ADR-0024 defines the current principal-owned transition.
The operation
returns bounded path, advisory media type, size, SHA-256, revision ID, derived
inline eligibility and deterministic reference diagnostics; no bytes, provider
ID or URL.

`get_bundle_file_download` selects exact revision + path, reauthorizes current
token/scope/ACL/visibility and returns a new opaque one-use grant. Default TTL is
5 minutes, server maximum 10 minutes and never beyond credential/revision/job
lifecycle. Download reauthorizes again immediately before reading bytes;
membership revoke, public/unlisted → private, token revoke/expiry, whole-Mind
delete, grant expiry or integrity mismatch fails closed.

The result also carries a closed machine-readable retrieval contract. The
originating MCP client or a purpose-built trusted download companion on the same
client host MUST perform one direct HTTPS GET, reject redirects, and verify
`Content-Type`, `Content-Length`, digest `ETag`, `Content-Disposition`, and the
SHA-256 of the received bytes against the same exact-revision file descriptor.
It MUST NOT transfer the grant URL to a model prompt, interactive browser,
remote execution container, or arbitrary connector. If the allowed executor's
host rejects URL admission before an HTTP request is made, the client reports
`client_transport_unsupported`; that outcome is neither a server download
failure nor evidence that the bytes were obtained.

Successful bytes use exact `Content-Type`, `Content-Length`, `ETag` from SHA-256,
`Cache-Control: no-store`, `Pragma: no-cache`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and
`Cross-Origin-Resource-Policy: same-origin`. `Content-Disposition` uses a safe
ASCII fallback plus RFC 5987 UTF-8 filename. Only the verified safe-raster
subset may be `inline`; every other object, including
`application/octet-stream`, is `attachment`. Grant secret/URL is consume-on-
response material and never appears in durable status, audit, logs, telemetry,
Task Manager evidence or model content.

Existing `fetch` and MCP Resources remain Markdown/text-only. No binary/base64
enters JSON-RPC `structuredContent` or model context automatically.

## Deterministic Site-owned export compatibility

`MD-OKF-ZIP-1` remains byte-for-byte unchanged and Markdown-only. Existing
v1/v2/v3 revisions and v4 Markdown-only revisions can request it. A mixed revision never
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
writable_mind_required
writable_mind_stale
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

`staged_file_binding_stale` remains a historical compatibility code. Fresh
principal-owned staging reports `writable_mind_required` when no effective
mount exists and `writable_mind_stale` when its exact usage generation changed.
Neither result permits binding-generation replay or fallback to another Mind.

`stage_bundle_file` is write-scoped, non-destructive and open-world because the
adapter downloads host-provided bytes. `list_bundle_files` is read-only and
closed-world. `get_bundle_file_download` creates a grant, so it is non-read-only,
non-destructive and open-world. `commit_changeset` remains destructive. Tool
catalog semantics are identical on modern and compatibility profiles only when
the pinned client passes the native-file capability gate.

## Проверяемые post-MVP acceptance rows

`unsupported_bundle_file_type` остаётся legacy pre-v4 error code for exact old
client/candidate reconciliation. V4 admission never returns it only because a
regular file has an unknown MIME or extension. `bundle_file_media_mismatch` in
v4 is a diagnostic followed by `application/octet-stream` fallback, not a
rejection.

MD-303 contract evidence covers manifest v1/v2/v3 compatibility, explicit v4,
open MIME fallback, exact numeric limits, arbitrary-format examples and the
incremental OKF boundary. MD-304 implementation evidence must cover v4
canonicalization, 256 MiB streaming/+1 overflow, MIME conflict fallback,
mixed atomic commit and stale/idempotent
failure, exact historical bytes, same-Space retained quota/GC, current-access
downloads, Markdown references, deterministic dual export and absence of bytes,
URLs, provider IDs and local paths from logs/errors/audit.

Dev and UAT promotion этого slice must include safe raster plus DOCX, HEIC,
EPUB, OPUS, HTML, notebook, ZIP and unknown-binary exact fixtures.
UAT evidence joins exact
Git SHA, Sites version/deployment, hosted tool inventory/schema, pinned Codex
client/plugin tuple, stage → commit → list → download SHA read-back, historical
replace/delete, access revoke and persistence after redeploy. Unsupported native
file input keeps MD-275 and Release 0.2 nonterminal; repository tests or local
paths cannot substitute this row. Historical MD-250 evidence remains a legacy-
baseline record and does not promote the v4 contract. Это не меняет terminal
status Release 0.1.

## Гипотезы и открытые решения

- Accepted for Release 0.2: 256 MiB/file with unchanged 1 GiB live-revision and
  2 GiB retained-Space ceilings. Usage evidence may require a future tier, but
  cannot raise these limits silently.
- Open: production antivirus/content-disarm policy, larger/paid quotas,
  resumable upload, OCR/transcription, rich preview/rendering, bundle import and
  cross-provider native-file transports.
- Open: public production/download CDN and retention/legal erasure model.

Markdown-only resumable import is accepted by ADR-0016 but is not a BundleFile
transport, does not extract ZIP and remains unavailable until its implementation
and UAT rows pass.

## Incremental OKF boundary

MD-306 may preserve one typed OKF Markdown entry with unknown producer fields
beside arbitrary opaque files in an ordinary revision using existing Markdown
operations plus one `staged_file_ref` per selected regular file. This contract
does not add an OKF `Asset` type, does not interpret `recorded_by`, `applies_to`,
`sources` or opaque bytes as service authority and does not create a directory,
glob, batch, archive-import or whole-Brain migration profile. Each incremental
operation remains one normal changeset over an explicitly selected entry or
small linked set.

Ни один open item не ослабляет format-neutral storage, authorization, exact
revision, 256 MiB streaming, quota, download-only containment или export rules.
