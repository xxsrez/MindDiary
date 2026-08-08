# Восстановление coordinator и незавершённых workers

Этот протокол применяется после interruption, restart, explicit handoff или
takeover. Его цель — продолжить с первой реально незавершённой стадии, сохранив
доказанный код и внешние effects, но не запустить второго coordinator и не
повторить default push, deploy, tag либо Linear create. Общие ownership rules
остаются в [coordination.md](coordination.md), форматы состояния — в
[receipts.md](receipts.md), чужой primary checkout — в
[external-main.md](external-main.md).

## Содержание

- [Сначала определить вид restart](#сначала-определить-вид-restart)
- [Сохранить durable HOLD и PAUSE](#сохранить-durable-hold-и-pause)
- [Войти в recovery и закрыть старые grants](#войти-в-recovery-и-закрыть-старые-grants)
- [Разрешить незавершённое external action](#разрешить-незавершённое-external-action)
- [Собрать bounded inventory](#собрать-bounded-inventory)
- [Классифицировать каждую issue](#классифицировать-каждую-issue)
- [Принять artifact из origin](#принять-artifact-из-origin)
- [Сохранить локальный commit или dirty worktree](#сохранить-локальный-commit-или-dirty-worktree)
- [Восстановить train и cutoffs](#восстановить-train-и-cutoffs)
- [Обработать позднего worker](#обработать-позднего-worker)
- [Сверить изменившийся Linear scope](#сверить-изменившийся-linear-scope)
- [Очистить только доказанно лишнее](#очистить-только-доказанно-лишнее)
- [Сообщать пользователю переходы](#сообщать-пользователю-переходы)

## Сначала определить вид restart

Remote repo-global coordinator ref остаётся единственным источником активного
ownership. Сам факт, что новая task видит `owner_id` в Git, не делает её тем же
owner.

1. `same-owner resume` разрешён без нового epoch только когда runtime предъявил
   тот же stable task/thread identity, digest которого уже записан в claim, либо
   доказал, что текущая task владеет уже активным goal с exact
   `run_id + owner_id`. Скопированный из remote UUID или текст goal не является
   доказательством.
2. Если initial claim выигран, но coordinator упал до создания goal и runtime
   не имеет stable task identity, автоматического `same-owner` пути нет. При
   полном durable-quiescent predicate новая task использует quiescent reclaim;
   иначе нужен proven-stop takeover. Не выдавай remote `owner_id` за resume token.
3. Если прежняя coordinator task ещё `running` либо её состояние неизвестно и
   durable state содержит running/live/pending/nonterminal или ambiguous
   элементы, новая session остаётся observer: никаких worktrees, worker joins,
   limit changes или external mutations. Timeout, старый timestamp, тишина
   mailbox и отсутствие PID не доказывают stop.
4. Если прежняя coordinator task authoritative terminal/archived, пользователь
   явно подтвердил её stop либо durable owner quiescent, новая task может
   начать takeover. Старые child workers не становятся её subagents.
   Для coherent zero-running execution vector, zero live claims и отсутствующих
   pending/nonterminal batch/gate/deploy новый explicit online вызов skill является достаточным
   resume intent: сразу выполни expected-old takeover CAS, не требуй от
   пользователя magic phrase или ручных Git действий. Handoff target —
   provenance; race между successors решает CAS. Поздний reconciled bookkeeping
   descendant не отменяет этот handoff: helper проверяет согласованный durable
   PAUSE/index, zero-running execution state и `PENDING_ACTIONS=none`, а не
   требует, чтобы `handoff-owner` оставался последним action.
   Для terminal/explicit-stop случая используй `shipctl.py
   recover-stale-owner --proof-kind <task-terminal|user-confirmed-stop>
   --proof-digest <sha256>`. Helper повторно доказывает zero-running,
   no-pending, coherent owner state и делает expected-old descendant CAS;
   timestamp/тишина/PID не являются допустимым proof-kind.
5. Неизвестная liveness старых workers допустима только если их manifest и
   guard refs доказывают feature-only authority. Тогда takeover сначала fence-ит
   все guards и не трогает их worktrees. Если старый contract позволял shared
   mutations либо набор grants неизвестен, остановись до подтверждения children
   или reconciliation фактических external effects.

Initial claim обязан сохранять `RELEASE_RUN.OWNER.proof` и coordinator metadata
`owner_proof_kind/digest` для доступной stable identity. Значение `none` честно
означает: после crash нужен takeover, а не небезопасное угадывание same session.

Legacy run без `run_key`/guard refs не получает выдуманный fence. Сначала докажи
stop coordinator и всех workers, reconciliate известные refs из старого ledger/
receipts и shared effects, затем назначь fresh `run_key`, epoch и claim
generations. Старые branches остаются evidence; ни один worker не продолжает их
remote publication по новому contract.

Любой nonterminal legacy coordinator ref блокирует normal/resume как collision.
Игнорируй только exact legacy tip, для которого ancestry canonical repo-global
coordinator ref содержит reconciled action `migrate-legacy-ledger` с target
`<legacy-ref>@<legacy-full-SHA>` и durable evidence доказанного stop прежнего
coordinator/workers. Другой ref, иной либо продвинувшийся SHA, missing reconcile
или одно лишь совпадение current owner proof снова блокируют mutations. Такой
checkpoint retire-ит exact legacy namespace для collision check, но не удаляет
его evidence.

## Сохранить durable HOLD и PAUSE

До reconciliation действий прочитай `HOLD_PAUSE_INDEX` и exact active records.
Не снимай их из-за restart, compaction, same-owner proof или active Goal.
`HOLD` можно lift-нуть отдельным expected-old CAS только после fresh evidence
его machine-checkable resume predicate. `PAUSE confirmation_required=yes`
требует дополнительно явное user confirmation, полученное после создания pause;
Goal auto-continuation и новый model turn подтверждением не являются. Пока
record active, recovery и read-only evidence допустимы, а affected mutation
scope остаётся закрыта; независимые lanes продолжай только по доказанному scope.
Fresh explicit вызов online `ship-linear-release` после pause считается таким
confirmation для этого run и сохраняется как invocation turn/digest; отдельный
предписанный текст не нужен. Он не заменяет невыполненный resume predicate и не
снимает unrelated scoped HOLD/PROMOTION_HOLD: takeover переносит их новому
owner, который lift-ит каждый scope только по его evidence.

`LIFECYCLE=draining|settling` не является takeover-ready. Matching same owner
получает `route=drain-owner` и завершает только протокол из
[soft-pause.md](soft-pause.md); другая session остаётся read-only. Quiescent
takeover атомарно снимает только user PAUSE и его index entry. Unrelated HOLD и
`PROMOTION_HOLD` сохраняются, даже если они перечислены в том же index.

## Войти в recovery и закрыть старые grants

1. Same owner CAS-переводит run в `recovering` с прежним epoch; takeover CAS-
   создаёт descendant owner с `epoch+1`. Запиши cause, previous/current owner,
   recovery generation и phase `fencing`. Shared integration/default/deploy/
   Linear-closure lane в этот момент заморожена.
   Для `route=takeover` это делает `shipctl.py takeover` одним idempotent
   bounded call. Не собирай takeover через generic `transition`: тот renderer
   намеренно не меняет stable owner/epoch headers и не выполняет push.
   Сразу после takeover (и на любом fresh
   `route=recover-owner|recover-owner-upgrade` с `RECOVERY phase=fencing`)
   вызови `shipctl.py fence-guards`. Upgrade-route разрешён только тому же
   runtime owner для coherent fast-forward contract migration. Helper сам
   durable-записывает exact vector intent, перечитывает raced tips, проверяет
   run/issue/generation, atomic CAS-fence-ит indexed guards и reconciles phase
   `inventory`. Не конструируй fencing shell/JavaScript snippets вручную.
   Helper принимает canonical one-field-per-line guards и ранее опубликованный
   compact layout (`RUN_ID; RUN_KEY; ISSUE`, `OWNER; CLAIM`, `FEATURE`), но
   descendant fence всегда canonicalizes metadata; иная неоднозначная legacy
   форма остаётся fail-closed.
   Fence authority берётся только из live-вектора `CLAIM_INDEX.active`.
   `CLAIM_INDEX.entries` считает также quarantined/terminal provenance, а
   terminal `CLAIM_MAP` rows остаются историей: ни то ни другое не создаёт
   guard для fencing и не должно сравниваться с числом active guards.
   Если coherent contract fast-forward появился уже после fencing, не повторяй
   fence: на `route=recover-owner-upgrade` вызови idempotent
   `shipctl.py sync-contract`, затем продолжай прежнюю recovery phase.
   Если после fencing/sync inventory содержит zero live claims/guards,
   `unresolved=none`, terminal/absent pipeline и repo-wide snapshot clean,
   немедленно вызови `shipctl.py resume-recovery`. Только его CAS переводит
   пустой recovery обратно в normal `running`; отсутствие runtime liveness API
   не является причиной оставить run зависшим.
2. До dispatch прочитай `CLAIM_INDEX`, `EXECUTION_INDEX` и bounded namespace
   guard refs текущего `run_key`. `CLAIM_INDEX` определяет authority/recovery,
   `EXECUTION_INDEX` — occupancy; live ready claim не означает running slot.
   Сверь только entries со state `running` с authoritative runtime liveness.
   Не полагайся на Linear comments.
3. До dispatch coordinator action intent сохраняет issue, executor task ID,
   worktree ID/intended branch, exact feature/guard refs и expected tips; затем
   expected-absent создаёт initial guard через `shipctl.py metadata-commit
   --kind guard` с пустым workflow-free tree и reconciled claim index. Перед spawn
   тот же bounded transition создаёт `EXECUTION_INDEX state=running`; failed
   spawn переводит entry в `stopped`. Worktree и worker появляются только после
   discovery checkpoint, поэтому crash не оставляет авторитетную работу без key.
4. Каждый online worker claim имеет отдельный guard ref, например
   `codex/release/claims/<run-key>/<issue-id>/c<generation>`. Worker публикует
   feature ref и descendant guard acknowledgement одним atomic multi-ref push с
   explicit expected-old для обоих refs. Если remote не поддерживает atomic
   multi-ref push, worker возвращает local-only commit. Coordinator записывает
   publication action intent, публикует exact feature ref, проверяет effect и
   затем descendant `ready` guard; crash между шагами восстанавливается по
   intent/ref, а stale worker remote authority не имеет.
5. При takeover продвинь каждый active guard descendant `fenced` commit-ом
   через `shipctl.py fence-guards`.
   CAS race означает: перечитай guard и связанную feature ref, запиши появившийся
   exact artifact и повтори fence от нового tip. Не requeue issue, пока все
   известные и найденные run-scoped guards не fenced.
6. После fencing late worker не может атомарно обновить старую feature ref:
   guard expected-old уже неверен. Старый ref и branch не переиспользуются новым
   claim; новый claim получает `max(generation)+1`, fresh token, guard и branch.
7. Если найден неизвестный guard/ref в exact run namespace, неоднозначный claim
   index либо worker-side shared mutation, сохрани evidence и заморозь affected
   lane. Независимые branch-only issues можно продолжать только при доказанной
   непересекаемости.

Не удаляй old guards/refs на этой стадии: они нужны как recovery evidence.

## Разрешить незавершённое external action

Pending action intent разрешается раньше adoption workers. Intent обязан
содержать `action_id`, kind, exact target, expected-before, payload digest,
queryable provider selector, external request/idempotency key и ожидаемую effect
identity. Если этих полей нет, provider-side create автоматически не retry-и.

Для `projection-batch` прочитай полный item vector из intent и reconciliate
каждый Linear comment/status item по его selector/idempotency key/digest. Одним
CAS сохрани vector terminal results; не повторяй proven applied items вместе с
failed/unknown. Feature/guard/train/cutoff/default Git refs, CI authority,
deploy/Sites/tag не являются projection items и восстанавливаются отдельными
authoritative action tickets.

Для каждого intent выбери ровно одно:

- exact effect уже существует и совпадает с payload/candidate — усынови его
  SHA/ID, запиши `reconciled`, не повторяй;
- authoritative state доказывает expected-before и отсутствие effect — выпусти
  новый action ID и повтори только bounded idempotent operation;
- фактическое состояние противоречит expected-before — пересобери/reseal от
  нового state либо quarantine affected surface;
- нельзя различить success и failure — `needs-input` для этой surface. Branch
  work может продолжаться, если не зависит от неё, но default/deploy/closure
  остаются заморожены.

Для первого Linear comment create intent заранее сохраняет container ID, exact
marker, payload digest и selector. После timeout/restart выполни один bounded
exact-marker lookup в правильном issue/milestone:

- один match — сохрани его comment ID и продолжи update этого ID;
- ноль matches и connector даёт exhaustive consistent read — create разрешён
  только новым action ID;
- ноль при неясной consistency либо больше одного — не создавай ещё один
  comment; заморозь эту запись и сообщи ambiguity.

Так же обрабатывай Bug create: selector включает team/project, source issue и
`defect_signature`, поэтому созданный, но ещё не linked Bug не выпадает из
dedupe. Default CAS сверяется по exact SHA; deploy — по exact artifact digest,
version/deployment ID и target Site; tag — по immutable name+SHA.

## Собрать bounded inventory

Собирай факты в таком порядке и сохрани один inventory digest:

1. coordinator ledger, owner/epoch, claim/execution/guard/comment/hold/gate
   indexes и pending action/projection batch;
2. authoritative runtime state exact coordinator/worker task IDs — только для
   liveness, не как доказательство кода;
3. exact origin guard/feature/train/cutoff/default refs и annotated tags;
4. exact `gatectl.py status` для indexed `GATE_RESULT` keys и atomic artifacts;
5. fresh foreign-main snapshot по [external-main.md](external-main.md);
6. CI/checks exact SHA и Sites artifact/version/deployment exact digest;
7. live Linear semantic `scope_fingerprint`, operational `updatedAt`, states,
   comments и links;
8. task-owned local refs/worktrees из `git worktree list --porcelain` и exact
   branch names; caches — только если они имеют проверяемый artifact ID.

`run_key` — отдельный случайный минимум 128-bit non-secret hex identifier,
сохранённый в `RELEASE_RUN`; его не сокращай и не выводи из human slug. Все
task-owned remote refs содержат exact `run_key`, а их полные строки сохранены в
ledger. Сначала проверяй refs из `CLAIM_INDEX`. Fallback — только bounded
`ls-remote` exact run namespace и issue identifier; не усыновляй произвольные
`codex/*` branches.

Branch name, commit time, author, Linear state или «самый новый ref» сами по
себе ничего не доказывают. Для каждого кандидата сохрани exact SHA/tree,
ancestry от recorded base/dependencies, actual changed paths, ref/guard tips и
relation к train/default. Несколько несовместимых candidates — quarantine, не
выбор по времени.

## Классифицировать каждую issue

После inventory каждой nonterminal claim назначь disposition, отдельно сверив
`EXECUTION_INDEX` и integration state. Только verified `running` reattach-ится и
занимает slot; `feature_ready` не получает нового executor и сразу остаётся в
ingest queue, хотя guard/claim ещё live.

| Disposition | Когда | Действие |
| --- | --- | --- |
| `reattach` | same owner/epoch/claim и runtime доказывает, что exact worker продолжает работу | Не создавай дубль; жди bounded receipt. |
| `adopt-ready` | exact receipt/ref/guard согласованы либо stale artifact полностью перепроверен | Ingest один раз; после takeover сначала новый claim generation. |
| `resume-origin` | origin содержит coherent checkpoint/commit, но ready evidence неполно | Новый generation/ref от exact SHA; выполни недостающую реализацию и gates. |
| `resume-local-commit` | task-owned local branch содержит unique committed SHA | Защити exact SHA recovery ref-ом, проверь и перенеси в новый claim. |
| `resume-worktree` | dirty progress принадлежит exact stopped worker и только ownership paths | Fresh generation branch в том же isolated worktree после fingerprint check. |
| `already-integrated` | exact artifact уже представлен structured train/default commit-ом | Reconcile receipts; worker/ingest не повторяй. |
| `requeue-clean` | пригодного доказанного artifact нет | Supersede old claim; fresh worktree от recorded safe base. |
| `quarantine` | liveness, provenance, scope, paths или candidates неоднозначны | Не трогай carrier; продолжай только независимые issues. |

Claim generation монотонна внутри `run_id:issue_id` и никогда не сбрасывается
на новом epoch. Старый receipt — только evidence о SHA/checks, не authority.

## Принять artifact из origin

1. Начни с exact feature ref и guard tip из claim ledger. Ref без matching
   receipt — checkpoint candidate, не готовая feature.
2. Проверь full SHA/tree, expected base/dependency ancestry, actual diff против
   ownership paths, live semantic `scope_fingerprint`, отдельно operational
   `updatedAt` и отсутствие shared mutation. Изменение одного `updatedAt` из-за
   projection не invalidates scope.
3. Если owner/epoch/generation/token всё ещё current и terminal worker receipt
   согласован, можно принять exact SHA normal path один раз.
4. После takeover либо supersede старого claim создай новый generation с fresh
   guard/branch. Старую ref не двигай. Создай новый ref на тот же validated SHA
   expected-absent; если работа ещё нужна, новый worker добавляет descendant
   commits. Не cherry-pick-и без необходимости: сохранение exact SHA упрощает
   provenance.
5. Повтори только targeted scope-sensitive и реально недостающие feature checks;
   full gate оставь `deferred-to-cutoff`. Результат
   старого validation можно reuse только при exact validation key и неизменной
   среде/acceptance. Новый `FEATURE_RECEIPT` указывает `ADOPTED_FROM` с old
   owner/epoch/generation/ref/SHA.
6. Если origin branch появилась после первого inventory, но guard уже fenced,
   проверь acknowledgement ordering. Exact atomic ack до fence — обычный stale
   artifact; ref без допустимого ack — quarantine как protocol violation.

## Сохранить локальный commit или dirty worktree

Локальный carrier — последний по authority, но может быть единственной копией
незаконченной работы.

1. Ищи только worktree/branch/worktree ID из claim action ledger либо exact
   `run_key` namespace. Не сканируй весь диск. Primary checkout допустим как
   carrier только для exact claim-bound single-worker `checkout_mode=primary`;
   любой другой dirt в нём — critical stop, а не recovery artifact.
2. Clean committed SHA защити task-owned local recovery ref-ом до любых branch
   changes. Проверь object existence, ancestry, diff/path ownership и отсутствие
   незаписанных изменений. Новый owner переносит SHA в fresh generation; old
   branch остаётся evidence.
3. Dirty/staged/untracked progress разрешено продолжить в том же worktree только
   когда exact worker доказанно stopped, worktree isolated, нет unmerged entries,
   submodule/nested-repo ambiguity и все paths входят в ownership. Сними
   fingerprint `HEAD + index + worktree + untracked path/mode/size digest`,
   включая bounded content hash каждого разрешённого untracked файла; слишком
   большой/меняющийся carrier quarantine-ится. Создай fresh generation branch
   без reset/stash, затем проверь тот же fingerprint.
4. Если worker liveness unknown, не открывай и не меняй его dirty worktree.
   Quarantine carrier и requeue issue в новом worktree либо жди authoritative
   stop. Никогда не запускай двух writers в одном worktree.
5. Untracked secret-like/generated/cache content не публикуй автоматически.
   Path вне ownership, conflict marker, missing object либо changing fingerprint
   переводит carrier в quarantine; не лечи reset/clean/stash.
6. Если worktree исчез, но exact committed ref существует, создай новый clean
   task-owned worktree. Если не осталось ни ref, ни commit, progress недоказан —
   `requeue-clean`, а не broad reflog/fsck search.

## Восстановить integration head и cutoffs

Каждый sealed cutoff имеет immutable ref
`codex/release/cutoff/<run-key>/<cutoff-id>/g<generation>` на exact candidate:
remote online либо task-owned local при explicit offline mode. Создай его
expected-absent до global gate. Existing same-name/same-SHA ref усынови;
existing different SHA замораживает cutoff. Local cutoff остаётся
`locally-integrated` и не разрешает default/Done. Moving local `main` не является
границей active cutoff.

Feature ingest — двухфазный переход:

1. coordinator action intent до integration ref/main update хранит expected
   head, prepared successor SHA, feature/ref/claim, resulting ordered membership
   digest и выбранную meaningful batch boundary;
2. registered exact-HEAD merge в local `main` выполняет Git effect;
3. coordinator перечитывает integration head. Successor означает accepted feature,
   даже если Linear update не случился; old head означает, что push не случился;
   другой head требует ordered structured-commit reconciliation;
4. только после Git reconciliation upsert-ни projections в `RELEASE_RUN`,
   `FEATURE_RECEIPT` и cutoff comment. Missing comment не откатывает merge и не
   меняет membership.

Structured integration commit обязан хранить issue ID, original feature SHA/ref,
claim generation, dependency SHAs и membership sequence. Поэтому recovery
восстанавливает OPEN membership из integration commits, ACTIVE boundary — из immutable
cutoff ref, затем сверяет comments. Latched pending trigger восстанавливай по
exact local main head и membership digest/count; после terminal ACTIVE cutoff seal-ни
его раньше late ingest.

Для каждого indexed `GATE_RESULT` сначала вызови `gatectl.py status` по exact
cutoff/generation/candidate/environment/ordered-plan key. Atomic terminal pass/fail
усынови и запиши в coordinator ledger; running process не дублируй. Compaction
или lost handle не разрешают rerun terminal result. `interrupted` продолжай тем
же exact request только если `status` доказал отсутствие owner lock.
Unknown/absent artifact при unknown process liveness freeze-ит gate до
reconciliation; новый key создаётся только новой sealed generation/validation
key. External CI/Sites effect усыновляй только по exact IDs/key.

Разрешай recovery в порядке: active HOLD/PAUSE -> pending authoritative action
или item-wise projection batch -> `GATE_RESULT` -> ACTIVE cutoff -> latched
pending seal -> OPEN cutoff -> claims. Pool можно снова наполнить после phase
`adopting`, если shared action разрешён и branch scope независим; occupancy бери
только из verified `EXECUTION_INDEX state=running`.

## Обработать позднего worker

- Worker старого epoch/generation после guard fence прекращает publication и
  возвращает local-only SHA/status. Его сообщение не двигает pipeline.
- Если stale worker успел выполнить atomic publish до fence, recovery видит
  guard acknowledgement и exact SHA; artifact можно усыновить по обычной
  процедуре. После validation переведи execution в `feature_ready`, освободи
  slot и refill-ни до ingest; claim/guard оставь live до disposition.
- Если он изменил feature ref без guard acknowledgement либо любую shared
  surface, заморозь affected lane и reconciliate факт. Не повторяй уже
  произошедший effect и не называй receipt нормальным.
- Late artifact не отменяет уже начатую новую реализацию автоматически. Если
  оба candidates различаются, quarantine и выбери только по scope/evidence,
  никогда по времени. Если exact SHA совпадает, deduplicate provenance.

## Сверить изменившийся Linear scope

Live Linear определяет, надо ли issue продолжать, но не стирает Git/external
evidence.

Сравни semantic `scope_fingerprint` (milestone membership, title/description/
acceptance, scope-bearing attachments/non-receipt comments и release-blocking
relations) отдельно от operational `updatedAt`, status/priority/assignee и
`ship-linear-release` receipt comments. Coordinator projections могут менять
`updatedAt` без requeue; changed fingerprint требует adaptation, quarantine
либо fresh claim.

- `Canceled`/`Duplicate` или удаление из milestone запрещает новую интеграцию;
  supersede claim и сохрани artifact как retired evidence.
- `Done` с exact terminal batch/default evidence — `already-integrated`.
- Issue, которая стала `Done` во время run при active claim/ready artifact, но
  без terminal delivery evidence, не исчезает молча из recovery. Попробуй
  доказать acceptance на current default; иначе quarantine эту issue как
  external scope change, оставь run/goal незавершённым и не переоткрывай без
  однозначного tracked решения. Независимую работу при этом продолжай.
- Issue, уже бывшие terminal до initial run и не имеющие run artifacts, не
  становятся задним числом scope run.
- Изменившийся unfinished scope получает новый claim generation; если old
  artifact несовместим, не интегрируй его частично по предположению.

## Очистить только доказанно лишнее

1. Во время recovery ничего не удаляй. Сначала durable adoption, supersede или
   retirement record.
2. Перед `Done`/cleanup terminalize-ни exact current guard по `receipts.md`:
   terminal disposition/evidence уже durable; direct `ready -> terminal`
   допустим только при доказанно terminal executor, unknown/taken-over требует
   `fenced -> terminal`. CAS race возвращает artifact в inventory.
3. Original feature SHA после cherry-pick может не быть ancestor default.
   Cleanup разрешён также когда reachable integration commit и terminal batch
   receipt явно связывают original SHA/ref с принятым content; одной похожести
   patch недостаточно.
4. Clean failed/superseded artifact удаляй только если ledger доказывает, что в
   нём нет unique required work, executor terminal/stopped либо old grant прошёл
   `fenced -> terminal`, и exact ref tip не изменился. Remote delete — exact-old CAS.
5. Dirty/quarantined carrier или единственную копию unpublished commit не
   удаляй автоматически. Оставь bounded path/ref и причину пользователю.
6. Перед terminal cleanup повтори bounded scan exact `run_key` feature/guard
   namespace. Unknown worker liveness блокирует delete, пока guard не terminal;
   terminal guard не даёт compliant late worker создать ref после cleanup.
7. Retired evidence refs не считаются active work и не блокируют goal, если
   ledger доказывает terminal disposition и отсутствие required unique work.
   Unresolved quarantine либо manual `Done` без delivery evidence не являются
   retirement и блокируют terminal release/goal.

После всех disposition сначала вызови `shipctl.py cleanup-plan` и сохрани exact
`plan_digest`. Передай неизменённый JSON в `cleanup-apply`: helper повторно
читает coordinator/default/worktree state и применяет только совпадающий fresh
plan. Он удаляет только clean task worktree с claim-bound `codex/*` branch и
HEAD, достижимым из remote default, причём coordinator уже terminal и live
claims отсутствуют; dirty, active, unmerged и unpublished carrier всегда
остаются. Branch/ref deletion — отдельное fenced действие и не входит в
worktree cleanup.

## Сообщать пользователю переходы

Пиши только содержательные сообщения, не heartbeat:

```text
resume-in-place; owner=same; epoch=<n>; recovery=<action/cutoff/claims>;
shared-lane=<open|paused>

already-running; owner=<id>; epoch=<n>; action=observer-only;
next=continue-old-or-confirm-stop

takeover-started; old-owner=<id>; new-owner=<id>; epoch=<n>;
old-guards=<fenced/quarantined>; shared-actions=paused

recovery-inventory; reattached=<n>; adopted=<n>; origin-resume=<n>;
local-resume=<n>; requeued=<n>; quarantined=<n>

artifact-adopted; issue=<id>; old=<epoch/generation/ref@sha>;
new=<epoch/generation/ref@sha>; repeated-mutation=none

recovery-paused; id=<hold/pause-id>; scope=<default|deploy|linear|worker|shared>;
reason=<exact>; confirmation=<required|not-required>;
independent-work=<continuing|paused>

recovery-complete; epoch=<n>; pool=<running/sustained>; open-cutoff=<id|none>;
pending-seal=<id@head|none>; shared-lane=<open|held:id:reason>
```

При critical stop сначала сведи факты в пользовательский overview: причина и
опасность продолжения, текущая recovery stage, уже сделанные effects, состояние
`main`/feature branches/worktrees/Linear/release и минимальное действие дальше.
Raw worker/helper output — только приложение, не итоговое объяснение.

Если current skill bundle untracked/dirty-only относительно сохранённого
contract source, normal preflight остаётся fail-closed: эта recovery procedure
служит планом, но mutable run начнётся только после отдельного tracked commit.
