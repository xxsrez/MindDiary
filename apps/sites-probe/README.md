# Mind Diary Sites capability probe

Это минимальный, намеренно не продуктовый OpenAI Sites probe для AND-37. Он
проверяет только платформенные предпосылки будущего Mind Diary MVP:

- presence-only Sites identity signals через `GET /probe/identity`;
- D1 counter и R2 object round-trip через authenticated `GET|POST /probe/state`;
- stateless MCP `2026-07-28` через authenticated `POST /mcp`;
- JSON, request-scoped SSE и безопасные transport/auth errors.

Probe не реализует account, Minds, OKF content, ACL, revisions или production
service. `.openai/hosting.json` содержит logical bindings `DB` и
`PROBE_BUCKET`, а также exact Sites `project_id`, добавленный coordinator
после единственного `create_site`.

Hosted runtime должен получить secret `SITES_PROBE_BEARER_TOKEN`. Secret не
передаётся в repository, responses, logs или evidence. Локальные tests передают
изолированное test-only значение напрямую в Worker environment.

```bash
npm ci
npm test
npm run lint
```

Live procedure и поля evidence находятся в
`docs/reports/2026-08-07-sites-mcp-capability-gate.md` корневого репозитория.
