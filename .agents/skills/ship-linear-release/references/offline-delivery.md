# Локальная очередь при неполадках Git hosting

Читай этот файл, когда Git hosting подтверждённо деградирован и пользователь
разрешил продолжать local-only. Техническая неполадка remote не останавливает
разработку, пока существует безопасная локальная работа; она лишь откладывает
publication, remote CI и зависящее от них доказательство delivery.

## Войти в offline mode

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

1. Делай bounded неблокирующую попытку на содержательных checkpoints и по
   согласованному recurring heartbeat. Не жди remote в foreground, не polling-и
   чаще расписания и не создавай новую automation после каждой неудачи.
2. Если remote ещё недоступен, запиши только изменившееся evidence и сразу
   продолжи локальную очередь. Технический push/CI fail сам по себе не переводит
   goal в `blocked`, пока остаётся локальная работа.
3. Когда remote доступен, fetch-ни exact `origin/<default>`. Если он равен
   `base_origin`, потребуй ancestry `base_origin -> local_head` и выполни один
   fast-forward CAS push exact `local_head`.
4. При remote drift ничего не переписывай. Создай aggregate generation от
   свежего origin, добавь offline chain и чужие commits обычным merge, проверь
   semantic conflicts, reseal и один раз выполни полный integrated gate нового
   tree. Затем fast-forward local default и push aggregate head без force.
5. Дождись configured required CI exact published head. Один успешный run
   финального head покрывает накопленные ancestor batches только вместе с их
   собственными сохранёнными integrated gates; запиши head/run в
   `PUBLISHED_BY` каждого batch.
6. После CI success обнови pending batch receipts до `integrated`, перечитай
   live scope, переведи покрытые issue в `Done`, release их claims и выполни
   свежий milestone snapshot. `release` profile дополнительно проходит обычные
   Sites/live/tag gates; offline queue никогда их не заменяет.
7. Очисти offline queue и отключи heartbeat только после проверки remote
   default, terminal CI, Linear closure и отсутствия незаписанных commits.

## Делать handoff при незапушенных commits

Если turn, run или локальная реализация заканчиваются до успешной публикации,
явно предупреди пользователя. Укажи exact `base_origin`, `local_head`, число
неопубликованных commits, pending batch IDs, последнюю причину push/CI failure и
время следующей ленивой попытки. Не называй такой state опубликованным,
доставленным или production-ready и не скрывай его только потому, что локальные
checks прошли.
