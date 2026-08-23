# Единый file-ingress contract и source capability matrix

Статус: accepted contract boundary, 2026-08-23. `normative_status: accepted`;
`implementation_status: partial_by_source`: общий portable boundary принят,
`session_attachment`, `bounded_in_memory` и `server_generated` реализованы в
local candidate и требуют отдельного exact evidence; MD-272 добавляет
local-only companion implementation для `local_path` и
`workspace/generated_artifact`. Native-file UAT остаётся MD-250, hosted
upload-intent/producer evidence и provider-specific connector adapter остаются
отдельными claims. MD-274 добавляет repository-local `FileIngressCoordinator`,
explicit stage/commit reconcile, mixed-source atomic integration и три
contracts на существующих MCP endpoints: `get_file_ingress_capabilities`,
`reconcile_file_stage`, `reconcile_changeset`. Это не добавляет новый hosted
endpoint или source transport.

## Цель и граница

MD-271 фиксирует один portable application contract для шести способов
получить bytes, которые затем могут стать producer-defined `BundleFile` в одной
immutable `SpaceRevision`. Контракт отделяет источник bytes от канонического
file path, object identity и revision semantics. Existing
[BundleFile contract](bundle-files.md), OKF 0.2 и
[Sites storage/capacity/import contract](sites-storage-capacity-import.md) остаются
источниками точных manifest, quota, import и export rules.

Требование пользователя: Release 0.1 должен уметь свести session attachment,
local disk, workspace/generated artifact, authorized connector object,
bounded in-memory bytes и server-generated output к одной проверяемой модели.
Это требование не означает, что каждый adapter уже существует или что текущий
MCP client умеет передать каждый вид source.

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
- Canonical MIME выбирается по exact bytes. Declared MIME, filename и
  provider metadata — только hints; `BundleFile` allowlist, display-name и
  canonical-path policy применяются без ослабления.
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
The record does not change OKF frontmatter or the v2/v3 manifest: only a
successful commit adds the canonical `kind: opaque` entry.

## Source capability matrix

`Status` относится к repository candidate, exact SHA которого фиксируется в
Task/release evidence после commit.
`implemented_local` означает repository code/tests only; `UAT pending` не
является hosted capability. `proposal` означает contract slot, а не
реализованный fallback.

| Source kind | Adapter owns reading | Transport boundary | Status / evidence | Explicit fallback |
|---|---|---|---|---|
| `session_attachment` | MCP/provider adapter | Native client file parameter; adapter follows provider HTTPS object/redirect policy | `implemented_local`, `UAT pending` MD-250; `_meta["openai/fileParams"]=["file"]` is local schema evidence, not live client proof | If the pinned profile cannot supply native `file`, return `native_file_input_unsupported`; do not use base64, local path or arbitrary URL |
| `local_path` | Local companion process | Out-of-band upload intent/equivalent binary stream; companion snapshots one regular file and sends bounded bytes | `implemented_local`, MD-272 unit/integration evidence; hosted intent/UAT pending | Missing companion, expired/invalid intent or revoked auth: `file_ingress_source_unsupported` / `file_ingress_intent_expired`; never send the path to hosted MCP |
| `workspace/generated_artifact` | Local companion process with explicit workspace authority | Same out-of-band intent/equivalent stream, but artifact snapshot is selected by the local process | `implemented_local`, MD-272 unit/integration evidence; hosted intent/UAT pending | Missing companion/workspace authority: `file_ingress_source_unsupported`; no path fallback or arbitrary URL |
| `connector_object` | Explicit authorized connector adapter | Connector API/object fetch with provider-specific bounded stream; arbitrary URL is not a connector contract | Provider-neutral reader/staging boundary is `implemented_local` with unit and mixed-source integration evidence; provider binding and hosted UAT pending | Connector absent, revoked or object unavailable: generic `file_ingress_source_unavailable`; no cross-provider or native fallback |
| `bounded_in_memory` | Calling adapter / trusted inline boundary | Explicit bounded bytes transport, not implicit JSON-RPC base64; local companion caps local generated path at 4 MiB and shared staging validates it | `implemented_local`, MD-272/MD-273; exact local tests cover limit, digest/MIME and quarantine; hosted UAT pending | Over limit or unsupported profile: `bundle_file_size_limit_exceeded` / `file_ingress_source_unsupported`; caller must choose out-of-band source |
| `server_generated` | Trusted server-side producer | Internal application port or bounded job output; no client-supplied source locator; local provider writer streams to quarantine storage | `implemented_local`, MD-273; exact local tests cover stream, cancellation and no partial publication; hosted producer evidence pending | Producer unavailable/expired: `file_ingress_source_unavailable`; no client URL or path fallback |

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
| One staged/canonical BundleFile | 67,108,864 bytes (64 MiB) | Fail closed before canonical HEAD mutation |
| BundleFile operations in one changeset | 20 | One staged ref per file operation; no duplicate ref |
| Staged bytes referenced by one changeset | 134,217,728 bytes (128 MiB) | Markdown limits and resulting revision limits still apply |
| Outstanding verified staged bytes per binding owner | 268,435,456 bytes (256 MiB) | Includes all source kinds in that owner namespace |
| Verified staged-ref TTL | 3,600 seconds (60 minutes) | Expiry is service time; ref is not reader-visible |
| One-use upload intent TTL (proposed out-of-band sources) | 600 seconds (10 minutes) | Intent is separate from `staged_file_ref`; no replay after expiry |
| Retained canonical objects per Space | 2,147,483,648 bytes (2 GiB) | Lower applicable capacity limit wins |

