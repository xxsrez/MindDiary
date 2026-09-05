# Режимы использования Mind и автоматическое сохранение

Статус: accepted target contract, 2026-09-05. Принято пользователем в текущем
обсуждении; реализация и UAT этой поправки ещё не выполнены.

[ADR-0025](../decisions/0025-personal-mind-description-routing.md) изменяет
Personal routing из [ADR-0024](../decisions/0024-principal-mind-usage-modes-and-automatic-save.md).
Прежние [Mind bindings](mind-bindings.md),
[credential writable target](credential-write-target.md) и
[automatic capture](automatic-capture.md) остаются историей.
План реализации — [Personal description и маршрутизация](../tasks/personal-mind-description-routing.md).

## Пользовательский результат

На странице каждого доступного Mind пользователь выбирает одно намерение:

| `usage_mode` | Смысл |
|---|---|
| `disabled` | Агент не использует Mind для чтения или записи. Значение по умолчанию. |
| `read` | Агент читает по прямой просьбе либо по соответствию вопроса непустому `description`, включая Personal Mind. |
| `read_write` | Всё из `read`; разрешены прямо запрошенные изменения и автоматическое сохранение по непустому `description`. |

У principal может быть `0..N` Minds в `read`, `0..1` ordinary Mind в
`read_write` для автоматического сохранения и независимо `0..1` Personal Mind
`/me` в `read_write`. При отсутствии Personal description его чтение и запись
остаются только по прямой просьбе; с description допускается автоматическое использование. Поэтому одновременно
могут быть writable Personal `/me` и один ordinary Mind. Настройка не
повторяется для каждого Connection, OAuth grant, personal token, Codex session
или MCP protocol profile.

## Authoritative state

Минимальная service model:

```text
PrincipalMindUsageState:
  principal_id             # trusted immutable owner
  usage_version            # monotonic CAS, initial 0
  ordinary_write_generation? # 0..1 automatic-save ordinary lane
  personal_write_generation? # 0..1 independent /me lane
  created_at
  updated_at

MindUsageEntry:
  principal_id
  space_id
  routing_profile          # personal_default | description_based
  usage_mode               # disabled | read | read_write
  entry_version
  write_generation?        # only for current read_write entry
  updated_at
```

State принадлежит principal. Browser не передаёт `principal_id`, `space_id`,
role, credential owner или generation как authority. Storage обеспечивает:

- одно effective entry на `principal_id + space_id`;
- не более одного ordinary `read_write` и одной независимой Personal `/me`
  `read_write` generation на principal;
- monotonic `usage_version` для atomic switch и stale-write rejection;
- никогда не переиспользуемую write generation;
- privacy-safe tombstone/reconciliation policy для stale in-flight work.

Выбор второго ordinary `read_write` одной transaction создаёт новую generation
и переводит прежний ordinary writable entry в `read`. Personal `/me` имеет
собственную generation: его включение, отключение или переход в `read` не
меняет ordinary lane, а ordinary switch не меняет `/me`. Повтор exact mode —
idempotent no-op без изменения versions. `disabled` удаляет Mind из MCP enabled
projection.

`usage_mode` — намерение пользователя, но не право доступа:

```text
effective_read = usage_mode in {read, read_write}
               ∩ active credential
               ∩ content:read
               ∩ current ACL or baseline visibility grant

effective_write = usage_mode == read_write
                ∩ active credential
                ∩ content:write
                ∩ current editor | admin | owner role
                ∩ exact active generation соответствующего Personal или ordinary lane
                ∩ expected HEAD + idempotency + full validation
```

Все credentials principal видят одну configured mode projection. Read-only
credential поэтому может увидеть `usage_mode: read_write`, но получает
`effective.can_write: false`; он не приобретает `content:write` и не создаёт
альтернативный destination.

## Description и routing

