# Единый file-ingress contract и source capability matrix

Статус: accepted contract boundary, 2026-08-23; Release 0.2 readable-path
profile принят 2026-08-26. `normative_status: accepted`;
`implementation_status: implemented_repository_for_disk_workspace`;
`connector_reference_status: implemented_repository_google_drive`.
Общий portable boundary принят, обязательный Release 0.2 slice использует
packaged local companion для `local_path` и `workspace/generated_artifact`,
MD-305 hosted one-use upload-intent service и format-neutral streaming
lifecycle MD-304; MD-284 добавляет repository reference adapter одного exact
Google Drive object. Его exact-provider UAT остаётся отдельным gate MD-319.
`FileIngressCoordinator` сохраняет общую staging/commit semantics и exact
reconcile. Google Drive reference adapter не выдаётся за hosted capability
только потому, что в repository существуют его code и tests. Release 0.3
candidate подключает `bounded_in_memory` отдельным
constructor-owned port для trusted hosted producer, но не публикует его через
HTTP/MCP или capability discovery до поздней UAT-проверки. MD-322 подключает trusted
`server_generated` producer stream к hosted composition только как внутренний
application port; он не становится HTTP/MCP surface и не выдаётся за hosted
support до отдельного late-UAT evidence. Repository ports, schemas и локальные
tests сами по себе не являются support claim.

Release applicability: portable boundary остаётся accepted, но
[ADR-0019](../decisions/0019-release-0-1-codex-first-small-data-boundary.md)
переносит universal file-ingress capability в post-MVP. Все source-specific
evidence rows остаются обязательными перед соответствующим support claim, но
не блокируют Markdown-first Release 0.1.

[ADR-0021](../decisions/0021-format-neutral-bundle-files.md) replaces the
historical closed MIME allowlist and 64 MiB cap. The Release 0.2 repository
candidate combines MD-304 format-neutral streaming through 256 MiB with the
MD-305 hosted local/workspace upload-intent composition. MD-325 owns the single
joined installed-client/UAT gate; no repository-local result is a hosted or
installed-client support claim.

### Release 0.3 product authority

Source, byte-integrity, staging and atomic-revision invariants этого документа
сохраняются. Sites control plane владеет bulk import/export orchestration, но
ordinary per-file ingress остаётся частью Codex content flow: companion/adapter
может принять явно выбранный source, а Content MCP — провести bounded
admission, stage и reconcile как подготовку exact-target content commit.
Transport и source authorization остаются adapter-owned, input —
server-approved; MCP не создаёт bulk import session, не меняет writable target
и не получает Connection, connector или provider control.

Existing MCP upload/stage/reconcile descriptions ниже остаются historical
0.1/0.2 compatibility, а не target operation register. MD-336 не решает, какие
exact tools сохраняются: disposition принадлежит MD-337; writable-target/
binding representation and migration приняты в
[MD-339 contract](credential-write-target.md). MD-336 не меняет runtime,
schemas, storage or UAT claims.

## Цель и граница

MD-271 фиксирует один portable application contract для шести способов
получить bytes, которые затем могут стать producer-defined `BundleFile` в одной
immutable `SpaceRevision`. Контракт отделяет источник bytes от канонического
file path, object identity и revision semantics. Existing
[BundleFile contract](bundle-files.md), OKF 0.2 и
[Sites storage/capacity/import contract](sites-storage-capacity-import.md) остаются
источниками точных manifest, quota, import и export rules.

Требование post-MVP graph: session attachment, local disk,
workspace/generated artifact, authorized connector object, bounded in-memory
bytes и server-generated output должны сводиться к одной проверяемой модели.
Это требование не означает, что каждый adapter уже существует или что текущий
MCP client умеет передать каждый вид source.

## Release 0.2 readable-path profile

Release 0.2 имеет один обязательный user journey:

```text
explicit readable absolute path on the current Codex execution host
  -> packaged local prepare_local_file
  -> hosted one-use upload intent
  -> packaged local upload_prepared_file
  -> verified staged_file_ref
  -> atomic changeset / immutable BundleFile revision
```

