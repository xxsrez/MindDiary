# Stateful UAT matrix для Sites storage/import/export

Статус: исполнимый repository runbook для `MD-288`; live UAT evidence создаётся
только после полного `setup → start → interrupt → redeploy → verify → cleanup`
на одном exact candidate. Наличие runner-а само по себе не доказывает hosted
storage, import, export или cleanup.

## Что проверяет matrix

`npm run uat:storage-matrix` создаёт один synthetic ordinary Mind и проверяет:

- deterministic OKF 0.2 snapshot ровно из `1 741` Markdown-файла и
  `5 681 704` UTF-8 bytes;
- metadata-only plan и его exact `descriptor_sha256` read-back;
- authenticated same-origin REST multipart staging по bounded checkpoints;
- сохранение import session и первого checkpoint после нового Sites
  deployment того же candidate;
- restartable validation и promotion до одной immutable HEAD revision;
- exact revision/file/byte read-back через modern `2026-07-28` и compatibility
  `2025-11-25` MCP profiles;
- semantic `search` + `fetch` SHA-256 в обоих profiles: HTTP `200` с MCP
  `isError=true` считается failure;
- asynchronous exact-revision `MD-OKF-ZIP-1` export, download size/SHA-256,
  CRC-32 и SHA-256 каждого stored ZIP entry, complete central directory и
  exact EOCD;
- удаление только созданного этим run Mind и revoke только выделенного этому
  run MCP token.

Matrix не меняет Site access/environment, не deploy-ит Site, не удаляет
account и не работает с production. Sites provider операции и свежие lineage
read-backs остаются у release coordinator-а по
[профилю доставки](ship-work-release-profile.md).

## Предпосылки и secret boundary

Нужны:

1. Exact integrated candidate с успешными repository/dev/CI gates.
2. Успешный deployment A этого SHA в текущий UAT Site и свежий provider
   read-back его `project/version/deployment/live URL`.
3. Активный зарегистрированный UAT account с правами Owner на создаваемый
   ordinary Mind.
4. Новый dedicated personal MCP token со scope `content:write`, пустыми read/
   write bindings и именем `UAT Storage Matrix <nonce>`, где `<nonce>` —
   выбранные заранее 16 lowercase hex characters.
5. Private local directory вне repository с mode `0700`. State и terminal
   evidence writer выставляет `0600` и fail closed при group/other bits.

Sites session reference, MCP secret и token ID передаются только через
environment. Не передавайте их как CLI arguments, не вставляйте в lineage,
Task Manager, logs или release evidence:

```bash
umask 077
read -s MIND_DIARY_UAT_STORAGE_SITES_TOKEN
export MIND_DIARY_UAT_STORAGE_SITES_TOKEN
read -s MIND_DIARY_UAT_STORAGE_MCP_TOKEN
export MIND_DIARY_UAT_STORAGE_MCP_TOKEN
read MIND_DIARY_UAT_STORAGE_MCP_TOKEN_ID
export MIND_DIARY_UAT_STORAGE_MCP_TOKEN_ID
```

Runner не записывает эти значения в state/evidence. Private state содержит
только synthetic handle и необходимые opaque recovery locators. Terminal
evidence не содержит Mind/revision/import/export/token IDs, paths, query,
content, account identity, URL или credentials.

## Fresh lineage input

До `setup`, непосредственно перед `start` и непосредственно перед `interrupt`
release coordinator получает current deployment A через Sites connector и
создаёт private JSON следующей exact schema:

```json
{
  "schema": "mind-diary/sites-deployment-readback/v1",
  "status": "succeeded",
  "candidate_sha": "<40-lowercase-hex>",
  "site_project_id": "appgprj_<opaque>",
  "site_version_id": "appgver_<opaque>",
  "deployment_id": "appgdep_<opaque-a>",
  "live_url": "https://<uat-host>",
  "observed_at_utc": "<UTC instant>"
}
```

После intentional interruption coordinator повторно deploy-ит exact candidate
в тот же UAT project, reconciles provider outcome и создаёт deployment B
receipt той же schema. Candidate, project и live origin должны совпасть, а
`deployment_id` обязан отличаться. CLI input без fresh Sites read-back не
считается доказательством lineage.

## Основной сценарий

Ниже `EVIDENCE_DIR`, `CANDIDATE_SHA` и `NONCE` — локальные operator values.
Не используйте repository path для state, lineage или receipt.

### 1. Setup

```bash
npm run uat:storage-matrix -- \
  --phase setup \
  --candidate-sha "$CANDIDATE_SHA" \
  --lineage "$EVIDENCE_DIR/deployment-a.json" \
  --nonce "$NONCE" \
  --state-out "$EVIDENCE_DIR/storage-state.json"
```

`setup` fail closed проверяет active account, exact dedicated token metadata,
нулевой binding state и disabled automatic capture. Затем он создаёт только
`uat-storage-<nonce>` exact idempotent create-командой и не присоединяет run к
ранее существовавшему похожему Mind. После этого dedicated token связывается
только с созданным Mind. Повторный state path не перезаписывается.

### 2. Start bounded import

```bash
npm run uat:storage-matrix -- \
  --phase start \
  --lineage "$EVIDENCE_DIR/deployment-a.json" \
  --state "$EVIDENCE_DIR/storage-state.json" \
  --interrupt-after-batches 1
```

