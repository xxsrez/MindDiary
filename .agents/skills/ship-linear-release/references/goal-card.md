# Goal card

Читай только при создании нового milestone-delivery goal. Подставь exact live
IDs и выбранный `delivery_profile`, затем передай objective в `create_goal`.
`workers` — параметр исполнения, а не часть done criteria; сохраняй выбранный
режим в run receipt.

`run_id`, `run_key` и `owner_id` получай одним вызовом
`scripts/shipctl.py identities`; не собирай UUID/randomness отдельными shell или
JavaScript snippets. `create_goal` вызывай один раз после выигранного claim.

```text
Objective: Автономно доставить все незавершённые issue Linear project
<project_name> (<project_id>) из закреплённого milestone <milestone_name>
(<milestone_id>) для <repo> по tracked контракту
<repo>/.agents/skills/ship-linear-release/SKILL.md; delivery_profile=<profile>;
run_id=<run_id>; run_key=<run_key>; owner_id=<owner_id>; owner_epoch=<epoch>.

Done when: Два свежих согласованных Linear snapshot exact milestone не содержат
незавершённых issue, кроме Canceled/Duplicate; нет активных WORK_CLAIM,
open/active cutoff, candidate, CI, deployment или rollback artifacts;
`DEFAULT_HEALTH=healthy`; `PROMOTION_HOLD=none`; fresh remote/default snapshot
совпадает с terminal evidence; каждый cutoff имеет BATCH_RELEASE_RECEIPT exact
default-branch SHA, вошедшие issue имеют FEATURE_RECEIPT + Done, а любая issue
с run artifact имеет terminal delivered/canceled/explicitly-retired
disposition; unresolved quarantine отсутствует. Done, появившийся при active
artifact без delivery evidence, не исчезает молча и удерживает goal. Для
design/build deployment, live smoke и tag явно
not-applicable и не заявляются. Для release production OpenAI Site имеет exact
artifact/version/deployment, successful live web + MCP smoke, previous-stable
rollback evidence и обязательный immutable tag по tracked version policy.
Terminal `CI_WAIVER` по [github-outage.md](github-outage.md) не является активным CI
artifact и не удерживает issue, cutoff или goal незавершёнными.

Verify with: Feature branches проходят targeted gate; каждый sealed candidate
проходит один integrated gate по validation key; default branch обновляется
только remote expected-old CAS из clean worktree; local default/primary checkout
не мутируется; доступный pre-push CI проверяет exact candidate; configured
required CI проверяет exact default SHA либо получает terminal external-outage
waiver строго по [github-outage.md](github-outage.md). Gate берётся из текущего AGENTS.md,
live acceptance и реально существующих scripts/configs: project-docs validator
и git diff --check для docs, canonical code/security checks после появления
кода, strict full-bundle OKF validation и exact MCP/client profiles при
применимости. Sites artifact соответствует exact SHA, web + MCP smoke
выполняется до tag/Linear Done, rollback опирается на сохранённый
previous-stable Sites receipt.

Constraints: Один repo-global coordinator owner/epoch владеет
Linear/integration/default/Sites/tags; чужая session только отказывает либо
наблюдает read-only. `workers=N` означает до N одновременно исполняемых issues,
не включая coordination overhead. При N=1 root работает coordinator-inline;
при N>1 отдельный coordinator предпочтителен, а hybrid допустим ради issue
capacity. Pool work-conserving: никаких waves/barriers, slot refill сразу.
Каждая issue получает отдельные worktree, run/epoch/claim-scoped branch, свежий
claim token и publication guard. Cheap feature/ingest guardrails выполняются по одной issue; full
integrated gate, default push и применимый Sites deploy — один раз на immutable
cutoff, не ожидающий всех in-flight workers. Не переписывать историю, не
двигать tags и не трогать dirty checkout. Автоматически создавать
deduplicated Bugs; same-scope возвращать в исходную issue; systemic/known-bad
state замораживает integration и запускает stabilization, не обязательно всю
изолированную работу. Contract digest должен быть tracked до dispatch; migration
переиспользует доказанные artifacts. Worker никогда не меняет
default/Linear/Sites/tags. Receipts обновляются только на содержательных
переходах, без streaming telemetry.
Stable disjoint foreign-main разрешает isolated continuation; overlap
quarantine-ится, ahead/diverged/unknown замораживает shared lane, remote drift
создаёт fresh generation по [external-main.md](external-main.md).
Restart/takeover сначала fence-ит guards и усыновляет exact origin/local
artifacts по [crash-recovery.md](crash-recovery.md); ambiguous external create
не повторяется.

Blocked when: Тот же устойчивый внешний доступ, неустранимая неоднозначность
или необходимое продуктовое решение не позволяют продвинуть ни active cutoff,
ни безопасный независимый subset минимум три fresh последовательных goal-хода.
User/client pause, soft drain/handoff, running worker, pending CI/gate и
recoverable CAS race не являются blocker. Быстрые auto-continuation с одним
fingerprint считаются одним наблюдением; transient dirty control surface
требует также минимум пяти минут без progress. При pause используй
references/soft-pause.md и не вызывай update_goal(blocked).
```
