# Why the leader is green almost every day

Sources:
- `copytrader-8zkg` journal `leader_session_closed` (2026-08-02…05, n=1692)
- mild-dip `leader-observer` flats (2026-08-09, matched sessions)
- prior 30d audit `docs/strategy/copytrader/LEADER_8ZKG_AUDIT.md`

## Short answer

His daily green is **not** “special entry every phase”. It is **positive EV per session × hundreds of sessions/day**. At ~400 closes/day and mean **+3.9%**, P(day sum > 0) ≈ **99.6%**. Bootstrap (shuffle his own trades into the same day sizes) still makes **all 4 observed days green 99%** of trials. Hours go red ~23% of the time — that matches the same math at smaller n.

## Evidence (leader sessionPct)

| Day | n | win% | med% | mean% | day sum% |
|-----|--:|-----:|-----:|------:|---------:|
| 2026-08-02 | 266 | 53.8 | +1.53 | +6.24 | **+1659** |
| 2026-08-03 | 438 | 57.5 | +3.45 | +4.54 | **+1986** |
| 2026-08-04 | 442 | 53.2 | +1.24 | +4.06 | **+1796** |
| 2026-08-05 | 546 | 54.0 | +1.68 | +2.15 | **+1175** |

- Overall: win **54.7%**, med **+1.83%**, mean **+3.91%**, sd ~29.5  
- p5 **−38%**, p95 **+50%** — fat right tail pays the left  
- Top 10% of sessions carry **>100%** of net sumPct (losers eat the rest)  
- Green hours: **77%** actual vs **~73%** bootstrap → almost pure volume×EV

P(day>0) by n (normal approx on his empirical mean/sd):

| sessions/day | P(green day) |
|-------------:|-------------:|
| 50 | ~83% |
| 100 | ~91% |
| 200 | ~97% |
| 400 | **~99.6%** |

## What creates the +EV (the part to learn)

Not “buy deeper red”. From observer + audit:

1. **Throughput** — ~500–600 buys/day, single-leg in/out, many closes.  
2. **Asymmetric distribution** — small median edge, fat winners.  
3. **Hold discipline** — edge in short/medium holds; 1–3h bucket was −$76k in 30d audit.  
4. **Not dip-only** — on 2026-08-09 closed sessions he also enters **green** tape (8zkg: 40/146 class=green still +$329; 7BNax: 75/170 green +$530).  
5. **Adds** — 8zkg ~1014 adds vs 180 new bags in observer window (scales, does not only one-shot knives).  
6. **No hard SL** — left tail exists; size + volume absorb it.

## What this is NOT

- Not “he only buys −5…−1% dips” as the daily-green engine.  
- Not phase-magic that makes every hour green (hours red ~1/4).  
- Not something we get by copying his wallet with lag (audit: blind copy −0.89%/trade after cost).

## Logging added (so next CF has the fields)

`scripts/milddip/leader-observer.py`:
- top-level `pc5m/pc1h/vol5m/vol1h/liq/mcap/turnover5mLiq/vol1hMcap/buySellRatio5m`
- `pnlUsdApprox` on sells/flats
- entry market carried onto `leader_session_flat` (`entryPc5m`, `entryTurnover5mLiq`, …)
- `leader_daily_rollup` after each flat

`src/milddip/entry-attempt.ts` buy attempts now also journal:
`pc1h`, `volume1hUsd`, `turnover5mLiq`, `vol1hMcap`, `buys5m`, `sells5m`

## Implication for our strategy

To get **his shape of daily green** we need **his EV structure** (many +EV short holds with fat winners), not fewer deeper knives. Our 60h book is the opposite: never-arm on continuation dumps destroys the left side faster than winners pay.
