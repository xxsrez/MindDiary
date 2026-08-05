# Архитектура Mind Diary

Статус: proposal, 2026-08-05. Ни один компонент ниже ещё не реализован.

## Драйверы и ограничения

Архитектура должна одновременно обеспечить:

- переносимый OKF 0.2 round-trip без потери неизвестных полей;
- ленивое, цитируемое чтение через MCP;
- безопасную многописательскую модель, которой нет в самом OKF;
- private shared KnowledgeSpaces, many-to-many memberships и четыре роли;
- required display names и стабильную человекочитаемую URL-адресацию;
- canonical `/{space_handle}`, base landing и безопасную персонализацию первого
  ответа из designated Personal Space;
- публикацию выбранной revision как adaptive knowledge site без копирования
  канонического corpus;
- ранний web-прототип в OpenAI Sites;
- целевой AWS deployment без переписывания доменного ядра;
- возможность начать с lexical search и добавить embeddings после измерений.

OKF намеренно не определяет storage, transactions, locks, ACL, query API или
MCP. Эти свойства принадлежат Mind Diary и не должны выдаваться за требования
формата.

## Контекст системы

```mermaid
flowchart LR
    Agent[ChatGPT, Codex или другой MCP client]
    Admin[Web/admin UI]
    Visitor[Member или KnowledgeSite visitor]
    Site[Canonical Space URL + SpaceLanding + optional SpaceGuide]
    Edge[MCP и Web/API adapters]
    Core[OKF application core]
    Canon[(Canonical revision store)]
    Meta[(Transactional metadata)]
    Index[(Rebuildable search index)]
    Personal[Bounded PersonalContext provider]

    Agent -->|Streamable HTTP, OAuth| Edge
    Admin -->|HTTPS| Edge
    Visitor --> Site
    Site -->|authorized revision + optional session| Edge
    Edge --> Core
    Core --> Personal
    Core --> Canon
    Core --> Meta
    Core --> Index
```

Весь corpus не проходит через MCP-сессию. Search отдаёт ограниченный набор
результатов, fetch — выбранный canonical concept, а large assets и exports
передаются через object storage.

## Доменная граница

`KnowledgeSpace` — service aggregate и access boundary вокруг одного
логического OKF tree. Он содержит HEAD, revisions, memberships и настройки, но
его service metadata не подмешивается в bundle:

```text
User/Principal --< SpaceMembership >-- KnowledgeSpace
User/Principal --default personal----> KnowledgeSpace
KnowledgeMount -----------------------> exactly one KnowledgeSpace
KnowledgeSpace --HEAD-----------------> SpaceRevision
KnowledgeSpace --space_handle URL-----> SpaceLanding
SpaceLanding --target-----------------> SpaceRevision
SpaceLanding --optional context-------> Personal SpaceRevision
SpaceRevision --materialize----------> OKFBundle
KnowledgeSite --published revision----> SpaceRevision
```

Контент различает `KnowledgeEntry`, `Source`, `Asset`, reserved `Index` и
`Log`; generic storage object не определяет их поведение. Полная терминология,
role matrix и owner invariants находятся в
[доменной спецификации](specs/domain-model.md).

## Слои

### 1. OKF domain и codec

Слой знает пути bundle, reserved `index.md`/`log.md`, concept frontmatter,
provenance, trust/lifecycle fields, assets, legacy 0.1 fallbacks и правила
валидации. Он:

- принимает и возвращает исходные UTF-8 bytes;
- сохраняет неизвестные types и producer-defined fields при round-trip;
- пишет OKF 0.2, если явно не выбран другой export profile;
- отделяет conformance errors от quality warnings;
- не знает об MCP, OAuth, AWS, Sites, SQL или vector search.

### 2. Application core

Use cases работают с явным `ActorContext`, KnowledgeMount, SpaceMembership и
SpaceRevision:

- create Space, list accessible Spaces и получить current membership;
- reserve/resolve immutable `space_handle`, rename display name без смены
  `space_id`;
- resolve canonical Space URL и получить base либо personalized landing
  разрешённой target revision;
- designate Personal Space и получить bounded PersonalContext по отдельному
  scope/consent;
- add/change/revoke memberships и transfer ownership через control plane;
- import/export/validate bundle;
- browse/search/fetch;
- create draft, inspect diff, commit with `expected_revision`;
- publish index jobs и audit events;
- выдавать короткоживущие object-transfer intents для больших файлов.

