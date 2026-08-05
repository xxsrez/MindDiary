# Обзор Mind Diary

Статус: proposal, 2026-08-05.

## Зачем проект существует

Mind Diary должен дать людям и агентам совместный управляемый доступ к
`KnowledgeSpace` по выбранной теме: обнаружить его структуру, найти релевантные
concepts, проверить источники, добавить новый материал, зафиксировать новую
ревизию и экспортировать данные в переносимом виде. Выбранную ревизию можно
будет опубликовать как knowledge site: посетитель сначала читает подготовленное
представление, затем задаёт вопросы и получает объяснение, адаптированное под
его уровень, но основанное на тех же источниках.

Вторая, равноправная цель — получить практический опыт AWS на реальном
продуктовом контуре: identity, object storage, transactional metadata,
контейнерный MCP runtime, асинхронная индексация, observability и infrastructure
as code.

В product language один `KnowledgeSpace` называется **Mind**, а одна
пользовательская `KnowledgeEntry` — **Memory**. Архитектурные разделы сохраняют
термины Space/Entry там, где важна точность API, ACL или OKF semantics.

## Ментальная модель

Mind Diary — не способ заранее загрузить всю тему в prompt. MCP публикует
описания tools и resources, а клиент и модель выбирают, когда искать и что
читать. Только результаты этих вызовов занимают контекст. Поэтому продукт
должен оптимизировать progressive disclosure: короткий обзор, точный поиск,
цитируемый фрагмент и возможность дочитать канонический concept или source.

Сам Space не является автономным агентом. Каноническое знание остаётся
неизменяемой ревизией, а ответы, рекомендации и порядок подачи — derived
presentation конкретной ревизии для конкретного пользователя или сессии.

## Адресуемая сеть знаний

Продуктовая гипотеза Mind Diary — «интернет из знаний»: базовой адресуемой
единицей становится не страница и не чат, а `KnowledgeSpace`. У каждого Space
есть стабильный человекочитаемый canonical HTTPS URL вида
`https://{space-host}/{space_handle}`. `space_handle` — внешнее имя-идентификатор
в пределах host namespace; внутри сервиса оно разрешается в immutable
`space_id`, который используют ACL, revisions, audit и storage.

Переход по URL сначала открывает `SpaceLanding` одной разрешённой revision. Он
отвечает на четыре вопроса:

- что это за Space и о чём он;
- какие основные темы и authored entrypoints доступны;
- на какой revision, источниках и freshness signals основано представление;
- что можно прочитать или спросить дальше.

Для anonymous/no-consent посетителя это `base`-представление. Для
аутентифицированного пользователя продуктовая гипотеза — уже первый landing
адаптировать под его язык, уровень знаний, интересы и цели с помощью
ограниченного контекста из designated Personal Space. Пользователь может
отключить адаптацию и увидеть базовую версию. Personal context меняет подачу,
но не corpus, source trust, revision или права.

Personal Space при этом не является особым форматом базы. Это обычный private
KnowledgeSpace, связанный с principal отдельной service metadata. Server-side
policy извлекает из него минимальный purpose-bound контекст; целевой Space не
получает доступ к личному corpus и не может управлять таким извлечением.
Последующий разговор создаёт `SpaceSession` и продолжает адаптацию в тех же
границах.

URL существует и у private Space, но это не public link. Неавторизованный
запрос не получает название, summary или подтверждение существования Space.
Anonymous landing возможен только для явно опубликованной revision; сервис не
строит его автоматически из private HEAD. Глобальный каталог, discovery,
cross-space links и поисковая сеть — возможное развитие этой гипотезы, а не
обещание MVP.

## Основные сущности

- `KnowledgeSpace` — live collaborative container с immutable внутренним ID,
  стабильным URL handle, display name, содержимым, участниками, ролями,
  настройками и HEAD revision.
- `SpaceRevision` — immutable snapshot содержимого.
- `Checkpoint` — неизменяемое человекочитаемое имя для конкретной
  `SpaceRevision`; это не OKF content tag.
- `Snapshot View` — read-only представление Space, один раз привязанное к точной
  revision по ID, времени или Checkpoint.
- `OKFBundle` — переносимый import/export одной revision без ACL и memberships.
- `KnowledgeEntry`, `Source` и `Asset` остаются разными видами содержимого с
  разными правилами чтения и изменения.
- `SpaceMembership` связывает пользователя со Space и ролью `reader`, `editor`,
  `admin` или `owner`.
- `KnowledgeMount` связывает один MCP connection с одним Space и подмножеством
  разрешённых возможностей.
