# Hosted canary generated producer ingress

Статус: accepted restricted-UAT procedure для `MD-290`, 2026-08-24.
Runbook исполняет capability
`mind-diary/uat-generated-producer-canary/v1` для hosted
`bounded_in_memory` и `server_generated`. Это постоянная, но fail-closed
операторская проверка: её route отсутствует для `dev`, `production`, неизвестного
deployment class, пустого operator allowlist, anonymous actor и любого обычного
зарегистрированного principal.

Repository status и live status разделены. Наличие hosted producer port и
`available_hosted` в composition означает только реализованный code path.
Hosted Codex UAT остаётся `not-available`/pending в release matrix, пока exact
candidate не пройдёт описанные ниже setup, отдельный redeploy, verify и cleanup
с passing receipt. Runbook не включает production enablement и не является
разрешением менять production configuration.

## Что доказывает canary

Один уже зарегистрированный UAT service operator с dedicated write-scoped MCP
credential создаёт fresh ordinary Mind с детерминированным handle
`md290-generated-<random-16-hex>`. Runner проверяет, что Mind private, actor —
его единственный Owner, а dedicated credential до setup не имеет active write
binding. Затем он создаёт и инвалидирует priming binding, устанавливает новый
`write_binding_id` на canary Mind и вызывает скрытый internal route. Route не
принимает source bytes, stream, path, URL, provider ID, arbitrary filename,
Mind ID или generic producer command от caller: все bytes, stream chunks,
filenames, media types, paths и Markdown зафиксированы server-side.

Setup внутри одного hosted runtime выполняет:

- exact deny для foreign и уже invalidated write-binding generations;
- typed MIME, bounded-size, changeset-quota, cancellation и writer-failure
  negatives;
- exact staged replay для `bounded_in_memory`;
- chunked fixed stream для `server_generated`;
- проверку, что каждый negative/replay не изменил HEAD;
- один atomic changeset из двух staged BundleFile refs и Markdown;
- второй Markdown-only commit, чтобы одна generated revision стала historical,
  а следующая — HEAD.

Verify выполняется только после другого exact deployment ID. Новая Worker
composition заново читает durable D1/R2 state и materializes обе revisions.
Canary сравнивает exact PNG/PDF bytes, размер и SHA-256 в historical revision и
HEAD, parent chain и текущий write-binding generation. Caller получает только
fixed fixture profile, два SHA-256 и закрытый список assertion IDs — без bytes,
canonical paths, principal/Mind/revision/staged-file/binding IDs или response
bodies.

Этот canary не доказывает native session attachment, connector transport,
Codex UI exposure или production support. Он также не публикует generic/debug
endpoint: единственный path —
`/api/v1/internal/operators/generated-ingress-canary`, только `POST`, exact
same-origin CSRF и совместная проверка Sites operator identity и MCP principal.

## Предусловия и authority boundary

1. Coordinator фиксирует exact 40-character candidate SHA, setup deployment
   ID, rollback target и restricted-UAT origin. Production исключён.
2. На setup deployment заданы exact
   `MIND_DIARY_DEPLOYMENT_CLASS=uat` и существующий bounded
   `MIND_DIARY_SERVICE_OPERATOR_PRINCIPAL_IDS`. Empty allowlist закрывает route.
   Invalid/missing deployment class не включает canary. Эти значения входят в
   runtime cache fingerprint.
3. Operator уже зарегистрирован, самостоятельно вошёл в Sites и имеет
   dedicated MCP token с `content:write`. Token принадлежит тому же principal,
   что Sites session. Runner не bootstrap-ит account, не меняет audience,
   operator allowlist, membership или access policy.
4. Dedicated token до setup имеет `write_binding: null`. Если binding уже есть,
   runner останавливается до изменения. Не используйте повседневный credential.
5. Setup и verify deployment собраны из одного candidate SHA. Verify deployment
   ID обязан отличаться от setup ID; оператор предоставляет IDs из deployment
   control plane, runner не угадывает lineage по HTTP body.
6. State и receipt пишутся вне repository на private local filesystem. Не
   сохраняйте shell transcript с environment credentials.

Credentials передаются только через environment:

```text
MIND_DIARY_UAT_GENERATED_CANARY_SITES_TOKEN
MIND_DIARY_UAT_GENERATED_CANARY_MCP_TOKEN
```

