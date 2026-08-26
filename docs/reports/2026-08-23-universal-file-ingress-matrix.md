# Universal file ingress: security, conformance и Codex UAT matrix

Статус: dated verification report, 2026-08-23. Документ не меняет accepted
contract и не является production evidence.

Историческая оговорка: capability interpretation этого отчёта superseded
disk-first контрактом Release 0.2 и
[разделяющим отчётом 2026-08-26](2026-08-26-disk-first-ingress-capability-layers.md).
Repository evidence ниже остаётся датированным фактом своего candidate, но не
описывает текущий release selector и не доказывает current hosted support.

## Ответ

Repository candidate реализует и локально проверяет единый file-ingress
boundary для всех шести source kinds. Hosted Codex support для universal
file-ingress пока отсутствует: текущий model-visible UAT plugin публикует старый
12-tool catalog без binding/file tools; provider-specific connector, hosted
local-companion intent и hosted producer transport не подключены. Эти строки
имеют результат `not-available`, а не `pass` и не скрытый fallback.

Отчёт является self-relative: `candidate_sha` — exact `git rev-parse HEAD` в
checkout, где находится этот файл. Task/release receipt обязан сохранить
разрешённый SHA, deployment ID, tool inventory и результаты команд ниже. Parent
implementation checkpoint перед созданием отчёта —
`e496c0fa5abb4141f6f9b9911197be4a6ac0a71d`.

Fresh targeted checkpoint на этом implementation SHA: команда из следующего
раздела прошла `109/109`; `npm run build`, `git diff --check` и repository docs
check прошли; project-docs validator проверил 55 документов и 264 локальные
ссылки после добавления отчёта. Exact final-candidate full gate, dev receipts и
UAT deployment фиксируются отдельным release receipt, потому что Git commit не
может содержать собственный ещё не вычисленный SHA.

## Словарь результата

- `pass` — observable result выполнен на exact candidate указанной командой
  либо current runtime probe.
- `fail` — exact candidate был фактически выполнен и нарушил criterion.
- `not-available` — required transport, credential, provider binding или
  hosted client surface отсутствует; строка не заменяется unit/schema proof.

`not-available` является честным terminal result одной matrix row, но не
делает release-blocking aggregate acceptance успешной.

## Повторяемый запуск

Из clean checkout exact candidate:

```bash
npm ci
CI=true npm run check
git diff --check <base-sha>..<candidate-sha>
```

Targeted separating command для ingress matrix:

```bash
node --test \
  tests/unit/file-ingress-coordinator.test.mjs \
  tests/unit/connector-ingress.test.mjs \
  tests/unit/local-file-companion.test.mjs \
  tests/unit/generated-artifacts.test.mjs \
  tests/integration/local-file-companion.test.mjs \
  tests/integration/bundle-files-core.test.mjs \
  tests/integration/changeset-commit.test.mjs \
  tests/integration/changeset-idempotency.test.mjs \
  tests/integration/export-download-grants.test.mjs \
  tests/conformance/file-ingress-contract.test.mjs \
  tests/conformance/mcp-bundle-file-staging.test.mjs \
  tests/conformance/mcp-binding-tools.test.mjs \
  tests/conformance/mcp-commit-export-tools.test.mjs \
  tests/conformance/mcp-tools.test.mjs \
  tests/integration/security-privacy-threat.test.mjs \
  tests/integration/privacy-safe-observability.test.mjs
```

Configured release gate дополнительно выполняет `dev.synthetic-browser`,
modern/compat dev MCP, exact artifact lineage, authenticated UAT web/control,
modern/compat UAT MCP, changed-surface smoke и persistence-after-redeploy из
[Mind Diary delivery profile](../operations/ship-work-release-profile.md).
Real two-principal canary остаётся informational и требует отдельно переданных
test principals; synthetic server-bound browser gate является blocking.

## Source matrix

