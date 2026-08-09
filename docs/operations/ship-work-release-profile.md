# Профиль `ship-work-release` для Mind Diary

Статус: accepted project configuration, 2026-08-09.

Документ задаёт project-specific параметры для универсального
`ship-work-release`. Нормативные orchestration semantics находятся в
[delivery specification](../specs/ship-work-release.md), а команды
пользователя — в [operator runbook](ship-work-release.md).

## Canonical profile

~~~yaml
schema: ship-work-release/project-profile/v1
profile_id: mind-diary

task_management:
  adapter: linear
  adapter_contract: ship-work-release/task-manager-adapter/v1
  adapter_reference: references/task-manager-linear.md
  adapter_spec: docs/specs/ship-work-release-linear.md
  collection: Mind Diary
  scope_selector: current_project_milestone

repository:
  integration_branch: main
  remote: origin
  install: npm ci
  full_gate: npm run check
  diff_check: git diff --check
  targeted_checks_source: readiness registry and work-item ownership manifest

ci:
  provider: github-actions
  required: true
  workflow: .github/workflows/ci.yml
  exact_candidate_required: true

release:
  default_cadence: continuous-uat
  review: manual

dev:
  target_class: localhost
  launch: npm run dev
  url_source: launcher output
  data_class: isolated-local-test
  secrets_class: local-test-only
  required_smoke:
    - authenticated web/control flows available locally
    - local persistence across runtime restart
    - modern MCP profile
    - compatibility MCP profile when its adapter or routing changed
    - every changed product surface available without hosted infrastructure

uat:
  configured: true
  target_class: openai-sites
  provider: openai-sites
  url: https://mind-diary.example.invalid
  deployment_source: apps/mind-diary-site
  deploy_action: publish exact candidate through OpenAI Sites hosting
  audience: single-principal owner plus explicit test principals
  data_class: isolated-uat
  deploy_authority: ship-work-release
  rollback_action: republish previous stable exact Sites deployment/version
  required_evidence:
    - exact Git SHA and exact-SHA CI
    - Sites project, version and deployment identifiers
    - authenticated web/control smoke
    - persistence after redeploy
    - modern MCP 2026-07-28 on /api/mcp
    - compatibility MCP 2025-11-25 on /api/mcp/2025-11-25 when applicable
    - changed-surface live smoke
    - previous stable deployment and rollback action

production:
  configured: false
  target_class: unassigned
  url: null
  promotion_runbook: null
  deploy_authority: manual-only
  ship_work_release_deploy_allowed: false
  promotion_requires:
    - explicit user prompt
    - separate confirmation immediately before the external effect
    - scope UAT acceptance
    - exact artifact identity without rebuild drift
    - production target and rollback plan
~~~

## Task management

Mind Diary выбирает adapter `linear`, collection `Mind Diary` и selector
`current_project_milestone`. Разрешение scope, status mapping, dependency
relations, pagination и remote updates задаёт
[Linear adapter specification](../specs/ship-work-release-linear.md); универсальный
delivery contract этих деталей не содержит.

Другой task-management backend подключается заменой `adapter`, его reference,
adapter specification и collection/scope selector. Lanes, pause, batches,
cohorts и dev/UAT/production semantics при этом не меняются.

## Environment boundaries

- `dev` использует только local/test data и не получает UAT или production
  secrets.
- `UAT` — текущий prod-like OpenAI Site без живых production users.
- `production` является отдельной environment. Пока
  `production.configured=false`, production release невозможен.
- Данные, secrets, external-effect journal и rollback chain не смешиваются
  между environments.
- Обычный release этого проекта означает UAT release. Слова `production`,
  `prod`, «прод» и «продакшн» требуют отдельного manual workflow и никогда не
  являются alias UAT.

## Dev readiness

`npm run dev` поднимает exact candidate на `localhost`, печатает точный URL и
использует изолированные adapters/data. Coordinator дожидается readiness,
выполняет declared smoke и сохраняет URL, configuration fingerprint и
результаты в batch receipt.

## UAT evidence

Каждый UAT cut связывает exact Git SHA, GitHub Actions result, Sites
project/version/deployment, live URL, dev receipt и declared live flows.
Single-principal smoke не доказывает invitations, role transfer,
`public`/`unlisted` access или другие multi-principal сценарии. Для такого
acceptance используются explicit test principals и отдельные redacted
artifacts.

Текущий Site классифицируется только как UAT. Исторические reports, где он
назывался production, сохраняют исходный текст, но не меняют current
environment authority.

## Production handoff

`ship-work-release` заканчивает work scope exact production-eligible candidate
и UAT evidence, но не выполняет production deployment. Перед настройкой
production в этом profile должны появиться target class, exact identifier/URL,
data and secret boundaries, promotion command or workflow, required evidence и
rollback procedure.
