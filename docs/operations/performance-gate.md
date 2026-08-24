# Exact-candidate performance gate

Статус: accepted operational contract для Release 0.1, обновлено 2026-08-24.
Repository runner реализован; этот документ не утверждает, что UAT receipt уже
получен.

## Назначение и граница

Gate блокирует UAT acceptance при regressions authenticated home и MCP read
path. Он проверяет один exact Git SHA на одном exact Sites deployment и не
принимает local benchmark, заявленную вручную scale matrix или один успешный
HTTP status как hosted evidence.

Канонический local scale benchmark
`npm run benchmark:local-mind-scale` остаётся полезным deterministic preflight для
`1/10/100` Minds. Synthetic browser gate остаётся проверкой Product Site
composition. Ни один из них не выдаётся за UAT profile provisioning/read-back
или latency receipt.

## Обязательные private inputs

Все inputs и полный report находятся только в private temporary evidence
storage. В repository не добавляются token, Sites credential, request/response
body, query, Mind/revision ID, path, URL download grant или private corpus.

### Profile provision/read-back receipt

Перед benchmark отдельный trusted UAT probe нормальными application commands
создаёт synthetic fixture profiles и затем независимо считывает их состояние.
Он выпускает hashed receipt
`mind-diary/performance-profile-readback/v1` с generator
`mind-diary/uat-profile-provision-readback/v1`.

Receipt связывает:

- exact `candidate_sha` и полную Sites identity: project, version, deployment и
  SHA-256 опубликованного archive;
- exact UAT target и canonical UTC provisioning/read-back window;
- `1/10/100` observed Minds и `1/20/100/1000` observed revisions;
- Brain Markdown profile не меньше `1741` files / `5,681,704` bytes;
- mixed corpus не меньше одного file / `590,000,000` bytes;
- для каждой строки distinct opaque provisioning/read-back request IDs,
  fixture fingerprint и exact equality `expected == observed` сразу по
  `minds/revisions/files/bytes`;
- keyed HMAC actual MCP credential и SHA-256 exact canonical tool arguments,
  которыми probe сделал read-back и которыми runner затем выбирает fixture.

Safe file/byte read-back берётся из `get_revision.manifest_summary`
(`file_count`, `total_bytes`), capacity projection и соответствующих normal
application reads, а не из scenario declaration. Receipt с лишними полями,
неверным hash, stale SHA/deployment, неполной matrix, отрицательным/нецелым
count либо несовпадающим read-back отклоняется до первого benchmark request.
HMAC key и credential никогда не входят в receipt: private scenario хранит
только имя `credential_binding_key_env`, а runner пересчитывает binding из
actual environment value до первого HTTP request. Поэтому три одинаковых
`list_minds {}` с произвольным token не могут изображать profiles `1/10/100`.
Отдельный 256-bit key из `performance_correlation_key_env` подписывает каждый
runner correlation ID и совпадает с deployment secret
`MIND_DIARY_PERFORMANCE_CORRELATION_KEY`; это не тот же proof, что credential
binding, и ни одно значение key/signature в evidence не сохраняется.

### Scenario v2

Private scenario имеет schema `mind-diary/performance-scenario/v2`, повторяет
exact SHA/deployment/target, задаёт `warm_samples >= 20` и bounded
`telemetry_wait_seconds <= 300`. Credential values задаются только через имена
environment variables. Inline `Authorization`, cookie и Sites authorization
header запрещены.

Каждая из девяти fixture rows выполняется через оба MCP profiles:

- `mcp_modern` — `POST /api/mcp`;
- `mcp_compatibility` — `POST /api/mcp/2025-11-25`.

В каждом profile обязательно присутствуют `list_minds`, `browse_entries`,
`search` и `fetch`. Для point-read history задаётся одна пара
`get_revision` с одинаковым comparison group и scale `1`/`10`. Отдельный
`web` profile выполняет authenticated `GET /`.

Каждая request definition получает один first-observed sample и ровно
`warm_samples` warm samples. MCP rows должны быть `tools/call`, а заявленная
operation обязана совпадать с tool name и hashed fixture request binding.
Modern request обязательно несёт согласованные `MCP-Protocol-Version`,
`Mcp-Method`, `Mcp-Name` и `_meta` protocol/client/capabilities. Compatibility
request несёт exact `MCP-Protocol-Version: 2025-11-25`. Оба MCP profiles и web
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

Report schema `mind-diary/performance-gate/v2` хранит только exact lineage,
UTC window, budgets, fixture fingerprints, observed aggregate counts/bytes,
aggregate timings, correlation counts, failures и canonical
`artifact_sha256`. Raw request IDs, headers, body/query и response отсутствуют.

После сохранения receipt operator удаляет synthetic fixture Minds/files normal
application lifecycle и отдельно проверяет cleanup. Cleanup failure не
переписывает performance result и остаётся release blocker-ом в owning
capacity/UAT row. Никакой production action этот runbook не разрешает.
