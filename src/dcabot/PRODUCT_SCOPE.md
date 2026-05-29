# dca_frontrun — paper trading bot (PRODUCT_SCOPE)

Front-runs alt-pipeline DCA orders detected by the `dca-telegram-watch` product:
buy after the first cycle, manage the position (average-down + partial profit-taking)
through the order, and exit just before the DCA finishes — all in **paper mode** while we
collect data for later analysis.

## Status
- **paper only** — never signs or sends transactions, no wallet private key is loaded.
- Live mode is explicitly out of scope here: when we go live we will redeploy on a
  separate, isolated server (the signing module must not share a box with the private VPN).

## Boundaries (self-contained within the solana-alpha repo)
- **Env prefix:** `DCABOT_` (see `src/dcabot/config.ts`).
- **DB tables:** `dcabot_positions`, `dcabot_fills`, `dcabot_equity`, `dcabot_token_score`
  (migration `src/core/db/migrations/0025_dcabot_paper.sql`; created idempotently at runtime).
- **Reads (read-only):** the watcher's `dca_operator_orders` for qualified DCA opens.
- **PM2 unit:** `salpha-dcabot-paper` (`ecosystem.dcabot.cjs`).
- **Dashboard:** fastify on `127.0.0.1:8645` — private, reached over the VPN only.

## Trading spec (owner-agreed)
- Virtual bank **$1,000**, no hard position / stop-loss limits in paper mode.
- Entry: after **cycle 1**, only if estimated price gain ≥ **3%**. Base buy **$300**.
- Average-down: every **−5%** from avg entry → buy **$300** (no cap by default; we record
  `max_capital_usd` per position so the real capital requirement is visible).
- Take-profit: every **+5%** from avg entry → sell **20%** of the position.
- Pre-exit: sell **50%** two cycles before the planned end, the rest one cycle before —
  **unless** per-cycle size > **$10,000**, in which case ride fully to the end.
- Operator early-cancel: if in profit sell **100%** now; if in loss sell **50%** now and
  **50%** after **10 minutes**.

## Legitimacy scoring
Every coin is scored (mint/freeze authority renounced, top-10 holder concentration,
liquidity, age) and stored in `dcabot_token_score` + shown on the dashboard. Currently
**non-blocking** (we buy everything) per owner; can be flipped to a hard gate later.

## Components
- `config.ts` — env + spec params.
- `db.ts` — tables + position/fill/equity/score persistence.
- `market.ts` — price/liquidity/age (Dexscreener + Jupiter fallback).
- `rpc.ts` — read-only Solana RPC (Helius primary + fallback).
- `scorer.ts` — legitimacy score.
- `vault.ts` — cycle progress + drained/early-cancel detection.
- `engine.ts` — paper state machine + accounting.
- `signals.ts` — intake from `dca_operator_orders`.
- `server.ts` — private dashboard.
- `../scripts/dcabot.ts` — entrypoint loop.

## Known simplifications (MVP)
- Paper fills execute at the current market price with no slippage/latency model.
- Cycle progress is estimated from elapsed time × cadence, with vault-balance checks for
  end / early-cancel detection.
- LP-lock detection not yet implemented (scored as unknown).
