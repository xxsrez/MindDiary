# Goal card

Читай только при создании нового milestone-delivery goal. Подставь exact live
IDs и выбранный `delivery_profile`, затем передай objective в `create_goal`.
`workers` — параметр исполнения, а не часть done criteria; сохраняй выбранный
режим в run receipt.

```text
Objective: Автономно доставить все незавершённые issue Linear project
<project_name> (<project_id>) из закреплённого milestone <milestone_name>
(<milestone_id>) для <repo> по tracked контракту
<repo>/.agents/skills/ship-linear-release/SKILL.md; delivery_profile=<profile>.

Done when: Два свежих согласованных Linear snapshot exact milestone не содержат
незавершённых issue, кроме Canceled/Duplicate; нет активных WORK_CLAIM,
candidate, CI, deployment или rollback artifacts; каждый batch имеет
BATCH_RELEASE_RECEIPT exact default-branch SHA и вошедшие issue имеют
FEATURE_RECEIPT + Done. Для design/build deployment, live smoke и tag явно
not-applicable и не заявляются. Для release production OpenAI Site имеет exact
artifact/version/deployment, successful live web + MCP smoke, previous-stable
rollback evidence и обязательный immutable tag по tracked version policy.

Verify with: Feature branches проходят targeted gate; каждый sealed candidate
проходит один integrated gate по validation key; default branch обновляется
только fast-forward; доступный pre-push CI проверяет exact candidate; configured
required CI проверяет exact default SHA. Gate берётся из текущего AGENTS.md,
live acceptance и реально существующих scripts/configs: project-docs validator
и git diff --check для docs, canonical code/security checks после появления
кода, strict full-bundle OKF validation и exact MCP/client profiles при
применимости. Sites artifact соответствует exact SHA, web + MCP smoke
выполняется до tag/Linear Done, rollback опирается на сохранённый
previous-stable Sites receipt.

Constraints: Один coordinator владеет Linear/default branch/Sites/tags.
Каждая issue выполняется свежим worker в отдельном worktree/feature branch.
workers=1 по умолчанию; explicit N — верхняя граница; auto ограничивается
runtime slots, графом независимости и ресурсами. Размер batch не равен числу
workers. Не force-push, не двигать tags, не трогать пользовательский dirty
checkout. Не выдавать design-first proposal за реализованный или deployed
service. Автоматически создавать deduplicated linked Bugs для независимых
regressions; same-scope возвращать в исходную feature; systemic second
generation выносить на решение пользователю. Contract digest должен быть
tracked до dispatch; смена версии активного run проходит migration checkpoint
с переиспользованием доказанных artifacts. Worker никогда не меняет
default/Linear/Sites/tags. Normal path: один integrated gate на validation key,
один default push и, только для release, один Sites deploy; отдельный production
container или AWS запрещён без нового решения. Receipts обновляются только на
содержательных state transitions, external jobs проверяются bounded polling
без streaming logs.

Blocked when: Тот же внешний доступ, неустранимая неоднозначность или
необходимое продуктовое решение не позволяют продвинуть ни текущий batch, ни
безопасный независимый subset минимум три последовательных goal-хода.
```
