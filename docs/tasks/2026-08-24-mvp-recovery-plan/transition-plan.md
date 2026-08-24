# План перехода

Статус документа: `proposal`.

План intentionally разделяет решение о scope, product implementation и live
acceptance. Ни один этап не считается доказанным только потому, что предыдущая
Task получила новый status.

## Фаза 0. Заморозить точку отсчёта

### Действия

1. Зафиксировать Task Manager snapshot: Project, Release, 29 active Tasks,
   relations, labels и versions.
2. Зафиксировать три artifact identities: deployed UAT, integration candidate,
   local dirty checkout.
3. Не строить новый release candidate из local `main` и не перетирать
   параллельные изменения.
4. Принять этот recovery package как рабочий planning baseline либо записать
   отклонения отдельным decision note.

### Gate

Все участники используют один Project/Release и различают repository-ready,
deployed и live-accepted состояния.

## Фаза 1. Принять release boundary

### Действия

1. Подтвердить P0/P1/post-MVP классификацию из target state.
2. Если universal ingress остаётся обязательным MVP, явно изменить accepted
   MVP scope и указать пользовательскую гипотезу, ради которой он блокирует
   release.
3. Иначе:
   - убрать `Release blocker` у MD-270, MD-275 и MD-284;
   - вынести MD-260, MD-266–MD-268, MD-270, MD-272–MD-275, MD-284 и
     MD-288–MD-290 из активного 0.1 gate;
   - сохранить relations внутри expansion graph;
   - не удалять Tasks и не отменять уже полученный код/evidence.
4. Определить, остаётся ли BundleFile P1 в release batch или уходит вместе с
   universal ingress. Это отдельное решение от Google Drive/Brain-scale.

### Gate

Существует один список P0 blockers; ни одна post-MVP Task не влияет на решение
о готовности Release 0.1.

### Rollback

Reclassification обратима: Tasks остаются в Project со всеми comments и
relations. Возврат в release требует нового явного решения, а не случайного
сдвига статуса.

## Фаза 2. Стабилизировать release machinery

### Действия

1. Завершить Task Manager migration graph MD-285–MD-287 и проверить свежий
   task catalog/read-back.
2. Завершить operator verification graph MD-244 и MD-280–MD-283 на exact
   three-principal UAT pool.
3. Выбрать один integration cutoff. Не добавлять в него feature work после
   начала full gate, кроме исправления доказанного regression.
4. Прогнать один repository full gate на exact cutoff, а не повторять полный
   gate в каждой Task lane.

### Gate

Есть один task authority, один exact candidate и воспроизводимый operator
canary без ручного создания временной инфраструктуры во время smoke.

## Фаза 3. Реализовать новую information architecture

### Шаг 3.1. Принять IA contract

- зафиксировать routes, redirect/alias policy и terminology;
- определить connection identity и safe opaque route ref;
- описать empty/loading/error/revoked/stale states;
- принять pagination и test-credential retention contract.

### Шаг 3.2. Разделить routes

- добавить `/settings/connections`;
- добавить detail surface одной connection;
- добавить `/settings/developer/mcp`;
- добавить `/help/codex`;
- оставить `/settings/mcp` совместимым entrypoint;
- обновить header/footer/onboarding links.

### Шаг 3.3. Упростить access UX

- показывать summary в списке connections;
- редактировать access только на detail page;
- скрыть internal IDs;
- сохранить versioned CAS и fail-closed enforcement;
- сделать exact warning при переключении writable Mind;
- проверить automatic capture только на private writable target.

### Шаг 3.4. Очистить credential history

- active-first sorting;
- inactive collapsed by default;
- pagination/filter;
- deterministic names для UAT credentials;
- bounded cleanup runbook.

### Шаг 3.5. Перенести instructional content

- оставить три шага в primary onboarding;
- перенести manual configs и self-check в Advanced;
- перенести starter/recovery playbooks в Help;
- удалить повторяющееся объяснение protocol mechanics из ordinary flow.

### Targeted verification

- renderer/unit tests для каждого state;
- route and signed-out shell tests;
- authorization/CAS regression для bindings;
- keyboard focus, headings, labels и mobile layout;
- token/grant archive pagination и negative tests;
- старый `/settings/mcp` entrypoint не ломает bookmarks.

## Фаза 4. Закрыть runtime P0

### Действия

1. На exact candidate подтвердить MD-252 recovery и MD-258 measured latency
   gate.
2. MD-257 и MD-261 считать supporting implementation; не создавать для них
   отдельные hosted release cutoffs, если единая matrix уже покрывает outcome.
3. Если measured thresholds не пройдены, исправлять конкретный bottleneck и
   повторять только affected targeted probe до следующего batch cutoff.

### Gate

Starter workflow стабильно выполняется в принятом envelope, а index failure
восстанавливается без ручной модификации данных.

## Фаза 5. Выпустить один UAT candidate

### Последовательность

1. Freeze exact integration SHA.
2. `npm ci`, один `npm run check`, `git diff --check` на exact candidate.
3. Project-profile dev smoke всех P0 web/control/MCP flows.
4. Publish exact candidate в UAT.
5. Read-back deployment identity и live URL.
6. Force-refresh Marketplace/plugin snapshot и fresh Codex context.
7. Выполнить final first-user matrix из target state.
8. Сохранить один redacted release receipt и связать его с final gate Task.

### Failure routing

- repository failure → вернуть в owning implementation Task;
- deployment mismatch → release machinery incident, не product bug;
- browser bootstrap failure → verification-surface incident;
- auth/ACL/binding mismatch → product security blocker;
- missing external principal/account → operator pool blocker;
- missing fresh tool catalog → connector/runtime blocker;
- post-MVP file-source failure → не блокирует P0 после принятого scope reset.

## Фаза 6. Закрыть release без хвоста неопределённости

1. Final gate получает Done только после exact live receipt.
2. P0 Tasks закрываются по owning evidence; comments ссылаются на один receipt,
   а не копируют секреты или полный payload.
3. P1 Tasks получают Done только при собственном acceptance; иначе остаются
   явно non-blocking.
4. Post-MVP Tasks переводятся в отдельный milestone/Backlog, сохраняя
   hierarchy и dependencies.
5. В documentation index deployed SHA и evidence обновляются отдельно от этого
   planning snapshot.

## Terminal conditions

Работа завершена, когда:

- обычный setup состоит из трёх понятных действий;
- credentials, access settings и advanced developer material физически
  разделены;
- один exact UAT candidate проходит final first-user matrix;
- Release `0.1` не содержит неоднозначных активных blockers;
- каждый оставшийся незавершённый Task явно относится к следующему milestone,
  а не выглядит забытым хвостом MVP.
