# Disk-first ingress: разделение capability layers

Статус: dated verification report, 2026-08-26. Документ описывает Release 0.2
и не является production evidence. Exact hosted acceptance принадлежит MD-325.

## Ответ

Capability file ingress нельзя сворачивать в одно `available_hosted`.
Release 0.2 требует три независимых факта:

1. Hosted Mind Diary сообщает только наличие server-side adapter, его binding
   requirement и byte limit.
2. Fresh inventory точного Codex client/profile отдельно показывает packaged
   local companion.
3. Только local admission конкретного explicit path доказывает, что current
   execution host действительно может прочитать один regular file.

Ни repository code, ни MCP schema, ни server adapter по отдельности не
доказывают два остальных слоя.

## Candidate contract

`get_file_ingress_capabilities` возвращает
`report_scope: hosted_server_adapters_only`. Поля
`client_companion_status` и `path_admission_status` всегда равны
`not_reported`: hosted service не угадывает installed client state и не обещает
readability локального пути.

В Release 0.2 ровно две server rows доступны:

| Source kind | Server adapter | Binding | Limit | Что ещё требуется |
|---|---|---|---:|---|
| `local_path` | `companion_upload_intent` | exact active write binding | 256 MiB | fresh companion inventory и local admission |
| `workspace/generated_artifact` | `companion_upload_intent` | exact active write binding | 256 MiB | fresh companion inventory, workspace authority и local admission |

`session_attachment`, `connector_object`, `bounded_in_memory` и
`server_generated` возвращают `not_available`, `server_transport: none`,
`requires_write_binding: false` и `max_bytes: 0`. Silent fallback на URL,
base64, provider transport или другой source kind запрещён. Direct
host/provider, connector и generated routes остаются Release 0.3.

Ответ не содержит path, filename, provider locator, account, token, URL,
credential или private content.

## Fresh pre-release observations

В exact установленном Codex profile на момент отчёта видны оба packaged local
companion tools: prepare exact local file и upload prepared file. Это inventory
evidence, а не гарантия readability любого path.

Текущий до-candidate UAT deployment ещё возвращает старую смешанную matrix с
`available_hosted` для `session_attachment`, `local_path` и
`workspace/generated_artifact`. Поэтому этот ответ явно не принимается как
Release 0.2 evidence: он не отделяет server adapter от client inventory и path
admission. MD-325 должна повторить read-back после exact candidate deployment.

## Повторяемая repository verification

Targeted contract проверяют:

```bash
npm run build
node --test \
  tests/conformance/mcp-binding-tools.test.mjs \
  tests/conformance/mcp-bundle-file-staging.test.mjs
git diff --check
```

Тесты доказывают одинаковую modern/compat response semantics, exact six-row
matrix, server-only scope, write-binding/limit fields, отсутствие private
locators и `not_available` для deferred routes. Они не называются installed
client или hosted UAT evidence.

## MD-325 join gate

Terminal UAT verification соединяет слои только на одном exact candidate:

1. фиксирует exact Codex client/profile и fresh companion tool inventory;
2. читает новый hosted server-only capability response;
3. выполняет successful disk и trusted-workspace admissions;
4. связывает stage, atomic commit, download, history/export и post-redeploy
   persistence с exact Git SHA и Site deployment;
5. сохраняет только безопасные IDs, sizes, MIME и hashes — без local paths,
   filenames, URLs, credentials или private bytes.

До этого repository candidate может закрыть MD-313, но не MD-325 и не весь
Release 0.2.