| Source / flow | Repository/dev | Hosted Codex UAT | Evidence | Причина `not-available` / resume step |
|---|---|---|---|---|
| `session_attachment`: PNG/JPEG/GIF/WebP/PDF/ZIP | `pass` | `not-available` | Native parameter schema/transport, redirect/size/privacy checks и PNG adapter execution; shared staging отдельно проверяет все accepted MIME/magic signatures | Current mounted UAT catalog не содержит `stage_bundle_file`; reconnect/install current direct-MCP package, pin exact client/plugin/profile, затем выполнить native image/PDF/ZIP stage → commit → read-back |
| `local_path` | `pass` | `not-available` | Local companion snapshots one regular file, denies traversal/symlink/directory/special/changed/oversize, retries exact bytes/key and stages through shared service | Hosted upload intent/companion transport отсутствует; provision explicit one-use path-free transport and repeat exact fixture |
| `workspace/generated_artifact` | `pass` | `not-available` | Explicit workspace authority and the same companion/staging boundary; path does not enter portable identity | Hosted companion intent отсутствует; expose an authorized workspace snapshot transport without sending a path to MCP |
| `connector_object` | `pass` for provider-neutral boundary | `not-available` | Authorized reader keeps provider object/URL/account/credentials inside adapter and streams into shared staging; denial/unavailable fail closed | No provider-specific connector binding or hosted ownership proof; implement one bounded provider adapter and rerun with a synthetic provider object |
| `bounded_in_memory` | `pass` | `not-available` | Exact 4 MiB limit, MIME/digest verification, unsupported/oversize failure before staging | No hosted explicit bounded-bytes ingress tool/producer; add a bounded non-base64 transport or report capability unavailable |
| `server_generated` | `pass` | `not-available` | Streamed quarantine, chunk validation, cancellation, collision ownership and no partial publication | No hosted producer binding/job lease; wire one trusted producer and verify cancellation/redeploy read-back |
| Mixed session + connector + local + workspace/bounded + server-generated + Markdown | `pass` | `not-available` | One integration uses all six source kinds and one Markdown entry in one HEAD-CAS revision, then checks exact canonical bytes, consumption and reconcile replay | Hosted source transports above are absent from current Codex catalog; all required rows must be callable on one exact deployment |

Repository `pass` for `session_attachment` proves the adapter contract and
shared byte gate, not that an arbitrary Codex client can supply a native file.
The hosted row stays `not-available` until a fresh mounted client actually
lists the tool and sends native PNG/PDF/ZIP objects.

## Integrity, lifecycle и atomicity

| Criterion | Result | Executable evidence |
|---|---|---|
| Exact SHA-256, size, MIME magic and safe filename | `pass` | BundleFile core plus local/generated/connector tests |
| Quarantine/verified/expiry/cleanup boundary | `pass` | Stream completion/cancellation, expired stage and bounded cleanup tests |
| Stage exact replay and changed receipt/key conflict | `pass` | `reconcileStage` missing → original ref; changed receipt → `idempotency_conflict` |
| Commit unknown-outcome reconcile | `pass` | `reconcileCommit` missing → original immutable revision; no duplicate revision |
| Duplicate staged ref under two paths | `pass` | `duplicate_staged_bundle_file_reference` before content read or HEAD mutation |
| Stale HEAD / concurrent writer | `pass` | One winner, explicit `revision_conflict`, no hidden merge/partial revision |
| Foreign, expired, consumed or stale-generation ref | `pass` | Current owner/Mind/write-generation checks fail closed |
| Quota/admission rejection | `pass` | Reject before canonical HEAD mutation; no reachable partial revision |
| Mid-transaction/storage failure | `pass` | Candidate objects remain unreachable and metadata transaction preserves HEAD |
| Historical replace/delete and exact bytes | `pass` | New HEAD changes while old revision retains exact raster/PDF/ZIP bytes |
| Persistence/reconstruction | `pass` locally | Memory and Sites-object adapters reconstruct manifest/staged metadata; hosted post-redeploy remains aggregate UAT evidence |

## Authorization и read matrix

