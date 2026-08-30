# Операторский каталог principals и последняя активность

Статус: accepted, 2026-08-22. `normative_status: accepted`;
`implementation_status: implemented_local_uat_pending`. Контракт относится
только к внутренней read-only поверхности Release 0.1 и не создаёт production
операторскую модель.

## Цель и граница

Оператор UAT должен видеть, какие accounts зарегистрированы и когда они в
последний раз успешно использовали first-party web или content MCP. Каталог
нужен для pilot support и проверки adoption, но не является product analytics,
provider session history или online-presence механизмом.

Операторская capability задаётся constructor-only allowlist внутренних
`principal_id`. Она не является ролью `KnowledgeSpace`, membership, token
scope, клиентским claim или deployment capability. Owner/Admin любого Mind и
обычный authenticated principal без allowlist получают тот же `404`, что и для
несуществующей internal route. При отсутствии или ошибке конфигурации доступ
fail closed.

## Минимальная модель активности

Для существующего `Principal` хранится не журнал запросов, а одна перезаписываемая
монотонная сводка:

```text
PrincipalActivitySummary:
  principal_id
  last_web_seen_at?
  last_mcp_seen_at?
  last_activity_at?
  last_activity_surface?   # web | mcp
  last_activity_kind?      # page | control_read | control_write | discovery | content_read | content_write
```

`registered_at` берётся из canonical `Principal.created_at`. Timestamp имеет
UTC ISO 8601 форму. Store применяет `max(previous, observed_at)` отдельно для
web/MCP и общего timestamp; delayed delivery и retry не могут сдвинуть время
назад. Равный повтор идемпотентен.

Обновление выполняется best-effort только после успешной аутентификации,
авторизации и успешного application/adapter результата:

- web: зарегистрированный principal получил успешный UI page или REST result;
- MCP: аутентифицированный principal получил успешный discovery, resource read
  или tool result;
- denied, failed, malformed, pre-registration и static-asset requests не
  обновляют сводку;
- ошибка записи активности не меняет уже полученный product response.

Hosted runtime может объединять успешные observations одного principal и
одной surface в bounded окно не более двух секунд. В этом окне сохраняется
самая новая observation; web и MCP не объединяются между собой, а новое
значение во время уже начатой записи приводит к последующей монотонной записи.
Такая best-effort проекция исполняется вне foreground response path и не должна
захватывать metadata lock между быстрыми переходами по UI.

Значения означают только последнее наблюдённое успешное обращение к surface.
Они не доказывают provider sign-in, активную browser session, присутствие
online или чтение конкретного Mind.

## Read-only каталог

Internal Sites UI route `/internal/operators/users` и REST route
`GET /api/v1/internal/operators/users` возвращают только:

- opaque `principal_id`, display name, verified account email;
- account state and `registered_at`;
- timestamps и bounded surface/kind из summary;
- количество active owned/participating ordinary Minds;
- количество active personal MCP tokens, если projection доступна без corpus.

Поддерживаются bounded `limit` (`1..100`), opaque cursor, stable sort по
`registered_at`, `last_activity_at` или `display_name`, направление, exact
normalized email/display-name search, account state, UTC registration/activity
range и `never_active`. Tie-breaker — opaque `principal_id`. Пустой результат
не раскрывает скрытые aggregate counts.

UI показывает UTC timestamp, относительную подсказку и явное `Never`, но не
переименовывает `last seen` в `online`. Все поля read-only; impersonation,
account mutation и переход в corpus отсутствуют.

## Privacy, audit и deletion

Каталог и activity summary никогда не содержат content, paths, Mind names,
search/tool arguments, URL, headers, token secrets/verifiers, provider IDs, IP,
device fingerprint или полный User-Agent. Нельзя строить clickstream, session
timeline или per-Mind activity из этой поверхности.

Каждый разрешённый directory read создаёт service audit event с opaque
operator principal, operation и UTC time. Query, email, returned rows и count
в audit/logs не попадают. Denied request не раскрывает существование каталога.

