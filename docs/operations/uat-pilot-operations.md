# Privacy-safe операции UAT pilot

Статус: accepted operational runbook для bounded UAT pilot, обновлено
2026-08-10. Документ не является production SLA, legal retention policy или
обещанием recovery.

## Назначение и граница

Runbook позволяет operator-у безопасно добавить или убрать pilot principal,
различить authentication/MCP/storage incident, отозвать credential или audience
access, вернуть exact last-good UAT version и проверить export/restore без
частного corpus. Он применяется только к OpenAI Site Mind Diary из
`apps/mind-diary-site/.openai/hosting.json`.

`production.configured=false`: текущий Site — product UAT, даже если Sites
называет publish deployment production deployment. Cohort execution, production
SLA/recovery/retention, billing, analytics и outbound notifications не входят в
этот runbook.

## Notice участнику до старта

Operator перед admission отправляет через исходный trusted pilot channel и
просит явно подтвердить четыре границы:

1. Использовать только данные, допустимые для restricted UAT, и не хранить здесь
   единственную копию. До рискованной работы сохранить deterministic export.
2. UAT не имеет production SLA, guaranteed recovery или принятой legal retention
   policy. Whole-Mind и account delete немедленны и необратимы.
3. Не передавать другим людям или operator-у MCP token, Sites credential,
   authorization header, export/download URL. Для каждого client/device нужен
   отдельный named token.
4. Support/recovery request содержит только симптом, UTC-время и безопасный
   request ID из UI. Он не содержит private content, raw query, email, token,
   header, signed/download URL или screenshot с такими значениями.

Тот же notice присутствует до account bootstrap в Product Site и кратко
повторён на `/help`; destructive delete отдельно повторяет irreversible/no
recovery boundary. Поскольку notice подтверждается до admission, он также
предшествует любому MCP export в pilot.

## Telemetry contract

UAT runtime пишет в Sites Worker logs только JSON event
`mind-diary.privacy-safe-observability` schema
`mind-diary/privacy-safe-observability/v1`. Разрешены только:

- `kind`, `metric`, `surface`, `operation`, `outcome`, `unit`, numeric `value`;
- `occurredAtUtc`;
- bounded opaque `requestId`/`jobId` либо `null`;
- fixed pilot `cohort` либо `null`.

Дополнительное поле отклоняет весь event. Запрещены content/body/path/name,
search query, email, principal/space/revision identity, token/verifier/header,
cookie, signed/download URL и raw request/response. Telemetry best-effort:
отказ logger-а не меняет authoritative request, transaction или background job.

Текущий минимальный набор сигналов:

| Класс | Безопасный сигнал | Первичная трактовка |
|---|---|---|
| Auth | `authentication_outcome`, `surface=control|mcp` | denied/invalid credential либо unavailable identity boundary |
| MCP | `request_latency_ms`, `request_error`, `surface=mcp` | protocol/tool/runtime failure без query/body |
| Storage/runtime | `request_error` с `outcome=unavailable`, background `index_lag_ms`/`export_lag_ms`, `mind-diary.runtime-unavailable` stage | D1/R2/index/composition dependency требует проверки |
| Recovery | `cas_conflict`, export/index outcome, token/deletion outcome | stale HEAD, delayed job или lifecycle action |

Это operational telemetry, а не product analytics. Pilot metrics из closed
schema используются только protocol-ом `AND-160`; inference, profiling и
content-derived dimensions отсутствуют.

## Bounded monitoring и диагностика

1. Зафиксировать exact `project_id`, current deployment/version и Git SHA. Не
   выбирать rollback по словам «предыдущий» или только по времени.
2. Прочитать recent Sites Worker logs с `errors_only=true`,
   `since_minutes=15`, `limit<=100`. Расширить до `errors_only=false` только для
   соседних safe telemetry events; не копировать весь log stream.
3. Классифицировать incident:
   - `401`/auth denied: проверить exact audience и named token state; не просить
     token у участника;
   - MCP-only: проверить exact `/api/mcp` либо `/api/mcp/2025-11-25`, protocol,
     status и opaque request ID;
   - repeated `503`, storage/background unavailable или runtime stage:
     проверить D1/R2 binding, current deployment и bounded index/export job;
   - CAS conflict: перечитать HEAD и построить новый preview/idempotency key,
     никогда не выполнять hidden merge.