После MVP те же use cases получают publication и interaction orchestration:
promote published revision, render KnowledgeSite, start SpaceSession и получить
revision-bound adaptive response. Эти операции не входят в OKF codec.

Application core зависит от портов `ObjectStore`, `MetadataStore`, command-level
`SpaceCommands`/`MembershipCommands`, `SearchIndex`, `Embedder`, `Authorizer`,
`ApprovalVerifier`, `PersonalContextProvider`, `AuditSink` и `Clock`, но не от
их реализаций. Presentation/interaction capabilities подключаются через
отдельные `PresentationRenderer` и `ResponseGenerator` ports.

### 3. Protocol adapters

- MCP adapter изолирует protocol-specific lifecycle за transport boundary.
  Current stable `2026-07-28` является целевым профилем; явный compatibility
  profile `2025-11-25` сохраняется, пока реально проверенные OpenAI/AWS clients
  могут требовать legacy initialize/session flow. Stateless per-request
  metadata 2026 и legacy lifecycle не смешиваются внутри одного profile.
- Web/API adapter обслуживает canonical Space URLs, SpaceLanding, admin UI,
  KnowledgeSite и large-transfer orchestration.
- Background adapter выполняет идемпотентную индексацию и housekeeping.

### 4. Infrastructure adapters

- Local: filesystem + SQLite metadata/FTS.
- Sites experiment: R2 для bytes/assets и D1 для revisions/HEAD/jobs.
- AWS: S3 для canonical bytes, DynamoDB для transactional metadata и
  OpenSearch Serverless как optional derived index.

Ни один infrastructure adapter не меняет публичные use-case contracts.

## Identity Space и имя

Внешняя canonical identity — required `space_handle`, внутренний primary key —
immutable `space_id`. Обязательное display `name` служит людям, но не участвует
в routing или uniqueness. В MVP handle — один immutable path segment,
уникальный по `(host_namespace, normalized_handle)`.

Create atomically резервирует normalized handle, создаёт Space и creator-owner.
Rename display name использует `expected_metadata_version` и пишет audit, но не
меняет resolver, URL или content HEAD. Router разрешает handle в ID до любого
authorization/object read; ACL, jobs, revisions, resource URIs и indexes хранят
`space_id`. Будущий rename handle потребует отдельной CAS-команды, tombstone и
permanent redirect, а не обновления обычного display name.

## Canonical Space URL и landing flow

Web adapter выводит deployment-scoped canonical URL из verified host и
immutable в MVP handle:

```text
GET https://{space-host}/{space_handle}
```

Полный host является trusted конфигурацией deployment, а `/{space_handle}` —
стабильным application contract и внешним identifier. Handle не является ACL:
после resolver все security-sensitive операции используют внутренний ID.
Production custom domain сохраняется при смене Sites/AWS runtime; если меняется
сам домен, старый URL остаётся permanent redirect, а не молча исчезает.

Поток перехода по URL:

1. Router нормализует один `space_handle`, проверяет reserved/confusable rules и
   разрешает `(verified host namespace, normalized_handle)` в `space_id`; path
   не задаёт tenant или роль.
2. Authorizer определяет verified principal и current target membership либо
   проверяет anonymous publication policy до чтения Space metadata.
3. Revision resolver выбирает target HEAD для member view, exact historical
   revision для Snapshot View или `published_revision_id` для anonymous view.
4. Core строит base presentation этой target revision.
5. Для authenticated principal с designation, consent и
   `personal.context.read` PersonalContextProvider разрешает exact Personal
   Space revision и возвращает минимальный server-filtered context. Иначе flow
   остаётся в `base` mode.
6. Renderer строит base либо personalized `SpaceLanding`, фиксирует target и
   personal revision IDs, отдаёт HTML/structured representation; оба corpus
   остаются за пределами ответа.
7. Начало разговора создаёт `SpaceSession` и продолжает adaptive presentation,
   не меняя разрешённые revisions или права.

Неавторизованный запрос к private Space получает non-enumerating ответ без
name, summary, membership hints или различимого redirect. Derived landing text
помечается как generated. Anonymous landing создаётся только из явно
утверждённой publication configuration и не может автоматически суммировать
private HEAD.

