# План Task Manager

Статус документа: `proposal`.

## Принципы изменений

- Не переписывать исторические Done Tasks: они фиксируют реально принятый на
  тот момент scope.
- Не удалять Tasks только ради красивого списка. Duplicate/Canceled допустимы
  лишь при exact доказательстве, а полезный выполненный код сохраняется.
- Новые planning Tasks создаются в Backlog и переходят дальше только при начале
  фактической delivery.
- Status отражает lifecycle результата; repository-ready и hosted-accepted
  различаются в description/comments и evidence.
- `Release blocker` означает только невозможность получить terminal outcome
  Release 0.1.

## Целевая triage-модель существующих Tasks

### P0 product/release blockers

| Task | Роль в MVP | Требуемое действие |
|---|---|---|
| MD-244 | operator outcome | поднять priority до high; закрыть по three-principal live evidence |
| MD-252 | index recovery | принять repository work только после exact UAT recovery probe |
| MD-258 | measured performance | закрыть одним consolidated performance receipt |
| MD-280–MD-283 | воспроизводимый operator gate | завершить pool/canary/privacy evidence, затем разблокировать MD-244 |
| MD-285–MD-287 | текущий release authority | завершить migration/read-back; не смешивать с product acceptance |

### P1 non-blocking hardening

| Task | Роль | Рекомендуемое состояние после scope decision |
|---|---|---|
| MD-245, MD-249, MD-250 | BundleFile vertical slice | оставить в batch только при низкой стоимости terminal UAT; иначе следующий milestone |
| MD-257, MD-259, MD-261 | performance implementation | закрывать supporting evidence, но не заводить новый release cutoff на каждую Task |
| MD-288 | stateful matrix | использовать как reusable gate; не делать обязательным для Markdown-only first-user path |

### Post-MVP expansion graph

| Tasks | Outcome | Рекомендуемое действие после принятия boundary |
|---|---|---|
| MD-260, MD-266–MD-268 | Brain-scale storage/import/export | вынести из blocking 0.1 scope, сохранить hierarchy |
| MD-270, MD-272–MD-275 | universal local/generated ingress | убрать `Release blocker` 0.1, перенести в следующий milestone |
| MD-284 | Google Drive-specific adapter | не считать generic connector bridge доказательством Google Drive; следующий milestone |
| MD-289–MD-290 | capacity/generated hosted canaries | оставить children соответствующих expansion outcomes |

MD-284 требует особенно аккуратного текста: generic `connector_object` bridge
и Google Drive-specific materialization — разные outcomes. Наличие первого не
закрывает второе и не должно маскироваться широким title.

## Новая структура Tasks

### Top-level decision Task — MD-292

`MD-292 Зафиксировать границу Release 0.1: Codex-first MVP против file/scale expansion`

Outcome: принято одно из двух явных решений — scope reset по этому документу
или расширенный MVP с обновлёнными accepted product docs и обоснованием.

### Epic подключения — MD-291

`MD-291 Сделать подключение Mind Diary понятным для MVP 0.1`

Children:

1. MD-294 — принять IA contract Connections / Connection details /
   Advanced MCP / Codex Help;
2. MD-295 — разделить routes и navigation;
3. MD-296 — заменить технический binding editor на human-readable access
   management;
4. MD-297 — скрыть inactive/test credential history и добавить pagination;
5. MD-298 — оставить Install → Authenticate → Choose Minds в primary
   onboarding;
6. MD-299 — пройти accessibility/mobile/security и exact UAT acceptance.

### Final release gate — MD-293

`MD-293 Провести финальный first-user UAT и закрыть MVP 0.1 по единому receipt`

Этот Task блокируется только:

- принятой release boundary;
- Epic подключения;
- MD-244;
- MD-252;
- MD-258;
- MD-285.

BundleFile/file-source expansion не добавляется в этот graph до отдельного
решения о расширенном MVP.

## Изменения, которые нельзя делать автоматически в параллельном release run

Перевод MD-260/MD-270 graph в Backlog, удаление `Release blocker` и изменение
Release composition меняют активный delivery scope. Их следует выполнить
атомарно после завершения top-level decision Task и свежего read-back versions,
а не одновременно с работой release executor над теми же Tasks.

Это не откладывает решение: decision Task и final graph делают его первым
обязательным шагом. Но сохраняют уже идущую инженерную работу от silent status
race и потери evidence.

## Применённые planning-изменения 2026-08-24

- После read-back Project содержит 213 Tasks: 9 Backlog, 29 started,
  119 completed и 56 canceled. Release 0.1 содержит 157 Tasks, включая новые
  9 Backlog planning items; ранее активные 29 Tasks не меняли status.
- Созданы MD-291–MD-299 в Backlog Release 0.1 с полными problem-first
  descriptions и acceptance.
- MD-291 имеет шесть native subtasks MD-294–MD-299.
- MD-294 блокирует MD-295–MD-298; эти четыре implementation outcomes блокируют
  MD-299.
- MD-244, MD-252, MD-258, MD-285, MD-291 и MD-292 блокируют единый final gate
  MD-293.
- Priority MD-244 исправлен с medium на high, поскольку Task остаётся active
  Release blocker.
- Permanent deletion, Duplicate и status demotion существующих Tasks не
  применялись: exact duplicates не найдены, а массовая переклассификация
  активного release scope теперь является явным acceptance MD-292 и должна
  выполняться после fresh version read-back.
