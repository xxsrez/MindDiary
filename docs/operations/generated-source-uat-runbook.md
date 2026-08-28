# Проверка generated-source ingress в UAT

Статус: accepted procedure MD-290, 2026-08-28. Эта проверка относится только к
Release 0.3 и UAT. Она не включает production, не меняет access policy и не
принимает пользовательские данные.

## Результат

Один exact candidate должен доказать два внутренних source route:
`bounded_in_memory` и `server_generated`. Оба используют обычный
application-owned staging, возвращают только `staged_file_ref` и становятся
видимы лишь после отдельного atomic commit в выбранный на Site writable target.

Локальная проверка и hosted evidence разделены. Локальный receipt всегда имеет
`hosted_evidence=false`; offline join также не может объявить hosted PASS.
Terminal вывод возможен только из живых Sites и in-app Browser наблюдений того
же запуска.

## Локальный gate exact candidate

Создайте отдельный private temp directory с exact mode `0700`; новый output
file должен отсутствовать. Из чистого exact candidate выполните:

```sh
npm run gate:generated-source-local -- \
  --candidate-sha <exact-clean-HEAD-sha> \
  --evidence-out <private-0700-directory>/generated-source-local.json
```

Runner принимает только candidate SHA и private output path. Он не принимает
bytes, prompt/job identity, URL, credential, principal или имя Mind. Fixtures
детерминированы внутри repository tests: exact 4 MiB и byte +1 для bounded
route, а также representative streaming, overflow, cancellation, timeout и
producer-error rows. Receipt связывает exact SHA с хешами исполнявшихся suites,
но сохраняет public capability claim `not_available` до hosted доказательства.

## Hosted same-run UAT

Root release owner сначала сверяет exact UAT project/version/deployment через
Sites control plane. В уже подготовленной restricted-UAT test session normal
server commands должны:

1. создать fresh private ordinary Mind с synthetic content only;
2. выпустить dedicated credential с коротким expiry и `content:write`;
3. выбрать этот Mind единственным writable target через authenticated Site;
4. stage-ить exact 4 MiB bounded fixture и representative generated stream;
5. проверить +1 byte, overflow, cancel, timeout, producer error, stale target,
   digest mismatch и revoke как no-HEAD/no-partial-effect outcomes;
6. reconcile exact stage/commit payload после искусственно неизвестного
   transport outcome без повторного object/revision effect;
7. одним explicit changeset commit-ить оба refs, затем проверить history,
   exact download и actor-owned Web export;
8. выполнить controlled redeploy того же version/candidate и повторить exact
   path/size/SHA/bytes read-back;
9. revoke-нуть dedicated credential, удалить только run-owned Mind и перечитать
   отсутствие target/Mind.

Owner/generation/version никогда не являются runner input. Trusted runtime
сам выводит credential owner и active target generation; Content MCP request не
может передать `write_binding_id` или replacement generation field.

Fresh trusted-test-composition response не является публичным MCP capability
report: публичные rows остаются `not_available`, transport `none`, limit `0`.
Если test-composition response возвращает для обоих внутренних routes
`test_composition_status: not_available`, `test_transport: none`, limit `0`,
это точный product/platform blocker `hosted_generated_sources_not_available`.
Local implementation, ручной файл и другой transport его не заменяют.

## Private readbacks и offline join

Provider readback имеет schema
`mind-diary/generated-source-sites-readback/v1`, exact candidate, project/version,
два distinct succeeded deployment ID и собственный content hash. In-app Browser
readback имеет schema `mind-diary/generated-source-browser-readback/v1`, exact
lineage, closed assertion set с отдельными overflow/cancel/timeout/error,
stale-target, digest-mismatch, no-partial-HEAD и no-duplicate rows, boolean
exact-byte/read-back и cleanup matrix
либо fresh blocker row. Оба документа исключают URL, credentials, private names,
raw content paths/bytes и response bodies.

После живых наблюдений offline structural join выполняется так:

```sh
npm run join:generated-source-uat -- \
  --candidate-sha <exact-clean-HEAD-sha> \
  --setup-deployment-id <exact-appgdep-id> \
  --verify-deployment-id <different-exact-appgdep-id> \
  --local-receipt <private-path> \
  --provider-readback <private-path> \
  --browser-readback <private-path> \
  --join-out <new-private-path>
```

Join проверяет shape, hashes, distinct redeploy, exact lineage, все assertions и
cleanup. Его status — `structurally_verified_readback` либо
`verification_blocked`, но `hosted_evidence` всегда `false`: локальный файл не
аутентифицирует происхождение Sites/Browser вызова. Root добавляет live tool
provenance отдельно и только затем решает terminal acceptance.

## Recovery и безопасность

- После unknown mutation сначала выполняется read-only reconcile exact payload;
  новый key до разрешения outcome запрещён.
- Cleanup удаляет только fresh run-owned private Mind после повторной проверки
  sole Owner, private visibility и exact target. Drift останавливает deletion.
- Credential revoke выполняется до Mind deletion и перечитывается.
- Evidence parent остаётся `0700`, files — `0600`; output reservation использует
  no-follow/exclusive open и повторно проверяет parent device/inode.
- Ни transcript, ни receipt не сохраняют bearer, cookie, URL, private name,
  source bytes/path, prompt/job identity или raw product IDs.