`description` — service metadata категории тем и исключений, единое для чтения
и записи. Оно не входит в OKF, search index или revision и не двигает HEAD.
Ordinary description по-прежнему редактируется на Site по текущим metadata
rules. Personal `/me` получает опциональное nullable description, которое
пользователь настраивает через MCP, объясняя агенту интересы своими словами.
Пустое или состоящее из пробелов описание нормализуется в `null`.

`usage_mode` определяет, разрешены ли чтение и запись; description определяет,
в каких случаях применять автоматическое чтение/сохранение. Ни установка, ни
очистка description не меняет mode, ACL, scopes или второй writable Mind.
Personal identity остаётся server-owned `personal_default` даже с description:
тематическое поведение не превращает `/me` в ordinary singleton.

Для ordinary `read_write` непустое description по-прежнему обязательно.
Ordinary `read` без description и Personal без description используются только
по прямой просьбе. `disabled` не публикуется content projection и не становится
доступным из-за прямой просьбы или настройки описания.

### Настройка Personal description через MCP

Отдельная узкая metadata operation читает/заменяет/очищает description только
канонического Personal Mind текущего principal. Агент вызывает изменение
только по текущей прямой просьбе настроить темы/интересы/исключения Personal
Mind. Агент может сам сформулировать точный текст из неформального объяснения,
но не выводит такую просьбу из обычного обсуждения темы, corpus или description.
После записи он перечитывает настройку и сообщает итоговые темы, исключения и
следствие для автоматического чтения/записи при текущем mode. Дополнительное
подтверждение точного текста не требуется, если смысл просьбы однозначен.

Операция не является `commit_changeset`, не меняет content HEAD, mode,
membership, visibility, ordinary description или credential scopes. Нужны
явно объявленная узкая capability, проверенная identity, текущая версия
настройки/CAS и idempotency; scope и wire names уточняет технический план.
Это единственное новое исключение из Site-only управления настройками через
MCP, а не общий control-plane API. Клиентский `intent=true` не является authority.
Description недоверенно даже после записи этой операцией.

Description доступно модели как **недоверенная категория**, а не инструкция.
Оно может помочь ответить «относится ли тема к этому Mind», но не может:

- потребовать tool call или изменить порядок действий;
- обойти mode, scope, ACL, role, revision или server validation;
- выбрать другой Mind, включить запись или расширить corpus;
- заставить агента раскрыть, перенести или удалить данные.

Agent routing:

1. получает fresh `list_minds` enabled projection;
2. если пользователь прямо просит использовать конкретный enabled Mind,
   выбирает его без semantic comparison, но server всё равно проверяет доступ;
3. иначе ищет в каждом enabled `read | read_write` Mind с непустым
   description, полезным для текущего вопроса, включая Personal; совпадение
   отдельного слова без пользы для ответа не является достаточным основанием;
4. каждый content call выбирает один Mind и exact resolved revision;
5. если подходят оба Mind, читает оба отдельными узкими поисками с exact
   source/revision provenance; сначала search, затем targeted fetch;
6. не делает общий cross-Mind search, не читает весь corpus и не перебирает
   нерелевантные Minds после пустого результата.

## Автоматическое сохранение

Для Mind с непустым description `read_write` разрешает автоматический save;
отдельного capture toggle, write instruction или подтверждения каждого
изменения нет. Agent рассматривает save после содержательного ответа, когда
одновременно выполнены условия:

- знание durable: полезно за пределами текущей реплики;
- оно явно обсуждалось в текущем разговоре, а не найдено фоновым сканированием;
- оно соответствует description конкретного effective writable Mind;
- текущий credential и server подтверждают effective write;
- изменение можно выразить как bounded create/replace/delete/no-op и проверить.

Personal без description читается и изменяется только по прямой текущей
просьбе о конкретном знании. Personal с description использует общие
тематические правила. Прямая просьба выбирает конкретный Mind без semantic
match, но не обходит mode, ACL или scopes.