SpaceLanding остаётся projection: authored content читается из revision,
presentation settings — из service metadata, а generated fragments не
записываются обратно в OKF без обычного draft/review/commit. Target content не
управляет PersonalContext query и не получает personal facts. Personalized
landing использует private per-principal cache или `no-store`; shared/CDN cache
может содержать только approved public base.

Historical durable URL может расширять canonical route точным revision ID,
например `/{space_handle}/revisions/{revision_id}`. Date/Checkpoint сначала
разрешаются в exact ID; shareable ссылка не хранит относительное время.

## Каноническая модель ревизий

Каждый Space имеет стабильный `space_id`, а каждый content commit создаёт новую
immutable `SpaceRevision`:

```text
KnowledgeSpace
├── HEAD -> revision id
├── revision
│   ├── revision id + monotonic revision number
│   ├── parent revision id
│   ├── manifest: path, SHA-256, media type, size
│   ├── exact OKF files and source assets
│   └── committed_by, server-assigned committed_at UTC, change summary
├── immutable checkpoint name -> exact revision id
└── derived index state per revision
```

Manifest — producer envelope, а не файл нормативного OKF bundle. Export
материализует только выбранное дерево bundle; service metadata в него не
подмешивается.

S3/R2 version IDs не заменяют SpaceRevision: одинаковый revision contract
должен работать на любой платформе. Hash каждого объекта обеспечивает
целостность и идемпотентность, но не означает доверие к содержанию.

## Разрешение истории и read-only mounts

History resolver принимает ровно один selector: HEAD, точный `revision_id`,
UTC `as_of` или имя immutable `Checkpoint`. Для `as_of` он выбирает revision с
максимальным монотонным номером, чей server-assigned `committed_at <= as_of`.
Даты внутри OKF и источников не участвуют в выборе. Относительное пользовательское
«два месяца назад» сначала становится точным UTC instant с явно выбранной
timezone.

Selector разрешается при создании/открытии mount и фиксируется как
`resolved_revision_id` на всю сессию:

```text
selector: head | revision_id | as_of | checkpoint
requested_value
resolved_revision_id
mode: live | historical
```

Не-HEAD selector всегда даёт historical mode. В нём effective permissions
дополнительно пересекаются с read-only capability set: mutation tools не
рекламируются и отклоняются даже для Owner. Current active membership и
`space.history.read` проверяются на каждом обращении; resolver никогда не
восстанавливает старую membership или ACL.

`Checkpoint` хранится в transactional service metadata, уникален внутри Space
после нормализации и не может быть retargeted. Его создание через trusted
control plane требует `space.checkpoint.write`, но не меняет HEAD и не создаёт
content revision. Это не OKF `tags`, не часть export и не publication pointer.
Если подходящей revision до `as_of` нет, resolver возвращает not found и не
подставляет первую revision или HEAD.

## Поток записи

1. Adapter аутентифицирует запрос и строит `ActorContext` без доверия к
   переданному клиентом `tenant_id`.
2. Core загружает current active SpaceMembership и проверяет её capabilities,
   mount/OAuth scopes и `membership_epoch`.
3. Input нормализуется в draft changeset; OKF parser/validator выдаёт errors и
   warnings без потери исходных bytes.
4. Пользователь проверяет diff, после чего trusted control plane выдаёт
   single-use approval token для точного draft hash и ожидаемого HEAD.
5. Core повторно проверяет membership и token, затем сверяет
   `expected_revision` с текущим HEAD.
6. Canonical objects и immutable manifest сохраняются идемпотентно.
7. Transactional metadata store условно продвигает HEAD и записывает outbox/audit
   reference. При конфликте новый HEAD не создаётся.
8. Background worker строит индекс для новой revision. Старый индекс не
   смешивается с новым благодаря фильтру `tenant_id + space_id +
   revision_id`.

Нужен recovery path для объектов, записанных до неудавшегося HEAD transaction:
они остаются недостижимыми и удаляются только безопасным garbage collection
после retention window.

## Поток чтения

1. Mount разрешает selector в `resolved_revision_id`; `search` применяет
   tenant/space/current-membership/mount/revision filter до выдачи результатов.
2. Derived index возвращает path/section, excerpt, content hash, revision и
   provenance pointers.
3. Core перечитывает ту же каноническую revision, когда точность важнее latency
   или index freshness не подтверждена.
4. `fetch` возвращает canonical text, URL/URI, OKF metadata, trust tier и
   freshness state; source pointer позволяет агенту дочитать evidence.
