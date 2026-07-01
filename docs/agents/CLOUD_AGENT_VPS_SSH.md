# Cloud Agent → VPS SSH (iPhone / облако)

Как сделать так, чтобы **Cloud Agent** (в т.ч. с **iPhone**) мог сам заходить на прод **`187.124.38.242`**, смотреть Oscar и деплоить — без вашего ПК и без копирования команд в Termius.

Ключ **не коммитим** и **не вставляем в чат**. Только **Cursor Secrets**.

---

## 1. Один раз: добавить секрет в Cursor

На **Mac/PC** (не обязательно с iPhone):

1. Откройте **Cursor → Settings → Cloud Agents → Secrets**  
   (или Secrets репозитория `solana-bot`, если так настроено).
2. Добавьте секрет **`VPS_SSH_PRIVATE_KEY_B64`** — рекомендуемый формат.

### Как получить base64 от вашего ключа (Windows PowerShell)

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\Users\cente\.ssh\botadmin_187_auto"))
```

Скопируйте **одну строку** в Secret `VPS_SSH_PRIVATE_KEY_B64`.

### Альтернатива: сырой PEM

Secret **`VPS_SSH_PRIVATE_KEY`** — тело ключа целиком (с `-----BEGIN …`).  
Если UI сохраняет в одну строку с `\n`, скрипт это понимает (`printf '%b'`).

### Опциональные секреты (дефолты уже верные)

| Secret | Default |
|--------|---------|
| `VPS_SSH_HOST` | `187.124.38.242` |
| `VPS_SSH_USER` | `root` |
| `VPS_APP_DIR` | `/opt/solana-alpha` |

---

## 2. Проверка (агент или вы с ПК после merge)

```bash
bash scripts/platform/vps-ssh.sh --test
```

Ожидаемо: `vps-ssh-ok host=… user=root …`

Если **«no SSH credentials»** — секрет не подхватился Cloud Agent; пересохраните Secret и перезапустите задачу.

---

## 3. Read-only диагностика Oscar (безопасно с iPhone)

```bash
bash scripts/platform/vps-diagnose-live-oscar.sh
```

Скрипт **ничего не меняет** на сервере: PM2, heartbeat, discovery health, последние `risk_block` / `execution_skip`, какие коллекторы в `ecosystem.config.cjs`.

**В промпте с iPhone достаточно:**

```text
Deploy session: yes, только read-only диагностика Oscar
Запусти: bash scripts/platform/vps-diagnose-live-oscar.sh
```

---

## 4. Деплой (только явная deploy-session)

```bash
VPS_DEPLOY_CONFIRM=1 bash scripts/platform/vps-deploy-v2.sh
```

Только **`git fetch/reset origin/v2` + `npm ci` + `pm2 reload`** — без `scp` дерева.

Точечный reload:

```bash
VPS_DEPLOY_CONFIRM=1 VPS_DEPLOY_PM2_ONLY=live-oscar bash scripts/platform/vps-deploy-v2.sh
```

**В промпте:**

```text
Deploy session: yes, merge в v2 и деплой по NORM §5.2
```

---

## 5. Произвольная команда

```bash
# от root на VPS
bash scripts/platform/vps-ssh.sh 'uptime'

# от salpha в /opt/solana-alpha
bash scripts/platform/vps-ssh.sh --salpha 'pm2 describe live-oscar | head -40'
```

---

## 6. Политика безопасности (не ослабляем)

| Режим | SSH | Деплой |
|-------|-----|--------|
| Обычная задача («поправь код») | **нет** | **нет** |
| «Deploy session: read-only» | **да**, diagnose | **нет** |
| «Deploy session: yes, деплой» | **да** | **да**, только через `vps-deploy-v2.sh` |

Агент **не** вставляет ключ/`.env`/пароли в ответ.  
Tracked-код на VPS — **только Git `v2`** (см. `.cursor/rules/server-autodeploy.mdc`).

---

## 7. Desktop Cursor (ваш ПК)

Если агент крутится **локально**, достаточно файла ключа:

```bash
export VPS_SSH_KEY_PATH="$HOME/.ssh/botadmin_187_auto"
bash scripts/platform/vps-ssh.sh --test
```

Cloud Agent на iPhone **не видит** ваш `~/.ssh` — нужен Secret из §1.

---

## 8. Troubleshooting

| Симптом | Действие |
|---------|----------|
| `no SSH credentials` | Secret не задан в Cloud Agent |
| `Permission denied` | Проверьте, что в Secret именно **приватный** ключ `botadmin_187_auto`, user **`root`** |
| `Connection timed out` | Сеть / firewall VPS; с телефона попробуйте позже |
| Diagnose OK, но 0 trades | Смотрите `discovery health` и `risk_block` в выводе — часто пауза рынка, не падение процесса |

---

## Связанные файлы

- `scripts/platform/vps-ssh.sh` — обёртка SSH
- `scripts/platform/vps-diagnose-live-oscar.sh` — read-only Oscar
- `scripts/platform/vps-deploy-v2.sh` — выкат v2
- `docs/strategy/release/RELEASE_OPERATING_MODEL.md` §7.4 — канон хоста/ключа
- `docs/agents/TASK_INTAKE_TEMPLATE.md` — поле **Deploy session**
