# Непрерывная интеграция и cutoff release

Читай этот файл для приёма готовых feature refs, global validation, default
promotion и release. Worker pool не имеет волн и не ждёт эту lane: правила
параллелизма и ownership находятся в [coordination.md](coordination.md), durable
state — в [receipts.md](receipts.md), defects — в
[defect-triage.md](defect-triage.md), чужой primary checkout и remote drift — в
[external-main.md](external-main.md).
Restart/adoption и cross-system ingest recovery находятся в
[crash-recovery.md](crash-recovery.md).

Coordinator единолично владеет serial integration/default/deploy lane. Workers
владеют только issue branches и `FEATURE_RECEIPT`.

## Разделы

- [Разделить pool и conveyor](#разделить-pool-и-conveyor)
- [Принять одну feature](#принять-одну-feature)
- [Закрыть cutoff](#закрыть-cutoff)
- [Выполнить global gate](#выполнить-global-gate)
- [Продвинуть exact candidate](#продвинуть-exact-candidate)
- [Обработать провал](#обработать-провал)
- [Стабилизировать known-bad default](#стабилизировать-known-bad-default)

Любую техническую аномалию GitHub обрабатывай по
[github-outage.md](github-outage.md); не дублируй outage, retry или waiver
policy здесь.

## Разделить pool и conveyor

Держи одновременно два независимых состояния:

- `OPEN_CUTOFF` — изменяемый integration train, куда coordinator по одной
  принимает готовые совместимые feature refs;
- `ACTIVE_CUTOFF` — immutable prefix exact train SHA, который проходит global
  gate, default promotion и при `release` deploy.

Ровно один cutoff может быть active. Пока он проверяется или публикуется,
worker pool продолжает работу, свободные slots немедленно заполняются, а новые
ready refs поступают в open cutoff. Не жди завершения уже работающих issues.

Integration train использует отдельный clean worktree и generation ref вида
`codex/release/train/<run-key>/g<generation>`. Каждый принятый feature SHA
добавляй отдельным merge/cherry-pick commit с issue ID, claim generation,
feature SHA/ref и dependency SHAs, затем fast-forward push ref. Поэтому
ordered membership восстановим по одной feature, но default остаётся за global
gate. Никогда не собирай train в пользовательском либо dirty checkout.
Local default ref не является train/aggregate ref и coordinator его не двигает.

Sealed active SHA может оставаться immutable ancestor движущегося train ref.
Если active prefix позднее оказался плохим, не force-rewrite опубликованный
train: создай новую generation от доказанного good base, перенеси только
разрешённые refs и supersede старый open cutoff.

## Принять одну feature

Обрабатывай каждый matching `FEATURE_RECEIPT ready` без cohort/wave. До
integration work соблюдай scheduler order: validate receipt -> free execution
slot -> refill -> enqueue ingest -> projections/bookkeeping.

1. Валидируй exact `run_id/run_key`, owner epoch, claim generation/token,
   semantic `scope_fingerprint`, feature SHA/ref/tree, queue fingerprint,
   targeted checks и ownership diff. Operational Linear `updatedAt` проверяй
   отдельно: его изменение из-за status/comment projection не делает scope
   stale. Online ref требует matching durable `ready` remote guard;
   coordinator-only mode сначала crash-safe публикует ref и reconciliate-ит
   guard. Explicit offline mode принимает только matching local guard/receipt и
   не разрешает default/Done.
2. Проверь ancestry от записанного base, exact dependency SHAs и что actual
   changed/renamed/deleted/generated paths входят в declared ownership paths.
   Receipt обязан иметь `CHECK_CLASS=targeted-feature` и
   `FULL_GATE=deferred-to-cutoff`; full-suite worker result не принимай как
   feature protocol success.
3. Durable-переведи exact `EXECUTION_INDEX` entry `running -> feature_ready` и
   освободи slot, не снимая claim/guard. Сначала refill compatible issue; target
   от ready-guard observation до spawn — `<=60s`. При пропуске durable-запиши
   blocker/evidence/resume predicate.
4. После refill поставь integration state `queued`. Только затем выполняй ingest
   и grouped Linear projections/bookkeeping. Если direct dependency ещё не
   accepted, оставь feature в topological queue; независимые refs продолжай.
5. Добавь exact feature SHA в train. Выполни только targeted ingest guardrails:
   - merge preflight и semantic conflict review;
   - `git diff --check`;
   - affected tests/validator/smoke, которых не было в feature gate либо которые
     проверяют взаимодействие с текущим train head;
   - bounded security/schema/migration invariant для затронутой поверхности.
6. Не запускай full repository suite, locked reinstall, aggregate release
   command, все browser flows, MCP clients или production smoke на feature/
   ingest. Full gate всегда принадлежит sealed cutoff.
7. До push CAS-запиши отдельный ingest action intent: expected/successor train SHA,
   feature/claim, resulting membership digest и latched timer. Fast-forward
   push-ни train ref expected-old, перечитай origin и только после exact
   successor upsert-ни `accepted` projections. Git train action не включай в
   projection batch. Независимые Linear comment/status updates можно выполнить
   одним batch intent и item-wise reconcile после Git reconciliation.
   Crash/partial update разрешай по [crash-recovery.md](crash-recovery.md), не
   повторным cherry-pick.
8. При fail не добавляй плохой ref в accepted head. Классифицируй defect по
   [defect-triage.md](defect-triage.md); независимые ready refs не задерживай,
   если integration state остаётся безопасным.

Same-path или semantic conflict создаёт serial integration order, а не worker
wave. Downstream ref со старым dependency SHA становится `superseded`, но
остальные lanes продолжаются.

## Закрыть cutoff

Cutoff — snapshot accepted prefix, а не ожидание тишины. Когда нет другого
`ACTIVE_CUTOFF`, закрой `OPEN_CUTOFF` по первому условию:

- accepted count достиг `CUTOFF_SIZE`;
- oldest accepted feature ждёт `max_ready_wait`;
- pool стал idle, а open cutoff не пуст;
- urgent stabilization/regression/hotfix требует fast lane;
- resource/risk boundary требует проверить уже собранный prefix до продолжения.

Если repo/user не задаёт значения, используй
`CUTOFF_SIZE=max(2,min(sustained_issue_capacity,4))` и `max_ready_wait=5m`. Не заводи
отдельный polling timer: после каждого mailbox/ref/integration event проверяй
условия, а ожидание worker event ограничивай ближайшим max-wait cutoff. Новая
feature не сбрасывает deadline; часовая issue никогда не удерживает минутную
ready feature дольше этого окна.

После recovery восстанови ordered accepted set из exact train-ref commits,
сверь `FEATURE_RECEIPT.INTEGRATION` и используй сохранённые `first_eligible_at`,
`CUTOFF_SIZE`, `max_wait_at` и pending trigger. Противоречие freeze-ит sealing,
а не сбрасывает deadline или membership.

Если trigger сработал при занятом `ACTIVE_CUTOFF`, немедленно создай durable
pending seal ticket с exact train head, ordered membership digest/count, reason
и trigger time. Поздние feature могут продолжить successor train, но не меняют
latched prefix. После terminal active cutoff этот ticket старше любого late
receipt/ingest/projection: сначала создай immutable cutoff ref exact latched
head и только потом обрабатывай новые accepts. Потеря ancestry latched head к
current train freeze-ит sealing, а не пересчитывает boundary.

Зафиксируй `cutoff_id`, `membership_closed_at`, ordered accepted feature SHAs,
excluded/queued refs, exact candidate SHA/tree, expected default SHA,
`gate_contract_hash` и `environment_fingerprint`. Seal action intent заранее
сохраняет эти поля, exact cutoff ref и membership digest. Затем до global gate
expected-absent создай immutable ref
`codex/release/cutoff/<run-key>/<cutoff-id>/g<generation>` на candidate: remote
в online mode, task-owned local в explicit offline mode. Same ref/same SHA
усынови; same ref/different SHA freeze-ит cutoff. Offline receipt остаётся
`locally-integrated` без default/Done. Новые ready refs относятся только к
следующему open cutoff.

Перед sealing сними foreign-main/remote snapshot. Overlap с membership либо
control surface не попадает в immutable cutoff: quarantine affected refs или
freeze sealing по [external-main.md](external-main.md). Stable disjoint dirt
не входит в candidate и не мешает sealing из clean worktree.

## Выполнить global gate

Sealed source tree immutable. Любая source change, exclusion, fix или revert
создаёт новую generation и новый validation key. Full repository gate никогда
не запускается на worker или OPEN ingest; он принадлежит exact sealed cutoff.

Сначала построи один deduplicated canonical ordered argv plan для exact
`cutoff + generation + candidate SHA/tree + gate contract hash + environment
fingerprint + plan`. Каждый step — отдельный non-shell argv; `gatectl` выполняет
их последовательно под одним lock/result и останавливается на первом fail. Если
aggregate command уже покрывает subcommands, включи только aggregate, не эти
subcommands. Coverage plan и последующих exact external gates включает применимые:

- обязательные правила current `AGENTS.md` и live acceptance вошедших issues;
- clean locked install и canonical build/test/lint/security commands, если они
  существуют;
- project-docs validator и `git diff --check <base>..<candidate>` для docs;
- strict full-bundle OKF validation для fixtures;
- batch-wide integration/UI/protocol checks;
- version-specific MCP/client/platform gates только при применимости.

Запускай и восстанавливай plan только через
`.agents/skills/ship-linear-release/scripts/gatectl.py run/status`. Helper
использует exact key, execution lock и atomic terminal artifact; сохраняй его
как durable `GATE_RESULT` из [receipts.md](receipts.md). После compaction или
lost process handle сначала вызови `status`: terminal pass/fail усынови без
rerun, running execution не дублируй. `interrupted` продолжай тем же exact
request только когда helper доказал отсутствие owner lock; ambiguous state
fail-closed до reconciliation.

```text
python3 .agents/skills/ship-linear-release/scripts/gatectl.py run \
  --state-dir <absolute-task-owned> --validation-key <64-hex> \
  --cutoff-id <id> --generation <n> --candidate-sha <full-sha> \
  --environment-id <bounded-id> --cwd <absolute-clean-worktree> \
  --plan-json '[["npm","ci"],["npm","run","check"],
                ["git","diff","--check","<base>..<candidate>"]]'

python3 .agents/skills/ship-linear-release/scripts/gatectl.py status \
  --state-dir <absolute-task-owned> --validation-key <64-hex>
```

Global gate использует только task-owned clean worktree и отдельные mutable
tmp/cache/build/runtime paths/ports; outputs primary checkout не являются cache
hit или evidence.

Переиспользуй pass только по exact `GATE_RESULT` key и durable terminal artifact.
Targeted worker/ingest checks не заменяют full gate. Не подменяй требуемую
live/client/cloud проверку локальным substitute. Terminal fail того же key не
rerun-и; lost handle/compaction тем более не разрешают повтор. Исправление либо
доказанное изменение contract/environment создаёт новую sealed generation/key;
необъяснённая нестабильность не pass.

До default branch используй существующий safe exact-SHA CI path, если он есть.
Не создавай PR/CI/infrastructure только ради ускорения. Разделяй portable и
platform-bound checks; несовместимый runner не доказывает parity.

## Продвинуть exact candidate

Train/cutoff/default Git actions, CI authority/waiver, Sites deploy и tag имеют
отдельные action tickets и reconciliation. Не включай их в Linear
projection-batch и не выполняй вторую default/deploy lane параллельно.

1. Потребуй `DEFAULT_HEALTH=healthy`, current owner epoch/action ticket, fresh
   `PROMOTION_HOLD=none` и remote default=`EXPECTED_DEFAULT_SHA`.
2. Докажи ancestry `expected_default -> candidate`. Обнови default explicit
   expected-old server-side lease на этот SHA; обычного check-then-push
   недостаточно. Lease разрешён только как CAS для доказанного fast-forward и
   никогда не разрешает history rewrite.
3. После push поставь `DEFAULT_HEALTH=pending`, независимо прочитай remote ref
   и foreign-main snapshot, потребуй exact candidate SHA. Local default ref и
   primary checkout не обновляй. До terminal результата второй push запрещён.
4. Дождись terminal required CI именно этого SHA, если CI настроен. Pre-push
   evidence не заменяет post-push required CI. Outage передай
   `github-outage.md`.
5. Для `design|build` запиши Sites/deploy/tag как `not-applicable`. Закрывай
   только issues с доказанным acceptance, integrated gate, exact default и
   terminal CI outcome.
6. Непосредственно перед deploy, tag и Linear closure снова прочитай remote
   default. Drift после нашего push отменяет exact-head evidence до fresh
   generation/reconciliation по [external-main.md](external-main.md).
7. Для `release` найди один configured production OpenAI Site из tracked
   config/runbook. До deploy докажи exact `previous_stable` и rollback artifact.
   Создай/найди artifact exact validated SHA, deploy один раз и проверь required
   authenticated web/control, persistence и MCP client flows.
8. Только после live pass создай immutable annotated tag, если tracked version
   policy его требует. Не выводи version из произвольного milestone name и не
   двигай существующий tag.
9. После terminal success поставь `DEFAULT_HEALTH=healthy`, upsert-ни cutoff и
   feature dispositions. Затем CAS-terminalize-ни exact current guards с
   feature head/checks digest и batch evidence; unknown/taken-over executor
   требует prior fence. Только после этого ставь issue `Done`. Cleanup выполняй
   по terminal guard, exact provenance и retirement rules
   `crash-recovery.md`: original SHA после cherry-pick может быть не ancestor
   default, но обязан быть явно связан с reachable integration commit.

Default push и production deploy сериализованы по cutoff. Feature refs и train
head публикуются по одной feature; это даёт durable progress без многократного
full gate/deploy.

## Обработать провал

Свяжи global failure с минимальным доказанным scope и примени scheduler effect
из [defect-triage.md](defect-triage.md):

- feature-local до default — исключи feature и stacked descendants, верни
  исходную issue в `In Progress`, выдай новый claim generation и продолжай
  независимый train;
- tiny candidate-only repair — сделай один минимальный coordinator fix commit,
  affected check, reseal и один новый global gate;
- independent/complex regression — создай deduplicated linked Bug, при
  blocking defect добавь его в milestone/priority queue; исключи виновный scope
  либо freeze promotion, но не останавливай безопасные issue branches;
- systemic/unknown/second-generation — поставь `integration=frozen`; разрешай
  только доказанно независимую работу от last-known-good base, а при
  продуктовом/архитектурном выборе верни `needs-input`;
- external infrastructure anomaly — не маскируй project fail и следуй
  соответствующему outage protocol.

Remote fast-forward/non-fast-forward, local ahead/diverged и changing/unknown
primary checkout — не project defect и не GitHub outage. Rebuild, quarantine
или freeze выбирай только по [external-main.md](external-main.md).

Если active cutoff fail, не добавляй его SHA в default. Open successor, который
является descendant плохого prefix, quarantine-ни и пересобери новой train
generation от good base. Exact feature refs сохраняй; повторяй только affected
feature checks и один global gate нового exact candidate.

## Стабилизировать known-bad default

Post-push CI fail или production smoke fail переводит state в:

```text
DEFAULT_HEALTH=known-bad
DISPATCH_MODE=good-base-only | stabilization-only
INTEGRATION_MODE=frozen
```

Не вливай обычные features и не делай следующий deploy поверх known-bad
default. При production fail сначала redeploy exact saved `previous_stable` и
проверь прежние критические flows. Затем создай explicit revert либо fix commit
в stabilization lane, прогони affected + full global gate, exact default CI и,
для `release`, новый artifact/deploy/smoke.

Обычная issue-работа может продолжаться только в изолированных branches от
`LAST_KNOWN_GOOD_DEFAULT_SHA`, если она не зависит от сломанной поверхности.
Ничего из неё не интегрируй, пока stabilization receipt не вернёт
`DEFAULT_HEALTH=healthy`. При неизвестном blast radius используй
`stabilization-only`, а не оптимистический dispatch.

Не reset/force default branch. Revert всегда новый commit; production fix —
новая candidate generation, artifact/deployment и immutable version по tracked
policy.
