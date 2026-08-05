# Архитектура Mind Diary

Статус: proposal, 2026-08-05. Документ описывает целевую форму первого
прототипа; components, schemas, tests и deployment ещё не реализованы.

## Драйверы и ограничения

Архитектура должна поддержать одновременно:

- authenticated Sites account и автоматически созданный Personal Mind;
- ordinary Minds с single Owner, invitations, roles и visibility;
- user-scoped MCP для Codex/Claude Code без загрузки всего corpus;
- individual-file UTF-8 Markdown access и переносимый deterministic export;
- immediate multi-file commits с immutable history и optimistic concurrency;
- public/unlisted live-HEAD reads только для authenticated users;
- Sites-only MVP production и post-MVP AWS portability без AWS SDK в domain
  core;
- future path к bounded PersonalContext без передачи личного corpus target
  Mind.

OKF не определяет transactions, locks, ACL, revisions, query API или MCP. Эти
свойства принадлежат Mind Diary.

## Контекст системы

```mermaid
flowchart LR
    Browser["Authenticated Sites browser"]
    Agent["Codex / Claude Code"]
    Web["Web control adapter"]
    MCP["Streamable HTTP MCP adapter"]
    Core["Application core"]
    Codec["OKF domain + codec"]
    Meta[("Transactional metadata")]
    Canon[("Canonical revision objects")]
    Index[("Rebuildable search index")]
    Worker["Background worker"]

    Browser -->|"account and metadata operations"| Web
    Agent -->|"Bearer token + content tools"| MCP
    Web --> Core
    MCP --> Core
    Core --> Codec
    Core --> Meta
    Core --> Canon
    Core --> Index
    Core -->|"outbox jobs"| Worker
    Worker --> Index
```

Web и MCP являются двумя adapters над общей application boundary. «Internal
REST» — логический contract use cases, а не обязательно отдельная сеть в первом
deployment. Raw content API не открыт browser/customer; внешней network surface
для corpus является authenticated MCP endpoint.

## Доменная граница

```text
Principal --exactly one-------------> Personal Mind
Principal --< SpaceMembership >------ Ordinary Mind
Principal --< SpaceInvitation >------ Ordinary Mind
Principal --< MCP access token
KnowledgeSpace --HEAD/history-------> SpaceRevision
SpaceRevision --materialize---------> OKFBundle
```

`KnowledgeSpace` — service aggregate и access boundary. `OKFBundle` export
содержит только canonical Markdown files одной revision; account, handle, ACL,
invitations, tokens, idempotency results, audit и indexes — service metadata.

Personal Mind использует тот же content/revision schema, но application commands
обеспечивают его sole-owner/private/non-shareable invariants и route `/me`.

## Слои

### 1. OKF domain и codec

Слой первого прототипа знает Markdown paths, reserved `index.md`/`log.md`,
frontmatter, provenance, trust/lifecycle fields и validation. Он:

- принимает и возвращает исходные UTF-8 bytes;
- сохраняет неизвестные types/fields при round-trip;
- по умолчанию пишет OKF 0.2;
- разделяет conformance errors и quality warnings;
- не знает об MCP, HTTP, auth, Sites, AWS SDK, SQL или search engine.

ZIP/local bundle import, transport producer-defined non-Markdown files и legacy
0.1 migration не входят в этот slice. Будущий legacy reader обязан получить
explicit migration policy
и не может silently менять version/status semantics.

### 2. Application core

Use cases получают trusted `ActorContext` от adapter и работают через узкие
ports:

- account bootstrap/delete и resolve `/me`;
- create/list/resolve/rename/delete Mind;
- invitations, membership roles и ownership transfer;
- visibility и public catalog;
- token issue/revoke/authenticate;
- export/validate revision;
- browse/search/fetch/history;
- atomic `commit_changeset`;
- future-proposal bounded PersonalContext/SpaceLanding;
- outbox/index jobs и audit.

Core первого прототипа зависит от `MetadataStore`, `ObjectStore`, `SearchIndex`,
`Authorizer`, `TokenHasher`, `AuditSink` и `Clock`, но не от concrete adapters.
Если post-prototype personalization будет принята, она подключит отдельный
узкий `PersonalContextProvider` port.

### 3. Protocol adapters

- **Web adapter** принимает Sites identity context и обслуживает control-plane
  pages/commands. Raw OKF file editing не входит в browser UI.
- **MCP adapter** предоставляет user-scoped content tools через Streamable HTTP.
  Целевой protocol profile — current stable `2026-07-28`; legacy
  `2025-11-25` изолируется только для конкретного проверенного client.
- **Background adapter** выполняет идемпотентную индексацию, outbox delivery и
  safe garbage collection incomplete/unreachable objects.

### 4. Infrastructure adapters

