# ADR-0003: user-scoped MCP и immediate commits

Статус: accepted, 2026-08-05.

## Контекст

Основная работа с Mind должна происходить через Codex или Claude Code, а сайт
нужен для account и metadata management. Прежний proposal связывал MCP mount с
одним Space и требовал persisted draft, отдельный diff review и approval token
для каждого commit. Это не соответствует выбранному простому агентному
workflow.

## Решение

- Один MCP connection аутентифицирует principal и видит все доступные ему
  Minds: `/me`, accepted memberships, public catalog и unlisted по exact handle.
- Каждый content tool явно выбирает ровно один Mind и revision. General implicit
  cross-Mind search/synthesis отсутствует.
- Первый MCP auth использует named revocable opaque bearer token, bound к
  principal. Secret имеет не менее 256 random bits, показывается один раз, на
  server хранится hash; default expiry 90 дней; scopes — `content:read` и
  `content:write`.
- MCP content mutations commit-ятся сразу. `commit_changeset` принимает
  `expected_revision`, `idempotency_key` и atomic file operations; persisted
  draft, diff approval и approval artifact отсутствуют.
- Stale HEAD возвращает conflict. Automatic semantic merge не выполняется.
- `index.md` меняется специальной CAS operation; `log.md` — semantic
  `add_log_entry`, сохраняющей OKF newest-first/date grouping. Concept, index и
  log могут входить в одну atomic revision.
- Sites обслуживает control plane, MCP — content plane. Оба adapters используют
  общий application core/internal API; raw REST не становится customer API.
- В первом prototype slice routes `/me` и `/{space_handle}` используются для
  адресации и management. Personalized content landing остаётся отдельным
  будущим proposal.

## Последствия

- Token не ограничивается одним Mind: актуальные role/visibility и scopes
  проверяются server-side на каждом call.
- Membership, visibility, ownership, deletion и token management не входят в
  content MCP и не могут быть вызваны инструкцией из corpus.
- Public/unlisted readers видят новую HEAD немедленно после successful commit.
- Low expected writer count делает CAS/re-read/retry приемлемым baseline.
- User оплачивает inference своего agent client; Mind Diary предоставляет MCP,
  storage и deterministic server operations без собственного LLM call в этом
  пути.
- OAuth 2.1 + PKCE остаётся production target для polished plugin integration,
  но не блокирует personal-token prototype.

## Отклонённые варианты

- Один MCP mount на Mind: заставляет пользователя заранее создавать несколько
  connections и мешает агенту выбрать нужный Mind по запросу.
- Autonomous cross-Mind retrieval: создаёт неявное смешивание ACL/provenance;
  для него нужен отдельный explicit use case.
- Persisted draft + manual approval каждого commit: добавляет лишний шаг в
  прототип и был прямо исключён из выбранного workflow.
- Literal append `log.md`: нарушает newest-first/date-grouped структуру OKF.

Подробные contracts находятся в [архитектуре](../architecture.md) и
[спецификации первого прототипа](../specs/mvp.md).
