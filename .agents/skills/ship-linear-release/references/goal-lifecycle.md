# Codex Goal lifecycle

Этот reference обязателен после `preflight` для каждого invocation
`ship-linear-release`. Goal удерживает coordinator на конечном результате между
turns; plan описывает текущую последовательность действий, а repo-local journal
хранит durable checkpoints и ownership. Ни plan, ни journal не заменяют Goal.

## Начать или продолжить

1. Для `disposition=no-work` не вызывай `create_goal`. Вызови `get_goal({})`
   только для reconciliation:
   - если unfinished Goal отсутствует, отчитай no-work;
   - если unfinished Goal относится к этому exact repository/project/milestone,
     проверь его terminal evidence по разделу ниже и только тогда вызови
     `update_goal({"status":"complete"})`;
   - чужой unfinished Goal не изменяй и явно сообщи scope conflict.
2. Если exact milestone содержит хотя бы одну unfinished in-scope issue, до
   любых writes вызови `get_goal({})`.
3. Переиспользуй unfinished Goal только при exact совпадении canonical
   repository root, stable Linear project ID, stable milestone ID и результата
   «все in-scope issue и defects завершены». Не создавай duplicate Goal.
4. Если unfinished Goal отсутствует, вызови
   `create_goal({"objective":"<goal card>"})`. Явный invocation
   `ship-linear-release` авторизует создание этой одной exact-scope цели.
5. Если активен другой Goal или Goal tools недоступны, остановись до mutation.
   Не заменяй Goal планом, journal-ом или обещанием в тексте.

Не передавай `token_budget`, если пользователь явно не задал положительный
числовой token budget. `workers=N`, milestone estimate и оставшийся backlog не
являются token budget.

## Goal card

Сформируй self-contained objective не длиннее 4 000 символов:

```text
Objective: Завершить каждую незавершённую in-scope issue и каждый defect exact
Linear project <name, stable ID> / milestone <name, stable ID> в repository
<canonical root>: интегрировать проверенный результат в main и доставить
обязательные meaningful batches в Mind Diary UAT.

Done when: В exact milestone нет незавершённых in-scope issue/defects; все lanes
свободны; main clean; journal completed; final repository gate и обязательный
UAT batch/smoke для exact SHA прошли; Linear отражает verified state.

Verify with: Полностью paginated final Linear inventory; shipctl status и
complete; exact Git SHA/status; project-profile repository gate; UAT deployment
и smoke evidence.

Constraints: Следовать AGENTS.md и accepted ship-linear-release v1; workers=N —
topology, не outcome; не выпускать production и не расширять разрешения Goal-ом.

Blocked when: <точная внешняя зависимость, credential, permission или решение,
без которого после безопасных альтернатив невозможно продолжать>.
```

Заполни конкретный blocker проверенным фактом; не используй общее «работа
сложная» или «проверка упала». Если детали длиннее лимита, сохрани их в
approved tracked file и укажи этот файл в кратком Goal.

## Работать до результата

- Считай issue, worker result, integration, batch, CI и UAT промежуточным
  прогрессом. Не завершай turn финальным handoff, пока остаётся безопасная
  in-scope работа; используй commentary для прогресса и wait/monitor для
  ожидаемого внешнего состояния.
- После Linear drift, reopen или нового defect обновляй plan и journal, но не
  сужай terminal Goal: финальная inventory всё равно должна иметь zero
  unfinished in-scope work.
- Failed check, worker crash, merge conflict, CI/UAT failure, медленная работа
  или неполный результат запускают repair/resume. Они не разрешают
  `update_goal({"status":"blocked"})`.
- `blocked` допустим только если один и тот же точный blocker повторился не
  менее чем в трёх последовательных Goal turns и без user input либо изменения
  внешнего state нельзя сделать meaningful progress. После resume ранее
  blocked Goal счёт начинается заново.

## Закрыть Goal

Перед `update_goal({"status":"complete"})` независимо проверь:

1. final fully paginated Linear inventory: zero unfinished in-scope
   issue/defects;
2. `shipctl.py complete` успешно пометил exact run `completed`;
3. все lanes free, defects resolved, exact `main` clean;
4. final repository gate относится к exact `main` SHA;
5. если run создал meaningful candidate, current UAT deployment и smoke
   подтверждают тот же exact SHA;
6. Linear projection соответствует проверенному Git/release state.

Только после всех шести проверок вызови `update_goal({"status":"complete"})`.
Если Goal имеет explicit token budget, в финальном отчёте укажи final token
usage из результата tool. Нельзя объявлять milestone завершённым, если
`update_goal` не подтвердил terminal status; повтори безопасную terminal
reconciliation на следующем Goal turn.
