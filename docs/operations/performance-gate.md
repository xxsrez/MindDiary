# Exact-candidate performance gate

Статус: accepted operational contract для Release 0.1, обновлено 2026-08-24.
Repository runner реализован; этот документ не утверждает, что UAT receipt уже
получен.

Применимость с 2026-09-09: это специализированный строгий benchmark, а не
обязательная часть каждого UAT release. Выбор запуска определяет
[профиль revision 9](ship-work-release-profile.md#обычный-uat-release-соразмерная-приёмка).
Приведённые ниже blocking budgets блокируют выбранную performance acceptance,
но не превращают обычную функциональную задачу в performance-проект.
Не запускать замеры без конкретного требования или наблюдаемого существенного
ухудшения. Если benchmark запущен, его samples, thresholds и failed результат
не подменяются; исключение из scope не означает успешный benchmark.

## Назначение и граница

Gate блокирует UAT acceptance при regressions authenticated home и MCP read
path. Он проверяет один exact Git SHA на одном exact Sites deployment и не
принимает local benchmark, заявленную вручную scale matrix или один успешный
HTTP status как hosted evidence.

Канонический local scale benchmark
`npm run benchmark:local-mind-scale` остаётся полезным post-MVP preflight для
`1/10/100` Minds, но не входит в blocking Release 0.1 acceptance. Synthetic
browser gate остаётся проверкой Product Site composition. Ни один из них не
выдаётся за UAT profile provisioning/read-back или latency receipt.

## Обязательные private inputs

Все inputs и полный report находятся только в private temporary evidence
storage. В repository не добавляются token, Sites credential, request/response
body, query, Mind/revision ID, path, URL download grant или private corpus.

### Profile provision/read-back receipt

Перед benchmark отдельный trusted UAT probe нормальными application commands
создаёт synthetic fixture profiles и затем независимо считывает их состояние.
Он выпускает hashed receipt
`mind-diary/performance-profile-readback/v2` с generator
`mind-diary/uat-profile-provision-readback/v2`.

Receipt связывает:

- exact `candidate_sha` и полную Sites identity: project, version, deployment и
  SHA-256 опубликованного archive;
- exact UAT target и canonical UTC provisioning/read-back window;
- один `starter_small` profile и два `small_history` profiles с exact
  `1x`/`10x` history;
- ровно два token-visible synthetic Minds: starter одновременно служит `1x`
  history fixture и имеет одну revision, второй Mind имеет десять revisions;
- в каждом profile от `1` до `16` files и от `1` byte до `1 MiB`;
- для каждой строки distinct opaque provisioning/read-back request IDs,
  fixture fingerprint и exact equality `expected == observed` сразу по
  `minds/revisions/files/bytes`;
- keyed HMAC actual MCP credential и SHA-256 exact canonical tool arguments,
  которыми probe сделал read-back и которыми runner затем выбирает fixture.

Safe file/byte read-back берётся из `get_revision.manifest_summary`
(`file_count`, `total_bytes`), capacity projection и соответствующих normal
application reads, а не из scenario declaration. Receipt с лишними полями,
неверным hash, stale SHA/deployment, отсутствующим starter/history profile,
выходом за small bounds, отрицательным/нецелым count либо несовпадающим
read-back отклоняется до первого benchmark request.
HMAC key и credential никогда не входят в receipt: private scenario хранит
только имя `credential_binding_key_env`, а runner пересчитывает binding из
actual environment value до первого HTTP request. Поэтому одинаковые
`list_minds {}` с произвольным token не могут изображать starter и два
независимо прочитанных history fixtures.
Отдельный 256-bit key из `performance_correlation_key_env` подписывает каждый
runner correlation ID и совпадает с deployment secret
`MIND_DIARY_PERFORMANCE_CORRELATION_KEY`; это не тот же proof, что credential
binding, и ни одно значение key/signature в evidence не сохраняется.

### Scenario v3

Private scenario имеет schema `mind-diary/performance-scenario/v3`, повторяет
exact SHA/deployment/target, задаёт `warm_samples >= 20` и bounded
`telemetry_wait_seconds <= 300`. Credential values задаются только через имена
environment variables. Inline `Authorization`, cookie и Sites authorization
header запрещены.

Три fixture profiles выполняются через MCP profile
`mcp_modern` — `POST /api/mcp`.

`starter_small` обязательно покрывает `list_minds`, `browse_entries`, `search`
и `fetch`. Два `small_history` profiles покрывают пару `get_revision` с
одинаковым comparison group и scale `1`/`10`. Отдельный `web` profile выполняет
authenticated `GET /`. Large-corpus, Brain-scale, mixed 590 MB, 100 Minds и
1000 revisions остаются post-MVP non-blocking capacity checks.

Каждая request definition получает один first-observed sample и ровно
`warm_samples` warm samples. MCP rows должны быть `tools/call`, а заявленная
operation обязана совпадать с tool name и hashed fixture request binding.
Modern request обязательно несёт согласованные `MCP-Protocol-Version`,
`Mcp-Method`, `Mcp-Name` и `_meta` protocol/client/capabilities. MCP и web
используют Sites credential env reference; MCP дополнительно использует
fixture-bound Bearer env reference.

### Closed telemetry JSONL

Runtime пишет closed application events `mind-diary.privacy-safe-observability`
schema `mind-diary/privacy-safe-observability/v2`. Вторая версия добавляет к
прежней privacy-safe projection только nullable bounded
`benchmarkCorrelationId`.

Параллельный bounded collector выбирает events только из exact provider
project/version/deployment window, сверяет candidate и archive через Sites
control plane и выпускает отдельную private JSONL projection
`mind-diary.performance-gate-telemetry` schema
`mind-diary/performance-gate-telemetry/v1`. В каждой строке она сохраняет
закрытый runtime event и добавляет exact `lineage` (`candidateSha`,
`siteVersionId`, `deploymentId`). Runtime env или CLI declaration не считается
provider attestation и не может подставить эту lineage.

Runner создаёт новый opaque `benchmark_*` для каждого cold/warm request,
посылает его только в `X-Mind-Diary-Performance-Correlation-Id` и требует exact
HMAC в `X-Mind-Diary-Performance-Correlation-Signature`. Runtime удаляет оба
headers при missing/invalid signature; только authenticated value получает
echo вместе с server-generated `X-Mind-Diary-Request-Id`. Telemetry group
принимается только когда оба ID exact совпадают с одним sample и все её events
лежат внутри его window. Это исключает foreign same-operation traffic даже в
том же deployment/window.

Runner принимает только exact closed projection. Extra field, unknown
categorical value, небезопасный correlation ID, отрицательная/нечисловая value
или event вне actual runner window делает receipt failing. После завершения
collector выпускает hashed
`mind-diary/performance-telemetry-capture/v1`, который связывает exact
candidate/deployment/target, охватывающий capture window, event count и SHA-256
final JSONL, а также generator
`mind-diary/sites-control-plane-telemetry-join/v1` и opaque control-plane query
ID. Незавершённый либо изменившийся JSONL не принимается.

Application telemetry остаётся best-effort: отказ sink никогда не меняет
HTTP/MCP/application outcome. Performance gate отдельно fail closed получает
missing telemetry и поэтому не превращает telemetry в authoritative product
transaction.

## Запуск

```text
npm run gate:performance -- \
  --scenario <private-scenario-v2.json> \
  --profile-readback <private-profile-readback.json> \
  --telemetry-jsonl <private-closed-events.jsonl> \
  --telemetry-capture <private-telemetry-capture.json> \
  --candidate-sha <40-hex> \
  --deployment-id <appgdep_exact> \
  --output <private-performance-report.json>
```

Collector должен охватывать actual request window runner-а и выбрать только
events с выданными runner-ом correlation IDs. Если log delivery асинхронна,
runner poll-ит JSONL и finalized capture receipt не дольше scenario timeout. Он не
расширяет log window сам и не читает raw provider request envelope.

## Проверяемые границы

Для каждого request runner:

1. измеряет first-observed request отдельно;
2. выполняет не меньше 20 warm requests;
3. требует exact ожидаемый 2xx HTTP status;
4. для MCP разбирает JSON либо один SSE `data` event, проверяет matching
   JSON-RPC ID, отсутствие JSON-RPC error, `result.isError === false` и
   `structuredContent.ok === true`;
5. связывает cold+warm samples с distinct closed-telemetry groups по exact
   server request ID, runner correlation ID, lineage и request window;
6. требует в той же group profile, authentication/application/total stages и
   exact tool operation; warm server budget считается только из этих groups.

HTTP `200` с tool `isError: true`, неполный response envelope, missing profile,
лишний или повторно использованный correlation, отсутствующая stage, stale
lineage, неполный count/byte read-back и любой budget regression завершают
процесс ненулевым кодом.

Blocking budgets:

- first-observed request каждого row — не более `5000 ms`;
- authenticated home warm p95 — не более `3000 ms`;
- connector-observed MCP read warm p95 — не более `5000 ms`;
- correlated server warm p95 отдельно для modern и compatibility:
  `list_minds`, `browse_entries`, `search` — не более `2000 ms`, `fetch` — не
  более `1000 ms`;
- point read при `10x` history — не выше `1.2x` соответствующего `1x` profile
  отдельно для modern и compatibility.

## Output и cleanup

Report schema `mind-diary/performance-gate/v3` хранит только exact lineage,
UTC window, budgets, fixture fingerprints, observed aggregate counts/bytes,
aggregate timings, correlation counts, failures и canonical
`artifact_sha256`. Raw request IDs, headers, body/query и response отсутствуют.

После сохранения receipt operator удаляет оба synthetic fixture Minds/files
normal application lifecycle и отдельно проверяет cleanup. Cleanup failure не
переписывает performance result и остаётся release blocker-ом в owning
capacity/UAT row. Никакой production action этот runbook не разрешает.

## Перспективный report v4: измеренные границы смещения часов

Для автономной приёмки MD-400 добавляется отдельный report v4. V3 и старые
receipts сохраняют прежнюю проверку без поправки. Причина — в живом замере
серверный timestamp при совпадающих signed correlation/request IDs оказался
на десятки миллисекунд позже клиентского получения ответа. Это не duration
регрессия, а разные wall clocks.

До и после samples сборщик делает по три настоящих GET к `/_acceptance/build` того же test target. Сохраняются клиентские UTC send/
receive, HTTP `Date`, status 200 и hash actual body с проверенным candidate.
HTTP Date имеет секундную точность: для каждого probe допустимый offset
лежит между `Date - received` и `Date + 999ms - sent`. Используется пересечение
шести интервалов; пустое пересечение, RTT больше 2 секунд, неопределённость
больше 3 секунд, абсолютное смещение больше 5 секунд либо отсутствие probe
до/после всего run дают failed calibration. Никакое вручную заданное смещение
не принимается.

V4 проверяет положение неизменённых server timestamps в client window,
расширенном только этими измеренными границами. Идентификаторы request,
подписанная correlation, provider version, source envelope hashes и полная
coverage по-прежнему обязательны. Клиентские durations и server durations
не меняются; бюджеты, 20 warm samples и history growth остаются прежними.
Hash calibration включается в report v4 и перепроверяется при общем join.
Это проверка согласованности источников времени, а не доказательство отсутствия
произвольных скачков часов между probes; при их наблюдении run отклоняется.
