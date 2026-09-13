# Локальная копия Mind Diary

Общая инструкция. Адрес среды, ключи, пути и фактическое состояние
пользовательских копий хранятся вне Git.

## Запуск

Нужны Node.js `>=22.13.0`, отдельный read-only `mdb_v1_` operator key,
точный HTTPS origin UAT и приватный каталог Mac. Ключ не передают аргументом
команды, в URL, shell history или логах. Будущий unattended runner должен
получать его из защищённого хранилища; способ установки относится к MD-448.

```text
MIND_DIARY_BACKUP_ORIGIN=<UAT origin>
MIND_DIARY_BACKUP_OPERATOR_KEY=<operator key>
node scripts/system-backup.mjs run --directory /absolute/private/backup-directory
node scripts/system-backup.mjs status --directory /absolute/private/backup-directory
node scripts/system-backup.mjs integrity --directory /absolute/private/backup-directory
node scripts/system-backup.mjs gc --directory /absolute/private/backup-directory
```

`run` использует только уже установленный key из environment. Каталог должен
принадлежать текущему пользователю и быть закрыт для group/other; новый
создаётся с режимом `0700`, SQLite и объекты — под `umask 077`. CLI повторно
запускает себя под системным `lockf` на macOS: одновременно работает один
writer, а падение процесса освобождает lock. В тестовой Linux-среде аналогом
служит `flock`. Запуск без ключа не создаёт рабочую копию.
После server completion и до локального commit `run` создаёт совместимый
`recovery-kits/<schema digest>/`: проверенный Node runtime текущей платформы,
архив исходников точного Git SHA с lockfile, миграциями и конфигурационными
шаблонами, а также автономные scripts. Незакоммиченный source или сбой записи
kit не позволяют продвинуть локальный checkpoint. Старые kits сохраняются
для старой точки при смене схемы. `integrity` проверяет также kit; его
`kit: verified` нельзя заменить одним только `status`.
На macOS Node должен быть самостоятельным бинарником. Homebrew Node может
ссылаться на `libnode` и другие библиотеки вне системных каталогов: копия
такого исполняемого файла не запустится на другом Mac. Передайте путь к
автономному Node `>=22.13.0` через
`MIND_DIARY_BACKUP_RUNTIME_NODE=/absolute/path/to/node` для ручного `run`
или `install`; отсутствие подходящего runtime завершает операцию ошибкой
`kit_runtime_not_portable` до продвижения checkpoint или установки Agent.
Путь к runtime не является секретом.

`status` показывает записанный `last_success`, отдельный `pending` и ошибку
без bytes, object keys, email, путей и credentials. Поле
`integrity: not_checked` означает, что `status` не перечитывал весь каталог;
только `integrity` проверяет record parts, корневой digest, inventory и хеши
всех файлов. Начальный оборванный baseline имеет `last_success: null`.

## Порядок записи и повтор

Клиент сохраняет страницы и полный inventory в staging SQLite. Объекты кладёт
по SHA-256 в `objects/sha256/`, загружая только отсутствующие или повреждённые
байты. Каждый ответ ограничен 4 MiB для part и 128 KiB для metadata page;
проверяются range, длина, SHA-256 части и целого объекта. Проверенный part
записывается во временный файл и fsync-ится до продвижения durable offset в
SQLite. После полного хеша файл переименовывается, затем fsync-ится каталог.
Уже сохранённые корректные объекты используются при metadata rebaseline.

До server completion клиент сверяет page hashes, counts, target inventory,
manifest digest и все локальные object bytes. Затем одна SQLite transaction
применяет records, сверяет корневой digest и переключает `last_success`;
transaction включает очистку pending. При обрыве старый checkpoint остаётся
на месте. Потерянный ответ completion повторяется по тому же session ID;
истёкшая незавершённая session заменяется новой без продвижения старой точки.
Повреждённые record parts заставляют начать полную пересверку metadata, а
повреждённый object скачивается снова. Для baseline/rebaseline прежние records
заменяются целиком в той же транзакции.

`gc` запускается отдельно после успешного обновления, не работает при pending
и удаляет только файлы, не упомянутые текущим inventory. Повтор после обрыва
идемпотентен; неизвестные имена файлов/каталогов вызывают отказ, а не
неограниченную очистку.

## Граница доказательства

Профильные тесты MD-446 используют синтетический D1/R2 и реальный HTTP
handler, а отдельный процесс CLI измеряет наблюдаемый RSS при объектах 8,
32 и 64 MiB. Показатель RSS снимается каждые 10 ms и в конце: он помогает
заметить рост, но не является аппаратным максимумом между samples. Этот gate
не подтверждает hosted transfer всех Minds. Его receipt относится к MD-445;
`last_success` локального теста не означает работающий ежедневный бэкап
пользовательских данных.

