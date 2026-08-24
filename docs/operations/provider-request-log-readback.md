# Read-back границы provider request logs

Статус: bounded UAT procedure, 2026-08-24. Документ не является результатом
read-back, privacy/legal policy или разрешением менять provider configuration.
До выполнения процедуры фактический состав, retention и controls provider
request envelope имеют статус `unknown`.

## Зачем нужна отдельная проверка

Mind Diary контролирует две application-owned поверхности:

1. `mind-diary.privacy-safe-observability` — runtime-validated closed JSON
   projection без request payload и свободных dimensions;
2. service audit — отдельные product events с закрытым набором actor,
   operation, outcome, UTC time и safe metadata.

Они не описывают и не ограничивают infrastructure request envelope, который
может создавать OpenAI Sites или нижележащий provider до/после Worker. Наличие
application regression не доказывает отсутствие source network metadata,
client software metadata, request target/headers или provider retention. Эта
граница закрывается только свежим provider read-back на exact UAT deployment и
отдельным privacy authority decision.

## Authority и безопасные входы

До read-back нужны:

- явное разрешение на bounded privacy inspection provider metadata/controls;
- exact `candidate_sha`, Sites `project_id`, version/deployment ID и archive
  SHA-256;
- provider surface с доступом к schema/configuration/access/retention metadata;
- synthetic request, если provider facts нельзя установить без request-level
  просмотра.

Не используйте реальный pilot request как fixture. Не экспортируйте raw log
stream, не копируйте значения полей и не сохраняйте screenshots с request
values. Изменение reduction, retention, access или deletion configuration —
отдельный privacy/access-policy effect и требует явного разрешения; read-back
сам по себе его не даёт.

## Closed classification matrix

Для каждого класса фиксируется только один status и безопасная evidence
reference. Имена реальных provider fields и их значения в receipt не входят.

| Receipt classification | Проверяемый вопрос |
|---|---|
| `source_network_metadata` | Создаёт ли provider metadata о сетевом источнике request |
| `client_software_metadata` | Создаёт ли provider metadata о client software/device |
| `request_target_metadata` | Сохраняется ли target/route/query representation |
| `request_header_metadata` | Сохраняются ли request headers либо их projection |
| `payload_metadata` | Сохраняется ли body/content или derived payload metadata |
| `credential_metadata` | Может ли provider envelope содержать credential material |
| `signed_resource_metadata` | Может ли envelope содержать signed resource locator |
| `retention_control` | Какой verified retention действует и кем управляется |
| `reduction_control` | Доступно ли отключение/уменьшение envelope |
| `access_control` | Кто фактически может читать provider evidence |
| `deletion_control` | Какой verified deletion lifecycle доступен |

Допустимые статусы:

- `unknown` — свежего достаточного provider evidence нет;
- `not_available` — provider не предоставляет нужный field/control/read-back;
  это не означает, что boundary приемлема;
- `accepted_boundary` — verified provider fact рассмотрен и явно принят
  уполномоченным пользователем для bounded UAT;
- `failed` — verified fact нарушает требуемую границу либо evidence/receipt
  некорректны.

## Порядок read-back

1. Прочитать current Sites project/version/deployment metadata и сверить их с
   exact candidate/archive. При несовпадении остановиться: старый read-back не
   переносится на новый deployment автоматически.
2. Повторно запустить product-controlled privacy regressions для application
   telemetry, operator service audit и durable receipt. Сохранить только
   `repo:`/`release-evidence:` locator и SHA-256 exact evidence.
3. В provider schema/configuration surface определить каждый класс таблицы.
   Предпочитать provider-declared field/config metadata. Если без runtime
   inspection факт не устанавливается, выполнить один synthetic request и
   просмотреть только field/classification presence in place; raw values не
   переносить в evidence.
4. Для retention/reduction/access/deletion прочитать current effective state и
   availability control. Не считать документацию о возможной функции доказанной
   current configuration.
5. Каждому классу присвоить status. Для `unknown` evidence равен `null`; для
   остальных нужен exact safe locator и SHA-256 redacted metadata artifact.
6. Если пользователь принимает bounded UAT boundary, записать отдельную
   classification-only authority evidence reference. Без неё общий status не
   может стать `accepted_boundary`, даже если все provider facts прочитаны.
7. Поместить только classification input в новый mode-private файл (`0600`) и
   создать receipt исполняемым adapter-ом:

   ```text
   npm run uat:provider-log-boundary -- \
     --input <private-classification.json> \
     --evidence-out <new-private-evidence.json>
   ```

   Adapter использует `scripts/lib/provider-request-log-boundary.mjs`, требует
   отдельные input/output paths, не перезаписывает существующий artifact и
   создаёт output с mode `0600`. Closed input не содержит schema для raw logs:
   он состоит только из exact lineage, application/provider classifications,
   safe evidence locators/hashes и authority marker. Дополнительные поля,
   URL/email/credential-shaped values, произвольные locators и
   `accepted_boundary` без authority evidence отклоняются.
8. Перечитать deployment identity и artifact hash receipt. Raw provider facts,
   request samples и временные inspection artifacts удалить по согласованной
   provider/local procedure; в repository/Task/evidence их не добавлять.

Стартовый classification-only fixture находится в
`tests/fixtures/provider-request-log-boundary.json`. Он намеренно имеет общий
status `unknown` и `authority.status=required`; это шаблон незакрытой границы,
а не UAT evidence.

## Решение и fail-closed outcome

- `accepted_boundary`: все application regressions прошли, ни один provider
  class не `unknown`/`failed`, exact deployment совпадает и существует явная
  authority evidence. `not_available` control может быть принят только тем же
  явным решением, а не автоматически.
- `failed`: любой application/provider class имеет `failed`; release
  acceptance по privacy boundary не закрыта.
- `unknown`: хотя бы один provider fact не установлен или нет authority
  evidence; продуктовый defect не объявляется, но hosted privacy claim остаётся
  verification-blocked.
- `not_available`: provider не даёт прочитать/уменьшить все необходимые классы,
  а явного bounded acceptance ещё нет; требуется решение принять остаточную
  границу либо сменить provider/configuration.

### Restricted-UAT residual decision

Для Release 0.1 владелец разрешил bounded classification-only inspection и
принял следующий остаточный boundary только для restricted UAT:

- ноль событий в доступном Sites worker-log read-back после synthetic request
  означает `not_available`, а не доказанное отсутствие provider envelope;
- отсутствие callable retention/reduction/deletion controls также означает
  `not_available`, а не `passed`;
- такие classifications могут дать общий `accepted_boundary` только с
  отдельным `authority.status=recorded`, passing application regressions,
  exact final candidate/version/deployment, synthetic data, exact custom
  audience и `production_excluded=true`;
- появление доступного sensitive provider field/control либо drift lineage
  требует нового решения и до него fail closed.

Это не production privacy policy, не обещание provider retention и не
утверждение, что IP/User-Agent/request target никогда не создаются платформой.

## Что никогда не попадает в durable receipt

Verified email, network/client values, corpus/content/query/path, headers,
cookies, credentials, Authorization, raw request/response, signed/download URL,
provider field values и raw log lines. Receipt хранит только schema/status,
closed classification IDs, exact candidate/deployment, UTC observation,
safe evidence locator/hash, authority status и canonical artifact SHA-256.
