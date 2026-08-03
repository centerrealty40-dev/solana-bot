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

**Superseded** — see "Exit re-measurement" below. Beating him out the door
turned out to cost money; the trail is now a backstop and he closes most
trades. The no-stop conclusion survived re-testing.

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

## Exit re-measurement (2026-08-02)

The shipped policy — arm +8%, give back 6%, hard cap 45 minutes, no stop —
lost $113 over its first seven live round trips. Four winners returned +$29;
two time-cap exits took −30% and −74%. That prompted a proper simulation:
1 029 gated entries replayed against per-minute snapshot prices, leader exits
placed at his actual hold time, 2.5% round trip. A stop is filled exactly at
its level, which flatters it, since a real stop in a collapsing pool fills
worse.

Stops lose anyway. Every level tested cut more upside than downside:

| Policy | Median | Mean | Win | 5th pct | Net |
| --- | --- | --- | --- | --- | --- |
| arm8 give6 cap45, no stop | +3.75% | +3.88% | 63.6% | −21.0% | +$1 411 |
| …stop 10% | +1.38% | +3.14% | 55.3% | −10.0% | +$649 |
| …stop 15% | +2.99% | +3.38% | 59.9% | −15.0% | +$897 |
| …stop 25% | +3.50% | +3.55% | 62.8% | −25.0% | +$1 076 |
| …stop 30% | +3.52% | +3.64% | 63.1% | −30.0% | +$1 159 |

The worst single outcome stays near −88% at every setting without a stop. That
tail is the price of the edge on this leader, not a defect to engineer away —
but it does mean the per-trade size has to survive it.

The larger finding inverts the original premise. Getting out before the leader
was supposed to be the advantage; measured, it is the opposite:

| Exit source | Net | Mean | Avg hold |
| --- | --- | --- | --- |
| Trail + cap only | +$549 | +3.03% | 24 min |
| Mirroring the leader | +$1 411 | +3.88% | 15 min |

Raising the arm threshold monotonically improves the result precisely because
it hands more exits back to him: arm 5/8/12/15/20/25 nets $871 / $1 411 /
$1 844 / $1 904 / $2 255 / $2 307, while trail exits fall from 434 to 134 and
leader exits rise from 532 to 767.

Fitted on the first half of the window and judged on the second, the loose
setting holds up:

| Held-out policy | n | Mean | Net/trade | Net |
| --- | --- | --- | --- | --- |
| arm8 give6 cap45 (shipped) | 511 | +4.35% | +1.85% | +$947 |
| arm15 give8 cap60 | 511 | +5.38% | +2.88% | +$1 474 |
| arm20 give8 cap60 | 511 | +5.50% | +3.00% | +$1 535 |

arm15 and arm20 land within 4% of each other, so this is a plateau rather than
a knife edge. Policy is now arm +20%, giveback 8%, cap 60 minutes, no stop:
the leader closes the trade unless it runs far enough that protecting the gain
beats following him.

## Gate re-measurement (2026-08-02)

The funnel above was built on the 3 582 buys that had live DexScreener context.
Two of its gates — leader clip size and liquidity — were never shown to earn
anything there; they survived because they barely bound on that subsample. Both
were re-measured on the full 30-day reconstruction: 35 817 transactions,
17 525 flat-to-flat sessions, entry context joined to stored pair snapshots
(24.8% coverage). Prior-record stats use only sessions closed before the one
being scored, so there is no lookahead.

Buckets by the size of the buy that opened the session, inside the experience
gates:

| Entry clip | n | Median | Mean | Win |
| --- | --- | --- | --- | --- |
| < $50 | 120 | −1.56% | +7.24% | 46.7% |
| $50–100 | 757 | +0.15% | +3.44% | 50.3% |
| $100–125 | 472 | +1.42% | +3.17% | 52.3% |
| $125–150 | 465 | +1.83% | +2.57% | 54.0% |
| $150–200 | 775 | +0.70% | +1.39% | 51.7% |
| $200–300 | 1 232 | +3.08% | +3.32% | 59.3% |
| $300–500 | 1 122 | +1.50% | +1.92% | 54.9% |
| $500–1000 | 673 | +0.85% | +0.95% | 53.6% |
| $1000+ | 428 | +2.53% | +2.35% | 60.7% |

A $150 floor raises the median but drops 1 814 sessions whose mean return
(+3.40%) is *higher* than what it keeps (+2.12%). Liquidity is worse: the
$10–15k bucket is the best one in the sample (median +6.57%, win 66.7%), and a
$15k floor discards 25 sessions worth +113 points. 5m pressure did not
reproduce either — the sub-0.7 bucket, which the old gate rejected outright,
returns +3.06% mean at 59.9% win.

Whole configurations scored on the 4 339 sessions that have snapshot context,
$100 flat, 2.5% round trip, leader's own exits:

