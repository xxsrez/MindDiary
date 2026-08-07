# Протокол issue worker в отдельном worktree

Работай только над issue из переданного manifest. Ты владеешь её
issue-scoped реализацией, тестами, локальной проверкой, commit и только
разрешённым manifest-ом local/remote ref своей feature-ветки в отдельном
worktree. Ты не мержишь default branch, не
публикуешь/deploy, не ставишь `Done` и по умолчанию не мутируешь Linear. Верни
coordinator-у только `FEATURE_RECEIPT` и при необходимости
`DEFECT_CANDIDATE`. Не создавай subagents.

Default branch, Linear mutations, deployments, tags и milestone closure запрещены даже
если предыдущая версия flow или старый receipt делали иначе. Если manifest
пытается выдать такую authority, ничего внешнего не меняй и верни
`STATUS: needs-input` с конфликтом контракта.

Не читай и не меняй primary checkout. Сдвиг local/remote default сам по себе не
перебазирует и не отменяет pinned issue branch: продолжай до bounded receipt,
если coordinator не прислал fenced stop/quarantine. Никогда не rebase/reset-и
ветку на новый default по собственной инициативе.

При `EXECUTOR=coordinator-inline` тот же root логически исполняет worker lane в
отдельном worktree. Между детерминированными issue-checkpoint он обслуживает
mailbox/cutoff и затем возвращается в тот же worktree. Coordinator authority
нельзя использовать от имени feature lane: для расширения её scope, обхода
claim или worker-side Linear/integration/default/deploy/tag. Текущую issue он
не делегирует другому subagent.

Manifest обязан содержать `run_id`, random full `run_key`, `owner_id`, epoch,
claim generation/token, exact feature ref и guard ref/tip. Это fencing identity,
не credential. Если они отсутствуют, не совпадают с work claim либо branch не
содержит уникальный run-key/epoch/claim suffix, ничего не меняй и верни
`needs-input`. Late result старого epoch/generation не имеет authority.

## Подтвердить входные данные

1. Полностью прочитай текущий `AGENTS.md`, обязательные документы из него,
   этот файл и `references/defect-triage.md`.
2. Прочитай live Linear issue с acceptance criteria, attachments и последними
   comments. Подтверди, что `projectMilestone.id` всё ещё равен pinned release
   ID. Если issue удалена из milestone, стала `Canceled`/`Duplicate` либо уже
   независимо завершена, прекрати новые мутации и верни фактическое состояние.
3. Проверь `run_id/run_key`, owner/epoch, claim generation/token, guard ref/tip,
   root/base SHA, ordered dependency SHAs, intended branch/ref, worktree ID/path,
   queue fingerprint, remote mode/offline base и issue `updatedAt` из manifest.
   Base может
   быть exact ready head предшественника в stacked lane, но обязан быть rooted
   в root SHA. Если worktree не изолирован, ancestry не сходится, база
   неожиданно изменилась или ownership конфликтует с чужими правками, не
   исправляй это разрушительно: верни `STATUS: needs-input`.
4. Подтверди изоляцию worktree:
   - отдельный checkout и branch только для этой issue;
   - отдельные mutable env/cache/tmp/build/port значения, если задача
     поднимает процессы; общий content-addressed dependency cache допустим;
   - никакие временные файлы не должны утекать в root checkout соседних issue.
5. Проверь resume state и существующие issue-scoped branch/commit/ref. Resume in
   place допустим только для exact current owner/epoch/generation/token и одного
   isolated worktree. Усыновлённый stale SHA приходит как явный `ADOPTED_FROM`
   в fresh claim/ref. Продолжай с первой незавершённой стадии, не дублируй commit.

## Выполнить issue

1. Реализуй последний live scope, сохраняя детерминизм, границы domain и
   presentation, продуктовые ограничения и ownership paths. Если новый scope
   отменяет сделанное, конфликтует с ownership или требует нового
   архитектурного решения, верни `needs-input`.
2. Добавь соразмерные regression-тесты. Для механики используй seeded
   unit/property scenarios; для UI проверь затронутый flow локально в реальном
   браузере, если она затрагивает runtime/UI.
3. Ограничивай собственный контекст: ищи через `rg`, читай только нужные
   диапазоны, группируй независимые read-only проверки и не печатай полный
   diff, comment history или длинные логи. Для UI flow предпочитай один
   детерминированный script нескольким мелким interactive steps.
4. Feature gate на точном будущем дереве:
   - узкие тесты затронутой области;
   - один локальный smoke затронутого flow, если применимо;
   - `git diff --check`;
   - для Markdown/docs — project-docs validator из repo instructions;
   - для code — только реально существующие canonical build/test/lint/security
     commands из `AGENTS.md`, manifests или scripts;
   - для OKF fixtures — strict validation всего bundle, не только `wiki/`;
   - для MCP/adapter/client work — version-specific conformance exact profile,
     если он доступен и входит в scope.
   Не запускай полный repository suite без прямой issue acceptance или
   доказанной необходимости: global cross-feature gate выполняется один раз на
   cutoff. Маленькая правка не должна платить стоимость всего release pipeline.
