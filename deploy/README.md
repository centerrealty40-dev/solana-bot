# VPS deployment guide (Ubuntu 22.04 / 24.04)

Stack:

- **VPS** (KVM, 2 vCPU, 2 GB RAM minimum) — Hetzner CPX11, OVH VPS Starter, etc.
- **Postgres** on Neon free tier (10 GB) — keeps data alive even if VPS dies
- **Node.js 20.x** + pm2 process manager
- **Caddy** for HTTPS termination + Let's Encrypt auto-cert
- **Domain/subdomain** pointing to the VPS public IP

Total monthly cost: **$5–6** (just the VPS).

## 1. Prerequisites

- A fresh Ubuntu 22.04 or 24.04 VPS with root SSH access
- A subdomain A record pointing at the VPS public IP (e.g. `solana-bot.example.com -> 1.2.3.4`)
- A Neon project URL — sign up at https://neon.tech, create a project, copy the `postgresql://...` connection string
- A Helius API key — sign up at https://helius.dev (free tier, 1M credits/mo)

## 2. One-shot bootstrap

SSH into the VPS as root and run:

```bash
curl -fsSL https://raw.githubusercontent.com/centerrealty40-dev/solana-bot/main/deploy/setup-vps.sh -o setup.sh
sudo bash setup.sh
```

This installs Node 20, pm2, Caddy, configures UFW (firewall: SSH + 80 + 443 only), creates the `salpha` user and the `/opt/solana-alpha` directory, enables fail2ban.

## 3. Clone and configure the app

```bash
sudo -iu salpha
cd /opt/solana-alpha
git clone https://github.com/centerrealty40-dev/solana-bot.git .
cp .env.example .env
nano .env
```

Fill at minimum:

```
DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/dbname?sslmode=require
REDIS_URL=redis://localhost:6379         # OR an Upstash free URL — Redis is only used by BullMQ cron, optional in MVP
HELIUS_API_KEY=...
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
HELIUS_WEBHOOK_URL=https://solana-bot.your-domain.com/webhooks/helius
HELIUS_WEBHOOK_AUTH=any-long-random-string-here-keep-secret
EXECUTOR_MODE=paper
```

> **Important:** keep `EXECUTOR_MODE=paper` until at least one hypothesis passes the gate.

If you don't want to set up Redis right now: leave `REDIS_URL=redis://localhost:6379` — the runner uses node-cron in-process and only needs Redis if you later add BullMQ background jobs.

## 4. Install deps and apply schema

```bash
npm ci
npm run db:migrate
npm run views:install
```

This creates all tables in your Neon DB and installs Grafana-friendly SQL views.

## 5. Start the four services with pm2

```bash
pm2 start ecosystem.config.cjs
pm2 save
exit                     # back to root
```

Enable pm2 to autostart on boot:

```bash
env PATH=$PATH:/usr/bin pm2 startup systemd -u salpha --hp /home/salpha
# pm2 prints a long command — run it
```

## 6. Configure Caddy for HTTPS

Replace `YOUR_DOMAIN` in the Caddyfile with your real subdomain:

```bash
sed -i 's/YOUR_DOMAIN/solana-bot.your-domain.com/g' /opt/solana-alpha/deploy/Caddyfile
cp /opt/solana-alpha/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
```

Verify HTTPS works (Let's Encrypt cert is fetched automatically on first request):

```bash
curl -i https://solana-bot.your-domain.com/health
# expect: {"ok":true,"ts":"...","mode":"paper"}
```

## 7. Verify Helius webhook is registered

The API server registers/updates the Helius webhook on startup. Check pm2 logs:

```bash
pm2 logs sa-api --lines 50
# look for: "updated helius webhook" or "created helius webhook"
```

You can also see the webhook in your Helius dashboard at https://dashboard.helius.dev/webhooks.

## 8. Watch data flow in

After ~10–30 minutes, swaps should be flowing. Quick sanity checks:

```bash
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM swaps;"
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM tokens;"
pm2 logs sa-runner --lines 100
```

## 9. After ~24h: kick off scoring

The hourly cron starts automatically, but you can trigger an initial pass:

```bash
sudo -iu salpha
cd /opt/solana-alpha
npm run scores:compute
```

## 10. Updates

To pull a new version after pushing changes to GitHub:

```bash
sudo -iu salpha
cd /opt/solana-alpha
bash deploy/update.sh
```

Zero-downtime reload via `pm2 reload`.

## Useful commands

```bash
pm2 status
pm2 logs                  # all services
pm2 logs sa-runner        # one service
pm2 restart sa-runner
pm2 monit                 # live CPU/memory dashboard

systemctl status caddy
journalctl -u caddy -f

# DB inspection
psql "$DATABASE_URL" -c "SELECT hypothesis_id, status, COUNT(*) FROM positions GROUP BY hypothesis_id, status ORDER BY 1,2;"
psql "$DATABASE_URL" -c "SELECT * FROM v_hypothesis_lifetime;"
psql "$DATABASE_URL" -c "SELECT * FROM v_top_wallets LIMIT 20;"
```

## Going live (Stage 5 only)

Do **not** flip to live until:

1. At least one hypothesis has 100+ closed paper trades AND `npm run hypothesis:evaluate -- <id>` reports READY.
2. The `live-executor.ts` Stage 5 implementation is finished (currently stub).
3. You have a fresh hot wallet keypair file at a path referenced by `WALLET_KEYPAIR_PATH`, funded with $200–500 USDC.
4. You've set up Telegram bot + chat id for trade alerts.

Then:

```bash
nano .env
# EXECUTOR_MODE=live
# WALLET_KEYPAIR_PATH=/home/salpha/wallet.keypair.json
# TELEGRAM_BOT_TOKEN=...
# TELEGRAM_CHAT_ID=...
pm2 restart sa-runner
```
