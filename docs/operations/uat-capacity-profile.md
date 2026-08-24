# Restricted-UAT capacity profile и quota evidence

Статус: accepted restricted-UAT procedure для `MD-289`, 2026-08-24.
Runbook включает фиксированный deployment profile
`restricted-uat-v1`, чтобы на изолированном временном Mind получить hosted
evidence веток warning/soft/hard без большого corpus. Это не production
configuration, не способ поднять quota и не operator bypass.

## Граница и неизменяемые условия

Профиль выбирается только Worker environment:

```text
MIND_DIARY_DEPLOYMENT_POSTURE=restricted-uat
MIND_DIARY_CAPACITY_PROFILE=restricted-uat-v1
MIND_DIARY_RELEASE_CANDIDATE_SHA=<exact-40-char-sha>
MIND_DIARY_CAPACITY_FENCE_NONCE=<22-64-char-non-secret-random>
```

Одновременно `MIND_DIARY_SERVICE_OPERATOR_PRINCIPAL_IDS` должен содержать
непустой bounded allowlist. Declared candidate и новый non-secret random nonce
записываются в trusted runtime binding до deployment, а не в request.
Отсутствующая, malformed, неизвестная или production posture, неизвестный
profile ID, пустой allowlist и неполный configuration fence делают runtime
unavailable при создании composition. Query, request body, header, role, UI и
diagnostic API не могут выбрать или изменить profile либо fence.

`restricted-uat-v1` меняет только
`mindPhysicalCanonicalBytes`: `2 GiB -> 8 MiB`. Остальные восемь limits
совпадают с `DEFAULT_CAPACITY_LIMITS`. Поэтому профиль локализует quota canary
в одном временном Mind и не уменьшает Site D1/temporary budgets или fairness
для соседних release flows. Production и runtime без restricted-UAT posture
продолжают использовать точные defaults. В restricted-UAT posture отсутствие
selector означает read-only `default-v1`: limits остаются compiled defaults,
но operator может получить terminal restore receipt.

Operator readback существует только в valid restricted-UAT posture:

```text
GET /api/v1/internal/operators/capacity
```

Endpoint доступен только Sites-authenticated principal из constructor
allowlist, принимает ноль query fields и возвращает closed schema
`mind-diary/operator-capacity-diagnostics`, version `1`: exact profile/limits,
aggregate usage/headroom, storage amplification, quota reject count,
active/expired/cleanup-pending/stale reservation counts and bytes, utilization
и UTC timestamps. Configuration fence представлен только domain-separated
SHA-256 binding declared candidate/non-secret nonce; raw nonce/provider ID в
diagnostics нет. Это защита от запроса к runtime с другой конфигурацией, а не
attestation Git artifact, Sites version или deployment. Успешное чтение
создаёт durable audit event
`service_operator.capacity_diagnostics_read` с opaque actor/request,
operation/time и без capacity values. Endpoint не возвращает corpus, paths,
object/provider IDs, Mind/principal IDs, email, URL или secrets и не имеет
mutation/reconcile/cleanup operations. У non-operator,
registration-required или anonymous actor endpoint неотличим от отсутствующего
route (`404`). В production/runtime без restricted-UAT posture он также
возвращает `404`.

## Предусловия

1. Coordinator фиксирует exact 40-character Git SHA, source archive hash,
   Sites version, deployment ID, environment revision и rollback deployment.
   `save/get version` обязаны подтвердить candidate + archive hash, а
   `deploy/get status` — тот же version/deployment и `succeeded`. Production
   исключён.
2. Custom audience и operator allowlist прочитаны до изменения; неожиданных
   users/groups/viewers нет.
3. Operator Sites session передаётся runner-у только через
   `MIND_DIARY_UAT_OPERATOR_SITES_TOKEN`. Значение не является CLI argument и
   не попадает в shell transcript/evidence.
4. Для quota operations создаётся отдельный временный private ordinary Mind.
   Его исходный HEAD и safe opaque run mapping хранятся вне repository.
5. На время provider read-back и immediate HTTP probe действует deploy fence:
   никакой параллельный deployment не может сменить mutable Site URL. Если
   такую гонку исключить нельзя, evidence fail-closed.
6. Stateful import/storage driver из `MD-288` или эквивалентный accepted
   product flow сохраняет exact response code и unchanged/changed HEAD; этот
   runbook не добавляет test-only product endpoint.

## Активация и exact readback

Сохраните pre-run env/access/deployment revisions. До build/deploy создайте
новый non-secret random fence nonce и установите posture/profile, declared
candidate SHA, nonce и operator allowlist. Создайте UAT deployment exact
candidate. Сверьте Sites version/deployment/archive control-plane receipts,
зафиксируйте отсутствие параллельного deploy и немедленно запустите:

