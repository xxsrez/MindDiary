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
  principal. Canonical secret — `mdp_v1_` + 43 unpadded base64url characters,
  которые декодируются ровно в 32 CSPRNG bytes; он показывается один раз. Server
  хранит только safe display prefix, lifecycle/scopes и exact indexed keyed
  HMAC-SHA-256 verifier `hmac-sha256:v1:<64 lowercase hex>`; plain secret,
  recoverable material и unkeyed hash отсутствуют. HMAC key содержит минимум
  256 random bits и хранится отдельно от token table. Default и maximum
  expiry — 90 дней; scopes — `content:read` и `content:write`, причём write
  scope включает read и write-only token не выпускается. Полный cryptographic
  contract зафиксирован в [ADR-0005](0005-mcp-token-secret-verifier.md).
- MCP content mutations commit-ятся сразу. `commit_changeset` принимает
  `expected_revision`, `idempotency_key` и atomic file operations; persisted
  draft, diff approval и approval artifact отсутствуют.
- Stale HEAD возвращает conflict. Automatic semantic merge не выполняется.
- `index.md` меняется специальной CAS operation; `log.md` — semantic
  `add_log_entry`, сохраняющей OKF newest-first/date grouping. Concept, index и
  log могут входить в одну atomic revision.
- Idempotency record namespace — actor + Mind + operation + key. Он связывается
  с canonical request hash: retry того же payload возвращает прежний result, а
  повторное использование key с другим payload получает conflict.
- Sites обслуживает control plane, MCP — content plane. Оба adapters используют
  общий application core/internal API; raw REST не становится customer API.
- В первом prototype slice routes `/me` и `/{space_handle}` используются для
  адресации и management. Personalized content landing остаётся отдельным
  будущим proposal.

## Последствия

- Token не ограничивается одним Mind: актуальные role/visibility и scopes
  проверяются server-side на каждом call.
- Membership, visibility, ownership, deletion и token management не входят в
  content MCP и не могут быть добавлены инструкцией из corpus. Prompt injection
  всё ещё может склонить модель вызвать разрешённый content write; scope, ACL,
  immutable history и audit ограничивают, а не устраняют этот risk.
- Public/unlisted readers видят новую HEAD немедленно после successful commit.
- Первый prototype использует custom Mind-aware `search(mind, ...)` и
  `fetch(id)`. Он не заявляет OpenAI company-knowledge compatibility:
  стандартный `search(query)` не несёт explicit Mind selector, а текущие
  `okf://` identifiers не являются user-openable citation URLs.
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
- Standard `search(query)` поверх всех доступных Minds: нарушает explicit
  single-Mind boundary. Отдельный company-knowledge/read profile потребует
  нового решения о scoping и user-openable URLs.
- Persisted draft + manual approval каждого commit: добавляет лишний шаг в
  прототип и был прямо исключён из выбранного workflow.
- Literal append `log.md`: нарушает newest-first/date-grouped структуру OKF.

Подробные contracts находятся в [архитектуре](../architecture.md) и
[спецификации первого прототипа](../specs/mvp.md).
