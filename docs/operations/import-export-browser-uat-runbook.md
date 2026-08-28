# Browser и UAT-проверка import/export exact bytes

Статус: operational contract для MD-363, 2026-08-27. Локальная
детерминированная композиция реализована; hosted UAT acceptance требует
отдельных прямых наблюдений exact deployment в том же run.

## Назначение и граница

Этот runbook проверяет web-owned Markdown import и exact-revision export
Release 0.3. Он не добавляет import/export в MCP, не читает пользовательские
файлы и не превращает локальные JSON в доказательство hosted выполнения.

Локальный gate использует только сгенерированные temporary bytes и shipped
Product Site clients. Hosted этап использует отдельный private run-owned Mind и
короткоживущую credential; production, Drive, archive restore, AWS и реальные
private corpora не входят в scope.

## Локальная детерминированная композиция

Runner создаёт во временном каталоге:

- valid UTF-8 Markdown snapshots с неизвестным полем OKF в concept;
- non-Markdown, invalid UTF-8, duplicate/path-conflict и файл ровно
  `1 MiB + 1 byte`;
- Markdown-only historical revision;
- mixed baseline с opaque bytes
  `00017f80ff4d443336330a` и их exact SHA-256;
- replacement snapshot, который обязан сохранить opaque path и прежнюю
  immutable history.

Playwright программно устанавливает generated files в настоящий browser input.
User picker, Chrome profile, login state и private filesystem не используются.
Fixture server исполняет shipped import/export UI, проверяет multipart bytes и
строит export через текущий `DeterministicOkfExportService`, а не через готовый
архив fixture.

Закрытый registry содержит 13 assertions:

- fixture bytes/boundaries;
- plan/confirm/import с одной HEAD transition;
- invalid path/profile/UTF-8 без staging;
- `1 MiB + 1` и quota denial без session/revision;
- unknown start replay, interruption/reload/resume и exact idempotency;
- cancel и оба HEAD-conflict момента без изменения HEAD;
- immutable history и opaque preservation;
- current, historical и mixed export с independent browser byte/size/SHA-256
  comparison;
- expired grant, revoked credential и visibility tightening;
- cancel/grant/job/Mind cleanup и exact route absence.

Перед browser matrix runner исполняет существующие runtime suites Markdown
import, exact export, durable jobs, grants, UI и archive contracts. Receipt
связывает их source hashes, exact candidate, фактически выполненные версии
Playwright/Chromium, Chromium executable hash, generated fixture manifest и
все 13 assertion IDs.

Для clean exact candidate:

```bash
MD363_TEMP_ROOT=${TMPDIR:-/tmp}
MD363_EVIDENCE_DIR=$(mktemp -d "${MD363_TEMP_ROOT%/}/mind-diary-md363-evidence.XXXXXX")
npm run gate:import-export-browser -- \
  --candidate-sha <exact-clean-HEAD-sha> \
  --evidence-out "$MD363_EVIDENCE_DIR/import-export-browser.json"
```

Output обязан быть новым файлом внутри существующего owner-only temporary
directory с exact mode `0700`, owner write/execute и расположением вне
repository и всех его worktrees. `0500`, более широкие modes и ACL-effective
denial отклоняются. Непосредственно перед записью runner атомарно резервирует
файл через `O_CREAT | O_EXCL | O_NOFOLLOW` с mode `0600` и держит открытый
FileHandle до final write, `fsync` и close. После open он повторно сверяет
realpath, device/inode parent и candidate, ownership/modes и forbidden roots с
pre-open наблюдением. Relative path, existing file, workspace destination,
public temp directory и symlink escape fail closed до evidence bytes; точный
пустой reservation удаляется.

Output имеет schema `mind-diary/import-export-browser-evidence/v1`,
`status: passed`, но одновременно обязательные
`hosted_evidence: false`, `acceptance: local-deterministic-only` и
`provenance: exact-candidate-local-execution`. Такой result доказывает только
локальную композицию exact candidate.

После успешной browser matrix внутренний temporary workspace удаляется. При
Playwright failure generated-only diagnostics сохраняются в отдельном
owner-private temporary directory; stderr и `CLEANUP-GUIDANCE.txt` называют
exact directory и срок удаления не позднее 24 часов. Failure receipt при этом
не создаётся.

## Hosted same-run prerequisites

Orchestrating agent до browser journeys обязан сам получить в одном
непрерывном run:

1. exact clean candidate и прошедший project gate;
2. exact Sites archive этого candidate;
3. прямой Sites connector read-back project, saved version, source
   `commit_sha`, archive size/hash и successful deployment;
4. controlled redeploy той же exact version с новым deployment ID и terminal
   successful read-back;
5. Codex in-app Browser session на current UAT URL;
6. private run-owned Mind, credential и только generated fixture bytes;
7. возможность после проверки отозвать credential, удалить Mind и доказать
   отсутствие следующими reads.