## Offline restore

Перенесите весь приватный каталог бэкапа на отдельный Mac той же архитектуры
и ОС. Сеть, Site, Git и npm для восстановления и локального чтения не нужны.
Запустите Node из `recovery-kits/<schema digest>/runtime/node` и CLI из того
же kit. Точный kit выбирается по `schema_digest` последнего checkpoint;
`integrity` на исходном Mac проверяет это соответствие. Входной каталог
не должен меняться во время restore, а target должен отсутствовать.

```text
<kit>/runtime/node <kit>/scripts/system-backup-restore.mjs restore \
  --directory /absolute/private/backup-directory \
  --target /absolute/private/empty-target
<kit>/runtime/node <kit>/scripts/system-backup-restore.mjs serve \
  --target /absolute/private/empty-target
```

Restore заново проверяет kit, целый checkpoint, все records, manifest bytes,
цепочки HEAD/parent, единственного Owner, Personal binding, inventory и
SHA-256 каждого объекта **до** создания target. Он заполняет локальную SQLite
с исходными ID, историей и byte-exact объектами, перестраивает переносимый
индекс слов на обычных таблицах SQLite и атомарно публикует новый каталог.
Повтор того же checkpoint проверяет
target и не создаёт дубликаты. Повреждённый source или занятый target не
перезаписываются.

`serve` слушает только `127.0.0.1` и требует новый `mdr_v1_` Bearer key из
`<target>/operator-key` (`0600`). Старые Site/OAuth/MCP/operator credentials
не работают. Только GET доступны: `/health`, `/minds`,
`/minds/{space_id}/revisions`,
`/minds/{space_id}/revisions/{revision_id}/files`,
`/minds/{space_id}/revisions/{revision_id}/files/{index}` и `/search?q=...`.
Файлы отдаются как download. Сервер не содержит public bind, mutation или
автоматического восстановления доступа пользователей. Перед будущим открытием
кому-либо ещё требуется отдельно проверить удаления и заново подтвердить
identity/access.

## Ежедневный runner на macOS

Установка требует отдельного UAT operator key `mdb_v1_`, выданного с явным
разрешением. Создайте его в Keychain как generic password для service
`com.xxsrez.mind-diary-backup.uat` и account, равного числовому UID Mac.
`/usr/bin/security add-generic-password -a <uid> -s
com.xxsrez.mind-diary-backup.uat -w` запрашивает пароль интерактивно, если
`-w` последний аргумент; не передавайте его в argv, URL, shell history или
документы. `install` сначала проверяет доступность и формат ключа, затем
создаёт приватный независимый clone точного commit и автономный Node runtime.

```text
node scripts/system-backup-runner.mjs install \
  --directory /absolute/private/local-backup \
  --origin <UAT HTTPS origin> \
  --hour 3 --minute 0 --stale-hours 48
node scripts/system-backup-runner.mjs status
node scripts/system-backup-runner.mjs run --config \
  "/absolute/Library/Application Support/MindDiaryBackup/config.json"
node scripts/system-backup-runner.mjs uninstall
```

Команду `install` запускайте из проверенного чистого Git checkout.
`install` создаёт user LaunchAgent с `StartCalendarInterval` и `RunAtLoad`.
`launchd` не будит выключенный Mac: после сна календарный запуск догоняется
при пробуждении, после выключения runner запускается при следующем login.
Пропущенные календарные интервалы объединяются в один запуск. Mac может
уснуть посреди работы; клиент возобновит незавершённую копию при следующем
запуске. Один `lockf` запрещает параллельных writers. Каждый HTTP запрос
ограничен 60 секундами, сетевой run — четырьмя часами; для временных ошибок
есть до трёх попыток с паузами 5 и 20 секунд.

`status` разделяет последний успешный checkpoint, pending и последнюю
попытку, показывает `stale` после заданного числа часов без успеха. Первая
просроченная неудача вызывает локальное уведомление без private bytes,
пути или credential; его повтор без промежуточного успеха не дублирует
уведомление. `uninstall` останавливает Agent и удаляет установленный runtime,
но оставляет backup data и Keychain item. Отзыв UAT operator key выполняется
отдельно. Каталог копии нельзя размещать внутри синхронизируемого Drive:
живую SQLite-базу нельзя копировать обычной файловой синхронизацией.

Код проверен синтетически. Настоящая установка, первый scheduled run,
Keychain provisioning и read-back свежей копии требуют отдельного evidence
MD-448; до него user data не считаются защищёнными.