Runner воспроизводит fixture локально, сверяет server descriptor, создаёт
private import session и загружает только первый из семи multipart batches.
Повтор той же команды использует stable idempotency keys и server status,
поэтому не публикует вторую revision.

### 3. Зафиксировать intentional interruption

```bash
npm run uat:storage-matrix -- \
  --phase interrupt \
  --lineage "$EVIDENCE_DIR/deployment-a.json" \
  --state "$EVIDENCE_DIR/storage-state.json"
```

Phase выполняет read-back nonterminal `active` session и checkpoint, но не
загружает новые bytes и не меняет HEAD. После `awaiting_redeploy` не продолжайте
import на deployment A.

### 4. Redeploy exact candidate

Release coordinator сохраняет rollback identity, выполняет обычный UAT
redeploy exact candidate через Sites, reconciles terminal provider result и
получает fresh deployment B receipt. Runner не выполняет эту операцию.

Не заменяйте redeploy restart-ом локального процесса: acceptance требует новый
Sites `deployment_id` при том же candidate/project/origin.

### 5. Resume и verify на deployment B

```bash
npm run uat:storage-matrix -- \
  --phase verify \
  --lineage "$EVIDENCE_DIR/deployment-b.json" \
  --state "$EVIDENCE_DIR/storage-state.json" \
  --poll-timeout-ms 600000
```

`verify` сначала доказывает, что server сохранил checkpoint deployment A,
затем дозагружает snapshot, bounded-страницами завершает validation/promotion,
сверяет terminal import status и выполняет modern+compat MCP и export checks.
Search/index и export polling bounded; timeout, unexpected terminal state,
HTTP `200` с tool error, wrong SHA/size/revision или неполный ZIP дают ненулевой
exit. Успех заканчивается `verified_cleanup_pending`, а не terminal release
receipt.

### 6. Cleanup и terminal evidence

```bash
npm run uat:storage-matrix -- \
  --phase cleanup \
  --state "$EVIDENCE_DIR/storage-state.json" \
  --evidence-out "$EVIDENCE_DIR/storage-matrix-evidence.json"
```

Cleanup:

1. cancel-ит только nonterminal import из signed local state;
2. перед deletion повторно проверяет exact synthetic handle/name, private
   visibility, Owner role и deletion impact;
3. удаляет только этот ordinary Mind;
4. сверяет token ID fingerprint и exact token name, revoke-ит только dedicated
   token и требует следующий MCP request `401`;
5. сохраняет `cleaned_evidence_pending` с неизменяемым completion timestamp;
6. атомарно пишет terminal `mind-diary/uat-storage-matrix-evidence/v1` и только
   после успешной записи переводит state в `cleaned`.

Если локальная запись receipt прервана (`ENOSPC`, permissions, process
interruption), повторите ту же cleanup-команду с тем же `--evidence-out`.
Runner не повторяет уже завершённые network deletions, использует сохранённый
timestamp и создаёт тот же content-addressed receipt. Состояние
`cleaned_evidence_pending` не является terminal passing evidence.

Если verification не завершён, cleanup всё равно доступен для recovery, но
terminal passing evidence не создаётся и `--evidence-out` не требуется.

## Recovery

После process/network interruption выполните:

```bash
npm run uat:storage-matrix -- \
  --phase recover \
  --state "$EVIDENCE_DIR/storage-state.json"
```

`recover` не угадывает target и не меняет HEAD. Он проверяет state integrity,
а для незавершённых server phases также credential fingerprint и import
status, сохраняет более свежий checkpoint и возвращает `next_phase`:

| State | Следующее действие |
|---|---|
| `prepared` | idempotently закончить `setup`, затем `start` |
| `setup_complete` | `start` |
| `import_started`, checkpoint ниже configured interrupt boundary | повторить `start` |
| `import_started`, checkpoint достиг boundary | `interrupt` |
| `awaiting_redeploy` | получить deployment B и `verify` |
| `verifying` или server `committed` | повторить `verify` с тем же B receipt |
| `verified` / `cleanup_pending` | `cleanup` |
| `cleaned_evidence_pending` | повторить `cleanup --evidence-out ...`; network cleanup не повторяется |
| `cleaned` | ничего |

Если private state потерян, повреждён либо имеет permissions шире `0600`,
runner не восстанавливает resource identity по поиску и ничего не удаляет.
Сначала остановите release и вручную установите exact run-owned locators через
trusted control surface; нельзя выбирать Mind/token по похожему имени.

## Evidence interpretation

Terminal receipt фиксирует exact candidate, project, deployment A/B, fixture
counts/digests, interrupted checkpoint, modern/compat fetch digest, export
archive digest/size и fixed assertions. Он подтверждает только этот один UAT
run. Он не доказывает provider capacity limits, mixed `590 MB` corpus,
production readiness или отсутствие provider-side request metadata.

Перед присоединением receipt к release coordinator проверяет:

- file mode `0600` и artifact SHA-256;
- candidate/project/deployment identity против fresh Sites read-back;
- отсутствие active synthetic Mind и возможность dedicated token только как
  `401`;
- отсутствие raw state, lineage URL, credential или downloaded ZIP в durable
  release evidence.

После присоединения terminal receipt локальный ZIP уже не существует: runner
держит его только в памяти. Private state/lineage можно удалить recoverable
способом после принятия evidence; token secret и Sites session reference не
архивируются.