- `local_path` — authority на один явно выбранный absolute path. Companion
  открывает exact regular file на текущем execution host и удерживает stable
  descriptor; отдельный root, directory, glob или batch authority не возникает.
- `workspace/generated_artifact` использует тот же byte route, но требует
  canonical path внутри trusted roots из process configuration. Root никогда не
  принимается tool argument и не выводится из filename или content.
- Extension и MIME не являются admission gate. Invalid, unknown или conflicting
  media evidence нормализуется в `application/octet-stream`; exact bytes, size,
  SHA-256, 256 MiB inclusive limit и bounded streaming совпадают с BundleFile
  contract.
- Relative path, traversal, glob request, directory, final symlink, special
  file, inaccessible source, unsupported workspace authority, changed snapshot
  и oversize input fail closed до hosted staging либо revision mutation.
- Hosted MCP получает только path-free metadata и затем uploaded bytes по
  one-use capability. Absolute path не входит в hosted request, error, audit,
  telemetry, staged record или release evidence. URL, base64, provider object и
  другой source kind не используются как fallback.
- Ошибка классифицирует только наблюдаемую boundary: source unavailable на
  текущем host, unsupported path/authority, changed snapshot или expired local
  ref. Missing path сам по себе не доказывает cross-host origin, удалённый
  attachment или истёкший provider object.
- `session_attachment` не является обязательным input Release 0.2. Direct
  host/provider, connector, bounded generated и server-generated routes
  остаются `not_available` для release claim до Release 0.3.

### Принятые invariants

- Portable application получает только `VerifiedFileInput`: exact bytes,
  `source_kind`, safe display filename, detected media type, size и SHA-256.
  Provider file ID, temporary URL, absolute local path, workspace path и raw
  request body заканчиваются на owning adapter boundary.
- Service-owned `staged_file_ref` — единственный locator staging state. Он
  pinned к `binding_owner_id + space_id + write_binding_id` и не является
  provider object ID, local path, URL или capability для другого Mind.
- `source_kind` хранится как closed enum без provider/account secret. Он
  описывает provenance class, но не становится authorization identity.
- Canonical media metadata is open and advisory. Declared MIME, filename and
  provider metadata are hints; missing, invalid, unknown or conflicting
  evidence becomes header-safe `application/octet-stream` and never blocks
  format-neutral storage. Display-name and canonical-path policy still apply.
- Каждый BundleFile operation получает один verified staged ref. Один
  changeset может содержать много разных refs вместе с Markdown operations,
  но каждый ref связывается ровно с одним target path и duplicate ref в одном
  changeset отклоняется. Успешный commit consumes все refs одной transaction;
  stale/failed commit не публикует partial HEAD и оставляет refs reusable до
  expiry.
- Unsupported source/client никогда не получает silent base64, arbitrary URL,
  local-path passthrough или неявное переключение на другой source kind.
  Adapter сообщает typed capability/transport error либо caller выбирает
  отдельный явно поддержанный adapter.

## Portable boundary

```text
source owner / provider / local process
        │  adapter-owned read, capability check, bounded transport
        ▼
VerifiedFileInput { source_kind, bytes, safe filename, detected metadata }
        │  application-owned digest, MIME/path/quota/static gate
        ▼
staged_file_ref { owner + Space + write generation + digest + metadata + state }
        │  exact active binding + expected HEAD + idempotency
        ▼
atomic commit_changeset -> one immutable revision or no visible revision
```

`VerifiedFileInput` не является durable domain entity: bytes могут ещё быть в
quarantine и не видны reader. `staged_file_ref` не раскрывает, откуда пришёл
source, кроме safe `source_kind`; exact bytes/digest/size/media type нужны для
staging and integrity, но не дают cross-Space lookup. Canonical identity после
commit остаётся `revision_id + path`, как в BundleFile specification.

### Staged record

Минимальный service-owned record содержит:

```text
staged_file_ref
binding_owner_id
space_id
write_binding_id
source_kind
sha256
size
media_type
safe_display_filename
state: quarantined | verified | rejected | consumed | expired
created_at / expires_at / consumed_at?
```

