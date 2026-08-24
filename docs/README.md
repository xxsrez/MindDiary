# Документация Mind Diary

Mind Diary имеет single-principal UAT deployment в OpenAI Sites с проверенными
authenticated web/control и Codex MCP flows. Документы ниже разделяют
проверенные внешние факты, реализованный repository behavior, UAT
evidence, предлагаемый дизайн и ещё не проверенные расширенные workflows.

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
   dev/UAT/production environments и post-MVP AWS path.
5. [Доменная модель и доступ](specs/domain-model.md) — KnowledgeSpace,
   содержимое, memberships, роли и owner invariants.
6. [URL-адресация и персонализированное открытие](specs/personalized-opening.md)
   — принятые URL/Personal Mind invariants и отложенный proposal bounded
   personalization.
7. [Спецификация первого прототипа](specs/mvp.md) — первый проверяемый vertical
   slice и его критерии готовности.
8. [REST и MCP API](specs/api.md) — предлагаемый wire-level contract control
   REST, internal application API, MCP tools/resources, schemas и errors.
9. [Plugin и OAuth](specs/plugin-connector.md) — принятый профиль установки
   Mind Diary из Srez Marketplace: direct MCP package, OAuth 2.1 + PKCE при
   первом использовании, identity binding, UAT pilot и production/public
   границы.
10. [Mind bindings](specs/mind-bindings.md) — принятый contract множества
   read bindings, единственного versioned writable target, CAS/lifecycle,
   MCP tools, compatibility и automatic-capture boundary.
11. [Границы реализации](specs/implementation-boundaries.md) — trusted
   `ActorContext`, application ports/façades, transaction boundaries и
   enforceable dependency rules для будущего runtime.
12. [Automatic knowledge capture](specs/automatic-capture.md) — принятый
   default-off routine capture profile, exact write-generation pinning,
   provenance, disclosure, deduplication и confirmation boundary.
13. [Traceability matrix MVP 0.1](specs/traceability.md) — критерии 1–29,
   owning stories, executable/release evidence, обязательные live flows,
   post-MVP denylist и implementation decisions.
14. [BundleFile](specs/bundle-files.md) — принятый producer-defined contract
   versioned attachments: manifest v2, exact type/limit/staging/download rules,
   mixed atomic commits и отдельный deterministic export profile.
15. [Единый file-ingress contract](specs/file-ingress.md) — принятый portable
   boundary и capability matrix для session attachment, local/workspace,
   connector, bounded in-memory и server-generated sources; implementation
   status каждой source явно отделён от contract.
16. [Sites storage, capacity и Markdown import](specs/sites-storage-capacity-import.md)
   — принятый Brain-scale contract: Space-scoped content addressing, v3 delta
   manifests, reconstructable accounting/reservations, bounded Markdown import,
   streaming export/GC и migration/rollback boundary.
17. [Операторский каталог principals и последняя активность](specs/service-operator-directory.md)
   — принятый read-only UAT contract отдельной service-operator authority,
   success-only web/MCP summary, privacy-minimized directory и deletion.
18. [Автономная доставка work scope](specs/ship-work-release.md) — универсальный
   принятый контракт `ship-work-release`: task-manager adapters, один mutable
   writer по умолчанию, selective lanes и scouts, cohorts, control API,
   dev/UAT promotion и ручная production boundary.
19. [Контракт project profile](specs/ship-work-release-project-profile.md) —
   versioned provider-neutral schema обязательных project-specific commands,
   runtime capabilities, gates, environments и evidence rows.
20. [Контракт task-management adapter](specs/ship-work-release-task-manager.md) —
   versioned provider-neutral schema identity, snapshots, mutations,
   reconciliation и capability negotiation task-management backend-а.
21. [Task Manager adapter Mind Diary](specs/ship-work-release-task-manager-srez.md) —
   current Project/Release mapping, configured runtime identity, bounded
   reads, versioned task writes и designated scope projection anchor.
