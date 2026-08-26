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
10. [Connections, Advanced MCP и Codex Help](specs/connection-experience.md) —
   принятые ordinary/advanced routes, opaque `connection_ref`, bounded
   projections, write step-up states и browser acceptance.
11. [Mind bindings](specs/mind-bindings.md) — принятый contract множества
   read bindings, единственного versioned writable target, CAS/lifecycle,
   MCP tools, compatibility и automatic-capture boundary.
12. [Границы реализации](specs/implementation-boundaries.md) — trusted
   `ActorContext`, application ports/façades, transaction boundaries и
   enforceable dependency rules для будущего runtime.
13. [Automatic knowledge capture](specs/automatic-capture.md) — принятый
   default-off routine capture profile, exact write-generation pinning,
   provenance, disclosure, deduplication и confirmation boundary.
14. [Traceability matrix MVP 0.1](specs/traceability.md) — критерии 1–29,
   owning stories, executable/release evidence, обязательные live flows,
   post-MVP denylist и implementation decisions.
15. [BundleFile](specs/bundle-files.md) — принятый Release 0.2 producer-defined
   format-neutral contract: explicit manifest v4, arbitrary opaque files,
   256 MiB streaming, safe-raster preview, download-only containment, mixed
   atomic commits и отдельный deterministic export profile.
16. [Единый file-ingress contract](specs/file-ingress.md) — принятый portable
   boundary, обязательный Release 0.2 readable-path profile через packaged
   local companion и отложенная Release 0.3 matrix direct/provider, connector
   и generated sources; implementation, installed-client и per-path evidence
   разделены.
17. [Sites storage, capacity и Markdown import](specs/sites-storage-capacity-import.md)
   — принятый post-MVP Brain-scale contract: Space-scoped content addressing, v3 delta
   manifests, reconstructable accounting/reservations, bounded Markdown import,
   streaming export/GC и migration/rollback boundary.
18. [Операторский каталог principals и последняя активность](specs/service-operator-directory.md)
   — принятый read-only UAT contract отдельной service-operator authority,
   success-only web/MCP summary, privacy-minimized directory и deletion.
19. [Автономная доставка work scope](specs/ship-work-release.md) — универсальный
   принятый контракт `ship-work-release`: task-manager adapters, один mutable
   writer по умолчанию, selective lanes и scouts, cohorts, control API,
   dev/UAT promotion и ручная production boundary.
20. [Контракт project profile](specs/ship-work-release-project-profile.md) —
   versioned provider-neutral schema обязательных project-specific commands,
   runtime capabilities, gates, environments и evidence rows.
21. [Контракт task-management adapter](specs/ship-work-release-task-manager.md) —
   versioned provider-neutral schema identity, snapshots, mutations,
   reconciliation и capability negotiation task-management backend-а.
22. [Task Manager adapter Mind Diary](specs/ship-work-release-task-manager-srez.md) —
    текущая привязка к Project `Mind Diary`, Release `0.1`, exact Task Manager
    refs, bounded reads, versioned task writes и designated scope projection
    anchor.
23. [Исторический Linear adapter](specs/ship-work-release-linear.md) —
    прежнее отображение Linear entities; не является текущим provider, profile
    или source of truth.

## Руководства

- [Локальная разработка и проверки](guides/development.md) — pinned toolchain,
  clean-checkout path, canonical commands, package graph, fixtures, CI и
  границы доказанного baseline.

## Операции

- [Runbook `ship-work-release`](operations/ship-work-release.md) —
  универсальный UX в Codex Desktop: status, «дойти до точки с запятой»,
  batch/UAT pause, resume, cohort upgrade, task-manager projection, recovery и
  отдельная manual production boundary.
- [Профиль доставки Mind Diary](operations/ship-work-release-profile.md) —
  project-specific commands, integration branch, CI, dev launcher, UAT
  URL/evidence и production configuration.
- [Task Manager runtime reference](operations/ship-work-release-task-manager-srez.md) —
  exact connector preflight, pagination, versioned status/comments,
  designated-anchor projection и reconcile-before-retry для Mind Diary.
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
- [Protocol assisted UAT pilot и feedback loop](operations/uat-pilot-protocol.md)
  — последовательные assisted/external cohorts, один feedback channel,
  privacy-safe metrics, cadence, feedback template, decision review и
  offboarding без private corpus.

