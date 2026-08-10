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

Для чистой сверки запуск должен использовать `workers=1` либо не указывать
`workers`. Запуск с `workers=N`, где `N > 1`, является другим execution
profile: coordinator и каждый worker измеряются отдельно, а all-agent total не
используется для обновления single-agent calibration factor.

## Estimates до запуска

| Forecast | Time P50 / P90 | Tokens P50 / P90 | Статус |
| --- | ---: | ---: | --- |
| Fresh compact context на каждую issue | 5h / 9h active | 2.2M / 4.5M | исходная model baseline; недостаточно учитывает повторное чтение растущего coordinator context |
| Один непрерывный release-skill run | 5h / 9h active | 100M / 300M | provisional user override для проверки; не является статистически calibrated |
| Фактический запуск | unknown | unknown | заполняется только из authoritative runtime counters |

Предыдущая сравнимая heavy-thread observation в MindDiary заняла `23m33s` и
израсходовала `13,272,726` primary-agent tokens за 83 runtime token-count
rounds. Её token ratio к прежней fresh estimate равен `29.49`. Одной
observation недостаточно для calibrated factor, но она подтверждает, что
длинный active context может поднять расход на один-два порядка. Поэтому для
предстоящего непрерывного run принята проверяемая гипотеза `100M / 300M`, а
низкая baseline не удаляется.

## Planning allocation по issue

Распределение ниже суммарно даёт `100M / 300M`. Оно пропорционально прежним
fresh-context весам и нужно для промежуточных checkpoints; это не независимая
калибровка каждой карточки.

| Issue | Time P50 / P90 active | Tokens P50 / P90 total |
| --- | ---: | ---: |
| `AND-150` | 20m / 45m | 7M / 19M |
| `AND-151` | 30m / 1h15m | 10M / 26M |
| `AND-152` | 25m / 1h | 8M / 24M |
| `AND-153` | 20m / 45m | 7M / 19M |
| `AND-154` | 30m / 1h15m | 10M / 32M |
| `AND-155` | 20m / 45m | 6M / 16M |
| `AND-156` | 30m / 1h30m | 11M / 37M |
| `AND-157` | 30m / 1h15m | 10M / 32M |
| `AND-158` | 30m / 1h30m | 11M / 37M |
| `AND-159` | 20m / 50m | 6M / 16M |
| `AND-160` | 10m / 25m | 2M / 7M |
| `AND-161` | 35m / 1h30m | 12M / 35M |

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
4. Сравнить actual с обеими baselines:
   `actual / 2.2M` и `actual / 100M` для P50 token forecast.
5. Обновить Linear estimates, этот план и calibration store отдельным
   follow-up commit; не называть factor calibrated до трёх сопоставимых
   completed observations.

## Done criteria сверки

- actual token total получен из authoritative counter либо честно указан как
  `unknown`;
- execution profile и worker topology записаны;
- active, external и user clocks не смешаны;
- исходная model baseline и provisional user override сохранены;
- variance и следующий correction decision зафиксированы без ретроспективного
  переписывания прогноза.
