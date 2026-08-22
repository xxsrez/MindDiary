# Границы реализации domain, application и adapters

Статус: proposal, обновлено 2026-08-09. Документ фиксирует обязательные
границы реализации первого прототипа. В репозитории уже существуют TypeScript
packages, application/adapters, dependency checks, tests и Product Site
composition, следующие этой карте. Это executable repository evidence, но не
автоматическое доказательство каждого поведенческого требования или live UAT
semantics: такие утверждения требуют соответствующего test либо release
evidence на exact candidate.

## Назначение

Эта specification переводит принятые product/API invariants в границы модулей,
use cases, ports и транзакций. Она не выбирает язык, framework, ORM или Sites
storage binding. Конкретный runtime может меняться, пока сохраняются:

- один application core для Web, MCP и background adapters;
- trusted identity только в `ActorContext`;
- отдельные control, content и background entry points;
- platform-neutral domain и OKF codec;
- атомарные metadata transitions и явная координация с object/index systems;
- запрет выдавать browser raw content API, а MCP — control-plane commands.

Wire contract остаётся в [API specification](api.md), product invariants — в
[domain model](domain-model.md), deployment topology — в
[architecture](../architecture.md).

## Целевая карта модулей

Названия каталогов и packages могут быть адаптированы под выбранный toolchain,
но направленность зависимостей обязательна:

```text
domain
okf-codec ───────────────> domain
application-contracts ───> domain
application-ports ───────> domain + application-contracts
application-control ─────> domain + contracts + ports
application-content ─────> domain + okf-codec + contracts + ports
application-background ──> domain + okf-codec + contracts + ports

adapter-web ─────────────> application-control
adapter-mcp ─────────────> application-content
adapter-background ──────> application-background
adapter-metadata-* ──────> application-ports
adapter-object-* ────────> application-ports
adapter-search-* ────────> application-ports
adapter-security-* ──────> application-ports
adapter-audit-* ─────────> application-ports

composition-root ────────> application + selected adapters
```

`domain` содержит entities, value objects, invariants и чистые policies.
`okf-codec` читает, изменяет, валидирует и детерминированно материализует OKF
0.2, сохраняя неизвестные fields/types. Ни один из этих leaf modules не знает
о process environment, transport, persistence или deployment platform.

Application modules оркестрируют use cases. Они владеют входными contracts и
outbound port interfaces, но не concrete drivers. Adapters переводят platform
или protocol types в application types и обратно. Только `composition-root`
выбирает реализации ports, читает deployment configuration и собирает runtime.

## Trusted `ActorContext`

`ActorContext` — server-created value, который передаётся первым параметром в
каждый application query/command. Request body, MCP arguments, cookies,
client-supplied headers, job payload и canonical content никогда не
десериализуются прямо в этот type.

Концептуальная форма:

```text
ActorContext:
  actor:
    registered_principal:
      principal_id
    sites_identity_before_registration:
      provider
      sensitive_normalized_binding
      suggested_display_name?
    service:
      service_id
      job_id?
  authentication:
    sites_identity:
      verified_by_platform: true
    mcp_token:
      token_id
      binding_owner_id
      effective_scopes: content:read | content:read+content:write
    internal_service:
      purpose: index | export | gc | audit | expiry
  request_id
  occurred_at_utc
  deployment_capabilities
```

Правила построения:

1. Web adapter принимает identity только из platform-authenticated server-side
   Sites context. Он нормализует email из этого context в sensitive binding value и не
   позволяет body/header подменить его. До регистрации допустим только
   `sites_identity_before_registration`; после exact binding lookup core
   использует immutable `principal_id`.
2. MCP authentication получает raw bearer secret в отдельной authentication
   entry point. Secret существует только до проверки через `TokenHasher` и не
   попадает в `ActorContext`, downstream ports, errors, audit или logs. После
   проверки context содержит `principal_id`, `token_id` и effective scopes.
3. Background adapter создаёт только `service` actor из trusted runtime
   configuration. Serialized job не может назначить `service_id`, principal,
   role или scopes.
4. `occurred_at_utc` считывается через `Clock` один раз для use case. Domain
   rules про expiry/date grouping используют это значение, а не собственные
   системные часы.
5. `request_id` служит correlation, а не authorization. `deployment_capabilities`
   могут только сужать разрешённое поведение.
