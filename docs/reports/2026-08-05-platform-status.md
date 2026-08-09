# Состояние платформенных предпосылок на 2026-08-05

Статус: report. Наблюдение выполнено 2026-08-05; внешнее состояние после этой
даты может измениться. Environment terminology в этом датированном report
историческая: с 2026-08-09 текущий OpenAI Site классифицируется как UAT, а
production является отдельным manual-only target.

## Вывод

Архитектурное направление Mind Diary остаётся жизнеспособным, но две прежние
формулировки устарели:

- MCP `2026-07-28` уже опубликован как текущая stable specification, поэтому
  его нельзя называть draft/RC;
- текущая документация OpenAI Sites говорит о зависимости public-beta
  доступности от plan, region и workspace settings, но не выделяет отдельное
  EEA-ограничение.

Это не доказывает, что ChatGPT или AgentCore уже одинаково поддерживают все
семантические изменения MCP `2026-07-28`. Поэтому protocol lifecycle остаётся
за adapter boundary: `2026-07-28` — target, а `2025-11-25` — явный legacy
compatibility profile только для клиента, на котором он реально потребовался.

Для первого прототипа документально подтверждён practicable путь с bearer
token в Codex, но не end-to-end совместимость готового Mind Diary MCP с Codex
или Claude Code: её ещё нужно проверить conformance tests.
Production MVP требует положительный Codex test. Claude Code остаётся отдельным
неблокирующим profile и не называется supported до собственного test.

## Принятое project decision после проверки

Внешние факты выше не выбирают deployment architecture автоматически. Для Mind
Diary принято отдельное product/architecture решение: единственная production
platform MVP — OpenAI Sites, а AWS/AgentCore отложен на post-MVP этап.

Это решение не превращает непроверенный MCP-in-Sites в подтверждённую
capability. Напротив, реальный Sites + MCP compatibility gate становится
обязательным production criterion. Если он не проходит, MVP release блокируется
до нового решения; fallback в отдельный container или AWS не выполняется
автоматически.

## Проверенные факты

### MCP

- Текущая нормативная спецификация имеет revision `2026-07-28` и использует
  stateless per-request protocol metadata вместо legacy session handshake.
- Страница `2025-11-25` остаётся доступна как предыдущая version и полезна для
  совместимости, но уже не является текущей stable revision.
- Переход между версиями нельзя свести к смене одной константы: lifecycle и
  transport conformance должны тестироваться отдельными profiles.

### OpenAI Plugins и Sites

- Для company knowledge OpenAI по-прежнему требует стандартные read-only
  `search`/`fetch` schemas и user-openable absolute URLs. Standard
  `search(query)` принимает одну query string и не имеет отдельного Mind
  selector; поэтому user-scoped multi-Mind surface первого прототипа не может
  честно считаться этим profile без отдельного routing/URL design.
- Public plugin submission требует стабильный public HTTPS Streamable HTTP MCP
  endpoint; реальная проверка в ChatGPT developer mode остаётся обязательной.
- Для authenticated production MCP plugin OpenAI описывает OAuth 2.1 с PKCE;
  это целевой путь для polished integration, но не обязательный механизм
  личного prototype connection.
- Sites находится в public beta и может зависеть от plan, region и workspace
  settings. Sites документирует durable D1/R2 bindings, server-side identity,
  project linkage через `.openai/hosting.json` и custom domains там, где они
  доступны.
- Sites передаёт server-side verified email в
  `oai-authenticated-user-email` и optional full name в
  `oai-authenticated-user-full-name`. В проверенной документации не найдено
  обещания стабильного external subject, поэтому durable account key и email
  relink нельзя считать закрытым platform contract.
- Sites documentation не обещает, что произвольный Site является совместимым
  Streamable HTTP MCP host. Совместное размещение остаётся compatibility spike.

### Codex MCP client

- Codex поддерживает remote MCP server по `url` и передачу bearer token из
  environment variable через `bearer_token_env_var`.
- Это позволяет не записывать личный secret в repository/config, но не заменяет
  server-side expiry, revocation, scopes и per-request ACL.
- Аналогичная возможность Claude Code не считается подтверждённой для Mind
  Diary, пока не выполнен отдельный client conformance test.

### AWS AgentCore Runtime

- AgentCore Runtime документирует MCP container contract на
  `0.0.0.0:8000/mcp` и Streamable HTTP.
- Stateless mode подходит Mind Diary, потому что canonical revisions,
  memberships и jobs находятся во внешнем storage, а не в MCP session.
- Совместимость конкретного SDK/runtime с target MCP revision всё равно должна
  подтверждаться integration suite, а не выводиться из наличия `/mcp` route.

## Изменения в проектной документации

- Current MCP target исправлен на `2026-07-28`; legacy `2025-11-25` изолирован.
- Compatibility gates стали version-aware вместо безусловного требования
  `initialize`.
- Sites availability приведена к текущей официальной формулировке.
- Непроверенные MCP-in-Sites и client-version assumptions остаются явно
  помеченными как эксперименты и открытые вопросы.
- Первый prototype auth зафиксирован как revocable personal bearer token;
  OAuth 2.1 + PKCE оставлен production target.
- Sites identity binding отделён от internal immutable `principal_id`, потому
  что текущая документация не фиксирует stable external subject. Initial email
  binding нормализуется server-side; unknown email явно создаёт isolated account
  без прежних прав либо идёт в manual recovery, без automatic relink/merge.
- MCP первого прототипа зафиксирован как custom Mind-aware tool profile;
  company-knowledge compatibility отложена до отдельного решения.
- Production target MVP зафиксирован как Sites-only; AWS и отдельный MCP runtime
  удалены из fallback path и оставлены post-MVP направлениями.

## Ограничения

Это документальная сверка официальных источников, а не live deployment test.
Она не подтверждает доступность Sites на текущем аккаунте, прохождение ChatGPT
plugin review, рабочий Mind Diary MCP на Sites или будущий AgentCore
deployment.

## Первичные источники

- [MCP specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic)
- [MCP specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic)
- [OpenAI: build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [OpenAI: authenticate an MCP server](https://developers.openai.com/plugins/build/auth)
- [OpenAI Codex: MCP](https://developers.openai.com/codex/mcp)
- [OpenAI Sites](https://learn.chatgpt.com/docs/sites)
- [AWS: deploy MCP servers in AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp.html)
