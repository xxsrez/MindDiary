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
- [`EXECUTION_INDEX`](#execution_index)
- [`HOLD` / `PAUSE`](#hold--pause)
- [`WORK_CLAIM`](#work_claim)
- [`CLAIM_GUARD`](#claim_guard)
- [`FEATURE_RECEIPT`](#feature_receipt)
- [`DEFECT_CANDIDATE`](#defect_candidate)
- [`GATE_RESULT`](#gate_result)
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
update, верни `needs-coordinator`, а не размножай receipts.

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

Authoritative metadata commit ограничен 49,152 bytes и не принимает NUL.
Scalar header встречается ровно один раз; duplicate `OWNER_ID`, `RUN_ID`,
`STATE`, action/lifecycle/index или другой authoritative header делает commit
invalid. Повторяемы только явно индексированные `CLAIM_MAP` и rebuildable
`COMMENT_MAP`. При приближении к limit coordinator сначала compacts terminal
history до count+digest и проверяемых external refs; truncation active claim,
pending action, hold/pause или gate запрещена. Проверяй форму через
`shipctl.py metadata-commit`, не прямым `commit-tree`.

Normal path допускает один create и только содержательные state-transition
updates каждого key. Не обновляй receipt для poll, начала shell command,
неизменившегося heartbeat или промежуточного лога. После сохранения comment ID
не перечитывай весь comment history без recovery-причины, scope change или
ошибки update. Несколько полей одного checkpoint записывай одним upsert.

Независимые Linear comment/status projections разрешено группировать одним
`projection-batch` action intent и одним reconcile checkpoint. Это не
provider-side transaction: каждый item хранит собственные `item_id`, target,
expected-before, exact selector, request/idempotency key, payload digest,
expected effect identity и terminal result. Reconcile выполняй item-wise;
неизвестный/failed item не обесценивает доказанные соседние results и не
повторяется вместе с ними.
`projection-plan` создаёт run/generation-scoped idempotency keys и человекочитаемый
comment (`статус -> изменения -> проверка -> следующий шаг`).
`projection-batch-cas` до provider calls сохраняет exact full item vector под
expected coordinator SHA, а после calls принимает только полный item-wise result
vector; generic action helper этот протокол не заменяет.

### Linear projection JSON

`projection-plan --input` принимает:

```json
{
  "run_id": "<UUID>",
  "items": [{
    "issue_identifier": "AND-N", "issue_id": "<AND-N или UUID>",
    "receipt_kind": "WORK_CLAIM|FEATURE_RECEIPT|DEFECT_CANDIDATE",
    "receipt_key": "<stable key>", "generation": 1, "status": "<contract status>",
    "summary": "<одна строка>", "changes": ["<одна строка>"],
    "evidence": ["<одна строка>"], "next": "<одна строка>",
    "updated_at": "<UTC>",
    "comment_id": "<existing id, optional>",
    "state_update": {"expected": "Todo", "desired": "In Progress"}
  }]
}
```

Перед `--phase intent` передай helper-у output `projection-plan` без изменений.
Provider выполняет выданные items. `--phase reconcile` принимает полный vector:

```json
{"batch_id":"<UUID>","results":[
  {"item_id":"<UUID>","status":"applied|absent|failed|ambiguous","result":"<одна строка>"}
]}
```

`comment_id` и `state_update` optional и при отсутствии удаляются из item, а не
передаются как `null`. Все строки bounded; credential-like данные запрещены.

## Repo-global coordinator claim

Используй ровно один ref на весь repository, независимо от milestone и числа
workers:

```text
refs/heads/codex/release/coordinator
```

Не подставляй milestone name, slug или ID в этот ref. Это repo-wide mutex для
общих default branch, integration train, CI, Sites и Linear release state.
Разные repositories координируются независимо.

Первое mutable действие нового run — metadata commit через `shipctl.py
metadata-commit --kind coordinator` с пустым workflow-free tree и его
conditional push в этот ref. Exact source SHA/tree храни отдельно в полях
ledger; прямой `commit-tree` с source tree запрещён. Commit содержит как минимум `run_id`,
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

Единственное неатомарное batch-исключение — bounded `projection-batch` только
для независимых Linear comment/status updates. Один coordinator CAS сохраняет
полный item vector до вызовов, один следующий CAS — item-wise results. Не
добавляй туда feature/guard/train/cutoff/default Git refs, CI authority/waiver,
deploy, Sites или tag: каждое такое действие сохраняет отдельный action ticket
и exact expected-old/effect reconciliation.

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
перенеси его фактический ledger action-ом `migrate-legacy-ledger`, exact target
которого равен `<legacy-ref>@<legacy-full-SHA>`, добавь durable stop evidence и
reconcile result в ancestry canonical ref. Только этот exact tip после reconcile
игнорируется collision check; иной/продвинувшийся SHA снова блокирует. Не
объявляй старые artifacts недействительными и не позволяй двум namespaces
владеть run.

## RELEASE_RUN

Key: `<release_id>`.

```text
STATUS: claiming | recovering | running | validating | offline-queue |
        publishing | deploying | stabilizing | pausing | checkpoint | complete |
        needs-input
RUN_ID: <stable id>
RUN_KEY: <random >=128-bit hex, never shortened>
GOAL: current=<goal id/objective fingerprint|none>; supersedes=<old goal id|none>
CONTRACT: source_sha=<full>; digest=<hash>; migrated_from=<hash|none>
OWNER: id=<uuid>; epoch=<n>; state=<active|handoff-ready|complete|aborted>;
       terminal_reason=<none|released|aborted-before-run:<reason>>;
       proof=<runtime-task-id|goal-bound|none>:<digest|none>
LIFECYCLE: schema=1; phase=<running|draining|settling|quiescent|recovering|terminal>;
           pause=<pause-id|none>; transition=<action-id>
COORDINATOR_REF: refs/heads/codex/release/coordinator=<commit>
ACTION: seq=<n>; id=<uuid>; kind=<bounded>; target=<exact>;
        expected_before=<exact>; request_key=<id|none>; selector=<bounded>;
        payload_digest=<hash>; effect_identity=<exact>; status=<intent|reconciled>
PROJECTION_BATCH: none | id=<uuid>; items=<n>; intent_digest=<hash>;
                  results=<item-id:pending|applied|absent|failed|ambiguous>;
                  status=<intent|reconciled>
PROJECTION_ITEM: <canonical JSON identity vector; one per item>
PROJECTION_RESULT: <canonical JSON terminal result; one per item>
COMMENT_INDEX: release_run=<comment id|none>; entries=<n>; digest=<hash>
CLAIM_INDEX: active=<issue:g@guard-scope:guard@feature-scope:feature@claim-token|none>;
             entries=<n>; digest=<hash>
EXECUTION_INDEX: running_count=<n>;
                 entries=<issue:g@executor=running|coordinator-paused|feature_ready|failed|needs-input|stopped>;
                 digest=<hash>
REFILL: target_seconds=60; pending_since=<ready-guard@utc|none>;
        blocker=<none|reason>; evidence=<bounded|none>; resume_predicate=<bounded|none>
HOLD_PAUSE_INDEX: active=<id:kind@scope|none>; entries=<n>; digest=<hash>
GATE_INDEX: active=<gate-result-key|none>; entries=<n>; digest=<hash>
RECOVERY: generation=<n>; cause=<resume|handoff|takeover|migration>;
          phase=<fencing|inventory|reconciling-actions|adopting|complete|needs-input>;
          previous_owner=<id/epoch|none>; inventory=<digest|none>;
          reattached=<ids>; adopted=<ids>; requeued=<ids>; quarantined=<ids>;
          unresolved=<ids|none>
PROJECT_ID: <id>
RELEASE_ID: <id>; name=<name>
SCOPE_LEDGER: initial=<digest>; observed=<digest>; run_artifacts=<issue ids/count+digest>
PRODUCTION_REQUIREMENT: <not-required-by-current-milestone|required>;
                        evidence=<issue acceptance+repo contract digest>
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
PROMOTION_HOLD: <none|hold-pause-id:foreign-main:<bounded reason>>
WORKERS: requested_workers=<1|N|auto|auto(max=N)>; runtime_slots_total=<n>;
         delegated_capacity=<n>; sustained_issue_capacity=<n>;
         opportunistic_inline=<0|1>; active_target=<n>;
         coordination=<inline|dedicated|hybrid>; reason=<bounded>
CAPABILITIES: available=<bounded>; not_available=<bounded>
PIPELINE: open_cutoff=<id|none>; active_cutoff=<id|none>;
          train_ref=<ref|none>; train_head=<sha|none>;
          cutoff_ref=<immutable ref=sha|none>
OPEN_CUTOFF: none | id=<id>; generation=<n>; accepted_count=<n>;
             first_eligible_at=<utc>; cutoff_size=<n>; max_wait_at=<utc>;
             pending_trigger=<none|id:reason@utc>; pending_train_head=<sha|none>;
             pending_membership=<count+digest|none>
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

Последний компонент active binding — exact UUID `claim_token` из dispatch
manifest. Это не path и не display-name worktree: token позволяет worker-у
доказать, что coordinator всё ещё признаёт именно его generation после
продвижения coordinator ledger.

Remote coordinator ref обеспечивает ownership; milestone comment только
объясняет его. После `complete` сохрани ref как ledger; новый run или milestone
продолжает тот же ref descendant commit-ом. Не используй wall-clock heartbeat
как lease и не обновляй его в цикле ожидания.

`OWNER.state=complete` ставь terminal CAS commit-ом только после отсутствия
in-flight action/worker/cutoff и полного done evidence. Ref не удаляй: он нужен
как expected-old ledger следующему run.
После terminal CAS повторно проверь `shipctl.py status`, cleanup clean merged
worktrees и лишь затем заверши Codex Goal. Goal status не может служить
доказательством terminal coordinator authority.

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

`OPEN_CUTOFF.pending_*` — immutable boundary ticket, пока другой cutoff active.
Защёлкни exact train head и ordered membership digest в момент первого trigger.
После terminal active cutoff сначала seal-ни этот exact prefix, затем принимай
late ingest; поздний suffix создаёт следующий OPEN и не меняет ticket.

## EXECUTION_INDEX

Это bounded authoritative index occupancy в repo-global coordinator ledger, а
не Linear comment и не замена guard. Key каждой записи:
`<run_id>:<issue_id>:<claim_generation>`.

```text
ISSUE: <identifier>; <id>; claim_generation=<n>
EXECUTOR: kind=<agent|coordinator-inline>; task_id=<stable id|unknown>
EXECUTION_STATE: running | coordinator-paused | feature_ready | failed |
                 needs-input | stopped
READY_GUARD: <ref@ack-sha|none>; FEATURE_SHA: <full|none>
READY_GUARD_OBSERVED_AT: <utc|none>
TRANSITION_AT: <utc>; EVIDENCE: <bounded>
```

Только `running` входит в `running_count` и занимает issue slot. После
валидированного durable ready guard сначала запиши `feature_ready` и освободи
slot; claim/guard остаются в `CLAIM_INDEX` до `integrated|excluded|retired`
terminal disposition. Refilling использует этот index, а не число live claims.
Нормальный missed-refill не записывай; если ready-compatible slot не заполнен
за 60 секунд, обнови `REFILL.blocker/evidence/resume_predicate` одним переходом.

## HOLD / PAUSE

Key: `<run_id>:<hold_or_pause_id>`. Авторитетный record хранится в
repo-global coordinator ledger; Linear — только необязательная projection.

```text
STATE: active | lifted
KIND: HOLD | PAUSE
SCOPE: <issue/ref/path|dispatch|integration|gate|default|deploy|tag|linear|all-shared>
REASON: <bounded>
EVIDENCE: <exact observation/receipt/action>
RESUME_PREDICATE: <machine-checkable condition>
CONFIRMATION: required=<yes|no>; after=<created-action-id>;
              evidence=<user-message-id/digest|none>
CREATED: action=<id>; at=<utc>
LIFTED: action=<id|none>; at=<utc|none>; evidence=<bounded|none>
```

`HOLD` снимается отдельным expected-old CAS после fresh predicate evidence.
`PAUSE` с `required=yes` дополнительно требует явное подтверждение пользователя,
полученное после `CREATED.action`. Goal auto-continuation, новый turn,
compaction, timeout и same-owner resume не являются confirmation. Пока record
active, запрещены только его scopes; unknown/contradictory index fail-closed.

Для user/client soft pause `LIFECYCLE` является обязательной проверяемой
projection. `draining` сохраняет прежний nonzero execution vector и блокирует
новый dispatch; `settling` требует `running_count=0`; `quiescent` требует
`OWNER.state=handoff-ready`, PAUSE scope `all-shared`, exact index entry и
`PENDING_ACTIONS=none`. Эти поля пишет только `shipctl.py soft-pause`; generic
action renderer обязан сохранить их неизменными. Exact machine flow описан в
[soft-pause.md](soft-pause.md).

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
ISSUE: <identifier>; <id>; issue_updated_at=<operational timestamp>;
       scope_fingerprint=<semantic digest>
EXECUTOR: kind=<agent|coordinator-inline>; task_id=<stable id|unknown>;
          lease_id=<fresh uuid>; fork_turns=none; reused=no;
          runtime_liveness=<running|terminal|unknown>
EXECUTION: state=<running|coordinator-paused|feature_ready|failed|needs-input|stopped>;
           evidence=<execution-index key/transition>
INTEGRATION: state=<not-queued|queued|accepted|excluded|terminal>;
             cutoff=<id:generation|next-open|none>; evidence=<key|none>
ROOT_BASE: sha=<full>; tree=<oid>; origin_default=<full>
BASE: sha=<full>; class=<current-default|last-known-good|stabilization>;
      dependency_shas=<ordered refs или none>
REMOTE_MODE: <online|offline-local-only>
FEATURE_REF: scope=<origin|local-only>; ref=<branch/ref или none>;
             expected_old=<zero|sha>
GUARD_REF: scope=<origin|local-only>; ref=<exact>; tip=<sha>;
           publish=<atomic-online|coordinator-only>
WORKTREE: id=<uuid>; branch=<exact>; path_hint=<basename>; head_at_dispatch=<sha>
ISOLATION: mutable_build_dir=<absolute task-owned>; tmp_dir=<absolute task-owned>;
           runtime_dir=<absolute task-owned>;
           cache_mode=<content-addressed|isolated>; cache_dir=<absolute>;
           cache_key=<sha256|none>;
           ports=<unique integers|none>; env=<non-secret keys+digest|none>
DEPENDENCIES: mode=<isolated|content-addressed>; path=<absolute>;
              lockfile_digest=<sha256>; cache_key=<sha256|none>;
              read_only=<yes|no>; provenance=<verified receipt>
VALIDATION_CONTRACT: check_class=targeted-feature;
                     targeted_checks=<stable id + non-shell argv vectors>;
                     full_gate=deferred-to-cutoff
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

`STATUS` и live guard выражают authority, `EXECUTION.state` — только occupancy,
`INTEGRATION.state` — судьбу feature. `feature_ready` освобождает slot, но не
переводит claim в `released`: release/supersede/retire допустимы лишь после
terminal guard с exact integration/retirement evidence.

## CLAIM_GUARD

Это Git ledger одной claim publication, не Linear comment: remote в online
mode, task-owned local в explicit offline mode. Exact ref:
`refs/heads/codex/release/claims/<run-key>/<issue-id>/c<generation>`.

```text
SCHEMA: 1
KIND: CLAIM_GUARD
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
всегда являются descendant metadata commits с пустым workflow-free tree,
созданными `shipctl.py metadata-commit --kind guard` либо встроенным fenced
helper; source feature tree связывается exact SHA из `FEATURE`. Guard ref не
переписывается.
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
STATUS: ready | failed | needs-coordinator | needs-input | superseded | retired
GENERATION: <n>
RUN_ID: <id>; RUN_KEY: <random >=128-bit hex>; OWNER: id=<uuid>; epoch=<n>
CLAIM: generation=<n>; token=<opaque non-secret id>
ISSUE: <identifier>; <id>; issue_updated_at=<operational timestamp>
SCOPE: fingerprint_start=<semantic digest>; fingerprint_final=<semantic digest>;
       disposition=<unchanged|adapted>
ROOT_BASE: sha=<full>; tree=<oid>
BASE: sha=<full>; tree=<oid>
DEPENDENCIES: <ordered issue=sha@origin_ref или none>
FEATURE: sha=<full>; tree=<oid>; ref=<origin|local-only>:<ref=sha>
GUARD: scope=<origin|local-only>; ref=<exact>; acknowledgement=<sha|none>
OWNERSHIP_PATHS: <компактный список>
AFFECTED_SURFACES: <domain/ui/build/docs/...>
CHECK_CLASS: targeted-feature
CHECKS: <affected commands и pass/fail; без полного лога>
FULL_GATE: deferred-to-cutoff
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

`scope_fingerprint` вычисляй как SHA-256 compact UTF-8 JSON с sorted keys/arrays:
milestone membership, title/description/acceptance, scope-bearing attachments/
non-receipt comments и release-blocking relations с exact IDs. Исключай status,
priority, assignee, `updatedAt` и comments с marker `ship-linear-release`.
Изменение одного Linear `updatedAt` не делает artifact stale; изменение
fingerprint требует adaptation либо нового claim. Worker и ingest выполняют
только targeted checks: full repo suite всегда остаётся `deferred-to-cutoff`.

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

## GATE_RESULT

Key: `<run_id>:<cutoff_id>:g<generation>:<validation_key_digest>`.
Авторитетный terminal result создаёт только
`.agents/skills/ship-linear-release/scripts/gatectl.py`; `run` дедуплицирует
execution lock-ом и атомарно пишет result, `status` читает тот же key после
compaction/restart. Coordinator затем сохраняет key/artifact digest в
repo-global ledger и проецирует его в batch receipt.

```text
STATUS: planned | running | passed | failed | interrupted
RUN_ID: <id>; RUN_KEY: <hex>; OWNER: id=<uuid>; epoch=<n>
CUTOFF: <id>; generation=<n>; cutoff_ref=<immutable exact ref@sha>
CANDIDATE: sha=<full>; tree=<oid>
VALIDATION_KEY: tree=<oid>; gate_contract=<hash>; environment=<hash>
GATECTL_KEY: cutoff=<id>; generation=<n>; candidate=<full>;
             environment=<hash>; plan_digest=<hash>
CHECK_CLASS: full-cutoff
PLAN: digest=<hash>; steps=<ordered non-shell argv vectors>;
      coverage=<bounded>; duplicate_subcommands=<none>
PROCESS: identity=<pid/task|none>; started_at=<utc|none>; terminal_at=<utc|none>
TIMEOUTS: step_seconds=<n>; total_seconds=<n>
RESULT_ARTIFACT: path=<task-owned exact|none>; digest=<hash|none>;
                 atomic=<yes|none>
RESULT: exit=<int|none>; outcome=<pass|fail|interrupted|none>;
        failing_step=<bounded|none>;
        failure_kind=<command-failed|spawn-failed|candidate-drift|step-timeout|total-timeout|none>;
        log_digest=<hash|none>
ADOPTED_AFTER: <none|compaction|lost-handle|recovery>
UPDATED_AT: <utc>
```

Для sealed generation сформируй ровно один canonical ordered full-gate plan.
Каждый step — отдельный argv без shell; helper выполняет steps последовательно,
останавливается на первом fail и сохраняет его index в terminal result.
Используй существующий aggregate command, когда он покрывает required
subcommands, и не добавляй их отдельно до/после него. Worker/ingest results с
`CHECK_CLASS=targeted-*` не заменяют этот gate. При lost handle сначала вызови
`gatectl.py status`: terminal
`passed|failed` усынови без rerun, `running` не дублируй. `interrupted` можно
продолжить только тем же exact request через `gatectl.py run`, когда `status`
доказал отсутствие owner lock; unknown reconciliation fail-closed. Новый
plan/key разрешён только новой sealed generation или доказанным изменением
validation key; terminal fail того же key не обходи повторным `run`.

## BATCH_RELEASE_RECEIPT

Key: `<run_id>:<cutoff_id>`.

```text
STATUS: assembling | sealed | gate-passed | locally-integrated | publishing |
        default-pushed | integrated | deployed | live-awaiting-tag | released |
        failed | rolled-back
RUN_ID: <id>; RUN_KEY: <random >=128-bit hex>; OWNER: id=<uuid>; epoch=<n>
PROJECT_ID: <Linear project id>
RELEASE_ID: <id>; name=<name>
PRODUCTION_REQUIREMENT: <not-required-by-current-milestone|required>;
                        evidence=<issue acceptance+repo contract digest>
CUTOFF: <cutoff_id>; generation=<n>; queue_fingerprint=<hash>;
        opened_at=<utc>; membership_closed_at=<utc>; cutoff_reason=<bounded>
EXPECTED_DEFAULT_SHA: <full>
TRAIN: ref=<ref>; accepted_head=<sha>; successor_head=<sha|none>
CUTOFF_REF: <origin|local-only>:<immutable run/cutoff/generation-scoped ref=sha>
FEATURES: <topological identifier=base/dependencies->feature_sha@origin_ref>
EXCLUDED_FEATURES: <identifier=sha+reason или none>
CANDIDATE: sha=<full>; tree=<oid>
VALIDATION_KEY: tree=<oid>; gate=<hash>; env=<hash>
GATE_RESULT: key=<exact>; status=<running|passed|failed|interrupted>;
             artifact_digest=<hash|none>; adopted_after=<none|compaction|lost-handle|recovery>
VALIDATION: gate_result=<key@passed|key@failed> | reused=<exact key> | none
PREPUSH_CI: sha=<full>; run/check=<id|not-available>; status=<terminal|none|pending-outage>
DEFAULT: expected_old=<full>; observed_before=<full>; published=<full|none>;
         observed_after=<full|unknown>; cas=<pass|fail|pending>
FOREIGN_MAIN: observation=<clear|isolated-dirty|overlap|ahead|diverged|active-unknown|unknown>;
              relation=<absent|equal|behind|ahead|diverged|unknown>;
              fingerprint=<hash>; action=<continue|quarantine|branches-only|freeze-shared|stop>
CI: sha=<full>; run/check=<id|none>; status=<terminal|none|pending-publication|waived-external-outage>
CI_WAIVER: none | component=<name>; observed=<symptom>; incident=<id/url>; incident_updated_at=<utc>; checked_at=<utc>; validation_key=<key>; catch_up=next-natural-run; reconciled=<run@head|none>
PUBLISHED_BY: head=<full>; run/check=<id|none>; status=<terminal|waived-external-outage> | none
SITES: not-required-by-current-milestone |
       project=<id>; version=<number>; version_id=<id>; archive_sha256=<digest>
DEPLOYMENT: not-required-by-current-milestone |
            id=<id>; status=<terminal>; url=<url>
LIVE_SMOKE: not-required-by-current-milestone |
            web=<flows+timestamp+result>; mcp=<profiles+timestamp+result>
PRODUCT: tag=<annotated tag@sha | not-required-by-current-milestone | none>
PREVIOUS_STABLE: not-required-by-current-milestone |
                 tag=<tag>; sha=<full>; sites_version_id=<id> | none
DEFECTS: <DEFECT_CANDIDATE keys/signatures или none>
SUPERSEDED_BY: <cutoff/generation или none>
LINEAR_DONE: <identifiers или none>
GAPS: <точные недоказанные границы или none>
NEXT: <одно действие или none>
UPDATED_AT: <timestamp>
```

Не заполняй downstream поля предположениями. При
`PRODUCTION_REQUIREMENT=required` tag и production-scoped `LINEAR_DONE`
допустимы только после successful required live smoke. При
`not-required-by-current-milestone` deployment/smoke/tag не выполняются, а
`LINEAR_DONE` всё равно требует live issue acceptance, integrated gate, exact
default и terminal CI outcome. Это факт об acceptance, не waiver и не profile.

`CI_WAIVER` допустим только по [github-outage.md](github-outage.md). Он не
является `pass`, но `waived-external-outage` — terminal outcome: при выполнении
всех условий протокола разрешает `integrated`/`released`, `LINEAR_DONE`, release
claims и завершение goal. Не оставляй такой receipt в `pending-outage`.

`STATUS: gate-passed` и `VALIDATION: gate_result=<key@passed>` могут сосуществовать с
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
coordinator/action/claim/execution/hold/gate indexes -> authoritative runtime
liveness -> exact origin guard/feature/train/cutoff/default refs и tags ->
foreign-main -> exact-SHA CI/Sites -> live Linear -> task-owned local artifacts.
Внутри pipeline сначала сохрани active `HOLD/PAUSE`, затем разреши pending
action/projection batch и `gatectl.py status`, ACTIVE cutoff, latched pending
boundary, OPEN cutoff и claims. Confirmation-required pause не снимается
автоматическим Goal continuation или recovery.

Refs, CI и Sites facts авторитетнее пересказа в comment; Linear определяет
актуальный semantic scope, но не стирает run artifacts; operational `updatedAt`
не заменяет `scope_fingerprint`, foreign checkout не source of truth. Late
receipt не продвигает pipeline без current authority. Exact stale SHA можно
усыновить только новым monotonic claim generation с fresh guard/ref и повторной
scope/ancestry/targeted-check проверкой. Никогда не восстанавливай secret из
receipt или лога.

При несовпадении contract source/digest заморозь dispatch/integration, сохрани
доказанные exact artifacts старого run и мигрируй ledger; worker authority не
наследуй. Mutable recovery запрещён, пока текущий invoked bundle существует
только как untracked/dirty-only change относительно pinned contract.
