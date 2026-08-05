# Обзор CloudBrain

Статус: proposal, 2026-08-05.

## Зачем проект существует

CloudBrain должен дать агенту управляемый доступ к базе знаний по выбранной
теме: обнаружить её структуру, найти релевантные concepts, проверить источники,
добавить новый материал, зафиксировать новую ревизию и экспортировать данные в
переносимом виде.

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

## Основной сценарий

1. Пользователь создаёт приватную базу или импортирует существующий OKF bundle.
2. CloudBrain валидирует структуру, сохраняет immutable revision и строит
   производный индекс.
3. Пользователь подключает к агенту knowledge mount одной конкретной базы и
   получает права только на неё, а не глобальный доступ ко всему аккаунту.
4. Агент вызывает `search`, затем `fetch` или читает OKF resource по URI.
5. При наличии write scope агент создаёт draft с ожидаемой исходной ревизией.
6. Пользователь проверяет diff; trusted control plane выдаёт короткоживущий
   approval artifact, привязанный к этому draft.
7. CloudBrain атомарно продвигает HEAD, пишет audit event и переиндексирует
   только новую ревизию.
8. Пользователь в любой момент получает детерминированный OKF export и может
   унести базу на другую платформу.

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
- **Replaceable infrastructure.** Runtime, metadata store, object store,
  search, embeddings и audit имеют отдельные адаптеры.
- **Evidence over magic.** Ответ содержит путь, revision, source pointers,
  trust/freshness signals и честно сообщает ограничения.

## Границы первой версии

В первую версию входят импорт и экспорт OKF 0.2, browse/search/fetch, проверка
bundle, приватный knowledge mount и безопасная точечная запись. Подробные
критерии находятся в [спецификации MVP](specs/mvp.md).

Не входят автоматический web crawler, полнофункциональный редактор документов,
исполнение Attested Computations, сложный совместный merge, billing,
cross-tenant sharing, автономная публикация синтеза и обещание, что любой
подключённый агент автоматически прочитает всю базу.

## Платформенный путь

- **Local vertical slice:** filesystem/object-store adapter, transactional
  metadata в SQLite и простой lexical index.
- **Ранний web-релиз:** admin UI для import/export/validation в OpenAI Sites;
  D1/R2 adapter допустим как эксперимент. Совместное размещение MCP в Sites —
  отдельный compatibility spike, а не gate для первого UI-релиза.
- **AWS v1:** тот же application core и MCP adapter в Bedrock AgentCore
  Runtime, S3 для OKF revisions/assets и DynamoDB для HEAD/ACL/jobs.
- **AWS v2:** асинхронный hybrid index через DynamoDB Streams, Lambda,
  embeddings и OpenSearch Serverless после измерения пользы.

## Что будет означать успех

- Одна и та же OKF fixture импортируется локально и в облачном adapter без
  изменения доменной логики.
- ChatGPT или другой MCP client находит concept через `search`, получает его
  через `fetch` и показывает рабочую ссылку на канонический resource.
- Конкурирующая запись с устаревшим `expected_revision` отклоняется и не теряет
  данные.
- Export выбранной ревизии проходит OKF validator и сохраняет неизвестные поля
  и source assets.
- Перенос Sites → AWS требует нового deployment/storage adapter и миграции
  данных, но не переписывания MCP contracts или OKF domain model.
