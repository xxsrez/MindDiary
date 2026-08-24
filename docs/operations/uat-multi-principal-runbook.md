# Multi-principal Sites canary

Статус: accepted informational operational procedure для restricted Mind
Diary UAT. С 2026-08-20 blocking P9 перенесён в
[synthetic multi-principal gate](synthetic-multi-principal-runbook.md) по
[ADR-0012](../decisions/0012-synthetic-principal-release-gates.md).

Этот runbook исполняет capability `mind-diary/uat-multi-principal-smoke/v1`
как `P9-Sites-Canary` для MD-158 и финального MD-161. Отсутствие human session
или failure этого canary не блокирует release 0.1, но до passing observation
нельзя утверждать, что real two-account Sites behavior проверено на candidate.
Runbook не разрешает добавлять audience сам по себе: второй Sites principal
должен быть заранее явно назван и авторизован владельцем. Shared browser,
machine credential, придуманная identity и production audience запрещены.

## Предусловия

1. Coordinator фиксирует exact candidate SHA, текущий Sites deployment и
   rollback deployment.
2. Sites access остаётся `custom`; Owner добавляет ровно explicit test
   principal как viewer. Группы, public access и external visitors не
   добавляются без отдельного решения.
3. Оба principals самостоятельно входят в Sites. Для automation каждый
   предоставляет отдельную short-lived Sites session reference. Secret
   передаётся только через локальный secret channel и environment, не через
   shell history, repository, Task Manager или evidence.
4. Каждый principal создаёт отдельный named read-only MCP token специально для
   probe. Secret и opaque token ID передаются через environment; после проверки
   probe отзывает оба token. Existing personal token использовать нельзя.
5. Coordinator создаёт два случайных, необратимых fingerprint вида
   `pilot-<16..64 lowercase alnum>`. Mapping с identity остаётся только у
   feedback owner в trusted channel.

Обязательные environment references:

```text
MIND_DIARY_UAT_OWNER_SITES_TOKEN
MIND_DIARY_UAT_PARTICIPANT_SITES_TOKEN
MIND_DIARY_UAT_PARTICIPANT_EMAIL
MIND_DIARY_UAT_OWNER_MCP_TOKEN
MIND_DIARY_UAT_PARTICIPANT_MCP_TOKEN
MIND_DIARY_UAT_OWNER_MCP_TOKEN_ID
MIND_DIARY_UAT_PARTICIPANT_MCP_TOKEN_ID
```

Их значения не передаются как CLI arguments. Terminal transcript с exported
values не является release evidence.

## Phase A: setup

На deployment A coordinator запускает:

```sh
npm run uat:multi-principal -- \
  --phase setup \
  --candidate-sha <exact-40-char-sha> \
  --deployment-id <deployment-a> \
  --owner-fingerprint <pilot-random> \
  --participant-fingerprint <pilot-random> \
  --state-out <private-temp-path>/multi-principal-state.json
```

Probe атомарно проверяет или создаёт isolated account обоих principals,
сравнивает server-owned `principal_id` и Personal Mind только в памяти,
проверяет token-to-account binding, alternating session isolation, private
non-enumeration, public и exact-unlisted baseline без membership, немедленный
возврат baseline в private, invite/accept Reader, смену на Editor и atomic
ownership transfer с одним Owner.

State содержит только exact candidate/deployment, случайный run nonce,
ephemeral Mind handle и transient `actor_fingerprints`. PII, service principal
IDs, credentials и content в него не записываются. Успех setup возвращает
`awaiting_redeploy`.

## Redeploy boundary

Coordinator выполняет обычный exact-artifact gate и private Sites deploy того
же candidate SHA. Deployment B обязан отличаться от deployment A. Замена SHA,
пересборка из другого source state или только browser reload не доказывают
persistence-after-redeploy.

## Phase B: verify, revoke и cleanup

С теми же локальными secret references:

```sh
npm run uat:multi-principal -- \
  --phase verify \
  --deployment-id <deployment-b> \
  --state <private-temp-path>/multi-principal-state.json \
  --evidence-out <private-temp-path>/multi-principal-evidence.json
```

Probe подтверждает после redeploy разные accounts/Personal Minds, durable
Admin/Owner state, Web и modern MCP access. Затем новый Owner отзывает прежнюю
Admin membership; следующий Web request получает private non-enumerating 404,
`list_minds` больше не видит Mind, а `list_revisions` не раскрывает history.
После доказательства probe удаляет ephemeral ordinary Mind, отзывает оба
dedicated MCP token и проверяет `401` для обоих secret.

Passing artifact имеет schema `mind-diary/multi-principal-evidence/v1`, exact
candidate/deployment, actor class, `actor_fingerprints` array из двух distinct
opaque values в stable Owner/Participant order, bounded assertion IDs и content
hash. Array не содержит alias/email/internal ID и не кодирует их. Artifact не
содержит email, `principal_id`, `space_id`, token ID,
credentials, cookies, private content или response bodies.

Эта historical/live schema не переименовывается в
`mind-diary/synthetic-multi-principal-evidence/v1` и не удовлетворяет blocking
synthetic row: carriers проверяют разные boundaries.

## Recovery и emergency revoke

Если setup/verify оборвался, не повторяйте mutation с новым nonce. Сначала:

```sh
npm run uat:multi-principal -- \
  --phase cleanup \
  --state <private-temp-path>/multi-principal-state.json
```

Cleanup находит current Owner server-side, удаляет только Mind с сохранённым
ephemeral handle и отзывает dedicated token IDs из environment. После этого
Owner удаляет test principal из Sites audience и проверяет access policy:
`custom`, только ожидаемые explicitly allowed users, ноль groups и ноль
unexpected external visitors. При потерянной второй session reference Owner
немедленно удаляет principal из Sites audience, отзывает его membership из UI
и применяет emergency revoke из
[privacy-safe UAT operations](uat-pilot-operations.md#emergency-revoke).

State/evidence хранятся вне repository и после внесения content-addressed
receipt удаляются recoverable способом. Фактический email-to-fingerprint
mapping и secret values не архивируются.