5. Ответ ограничивается явным result/token budget. Обрезание помечается.

## MCP surface

В MVP один MCP mount связан ровно с одним KnowledgeSpace. Для совместимости с
ChatGPT company knowledge/deep research стандартная пара остаётся минимальной:

- `search(query)` → `{ results: [{ id, title, url }] }`;
- `fetch(id)` → `{ id, title, text, url, metadata? }`.

`id` opaque и revision-bound: найденный результат фиксирует SpaceRevision и
path, поэтому последующий `fetch(id)` не перескакивает на новый HEAD. Расширенные
filters и section fetch при необходимости получают отдельные tools, а не
меняют compatibility contract. Historical revision выбирается selector всего
mount, а не аргументом отдельного retrieval call.

Mind Diary-specific tools добавляются узко:

- `get_space_info` и `browse_entries`;
- `list_revisions`, `get_revision` и `list_checkpoints`;
- `validate_space`;
- `get_draft_diff`;
- `create_draft`;
- `commit_draft(draft_id, expected_revision, approval_token, idempotency_key)`;
- `start_export` и `get_export_status`.

Import остаётся web/CLI operation в MVP. Если позже он появится в MCP, archive
передаётся через upload intent, а не внутри JSON-RPC.

Исторический selector задаётся при создании mount, поэтому standard
`search(query)`/`fetch(id)` не получают новые inputs. `get_space_info` сообщает
canonical Space URL/handle, landing mode, target `resolved_revision_id`,
private `personal_context_revision_id` при его использовании, selector,
`committed_at` и `is_historical`. Создание Checkpoint остаётся mutation trusted
web/CLI control plane и не публикуется в content MCP.
Historical mount предлагает только read-only tools; он не может создать draft,
commit, импортировать content, изменить metadata или сдвинуть HEAD. Export уже
существующей выбранной revision остаётся read operation и по-прежнему требует
role capability и `space.export`.

Точные schemas являются частью MVP и будут зафиксированы до реализации.
Read-only и mutation tools получают правдивые MCP annotations. Mutations не
маскируются под `search`/`fetch`.

Resource identity не содержит `mount_id`: mount — authorization context, а не
часть знания. Внутри одного Mind Diary deployment immutable resource имеет URI
наподобие:

```text
okf://spaces/{space-id}/revisions/{revision-id}/index
okf://spaces/{space-id}/revisions/{revision-id}/entries/{path}
```

Для ChatGPT citation поле `url` содержит auth-gated HTTPS-представление того же
resource. Оно стабильно внутри deployment, но не объявляется глобальным OKF ID.
Переносимая ссылка в export — tuple `revision manifest hash + bundle path`;
сам OKF не задаёт глобальную идентичность concept.

Конкретный клиент может не показывать resources напрямую, поэтому критические
сценарии остаются доступны через tools.

## Identity, memberships и KnowledgeMount

Один deployment обслуживает много tenants. Подключение получает не `tenant_id`
из аргумента tool, а проверенный `principal_id` из `issuer + subject` и
`mount_id`. В MVP mount связывает:

- ровно один KnowledgeSpace;
- current active SpaceMembership;
- HEAD или один selector, разрешённый в точный `resolved_revision_id`;
- content scopes `space.read`, `space.history.read`, `space.draft`,
  `space.commit`, `space.export`;
- Space-level ACL без частичных path/tag grants.

Control-plane scopes, включая `space.checkpoint.write`, и sessions не являются
частью content MCP mount. `personal.context.read` относится к identity/web
presentation context, а не добавляет второй Space в content mount.

Role определяет максимум capabilities: Reader читает; Editor также создаёт и
commit-ит reviewed drafts; Admin управляет Reader/Editor и settings/export;
Owner управляет Admin/Owner, visibility и lifecycle. Effective permissions —
пересечение role capabilities, mount/OAuth scopes и deployment flags.

`space.export` материализует всю выбранную revision и выдаётся только mount без
частичных ограничений. Если позже появятся path/tag grants, они не наследуют
bulk export: subset export потребует отдельной модели revision и provenance.

Наличие `space.commit` само по себе не завершает mutation. В reviewed mode,
обязательном для MVP, trusted web/control-plane flow после показа diff выдаёт
single-use approval token, связанный с actor, Space, draft hash, expected HEAD,
`membership_epoch` и expiry. MCP server повторно проверяет current membership и
пишет token ID в audit без секрета. Режим autonomous commit потребует отдельного
решения и scope; tool annotations остаются UX hints, а не authorization control.

