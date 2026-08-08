# Триаж feature, integration и global defects

Этот протокол определяет attribution и влияние defect на scheduler. Явный
запуск основного skill разрешает coordinator-у описанные Linear-мутации;
worker сам их не делает без manifest-инструкции. Замораживай минимальную
доказанно опасную lane, а не весь run, но при неизвестном blast radius выбирай
fail closed.

## Содержание

- [Сначала классифицируй дефект](#сначала-классифицируй-дефект)
- [Правила действий](#правила-действий)
- [Применить scheduler effect](#применить-scheduler-effect)
- [Dedupe и provenance](#dedupe-и-provenance)
- [Ограничители](#ограничители)

## Сначала классифицируй дефект

1. **`same-scope`**: дефект делает acceptance criteria текущей issue ложными или
   является прямым следствием её реализации.
2. **`tiny-integration-repair`**: маленькая, локальная и очевидная
   коррекция на пути к `ready` без нового продуктового решения и без
   захвата чужих ownership paths.
3. **`independent-regression`**: отдельный симптом, другой fix
   path, другая функциональная область или регрессия, которая может жить
   отдельно от текущей issue.
4. **`systemic-or-second-generation`**: дефект возник после уже сгенерированного
   исправления либо показывает повторяющийся шаблон шире текущей issue; он
   требует отдельной stabilization issue и root-cause scope.
5. **`known-bad-default`**: post-push CI или live smoke доказал, что
   текущий default/release нельзя использовать как healthy base.

## Правила действий

1. `same-scope`:
   - не открывай новую issue по умолчанию;
   - до terminal `FEATURE_RECEIPT` worker чинит в текущем claim/worktree;
   - после ready receipt/ingest coordinator supersede-ит старый claim/ref,
     возвращает issue в работу и выдаёт новую generation, epoch-scoped descendant
     repair branch; старый worker больше не пишет;
   - Linear меняет только coordinator.
2. `tiny-integration-repair`:
   - если дефект найден до `FEATURE_RECEIPT` и относится к этой feature, worker
     может исправить его в текущей branch/worktree;
   - если дефект существует только в assembled candidate, coordinator делает
     отдельный coordinator-inline manifest, task worktree/branch/guard и
     минимальный integration-fix commit;
   - не расширяй scope дальше минимально нужного; после code change всегда
     reseal candidate.
3. `independent-regression`:
   - не чини молча в текущей ветке;
   - верни `DEFECT_CANDIDATE` с provenance;
   - coordinator deduplicate-ит candidate и создаёт linked Linear Bug,
     назначает на `me`, связывает с source issue;
   - добавь Bug в тот же milestone, если дефект блокирует delivery или был
     заинтродуцирован текущим milestone; иначе оставь в backlog и продолжай
     независимую delivery.
4. `systemic-or-second-generation`:
   - deduplicate-и либо создай отдельную priority stabilization Bug с failing
     signature, affected cutoffs, known-good base и bounded root-cause
     acceptance;
   - заморозь только affected integration/promotion и отдай Bug свежему worker,
     а доказанно независимый frontier продолжай;
   - не порождай бесконечную цепочку одинаковых generated fixes. После двух
     неуспешных repair generations с тем же signature выполни bounded
     classification: новый product/security decision, противоречивые
     authoritative требования или недоступный внешний ресурс разрешают
     `needs-input`; доказуемый implementation path остаётся обычной задачей и
     продолжает work, даже если он сложный.
5. `known-bad-default`:
   - запрети ordinary integration/default/deploy;
   - верни production на exact `previous_stable`, если live release сломан;
   - создай stabilization fix/revert lane и разрешай обычную branch-работу
     только от exact last-known-good base при доказанной независимости.

## Применить scheduler effect

| Класс | Issue work | Integration | Default / deploy |
|---|---|---|---|
| `same-scope` до promotion | Переоткрой исходную issue, новый claim generation, та же feature scope | Исключи bad ref и зависимые refs; независимые продолжай | Без freeze, пока default healthy |
| `tiny-integration-repair` | Не создавай новую issue | Один минимальный coordinator-inline fix в отдельном worktree, affected check, reseal | Продолжай только после нового global pass |
| `independent-regression` | Создай deduplicated Bug; blocking bug отправь в приоритетный slot | Исключи culprit либо freeze только affected cutoff | Не deploy affected cutoff |
| `systemic-or-second-generation` | Создай/переиспользуй stabilization Bug и fresh worker; независимые branches от good base продолжаются | `integration=frozen` только для affected scope | Никаких affected promotion/deploy до passing stabilization cutoff |
| `known-bad-default` | `good-base-only` либо `stabilization-only` | Только stabilization lane | Rollback/revert/fix до healthy evidence |

Если attribution неизвестна, не называй defect feature-local. Поставь active
cutoff в quarantine, запрети promotion и выполни минимальную диагностику,
которая различит feature, interaction, environment и systemic cause. Issue pool
может продолжать только работу, не зависящую от suspect surface/base.

Worker slot и integration lane независимы: возвращённая в работу issue занимает
первый совместимый свободный slot по обычному priority, но длинный repair не
удерживает готовые независимые refs. Изменение source после любого fix создаёт
новую exact generation; не переиспользуй старый global pass.

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
- suggested class: `same-scope` | `tiny-integration-repair` |
  `independent-regression` | `systemic-or-second-generation` | `known-bad-default`.

Перед созданием linked Bug coordinator ищет совпадение signature среди issue
team/project, milestone, связанных issue и receipts run. До create durable action
intent сохраняет team/project, source issue, signature, payload digest и exact
provider selector. Поэтому crash после create, но до link/receipt, разрешается
bounded lookup: один match усыновляется, доказанный ноль разрешает новый action,
ambiguity не создаёт дубль. Description нового Bug содержит repro,
expected/actual, source issue, cutoff/generation, candidate SHA, failing gate,
last known stable artifact при наличии и проверяемые acceptance criteria.

## Ограничители

1. Один повтор flaky-проверки на неизменённом SHA допустим; второй fail —
   это gap, а не успех.
2. Ни worker, ни coordinator не должны автономно порождать бесконечную цепочку
   одинаковых исправлений. Один deduplicated stabilization Bug может получить
   новые claim generations; запрос пользователя нужен только после bounded
   диагностики, доказавшей настоящий blocker из Goal contract.
3. Если не уверен между `same-scope` и `independent-regression`, предпочитай
   `DEFECT_CANDIDATE` coordinator-у вместо молчаливого расширения scope.
4. Global guardrail не запускай повторно без source/evidence change, кроме
   единственного exact retry suspected flake. Необъяснённая нестабильность —
   degraded/frozen state, а не pass.
