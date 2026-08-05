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
MVP в OpenAI Sites. AWS/AgentCore остаётся post-MVP направлением, а не текущей
release surface.

Сейчас репозиторий содержит проверенный design bootstrap. Исполняемый MCP
server, UI и облачная инфраструктура ещё не реализованы.

Важная оговорка: подключённая MCP-база не находится целиком в контексте модели.
Она виртуально доступна через поиск и точечное чтение, а в контекст попадают
только выбранные результаты.

## Документация

- [Карта документации](docs/README.md)
- [Базовая айдентика](docs/brand.md)
- [Обзор продукта](docs/overview.md)
- [Предлагаемая архитектура](docs/architecture.md)
- [Доменная модель и доступ](docs/specs/domain-model.md)
- [URL-адресация и персонализированное открытие](docs/specs/personalized-opening.md)
- [Спецификация первого прототипа](docs/specs/mvp.md)
- [Проверка актуальности OKF](docs/reports/2026-08-05-okf-status.md)
- [Проверка платформенных предпосылок](docs/reports/2026-08-05-platform-status.md)

## Статус

Базовый фичасет первого прототипа зафиксирован в ADR и спецификациях. Следующий
этап — определить точные API schemas и реализовать local vertical slice:
authenticated account bootstrap, `/me`, roles/visibility, user-scoped
Streamable HTTP MCP с custom Mind-aware tools, atomic content commits, history и
deterministic OKF 0.2 export, после чего весь обязательный slice должен пройти
production gate в Sites. ZIP import и binary Asset transport в этот scope не
входят. До реализации в репозитории нет команды запуска, которую можно честно
назвать рабочей.
