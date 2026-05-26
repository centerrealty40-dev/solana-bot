# Индекс документации агентов (канон в solana-bot)

Краткая карта файлов в `docs/agents/` и связанных нормативов.

| Файл | Назначение |
|------|------------|
| [`AGENT_BOOTSTRAP.md`](./AGENT_BOOTSTRAP.md) | Обязательный порядок чтения контекста, жёсткие ограничения, Git v2 / CI / деплой |
| [`TASK_INTAKE_TEMPLATE.md`](./TASK_INTAKE_TEMPLATE.md) | Шаблон промпта: продукт, цель, **ALLOWED_SURFACE**, запрет SSH/scp по умолчанию |
| [`NORM_UNIFIED_RELEASE_AND_RUNTIME.md`](./NORM_UNIFIED_RELEASE_AND_RUNTIME.md) | Указатель на **канон** релиза Solana Alpha (`docs/strategy/release/`) |
| [`CURSOR_HOOKS_REMINDER.md`](./CURSOR_HOOKS_REMINDER.md) | Опциональные Cursor hooks (напоминания / блоки под ваш сценарий) |

**Канон цепочки «код → GitHub `v2` → VPS» (Solana Alpha):**  
[`../strategy/release/NORM_UNIFIED_RELEASE_AND_RUNTIME.md`](../strategy/release/NORM_UNIFIED_RELEASE_AND_RUNTIME.md)

**Параллельные агенты и интегратор:**  
[`../strategy/release/PARALLEL_WORKFLOW.md`](../strategy/release/PARALLEL_WORKFLOW.md)

**Операционная модель релиза продукта:**  
[`../strategy/release/RELEASE_OPERATING_MODEL.md`](../strategy/release/RELEASE_OPERATING_MODEL.md)
