# Деградация GitHub и локальная очередь

Читай этот файл при наблюдаемой аномалии GitHub: ошибках Git/API, отсутствии
ожидаемого workflow run, задержке webhook, зависшем runner или сбое Pages. Для
local-only частей дополнительно требуется явное разрешение пользователя.

## Добавить официальный status как контекст

1. После наблюдаемой внешней аномалии один раз прочитай официальный
   [GitHub Status](https://www.githubstatus.com/),
   [current status API](https://www.githubstatus.com/api/v2/status.json) и
   [unresolved incidents API](https://www.githubstatus.com/api/v2/incidents/unresolved.json).
   Не обращайся туда на каждом обычном batch и не используй сторонний пересказ
   вместо официального источника.
2. Всегда разделяй:
   - фактическое evidence этого run: exact SHA, результат push/API, наличие и
     состояние workflow/check, конкретную ошибку;
   - внешний контекст: component, incident impact/status, время последнего
     update, время проверки и incident URL.
   Status не доказывает причину отдельного сбоя и не заменяет проверку exact
   repo/SHA.
3. Сопоставляй только затронутый component с текущей стадией. Например, outage
   Actions или throttling Webhooks может объяснять отсутствие workflow после
   успешного push, не означая отказ Git Operations. GitHub Pages не относится
   к OpenAI Sites; Copilot incident не относится к локальному Codex run, если
   соответствующая GitHub service фактически не используется.
4. Классифицируй влияние на этот run, а не по одному глобальному banner:
   - `blocking-current-gate` — matching incident мешает обязательной текущей
     capability, например публикации ref или configured exact-SHA CI перед
     `Done`;
   - `degraded-nonblocking-now` — локальная/независимая работа продолжается или
     затронута только более поздняя/необязательная capability;
   - `unrelated` — incident не совпадает с наблюдаемой surface.
   Даже `Major Outage` может быть нерелевантен этому release path, а частичная
   деградация Actions — блокировать только Linear closure покрытых issue.
5. Не меняй flow, acceptance или gates по status page: не ставь `pass`/`fail`,
   не ослабляй required CI, не создавай fallback, не отменяй job и не добавляй
   retries. Если matching incident нет, продолжай обычную repo-specific
   диагностику. Оценку восстановления используй лишь как подсказку для handoff;
   это не гарантия и не причина создавать timer/polling loop.
6. Кратко сохрани контекст в `CAPABILITIES`/`GAPS`: observed symptom, official
   component/impact/status, `updated_at`, `checked_at`, incident URL и влияние
   на текущую стадию. Не копируй полную хронику incident. Перепроверяй status
   только на естественном terminal checkpoint либо перед новым утверждением,
   что incident всё ещё продолжается.
7. Пользователю сообщай четырьмя частями: что наблюдалось в exact repo/SHA; что
   официально сообщает GitHub и на какое UTC-время; что это реально блокирует
   или не блокирует; какое действие основного flow идёт дальше.

## Войти в offline mode

Входи сюда только когда недоступна Git publication/CAS и пользователь разрешил
local-only progress. Component-scoped outage Actions сам по себе не делает весь
Git hosting offline: если refs публикуются, сохраняй online Git path, отмечай
exact-SHA CI как `pending-outage` и продолжай безопасную локальную работу.
Техническая неполадка remote не останавливает разработку, пока существует
безопасная локальная работа; она лишь откладывает publication, remote CI и
зависящее от них доказательство delivery.

1. Разрешай offline mode только существующему coordinator-у с восстановленным
   `run_id`. Не выполняй takeover с другой машины: remote CAS недоступен.
2. Зафиксируй последний доказанный `origin/<default>` как `base_origin`, clean
   local default как `local_head`, незавершённые remote jobs и ordered pending
   batches в `RELEASE_RUN.OFFLINE_QUEUE`.
3. Не отменяй и не объявляй failed уже запущенный exact-SHA CI только из-за
   outage. Сохрани его ID для последующего terminal read.
4. Оставляй локально готовые issue в `In Review`, не в `Done`. Активные claims
   остаются привязаны к exact local refs до публикации.

## Делать local-only batch

1. Строй следующий batch от clean local default, который обязан быть
   descendant `base_origin`. Coordinator остаётся единственным владельцем
   local default; workers используют отдельные worktrees и local-only feature
   refs без обращения к origin.
2. Выполни обычные feature gates, sealing и один полный integrated gate. Remote
   pre-push CI запиши `pending-outage`, а не `pass`, `fail` или `none`.
3. Перед продвижением проверь CAS локально: `local/<default>` всё ещё равен
   expected local head, а candidate является его descendant. Продвинь local
   default только fast-forward, без reset, history rewrite или force.
4. Upsert-ни `BATCH_RELEASE_RECEIPT` со статусом `locally-integrated`, exact
   candidate/tree/validation key, `MAIN.cas=pending`, `CI=pending-outage`,
   `PUBLISHED_BY=none` и `LINEAR_DONE=none`.
5. Обнови `RELEASE_RUN` со статусом `offline-queue`, новым `local_head` и
   ordered pending batches. Этот terminal checkpoint разрешает следующий
   local-only batch; не считай remote outage goal blocker, пока существует
   безопасный независимый local subset.
6. Удаляй только task-owned worktrees/refs, чьи commits достижимы из local
   default и полностью описаны durable receipts. Не удаляй offline base,
   local default или единственное доказательство незапушенного commit.

## Лениво пытаться опубликовать

1. После каждого terminal local batch посмотри `LAST_REMOTE_ATTEMPT`. Если
   предыдущая попытка завершилась technical failure менее часа назад, сразу
   пропусти remote step и продолжи следующий batch. Если прошёл минимум час
   либо попытки ещё не было, выполни ровно одну bounded push/CI попытку.
2. Не создавай recurring automation, timer или отдельный polling loop. Throttle
   привязан к естественным batch checkpoints, а не к wall-clock wakeups.
3. Когда вся локальная работа goal исчерпана, выполни последнюю remote попытку
   независимо от прошедшего интервала. При technical failure предупреди
   пользователя и сохрани незапушенную очередь; не называй её доставленной.
4. Если remote ещё недоступен, запиши изменившееся evidence и сразу продолжи
   локальную очередь. Технический push/CI fail сам по себе не переводит goal в
   `blocked`, пока остаётся безопасная локальная работа.
5. Когда remote доступен, fetch-ни exact `origin/<default>`. Если он равен
   `base_origin`, потребуй ancestry `base_origin -> local_head` и выполни один
   fast-forward CAS push exact `local_head`.
6. При remote drift ничего не переписывай. Создай aggregate generation от
   свежего origin, добавь offline chain и чужие commits обычным merge, проверь
   semantic conflicts, reseal и один раз выполни полный integrated gate нового
   tree. Затем fast-forward local default и push aggregate head без force.
7. Дождись configured required CI exact published head. Один успешный run
   финального head покрывает накопленные ancestor batches только вместе с их
   собственными сохранёнными integrated gates; запиши head/run в
   `PUBLISHED_BY` каждого batch.
8. После CI success обнови pending batch receipts до `integrated`, перечитай
   live scope, переведи покрытые issue в `Done`, release их claims и выполни
   свежий milestone snapshot. `release` profile дополнительно проходит обычные
   Sites/live/tag gates; offline queue никогда их не заменяет.
9. Очисти offline queue только после проверки remote default, terminal CI,
   Linear closure и отсутствия незаписанных commits.

## Делать handoff при незапушенных commits

Если turn, run или локальная реализация заканчиваются до успешной публикации,
явно предупреди пользователя. Укажи exact `base_origin`, `local_head`, число
неопубликованных commits, pending batch IDs, время/причину последней remote
ошибки и `next_eligible_at`. Не называй такой state опубликованным,
доставленным или production-ready и не скрывай его только потому, что локальные
checks прошли.
