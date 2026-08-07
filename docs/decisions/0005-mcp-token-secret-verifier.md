# ADR-0005: secret и verifier личного MCP token

Статус: accepted, 2026-08-06.

## Контекст

Первый прототип использует revocable principal-scoped bearer tokens на каждом
MCP request. Нужно выбрать format, indexed lookup и cryptographic verifier так,
чтобы server не сохранял recoverable secret, retry не раскрывал старый secret,
а verifier не создавал избыточную per-request latency и online DoS
amplification.

Password hashing guidance рассчитан прежде всего на низкоэнтропийные
пользовательские пароли. Здесь secret генерирует server CSPRNG и содержит ровно
256 random bits; атакующий не выбирает и не запоминает его как пароль.

## Threat analysis

| Threat | Boundary и мера |
|---|---|
| Read-only dump token table | В record нет plain secret или unkeyed digest: exact lookup использует HMAC-SHA-256 под отдельным deployment key минимум 256 bits. Safe display prefix оставляет не менее 220 неизвестных random bits. |
| Утечка verifier key вместе с table | 256-bit random secret всё равно не перебирается practically; key compromise требует rotation/reissue и incident response. HMAC не заменяет secret-store isolation. |
| Online guessing и verifier DoS | Exact 50-character grammar отклоняется до storage. Canonical input требует одну HMAC и один indexed lookup; route получает отдельный rate limit. |
| Timing oracle | Вычисленный и persisted verifier сравниваются как fixed 32-byte arrays без data-dependent exit. Unknown/denied lookup проходит comparison с dummy bytes и возвращает generic invalid. Format и external storage latency не обещаются полностью constant-time. |
| Collision или prefix scan | Lookup идёт по full 256-bit HMAC с unique index, никогда по display prefix; scan/collision bucket отсутствует. |
| Secret в list/log/error/trace | Secret доступен только через consume-once issuance boundary. Public serialization содержит safe prefix; list, retry, errors, logs, traces и metrics исключают secret, verifier и HMAC key. |
| Retry и concurrent issuance | Повтор не восстанавливает старый secret. Новый record получает independently generated secret; unique verifier constraint разрешает невероятную collision race fail-closed. |
| Bearer disclosure у клиента или в runtime | HMAC storage policy не помогает уже украденному bearer. Нужны TLS, `bearer_token_env_var`, 90-day maximum expiry, revocation и запрет logging. |

## Решение

- Canonical token: `mdp_v1_` + 43 unpadded base64url characters, которые
  декодируются ровно в 32 CSPRNG bytes. Других valid forms в MVP нет.
- Persisted material: `display_prefix`, scopes/lifecycle metadata и
  `hmac-sha256:v1:<64 lowercase hex>`; plain/recoverable secret отсутствует.
- HMAC message domain-separated строкой `mind-diary:mcp-token:v1\0` и включает
  весь canonical token. HMAC key не экспортируется и хранится вне token table.
- Full versioned verifier — unique indexed lookup key. После lookup adapter
  выполняет fixed-length comparison; malformed persisted value fail-closed.
- Default и maximum lifetime — 90 дней от server-assigned issuance time.
- `mdp_v1` привязан к verifier key version 1. Плановая rotation вводит новый
  token/verifier version и bounded dual-read window; emergency rotation
  отзывает/reissues affected tokens. Silent reinterpretation v1 запрещена.
- PBKDF2/scrypt/Argon2 не применяются: для 256-bit random secret они практически
  не усиливают offline protection, но добавляют predictable CPU cost каждому
  MCP request. Если future tokens станут user-chosen/low-entropy, решение
  обязательно пересматривается.

## Воспроизводимый latency benchmark

Команда после build:

```bash
node scripts/benchmark-token-verifier.mjs
```

Script выполняет warm-up, 1000 samples реального HMAC verify path с in-memory
exact lookup и по 12 samples PBKDF2-SHA256. Он печатает параметры runtime и
percentiles JSON, но не token/verifier. Наблюдение 2026-08-06 на Node v26.7.0,
macOS arm64, Apple M1 Pro:

| Variant | p50 | p95 |
|---|---:|---:|
| HMAC-SHA-256, found exact lookup | 0.021 ms | 0.049 ms |
| HMAC-SHA-256, unknown exact lookup | 0.017 ms | 0.037 ms |
| PBKDF2-SHA256, 100k iterations | 12.065 ms | 12.337 ms |
| PBKDF2-SHA256, 310k iterations | 36.943 ms | 37.790 ms |

Это synthetic local crypto measurement без storage/network latency и не SLO.
Абсолютные числа зависят от runtime/hardware; существенна воспроизводимая
разница в несколько порядков и отсутствие security benefit slow KDF для
server-generated 256-bit secret.

## Последствия

- Token table compromise отдельно от deployment key не даёт reusable bearer и
  не позволяет проверять guesses unkeyed hash-ом.
- HMAC key становится security-critical deployment secret с отдельными access,
  rotation и backup controls; его нельзя логировать или хранить в token rows.
- Public token list и issuance serialization могут безопасно показывать только
  `display_prefix` и lifecycle metadata. Internal persistence object содержит
  verifier, поэтому он также запрещён в logs/traces/errors.
- Constant-time policy ограничена cryptographic compare; она не обещает скрыть
  malformed parsing, database/cache latency или network jitter.
- Lifecycle/scopes остаются отдельной authorization policy: cryptographic match
  сам по себе не даёт control-plane capability и не отменяет current ACL check.

## Отклонённые варианты

- **Unkeyed SHA-256 полного token.** Энтропии достаточно против brute force, но
  keyed verifier дешевле добавляет separation между database dump и verifier
  capability.
- **PBKDF2/scrypt/Argon2 каждого request.** Подходит low-entropy passwords, но
  здесь расходует CPU и усиливает unauthenticated DoS без практического
  улучшения 256-bit random secret.
- **Public selector + slow hash отдельного secret.** Даёт bounded lookup, но
  добавляет отдельный enumeration identifier и сохраняет per-request KDF cost;
  full keyed verifier уже является exact lookup key.
- **Lookup по короткому display prefix.** Требует collision buckets/scans и
  превращает UI hint в security-sensitive material.

Wire contract находится в [API specification](../specs/api.md), component
boundary — в [architecture](../architecture.md).
