# Реестр операций Release 0.3

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
  visibility, участниками и ownership, Connections, выбором единственного
  writable target, credentials, bulk import/export и административным
  удалением;
- **Content MCP** владеет discovery, чтением/search/history/standalone
  validation одного явно выбранного Mind/revision, подготовкой отдельных
  файлов и одним ordinary atomic content commit в заранее выбранный на Site
  writable target.

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
| `credential-control` | Sites control; credential-owner authority, target-version CAS and idempotency are common; action-specific checks are defined below | unknown/foreign ref is indistinguishable `404`; target selection is `0..1`, never content-selected |
| `operator-read` | hidden support surface; current registered Sites actor in constructor-only service-operator allowlist | every other actor receives indistinguishable `404`; no content body or new authority |
| `content-read` | Content MCP; current OAuth/personal-token actor with `content:read`, current ACL/visibility and explicit Mind/revision whenever the operation targets content | no `mind_binding_required`; denied/missing stay indistinguishable where required; no cross-Mind fallback |
| `content-write` | Content MCP; current actor with `content:write`, current ACL, Site-selected writable target, idempotency and HEAD CAS | `writable_target_required`, `writable_target_mismatch`, `writable_target_unavailable`, revision/idempotency conflicts; one exact target |
| `content-ingress` | Content MCP or capability-only HTTP; same checks as `content-write` plus source ownership, byte/digest/quota/expiry checks | no provider/local locator below adapter; staged result is pinned to current credential target defined by MD-339 |
| `mcp-transport` | Content MCP; current OAuth/personal-token actor authenticated on every POST; per-method/per-tool scope and current access checks follow after protocol validation | OAuth challenge or protocol error before application call; no session actor cache |
| `oauth` | OAuth adapter; public-client DCR/PKCE, exact redirect/resource, trusted Sites identity at consent, grant/token lifecycle | standard OAuth errors; resource remains canonical `/api/mcp` |
| `delivery-grant` | exact content/export delivery; one-use opaque URL grant captures principal/Mind/revision and rechecks current access at download | invalid/expired/revoked/deleted/unauthorized are one indistinguishable `404` |
| `compat-removed` | no target product capability | omitted from advertised catalog; exact old call returns protocol `Invalid params`/`Method not found`, never silently performs another action |

`select_write` additionally requires active credential lifecycle,
`content:write`, current writer role and target eligibility. `clear_write`
requires credential-owner authority, active credential lifecycle,
`expected_target_version` and idempotency: target ACL, current writer role and
target eligibility are not preconditions. A revoked or expired credential
cannot clear state, but an active credential may clear after target ACL/role
loss or target deletion without revealing target metadata. This action-specific
split is normative; the shared `credential-control` profile must not be
interpreted as adding the remaining select-only checks to recovery-safe clear.

Это target disposition, а не описание уже изменённого runtime. В текущем
as-built Sites helper `clear_write` всё ещё требует `content:write`, принимает
`expected_binding_version`, возвращает `409 write_step_up_required` без write
scope и пробрасывает stale CAS как `409 binding_version_conflict`. Executable
fixture проверяет эти legacy predicates/results через реальный helper и HTTP
handler и отдельно проверяет принятый target contract. MD-343 владеет runtime
переходом к recovery-safe clear, `expected_target_version` и `target_conflict`;
до его реализации MD-337 не заявляет target semantics реализованными.

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
| `POST /api/v1/minds` | keep → Sites control | Ordinary Mind create; no migration |
| `GET /api/v1/minds/{mind_ref}` | keep → Sites control | Current metadata after authorization; no content body |
| `GET /api/v1/minds/{mind_ref}/capacity` | keep → Sites control | Current authorized capacity projection |
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
| `PATCH /api/v1/mcp-tokens/{personal_token_ref}/mind-access` | change → Sites control | `credential-control`: remove `attach_read`/`detach_read`; retain only select/switch/clear writable target with target-version CAS. Legacy actions fail `400 operation_removed`; target stale `expected_target_version` fails `409 target_conflict`, changes no target state, discloses no target metadata and never falls back to last-write-wins. MD-339 owns record/version migration; MD-343 owns helper/handler implementation |
| `DELETE /api/v1/mcp-tokens/{personal_token_ref}` | keep → Sites control | Actor-owned revoke |
| `GET /api/v1/connections` | change → Sites control | Current active Connections and current-readable projection; remove mutable read-attachment state from response. MD-339 owns projection migration |
| `GET /api/v1/connections/{connection_ref}` | change → Sites control | `credential-control`: readable Minds are current derived access; writable target remains explicit Site state. MD-339 owns projection migration |
| `PATCH /api/v1/connections/{connection_ref}/mind-access` | change → Sites control | Same target-only action schema and exact `target_conflict` semantics as personal token. MD-343 implementation; MD-339 durable state migration |
| `DELETE /api/v1/connections/{connection_ref}` | keep → Sites control | Actor-owned connection revoke |

