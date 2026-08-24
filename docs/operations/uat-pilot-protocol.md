# Protocol assisted UAT pilot и feedback loop

Статус: accepted operational protocol для bounded pilot, обновлено 2026-08-11.
Документ определяет способ проведения и оценки pilot, но не содержит результатов
cohort, не является market validation, production rollout или разрешением
расширить Sites audience. Admission, revoke, rollback и incident response
выполняются по [privacy-safe UAT runbook](uat-pilot-operations.md).

## Решение и владелец

Pilot проверяет один job-to-be-done:

> Дать Codex готовый, постоянно доступный и переносимый Mind без необходимости
> самому поднимать и сопровождать knowledge infrastructure.

Владелец pilot и feedback queue — владелец проекта Mind Diary, который в
конкретном release действует как UAT release coordinator. Только он допускает
участника, связывает observation с exact candidate/deployment, проводит review
и создаёт redacted Task Manager defect task/comment. Делегирование этой роли
требует отдельной
явной записи до admission; несколько параллельных feedback queues запрещены.

Единственный feedback channel для участника — тот же one-to-one trusted channel,
через который владелец пригласил его в pilot и получил подтверждение UAT notice.
Форма, публичный чат, общий credential, automatic outbound campaign и новый
support channel не создаются. Identity и контакт остаются только в Sites access
policy и исходном trusted channel; repository, Task Manager и release evidence
используют случайный opaque participant fingerprint без обратимого отображения.

Pilot начинается только после passing `AND-161` exact-candidate join-gate.
Добавление каждого non-owner Sites principal остаётся отдельным явным действием
владельца и не выводится из этого protocol автоматически.

## Cohorts и admission

Cohorts проходят последовательно и оцениваются раздельно:

1. **Assisted cohort:** 6–8 знакомых Codex users из initial ICP. Владелец может
   помочь с setup и bounded conversion, но фиксирует каждое такое вмешательство
   как setup friction. Эта cohort ищет грубые product и operational defects и
   не доказывает внешний спрос.
2. **External cohort:** 3–5 участников вне ближнего круга с тем же ICP. Она
   открывается только после review assisted cohort, отсутствия active safety
   stop и подтверждения, что onboarding исполним по этому документу без новых
   решений. Результаты не объединяются с assisted cohort в один retention rate.

Go/no-go threshold использует полные 8 assisted users. Cohort из 6–7 всё ещё
годится для defect discovery, но остаётся `inconclusive` и не получает
пересчитанный процентный threshold.

Участник подходит, если он уже использует Codex, имеет повторяющийся knowledge
workflow или bounded existing Markdown set, понимает restricted UAT boundary и
готов сохранить собственный export/backup. Empty demo без реальной будущей
задачи, anonymous participant, shared account и shared MCP/Sites credential не
входят в sample.

До admission владелец:

1. передаёт notice из UAT runbook и получает явное подтверждение;
2. присваивает случайный opaque fingerprint вида `pilot-<random>`; identity не
   кодируется в fingerprint и mapping не записывается в repository/Task Manager;
3. фиксирует `assisted | external`, exact UAT candidate/version/deployment и
   UTC admission time;
4. добавляет ровно выбранный Sites principal и проверяет isolated account по
   runbook; participant создаёт собственный named MCP token;
5. согласует один реальный workflow и один bounded starter/source set, не
   копируя их content или query в evidence.

## Сценарии и cadence

### Session 0: admission, 10–15 минут

- подтвердить UAT/data/credential/delete boundaries;
- проверить отдельный Sites account и Personal Mind;
- выбрать один реальный workflow и ожидаемый полезный результат;
- убедиться, что до рискованной работы у участника есть допустимый backup/export
  plan.

### Session 1: activation, до 45 минут

1. Подключить Codex через собственные Sites и Mind Diary credentials.
2. Выбрать ровно один Personal или ordinary Mind.
3. Получить first useful result через strict starter либо bounded concierge
   conversion: valid UTF-8 Markdown Memory, `index.md`, `log.md`, commit по fresh
   HEAD, full-bundle validation, index fetch, search и exact fetch.
