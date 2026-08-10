# План запуска MVP 0.1 и сверки token estimate

Статус: planned, запуск ещё не начат.

Authoritative scope и lifecycle принадлежат Linear milestone `0.1`:
`AND-150`–`AND-161`. Этот документ не дублирует task status; он фиксирует
execution profile, две конкурирующие оценки и способ измерить фактический
расход после запуска `ship-linear-release`.

## Что сравниваем

Базовый профиль `codex-estimator`:

- GPT-5.6 Sol;
- Extra High (`xhigh`);
- один primary agent;
- без subagents;
- total model tokens primary agent;
- active agent time отдельно от external и user wait.

`workers=1` либо отсутствие параметра `workers` — default cost-efficient
profile этого плана. Только его мы оцениваем и калибруем. Более быстрые
multi-worker варианты меняют время на дополнительный token spend и не входят
в estimate без отдельного запроса пользователя. Если фактический запуск всё же
использует `workers=N`, где `N > 1`, это другая observation: coordinator и
каждый worker измеряются отдельно, а all-agent total не обновляет single-agent
calibration factor.

## Estimates до запуска

| Forecast | Time P50 / P90 | Tokens P50 / P90 | Статус |
| --- | ---: | ---: | --- |
| Fresh compact context на каждую issue | 5h / 9h active | 2.2M / 4.5M | исходная ошибочная model baseline; сохранена для variance comparison |
| Один непрерывный `workers=1` release-skill run | 5h / 9h active | 100M / 250M | текущий независимый model estimate; partly calibrated |
| Мнение пользователя | — | «скорее сотни миллионов» | отдельная competing hypothesis; не correction factor и не model override |
| Фактический запуск | unknown | unknown | заполняется только из authoritative runtime counters |

Предыдущая сравнимая heavy-thread observation в MindDiary заняла `23m33s` и
израсходовала `13,272,726` primary-agent tokens за 83 runtime token-count
rounds. Её token ratio к прежней fresh estimate равен `29.49`. Одной
observation недостаточно для calibrated factor, но она подтверждает, что
длинный active context может поднять расход на один-два порядка.

Текущий model estimate не заимствует пользовательскую ставку. Для P50 он
использует около 600 primary-agent rounds со средней total load порядка
150k tokens и bounded context growth. Для P90 — до 1000 rounds, более тяжёлый
средний context и дополнительные fix/release loops. После округления это даёт
`100M / 250M`. Независимое мнение пользователя сохраняется рядом без
искусственного назначения ему P50/P90.

## Planning allocation по issue

Распределение ниже суммарно даёт `100M / 250M`. Оно пропорционально прежним
fresh-context весам и нужно для промежуточных checkpoints; это не независимая
калибровка каждой карточки.

| Issue | Time P50 / P90 active | Tokens P50 / P90 total |
| --- | ---: | ---: |
| `AND-150` | 20m / 45m | 7M / 16M |
| `AND-151` | 30m / 1h15m | 10M / 22M |
| `AND-152` | 25m / 1h | 8M / 20M |
| `AND-153` | 20m / 45m | 7M / 16M |
| `AND-154` | 30m / 1h15m | 10M / 27M |
| `AND-155` | 20m / 45m | 6M / 13M |
| `AND-156` | 30m / 1h30m | 11M / 31M |
| `AND-157` | 30m / 1h15m | 10M / 27M |
| `AND-158` | 30m / 1h30m | 11M / 31M |
| `AND-159` | 20m / 50m | 6M / 13M |
| `AND-160` | 10m / 25m | 2M / 6M |
| `AND-161` | 35m / 1h30m | 12M / 28M |

Aggregate P90 не является суммой вероятностей отдельных issue. В таблице это
bounded allocation общего P90 budget, чтобы не выдать сумму всех локальных
worst cases за project-level percentile.

## Measurement protocol

### До первого write

1. Сохранить exact invocation, `workers`, UTC start, current `main` SHA,
   Linear project/milestone IDs и идентификатор primary rollout.
2. Убедиться, что checkout clean и `main` соответствует ожидаемому remote.
3. Только когда execution действительно начался, создать pending observation
   `20260810-mvp01-pilot-ready` в `codex-estimator` calibration store.
4. Не переносить в actual usage transcript size, приблизительный context size
   или quota percentage.

### Во время run

1. Снимать cumulative runtime `token_count` после каждого интегрированного
   issue и каждого UAT batch.
2. Отдельно записывать active agent time, CI/Sites wait и user wait.
3. После первого meaningful checkpoint (`AND-150` focused browser tests)
   пересчитать remaining P50/P90, не меняя исходные baselines задним числом.
4. При compaction или смене rollout сохранить boundary counter, чтобы не
   потерять и не задвоить delta.

### После terminal outcome

1. Взять actual primary-agent total из runtime usage либо вычислить delta
   официальным `codex-estimator/scripts/token_usage.py` по однозначно
   определённому rollout и UTC interval.
2. Если запуск использовал workers, сохранить per-agent totals и all-agent
   sum отдельно; такой run не обновляет single-agent factor без нормализации.
3. Зафиксировать actual wall-clock, external wait, user wait, outcome и причину
   существенного variance.
4. Сравнить actual с model baselines: `actual / 2.2M` для исходной ошибки и
   `actual / 100M` для текущего P50 token forecast. Отдельно отметить,
   подтверждает ли result пользовательскую гипотезу «сотни миллионов», не
   превращая её задним числом в числовой percentile.
5. Обновить Linear estimates, этот план и calibration store отдельным
   follow-up commit; не называть factor calibrated до трёх сопоставимых
   completed observations.

## Done criteria сверки

- actual token total получен из authoritative counter либо честно указан как
  `unknown`;
- execution profile и worker topology записаны;
- active, external и user clocks не смешаны;
- исходная model baseline, текущий model estimate и независимое мнение
  пользователя сохранены раздельно;
- variance и следующий correction decision зафиксированы без ретроспективного
  переписывания прогноза.
