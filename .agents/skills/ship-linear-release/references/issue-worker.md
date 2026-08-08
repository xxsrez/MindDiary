# Протокол issue executor в feature checkout

Работай только над issue из переданного manifest. Ты владеешь её
issue-scoped реализацией, тестами, локальной проверкой, commit и только
разрешённым manifest-ом local/remote ref своей feature-ветки. Delegated worker
использует отдельный worktree; fused `workers=1` coordinator-inline использует
primary checkout. Ты не мержишь default branch, не
публикуешь/deploy, не ставишь `Done` и по умолчанию не мутируешь Linear. Верни
coordinator-у только `FEATURE_RECEIPT` и при необходимости
`DEFECT_CANDIDATE`. Не создавай subagents.

## Содержание

- [Подтвердить входные данные](#подтвердить-входные-данные)
- [Выполнить issue](#выполнить-issue)
- [Commit и ready результат](#commit-и-ready-результат)
- [Дефекты во время работы](#дефекты-во-время-работы)
- [Вернуть bounded receipt](#вернуть-bounded-receipt)

Default branch, Linear mutations, deployments, tags и milestone closure запрещены даже
если предыдущая версия flow или старый receipt делали иначе. Если manifest
пытается выдать такую authority, ничего внешнего не меняй и верни
`STATUS: needs-coordinator` с конфликтом контракта.

При `checkout_mode=worktree` не читай и не меняй primary checkout. При
`checkout_mode=primary` требуй `EXECUTOR=coordinator-inline`, repo path равный
worktree path и exact зарегистрированный feature branch; delegated executor не
может получить такой manifest. Сдвиг local/remote default сам по себе не
перебазирует и не отменяет pinned issue branch: продолжай до bounded receipt,
если coordinator не прислал fenced stop/quarantine. Никогда не rebase/reset-и
ветку на новый default по собственной инициативе.

При `EXECUTOR=coordinator-inline` тот же root логически исполняет worker lane в
primary checkout при `workers=1`. Между детерминированными issue-checkpoint он обслуживает
mailbox/cutoff и затем возвращается в тот же worktree. Coordinator authority
нельзя использовать от имени feature lane: для расширения её scope, обхода
claim или worker-side Linear/integration/default/deploy/tag. Текущую issue он
не делегирует другому subagent.

Manifest обязан содержать `run_id`, random full `run_key`, `owner_id`, epoch,
claim generation/token, exact feature ref и guard ref/tip. Это fencing identity,
не credential. Если они отсутствуют, не совпадают с work claim либо branch не
содержит уникальный run-key/epoch/claim suffix, ничего не меняй и верни
`needs-coordinator`. Late result старого epoch/generation не имеет authority.
Manifest также содержит fresh `executor.lease_id`, `mode`, `agent_type` и
`fork_turns=none`. Если этот runtime agent уже исполнял другую issue/lease,
ничего не меняй и верни `needs-coordinator`: worker нельзя переиспользовать.
`issue_id` может быть Linear UUID либо exact `issue_identifier`, когда
установленный connector возвращает identifier в поле `id`; во втором случае
они обязаны совпадать. Никогда не принимай выдуманный UUID.

Требуй exact machine-checkable fragment:

```json
{
  "issue_updated_at": "<operational timestamp>",
  "scope_fingerprint": "<semantic digest>",
  "checkout_mode": "primary|worktree",
  "executor": {
    "lease_id": "<fresh UUID>",
    "mode": "delegated|coordinator-inline",
    "agent_type": "worker|coordinator-inline",
    "fork_turns": "none"
  },
  "isolation": {
    "mutable_build_dir": "<absolute task-owned path>",
    "tmp_dir": "<absolute task-owned path>",
    "runtime_dir": "<absolute task-owned path>",
    "cache_mode": "content-addressed|isolated",
    "cache_dir": "<absolute path>",
    "cache_key": "<sha256 for content-addressed, otherwise none>",
    "ports": [],
    "env": {}
  },
  "dependencies": {
    "mode": "isolated|content-addressed",
    "path": "<absolute dependency tree>",
    "lockfile_digest": "<sha256 package-lock.json>",
    "cache_key": "none|<sha256>",
    "read_only": false,
    "provenance": "<verified provision receipt>"
  },
  "validation": {
    "check_class": "targeted-feature",
    "targeted_checks": [
      {"id": "<stable-id>", "argv": ["node", "--test", "<exact-file>"]}
    ],
    "full_gate": "deferred-to-cutoff"
  }
}
```

`ports` — уникальные integer ports; `env` содержит только explicit non-secret
task-scoped values; `targeted_checks` — непустой список. Missing/invalid
isolation или validation field запрещает исполнение, а не разрешает worker-у
подобрать значение самостоятельно.
Для `dependencies.mode=isolated` требуется `read_only=false`, task-owned
`<worktree>/node_modules` и exact `.codex-task/provision.json`; для
`content-addressed` — `read_only=true`, immutable cache key и physically
read-only path вне worktree.

## Подтвердить входные данные

1. Полностью прочитай текущий `AGENTS.md` и этот файл. Затем выполни из
   worktree один routed read по exact `OWNERSHIP_PATHS`:

   ```bash
   PYTHONDONTWRITEBYTECODE=1 python3 \
     .agents/skills/ship-linear-release/scripts/shipctl.py docs \
     --path <ownership-path> [--path <ownership-path> ...]
   ```

   Полностью прочитай только документы из `documents`. При `fallback_all=true`
   прочитай весь mandatory список из `AGENTS.md`; не угадывай новый surface.
   `references/defect-triage.md` читай только при фактическом дефекте. Не
   повторяй чтение документов, уже прочитанных в текущем worker turn.
   До source edit проверь manifest командой `shipctl.py manifest --phase active
   --input <manifest.json>`. Любая ошибка возвращается coordinator-у; worker не
   чинит coordinator SHA, refs, provision receipt или executor lease сам.
2. Прочитай live Linear issue с acceptance criteria, attachments и последними
   comments. Подтверди, что `projectMilestone.id` всё ещё равен pinned release
   ID. Если issue удалена из milestone, стала `Canceled`/`Duplicate` либо уже
   независимо завершена, прекрати новые мутации и верни фактическое состояние.
3. Проверь `run_id/run_key`, owner/epoch, claim generation/token, guard ref/tip,
   root/base SHA, ordered dependency SHAs, intended branch/ref, worktree ID/path,
   queue fingerprint, remote mode/offline base, operational issue `updatedAt` и
   semantic `scope_fingerprint` из manifest. Fingerprint включает milestone
   membership, title/description/acceptance, scope-bearing attachments/
   non-receipt comments и release-blocking relations, но не status, priority,
   assignee, `updatedAt` или `ship-linear-release` receipt comments. Изменение
   одного `updatedAt` после coordinator projection не делает manifest stale.
   Base может быть exact ready head
   предшественника в stacked lane, но обязан быть rooted
   в root SHA. Если `checkout_mode=worktree` не изолирован, primary mode имеет
   другого writer-а, ancestry не сходится, база
   неожиданно изменилась или ownership конфликтует с чужими правками, не
   исправляй это разрушительно: верни `STATUS: needs-coordinator`.
4. Подтверди checkout topology и exact manifest keys: `worktree` означает
   отдельный checkout/branch, `primary` — fused root и feature branch primary;
   absolute task-owned `mutable_build_dir`, `tmp_dir`, `runtime_dir`; declared
   `cache_mode` и `cache_dir`; уникальные `ports`; explicit task-scoped `env`.
   `content-addressed` cache можно разделять только по immutable content key,
   `isolated` cache обязан быть task-owned. Временные файлы не должны утекать в
   primary checkout или worktrees соседних issue.
   Не создавай symlink/hardlink на mutable `node_modules`, tmp, cache или runtime
   другого worktree. Не запускай dependency install (`npm ci/install`, `pnpm
   install`, `yarn install` и аналоги) в feature lane: используй только заранее
   подготовленную coordinator-ом task-owned dependency tree либо read-only
   content-addressed cache с exact `cache_key`.
5. Проверь resume state и существующие issue-scoped branch/commit/ref. Resume in
   place допустим только для exact current owner/epoch/generation/token и одного
   isolated worktree. Усыновлённый stale SHA приходит как явный `ADOPTED_FROM`
   в fresh claim/ref. Продолжай с первой незавершённой стадии, не дублируй commit.

## Выполнить issue

1. Реализуй последний live scope, сохраняя детерминизм, границы domain и
   presentation, продуктовые ограничения и ownership paths. Если новый scope
   отменяет сделанное, конфликтует с ownership или требует нового
   архитектурного решения, верни `needs-coordinator`; coordinator решит,
   относится ли это к исходной issue, новой Bug или реальному user decision.
2. Добавь соразмерные regression-тесты. Для механики используй seeded
   unit/property scenarios; для UI проверь затронутый flow локально в реальном
   браузере, если она затрагивает runtime/UI.
3. Ограничивай собственный контекст: ищи через `rg`, читай только нужные
   диапазоны, группируй независимые read-only проверки и не печатай полный
   diff, comment history или длинные логи. Для UI flow предпочитай один
   детерминированный script нескольким мелким interactive steps.
   Не запускай scout/subagent: если ownership из manifest недостаточен, верни
   `STATUS: needs-coordinator` и `NEXT: SCOPE_REFINEMENT: <exact paths/reason>`.
4. Feature gate на точном будущем дереве имеет только
   `CHECK_CLASS=targeted-feature`:
   - узкие тесты затронутой области;
   - один локальный smoke затронутого flow, если применимо;
   - `git diff --check`;
   - для Markdown/docs — project-docs validator из repo instructions;
   - для code — только affected invocations реально существующих canonical
     build/test/lint/security commands из `AGENTS.md`, manifests или scripts;
   - для OKF fixtures — strict validation всего bundle, не только `wiki/`;
   - для MCP/adapter/client work — version-specific conformance exact profile,
     если он доступен и входит в scope.
   Никогда не запускай full repository suite, aggregate release command или его
   полный набор subcommands в feature lane. Даже если issue acceptance требует
   full suite, запиши эту проверку как cutoff coverage и верни
   `FULL_GATE=deferred-to-cutoff`; global gate выполняется только для sealed
   cutoff.
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
   operational `updatedAt` и semantic `scope_fingerprint`. Один изменившийся
   `updatedAt` не требует adaptation; при изменении fingerprint перечитай issue
   и примени правило адаптации выше.
2. Сопоставь actual changed/renamed/deleted/generated paths с
   `OWNERSHIP_PATHS`; diff вне разрешённого scope требует `needs-coordinator`, а не
   молчаливого захвата. Stage только issue-scoped файлы. Сделай минимальное число осмысленных
   commits с Linear identifier; release-defect fix добавляй новым commit, не
   переписывая уже опубликованный SHA. Перед `online` push fetch-ни repo-global
   coordinator ref, current `WORK_CLAIM` и guard; потребуй exact manifest
   owner/epoch/generation/token. При mismatch/unavailable не публикуй и верни
   local-only artifact. В online mode создай descendant guard acknowledgement
   через `shipctl.py metadata-commit --kind guard`: пустой metadata tree не
   содержит `.github/workflows`. Атомарно fast-forward push-ни exact feature ref плюс
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
`STATUS: needs-coordinator`.

## Вернуть bounded receipt

Верни coordinator-у только этот формат, суммарно не более 2000 символов:

```text
STATUS: ready | failed | needs-coordinator | needs-input
RUN_ID: <id>
RUN_KEY: <random >=128-bit hex>
OWNER: id=<owner_id>; epoch=<n>
CLAIM: generation=<n>; token=<opaque id>
ISSUE: <identifier> (<id>)
WORKTREE: <absolute path>
CHECKOUT_MODE: <primary|worktree>
BRANCH: <name>
BASE_SHA: <sha>
DEPENDENCY_SHAS: <ordered refs или none>
HEAD_SHA: <full sha or none>
SCOPE: start_fingerprint=<digest>; final_fingerprint=<digest>; unchanged | adapted
LINEAR_UPDATED_AT: start=<timestamp>; final=<timestamp>
RESUMED_FROM: none | branch | commit | receipt
ADOPTED_FROM: <owner/epoch/generation/ref@sha or none>
ORIGIN_REF: <branch=sha or none>
GUARD: origin:<ref=ack-sha or none>
REF_SCOPE: <origin | local-only>
SMOKE: <коротко что локально проверено>
CHECK_CLASS: targeted-feature
TARGETED_CHECKS: <короткий список exact команд/check IDs и итогов>
FULL_GATE: deferred-to-cutoff
EXECUTOR: lease=<uuid>; mode=<delegated|coordinator-inline>; fresh=yes
GAPS: <none или точная граница>
DIRTY_REMAINDER: <none или сохранённые paths внутри worktree>
DEFECT_CANDIDATE: <none или короткий summary + defect_signature>
NEXT: <none или один конкретный вопрос/блокер>
```

Не прикладывай diff, полный tool log или длинный stack trace. Если issue не
доведена до ready, не начинай другую issue. Coordinator обязан перед ingest
пропустить receipt через `shipctl.py receipt-verify`; model-level визуальная
проверка не заменяет exact ref/scope/diff verification. `needs-input` оставляй
только для уже доказанного запроса к пользователю; обычные scope, environment,
integration и defect вопросы всегда `needs-coordinator`.
