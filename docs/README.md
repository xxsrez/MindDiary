# Документация CloudBrain

CloudBrain пока находится на стадии проектирования. Документы ниже разделяют
проверенные внешние факты, предлагаемый дизайн и ещё не реализованное поведение.

## Начать отсюда

1. [Обзор продукта](overview.md) — зачем нужен CloudBrain, какую проблему он
   решает, как Space становится адресуемой knowledge surface и где проходят
   границы продукта.
2. [Архитектура](architecture.md) — переносимое ядро, ревизии OKF, MCP surface,
   Sites-прототип и целевая AWS-топология.
3. [Доменная модель и доступ](specs/domain-model.md) — KnowledgeSpace,
   содержимое, memberships, роли и owner invariants.
4. [URL-адресация и персонализированное открытие](specs/personalized-opening.md)
   — человекочитаемый `space_handle`, Personal Space, bounded context и privacy
   invariants.
5. [Спецификация MVP](specs/mvp.md) — первый проверяемый vertical slice и его
   критерии готовности.

## Исследования

- [Состояние OKF на 2026-08-05](reports/2026-08-05-okf-status.md) — сверка
  официальной спецификации с зафиксированным OKF 0.2 snapshot.

## Статусы документов

- `report` фиксирует наблюдения на указанную дату и не обещает реализацию.
- `proposal` описывает рекомендуемое направление, которое ещё можно менять.
- После принятия значимых решений появятся отдельные ADR; сейчас их нет.

## Полнота design bootstrap

High-level контур проекта закрыт следующими документами:

- продуктовая идея, сценарии, URL/landing и платформенный путь — в overview;
- сущности, адресация, роли, история и publication — в domain model;
- персонализированное открытие и ограниченный Personal Space overlay — в
  personalized-opening specification;
- границы компонентов, основные flows, MCP/web surfaces и deployment profiles —
  в architecture;
- authorization, non-enumeration private URLs, untrusted content и безопасные
  mutation boundaries — совместно в domain model, architecture и MVP;
- проверяемый первый vertical slice и non-goals — в MVP specification;
- актуальность внешнего формата данных — в датированном OKF report.

API reference, отдельный threat model, runbooks, deployment guide, changelog и
ADR намеренно не созданы: сервисного кода, public release, развёртывания и
принятых архитектурных решений пока нет. Перед anonymous publication threat
model станет обязательным отдельным документом.