6. Role, visibility и membership не кэшируются в context. `binding_owner_id`
   выводится только из validated OAuth grant/personal token и выбирает
   independent server-side binding set; request/chat не может его назначить.
7. `Authorizer`
   вычисляет effective access из актуального server-side state для каждого
   target Mind; mutation повторяет проверку в своей metadata transaction.

Application entry point принимает только подходящий variant. MCP token не
может вызвать control command; service actor не может изображать principal;
pre-registration Sites identity может вызвать только session/bootstrap use
cases.

### Test-only trusted binding provider

Отдельный harness, не входящий в product dependency graph, подаёт ephemeral
trusted identity snapshot через существующий `ProductSiteTrustedIdentityReader`
и выбирает constructor-only generic binding provider `synthetic-test`.
Pre-registration actor остаётся обычным `sites_identity_before_registration`;
отдельного test/domain variant нет.

`SyntheticPrincipal` — только label run/evidence, не имя этого value и не
persisted domain discriminator. Harness передаёт snapshot только normal
session/bootstrap или trusted OAuth authorize/consent adapter. После binding
resolution application использует обычный `registered_principal`.

Harness доступен только через direct test entry point. Generic provider
dependency default-ится на `openai-sites`; Product Worker не задаёт её. Route,
header, cookie, body/query, environment, `NODE_ENV`, deployment configuration
или job payload не могут выбрать provider; architecture gate проверяет это
negative правило.

Namespace `synthetic-test` допустим только в isolated test `MetadataStore`.
Harness создаёт records обычными commands и не вызывает storage seed/direct
write. Он не подменяет role/scopes/current ACL и завершает normal revoke/delete
с negative state scan.

## Outbound ports

Ports используют domain/application types и typed failures. Они не возвращают
HTTP response, JSON-RPC error, SQL row, SDK exception или engine-specific
document. Retryability и conflict сообщаются application-level result.

### `MetadataStore`

Transactional source of truth для principals, identity bindings, Mind binding
sets, Spaces,
handles, memberships, invitations, tokens metadata, revisions, HEAD,
idempotency, audit outbox, jobs и deletion state.

Минимальные обязанности:

- snapshot queries и exact ID/handle/revision resolution;
- `transact`/unit-of-work с atomic commit/rollback;
- unique constraints для identity binding, Personal Mind, active membership,
  pending invitation и canonical handle;
- conditional writes для metadata version, invitation state, token state и
  HEAD revision;
- monotonic binding version, unique active read per owner/space и максимум один
  active write record per binding owner;
- storage одного command result с canonical request hash для idempotency;
- запись domain state, audit outbox и background jobs в одной transaction;
- denial/non-enumeration без предварительного object/index read.

Port не скрывает distributed transaction: canonical object bytes и derived
index не считаются частью metadata transaction.

### `ObjectStore`

Хранит immutable content-addressed canonical objects и построенные export
objects. Он обязан поддерживать put/get по opaque key и digest, подтверждение
digest/size, idempotent delete и короткоживущий authorized download grant.

Object key не является authorization capability. Application разрешает
`space_id + revision_id + path` и проверяет access до `get`. Incoming bearer
token port не получает. Put до metadata commit допустим только для immutable
object; неуспешный CAS оставляет unreachable object для bounded GC.

### `SearchIndex`

Производный exact-revision index. Port принимает только explicit
`space_id + revision_id`, индексирует immutable revision идемпотентно,
возвращает `ready | building | unavailable` и удаляет index data по deletion
plan. Он не выбирает HEAD и не имеет права fallback на другую revision.

### `Authorizer`

Возвращает named capabilities или generic denial из current server-side
state. Вход: trusted actor, resolved `space_id`, requested capability и
transaction/snapshot context. Он учитывает active membership либо baseline
visibility, token scopes, revision mode и deployment capability.

Port не принимает client role или binding owner как authority. Binding
application сначала проверяет current authoritative record, затем Authorizer.
Для private missing/denied target
он не возвращает различимую metadata. Control/content application modules
задают capability, но не дублируют role matrix в adapters.

### `TokenHasher`

