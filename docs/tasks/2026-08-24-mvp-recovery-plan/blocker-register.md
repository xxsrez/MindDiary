# Реестр блокеров MVP 0.1

Статус документа: текущая planning projection; live status и relations
принадлежат Task Manager.

Срез: 2026-08-24 после критического прогона и исправления плана.

## Правило классификации

План больше не использует слово «блокер» для любой незавершённой работы.

- **Внутренний gate** — результат, который команда может получить кодом,
  документацией, тестами, Task Manager mutation или UAT release. Он обязан
  иметь owning Task, native dependency и observable acceptance; его нельзя
  перекладывать на пользователя.
- **Внешний blocker** — подтверждённая неудача после самостоятельной попытки,
  которую нельзя устранить кодом, test fixtures, connector refresh,
  deploy/reconcile или доступными test principals. Он обязан назвать одного
  actor, одно минимальное действие и success signal.
- **Non-blocking scope** — полезная работа за границей MVP. Её failure или
  отсутствие evidence не влияет на terminal status Release 0.1.

На момент среза подтверждённых активных внешних blockers нет.

## Исполнимый P0 graph

```text
MD-292 normative small-data MVP boundary
  ├─ blocks MD-301 single integration baseline
  └─ blocks MD-294 IA/security contract

MD-301 + MD-294
  ├─ block MD-295 routes and bounded projections
  ├─ block MD-296 read-first/write-step-up access UX
  ├─ block MD-297 server-side credential pagination
  ├─ block MD-298 three-step onboarding
  └─ block MD-300 real-browser gate

MD-295 + MD-296 + MD-297 + MD-298 + MD-300
  └─ block MD-299 exact connection-flow UAT

MD-244 + MD-252 + MD-258 + MD-285 + MD-292 + MD-301 + MD-299
  └─ block MD-293 final first-user UAT
```

MD-291 остаётся product Epic и группирует MD-294–MD-300. Final dependency не
полагается только на implicit child lifecycle: MD-299 и MD-301 блокируют
MD-293 напрямую.

## Открытые внутренние gates

| Gate | Почему действительно блокирует | Owning Task | Следующее действие | Success signal |
|---|---|---|---|---|
| Normative boundary | Accepted storage/import contract всё ещё противоречит small-data MVP | MD-292 | amend MVP/roadmap/ADR-0016/spec/profile и атомарно reclassify file/scale Tasks | accepted docs и Task Manager дают один P0 list |
| Integration baseline | `main` и `1df46ec` расходятся на 2/21 commits | MD-301 | inventory 21 commits и conflict-aware integration в `main` | один remote `main` SHA, full gate passed |
| Release authority | Release profile/migration должны соответствовать live Task Manager | MD-285–MD-287 | закрыть exact profile/conformance read-back | repository и live selector совпадают |
| Operator evidence | Admin/account flows требуют воспроизводимого three-principal UAT | MD-244, MD-280–MD-283 | выполнить existing hosted pool/canary matrix | redacted exact-deployment receipt passed |
| Index recovery | Пропущенный index job не должен требовать ручной data mutation | MD-252 | exact-candidate recovery probe | search восстанавливается bounded worker flow |
| Small-data performance | Read path не должен возвращаться к 10–23 s latency | MD-258 | выполнить starter/small cold+warm receipt | принятые p95 budgets passed |
| IA/security contract | Route identity, step-up и pagination должны быть определены до UI code | MD-294 | записать specs и objective contract tests | MD-294 acceptance passed |
| Product implementation | Ordinary flow сейчас остаётся монолитным и unbounded | MD-295–MD-298 | реализовать routes, access UX, paging и copy | targeted security/UI tests passed |
| Browser evidence | Synthetic HTTP gate не исполняет DOM/accessibility tree | MD-300 | добавить deterministic real-browser runner | desktop/mobile/keyboard gate passed |
| Connection UAT | Новый flow должен совпасть с реальным MCP enforcement | MD-299 | deterministic gate + fresh real-account canary | exact privacy-safe receipt passed |
| Final release | Нужен один terminal first-user result на одном artifact | MD-293 | UAT cut после всех incoming gates | exact SHA/deployment/package receipt passed |

## Findings, устранённые самим планом

Эти пункты больше не являются развилками или blockers:

- **CR-3:** large-corpus/Brain-scale performance minimum исключён; MD-258
  использует небольшой deterministic fixture.
- **CR-4:** выбран read-first OAuth. Первый write intent в Codex запускает
  native step-up; UI не обещает writable access до `content:write`.
- **CR-9:** physical credential deletion исключён из MVP. Test hygiene —
  deterministic naming, revoke и hide; retention policy не блокирует 0.1.
- **CR-10:** automatic capture исключён из ordinary Connections/onboarding и
  остаётся Advanced/post-MVP capability.
- **CR-11:** MD-299 напрямую блокирует MD-293.
- **CR-12:** list/detail/inactive page time, rendered size и bounded reads
  включены в MD-299 на fixture `0 / 1 / page_size + 1`.

## Non-blocking scope Release 0.1

После MD-292 следующие Tasks сохраняются, но не блокируют MVP:

- MD-245, MD-249–MD-250 — BundleFile vertical slice;
- MD-260, MD-266–MD-268 — Brain-scale storage/import/export;
- MD-270, MD-272–MD-275 — universal local/generated ingress;
- MD-284 — Google Drive-specific adapter;
- MD-288–MD-290 — stateful capacity/generated hosted canaries.

Наличие уже реализованного кода не возвращает эти outcomes в P0. Их failure
блокирует только соответствующий следующий milestone.

## Внешние границы, которые могут стать blockers

| Boundary | Что agent обязан сделать сам | Когда нужен человек | Resume signal |
|---|---|---|---|
| Marketplace/Codex OAuth account | refresh package, fresh context, install/connect, classify product vs surface failure, retry bounded flow | interactive consent, MFA или approval недоступны agent-у | fresh account видит exact package и OAuth завершается |
| Sites/provider deployment | build exact artifact, publish UAT, read-back/reconcile version and deployment, retry bounded provider outcome | account/provider action невозможно выполнить доступными tools | exact SHA связан с доступным deployment и live URL |

Timeout, stale catalog или failed smoke сами по себе не являются просьбой к
пользователю. Сначала должен быть исключён product bug, stale artifact,
connector drift, missing test principal и verification-surface failure.

## Обязательный blocker-report

Если внешний blocker действительно возник, отчёт содержит ровно:

1. затронутые Tasks и остановленный acceptance row;
2. что agent уже проверил и почему код/retry/reconcile не решают проблему;
3. actor, от которого нужно действие;
4. одно минимальное действие без передачи secrets;
5. observable success signal и точную точку продолжения.

Без этих пяти пунктов работа остаётся внутренним незавершённым gate, а не
блокером пользователя.