- `Personal Space designation` связывает principal с одним обычным private
  Space, который можно использовать как источник разрешённого личного контекста.
- `SpaceLanding` — базовое или персонализированное начальное представление Space
  по его URL, привязанное к exact target revision и, при адаптации, exact
  Personal Space revision.
- `KnowledgeSite` публикует выбранную immutable revision как обычные страницы и
  интерактивную точку входа.
- `SpaceSession` хранит контекст конкретного разговора, включая заявленный
  уровень аудитории; `SpaceGuide` использует его для адаптивных ответов и
  предложений, не изменяя Space.

Точная модель и role matrix описаны в
[доменной спецификации](specs/domain-model.md).

## Продуктовые сценарии

Это не фиксированные `space_type`, а сценарии и конфигурации одной сущности:

1. **Personal Mind.** Один Owner хранит знания по теме или обо всём сразу;
   Space остаётся private. Один такой Space может быть явно designated как
   default Personal Space для адаптации других Spaces.
2. **Shared Mind.** Семья или небольшая группа добавляет разные наблюдения и
   получает общую source-aware картину без потери авторства и revision history.
3. **Community Mind.** Доверенные Editors совместно собирают знания по игре или
   другой теме в wiki-подобной модели. Moderation, reputation и review queues
   появятся только при реальной необходимости.
4. **Knowledge site.** Владелец публикует выбранную ревизию как статическую
   основу сайта. Anonymous посетитель получает базовый SpaceLanding, а
   аутентифицированный пользователь может сразу получить более подходящую
   подачу — например, как профессиональный историк — и затем продолжить
   разговор на основе того же corpus.
5. **Historical view.** Участник открывает Space «на момент два месяца назад»
   или по Checkpoint. Время разрешается в точную revision, и весь разговор,
   поиск и fetch остаются привязаны к ней без смешивания с HEAD.

Space может пройти этот путь постепенно: personal → shared → community →
published, не меняя `space_id` и не мигрируя каноническое OKF-дерево.
SpaceGuide при этом полезен не только публичному сайту: в personal/shared Space
он может предлагать следующие темы и revision-bound recommendations в пределах
прав текущего KnowledgeMount.

## Основной сценарий

1. Пользователь создаёт private KnowledgeSpace с уникальным в host namespace
   `space_handle` и display name; в той же транзакции он становится первым
   Owner либо импортирует OKF bundle в новый Space.
2. Owner/Admin добавляет существующих пользователей как Reader или Editor;
   Owner отдельно управляет Admin/Owner memberships.
3. Mind Diary валидирует структуру, сохраняет immutable SpaceRevision и строит
   производный индекс.
4. Space получает canonical URL `/{space_handle}`. Router разрешает handle во
   внутренний `space_id`, проверяет доступ и открывает base либо personalized
   landing текущей разрешённой revision.
5. Каждый пользователь подключает к агенту KnowledgeMount одного Space и
   получает не больше прав своей membership и OAuth scopes. Разрешённый
   Personal Space overlay остаётся server-side presentation context, а не
   вторым corpus в mount.
6. Агент вызывает `search`, затем `fetch` или читает OKF resource по URI.
7. Editor/Admin/Owner при наличии write scope создаёт draft с ожидаемой
   исходной ревизией.
8. Пользователь проверяет diff; trusted control plane выдаёт короткоживущий
   approval artifact, привязанный к этому draft.
9. Mind Diary повторно проверяет active membership, атомарно продвигает HEAD,
   пишет audit event и переиндексирует
   только новую ревизию.
10. Admin/Owner в любой момент получает детерминированный OKF export и может
   унести базу на другую платформу.

Будущий publication flow отдельно выбирает `published_revision`, строит из неё
KnowledgeSite и привязывает SpaceGuide. Базовая страница берётся из authored
content; разрешённый Personal Space context или заявленный в SpaceSession
audience profile меняет объяснение и подбор следующих материалов. Generated
answer или recommendation становится общим знанием лишь после обычного
draft/review/commit.

## Продуктовые принципы

- **Portable by construction.** Экспорт не является аварийной функцией: OKF —
  основной контракт данных между реализациями.
- **Sources before synthesis.** Raw/source-faithful материал отделён от
  агентной wiki-синтеза; поиск возвращает provenance и канонические URI.
- **Progressive disclosure.** Агент не загружает bundle целиком и может
  переходить от индекса к concept и первоисточнику.
- **Human-addressable by default.** У каждого Space есть стабильный
  `/{space_handle}`; URL name является внешней identity, а внутренний
  `space_id` сохраняет ссылочную и authorization целостность.