Изолирует cryptographic token handling по принятому
[ADR-0005](../decisions/0005-mcp-token-secret-verifier.md): создаёт canonical
secret `mdp_v1_` + 43 unpadded base64url characters из ровно 32 random bytes и
вычисляет versioned keyed HMAC-SHA-256 verifier `hmac-sha256:v1` под отдельным
deployment key. Persisted verifier служит exact lookup key; raw secret
показывается только через consume-once issue response и не проходит в
`MetadataStore`, audit или logs.

Malformed или oversized candidate отклоняется до storage. Canonical candidate
требует одной HMAC, одного indexed lookup и constant-time сравнения двух
32-byte verifier values. Медленный password KDF для high-entropy
server-generated token не используется; deployment key хранится отдельно от
token records и не экспортируется через application boundary.

### `AuditSink`

Идемпотентно сохраняет или доставляет уже committed safe audit event по
`event_id` и умеет идемпотентно удалить target-linked events по deletion plan.
Он не вызывается синхронно как условие metadata commit: command пишет event в
transactional outbox, background handler доставляет его через port и отмечает
результат. Event не содержит content body, private query, verified email,
token material или download URL.

При whole-Mind deletion target-linked audit/outbox удаляются согласно принятой
MVP policy. Финализация ждёт подтверждённый purge из sink; адаптер, который не
может его обеспечить, несовместим с MVP delete contract. `AuditSink` не создаёт
скрытый forensic retention channel.

### `Clock`

Возвращает UTC instant. Application считывает его один раз на use case и
передаёт явным значением domain policies и store operations. Tests используют
deterministic fake clock; domain и codec не обращаются к process clock.

## Application entry points

Три boundary публикуют отдельные типизированные façades. Общие value types и
errors разрешены, но application modules не вызывают соседний façade и не
экспортируют generic repository/CRUD surface.

### Control application

Доступен только Web adapter:

```text
queries:
  get_session, get_account_deletion_impact, get_mind_deletion_impact
  list_minds, resolve_mind_metadata, get_mind_info, list_public_minds
  list_members, list_invitations, list_mcp_tokens

commands:
  bootstrap_account, rename_account, delete_account
  create_space_with_owner, rename_space, change_visibility, delete_space
  create/accept/reject/cancel/reissue_invitation
  change/revoke_membership, leave_space, transfer_ownership
  issue_mcp_token, revoke_mcp_token
```

Ответы содержат safe account/control metadata и HEAD descriptor, но не raw
Markdown, manifest body, search snippet, export bytes или content mutation.

### Content application

Доступен только MCP adapter:

```text
queries:
  list_minds, resolve_mind, get_mind_info
  get_mind_bindings
  browse_entries, search_entries, fetch_entry
  list_revisions, get_revision, validate_revision, get_export_status

commands:
  set_read_mind_binding, set_write_mind_binding
  commit_changeset, start_export
```

Каждый content use case после discovery явно разрешает ровно один bound Mind и
одну exact revision. Binding mutations меняют только per-grant/token service
selection и не создают ACL. Content boundary не экспортирует account, invitation,
membership, role, visibility, ownership, deletion или token-management
commands. `commit_changeset` требует registered principal, effective
`content:write`, current content capability и current HEAD.

### Background application

Доступен только Background adapter:

```text
handlers:
  rebuild_revision_index, complete_export
  collect_unreachable_objects, deliver_audit_outbox
  expire_invitations, expire_export_grants, continue_deletion
```

Handler принимает explicit job/aggregate ID, перечитывает current job state и
идемпотентно фиксирует outcome. Job payload не содержит authority. Handler не
меняет authored OKF или HEAD напрямую; canonical mutation возможна только
через обычный content/domain command с теми же authorization/CAS invariants.

## Inbound adapters и exposure

| Adapter | Может вызвать | Не может публиковать |
|---|---|---|
| Authenticated Sites Web | Только Control application | Raw content read/write, MCP bearer auth, background handlers |
| Streamable HTTP MCP | Только Content application и MCP authentication | Accounts, invitations, members, roles, visibility, ownership, deletion, token management |
| Background runner | Только Background application | User-facing HTTP/MCP operations и synthetic principal authority |
| Synthetic test harness | Test-only composition над normal Control/Content/OAuth contracts | Product route/login, direct storage seed, UAT/production bindings и client-selected authority |

Web route `/me` и `/{space_handle}` — management addressing. Browser может
получить safe descriptor, counts, current status и destructive-action preview,
но не raw file, content search/fetch, full manifest или direct object URL.
Добавление такого endpoint считается изменением product/API scope, а не
«удобным» reuse внутреннего query.