22. [Retired Linear adapter tombstone](specs/ship-work-release-linear.md) —
   historical provenance прежнего path без executable selector, runtime или
   delivery authority.

## Руководства

- [Локальная разработка и проверки](guides/development.md) — pinned toolchain,
  clean-checkout path, canonical commands, package graph, fixtures, CI и
  границы доказанного baseline.

## Операции

- [Runbook `ship-work-release`](operations/ship-work-release.md) —
  универсальный UX в Codex Desktop: status, «дойти до точки с запятой»,
  batch/UAT pause, resume, cohort upgrade, task-manager projection, recovery и
  отдельная manual production boundary.
- [Task Manager runtime reference](operations/ship-work-release-task-manager-srez.md) —
  exact connector preflight, pagination, versioned status/comments,
  designated-anchor projection и reconcile-before-retry для Mind Diary.
- [Профиль доставки Mind Diary](operations/ship-work-release-profile.md) —
  project-specific commands, integration branch, CI, dev launcher, UAT
  URL/evidence и production configuration.
- [Exact-candidate performance gate](operations/performance-gate.md) —
  machine-verified UAT scale read-back, web/modern/compatibility sampling,
  request-correlated closed telemetry, blocking budgets и private receipt.
- [Privacy-safe операции UAT pilot](operations/uat-pilot-operations.md) —
  participant boundaries, closed-schema telemetry, bounded diagnostics,
  token/audience revoke, exact rollback и fixture export/restore drill.
- [Provider request-log privacy read-back](operations/provider-request-log-readback.md)
  — bounded classification-only проверка exact UAT deployment без сохранения
  raw provider envelope, IP, User-Agent, identity или credential values.
- [Restricted-UAT test account pool](operations/uat-test-account-pool.md) —
  fail-closed logical aliases, owner-authority boundary, redacted inventory,
  exact audience/operator read-back и bounded cleanup/recovery.
- [Multi-principal UAT probe](operations/uat-multi-principal-runbook.md) —
  informational Sites canary двух отдельных real principals, redeploy
  persistence, immediate revoke, redacted receipt и cleanup.
- [Synthetic multi-principal release gate](operations/synthetic-multi-principal-runbook.md)
  — blocking test-only composition без human credentials, storage seed,
  product login surface или ACL bypass.
- [Synthetic browser Product Site gate](operations/synthetic-browser-gate-runbook.md)
  — blocking local server-bound browser/UI composition, direct API negatives,
  operator boundary и redacted exact-SHA receipt.
- [Hosted canary операторского каталога](operations/uat-operator-directory-canary.md)
  — three-actor restricted-UAT setup/verify/cleanup/recovery с
  environment-only session references, exact `404` boundary и redacted receipt.
- [Stateful UAT storage/import/export matrix](operations/uat-storage-matrix.md)
  — exact Brain-scale Markdown fixture, REST multipart checkpoint до redeploy,
  modern/compat MCP и export SHA read-back, recovery и run-owned cleanup.
- [Hosted canary generated producer ingress](operations/uat-generated-producer-canary.md)
  — operator-only restricted-UAT проверка `bounded_in_memory` и
  `server_generated` через distinct redeploy, exact bytes/SHA/history и
  canary-owned cleanup.
- [Protocol assisted UAT pilot и feedback loop](operations/uat-pilot-protocol.md)
  — последовательные assisted/external cohorts, один feedback channel,
  privacy-safe metrics, cadence, feedback template, decision review и
  offboarding без private corpus.

## Активные планы

- [План запуска MVP 0.1 и сверки token estimate](tasks/2026-08-10-mvp-01-pilot-readiness-estimate.md)
  — независимый model estimate, отдельная user hypothesis, planning allocation
  `AND-150`–`AND-161` и protocol измерения фактического расхода следующего
  delivery run.

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
- [ADR-0004: историческое Sites-only решение](decisions/0004-sites-only-mvp-production.md)
  — прежняя production-классификация текущего Site; environment/release
  semantics superseded ADR-0008.
