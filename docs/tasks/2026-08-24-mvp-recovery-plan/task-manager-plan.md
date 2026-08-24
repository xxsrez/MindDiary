# План Task Manager

Статус документа: current planning projection; live Task Manager остаётся
авторитетным для status, versions и relations.

## Canonical scope

- Project `Mind Diary`: `525e801d-0ae9-4be7-bae4-6a9c8f85f581`.
- Release `0.1`: `e92b681b-fd18-43e2-91df-3538c37d9890`.
- После третьего критического прогона и reconciliation: Project 215 Tasks;
  Release 140 Tasks; `Backlog 0 / Todo 11 / started 10 / Done 119` внутри
  Release. Это датированный snapshot; перед mutation обязателен fresh
  read-back.

## Правила графа

- `Release blocker` означает невозможность получить terminal outcome 0.1, а
  не просто полезную незавершённую работу.
- Каждый blocker имеет одну owning Task, objective acceptance и native
  dependency до consumer.
- Epic используется для grouping, но critical dependency дублируется прямой
  `blocks` relation, если Task Manager не гарантирует child lifecycle.
- Post-MVP Tasks не удаляются и не помечаются Duplicate ради чистого списка.
- Physical credential deletion и production не входят в planning mutations.

## Исполнимый P0 graph

| Task | Outcome | Прямые consumers |
|---|---|---|
| MD-292 | accepted small-data MVP boundary и reclassification | MD-301, MD-294, MD-293 |
| MD-301 | один exact integration baseline в `main` | MD-295–MD-298, MD-300, MD-293 |
| MD-294 | route/ref/query/write-step-up security contract | MD-295–MD-298, MD-300 |
| MD-295 | bounded non-enumerating routes | MD-299 |
| MD-296 | read-first/write-step-up access UX | MD-299 |
| MD-297 | server-side credential pagination, revoke + hide | MD-299 |
| MD-298 | three-step onboarding без protocol/capture noise | MD-299 |
| MD-300 | real-browser deterministic gate | MD-299 |
| MD-282 | reusable three-session UAT pool | MD-281, MD-299 |
| MD-299 | exact browser/security/real-account connection UAT | MD-293 |
| MD-244 | operator/admin exact UAT | MD-293 |
| MD-252 | bounded exact-revision index recovery | MD-293 |
| MD-258 | starter/small performance receipt | MD-293 |
| MD-285 | Task Manager release authority | MD-293 |
| MD-293 | final first-user release receipt | terminal gate |

MD-291 группирует MD-294–MD-300 и также блокирует MD-293 как product Epic.
MD-299 и MD-301 блокируют final gate напрямую, поэтому он не зависит только от
неявной семантики закрытия Epic.

## Выбранные решения вместо открытых вопросов

- MD-292 больше не предлагает расширенный file/scale MVP как равноправный
  вариант: Release 0.1 — small-data Codex-first Markdown outcome.
- MD-294 фиксирует initial `content:read`; first write intent запускает native
  step-up, после которого выбирается один writable Mind.
- Raw grant/token IDs не используются как route identity.
- MD-297 реализует bounded active OAuth list для Connections и отдельную
  active/inactive personal-token history для Advanced MCP;
  CSS/client-side hiding недостаточно.
- Credential hygiene — revoke + hide; hard delete не блокирует MVP.
- Automatic capture не входит в ordinary Connections/onboarding.
- MD-299 требует fresh real-account canary; informational external check не
  может доказать заявленный first-user outcome.

## Post-MVP reclassification, применённая 2026-08-24

После fresh versions следующие Tasks атомарно покинули active Release 0.1,
потеряли `Release blocker` 0.1 и получили `medium` priority:

| Tasks | Следующий outcome |
|---|---|
| MD-245, MD-249–MD-250 | BundleFile vertical slice |
| MD-260, MD-266–MD-268 | Brain-scale storage/import/export |
| MD-270, MD-272–MD-275 | universal local/generated ingress |
| MD-284 | Google Drive-specific materialization |
| MD-288–MD-290 | stateful capacity/generated hosted canaries |

Дополнительно MD-257, MD-259 и MD-261 выведены из Release как scale/supporting
scope. Relations MD-257 → MD-258 и MD-261 → MD-258 удалены: эти fixes
возвращаются только при измеренном small-data bottleneck. Code/evidence и
остальные post-MVP relations сохранены.

## Planning mutations, применённые 2026-08-24

- MD-291–MD-299 находятся в Todo; MD-300 переведена из Backlog в Todo.
- Создана MD-301 `Собрать единый integration baseline Release 0.1`, `urgent`,
  с Labels `Release blocker` и `Improvement`; вторым review она исправлена из
  Backlog в Todo, потому что это обязательный предшественник implementation.
- Описания MD-291–MD-300 переписаны с точными decisions, acceptance и
  blocker-report boundary.
- Добавлены relations:
  - MD-292 → MD-301 и MD-294;
  - MD-301 → MD-295, MD-296, MD-297, MD-298, MD-300, MD-293;
  - MD-294 → MD-300;
  - ранее добавленные MD-295–MD-300 → MD-299 и MD-299 → MD-293 сохранены.
- MD-244, MD-252, MD-258 и MD-285 продолжают напрямую блокировать MD-293.
- MD-292 дополнена обязанностью обновить stale top-level Project/Release
  descriptions вместе с normative reclassification.
- MD-294 запрещает silent fallback с read-first OAuth на initial read+write и
  фиксирует live incremental-consent canary как отдельный gate.
- MD-297 больше не обещает отсутствующую revoked OAuth history: Connections
  читает active OAuth grants, Advanced MCP — bounded token history; заголовок
  Task также заменён на outcome-level формулировку без CSS-hide implication.
- MD-282 получила `urgent` + `Release blocker` и native relations
  `MD-282 blocks MD-281` и `MD-282 blocks MD-299`.
- MD-244, MD-258, MD-280, MD-285 и весь connection critical path получили
  priorities/labels, соответствующие реальному release order.
- MD-244, MD-280–MD-283, MD-291, MD-293–MD-294 и MD-299–MD-300 используют
  agent-owned acceptance. Human-only boundary сведена к password/MFA/passkey,
  отсутствующей external identity, OS security prompt или at-action authority
  confirmation; после неё agent продолжает сам.
- MD-258 current description и superseding comment явно исключают 590 MB,
  1,741 files и Brain-scale matrix из terminal acceptance.
- Новые Tasks и архивирование не потребовались: actor/evidence outcomes уже
  имели владельцев, а exact duplicates не обнаружены.

MD-301 теперь Todo. Delivery переводит её в In Progress только при фактическом
начале inventory/integration; UI implementation всё равно не начинается до её
terminal baseline gate.

## Read-back checklist

После каждой следующей mutation нужно проверить:

1. canonical Task ref и current version;
2. status/priority/Release/labels;
3. direction человеческой фразой `A blocks B`;
4. отсутствие post-MVP Task среди incoming MD-293 blockers;
5. совпадение live graph с [реестром блокеров](blocker-register.md);
6. отсутствие unknown outcome перед retry.

## Ограничение adapter-а

Current Task Manager adapter не предоставляет mutation Project/Release
descriptions. Поэтому их stale AND/Linear narrative остаётся non-authoritative
operational metadata до поддержанной write surface. Это явно записано в
MD-292; release truth до исправления берётся из accepted repository docs,
Release composition и native relations, а не из stale top-level prose.
