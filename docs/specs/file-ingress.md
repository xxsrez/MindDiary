# File ingress: один доступный файл

> **Действующее изменение 2026-09-18.** [ADR-0030](../decisions/0030-single-file-input.md)
> заменяет обязательную матрицу из шести источников, model-visible
> `source_kind`, отдельный `/api/mcp/apps`, picker и app-only stage.

Статус: accepted, Release 0.5. Fresh modern Content MCP публикует один
`stage_bundle_file` с `openai/fileParams`. Клиент без native bridge может
использовать один companion upload intent. Internal legacy provenance
сохраняется только в существующих staged records, audit и exact replay.

## Цель и граница

Пользователь передаёт один доступный файл. Различия между локальным файлом,
attachment, workspace artifact, connector object и server output не создают
разные MCP capabilities. Adapter, у которого уже есть разрешённый byte stream,
передаёт его в общий staging service.

```text
user-selected file
        │
        ├─ compatible host: OpenAI file parameter
        │    { download_url, file_id, mime_type?, file_name? }
        │
        └─ client without native bridge: one-use companion upload intent
                 │
                 ▼
       BundleFileStagingService.stageStream
                 │
                 ▼
 opaque staged_file_ref pinned to principal + Mind + usage generation
                 │
                 ▼
 atomic commit_changeset -> one immutable revision or no revision
```

Provider file ID, temporary URL, absolute local path, workspace path and
connector credentials заканчиваются на owning adapter boundary. Они не входят
в domain identity, durable content, model context, audit или release evidence.
Server не принимает arbitrary URL, base64, локальный путь либо provider ID как
самостоятельный MCP argument.

## Modern MCP file parameter

`stage_bundle_file` принимает top-level `file`. Его schema объявляет:

```json
{
  "download_url": "https://...",
  "file_id": "provider-opaque",
  "mime_type": "application/octet-stream",
  "file_name": "optional-display-name"
}
```

`download_url` и `file_id` обязательны, остальные поля advisory. Tool metadata
содержит `_meta["openai/fileParams"] = ["file"]`. Модель не конструирует этот
object и не выбирает тип происхождения. Host создаёт envelope из файла, к
которому у него уже есть доступ.

Adapter до чтения байтов разрешает authenticated principal, exact requested
Mind, current `read_write` usage generation, token scope и ACL. Затем он:

- принимает только HTTPS URL разрешённого OpenAI file host;
- повторяет allowlist check на каждом redirect;
- не передаёт bearer, cookies, referrer или provider credentials;
- применяет общий timeout и counting stream;
- игнорирует private source filename, если оно небезопасно;
- вычисляет exact SHA-256, size и safe media metadata самостоятельно.

Единственный `POST /api/mcp` публикует этот tool.
Отдельного Apps endpoint и обязательного picker resource нет.

## Companion fallback

Клиент без native file bridge использует `create_file_upload_intent`, затем
передаёт один явно выбранный readable regular-file snapshot по same-origin
one-use upload URL.

Fresh `create_file_upload_intent` не принимает `source_kind`,
`write_binding_id`, локальный path или provider locator. Input содержит exact
`mind`, safe display filename, expected size, expected SHA-256 и
`idempotency_key`. Server разрешает current writable target сам.

Companion:

- открывает ровно один absolute regular file без directory, glob, traversal,
  final symlink или special file;
- удерживает стабильный snapshot и сверяет size/digest перед upload;
- не отправляет абсолютный local path на hosted service;
- использует `credentials: omit`, no-referrer и запрещает redirect;
- сначала проверяет intent, затем делает streaming PUT и reconciles неизвестный
  transport outcome через тот же receipt.

URL capability секретен, short-lived и одноразовый. Missing/revoked capability
возвращает indistinguishable `404`; expiry — `410`; conflict — `409`;
oversize — `413`; size/digest mismatch — typed `422`; временная ошибка —
retryable `503`.

## Общий staged contract

Успешный ingress создаёт opaque `staged_file_ref`. Минимальный service-owned
record фиксирует:

```text
staged_file_ref
principal_id
space_id
principal_mind_usage_generation_id
sha256
size
media_type
safe_display_filename
state = quarantined | ready | consumed | rejected | expired
created_at
expires_at
idempotency_fingerprint
```

Internal `sourceKind` может сохраняться в старом record как compatibility
provenance. Он не является selector, authorization identity или fresh API
field.

Stage idempotency namespaced by principal, Mind, operation and key. Same key
with the same verified bytes and metadata returns the same ref; any mismatch
fails closed. `reconcile_file_stage` принимает современный receipt без выбора
source kind. Для exact legacy replay adapter может проверить ограниченный набор
старых fingerprints server-side.