Existing limits remain unchanged: resulting HEAD has at most 10,000 entries,
1 GiB total and 64 MiB Markdown subtotal; orphan safety window is 24 hours.
The accepted lower-specific-limit rule from BundleFile and the Sites storage
contract remains authoritative.

### Source-specific transport budgets

| Source kind | Source-specific budget | Where bytes/metadata are checked | Initial state and success |
|---|---|---|---|
| `session_attachment` | `file_id` ≤ 1,024 chars; temporary URL ≤ 8,192; name ≤ 1,024; MIME hint ≤ 256; current Sites adapter default: 30,000 ms, up to 4 redirects, 64 MiB stream | Provider adapter checks HTTPS allowlist, credentials omission, redirect/timeout/stream bound; application recomputes SHA-256, size, magic MIME and safe filename | `quarantined → verified → staged_file_ref`; only verified ref may enter commit |
| `local_path` | One regular file per intent, ≤ 64 MiB; proposed intent 600 s; staged ref 3,600 s | Companion checks regular-file/snapshot/size/digest before upload; application rechecks exact bytes, MIME and filename after upload | `intent → quarantined → verified`; changed snapshot is a new key, not a changed retry |
| `workspace/generated_artifact` | One selected artifact per intent, ≤ 64 MiB; proposed intent 600 s; staged ref 3,600 s | Companion checks workspace authority and snapshot; application rechecks bytes, digest, MIME and safe filename | Same as `local_path`; workspace path never reaches application identity |
| `connector_object` | One object per stage, ≤ 64 MiB; proposed fetch deadline 30 s and at most 4 provider redirects where the connector permits; staged ref 3,600 s | Connector validates grant/object ownership and bounded fetch; application recomputes digest, size, magic MIME and filename | `quarantined → verified`; provider metadata is advisory only |
| `bounded_in_memory` | One object per explicit call, ≤ 4,194,304 bytes (4 MiB); no upload intent; staged ref 3,600 s | Calling adapter enforces byte bound; application recomputes digest, size and MIME before quarantine promotion | `quarantined → verified`; larger payload must use an explicit out-of-band source |
| `server_generated` | One producer output, ≤ 64 MiB; proposed generation lease 600 s; staged ref 3,600 s | Trusted producer supplies bytes, but application still checks exact digest, size, magic MIME and safe filename | `quarantined → verified`; producer job identity is not a file identity |

The current `session_attachment` values are repository-verified composition
defaults, not a claim about every OpenAI host or client. A changed timeout,
redirect allowlist, inline limit or intent TTL is a versioned contract change
with targeted checks and applicable UAT evidence.

Verification is deliberately two-stage: source adapters protect transport and
ownership boundaries; the application owns canonical byte-level integrity and
BundleFile allowlist decisions. Declared MIME/extension never overrides magic
detection. Unsupported types, SVG/HTML/script/executable content, archive
members and ZIP extraction remain denied by the BundleFile policy.

### Idempotency and reconcile

- Stage idempotency is namespaced by binding owner, operation and key. The
  canonical payload hash includes `source_kind`, exact bytes digest/size and
  safe canonical metadata. Same key and same payload return the same
  `staged_file_ref`/expiry; a changed source, snapshot, metadata or digest
  returns `idempotency_conflict`.
- An unknown stage or upload-intent outcome is reconciled by repeating the
  exact safe receipt: current actor/binding, source kind, idempotency key,
  canonical metadata, digest and size. `reconcileStage` never uploads bytes or
  reserves capacity; it returns the existing verified ref, `missing`, a stable
  state error or `idempotency_conflict`. The client does not change source,
  restage with a new key or infer failure from a network timeout.
- Upload intents are one-use. Exact replay of the same idempotency key may
  recover the same intent before expiry; a changed payload or second consumer
  returns `file_ingress_intent_conflict`.
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

## Native MCP capability negotiation

The current `stage_bundle_file` tool is the `session_attachment` profile. Both
modern `2026-07-28` and isolated compatibility `2025-11-25` adapters may
advertise the native `file` parameter for a write-capable credential, with
`_meta["openai/fileParams"] = ["file"]`. The local schema and transport tests
prove only the repository candidate. Exact client/profile support remains a
blocking MD-250 UAT row; a missing native capability is a non-passing result,
not an automatic switch to another source.