The hidden operator alias `GET /api/v1/internal/operators/users` and UI route
`GET /internal/operators/users` remain unchanged read-only support projections;
they are not product authority and keep constructor-only operator checks plus
indistinguishable `404` for every other actor.

## Capability, delivery и OAuth HTTP routes

| Current operation | Disposition → target | Delta / compatibility / owner |
|---|---|---|
| `GET /api/v1/exports/{grant}` | move → Sites export delivery | Grant download remains one-use and reauthorizes current read access, but only a Site-owned export workflow may issue it. Existing MCP job issuers are retired. MD-359 owns Site workflow routes |
| `GET /api/bundle-download/{grant}` | keep → content delivery | Exact Mind/revision BundleFile grant, current access recheck; not bulk export |
| `GET /api/file-ingress/v1/upload-intents/{capability}` | change → content ingress | Status is capability-only; target pin uses MD-339 target record, not historical `write_binding_id` |
| `PUT /api/file-ingress/v1/upload-intents/{capability}` | change → content ingress | Same target rule plus byte/digest/quota/expiry checks; MD-339 |
| `GET /.well-known/oauth-protected-resource` | keep → OAuth | Canonical resource metadata for `/api/mcp` |
| `GET /.well-known/oauth-protected-resource/api/mcp` | keep → OAuth | Same metadata alias |
| `GET /.well-known/oauth-authorization-server` | keep → OAuth | No authority change |
| `GET /.well-known/openid-configuration` | keep → OAuth compatibility | Existing metadata compatibility alias; does not claim ID tokens |
| `POST /oauth/register` | keep → OAuth | Public-client DCR only |
| `GET /oauth/authorize` | keep → OAuth | Trusted Sites identity and exact request/redirect/resource |
| `POST /oauth/authorize` | keep → OAuth | Explicit consent; account control is not granted |
| `POST /oauth/token` | keep → OAuth | PKCE/refresh/resource/grant checks |
| `POST /oauth/revoke` | keep → OAuth | Credential revoke; Site Connection UI remains product control |
| `POST /api/mcp` | change → Content MCP modern | Catalog/instructions/schema changes below; canonical OAuth resource unchanged |
| `POST /api/mcp/2025-11-25` | change → Content MCP compatibility | Isolated legacy lifecycle, same target tool catalog |
| any `/mcp` | remove → none | Preserve explicit product `404 route_not_found`; never redirect a bearer request |

## MCP tool register

