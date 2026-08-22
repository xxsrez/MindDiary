# Roadmap и стратегия проверки Mind Diary

Статус: зафиксированная product direction владельца проекта, 2026-08-22.
Документ определяет последовательность проверки и развития продукта, но не
является implementation specification, календарным обещанием или свидетельством
реализованных функций.

## Зачем нужен отдельный roadmap

Границы первого прототипа намеренно узкие. Отсутствие функции в MVP нельзя
автоматически трактовать как отказ от неё в конечном продукте. В частности:

- Sites-only относится только к prod-like UAT текущего MVP;
- внешний Codex через MCP — первая дешёвая пользовательская поверхность, а не
  единственный долгосрочный способ работы с Mind Diary;
- bounded Markdown-only import принят как расширение Release 0.1 и реализован
  локально; exact UAT gate ещё не пройден, а ZIP/binary/legacy imports и named
  checkpoints остаются post-MVP;
- bounded support non-Markdown files/assets теперь принят как Release 0.1
  BundleFile slice; более широкие formats, processing и capacity tiers не
  приняты.

Будущий product/market analysis обязан оценивать каждую фазу отдельно и не
выдавать ограничения проверочного slice за окончательные границы продукта.

## Исходный практический сигнал

До облачного сервиса уже проверялся локальный precursor: installable Codex skill
для создания и ведения OKF knowledge store. По наблюдению владельца проекта,
даже пользователям, которые уже работают с Codex и в целом технически
подкованы, трудно самостоятельно:

- установить и правильно подключить skill;
- создать и поддерживать bundle;
- следить за изменениями OKF;
- организовать storage, revisions, sharing и access;
- объяснить агенту безопасный и повторяемый workflow.

Это качественное наблюдение, а не измерение рынка, retention или
willingness-to-pay. Оно всё же уточняет начальный сегмент: это не обязательно
инженеры, готовые вручную собирать Git/Markdown/MCP stack, а пользователи Codex,
которые умеют работать с агентом, но не хотят становиться администраторами
knowledge infrastructure.

## Фаза 1: дешёвая Codex-first проверка на Sites

### Аудитория

Начальная аудитория — технически знакомые с AI пользователи, уже работающие с
Codex, но испытывающие трудности с ручной установкой и сопровождением OKF
хранилища. Ближний круг допустим как первая assisted pilot cohort.

### Проверяемая работа

Mind Diary должен сделать работу с OKF заметно проще, чем локальный skill или
ручной Git/file workflow:

- сервис следит за поддерживаемой версией OKF и валидирует изменения;
- пользователь получает готовый Mind без ручного bootstrap storage;
- Minds дают понятную гранулярность corpus и access boundary;
- roles, visibility и revisions обслуживаются сервером;
- Codex через один MCP connection явно подключает несколько read Minds и
  единственный versioned writable Mind без ослабления ACL;
- canonical data остаются переносимыми через deterministic export.

Пользователь уже оплачивает inference своего Codex client, поэтому Mind Diary
не несёт LLM API cost в первой фазе. Sites-only UAT выбран как дешёвый
способ проверить end-to-end service и реальное использование, а не как
долгосрочная привязка всей платформы к Sites.

### Что эта фаза не доказывает

Успех assisted pilot подтверждает только ценность managed OKF workflow для
Codex-аудитории. Он сам по себе не доказывает:

- внешний спрос вне ближнего круга;
- готовность платить за отдельный сервис;
- востребованность будущего встроенного AI;
- пригодность продукта для технически неподготовленной аудитории;
- будущую AWS economics или enterprise readiness.

Решение о расширении должно опираться на повторное использование реальных
Minds, а не только на успешную настройку или положительную реакцию на demo.

## Фаза 2: основная post-MVP платформа на AWS

Если первая фаза показывает повторяемую ценность, предполагаемая основная
post-MVP infrastructure переносится на Amazon Web Services. Работа с AWS — не
случайный fallback, а самостоятельная техническая и учебная цель проекта.

Текущее архитектурное направление:

- Bedrock AgentCore Runtime для portable application/MCP runtime;
- S3 для canonical objects и больших files;
- DynamoDB для transactional metadata, HEAD CAS, access и jobs;
- optional OpenSearch для производного поиска после отдельного benchmark.

Перенос должен менять adapters и deployment topology, но не domain semantics,
access model, revision identity или OKF representation. Фактический AWS
deployment не входит в текущий release contract и потребует отдельного
принятого решения, реализации и live verification.

## Фаза 3: встроенный AI и расширение аудитории

