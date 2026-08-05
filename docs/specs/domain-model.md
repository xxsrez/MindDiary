# Доменная модель и доступ

Статус: proposal, 2026-08-05. Модель расширяет первоначальный single-user MVP
до именованных совместных пространств и будущей web-публикации; код и
migrations ещё не реализованы.

## Терминология

Главная пользовательская сущность называется **KnowledgeSpace** («пространство
знаний», в коротком UI — `Space`). Это живой совместный объект CloudBrain: у
него есть содержимое, HEAD revision, участники, роли, настройки и audit history.

Название выбрано вместо:

- `KnowledgeBase`, чтобы не путать продуктовую сущность с конкретной БД и
  Amazon Bedrock Knowledge Bases;
- `Workspace`, потому что термин уже перегружен в ChatGPT и других SaaS;
- `Vault`, потому что Space может стать публично читаемым;
- `OKFBundle`, потому что bundle — переносимый файл-снимок, а не live-сервис.

Остальные термины:

| Термин | Значение |
|---|---|
| `KnowledgeSpace` | Совместный aggregate и access boundary вокруг одного логического дерева знаний. |
| `SpaceRevision` | Неизменяемый снимок содержимого Space с manifest и parent revision. |
| `Checkpoint` | Неизменяемая именованная ссылка на одну `SpaceRevision`. Это service metadata, не OKF `tags`. |
| `Snapshot View` | Read-only view/mount, один раз разрешённый в точную revision по ID, времени или Checkpoint. |
| `OKFBundle` | Материализованный импорт/экспорт ровно одной `SpaceRevision`. В нём нет memberships и ACL. |
| `KnowledgeEntry` | Пользовательский searchable OKF concept document. Это не общий тип для любых bytes. |
| `Source` | Source-faithful материал или typed source concept с provenance. |
| `Asset` | Binary/non-Markdown объект со своими правилами чтения и передачи. |
| `Index` / `Log` | Reserved OKF `index.md` и `log.md`, не обычные `KnowledgeEntry`. |
| `SpaceMembership` | Связь principal с одним Space, ролью и lifecycle state. |
| `KnowledgeMount` | Authorization binding одного MCP connection к одному Space. Не часть знания. |
| `KnowledgeSite` | Web-представление явно опубликованной `SpaceRevision`; не отдельная копия знаний. |
| `SpaceSession` | Контекст одного участника или посетителя и его audience profile; service metadata, не OKF. |
| `SpaceGuide` | Read-only orchestration, которая отвечает и предлагает материалы по разрешённой revision. |

Слово «артефакт» допустимо как неформальное общее описание содержимого, но API
не должен скрывать под ним разные правила concept, source, asset и reserved
files. Во внутреннем manifest любой path-addressed object можно назвать
`RevisionObject` или `BundleEntry`.

## Отношения

```mermaid
flowchart LR
    User[User / Principal]
    Membership[SpaceMembership]
    Space[KnowledgeSpace]
    Revision[SpaceRevision]
    Checkpoint[Checkpoint]
    Bundle[OKFBundle]
    Entry[KnowledgeEntry]
    Source[Source]
    Asset[Asset]
    Mount[KnowledgeMount]
    Site[KnowledgeSite]
    Session[SpaceSession]
    Guide[SpaceGuide]

    User -->|many| Membership
    Membership -->|many-to-one| Space
    Mount -->|actor + effective permissions| Membership
    Mount -->|exactly one| Space
    Space -->|HEAD| Revision
    Space -->|history| Revision
    Checkpoint -->|names exactly one| Revision
    Revision --> Entry
    Revision --> Source
    Revision --> Asset
    Revision -->|materialize| Bundle
    Site -->|published revision| Revision
    Session -->|conversation context| Space
    Guide -->|reads| Revision
    Guide -->|adapts for| Session
```

Один пользователь может иметь memberships в нескольких Spaces. У одного Space
может быть несколько пользователей и несколько одновременных editors. Web
control plane показывает список доступных Spaces; content MCP по-прежнему
работает только с одним Space на connection и не делает неявный cross-space
search.

## Имя и адресация

Каждый Space имеет два разных идентификатора:

```text
space_id          # immutable opaque primary identity
name              # required human-readable name
normalized_name   # service-derived uniqueness key
metadata_version  # CAS for rename/settings
```

В MVP `normalized_name` уникален в пределах tenant. Global uniqueness не нужна:
она раскрывала бы существование private Spaces и создавала бы ненужный рынок
имён. Минимальная нормализация фиксируется до реализации и как минимум включает
trim, Unicode NFC и case folding.

