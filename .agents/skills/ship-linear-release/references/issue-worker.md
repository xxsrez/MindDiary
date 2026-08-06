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

## Подтвердить входные данные

1. Полностью прочитай текущий `AGENTS.md`, обязательные документы из него,
   этот файл и `references/defect-triage.md`.
2. Прочитай live Linear issue с acceptance criteria, attachments и последними
   comments. Подтверди, что `projectMilestone.id` всё ещё равен pinned release
   ID. Если issue удалена из milestone, стала `Canceled`/`Duplicate` либо уже
   независимо завершена, прекрати новые мутации и верни фактическое состояние.
3. Проверь batch root SHA, `base SHA`, ordered dependency SHAs, intended branch,
   worktree path, queue fingerprint, `remote mode`, offline base и issue
   `updatedAt` из manifest. Base может
   быть exact ready head предшественника в stacked lane, но обязан быть rooted
   в batch root. Если worktree не изолирован, ancestry не сходится, база
   неожиданно изменилась или ownership конфликтует с чужими правками, не
   исправляй это разрушительно: верни `STATUS: needs-input`.
4. Подтверди изоляцию worktree:
   - отдельный checkout и branch только для этой issue;
   - отдельные mutable env/cache/tmp/build/port значения, если задача
     поднимает процессы; общий content-addressed dependency cache допустим;
   - никакие временные файлы не должны утекать в root checkout соседних issue.
5. Проверь resume state и существующие issue-scoped branch/commit/ref. Если
   доказанный прогресс уже есть, продолжай с первой незавершённой стадии и не
   дублируй commit.

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
5. Не изобретай отсутствующую canonical command и не объявляй build/test,
   client compatibility или deployment выполненными по косвенному сигналу.
6. Исправь и повтори любую доступную упавшую проверку. Для flaky-проверки
   допускается ровно один повтор на неизменённом SHA; если снова нестабильно,
   верни точный gap и не маскируй его успехом.
7. Недоступный external platform, cloud binding, real client, browser/device
   или performance trace запиши как `not-available` gap. Если live acceptance
   прямо требует это evidence, не возвращай `branch-ready`; иначе продолжай,
   не заявляя проверенной совместимости. Известный воспроизведённый дефект при
   этом остаётся fail.

## Commit и branch-ready результат

1. Перед commit ещё раз fetch-ом проверь milestone membership, state,
   `updatedAt` и scope. При изменении перечитай issue и примени правило
   адаптации выше.
2. Stage только issue-scoped файлы. Сделай минимальное число осмысленных
   commits с Linear identifier; release-defect fix добавляй новым commit, не
   переписывая уже опубликованный SHA. В `online` push exact HEAD только в
   intended feature branch и докажи совпадение remote ref. В
   `offline-local-only` не обращайся к origin: докажи exact локальную branch и
   оставь remote publication coordinator-у.
3. Не мержи никакую ветку, не пушь в default branch, не запускай deployment и
   не переводи issue в `Done`.
4. Сохрани worktree и branch до явного release success coordinator-а. Не
   удаляй worktree как часть своей normal path.
5. По умолчанию не меняй Linear. Если внешний протокол отдельно разрешил
   создать linked bug по `defect-triage.md`, не меняй state исходной issue без
   явной инструкции coordinator-а.

## Дефекты во время работы

Следуй `references/defect-triage.md`.

- same-scope дефект: чини в той же ветке/worktree и отрази в receipt;
- tiny obvious repair: чини в своей ветке только если он feature-local; если
  проявляется лишь в assembled candidate, верни `DEFECT_CANDIDATE` с
  предложением quick fix;
- independent или cross-feature regression: не чини молча в этой ветке без
  отдельного разрешения; верни связанный кандидат с provenance и dedupe-ключом.

Если после сгенерированного fix возник дефект второго поколения или проблема
выглядит системной, сработал recursion guard: остановись и верни
`STATUS: needs-input`.

## Вернуть bounded receipt

Верни coordinator-у только этот формат, суммарно не более 2000 символов:

```text
STATUS: branch-ready | failed | needs-input
ISSUE: <identifier> (<id>)
WORKTREE: <absolute path>
BRANCH: <name>
BASE_SHA: <sha>
DEPENDENCY_SHAS: <ordered refs или none>
HEAD_SHA: <full sha or none>
SCOPE: start=<updatedAt>; final=<updatedAt>; unchanged | adapted
RESUMED_FROM: none | branch | commit | receipt
ORIGIN_REF: <branch=sha or none>
REF_SCOPE: <origin | local-only>
SMOKE: <коротко что локально проверено>
TESTS: <короткий список команд и итогов>
GAPS: <none или точная граница>
DIRTY_REMAINDER: <none или сохранённые paths внутри worktree>
DEFECT_CANDIDATE: <none или короткий summary + defect_signature>
NEXT: <none или один конкретный вопрос/блокер>
```

Не прикладывай diff, полный tool log или длинный stack trace. Если issue не
доведена до branch-ready, не начинай другую issue.