| Criterion | Result | Boundary/evidence |
|---|---|---|
| Reader or read-only token cannot stage/commit/reconcile | `pass` | MCP returns `insufficient_scope` before execution; application commit denies Reader |
| Editor/Admin/Owner write authority | `pass` | Shared `content:write` authorizer and current role/binding checks; MD-278 synthetic browser/direct API role matrix remains the role-level source |
| Private/unlisted/public reads | `pass` | Current authorization is checked before metadata/object read; public/unlisted baseline Reader receives exact allowed revision only |
| Foreign Mind/ref and stale binding | `pass` | Ref is pinned to binding owner + Space + write generation and cannot redirect after rebind |
| Token/membership revoke or visibility switch | `pass` | Download/read/reconcile reauthorize current state; revoked/private-switched access fails closed |
| Whole-Mind deletion | `pass` | Canonical lookup/read after deletion is indistinguishable from unavailable and never returns retained bytes |
| Real hosted two-principal file matrix | `not-available` | No separately supplied second UAT principal/credential in this run; resume only with explicit test-principal reference and current hosted file tools |

## Negative security и privacy

| Threat | Result | Evidence / rule |
|---|---|---|
| Absolute path, traversal, glob, symlink, directory, device/special file | `pass` | Local companion rejects before transport; hosted MCP never accepts a path |
| MIME spoof or unsupported SVG/HTML/script/executable | `pass` | Exact magic/MIME/extension gate rejects before canonical publication |
| Oversize and quota exhaustion | `pass` | Source-specific bound plus shared file/changeset/owner/Space admission |
| Arbitrary URL / SSRF / unsafe redirect | `pass` | Native adapter accepts only allowlisted HTTPS provider hosts and revalidates every redirect; connector does not accept a URL contract |
| ZIP extraction or execution | `pass` | ZIP is opaque BundleFile only; no extraction/import/execute path exists |
| Expired/consumed intent or staged ref | `pass` for staged ref; hosted intent `not-available` | Stage state errors are stable; hosted upload-intent implementation does not exist |
| Companion/provider compromise expands server authority | `pass` at boundary | Adapter data remains untrusted; current token, ACL, binding, quota, MIME/digest and HEAD CAS are server-owned |
| Provider ID/URL, local path, bearer/download secret or bytes leak | `pass` | Strict schemas/results and privacy assertions deny these fields in errors, logs, audit and returned staged descriptors |
| Silent base64/URL/path/source fallback | `pass` | Capability rows always report `fallback: none`; absent adapter returns typed unsupported/unavailable error |

No private content, source path, provider locator, credential, bearer/download
URL or raw file bytes belongs in this report or Task Manager comments. Runtime
evidence must persist only allowlisted identifiers, hashes, sizes, MIME types,
status, assertion IDs and redacted failure class.

## MCP profile conformance

Modern `2026-07-28` and isolated compatibility `2025-11-25` publish identical
strict input/output schemas and annotations for
`get_file_ingress_capabilities`, `reconcile_file_stage` and
`reconcile_changeset`. Reconcile tools are `readOnlyHint: true` but require
`content:write`, because they inspect a write-scoped idempotency namespace after
current binding/ACL checks. The compatibility bridge changes only transport
framing; it does not weaken authorization or create another source contract.

Local conformance is `pass`. Current mounted hosted-profile conformance for the
three new tools is `not-available`, because the live catalog does not expose
them. A static tool definition or direct server deployment alone cannot upgrade
that row.

## Aggregate release decision

The implementation and local security/conformance matrix are review-ready.
Universal hosted file ingress is not accepted: every provider/client-dependent
source remains `not-available` until current catalog, binding, actual native or
source transport, exact commit/history/download and post-redeploy read-back are
observed on one deployed SHA.

Minimum resume sequence:

1. Deploy the exact clean-gate candidate to Mind Diary UAT and record Site
   version/deployment plus source digest.
2. Refresh or reconnect the exact direct-MCP plugin so a fresh Codex task sees
   the current catalog; do not infer freshness from package files or cache.
3. Bind one clearly synthetic private Mind with authorized credentials.
4. Execute every actually available source row, security negatives, mixed
   commit/reconcile, exact history/download and persistence-after-redeploy.
5. Keep unavailable transports `not-available`; upgrade only rows backed by
   exact client/provider receipts.