API, ACL, audit, revisions, mounts и durable links адресуют Space через
`space_id`. Человек может выбрать Space по имени, но resolver сначала переводит
`tenant_id + normalized_name` в ID. Rename выполняется с
`expected_metadata_version`; изменение имени не меняет content HEAD и не
переписывает OKF bundle.

Для будущих public URLs отдельный namespace/slug и aliases могут дать адрес
наподобие `/@publisher/napoleon`. Они не меняют внутреннюю identity и не входят
в MVP.

## Сценарии, а не типы Space

Не вводится enum `personal | group | community | site`: один Space может менять
способ использования без миграции содержимого.

| Сценарий | Конфигурация |
|---|---|
| Personal | `private`, один Owner, publication отсутствует. |
| Shared/family | `private`, несколько memberships и параллельные Editors. |
| Community wiki | Несколько trusted Editors; moderation/reputation пока отсутствуют. |
| Knowledge site | Space имеет publication на выбранную revision и presentation surface. |

Visibility, membership и publication policy остаются независимыми осями.

## Principal и membership

`principal_id` — opaque stable ID, полученный из проверенной пары
`issuer + subject`; email или display name не являются identity key.

Минимальная запись `SpaceMembership`:

```text
tenant_id
space_id
principal_id
role: reader | editor | admin | owner
state: active | revoked
version
created_at / created_by
updated_at / updated_by
```

На `(tenant_id, space_id, principal_id)` существует не более одного active
membership. Revoke сохраняет tombstone и историю вместо физического удаления.
Invitation lifecycle, groups и external collaborators требуют отдельной
спецификации; MVP добавляет только уже существующий точный `principal_id`.

Membership — service metadata. Его изменение не создаёт OKF concept, не меняет
content HEAD и не попадает в `OKFBundle`.

## Роли

Человеческая роль `write-only` не используется. Редактору необходимо видеть
текущий content, sources и HEAD, чтобы не создавать слепые конфликты. Поэтому
роль называется `editor` и включает чтение.

Роли образуют понятную продуктовую иерархию, но authorization code проверяет
именованные capabilities, а не числовое сравнение enum:

| Capability | Reader | Editor | Admin | Owner |
|---|:---:|:---:|:---:|:---:|
| Browse, search, fetch, history, validate | ✓ | ✓ | ✓ | ✓ |
| Create draft, inspect diff, reviewed commit | — | ✓ | ✓ | ✓ |
| Create immutable Checkpoint | — | ✓ | ✓ | ✓ |
| Full OKF export | — | — | ✓ | ✓ |
| Add/revoke `reader` or `editor` | — | — | ✓ | ✓ |
| Configure non-destructive Space settings | — | — | ✓ | ✓ |
| Grant/revoke `admin` or `owner` | — | — | — | ✓ |
| Change visibility, transfer ownership, archive/delete | — | — | — | ✓ |
| Publish a revision or change publication policy | — | — | — | ✓ |

Запрет bulk export для Reader/Editor — продуктовая защита от простой массовой
выгрузки, а не обещание предотвратить копирование уже прочитанного content.

Если позже понадобится настоящий ingest-only principal, это будет отдельный
machine capability наподобие `source.submit`, а не человеческая роль в этой
иерархии.

## Effective permissions

Роль задаёт верхнюю границу. Реальные права конкретного вызова равны:

```text
membership capabilities
∩ mount / OAuth scopes
∩ deployment-enabled capabilities
```

Например, Owner с read-only mount остаётся read-only. Editor/Admin/Owner всё
равно не обходят reviewed approval artifact для content commit.

Предлагаемые scopes:

- `space.read`;
- `space.history.read`;
- `space.draft`;
- `space.commit`;
- `space.checkpoint.write`;
- `space.export`;
- `space.settings`;
- `space.members.read`;
- `space.members.write`;
- `space.publish`;
- `space.owner`.

Role и membership state не кэшируются в JWT как источник истины. Каждый
tool/resource проверяет текущий active membership. `membership_epoch` Space
инвалидирует будущие caches и входит в security-sensitive approval artifacts.
Если membership отозван после создания draft, commit отклоняется.

## Owner invariants

Минимальная отличительная семантика Owner фиксируется уже сейчас:

- создание Space и creator-owner membership — одна атомарная операция;
- у active Space всегда есть хотя бы один active Owner;
- Owners может быть несколько;
- только Owner назначает или отзывает `admin`/`owner`;
- последнего Owner нельзя demote, revoke или удалить;
- Owner может выйти или понизить себя только при наличии другого Owner;
- transfer ownership атомарно повышает target и понижает source;
- import OKF bundle никогда не импортирует owner или memberships.

Billing, legal ownership, recovery после удаления аккаунта и organization-level
policy остаются открытыми вопросами. До их решения Space без bootstrap Owner не
создаётся.

## Space и membership mutations

Space/membership commands работают через command-level storage port, а не
generic CRUD:

```text
create_space_with_owner(name)
rename_space
add_membership
change_membership_role
revoke_membership
transfer_ownership
```

Membership changes принимают `expected_membership_version`, rename —
`expected_metadata_version`; все повторяемые commands принимают
`idempotency_key`. Create резервирует имя условно, когда Space ещё не существует.
Одна storage transaction:

1. проверяет tenant-level create capability либо current active membership;
2. резервирует tenant-scoped `normalized_name`, если команда меняет имя;
3. делает CAS target membership или Space metadata;
4. сохраняет last-owner invariant;
5. увеличивает нужный epoch/version;
6. записывает audit event и idempotency result.

Успешного Space/membership change без audit event быть не может. Audit содержит
opaque actor/subject IDs, before/after name, role or state, request ID и outcome,
но не email, JWT, approval token или private content.

## Совместное редактирование

Membership не заменяет content concurrency protocol. Несколько Editors могут
создавать drafts параллельно, но commit по-прежнему требует:

- active membership и `space.commit` в момент commit;
- внешний approval artifact для точного draft hash;
- `expected_revision` HEAD CAS;
- новую immutable `SpaceRevision` без last-writer-wins.

Текстовый merge, rebase и разрешение semantic conflicts остаются отдельной
функцией. Role change не блокирует Space целиком и не создаёт content revision.

## История, Checkpoints и Snapshot View

Каждый успешный content commit добавляет полную immutable `SpaceRevision` в
линейную историю Space. Линейность MVP следует из HEAD CAS: новая revision
имеет ровно одного parent и становится новой HEAD. Branches, merges и запись
поверх detached revision не поддерживаются.

Минимальная service metadata revision:

```text
revision_id
revision_number       # монотонно растёт внутри Space
parent_revision_id
committed_at          # server-assigned UTC
committed_by
manifest_hash
summary
```

Историческое состояние выбирается одним из selector:

- точный `revision_id`;
- `as_of` — максимальная `revision_number`, у которой server-assigned
  `committed_at <= as_of`;
- `checkpoint` — tenant/Space-scoped имя, неизменно указывающее на точную
  revision.

Фраза вроде «два месяца назад» сначала интерпретируется клиентом или trusted
control plane с явной timezone и превращается в точный UTC instant. Resolver
один раз фиксирует `resolved_revision_id`; все последующие browse/search/fetch
в сессии используют его. Ответ показывает и исходный selector, и фактически
разрешённую revision. Даты внутри OKF content, `generated.at` и source metadata
не участвуют в выборе истории. Если до указанного `as_of` ещё не было ни одной
revision, resolver возвращает not found, а не подставляет первую revision или
HEAD.

`Checkpoint` создаётся Editor/Admin/Owner с `space.checkpoint.write` через
trusted web/CLI control plane. Имя уникально внутри Space после нормализации,
а ссылка неизменяема: retarget запрещён, для новой точки создаётся новое имя.
Checkpoint не меняет HEAD, не создаёт `SpaceRevision`, не является publication
и не входит в `OKFBundle`. В разговорном UI его можно пояснять как «метка
версии», но API не использует слово `tag`, чтобы не путать с OKF content tags.

Любой selector, отличный от HEAD, создаёт `Snapshot View`: mount помечается как
historical и принудительно становится read-only независимо от роли. Mutation
tools в нём отсутствуют или возвращают однозначную read-only ошибку. Доступ
каждый раз проверяется по текущей active membership и `space.history.read`;
исторические ACL/memberships не восстанавливаются, поэтому отозванный участник
не получает доступ к старому content.

Исторический search/fetch обязан читать и фильтровать только
`resolved_revision_id`. Производный индекс строится отдельно для revision и
может быть восстановлен лениво из canonical objects. Отсутствующий индекс не
разрешает fallback на HEAD или смешивание chunks: browse/fetch остаются
доступными, а search либо запускает/ожидает rebuild, либо честно сообщает о
недоступности.

