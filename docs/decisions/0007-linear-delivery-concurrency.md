# ADR-0007: repository-scoped concurrency и batch release

Статус: accepted, 2026-08-08.

## Контекст

Первый concurrency contract `ship-linear-release` надёжно ограждал shared
Git/Linear/release mutations, но оказался сложнее необходимого и имел liveness
gap. `active` coordinator claim мог бессрочно блокировать новый запуск, когда
старая Codex task уже не работала, а runtime не позволял новой session доказать
это. Single-worker flow создавал worktree, хотя при одном writer primary
checkout даёт тот же task lifecycle проще. Маленькие features могли слишком
часто закрывать cutoff и запускать дорогой full gate.

Нужен понятный контракт, который сохраняет fail-safe ownership, но делает
обычный Git flow предсказуемым и не тратит full-gate ресурсы на каждую карту.

## Решение

### Граница синхронизации

- Единица Git coordination — один repository вместе со всеми его worktrees.
- Разные repositories независимы. Возможные code conflicts между ними
  разрешаются обычным merge при их последующем объединении.
- Production publish coordination не расширяет Git mutex. Optional Site lock
  ниже является отдельной защитой одного deployment target.

### Branch и worktree topology

- Каждая Linear issue получает ровно одну текущую feature branch на claim
  generation.
- При `workers=1` root совмещает coordinator и executor и работает с feature
  branch в primary checkout. Отдельный worktree не создаётся.
- При `workers>1` каждый issue worker получает отдельный worktree и feature
  branch.
- Workers никогда самостоятельно не merge-ят и не push-ят `main`. Единственный
  integrator — coordinator; он последовательно принимает ready branches,
  разрешает конфликты и сохраняет provenance исходных feature SHAs.

### Dirty state и внешнее вмешательство

- Fresh normal start требует clean repository. Dirt — всё, что отображает
  `git status`: staged, unstaged, untracked, rename/delete и conflicts. Полностью
  claim-bound dirty worktree прежнего run допускается только как recovery
  carrier, не как normal-start exception.
- Skill не выполняет stash/reset/clean и не присваивает ранее существовавшие
  изменения. Пользователь сначала завершает, коммитит либо явно передаёт их в
  отдельный task contract, после чего preflight повторяется.
- После claim каждый разрешённый delta связан с coordinator action либо active
  worker, exact branch/worktree и ownership paths. Любое другое новое отличие
  status, HEAD или tracked ref считается внешним вмешательством.
- Внешнее вмешательство — critical stop: прекратить новые edits/commits/merges,
  gates и release; сохранить чужие bytes; workers довести только до ближайшей
  безопасной границы; дать пользователю сводное человеческое объяснение.

### Coordinator liveness

- Repo-global claim остаётся CAS/fencing authority, но не вечной reservation.
- Fresh explicit invocation автоматически reclaim-ит даже `active` owner, если
  durable vector когерентно доказывает quiescence: zero running, zero active
  lanes/live claims, no pending external action, no nonterminal/ambiguous
  gate/batch/deploy и stable expected repository snapshot. Terminal reconciled
  batch metadata owner не удерживает.
- Reclaim выполняется expected-old CAS с `epoch+1`; все известные guards
  fence-ятся до новой работы. Runtime liveness proof и timeout для этого пути не
  нужны.
- При running worker, live claim, pending effect или неоднозначном state
  автоматический reclaim запрещён. Нужны authoritative terminal evidence либо
  явное подтверждение пользователя об остановке прежнего owner, после чего
  обязательны fencing и effect reconciliation.

### Проверки и release batches

- Feature/merge boundary выполняет только targeted checks потенциально
  затронутой поверхности и `git diff --check`.
- Ready tasks последовательно накапливаются в local `main`. Full repository
  gate не запускается после каждой маленькой задачи.
- Coordinator закрывает осмысленные batch units по связности, риску, размеру,
  стоимости gate и состоянию очереди. Exact threshold или timer этим ADR не
  задаётся.
- Каждый закрытый batch проходит один full gate на exact `main` SHA, затем
  expected-old promotion, exact-SHA CI и применимый production release.
- Перед успешным завершением skill финальный batch, full gate и применимый
  release обязательны даже для одного маленького оставшегося patch.

### Optional production release lock

- Перед publish coordinator проверяет, предоставляет ли exact Site/environment
  проверяемую atomic acquire/conditional release либо CAS capability.
- При наличии capability lock хранит owner run и fencing identity, захватывается
  до первой publish mutation и освобождается matching owner после terminal
  deploy/reconciliation.
- При отсутствии capability release не блокируется; evidence фиксирует
  `release_lock=unsupported/skipped`. Plain file, comment либо marker без CAS не
  считается lock.
- Оставшийся после failure lock автоматически не удаляется. Coordinator
  reconciles deployment, объясняет состояние пользователю и выполняет
  `force-unlock` только после явного подтверждения. Если доступен fencing,
  force-unlock одновременно увеличивает epoch.

### Critical error report

Coordinator не пересылает raw subagent analysis как итог. Он тратит отдельное
время на короткий overview: что произошло, почему продолжение небезопасно, где
остановился run, что уже изменено, в каком состоянии остались Git/Linear/release
artifacts и какое минимальное действие требуется дальше.

## Последствия

- Single-worker flow дешевле: нет создания, provisioning и последующей очистки
  лишнего worktree.
- `main` имеет одного технического writer независимо от числа workers, поэтому
  merge conflicts разрешаются последовательно и наблюдаемо.
- Clean-start policy строже прежней isolated-dirty модели, зато любое видимое
  изменение имеет однозначного владельца внутри run.
- Quiescent run больше не может навсегда заблокировать repository только из-за
  недоступного runtime task lookup.
- Full gates и production releases амортизируются по заметным batches, но
  final verification не может быть пропущена.
- Site lock остаётся capability-dependent; текущая реализация не должна
  симулировать его небезопасным marker-ом.

## Не входит в решение

- Синхронизация code work между разными repositories.
- Фиксированный batch size, timer или экономическая модель gate frequency.
- Реализация cross-session mailbox либо присоединение второй session к active
  worker pool.
- Создание нового lock service внутри продукта только ради release orchestration.

## Статус реализации

На 2026-08-08 решение реализовано в repo-local `SKILL.md`, reference protocols,
`shipctl.py` и forward/regression tests. Главный liveness test проходит полный
путь clean preflight -> quiescent active takeover -> fencing ->
`resume-recovery` -> normal resume. Conformance конкретного commit подтверждает
только repository gate этого commit.

## Заменённые части ADR-0006

Этот ADR заменяет только решения ADR-0006 о single-worker worktree,
isolated-dirty primary checkout, вечном active-owner observer path и точных
маленьких cutoff triggers. Остальные решения ADR-0006 — отсутствие profiles,
acceptance-derived release scope и один coordinator на repository — остаются в
силе.
