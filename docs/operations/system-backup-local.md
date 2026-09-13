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
не подтверждает hosted transfer всех Minds или offline restore. Их receipts
относятся соответственно к MD-445 и MD-447; до них `last_success` локального
теста не означает работающий ежедневный бэкап пользовательских данных.
