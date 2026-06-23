# solana-alpha — production VPS (v2 slim)

Single-product server for **solana-alpha** after W1/W2: one HTTP dashboard, Postgres, optional Redis, Caddy TLS, daily DB backup to Cloudflare R2.

## Host

| Item | Value |
|------|--------|
| VPS IPv4 | `187.124.38.242` |
| OS | Ubuntu LTS (amd64) |
| Approx cost | ~$5/mo tier |

## Users & paths

| Item | Value |
|------|--------|
| App UNIX user | `salpha` (PM2, repo, data under `/home/salpha` or `/opt/solana-alpha`) |
| App directory | `/opt/solana-alpha` |
| Dashboard JSONL | `/opt/solana-alpha/data/paper2/organizer-paper.jsonl` |

Bootstrap from scratch: scripts under `deploy/v2-bootstrap/` (`01-base-stack.sh`, `02-finish-node-caddy-ufw.sh`, `03-salpha-db-repo-dashboard.sh`).

## Postgres

| Item | Value |
|------|--------|
| Database | `solana_alpha` |
| Role | `salpha` (password in `.env`, **never commit**) |
| DSN | Set as `DATABASE_URL` or `SA_PG_DSN` in `/opt/solana-alpha/.env` |

Migrations: `npm run db:migrate` (from repo root, loads `src/core/db/migrations/`).

## Reverse proxy & TLS

| Item | Value |
|------|--------|
| Public domain | `etonne-moi.com` |
| Caddy | Terminates HTTPS, reverse-proxies to `127.0.0.1:3008` |

## PM2

| Item | Value |
|------|--------|
| Config file | `/opt/solana-alpha/ecosystem.config.cjs` |
| Process | `dashboard-organizer-paper` → `npm run --silent dashboard` |
| Logs | `/home/salpha/.pm2/logs/dashboard-organizer-paper-*.log` |

Commands (always as `salpha`, with `HOME=/home/salpha`):

```bash
cd /opt/solana-alpha
pm2 start ecosystem.config.cjs
pm2 save
pm2 list
```

## Cron / backups

Full DR runbook: [`docs/strategy/release/DR_RESTORE.md`](../docs/strategy/release/DR_RESTORE.md).

| Job | Schedule (UTC) | Script |
|-----|----------------|--------|
| Postgres → R2 | daily **03:10** | `scripts/ops/backup-db-r2-api.sh` |
| Secrets (gpg) | daily **03:20** | `scripts/ops/backup-secrets-encrypted.sh` |
| Live journals + runtime | daily **03:30**; large journal R2 **Sun 04:00** | `scripts/ops/backup-live-data.sh` |

Install all cron jobs (as `salpha`): `bash scripts/ops/install-backup-cron.sh` (alias: `install-vps-pg-backup-cron.sh`).  
Local: `/home/salpha/backups/`. Env: `CF_*`, `R2_BUCKET`, `BACKUP_GPG_PASSPHRASE_FILE` in `.env`.

**Git backup drift audit** at **04:15 UTC**: `scripts/ops/vps-github-sync-audit.sh` (install once: `bash scripts/ops/install-vps-github-sync-cron.sh`). Prod **`HEAD`** must match **`origin/v2`**; log: `data/logs/git-sync-audit.log`.

## Deploy / update (operator)

```bash
sudo -u salpha -H bash -lc '
  cd /opt/solana-alpha &&
  git fetch origin &&
  git reset --hard origin/v2 &&
  npm install --omit=dev &&
  npm run db:migrate &&
  pm2 delete all 2>/dev/null || true
  pm2 start ecosystem.config.cjs &&
  pm2 save
'
```

(`npm ci --omit=dev` may fail on some hosts with optional-dep lockfile skew; `npm install --omit=dev` is the supported fallback.)

Smoke:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3008/
curl -sS -o /dev/null -w "%{http_code}\n" https://etonne-moi.com/
```

## Docs

- Runtime notes and troubleshooting: `deploy/RUNTIME.md`.
- Do **not** commit `.env`, `.env.hourly`, or `_vps-backup-*` snapshots.
