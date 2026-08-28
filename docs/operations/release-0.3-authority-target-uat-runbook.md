# Проверка ACL reads и singleton write target Release 0.3

Статус: accepted operational verification contract для `MD-344`.

Этот runbook соединяет два независимых слоя доказательств:

1. детерминированную локальную проверку exact candidate;
2. прямые наблюдения exact UAT deployment на трёх readiness-checked test
   principals.

Локальный PASS не является hosted PASS. Итоговая UAT-квитанция имеет schema
`mind-diary/uat-release-0.3-authority-target-evidence/v1` и появляется только
после machine join локальной квитанции, pool readiness и отдельного hosted
observation той же версии и deployment.

## Границы

- Target — только UAT. Production явно исключён.
- Используются `UAT-OPERATOR`, `UAT-MIND-ROLE` и `UAT-ORDINARY` из
  [restricted-UAT pool](uat-test-account-pool.md). Другие principals не
  подставляются.
- Password, MFA, passkey, OAuth code, bearer token, email, internal ID и corpus
  body не попадают в receipts или репозиторий.
- Synthetic identity существует только как constructor-injected test adapter.
  Ни один production runtime switch, header, URL или stored identity mapping не
  допускается.
- Site управляет target. MCP только читает доступные сейчас Minds и выполняет
  content calls с явными Mind, revision, HEAD и idempotency.
- Оба web surface обязательны: OAuth connection и personal token Advanced MCP.
  Проверка одного из них не заменяет второй.

Закрытый machine contract находится в
`tests/fixtures/release-0.3-authority-target/contract.v1.json`.

## 1. Локальная квитанция exact candidate

Сначала выполнить один build, затем gate. Output обязан быть новым файлом в
owner-private каталоге `0700` под системным temp и вне всех Git worktrees:

```bash
npm run build --silent
mkdir -m 700 /private/tmp/mind-diary-r03-authority-LOCAL
npm run gate:release-0.3-authority-target -- \
  --candidate-sha 0123456789abcdef0123456789abcdef01234567 \
  --evidence-out /private/tmp/mind-diary-r03-authority-LOCAL/local.json
```

Если Git worktree расположен не рядом с checkout `Srez Marketplace`, добавить
`--marketplace-root /absolute/path/to/clean/Srez Marketplace`.
Отсутствующий либо не-Git default sibling останавливает gate с безопасным
`marketplace_checkout_unavailable`; он не сворачивается в
`unexpected_response` и не разрешает пропустить direct-plugin proof.

Заменить SHA на полный SHA exact clean `HEAD`. Gate сам повторно сверяет HEAD и
clean worktree до и после проб. Он последовательно запускает:

- synthetic multi-principal probe через normal product bootstrap;
- OAuth direct-plugin probe с fresh/read/write/revoke/reconnect и personal-token
  regression;
- constructor-only synthetic verified-native profile для exact 18-tool
  modern/compat catalogs; его fail-closed fetcher не читает bytes и не является
  hosted route evidence;
- credential target contract и persisted-state migration tests;
- exact modern/compat 18-tool catalog, retired binding tools и moved export
  tests;
- stale HEAD и wrong Mind zero-side-effect assertions.

Local receipt фиксирует hashes двух probe receipts, каждого test output и
каждого contract/source file. `hosted_status` всегда равен `not-run`; другое
значение делает квитанцию недействительной.

Локальный gate подтверждает:

- Personal, membership, public, unlisted и private discovery;
- немедленное действие membership, visibility и revoke;
- owner isolation OAuth и personal token;
- fresh/reconnect/reissue empty target;
- same-owner OAuth upgrade с новой generation и legacy fail-closed cases;
- отсутствие переноса target/capture;
- exact target generation, stale HEAD, wrong Mind и отсутствие побочного
  revision;
- отсутствие binding mutations и export tools в обоих MCP catalogs.

Он не подтверждает deployment, live Site, hosted persistence или browser UI.

## 2. Подготовка UAT run

До первого mutable hosted вызова нужны одновременно:

1. exact candidate SHA и exact Sites deployment ID;
2. валидная `mind-diary/uat-test-account-pool-readiness/v2` квитанция для того
   же candidate/deployment;
3. три distinct short-lived session references в environment текущего run;
4. private evidence directory `0700`;
5. baseline read-back: временных Mind roles и per-run MCP tokens нет.

Если readiness отсутствует или не совпадает с deployment, классификация —
`blocked_by_dependency`; hosted mutations не начинаются.

Создать один synthetic run Mind через обычный Site command path. Для свежих,
reconnect и reissue cases создаются новые grants/tokens/targets, но не новые
accounts. Все content fixtures — сгенерированный Markdown без пользовательских
данных.

## 3. Прямые hosted-наблюдения

Все шаги выполняются последовательно. Каждый следующий шаг использует
read-back предыдущего, а не локальное предположение.

### Каталоги и discovery

- Fresh write-capable modern client (`2026-07-28`) и compatibility client
  (`2025-11-25`) получают ровно 18 names из contract fixture. Read-only grant
  получает exact 16-tool subset без двух write-only native staging tools.