4. После mitigation повторить redacted authenticated Web/control smoke и
   modern/default Codex MCP smoke на одном exact deployment. UI-only check не
   закрывает MCP incident.

В evidence сохраняются только class/status/timestamp/opaque correlation,
exact artifact/deployment и итог. Raw log line допустима только после проверки
closed schema и отсутствия запрещённых значений.

## Emergency revoke

### Утечка MCP token

1. Участник либо authenticated operator открывает `/settings/mcp` и отзывает
   exact named token. Secret не пересылается и не сравнивается.
2. Проверить тем же client endpoint, что прежний Bearer получает `401`.
3. Создать новый named token только после устранения источника утечки; старый не
   «включать обратно».

### Потерянный доступ или audience incident

1. Не relink-ить account и не переносить membership автоматически.
2. При активном риске owner Sites project меняет custom access через exact
   `project_id`: удаляет только выбранного viewer/external grant либо, для полной
   остановки pilot, очищает non-owner allowlist. Любое изменение audience требует
   отдельного явного operator instruction и записи прежней access revision.
3. Проверить, что исключённый principal больше не проходит Sites boundary;
   затем отдельно отозвать его named MCP tokens через account lifecycle, если
   control-plane access ещё доступен. Sites audience и product Bearer — две
   независимые границы.
4. Recovery рассматривается вручную через исходный trusted channel без email,
   content или credentials в evidence; automatic merge/relink запрещён.

## Rollback UAT

Перед каждым cut release receipt фиксирует exact current deployment и compatible
last-good version. Для rollback:

1. Остановить новые pilot действия и revoke скомпрометированные credentials.
2. Найти saved version только по exact version ID + source commit SHA из
   last-good receipt; проверить project ID и archive content hash.
3. Deploy exact saved version с compare/reconcile against current deployment.
   Не пересобирать старый SHA и не сохранять новый version под видом rollback.
4. Дождаться terminal deployment status. Выполнить
   `rollback.authenticated-web-control` и `rollback.mcp-modern`; при затронутом
   compatibility profile также default Codex smoke.
5. Rollback code не откатывает уже committed immutable revisions или access
   mutations. Если state несовместим, оставить pilot stopped и открыть
   forward-only defect; не обещать recovery.

## Fixture backup/export и restore drill

Drill использует новый synthetic ordinary Mind без private/participant data:

1. Создать fixture Markdown с явным synthetic marker и сохранить исходный HEAD.
2. Выполнить deterministic export exact revision; проверить media type,
   filename, SHA-256, size и full OKF validation. Archive хранить только на время
   drill и не записывать download URL в evidence.
3. Создать одну synthetic change revision. Прочитать исходную revision в
   historical read-only mode.
4. После preview/confirmation восстановить fixture как новую HEAD revision с
   fresh expected HEAD и новым idempotency key. Проверить, что historical
   revision не изменилась.
5. Экспортировать exact restored revision, повторить integrity/full-bundle
   validation и убедиться, что service metadata отсутствует.
6. Удалить synthetic Mind/account через штатный lifecycle, revoke все временные
   tokens и подтвердить `401` после revoke. Локальный archive удалить.

Repository drill считается доказательством механики, не UAT recovery promise.
Exact-candidate live drill принадлежит финальному `AND-161` join-gate.

## Checklist admission

- notice подтверждён через trusted channel;
- Sites access mode остаётся `custom`; добавлен ровно выбранный principal без
  shared credential;
- participant создаёт собственный isolated account либо останавливается на
  manual recovery;
- для каждого client/device создан отдельный named token;
- current deployment, rollback target и support channel зафиксированы без PII
  в release evidence.

## Checklist removal

- удалить exact viewer/external grant, сохранив других участников;
- revoke named MCP tokens и проверить `401`;
- определить вместе с участником export/delete outcome до потери control access;
- не заявлять physical/legal erasure сверх проверенного account/Mind lifecycle;
- evidence содержит только status, UTC timestamp и opaque IDs.
