# План Task Manager

Статус документа: current planning projection; live Task Manager остаётся
авторитетным для status, versions и relations.

## Canonical scope

- Project `Mind Diary`: `525e801d-0ae9-4be7-bae4-6a9c8f85f581`.
- Release `0.1`: `e92b681b-fd18-43e2-91df-3538c37d9890`.
- После исправления плана: Project 215 Tasks; Release 159 Tasks;
  `Backlog 1 / Todo 10 / started 29 / Done 119` внутри Release.

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
- MD-297 реализует bounded server-side paging; CSS/client-side hiding
  недостаточно.
- Credential hygiene — revoke + hide; hard delete не блокирует MVP.
- Automatic capture не входит в ordinary Connections/onboarding.
- MD-299 требует fresh real-account canary; informational external check не
  может доказать заявленный first-user outcome.

## Post-MVP reclassification, принадлежащая MD-292

После accepted-doc amendment и fresh versions следующие Tasks атомарно
покидают active Release 0.1 и теряют `Release blocker` 0.1:

| Tasks | Следующий outcome |
|---|---|
| MD-245, MD-249–MD-250 | BundleFile vertical slice |
| MD-260, MD-266–MD-268 | Brain-scale storage/import/export |
| MD-270, MD-272–MD-275 | universal local/generated ingress |
| MD-284 | Google Drive-specific materialization |
| MD-288–MD-290 | stateful capacity/generated hosted canaries |

Их code/evidence сохраняются. MD-257/MD-261 остаются supporting fixes только
если MD-258 обнаружит соответствующий small-data bottleneck.

## Planning mutations, применённые 2026-08-24

- MD-291–MD-299 находятся в Todo; MD-300 переведена из Backlog в Todo.
- Создана MD-301 `Собрать единый integration baseline Release 0.1` в Backlog,
  `urgent`, с Labels `Release blocker` и `Improvement`.
- Описания MD-291–MD-300 переписаны с точными decisions, acceptance и
  blocker-report boundary.
- Добавлены relations:
  - MD-292 → MD-301 и MD-294;
  - MD-301 → MD-295, MD-296, MD-297, MD-298, MD-300, MD-293;
  - MD-294 → MD-300;
  - ранее добавленные MD-295–MD-300 → MD-299 и MD-299 → MD-293 сохранены.
- MD-244, MD-252, MD-258 и MD-285 продолжают напрямую блокировать MD-293.

MD-301 остаётся Backlog, потому что это новая planning Task; начало delivery
должно отдельным lifecycle action перевести её в Todo/In Progress. До этого
UI implementation не начинается.

## Read-back checklist

После каждой следующей mutation нужно проверить:

1. canonical Task ref и current version;
2. status/priority/Release/labels;
3. direction человеческой фразой `A blocks B`;
4. отсутствие post-MVP Task среди incoming MD-293 blockers;
5. совпадение live graph с [реестром блокеров](blocker-register.md);
6. отсутствие unknown outcome перед retry.