После проверки knowledge substrate и перехода к подходящей backend platform
Mind Diary планирует собственную AI-поверхность непосредственно в web UI.
Backend будет вызывать model APIs и учитывать API pricing; пользователю не
потребуется самостоятельно настраивать Codex или MCP для основного сценария.

Эта фаза должна открыть продукт технически неподготовленной аудитории и дать на
сайте как минимум чтение, поиск, ответы по Mind и управляемое изменение знаний.
Provider selection, retrieval flow, citations, consent, billing, cost controls,
write confirmation и точная роль MCP пока не выбраны и требуют отдельных
specifications. Успех Codex-first MVP не заменяет отдельную проверку этой фазы.

## Принятое расширение Release 0.1 и post-MVP функции

### Imports

Для Release 0.1 принят первый productized profile: отдельные UTF-8 Markdown
files проходят resumable `plan → reserve → stage → validate → commit`, а один
exact HEAD CAS публикует одну revision или ничего. Paths, idempotency, quotas,
temporary lifecycle, delta storage и rollback зафиксированы в
[Sites storage/capacity/import specification](specs/sites-storage-capacity-import.md)
и [ADR-0016](decisions/0016-sites-storage-capacity-import.md). Local
implementation использует durable checkpoints для staging, validation и
canonical promotion; exact-SHA UAT capacity/import evidence ещё отсутствует.
ZIP/binary import, legacy OKF 0.1, remote sync и cross-Mind merge остаются
post-MVP decisions.

### Named checkpoints

Human-readable checkpoints поверх immutable revisions точно планируются.
Предполагаемая работа — сохранить важное состояние Mind и позже разрешить его в
одну exact revision без изменения исторического content. Naming, mutability,
uniqueness, API и связь с export/share требуют отдельной specification.
Checkpoint остаётся service metadata и не должен автоматически превращаться в
OKF `tags` или изменять bundle.

## Assets и другие non-Markdown files: первый slice принят

[OKF 0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
не определяет нормативную сущность `Asset` и не задаёт общий binary manifest.
Concept может описывать underlying resource через `resource`, указывать на
source через `sources[].resource` или ссылаться на файл обычной Markdown
ссылкой. Packaging, MIME, size, checksum, preview, OCR и transport остаются
producer-defined.

Для Mind Diary принят технический тип `BundleFile`, поскольку non-Markdown
payload бывает не только binary:

- images, PDF, audio, video и office documents;
- CSV/JSON datasets;
- SQL, Python, notebooks, executors и attesters;
- любые неизвестные файлы, которые надо сохранить byte-for-byte для round-trip.

Release 0.1 принимает bounded raster/PDF/ZIP slice: unified revision manifest,
quarantined staging, exact digest/media/size, atomic Markdown+file commits,
reauthorized download и отдельный deterministic mixed export. Type allowlist,
числовые quotas, archive containment и compatibility закреплены в
[BundleFile specification](specs/bundle-files.md) и
[ADR-0015](decisions/0015-versioned-bundle-files.md). Canonical bytes нельзя
автоматически исполнять; ZIP не извлекается, а previews/OCR/transcription
остаются будущими derived capabilities.

Это решение не является productized import, general arbitrary-file support или
production malware-cleanliness claim. Larger files/capacity, Office/audio/video,
resumable upload, antivirus/CDR и extraction требуют нового evidence и
accepted contract.

## Известный naming risk

Риск смешения `Mind Diary` с mood/reflection diary products принят к сведению.
Текущее имя сохраняется для bootstrap и MVP; решение о rename перед широким
рынком отдельно не принято.

## Правила для последующего анализа

- Оценивать Codex-first managed OKF wedge отдельно от будущего website AI.
- Не считать начальную аудиторию экспертами по Git, deployment или OKF только
  потому, что они используют Codex.
- Не считать отсутствие ZIP/binary/legacy imports и checkpoints в Release 0.1
  отказом от них в roadmap.
- Не считать Sites-only UAT MVP долгосрочным отказом от AWS или выбором
  будущей production platform.
- Не переносить сигнал ближнего круга на массовый рынок без внешней cohort.
- Разделять product evidence, engineering/learning value и коммерческий спрос.

## Открытые решения

- Какой один job-to-be-done должен определять успех первой Codex cohort?
- Какие import formats идут после принятого Markdown-only profile?
- Какая точная семантика named checkpoints?
- Какие следующие BundleFile types, capacity tiers и processing capabilities
  подтверждаются usage после bounded raster/PDF/ZIP slice?
- Какой usage/retention signal запускает AWS migration?
- Как устроены website AI pricing, billing, provider routing и write safety?
- Сохраняется ли имя `Mind Diary` перед выходом за пределы pilot audience?
