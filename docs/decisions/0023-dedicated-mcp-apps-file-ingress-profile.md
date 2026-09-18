# ADR-0023: отдельный MCP Apps профиль для native file ingress

Статус: superseded by [ADR-0030](0030-single-file-input.md), 2026-09-18.
Отдельный `/api/mcp/apps`, обязательный picker и app-only staging больше не
являются активным контрактом; документ остаётся историей решения и evidence.
Исходное решение принято 2026-08-28. Решение MD-315/MD-316 задавало Release 0.3
контракт публикации native file route и picker. Оно разрешает repository/UAT
implementation, но само по себе не утверждает, что конкретный host уже
переписал file parameter или что hosted staging прошёл.

ADR уточняет [ADR-0011](0011-direct-mcp-plugin-oauth-on-use.md) и
[ADR-0018](0018-file-ingress-contract-and-source-capability-matrix.md):
обычный direct MCP и compatibility Codex transport остаются без native file
route, а OpenAI/MCP Apps получает отдельный modern endpoint.

## Контекст

`stage_bundle_file` использует официальный top-level file parameter. Его schema
уже объявляет `download_url`, `file_id`, optional `mime_type`/`file_name` и
`_meta["openai/fileParams"]`. Однако прежняя composition требовала внешний
receipt о host rewrite до публикации tool. Такой receipt невозможно получить,
пока host не видит tool: возник замкнутый bootstrap.

Публикация tool на общем `/api/mcp` была бы другой ошибкой: direct clients без
MCP Apps/file-library contract увидели бы capability, которой у них нет.
Client hints, `userAgent`, session metadata и наличие schema не являются
authority и не позволяют безопасно выбирать route внутри одного endpoint.

## Решение

1. Product Site добавляет exact modern endpoint `POST /api/mcp/apps`. Он
   использует тот же OAuth resource/audience `/api/mcp`, principal, scopes,
   current ACL, Site-selected singleton writable target и content application.
   Отличаются только route-specific tool/resource projection и native transport.
2. `/api/mcp` и `/api/mcp/2025-11-25` не публикуют `stage_bundle_file` или picker.
   Точный вызов native stage через эти surfaces остаётся fail-closed до target
   lookup и provider fetch.
3. Apps endpoint создаёт закрытый compile-time route profile. Он не выбирается
   через env, request metadata или client-declared identity. Provider file ID и
   temporary URL считаются недоверенным transport envelope, а не
   криптографическим доказательством происхождения.
4. Transport принимает только bounded official file object, HTTPS allowlist,
   no credentials, no referrer/cache, каждый redirect проверяется заново,
   timeout/redirect/stream limits сохраняются. До fetch сервер проверяет token,
   current Mind, write scope/role и exact active writable target.
5. Apps endpoint публикует model-visible `open_bundle_file_picker` с exact
   `_meta.ui.resourceUri`. Static `ui://mind-diary/file-ingress/v1.html`
   возвращается как `text/html;profile=mcp-app`; обычные OKF resources и их
   authorization не меняются.
6. `stage_bundle_file` на Apps endpoint имеет UI visibility `app`. Widget
   feature-detects `selectFiles`; при отсутствии library picker может явно
   использовать `uploadFile`, затем получает fresh URL через
   `getFileDownloadUrl` и вызывает `stage_bundle_file` через `tools/call`.
   Отмена или отсутствие API не создаёт tool call.
7. File ID, temporary URL, bytes и private filename не помещаются в
   `structuredContent`, model context, widget state, DOM attributes, storage,
   logs или durable records. После успешного app-only stage widget вызывает
   portable `ui/update-model-context` и передаёт только уже известные модели
   `mind`/target `path` плюс service-owned opaque `staged_file_ref`; полный
   stage result и provider envelope остаются вне model-visible context.
8. Host rewrite/file-library UAT receipt остаётся обязательным evidence для
   support claim и MD-315/MD-316 terminal acceptance. Compile-time profile,
   schema, tests и successful deployment доказывают только опубликованный
   server boundary.

## Последствия

- Bootstrap становится проверяемым без fabricated assertion: host может увидеть
  Apps tool/resource и выполнить реальный picker flow.
- Обычный direct MCP не получает ложную native capability; compatibility
  `2025-11-25` lifecycle не расширяется resources/UI методами.
- Marketplace package должен направлять Apps-capable integration на
  `/api/mcp/apps`, сохраняя `oauth_resource: /api/mcp`. Legacy Codex transport
  остаётся отдельной package/client compatibility surface и не выбирается
  автоматически внутри request.
- Fresh package install, tool/resource inventory, picker, stage, reconcile,
  commit, byte-exact read-back, revoke/expiry/oversize и privacy-negative cases
  входят в UAT evidence exact candidate/deployment.

## Отклонённые варианты

- **Требовать observed receipt до публикации.** Это сохраняет bootstrap cycle и
  не позволяет получить сам receipt.
- **Публиковать native stage на общем `/api/mcp`.** Direct clients увидят
  unsupported source и смогут ошибочно трактовать schema как capability.
- **Выбирать route по `userAgent`, session или request `_meta`.** Эти поля не
  являются authentication/authorization authority и контролируются клиентом.
- **Передавать file ID/URL через model message.** Это нарушает privacy boundary
  и делает transport envelope частью prompt history.
- **Добавить UI в compatibility endpoint.** Он намеренно не поддерживает
  resources lifecycle и должен оставаться изолированным adapter-ом.
