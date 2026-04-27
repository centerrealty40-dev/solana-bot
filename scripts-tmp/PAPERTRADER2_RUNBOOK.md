# PaperTrader 2 Runbook

This runbook launches 8 strategies in parallel, each writing to its own JSONL
store, and exposes the multi-strategy dashboard on `/papertrader2`.

## 1) Prepare storage

```bash
sudo mkdir -p /opt/solana-alpha/data/paper2
sudo chown -R salpha:salpha /opt/solana-alpha/data/paper2
```

## 2) Start multi-strategy runners (PM2 example)

Each process runs `scripts-tmp/live-paper-trader.ts` with its own env config.

```bash
cd /opt/solana-alpha

pm2 start node_modules/.bin/tsx --name pt2-s1 -- scripts-tmp/live-paper-trader.ts --update-env --time -- \
  && pm2 set pm2:autodump true
```

Recommended env pattern per strategy:

- `PAPER_STRATEGY_ID=<id>`
- `PAPER_TRADES_PATH=/opt/solana-alpha/data/paper2/<id>.jsonl`
- `PAPER_MIN_UNIQUE_BUYERS=...`
- `PAPER_MIN_BUY_SOL=...`
- `PAPER_MIN_BUY_SELL_RATIO=...`
- `PAPER_MAX_TOP_BUYER_SHARE=...`
- `PAPER_MIN_BC_PROGRESS=...`
- `PAPER_MAX_BC_PROGRESS=...`
- `PAPER_TP_X=...`
- `PAPER_SL_X=...`
- `PAPER_TRAIL_TRIGGER_X=...`
- `PAPER_TRAIL_DROP=...`
- `PAPER_TIMEOUT_HOURS=...`
- `PAPER_ENABLE_LAUNCHPAD_LANE=0|1`
- `PAPER_ENABLE_MIGRATION_LANE=0|1`
- `PAPER_ENABLE_POST_LANE=0|1`
- `PAPER_MIN_TOKEN_AGE_MIN=...`
- `PAPER_MIN_HOLDER_COUNT=...`

Two practical presets:

- **runner-only** (mature tokens): `PAPER_ENABLE_LAUNCHPAD_LANE=0`, `PAPER_MIN_TOKEN_AGE_MIN=360`, `PAPER_MIN_HOLDER_COUNT=5000`
- **fresh-only** (fast entries): `PAPER_ENABLE_LAUNCHPAD_LANE=1`, `PAPER_ENABLE_MIGRATION_LANE=0`, `PAPER_ENABLE_POST_LANE=0`

Use 8 ids, for example:

- `s1_fast_stop`
- `s2_balanced`
- `s3_dno_safe`
- `s4_wide_trail`
- `s5_low_dip`
- `s6_mid_dip`
- `s7_high_dip`
- `s8_momentum_guard`

## 3) Dashboard service

Run dashboard with PaperTrader2 directory:

```bash
cd /opt/solana-alpha
PORT=3007 \
STORE_PATH=/tmp/paper-trades.jsonl \
PAPER2_DIR=/opt/solana-alpha/data/paper2 \
POSITION_USD=100 \
BANK_START_USD=1000 \
node scripts-tmp/dashboard.mjs
```

URLs:

- Main board: `/`
- Multi-strategy board: `/papertrader2`

## 4) Hourly Telegram report (all strategies)

The report script reads default store plus every `*.jsonl` in `PAPER2_DIR`.

```bash
cd /opt/solana-alpha
PAPER2_DIR=/opt/solana-alpha/data/paper2 \
PAPER_TRADES_PATH=/tmp/paper-trades.jsonl \
TELEGRAM_BOT_TOKEN=... \
TELEGRAM_CHAT_ID=... \
node scripts-tmp/hourly-telegram-report.mjs
```

Schedule hourly via cron/systemd timer.

### Cron example (hourly report + health + advisor)

```bash
crontab -e
```

```cron
# Hourly detailed report
5 * * * * cd /opt/solana-alpha && PAPER2_DIR=/opt/solana-alpha/data/paper2 PAPER_TRADES_PATH=/tmp/paper-trades.jsonl node scripts-tmp/hourly-telegram-report.mjs >> /opt/solana-alpha/logs/paper2-hourly.log 2>&1

# Health check every 10 min (alerts only; no periodic OK spam)
*/10 * * * * cd /opt/solana-alpha && PAPER2_DIR=/opt/solana-alpha/data/paper2 PAPER2_MAX_STALE_MIN=20 PAPER2_HEALTH_TELEGRAM_ON_ALERT=1 PAPER2_HEALTH_TELEGRAM_ON_OK=0 node scripts-tmp/paper2-healthcheck.mjs >> /opt/solana-alpha/logs/paper2-health.log 2>&1

# Advisor every 3 hours (advice only)
15 */3 * * * cd /opt/solana-alpha && PAPER2_DIR=/opt/solana-alpha/data/paper2 node scripts-tmp/paper2-advisor.mjs >> /opt/solana-alpha/logs/paper2-advisor.log 2>&1
```

## 5) GMGN links

- `papertrader2` page shows token links to `https://gmgn.ai/sol/token/<mint>`.
- Hourly Telegram report includes GMGN link per buy/close/open row.

## 6) Advisor mode

`paper2-advisor.mjs` is advisory only:

- ranks strategies by risk-adjusted score,
- suggests TP tuning direction,
- suggests mint add/drop candidates from observed performance.

It does **not** auto-change trading parameters.
