# Leader `8zkgFGVZ` — 30d audit and copy configuration

Window 2026-07-03 … 2026-08-02. Sources: Helius enhanced transactions for the
leader wallet (35 163 swap legs, 17 581 flat-to-flat sessions, 4 776 mints),
minute marks from `*_pair_snapshots` in PG, and the production copy-trader
journal for real entry lag.

Runtime: PM2 app `copy-trader-8zkg`, dedicated wallet
`FxQfFTmj6xfjbzE2LcXteJMjd1KpBjMhH9nzEiijUGHX`, state in
`data/copytrader-8zkg/`.

## What the leader actually is

~586 buys/day, single-leg in and single-leg out, median hold 28 minutes,
win rate 52.4%, +$96.7k over the window.

His profit is entirely in short holds. Average PnL per session by hold bucket:

| Hold | Sessions | Avg PnL | Win |
| --- | --- | --- | --- |
| 2–5m | 1 639 | +$18.04 | 75.4% |
| 5–15m | 4 025 | +$17.35 | 67.1% |
| 15–30m | 3 384 | +$12.91 | 57.5% |
| 30–60m | 3 193 | +$9.35 | 47.5% |
| 1–3h | 5 339 | −$14.28 | 32.4% |

The 1–3h bucket alone is −$76 244. We cannot match his entry speed (our measured
median lag is 31.2s), so copying him one-for-one inherits the losing tail
without the fast winners. The edge has to come from rejecting entries and from
owning the exit.

## Why he buys too many coins

Splitting his sessions by whether the mint has live market data in our platform:

| Class | Sessions | Median | Win | PnL | Median first buy | Sessions/mint |
| --- | --- | --- | --- | --- | --- | --- |
| Actively traded mints | 8 032 | +1.98% | 56.0% | +$93 985 | $302 | 18.9 |
| One-off noise | 9 549 | −0.54% | 48.5% | +$2 686 | $111 | 4.5 |

54% of his trades are small one-off entries into mints he never revisits, and
they contribute 2.8% of his profit.

## Entry correlations

Measured on the 3 967 sessions that have minute-level market context at entry.

**His own record on the mint** is the strongest single signal:

| Prior avg on mint | n | Median | Win | Sum PnL |
| --- | --- | --- | --- | --- |
| > +5% | 2 203 | +2.24% | 58.1% | +$28 020 |
| −1% … +1% | 237 | +2.70% | 59.1% | +$3 450 |
| +1% … +5% | 689 | +0.67% | 53.6% | −$388 |
| −5% … −1% | 219 | +0.89% | 53.0% | −$333 |
| < −5% | 153 | +2.29% | 52.3% | −$106 |

**Pair age**: 1–6h +3.03% / 57.9%, 6–24h +2.72% / 57.9%, 1–3d +1.13% / 55.2%,
7–30d +0.52% / 52.1%. Past three days the expectancy is ~zero.

**5m buy/sell pressure**: the 1.1–1.4 band is best (+3.16%, 60.9%); 0.7–0.9 is a
dead zone (+0.20%, 50.8%).

**Chasing**: entering after a >+15% 5m move is the only negative-median bucket
(−2.00%, 45.9% win). Buying a −5%…−1% dip is the best (+2.73%, 60.9%).

Market cap on its own is not the culprit — liquidity below $15k is already
excluded by the other gates.

## Exit

Price path after his entry, medians across the sample:

| | +5m | +15m | +30m | +60m | +120m |
| --- | --- | --- | --- | --- | --- |
| Realized vs entry | +0.15% | +0.04% | −0.40% | −1.71% | −3.03% |
| Best point so far | +2.78% | +6.01% | +9.58% | +14.60% | +21.21% |

The excursion is real and the leader gives it back. His own exit does dump the
price (−1.22% median 5 minutes after he sells) but that is second-order next to
sitting in decaying positions.

Chosen policy: peak trail armed at +8%, exit on a 6% giveback from peak, hard
time cap 45 minutes, leader sell mirrored only as a backstop. No stop-loss — on
this sample every SL cut the winning tail harder than it saved losers. This
exits before the leader on 65% of trades.

## Backtest

$100 per trade, 2.5% round-trip cost, returns winsorized at +300%, price paths
validated against the leader's actual fills.

| Scenario | Trades | Avg PnL | Win | Per day | Max DD |
| --- | --- | --- | --- | --- | --- |
| Copy everything, exit with him | 3 582 | +$1.08 | 51.2% | +$129 | −$1 340 |
| Gated, exit with him | 696 | +$3.90 | 58.8% | +$90 | −$202 |
| Gated + trail, pessimistic fill | 696 | +$2.11 | 56.8% | +$49 | −$404 |
| Gated + trail, optimistic fill | 696 | +$3.35 | 63.1% | +$78 | −$369 |

Out-of-sample on the last 15 days, parameters fitted on the first 15:

| Scenario | Trades | Avg PnL | Win | Per day | Max DD |
| --- | --- | --- | --- | --- | --- |
| Gated, exit with him | 374 | +$4.34 | 61.0% | +$111 | −$89 |
| Gated + trail, pessimistic | 374 | +$3.30 | 60.5% | +$85 | −$82 |
| Gated + trail, optimistic | 374 | +$4.48 | 67.5% | +$115 | −$70 |

Peak capital in use ~$400, median 21 trades/day.

## Gate funnel

| Gate | Condition | Survivors |
| --- | --- | --- |
| — | leader buys with context | 3 582 |
| Pair age | 1h … 3d | 1 886 |
| 5m pressure | buys/sells ≥ 1.05 | 1 258 |
| Leader buy size | ≥ $150 | 1 247 |
| Liquidity | ≥ $15k | 1 240 |
| No chase | 5m move ≤ +15% | 1 190 |
| Leader experience | ≥ 3 prior sessions | 973 |
| Leader record | prior avg > +5% | 696 |

## Cold start

The prior-record gate needs history. `npm run copy-trader:bootstrap-history --
--days 30` replays the leader's recent chain activity into `leaderHistory` in
the state file so the gate is useful from the first tick; without it the lane
would take days to open a position.

## Known limits

Backtest paths come from minute snapshots, so real slippage in thin names will
be worse than modelled. The trail's fill is bracketed by the pessimistic and
optimistic rows above; live results should land between them.
