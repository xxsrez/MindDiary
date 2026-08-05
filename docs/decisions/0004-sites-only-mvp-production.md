# ADR-0004: OpenAI Sites как production target MVP

Статус: accepted, 2026-08-05.

## Контекст

В документации одновременно фигурировали Sites prototype, возможный отдельный
portable runtime для MCP и будущий AWS AgentCore deployment. Из-за этого слово
«production» не задавало одну проверяемую поверхность: релиз мог означать
только web UI на Sites, split deployment либо ранний AWS-контур.

Для текущего MVP нужен один однозначный release target. При этом документация
Sites пока не доказывает, что реальный Streamable HTTP MCP Mind Diary сможет
работать в том же production Site; эта неопределённость должна оставаться
явным gate, а не скрываться fallback-ом.

## Решение

- Единственная production platform MVP — **OpenAI Sites**.
- Фраза «зарелизить на продакшн» без другого qualifier означает deploy exact
  проверенного commit в production Site Mind Diary и live-проверку этого Site.
- MVP production release включает весь обязательный vertical slice на Sites:
  authenticated web/control UI, application core, persistence и Streamable
  HTTP content MCP с проверенным Codex client. Успех только UI не считается
  полным release; Claude Code не блокирует MVP и требует отдельного conformance
  test до заявления поддержки.
- Compatibility gate Sites + MCP остаётся обязательным. Если Site не может
  предоставить required endpoint, lifecycle, auth forwarding или persistence,
  MVP production release блокируется до нового решения; MCP не переносится
  автоматически в отдельный container.
- AWS deployment — Bedrock AgentCore Runtime, S3, DynamoDB и optional
  OpenSearch — отложен на post-MVP этап и не входит в текущий release contract.
- Domain core, OKF codec и application ports продолжают проектироваться
  переносимыми, чтобы поздний переход с Sites на AWS не менял domain semantics.
- Preferred Sites slug остаётся `mind-diary`; exact production domain и URL
  будут зафиксированы по фактическому Sites project до первого release.

## Последствия

- Release evidence связывает exact Git SHA, Sites project, version/artifact,
  deployment ID, live URL и успешные web + MCP smoke/conformance flows.
- Local vertical slice, preview, docs-only integration и успешный Sites UI без
  рабочего required MCP не называются production deployment.
- Провал Sites MCP compatibility gate является настоящим blocker-ом MVP, а не
  сигналом автоматически развернуть AgentCore или отдельный runtime.
- Любая новая production surface до завершения MVP требует нового явного
  решения и обновления этого ADR, спецификации и release skill.
- AWS остаётся архитектурным направлением и portability constraint, но не
  текущим критерием готовности или release destination.

## Рассмотренные варианты

- **Sites для UI + отдельный portable MCP runtime.** Не выбран для MVP: он
  возвращает две production surfaces и размывает смысл команды release.
- **AWS/AgentCore уже в MVP.** Отложен, чтобы сначала доказать продуктовый
  vertical slice на принятой Sites surface.
- **Local-only prototype.** Недостаточен: не даёт production Site и live
  integration evidence.

Связанные документы: [архитектура](../architecture.md),
[спецификация первого прототипа](../specs/mvp.md) и
[платформенный отчёт](../reports/2026-08-05-platform-status.md).