| Config | n | Median | Win | Net/trade | Net |
| --- | --- | --- | --- | --- | --- |
| No gates | 4 339 | +1.98% | 56.7% | −0.51% | −$2 229 |
| Experience only | 2 363 | +2.24% | 57.9% | −0.15% | −$361 |
| As shipped (age ≤72h, clip, liq, pressure) | 1 386 | +2.40% | 58.6% | +0.21% | +$289 |
| Experience + age 1–24h | 1 347 | +3.03% | 59.3% | +1.03% | +$1 393 |
| …plus clip ≥ $150 | 1 326 | +3.13% | 59.4% | +1.06% | +$1 405 |
| …plus liquidity ≥ $15k | 1 336 | +3.03% | 59.2% | +1.00% | +$1 333 |
| …plus pressure ≥ 1.05 | 995 | +3.20% | 59.5% | +1.32% | +$1 314 |

Almost the whole gap between the shipped config and the best one is the age
window, not the thresholds: 24–72h old pairs return +0.42% mean against +3.5%
inside 24h. Clip size adds $12 on this sample, liquidity subtracts $60, and
pressure subtracts $79 by cutting a quarter of the trades for a better average.

Anti-chase is the one threshold that survives. Inside the kept gates, capping
the pre-entry 5m move at +10% drops 84 sessions worth −$176 net; the 10–15%
bucket is the sample's worst (median −4.16%, 33.3% win). Capping at +15% only
recovers $51 of that, so the cap moves to +10%.

Resulting gate set: leader experience (≥3 prior sessions, prior avg > +5%),
pair age 1–24h, and no entry after a >+10% 5m move. Clip size, liquidity,
market cap and 5m pressure are all off — Jupiter's slippage guard, not a static
liquidity floor, is what protects against untradeable pools.

Caveat: snapshot context covers a quarter of sessions and skews toward names
the collector already tracks, so absolute trade counts scale up in live and
thin names are under-represented.

## Gates under the shipped exit (2026-08-02)

Everything above was scored against the leader's own exits. Once the lane
mirrors him with the loose trail as a backstop, the entry buckets have to be
re-ranked: a bucket that looked weak when we cut it short can be fine when he
carries it. Same 3 402 sessions that have both entry context and a price path,
scored with arm +20% / giveback 8% / cap 60m / mirror.

The prior-record bar, by bucket (≥3 prior sessions, age 1–24h):

| Prior avg on mint | n | Median | Win | Net/trade |
| --- | --- | --- | --- | --- |
| < −5% | 84 | −0.39% | 47.6% | −1.88% |
| −5…0% | 109 | +4.17% | 56.0% | +1.45% |
| 0…3% | 136 | +3.33% | 59.6% | +2.44% |
| 3…5% | 107 | +3.22% | 61.7% | +1.29% |
| 5…10% | 272 | +4.19% | 61.8% | +1.49% |
| > 10% | 749 | +4.91% | 61.9% | +2.73% |

Only the losing bucket loses. The +5% cliff was cutting the 0–5% band, which
earns as much per trade as the band above it. Fit on the first half of the
window, judged on the second:

| Prior-avg bar | Held-out n | Net/trade | Net |
| --- | --- | --- | --- |
| > +5% (was live) | 520 | +2.97% | +$1 543 |
| > +3% | 579 | +3.00% | +$1 734 |
| > 0% | 667 | +2.99% | +$1 996 |
| > −5% | 725 | +2.95% | +$2 135 |

Per-trade return is flat across the whole range, so the bar buys nothing but
lost volume. It moves to 0: block the mints he has actually lost money on,
take the rest. The other two gates stay — the 1-session bucket is the only
negative experience bucket (−2.12% per trade against +4.09% at 5–9 sessions),
and 24–48h pairs sit at +0.16% per trade with 48–72h negative.

This was prompted by the live funnel: 1 of 45 leader buys cleared the gates in
the two hours after the exit change, with prior-avg rejections clustered at
+2.9…+4.8%, just under the old bar.

**Superseded the same day.** The prior-record gate does not survive a proper
measurement — see below.

## Market structure, measured properly (2026-08-02)

Everything above shares a flaw. The entry price came from a snapshot picked by
one rule while the exit path came from another, so any feature computed off
that same snapshot — the 5m chase in particular — was partly measuring its own
entry price. And the return was never checked against what the leader actually
realised.

Rebuilt from the bottom:

- **Entry and exit read off the same per-minute path.** Our fill is the first
  path point after his buy, which also prices in the ~30s of entry lag instead
  of pretending we get his fill.
- **Calibration.** Snapshot price against his on-chain fill: median ratio 1.001,
  so the feed is unbiased. Simulated gross on his exits reproduces his realised
  PnL (+2.2% median against his +2.12%), which means the harness is sound.
- **Returns winsorized to −95…+200%.** A handful of 100x tails should not pick
  a threshold.
- **Three time folds** over 3 624 sessions in a 30-day window, so every number
  below is reported on data the threshold never saw.

