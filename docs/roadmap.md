# Roadmap и стратегия проверки Mind Diary

> **Принятая поправка ADR-0025, 2026-09-05; реализована и опубликована в UAT, полная hosted-приёмка ещё не закрыта.**
> `usage_mode` определяет разрешённые действия, description — темы.
> Personal `/me` получает опциональное description, настраиваемое через узкую
> MCP metadata operation по прямой просьбе пользователя без изменения mode/scopes.
> Без description Personal читается/изменяется только по прямой просьбе;
> с description используется автоматически по теме в пределах `read | read_write`.
> Один ordinary writable Mind и Personal независимы; при совпадении обоих
> descriptions выполняются отдельные reads/commits, без фоновой синхронизации
> и неявного раскрытия Personal в shared Mind. Полный контракт —
> [режимы использования Mind](specs/mind-usage-modes.md). Historical sections ниже не
> переопределяют этот target и не доказывают его реализацию.

Статус: зафиксированная product direction владельца проекта, обновлено
2026-08-27.
Документ определяет последовательность проверки и развития продукта, но не
является implementation specification, календарным обещанием или свидетельством
реализованных функций.

## Зачем нужен отдельный roadmap

Границы первого прототипа намеренно узкие. Отсутствие функции в MVP нельзя
автоматически трактовать как отказ от неё в конечном продукте. В частности:

- Sites-only относится только к prod-like UAT текущего MVP;
- внешний Codex через MCP — первая дешёвая пользовательская поверхность, а не
  единственный долгосрочный способ работы с Mind Diary;
- bounded Markdown-only import, Brain-scale storage/export и universal file
  ingress приняты и частично реализованы как post-MVP graph; они не блокируют
  small-data Markdown Release 0.1;
- Release 0.2 принимает format-neutral `BundleFile` contract для arbitrary
  regular files до 256 MiB; текущая local implementation остаётся legacy
  raster/PDF/ZIP + 64 MiB baseline до MD-304 и hosted exact evidence.

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
- Site остаётся единственным местом управления account, Minds metadata,
  visibility, memberships, Connections, writable target, tokens,
  import/export и административными destructive actions;
- Codex через один MCP connection discover-ит и читает разрешённые Minds без
  обязательного read-binding onboarding, а content commit направляет только в
  заранее выбранный на Site exact writable Mind без ослабления ACL;
- canonical data остаются переносимыми через deterministic export, который
  пользователь запускает и получает через Site control plane.

### Authority contract Release 0.3

Product direction после historical Release 0.1 разделяет surfaces по типу
намерения, а не по тому, где удобнее разместить один endpoint:

- **Web control plane** владеет всеми изменениями service authority и
  lifecycle: account/Mind metadata, visibility, participants, Connections,
  writable target, credentials, import/export и whole-account/whole-Mind либо
  credential destructive actions.
- **Content MCP** владеет discovery, explicit-Mind read/search/history,
  standalone validation и ordinary atomic exact-target content commits. Он не
  управляет control state и не запускает административный export.

Replace/delete files внутри такого commit остаются versioned content change,
а не обходом control plane. Exact disposition существующего operation catalog
принадлежит MD-337; access/binding representation и migration — MD-339. До
этих задач documented Release 0.1/0.2 tool surface остаётся историческим
as-built, а не текущей целевой authority. Это решение не выбирает новые UI,
description semantics, website AI, anonymous publication, token format или
production/AWS topology.

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

## Принятый post-MVP graph

### Imports

Для post-MVP принят первый productized profile: отдельные UTF-8 Markdown files
проходят resumable `plan → reserve → stage → validate → commit`, а один exact
HEAD CAS публикует одну revision или ничего. Paths, idempotency, quotas,
temporary lifecycle, delta storage и rollback зафиксированы в
[Sites storage/capacity/import specification](specs/sites-storage-capacity-import.md)
и [ADR-0016](decisions/0016-sites-storage-capacity-import.md). Local
implementation использует durable checkpoints для staging, validation и
canonical promotion; exact-SHA UAT capacity/import evidence ещё отсутствует.
Этот profile и его UAT не входят в terminal Release 0.1. ZIP/binary import,
legacy OKF 0.1, remote sync и cross-Mind merge остаются отдельными post-MVP
decisions.

User-facing plan/reserve/stage/validate/commit/cancel import lifecycle и
экспорт exact revision принадлежат Site control plane. Content MCP может после
этого читать/валидировать exact result и делать обычный exact-target content
commit, но не становится вторым import/export administrator. Import validation
и финальный import commit остаются этапами одной Site-owned bulk operation, а
не дублирующими standalone validate или ordinary content-write surfaces.

### Named checkpoints

Human-readable checkpoints поверх immutable revisions точно планируются.
Предполагаемая работа — сохранить важное состояние Mind и позже разрешить его в
одну exact revision без изменения исторического content. Naming, mutability,
uniqueness, API и связь с export/share требуют отдельной specification.
Checkpoint остаётся service metadata и не должен автоматически превращаться в
OKF `tags` или изменять bundle.

## Assets и другие non-Markdown files: post-MVP slice принят

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

Historical post-MVP graph начал с bounded raster/PDF/ZIP slice. Release 0.2
принимает его format-neutral replacement: manifest v4 хранит любой явно
выбранный regular file как `kind: opaque`, open advisory `media_type` использует
`application/octet-stream` fallback, а exact per-file limit равен 256 MiB.
Storage не зависит от preview support: только safe raster subset может быть
inline, DOCX/HEIC/EPUB/OPUS/HTML/notebook/ZIP/unknown binary — download-only.
Canonical bytes нельзя автоматически исполнять или извлекать. Полный contract
закреплён в [BundleFile specification](specs/bundle-files.md) и
[ADR-0021](decisions/0021-format-neutral-bundle-files.md).

Этот target не меняет terminal Markdown-first Release 0.1 и не является bulk
Brain import, directory/archive import, rich renderer или production
malware-cleanliness claim. Текущий runtime остаётся legacy-bounded; MD-304,
MD-305 hosted local/workspace upload-intent composition, последующие
browse/download/export tasks и exact UAT должны доказать 0.2. MD-305 использует
MD-304 core object lifecycle и не вводит второй BundleFile store.

## Известный naming risk

Риск смешения `Mind Diary` с mood/reflection diary products принят к сведению.
Текущее имя сохраняется для bootstrap и MVP; решение о rename перед широким
рынком отдельно не принято.

## Правила для последующего анализа

- Оценивать Codex-first managed OKF wedge отдельно от будущего website AI.
- Не считать начальную аудиторию экспертами по Git, deployment или OKF только
  потому, что они используют Codex.
- Не считать отсутствие BundleFile, file ingress, Brain-scale/import и
  checkpoints в Release 0.1 отказом от них в roadmap.
- Не считать Sites-only UAT MVP долгосрочным отказом от AWS или выбором
  будущей production platform.
- Не переносить сигнал ближнего круга на массовый рынок без внешней cohort.
- Разделять product evidence, engineering/learning value и коммерческий спрос.

## Открытые решения

- Какой один job-to-be-done должен определять успех первой Codex cohort?
- Когда измеренный usage оправдывает продвижение принятого Markdown-only import?
- Какая точная семантика named checkpoints?
- Какие capacity tiers и optional processing/preview capabilities подтверждаются
  usage после format-neutral storage, не превращаясь обратно в admission rule?
- Какой usage/retention signal запускает AWS migration?
- Как устроены website AI pricing, billing, provider routing и write safety?
- Сохраняется ли имя `Mind Diary` перед выходом за пределы pilot audience?
