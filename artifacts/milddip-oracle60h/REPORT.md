# Mild-dip 60h research — 1.11.768 tighten **REJECTED**

## Verdict

Skip-filter “tighten stabilize + deepen h1 + rising ticks” on 1780 live fills:

| | |
|--|--|
| Actual | **−$108.54** |
| After 768 full | **−$69.30** (Δ **+$39**) |
| Winners cut | **+$198** |
| Losses avoided | **−$238** |
| Churn | **~$436** |
| Avoid/cut ratio | **1.20** |

**Rejected as noise.** Net +$39 on ~$400 of canceling win/loss mass is not an edge.

## What we will not ship from this thread

- dump `(−25,−12]` / bounce≤4 / trough 25s / rise3 / h1 `(−15,−8]` as a package  
- Time-based rebuy bans  
- Blind dex≤−12 / hard wait≤−12 (even worse collateral)

## Real problem (still open)

**58 downhill-grind mints = −$279**, of which **rest entries after #1 = −$258**.  
Without those rest fills the book ≈ **+$150**.

That bleed is mostly `wait_dip` / `dex` continuation on a falling hill — **not** fixed by shaving shallow h1/stabilize. No clean low-collateral attempt-field rule found yet that removes DH-rest without chewing winners.

## Cleaner-but-small slices (still not “the fix”)

| Rule | Δ | win cut | lose avoid | ratio |
|------|--:|--------:|-----------:|------:|
| h1 skip pc5m > −4 | +$19 | $9 | $28 | 3.1 |
| h1 skip pc5m > −5 | +$30 | $19 | $50 | 2.6 |
| stab bounce > 6 | +$21 | $17 | $38 | 2.3 |

Better asymmetry than 768, but small absolute dollars — not the main hole.

## Artifacts

- `downhill.json` — 58 grind mints  
- `cf-768-backtest.json` — full 768 CF  
- `scripts-tmp/milddip-bottom-oracle-grid-60h.py` — grid harness  
