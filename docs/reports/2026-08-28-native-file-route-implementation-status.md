# Статус native file route на 2026-08-28

Статус: repository implementation evidence для MD-315/MD-316; hosted Apps
support не подтверждён. Активный релиз — `0.3`.

## Причинный вывод

Mind Diary получил отдельный modern MCP Apps endpoint `/api/mcp/apps`, который
разрывает прежний bootstrap cycle: host может увидеть picker и app-only native
stage до появления hosted receipt. Это ещё не доказательство поддержки в
конкретном клиенте. Route честно сообщает `declared_unverified`, пока fresh
installed package и реальный host не пройдут selection → provider object →
stage → model-context receipt → commit на одном exact deployment.

Обычные `/api/mcp` и `/api/mcp/2025-11-25` остаются fail closed: их write
catalog содержит 17 tools без `open_bundle_file_picker` и `stage_bundle_file`,
а точный cached native call отклоняется до target lookup или сети. Apps catalog
содержит 19 tools; schema, UI resource, deployment и test double сами по себе
hosted support не доказывают.

## Реализованная repository boundary

- Product Site всегда создаёт sealed Apps composition только для exact
  `/api/mcp/apps`; env, `userAgent`, session metadata и request `_meta` не могут
  выбрать этот route.
- `open_bundle_file_picker` проверяет explicit Mind, current write capability и
  exact Site-selected writable target до открытия static
  `ui://mind-diary/file-ingress/v1.html` resource.
- Widget feature-detects `selectFiles`, имеет явный `uploadFile` fallback,
  получает fresh URL через `getFileDownloadUrl` и вызывает app-only
  `stage_bundle_file` через `tools/call`.
- После успешного stage widget передаёт через portable
  `ui/update-model-context` только уже известные модели `mind`/target `path` и
  service-owned opaque `staged_file_ref`. Полный stage result не становится
  model-visible.
- Provider ID, temporary URL, bytes и private filename остаются внутри iframe и
  MCP adapter edge. Apps route сохраняет neutral `display_filename =
  selected-file`; provider/caller filename override игнорируется.
- Temporary fetch разрешён только по HTTPS к explicit OpenAI allowlist, с
  allowlisted manual redirects, `credentials: omit`, `no-store`, no referrer,
  timeout и counting stream до 256 MiB inclusive.
- Portable staging сохраняет общий SHA-256, size, quota, quarantine, expiry,
  idempotency, reconcile, `staged_file_ref` и atomic commit lifecycle.
- Constructor-verified native profile остаётся synthetic local evidence:
  18-tool projection сохраняет model-visible native stage metadata, но не
  активирует Apps picker и не считается hosted route receipt.

Conformance и Product Site integration tests проверяют direct 17, read-only
16, constructor-verified 18 и Apps 19 projections, exact UI resource, safe
context handoff, route-specific metadata, default direct denial и bounded
provider transport. Это repository evidence, не host observation.

## Проверенная текущая capability

Исходный MD-317 probe проверял Codex Desktop `26.820.60940` build `7119` и
Mind Diary plugin `0.1.0+codex.20260826190538`. Он видел native schema только на
старой direct surface; structurally valid provider object завершался
`native_file_input_unsupported` до fetch. Этот результат остаётся историческим
доказательством отсутствия direct host rewrite и не проверяет новый Apps route.

Рабочий packaged companion + hosted upload intent остаётся отдельным
`local_path` / `workspace/generated_artifact` transport. Его нельзя называть
`session_attachment` или использовать как доказательство MD-315/MD-316.

## Что разблокирует native acceptance

Нужен один fresh hosted receipt на exact installed Apps-capable package,
candidate, Sites version и deployment, который одновременно доказывает:

1. package/registration действительно направляет Apps integration на
   `/api/mcp/apps`, сохраняя OAuth audience `/api/mcp`;
2. fresh catalog содержит exact 19 tools, picker metadata и точный UI resource;
3. restricted-UAT synthetic file реально выбирается через host picker/upload,
   а provider envelope достигает app-only stage без ручного конструирования;
4. model context получает только explicit Mind/path и opaque staged ref;
5. retry/reconcile и commit используют тот же ref, после чего download/history/
   export подтверждают exact bytes без provider locator или private data;
6. revoke, expiry, oversize и cleanup проходят на том же lineage.

Пока не определён и не проверен exact installed package/registration path до
`/api/mcp/apps`, acceptance MD-315/MD-316 остаётся nonterminal. Production не
входит в scope.