- **Personalized with a neutral fallback.** Authenticated opening может сразу
  учитывать Personal Space; базовая версия всегда доступна, anonymous opening
  не использует личный контекст.
- **Safe writes.** Нет last-writer-wins: мутации используют revisions,
  idempotency и optimistic concurrency.
- **Explicit time travel.** Исторический selector разрешается один раз в
  точную immutable revision; такой mount всегда read-only и показывает, какую
  revision он фактически открыл.
- **Private by default.** Identity, tenant isolation и ACL не смешиваются с OKF
  trust metadata.
- **Shared with explicit membership.** Один Space может иметь много Readers,
  Editors, Admins и Owners; параллельные writers не обходят HEAD CAS.
- **Replaceable infrastructure.** Runtime, metadata store, object store,
  search, embeddings и audit имеют отдельные адаптеры.
- **Evidence over magic.** Ответ содержит путь, revision, source pointers,
  trust/freshness signals и честно сообщает ограничения.
- **Adaptive presentation, stable knowledge.** Один corpus допускает разные
  уровни объяснения; персонализация не переписывает canonical revision.

## Границы первой версии

В первую версию входят импорт и экспорт OKF 0.2, browse/search/fetch, проверка
bundle, обязательные host-unique `space_handle` и display name, private shared
Space, designated Personal Space, несколько memberships с четырьмя ролями,
membership audit, last-owner protection, безопасная точечная запись, а также
canonical auth-gated URL, base/personalized landing и read-only история по
revision ID, времени и immutable Checkpoint. Подробные критерии находятся в
[спецификации MVP](specs/mvp.md).

Не входят автоматический web crawler, полнофункциональный редактор документов,
исполнение Attested Computations, сложный совместный merge, billing,
invitations/groups, public или cross-tenant sharing, автономная публикация
синтеза, KnowledgeSite/SpaceGuide и обещание, что любой подключённый агент
автоматически прочитает весь Space.

## Платформенный путь

- **Local vertical slice:** filesystem/object-store adapter, transactional
  metadata в SQLite и простой lexical index.
- **Ранний web-релиз:** admin UI для import/export/validation в OpenAI Sites и
  read-only preview KnowledgeSite для выбранной revision; D1/R2 adapter допустим
  как эксперимент. Adaptive conversation и совместное размещение MCP в Sites —
  отдельные compatibility spikes, а не gate для первого UI-релиза.
- **AWS v1:** тот же application core и MCP adapter в Bedrock AgentCore
  Runtime, S3 для OKF revisions/assets и DynamoDB для HEAD/ACL/revision
  history/checkpoints/jobs.
- **AWS v2:** асинхронный hybrid index через DynamoDB Streams, Lambda,
  embeddings и OpenSearch Serverless после измерения пользы.

## Что будет означать успех

- Одна и та же OKF fixture импортируется локально и в облачном adapter без
  изменения доменной логики.
- Два Editors могут независимо создать drafts; устаревший commit получает
  conflict, а revoked Editor не завершает старый draft.
- Admin управляет Reader/Editor memberships, Owner — Admin/Owner memberships;
  ни одна конкурентная операция не оставляет Space без Owner.
- ChatGPT или другой MCP client находит concept через `search`, получает его
  через `fetch` и показывает рабочую ссылку на канонический resource.
- Rename display name не ломает canonical `/{space_handle}`. Два пользователя
  могут увидеть разную подачу одной target revision из-за разных Personal
  Spaces, но одинаковые факты и provenance; посторонний не узнаёт metadata
  private Space.
- Участник открывает состояние Space на заданное время или по Checkpoint;
  интерфейс показывает resolved revision, а search/fetch не подмешивают HEAD.
- KnowledgeSite показывает только явно опубликованную revision; посетитель
  может переключить уровень объяснения без изменения canonical content.
- Конкурирующая запись с устаревшим `expected_revision` отклоняется и не теряет
  данные.
- Export выбранной ревизии проходит OKF validator и сохраняет неизвестные поля
  и source assets.
- Перенос Sites → AWS требует нового deployment/storage adapter и миграции
  данных, но не переписывания MCP contracts или OKF domain model. Production
  domain сохраняется либо старые canonical URLs получают постоянный redirect.

История не является обходом доступа: на каждый read действует текущая active
membership. Но удаление entry из HEAD само по себе не удаляет его из прежних
committed revisions. UI обязан предупреждать об этом; hard erasure и сроки
retention требуют отдельной privacy/security спецификации.