The headline is uncomfortable: copied blind, this leader is **−0.89% per trade**
after cost, against his own **+2.08%**. Entry lag (~1.2%) plus the 2.5% round
trip is his entire edge. Selection has to pay for both before it pays us.

Rank correlation with our realised return, in each half of the window:

| Feature | First half | Second half | Replicates |
| --- | --- | --- | --- |
| trades in 5m | +0.116 | +0.061 | yes |
| 5m volume | +0.100 | +0.058 | yes |
| our clip / 5m volume | −0.098 | −0.058 | yes |
| **5m volume / liquidity** | **+0.084** | **+0.067** | **yes** |
| pair age | −0.080 | −0.066 | yes |
| 1h volume / liquidity | +0.085 | +0.056 | yes |
| **1h volume / market cap** | **+0.066** | **+0.069** | **yes** |
| leader's prior avg on mint | +0.048 | +0.005 | no |
| 5m chase | −0.034 | −0.017 | no |
| market cap | +0.037 | −0.059 | sign flips |
| liquidity | +0.053 | −0.054 | sign flips |
| leader's prior sessions | −0.032 | −0.059 | wrong direction |

Every feature that replicates is the same idea: **how much the pool is actually
being traded relative to its size**. Market cap and liquidity in absolute terms
flip sign between halves — there is no "too small" or "too illiquid" band, only
"nobody is trading it". Turnover octiles, held-out half:

| 5m volume / liquidity | n | Median | Win | Held-out mean |
| --- | --- | --- | --- | --- |
| 0.000–0.025 | 452 | −2.56% | 35.8% | −3.33% |
| 0.025–0.043 | 452 | −2.12% | 43.1% | −1.11% |
| 0.043–0.066 | 452 | −2.75% | 38.5% | −1.98% |
| 0.066–0.093 | 452 | −2.69% | 40.3% | −2.70% |
| 0.093–0.139 | 452 | −0.65% | 46.5% | +0.12% |
| 0.139–0.213 | 452 | +0.96% | 51.5% | +0.66% |
| 0.213–0.385 | 452 | −0.81% | 47.6% | +1.75% |
| 0.385+ | 459 | +0.24% | 50.5% | +0.09% |

The break sits at ~0.09 and the four octiles below it lose money in both halves.
Pair age behaves the same way past 30 hours (−2.1%, −3.1%, −3.5% in the top
three octiles).

Rules, each fold unseen by the threshold that produced it:

| Rule | n | Fold 1 | Fold 2 | Fold 3 | All |
| --- | --- | --- | --- | --- | --- |
| no gates | 3 624 | −1.49% | −0.44% | −0.74% | −0.89% |
| prior-history gates (was live) | 1 308 | −2.31% | +1.00% | +1.18% | +0.07% |
| age ≤ 30h | 2 235 | −1.49% | +0.62% | +0.28% | −0.14% |
| turnover ≥ 0.09 | 1 871 | +0.61% | +0.55% | +0.38% | +0.50% |
| age ≤ 30h & turnover ≥ 0.09 | 1 440 | +1.31% | +1.03% | +0.83% | +1.02% |
| **…& 1h vol/mcap ≥ 0.33** | **1 083** | **+1.95%** | **+1.19%** | **+1.26%** | **+1.37%** |

The prior-history set averages +0.07% and swings from −2.31% to +1.18% between
folds: it was noise. The turnover set holds its sign in every fold.

A grid search over the same features reached +4.63% in training and +0.94% held
out; across its top 40 configurations the average drop was 3.1 points. That gap
is why the shipped thresholds come from the octile breaks, not from the search.

Two things to keep in view:

- **The edge is a tail.** Median is +0.42%; the top 5% of trades carry 293% of
  the total, and without them the rule averages −2.09%. This only works with
  enough trades and an exit that lets runners run.
- **Cost is the whole margin.** At a 2.5% round trip the rule earns +1.37%; at
  3.5% it earns +0.37%, and at 4% it is negative. Cutting entry lag and
  slippage is worth more than any further gate work.

Shipped: pair age **0.3–30h** (was 1–30h; 2026-08-03 live contour showed the
1h floor cutting his +40…+78% opens under 1h), 5m volume ≥ 9% of liquidity, 1h
volume ≥ 33% of market cap. Leader mint history, 5m chase, buy/sell pressure,
clip size, liquidity and market-cap floors are all off. Throughput ~36/day,
average hold 16 minutes, which occupies well under one of the eight position
slots.

## Cold start

The prior-record gate needs history. `npm run copy-trader:bootstrap-history --
--days 30` replays the leader's recent chain activity into `leaderHistory` in
the state file so the gate is useful from the first tick; without it the lane
would take days to open a position.

## Known limits

Backtest paths come from minute snapshots, so real slippage in thin names will
be worse than modelled. The trail's fill is bracketed by the pessimistic and
optimistic rows above; live results should land between them.