Один `commit_changeset` может использовать несколько независимых refs вместе
с Markdown operations. Каждый ref связывается ровно с одним target path.
Duplicate ref, foreign Mind, expired/consumed state, generation drift, stale
HEAD, lost ACL/scope или quota failure отклоняет весь changeset. Success
consumes все refs и продвигает HEAD одной atomic transaction; failure не
публикует partial revision.

## Форматы, размеры и память

Ingress format-neutral. Missing, invalid, unknown или conflicting media
evidence нормализуется в `application/octet-stream`. Canonical media type —
lowercase MIME essence с exactly one slash и допустимыми `tchar`; значение
ограничено 127 ASCII bytes. Media metadata advisory и не решает, можно ли
позже inline-рендерить файл. Responses используют `nosniff`; unsafe formats
остаются download-only.

Один файл ограничен inclusive 268,435,456 bytes (256 MiB). Byte 268,435,457
fail closed. Если trustworthy Content-Length уже больше лимита, request
отклоняется до body read. Иначе counting stream прекращает чтение на первом
лишнем byte. Реализация не вызывает full-file `arrayBuffer` и не держит
resident memory proportional to file size.

Stage service повторно вычисляет size, SHA-256 и MIME evidence до публикации
ready ref. Quarantined bytes не видны reader и удаляются при rejection/expiry.

## Capability report

`get_file_ingress_capabilities` описывает текущие transports и limits:

```json
{
  "contract_version": 2,
  "source_selection_required": false,
  "max_bytes": 268435456,
  "native_file_input": {
    "transport": "openai_file_parameter",
    "status": "available",
    "route_profile_id": "openai-file-params-v1",
    "verification_status": "declared_unverified"
  },
  "companion_upload": {
    "transport": "one_use_upload_intent",
    "status": "available"
  }
}
```

`available` сообщает deployed server surface, а не доказывает поддержку
конкретного host. `verification_status` становится `verified` только после
fresh client receipt на exact candidate/deployment. Ответ не содержит path,
filename, provider identity, URL, account, credential или private content.

## Внутренние producers

Trusted producers используют тот же `stageStream`, но не становятся новыми MCP
file types.

`ProductSiteRuntime.boundedInMemoryIngress` — constructor-owned test/internal
port с отдельным меньшим admission limit. Он не имеет public HTTP route или MCP
tool и остаётся `not_available` как customer capability, пока exact hosted use
case не проверен.

`ProductSiteRuntime.serverGeneratedIngress` принимает только trusted
cancellable stream и exact safe receipt. Exact 268,435,456 bytes remain
permitted; byte 268,435,457 must fail closed. Producer имеет 600-second producer
lease. Target resolve и reconcile происходят до запуска producer; uncertain
same-key retry performs no generation and no second producer invocation.
Computed MIME essence сверяется с expected evidence before `upload.complete`.
Port adds no MCP/REST tool, route or export surface, а capability row remains
`not_available`.

Эти ports сохраняют разделение ответственности: MD-304 владеет общим streaming
core и storage stage, MD-305 — one-use upload-intent service поверх MD-304.
MD-305 does not own формат, object identity, quota, digest или commit semantics
и не меняет core rules MD-304.

## Безопасность и приватность

- Внешний input не выбирает principal, `space_id`, usage generation, роль или
  quota partition.
- Current scope, token status, ACL, Mind mode и generation проверяются перед
  transport, при stage publication и снова в commit.
- Native download и companion upload никогда не становятся generic URL fetch.
- Raw bytes, provider envelope, local path и temporary URL не попадают в logs,
  telemetry, model context или structured tool result.
- Evidence использует только synthetic non-sensitive fixtures, exact SHA-256,
  size, candidate/deployment IDs и privacy-safe outcome.
- Unknown transport result reconciles exact idempotency fingerprint; retry не
  меняет Mind и не создаёт второй object.

## Совместимость

Existing revisions, staged records и audit с прежним `source_kind` читаются
без миграции. Cached legacy upload-intent calls с `local_path` или
`workspace/generated_artifact` могут завершить уже созданный intent либо
вернуть exact replay. Fresh schemas эту классификацию не предлагают.

История прежней six-source matrix и Apps-specific route сохранена в
[ADR-0018](../decisions/0018-file-ingress-contract-and-source-capability-matrix.md),
[ADR-0023](../decisions/0023-dedicated-mcp-apps-file-ingress-profile.md) и
датированных reports. Эти документы объясняют происхождение решения, но не
задают текущий API.
