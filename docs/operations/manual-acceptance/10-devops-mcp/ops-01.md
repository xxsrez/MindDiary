---
uat: always
topics: []
---

# OPS-01 — От исходников до развёрнутой версии

## Шаги

1. Read-only сверить candidate SHA, применимый CI, artifact digest и фактический target/version/deployment.
2. Проверить binding/configuration по безопасным metadata без вывода секретов.
   После переноса или публичной очистки выполнить `npm run private:check`:
   targets и dev-ключи должны разрешаться из игнорируемой `.private/config`
   внутри рабочей папки, без внешних ссылок. Журналы и credentials приёмки —
   в `.private/acceptance`. Проверить блокировку принудительного добавления
   `.private/` и Git bundles. В сборке проверить hosting hash и соответствие
   выбранному приватному manifest; placeholder project ID не годится для release.
3. Сопоставить доступный recovery/rollback путь и совместимость данных с его требованиями.

## Ожидается

Цепочка версий установлена либо назван конкретный разрыв. Это проверка готовности восстановления, не выполненный rollback; публикация не производится.
