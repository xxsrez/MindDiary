# Триаж дефектов во время issue-работы

Этот протокол определяет, когда worker может исправить найденный дефект в той
же ветке, когда должен вернуть только кандидат и как coordinator создаёт
отдельный linked Bug. Явный запуск основного skill разрешает coordinator-у
такие Linear-мутации; worker сам их не делает без manifest-инструкции.

## Сначала классифицируй дефект

1. **same-scope**: дефект делает acceptance criteria текущей issue ложными или
   является прямым следствием её реализации.
2. **tiny obvious integration repair**: маленькая, локальная и очевидная
   коррекция на пути к branch-ready без нового продуктового решения и без
   захвата чужих ownership paths.
3. **independent / cross-feature regression**: отдельный симптом, другой fix
   path, другая функциональная область или регрессия, которая может жить
   отдельно от текущей issue.
4. **systemic / second generation**: дефект возник после уже сгенерированного
   исправления либо показывает повторяющийся шаблон шире текущей issue.

## Правила действий

1. same-scope:
   - не открывай новую issue по умолчанию;
   - продолжай в той же branch/worktree;
   - если исходная issue уже была частично закрыта внешним процессом, проси
     coordinator-а переоткрыть/вернуть её в работу, а сам новых мутаций Linear
     не делай без явной инструкции.
2. tiny obvious integration repair:
   - если дефект найден до `FEATURE_RECEIPT` и относится к этой feature, worker
     может исправить его в текущей branch/worktree;
   - если дефект существует только в assembled candidate, coordinator делает
     отдельный минимальный integration-fix commit;
   - не расширяй scope дальше минимально нужного; после code change всегда
     reseal candidate.
3. independent / cross-feature regression:
   - не чини молча в текущей ветке;
   - верни `DEFECT_CANDIDATE` с provenance;
   - coordinator deduplicate-ит candidate и создаёт linked Linear Bug,
     назначает на `me`, связывает с source issue;
   - добавь Bug в тот же milestone, если дефект блокирует delivery или был
     заинтродуцирован текущим milestone; иначе оставь в backlog и продолжай
     независимую delivery.
4. systemic / second generation:
   - если новый независимый defect возник после generated fix либо повторяется
     системный паттерн, не продолжай автономную рекурсию;
   - верни `STATUS: needs-input` и компактное объяснение root cause surface.

## Dedupe и provenance

Перед новым bug-candidate собери `defect_signature`:

`<surface>|<symptom>|<repro step or invariant>|<expected vs actual>`

Используй его для bounded dedupe:

1. сравни с уже найденными кандидатами этой issue/run;
2. сравни с linked comments/receipts/известными bug refs в текущей issue;
3. не создавай второй кандидат, если signature и symptom по сути совпадают.

Каждый `DEFECT_CANDIDATE` должен содержать минимум:

- `defect_signature`;
- краткий symptom;
- expected vs actual;
- reproducible steps или invariant;
- где найдено: issue, branch, SHA, локальный smoke/test;
- suggested class: `same-scope` | `tiny-repair` | `independent-regression` |
  `systemic`.

Перед созданием linked Bug coordinator ищет совпадение signature среди issue
milestone, связанных issue и receipts run. Description нового Bug содержит
repro, expected/actual, source issue, batch/generation, candidate SHA, failing
gate, last known stable artifact при наличии и проверяемые acceptance criteria.

## Ограничители

1. Один повтор flaky-проверки на неизменённом SHA допустим; второй fail —
   это gap, а не успех.
2. Ни worker, ни coordinator не должны автономно порождать цепочку
   независимых исправлений второго поколения после generated-fix или
   системного паттерна.
3. Если не уверен между `same-scope` и `independent-regression`, предпочитай
   `DEFECT_CANDIDATE` coordinator-у вместо молчаливого расширения scope.
