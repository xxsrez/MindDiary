# Документация Mind Diary

Mind Diary имеет single-principal UAT deployment в OpenAI Sites с проверенными
authenticated web/control и Codex MCP flows. Документы ниже разделяют
проверенные внешние факты, реализованный repository behavior, UAT
evidence, предлагаемый дизайн и ещё не проверенные расширенные workflows.

Целевая product authority Release 0.3 описана прежде всего в
[режимах использования Mind](specs/mind-usage-modes.md),
[обзоре](overview.md#product-authority-после-release-01),
[roadmap](roadmap.md#authority-contract-release-03),
[доменной модели](specs/domain-model.md#content-plane-и-control-plane) и
[архитектуре](architecture.md#целевая-authority-boundary-release-03). Historical
Release 0.1/0.2 API, Connections и Mind bindings, а также ранний
credential-scoped target Release 0.3 сохраняются как historical as-built;
principal-owned replacement принят MD-373 в ADR-0024; Personal description
и двойное тематическое использование приняты ADR-0025 (2026-09-05).
Реализация опубликована в UAT; границы подтверждения и незакрытая приёмка —
в [отчёте Personal description](reports/2026-09-05-personal-description-routing.md).

## Начать отсюда

1. [Обзор продукта](overview.md) — зачем нужен Mind Diary, какую проблему он
   решает, как Mind становится адресуемой knowledge surface и где проходят
   границы продукта.
2. [Roadmap и стратегия проверки](roadmap.md) — Codex-first initial audience,
   Sites-only MVP, планируемые imports/checkpoints, будущий website AI и
   основная post-MVP AWS direction.
3. [Базовая айдентика](brand.md) — `Mind Diary → Mind → Memory`, знак, палитра,
   типографика, голос и canonical assets.
4. [Архитектура](architecture.md) — переносимое ядро, целевое разделение Web
   control plane и Content MCP, ревизии OKF, environments и post-MVP AWS path.
5. [Доменная модель и доступ](specs/domain-model.md) — KnowledgeSpace,
   содержимое, memberships, роли и owner invariants.
6. [URL-адресация и персонализированное открытие](specs/personalized-opening.md)
   — принятые URL/Personal Mind invariants и отложенный proposal bounded
   personalization.
7. [Спецификация первого прототипа](specs/mvp.md) — первый проверяемый vertical
   slice и его критерии готовности.
8. [REST и MCP API](specs/api.md) — historical 0.1/0.2 wire contract и граница
   будущей operation-disposition работы без premature schema migration.
9. [Plugin и OAuth](specs/plugin-connector.md) — historical Release 0.1/0.2
   direct MCP package и OAuth profile плюс Release 0.3 content-only plugin
   authority без Connection/target controls.
10. [Connections, Advanced MCP и Codex Help](specs/connection-experience.md) —
   historical Release 0.1 routes/projections и Release 0.3 Sites-only ownership
   Connections/writable target.
11. [Compact admin IA и design contract](specs/compact-admin-information-architecture.md)
   — измеримые desktop/mobile layouts, density/tokens, route/session states,
   privacy/destructive disclosures и machine-check mapping для MD-347.
12. [Режимы использования Mind и автоматическое сохранение](specs/mind-usage-modes.md)
   — целевой principal-owned `disabled | read | read_write`, единый writable
   ordinary Mind плюс независимый Personal, тематические descriptions и
   explicit-only Personal без description, discussed-only automatic save и fail-closed migration. Прежний
   [credential write target](specs/credential-write-target.md)
   и [Mind bindings](specs/mind-bindings.md) сохранены как historical evidence.
13. [Границы реализации](specs/implementation-boundaries.md) — trusted
   `ActorContext`, application ports/façades, transaction boundaries и
   enforceable dependency rules для будущего runtime.
14. [Automatic knowledge capture](specs/automatic-capture.md) — historical
   default-off capture profile, superseded единым `read_write` intent и
   canonical `commit_changeset` из principal usage contract.
15. [Traceability matrix MVP 0.1](specs/traceability.md) — критерии 1–29,
   owning stories, executable/release evidence, обязательные live flows,
   post-MVP denylist и implementation decisions.
16. [BundleFile](specs/bundle-files.md) — принятый Release 0.2 producer-defined
   format-neutral contract: explicit manifest v4, arbitrary opaque files,
   256 MiB streaming, safe-raster preview, download-only containment, mixed
   atomic commits и Sites-owned import/export boundary Release 0.3.
17. [Единый file-ingress contract](specs/file-ingress.md) — принятый portable
   boundary, обязательный Release 0.2 readable-path profile через packaged
   local companion и отложенная Release 0.3 matrix direct/provider, connector
   и generated sources; implementation, installed-client и per-path evidence
   разделены.
18. [Sites storage, capacity и Markdown import](specs/sites-storage-capacity-import.md)
   — принятый post-MVP Brain-scale contract: Space-scoped content addressing,
   canonical v4 manifests с чтением historical v1/v2/v3, reconstructable
   accounting/reservations, bounded Markdown import, Sites-owned streaming
   export/GC и migration/rollback boundary.
19. [Delta полномочий import/export Release 0.3](specs/release-0.3-import-export-authority-delta.md)
   — проверяемый register переноса export в Sites control plane, сохранения
   существующего web-only Markdown import и compatibility boundary Content MCP.
20. [Operation disposition Release 0.3](specs/release-0.3-operation-disposition.md)
   — закрытый реестр текущих REST, MCP, UI, schema, error и plugin/help
   surfaces с целевым состоянием, владельцами реализации и исполняемыми
   доказательствами различия as-built и target behavior.
21. [Трассируемость требований Release 0.3](specs/release-0.3-traceability.md)
   — closed forward/reverse registry для `MD-329`–`MD-335`: owning Tasks,
   local commands, synthetic fixtures, hosted runner/receipt contracts,
   cleanup/recovery и stable assertion IDs.
22. [Операторский каталог principals и последняя активность](specs/service-operator-directory.md)
   — принятый read-only UAT contract отдельной service-operator authority,
   success-only web/MCP summary, privacy-minimized directory и deletion.
23. [Автономная доставка work scope](specs/ship-work-release.md) — универсальный
   принятый контракт `ship-work-release`: task-manager adapters, один mutable
   writer по умолчанию, selective lanes и scouts, cohorts, control API,
   dev/UAT promotion и ручная production boundary.
24. [Контракт project profile](specs/ship-work-release-project-profile.md) —
   versioned provider-neutral schema обязательных project-specific commands,
   runtime capabilities, gates, environments и evidence rows.
25. [Контракт task-management adapter](specs/ship-work-release-task-manager.md) —
   versioned provider-neutral schema identity, snapshots, mutations,
   reconciliation и capability negotiation task-management backend-а.
26. [Task Manager adapter Mind Diary](specs/ship-work-release-task-manager-srez.md) —
    текущая привязка к Project `Mind Diary`, Release `0.1`, exact Task Manager
    refs, bounded reads, versioned task writes и designated scope projection
    anchor.
27. [Исторический Linear adapter](specs/ship-work-release-linear.md) —
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
- [Access-admin lifecycle UAT Release 0.3](operations/release-0.3-access-admin-uat-runbook.md)
  — exact-candidate local carrier, three-account role/invitation/visibility
  matrix, closed content MCP catalog, privacy-safe cleanup и nonterminal join
  для MD-354.
- [UAT-контракт Google Drive `connector_object`](operations/google-drive-connector-object-uat.md)
  — exact-provider binary/native export matrix, fail-closed race/revoke checks,
  downstream lifecycle, privacy-safe receipt и bounded cleanup для MD-319.
- [Multi-principal UAT probe](operations/uat-multi-principal-runbook.md) —
  informational Sites canary двух отдельных real principals, redeploy
  persistence, immediate revoke, redacted receipt и cleanup.
- [Synthetic multi-principal release gate](operations/synthetic-multi-principal-runbook.md)
  — blocking test-only composition без human credentials, storage seed,
  product login surface или ACL bypass.
- [Synthetic browser Product Site gate](operations/synthetic-browser-gate-runbook.md)
  — blocking local server-bound browser/UI composition, direct API negatives,
  operator boundary и redacted exact-SHA receipt.
- [Browser-проверка компактного admin shell](operations/admin-shell-browser-uat-runbook.md)
  — exact-SHA Playwright/Chromium gate для responsive/accessibility matrix и
  nonterminal byte-level UAT readback join; hosted acceptance требует прямых
  same-run Sites connector и in-app Browser observations.
- [Browser и UAT-проверка Settings / Connections](operations/settings-connections-uat-runbook.md)
  — fresh OAuth/plugin и personal-token target lifecycle, стабильный Codex
  Help, controlled redeploy, privacy/cleanup и nonterminal offline join MD-358.
- [Browser и UAT-проверка import/export exact bytes](operations/import-export-browser-uat-runbook.md)
  — generated Markdown/invalid/opaque fixtures, failure/recovery matrix,
  independent archive byte comparison и fail-closed nonterminal offline join.
- [Generated-source ingress UAT](operations/generated-source-uat-runbook.md) —
  exact-candidate local gate, restricted-UAT bounded/streaming matrix,
  distinct-redeploy read-back и fail-closed offline join для MD-290.
- [ACL reads и singleton write target Release 0.3](operations/release-0.3-authority-target-uat-runbook.md)
  — exact-candidate local gate, readiness-bound three-actor UAT matrix,
  immutable revision read-back, cleanup и fail-closed machine join.
- [Browser-проверка управления Minds](operations/mind-admin-browser-uat-runbook.md)
  — run-owned Playwright journey для ordinary/Personal admin surface,
  exact-candidate local receipt и fail-closed hosted readback contract.
- [Hosted canary операторского каталога](operations/uat-operator-directory-canary.md)
  — three-actor restricted-UAT setup/verify/cleanup/recovery с
  environment-only session references, exact `404` boundary и redacted receipt.
- [Protocol assisted UAT pilot и feedback loop](operations/uat-pilot-protocol.md)
  — последовательные assisted/external cohorts, один feedback channel,
  privacy-safe metrics, cadence, feedback template, decision review и
  offboarding без private corpus.

## Активные планы

- [Автономная UAT-приёмка на тестовых пользователях](tasks/autonomous-uat-acceptance.md)
  — MD-400: отдельная тестовая среда, автоматические сессии, сценарии,
  восстановление и доказательства приёмки без рутинных действий пользователя.
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
  — historical Release 0.1/0.2 binding contract; target semantics superseded
  ADR-0024.
- [ADR-0014: opt-in routine automatic capture](decisions/0014-opt-in-routine-automatic-capture.md)
  — historical per-credential capture policy; target semantics superseded
  ADR-0024.
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
- [ADR-0022: Sites-controlled credential write target](decisions/0022-site-controlled-credential-write-target.md)
  — historical early Release 0.3 credential target; principal-owned target
  semantics superseded ADR-0024.
- [ADR-0023: отдельный MCP Apps профиль для native file ingress](decisions/0023-dedicated-mcp-apps-file-ingress-profile.md)
  — route-specific `/api/mcp/apps`, app-only native stage, static picker UI и
  обязательный внешний hosted receipt без fabricated activation assertion.
- [ADR-0024: пользовательские режимы Mind и автоматическое сохранение](decisions/0024-principal-mind-usage-modes-and-automatic-save.md)
  — приняты principal-owned `disabled | read | read_write`, один writable Mind,
  description routing ordinary Minds, `personal_default` с записью только по
  прямой просьбе и automatic discussed-only OKF save без binding/capture controls.

## Исследования

- [Проверка интерфейса и скорости UAT, 2026-09-05](reports/2026-09-05-ui-performance.md)
  — обход основных экранов, измерения загрузки и диагностика встроенного браузера.

- [Состояние OKF на 2026-08-30](reports/2026-08-30-okf-status.md) — повторный
  аудит отдельного официального repository, exact spec revision/hash,
  timestamp-with-offset delta и permissive-consumer/strict-producer boundary.
- [Статус native file route на 2026-08-28](reports/2026-08-28-native-file-route-implementation-status.md)
  — repository-кандидат MD-315/MD-316 с отдельным `/api/mcp/apps`, безопасным
  picker/context handoff и точным внешним blocker: installed Apps package и
  реальный hosted picker/stage flow ещё не доказаны.
- [Capability host-managed и same-host file transport на 2026-08-27](reports/2026-08-27-host-managed-file-transport-capability-probe.md)
  — live Codex Desktop matrix native provider parameter, host picker и packaged
  companion с closed assertions, exact synthetic hashes и typed unavailable
  профилями без private locators.
- [Reconciliation baseline Release 0.1 на 2026-08-24](reports/2026-08-24-release-0-1-integration-baseline.md)
  — fresh divergence, disposition всех 21 engineering commits, conflict-aware
  P0 replay и отдельный preservation ref для post-MVP lineage.
- [Поддержка Brain-масштаба: storage и capacity proposal на 2026-08-22](reports/2026-08-22-brain-scale-storage-and-capacity-proposal.md)
  — live Sites/task evidence, профиль текущего Brain, узкие места revision,
  search/import/export и поэтапный план для одного и нескольких крупных Minds.
- [Состояние OKF на 2026-08-05](reports/2026-08-05-okf-status.md) — historical
  сверка прежнего `knowledge-catalog` snapshot, superseded аудитом 2026-08-30.
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

- [ADR-0025: описание Personal Mind и тематическое использование двух Minds](decisions/0025-personal-mind-description-routing.md)
- [ADR-0026: отдельная среда автономной приёмки](decisions/0026-autonomous-acceptance-environment.md)
- [План Personal description и маршрутизации](tasks/personal-mind-description-routing.md)