4. Выполнить один реальный search/fetch для выбранного workflow.
5. Подготовить, подтвердить и commit-ить хотя бы один meaningful write.
6. Показать immutable history и deterministic export; при уместном сценарии
   выполнить restore как новую HEAD revision.

Owner помогает только по запросу. Assistance фиксируется как `none | prompt |
hands-on`; текст запроса, corpus и credentials не записываются. Если starter
или bounded source уже готовы, целевой first useful result — примерно 15 минут
от начала product setup; это falsification threshold, не SLA.

### Week 1, день 7 ± 2

- участник сам инициирует реальную сессию и выполняет минимум один search/fetch;
- фиксируются наличие meaningful write/history/export, причина возврата или
  отсутствия возврата и уровень assistance;
- владелец задаёт bounded feedback template в canonical channel.

### Week 4, день 28 ± 3

- повторить participant-initiated workflow без demo-only task;
- отдельно спросить willingness to continue и willingness to pay/team-budget;
- зафиксировать предпочитаемую альтернативу и конкретный workflow, где managed
  Mind лучше либо хуже local files, Git, Projects, Notion или manual context;
- согласовать export/delete outcome и выполнить offboarding либо оставить
  доступ только по новому явному решению владельца.

Между checkpoints нет automatic reminders или outbound campaigns. Если
участник не возвращается, владелец делает один bounded follow-up в canonical
channel; отсутствие ответа считается `no observed return`, а не отрицательным
ответом на usefulness или willingness-to-pay. Сессия после owner follow-up не
считается participant-initiated return, пока участник сам не выполнит реальную
product operation.

## Privacy-safe определения

| Сигнал | Принятое определение | Допустимое evidence |
|---|---|---|
| `activation` | Participant завершил isolated account/MCP setup и получил один first useful result на exact UAT candidate. | Boolean + UTC window + actor class + opaque fingerprint. |
| `setup_completion` | Codex config прошёл redacted self-check и participant смог вызвать read-only Mind operation. | Closed runtime event либо bounded manual status; без endpoint credential или account identity. |
| `first useful result` | Один valid starter/converted Memory committed в один Mind и доказан `validate_mind` + index fetch + non-empty search + exact fetch. | Pass/fail и duration; без title, path, query, result ID или content. |
| `time_to_first_useful_search_ms` | Server-owned duration от account creation до первого non-empty search в текущем runtime observation window. | Closed telemetry event. Restart может открыть новое window, поэтому event не является durable unique-user analytics. |
| `meaningful write` | Participant подтверждает, что commit изменил reusable knowledge для выбранного реального workflow, а не synthetic/demo fixture. | Boolean и operation class `create | update | delete`; content/path не сохраняются. |
| `week-1 return` | Participant-initiated product session в day 5–9 с реальным search/fetch и не только setup/demo. | Boolean + UTC window. |
| `week-4 return` | Participant-initiated product session в day 25–31 с реальным workflow operation. | Boolean + UTC window; отсутствие observation не интерпретируется как причина. |
| `operational friction` | Setup/auth/MCP/control/persistence/export problem потребовала assistance, retry либо остановила scenario. | Surface, severity, outcome, assistance class, duration bucket и safe request ID. |
| `willingness to continue` | Прямой ответ `yes | uncertain | no` на продолжение этого workflow после pilot. | Ответ + краткий redacted rationale после проверки участником. |
| `willingness to pay` | Отдельный прямой ответ `personal | team-budget | no | uncertain`; оплата Codex не считается оплатой Mind Diary. | Категория без платёжных данных; price discovery требует отдельного experiment. |

Runtime telemetry остаётся operational closed schema из UAT runbook. Protocol
не добавляет durable per-user analytics, cookies, profiling, content-derived
dimensions или новые runtime fields. Manual observation record содержит только
поля из template ниже.

## Bounded feedback template

Одна запись создаётся после activation, week-1/week-4 checkpoint либо material
incident. Свободный текст сначала редактируется владельцем и затем проверяется
на отсутствие private content и identity.

