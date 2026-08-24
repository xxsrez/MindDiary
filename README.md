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
Практическая цель проекта — пройти путь от local vertical slice через prod-like
UAT в OpenAI Sites до отдельно управляемого production. При подтверждённой
пользовательской ценности основной
post-MVP infrastructure direction — AWS/AgentCore; это также самостоятельная
учебная цель проекта, но не текущая release surface.

Сейчас Mind Diary развёрнут single-principal в UAT OpenAI Sites по адресу
<https://mind-diary.example.invalid>. Репозиторий содержит отдельное
приложение `apps/mind-diary-site`, authenticated web/control
routes, современный Streamable HTTP `POST /api/mcp`, изолированный Codex
compatibility endpoint `POST /api/mcp/2025-11-25`, D1/R2 adapters и Worker
background handlers. Перенос с `/mcp` необходим, потому что exact path
перехватывается Sites до product Worker. Локальные build, contract/integration
checks дополнены UAT smoke: persisted authenticated web/control UI,
raw modern discovery/list и реальный `codex-cli 0.147.0` прошли на обоих
profiles — default compatibility и opt-in `mcp_2026_07_28`. Временный
read-only token после проверки отозван; следующий request получил 401.
История платформенной проблемы и доказательство исправления сохранены в
[capability report](docs/reports/2026-08-07-sites-mcp-capability-gate.md).

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
- [Контракт `ship-work-release`](docs/specs/ship-work-release.md)
- [Контракт project delivery profile](docs/specs/ship-work-release-project-profile.md)
- [Контракт task-management adapter](docs/specs/ship-work-release-task-manager.md)
- [Task Manager adapter доставки](docs/specs/ship-work-release-task-manager-srez.md)
- [Исторический Linear adapter](docs/specs/ship-work-release-linear.md)
- [Операторский runbook](docs/operations/ship-work-release.md)
- [Профиль dev/UAT/production доставки](docs/operations/ship-work-release-profile.md)

## Dev и локальная проверка

Требуется Node.js `>=22.13.0`:

```bash
npm ci
npm run check
```

Команда собирает package graph и запускает unit, integration, contract,
full-bundle OKF, documentation, architecture и secret/config checks. Она не
запускает service и не является Sites deployment или live MCP conformance.
Перед UAT release exact candidate запускается на `localhost` через
`npm run dev` и проходит declared dev smoke.

## Статус

UAT Product Site соединяет принятые application use cases с
Sites-compatible Vinext/Worker runtime, durable D1/R2 adapters и background
jobs. Browser surface остаётся control plane и не рендерит raw Markdown;
Bearer endpoints `/api/mcp` и `/api/mcp/2025-11-25` используют одну
request-scoped authorization boundary и не публикуют membership/control tools.
Single-principal Sites audience gate и application Bearer остаются независимыми:
Codex передаёт первый через `env_http_headers`, второй — через
`bearer_token_env_var`. Следующий этап — расширять product workflows и
automation поверх уже проверенного UAT Sites/MCP контура. Production является
отдельной средой для живых пользователей, пока не provisioned и deploy-ится
только вручную после явного запроса и подтверждения. ZIP import,
producer-defined non-Markdown files и named checkpoints остаются вне MVP.