`binding_owner_id`, `space_id` и `write_binding_id` проверяются заново при
stage, list, commit и cleanup. Provider account, `file_id`, temporary URL,
absolute path, bytes и connector credentials не сохраняются в этом record.
The record does not change OKF frontmatter or the v4 manifest: only a
successful commit adds the canonical `kind: opaque` entry.

## Source capability matrix

`Release status` относится к product claim, а не к наличию interface или test
double в repository. `implemented_repository` означает только code/tests;
`UAT pending` не является hosted или installed-client capability.

| Source kind | Adapter owns reading | Transport boundary | Release status / evidence | Explicit fallback |
|---|---|---|---|---|
| `session_attachment` | MCP/provider adapter | Native client file parameter | Release 0.3 `not_available`; legacy repository schema is not a Release 0.2 support claim | No base64, local-path or arbitrary-URL fallback |
| `local_path` | Packaged local companion on the current Codex host | Path-free one-use hosted upload intent; companion snapshots one exact regular file | Release 0.2 `implemented_repository`; installed tool inventory and exact disk journey are pending MD-325 | Missing companion is a client-installation failure; local admission returns only observable safe errors; never send the path to hosted MCP |
| `workspace/generated_artifact` | Packaged local companion with trusted process-configured workspace roots | Same path-free one-use hosted intent | Release 0.2 `implemented_repository`; installed tool inventory and exact workspace journey are pending MD-325 | Unsupported authority fails locally; do not relabel or fall back to URL/provider transport |
| `connector_object` | Explicit authorized connector adapter | Connector API/object fetch | Release 0.3 `implemented_repository` для Google Drive reference adapter; exact-provider UAT pending MD-319, поэтому hosted status остаётся `not_available` | No cross-provider, implicit native export or URL fallback |
| `bounded_in_memory` | Trusted constructor-owned Product Site producer boundary | Explicit `Uint8Array` call через `ProductSiteRuntime.boundedInMemoryIngress.stage`; ≤ 4 MiB inclusive | Release 0.3 `not_available` как deployed capability до exact late-UAT evidence; internal composition `implemented_repository` | Нет HTTP/MCP route, JSON-RPC base64, URL или path fallback |
| `server_generated` | Trusted server-side producer in hosted composition | Internal bounded producer stream; no customer wire transport | Release 0.3 `not_available` as a hosted support claim; `implemented_repository` internal composition, while capability report stays unavailable until late UAT installs and verifies one privacy-safe producer use case | No client URL/path/provider-locator fallback |

All six rows use the same application static gate and the same commit
transaction. A source adapter may have a stricter limit, but it cannot raise
the effective BundleFile/Mind/principal/Site limit. `local_path` and
`workspace/generated_artifact` are not aliases for the current MCP native file
parameter.

## Verification, limits и lifecycle

### Common effective limits

These limits are accepted by the existing BundleFile contract and apply to
every source after transport-specific admission:

| Limit | Value | Rule |
|---|---:|---|
| One staged/canonical BundleFile | 268,435,456 bytes (256 MiB), inclusive | Byte 268,435,457 fails before canonical HEAD mutation |
| BundleFile operations in one changeset | 20 | One staged ref per file operation; no duplicate ref |
| Staged bytes referenced by one changeset | 268,435,456 bytes (256 MiB) | Permits one maximum-size file; Markdown/resulting revision limits still apply |
| Outstanding verified staged bytes per binding owner | 268,435,456 bytes (256 MiB) | Includes all source kinds in that owner namespace |
| Verified staged-ref TTL | 3,600 seconds (60 minutes) | Expiry is service time; ref is not reader-visible |
| One-use upload intent TTL | 600 seconds (10 minutes) | Intent is separate from `staged_file_ref`; no replay after expiry |
| Retained canonical objects per Space | 2,147,483,648 bytes (2 GiB) | Lower applicable capacity limit wins |

Existing limits remain unchanged: resulting HEAD has at most 10,000 entries,
1 GiB total and 64 MiB Markdown subtotal; orphan safety window is 24 hours.
The accepted lower-specific-limit rule from BundleFile and the Sites storage
contract remains authoritative.

### Source-specific transport budgets

