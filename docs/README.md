# Документация Mind Diary

Mind Diary пока находится на стадии проектирования. Документы ниже разделяют
проверенные внешние факты, предлагаемый дизайн и ещё не реализованное поведение.

## Начать отсюда

1. [Обзор продукта](overview.md) — зачем нужен Mind Diary, какую проблему он
   решает, как Mind становится адресуемой knowledge surface и где проходят
   границы продукта.
2. [Базовая айдентика](brand.md) — `Mind Diary → Mind → Memory`, знак, палитра,
   типографика, голос и canonical assets.
3. [Архитектура](architecture.md) — переносимое ядро, ревизии OKF, MCP surface,
   Sites-прототип и целевая AWS-топология.
4. [Доменная модель и доступ](specs/domain-model.md) — KnowledgeSpace,
   содержимое, memberships, роли и owner invariants.
5. [URL-адресация и персонализированное открытие](specs/personalized-opening.md)
   — человекочитаемый `space_handle`, Personal Space, bounded context и privacy
   invariants.
6. [Спецификация MVP](specs/mvp.md) — первый проверяемый vertical slice и его
   критерии готовности.

## Принятые решения

- [ADR-0001: название продукта и пользовательская лексика](decisions/0001-product-name-and-language.md)
  — принято `Mind Diary → Mind → Memory`; техническая доменная лексика
  сохраняется.

## Исследования

- [Состояние OKF на 2026-08-05](reports/2026-08-05-okf-status.md) — сверка
  официальной спецификации с зафиксированным OKF 0.2 snapshot.

## Статусы документов

- `report` фиксирует наблюдения на указанную дату и не обещает реализацию.
- `proposal` описывает рекомендуемое направление, которое ещё можно менять.
- Значимые принятые решения фиксируются отдельными ADR.

## Полнота design bootstrap

High-level контур проекта закрыт следующими документами:

- продуктовая идея, сценарии, URL/landing и платформенный путь — в overview;
- базовая визуальная и речевая система — в brand guide;
- сущности, адресация, роли, история и publication — в domain model;
- персонализированное открытие и ограниченный Personal Space overlay — в
  personalized-opening specification;
- границы компонентов, основные flows, MCP/web surfaces и deployment profiles —
  в architecture;
- authorization, non-enumeration private URLs, untrusted content и безопасные
  mutation boundaries — совместно в domain model, architecture и MVP;
- проверяемый первый vertical slice и non-goals — в MVP specification;
- актуальность внешнего формата данных — в датированном OKF report.

API reference, отдельный threat model, production runbooks, deployment guide и
changelog намеренно не созданы: сервисного кода, public release и развёртывания
пока нет. Перед anonymous
publication threat model станет обязательным отдельным документом.