## Активные планы

- [План восстановления MVP 0.1](tasks/2026-08-24-mvp-recovery-plan/README.md)
  — current state 40 незавершённых Tasks, интерактивная
  [визуальная карта системы и перехода](tasks/2026-08-24-mvp-recovery-plan/system-transition-presentation.html),
  целевая информационная архитектура Connections / Advanced MCP / Codex Help,
  release-scope reset, подробный переходный план и целевая модель Task Manager.
- [План обновления runtime-регистрации Mind Diary plugin](tasks/2026-08-22-mind-diary-plugin-runtime-refresh.md)
  — диагноз legacy registered connector, опыт Task Manager, безопасный
  remove/add lifecycle, fresh-runtime acceptance и recovery без изменения
  данных Minds.
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
  lazy-loaded adapter references; текущая Mind Diary mapping описана отдельно,
  а Linear reference оставлен только для истории.
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
  исторически приняты post-MVP unified manifest v2, adapter-only native file
  transport, bounded quarantined staging и отдельный `MD-BUNDLE-ZIP-1` без
  изменения OKF 0.2; closed media/64 MiB часть superseded ADR-0021.
- [ADR-0016: Sites storage, capacity и Markdown import](decisions/0016-sites-storage-capacity-import.md)
  — приняты post-MVP Space-scoped R2 objects/manifests, D1 HEAD/ledger/reservations,
  delta commits, bounded Markdown import и v3-aware rollback floor.
- [ADR-0017: read-only service-operator directory](decisions/0017-service-operator-directory.md)
  — приняты отдельная constructor-only operator allowlist, compact success-only
  web/MCP activity summary, privacy-minimized read model и deletion boundary.
- [ADR-0018: единый file-ingress contract](decisions/0018-file-ingress-contract-and-source-capability-matrix.md)
  — приняты portable staged-ref boundary, шесть source kinds, explicit
  capability negotiation, atomic multi-ref semantics и запрет silent fallback;
  implementation остаётся source-specific; terminal 0.1 scope заменён ADR-0019,
  closed BundleFile static policy — ADR-0021.
- [ADR-0019: Release 0.1 — Codex-first Markdown и small-data boundary](decisions/0019-release-0-1-codex-first-small-data-boundary.md)
  — terminal 0.1 возвращён к Markdown/OKF 0.2 first-user workflow;
  BundleFile, Brain-scale/import и universal ingress сохранены как post-MVP.
- [ADR-0020: Connections IA и безопасные presentation projections](decisions/0020-connections-ia-and-safe-projections.md)
  — ordinary Connections отделены от Advanced MCP, принят actor-owned opaque
  `connection_ref`, bounded page projection и запрет silent write widening.
- [ADR-0021: format-neutral BundleFile и безопасное serving](decisions/0021-format-neutral-bundle-files.md)
  — closed MIME admission заменён arbitrary opaque storage, manifest v4,
  header-safe `application/octet-stream` fallback, exact 256 MiB streaming и
  safe-raster-only inline policy без изменения OKF 0.2.

## Исследования

- [Reconciliation baseline Release 0.1 на 2026-08-24](reports/2026-08-24-release-0-1-integration-baseline.md)
  — fresh divergence, disposition всех 21 engineering commits, conflict-aware
  P0 replay и отдельный preservation ref для post-MVP lineage.
- [Поддержка Brain-масштаба: storage и capacity proposal на 2026-08-22](reports/2026-08-22-brain-scale-storage-and-capacity-proposal.md)
  — live Sites/task evidence, профиль текущего Brain, узкие места revision,
  search/import/export и поэтапный план для одного и нескольких крупных Minds.
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
- [Disk-first ingress: capability layers на 2026-08-26](reports/2026-08-26-disk-first-ingress-capability-layers.md)
  — текущая Release 0.2 граница между hosted server adapters, installed Codex
  companion inventory и admission конкретного local/workspace path.
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