Read-only credentials do not gain staging by seeing the tool definition. The
server checks token scope, current write binding, current ACL and exact Mind
again on every call. Compatibility framing does not create a second source
contract or bypass the same application gate.

Future local/connector adapters must negotiate their own explicit capability
and source kind. The implemented generated paths must not overload the native
`file` field with a local path, arbitrary URL or unbounded bytes. Until the
corresponding implementation and conformance evidence exists, the capability
is `not-available`; hosted UAT for generated paths is still a separate claim.

## Errors, privacy and audit

Stable errors are split by boundary:

| Situation | Code | Retry/fallback rule |
|---|---|---|
| Current native profile cannot accept a client file | `native_file_input_unsupported` | No silent base64/path/URL fallback; choose an explicitly supported adapter |
| Source kind has no enabled adapter/profile | `file_ingress_source_unsupported` | Non-retryable capability result; no automatic source conversion |
| Source object cannot be read or ownership cannot be established | `file_ingress_source_unavailable` | Generic response without existence/owner leak; retry only after source state is fixed |
| Bounded source transport temporarily fails | `file_ingress_transport_unavailable` | Retry exact request/key while source TTL permits; do not alter payload |
| Upload intent expired/consumed or changed | `file_ingress_intent_expired` / `file_ingress_intent_conflict` | Create a new intent/key for a new operation; never replay changed bytes |
| Size/MIME/path/digest/static policy fails | Existing `bundle_file_*`, `unsupported_bundle_file_type`, `bundle_file_media_mismatch`, `invalid_bundle_file_name` | No canonical object or revision is published |
| Stage/commit idempotency payload changed | `idempotency_conflict` | Re-read/reconcile; new key only for a genuinely new operation |
| One staged ref is used by more than one file operation | `duplicate_staged_bundle_file_reference` | Build a changeset with one distinct verified ref per target path |
| Binding generation or HEAD changed | `staged_file_binding_stale` / `revision_conflict` | Re-read current binding/HEAD and build a new confirmed operation |

The first two generic ingress codes and intent codes are contract-level additions
for future adapters; they do not claim current implementation. Current native
failures retain `native_file_input_unsupported` so MD-248/MD-250 remain
backward-compatible.

Audit may retain opaque actor/Space/request IDs, `source_kind`, operation,
status, bounded size category and outcome. It must not retain provider IDs,
temporary URLs, local/workspace paths, raw bytes, request bodies, credentials,
download grants or source content. Durable staged metadata may retain exact
digest/size/media type for integrity and quota; these fields are not emitted as
provider identity or capability.

## Compatibility, non-goals and open questions

This contract preserves the old boundaries:

- Markdown-only import remains the separate `plan → reserve → stage → validate
  → commit → finalize` Sites profile. It does not accept BundleFile source
  kinds, ZIP extraction or arbitrary binary import.
- `BundleFile` v1/v2/v3 manifest semantics, exact historical bytes, current
  quotas and deterministic `MD-OKF-ZIP-1`/`MD-BUNDLE-ZIP-1` exports are
  unchanged.
- `session_attachment` native stage, bounded inline staging, server-generated
  streaming staging and local companion are repository-local capabilities. None
  is advertised as hosted MCP/native support without exact client/provider/UAT
  evidence. `FileIngressCoordinator` dispatches only explicitly enabled
  adapters, reports unavailable rows without fallback and delegates every
  mixed-source commit to the existing atomic HEAD-CAS transaction. The
  provider-specific connector binding remains not-available; the local generic
  reader contract proves only that an authorized adapter can stream verified
  bytes without leaking provider identity into staging.
- Browser raw-content API, provider-wide connector sync, resumable non-Markdown
  upload, preview/OCR/transcription, archive import/extraction and production
  antivirus/CDR are not implied by this source matrix.

Open questions intentionally left for child implementation decisions:

- Hosted local-companion trust/consent and one-use upload-intent endpoint remain
  an open UAT/platform decision; MD-272 proves the local adapter boundary
  without creating a private Sites bypass.
- Which hosted producer wiring and runtime limits are required before the local
  server-generated writer can be promoted to UAT evidence (MD-273)?
- Which connector object types and provider-specific ownership proofs can be
  supported, and how are their bounded fetch receipts represented (future
  connector work)?
- Which exact client/profile capability receipts are required before a source
  can move from `proposal`/`not-available` to `implemented` or UAT-supported?

Protocol exposure itself is accepted: both modern `2026-07-28` and isolated
compatibility `2025-11-25` profiles publish the same strict schemas for
`get_file_ingress_capabilities`, `reconcile_file_stage` and
`reconcile_changeset`. This is contract/conformance evidence only; each
capability row still reports the exact deployed adapter status and cannot turn
repository-local code into hosted support.

No open question permits a fallback that leaks provider IDs/URLs, local paths or
bytes into the portable application contract, weakens BundleFile static policy,
or claims a local/native capability without evidence.
