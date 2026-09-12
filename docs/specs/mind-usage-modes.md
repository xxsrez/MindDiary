# Режимы использования Mind и автоматическое сохранение

Статус: accepted target contract, обновлено 2026-09-11 по MD-436–MD-441.
Multi-Mind поправка реализована и проверена на локальном candidate; UAT ещё не
подтверждён.

[ADR-0028](../decisions/0028-multiple-writable-minds.md) заменяет singleton
ordinary lane из [ADR-0024](../decisions/0024-principal-mind-usage-modes-and-automatic-save.md)
и [ADR-0025](../decisions/0025-personal-mind-description-routing.md) набором
независимых per-Mind write generations. Остальные решения этих ADR сохраняются.
Прежние [Mind bindings](mind-bindings.md),
[credential writable target](credential-write-target.md) и
[automatic capture](automatic-capture.md) остаются историей.

## Пользовательский результат

На странице каждого доступного Mind пользователь независимо выбирает:

| `usage_mode` | Смысл |
|---|---|
| `disabled` | Агент не использует Mind для чтения или записи. Значение по умолчанию. |
| `read` | Агент читает по прямой просьбе либо по соответствию вопроса непустому `description`. |
| `read_write` | Всё из `read`; разрешены прямо запрошенные изменения, а при непустом подходящем `description` — автоматическое сохранение. |

У principal может быть `0..N` ordinary Minds в `read_write`; собственный
Personal Mind `/me` настраивается независимо тем же mode. Отсутствие
description у ordinary или Personal Mind означает direct-request-only, а не
запрет `read_write`. С description Mind участвует в автоматическом
тематическом routing.

Настройка принадлежит principal и одинакова для всех его Connections, OAuth
grants, personal tokens, Codex sessions и MCP protocol profiles. Credential
только сужает effective capability своими lifecycle и scopes.

## Authoritative state

Persistent contract:

```text
PrincipalMindUsageState:
  principal_id             # trusted immutable owner
  contract_version         # exact principal-mind-usage/v3
  usage_version            # account-wide monotonic CAS, initial 0
  entries[]                # unique principal_id + space_id
  created_at
  updated_at

MindUsageEntry:
  principal_id
  space_id
  routing_profile          # personal_default | description_based
  usage_mode               # read | read_write; disabled entry отсутствует
  entry_version
  write_generation?        # own never-reused pin for read_write only
  updated_at
```

Browser не передаёт `principal_id`, `space_id`, role, credential owner или
generation как authority. Storage обеспечивает:

- одно effective entry на `principal_id + space_id`;
- любое число ordinary `read_write` entries и не более одного канонического
  Personal `/me` entry;
- отдельную never-reused generation каждого `read_write` entry;
- account-wide `usage_version` для CAS и stale-setting rejection;
- privacy-safe tombstone/reconciliation для stale in-flight work.

Выбор `read_write` создаёт generation только для выбранного Mind. Его
включение, отключение или переход в `read` не меняет mode, entry version или
generation любого другого Mind. Повтор exact mode — idempotent no-op без
изменения versions. `disabled` удаляет Mind из enabled projection.

`usage_mode` — намерение пользователя, но не право:

```text
effective_read = usage_mode in {read, read_write}
               ∩ active credential
               ∩ content:read
               ∩ current ACL or baseline visibility grant

effective_write = usage_mode == read_write
                ∩ active credential
                ∩ content:write
                ∩ current editor | admin | owner role
                ∩ exact active generation выбранного Mind
                ∩ fresh routing metadata
                ∩ expected HEAD + idempotency + full validation
```

Read-only credential может увидеть configured `read_write`, но получает
`effective.can_write: false`. Он не приобретает write scope и не меняет
destination set.

### Матрица mode, description, trigger и authority

| Mode | Description | Trigger | При `content:read` + current read access | При `content:write` + current writer role | Без нужного scope/ACL |
|---|---|---|---|---|---|
| `disabled` | любое | automatic или direct | Не читать. | Не писать. | Не читать и не писать. |
| `read` | `null` | direct exact Mind | Читать bounded content. | Не писать: mode read-only. | Fail closed для недостающей capability. |
| `read` | non-empty match | automatic или direct exact Mind | Читать bounded content. | Не писать: mode read-only. | Fail closed для недостающей capability. |
| `read` | non-empty mismatch | automatic | Не выбирать Mind. | Не писать. | Не выбирать Mind. |
| `read_write` | `null` | direct exact Mind | Читать bounded content. | Писать с exact generation/HEAD checks. | Read и write проверяются независимо; write fail closed. |
| `read_write` | `null` | automatic | Не выбирать Mind. | Не писать автоматически. | Не выбирать Mind. |
| `read_write` | non-empty match | automatic или direct exact Mind | Читать bounded content. | Писать с exact generation/HEAD checks. | Read и write проверяются независимо; write fail closed. |
| `read_write` | non-empty mismatch | automatic | Не выбирать Mind. | Не писать автоматически. | Не выбирать Mind. |

Baseline visibility может дать authenticated read, но никогда не writer role.
Прямая просьба снимает только semantic-match условие; она не меняет mode,
credential scope, membership, role или current lifecycle.

