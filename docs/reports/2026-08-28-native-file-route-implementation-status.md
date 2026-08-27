# Статус native file route на 2026-08-28

Статус: repository implementation evidence для MD-315; hosted/native support
не подтверждён. Активный релиз — `0.3`.

## Причинный вывод

Mind Diary теперь имеет fail-closed route-кандидат для
`session_attachment` через `native_file_parameter`, но текущий Codex host его
не активирует: реальный host rewrite выбранного файла в provider-issued object
не наблюдался. Поэтому direct custom MCP обязан показывать
`not_available`, не публиковать `stage_bundle_file` в fresh catalog и закрывать
точный прямой вызов до target lookup или сети.

Это внешний capability blocker. Локальный код, JSON Schema с
`_meta["openai/fileParams"]`, test double или переданный вручную
`file_id/download_url` не заменяют host rewrite evidence.

## Реализованная repository boundary

- `NativeFileParameterRoute` создаётся только с exact assertion полями:
  route profile, assertion ID, observation time, `stage_bundle_file.file`,
  `session_attachment` и `native_file_parameter`.
- Fresh `tools/list` включает native stage только для такого route и доступного
  общего staging service. Capability response сообщает exact profile/assertion
  либо typed `not_available` с `null` evidence.
- `createProductSiteRuntime` имеет explicit constructor-only
  `verifiedNativeFileParameterRoute` input и создаёт route внутри composition
  root только для exact unique `mcpProfiles`. Missing input оставляет
  default/direct catalog без stage; incomplete assertion/profile set закрывает
  создание runtime. Product Worker сейчас input не задаёт.
- Provider object имеет закрытую форму `file_id + download_url` с optional
  advisory filename/media. Local path, base64, лишние поля, missing locator и
  arbitrary URL отклоняются.
- Temporary fetch разрешён только по HTTPS к explicit OpenAI allowlist, с
  manual allowlisted redirects, `credentials: omit`, `no-store`, no referrer и
  общим timeout. Declared и фактический поток ограничены inclusive 256 MiB.
- Provider ID/URL завершаются на MCP edge. В portable staging передаются только
  bounded stream, exact `source_kind=session_attachment`, safe metadata,
  target binding/generation, idempotency key и optional expected digest/size.
- SHA-256, size, quota, retry/reconcile, `staged_file_ref` и atomic commit
  остаются общим lifecycle, а не отдельной native реализацией.

Product Site integration test отдельно проверяет обе composition ветви. Default
runtime не рекламирует stage и закрывает exact direct call до fetch. Runtime с
полным synthetic assertion только на заявленном modern profile публикует exact
schema/capability, выполняет allowlisted fetch, сохраняет проверенный staged
object и возвращает тот же ref через reconcile; незаявленный compatibility
profile остаётся без stage. Это repository composition evidence; synthetic
assertion не является внешним host receipt.

## Проверенная текущая capability

Исходный MD-317 probe проверял Codex Desktop `26.820.60940` build `7119` и
Mind Diary plugin `0.1.0+codex.20260826190538`. Native schema присутствовала,
но структурно корректный provider object завершился
`native_file_input_unsupported` до fetch; local path не был переписан host-ом.
Установленный plugin направляет content в direct hosted MCP и отдельно
публикует local companion, но не содержит подтверждённого host-managed App
bridge для native parameter.

Рабочий packaged companion + hosted upload intent остаётся отдельным
`local_path` / `workspace/generated_artifact` transport. Его нельзя называть
`session_attachment` или использовать как доказательство MD-315.

## Что разблокирует native acceptance

Нужен новый внешний receipt для каждого заявляемого профиля, который на exact
installed plugin/candidate доказывает одновременно:

1. fresh catalog с `stage_bundle_file` и exact native file metadata;
2. реальный выбор session/provider file и host rewrite в provider object;
3. успешный allowlisted streaming stage с проверенными bytes, digest и size;
4. retry/reconcile и commit того же `staged_file_ref` в current writable target;
5. download/history/export exact bytes без provider locator или private data в
   response/log evidence.

До такого receipt UAT/native claim и activation запрещены; production не
входит в scope.
