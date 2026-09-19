# Проверка ACL reads и независимых `read_write` lanes Release 0.3

> **Current Web amendment MD-373/MD-383, 2026-09-03.** Principal задаёт для
> каждого Mind
> `disabled | read | read_write`, общий для всех OAuth connections и personal
> tokens, с `0..1` ordinary automatic-write Mind и независимым Personal `/me`
> requested-write Mind. Connections и Advanced MCP остаются
> lifecycle/scopes-only. Machine contract MD-344 и его `target_*` поля ниже
> сохранены как историческое evidence прежней модели и не доказывают current
> Web behavior без principal-usage read-back. Ordinary `read_write` требует
> description; canonical Personal `/me` использует `personal_default` без него,
> а write выполняется только после прямой просьбы пользователя.

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
- Site управляет principal Mind usage. MCP только читает enabled доступные
  Minds и выполняет content calls с явными Mind, revision, HEAD и idempotency;
  mode mutation в MCP отсутствует.
- Оба web surface обязательны: OAuth connection и personal token Advanced MCP.
  Проверка одного из них не заменяет второй; оба показывают только
  lifecycle/scopes и одинаковую principal-owned usage projection через MCP.

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
- fresh Codex 0.153.4 profile обязан разрешить установленный HTTP server как
  OAuth-capable (`auth_status: o_auth`) без автоматического входа или сохранённой
  credential; прежняя строка `not_logged_in` считается несовместимой проекцией,
  а не доказательством более безопасного состояния;
- constructor-only synthetic verified-native profile для exact 22-tool
  modern catalog; его fail-closed fetcher не читает bytes и не является
  hosted route evidence;
- credential target contract и persisted-state migration tests;
- exact direct modern catalog, который не рекламирует
  MCP Apps picker или unverified native stage, retired binding tools и moved
  export tests;
- stale HEAD и wrong Mind zero-side-effect assertions.

Local receipt фиксирует hashes двух probe receipts, каждого test output и
каждого contract/source file. `hosted_status` всегда равен `not-run`; другое
значение делает квитанцию недействительной.

Это frozen MD-344 receipt прежней target-модели. Упоминания target generation,
empty target, capture и credential owner в его registry описывают только
историческую проверку/migration. Fresh MD-375 acceptance дополнительно требует
current Web/API evidence `principal-mind-usage/v2`, independent write lanes и
отсутствия credential-level controls; historical PASS не заменяет эти строки.

Локальный gate подтверждает исторический MD-344 contract:

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
reconnect и reissue cases создаются новые grants/tokens, но не новые accounts и
не отдельный credential-owned selection state. Все content fixtures —
сгенерированный Markdown без пользовательских данных.

## 3. Прямые hosted-наблюдения

Все шаги выполняются последовательно. Каждый следующий шаг использует
read-back предыдущего, а не локальное предположение.

### Каталоги и discovery

- Fresh write-capable modern client (`2026-07-28`) получает exact 26-tool
  catalog, включая один `openai/fileParams` stage. Read-only grant получает
  exact 22-tool subset без `create_file_upload_intent` и native stage.
  Отдельного Apps profile или picker нет; host bridge проверяется отдельным
  fresh client receipt.
- `get_mind_bindings`, `set_read_mind_binding`,
  `set_write_mind_binding`, `start_export`, `get_export_status` отсутствуют в
  обоих catalogs. Exact cached calls возвращают принятый bounded compatibility
  result без side effect.
- Owner видит Personal Mind и run Mind. Ordinary actor видит membership Mind,
  public в catalog, unlisted только по exact handle и не видит private Mind как
  non-member.
- После membership/visibility изменения следующий новый MCP request отражает
  новое состояние. После revoke следующий request denied.

### Credentials и principal Mind usage

Для каждого случая фиксируется только classification и opaque artifact hash:

- новый principal — все Minds `disabled`, `usage_version=0`;
- несколько Minds можно независимо перевести в `read`;
- ровно один ordinary Mind можно перевести в `read_write`, только с непустым
  routing description; независимо canonical Personal `/me` можно перевести в
  `read_write` без description;
  current writer role требуется в обоих случаях;
