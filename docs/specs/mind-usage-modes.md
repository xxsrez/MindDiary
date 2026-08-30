# Режимы использования Mind и автоматическое сохранение

Статус: accepted target contract для MD-373, 2026-08-30. Реализация,
Marketplace package и hosted UAT принадлежат MD-374–MD-380 и требуют отдельного
evidence exact candidate/deployment.

Решение принято в
[ADR-0024](../decisions/0024-principal-mind-usage-modes-and-automatic-save.md).
Документ заменяет target authority historical
[Mind bindings](mind-bindings.md),
[credential writable target](credential-write-target.md) и
[automatic capture](automatic-capture.md), сохраняя их как evidence прежних
release contracts.

## Пользовательский результат

На странице каждого доступного Mind пользователь выбирает одно намерение:

| `usage_mode` | Смысл |
|---|---|
| `disabled` | Агент не использует Mind для чтения или записи. Значение по умолчанию. |
| `read` | Агент может читать Mind по явной просьбе пользователя или когда тема соответствует `description`. |
| `read_write` | Всё из `read`; этот единственный Mind также принимает подходящие автоматические сохранения. |

У principal может быть `0..N` Minds в `read` и `0..1` Mind в `read_write`.
Настройка не повторяется для каждого Connection, OAuth grant, personal token,
Codex session или MCP protocol profile.

## Authoritative state

Минимальная service model:

```text
PrincipalMindUsageState:
  principal_id             # trusted immutable owner
  usage_version            # monotonic CAS, initial 0
  active_write_generation? # opaque immutable generation or null
  created_at
  updated_at

MindUsageEntry:
  principal_id
  space_id
  usage_mode               # disabled | read | read_write
  entry_version
  write_generation?        # only for current read_write entry
  updated_at
```

State принадлежит principal. Browser не передаёт `principal_id`, `space_id`,
role, credential owner или generation как authority. Storage обеспечивает:

- одно effective entry на `principal_id + space_id`;
- не более одного active `read_write` и generation на principal;
- monotonic `usage_version` для atomic switch и stale-write rejection;
- никогда не переиспользуемую write generation;
- privacy-safe tombstone/reconciliation policy для stale in-flight work.

Выбор второго `read_write` одной transaction создаёт новую generation и
переводит прежний writable entry в `read`. Повтор exact mode — idempotent no-op
без изменения versions. `disabled` удаляет Mind из MCP enabled projection.

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
                ∩ exact active principal write generation
                ∩ expected HEAD + idempotency + full validation