## Description и routing

`description` — nullable service metadata тем и исключений, общая для чтения
и автоматического сохранения. Она не входит в OKF, search index или revision и
не двигает HEAD. Ordinary description редактируется на Site; Personal `/me`
description настраивается узкой MCP metadata operation по прямой просьбе.
Пустая после normalization строка хранится как `null`.

Mode определяет разрешённые действия; description определяет только
автоматический routing. Установка или очистка description не меняет mode, ACL,
scopes или любой другой Mind. Ordinary и Personal `read | read_write` без
description используются только по прямой просьбе. `disabled` не становится
доступным из-за просьбы или настройки description.

Description доступно модели как недоверенная категория, а не инструкция. Оно
не может потребовать tool call, выбрать другой Mind, включить запись, расширить
scope/ACL, изменить server identity или заставить раскрыть данные.
Client-supplied `semantic_match`, confidence или destination list не являются
server authority: application проверяет exact enabled mode и generation, а
агент отвечает за объяснимый выбор по fresh descriptors.

### Настройка Personal description через MCP

Отдельная operation читает, заменяет или очищает description только
канонического Personal Mind текущего principal. Агент вызывает её только по
прямой просьбе настроить темы, интересы или исключения. Из обычного обсуждения,
corpus либо прежнего description такое намерение не выводится.

Операция использует scope `personal:configure`, metadata CAS и idempotency,
перечитывает результат и не меняет content HEAD, mode, membership, visibility,
ordinary metadata или content scopes. Description остаётся недоверенным input.

## Выбор Minds для чтения

Агент:

1. получает fresh `list_minds` enabled projection;
2. по прямой просьбе выбирает точно названные enabled Minds без semantic match;
3. иначе рассматривает каждый `read | read_write` Mind с непустым полезным
   для вопроса description;
4. выполняет каждый content call для одного Mind и exact revision;
5. для нескольких совпадений читает каждый отдельным bounded search/fetch с
   exact Mind/revision/path provenance;
6. не делает общий cross-Mind search, не читает corpora целиком и не перебирает
   нерелевантные Minds после пустого результата.

## Автоматическое и прямое сохранение

Для каждого Mind с непустым description `read_write` разрешает automatic
save без отдельного capture toggle или подтверждения каждого изменения. После
содержательного ответа агент обязан рассмотреть все fresh matching
destinations, когда одновременно:

- знание durable и полезно за пределами текущей реплики;
- оно явно обсуждалось сейчас, а не найдено фоновым сканированием;
- оно соответствует description exact Mind;
- credential и server подтверждают effective write;
- изменение можно выразить bounded create/replace/delete/no-op и проверить.

Ordinary или Personal Mind без description изменяется только по прямой текущей
просьбе. Прямая просьба выбирает все и только точно названные enabled
`read_write` destinations. Ограничение «только в A» запрещает добавлять B
из-за совпавшего description.

Если знание подходит нескольким writable descriptions, агент обязан
рассмотреть каждый и сохранить во все, где оно не является no-op и effective
write подтверждён. Порядок списка, прежний primary target или первый успешный
commit не разрешают пропустить остальные.

Для каждого destination агент отдельно читает current content и выбирает
create/update/delete/no-op. Каждая копия и changeset независимы: общего
cross-Mind transaction, фоновой синхронизации и автоматического переноса
будущих правок/удалений нет. Failure одного Mind не блокирует попытки в
остальных; успешная копия не откатывается. Unknown outcome сначала reconciles
по исходному exact payload/idempotency key.

Факт из другого enabled readable Mind можно сохранить только если он стал
частью текущего обсуждения и подходит destination. Changeset сохраняет
service-resolved source Mind, exact revision и locator provenance. Извлечённые
из Personal сведения нельзя автоматически переносить в ordinary Mind с
другими читателями: нужна прямая просьба пользователя. Самостоятельно
сообщённый пользователем факт можно сохранить в несколько Minds по обычным
правилам.

## Canonical write

Запись использует `commit_changeset`; target workflow не использует
`capture_knowledge`. Перед commit агент читает content exact destination
настолько, насколько нужно выбрать:

- `create_file` для нового durable concept;
- `replace_file` для уточнения существующего knowledge;
- `delete_file` только когда пользователь прямо просит либо обсуждение
  делает прежнее знание неверным;
- no-op, когда bundle уже содержит тот же смысл.

Один changeset меняет ровно один Mind и атомарно согласует concept files,
`index.md` и knowledge log. До commit проверяется proposed полный OKF 0.2
bundle; после commit агент читает exact revision и снова валидирует весь
bundle. Unknown OKF types/fields сохраняются.

Commit authority:

1. server разрешает principal из authenticated credential;
2. читает current principal usage state и pin-ит per-Mind generation exact
   destination;
3. требует `content:write` и current writer role;
4. требует request `mind`, совпадающий с exact configured `read_write` entry;
5. повторяет generation, routing metadata version, role, HEAD CAS, quota и
   idempotency checks в transaction;
