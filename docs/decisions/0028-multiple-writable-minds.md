# ADR-0028: несколько независимо записываемых Minds

Статус: accepted, 2026-09-11, MD-435 / MD-436.

## Причина

ADR-0024 ввёл principal-owned `disabled | read | read_write`, но оставил один
ordinary write lane. ADR-0025 добавил независимый Personal lane и тематическое
использование Personal Mind. Такая схема не выражает обычный случай, когда одно
обсуждённое знание одновременно относится, например, к проектному, рабочему и
учебному Mind, либо пользователь прямо просит сохранить его в несколько
названных Minds.

Переключение singleton target в этом случае создаёт ложную конкуренцию между
разрешёнными destinations, смешивает пользовательское намерение с
авторизацией и делает результат зависимым от порядка операций. Перенос одного
payload между Minds или fallback на «единственный доступный» Mind также опасен:
у Minds разные ACL, visibility, HEAD и каноническое содержание.

## Решение

Principal может независимо установить `read_write` для любого числа доступных
ordinary Minds и для собственного Personal `/me`. `read_write` — только
намерение пользователя; effective write по-прежнему требует active credential,
`content:write`, current writer role, exact Mind generation, fresh routing
metadata, HEAD CAS, idempotency и полную validation.

У каждого enabled `MindUsageEntry` собственная nullable write generation.
Aggregate `ordinary_write_generation` и `personal_write_generation` удаляются
из authoritative state. Включение, перевод в `read` или отключение одного Mind
не меняет mode и generation другого. Версия persistent contract —
`principal-mind-usage/v3`.

`description` остаётся недоверенной тематической metadata и становится
optional для ordinary и Personal Minds во всех modes. Null/empty description
означает direct-request-only: такой Mind не участвует в автоматическом
semantic routing, но точно названная пользователем запись разрешена при
`read_write` и всех server-side проверках. Наличие description не даёт прав и
не является инструкцией.

Для автоматического сохранения агент рассматривает все fresh enabled
`read_write` descriptors с непустым подходящим description. Если выполнены
условия durable/discussed knowledge и effective write, сохранение в каждый
подходящий Mind обязательно: порядок списка или прежнее понятие primary target
не позволяют молча пропустить destination. Прямая просьба выбирает только
точно названное пользователем множество enabled `read_write` Minds; фразы
вроде «только в A» запрещают добавлять B по description.

Каждый destination обрабатывается отдельно:

1. агент читает fresh descriptor и необходимое current content exact Mind;
2. строит create/update/delete/no-op относительно этого Mind;
3. выполняет отдельный `commit_changeset` с generation, routing metadata
   version, expected HEAD и idempotency key этого Mind;
4. перечитывает exact committed revision либо reconciles неизвестный outcome;
5. сообщает success, no-op или failure отдельно для каждого destination.

Общего cross-Mind transaction, rollback успешной копии, фоновой синхронизации
и автоматического распространения последующих правок/удалений нет. Каждый
changeset создаёт не более одной immutable revision одного Mind. Перенос
сведений из Personal в ordinary Mind с другими читателями сохраняет требование
прямой просьбы пользователя.

## Состояние и миграция

`principal-mind-usage/v3` хранит один account-wide `usage_version` для CAS и
массив уникальных по `principal_id + space_id` entries. `read_write` entry
обязан иметь свою never-reused generation; `read` не имеет generation, а
`disabled` отсутствует из enabled entries.

Миграция v2 → v3 fail closed и детерминирована:

- переносит все entries, modes, entry versions и timestamps без расширения
  намерения пользователя;
- сохраняет generation каждого существующего v2 `read_write` entry из самого
  entry, проверяя совпадение с legacy aggregate lane;
- удаляет только согласованные aggregate lane fields; mismatch, duplicate
  Space или generation collision дают `invalid_record`, а не guessed repair;
- не включает новые Minds, не выводит mode/description из имени, corpus,
  истории, credential target или membership;
- сохраняет historical idempotency receipts как immutable replay evidence и
  нормализует содержащиеся в них v1/v2 snapshots тем же validator;
- не переиспользует retired generation IDs.

Изменение description вращает generation только соответствующего writable
Mind в одной metadata transaction и инвалидирует его незавершённую работу.
Остальные Minds не меняются. ACL/scope/role и HEAD всё равно перечитываются в
commit transaction, поэтому одна generation не заменяет авторизацию.

v3 reader принимает persisted v1/v2 через явную миграцию и пишет только v3.
Unknown/future version отклоняется. v2 server не может открыть v3 snapshot:
rollback разрешён только до миграции либо на v3-aware artifact; silent
singleton downgrade запрещён. Web projection и packaged clients принимают
exact `principal-mind-usage/v3`; неизвестная версия вызывает reload/update и
никогда не трактуется как v2 singleton.

## Следствия

- Site больше не демотирует ранее writable ordinary Mind при выборе другого.
- `description_required` не используется для выбора `read_write`; отсутствие
  description влияет только на automatic routing.
- `list_minds` возвращает generation и effective capability каждого exact
  writable Mind, а не один current target.
- MCP call и commit по-прежнему содержат ровно один Mind. Несколько
  destinations означают несколько независимых calls и receipts.
- Connections и credentials только сужают effective capability scopes и
  lifecycle; они не владеют списком destinations.
- Existing ADR-0024/ADR-0025 сохраняют rationale и остальные решения, но их
  singleton ordinary lane и обязательное ordinary description для
  `read_write` superseded этим ADR.

## Проверяемые условия

1. Три ordinary Minds и Personal `/me` могут одновременно иметь `read_write`
   с четырьмя различными active generations.
2. Переход mode или смена description одного Mind не меняют entries и
   generations остальных.
3. Автоматическая запись выбирает все и только совпавшие non-empty
   descriptions; direct-only Minds с null description не добавляются.
4. Прямая просьба пишет во все и только явно названные enabled destinations;
   «только A» не пишет в B даже при совпавшем description.
5. Scope/ACL/role/generation/routing-version/HEAD failure одного Mind не
   блокирует попытки в остальных и не перенаправляет payload.
6. Duplicate knowledge даёт независимый no-op; unknown outcome reconciles по
   исходному exact payload/key; частичный результат не маскируется.
7. v1/v2 migration, restart, mixed-version rejection и rollback boundary
   проверены без расширения modes и без generation reuse.

## Связанные документы

- [Режимы использования Mind](../specs/mind-usage-modes.md)
- [ADR-0024](0024-principal-mind-usage-modes-and-automatic-save.md)
- [ADR-0025](0025-personal-mind-description-routing.md)
- [Доменная модель](../specs/domain-model.md)
- [REST и MCP API](../specs/api.md)