| Current tool | Disposition → target | Schema/error delta, compatibility и migration owner |
|---|---|---|
| `list_minds` | keep → Content MCP | Existing discovery already lists current allowed Minds and creates no binding |
| `resolve_mind` | keep → Content MCP | Existing exact-handle discovery already authorizes from current ACL/visibility and creates no binding |
| `get_mind_info` | change → Content MCP | Keep explicit `mind`/revision selector; remove binding-derived requirements/projection |
| `get_mind_bindings` | remove → none | Omit from both catalogs; exact old call returns `Invalid params`; target inspection lives on Site. MD-339 migrates state |
| `browse_entries` | change → Content MCP | Wire selector unchanged; remove `mind_binding_required` |
| `search` | change → Content MCP | Wire selector unchanged; one Mind/revision only; remove binding requirement |
| `fetch` | change → Content MCP | Opaque exact-revision locator unchanged; current access only, no binding |
| `list_revisions` | change → Content MCP | Explicit one Mind; current access only, no binding |
| `get_revision` | change → Content MCP | Explicit Mind + exact revision; historical view stays read-only |
| `validate_mind` | change → Content MCP | Standalone exact revision validation; not import-session validation |
| `list_bundle_files` | change → Content MCP | Explicit Mind/revision, no binding; metadata only |
| `set_read_mind_binding` | remove → none | Omit from catalog; old call `Invalid params`; no replacement because read is stateless. MD-339 removes/migrates records |
| `set_write_mind_binding` | move → Sites control | Omit from catalog; old call `Invalid params`; Site credential target mutation replaces it. MD-339 |
| `get_file_ingress_capabilities` | change → Content MCP | Read-only deployed-adapter report; rename output `requires_write_binding` to `requires_writable_target`; no client/path promise |
| `create_file_upload_intent` | change → Content MCP | Remove required `write_binding_id`; explicit `mind` must equal Site-selected target; target errors use `content-write` profile. MD-339 |
| `stage_bundle_file` | change → Content MCP | Remove required `write_binding_id`; native provider object terminates at adapter; staged ref pins current credential target. MD-339 |
| `reconcile_file_stage` | change → Content MCP | Remove required `write_binding_id`; reconcile exact original target/source/digest/idempotency payload |
| `get_bundle_file_download` | change → Content MCP | Exact Mind/revision current read; remove binding requirement |
| `commit_changeset` | change → Content MCP | Remove required `write_binding_id`; keep required explicit `mind`, `expected_revision`, `idempotency_key`, non-empty operations; server verifies `mind` equals Site-selected target. MD-339 |
| `reconcile_changeset` | change → Content MCP | Same target schema as original commit; missing outcome performs no writes |
| `capture_knowledge` | change → Content MCP | Remove `write_binding_id` and `expected_binding_version`; keep explicit Mind/HEAD/idempotency/policy payload, require Site-owned enabled policy and same selected private target. MD-339 |
| `start_export` | move → Sites control | Omit from catalog; old call `Invalid params`; no silent call-through. MD-359 owns Site export start |
| `get_export_status` | move → Sites control | Omit from catalog; old call `Invalid params`; Site status/download only. MD-359 |

The target advertised catalog therefore contains 18 tools, in stable order:

```text
list_minds
resolve_mind
get_mind_info
browse_entries
search
fetch
list_revisions
get_revision
validate_mind
list_bundle_files
get_file_ingress_capabilities
create_file_upload_intent
stage_bundle_file
reconcile_file_stage
get_bundle_file_download
commit_changeset
reconcile_changeset
capture_knowledge
```

## MCP Resources и protocol profiles

Modern `2026-07-28`:

| Method | Disposition | Target behavior |
|---|---|---|
| `server/discover` | change | Keep version/capabilities; instructions describe explicit Mind reads and Site-selected writable target, not attach/bind |
| `resources/templates/list` | keep | Authenticated empty list; no implicit templates |
| `resources/list` | change | Enumerate only authorized root `index` resources from current access, without binding |
| `resources/read` | change | Reauthorize exact `okf://spaces/{space_id}/revisions/{revision_id}/...`; no HEAD or cross-Mind fallback |
| `tools/list` | change | Advertise exactly the 18-tool target catalog |
| `tools/call` | change | Execute only advertised target tool and target schemas |
| `initialize` | remove | Preserve explicit `Method not found`; modern profile never starts legacy lifecycle |
| `ping` | remove | Preserve current `Method not found`; not silently added by this migration |

Compatibility `2025-11-25`:

| Method | Disposition | Target behavior |
|---|---|---|
| `initialize` | change | Keep isolated negotiation; update instructions and advertised tool capability |
| `notifications/initialized` | keep | `202` for exact notification |
| `ping` | keep | Empty successful result |
| `tools/list` | change | Same 18-tool target catalog; no legacy-only authority |
| `tools/call` | change | Same target schemas and authorization |
| `resources/templates/list`, `resources/list`, `resources/read` | remove | Preserve compatibility `Method not found`; resources are not silently widened in this profile |
| `server/discover` | remove | Preserve compatibility `Method not found` |

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
| `/settings/connections` | change | Remove attach/detach-read controls; show current-readable projection and link to target selection |
| `/settings/connections/{connection_ref}` | change | Only Site can select/switch/clear one writable target; MD-339 state migration |
| `/settings/developer/mcp` | change | Personal-token lifecycle/endpoints remain; access controls become target-only; no binding tool instructions |
| `/settings/mcp` | keep | Registered `GET`/`HEAD` stays `308` to Advanced MCP; signed-out safe shell unchanged |
| `/help/codex` | change | `MD-339`: three steps become install → authenticate/read explicit Minds → choose writable target on Site only when writing; remove “attach readable Minds” guidance |
| `/help` | change | `integration-owner`: starter/concierge copy must not call removed binding/export tools |
| Marketplace package `mind-diary@srez-marketplace` | change | Keep `AVAILABLE + ON_USE`, compatibility transport `/api/mcp/2025-11-25` and canonical OAuth resource `/api/mcp`; `integration-owner` publishes a new immutable package version for catalog/schema change |
| Bundled Mind Diary skill | change | `integration-owner`: remove `get/set_*_mind_binding` and MCP export instructions; always name one explicit Mind/revision and direct target/export control to Site |
| Plugin card/help label `Mind Diary UAT` | keep | `integration-owner`: UAT remains explicit; no production/public-directory claim |

Static asset routes do not carry product authority and remain unchanged.
The machine fixture assigns an implementation/migration owner to every row and
pins each package, skill or Help requirement to exact Git-blob source evidence.
Those blob pins describe the current legacy artifacts that an implementation
lane must replace; they are not evidence that the target copy is already
published.

## Machine-readable schema diff

The fixture records every changed or removed wire field. Normative highlights:

Имена `expected_target_version`, `requires_writable_target`,
`writable_target_required`, `writable_target_mismatch`,
`writable_target_unavailable` и `target_conflict` являются каноническими machine
names этого operation contract. `target_conflict` относится только к Sites
mutation: stale `expected_target_version` получает HTTP `409`, не меняет target
state, не раскрывает target metadata и не допускает last-write-wins. Он не
добавляется в Content MCP writable-target error set. MD-339 обязан сослаться на
эти имена и определить durable state, migration/reconnect semantics, не
переименовывая и не дублируя этот register; MD-343 реализует Sites
helper/handler delta. Текущие legacy names в source evidence не являются
каноническими target aliases.

- remove `write_binding_id` from `create_file_upload_intent`,
  `stage_bundle_file`, `reconcile_file_stage`, `commit_changeset` and
  `reconcile_changeset`;
- additionally remove `expected_binding_version` from `capture_knowledge`;
- rename `requires_write_binding` to `requires_writable_target` in every
  `get_file_ingress_capabilities.sources[]` row;
- keep required explicit `mind` on every target-sensitive content operation;
- remove `get_mind_bindings`, `set_read_mind_binding`,
  `set_write_mind_binding`, `start_export`, `get_export_status` from both tool
  catalogs rather than retaining hidden aliases;
- remove `attach_read`/`detach_read` from both credential `mind-access` REST
  mutations; retain select/switch/clear with an exact target-version CAS;
- retire binding errors from read paths and use the `content-write` target
  error set only where a content write or its staging preparation requires the
  selected target.

During migration, old MCP names are never forwarded to Site endpoints and old
REST read-binding actions never become no-op success. Old calls fail explicitly;
reconnect/reissue/state migration and preservation rules belong to MD-339.
Sites helper/handler action predicates and legacy error translation belong to
MD-343.
Export route creation and exact Site projection belong to MD-359.

## Verification boundary

The conformance fixture proves closed inventory and target contract consistency
with the repository source candidate. It does **not** prove runtime migration,
plugin publication, UAT behavior, OAuth reconsent, persistence migration or
production deployment. Those claims require their owning implementation and
exact hosted evidence.