В local profile роль control plane выполняет отдельная operator CLI: она читает
draft/diff через application core, требует явное подтверждение и выпускает
token вне MCP. Ручной Inspector test получает token этим CLI между draft и
commit. Автоматические tests используют fixture `ApprovalIssuer`, доступный
только test process и отсутствующий в production container. В Sites/AWS token
выпускает аутентифицированный web/control-plane endpoint после того же review;
непроверенный MCP content не имеет доступа к issuer.

Membership administration не публикуется в content MCP. `get_space_info`
возвращает role/effective content capabilities и `management_url`; добавление
участников, role changes, ownership и deletion выполняются в trusted web/CLI
control plane. Membership mutation не меняет content HEAD, но атомарно обновляет
membership state/version, `membership_epoch`, owner count, idempotency result и
audit event. Последнего active Owner снять нельзя.

Remote MCP следует authorization profile выбранной protocol version: OAuth
2.1, authorization code + PKCE, Protected Resource Metadata и audience-bound
access tokens. Issuer, audience, expiry и scopes проверяются на каждом вызове.
Входящий token нельзя пересылать downstream.

Для OpenAI-публикации также нужны стабильный HTTPS endpoint, domain challenge,
logging/metrics и реальная проверка Developer mode. Cognito не поддерживает
RFC 7591 Dynamic Client Registration; если конкретный клиент не допускает
pre-registration или Client ID Metadata Documents, потребуется другой OAuth
provider либо auth broker.

## KnowledgeSite и adaptive interaction

KnowledgeSite не экспортирует Space в отдельную «сайтовую» базу. Publication
record связывает route и presentation settings с одним
`published_revision_id`; renderer читает ту же immutable revision, что MCP и
export. Content HEAD и published revision различаются.

Canonical `/{space_handle}` существует независимо от publication. Для private
member он открывает auth-gated landing разрешённой revision. Publication
добавляет anonymous policy к той же Space identity и не создаёт второй Space.

```text
Owner promotes SpaceRevision
        │
        ▼
KnowledgeSite renders authored entrypoint
        │ visitor question / audience profile
        ▼
SpaceSession -> SpaceGuide -> revision-bound search/fetch
        │
        ▼
answer + sources + suggested next topics
```

Default publication policy — `pinned`. Commit не меняет сайт, пока Owner с
`space.publish` явно не продвинет revision. `follow_head` может понадобиться для
community-wiki, но это отдельная policy с видимым предупреждением: каждый
принятый commit немедленно становится опубликованным.

Первая public-модель считает весь corpus published revision доступным для
site/search/fetch. Entrypoint управляет навигацией, но не скрывает paths. Пока
нет отдельного subset-publication manifest и security model, private и public
материал должны находиться в разных Spaces.

`SpaceSession` содержит context конкретного посетителя. Фраза «я
профессиональный историк» может дополнить bounded context из Personal Space и
изменить vocabulary, depth и порядок подачи, но не authorization, ranking trust
signals или canonical facts. Долговременный profile может быть authored
knowledge в designated Personal Space; его использование требует отдельного
scope/consent и retention policy для derived data.

`SpaceGuide` читает ровно одну target revision и возвращает provenance. Для
member session её задаёт KnowledgeMount, для anonymous site session — только
publication record. Bounded PersonalContext разрешён server-side только для
того же authenticated principal и не является вторым searchable corpus.
Opening brief, suggested questions и recommendations являются derived outputs:
они не попадают в Space другим пользователям и не становятся знаниями без
обычного draft/review/commit. General cross-space recommendations запрещены;
outbound push и внешние actions также остаются за границей текущего дизайна.

## Deployment profiles

### Local vertical slice

- Один процесс и один MCP endpoint.
- Локальный Web/API route на test base URL реализует canonical
  `/{space_handle}` и structured base/personalized SpaceLanding для integration
  tests.
- Filesystem сохраняет exact revision objects.
- SQLite хранит host/handle resolver, Personal Space designation, consent state,
  metadata version, HEAD, memberships, owner count, membership epoch,
  упорядоченный revision log, immutable checkpoints, jobs и lexical FTS index
  per revision.
- Один тестовый tenant и несколько principals; tenant/space/membership filter
  остаётся обязательным в API.