- Local: filesystem/object directory, SQLite transactional metadata/FTS.
- Sites MVP target: platform persistence, включая D1/R2 где применимо, только
  после live-проверки bindings, quotas и нужной transactional semantics.
- Post-MVP AWS adapters: S3 canonical objects, DynamoDB transactional
  metadata/outbox и optional OpenSearch Serverless derived index.

## Identity и authentication

### Sites account

Web adapter принимает только platform-verified identity context. Первый
prototype создаёт свой opaque immutable `principal_id` и binding к verified
external identity. Email/display name не передаются клиентом как authority.

Документация Sites сейчас описывает verified email header и optional full-name
header, но не обещает стабильный external subject. Initial binding использует
server-normalized verified email, exact match возвращает existing principal.
Unknown email нельзя отличить от смены email: explicit create получает новый
изолированный principal без прежних прав, а recovery требует отдельной ручной
проверки identity. Сервис никогда автоматически не relink/merge-ит accounts и
не переносит access. Email не является durable authorization ID.

Account bootstrap transaction создаёт principal, Personal Mind и owner binding.
Retry использует external-binding idempotency и возвращает существующий account.
Display name инициализируется из verified full name либо вводится при первом
входе; его последующая смена обновляет metadata Personal Mind, а не content HEAD.

### MCP personal access tokens

Personal token выбран как минимальный безопасный механизм первого прототипа:

```text
token_id
principal_id
name
secret_hash
display_prefix
scopes: content:read, content:write
created_at
expires_at           # default 90 days
last_used_at?
revoked_at?
```

Secret содержит не менее 256 random bits, показывается один раз и передаётся
как `Authorization: Bearer`. Сервер сравнивает hash constant-time, проверяет
expiry/revocation, строит `ActorContext` и затем на каждом tool call заново
проверяет current Mind access. Token bound к principal, не Mind. Он не даёт
control-plane capabilities и не логируется. `content:write` включает
`content:read`; write-only token не выпускается.

Codex configuration использует `bearer_token_env_var`. Для Claude Code и других
clients support объявляется только после conformance test. OAuth 2.1 + PKCE и
authorization-server metadata остаются target для production/public plugin, но
не нужны для personal prototype.

## Mind identity, `/me` и visibility

