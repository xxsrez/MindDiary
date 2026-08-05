# Обзор CloudBrain

Статус: proposal, 2026-08-05.

## Зачем проект существует

CloudBrain должен дать людям и агентам совместный управляемый доступ к
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

## Ментальная модель

CloudBrain — не способ заранее загрузить всю тему в prompt. MCP публикует
описания tools и resources, а клиент и модель выбирают, когда искать и что
читать. Только результаты этих вызовов занимают контекст. Поэтому продукт
должен оптимизировать progressive disclosure: короткий обзор, точный поиск,
цитируемый фрагмент и возможность дочитать канонический concept или source.

Сам Space не является автономным агентом. Каноническое знание остаётся
неизменяемой ревизией, а ответы, рекомендации и порядок подачи — derived
presentation конкретной ревизии для конкретной сессии.

## Основные сущности

- `KnowledgeSpace` — live collaborative container с обязательным именем,
  содержимым, участниками, ролями, настройками и HEAD revision.
- `SpaceRevision` — immutable snapshot содержимого.
- `OKFBundle` — переносимый import/export одной revision без ACL и memberships.
- `KnowledgeEntry`, `Source` и `Asset` остаются разными видами содержимого с
  разными правилами чтения и изменения.
- `SpaceMembership` связывает пользователя со Space и ролью `reader`, `editor`,
  `admin` или `owner`.
- `KnowledgeMount` связывает один MCP connection с одним Space и подмножеством
  разрешённых возможностей.
- `KnowledgeSite` публикует выбранную immutable revision как обычные страницы и
  интерактивную точку входа.
- `SpaceSession` хранит контекст конкретного разговора, включая заявленный
  уровень аудитории; `SpaceGuide` использует его для адаптивных ответов и
  предложений, не изменяя Space.

Точная модель и role matrix описаны в
[доменной спецификации](specs/domain-model.md).

## Продуктовые сценарии

Это не четыре разных `space_type`, а конфигурации одной сущности:

1. **Personal Space.** Один Owner хранит знания по теме или обо всём сразу;
   Space остаётся private.
2. **Shared Space.** Семья или небольшая группа добавляет разные наблюдения и
   получает общую source-aware картину без потери авторства и revision history.
3. **Community Space.** Доверенные Editors совместно собирают знания по игре или
   другой теме в wiki-подобной модели. Moderation, reputation и review queues
   появятся только при реальной необходимости.
4. **Knowledge site.** Владелец публикует выбранную ревизию как статическую
   основу сайта. Посетитель может читать её, начать разговор, сообщить свой
   уровень — например, «я профессиональный историк» — и получить более глубокую
   подачу на основе того же corpus.

Space может пройти этот путь постепенно: personal → shared → community →
published, не меняя `space_id` и не мигрируя каноническое OKF-дерево.
SpaceGuide при этом полезен не только публичному сайту: в personal/shared Space
он может предлагать следующие темы и revision-bound recommendations в пределах
прав текущего KnowledgeMount.

## Основной сценарий

1. Пользователь создаёт именованный private KnowledgeSpace и в той же транзакции
   становится его первым Owner либо импортирует OKF bundle в новый Space.
2. Owner/Admin добавляет существующих пользователей как Reader или Editor;
   Owner отдельно управляет Admin/Owner memberships.
3. CloudBrain валидирует структуру, сохраняет immutable SpaceRevision и строит
   производный индекс.
4. Каждый пользователь подключает к агенту KnowledgeMount одного Space и
   получает не больше прав своей membership и OAuth scopes.
5. Агент вызывает `search`, затем `fetch` или читает OKF resource по URI.
6. Editor/Admin/Owner при наличии write scope создаёт draft с ожидаемой
   исходной ревизией.
7. Пользователь проверяет diff; trusted control plane выдаёт короткоживущий
   approval artifact, привязанный к этому draft.
8. CloudBrain повторно проверяет active membership, атомарно продвигает HEAD,
   пишет audit event и переиндексирует
   только новую ревизию.
9. Admin/Owner в любой момент получает детерминированный OKF export и может
   унести базу на другую платформу.

Будущий publication flow отдельно выбирает `published_revision`, строит из неё
KnowledgeSite и привязывает SpaceGuide. Начальная страница берётся из authored
content; заявленный посетителем audience profile меняет объяснение и подбор
следующих материалов только внутри его SpaceSession. Generated answer или
recommendation становится общим знанием лишь после обычного draft/review/commit.

## Продуктовые принципы

- **Portable by construction.** Экспорт не является аварийной функцией: OKF —
  основной контракт данных между реализациями.
- **Sources before synthesis.** Raw/source-faithful материал отделён от
  агентной wiki-синтеза; поиск возвращает provenance и канонические URI.
- **Progressive disclosure.** Агент не загружает bundle целиком и может
  переходить от индекса к concept и первоисточнику.
- **Safe writes.** Нет last-writer-wins: мутации используют revisions,
  idempotency и optimistic concurrency.
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
bundle, обязательное tenant-unique имя, private shared Space, несколько
memberships с четырьмя ролями,
membership audit, last-owner protection и безопасная точечная запись. Подробные
критерии находятся в [спецификации MVP](specs/mvp.md).

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
  Runtime, S3 для OKF revisions/assets и DynamoDB для HEAD/ACL/jobs.
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
- KnowledgeSite показывает только явно опубликованную revision; посетитель
  может переключить уровень объяснения без изменения canonical content.
- Конкурирующая запись с устаревшим `expected_revision` отклоняется и не теряет
  данные.
- Export выбранной ревизии проходит OKF validator и сохраняет неизвестные поля
  и source assets.
- Перенос Sites → AWS требует нового deployment/storage adapter и миграции
  данных, но не переписывания MCP contracts или OKF domain model.
