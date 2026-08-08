# Документация Mind Diary

Mind Diary имеет локально проверенный deployable source candidate продукта, но
ещё не имеет подтверждённого production deployment. Документы ниже разделяют
проверенные внешние факты, реализованный repository behavior, предлагаемый
дизайн и ещё не подтверждённое live-поведение.

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
11. [Автономная доставка Linear milestone](specs/linear-milestone-delivery.md) —
   нормативный контракт `ship-linear-release`: worker modes, session ownership,
   dirty checkout, guards, cutoffs, production gates и blocker policy.

## Руководства

- [Локальная разработка и проверки](guides/development.md) — pinned toolchain,
  clean-checkout path, canonical commands, package graph, fixtures, CI и
  границы доказанного baseline.

## Операции

- [Runbook `ship-linear-release`](operations/ship-linear-release.md) — запуск с
  одним, exact N или auto workers, параллельные сессии, status, recovery,
  defect routing и понятная остановка на настоящем blocker.

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
- [ADR-0006: автономная доставка Linear milestone без профилей](decisions/0006-linear-milestone-delivery.md)
  — принят единый acceptance-driven conveyor, exact/auto workers, один
  repo-global coordinator и отказ от `design | build | release` profiles.

## Исследования

- [Состояние OKF на 2026-08-05](reports/2026-08-05-okf-status.md) — сверка
  официальной спецификации с зафиксированным OKF 0.2 snapshot.
- [Рыночная оценка Mind Diary на 2026-08-05](reports/2026-08-05-market-assessment.md)
  — самостоятельный decision memo о спросе, конкурентах, рисках и validation
  gates для Codex-first pilot.
- [Состояние платформенных предпосылок на 2026-08-05](reports/2026-08-05-platform-status.md)
  — актуальные MCP, OpenAI Sites/Plugins и AWS AgentCore факты, на которых
  основан proposal.
- [OpenAI Sites + MCP capability gate на 2026-08-07](reports/2026-08-07-sites-mcp-capability-gate.md)
  — исторический pre-Worker отказ exact `/mcp`, доказательство Sites dispatcher
  reservation, исключённые гипотезы, direct resolution candidate и repeatable
  redacted live procedure.
- [Security, privacy и threat regression на 2026-08-07](reports/2026-08-07-security-privacy-regression.md)
  — локальная fail-closed suite для identity, Origin/CSRF, token/ACL/locator
  boundaries, safe rendering и privacy-redacted evidence; без live claim.
- [Product Site source candidate на 2026-08-08](reports/2026-08-08-product-site-candidate.md)
  — локально собранное Sites-compatible product application, targeted evidence
  и остающиеся coordinator-owned live release gates.

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
- автономная реализация Linear milestone, worker topology, integration cutoffs,
  session fencing и blocker policy — в milestone delivery specification и
  operations runbook;
- актуальность внешнего формата данных — в датированном OKF report;
- конкурентная среда, уточнённый ICP, риски и validation gates — в датированном
  market assessment;
- текущие платформенные предпосылки и их ограничения — в датированном platform
  report;
- состав и граница доказанного Product Site source candidate — в датированном
  candidate report.

Machine-readable OpenAPI/JSON Schemas, отдельный threat model, product
deployment guide и changelog пока не созданы. Operations runbook описывает
delivery orchestration, но не выдаёт ещё не выполненный release или deployment
за существующий. До anonymous publication потребуется новая спецификация и
отдельный threat model.