- Никаких embeddings до корректного source-backed search/fetch.

Это самый короткий путь проверить domain contract без облачной сложности.

### OpenAI Sites prototype

Подтверждённая роль Sites — web/admin UI с server-side routes, D1 для structured
data и R2 для objects. Первый Sites milestone — UI для import, validation,
browse, export и управления участниками/ролями, плюс read-only preview
canonical Space URL/landing и KnowledgeSite для выбранной revision. Data-only
MCP остаётся ядром агентного продукта, но совместное размещение MCP и adaptive
conversation не блокируют этот UI.

Официальная документация Sites не обещает Streamable HTTP MCP, SSE без
buffering, `/mcp` compatibility или прохождение plugin review. Поэтому единый
Sites deployment — compatibility spike, а не архитектурная гарантия.

Gate для признания Sites MCP-host:

1. Прохождение lifecycle реально выбранного profile: required per-request
   protocol metadata для `2026-07-28` либо legacy initialize/version negotiation
   для `2025-11-25`; фактически принятая ChatGPT версия фиксируется в отчёте.
2. `tools/list`, `search` и `fetch` из реального ChatGPT Developer mode.
3. Streaming без buffering и корректная отмена/ошибки.
4. OAuth discovery, scopes и refresh flow.
5. `/.well-known/openai-apps-challenge` и стабильный public URL.
6. Проверка текущей plan/region/workspace availability для Madeira; Sites
   остаётся public beta, а доступность зависит от этих условий.

Compatibility spikes совместного размещения MCP и server-side adaptive chat
запускаются отдельно. Если gate не пройден, Sites остаётся UI/static presentation,
а portable MCP/interaction container размещается отдельно. Это не меняет domain
или tool contracts.

### AWS target

Рекомендуемая первая AWS-топология:

```text
MCP clients ──OAuth/JWT──> Bedrock AgentCore Runtime: Streamable HTTP MCP
Browsers ──HTTPS─────────> CloudFront/edge -> portable Web/API runtime
                                      │ canonical /{space_handle}
                                      │
Both adapters share application ports and use:
    ├── S3: immutable OKF revisions and assets
    ├── DynamoDB: Space, memberships, HEAD, ordered revisions, checkpoints,
    │   publication, jobs, idempotency
    ├── DynamoDB Streams -> idempotent Lambda indexer
    ├── OpenSearch Serverless: optional lexical + vector index
    └── CloudWatch/OpenTelemetry: operational telemetry
```

AgentCore Runtime выбран как MCP-native target: он принимает container на
`0.0.0.0:8000/mcp`, поддерживает Streamable HTTP и JWT/SigV4 authorization.
Stateless mode достаточен, потому что долговременная истина находится в
storage, а не в MCP session.

AgentCore остаётся MCP-native runtime, а canonical Space URL обслуживает
отдельный переносимый Web/API adapter. Конкретный AWS compute для него
(container service или serverless HTTP) выбирается отдельным deployment
решением; route и application contract от этого не меняются.

DynamoDB conditional writes/transactions реализуют HEAD CAS. S3 Versioning —
аварийная страховка, но не доменная история. DynamoDB Streams + Lambda имеют
at-least-once semantics, поэтому index job идентифицируется revision и content
hash. OpenSearch не участвует в commit path и может быть полностью перестроен.

Revision records поддерживают strongly consistent lookup по ID, монотонному
номеру и predecessor для `as_of`; Checkpoint conditional write создаёт только
новое имя и не допускает retarget. Исторический read сначала разрешает selector
в exact revision, затем применяет тот же tenant/membership filter, что HEAD.

Membership storage использует command-level operations
`create_space_with_owner`, `change_membership`, `revoke_membership` и
`transfer_ownership`. DynamoDB transaction повторно проверяет actor membership,
делает target version CAS, сохраняет `owner_count >= 1`, увеличивает
`membership_epoch` и пишет audit/idempotency records. Авторизация читает
membership по strongly consistent primary key, а не через eventually consistent
индекс «мои Spaces».

Create резервирует `(host_namespace, normalized_handle)` conditional write и
создаёт creator-owner в той же transaction. Rename display name меняет только
Space metadata version. Handle lookup и Personal Space designation имеют
отдельные strongly consistent records, но durable records и authorization
продолжают использовать `space_id`.

