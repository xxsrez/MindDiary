---
uat: extended
topics: ["provider_privacy"]
uat_when: "Provider identity и logging boundary. Выбирать только при изменении этого поведения или явном критерии задачи."
---

# UAT-14 — Сверка provider privacy boundary

## Шаги

1. По действующему профилю получить разрешённый read-back audience/identity и доступной политики request logging.
2. Сопоставить, какие identity/header сведения видит provider и что сохраняет application; не выводить сырые логи.
3. Связать read-back с exact target/configuration, отметить недоступные наблюдения.

## Ожидается

Application redaction не выдаётся за provider privacy. Отсутствие доступа к политике провайдера остаётся blocked/неизвестным, настройки автоматически не меняются.