| Source kind | Source-specific budget | Where bytes/metadata are checked | Initial state and success |
|---|---|---|---|
| `session_attachment` | `file_id` ≤ 1,024 chars; temporary URL ≤ 8,192; name ≤ 1,024; MIME hint ≤ 256; target adapter: 30,000 ms, up to 4 redirects, 256 MiB counting stream | Provider adapter checks HTTPS allowlist, credentials omission, redirect/timeout/stream bound; application recomputes SHA-256, size, advisory media and safe filename | `quarantined → verified → staged_file_ref`; only verified ref may enter commit |
| `local_path` | One regular file per intent, ≤ 256 MiB; intent 600 s; staged ref 3,600 s | Companion checks regular-file/snapshot/size/digest before upload; application rechecks exact bytes, media and filename after upload | `intent → quarantined → verified`; changed snapshot is a new key, not a changed retry |
| `workspace/generated_artifact` | One selected artifact per intent, ≤ 256 MiB; intent 600 s; staged ref 3,600 s | Companion checks workspace authority and snapshot; application rechecks bytes, digest, media and safe filename | Same as `local_path`; workspace path never reaches application identity |
| `connector_object` | One object per stage, ≤ 256 MiB; Google Drive reference: 30 s, zero redirects, `supportsAllDrives=true` on metadata/binary `files.get`, native `files.export` by exact `fileId + mimeType`, and provider-owned native export limit 10,000,000 bytes; staged ref 3,600 s | Connector validates current actor-owned grant, exact object, stable ownership/version and bounded fetch; application independently recomputes digest, size, advisory media and filename | `quarantined → verified`; provider metadata is advisory only |
| `bounded_in_memory` | One object per explicit call, ≤ 4,194,304 bytes (4 MiB); no upload intent; staged ref 3,600 s | Calling adapter enforces byte bound; application recomputes digest, size and MIME before quarantine promotion | `quarantined → verified`; larger payload must use an explicit out-of-band source |
| `server_generated` | One producer output, ≤ 256 MiB inclusive; generation lease 600 s; staged ref 3,600 s | Trusted producer supplies a cancellable stream, but application still checks exact digest, size, advisory media and safe filename | `quarantined → verified`; producer job/prompt identity is not a file identity |

The current `session_attachment` values are repository-verified composition
defaults, not a claim about every OpenAI host or client. A changed timeout,
redirect allowlist, inline limit or intent TTL is a versioned contract change
with targeted checks and applicable UAT evidence.

Verification is deliberately two-stage: source adapters protect transport and
ownership boundaries; the application owns canonical byte-level integrity,
size/quota and header-safe media normalization. Declared MIME/extension never
overrides exact-byte evidence. Unknown and conflicting formats are stored as
`application/octet-stream`; SVG/HTML/script/executable/archive and every
non-safe-raster type remain download-only and are never rendered, executed or
extracted.

Every transport above the explicit 4 MiB `bounded_in_memory` profile uses a
counting stream and direct quarantine writes. Hashing, promotion, download and
export must retain only bounded chunks/prefixes, not a full-file buffer. Exact
256 MiB succeeds; the next byte returns `bundle_file_size_limit_exceeded` with
no reachable object/revision. MD-304 owns and supplies that streaming/staging
contract; MD-305 consumes it through `stageStream` and cannot redefine its
limits, object identity or lifecycle.

### Trusted `server_generated` composition

MD-322 adds one constructor-owned internal port to hosted composition. A
trusted backend producer opens exactly one `ReadableStream` or
`AsyncIterable`; the port passes its chunks directly to existing `stageStream`
with `source_kind: server_generated`, `max_bytes: 268435456` and a bounded
600-second producer lease. It does not accept bytes, client path, URL, provider
locator, prompt or job identity. The caller supplies an exact safe receipt —
display filename, canonical media type, size and SHA-256 — which passes the
common filename/media/size/digest gate and contains no producer authority.
The media receipt is reduced to the canonical lowercase MIME essence before
reconcile and request hashing, so parameters such as
`application/pdf; charset=binary` are equivalent to `application/pdf`.