- [ADR-0005: secret и verifier личного MCP token](decisions/0005-mcp-token-secret-verifier.md)
  — принят fixed-size opaque secret, keyed HMAC-SHA-256 exact lookup,
  consume-once issuance и 90-day maximum expiry.
- [ADR-0008: dev, UAT и production](decisions/0008-dev-uat-production-delivery.md)
  — текущий Site принят как UAT, localhost как dev, а production вынесен в
  отдельный manual-only workflow вне `ship-work-release`.
- [ADR-0009: универсальный delivery skill и task-manager adapters](decisions/0009-task-manager-adapters.md)
  — принято имя `ship-work-release`, provider-neutral core и отдельные
  provider adapter/runtime references; amendment 2026-08-24 выбирает current
  Task Manager mapping и supersede-ит Linear runtime для Mind Diary.
- [ADR-0010: OAuth-коннектор и Marketplace pilot](decisions/0010-oauth-marketplace-connector.md)
  — приняты dual personal/OAuth authentication, PKCE/DCR, read-first consent,
  rotating refresh и server-side UAT OAuth boundary; distribution-часть для
  Codex pilot частично заменена ADR-0011.
- [ADR-0011: direct MCP plugin и OAuth при первом использовании](decisions/0011-direct-mcp-plugin-oauth-on-use.md)
  — принят package без private registered app, `AVAILABLE + ON_USE` и future-
  only граница ChatGPT Web/public-directory connector.
- [ADR-0012: SyntheticPrincipal и автоматические release gates](decisions/0012-synthetic-principal-release-gates.md)
  — приняты blocking synthetic multi-principal и OAuth/package automation,
  informational real Sites/Desktop canaries и запрет product test-login
  surface.
- [ADR-0013: multiple-read/single-write Mind bindings](decisions/0013-multiple-read-single-write-mind-bindings.md)
  — binding owner выбран по OAuth grant/personal token, приняты `0..N` read,
  `0..1` write, versioned CAS/rebind и fail-closed migration без implicit `/me`.
- [ADR-0014: opt-in routine automatic capture](decisions/0014-opt-in-routine-automatic-capture.md)
  — принят default-off per-credential policy, pin к exact write generation,
  private/same-target initial profile и additive-only capture tool.
- [ADR-0015: versioned BundleFile](decisions/0015-versioned-bundle-files.md) —
  приняты unified manifest v2, adapter-only native file transport, bounded
  quarantined staging и отдельный `MD-BUNDLE-ZIP-1` без изменения OKF 0.2.
- [ADR-0016: Sites storage, capacity и Markdown import](decisions/0016-sites-storage-capacity-import.md)
  — приняты Space-scoped R2 objects/manifests, D1 HEAD/ledger/reservations,
  delta commits, bounded Markdown import и v3-aware rollback floor.
- [ADR-0017: read-only service-operator directory](decisions/0017-service-operator-directory.md)
  — приняты отдельная constructor-only operator allowlist, compact success-only
  web/MCP activity summary, privacy-minimized read model и deletion boundary.
- [ADR-0018: единый file-ingress contract](decisions/0018-file-ingress-contract-and-source-capability-matrix.md)
  — приняты portable staged-ref boundary, шесть source kinds, explicit
  capability negotiation, atomic multi-ref semantics и запрет silent fallback;
  implementation остаётся source-specific.

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
  reservation, исключённые гипотезы, исправление и положительное evidence
  среды, которая теперь классифицируется как UAT.
- [Security, privacy и threat regression на 2026-08-07](reports/2026-08-07-security-privacy-regression.md)
  — локальная fail-closed suite для identity, Origin/CSRF, token/ACL/locator
  boundaries, safe rendering и privacy-redacted evidence; без live claim.