Account deletion атомарно удаляет linkable activity summary вместе с
`Principal` и identity binding. Сохранённый service audit использует обычную
политику tombstone для удалённого actor; target principals в нём отсутствуют.
Activity summary не участвует в authentication, authorization, billing,
retention decisions или product ranking.

Эти гарантии разделены по трём поверхностям:

- application telemetry принимает только runtime-validated closed event и не
  получает directory query/rows, verified email, request path/headers либо
  credentials;
- service audit сохраняет только opaque operator actor/request, bounded
  operation/outcome и UTC time; target email, query, returned rows/count и
  request-envelope values отсутствуют;
- infrastructure provider request envelope не является application telemetry
  или service audit и не контролируется этим contract. Его field presence,
  retention, reduction, access и deletion нельзя выводить из локальных tests;
  они требуют отдельного
  [bounded provider read-back](../operations/provider-request-log-readback.md)
  и явного privacy authority decision для exact UAT deployment.

До такого read-back provider boundary имеет `unknown`, а не `passed`.
`not_available` provider control означает недоступность, а не автоматически
приемлемую privacy границу.

Sites persistence хранит новые observations в отдельной bounded
`md_principal_activity` projection с одной строкой на opaque `principal_id`.
Atomic upsert применяет монотонный `max(previous, observed_at)` отдельно к web,
MCP и общему timestamp. Observation не входит в fenced canonical metadata event
log, не запускает его replay и не переписывает большой materialized snapshot;
тем самым observational telemetry не захватывает canonical metadata path между
UI-переходами. Operator read накладывает projection на актуальный canonical
principal directory. Optional activity field старого snapshot остаётся
backward-compatible источником до первого нового observation.

Projection не является request log, product/query surface или источником
authentication/authorization. Каждая observation захватывает immutable
canonical view и соответствующий ему exact metadata sequence/generation.
Physical upsert выполняется только если current canonical sequence всё ещё
равен захваченному; unrelated canonical mutation может консервативно отбросить
best-effort observation, а stale writer после account deletion не может
воскресить строку.

Победивший canonical account-deletion event и физическое удаление строки
`md_principal_activity` составляют одну атомарную D1 mutation. Conditional
cleanup проверяет exact sequence и полный deletion-event envelope/payload,
поэтому проигравший CAS не удаляет activity живого principal. Post-commit
cleanup допустим только как идемпотентный fallback и не превращает уже
зафиксированное canonical deletion в reported failure. После завершённого
account deletion linkable activity физически отсутствует, а не только скрыта
read path.

## Verification

Repository acceptance требует как минимум двух principals и проверяет:

- allowlisted operator получает stable page/API; обычный principal и Mind
  Owner/Admin получают `404`;
- successful web и MCP results обновляют свои timestamps, а denied/failed — нет;
- delayed/retried observations монотонны, `never_active` остаётся отличимым;
- stale observation после account deletion или unrelated canonical mutation
  не создаёт activity; observation, записанная до deletion, физически удаляется
  тем же победившим canonical commit;
- search/filter/sort/cursor/empty-state deterministic;
- account deletion атомарно удаляет canonical summary и physical projection;
- privacy regression не находит forbidden fields в state, responses, audit и
  telemetry.

Product-controlled negative regression отдельно подставляет verified email,
network/client metadata, corpus/query/path, credential/Authorization и signed
resource sentinels и доказывает, что их значения отсутствуют в application
telemetry, service audit и durable provider-boundary receipt. Это не проверяет
provider envelope: его результат фиксируется только classification-only
receipt schema `mind-diary/provider-request-log-boundary-receipt/v1`.

Hosted claim требует exact UAT candidate, allowlisted operator, два реально
изолированных principals и read-back web/MCP/never-active cases. Локальные
tests сами по себе не являются live evidence. Privacy часть hosted claim также
требует exact-deployment provider read-back и explicit bounded authority;
unknown provider behavior не закрывает acceptance и не объявляется product bug.

## Вне scope

- production access policy или production deployment;
- impersonation, support mutations, password/provider session controls;
- clickstream, realtime online status, product analytics warehouse;
- corpus preview, query history, Mind names или per-Mind activity;
- anonymous/public operator endpoint и content MCP operator tools.