MCP публикует только custom Mind-aware content tools/resources из
[API specification](api.md#content-mcp). Tool annotations не расширяют права.
Adapter не импортирует control façade даже если оба работают в одном process.

Shared application core означает общие domain policies, ports, errors и
transaction semantics, а не один универсальный dispatcher, доступный любому
transport. Internal application API не публикуется как customer network API.

## Transaction boundaries

`MetadataStore` — единственная atomic transaction boundary. `ObjectStore`,
`SearchIndex` и `AuditSink` координируются через immutable writes,
idempotency, outbox/jobs и explicit intermediate states; distributed
transaction не предполагается.

### Account bootstrap

Одна metadata transaction:

1. разрешает exact normalized Sites binding и idempotency replay;
2. если binding уже существует, возвращает existing account без второго Mind;
3. иначе создаёт principal, Personal Mind, initial revision/HEAD и sole-owner
   binding;
4. фиксирует external binding, command result, audit/outbox.

Initial immutable OKF objects подготавливаются до transaction. Они становятся
достижимыми только после commit; rollback оставляет их GC-кандидатами.

### Handle reservation и ordinary Mind create

Одна metadata transaction атомарно проверяет canonical handle, резервирует
host namespace, создаёт Space, initial revision/HEAD, sole Owner, idempotency
result и audit/outbox. Occupied, reserved и retired дают один
`handle_unavailable`. Handle не существует в состоянии, где его можно занять,
но соответствующего active Space ещё нет.

### Invitation acceptance

Одна metadata transaction повторно authorizes authenticated target, проверяет
`pending`, target ID, expiry и version, обеспечивает отсутствие active
membership, создаёт ровно одну membership, переводит invitation в `accepted`,
увеличивает metadata/access version и пишет idempotency + audit/outbox. Retry
возвращает прежний result; concurrent accept/cancel/expiry имеет одного
победителя и не оставляет membership после проигравшего transition.

### Ownership transfer

Одна metadata transaction повторно проверяет current Owner и version, active
target membership и отсутствие Personal Mind. Затем target становится Owner,
source — Admin, metadata/access version и idempotency/audit/outbox обновляются
в том же commit. Ни ownerless, ни two-owner state не виден даже временно.

### HEAD CAS

1. До transaction core authorizes read/write, читает exact expected revision,
   применяет operations, валидирует весь resulting OKF bundle и кладёт
   immutable content-addressed objects.
2. Одна metadata transaction повторно authorizes actor на том же `space_id`,
   проверяет token/current capability, idempotency hash и exact HEAD.
3. При match transaction создаёт один `SpaceRevision`, меняет HEAD, сохраняет
   command result и пишет audit + index/export outbox jobs.
4. При stale/denied/error transaction не публикует revision или partial HEAD.
   Уже записанные objects остаются unreachable до safe idempotent GC.

Derived index не входит в commit. Новая HEAD доступна через canonical
browse/fetch сразу после metadata commit; search честно сообщает index status.

### Whole-Mind и account deletion

Из-за нескольких storage systems deletion — restartable state machine, а не
ложная «общая transaction»:

1. Первая metadata transaction повторно authorizes request и preview,
   переводит target aggregate(s) в `deleting`, немедленно закрывает новые
   reads/writes, фиксирует bounded deletion plan, блокирует handles от reuse,
   отзывает связанный access и ставит continuation job.
2. Идемпотентный handler удаляет canonical/export objects, exact-revision
   indexes и target-linked delivered audit events по plan. Crash оставляет
   target недоступным и позволяет продолжить, но не возвращает success.
3. Финальная metadata transaction проверяет completion и удаляет target-linked
   metadata, revisions, jobs, audit/outbox и idempotency records. Остаётся
   только non-linkable retired-handle marker. Account deletion дополнительно
   удаляет identity/profile/tokens и сохраняет только принятые
   `deleted-principal` tombstones в Minds других Owners.
4. API сообщает success только после финального commit. До него повтор с тем
   же operation продолжает deletion; восстановить доступ или отменить процесс
   нельзя.

Текущий repository baseline реализует restartable deletion lifecycle и
failure-injection tests. Они доказывают application/adapter contract на
проверенном commit, но сами по себе не являются доказательством physical
erasure на Sites storage; для этого требуется отдельное redacted live evidence.

### Audit delivery

State transition и safe audit event всегда commit-ятся в одной metadata
transaction. `AuditSink` вызывается только после commit через outbox. Delivery
retry не повторяет business command, а deduplicate-ится по `event_id`.

## Enforceable dependency rules

Следующие правила представлены не только prose, но и package manifests,
TypeScript references, import graph checks и compile/test targets:

1. `domain` не импортирует `okf-codec`, application, adapters или
   composition-root. Разрешены только standard library и отдельно одобренные
   pure utility packages без I/O/platform dependencies.
2. `okf-codec` может зависеть от `domain` и pure parser/serialization packages,
   но не от application, adapters или runtime SDK.
3. Application modules зависят только от domain/codec, contracts и owned port
   interfaces. Control/content/background façades не импортируют друг друга.
4. Protocol adapters импортируют только свой façade и protocol/platform
   mapping types. Web не импортирует Content application; MCP не импортирует
   Control application; Background не импортирует user façades.
5. Outbound adapter реализует один или несколько application-owned ports и не
   вызывает inbound adapter либо другой concrete outbound adapter.
6. Только composition-root выбирает concrete adapters и platform bindings.
7. Domain и OKF codec запрещены прямые или transitively exposed dependencies
   на Sites bindings, AWS SDK, HTTP/router framework, SQL/ORM/database driver,
   SQLite/FTS/search engine, filesystem/object-store/network client,
   observability exporter и process environment/configuration library.
8. Domain errors и application results не содержат HTTP status,
   `Response`/JSON-RPC/SDK/SQL types. Transport mapping остаётся в inbound
   adapters; storage mapping — в outbound adapters.
9. Infrastructure package не может стать dependency leaf package через
   test helper, generated client или shared «common» module. Test fixtures для
   domain/codec также компилируются без infrastructure graph.

Минимальный automated gate текущего baseline:

- отдельные package/workspace manifests для leaf и application modules;
- compile/typecheck `domain` и `okf-codec` с их собственными dependency graphs;
- forbidden-import и forbidden-transitive-dependency check;
- architecture tests на allowed edges и absence cross-façade imports;
- contract tests для local/in-memory и Sites adapters;
- один canonical command, запускающий эти проверки на exact commit.

Эти manifests и checks находятся в `packages/*`, TypeScript project references,
`scripts/check-architecture.mjs` и canonical `npm run check`. Их прохождение
подтверждает repository boundary только на exact commit: оно не заменяет
Product Site build и live Sites/Codex release gates.

## Verification contract реализации

Acceptance и дальнейшее сохранение этой границы требуют:

- positive/invalid/denied/stale/retry/race tests для каждой transaction выше;
- проверку итогового state после failure, включая отсутствие partial HEAD,
  duplicate membership и two-owner state;
- browser contract test, доказывающий отсутствие raw content routes;
- MCP schema/tool-list test, доказывающий отсутствие control-plane commands;
- background tests, доказывающие idempotency и отсутствие authority в payload;
- leaf compile/import-graph gate из предыдущего раздела;
- adapter contract suite на том же exact commit;
- redacted evidence без tokens, content/query bodies, verified email, CSRF
  secret или download URL.

Отдельный blocking gate дополнительно доказывает normal multi-principal
bootstrap/access lifecycle через ephemeral trusted snapshots и persisted
provider `synthetic-test`, отсутствие harness/provider import или override в
product compositions и receipt
`mind-diary/synthetic-multi-principal-evidence/v1`. Automated OAuth/package
gate использует тот же trusted seam только для authorize/consent и отдельно
проверяет, что transport/token/ACL/CAS paths остаются обычными.

Live Sites/MCP compatibility, physical storage semantics и Codex conformance
проверяются отдельными release gates и не следуют из этой specification.

## Не входит в это решение

- выбор языка, framework, ORM, database schema или Sites binding;
- AWS/AgentCore deployment либо fallback runtime;
- raw browser content surface или control-plane MCP tools;
- imports, checkpoints, non-Markdown assets, personalized landing, anonymous
  access, company-knowledge profile, drafts/approval и Claude Code support;
- утверждение, что наличие modules, ports и local checks само по себе доказывает
  physical storage semantics, live Sites compatibility или client conformance.