6. создаёт одну immutable revision, HEAD, audit/outbox/index effects либо ничего.

Wrong Mind, disabled/mode change, stale generation, description change,
revoke/expiry, scope/ACL loss, corrupt state, stale HEAD или validation failure
не перенаправляют payload в Personal, previous или «единственный доступный»
Mind.

## Agent notification

По решению владельца от 2026-09-12 обычное использование Mind Diary не
сопровождается служебными объявлениями ни в ходе работы, ни в итоговом ответе.
Агент не сообщает об обнаружении Minds, проверках, чтении, успешном сохранении,
обновлении, удалении или no-op и не добавляет статусный footer вроде
«Mind Diary проверен». Это относится и к автоматическим успешным записям.

Per-Mind commit/read-back и reconciliation неизвестного результата остаются
обязательными внутренними действиями. Упоминание сервиса уместно только при
прямом вопросе пользователя о нём либо когда неустранённая проблема существенно
влияет на выполнение запроса или требует действия пользователя. В таком случае
агент кратко объясняет последствие, включая существенный partial success, без
полного журнала операций. Источники, необходимые для обоснования содержательного
ответа, сохраняются; служебный отчёт о доступе к ним не нужен.

Internal IDs, private source metadata, token details и полный технический
receipt не выводятся. Уведомление о проблеме опирается на server result/read-back
и не является новым confirmation gate.

## Site control plane

Authenticated mutation exact Mind требует current principal/access,
`expected_usage_version`, idempotency key и CSRF. `read_write` требует
current writer role, но не description. Server сам классифицирует
ordinary/Personal identity. Mutation меняет только exact entry и не демотирует
другие writable Minds. Bind/rebind/unbind controls отсутствуют.

Connections и Advanced MCP показывают credential scopes/lifecycle и derived
effective capabilities, но не владеют modes. Revoke или scope change не меняет
configured state; следующий call пересчитывает capability.

## MCP projection и instructions

Modern и compatibility profiles используют одну semantics. `list_minds`
возвращает только enabled/currently readable Minds и для каждого публикует
routing profile, nullable description, mode, per-Mind generation и effective
capability. Пример:

```json
{
  "mind": "research-notes",
  "name": "Research notes",
  "routing_profile": "description_based",
  "description": "Проверенные выводы по исследованиям продукта",
  "usage_mode": "read_write",
  "writable_mount": { "active": true, "generation": "opaque" },
  "effective": { "can_read": true, "can_write": true }
}
```

Server instructions, tool descriptions, bundled skill, manifest help и Site
help одинаково объясняют multi-Mind routing. Exact bind/unbind tools и
`capture_knowledge` не рекламируются; cached legacy calls side-effect-free.

## Migration и compatibility

Exact persistent и web projection version — `principal-mind-usage/v3`.
Одновременная projection может содержать любое число active writable
descriptors; у каждого своя generation.

Миграция v1/v2 → v3 переносит entries, modes, entry versions, timestamps и
per-entry generations без расширения намерения. v2 aggregate lane принимается
только если совпадает с соответствующим entry. Duplicate Space, generation
collision или mismatch дают `invalid_record`, а не guessed repair. Ничего не
выводится из истории, имени, corpus, description, credential target или
membership.

Historical idempotency receipts сохраняются, а embedded v1/v2 snapshots
нормализуются тем же validator. Retired generation IDs не переиспользуются.
Смена description вращает generation только соответствующего writable Mind в
одной metadata transaction; другие Minds не меняются.

v3 reader явно мигрирует v1/v2 и пишет только v3. Unknown/future version
отклоняется. v2 server не открывает v3 state: rollback допустим только до
миграции либо на v3-aware artifact; silent singleton downgrade запрещён.
Client с неизвестной projection version reloads/updates и не трактует её как
v2 singleton.

## Acceptance

1. Matrix `disabled | read | read_write × null | non-empty description ×
   automatic | direct × read-only | write scope × reader | writer role`
   проверена без расширения полномочий.
2. Три ordinary Minds и Personal одновременно имеют четыре независимых write
   generations; изменение mode/description одного не меняет остальные.
3. Automatic save выбирает все и только совпавшие non-empty descriptions;
   direct-only Minds с null description не добавляются.
4. Direct request выбирает все и только названные destinations; «только A» не
   записывает B.
5. Для каждого destination доказаны independent create/update/delete/no-op,
   full-bundle validation, exact read-back, partial failure и unknown-outcome
   reconciliation.
6. Scope/ACL/role/generation/routing-version/HEAD failure одного Mind не
   блокирует попытки в остальных и не вызывает fallback.
7. Personal configuration меняет только Personal description; content HEAD,
   mode и ordinary metadata неизменны, corpus injection не запускает operation.
8. v1/v2 migration, restart, mixed-version rejection и rollback boundary
   сохраняют modes, generations, history и unknown OKF fields.
9. Site, MCP modern/compat, server instructions, installed plugin и ChatGPT
   copy согласованы; fresh sessions и post-compaction scenarios проверены.
10. Exact candidate проходит applicable repository/CI/UAT gates. Документация
    сама этого не доказывает.