- [Universal file ingress matrix на 2026-08-23](reports/2026-08-23-universal-file-ingress-matrix.md)
  — повторяемый `pass/fail/not-available` report по source, atomicity,
  authorization, privacy, modern/compat conformance и текущей hosted Codex
  capability boundary.
- [Product Site source candidate на 2026-08-08](reports/2026-08-08-product-site-candidate.md)
  — исторический repository candidate, впоследствии интегрированный в
  deployment, который теперь классифицируется как UAT.

## Статусы и проверяемые claims

Тип документа (`specification`, `ADR`, `guide`, `runbook`, `report`) описывает
его назначение, но не заменяет lifecycle status. В частности, `report` — это
датированный тип evidence-документа, а не нормативный статус. Для документов,
которые одновременно описывают требования, реализацию и результаты проверок,
используются три независимые оси: `normative_status`,
`implementation_status` и датированные записи `evidence[]`.
Если один файл охватывает несколько независимо меняющихся surfaces, статусы
указываются для конкретного раздела или claim, а не сворачиваются в один
оптимистичный статус всего документа.

### Нормативный статус

- `proposal` — рекомендуемая модель, которая ещё не является обязательным
  контрактом;
- `baseline` — выбранная рабочая основа для прототипирования и совместимости;
  она нормативна в заявленном scope, но допускает пересмотр без утверждения,
  что это окончательный production-стандарт;
- `accepted` — действующий нормативный контракт или принятое решение; его
  значимые изменения требуют явного нового решения либо superseding ADR;
- `superseded` — оставленный в активном дереве исторический документ, который
  больше не является источником текущих требований. Он сохраняет rationale и
  evidence своего периода и обязан ссылаться на заменивший его документ;
- `not_applicable` — документ не устанавливает требований, например
  датированный report с одними наблюдениями.

Нормативный статус ничего не утверждает о наличии кода, deployment или live
verification. Устаревший документ не требуется сохранять в активном дереве
только ради статуса `superseded`: если его rationale не нужен для текущей
навигации, достаточным архивом остаётся Git history.

### Статус реализации

- `not_started` — требование ещё не реализовано;
- `partial` — реализована только явно перечисленная часть заявленного scope;
- `implemented` — заявленный scope присутствует в exact repository artifact и
  прошёл указанные repository checks;
- `unknown` — текущая реализация не проверялась либо доступных данных
  недостаточно;
- `not_applicable` — документ не задаёт реализуемого поведения.

Implementation claim всегда указывает свой scope и artifact или Git SHA.
Нельзя выводить `implemented` только из `accepted`, из статуса task manager или
из наличия deployment.

### Evidence и время наблюдения

Каждый внешний, CI, deployment или live claim указывает:

- что именно проверено и каким probe;
- environment/target и exact artifact или Git SHA;
- результат и ссылку на redacted evidence;
- `observed_at` в UTC.

Evidence подтверждает только перечисленную surface в момент `observed_at`:
local check не доказывает CI, CI не доказывает deployment, а deployment без
live probe не доказывает работоспособность. Более позднее evidence не
переписывает датированный report задним числом; current-документ ссылается на
новое наблюдение отдельно.

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
- границы компонентов, основные flows, MCP/web surfaces, dev/UAT/production и
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
- автономная реализация work scope, project profile, task-manager adapter
  contract, worker topology, integration cutoffs, session fencing и blocker
  policy — в delivery specification, supporting contracts, provider adapter и
  operations runbook;
- актуальность внешнего формата данных — в датированном OKF report;
- конкурентная среда, уточнённый ICP, риски и validation gates — в датированном
  market assessment;
- текущие платформенные предпосылки и их ограничения — в датированном platform
  report;
- состав и граница доказанного Product Site source candidate — в датированном
  candidate report.

Machine-readable OpenAPI/JSON Schemas, отдельный threat model, production
deployment guide и changelog пока не созданы. Текущий UAT deployment и redacted
live evidence зафиксированы в capability report; operations runbook описывает
delivery contract. До anonymous publication потребуется новая
спецификация и отдельный threat model.