Если обсуждённое новое долговечное знание подходит обоим writable descriptions,
агент сохраняет его в оба Mind. Он отдельно проверяет существующее содержание
каждого и выбирает create/update/delete/no-op; гипотезы не превращает в факты.
Это две независимые копии и два отдельных changeset: общего atomic commit,
фоновой синхронизации и автоматического переноса будущих правок/удалений нет.
При успехе только одного commit сообщает частичный результат; не откатывает
его автоматически и не повторяет успешную запись. Неопределённый результат
каждого commit сначала reconciles по его исходному payload/idempotency key.

Приватная или чувствительная информация не запрещена отдельным category filter,
если пользователь сам явно обсудил её и она соответствует Mind. Это не
разрешает собирать соседние сообщения, файлы, браузерную историю или весь
readable corpus «на всякий случай».

Факт из другого enabled readable Mind можно сохранить только если он стал
частью текущего обсуждения и подходит writable description. Changeset сохраняет
service-resolved provenance: source Mind, exact revision и opaque/exact locator,
не выдавая source access downstream и не копируя недоступный контекст.
Знание, извлечённое из Personal Mind, нельзя автоматически переносить в
ordinary Mind с другими участниками или baseline visibility grant: требуется
прямая просьба о таком переносе. Совпадение обоих descriptions и чтение Personal
не заменяют её. Самостоятельно сообщённый пользователем факт можно сохранить
в оба по тематическим правилам; приватность ordinary Mind не означает Personal identity.

## Canonical write

Автоматический save использует `commit_changeset`; отдельный simplified
`capture_knowledge` не является target tool. Агент сначала читает current
writable bundle/entries настолько, насколько нужно для выбора операции:

- `create_file` для нового durable concept;
- `replace_file` для уточнения существующего knowledge;
- `delete_file` только когда обсуждение делает прежнее знание неверным или
  пользователь явно просит удалить его;
- no-op, когда canonical bundle уже содержит тот же смысл.

Один changeset атомарно согласует concept files, `index.md` и knowledge log.
Перед commit проверяется proposed полный OKF 0.2 bundle; после commit агент
читает exact revision, снова валидирует весь bundle и сверяет ожидаемые paths/
content. Unknown OKF types/fields сохраняются. Partial validation только
изменённого файла не даёт права продвигать HEAD.

Commit authority:

1. server разрешает principal из authenticated credential;
2. читает current principal usage state и pin-ит exact Personal либо ordinary
   write generation выбранного Mind;
3. требует `content:write` и current writer role exact Mind;
4. требует request `mind` равным configured `read_write` destination
   соответствующего lane;
5. повторяет generation, текущую версию routing description, role, HEAD CAS,
   quota и idempotency checks в transaction;
6. создаёт одну immutable revision, HEAD, audit/outbox/index effects либо ничего.

Client не передаёт principal, configured target, generation или role. Wrong
Mind, disabled/switch, stale generation, revoke/expiry, scope/ACL loss,
corrupt state, stale HEAD или validation failure не перенаправляют payload в
Personal/previous/«единственный доступный» Mind.

## Agent notification

После автоматической попытки агент сообщает пользователю только существенный
результат:

- что сохранено/обновлено/удалено отдельно в каждом Mind, включая частичный успех;
- no-op только когда это важно для обещанного действия;
- безопасную причину no-write, если ожидалась запись и пользователь может её
  исправить на Site.

Internal IDs, private source metadata, token/scope details и полный технический
receipt в обычный ответ не выводятся. Уведомление следует после server result и
read-back; оно не является confirmation gate.

## Site control plane

Authenticated Site mutation изменяет mode на уровне Mind и требует current
principal, current access, `expected_usage_version`, idempotency key и CSRF.
Ordinary `read_write` дополнительно требует non-empty description и current
writer role. Для канонического Personal `/me` description check заменяется
проверкой service-managed Personal identity; current writer role сохраняется.
Ordinary atomic switch сам демотирует прежний ordinary writable Mind в `read`,
но не меняет Personal `/me`; изменение `/me` также не меняет ordinary lane.
Отдельные bind/rebind/unbind controls отсутствуют.