Before opening the producer, the port uses existing stage reconciliation with
the current actor, server-derived credential owner, Space and exact active
target generation plus source kind, idempotency key and safe receipt. The
caller supplies neither owner nor generation. `missing` is the only outcome
that may invoke the producer. An existing matching success returns its original
`staged_file_ref`; changed metadata/digest/size returns
`idempotency_conflict`; authorization, expiry, consumed/rejected state and
storage failures fail closed. Therefore an uncertain same-key retry performs
no generation, reservation or object upload.

The resolved generation is passed only through trusted application context.
The shared staging authorization checks the same credential owner, generation
and Space before reservation, then repeats that check inside the metadata
transaction against the pinned target-version stamp. Clear, switch, revoke or
target corruption between reconcile and stage therefore returns a canonical
`writable_target_required | writable_target_mismatch |
writable_target_unavailable` outcome; it never redirects bytes to another
Mind and leaves no hidden staged state.

The route races producer acquisition and every pending chunk against caller
cancellation and the lease. Cancellation, timeout, producer exception,
invalid chunk and byte 268,435,457 close or return the producer best-effort and
fail closed through the existing quarantine cleanup. Counting and SHA-256 stay
incremental; the route never assembles the complete artifact in application
memory. Exact 268,435,456 bytes remain permitted by the shared gate.
If sniffed canonical media differs from the expected MIME essence, the common
streaming gate rejects before `upload.complete` and idempotency completion,
aborts the temporary writer and releases the quota reservation. No staged
record or object remains, so the same key can be retried with a corrected,
internally consistent safe receipt.

Success returns only the service-owned `staged_file_ref`. It does not advance
HEAD: quota, exact writable-target authorization, idempotency, explicit atomic
changeset, immutable history, exact download, actor-owned Web export and orphan
cleanup remain the existing BundleFile lifecycle. Content MCP gains neither a
`server_generated` stage/export tool nor export administration. Until MD-290
installs one privacy-safe producer use case and records exact-candidate late
UAT, hosted capability discovery deliberately continues to report
`server_generated` as `not_available`, transport `none`, maximum `0`.

### Idempotency and reconcile

- Stage idempotency is namespaced by credential owner, exact target generation,
  Space, operation and key. The canonical payload hash includes `source_kind`,
  exact bytes digest/size and safe canonical metadata. Same key and same payload return the same
  `staged_file_ref`/expiry; a changed source, snapshot, metadata or digest
  returns `idempotency_conflict`.
- An unknown stage or upload-intent outcome is reconciled by repeating the
  exact safe receipt: current actor/target, source kind, idempotency key,
  canonical metadata, digest and size. `reconcileStage` never uploads bytes or
  reserves capacity; it returns the existing verified ref, `missing`, a stable
  state error or `idempotency_conflict`. The client does not change source,
  restage with a new key or infer failure from a network timeout.
- Upload intents are one-use. Exact replay of the same idempotency key may
  recover the same intent before expiry; a changed payload or second consumer
  returns `file_ingress_intent_conflict`. OAuth access-record rotation within
  the same still-active principal/grant/exact target generation atomically refreshes the
  replayed intent authorization reference; it cannot change body identity or
  resurrect a revoked credential owner or target.
- A successful `commit_changeset` consumes every referenced staged ref in its
  single HEAD transaction. An unknown commit outcome is reconciled with the
  exact commit key/payload through `reconcileCommit`; replay returns the same
  immutable revision and `missing` performs no preflight, reservation, object
  write or HEAD mutation. Stale HEAD,
  invalid ref, quota or full-bundle failure publishes no reachable partial
  revision and does not consume refs.
- Expiry/rejection cleanup is bounded and idempotent. Unreachable bytes remain
  behind the existing 24-hour orphan safety window; no source provider is
  queried by GC.

## Historical native MCP capability negotiation

The legacy `stage_bundle_file` tool is the `session_attachment` profile. Its
schema may remain available for compatibility, but Release 0.2 does not claim
or require that transport. Direct host/provider input stays `not_available`
until Release 0.3 evidence; a static `_meta["openai/fileParams"]` declaration is
not installed-client or hosted support proof and never activates fallback.

Read-only credentials do not gain staging by seeing the tool definition. The
server checks token scope, current write binding, current ACL and exact Mind
again on every call. Compatibility framing does not create a second source
contract or bypass the same application gate.