AgentCore Gateway, Verified Permissions, Object Lock, Bedrock Knowledge Bases и
AgentCore Memory не входят в AWS v1. Их добавляют только при подтверждённой
задаче: aggregation/policy, сложный ABAC, compliance retention, сменный RAG
adapter или conversation memory соответственно.

## Поиск и embeddings

MVP начинает с metadata filters + lexical search. До включения vector search
нужен benchmark на реальных русских и английских вопросах с измерением recall,
precision/grounding и стоимости.

Если hybrid search доказал пользу, chunk содержит `tenant_id`, `space_id`,
`revision_id`, `path`, `section`, provenance, text hash и embedding model/version.
Исторический query всегда фильтруется по exact revision. Если её index ещё не
построен или был удалён как производный, система перестраивает его лениво либо
явно сообщает lag/unavailable; fallback к HEAD запрещён. Embedder остаётся
портом. Titan Text Embeddings V2 — AWS-кандидат, но его cross-language качество
нельзя предполагать без теста.

## Observability и audit

- Operational logs/traces содержат request ID, latency, tool, result count и
  error class, но не приватный текст concept/chunk, PersonalContext, audience
  profile или conversation body. URL routing не логирует private landing
  content.
- Application audit хранит actor, tenant, mount, action, Space, old/new revision,
  requested history selector, resolved revision, object/result IDs и outcome.
- CloudTrail покрывает AWS control plane и явно включённые data events, но не
  заменяет user-level audit.
- Метрики: auth failures, revision conflicts, validation failures, index lag,
  historical-resolution failures, stale-index reads, base/personalized landing
  latency, personalization fallback/cache-isolation failures, search/fetch
  latency и export/import failures.

## Недоверенное содержимое и import boundary

OKF content, raw sources и metadata являются данными, а не инструкциями
Mind Diary или вызывающему агенту. Retrieval responses должны отделять content
от server guidance. Embedded prompt может повлиять на модель, поэтому server не
доверяет намерению tool call: scope, draft boundary и внешний approval artifact
не дают такому content самостоятельно повысить права или перейти в commit.

Import распаковывается в изолированной временной области с quotas на число
entries, общий и распакованный размер, глубину и compression ratio. Absolute
paths, `..`, symlinks/hardlinks и special files отклоняются до object write.
Remote crawling не входит в MVP; будущий URL importer потребует SSRF policy,
allow/deny rules, redirect limits и content-type/size checks.

Web UI экранирует HTML и URL schemes, использует строгий CSP и не исполняет
scripts из Markdown/assets. Download URLs короткоживущие, scoped на один object
и не попадают в логи или model-visible metadata.

## Риски и открытые вопросы

- Совместим ли Sites runtime с полным MCP/OpenAI review flow на практике?
- Какой OAuth provider удовлетворит одновременно ChatGPT и AWS deployment без
  собственного небезопасного authorization server?
- Когда после MVP действительно понадобится multi-space или path-filtered mount?
- Какая отдельная модель visibility и anonymous access нужна для `public_read`?
- Какие normalization, confusable, reserved-route и registration-conflict rules
  нужны для host-unique handles?
- Какая discovery/link-graph модель превратит отдельные Space URLs в сеть, не
  раскрывая private Spaces и не создавая неявный cross-space retrieval?
- Нужен ли community Space режим `follow_head`, или publication всегда требует
  отдельного promotion?
- Какие categories, consent и retention rules допустимы для PersonalContext,
  adaptive profiles и proactive recommendations?
- Хватит ли lexical search для MVP, и на каком corpus оправдан hybrid search?
- Как сохранить byte-perfect YAML style при изменении одного поля: AST
  round-trip или canonical reserialization с явным diff?
- Какая retention и hard-erasure policy нужна для committed history и удалённых
  sources, если privacy deletion должна нарушить воспроизводимость revision?

## Внешние основания

- [OKF 0.2 specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
- [MCP stable specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic)
- [MCP resources 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)
- [MCP legacy compatibility specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic)
- [OpenAI: build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [OpenAI: MCP authentication](https://developers.openai.com/plugins/build/auth)
- [OpenAI Sites](https://learn.chatgpt.com/docs/sites)
- [AWS: host MCP in AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp.html)
- [AWS: DynamoDB optimistic locking](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/BestPractices_OptimisticLocking.html)
- [AWS: S3 Versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/versioning-workflows.html)
