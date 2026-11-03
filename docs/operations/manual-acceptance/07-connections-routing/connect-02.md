---
uat: when-changed
topics: ["oauth","token"]
uat_when: "OAuth подключение, scopes, refresh и revoke; Personal token lifecycle. Выбирать только при изменении этого поведения или явном критерии задачи."
---

# CONNECT-02 — Единые режимы при разных credentials

Источник: [Settings / Connections](../../settings-connections-uat-runbook.md). Данные: два разрешённых тестовых credentials одного principal с read-only и read/write scopes.

## Шаги

1. Включить read_write у двух ordinary Minds на сайте.
2. Прочитать list_minds обоими credentials и попытаться записать.
3. Отозвать один credential и повторить чтение вторым.

## Ожидается

Configured modes общие; scopes сужают effective write. Два writable Mind не выключают друг друга; отзыв одного credential не отзывает другой.