Local/workspace adapters negotiate their own explicit capability and source
kind. MD-305 exposes `create_file_upload_intent` plus the
same-origin capability-only GET/PUT route for the first two sources; the local
companion uses a two-tool local sequence: `prepare_local_file` opens one stable
no-follow regular-file descriptor and returns a 600-second process-local
pathless ref plus safe filename/media/size/SHA metadata; after the caller mints
the hosted intent from that metadata, `upload_prepared_file` accepts only the
local ref and one-use `upload_url`. It performs credentialless GET-before-PUT,
streams the same descriptor with a second digest/snapshot verification and GET
reconciliation after an unknown outcome. A successful, expired, changed or
definitively rejected ref is closed and invalidated; only retryable/unknown
transport retains the exact ref. Directory, glob, traversal, final symlink,
special file and byte mutation fail locally without putting a path in output,
network or telemetry. The implemented generated paths must not overload the
native `file` field with a local path, arbitrary URL or unbounded bytes.
Installed companion visibility is proven only by fresh exact client/plugin tool
inventory; hosted response cannot observe it. Readability of one path is proven
only by that local `prepare_local_file` call. MD-325 joins those two facts with
the hosted adapter/binding and exact disk/workspace journeys.

## Errors, privacy and audit

Stable errors are split by boundary:

| Situation | Code | Retry/fallback rule |
|---|---|---|
| Current native profile cannot accept a client file | `native_file_input_unsupported` | No silent base64/path/URL fallback; choose an explicitly supported adapter |
| Path/source cannot be read on the current execution host | `file_ingress_source_unavailable` | Choose or copy one regular file to a readable absolute path on this host; do not guess cross-host/provider provenance |
| Path shape, file kind or workspace authority is unsupported | `file_ingress_source_unsupported` | Choose an exact regular file or an authorized workspace path; no automatic source conversion |
| Retained descriptor no longer matches the verified snapshot | `local_companion_file_changed` | Wait for writes to finish and prepare the exact file again with a new logical intent |
| Prepared process-local reference expired | `local_companion_ref_expired` | Prepare the exact file again; an expired ref never selects or reopens a path implicitly |
| Bounded source transport temporarily fails | `file_ingress_transport_unavailable` | Retry exact request/key while source TTL permits; do not alter payload |
| Upload intent expired/consumed or changed | `file_ingress_intent_expired` / `file_ingress_intent_conflict` | Create a new intent/key for a new operation; never replay changed bytes |
| Size/path/digest/static policy fails | Existing `bundle_file_*`, `invalid_bundle_file_name` | No canonical object or revision is published |
| Advisory MIME is missing, unknown, invalid or conflicts | `bundle_file_media_mismatch` diagnostic + `application/octet-stream` | Storage continues; serving remains download-only. An internal route that supplies an exact expected MIME receipt instead rejects a detected mismatch before object promotion |
| Stage/commit idempotency payload changed | `idempotency_conflict` | Re-read/reconcile; new key only for a genuinely new operation |
| One staged ref is used by more than one file operation | `duplicate_staged_bundle_file_reference` | Build a changeset with one distinct verified ref per target path |
| Binding generation or HEAD changed | `staged_file_binding_stale` / `revision_conflict` | Re-read current binding/HEAD and build a new confirmed operation |

The first two generic ingress codes are shared adapter codes; the intent codes
are implemented by the MD-305 repository candidate. Current native
failures retain `native_file_input_unsupported` so the historical MD-248/MD-250
baseline remains backward-compatible.

Audit may retain opaque actor/Space/request IDs, `source_kind`, operation,
status, bounded size category and outcome. It must not retain provider IDs,
temporary URLs, local/workspace paths, raw bytes, request bodies, credentials,
download grants or source content. Durable staged metadata may retain exact
digest/size/media type for integrity and quota; these fields are not emitted as
provider identity or capability.