5. Не изобретай отсутствующую canonical command и не объявляй build/test,
   client compatibility или deployment выполненными по косвенному сигналу.
6. Исправь и повтори любую доступную упавшую проверку. Для flaky-проверки
   допускается ровно один повтор на неизменённом SHA; если снова нестабильно,
   верни точный gap и не маскируй его успехом.
7. Недоступный external platform, cloud binding, real client, browser/device
   или performance trace запиши как `not-available` gap. Если live acceptance
   прямо требует это evidence, не возвращай `ready`; иначе продолжай,
   не заявляя проверенной совместимости. Известный воспроизведённый дефект при
   этом остаётся fail.

## Commit и ready результат

1. Перед commit ещё раз fetch-ом проверь milestone membership, state,
   `updatedAt` и scope. При изменении перечитай issue и примени правило
   адаптации выше.
2. Сопоставь actual changed/renamed/deleted/generated paths с
   `OWNERSHIP_PATHS`; diff вне разрешённого scope требует `needs-input`, а не
   молчаливого захвата. Stage только issue-scoped файлы. Сделай минимальное число осмысленных
   commits с Linear identifier; release-defect fix добавляй новым commit, не
   переписывая уже опубликованный SHA. Перед `online` push fetch-ни repo-global
   coordinator ref, current `WORK_CLAIM` и guard; потребуй exact manifest
   owner/epoch/generation/token. При mismatch/unavailable не публикуй и верни
   local-only artifact. В online mode создай descendant guard acknowledgement с
   exact HEAD/state и атомарно fast-forward push-ни intended feature ref плюс
   guard ref с explicit expected-old для обоих. Если remote не поддерживает
   atomic multi-ref push, не публикуй сам: coordinator-only mode. Не
   переписывай существующий ref. В `offline-local-only` не обращайся к origin:
   докажи exact локальную branch и
   оставь remote publication coordinator-у.
   Для длинной работы допустим редкий coherent checkpoint после осмысленного
   commit и affected check тем же atomic feature+guard protocol. Это не
   telemetry: не push-и на каждом shell step и не называй checkpoint `ready`.
3. Не мержи никакую ветку, не пушь в default branch, не запускай deployment и
   не переводи issue в `Done`.
4. Сохрани worktree и branch до явного release success coordinator-а. Не
   удаляй worktree как часть своей normal path.
5. По умолчанию не меняй Linear. Если внешний протокол отдельно разрешил
   создать linked bug по `defect-triage.md`, не меняй state исходной issue без
   явной инструкции coordinator-а.

## Дефекты во время работы

Следуй `references/defect-triage.md`.

- `same-scope`: чини только в branch/worktree текущего active claim и отрази в receipt;
- `tiny-integration-repair`: чини в своей ветке только если он feature-local; если
  проявляется лишь в assembled candidate, верни `DEFECT_CANDIDATE` с
  предложением quick fix;
- `independent-regression`: не чини молча в этой ветке без
  отдельного разрешения; верни связанный кандидат с provenance и dedupe-ключом.

Если после сгенерированного fix возник дефект второго поколения или проблема
выглядит системной, сработал recursion guard: остановись и верни
`STATUS: needs-input`.

## Вернуть bounded receipt

Верни coordinator-у только этот формат, суммарно не более 2000 символов:

```text
STATUS: ready | failed | needs-input
RUN_ID: <id>
RUN_KEY: <random >=128-bit hex>
OWNER: id=<owner_id>; epoch=<n>
CLAIM: generation=<n>; token=<opaque id>
ISSUE: <identifier> (<id>)
WORKTREE: <absolute path>
BRANCH: <name>
BASE_SHA: <sha>
DEPENDENCY_SHAS: <ordered refs или none>
HEAD_SHA: <full sha or none>
SCOPE: start=<updatedAt>; final=<updatedAt>; unchanged | adapted
RESUMED_FROM: none | branch | commit | receipt
ADOPTED_FROM: <owner/epoch/generation/ref@sha or none>
ORIGIN_REF: <branch=sha or none>
GUARD: <origin|local-only>:<ref=ack-sha or none>
REF_SCOPE: <origin | local-only>
SMOKE: <коротко что локально проверено>
TESTS: <короткий список команд и итогов>
GAPS: <none или точная граница>
DIRTY_REMAINDER: <none или сохранённые paths внутри worktree>
DEFECT_CANDIDATE: <none или короткий summary + defect_signature>
NEXT: <none или один конкретный вопрос/блокер>
```

Не прикладывай diff, полный tool log или длинный stack trace. Если issue не
доведена до ready, не начинай другую issue.
