# Disaster recovery — backup & restore (Solana Alpha VPS)

**Статус:** операционный runbook. Дополняет [`NORM_UNIFIED_RELEASE_AND_RUNTIME.md`](./NORM_UNIFIED_RELEASE_AND_RUNTIME.md) (деплой кода) и [`deploy/README.md`](../../../deploy/README.md) (инфраструктура).

**Prod:** `/opt/solana-alpha`, пользователь `salpha`, PM2.  
**Хранилище off-site:** Cloudflare R2 bucket (`R2_BUCKET`, по умолчанию `solana-alpha-backups`).  
**Локальные копии:** `/home/salpha/backups/` (ротация по скриптам).

---

## 1. Что бэкапится

| Объект | Скрипт | Расписание (UTC) | Локально | R2 prefix |
|--------|--------|------------------|----------|-----------|
| PostgreSQL `solana_alpha` (public + drizzle) | `scripts/ops/backup-db-r2-api.sh` | ежедн. **03:10** | `/home/salpha/backups/postgres/` (14d) | `postgres/chunks/` |
| `.env`, `.env.hourly`, `*.keypair.json` | `scripts/ops/backup-secrets-encrypted.sh` | ежедн. **03:20** | `/home/salpha/backups/encrypted/` (30d) | `secrets/<ts>/` |
| Runtime: open snapshots, denylist, graduated | `scripts/ops/backup-live-data.sh` | ежедн. **03:30** | `/home/salpha/backups/live/runtime/` (30d) | `live/runtime/` |
| Journal `live-oscar-preset-c.jsonl` | `backup-live-data.sh` | ежедн. **03:30** | `/home/salpha/backups/live/journals/` (7d) | `live/journals/` |
| Journal `pt1-oscar-live.jsonl` (~GB) | `backup-live-data.sh` | локально ежедн.; R2 **вс 04:00** (`--r2-full-journals`) | 7d local | `live/journals-weekly/` |

Установка cron (идемпотентно, от `salpha`):

```bash
bash /opt/solana-alpha/scripts/ops/install-backup-cron.sh
```

Логи: `data/logs/db-backup.log`, `secrets-backup.log`, `live-backup.log`.  
Telegram: `[HEALTH][backup-*]` при успехе/ошибке (если заданы `TELEGRAM_*`).

---

## 2. Переменные окружения

В `/opt/solana-alpha/.env` (не коммитить):

| Ключ | Назначение |
|------|------------|
| `CF_ACCOUNT_ID`, `CF_API_TOKEN` | Cloudflare R2 HTTP API |
| `R2_BUCKET` | Имя bucket (default `solana-alpha-backups`) |
| `BACKUP_GPG_PASSPHRASE` **или** `BACKUP_GPG_PASSPHRASE_FILE` | Шифрование secrets-бэкапа (gpg AES256). Без ключа secrets-бэкап пропускается с записью в лог. |

Шаблон — `.env.example` (секция backup).

---

## 3. Проверка бэкапов (read-only)

```bash
# Postgres: скачать последний дамп из R2 и проверить pg_restore --list
bash /opt/solana-alpha/scripts/ops/restore-from-r2-chunks.sh

# Логи последнего прогона
tail -30 /opt/solana-alpha/data/logs/db-backup.log
tail -30 /opt/solana-alpha/data/logs/live-backup.log
tail -30 /opt/solana-alpha/data/logs/secrets-backup.log

# Локальные архивы
ls -lh /home/salpha/backups/postgres/
ls -lh /home/salpha/backups/live/journals/
ls -lh /home/salpha/backups/encrypted/
```

Список объектов R2 (operator): `deploy/v2-bootstrap/r2-list-and-find-atlas.sh`.

---

## 4. Restore checklist

### 4.1 Новый VPS / полная переустановка

1. Bootstrap по `deploy/v2-bootstrap/` (Postgres, `salpha`, клон `/opt/solana-alpha`).
2. **Secrets:** расшифровать последний `secrets_*.tar.gz.gpg` из `/home/salpha/backups/encrypted/` или скачать из R2 `secrets/<ts>/`:
   ```bash
   gpg -d secrets_YYYYMMDD-HHMMSS.tar.gz.gpg | tar -xzf -
   # восстановить files/dot-env → /opt/solana-alpha/.env
   # keypair files → data/live/ и data/*/ по исходным путям (см. имена __ в архиве)
   chmod 600 /opt/solana-alpha/.env
   ```
3. **PostgreSQL:**
   ```bash
   bash scripts/ops/restore-from-r2-chunks.sh   # проверка + dump.file в /tmp/r2-restore-check
   cd /tmp/r2-restore-check
   zstd -d solana_alpha_*.dump.zst -o restore.dump
   pg_restore -Fc --clean --if-exists -d solana_alpha -U salpha restore.dump
   ```
4. **Runtime + journals:** распаковать `runtime_*.tar.zst` в `data/live/`; journals:
   ```bash
   zstd -d /home/salpha/backups/live/journals/pt1-oscar-live_*.jsonl.zst -o data/live/pt1-oscar-live.jsonl
   zstd -d .../live-oscar-preset-c_*.jsonl.zst -o data/live/live-oscar-preset-c.jsonl
   ```
5. `npm ci`, `npm run db:migrate`, `pm2 reload ecosystem.config.cjs --update-env`.
6. Smoke: `bash scripts/release/post-deploy-smoke.sh`.

### 4.2 Потеря только JSONL / runtime (БД цела)

1. Остановить live-oscar / preset-c PM2-процессы.
2. Восстановить файлы из `/home/salpha/backups/live/` или weekly R2 (`live/journals-weekly/`).
3. Проверить `live-oscar-open-snapshot.json` и denylist.
4. `pm2 reload` соответствующих процессов.

### 4.3 Потеря только Postgres

1. Остановить writers (PM2 live, collectors при необходимости).
2. Restore dump (§4.1 п.3).
3. `npm run db:migrate`, reload PM2.

### 4.4 Потеря только secrets

1. Расшифровать gpg-архив (§4.1 п.2).
2. Проверить права `600` на `.env` и keypairs.
3. `pm2 reload ecosystem.config.cjs --update-env`.

---

## 5. RTO / RPO (ориентиры)

| Компонент | RPO | Примечание |
|-----------|-----|------------|
| Postgres | ≤ 24 ч | ежедневный дамп 03:10 UTC |
| preset-c journal | ≤ 24 ч | daily R2 |
| pt1-oscar journal | ≤ 7 д local; ≤ 7 д R2 | weekly full R2 |
| Runtime state | ≤ 24 ч | daily bundle |
| Secrets | ≤ 24 ч | daily encrypted |

---

## 6. Rollback cron

```bash
crontab -l | sed '/# SA_BACKUP_CRON_BEGIN/,/# SA_BACKUP_CRON_END/d' | crontab -
```

---

## 7. Связанные файлы

- `scripts/ops/backup-db-r2-api.sh`
- `scripts/ops/backup-live-data.sh`
- `scripts/ops/backup-secrets-encrypted.sh`
- `scripts/ops/restore-from-r2-chunks.sh`
- `scripts/ops/install-backup-cron.sh`
- Legacy wrapper: `scripts-tmp/backup-db-r2-api.sh` → делегирует в `scripts/ops/`
