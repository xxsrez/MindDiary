# Repository state, primary checkout и remote default

Читай этот файл на preflight/recovery и при необъяснённом изменении status,
HEAD, local/remote ref. Единица coordination — один Git repository вместе со
всеми linked worktrees. Другие repositories независимы. Цель проверки — не
угадать автора изменения, а допустить только effects, заранее связанные с
coordinator/worker action текущего run.

Repo-global claim ограждает sessions этого skill, но не блокирует сторонний
процесс. Поэтому safety строится на repo-wide snapshots, exact manifests,
ownership paths, task branches, fenced refs и expected-old CAS. PID, heartbeat,
watcher либо polling lock этого не заменяют.

## Topology primary checkout

- При `workers=1` primary checkout является task surface: coordinator
  переключает доказанно clean `main` на feature branch, исполняет issue inline,
  коммитит, возвращается на `main` и единолично интегрирует feature.
- При `workers>1` каждый issue worker использует отдельный worktree. Primary
  checkout может использовать только coordinator как зарегистрированную
  integration surface; worker его не читает и не меняет.
- В любом режиме единственный writer `main` — coordinator. Worker не merge-ит и
  не push-ит default.
- Mutable dependency/cache/build/tmp/runtime paths и ports между worktrees не
  разделяются. Разрешены только immutable content-addressed artifacts с exact
  provenance.

## Fresh preflight: только clean

`shipctl.py preflight` снимает два согласованных чтения primary checkout и всех
linked worktrees: path, branch, HEAD и porcelain status со staged, unstaged,
untracked, rename/delete и conflicts. Ignored outputs не являются source dirt,
но остаются предметом isolation checks.

Fresh normal start разрешён только при:

```text
repository_snapshot.status = clear
dirty_worktrees = 0
snapshot_errors = none
```

Любой видимый `git status` dirt блокирует initial claim. Skill не делает
stash/reset/clean, не коммитит его и не объявляет своим. Claim-bound dirty task
worktree старого run маршрутизируется только в recovery/adoption после fencing;
это не normal-start exception. Torn/unreadable/truncated snapshot также
fail-closed.

Dirty invoked skill/`AGENTS.md`/manifest/lockfile/workflow/schema/release config
особенно критичен: run не может pin-нуть непроверенный contract. Пользователю
нужно завершить, закоммитить либо отдельно передать изменения, затем полностью
повторить preflight на новом SHA.

## Active run: только зарегистрированные deltas

После claim coordinator сохраняет baseline. Перед dispatch, issue checkpoint,
ingest/merge, gate, default push, deploy/tag/Linear Done и terminal completion
он вызывает один bounded guard:

```bash
python3 .agents/skills/ship-linear-release/scripts/shipctl.py repo-guard \
  --repo <repo> --input <registered-actions.json>
```

`registered-actions.json` содержит `expected_worktrees` с exact path/branch/HEAD
для каждого linked checkout, а для каждого разрешённого dirty checkout —
absolute path, exact branch/HEAD, action UUID и ownership paths; при shared Git
boundary — exact expected local refs. Разрешение не
переносится на следующий action, branch, HEAD либо соседний path.

Guard допускает dirt только когда одновременно:

1. worktree зарегистрирован действующим coordinator/worker action;
2. branch и HEAD совпадают exactly;
3. каждый dirty path входит в ownership prefixes;
4. expected refs не сдвинулись;
5. весь repo-wide snapshot coherent.

`status=critical-stop` означает: немедленно прекратить новые edits, commits,
merges, gates и release actions; не менять неизвестные bytes; active workers
довести только до ближайшего bounded safe receipt, если это не расширяет
опасный scope. В active run это critical error, а не повод продолжить
«независимую» lane: контракт ожидает, что все изменения делает только текущий
coordinator или его executors.

Один fresh snapshot обслуживает одну natural boundary. Не опрашивай status в
tight loop. После unexpected CAS/Git failure сними один новый snapshot; два
разных чтения внутри probe означают torn state и stop.

## Remote default

Repo dirt и remote drift — разные факты. Для compact remote/default observation
используй `inspect_foreign_main.py`; helper не читает contents dirty files и не
двигает refs. Перед irreversible boundary всё равно требуется свежий exact
remote SHA и expected-old server-side CAS: check-then-push недостаточно.

### Remote fast-forward до нашего push

1. Поставь `default=drifted`, запрети старый promotion intent.
2. Получи exact remote commit в coordinator-owned namespace и классифицируй
   range/paths/control changes.
3. Пересобери local `main`/batch generation от нового remote SHA, переиграв
   topologically только compatible feature refs. Overlap получает new claim
   generation либо quarantine.
4. Новое tree получает новый validation key и один full gate. Не повторяй
   unchanged feature-local checks.
5. Только exact rebuilt candidate и passing gates снова разрешают promotion.

Если remote уже равен candidate, reconciliate фактический push вместо повтора.
Если он содержит candidate плюс новые commits, старый evidence сохраняется как
provenance, но deploy/tag/Done требуют свежей exact-head generation.

### Non-fast-forward, rewrite либо deletion

Не force-push, reset, rebase и не исправляй историю автоматически. Freeze shared
mutations, сохрани expected/observed SHAs, доведи workers до bounded receipts и
верни `needs-input` с точным resolution predicate. То же правило действует,
если drift меняет contract/security/release semantics либо scope неизвестен.

### Drift после candidate push

До deploy/tag/Done старый cutoff больше не доказывает current default: создай
новую generation и exact-head gate. Если deploy уже произошёл, сохрани его
version/deployment evidence и не rollback-и только из-за Git drift; terminal
closure всё равно ждёт восстановления Git/live alignment.

## Recovery carrier

Dirty carrier можно открыть только по exact claim/run-key/branch/worktree ID.
Для single-worker это может быть primary checkout с
`checkout_mode=primary`; для multi-worker — claim-bound task worktree. Нужны
fenced старый guard, доказанно остановленный executor, exact ownership paths,
отсутствие unmerged entries и стабильный fingerprint. Иначе carrier остаётся
нетронутым и quarantined. Не используй broad disk scan, reflog/fsck, stash или
clean.

После reconciliation повтори `repo-guard`. Normal/shared work возобновляется
только когда все текущие deltas имеют exact action bindings; quiescent reclaim
дополнительно требует полностью clean repo-wide snapshot.

## Пользовательский critical overview

Не утверждай автора недоказанного изменения. Сообщи:

```text
repository-interference; stage=<stage>; new-mutations=stopped;
worktrees=<affected>; paths=<bounded>; main=<sha/state>;
linear=<last-projected-state>; release=<not-started|state>;
required=<minimal cleanup/handoff/reconciliation action>
```

Сначала объясни обычным языком, что изменилось и почему продолжать небезопасно,
что skill уже успел сделать и в каком состоянии остались Git/Linear/release.
Raw status/helper JSON — только вторичное evidence.
