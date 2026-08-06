# Документация Mind Diary

Mind Diary пока находится на стадии проектирования. Документы ниже разделяют
проверенные внешние факты, предлагаемый дизайн и ещё не реализованное поведение.

## Начать отсюда

1. [Обзор продукта](overview.md) — зачем нужен Mind Diary, какую проблему он
   решает, как Mind становится адресуемой knowledge surface и где проходят
   границы продукта.
2. [Roadmap и стратегия проверки](roadmap.md) — Codex-first initial audience,
   Sites-only MVP, планируемые imports/checkpoints, будущий website AI и
   основная post-MVP AWS direction.
3. [Базовая айдентика](brand.md) — `Mind Diary → Mind → Memory`, знак, палитра,
   типографика, голос и canonical assets.
4. [Архитектура](architecture.md) — переносимое ядро, ревизии OKF, MCP surface,
   Sites-only MVP production и post-MVP AWS path.
5. [Доменная модель и доступ](specs/domain-model.md) — KnowledgeSpace,
   содержимое, memberships, роли и owner invariants.
6. [URL-адресация и персонализированное открытие](specs/personalized-opening.md)
   — принятые URL/Personal Mind invariants и отложенный proposal bounded
   personalization.
7. [Спецификация первого прототипа](specs/mvp.md) — первый проверяемый vertical
   slice и его критерии готовности.
8. [REST и MCP API](specs/api.md) — предлагаемый wire-level contract control
   REST, internal application API, MCP tools/resources, schemas и errors.
9. [Границы реализации](specs/implementation-boundaries.md) — trusted
   `ActorContext`, application ports/façades, transaction boundaries и
   enforceable dependency rules для будущего runtime.
10. [Traceability matrix MVP 0.1](specs/traceability.md) — критерии 1–29,
   owning stories, executable/release evidence, обязательные live flows,
   post-MVP denylist и implementation decisions.

## Руководства

- [Локальная разработка и проверки](guides/development.md) — pinned toolchain,
  clean-checkout path, canonical commands, package graph, fixtures, CI и
  границы доказанного baseline.

## Принятые решения

- [ADR-0001: название продукта и пользовательская лексика](decisions/0001-product-name-and-language.md)
  — принято `Mind Diary → Mind → Memory`; техническая доменная лексика
  сохраняется.
- [ADR-0002: account, доступ и lifecycle Minds](decisions/0002-account-access-and-lifecycle.md)
  — принят автоматический Personal Mind, single Owner, invitations и три
  authenticated visibility modes.
- [ADR-0003: user-scoped MCP и immediate commits](decisions/0003-user-scoped-mcp-and-direct-commits.md)
  — принят один MCP на пользователя, personal bearer token и atomic write без
  отдельного draft/approval.
- [ADR-0004: OpenAI Sites как production target MVP](decisions/0004-sites-only-mvp-production.md)
  — production release означает весь обязательный vertical slice на одном
  Site; AWS и отдельный MCP runtime отложены.
- [ADR-0005: secret и verifier личного MCP token](decisions/0005-mcp-token-secret-verifier.md)
  — принят fixed-size opaque secret, keyed HMAC-SHA-256 exact lookup,
  consume-once issuance и 90-day maximum expiry.

## Исследования

- [Состояние OKF на 2026-08-05](reports/2026-08-05-okf-status.md) — сверка
  официальной спецификации с зафиксированным OKF 0.2 snapshot.
- [Рыночная оценка Mind Diary на 2026-08-05](reports/2026-08-05-market-assessment.md)
  — самостоятельный decision memo о спросе, конкурентах, рисках и validation
  gates для Codex-first pilot.
- [Состояние платформенных предпосылок на 2026-08-05](reports/2026-08-05-platform-status.md)
  — актуальные MCP, OpenAI Sites/Plugins и AWS AgentCore факты, на которых
  основан proposal.

## Статусы документов

- `report` фиксирует наблюдения на указанную дату и не обещает реализацию.
- `proposal` описывает рекомендуемое направление, которое ещё можно менять.
- `baseline` фиксирует рабочую основу для прототипов, но не окончательный
  production-стандарт.
- `accepted` используется в ADR для явно принятого решения; значимые изменения
  такого решения фиксируются новым или superseding ADR.

## Полнота design bootstrap

High-level контур проекта закрыт следующими документами:

- продуктовая идея, сценарии, URL/landing и платформенный путь — в overview;
- последовательность Codex-first validation → AWS → website AI и статус
  post-MVP функций — в roadmap;
- базовая визуальная и речевая система — в brand guide;
- сущности, account bootstrap, адресация, роли, visibility и история — в domain
  model;
- URL-адресация и граница будущего ограниченного Personal Mind overlay — в
  personalized-opening specification;
- границы компонентов, основные flows, MCP/web surfaces, Sites production и
  post-MVP AWS path — в architecture;
- authorization, non-enumeration private URLs, untrusted content и безопасные
  mutation boundaries — совместно в domain model, architecture и спецификации
  первого прототипа;
- проверяемый первый vertical slice и non-goals — в спецификации первого
  прототипа;
- REST routes, общие schemas, MCP tools/resources и error contracts — в API
  specification;
- trusted actor, ports, application façades, transaction boundaries и
  dependency rules — в specification границ реализации;
- критерии 1–29, их owning stories и обязательный release evidence — в
  traceability matrix;
- актуальность внешнего формата данных — в датированном OKF report;
- конкурентная среда, уточнённый ICP, риски и validation gates — в датированном
  market assessment;
- текущие платформенные предпосылки и их ограничения — в датированном platform
  report.

Machine-readable OpenAPI/JSON Schemas, отдельный threat model, production
runbooks, deployment guide и changelog пока не созданы: сервисного кода,
release и развёртывания нет. До anonymous publication потребуется новая
спецификация и отдельный threat model.
