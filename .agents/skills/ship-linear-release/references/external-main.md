# Чужие изменения в primary checkout и default branch

Читай этот файл на preflight/recovery и при любом необъяснённом изменении
checkout, local default ref или remote default. Цель — не определить «какой
агент виноват» (Git этого надёжно не доказывает), а не затронуть чужую работу,
сохранить безопасный параллелизм и остановить shared release lane там, где
намерение либо blast radius неизвестны.

Coordinator ref ограждает только sessions, соблюдающие этот skill. Он не
является блокировкой для другого процесса. Не добавляй PID/heartbeat lock,
watcher или polling loop: защита строится на отдельных worktrees, pinned SHAs,
task-owned refs, expected-old CAS и проверке результата после действия.

## Разделы

- [Не трогать primary checkout](#не-трогать-primary-checkout)
- [Снять bounded snapshot](#снять-bounded-snapshot)
- [Классифицировать состояние](#классифицировать-состояние)
- [Реагировать по матрице](#реагировать-по-матрице)
- [Обработать remote drift](#обработать-remote-drift)
- [Сообщать только переходы](#сообщать-только-переходы)
- [Восстановиться](#восстановиться)

## Не трогать primary checkout

Primary checkout — worktree, в котором checked out local default branch. Он
может принадлежать пользователю или другому агенту. Coordinator никогда не
делает в нём `checkout`, `switch`, `pull`, `merge`, `rebase`, `stash`, `reset`,
`clean`, `add`, `commit`, install/build/test или исправление index lock.

Issue work, integration train, global gate и offline aggregate выполняй только
в task-owned clean worktrees с отдельными mutable tmp/cache/build/runtime
paths и ports. Не используй artifacts, index или uncommitted bytes primary
checkout как source, cache hit либо validation evidence.

Base — exact свежепрочитанный `origin/<default>` либо доказанный task-owned
descendant. Local `<default>` не является base и не обязан двигаться вместе с
remote. Default публикуй прямо из clean coordinator worktree explicit
expected-old server-side CAS; успешный push может оставить primary checkout
чистым или dirty и просто `behind` — это нормально и требует сообщения, а не
`pull`.

## Снять bounded snapshot

На preflight сохрани branch/HEAD/local default ref, remote default SHA,
porcelain status без contents и fingerprint primary checkout. Для повторяемой
read-only диагностики используй:

```text
python3 .agents/skills/ship-linear-release/scripts/inspect_foreign_main.py \
  --repo <repo> --remote origin --default <default>
```

После изменения helper прогони:

```text
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s .agents/skills/ship-linear-release/scripts -p 'test_*.py'
```

Helper использует `GIT_OPTIONAL_LOCKS=0`, не fetch-ит и не читает содержимое
dirty файлов; stdin закрыт, interactive Git prompt запрещён, каждая команда
имеет default timeout 30 секунд (`--timeout-seconds` меняет bounded limit).
`status=partial`, `relation=unknown` либо `paths_truncated=true` не разрешают
оптимистически считать scope независимым. `remote_error` и `status_error`
различают timeout/spawn/Git surface без утечки raw stderr. Untracked directory
считай prefix всей subtree при overlap check; helper не разворачивает её ради
экономии I/O.

Поля helper отображаются в receipt так: `remote_sha -> observed_sha`,
`local_default_ref -> local_default`, `fingerprint -> baseline/current`, а
`checkout_discovery + status_state + relation + dirty` дают observation/action.
`remote_status=missing`, ambiguous checkout discovery или отсутствующий remote
SHA — `unknown/stop`, не нормальный empty repository.

Helper сознательно не materialize-ит новый remote object. Если `remote_sha`
ещё отсутствует локально и relation=`unknown`, один раз получи advertised SHA
в isolated temporary object database (до claim) либо task-owned observation
namespace (после claim), не обновляя local default/remote-tracking ref, затем
докажи ancestry. Не удалось — оставь `unknown` и stop/freeze; не угадывай
`behind|ahead|diverged`.

Перепроверяй snapshot только на естественных границах:

1. preflight и recovery;
2. перед dispatch/refill, если внешний state изменился или ownership может
   пересечься;
3. перед ingest/seal и global gate;
4. непосредственно перед default action intent/CAS и сразу после push;
5. перед deploy, tag, Linear `Done` и terminal owner completion;
6. после неожиданного Git/CAS failure или явного сигнала о другой работе.

Один свежий snapshot обслуживает все действия одной границы. При новом
fingerprint сними ровно один confirming snapshot и один remote read. Если два
local snapshot различаются, это `active-unknown`; не опрашивай в цикле.

## Классифицировать состояние

Сравни paths, включая rename/delete и non-ignored untracked, с actual feature
diffs, ownership paths, `OPEN_CUTOFF`, `ACTIVE_CUTOFF` и control surfaces:

- invoked skill bundle и `AGENTS.md`;
- manifests/lockfiles/toolchain и scripts/workflows, определяющие gates;
- schemas/migrations либо generated source, влияющие на несколько lanes;
- `.openai/hosting.json`, release runbook, version/deploy/rollback config.

До первого claim dirty/untracked invoked skill contract — существующий hard
stop; dirty instruction surface тоже запрещает claim. Не коммить и не
откатывай эти файлы за пользователя. В active run изменение contract/instruction
surface останавливает новый dispatch и shared actions до tracked migration.

Храни наблюдение отдельно от решения:

```text
observation = clear | isolated-dirty | overlap | ahead | diverged |
              active-unknown | unknown
action = continue | quarantine | branches-only | freeze-shared | stop
```

`quarantine` — только scheduler state: не dispatch-и/не ingest-и affected
paths, claims и refs. Никогда не перемещай и не меняй чужие файлы.

## Реагировать по матрице

| Наблюдение | Shared lane | Issue pool |
| --- | --- | --- |
| Нет default checkout/local ref, remote default точно существует; либо checkout clean и refs ожидаемы | Продолжай normal path от exact remote. | Work-conserving refill. |
| Stable dirty/untracked, local ref `equal|behind`, paths disjoint от claims, cutoffs и control | Продолжай exact clean-worktree gate/CAS; чужие bytes исключены. | Продолжай и сообщи один раз. |
| Stable overlap только с active claims или `OPEN_CUTOFF` | Quarantine affected claims/refs; независимый cutoff можно продолжить. | Доведи affected worker до bounded receipt без ingest; refill только disjoint lanes. |
| Overlap с `ACTIVE_CUTOFF` либо release/gate/control surface | Freeze seal/global gate/default/deploy/tag/Done. | Только доказанно disjoint branches от pinned good base; иначе drain. |
| Local default `ahead` (включая clean committed work) | Не обходи вероятное unpushed intent: integration ingest/seal/global gate/default/deploy/tag/Done frozen. | `branches-only` от exact remote/good base; task-owned feature refs/receipts queued. |
| Local default `diverged` или необъяснимо сдвинулся | Freeze shared actions; не merge/rebase/reset автоматически. | Не dispatch-и новое; proven-disjoint in-flight доведи до bounded receipt, затем `needs-input`. |
| Snapshot меняется, discovery/status/ref/index/remote нельзя однозначно прочитать, remote missing либо paths truncated/unknown | `active-unknown`: stop all new mutations; не удаляй чужой lock. | In-flight workers только до bounded receipts; затем stop. |
| Dirty invoked contract/instructions до claim | Никакого claim/action intent. | Не dispatch-и; сообщи, что нужен tracked contract. |

`relation=behind` не отменяет run-level `EXPECTED_DEFAULT_SHA`: если remote
ушёл от него, сначала выполни drift/rebuild ниже. Dirty control surface до
claim разрешает лишь provably disjoint branch work; если такой issue нет,
остановись без claim/mutations.

Локальная Git/index lock не является GitHub outage и не разрешает waiver.
Сделай один bounded retry на следующей natural boundary; затем сохрани evidence
и stop/`needs-input`. Не убивай процесс и не удаляй lock другого checkout.

## Обработать remote drift

Перед каждой irreversible boundary прочитай exact remote default. Check-then-
push недостаточно: default push всё равно требует expected-old CAS.

### Fast-forward до нашего push

1. Поставь `default=drifted`, не выполняй старый action intent/push/deploy.
2. Fetch-ни exact commit в task-owned observation/train namespace, не в local
   default ref, и классифицируй range/paths/control changes.
3. Создай fresh train/cutoff generation от нового remote SHA. Переиграй
   topologically exact non-overlapping feature refs; overlapping refs
   quarantine/supersede и requeue с новой claim generation.
4. Изменившееся tree получает новый validation key и ровно один новый global
   gate. Не повторяй неизменённые feature-local checks.
5. Если drift disjoint и gates проходят — сообщи reconciliation и продолжай.

Если remote уже равен candidate, reconcile фактический push вместо повтора.
Если remote содержит candidate плюс чужие commits, candidate evidence можно
сохранить, но release/Done требуют новой exact-head generation и global gate.

### Non-fast-forward, rewrite или удаление ref

Не force-push, не reset и не пытайся «починить» историю. Freeze shared
mutations, сохрани exact expected/observed SHAs, drain workers до bounded
receipts и верни `needs-input`. То же правило действует, если remote change
меняет contract/security/release semantics или его scope нельзя доказать.

### Drift после нашего push

Если remote продвинулся после candidate push, но до deploy/tag/Linear `Done`,
старый cutoff больше не доказывает exact current default. Не deploy-и, не
тегируй и не закрывай issue: reconcile/reseal новую generation. Если deploy
уже случился, сохрани version/deployment evidence и не rollback-и только из-за
Git drift; однако `Done`/completion запрещены до восстановления exact Git/live
alignment.

## Сообщать только переходы

Никакой telemetry на каждый snapshot. Сообщай пользователю сразу при смене
disposition и один раз при продолжении:

```text
foreign-main=isolated-dirty; relation=<equal|behind>; overlap=none;
action=continue; mode=isolated; external checkout untouched/excluded; promotion=CAS

foreign-main=overlap; scope=<paths/control/issues>; action=quarantine <items>;
independent-pool=<continues|drains>; paused=<exact shared surfaces|none>

foreign-main=ahead; action=branches-only; integration=paused;
workers=proven-disjoint-from-origin; required=finish/push/move/handoff local main

foreign-main=diverged; action=freeze-shared; result=needs-input; dispatch=stopped;
workers=drain-proven-disjoint; required=resolve/handoff without altering checkout

foreign-main=active-unknown; action=stop; new-mutations=none; workers=draining-only;
required=stable readable snapshot; external checkout/lock untouched

foreign-main=reconciled; remote=<old>-><new>; generation=<id>;
reused=<refs>; rerun=affected+one-global-gate; action=continue
```

Не утверждай, кто автор изменений, если это не доказано. При successful remote
push из clean worktree отдельно скажи, что local primary checkout оставлен
нетронутым и теперь может быть `behind`.

## Восстановиться

Используй canonical order и fencing из
[crash-recovery.md](crash-recovery.md). Этот файл отвечает только за его
foreign-main substep: после exact origin refs сними fresh primary-checkout
snapshot, вычисли disposition и до CI/Sites/Linear зафиксируй affected hold.

Записывай `PRIMARY_CHECKOUT`, `INTERFERENCE` и `PROMOTION_HOLD` из
[receipts.md](receipts.md) только при обнаружении, смене policy, rebuild,
reconciliation или terminal `needs-input`; неизменный snapshot не порождает
comment. Чужой checkout никогда не является recovery source of truth.
