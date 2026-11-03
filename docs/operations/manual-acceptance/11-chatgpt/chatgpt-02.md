---
uat: when-changed
topics: ["file_native"]
clients: ["chatgpt"]
uat_when: "Native file bridge и вложение из разговора. Выбирать только при изменении этого поведения или явном критерии задачи."
---

# CHATGPT-02 — Native file bridge в ChatGPT

## Шаги

1. В настоящем новом разговоре ChatGPT прикрепить синтетический файл с известным hash и попросить сохранить только в тестовый Mind.
2. Наблюдать реальную передачу attachment в tool, итоговую revision и независимо прочитать сохранённые bytes.
3. Сверить hash; записать host approvals без изменения постоянных настроек.

## Ожидается

Проверен native bridge именно ChatGPT; companion и сохранение одного описания файла не дают pass. Маршрутизация и no-op выбираются отдельно по темам multi_mind и no_op.