Обычный Mind хранит immutable `space_id`, immutable в prototype
`space_handle`, derived `normalized_handle`, mutable `name` и
`metadata_version`. Create atomically резервирует host-scoped handle и создаёт
sole Owner. Canonical grammar, normalization, reserved names, generic
`handle_unavailable` и permanent retirement после deletion определены в
[доменной модели](specs/domain-model.md#identity-и-адресация-mind). Router разрешает
handle в ID до metadata/object read.

`/me` — reserved route, разрешаемый только из authenticated `principal_id` в
`personal_space_id`. Скрытый service handle Personal Mind не является
user-facing URL. Rename principal display name меняет Personal Mind name через
metadata CAS, но не content HEAD.

Authorization query возвращает одно из:

```text
denied
membership(role)
baseline_reader(visibility: public | unlisted)
```

`private` разрешает только membership. `unlisted` даёт authenticated baseline
Reader после exact handle resolve, `public` — также через catalog. Baseline
grant не создаёт membership. Owner-only visibility mutation увеличивает
metadata/access epoch; перевод в private сразу инвалидирует caches и будущие
reads non-members. `unlisted` означает только отсутствие в каталоге, не secret
URL. Включение `public`/`unlisted` открывает live HEAD и всю immutable history;
обратный switch не отменяет уже состоявшееся раскрытие.

## Membership, invitations и ownership

Commands используют version CAS и idempotency, а не generic CRUD:

```text
create_space_with_owner(name, handle)
create_invitation(target_principal, role)
accept_invitation(invitation_id)
reject_or_cancel_invitation(invitation_id)
change_membership_role
revoke_membership
leave_space
transfer_ownership(target_active_participant)
change_visibility
delete_space
```

Storage transaction проверяет actor capability, target state/version,
single-owner invariant, пишет state + audit event и возвращает idempotency
result. Transfer меняет target на Owner и source на Admin в одной transaction.
Invitation acceptance создаёт membership только если invitation pending,
unexpired и target совпадает с authenticated principal.

Personal Mind не использует ordinary membership/invitation commands после
bootstrap. Его delete разрешён только account-deletion transaction.

## Каноническая модель revisions

```text
KnowledgeSpace
├── HEAD -> revision_id
├── SpaceRevision
│   ├── revision_id + monotonic revision_number
│   ├── parent_revision_id
│   ├── manifest: path, SHA-256, media_type, size
│   ├── exact UTF-8 OKF Markdown files
│   └── committed_by, committed_at UTC, summary
└── derived index state per revision
```

Manifest — service envelope, не нормативный OKF file. Export материализует
только выбранное дерево. Object-store version IDs не заменяют domain revision.

History resolver принимает HEAD, exact ID или UTC `as_of`. `as_of` выбирает
revision с максимальным number и `committed_at <= as_of`, без fallback на HEAD.
Non-HEAD selector фиксирует `resolved_revision_id` и принудительно read-only.
Каждый read проверяет current membership/baseline grant и token scope. Named
checkpoints/tags не входят в первый прототип.

## Поток content write

```mermaid
sequenceDiagram
    participant A as MCP client
    participant M as MCP adapter
    participant C as Application core
    participant O as Object store
    participant D as Metadata store
    participant W as Index worker

    A->>M: commit_changeset(mind, expected, key, operations)
    M->>C: authenticated ActorContext + command
    C->>D: resolve Mind and current role/token state
    C->>C: normalize and validate OKF operations
    C->>O: put content-addressed immutable objects
    C->>D: conditional HEAD CAS + revision + audit/outbox
    alt expected HEAD matches
        D-->>C: committed revision_id
        C-->>A: success + new HEAD
        D-->>W: outbox/index job
    else stale HEAD
        D-->>C: conflict + current revision
        C-->>A: 409 Conflict
    end
```

Отдельного persisted draft, diff approval и approval token нет. Authorization
проверяется до validation/object read и повторно внутри transactional boundary,
если adapter/storage допускает race. Objects, записанные до неудачного HEAD CAS,
недостижимы и удаляются только bounded garbage collection после safety window.

Multi-file changeset all-or-nothing. `index.md` обновляется explicit replace
under HEAD CAS; automatic merge отложен. `add_log_entry` парсит canonical
`log.md`, вставляет событие в newest-first/date-grouped позицию и снова
валидирует файл. Idempotency result предотвращает duplicate revision/log entry.
Ключ namespaced по `principal_id + space_id + operation + key` и связан с
canonical request hash: тот же payload возвращает прежний result, другой
payload с тем же key — `409 Idempotency Conflict`.

## Поток content read

1. MCP adapter аутентифицирует token и получает `principal_id`.
2. Explicit Mind selector разрешается в `space_id`; `/me` разрешается только
   через actor.
3. Authorizer проверяет current membership или visibility grant.
4. Revision selector разрешается в exact `revision_id`.
5. Browse/search применяет `space_id + revision_id` filter до выдачи результатов.
6. `fetch` перечитывает canonical object той же revision и возвращает
   provenance/freshness.
7. Ответ ограничивается budget; truncation обозначается явно.

Index для каждой revision derived и rebuildable. При отсутствии/lag historical
index browse/fetch остаются доступны, а search ждёт rebuild или честно сообщает
unavailable; fallback на HEAD запрещён.

## MCP surface и multi-Mind boundary

Один connection видит allowed universe principal, но не смешивает corpus:

```text
list_minds -> /me + memberships + public catalog
resolve_mind(exact unlisted handle) -> one authorized descriptor
content_tool(mind, revision?, ...) -> exactly one resolved space_id
```

Opaque search result ID фиксирует `space_id + revision_id + path`, поэтому
subsequent `fetch(id)` не перескакивает на новую HEAD. MCP не принимает
client-supplied `principal_id`, `space_id` или role как источник истины.
Private/unlisted enumeration защищена: unlisted не попадает в list без
membership, private denied response не раскрывает metadata.

Surface использует custom Mind-aware tools. Первый прототип не заявляет OpenAI
company-knowledge compatibility: стандартный `search(query)` не передаёт Mind
selector, а его results требуют user-openable web URLs, которых content surface
не предоставляет. Такой profile требует отдельного design decision.

Content MCP не содержит invitation, membership, visibility, ownership, deletion
или token-management tools. Corpus не может расширить server scopes или получить
эти operations. Но prompt injection способен склонить модель вызвать уже
разрешённый content write; explicit write scope, current ACL, immutable history
и audit ограничивают, а не устраняют этот residual risk. Tool annotations — UX
metadata, а не security boundary.

## Sites control plane и internal API

Sites обслуживает только authenticated metadata workflows: account, `/me`, Mind
list/create/rename, catalog, visibility, invitations, roles, transfer, deletion
и personal tokens. Работа с OKF files происходит через MCP; browser может
показывать лишь status/metadata, необходимые для управления.

Предлагаемые REST routes, internal command/query boundary и exact MCP
tools/resources schemas зафиксированы в [API specification](specs/api.md).

Production deployment MVP размещает Web adapter, MCP adapter и core в одном
OpenAI Site. Внутренние use-case routes при этом не публикуются. Если Sites не
поддержит required Streamable HTTP или persistence semantics, production
release блокируется до нового архитектурного решения; split deployment не
включается как автоматический fallback.

## Personalization boundary

Это post-prototype proposal, а не capability первого vertical slice. Если он
будет принят, после target authorization `PersonalContextProvider` сможет по
отдельному `personal.context.read` разрешить exact revision собственного
Personal Mind и вернуть server-filtered profile. Target content не формирует
personal query, не выбирает fields и не расширяет scope. Derived landing
приватен principal и не кэшируется как shared response.

Этот use case не меняет правило content MCP: каждый обычный tool call имеет один
explicit target Mind. General cross-Mind search/synthesis требует новой
спецификации и provenance/access checks для каждого corpus.

## Deployment profiles

### Local vertical slice

- Один portable process с Web/API и MCP adapters.
- SQLite хранит principals, external bindings, handles, Personal Mind binding,
  memberships, invitations, tokens, revisions, HEAD, idempotency, audit/outbox
  и FTS index.
- Filesystem/object directory хранит content-addressed canonical objects.
- Integration suite проверяет account, roles/visibility, history, concurrent
  commits, export и MCP lifecycle.

### OpenAI Sites MVP production

- Sites — единственная production platform текущего MVP и подтверждённый host
  web/admin UI с Sign in with ChatGPT.
- D1/R2 используются только после проверки bindings, quotas и atomicity нужных
  operations.
- Streamable HTTP MCP в том же Sites deployment остаётся compatibility
  experiment, а не подтверждённой возможностью.
- Gate включает real Codex client, stable HTTPS endpoint, streaming, bearer
  forwarding/configuration, protocol lifecycle и persistence across deployments.
  Claude Code и другие clients получают собственную non-blocking gate до
  заявления их поддержки.
- Production release требует успешных web/control и MCP flows одного exact
  Sites version/deployment. При провале gate релиз блокируется; отдельный
  portable runtime не создаётся без нового решения.

### Post-MVP AWS path

- Это основная planned infrastructure direction после подтверждения MVP и
  самостоятельная учебная цель проекта; она не является текущим release
  fallback.
- Будущий portable container в Bedrock AgentCore Runtime.
- S3 для canonical objects; DynamoDB conditional writes для HEAD, metadata,
  invitations, tokens metadata и outbox.
- Optional OpenSearch Serverless только как derived index после benchmark.
- IAM least privilege, private service access, OTEL/CloudWatch без content body.
- Тот же domain/integration suite, что local profile.
- Этот profile не входит в MVP release, его deployment требует нового принятого
  решения.

## Observability и audit

Metrics: request latency/errors, auth failures, CAS conflicts, index lag,
invitation outcomes, token issuance/revocation и deletion counts. Logs/traces не
содержат concept/source bodies, PersonalContext, raw email where avoidable,
token secret/hash, presigned URL или private search query.

Каждая account, ownership, membership, visibility и successful content commit
operation создаёт audit event с opaque actor/subject IDs, target `space_id`,
request/idempotency ID, outcome и safe metadata. Whole-Mind hard deletion
удаляет target-linked audit/idempotency records вместе с aggregate; остаётся
только non-linkable retired-handle marker, без forensic deletion receipt. Это
сознательная потеря post-delete accountability в delete-all прототипе. Account
deletion также удаляет identity/profile, но commits в Minds других Owners
сохраняют opaque non-PII `deleted-principal` tombstone. OKF `log.md` не заменяет
audit log.

## Недоверенное content boundary

- ACL разрешается до object/index read.
- Concept/source text не расширяет server tools или scopes; модель всё ещё может
  ошибочно интерпретировать его как инструкцию в пределах разрешённых tools.
- Changeset принимает только canonical relative Markdown paths и valid UTF-8,
  ограничивает размер/число operations и отклоняет reserved-path misuse.
- Web renderer не исполняет embedded HTML/script без isolation/sanitization.
- Full export передаётся через short-lived download URL с повторной проверкой
  доступа; upload intent в первом прототипе отсутствует.

## Риски и открытые вопросы

- Даст ли Sites stable external identifier, позволяющий позже заменить ручной
  fail-closed account recovery безопасным automatic relink?
- Пройдёт ли Sites реальный Streamable HTTP MCP gate? До положительного
  evidence это blocker MVP production release, а не основание автоматически
  выбрать отдельный runtime.
- Какой exact token hash/KDF и lookup strategy дают приемлемую latency без
  хранения recoverable secrets?
- Как реализовать immediate full deletion и доказать удаление replicated/index
  data до появления production retention model?
- Нужны ли позже soft delete/recovery и formal privacy-retention policy?
- Когда сложности конфликтов оправдают structured index merge вместо current
  HEAD CAS/retry?
- Какие personal categories и consent model допустимы для personalization?

## Внешние основания

Актуальные проверенные platform facts и primary links собраны в
[отчёте о платформенных предпосылках](reports/2026-08-05-platform-status.md).
Состояние OKF и ограничения multi-writer extension — в
[отчёте о формате](reports/2026-08-05-okf-status.md).
