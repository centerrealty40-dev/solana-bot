# Wallet balance — source of truth for live exits

## Policy

Live Oscar (prod, `runner_probe`, `runner_lite`, copy-trader shared wallet, future `pervyy_vystrel`) treats **on-chain SPL balance** as authoritative for **sell sizing** and **orphan detection**. Journal `remainingFraction` is a cost-basis tracker that may lag after:

- manual wallet buys/sells,
- partial Jupiter fills vs modeled fraction,
- journal replay gaps.

## Rules

1. **Exit sizing** — partial and full sells use `max(journalRemainingUsd, oscarChainUsd)` where `oscarChainUsd` subtracts copy-leader attribution on the shared wallet (`copy-leader-attribution.ts`).
2. **Journal resync** — each tracker tick (and hot tick) bumps `remainingFraction` upward when chain Oscar-USD exceeds journal remainder by >2% or journal is ~0 but chain ≥ `LIVE_WALLET_BALANCE_RECONCILE_MIN_USD` (default **$5**).
3. **No journal shrink on chain deficit** — undersell / RPC lag still handled by existing wallet-drained sync and tail flush.
4. **TP auto-close guard** — journal `remainingFraction ≈ 0` triggers journal-only TP close **only** when chain Oscar-USD is below the reconcile minimum (avoids MENSA-class false closes).
5. **Orphan tail** — post-close tail sweep + periodic self-heal continue to `sell_full` from chain; emits `orphan_reconcile` JSONL when chain-only balance is detected.

## Events

`orphan_reconcile` JSONL (`events.ts`):

| reason | meaning |
|--------|---------|
| `journal_zero_chain_holds` | open row had ~0 remainder; chain resynced upward |
| `chain_above_journal` | manual add / drift; journal bumped to match chain |
| `chain_orphan_no_open` | wallet holds mint, no open journal row (periodic heal) |

## Env

- `LIVE_WALLET_BALANCE_RECONCILE_MIN_USD` — dust/orphan threshold (default `5`).

## Copy-trader shared wallet

Oscar-attributed USD excludes copy-leader cost basis unless the mint was promoted to Oscar management. Full wallet balance is never used for Oscar exit sizing when a copy leg is unattributed.