```text
Participant: pilot-<random>
Cohort: assisted | external
Checkpoint: activation | week-1 | week-4 | incident | offboarding
Observed at UTC: <timestamp>
Candidate: <git-sha> / <site-version> / <deployment-id>
Scenario: setup | starter | search-fetch | write | history-restore | export | offboarding
Outcome: passed | partial | failed | no-observed-return
Assistance: none | prompt | hands-on

Product usefulness
- Specific recurring workflow improved: yes | uncertain | no
- Managed Mind versus current alternative: better | same | worse | unknown
- Redacted reason approved by participant: <one bounded sentence or absent>

Setup friction
- Surface: setup | auth | mcp | control | persistence | export | none
- Severity: minor | blocking | safety-stop
- Retry/assistance outcome: <fixed category, no raw request/query/content>

Operational defect
- Defect present: yes | no
- Safe request ID and UTC only: <opaque or absent>
- Task Manager task/comment: <canonical ref or absent>

Return and intent
- Week-1 return: yes | no-observation | not-due
- Week-4 return: yes | no-observation | not-due
- Continue: yes | uncertain | no | not-asked
- Pay: personal | team-budget | no | uncertain | not-asked

Privacy check
- No email, name, content, path, raw query, token/header/cookie, signed/download URL,
  payment data or screenshot: confirmed
```

Product usefulness, setup friction и operational defect заполняются отдельно:
одна удачная demo не скрывает setup cost, а operational outage не доказывает
отсутствие product value. Material defect создаётся в Task Manager только из
redacted operational section и exact release evidence; participant feedback
не превращается автоматически в feature request.

## Bias и decision review

Review хранит assisted и external rows раздельно и явно учитывает:

- знакомые терпимее к шероховатому onboarding и owner assistance;
- все участники уже используют Codex и не представляют массовую либо web-native
  AI аудиторию;
- отсутствие productized import может измерять bootstrap effort вместо ongoing
  value; bounded conversion учитывается как assistance;
- owner одновременно помогает и оценивает, поэтому direct answer не заменяет
  observed return usage;
- restricted UAT reliability и Sites audience friction отделяются от product
  usefulness;
- маленькая external cohort не даёт статистической market estimate.

### Safety stop

Admission и обычные сценарии немедленно останавливаются при cross-account/private
metadata leakage, shared/утёкшем credential, неверном current authorization,
unexplained destructive outcome, corrupted deterministic export либо потере
exact rollback target. Сначала выполняется revoke/incident path UAT runbook;
cohort не возобновляется до verified forward fix или exact rollback smoke.

### Go / no-go / inconclusive

После обеих cohorts владелец проводит один review:

- **Go to a broader validation experiment:** нет safety stop; не менее 4 из 8
  assisted users наблюдались на week 4; минимум 3 external participants прошли
  activation и минимум 2 из них наблюдались на week 4; хотя бы у половины всех
  retained участников есть meaningful write, history/restore или export; не
  менее 3 участников, включая 2 external, называют конкретный workflow лучше
  своей альтернативы; минимум 2, включая 1 external, прямо выбирают
  `personal`/`team-budget` willingness-to-pay. First useful result после готового
  source обычно укладывается примерно в 15 минут.
- **No-go / pause expansion:** sample достигнут, но thresholds выше не
  выполнены; ценность наблюдается только при постоянной hands-on помощи; либо
  большинство usage остаётся demo/read-only без return. Следующее действие —
  bounded diagnosis, а не AWS migration, broad AI surface или market claim.
- **Inconclusive:** minimum sample, week-4 windows или privacy-safe records не
  собраны. Нельзя заменять missing observation положительной/отрицательной
  интерпретацией или объединять cohorts ради threshold.

`Go` означает только основание для следующего validation experiment с Codex
audience. Он не доказывает массовый спрос, pricing, website AI, production
readiness или AWS economics. Actual four-week results не требуются для закрытия
`AND-160`; закрытие означает только готовность этого исполнимого protocol.

## Offboarding

Withdrawal, week-4 completion либо owner stop завершаются checklist removal из
[UAT runbook](uat-pilot-operations.md#checklist-removal): согласовать
export/delete outcome, удалить exact Sites grant, revoke named MCP tokens,
проверить `401` и не заявлять physical/legal erasure сверх проверенного
lifecycle. Feedback record получает только checkpoint `offboarding`, UTC,
opaque fingerprint и outcomes; identity mapping, credential и private corpus не
архивируются в evidence.