Connection и Advanced MCP pages показывают credential scopes/lifecycle и
derived effective capability, но не владеют mode. Они не содержат target
selector или capture toggle. Changing/revoking token не меняет principal mode;
следующий MCP call просто пересчитывает effective capability.

## MCP projection и instructions

Modern и compatibility profiles публикуют одну application semantics.
`list_minds` возвращает только enabled и currently readable Minds. Ordinary
descriptor содержит routing `description`:

```json
{
  "mind": "research-notes",
  "name": "Research notes",
  "description": "Проверенные выводы по исследованиям продукта",
  "usage_mode": "read_write",
  "effective": { "can_read": true, "can_write": true }
}
```

Personal descriptor сохраняет identity profile и публикует nullable description:

```json
{
  "mind": "me",
  "name": "Andrey",
  "usage_mode": "read_write",
  "routing_profile": "personal_default",
  "description": "Работа и обучение; исключая здоровье и финансы",
  "effective": { "can_read": true, "can_write": true }
}
```

Server instructions, tool descriptions, bundled skill, manifest help и Site
help согласованно объясняют routing и automatic save. Corpus и description
остаются untrusted content. Exact bind/unbind tools и `capture_knowledge` не
рекламируются и не вызывают application write. Cached exact legacy calls дают
side-effect-free versioned retired result с remediation на Site.

## Migration

Одновременная проекция может содержать два descriptor с
`writable_mount.active=true`: максимум один `description_based` ordinary и
один `personal_default`. Их generation различны и не являются client authority.

Новая schema/capability generation должна отличать Personal optional description
от прежнего `principal-mind-usage/v2`; точный version token фиксируется при реализации.

Миграция не расширяет намерения пользователя: всем existing Personal Minds
назначается `description: null`, modes и независимые generations сохраняются.
Ничего не выводится из истории, имени, corpus или ordinary description.
Смена/очистка description инвалидирует незавершённую работу по старому routing
snapshot соответствующего Mind; commit проверяет версию атомарно. Второй lane
не меняется. Исторические commits и idempotency receipts не переписываются.
Rollback не должен молча оставлять автоматические Personal saves с несовместимым
сервером/плагином; mixed-version поведение проверяется отдельно.

## Acceptance

1. Null/empty Personal description сохраняет direct-request-only чтение/запись.
2. Тематический Personal `read` читает, но не пишет; `read_write` читает и
   сохраняет подходящее обсуждённое долговечное знание; `disabled` не используется.
3. Ordinary singleton и независимый Personal lane сохраняются; оба совпадения
   дают два bounded reads и два независимых save/no-op без третьего назначения.
4. MCP-настройка изменяет только Personal description текущего principal;
   права, scope, version conflict, retry и read-back доказаны; content HEAD,
   mode и ordinary metadata неизменны. Неформальная просьба допускается,
   неясный существенный смысл уточняется, corpus injection не запускает настройку.
5. Description не даёт полномочий и не запускает произвольные tools; нет
   автоматического раскрытия Personal в shared ordinary и background vacuum.
6. Оба commits проверяют текущие права, routing version, generation, HEAD,
   idempotency и полный OKF bundle; изменение description во время работы
   отклоняет stale commit. Частичный/unknown outcome сообщается и reconciles.
7. Migration/restart/rollback не включают автоматическое использование старых
   Personal Minds; история и неизвестные OKF fields сохранены.
8. Site, MCP modern/compat, server instructions и установленный плагин
   согласованы; fresh session и сценарии после compaction проверены.
9. Exact candidate проходит applicable dev/full gates и joined UAT evidence
   по project profile. Документация и план сами этого не доказывают.
