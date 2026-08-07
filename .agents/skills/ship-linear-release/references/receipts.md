# Квитанции, ownership и восстановление

Remote repo-global coordinator ref — единственный источник активного ownership.
Linear comments — компактные durable checkpoints, а не lock, lease или журнал.
Coordinator создаёт и изменяет comments; workers возвращают данные для upsert.
Используй UTC ISO-8601, full Git SHAs и exact opaque IDs. Не записывай
credentials, bearer tokens, authorization headers, secret/env values,
временные archive paths, полные логи или приватные browser state.

## Разделы

- [Idempotent upsert](#idempotent-upsert)
- [Repo-global coordinator claim](#repo-global-coordinator-claim)
- [`RELEASE_RUN`](#release_run)
- [`WORK_CLAIM`](#work_claim)
- [`CLAIM_GUARD`](#claim_guard)
- [`FEATURE_RECEIPT`](#feature_receipt)
- [`DEFECT_CANDIDATE`](#defect_candidate)
- [`BATCH_RELEASE_RECEIPT`](#batch_release_receipt)
- [Восстановление](#восстановить-после-прерывания)

## Idempotent upsert

Каждый comment начинается с устойчивого маркера:

```text
<!-- ship-linear-release:<KIND>:<KEY> -->
SCHEMA: 1
KIND: <KIND>
KEY: <KEY>
```

Перед первым create сохрани action intent с container ID, exact marker, payload
digest и provider selector. Найди exact marker и обнови тот же comment по его
ID; не создавай второй основной comment. Только session, владеющая актуальным
coordinator epoch, пишет comments; проигравший initial CAS не пишет вообще.
При новой generation обнови поля `GENERATION` и `SUPERSEDES`; отдельный дефект
сохраняй своим `DEFECT_CANDIDATE`. Если connector не позволяет безопасный
update, верни `needs-input`, а не размножай receipts.

`RELEASE_RUN` и `BATCH_RELEASE_RECEIPT` храни комментариями exact milestone;
`WORK_CLAIM`, `FEATURE_RECEIPT` и issue-specific `DEFECT_CANDIDATE` —
комментариями соответствующей issue. После первого create сохраняй comment ID
в reconciled coordinator-ref commit как `<KIND>:<KEY>=<comment_id>`; следующие
записи обновляют exact ID. `RELEASE_RUN.COMMENT_INDEX` хранит digest/count и
свой ID. Если crash случился до сохранения ID, recovery делает один bounded
exact-marker lookup по action selector: один match усыновляет, доказанный ноль
разрешает новый create action, ambiguity fail-closed. Полная процедура — в
[crash-recovery.md](crash-recovery.md).
Remote ref и external exact IDs авторитетнее comment при расхождении.

Normal path допускает один create и только содержательные state-transition
updates каждого key. Не обновляй receipt для poll, начала shell command,
неизменившегося heartbeat или промежуточного лога. После сохранения comment ID
не перечитывай весь comment history без recovery-причины, scope change или
ошибки update. Несколько полей одного checkpoint записывай одним upsert.

## Repo-global coordinator claim

Используй ровно один ref на весь repository, независимо от milestone и числа
workers:

```text
refs/heads/codex/release/coordinator
```

Не подставляй milestone name, slug или ID в этот ref. Это repo-wide mutex для
общих default branch, integration train, CI, Sites и Linear release state.
Разные repositories координируются независимо.

Первое mutable действие нового run — metadata commit с неизменённым source tree
и его conditional push в этот ref. Commit содержит как минимум `run_id`,
случайный минимум 128-bit `run_key`, exact `project_id`/`release_id`, случайный
`owner_id`, owner-proof kind/digest, монотонный `owner_epoch`, contract source/
digest, claim/comment indexes и полный текущий action intent. Если ref
отсутствует, создай его non-force; если существует terminal ledger, добавь
descendant commit. При гонке только один exact expected-old update может
победить. Проигравшая session fetch-ит winner и прекращает все мутации.

До каждого shared external action — Linear claim/state/comment, integration-ref
update, default push, deploy/tag или Linear closure — сначала продвинь ref новым
descendant action-intent commit от exact observed old SHA. Используй server-side
expected-old lease и отдельно докажи ancestry; это CAS, а не разрешение
переписывать историю. Один action ticket покрывает одну bounded idempotent
операцию или явно перечисленную атомарную группу, а не произвольный этап run.
Intent хранит expected-before, external request/idempotency key, queryable
provider selector, payload digest и expected effect identity; без них
неразличимый provider-side create нельзя retry-ить.
После interruption recovery сначала выясняет, был ли intent исполнен, и не
повторяет external effect по предположению.

`owner_epoch` меняется только при новом owner/handoff/takeover. Старый owner,
worker manifest, claim token или receipt другого epoch не имеют authority, но
epoch сам по себе не закрывает race после worker precheck. Online publication
feature ref обязана атомарно продвинуть отдельный claim guard; takeover сначала
fence-ит indexed/run-scoped guards по [crash-recovery.md](crash-recovery.md).
Heartbeat/stale timestamp сам по себе никогда не разрешает takeover: Git,
Linear и Sites не умеют отклонять уже начатый effect по fencing token. Новая
session может CAS-войти в `recovering` только после явного handoff либо
подтверждения пользователя, что прежняя task остановлена; если runtime умеет
проверить task state, сначала подтверди, что она больше не running. До
reconciliation из `recovering` запрещены dispatch, integration, default,
deploy/tag и Linear closure.

При migration найди legacy refs вида
`refs/heads/codex/release/<milestone>/coordinator`. Не создавай repo-global claim,
пока любой legacy run может быть активен. После доказанного stop/terminal state
перенеси его фактический ledger одним migration checkpoint; не объявляй старые
artifacts недействительными и не позволяй двум namespaces владеть run.

## RELEASE_RUN

Key: `<release_id>`.

```text
STATUS: claiming | recovering | running | validating | offline-queue |
        publishing | deploying | stabilizing | checkpoint | complete |
        needs-input
RUN_ID: <stable id>
RUN_KEY: <random >=128-bit hex, never shortened>
GOAL: current=<goal id/objective fingerprint|none>; supersedes=<old goal id|none>
CONTRACT: source_sha=<full>; digest=<hash>; migrated_from=<hash|none>
OWNER: id=<uuid>; epoch=<n>; state=<active|handoff-ready|complete|aborted>;
       terminal_reason=<none|released|aborted-before-run:<reason>>;
       proof=<runtime-task-id|goal-bound|none>:<digest|none>
COORDINATOR_REF: refs/heads/codex/release/coordinator=<commit>
ACTION: seq=<n>; id=<uuid>; kind=<bounded>; target=<exact>;
        expected_before=<exact>; request_key=<id|none>; selector=<bounded>;
        payload_digest=<hash>; effect_identity=<exact>; status=<intent|reconciled>
COMMENT_INDEX: release_run=<comment id|none>; entries=<n>; digest=<hash>
CLAIM_INDEX: active=<issue:g@guard-scope:guard@feature-scope:feature@worktree-id|none>;
             entries=<n>; digest=<hash>
RECOVERY: generation=<n>; cause=<resume|handoff|takeover|migration>;
          phase=<fencing|inventory|reconciling-actions|adopting|complete|needs-input>;
          previous_owner=<id/epoch|none>; inventory=<digest|none>;
          reattached=<ids>; adopted=<ids>; requeued=<ids>; quarantined=<ids>;
          unresolved=<ids|none>
PROJECT_ID: <id>
RELEASE_ID: <id>; name=<name>
SCOPE_LEDGER: initial=<digest>; observed=<digest>; run_artifacts=<issue ids/count+digest>
PROFILE: design | build | release; evidence=<tracked facts>
DEFAULT_BRANCH: <name>; observed_sha=<full>
PRIMARY_CHECKOUT: default_checked_out=<yes|no>; head=<sha|none>;
                  local_default=<sha|none>; baseline=<fingerprint>
INTERFERENCE: none | generation=<n>;
              observation=<isolated-dirty|overlap|ahead|diverged|active-unknown|unknown>;
              relation=<absent|equal|behind|ahead|diverged|unknown>;
              dirty=<clean|tracked|untracked|both|unknown>; fingerprint=<hash>;
              paths=<bounded list|count+digest>; overlap=<none|claims/issues/control/unknown>;
              remote=<expected>-><observed>/<same|ff|contains-candidate|non-ff|unknown>;
              action=<continue|quarantine|branches-only|freeze-shared|stop>;
              rebuild=<cutoff:generation@base|none>
PROMOTION_HOLD: <none|foreign-main:<bounded reason>>
WORKERS: requested=<1|N|auto|auto(max=N)>; effective=<n>;
         coordination=<inline|dedicated|hybrid>; reason=<bounded>
CAPABILITIES: available=<bounded>; not_available=<bounded>
PIPELINE: open_cutoff=<id|none>; active_cutoff=<id|none>;
          train_ref=<ref|none>; train_head=<sha|none>;
          cutoff_ref=<immutable ref=sha|none>
OPEN_CUTOFF: none | id=<id>; generation=<n>; accepted_count=<n>;
             first_eligible_at=<utc>; cutoff_size=<n>; max_wait_at=<utc>;
             pending_trigger=<none|reason@utc>
HEALTH: default=<unknown|healthy|pending|drifted|known-bad|stabilizing>;
        last_known_good=<sha>; known_bad=<sha|none>;
        dispatch=<open|good-base-only|stabilization-only|frozen>;
        integration=<open|validating|publishing|frozen>
OFFLINE_QUEUE: base_origin=<full>; aggregate_ref=<task-owned ref>;
               aggregate_head=<full>; cutoffs=<ordered ids> | none
LAST_REMOTE_ATTEMPT: at=<timestamp>; result=<success|technical-failure>; next_eligible=<timestamp>; reason=<bounded> | none
QUEUE_FINGERPRINT: <hash>
STARTED_AT: <timestamp>
LAST_TRANSITION_AT: <timestamp>
NEXT: <одно действие или none>
```

Remote coordinator ref обеспечивает ownership; milestone comment только
объясняет его. После `complete` сохрани ref как ledger; новый run или milestone
продолжает тот же ref descendant commit-ом. Не используй wall-clock heartbeat
как lease и не обновляй его в цикле ожидания.

`OWNER.state=complete` ставь terminal CAS commit-ом только после отсутствия
in-flight action/worker/cutoff и полного done evidence. Ref не удаляй: он нужен
как expected-old ledger следующему run.

`OWNER.state=aborted` не является release completion. Он допустим только после
initial claim, когда не создан goal, Linear/worktree/worker/cutoff и не было
shared external effect; terminal reason и отсутствие effects запиши CAS commit-ом.

`open_cutoff` может принимать новые ready refs, пока отдельный `active_cutoff`
проходит global gate/publish. Ровно один active cutoff владеет default/deploy
lane. `HEALTH` управляет независимо issue dispatch и integration: freeze
integration не обязан останавливать безопасную работу в изолированных branches.

Feature ingest — двухфазный cross-system переход: coordinator action intent
сначала фиксирует expected/successor train heads, membership и latched timer;
после expected-old train push origin определяет, случился ли Git effect, а
Linear receipts становятся projection. Ordered membership восстанавливается из
structured train commits; missing comment не откатывает train и не сбрасывает
deadline. Детали — в [crash-recovery.md](crash-recovery.md).

`PRIMARY_CHECKOUT` — read-only baseline, не recovery artifact. `INTERFERENCE`
обновляй только при обнаружении/смене disposition, rebuild, reconciliation или
terminal `needs-input`, не при неизменном snapshot. Не записывай file contents.

## WORK_CLAIM

Key: `<run_id>:<issue_id>`.

`CLAIM.generation` монотонна внутри `<run_id>:<issue_id>`: начни с `1` и
увеличивай при каждом supersede/requeue/repair/takeover. Новый owner сначала
находит максимальную generation в claim/receipts и использует `max+1`; epoch
никогда не сбрасывает generation, а token всегда новый.

```text
STATUS: active | released | superseded | retired
RUN_ID: <id>; RUN_KEY: <random >=128-bit hex>; OWNER: id=<uuid>; epoch=<n>
CLAIM: generation=<n>; token=<opaque non-secret id>
PROJECT_ID: <id>
RELEASE_ID: <id>
ISSUE: <identifier>; <id>; updated_at=<timestamp>
EXECUTOR: kind=<agent|coordinator-inline>; task_id=<stable id|unknown>;
          runtime_state=<running|terminal|unknown>
ROOT_BASE: sha=<full>; tree=<oid>; origin_default=<full>
BASE: sha=<full>; class=<current-default|last-known-good|stabilization>;
      dependency_shas=<ordered refs или none>
REMOTE_MODE: <online|offline-local-only>
FEATURE_REF: scope=<origin|local-only>; ref=<branch/ref или none>;
             expected_old=<zero|sha>
GUARD_REF: scope=<origin|local-only>; ref=<exact>; tip=<sha>;
           publish=<atomic-online|coordinator-only>
WORKTREE: id=<uuid>; branch=<exact>; path_hint=<basename>; head_at_dispatch=<sha>
CHECKPOINT: state=<none|local-commit|origin-checkpoint|ready>;
            head=<sha|none>; ref=<exact|none>; at=<utc|none>
RECOVERY: disposition=<none|reattach|adopt-ready|resume-origin|resume-local-commit|
          resume-worktree|already-integrated|requeue-clean|quarantine|retired>;
          artifact=<sha|none>; adopted_from=<owner/epoch/generation/ref|none>
RETIREMENT: none | reason=<canceled|duplicate|scope-removed|adopted|discarded-no-unique-work>;
            evidence=<bounded>; unique_work=<none|preserved>; authority=<contract|user>
OWNERSHIP_PATHS: <компактный список>
TARGET_CUTOFF: <id|next-open>
QUEUE_FINGERPRINT: <hash>
CLAIMED_AT: <timestamp>
LAST_TRANSITION_AT: <timestamp>
NEXT: <одно действие или none>
```

Один статус `In Progress` не заменяет claim. Branch включает random full
run-key/epoch/claim suffix, например
`codex/<identifier>-<slug>/r<run-key>-e<epoch>-c<generation>`; полная ref строка
сохраняется в ledger. Receipt принимается только при exact
`RUN_ID + OWNER.id + OWNER.epoch + CLAIM.generation + CLAIM.token`. Старый result можно
использовать лишь как неавторитетный artifact после recovery и повторной
проверки exact SHA. Stale timestamp сам по себе не разрешает захват.

## CLAIM_GUARD

Это Git ledger одной claim publication, не Linear comment: remote в online
mode, task-owned local в explicit offline mode. Exact ref:
`refs/heads/codex/release/claims/<run-key>/<issue-id>/c<generation>`.

```text
STATE: claimed | checkpoint | ready | fenced | terminal
RUN_ID: <id>; RUN_KEY: <hex>; ISSUE: <id>
OWNER: id=<uuid>; epoch=<n>; CLAIM: generation=<n>; token_digest=<hash>
FEATURE: ref=<exact>; expected_old=<zero|sha>; head=<sha|none>
CHECKS_DIGEST: <hash|none>
PREVIOUS_GUARD: <sha|none>; UPDATED_BY: <coordinator|executor task id>
TERMINAL_REASON: <integrated@cutoff|superseded|retired|none>;
TERMINAL_EVIDENCE: <batch/retirement key|none>
```

Initial `claimed`, worker acknowledgement и coordinator `fenced|terminal`
всегда являются descendant metadata commits с неизменным guard tree; guard ref
не переписывается.
Worker обновляет `feature ref + guard ref` одним atomic multi-ref expected-old
push. `ready` acknowledgement не заменяет bounded worker receipt/check review,
но делает published SHA discoverable. Takeover считает grant закрытым только
после `fenced`; cleanup — после `terminal`. Coordinator terminalize-ит exact
current guard tip только после durable feature/batch/retirement disposition:
из `ready` напрямую, если terminal worker receipt/liveness доказаны, либо
обязательно после `fenced`, если executor был unknown/taken-over. Terminal
commit повторяет exact feature head/checks digest и evidence key. CAS race
требует нового inventory; `Done` и cleanup выполняются только после terminal.

## FEATURE_RECEIPT

Key: `<run_id>:<issue_id>:<claim_generation>`.

```text
STATUS: ready | failed | needs-input | superseded | retired
GENERATION: <n>
RUN_ID: <id>; RUN_KEY: <random >=128-bit hex>; OWNER: id=<uuid>; epoch=<n>
CLAIM: generation=<n>; token=<opaque non-secret id>
ISSUE: <identifier>; <id>; scope_updated_at=<timestamp>
ROOT_BASE: sha=<full>; tree=<oid>
BASE: sha=<full>; tree=<oid>
DEPENDENCIES: <ordered issue=sha@origin_ref или none>
FEATURE: sha=<full>; tree=<oid>; ref=<origin|local-only>:<ref=sha>
GUARD: scope=<origin|local-only>; ref=<exact>; acknowledgement=<sha|none>
OWNERSHIP_PATHS: <компактный список>
AFFECTED_SURFACES: <domain/ui/build/docs/...>
CHECKS: <affected commands и pass/fail; без полного лога>
RUNTIME: <проверенный local/UI/protocol flow или none>
GAPS: <точная граница или none>
DIRTY_REMAINDER: <сохранённые чужие paths или none>
INTEGRATION: <queued|accepted@cutoff|excluded|none>
SUPERSEDES: <предыдущий feature SHA/comment id или none>
ADOPTED_FROM: <owner/epoch/generation/ref@sha или none>
NEXT: <одно действие или none>
UPDATED_AT: <timestamp>
```

`ready` доказывает feature-scoped результат, но не full integrated gate,
production readiness или право менять external state.

`GAPS` различает `not-available` и известный fail. Недоступная external
platform, cloud binding, real client/browser/device или trace остаётся честным
gap. Она блокирует `ready` только когда live acceptance прямо требует это
evidence; в остальных случаях не заявляй проверенную совместимость. Известный
воспроизведённый дефект gap-ом не маскируй.

## DEFECT_CANDIDATE

Key: `<run_id>:<cutoff_id|pre-integration>:<generation>:<defect_key>`.

```text
STATUS: open | fixing | excluded | reverted | resolved | rolled-back
RUN_ID: <id>; RUN_KEY: <random >=128-bit hex>; OWNER: id=<uuid>; epoch=<n>
CUTOFF: <cutoff_id|pre-integration>; generation=<n>
CANDIDATE: sha=<full>; tree=<oid> | none(pre-integration)
DEFECT_SIGNATURE: <surface|symptom|repro-or-invariant|expected-vs-actual>
FOUND_AT: preflight | integrated-gate | ci | live-smoke
SIGNAL: <короткий failing check/наблюдение>
ATTRIBUTION: <issue/ref | cross-feature | unknown>
DECISION: tiny-direct-fix | reopen-feature | new-linear-bug | freeze | stabilize
ACTION: <fix/exclude/revert/rollback/block>
SCHEDULER: dispatch=<unchanged|good-base-only|stabilization-only|frozen>;
           integration=<unchanged|frozen>; default=<unchanged|healthy|known-bad|stabilizing>
LINEAR_BUG: <identifier/id или none>
SOURCE_ISSUES: <identifiers или none>
PREVIOUS_STABLE: tag=<tag>; sha=<full>; sites_version_id=<id> | none
EVIDENCE: <bounded reference, не raw log>
NEXT: <одно действие>
UPDATED_AT: <timestamp>
```

Если feature исключена или reverted, её issue остаётся незавершённой, а
независимый cutoff может продолжиться.

## BATCH_RELEASE_RECEIPT

Key: `<run_id>:<cutoff_id>`.

```text
STATUS: assembling | sealed | gate-passed | locally-integrated | publishing |
        default-pushed | integrated | deployed | live-awaiting-tag | released |
        failed | rolled-back
RUN_ID: <id>; RUN_KEY: <random >=128-bit hex>; OWNER: id=<uuid>; epoch=<n>
PROJECT_ID: <Linear project id>
RELEASE_ID: <id>; name=<name>
PROFILE: design | build | release
CUTOFF: <cutoff_id>; generation=<n>; queue_fingerprint=<hash>;
        opened_at=<utc>; membership_closed_at=<utc>; cutoff_reason=<bounded>
EXPECTED_DEFAULT_SHA: <full>
TRAIN: ref=<ref>; accepted_head=<sha>; successor_head=<sha|none>
CUTOFF_REF: <origin|local-only>:<immutable run/cutoff/generation-scoped ref=sha>
FEATURES: <topological identifier=base/dependencies->feature_sha@origin_ref>
EXCLUDED_FEATURES: <identifier=sha+reason или none>
CANDIDATE: sha=<full>; tree=<oid>
VALIDATION_KEY: tree=<oid>; gate=<hash>; env=<hash>
VALIDATION: run=<pass/fail+timestamp> | reused=<receipt/key> | none
PREPUSH_CI: sha=<full>; run/check=<id|not-available>; status=<terminal|none|pending-outage>
DEFAULT: expected_old=<full>; observed_before=<full>; published=<full|none>;
         observed_after=<full|unknown>; cas=<pass|fail|pending>
FOREIGN_MAIN: observation=<clear|isolated-dirty|overlap|ahead|diverged|active-unknown|unknown>;
              relation=<absent|equal|behind|ahead|diverged|unknown>;
              fingerprint=<hash>; action=<continue|quarantine|branches-only|freeze-shared|stop>
CI: sha=<full>; run/check=<id|none>; status=<terminal|none|pending-publication|waived-external-outage>
CI_WAIVER: none | component=<name>; observed=<symptom>; incident=<id/url>; incident_updated_at=<utc>; checked_at=<utc>; validation_key=<key>; catch_up=next-natural-run; reconciled=<run@head|none>
PUBLISHED_BY: head=<full>; run/check=<id|none>; status=<terminal|waived-external-outage> | none
SITES: not-applicable(profile=<design|build>) |
       project=<id>; version=<number>; version_id=<id>; archive_sha256=<digest>
DEPLOYMENT: not-applicable(profile=<design|build>) |
            id=<id>; status=<terminal>; url=<url>
LIVE_SMOKE: not-applicable(profile=<design|build>) |
            web=<flows+timestamp+result>; mcp=<profiles+timestamp+result>
PRODUCT: tag=<annotated tag@sha | not-applicable | none>
PREVIOUS_STABLE: not-applicable(profile=<design|build>) |
                 tag=<tag>; sha=<full>; sites_version_id=<id> | none
DEFECTS: <DEFECT_CANDIDATE keys/signatures или none>
SUPERSEDED_BY: <cutoff/generation или none>
LINEAR_DONE: <identifiers или none>
GAPS: <точные недоказанные границы или none>
NEXT: <одно действие или none>
UPDATED_AT: <timestamp>
```

Не заполняй downstream поля предположениями. В `release` tag и release-scoped
`LINEAR_DONE` допустимы только после successful required live smoke. В
`design|build` deployment/smoke/tag должны быть `not-applicable`, а
`LINEAR_DONE` допустим только после доказательства live issue acceptance,
integrated gate и exact default плюс terminal CI outcome.

`CI_WAIVER` допустим только по [github-outage.md](github-outage.md). Он не
является `pass`, но `waived-external-outage` — terminal outcome: при выполнении
всех условий протокола разрешает `integrated`/`released`, `LINEAR_DONE`, release
claims и завершение goal. Не оставляй такой receipt в `pending-outage`.

`STATUS: gate-passed` и `VALIDATION: run=pass` могут сосуществовать с
`not-available` в `GAPS`, если все проверки capability boundary выполнены.
Само отсутствие external path не переводит receipt в `failed`, если acceptance
его не требует; требуемое, но недоступное evidence нельзя считать pass.

`STATUS: locally-integrated` означает, что exact candidate прошёл integrated
gate и достижим из task-owned offline aggregate ref, но remote push ещё не
доказан. Local default ref не двигается. В таком receipt `LINEAR_DONE: none`,
`DEFAULT.cas: pending`, `PUBLISHED_BY: none`; issue остаётся незавершённой. После общей публикации
укажи exact published head и terminal CI outcome в `PUBLISHED_BY`, затем обнови
каждый покрытый cutoff до `integrated` и закрой issue по normal path либо
`github-outage.md`.

## Восстановить после прерывания

Выполни полный [crash-recovery.md](crash-recovery.md). Порядок источников:
coordinator/action/indexes -> authoritative runtime liveness -> exact origin
guard/feature/train/cutoff/default refs и tags -> foreign-main -> exact-SHA CI/
Sites -> live Linear -> task-owned local artifacts. Внутри pipeline сначала
разреши pending action, затем ACTIVE cutoff, OPEN cutoff и claims.

Refs, CI и Sites facts авторитетнее пересказа в comment; Linear определяет
актуальный scope, но не стирает run artifacts; foreign checkout не source of
truth. Late receipt не продвигает pipeline без current authority. Exact stale
SHA можно усыновить только новым monotonic claim generation с fresh guard/ref и
повторной scope/ancestry/check проверкой. Никогда не восстанавливай secret из
receipt или лога.

При несовпадении contract source/digest заморозь dispatch/integration, сохрани
доказанные exact artifacts старого run и мигрируй ledger; worker authority не
наследуй. Mutable recovery запрещён, пока текущий invoked bundle существует
только как untracked/dirty-only change относительно pinned contract.