Локальный path/base64/URL substitute, system browser, Safari, screenshot,
самостоятельно введённые provider IDs и старый receipt не заменяют эти
prerequisites. Если hosted upload/download primitive реально отсутствует,
сохраняются exact capability/response и nonterminal blocker; другой transport
не подставляется.

## Hosted browser matrix

In-app Browser повторяет critical matrix через real same-origin routes:

1. Создаёт private run Mind и фиксирует initial HEAD/history.
2. Программно передаёт generated Markdown через file input, сверяет authoritative
   plan и подтверждает exact replacement.
3. Проверяет unknown start replay, interruption через controlled redeploy,
   reload/resume, cancel, quota/limit/invalid paths и stale HEAD. Negative rows
   обязаны иметь fresh HEAD/history no-side-effect read-back.
4. Проверяет одну новую immutable revision, неизменную прежнюю history,
   неизвестные OKF fields и exact opaque SHA-256.
5. Запускает current, historical Markdown-only и historical mixed export.
   Каждый archive скачивается independently, после чего browser-side bytes,
   HTTP length, receipt size и три SHA-256 значения должны совпасть.
6. Проверяет expired grant, next-request denial после credential revoke и
   visibility tightening.
7. Отзывает run credential, отменяет незавершённые операции, удаляет run Mind и
   доказывает отсутствие route, jobs и grants. Cleanup продолжается после
   failure до bounded safe terminal state.

Raw read-back использует schema
`mind-diary/import-export-in-app-browser-readback/v1`. Revision/job values в
persisted redacted evidence представлены opaque SHA-256 fingerprints; exact
raw IDs остаются только в private same-run tool outputs. Ни receipt, ни Task
comment не содержат Markdown/opaque bytes, paths, token, cookie, signed URL,
email или response body.

## Offline structural join

После прямых read-back можно проверить byte/shape consistency:

```bash
npm run join:import-export-uat-readback -- \
  --local-receipt <private-temp-directory>/import-export-browser.json \
  --provider-readback <private-temp-directory>/provider-readback.json \
  --browser-readback <private-temp-directory>/browser-readback.json \
  --artifact-archive <exact-archive-passed-to-save-version> \
  --candidate-sha <exact-deployed-sha> \
  --join-out "$MD363_EVIDENCE_DIR/import-export-uat-join.json"
```

`--join-out` применяет ту же atomic reservation, post-open identity revalidation,
owner-only temp, worktree и symlink gate, что и `--evidence-out`, и также
требует отсутствующий destination file.

Provider input schema
`mind-diary/import-export-sites-provider-readback/v1` содержит raw results
current Site/version, successful deployment before redeploy, redeploy start и
successful terminal read-back after redeploy. Sites source `commit_sha` в
текущей конфигурации — отдельный subtree-mirror commit. Joiner получает его
только из provider input и fail closed сверяет локально: subject обязан быть
`Mirror MindDiary <candidate-sha>`, а tree — точно совпадать с
`<candidate-sha>:apps/mind-diary-site`. Поэтому mirror SHA не подменяет
монорепозиторный candidate и не сравнивается с ним как равный. Join
пересчитывает archive hash, проверяет candidate/project/version/deployment lineage, generated fixture
manifest, closed assertion registry, exact export comparisons и cleanup.

Даже полностью согласованный join всегда возвращает только:

```json
{
  "status": "structurally_verified_readback",
  "hosted_evidence": false,
  "acceptance": "nonterminal",
  "provenance": "unverified-local-files"
}
```

Локальные lookalike JSON/archive тоже могут доказать структуру, поэтому local
script никогда не пишет `status: passed` для UAT и не принимает CLI approval.

## Terminal hosted evidence

Hosted PASS может зафиксировать только orchestrating agent, который сам видел
в текущем run все Sites connector calls и in-app Browser observations. Terminal
record использует schema
`mind-diary/uat-release-0.3-import-export-evidence/v1`,
`hosted_evidence: true`, `provenance: direct-same-run-observation` и связывает:

- exact candidate, Site version, оба deployment ID и archive hash;
- local receipt и structural join hashes;
- refs/hashes каждого raw Sites и Browser observation;
- actor/run fingerprints и exact revision/job raw-read provenance;
- import, history, recovery, exact export bytes и negative no-side-effect rows;
- cleanup/absence read-back.

Repository script намеренно не создаёт и не валидирует terminal hosted record:
его authority выводится из прямых tool observations текущего orchestrator, а не
из формы файла. Без них MD-363 остаётся nonterminal при любом локальном PASS.

## Failure и recovery

- Неизвестный mutation outcome сначала разрешается status/HEAD/job read-back;
  новый idempotency key до reconciliation запрещён.
- Redeploy failure не означает import/export defect: сначала перечитываются
  deployment, session/job и HEAD.
- Byte/SHA mismatch — terminal failed assertion; archive не сохраняется как
  принятый.
- Revoke/tightening failure не обходится новой ссылкой: current access сначала
  должен быть восстановлен либо run закрывается fail-closed.
- Cleanup failure сохраняет run fingerprint и продолжает только reduce-only
  reconciliation; новый run не создаётся поверх неизвестного state.
