# Реестр операций Release 0.3

MD-453 (2026-09-14) добавляет `enqueue_note` (content-write, exact writable Mind)
и `get_note_status` (content-read, exact Mind и исходный principal).
Старый `capture_knowledge` остаётся retired. Контракт приёма и ограничения
Sites описаны в [REST и MCP API](api.md#md-453-асинхронный-приём-заметок-implemented-uat-verified-2026-09-14).

> **Superseding disposition MD-373/MD-383, 2026-09-03.** Principal-owned
> `disabled | read | read_write` заменяет credential target. Site меняет mode
> на уровне Mind; `list_minds` публикует enabled projection; bind/unbind,
> credential target controls, capture toggle и `capture_knowledge` удаляются,
> а writes используют `commit_changeset`. Ordinary Mind сохраняет description-
> based automatic save. Canonical Personal `/me` работает без description и
> допускает write только после прямой просьбы пользователя; `read_write` сам по
> себе такого согласия не даёт. Нормативный delta и migration зафиксированы в
> [режимах использования Mind](mind-usage-modes.md) и machine contract.

Статус: accepted operation-disposition contract, 2026-08-27. Документ
фиксирует целевое распределение уже существующих входных операций после
принятого разделения полномочий Release 0.3. Он не утверждает, что runtime,
плагин или UAT уже переведены на этот контракт.

Machine-readable источник реестра и schema diff:
`tests/fixtures/release-0.3-operation-disposition/contract.v1.json`.
Conformance-проверка сопоставляет его с экспортируемыми route/tool catalogs и
protocol handlers. Навигационную ссылку на этот документ добавляет integration
owner, чтобы не создавать конфликт с параллельными изменениями `docs/README.md`.

## Решение

Release 0.3 оставляет ровно две пользовательские поверхности полномочий:

- **Sites control plane** владеет account/profile, metadata и lifecycle Minds,
  visibility, участниками и ownership, principal-wide режимами использования
  каждого Mind, Connections, credentials, bulk import/export и
  административным удалением;
- **Content MCP** владеет discovery, чтением/search/history/standalone
  validation одного явно выбранного Mind/revision, подготовкой отдельных
  файлов и одним ordinary atomic content commit в единственный текущий
  `read_write` Mind principal.

Каждый content read по-прежнему передаёт ровно один explicit `mind`; где
применимо, selector разрешается в один exact `revision_id`. `fetch` продолжает
использовать server-issued locator, уже зафиксированный на
`space_id + revision_id + path`. Ни одна операция не получает implicit `/me`,
cross-Mind search или возможность выбрать target из corpus/prompt.

## Как читать таблицы

`keep` сохраняет входную operation и её surface; `change` сохраняет имя или
route, но меняет authority/schema/error contract; `move` удаляет прежний
inbound alias и переносит пользовательский workflow на другую surface;
`remove` перестаёт рекламировать operation и оставляет только явный
compatibility response.

Короткие профили ниже задают обязательные поля каждой строки: target surface,
actor, authorization checks, базовую схему ошибок и правило Mind/revision.
Колонка `Delta / compatibility / owner` задаёт отклонение от профиля и
владельца миграции.

| Profile | Target, actor и обязательные checks | Errors и Mind/revision |
|---|---|---|
| `web-session` | Sites control; platform-authenticated identity before or after account bootstrap; identity resolution and safe state projection | `401 authentication_required` or typed bootstrap state; no Mind content |
| `web-bootstrap` | Sites control; platform-authenticated identity without an existing principal; exact external-binding resolution and idempotent isolated-account bootstrap | typed identity/bootstrap conflict; atomically creates one principal and Personal Mind |
| `web-read` | Sites control; current registered Sites actor; identity и current ACL/visibility до metadata read | `401 authentication_required`, indistinguishable `404` where required; exact Mind only where route contains `mind_ref` |
| `web-write` | Sites control; current registered Sites actor; same-origin `Origin`, session CSRF, idempotency/CAS where state changes, current named capability | typed `400/403/409`; no content revision unless operation is the internal final step of Site-owned import |
| `web-import` | Sites control; current actor with exact Mind write authority; quota/reservation/session/CAS checks | bounded typed import errors; exact Mind and base revision, one final HEAD or no change |
| `mind-usage-control` | Sites control; current registered principal, principal-owned settings, current Mind access, `expected_usage_version`, idempotency, singleton ordinary `read_write` and independent Personal `/me` lane | `disabled | read | read_write`; unknown/foreign Mind is indistinguishable `404`; `read_write` additionally requires current writer role and either ordinary authorized description or canonical Personal identity |
| `operator-read` | hidden support surface; current registered Sites actor in constructor-only service-operator allowlist | every other actor receives indistinguishable `404`; no content body or new authority |
| `content-read` | Content MCP; OAuth/personal-token actor with `content:read`, principal usage `read | read_write`, current ACL/visibility and explicit Mind/revision whenever the operation targets content | disabled/inaccessible/missing stay indistinguishable where required; direct user request bypasses only description relevance, never usage/scope/access; no cross-Mind fallback |
| `content-write` | Content MCP; current actor with `content:write`, exact current principal `read_write` lane for the selected Mind, principal-owned mount generation, current ACL, authorized routing profile, idempotency and HEAD CAS; optional source refs are reauthorized | Ordinary automatic write requires description match after explicit discussion; independent Personal write requires a direct current-user request checked by connector policy. Server receives no trusted intent flag; client `mind` is only exact-target assertion |
| `content-ingress` | Content MCP or capability-only HTTP; same principal mount checks as `content-write` plus source ownership, byte/digest/quota/expiry checks | no provider/local locator below adapter; staged result is pinned to current principal-owned mount generation |
| `mcp-transport` | Content MCP; current OAuth/personal-token actor authenticated on every POST; per-method/per-tool scope and current access checks follow after protocol validation | OAuth challenge or protocol error before application call; no session actor cache |
| `oauth` | OAuth adapter; public-client DCR/PKCE, exact redirect/resource, trusted Sites identity at consent, grant/token lifecycle | standard OAuth errors; resource remains canonical `/api/mcp` |
| `delivery-grant` | exact content/export delivery; one-use opaque URL grant captures principal/Mind/revision and rechecks current access at download | invalid/expired/revoked/deleted/unauthorized are one indistinguishable `404` |
| `compat-removed` | no target product capability | omitted from advertised catalog and schemas; exact cached binding names and `capture_knowledge` receive versioned `mind-diary/mcp-operation-retired/v1` with no application call or side effect. Unknown and near-miss names still receive protocol `Invalid params`/`Method not found` |

`PUT /api/v1/minds/{mind_ref}/usage` принимает ровно один mode и
`expected_usage_version`. `disabled` удаляет Mind из MCP projection, `read`
разрешает чтение. Ordinary `read_write` выбирает единственный ordinary
automatic-write Mind и атомарно переводит прежний ordinary writable Mind в
`read`. Personal `/me` переключается независимо и не меняет ordinary lane;
поэтому одновременно возможны две write generations. Настройка принадлежит
principal и одинакова для всех его OAuth grants и personal tokens; scope
конкретного credential может только сузить effective capability. MD-374/MD-382
реализуют Site surface и два lane, MD-376 — MCP projection и инструкции,
MD-379 — server-resolved exact-lane write pin и transactional rechecks.

MD-383 уточняет этот контракт без второй серверной операции. Для ordinary Mind
`authorized_routing_profile` означает непустое authorized description. Для
service-resolved canonical Personal `/me` он означает встроенный
`personal_default`, который не требует description. Server проверяет только
техническую authority. Connector/skill вызывает тот же `commit_changeset` для
Personal Mind лишь после прямой просьбы текущего пользователя сохранить,
запомнить, добавить, обновить или удалить конкретное знание.

## REST control routes

Все строки ниже относятся к текущему `WEB_CONTROL_ROUTES`. `keep` использует
`web-read` для `GET` и `web-write` для mutation, если строка не задаёт другой
профиль.

| Current operation | Disposition → target | Delta / compatibility / owner |
|---|---|---|
| `GET /api/v1/session` | keep → Sites control | Safe session projection; no migration |
| `POST /api/v1/account` | keep → Sites control | Bootstrap only; no migration |
| `PATCH /api/v1/account` | keep → Sites control | Profile metadata only; no migration |
| `GET /api/v1/account/deletion-impact` | keep → Sites control | Fresh destructive preview; no migration |
| `DELETE /api/v1/account` | keep → Sites control | Exact impact + confirmation; no migration |
| `GET /api/v1/minds` | keep → Sites control | Current accessible metadata projection; no read-binding filter |
| `GET /api/v1/mind-usage` | change → Sites control | Principal-wide enabled usage with settings version, at most one ordinary writable generation and an independent Personal `/me` writable generation. MD-374/MD-382 |
| `POST /api/v1/minds` | keep → Sites control | Ordinary Mind create; no migration |
| `GET /api/v1/minds/{mind_ref}` | keep → Sites control | Current metadata after authorization; no content body |
| `GET /api/v1/minds/{mind_ref}/usage` | change → Sites control | Authorized per-Mind `disabled | read | read_write` projection; no credential selector. MD-374 |
| `PUT /api/v1/minds/{mind_ref}/usage` | change → Sites control | `mind-usage-control`; exact mode, `expected_usage_version`, idempotency, ordinary-only singleton switch and independent Personal transition. MD-374/MD-382 |
| `PATCH /api/v1/minds/me/description` | remove → none | Personal Mind не имеет description; fresh route/catalog его не публикует. Реализация удаления — MD-381/MD-384 |
| `GET /api/v1/minds/{mind_ref}/capacity` | keep → Sites control | Current authorized capacity projection |
| `POST /api/v1/minds/{mind_ref}/exports` | keep → Sites control | Actor-owned exact-revision export start; explicit profile for mixed revisions; atomic idempotency, quota reservation and job creation. MD-361 |
| `GET /api/v1/export-jobs/{job_id}` | keep → Sites control | Creator-private bounded status; current read access is rechecked before issuing a short-lived download grant. MD-361 |
| `POST /api/v1/minds/{mind_ref}/markdown-import-plans` | keep → Sites control | `web-import`; no MCP alias |
| `POST /api/v1/minds/{mind_ref}/markdown-imports` | keep → Sites control | `web-import`; no MCP alias |
| `GET /api/v1/markdown-imports/{import_id}` | keep → Sites control | Actor-owned bounded status; `web-import` |
| `PUT /api/v1/markdown-imports/{import_id}/batches/{checkpoint}` | keep → Sites control | Actor-owned bounded staging; `web-import` |
| `POST /api/v1/markdown-imports/{import_id}/validate` | keep → Sites control | Internal import gate, not standalone content validation |
| `POST /api/v1/markdown-imports/{import_id}/commit` | keep → Sites control | Internal final import step; one exact HEAD CAS |
| `DELETE /api/v1/markdown-imports/{import_id}` | keep → Sites control | Cancel temporary state only; canonical HEAD unchanged |
| `PATCH /api/v1/minds/{mind_ref}` | keep → Sites control | Ordinary Mind metadata only |
| `GET /api/v1/minds/{mind_ref}/deletion-impact` | keep → Sites control | Fresh destructive preview |
| `DELETE /api/v1/minds/{mind_ref}` | keep → Sites control | Whole-Mind destructive lifecycle |
| `GET /api/v1/public-minds` | keep → Sites control | Authenticated catalog metadata only |
| `PUT /api/v1/minds/{mind_ref}/visibility` | keep → Sites control | Owner-only exposure warning/current version |
| `GET /api/v1/minds/{mind_ref}/members` | keep → Sites control | Current participant projection |
| `PATCH /api/v1/minds/{mind_ref}/members/{member_id}` | keep → Sites control | Named role capability checks |
| `DELETE /api/v1/minds/{mind_ref}/members/{member_id}` | keep → Sites control | Named revoke capability checks |
| `POST /api/v1/minds/{mind_ref}/leave` | keep → Sites control | Owner cannot leave without transfer/delete |
| `POST /api/v1/minds/{mind_ref}/ownership-transfer` | keep → Sites control | Exact confirmation, sole-owner invariant |
| `GET /api/v1/invitations` | keep → Sites control | Current actor invitations only |
| `GET /api/v1/invitations-overview` | keep → Sites control | Bounded UI projection only |
| `POST /api/v1/minds/{mind_ref}/invitations` | keep → Sites control | Exact registered principal and allowed role |
| `POST /api/v1/invitations/{invitation_id}/accept` | keep → Sites control | Target actor only, current pending state |
| `POST /api/v1/invitations/{invitation_id}/reject` | keep → Sites control | Target actor only, current pending state |
| `POST /api/v1/invitations/{invitation_id}/reissue` | keep → Sites control | Current administrative authority |
| `DELETE /api/v1/invitations/{invitation_id}` | keep → Sites control | Current administrative authority |
| `GET /api/v1/mcp-tokens` | keep → Sites control | Advanced MCP metadata; no secret/verifier |
| `POST /api/v1/mcp-tokens` | keep → Sites control | One-time secret issuance |
| `DELETE /api/v1/mcp-tokens/{personal_token_ref}` | keep → Sites control | Actor-owned revoke |
| `GET /api/v1/connections` | change → Sites control | Current active connection lifecycle only; Mind usage is principal-wide and read from Mind settings. MD-374 |
| `GET /api/v1/connections/{connection_ref}` | change → Sites control | Connection details no longer expose or mutate credential-specific Mind targets. MD-374 |
| `DELETE /api/v1/connections/{connection_ref}` | keep → Sites control | Actor-owned connection revoke |

Старые `PATCH .../mind-access` routes удалены из published
`WEB_CONTROL_ROUTES`. Migration narrative может вернуть `operation_removed`
для уже полученного legacy request на старом artifact, но свежий Site не
регистрирует эти routes и не считает их compatibility operations.

The hidden operator alias `GET /api/v1/internal/operators/users` and UI route
`GET /internal/operators/users` remain unchanged read-only support projections;
they are not product authority and keep constructor-only operator checks plus
indistinguishable `404` for every other actor.

## Capability, delivery и OAuth HTTP routes

| Current operation | Disposition → target | Delta / compatibility / owner |
|---|---|---|
| `GET /api/v1/exports/{grant}` | move → Sites export delivery | Grant download remains one-use and reauthorizes current read access, but only a Site-owned export workflow may issue it. Existing MCP job issuers are retired. MD-359 owns Site workflow routes |
| `GET /api/bundle-download/{grant}` | keep → content delivery | Exact Mind/revision BundleFile grant, current access recheck; not bulk export |
| `GET /api/file-ingress/v1/upload-intents/{capability}` | change → content ingress | Status is capability-only; write pin uses the current principal-owned mount generation, not historical `write_binding_id`. MD-379 |
| `PUT /api/file-ingress/v1/upload-intents/{capability}` | change → content ingress | Same principal mount rule plus byte/digest/quota/expiry checks; MD-379 |
| `GET /.well-known/oauth-protected-resource` | keep → OAuth | Canonical resource metadata for `/api/mcp` |
| `GET /.well-known/oauth-protected-resource/api/mcp` | keep → OAuth | Same metadata alias |
| `GET /.well-known/oauth-authorization-server` | keep → OAuth | No authority change |
| `GET /.well-known/openid-configuration` | keep → OAuth compatibility | Existing metadata compatibility alias; does not claim ID tokens |
| `POST /oauth/register` | keep → OAuth | Public-client DCR only |
| `GET /oauth/authorize` | keep → OAuth | Trusted Sites identity and exact request/redirect/resource |
| `POST /oauth/authorize` | keep → OAuth | Explicit consent; account control is not granted |
| `POST /oauth/token` | keep → OAuth | PKCE/refresh/resource/grant checks |
| `POST /oauth/revoke` | keep → OAuth | Credential revoke; Site Connection UI remains product control |
| `POST /api/mcp` | change → Content MCP modern | Enabled 25-tool projection, centralized instructions and one standard native file parameter; canonical OAuth resource unchanged. MD-376/MD-379/MD-470/ADR-0030 |
| `POST /api/mcp/2025-11-25` | change → Content MCP compatibility | Isolated legacy lifecycle, same enabled tool catalog and centralized instructions. MD-376 |
| any `/mcp` | remove → none | Preserve explicit product `404 route_not_found`; never redirect a bearer request |

## MCP tool register

| Current tool | Disposition → target | Schema/error delta, compatibility и migration owner |
|---|---|---|
| `list_minds` | change → Content MCP | Lists only principal-enabled `read | read_write` Minds with effective capability, settings version and each current lane generation. At most one ordinary descriptor and independently Personal `/me` may expose `writable_mount.active=true`; `routing_profile` distinguishes them. MD-381/MD-386/MD-382 |
| `resolve_mind` | change → Content MCP | Exact enabled handle only; explicit user request never bypasses disabled/scope/current access. MD-376 |
| `get_mind_info` | change → Content MCP | Explicit enabled Mind/revision and effective capability; historical mode remains read-only. MD-376 |
| `get_mind_bindings` | remove → none | Omit from both catalogs/schemas; exact cached call returns side-effect-free `mind-diary/mcp-operation-retired/v1` and points to principal Mind usage on Site. MD-376 |
| `browse_entries` | change → Content MCP | One enabled explicit Mind/revision per call; no corpus vacuum or fallback. MD-376 |
| `search` | change → Content MCP | One enabled explicit Mind/revision only; multiple relevant Minds require sequential calls. MD-376 |
| `fetch` | change → Content MCP | Opaque exact-revision locator unchanged; current usage and access are rechecked. MD-376 |
| `list_files` | add → Content MCP | Deterministic manifest/path and bounded structured-metadata selection for one enabled explicit Mind/revision. MD-408/MD-415 |
| `grep_files` | add → Content MCP | Literal or safe single-line regex matching over explicitly selected UTF-8 files; no semantic expansion. MD-408/MD-414 |
| `read_files` | add → Content MCP | Whole/head/tail/line/UTF-8 byte ranges for up to 32 exact paths, with manifest-bound continuation. MD-408/MD-416 |
| `list_revisions` | change → Content MCP | Enabled explicit Mind; current access only; history stays read-only. MD-376 |
| `get_revision` | change → Content MCP | Explicit Mind + exact revision; historical view stays read-only |
| `validate_mind` | change → Content MCP | Standalone exact revision validation; not import-session validation |
| `list_bundle_files` | change → Content MCP | Explicit Mind/revision, no binding; metadata only |
| `set_read_mind_binding` | remove → none | Omit from both catalogs/schemas; exact cached call directs the user to per-Mind usage on Site and has no side effect. MD-376 |
| `set_write_mind_binding` | remove → none | Omit from both catalogs/schemas; exact cached call directs the user to the single principal `read_write` mode on Site and has no side effect. MD-376 |
| `get_file_ingress_capabilities` | change → Content MCP | Read-only transport/limit report; no source selection, client/path promise or provider data. ADR-0030 |
| `create_file_upload_intent` | change → Content MCP | One companion fallback; no source/binding/generation selector. Explicit `mind` is an assertion against current principal `read_write` state. ADR-0030/MD-379 |
| `stage_bundle_file` | change → modern Content MCP | One top-level `openai/fileParams` input; provider envelope terminates at adapter and service pins current principal usage generation. ADR-0030/MD-379 |
| `reconcile_file_stage` | change → Content MCP | Reconcile exact target/digest/idempotency payload without source selection under current principal usage generation. ADR-0030/MD-379 |
| `get_bundle_file_download` | change → Content MCP | Exact enabled Mind/revision current read; usage is rechecked. MD-376 |
| `preflight_changeset` | add → Content MCP | Read-only dry-run of the exact operations against an explicit writable Mind and expected HEAD; uses the commit producer profile and full resulting-bundle doctor, exposes exact base and prepared identity, and never reserves or saves. MD-470 |
| `commit_changeset` | change → Content MCP | Canonical write: explicit target assertion, expected HEAD, idempotency, bounded operations and optional max-8 strict `source_references[{mind,revision,path}]`; service resolves the selected Mind's current ordinary or Personal `read_write` generation and reauthorizes target/source transactionally. MD-376/MD-379/MD-382 |
| `reconcile_changeset` | change → Content MCP | Exact original commit payload including unchanged `source_references`; missing outcome performs no writes. MD-376/MD-379 |
| `capture_knowledge` | remove → none | Omit from both catalogs/schemas; exact cached call is side-effect-free and directs the agent to canonical `commit_changeset`. MD-376 |
| `start_export` | move → Sites control | Omit from catalog; exact old call returns side-effect-free `operation_moved_to_sites` with the Sites REST route and never starts a job. MD-359/MD-361 |
| `get_export_status` | move → Sites control | Omit from catalog; exact old call returns the same side-effect-free migration result; Site status/download only. MD-359/MD-361 |

The complete modern target schema catalog contains 25 tools in stable order,
including the two ADR-0025 Personal-configuration tools, three MD-408 file
operation tools and two managed note tools. Modern `/api/mcp` publishes the
complete catalog. Compatibility omits only `stage_bundle_file` until its exact
client/profile pair has separate native-file evidence.

```text
get_personal_mind_configuration
set_personal_mind_description
list_minds
resolve_mind
get_mind_info
browse_entries
search
fetch
list_files
grep_files
read_files
list_revisions
get_revision
validate_mind
list_bundle_files
get_file_ingress_capabilities
create_file_upload_intent
stage_bundle_file
reconcile_file_stage
get_bundle_file_download
preflight_changeset
commit_changeset
reconcile_changeset
enqueue_note
get_note_status
```

## MCP Resources и protocol profiles

Modern `2026-07-28`:

| Method | Disposition | Target behavior |
|---|---|---|
| `server/discover` | change | Keep version/capabilities; centralized instructions describe description-relevant or user-requested enabled reads, sequential multi-Mind calls, automatic discussed-knowledge save, OKF validation/read-back/conflict reconciliation and user notification. MD-376 |
| `resources/templates/list` | keep | Authenticated empty list; no implicit templates |
| `resources/list` | change | Enumerate only authorized root `index` resources from current access, without binding |
| `resources/read` | change | Reauthorize exact `okf://spaces/{space_id}/revisions/{revision_id}/...`; no HEAD or cross-Mind fallback |
| `tools/list` | change | Advertise the complete 25-tool modern projection, including one standard native file tool |
| `tools/call` | change | Execute only advertised target tool and target schemas |
| `initialize` | remove | Preserve explicit `Method not found`; modern profile never starts legacy lifecycle |
| `ping` | remove | Preserve current `Method not found`; not silently added by this migration |

Compatibility `2025-11-25`:

| Method | Disposition | Target behavior |
|---|---|---|
| `initialize` | change | Keep isolated negotiation; update instructions and advertised tool capability |
| `notifications/initialized` | keep | `202` for exact notification |
| `ping` | keep | Empty successful result |
| `tools/list` | change | Advertise the 24-tool compatibility projection; omit native stage until exact client evidence |
| `tools/call` | change | Same target schemas and authorization |
| `resources/templates/list`, `resources/list`, `resources/read` | remove | Preserve compatibility `Method not found`; resources are not silently widened in this profile |
| `server/discover` | remove | Preserve compatibility `Method not found` |

Отдельного MCP Apps endpoint, picker resource или app-only tool projection нет.
Host bridge формирует standard file object, а modern adapter возвращает только
privacy-safe staged receipt. Provider envelope и bytes не входят в durable
content или model-visible metadata.

Resource URI grammar remains exact and token-free:

```text
okf://spaces/{space-id}/revisions/{revision-id}/index
okf://spaces/{space-id}/revisions/{revision-id}/entries/{path}
```

Resources never become user-openable web URLs, bearer capabilities or a
company-knowledge claim.

## Web, plugin и Help surface

| Surface | Disposition | Target behavior / owner |
|---|---|---|
| `/`, `/me`, `/minds`, `/{space_handle}`, `/public`, `/invitations`, `/settings/account`, `/internal/operators/users` | keep | Existing Sites control purpose and authorization boundary |
| `/settings/connections` | change | Connection lifecycle only; Mind access modes are principal-wide and configured on each Mind. MD-374 |
| `/settings/connections/{connection_ref}` | change | Connection details expose no credential-specific readable/writable target controls. MD-374 |
| `/settings/developer/mcp` | change | Personal-token lifecycle remains; tokens inherit principal usage and only scopes narrow effective capability. MD-374 |
| `/settings/mcp` | keep | Registered `GET`/`HEAD` stays `308` to Advanced MCP; signed-out safe shell unchanged |
| `/help/codex` | change | `MD-376`: install → authenticate → read enabled explicit Minds by user request/description → configure per-Mind usage on Site; automatic save uses `commit_changeset` |
| `/help` | change | `integration-owner`: starter/concierge copy must not call removed binding/export tools |
| Marketplace package `mind-diary@srez-marketplace` | change | Keep `AVAILABLE + ON_USE`, switch current transport to canonical modern `/api/mcp`, and publish a new immutable package version for the catalog/schema change |
| Bundled Mind Diary skill | change | `integration-owner`: remove binding/capture/export-tool instructions; use enabled descriptions for reads, one exact Mind/revision per call, automatic save of explicitly discussed matching knowledge through `commit_changeset`, OKF validation/read-back/conflict reconciliation and user notification |
| Plugin card/help label `Mind Diary UAT` | keep | `integration-owner`: UAT remains explicit; no production/public-directory claim |

Static asset routes do not carry product authority and remain unchanged.
The machine fixture assigns an implementation/migration owner to every row and
pins each package, skill or Help requirement to exact Git-blob source evidence.
Those blob pins describe the current legacy artifacts that an implementation
lane must replace; they are not evidence that the target copy is already
published.

## Machine-readable schema diff

The fixture records every changed or removed wire field. Normative highlights:

Имена `expected_usage_version`, `disabled`, `read`, `read_write`,
`settings_version`, `writable_mount.generation`, `writable_mind_required` и
`writable_mind_stale` являются каноническими machine names этого operation
contract. Generation принадлежит principal mount, а не credential binding, и
никогда не принимается от клиента как authority. Stale usage CAS не меняет
state и не допускает last-write-wins. MD-374 владеет Site mode transition,
MD-376 — MCP projection/guidance, MD-379 — write pin и transactional rechecks.

- remove `write_binding_id` from `create_file_upload_intent`,
  `stage_bundle_file`, `reconcile_file_stage`, `commit_changeset` and
  `reconcile_changeset`;
- remove `capture_knowledge` from the fresh catalog and accept only its exact
  cached name through the side-effect-free retired dispatcher;
- replace the old source matrix in `get_file_ingress_capabilities` with one
  native transport, one companion transport and the common byte limit;
- keep required explicit `mind` on every target-sensitive content operation;
- remove `get_mind_bindings`, `set_read_mind_binding`,
  `set_write_mind_binding`, `start_export`, `get_export_status` from both tool
  catalogs and published schemas. The dispatcher recognizes only the exact
  cached binding names to return versioned `mind-diary/mcp-operation-retired/v1`
  without application calls or side effects; this compatibility response is
  not a hidden alias and cannot perform the retired operation;
- add optional max-8 strict `source_references[{mind,revision,path}]` to
  `commit_changeset` and `reconcile_changeset` and keep it identical during
  uncertain-outcome reconciliation;
- remove both credential `mind-access` REST routes from the fresh Site catalog;
  per-Mind usage uses `expected_usage_version` and one of the three exact modes;
- retire binding errors from fresh read paths and use the `content-write`
  `writable_mind_*` error set only where a content write or ingress operation
  requires the current principal mount.

During migration, old MCP names are never forwarded to Site endpoints and old
REST read-binding actions never become no-op success. Exact cached binding calls
fail explicitly through the versioned retired result; unknown/near-miss names
remain protocol errors. The result contains no raw owner, binding, generation,
Mind or credential identifier and does not inspect application state;
reconnect/reissue/state migration and preservation rules belong to MD-374/MD-379.
Pending legacy credential также не получает список или metadata новых Minds:
до explicit upgrade/re-consent/reissue все ACL-derived discovery/read operations
fail closed одним versioned compatibility result. После перехода fresh/upgraded
profile читает только по current ACL/visibility; historical read bindings не
становятся authority и `mind_binding_required` не возвращается.
Sites usage handler predicates and mode CAS belong to MD-374.
Export route creation and exact Site projection belong to MD-359.

## Verification boundary

The conformance fixture proves closed inventory and target contract consistency
with the repository source candidate. It does **not** prove runtime migration,
plugin publication, UAT behavior, OAuth reconsent, persistence migration or
production deployment. Those claims require their owning implementation and
exact hosted evidence.

## Поправка ADR-0025: Personal configuration

`get_personal_mind_configuration` и `set_personal_mind_description` добавляют
узкую metadata surface собственного Personal Mind. Оба требуют отдельный
`personal:configure`; второй также metadata CAS и idempotency. Они не выбирают
Mind, principal, mode или scopes, не читают corpus и не меняют HEAD. Совпадение
тем разрешает независимое использование двух Minds по
[новому routing-контракту](mind-usage-modes.md). Это дополнение не возвращает
удалённые общие control-plane инструменты в MCP.