Sites session идёт accepted runner header
`OAI-Sites-Authorization`; MCP secret — обычным `Authorization: Bearer` только
на MCP/internal canary request. Значения не являются CLI arguments, не входят в
state/receipt и не печатаются. Отсутствующий или не-Mind-Diary MCP token закрывает
run до hosted mutation.

## Phase A: setup

В clean checkout exact candidate:

```sh
npm run uat:generated-producer-canary -- \
  --phase setup \
  --candidate-sha <exact-40-char-sha> \
  --deployment-id <exact-setup-appgdep-id> \
  --state-out <private-temp-path>/generated-producer-state.json
```

Для нестандартного restricted-UAT origin добавьте `--base-url <exact-https-origin>`.
Runner фиксирует только его opaque fingerprint; raw URL не хранится. До первого
hosted request он exclusive создаёт state с mode `0600`, status
`setup_started`, candidate SHA, setup deployment ID и random nonce. Дальнейшие
checkpoint обновляются через private sibling temporary file и atomic rename.

Успех заканчивается `status: awaiting_redeploy`. State содержит fixed fixture
SHA и setup assertion IDs, но не handle, URL, identity, token, binding/Mind/
revision/staged-file ID, path или raw body. Setup не является passing evidence.

## Phase B: distinct redeploy и verify

Разверните тот же candidate как новый UAT deployment, сохранив exact UAT class,
operator allowlist и durable D1/R2 bindings. Затем:

```sh
npm run uat:generated-producer-canary -- \
  --phase verify \
  --deployment-id <different-exact-appgdep-id> \
  --state <private-temp-path>/generated-producer-state.json
```

Если setup использовал `--base-url`, передайте тот же URL снова. Opaque target
fingerprint должен совпасть. Same deployment ID, другой target, изменившийся
principal/token owner, stale/current binding mismatch, reconstruction failure,
неполная history или любой byte/SHA mismatch оставляют run non-passing.

Успех сохраняет `status: verified` и verify assertion IDs, но ещё не создаёт
receipt: product cleanup обязателен до pass.

## Phase C: cleanup и receipt

```sh
npm run uat:generated-producer-canary -- \
  --phase cleanup \
  --state <private-temp-path>/generated-producer-state.json \
  --receipt-out <private-temp-path>/generated-producer-receipt.json
```

Runner повторно проверяет exact derived handle, name, `private`, self Owner и
единственного member. Он снимает write binding только если тот всё ещё указывает
на canary Mind, затем получает deletion impact, удаляет только эту Mind и
подтверждает `mind_not_found` плюс отсутствие canary write target. Другой
current binding, чужая Mind, изменившееся имя/visibility/ownership или
дополнительный member не «исправляются» и не удаляются — cleanup fail closed.
Account, Personal Mind, token, audience и allowlist runner не удаляет.

После hosted cleanup state получает crash-resumable checkpoint. Только затем
exclusive создаётся mode-`0600` receipt и state становится `passed`. Receipt
schema `mind-diary/uat-generated-producer-canary-receipt/v1` содержит exact
candidate SHA, оба distinct deployment ID, opaque run/target/resource
fingerprints, fixed fixture profile/SHA, закрытый passing assertion list, UTC
observation и content hash. В нём нет identity, credentials, URL, raw product
IDs, paths, bytes или raw responses.

Только этот terminal receipt можно связать с release evidence и использовать
для перевода hosted producer row из pending. Факт успешного local/integration
test или `verified` state без cleanup недостаточен.

## Recovery

После любого interrupted/nonterminal setup, verify или cleanup:

```sh
npm run uat:generated-producer-canary -- \
  --phase recover \
  --state <private-temp-path>/generated-producer-state.json
```

При custom origin снова передайте exact `--base-url`. Recovery использует
redacted checkpoint, чтобы удалить только runner-created priming/canary binding
generation и exact canary-owned Mind. Он не восстанавливает и не меняет
неизвестный pre-run target. Если ownership/visibility/name/member invariants
больше не совпадают, recovery останавливается для ручного расследования без
расширения authority. `recovered` — terminal cleanup result, не passing
evidence; receipt не создаётся.

После `passed`/`recovered` authorized operator отдельно отзывает dedicated MCP
token по обычной UAT procedure. State/receipt передают content-addressed и затем
удаляют recoverable способом; credentials и identity mapping не архивируют.
