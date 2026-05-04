# Cursor hooks — напоминание под процесс Git v2

Hooks не включены автоматически: их нужно завести вручную под ваш сценарий (см. skill `create-hook` в Cursor).

Идеи событий:

| Событие (условно) | Зачем |
|-------------------|--------|
| Перед отправкой сообщения агенту | Вставить блок: «Если задача **не** помечена как deploy-session — **без SSH/scp**; **ALLOWED_SURFACE** заполнен?» |
| После правки tracked-файлов в репозитории | Напоминание: `npm run typecheck`, при необходимости `npm run check:hygiene:integration` перед merge в `v2` |
| Перед merge PR → `v2` (human) | Чеклист: CI зелёный, diff просмотрен, без force-push |

Канон деплоя на VPS без `scp` tracked-кода:  
`docs/strategy/release/NORM_UNIFIED_RELEASE_AND_RUNTIME.md` §5.