- `get_mind_bindings`, `set_read_mind_binding`,
  `set_write_mind_binding`, `start_export`, `get_export_status` отсутствуют в
  обоих catalogs. Exact cached calls возвращают принятый bounded compatibility
  result без side effect.
- Owner видит Personal Mind и run Mind. Ordinary actor видит membership Mind,
  public в catalog, unlisted только по exact handle и не видит private Mind как
  non-member.
- После membership/visibility изменения следующий новый MCP request отражает
  новое состояние. После revoke следующий request denied.

### Credentials и target lifecycle

Для каждого случая фиксируется только classification и opaque artifact hash:

- fresh OAuth — target version `0`, writable Mind отсутствует;
- legacy OAuth — pending upgrade и non-disclosing
  `credential_access_upgrade_required`;
- same-owner unambiguous OAuth upgrade — тот же selected Mind, новая opaque
  generation, capture disabled;
- reconnect OAuth — новый owner и empty target;
- fresh personal token — empty target;
- legacy personal token — pending upgrade, только reissue;
- personal-token reissue — новый owner и empty target;
- revoke/reconnect/reissue не переносят target или capture.

Проверить owner isolation: Site target route другого principal не читает и не
изменяет owner state. Browser не передаёт owner или generation как authority.

### Writes и immutable revision read-back

1. На обоих web surfaces выбрать exact run Mind через target-version CAS.
2. Снять HEAD, выполнить один `commit_changeset` с exact target, generation,
   `expected_revision` и новым idempotency key.
3. Независимо прочитать новый revision через HEAD, history и exact fetch;
   hashes content должны совпасть.
4. Повторить тот же idempotency key: новый revision не появляется.
5. Отправить stale HEAD: `revision_conflict`, HEAD и history не меняются.
6. Переключить target и отправить подготовленный write в прежний Mind:
   `writable_target_mismatch`; HEAD/history обоих Minds не меняются.
7. Потерять writer role: следующий write denied; clear target остаётся
   reduce-only и выполняется через current target version.

Hosted observation считается полным только при exact matrices
`credentialCases`, `authorityCases`, обоих `webSurfaces`, двух catalogs и
`immutableRevision`. Файл создаётся runner-ом из прямых ответов этого run;
редактируемый вручную checklist доказательством не является.

## 4. Cleanup и recovery

Нормальный cleanup обязателен даже после product defect:

1. revoke все per-run grants/tokens;
2. доказать denial на следующем request каждым credential;
3. удалить run Mind и доказать exact absence;
4. повторно прочитать pool baseline и доказать отсутствие временных roles и
   tokens;
5. сравнить custom audience и operator allowlist с readiness receipt.

После timeout или потерянного ответа новые writes останавливаются. Сначала
прочитать deployment state, target version, HEAD/history и существующие
receipts по тому же run fingerprint. До этого retry запрещён. Классификация —
`unknown_external_outcome`, а не pass или product defect.

Concrete defect содержит: failing case ID, expected classification, observed
classification, candidate, deployment, безопасный request correlation и hashes
before/after read-back. Raw response, identity и content не сохраняются.

## 5. Machine join

Final output также должен быть новым private temp file. Поле `schema` находится
на верхнем уровне и обязано быть равно
`mind-diary/uat-release-0.3-authority-target-evidence/v1`; вложенный
`read_back` не подменяет schema квитанции:

```bash
npm run join:release-0.3-authority-target -- \
  --local-evidence /private/tmp/mind-diary-r03-authority-LOCAL/local.json \
  --pool-evidence /private/tmp/mind-diary-r03-authority-UAT/pool.json \
  --hosted-observation /private/tmp/mind-diary-r03-authority-UAT/hosted.json \
  --output /private/tmp/mind-diary-r03-authority-UAT/joined.json
```

Join fail-closed проверяет:

- local, pool и hosted observation имеют один exact candidate;
- pool и hosted observation имеют один exact deployment;
- три ordered actor fingerprints совпадают с readiness pool;
- hosted observation имеет environment `uat`, production excluded, оба web
  surfaces, оба exact catalogs, все credential/authority cases, immutable
  revision read-back и полный cleanup;
- local receipt имеет `hosted_status=not-run`.

Подстановка local receipt вместо hosted observation отклоняется как
`invalid_join_input_receipt`. Поэтому локальные тесты, fixture или mock не могут
создать `r03.target.uat-joined`.

## Терминальный результат

`PASS` допустим только для валидной joined receipt
`mind-diary/uat-release-0.3-authority-target-evidence/v1` exact deployed
candidate. Иначе результат один из:

- `product_defect` — контракт нарушен прямым наблюдением;
- `service_fault` — проверка не дошла до надёжного product result;
- `missing_external_capability` — требуемая Sites/MCP/browser поверхность
  недоступна;
- `credential_role_or_approval` — существующий restricted actor требует
  owner-controlled password, MFA или passkey;
- `unknown_external_outcome` — outcome нельзя безопасно повторить без
  reconciliation;
- `blocked_by_dependency` — readiness, lineage или upstream contract не готов.

Незавершённый cleanup всегда остаётся blocker и не может быть скрыт основным
PASS.
