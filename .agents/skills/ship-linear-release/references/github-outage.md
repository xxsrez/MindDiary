# Сбои GitHub во время delivery

Читай этот файл при ошибках Git/API, отсутствии ожидаемого Actions run,
задержке webhook, зависшем runner или другом подозрении на внешний сбой GitHub.
Нормальный Git/CI flow описан в `SKILL.md` и `batch-release.md`; здесь находится
вся аварийная логика, включая terminal waiver для недоступного Actions evidence.
Local checkout/index lock, dirty/ahead/diverged default и remote drift относятся
к [external-main.md](external-main.md), а не к outage/waiver.

## Разделы

- [Диагностировать затронутый component](#диагностировать-затронутый-component)
- [Выбрать outcome](#выбрать-outcome)
- [Завершить cutoff при outage Actions](#завершить-cutoff-при-outage-actions)
- [Сверить CI после восстановления](#сверить-ci-после-восстановления)
- [Продолжать при недоступной Git publication](#продолжать-при-недоступной-git-publication)
- [Сделать handoff](#сделать-handoff)

## Диагностировать затронутый component

1. Сначала зафиксируй evidence exact repo/SHA: результат fetch/push/ref CAS,
   наличие workflow/check, terminal conclusion, failing step либо конкретную
   API/network ошибку. Не выводи outage только из ожидания или общего banner.
2. После наблюдаемой аномалии один раз прочитай официальный
   [GitHub Status](https://www.githubstatus.com/),
   [current status API](https://www.githubstatus.com/api/v2/status.json) и
   [unresolved incidents API](https://www.githubstatus.com/api/v2/incidents/unresolved.json).
   Сохрани component, incident impact/status, latest update UTC, `checked_at` и
   incident URL. Не используй сторонний пересказ вместо официального источника.
3. Сопоставь симптом только с реально затронутым component:
   - `Actions`/`Webhooks` могут объяснить отсутствующий или застрявший workflow
     после успешного push, не означая отказ `Git Operations`;
   - `Git Operations`/релевантный API влияют на publication и coordinator CAS;
   - GitHub Pages не относится к OpenAI Sites;
   - Copilot incident не относится к локальному Codex run, если эта GitHub
     service фактически не используется.
4. Разделяй repo defect и infrastructure signal. Terminal failure внутри
   `npm ci`, test, build, lint или другого project command — настоящий fail,
   даже во время incident. Missing run, runner allocation error, webhook loss,
   GitHub 5xx/rate-limit либо job infrastructure failure могут быть external.
5. Status page — corroborating context, не доказательство причины отдельного
   сбоя. Если matching incident нет, продолжай обычную repo-specific
   диагностику. Перепроверяй status только на естественном terminal checkpoint
   либо перед новым утверждением, что incident всё ещё продолжается.
6. Пользователю сообщай: observed exact repo/SHA symptom; официальный status с
   UTC-временем; реальное влияние на этот run; следующий шаг. Любую оценку
   восстановления называй подсказкой, а не ETA или гарантией.

## Выбрать outcome

| Состояние | Локальная работа | Linear `Done` | Sites/release |
|---|---|---|---|
| Exact SHA опубликован; matching Actions/Webhooks outage; clean full gate pass | Продолжать | Разрешён outage waiver | Продолжать только по обычным live gates |
| Actions run содержит project-command failure | Исправить defect | Запрещён | Запрещён до исправления |
| Git publication/CAS недоступна | Только разрешённая local queue | Запрещён | Запрещён: exact remote default не доказан |
| Incident затрагивает только Pages/Copilot, не используемые flow | Обычный flow | Обычный flow | Обычный flow |
| Matching incident отсутствует | Repo-specific diagnosis | По обычному CI contract | По обычному release contract |

Глобальные `Major Outage`/`Partial Outage` не определяют outcome сами по себе.
Оценивай необходимую capability текущей стадии и exact observed evidence.

## Завершить cutoff при outage Actions

Не удерживай issue в `In Review` только из-за отсутствующего GitHub Actions
evidence, если одновременно доказаны все условия:

1. Exact candidate уже опубликован в `origin/<default>`; remote ref равен
   `candidate_sha`, server-side CAS прошёл, candidate достижим из ожидаемого
   default base.
2. Exact candidate tree прошёл один clean full integrated gate в dedicated
   worktree: locked install (`npm ci` либо текущий canonical equivalent), все
   обязательные repo commands, acceptance checks и `git diff --check`.
   Сохранены validation key, environment fingerprint и bounded result.
3. Нет известного test/build/security/conformance fail. CI не содержит
   уникальной platform-bound проверки, которую локальный gate не выполнял.
   Повтор portable repo commands на втором generic OS waivable; сам runner OS
   не должен быть acceptance target этой issue или release.
4. Acceptance issue не требует доказать саму работу GitHub Actions, workflow,
   runner или другого затронутого component.
5. Observed отсутствие/infra-failure run по времени и component совпадает с
   официальным incident `Actions`/`Webhooks`, активным на момент симптома; это
   доказано сохранённым status/update, даже если incident уже resolved.
   Выполнена одна bounded проверка run/check state.
6. Все остальные gates, требуемые current milestone и repository contract,
   доступны и выполнены. Outage waiver не заменяет required Sites
   artifact/deployment, authenticated web, persistence, MCP client smoke,
   rollback evidence или tag policy.

Если условия выполнены:

1. Не называй CI успешным. Запиши terminal
   `CI.status=waived-external-outage`, `run/check=none|<infra-run-id>` и
   `CI_WAIVER` с exact head, observed symptom, incident component/id/URL,
   `updated_at`, `checked_at`, validation key и `catch_up=next-natural-run`.
2. Если production не требуется current milestone, переведи cutoff в
   `integrated`, закрой полностью доказанные issue в Linear и release-ни их
   claims. Если production требуется, продолжай обычные Sites/live/tag gates и
   после их успеха разрешай `released`/`Done` с тем же явно сохранённым waiver.
3. Один waiver финального опубликованного head может покрыть несколько ancestor
   cutoffs, только если каждый ancestor имеет собственный clean integrated gate
   и достижим из этого head. Запиши одинаковый `PUBLISHED_BY`/`CI_WAIVER` в
   каждый покрытый receipt; не переиспользуй waiver для divergent ref/tree.
4. Считай waiver terminal evidence, а не pending artifact. Он не удерживает
   issue в `In Review`, milestone goal active или release claim открытым.
5. При migration со старого contract reclassify существующие `pending-outage`
   receipts только после проверки всех условий выше; переиспользуй их exact
   gates/refs и не повторяй validation или external mutations.

В user-facing результате формулируй: «exact SHA опубликован и локально полностью
проверен; GitHub Actions evidence waived из-за matching external incident». Не
пиши «CI passed» и не скрывай ссылку на incident.

## Сверить CI после восстановления

1. Не создавай timer, recurring monitor, no-op commit, dummy PR или лишний push
   ради waiver. Goal может завершиться; catch-up не является скрытым blocker.
2. На следующем естественном default-branch push либо новом delivery run найди
   обычный Actions result актуального head. Один successful full run reconciles
   предыдущие ancestor waivers вместе с сохранёнными per-cutoff integrated gates.
3. Обнови ledger/receipts на `CI_WAIVER.reconciled=<run-id@head>` только при
   точной ancestry. Уже закрытые issue повторно не мутируй.
4. Если catch-up run даёт project-command fail, не списывай его на старый
   outage: оформи defect, определи затронутый scope и переоткрой только реально
   нарушенные issue либо создай linked cross-cutoff Bug. Не делай массовый reopen
   без attribution.
5. Если официальный incident resolved, но новые runs всё ещё не создаются,
   начни repo-specific diagnosis. Старые terminal waivers не отменяй задним
   числом, но новые не выдавай без нового matching evidence.

## Продолжать при недоступной Git publication

Эта ветка отличается от Actions waiver: пока exact commit не опубликован и
remote default/CAS не доказаны, issue не доставлена и `Done` запрещён.

1. Входи в local-only mode только существующим coordinator с восстановленным
   `run_id`, `owner_id` и `owner_epoch` и только при явном разрешении
   пользователя. Не запускай новый run/session и не выполняй takeover, когда
   repo-global remote claim нельзя прочитать и CAS-продвинуть.
2. Зафиксируй последний доказанный `origin/<default>` как `base_origin`,
   task-owned aggregate ref/head, незавершённые remote jobs и ordered pending
   cutoffs в `RELEASE_RUN.OFFLINE_QUEUE`.
3. Строй local-only cutoffs в clean worktree от task-owned ref вида
   `codex/release/offline/<run-key>/g<generation>`, rooted в `base_origin`.
   Workers используют отдельные worktrees/local refs; local default и primary
   checkout не обновляй.
4. Выполняй обычные feature gates, sealing и один full integrated gate. Пиши
   `STATUS=locally-integrated`, `DEFAULT.cas=pending`, `PUBLISHED_BY=none`,
   `CI=pending-publication` и `LINEAR_DONE=none`.
5. Cleanup выполняй только по provenance/retirement rules
   [crash-recovery.md](crash-recovery.md). Не удаляй единственное доказательство
   unpublished commit или dirty/quarantined carrier.
6. Пытайся публиковать ровно один раз на естественном terminal cutoff checkpoint,
   если последняя technical failure была не менее часа назад; всегда сделай
   одну последнюю bounded attempt после исчерпания локальной работы. Не создавай
   polling loop и не retry-и по одному wall-clock wakeup.
7. При восстановлении fetch-ни exact origin. Если он равен `base_origin`, сделай
   publication action intent с base/aggregate heads, cutoff membership и effect
   identity, затем один fast-forward CAS push `aggregate_head` и reconcile
   origin до receipt update. При drift закрой intent фактическим state, собери
   новую aggregate generation от свежего origin, merge-ни local chain без
   history rewrite, reseal и один раз повтори full integrated gate.
8. После публикации используй обычный CI path. Если publication прошла, но
   Actions всё ещё затронут matching incident, примени outage waiver выше вместо
   удержания issue в `In Review`.

## Сделать handoff

- При Actions waiver укажи published exact head, validation key, закрытые issue,
  incident URL/UTC context, отсутствие CI-pass claim и
  `catch_up=next-natural-run`.
- При unpublished local queue предупреди, что работа не доставлена. Укажи exact
  `base_origin`, aggregate ref/head, число commits, pending cutoff IDs, время/причину
  последней remote ошибки и следующую допустимую natural attempt.
- Не называй local-only state опубликованным, delivered или production-ready.
