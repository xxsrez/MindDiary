# Mind Diary

![Mind Diary](docs/assets/brand/mind-diary-lockup.svg)

Mind Diary — проект совместных облачных Minds (`KnowledgeSpace`), которые
пользователи и агенты подключают через MCP, читают и пополняют Memories с
сохранением переносимого Open Knowledge Format (OKF). Account автоматически
получает private Personal Mind по `/me`; другие Minds имеют стабильный
`/{space_handle}`, роли и режимы `private`, `unlisted` или `public`. Один
user-scoped MCP даёт агенту доступ ко всем разрешённым Minds, но каждый вызов
явно работает с одним corpus. Изменения сразу создают immutable revision через
optimistic HEAD CAS.
Практическая цель проекта — пройти путь от local vertical slice до production
MVP в OpenAI Sites. При подтверждённой пользовательской ценности основной
post-MVP infrastructure direction — AWS/AgentCore; это также самостоятельная
учебная цель проекта, но не текущая release surface.

Сейчас репозиторий содержит deployable source candidate продукта для OpenAI
Sites: отдельное приложение `apps/mind-diary-site`, authenticated web/control
routes, современный Streamable HTTP `POST /api/mcp`, изолированный Codex
compatibility endpoint `POST /api/mcp/2025-11-25`, D1/R2 adapters и Worker
background handlers. Перенос с `/mcp` необходим, потому что exact path
перехватывается Sites до product Worker. Локальные build, contract/integration
checks и воспроизводимый probe с `codex-cli 0.147.0` подтверждают source
candidate на обоих profiles: default compatibility и opt-in
`mcp_2026_07_28`. Но новая версия не публиковалась: production deployment, live
URL, persistence-after-redeploy и live MCP Inspector ещё не подтверждены.

Важная оговорка: подключённая MCP-база не находится целиком в контексте модели.
Она виртуально доступна через поиск и точечное чтение, а в контекст попадают
только выбранные результаты.

## Документация

- [Карта документации](docs/README.md)
- [Roadmap и стратегия проверки](docs/roadmap.md)
- [Базовая айдентика](docs/brand.md)
- [Обзор продукта](docs/overview.md)
- [Предлагаемая архитектура](docs/architecture.md)
- [Доменная модель и доступ](docs/specs/domain-model.md)
- [URL-адресация и персонализированное открытие](docs/specs/personalized-opening.md)
- [Спецификация первого прототипа](docs/specs/mvp.md)
- [REST и MCP API](docs/specs/api.md)
- [Проверка актуальности OKF](docs/reports/2026-08-05-okf-status.md)
- [Проверка платформенных предпосылок](docs/reports/2026-08-05-platform-status.md)
- [Product Site source candidate](docs/reports/2026-08-08-product-site-candidate.md)
- [Локальная разработка и проверки](docs/guides/development.md)

## Локальная проверка

Требуется Node.js `>=22.13.0`:

```bash
npm ci
npm run check
```

Команда собирает package graph и запускает unit, integration, contract,
full-bundle OKF, documentation, architecture и secret/config checks. Она не
запускает service и не является Sites deployment или live MCP conformance.

## Статус

Product Site source candidate соединяет принятые application use cases с
Sites-compatible Vinext/Worker runtime, durable D1/R2 adapters и background
jobs. Browser surface остаётся control plane и не рендерит raw Markdown;
Bearer endpoints `/api/mcp` и `/api/mcp/2025-11-25` используют одну
request-scoped authorization boundary и не публикуют membership/control tools.
Это source/build/local-client evidence, а не production claim: следующий этап —
sealed full gate exact candidate SHA, Sites publish и live web, persistence,
MCP Inspector и Codex gates. ZIP import, producer-defined non-Markdown files и
named checkpoints остаются вне MVP.