```sh
npm run uat:capacity-profile -- \
  --candidate-sha <exact-40-char-sha> \
  --configuration-fence-nonce <same-non-secret-nonce> \
  --expected-utilization normal \
  --evidence-out <private-temp-path>/capacity-profile-baseline.json
```

Runner проверяет exact profile/limits, closed response schema, обязательный
`400 invalid_request` для `?profile=default` и равенство собственного
domain-separated digest CLI values серверному configuration fence. Поэтому
nonce/query от другой runtime configuration не проходит. Receipt записывается
mode `0600`, содержит declared candidate, configuration-fence digest, явный
`runtime_configuration_fence_not_attestation`, safe aggregate numbers, fixed
assertion IDs и content hash. Сам по себе этот receipt не доказывает candidate,
Sites version/deployment или archive; terminal release evidence получается
только после join с fenced provider receipts и immediate-probe ordering. Raw
response, credential, Site URL и identities в receipt не попадают.

## Warning, soft и hard matrix

Порог считается от фактического `physical_canonical_bytes` временного Mind,
а не от размера входного payload. Для 8 MiB profile ориентиры:

- warning начинается с `70%` (`5,872,026` bytes);
- bulk soft rejection начинается при projected utilization `>=85%`
  (`7,130,317` bytes), пока projection не превышает hard limit;
- hard rejection начинается при projected utilization `>=100%`; fixture
  должна заполнить remaining headroom либо превысить его.

Последовательность:

1. Прочитайте Owner capacity projection временного Mind и exact HEAD.
2. Stateful driver коммитит private fixture до Owner utilization `warning`.
   Повторный read должен показать trustworthy usage и тот же exact profile
   limit; operator snapshot остаётся aggregate Site view и не заменяет
   Mind-level proof.
3. Запустите bulk import/stage с projection в soft interval. Требуйте exact
   semantic `capacity_soft_limit`, неизменный HEAD и отсутствие частично
   видимой revision. Operator `quota_rejects` должен монотонно увеличиться.
4. Новым idempotency namespace запустите projection выше hard limit. Требуйте
   `capacity_hard_limit`, неизменный HEAD и ещё одно увеличение reject count.
5. Re-read exact import/staging state: rejected operation не должна оставлять
   active product session или bytes. Reservation aggregates должны объяснять
   active, expired-active, cleanup-pending и stale count/bytes без identifiers;
   stale values должны быть нулевыми либо иметь отдельный lifecycle explanation
   из owning recovery task.
6. Сохраните новый receipt, связав minimum reject count с тем же configuration
   fence:

```sh
npm run uat:capacity-profile -- \
  --candidate-sha <same-exact-sha> \
  --configuration-fence-nonce <same-non-secret-nonce> \
  --min-quota-rejects <observed-monotonic-count> \
  --evidence-out <private-temp-path>/capacity-profile-after-rejects.json
```

HTTP `200` без проверки application code не является evidence. Soft/hard
подтверждаются exact product response и HEAD read-back; aggregate counter сам
по себе не классифицирует причину rejection.

## Cleanup, restore и fail-closed readback

1. Удалите только canary-owned temporary Mind обычным accepted product flow.
2. Дождитесь штатного bounded cleanup/reconcile owning lifecycle; не вызывайте
   несуществующий diagnostic mutation и не сканируйте R2 globally.
3. Подтвердите отсутствие canary-visible resources, неизменность чужих Minds и
   допустимое stale-reservation состояние.
4. Удалите только `MIND_DIARY_CAPACITY_PROFILE`, сохранив restricted posture и
   allowlist, но заменив fence nonce новым non-secret random value; создайте
   новый deployment того же accepted candidate и повторите fenced provider
   version/deployment/archive read-back.
5. Получите terminal default receipt:

```sh
npm run uat:capacity-profile -- \
  --candidate-sha <same-exact-sha> \
  --configuration-fence-nonce <new-default-nonce> \
  --expected-profile default-v1 \
  --evidence-out <private-temp-path>/capacity-profile-restored-default.json
```

   Receipt обязан показать `default-v1` и все exact
   `DEFAULT_CAPACITY_LIMITS`. Затем восстановите сохранённую posture/env
   revision, удалив restricted-only configuration-fence bindings, и создайте финальный UAT
   deployment; endpoint снова обязан вернуть exact `404`.
6. Если env restore, cleanup, default receipt или aggregate provider lineage не
   подтверждены, matrix остаётся nonterminal. Rollback выполняется на
   сохранённый exact deployment; профиль нельзя переносить в production.

Evidence хранит только closed receipts и bounded classifications. Удалите
временные credential/state files recoverable способом после content-addressed
handoff. Никогда не сохраняйте raw environment, authorization header, email,
provider object IDs вне required control-plane lineage receipt, signed URL,
file path или corpus bytes.