- второй ordinary `read_write` одним CAS атомарно демотирует прежний ordinary
  Mind в `read`; изменение Personal `/me` не меняет ordinary lane и наоборот;
- два OAuth grants и personal token видят одинаковые configured modes;
- read-only credential видит configured `read_write`, но получает
  `effective.can_write=false`;
- revoke/reconnect/reissue меняют только credential lifecycle/scopes и не
  меняют principal usage;
- Connections и Advanced MCP не содержат credential-owned Mind selector,
  bind/unbind или отдельный automatic-save toggle.

Проверить principal isolation: route другого principal не читает и не изменяет
usage state. Browser передаёт только safe `mind_ref`, mode,
`expected_usage_version` и idempotency key; principal, `space_id`, role и write
generation остаются server authority.

### Writes и immutable revision read-back

Перед общей матрицей отдельно подтвердить policy: topic match, обычное
обсуждение, read request и прежняя просьба не вызывают Personal write; только
прямая просьба текущего пользователя изменить конкретное знание приводит к
`commit_changeset`. Это connector/model-visible evidence, а не доверенный
клиентский флаг в server request.

1. На странице exact run Mind задать `read_write` через usage-version CAS и
   прочитать результат через OAuth и personal-token MCP profiles.
2. Снять HEAD, выполнить один `commit_changeset` с exact Mind,
   `expected_revision` и новым idempotency key; write generation pin-ится
   server-side и не приходит из browser/client.
3. Независимо прочитать новый revision через HEAD, history и exact fetch;
   hashes content должны совпасть.
4. Повторить тот же idempotency key: новый revision не появляется.
5. Отправить stale HEAD: `revision_conflict`, HEAD и history не меняются.
6. Включить Personal `/me` в `read_write`, не меняя ordinary Mind; выполнить
   отдельно exact ordinary и прямо запрошенный Personal changeset, подтвердив
   два независимых HEAD/read-back.
7. Переключить ordinary `read_write` на другой ordinary Mind и отправить
   подготовленный write в прежний: write отклоняется как current lane mismatch,
   а Personal write generation остаётся активной.
8. Потерять writer role: следующий write denied. Reduce-only изменение mode
   выполняется на Site через current `expected_usage_version`; credential page
   не получает control action.

Hosted observation считается полным только при exact matrices
`credentialCases`, `authorityCases`, обоих `webSurfaces`, двух catalogs и
`immutableRevision`. Файл создаётся runner-ом из прямых ответов этого run;
редактируемый вручную checklist доказательством не является.

Имена `target_*` внутри frozen MD-344 schema остаются историческими carrier
fields. Для current acceptance каждый такой row сопровождается direct
principal-usage evidence; один legacy schema join без этого дополнения не
считается MD-375 PASS.

## 4. Cleanup и recovery

Нормальный cleanup обязателен даже после product defect:

1. revoke все per-run grants/tokens;
2. доказать denial на следующем request каждым credential;
3. удалить run Mind и доказать exact absence;
4. повторно прочитать pool baseline и доказать отсутствие временных roles и
   tokens;
5. сравнить custom audience и operator allowlist с readiness receipt.

После timeout или потерянного ответа новые writes останавливаются. Сначала
прочитать deployment state, `usage_version`, configured modes, HEAD/history и
существующие receipts по тому же run fingerprint. До этого retry запрещён.
Классификация — `unknown_external_outcome`, а не pass или product defect.

Concrete defect содержит: failing case ID, expected classification, observed
classification, candidate, deployment, безопасный request correlation и hashes
before/after read-back. Raw response, identity и content не сохраняются.

## 5. Исторический MD-344 machine join

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

Этот join сохраняет provenance старого contract, но не содержит достаточной
формы для current principal usage. Для MD-375 он принимается только вместе с
direct same-run evidence из раздела 3; сам по себе historical joined receipt
не является current Web PASS.

## Терминальный результат

`PASS` current candidate допустим только при одновременном наличии валидной
historical joined receipt
`mind-diary/uat-release-0.3-authority-target-evidence/v1` exact deployed
candidate и direct same-run principal-usage evidence из раздела 3. Одна старая
target matrix не подтверждает MD-375. Иначе результат один из:

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