Успешный mixed-source `commit_changeset` сохраняет в content audit один
canonical bounded `staged_source_receipts` value: JSON-массив из `1..20`
элементов `{ "source_kind", "sha256" }`, отсортированный сначала по закрытому
`source_kind`, затем по digest. Один элемент соответствует одному consumed
staged ref, поэтому одинаковые bytes из нескольких refs сохраняют
множественность. В receipt нет target/display path, staged/provider/object ID,
size, media hint, URL, capability или bytes. Metadata validator принимает
только exact canonical JSON, известные source kinds и SHA-256 и отклоняет
missing/extra/malformed fields внутри той же transaction, что revision, HEAD,
ref consumption, idempotency, audit/outbox и index effects. Markdown-only
commit не получает это поле; controlled automatic-capture metadata остаётся
совместимой с теми же строгими вариантами key set.

## Compatibility, non-goals and open questions

This contract preserves the old boundaries:

- Markdown-only import remains the separate `plan → reserve → stage → validate
  → commit → finalize` Sites profile. It does not accept BundleFile source
  kinds, ZIP extraction or arbitrary binary import.
- `BundleFile` v1/v2/v3 historical semantics and exact bytes remain unchanged;
  new commits target v4 with open advisory media. Deterministic
  `MD-OKF-ZIP-1`/`MD-BUNDLE-ZIP-1` profiles remain separate.
- `session_attachment` native stage, bounded inline staging, server-generated
  streaming staging and local companion are repository-local capabilities. Для
  `bounded_in_memory` Product Site candidate теперь содержит отдельный
  constructor-owned internal port с фиксированным provenance и shared staging
  gate, но public capability row намеренно остаётся `not_available`. Ни одна из
  этих строк не рекламируется как hosted MCP/native support без exact
  client/provider/UAT evidence. `FileIngressCoordinator` dispatches only explicitly enabled
  adapters, reports unavailable rows without fallback and delegates every
  mixed-source commit to the existing atomic HEAD-CAS transaction. The
  Google Drive reference adapter is implemented only in the repository. It
  accepts one exact actor-authorized object ID, never a URL. Binary objects are
  staged byte-for-byte. Google Docs, Sheets and Slides require an explicit
  supported export representation (`DOCX`/`XLSX`/`PPTX`, or `PDF`) and are
  recorded as an export snapshot rather than invented original bytes. Grant,
  object/revision/ownership locators, export endpoint and credentials terminate
  inside the adapter. Hosted support remains `not_available` until MD-319 runs
  the exact-provider UAT contract.
  Revoke, ownership/version drift and changed export bytes discovered during
  streaming collapse to terminal non-retryable `file_ingress_source_unavailable`;
  an actual transient provider transport failure remains retryable. Both paths
  abort quarantine and expose no provider existence detail.
- Browser raw-content API, provider-wide connector sync, resumable non-Markdown
  upload, preview/OCR/transcription, archive import/extraction and production
  antivirus/CDR are not implied by this source matrix.

Open questions intentionally left for child implementation decisions:

- Hosted local-companion UAT must prove the MD-305 one-use HMAC capability,
  OAuth grant/write-binding invalidation, exact 256 MiB streaming and
  GET reconciliation on the exact candidate. Repository tests do not prove
  Sites routing or a real companion/client installation.
- Which hosted producer wiring and runtime limits are required before the local
  server-generated writer can be promoted to UAT evidence (MD-273)?
- Which providers and object types beyond the Google Drive binary and explicit
  Docs/Sheets/Slides reference profile can be supported? Such support requires
  a separate adapter and exact-provider receipt; the Google adapter is not a
  cross-provider fallback.
- Release 0.3 must separately define exact client/profile receipts for direct
  host/provider, connector and generated routes before any of them can move
  from `not_available` to supported.

Protocol exposure itself is accepted: both modern `2026-07-28` and isolated
compatibility `2025-11-25` profiles publish the same strict schemas for
`get_file_ingress_capabilities`, `create_file_upload_intent`,
`reconcile_file_stage` and
`reconcile_changeset`. This is contract/conformance evidence only; each
capability row still reports the exact deployed adapter status and cannot turn
repository-local code into hosted support.

No open question permits a fallback that leaks provider IDs/URLs, local paths or
bytes into the portable application contract, weakens BundleFile
authorization/streaming/download containment, or claims a local/native
capability without evidence.