В MVP все успешно committed, достижимые из истории revisions сохраняются.
Удаление entry из HEAD не стирает его из прежних revisions; интерфейс явно
предупреждает об этом. Hard erasure, юридический right-to-delete и сроки
retention требуют отдельного дизайна, потому что могут нарушить
воспроизводимость старых revisions. Неуспешно записанные и недостижимые objects
могут удаляться безопасным garbage collection после retention window.

`KnowledgeSite` не открывает history или Checkpoints автоматически. Anonymous
visitor видит только `published_revision_id`; публикация другой revision —
отдельное явное действие Owner.

## Content plane и control plane

Membership management не публикуется в том же MCP, который помещает corpus в
model context. Это защита от prompt injection, а не только UI-решение.

- **Content MCP:** `search`, `fetch`, browse, read-only просмотр истории,
  drafts, diff и commit с внешним approval.
- **Trusted control plane:** список Spaces, memberships, role changes,
  ownership, visibility, lifecycle, создание Checkpoint и approval issuance
  через web UI/CLI.

`get_space_info` может вернуть текущую role, effective content capabilities и
`management_url`, но клиент никогда не передаёт role обратно как доказательство
прав. Если agent-assisted administration понадобится позже, для него нужен
отдельный privileged MCP без corpus/search/fetch и со step-up approval.

## Publication и adaptive interaction

`KnowledgeSite` — projection, а не новая копия Space. Минимальная publication
configuration содержит:

```text
site_id
space_id
published_revision_id
route / visibility
entrypoint
presentation settings
publication_version
```

По умолчанию publication pinned к одной immutable revision. Новый content HEAD
не становится публичным автоматически: Owner явно продвигает проверенную
revision через `space.publish`. Возможный режим `follow_head` требует отдельного
решения, заметного предупреждения всем writers и теста на accidental disclosure.

В первой public-модели все objects опубликованной revision считаются читаемыми
через site/search/fetch, даже если entrypoint на них не ссылается. Entrypoint —
навигация, не ACL. Для смеси private и public content нужны разные Spaces; subset
publication потребует отдельного publication manifest и security model.

KnowledgeSite сначала рендерит authored entrypoint, например root `index.md` или
выбранный concept. Интерактивный слой создаёт `SpaceSession` и использует
`SpaceGuide`:

1. visitor читает базовое представление published revision;
2. задаёт вопрос или сообщает audience profile, например уровень подготовки;
3. Guide делает revision-bound search/fetch и строит ответ с provenance;
4. profile меняет глубину, терминологию и последовательность объяснения, но не
   факты, ACL или каноническую revision;
5. generated answer, suggested question или recommendation остаётся derived
   session output, пока Editor явно не проведёт его через draft/review/commit.

В authenticated personal/shared сценарии тот же Guide читает revision, доступную
через KnowledgeMount. В anonymous site-сценарии он всегда ограничен
`published_revision_id`; audience profile не может расширить этот corpus.

«Проактивность» первой версии interaction означает opening brief, suggested
questions и revision-bound recommendations во время активной сессии. Outbound
push, расписания, действия во внешних системах и рекомендации по нескольким
Spaces требуют отдельной consent/delivery/authorization спецификации.

Audience profile и conversation history по умолчанию session-scoped и не
попадают ни в SpaceRevision, ни в OKFBundle. Сохранение пользовательских
предпочтений требует opt-in, retention policy и отдельного private profile
store. Один visitor не меняет представление для остальных.

## Visibility

Visibility — отдельная политика, не роль и не fake membership:

- `private` — единственный режим MVP;
- `unlisted` — возможный будущий режим;
- `public_read` — возможный будущий Wikipedia-like режим.

Первый Wikipedia-like сценарий CloudBrain означает совместное авторство,
revision history и revert внутри private Space. `public_read` реализуется через
KnowledgeSite и только по `published_revision`; он требует отдельного threat
model для anonymous identity, discovery, indexing, cache, citations и переходов
private ↔ public.

## Граница MVP

Обновлённый MVP включает required tenant-unique name, private shared Space,
несколько active users, четыре роли, membership audit и last-owner protection.
Он также включает read-only историю по revision ID, времени и immutable
Checkpoint. Он не включает branches, merges, historical writes, moving tags,
hard-erasure policy, KnowledgeSite/SpaceGuide, invitations, groups, path/tag
grants, public links, cross-tenant sharing или organization administration.
