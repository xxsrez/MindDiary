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

Сейчас репозиторий содержит реализованные локальные domain/application
capabilities первого vertical slice, in-memory adapters, web control-plane UI
modules, MCP transport/tools/resources, deterministic OKF export, fixtures и
automated checks. Это ещё не deployable production Site: durable Sites
persistence/composition, production binding и live web/MCP evidence не
подтверждены.

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

Базовый фичасет первого прототипа зафиксирован в ADR и спецификациях; подробный
REST/MCP contract остаётся proposal для проверки на production platform.
Локальная реализация уже покрывает account bootstrap, `/me`, roles/visibility,
custom Mind-aware MCP transport и tools, atomic content commits, history,
search, validation и deterministic OKF 0.2 export автоматизированными unit,
integration, conformance, security и failure-injection tests. Следующий этап —
собрать deployable product Site с durable platform adapters и пройти на одном
exact SHA live Sites, MCP Inspector и Codex gates. ZIP import и transport
producer-defined non-Markdown files в этот scope не входят, но imports и named
checkpoints явно планируются post-MVP; support non-Markdown files/assets
остаётся отдельным открытым решением. Команды build/check подтверждают только
локальное evidence; команды запуска production service и подтверждённого live
deployment пока нет.
