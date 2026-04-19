# Solana Alpha Research Platform

Modular research platform for testing on-chain alpha hypotheses on Solana DEX. Parallel paper-trade of 5-10 narrow hypotheses on a cheap stack ($0-50/mo). Goal: find 1-3 working strategies and accumulate IP for the next bull run.

## Stack

- Node.js 20+ / TypeScript (ESM)
- Postgres (Neon free tier or local Docker) + Drizzle ORM
- Redis + BullMQ for job queue & cron
- Helius (Free tier: 1M credits/mo) — webhooks on Raydium/Jupiter/Pump.fun swap programs
- DexScreener WebSocket — price/trending feed
- Birdeye / Solscan public APIs — supplemental data
- Jupiter v6 API — quote (paper sim) and swap (live executor)
- Fastify — webhook receiver + dashboard API
- Vitest — tests
- Optional: Grafana Cloud free tier for dashboards over Postgres

Estimated infra cost in research mode: **$5-10/mo** (just a Hetzner CPX11 VPS). All data sources are free tier.

## Layout

```
src/
  core/            # config, logger, types, db schema & client
    db/
      schema.ts
      client.ts
      migrations/
  collectors/      # data ingestion (DexScreener WS, Helius webhook, Birdeye)
  scoring/         # wallet scoring engine
    metrics/       # individual metric calculators
  hypotheses/      # H1..H6 strategy modules implementing common interface
  runner/          # hypothesis runner, paper executor, live executor, Jupiter sim
  api/             # Fastify server + Helius webhook receiver + dashboard endpoints
  dashboard/       # SQL views for Grafana / Metabase
  scripts/         # one-off CLIs (migrate, backfill, compute scores)
tests/
```

## Quick start (local dev)

```bash
cp .env.example .env
# fill in HELIUS_API_KEY (free at https://helius.dev) at minimum

# bring up local Postgres + Redis
docker compose up -d

# install deps & generate migration
npm install
npm run db:generate
npm run db:migrate

# run API + collectors in separate terminals
npm run dev:api
npm run dev:collector:dexscreener
```

## Production deployment (Ubuntu VPS)

See [`deploy/README.md`](deploy/README.md) for the full step-by-step guide:
Hetzner-class VPS + Neon free Postgres + pm2 + Caddy HTTPS for the Helius webhook.
Total cost ~$5–6/mo. One-shot bootstrap script: `deploy/setup-vps.sh`.

## Implementation status

Following the plan's stages:

- [x] Stage 0 — platform skeleton, schema, base collectors, webhook receiver
- [x] Stage 1 — scoring engine with 7 wallet metrics + cron
- [x] Stage 2 — hypothesis runner + paper executor + Jupiter quote simulator + dashboard SQL views
- [x] Stage 3 — H1 (confirmation gate copy), H2 (wallet clustering), H3 (dev signal)
- [x] Stage 4 — H4 (pre-listing accumulation), H5 (negative copy), H6 (snipe-then-hold)
- [ ] Stage 5 — live pilot (only after a hypothesis passes 100+ paper trades with positive expectancy; **not started, manual gate**)

## Telegram monitoring

Three layers of visibility while the bot runs unattended:

1. **Per-trade alerts** — every paper entry/exit sends a Markdown message
   (token symbol, size, entry/exit price, slippage, hold time, trade & total PnL, reason).
2. **Heartbeat** every 6 hours — confirms the runner is alive and shows window stats
   (swaps processed, signals raised, entries, closes, open positions, window PnL).
3. **Daily report** at 21:00 UTC (00:00 MSK) — per-hypothesis trades / winrate / PnL
   plus daily total and open positions count.

Setup: see the comment block in `.env.example` (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID),
then `npm run telegram:test`. Manually trigger today's summary anytime with
`npm run report:daily` (or `npm run report:daily 2026-04-19` for a specific day).

## Hypothesis evaluation

A hypothesis is considered "working" only if, on 100+ paper trades:

- Expectancy >= 0.5% after simulated Jupiter slippage and fees
- Sharpe (per-trade, not daily) >= 1.0
- Max consecutive losses <= 8
- Max equity-curve drawdown <= 25%
- Trades cover >= 10 distinct tokens (no overfit to one coin)

## Safety

- Wallet keypairs **only** in `.env` / `WALLET_KEYPAIR_PATH`, never committed
- Hot wallet capped via `MAX_POSITION_USD` and `DAILY_LOSS_LIMIT_PCT`
- Live executor restricted to Jupiter Aggregator program ID
- Hard slippage cap in every quote
- Telegram alert on every executed trade and on kill-switch trip

## License

Private / unpublished.