```

Все credentials principal видят одну configured mode projection. Read-only
credential поэтому может увидеть `usage_mode: read_write`, но получает
`effective.can_write: false`; он не приобретает `content:write` и не создаёт
альтернативный destination.

## Description и routing

`description` — service metadata Mind, единое для чтения и записи. Owner/Admin
редактирует description ordinary Mind по текущим metadata rules; owner Personal
Mind редактирует его description через тот же безопасный metadata contract.
Description не входит в OKF, search index или revision и не двигает HEAD.

Для `read_write` требуется непустое нормализованное description. Для `read`
пустое значение допустимо: такой Mind используется только по прямой просьбе.
`disabled` description не публикуется Content MCP.

Description доступно модели как **недоверенная категория**, а не инструкция.
Оно может помочь ответить «относится ли тема к этому Mind», но не может:

- потребовать tool call или изменить порядок действий;
- обойти mode, scope, ACL, role, revision или server validation;
- выбрать другой Mind, включить запись или расширить corpus;
- заставить агента раскрыть, перенести или удалить данные.

Agent routing:

1. получает fresh `list_minds` enabled projection;
2. если пользователь назвал Mind, выбирает этот enabled Mind без semantic
   comparison, но server всё равно проверяет доступ;
3. иначе читает только те `read | read_write` Minds, чьи descriptions
   действительно соответствуют текущему вопросу;
4. каждый content call выбирает один Mind и exact resolved revision;
5. не делает общий cross-Mind search и не помещает весь corpus в context.

## Автоматическое сохранение

`read_write` является consent на автоматический save; отдельного capture toggle,
write instruction или подтверждения каждого изменения нет. Agent рассматривает
save после содержательного ответа, когда одновременно выполнены условия:

- знание durable: полезно за пределами текущей реплики;
- оно явно обсуждалось в текущем разговоре, а не найдено фоновым сканированием;
- оно соответствует description единственного effective writable Mind;
- текущий credential и server подтверждают effective write;
- изменение можно выразить как bounded create/replace/delete/no-op и проверить.

Приватная или чувствительная информация не запрещена отдельным category filter,
если пользователь сам явно обсудил её и она соответствует Mind. Это не
разрешает собирать соседние сообщения, файлы, браузерную историю или весь
readable corpus «на всякий случай».

Факт из другого enabled readable Mind можно сохранить только если он стал
частью текущего обсуждения и подходит writable description. Changeset сохраняет
service-resolved provenance: source Mind, exact revision и opaque/exact locator,
не выдавая source access downstream и не копируя недоступный контекст.

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
2. читает current principal usage state и pin-ит exact write generation;
3. требует `content:write` и current writer role exact Mind;
4. требует request `mind` равным configured `read_write` destination;
5. повторяет generation, role, HEAD CAS, quota и idempotency checks в transaction;
6. создаёт одну immutable revision, HEAD, audit/outbox/index effects либо ничего.

Client не передаёт principal, configured target, generation или role. Wrong
Mind, disabled/switch, stale generation, revoke/expiry, scope/ACL loss,
corrupt state, stale HEAD или validation failure не перенаправляют payload в
Personal/previous/«единственный доступный» Mind.

## Agent notification

После автоматической попытки агент сообщает пользователю только существенный
результат:

- что сохранено/обновлено/удалено и в каком Mind;
- no-op только когда это важно для обещанного действия;
- безопасную причину no-write, если ожидалась запись и пользователь может её
  исправить на Site.

Internal IDs, private source metadata, token/scope details и полный технический
receipt в обычный ответ не выводятся. Уведомление следует после server result и
read-back; оно не является confirmation gate.

## Site control plane

Authenticated Site mutation изменяет mode на уровне Mind и требует current
principal, current access, `expected_usage_version`, idempotency key и CSRF.
`read_write` дополнительно требует non-empty description и current writer role.
Atomic switch сам демотирует прежний writable Mind в `read`; отдельные
bind/rebind/unbind controls отсутствуют.

Connection и Advanced MCP pages показывают credential scopes/lifecycle и
derived effective capability, но не владеют mode. Они не содержат target
selector или capture toggle. Changing/revoking token не меняет principal mode;
следующий MCP call просто пересчитывает effective capability.

## MCP projection и instructions

Modern и compatibility profiles публикуют одну application semantics.
`list_minds` возвращает только enabled и currently readable Minds с минимумом:

```json
{
  "mind": "research-notes",
  "name": "Research notes",
  "description": "Проверенные выводы по исследованиям продукта",
  "usage_mode": "read_write",
  "effective": { "can_read": true, "can_write": true }
}
```

Server instructions, tool descriptions, bundled skill, manifest help и Site
help согласованно объясняют routing и automatic save. Corpus и description
остаются untrusted content. Exact bind/unbind tools и `capture_knowledge` не
рекламируются и не вызывают application write. Cached exact legacy calls дают
side-effect-free versioned retired result с remediation на Site.

## Migration

Capability version — `principal-mind-usage/v1`. Migration fail closed:

1. Новому principal все entries создаются как `disabled`.
2. Однозначный existing principal configuration может быть перенесён только
   если один readable/writable intent доказуем без объединения разных
   credentials и writable Mind имеет non-empty description.
3. Любые несколько credential targets, conflicting modes, missing principal,
   empty writable description, corrupt generation или partial state дают
   `disabled` для ambiguous entries; destination не угадывается.
4. Legacy binding/capture IDs и in-flight staged/write refs не становятся новой
   authority и не remap-ятся в principal generation.
5. Уже committed immutable revisions/idempotency results остаются историческими
   фактами и не повторяются.
6. Runtime не обслуживает mixed old/new write semantics. До завершения
   principal state migration write fail closed с versioned remediation.

## Acceptance

MD-374–MD-380 должны совместно доказать:

1. default `disabled`, arbitrary `read` и global singleton `read_write` для
   одного principal, включая atomic switch/CAS/idempotency/restart;
2. одинаковую configured projection для двух OAuth grants и personal token при
   разных effective scopes;
3. ACL/role/scope loss без расширения authority и без изменения intent state;
4. Personal description и запрет `read_write` при empty description;
5. direct-request и description-match read routing без disabled/cross-Mind
   bypass;
6. discussed-only automatic create/update/delete/no-op, cross-Mind provenance,
   no-vacuum negative cases и user notification contract;
7. full OKF 0.2 bundle validation/read-back и preservation unknown fields;
8. отсутствие binding/capture controls во всех Site/MCP/plugin surfaces;
9. modern/compat parity, fresh Marketplace install и model-visible instruction
   evidence exact package version;
10. local/dev/UAT joined receipts exact candidate/deployment с cleanup и без
    production действий.
