# Goal card

Читай только при создании нового milestone-delivery Goal. Подставь exact live
IDs и передай objective в `create_goal`. `workers` — параметр исполнения, а не
done criterion; target/delivery profiles в Goal запрещены.

`run_id`, `run_key` и `owner_id` получай одним вызовом
`scripts/shipctl.py identities`; не собирай UUID/randomness отдельными shell или
JavaScript snippets. `create_goal` вызывай ровно один раз после выигранного
repo-global claim и не передавай `token_budget`, если пользователь явно не
запросил положительный budget.

```text
Objective: Автономно реализовать и доставить все незавершённые issue Linear
project <project_name> (<project_id>) из закреплённого current milestone
<milestone_name> (<milestone_id>) для <repo> по tracked контрактам
<repo>/.agents/skills/ship-linear-release/SKILL.md и
<repo>/docs/specs/linear-milestone-delivery.md; run_id=<run_id>;
run_key=<run_key>; owner_id=<owner_id>; owner_epoch=<epoch>.

Done when: Два свежих согласованных Linear snapshot exact milestone не содержат
unfinished issue, кроме Canceled/Duplicate; нет active WORK_CLAIM, cutoff,
candidate, CI, deployment или rollback artifacts; DEFAULT_HEALTH=healthy и
PROMOTION_HOLD=none; fresh remote/default snapshot совпадает с terminal
evidence. Каждый cutoff имеет BATCH_RELEASE_RECEIPT exact default SHA; каждая
вошедшая issue имеет FEATURE_RECEIPT и Done; любой run artifact имеет terminal
delivered/canceled/explicitly-retired disposition; unresolved quarantine
отсутствует. Если acceptance current milestone или repository release contract
требует production, exact OpenAI Sites artifact/version/deployment прошёл
обязательные authenticated web/control, persistence и MCP live flows, а
previous-stable rollback evidence сохранён; immutable tag существует только
когда его требует tracked version policy. Если production не требуется, он не
выполняется и receipt фиксирует not-required-by-current-milestone. Done без
delivery evidence при active artifact удерживает Goal. Terminal CI_WAIVER по
references/github-outage.md не считается active CI artifact.

Verify with: Каждая feature проходит issue-scoped targeted checks; каждый
sealed candidate ровно один full integrated gate по immutable validation key;
default обновляется только expected-old remote CAS из clean task-owned
worktree; primary checkout/local default не мутируются. Required CI проверяет
exact default SHA либо получает terminal external-outage waiver строго по
references/github-outage.md. Gate выводится из current AGENTS.md, issue
acceptance и tracked commands: docs validator и git diff --check для docs,
canonical aggregate build/test/security gate для кода, strict full-bundle OKF
validation и exact MCP/client compatibility там, где это действительно требует
acceptance. Production artifact, live smoke и rollback proof связаны с exact
validated SHA.

Constraints: Один repo-global coordinator owner/epoch владеет
Linear/integration/default/Sites/tags; чужая session остаётся read-only.
workers=N означает exact N устойчивых issue lanes; при N>1 coordinator занимает
отдельный runtime slot. workers=auto — единственный адаптивный режим. При N=1
root совмещает роли, но issue выполняет в отдельном worktree. Pool
work-conserving, slot refill немедленный. Каждая issue
имеет отдельные worktree, branch, generation, claim и guard; worker никогда не
меняет default/Linear/Sites/tags. Targeted gate выполняется на feature, full
gate/default и применимый production — на immutable cutoff. Dirty user files не
трогать; dirty control surface fail closed. Same-scope defect возвращать в
исходную issue; сложный независимый создавать как deduplicated linked Bug;
маленький integration repair проводить через новую cutoff generation и full
gate, не непроверенным commit в main. Не переписывать историю, не двигать tags,
не раскрывать secrets и не выбирать AWS/новую infrastructure без отдельного
решения. Recovery сначала fence-ит guards и reconciles external actions.

Blocked when: Один и тот же устойчивый внешний blocker, неустранимая
неоднозначность или необходимое продуктовое решение не позволяют продвинуть ни
active cutoff, ни безопасный независимый subset минимум три fresh
последовательных Goal turns. Отсутствующая реализация принятого scope, сложная
задача, running worker, pending CI/gate, recoverable CAS race, user pause или
soft handoff blocker-ом не являются. Быстрые continuations с одним fingerprint
считаются одним наблюдением. При pause используй references/soft-pause.md и не
вызывай update_goal(blocked).
```

Goal не расширяет полномочия user request и не заменяет repo-global claim.
Если `get_goal` показывает другой active Goal, остановись до мутаций и объясни
конфликт; не заменяй его автоматически.
