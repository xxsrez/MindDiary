# Restricted-UAT test account pool

Статус: operational preparation contract для MD-282. Checked-in template и
validator реализованы; внешние accounts, first login/MFA, Sites custom audience
и service-operator allowlist этим документом не создаются и не изменяются.
Passing repository tests не являются evidence, что pool provisioned.

Цель — держать три независимых real Sites actors для повторяемых hosted UAT
canaries, не сохраняя identity, credentials или session references в Git,
Task Manager, terminal transcript и release evidence. Любой
`pending-owner-action`, неполный read-back или расхождение блокирует `ready`
receipt.

## Logical actors

| Alias | Lifecycle | Stable baseline | Разрешённая роль в canary |
|---|---|---|---|
| `UAT-OPERATOR` | persistent restricted UAT | custom-audience member, service operator, без ordinary Mind membership | только read-only operator surface |
| `UAT-MIND-ROLE` | persistent restricted UAT | custom-audience member, non-operator, без ordinary Mind membership | временный `editor`, затем role cleanup |
| `UAT-ORDINARY` | persistent restricted UAT | custom-audience member, non-operator, без ordinary Mind membership | ordinary negative/UI/API actor |
| `UAT-DISPOSABLE` | optional, ephemeral и только после отдельного owner approval | отсутствует | account/deletion/recovery drill; никогда не operator |

Aliases не являются product identities. Mapping alias → external account
остаётся у access owner в trusted secret channel. `actor_fingerprint` —
независимое случайное `actor-<16..64 lowercase alnum>`, а не hash, encoding или
производное от email, account ID, principal ID либо session.

## Owner authority

Только owner соответствующей внешней surface выполняет и подтверждает:

1. provision/reuse трёх отдельных external accounts;
2. самостоятельный first login и MFA каждого actor, когда MFA требуется;
3. exact custom-audience membership restricted UAT Site;
4. exact service-operator allowlist, содержащий только `UAT-OPERATOR` из этого
   pool;
5. выдачу short-lived session references через owner-controlled environment
   для конкретного canary run.

Delivery instruction не заменяет эту owner authority. Automation не создаёт
accounts, не проходит MFA, не угадывает identity, не расширяет audience и не
меняет operator allowlist. Production, группы, public access и постоянные
personal MCP tokens находятся вне этого runbook.

## Machine-readable inventory

Canonical pending template:

```text
tests/fixtures/uat-test-account-pool/pending-inventory.json
```

Machine contract:

```text
scripts/lib/uat-test-account-pool-contract.mjs
```

Owner копирует template во временный private path вне repository и меняет
только закрытые enum states и opaque fingerprints. Identity/session mapping и
credentials в inventory не добавляются. Contract отвергает лишние fields,
email-like values, URLs, token/authorization markers, internal IDs, неверные
actor profiles и повторяющиеся fingerprints.

Пример локальной structural/readiness проверки без печати inventory:

```sh
MIND_DIARY_UAT_POOL_INVENTORY=/private/owner-path/pool-inventory.json \
node --input-type=module <<'NODE'
import { readFile } from "node:fs/promises";
import { assessUatTestAccountPoolReadiness } from "./scripts/lib/uat-test-account-pool-contract.mjs";

const inventory = JSON.parse(await readFile(
  process.env.MIND_DIARY_UAT_POOL_INVENTORY,
  "utf8",
));
const assessment = assessUatTestAccountPoolReadiness(inventory);
console.log(JSON.stringify(assessment));
if (assessment.status !== "ready") process.exitCode = 1;
NODE
```

Команда выводит только `ready|blocked` и blocker codes. Она не доказывает
внешнее состояние: owner обязан получить свежий exact custom-audience read-back,
operator-allowlist read-back и distinct-principal observation через три
independent sessions, затем записать только classification в private inventory.

`createUatTestAccountPoolReadinessReceipt(...)` создаёт deterministic
classification-only receipt с logical aliases, random actor fingerprints,
actor counts, UTC observation и artifact hash. Receipt не содержит mapping,
account/principal IDs, email, sessions, credentials, token IDs или content.

## Provisioning and read-back sequence

1. Owner provision/reuses each mandatory account and completes independent
   first login/MFA. Shared browser identity или одна session для нескольких
   aliases не допускаются.
2. Owner устанавливает custom audience ровно в согласованный restricted-UAT
   baseline. Exact custom-audience read-back обязан показать три distinct
   actors либо четыре при separately approved `UAT-DISPOSABLE`.
3. Owner устанавливает operator allowlist и подтверждает exact read-back:
   `UAT-OPERATOR` allowed, все остальные pool actors denied.
4. Каждый actor открывает authenticated Product Site session. Product-owned
   observations должны подтвердить distinct principals без сохранения их IDs.
5. Перед canary подтверждается baseline: нет временных ordinary Mind roles и
   нет оставшихся per-run MCP tokens.
6. Только после всех owner-confirmed states и exact read-backs contract может
   выпустить `ready` receipt. `mismatch`, `not-run`, missing fingerprint или
   любой `pending-owner-action` fail closed.

## Per-run token and role policy

- Session references и MCP token secrets поступают только через environment в
  конкретный runner process; их нельзя передавать CLI arguments или сохранять
  в inventory/receipt.
- Existing personal MCP token использовать нельзя. Нужен отдельный named
  short-lived per-run token с минимальным scope.
- `UAT-MIND-ROLE` получает временную ordinary Mind role только на время exact
  canary. Operator authority не создаёт implicit Mind access.
- `UAT-ORDINARY` остаётся nonoperator/nonmember для negative checks.
- Evidence observer сохраняет только actor class/fingerprint, assertion status
  и safe error code; response bodies, identity и credentials не сохраняются.

## Cleanup

Успешный и неуспешный run завершаются одинаковым bounded cleanup:

1. revoke все созданные per-run MCP tokens и проверить denial следующего
   request;
2. удалить временные invitations/memberships/test Mind data по contract canary;
3. вернуть ordinary Mind role `UAT-MIND-ROLE` к stable baseline `none`;
4. восстановить exact custom audience до pool baseline и exact operator
   allowlist до единственного operator actor;
5. выполнить independent read-back и negative session check;
6. не удалять persistent pool accounts; optional disposable account удаляет
   только owner в отдельно подтверждённом deletion drill.

Cleanup evidence фиксирует только closed assertion status и opaque
fingerprints. Нельзя сохранять forensic account identifiers или token IDs.

## Interrupted-run recovery

При interruption или mismatch runner прекращает новые writes и помечает run
`recovery-required`. Recovery выполняется в таком порядке:

1. revoke known per-run tokens в памяти runner; если reference утрачен, owner
   отзывает все named tokens этого run через trusted control surface;
2. удалить временные roles/invitations и bounded fixture data;
3. owner восстанавливает exact audience и operator allowlist baseline;
4. повторить three-session distinctness, nonoperator denial и token denial;
5. новый `ready` receipt допустим только после fresh exact read-back.

Если account provisioning, first login/MFA, audience или allowlist невозможно
завершить без новой identity/policy authority, это внешний blocker MD-282, а не
repository или product failure. Возобновление требует explicit owner action;
automation не расширяет authority и не ослабляет acceptance.
